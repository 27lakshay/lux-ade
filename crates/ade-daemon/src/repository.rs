//! Repository clone and publish through the system `git` (F062, D08).
//!
//! Every Git call runs with the daemon's neutral Git environment: no
//! inherited repository overrides, no terminal prompt and no stdin. The
//! user's own configuration, credential helpers and SSH agent apply. Remote
//! helpers such as `ext::` are disabled on every network call. When the user
//! has not configured an SSH command, SSH runs in batch mode so a host-key or
//! passphrase prompt fails instead of waiting.
//!
//! Pure decisions live in [`decide`]; this module only gathers facts and runs Git.
pub mod decide;

use crate::worktrees::{neutral, run_input};
use anyhow::{Context, Result, anyhow, ensure};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

pub use decide::{PublishFacts, PublishPlan, parse_remote_url, plan_publish};

/// Upper bounds for one Git process, in seconds.
pub const CLONE_TIMEOUT: u64 = 30 * 60;
pub const PUSH_TIMEOUT: u64 = 10 * 60;
const LS_REMOTE_TIMEOUT: u64 = 2 * 60;
const LOCAL_TIMEOUT: u64 = 60;

/// What one Git process did. `exit_code` is `None` when it was killed, timed
/// out or its outcome could not be read.
pub struct GitRun {
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
}

impl GitRun {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// A short reason for a failed run, from Git's own message.
    pub fn failure(&self, action: &str) -> String {
        let message = self
            .stderr
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        let message: String = message.chars().take(2000).collect();
        match (self.exit_code, message.is_empty()) {
            (None, _) => format!("{action} was stopped or timed out; its outcome is unknown"),
            (Some(code), true) => format!("{action} failed with exit code {code}"),
            (Some(_), false) => format!("{action} failed: {message}"),
        }
    }
}

fn ssh_is_configured(cwd: &Path) -> bool {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return true;
    }
    let mut command = Command::new("git");
    neutral(&mut command);
    command
        .current_dir(cwd)
        .args(["config", "--get", "core.sshCommand"]);
    run_input(command, LOCAL_TIMEOUT, None, None)
        .map(|output| output["exit_code"].as_i64() == Some(0))
        .unwrap_or(false)
}

