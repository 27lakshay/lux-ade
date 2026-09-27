//! Workspace checkpoints stored as Git objects under a private ref (F070).
//!
//! Portions adapted from t3code `apps/server/src/vcs/GitVcsDriver.ts` (MIT):
//! snapshotting through a temporary index kept inside the Git directory, the
//! racy-timestamp rule for a copied index, the fsync options on object and
//! ref writes, and a detached commit published with `update-ref`.
//!
//! A checkpoint commit's tree is the working-tree snapshot: every tracked and
//! untracked, non-ignored file. Its last parent is an index commit whose tree
//! is the index snapshot; its first parent is HEAD when HEAD exists. Nothing
//! here writes the user's index, branch or stash except `restore`, and that
//! only after the caller has saved a safety checkpoint.
use ade_core::contract::checkpoints::{
    CheckpointArea, CheckpointChangeKind, CheckpointCoverage, CheckpointPathChange,
    CheckpointProblem, CheckpointSummary,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub mod decide;

pub use decide::{Decision, Metadata, RestoreFacts, decide};

/// Seconds a single Git step may run before it is killed.
const GIT_TIMEOUT: u64 = 300;

const BASE_CONFIG: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
    "-c",
    "gc.auto=0",
];

struct Output {
    code: Option<i64>,
    stdout: String,
    stderr: String,
}

fn run(root: &Path, index: Option<&Path>, args: &[&str], input: Option<Vec<u8>>) -> Result<Output> {
    let mut command = Command::new("git");
    crate::worktrees::neutral(&mut command);
    command
        .current_dir(root)
        .args(BASE_CONFIG)
        .args(args)
        .env("GIT_AUTHOR_NAME", "ADE")
        .env("GIT_AUTHOR_EMAIL", "ade@localhost")
        .env("GIT_COMMITTER_NAME", "ADE")
        .env("GIT_COMMITTER_EMAIL", "ade@localhost");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let output = crate::worktrees::run_input(command, GIT_TIMEOUT, None, input)
        .with_context(|| format!("git {} did not finish", args.first().unwrap_or(&"")))?;
    Ok(Output {
        code: output["exit_code"].as_i64(),
        stdout: output["stdout"].as_str().unwrap_or_default().to_owned(),
        stderr: output["stderr"].as_str().unwrap_or_default().to_owned(),
    })
}

fn ok(output: Output, args: &[&str]) -> Result<String> {
    if output.code == Some(0) {
        return Ok(output.stdout);
    }
    let detail: String = output.stderr.trim().chars().take(600).collect();
    Err(anyhow!(
        "git {} failed{}{}",
        args.first().unwrap_or(&""),
        if detail.is_empty() { "" } else { ": " },
        detail
    ))
}

fn git(root: &Path, index: Option<&Path>, args: &[&str]) -> Result<String> {
    ok(run(root, index, args, None)?, args)
}

fn git_input(root: &Path, index: Option<&Path>, args: &[&str], input: String) -> Result<String> {
    ok(run(root, index, args, Some(input.into_bytes()))?, args)
}

fn line(text: String) -> String {
    text.trim_end_matches('\n').to_owned()
}

/// A temporary index file inside the Git directory, removed on drop.
pub struct TempIndex(PathBuf);

impl TempIndex {
    /// Copies the real index, keeping its timestamp one second older so Git
    /// still re-checks entries written in the same second (racy Git).
    fn copy_of(layout: &Layout) -> Result<Self> {
        let path = layout
            .git_dir
            .join(format!("ade-checkpoint-index-{}", uuid::Uuid::new_v4()));
        let temp = Self(path);
        match std::fs::metadata(&layout.index) {
            Ok(metadata) => {
                std::fs::copy(&layout.index, &temp.0).context("Could not copy the Git index")?;
                let modified = metadata.modified()?;
                let older = modified
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or(modified);
                std::fs::File::options()
                    .write(true)
                    .open(&temp.0)?
                    .set_modified(older)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Could not read the Git index"),
        }
        Ok(temp)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Where a workspace's Git state lives.
pub struct Layout {
    pub root: PathBuf,
    git_dir: PathBuf,
    index: PathBuf,
}

impl Layout {
    /// Fails closed unless `root` is the top of a non-bare Git working tree.
    pub fn open(root: &str) -> Result<Self> {
        let root = std::fs::canonicalize(root).context("Workspace directory is unavailable")?;
        let top = git(&root, None, &["rev-parse", "--show-toplevel"]).map_err(|_| {
            anyhow!("Checkpoints need a Git working tree; this workspace is not one")
        })?;
        let top = std::fs::canonicalize(line(top)).context("Git working tree is unavailable")?;
        ensure!(
            top == root,
            "Checkpoints need the workspace root to be the top of its Git working tree"
        );
        let git_dir = PathBuf::from(line(git(
            &root,
            None,
            &["rev-parse", "--absolute-git-dir"],
        )?));
        let index = PathBuf::from(line(git(
            &root,
            None,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )?));
        Ok(Self {
            root,
            git_dir,
            index,
        })
    }

    /// Conditions under which a snapshot could miss changes or a restore
    /// could corrupt an operation in progress.
    pub fn blockers(&self, restoring: bool) -> Result<Vec<String>> {
        let mut blockers = Vec::new();
        let sparse = run(
            &self.root,
            None,
            &["config", "--bool", "core.sparseCheckout"],
            None,
        )?;
        if line(sparse.stdout) == "true" {
            blockers.push("Sparse checkouts are not supported by checkpoints".into());
        }
        let entries = git(&self.root, None, &["ls-files", "-v", "-z"])?;
        if decide::has_hidden_entries(&entries) {
            blockers.push(
                "Some index entries are marked assume-unchanged or skip-worktree, so a snapshot could miss changes"
                    .into(),
            );
        }
        if !git(&self.root, None, &["ls-files", "-u", "-z"])?.is_empty() {
            blockers.push("The index has unresolved merge conflicts".into());
        }
        if restoring {
            for (marker, name) in [
                ("MERGE_HEAD", "merge"),
                ("CHERRY_PICK_HEAD", "cherry-pick"),
                ("REVERT_HEAD", "revert"),
                ("rebase-merge", "rebase"),
                ("rebase-apply", "rebase or am"),
            ] {
                if self.git_dir.join(marker).exists() {
                    blockers.push(format!("A {name} is in progress"));
                }
            }
            let mut lock = self.index.clone().into_os_string();
            lock.push(".lock");
            if Path::new(&lock).exists() {
                blockers.push("Another Git process holds the index lock".into());
            }
        }
        Ok(blockers)
    }
}

/// The working tree and index as tree objects. The worktree temp index is
/// kept so a restore can check that no file changed after the snapshot.
pub struct Snapshot {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub index_tree: String,
    pub worktree_tree: String,
    worktree_index: TempIndex,
}

pub fn snapshot(layout: &Layout) -> Result<Snapshot> {
    let root = &layout.root;
    let head = run(
        root,
        None,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        None,
    )?;
    let head = match head.code {
        Some(0) => Some(line(head.stdout)),
        Some(1) => None,
        _ => bail!("Could not read HEAD"),
    };
    let branch = run(root, None, &["symbolic-ref", "-q", "--short", "HEAD"], None)?;
    let branch = (branch.code == Some(0)).then(|| line(branch.stdout));
    let index_copy = TempIndex::copy_of(layout)?;
    let index_tree = line(
        git(root, Some(index_copy.path()), &["write-tree"])
            .context("The index cannot be recorded; resolve conflicts first")?,
    );
    drop(index_copy);
    let worktree_index = TempIndex::copy_of(layout)?;
    git(root, Some(worktree_index.path()), &["add", "-A", "--", "."])?;
    let worktree_tree = line(git(root, Some(worktree_index.path()), &["write-tree"])?);
    ensure!(
        !index_tree.is_empty() && !worktree_tree.is_empty(),
        "Git returned an empty tree ID"
    );
    Ok(Snapshot {
        head,
        branch,
        index_tree,
        worktree_tree,
        worktree_index,
    })
}

pub fn coverage(layout: &Layout, snapshot: &Snapshot) -> Result<CheckpointCoverage> {
    let root = &layout.root;
    let modes = git(
        root,
        None,
        &[
            "ls-tree",
            "-r",
            "-z",
            "--format=%(objectmode)",
            &snapshot.worktree_tree,
        ],
    )?;
    let (files, symlinks, submodules) = decide::count_modes(&modes)?;
    let untracked = git(
        root,
        None,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--diff-filter=A",
            "--name-only",
            &snapshot.index_tree,
            &snapshot.worktree_tree,
        ],
    )?;
    let ignored = git(
        root,
        Some(snapshot.worktree_index.path()),
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
    )?;
    Ok(CheckpointCoverage {
        files,
        untracked_files: decide::nul_paths(&untracked).len() as u64,
        symlinks,
        submodules,
        ignored_entries: decide::nul_paths(&ignored).len() as u64,
        not_covered: decide::NOT_COVERED
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
    })
}

/// Writes the checkpoint commit and publishes its ref. The ref is created
/// only if absent, so an ID is never reused.
pub fn write(
    layout: &Layout,
    snapshot: &Snapshot,
    metadata: &Metadata,
) -> Result<CheckpointSummary> {
    let root = &layout.root;
    let reference = decide::ref_name(&metadata.workspace_id, &metadata.checkpoint_id)?;
    let mut index_args = vec!["commit-tree", "--no-gpg-sign", snapshot.index_tree.as_str()];
    if let Some(head) = &snapshot.head {
        index_args.extend(["-p", head]);
    }
    index_args.extend(["-m", "ADE checkpoint index"]);
    let index_commit = line(git(root, None, &index_args)?);
    let mut args = vec![
        "commit-tree",
        "--no-gpg-sign",
        snapshot.worktree_tree.as_str(),
    ];
    if let Some(head) = &snapshot.head {
        args.extend(["-p", head]);
    }
    args.extend(["-p", &index_commit, "-F", "-"]);
    let commit = line(git_input(
        root,
        None,
        &args,
        decide::encode_message(metadata)?,
    )?);
    ensure!(!commit.is_empty(), "git commit-tree returned no commit");
    git_input(
        root,
        None,
        &["update-ref", "--stdin"],
        format!("create {reference} {commit}\n"),
    )?;
    read(layout, &reference)
}

/// Reads one checkpoint ref, checking its metadata against the ref's name.
pub fn read(layout: &Layout, reference: &str) -> Result<CheckpointSummary> {
    let root = &layout.root;
    let commit = line(git(
        root,
        None,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("{reference}^{{commit}}"),
        ],
    )?);
    let raw = decide::parse_commit(&git(root, None, &["cat-file", "commit", &commit])?)?;
    let metadata = decide::decode_message(&raw.message)?;
    ensure!(
        decide::ref_name(&metadata.workspace_id, &metadata.checkpoint_id)? == reference,
        "Checkpoint metadata names a different ref"
    );
    let index_commit = raw
        .parents
        .last()
        .context("Checkpoint has no index commit")?;
    let expected_parents = usize::from(metadata.head.is_some()) + 1;
    ensure!(
        raw.parents.len() == expected_parents
            && (metadata.head.is_none() || raw.parents.first() == metadata.head.as_ref()),
        "Checkpoint parents do not match its metadata"
    );
    let index_tree = line(git(
        root,
        None,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("{index_commit}^{{tree}}"),
        ],
    )?);
    Ok(CheckpointSummary {
        checkpoint_id: metadata.checkpoint_id,
        workspace_id: metadata.workspace_id,
        kind: metadata.kind,
        label: metadata.label,
        ref_name: reference.to_owned(),
        commit,
        worktree_tree: raw.tree,
        index_tree,
        head: metadata.head,
        branch: metadata.branch,
        created_at: metadata.created_at,
        coverage: metadata.coverage,
    })
}