/// Runs Git in `cwd`. A process that ran but whose outcome cannot be read is
/// reported with no exit code, never as success.
pub fn git(cwd: &Path, args: &[&str], timeout: u64, network: bool) -> GitRun {
    let mut command = Command::new("git");
    neutral(&mut command);
    command.current_dir(cwd);
    if network {
        command.args(["-c", "protocol.ext.allow=never"]);
        if !ssh_is_configured(cwd) {
            command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
    }
    command.args(args);
    match run_input(command, timeout, None, None) {
        Ok(output) => GitRun {
            exit_code: output["exit_code"].as_i64(),
            stdout: output["stdout"].as_str().unwrap_or_default().to_owned(),
            stderr: output["stderr"].as_str().unwrap_or_default().to_owned(),
        },
        Err(error) => GitRun {
            exit_code: None,
            stdout: String::new(),
            stderr: format!("{error:#}"),
        },
    }
}

/// Runs a local Git command that must succeed and returns its trimmed stdout.
pub fn git_ok(cwd: &Path, args: &[&str]) -> Result<String> {
    let run = git(cwd, args, LOCAL_TIMEOUT, false);
    ensure!(run.ok(), "{}", run.failure(&format!("git {}", args[0])));
    Ok(run.stdout.trim_end().to_owned())
}

/// Asks Git whether `name` is a valid branch name.
pub fn branch_name_ok(cwd: &Path, name: &str) -> bool {
    decide::valid_branch_name(name)
        && git(
            cwd,
            &["check-ref-format", "--branch", name],
            LOCAL_TIMEOUT,
            false,
        )
        .ok()
}

/// Anything at `path`, including a broken symbolic link.
pub fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Gathers the publish facts for `folder`, which must be a directory.
pub fn publish_facts(folder: &Path, remote: &str) -> Result<PublishFacts> {
    let inside = git(
        folder,
        &["rev-parse", "--is-inside-work-tree"],
        LOCAL_TIMEOUT,
        false,
    );
    let bare = git(
        folder,
        &["rev-parse", "--is-bare-repository"],
        LOCAL_TIMEOUT,
        false,
    );
    if bare.ok() && bare.stdout.trim() == "true" {
        return Ok(PublishFacts {
            in_repository: true,
            is_bare: true,
            ..Default::default()
        });
    }
    if !(inside.ok() && inside.stdout.trim() == "true") {
        // Git exits 128 outside any repository. Any other failure is not proof
        // that the folder is plain, so it refuses rather than running git init.
        ensure!(
            inside.exit_code == Some(128) && inside.stderr.contains("not a git repository"),
            "{}",
            inside.failure("Inspecting the folder")
        );
        return Ok(PublishFacts::default());
    }
    let toplevel = git_ok(folder, &["rev-parse", "--show-toplevel"])?;
    let is_toplevel = std::fs::canonicalize(&toplevel)? == std::fs::canonicalize(folder)?;
    let head_born = git(
        folder,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        LOCAL_TIMEOUT,
        false,
    )
    .ok();
    let branch = git(
        folder,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        LOCAL_TIMEOUT,
        false,
    );
    let branch = branch.ok().then(|| branch.stdout.trim().to_owned());
    let key = format!("remote.{remote}.url");
    let url = git(folder, &["config", "--get", &key], LOCAL_TIMEOUT, false);
    ensure!(
        url.exit_code == Some(0) || url.exit_code == Some(1),
        "{}",
        url.failure("Reading the remote")
    );
    let remote_url = url.ok().then(|| url.stdout.trim().to_owned());
    let git_dir = git_ok(folder, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = Path::new(&git_dir);
    let operation_in_progress = [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
    ]
    .iter()
    .any(|name| git_dir.join(name).exists());
    let status = git_ok(
        folder,
        &["status", "--porcelain", "--untracked-files=normal"],
    )?;
    Ok(PublishFacts {
        in_repository: true,
        is_toplevel,
        is_bare: false,
        head_born,
        branch,
        remote_url,
        operation_in_progress,
        uncommitted_changes: !status.is_empty(),
    })
}

/// The commit HEAD names, if any.
pub fn head(folder: &Path) -> Option<String> {
    let run = git(
        folder,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        LOCAL_TIMEOUT,
        false,
    );
    run.ok().then(|| run.stdout.trim().to_owned())
}

/// The checked-out branch, if HEAD names one.
pub fn current_branch(folder: &Path) -> Option<String> {
    let run = git(
        folder,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        LOCAL_TIMEOUT,
        false,
    );
    run.ok().then(|| run.stdout.trim().to_owned())
}

/// Whether `folder` is the top level of a non-bare Git work tree.
pub fn is_repository_root(folder: &Path) -> bool {
    let Ok(canonical) = std::fs::canonicalize(folder) else {
        return false;
    };
    let run = git(
        folder,
        &["rev-parse", "--show-toplevel"],
        LOCAL_TIMEOUT,
        false,
    );
    run.ok() && std::fs::canonicalize(run.stdout.trim()).is_ok_and(|top| top == canonical)
}

/// Reads the remote branch back; `Ok(true)` when it names `commit`.
pub fn remote_has(folder: &Path, remote: &str, branch: &str, commit: &str) -> Result<bool> {
    let reference = format!("refs/heads/{branch}");
    let run = git(
        folder,
        &["ls-remote", remote, &reference],
        LS_REMOTE_TIMEOUT,
        true,
    );
    if !run.ok() {
        return Err(anyhow!("{}", run.failure("Reading the remote branch back")));
    }
    Ok(decide::remote_confirms(&run.stdout, &reference, commit))
}

/// In-process claims: one clone or publish per path at a time, and one
/// runner per operation ID. A receipt left open by an ID nobody here holds
/// was interrupted by an earlier daemon process.
pub struct Claim(Vec<String>);

fn claims() -> &'static Mutex<HashSet<String>> {
    static CLAIMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashSet::new()))
}

impl Claim {
    pub fn acquire(path: &str, operation_id: &str) -> Result<Self> {
        let keys = vec![format!("path\0{path}"), format!("op\0{operation_id}")];
        let mut held = claims().lock().unwrap_or_else(|poison| poison.into_inner());
        ensure!(
            !held.contains(&keys[1]),
            "Operation {operation_id} is still running"
        );
        ensure!(
            !held.contains(&keys[0]),
            "Another clone or publish is running at {path}; retry when it finishes"
        );
        held.extend(keys.iter().cloned());
        Ok(Self(keys))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut held = claims().lock().unwrap_or_else(|poison| poison.into_inner());
        for key in &self.0 {
            held.remove(key);
        }
    }
}

/// A receipt record field as text.
pub fn text(record: &Value, key: &str) -> String {
    record[key].as_str().unwrap_or_default().to_owned()
}

/// Resolves a new clone destination to an absolute path under a canonical parent.
pub fn destination_path(destination: &str) -> Result<std::path::PathBuf> {
    let path = Path::new(destination);
    let parent = path
        .parent()
        .context("Destination must name a new folder")?;
    let name = path
        .file_name()
        .context("Destination must name a new folder")?;
    let parent =
        std::fs::canonicalize(parent).context("Destination's parent folder does not exist")?;
    Ok(parent.join(name))
}