/// Whether the ref exists at all; any other failure is an error.
pub fn exists(layout: &Layout, reference: &str) -> Result<bool> {
    let output = run(
        &layout.root,
        None,
        &["show-ref", "--verify", "-q", reference],
        None,
    )?;
    match output.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => bail!("Could not read ref {reference}"),
    }
}

pub fn list(
    layout: &Layout,
    workspace_id: &str,
) -> Result<(Vec<CheckpointSummary>, Vec<CheckpointProblem>)> {
    ensure!(
        decide::valid_component(workspace_id),
        "Invalid workspace_id"
    );
    let prefix = format!("{}/{workspace_id}/", decide::REF_ROOT);
    let refs = git(
        &layout.root,
        None,
        &["for-each-ref", "--format=%(refname)", &prefix],
    )?;
    let mut checkpoints = Vec::new();
    let mut problems = Vec::new();
    for reference in refs.lines().filter(|line| !line.is_empty()) {
        match read(layout, reference) {
            Ok(summary) => checkpoints.push(summary),
            Err(error) => problems.push(CheckpointProblem {
                ref_name: reference.to_owned(),
                problem: format!("{error:#}"),
            }),
        }
    }
    checkpoints.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.checkpoint_id.cmp(&a.checkpoint_id))
    });
    Ok((checkpoints, problems))
}

pub fn delete(layout: &Layout, reference: &str, expected_commit: &str) -> Result<()> {
    git_input(
        &layout.root,
        None,
        &["update-ref", "--stdin"],
        format!("delete {reference} {expected_commit}\n"),
    )?;
    Ok(())
}

fn empty_tree(layout: &Layout) -> Result<String> {
    Ok(line(git_input(
        &layout.root,
        None,
        &["hash-object", "-t", "tree", "-w", "--stdin"],
        String::new(),
    )?))
}

fn diff(
    layout: &Layout,
    from: &str,
    to: &str,
    area: CheckpointArea,
) -> Result<Vec<CheckpointPathChange>> {
    let output = git(
        &layout.root,
        None,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--name-status",
            from,
            to,
        ],
    )?;
    decide::parse_name_status(&output, area)
}

/// Everything a restore preview reports, and the facts the decision uses.
pub struct Plan {
    pub changes: Vec<CheckpointPathChange>,
    pub uncommitted_overwritten: Vec<String>,
    pub ignored_overwritten: Vec<String>,
    pub head_changed: bool,
    pub state_token: String,
}

pub fn plan(layout: &Layout, snapshot: &Snapshot, checkpoint: &CheckpointSummary) -> Result<Plan> {
    let mut changes = diff(
        layout,
        &snapshot.worktree_tree,
        &checkpoint.worktree_tree,
        CheckpointArea::Worktree,
    )?;
    changes.extend(diff(
        layout,
        &snapshot.index_tree,
        &checkpoint.index_tree,
        CheckpointArea::Index,
    )?);
    let base = match &snapshot.head {
        Some(head) => format!("{head}^{{tree}}"),
        None => empty_tree(layout)?,
    };
    let mut dirty = BTreeSet::new();
    for tree in [&snapshot.worktree_tree, &snapshot.index_tree] {
        let output = git(
            &layout.root,
            None,
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-only",
                &base,
                tree,
            ],
        )?;
        dirty.extend(decide::nul_paths(&output));
    }
    let ignored_overwritten = changes
        .iter()
        .filter(|change| {
            change.area == CheckpointArea::Worktree && change.kind == CheckpointChangeKind::Added
        })
        .filter(|change| occupied(&layout.root, &change.path))
        .map(|change| change.path.clone())
        .collect();
    Ok(Plan {
        uncommitted_overwritten: decide::uncommitted_overwritten(&changes, &dirty),
        changes,
        ignored_overwritten,
        head_changed: snapshot.head != checkpoint.head,
        state_token: decide::state_token(
            snapshot.head.as_deref(),
            &snapshot.index_tree,
            &snapshot.worktree_tree,
            &checkpoint.commit,
        ),
    })
}

/// Whether writing `path` would replace something the snapshot does not
/// hold: an entry at the path itself, or a non-directory at a parent.
fn occupied(root: &Path, path: &str) -> bool {
    let mut current = root.to_path_buf();
    let parts: Vec<&str> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if index + 1 == parts.len() || !metadata.is_dir() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }
    false
}

/// What `restore` did.
pub struct Applied {
    pub verified: bool,
    pub problems: Vec<String>,
}

/// Writes the checkpoint over the working tree, then the index, then checks
/// both against a fresh snapshot. The working tree is written with
/// `read-tree -m -u` on the snapshot's own index, which refuses if any file
/// changed after the snapshot. Returns an error only if nothing was written.
pub fn restore(
    layout: &Layout,
    snapshot: &Snapshot,
    checkpoint: &CheckpointSummary,
) -> Result<Applied> {
    let root = &layout.root;
    let mut problems = Vec::new();
    if snapshot.worktree_tree != checkpoint.worktree_tree
        && let Err(error) = git(
            root,
            Some(snapshot.worktree_index.path()),
            &[
                "read-tree",
                "-m",
                "-u",
                &snapshot.worktree_tree,
                &checkpoint.worktree_tree,
            ],
        )
    {
        // Git checks before it writes, but a failure while writing can
        // leave some files changed. Only a matching snapshot proves none were.
        match snapshot_trees(layout) {
            Ok((index_tree, worktree_tree))
                if index_tree == snapshot.index_tree && worktree_tree == snapshot.worktree_tree =>
            {
                return Err(error.context("The workspace was not changed"));
            }
            _ => {
                return Ok(Applied {
                    verified: false,
                    problems: vec![format!(
                        "Writing the working tree failed part way and some files may have changed: {error:#}"
                    )],
                });
            }
        }
    }
    if snapshot.index_tree != checkpoint.index_tree {
        // The index must still be the one the decision saw.
        let current = TempIndex::copy_of(layout)?;
        let now = line(git(root, Some(current.path()), &["write-tree"])?);
        if now != snapshot.index_tree {
            problems.push(
                "The index changed during the restore, so it was left as it is; the working tree was restored"
                    .into(),
            );
        } else if let Err(error) = git(root, None, &["read-tree", &checkpoint.index_tree]) {
            problems.push(format!(
                "The working tree was restored but the index was not: {error:#}"
            ));
        }
    }
    // Refresh stat data so `git status` does not re-hash every file. Exit 1
    // means some files differ from the index, which is expected.
    let refreshed = run(root, None, &["update-index", "-q", "--refresh"], None)?;
    if !matches!(refreshed.code, Some(0 | 1)) {
        problems.push("Git could not refresh the index stat data".into());
    }
    let verified = match snapshot_trees(layout) {
        Ok((index_tree, worktree_tree)) => {
            if worktree_tree != checkpoint.worktree_tree {
                problems.push(
                    "The working tree does not match the checkpoint after the restore".into(),
                );
            }
            if index_tree != checkpoint.index_tree {
                problems.push("The index does not match the checkpoint after the restore".into());
            }
            index_tree == checkpoint.index_tree && worktree_tree == checkpoint.worktree_tree
        }
        Err(error) => {
            problems.push(format!("The restore could not be verified: {error:#}"));
            false
        }
    };
    Ok(Applied { verified, problems })
}

fn snapshot_trees(layout: &Layout) -> Result<(String, String)> {
    let after = snapshot(layout)?;
    Ok((after.index_tree, after.worktree_tree))
}

/// In-process claims: one effect per workspace at a time, and one runner per
/// operation ID. A receipt left open by an ID nobody here holds was
/// interrupted by an earlier daemon process.
pub struct Claim(Vec<String>);

fn claims() -> &'static Mutex<HashSet<String>> {
    static CLAIMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashSet::new()))
}

impl Claim {
    pub fn acquire(workspace_id: &str, operation_id: &str) -> Result<Self> {
        let keys = vec![format!("ws\0{workspace_id}"), format!("op\0{operation_id}")];
        let mut held = claims().lock().unwrap_or_else(|poison| poison.into_inner());
        ensure!(
            !held.contains(&keys[1]),
            "Operation {operation_id} is still running"
        );
        ensure!(
            !held.contains(&keys[0]),
            "Another checkpoint operation is running on this workspace; retry when it finishes"
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

/// A stored effect outcome: `{"ok": reply}` or `{"error": message}`.
pub fn outcome(result: &Result<Value>) -> Value {
    match result {
        Ok(reply) => serde_json::json!({ "ok": reply }),
        Err(error) => serde_json::json!({ "error": format!("{error:#}") }),
    }
}

pub fn replay_outcome(stored: Option<Value>) -> Result<Value> {
    let stored = stored.context("Settled operation has no stored result")?;
    if let Some(reply) = stored.get("ok") {
        return Ok(reply.clone());
    }
    match stored.get("error").and_then(Value::as_str) {
        Some(message) => Err(anyhow!("{message}")),
        None => bail!("Stored operation result is invalid"),
    }
}
