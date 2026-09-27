//! Staging and placing plugin artifacts. Every source is copied into a private
//! staging directory, walked, digested and only then moved into the
//! content-addressed artifact store. Symbolic links and special files are
//! refused so an artifact never points outside itself.
use super::manifest::relative_path_problem;
use ade_core::contract::plugins::{MANIFEST_FILE, PluginSource, PluginSourceKind, PluginSourcePin};
use anyhow::{Context, Result, anyhow, bail, ensure};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(180);
const TAR_TIMEOUT: Duration = Duration::from_secs(120);

/// An artifact unpacked into staging and not yet placed.
pub struct Staged {
    /// The staging directory to delete afterwards.
    pub staging: PathBuf,
    /// The artifact root inside `staging`.
    pub root: PathBuf,
    pub files: BTreeSet<String>,
    /// `sha256:<hex>` over the artifact's files.
    pub digest: String,
    pub pin: PluginSourcePin,
}

impl Staged {
    pub fn manifest_bytes(&self) -> Result<Vec<u8>> {
        ensure!(
            self.files.contains(MANIFEST_FILE),
            "Plugin artifact has no {MANIFEST_FILE} at its root"
        );
        let path = self.root.join(MANIFEST_FILE);
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(super::manifest::MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

/// Removes a staging directory; failures only leave garbage for the next open.
pub fn discard(staging: &Path) {
    let _ = fs::remove_dir_all(staging);
}

/// Copies, extracts or clones `source` into a new directory under `staging_root`.
pub fn stage(source: &PluginSource, staging_root: &Path) -> Result<Staged> {
    fs::create_dir_all(staging_root)?;
    let staging = staging_root.join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir(&staging)?;
    let staged = stage_into(source, &staging);
    if staged.is_err() {
        discard(&staging);
    }
    staged
}

fn stage_into(source: &PluginSource, staging: &Path) -> Result<Staged> {
    let (root, pin) = match source {
        PluginSource::Local { path } => {
            let from = absolute(path)?;
            ensure!(from.is_dir(), "Local plugin source is not a directory");
            let root = staging.join("artifact");
            copy_tree(&from, &root)?;
            let (_, digest) = walk(&root)?;
            (
                root,
                PluginSourcePin {
                    kind: PluginSourceKind::Local,
                    locator: from.to_string_lossy().into_owned(),
                    git_ref: None,
                    pin: digest,
                },
            )
        }
        PluginSource::Package { path, sha256 } => {
            let archive = absolute(path)?;
            ensure!(archive.is_file(), "Package plugin source is not a file");
            let actual = file_sha256(&archive)?;
            if let Some(expected) = sha256 {
                ensure!(
                    expected.eq_ignore_ascii_case(&actual),
                    "Package archive SHA-256 is {actual}, not the pinned {expected}"
                );
            }
            let extract = staging.join("extract");
            fs::create_dir(&extract)?;
            let mut tar = Command::new("tar");
            tar.arg("-xzf").arg(&archive).arg("-C").arg(&extract);
            run(&mut tar, TAR_TIMEOUT, "tar")?;
            // `pnpm pack` and `npm pack` put everything under `package/`.
            let nested = extract.join("package");
            let root = if nested.is_dir() && fs::read_dir(&extract)?.count() == 1 {
                nested
            } else {
                extract
            };
            (
                root,
                PluginSourcePin {
                    kind: PluginSourceKind::Package,
                    locator: archive.to_string_lossy().into_owned(),
                    git_ref: None,
                    pin: format!("sha256:{actual}"),
                },
            )
        }
        PluginSource::Git {
            url,
            git_ref,
            commit,
        } => {
            let root = staging.join("repository");
            let commit = clone(url, git_ref.as_deref(), commit.as_deref(), &root)?;
            fs::remove_dir_all(root.join(".git"))?;
            (
                root,
                PluginSourcePin {
                    kind: PluginSourceKind::Git,
                    locator: url.clone(),
                    git_ref: git_ref.clone(),
                    pin: commit,
                },
            )
        }
    };
    let (files, digest) = walk(&root)?;
    Ok(Staged {
        staging: staging.to_owned(),
        root,
        files,
        digest,
        pin,
    })
}

/// Moves a staged artifact to `<artifacts>/<id>/<version>-<digest prefix>`.
/// An existing directory there is reused only when its digest matches.
pub fn place(staged: &Staged, artifacts: &Path, id: &str, version: &str) -> Result<PathBuf> {
    let hex = staged
        .digest
        .strip_prefix("sha256:")
        .context("Artifact digest is malformed")?;
    let parent = artifacts.join(id);
    fs::create_dir_all(&parent)?;
    let target = parent.join(format!("{version}-{}", &hex[..16]));
    if target.exists() {
        let (_, existing) = walk(&target)?;
        ensure!(
            existing == staged.digest,
            "Installed artifact at {} does not match its digest; remove it before reinstalling",
            target.display()
        );
        return Ok(target);
    }
    fs::rename(&staged.root, &target)?;
    Ok(target)
}

/// Confirms an installed artifact still has the digest it was installed with.
pub fn verify(path: &Path, digest: &str) -> Result<()> {
    let (_, actual) = walk(path).with_context(|| {
        format!(
            "Installed plugin artifact at {} is unreadable",
            path.display()
        )
    })?;
    ensure!(
        actual == digest,
        "Installed plugin artifact at {} changed since installation",
        path.display()
    );
    Ok(())
}

fn absolute(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(path.is_absolute(), "Plugin source path must be absolute");
    Ok(fs::canonicalize(path)?)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= MAX_BYTES,
        "Plugin package exceeds {MAX_BYTES} bytes"
    );
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every regular file under `root` and the tree digest: SHA-256 over each
/// sorted relative path, a NUL, the file's SHA-256 and a newline.
pub fn walk(root: &Path) -> Result<(BTreeSet<String>, String)> {
    let mut files = BTreeSet::new();
    let mut hashes = Vec::new();
    let mut total = 0u64;
    let mut pending = vec![(root.to_owned(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("Plugin artifact has a file name that is not UTF-8"))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if let Some(problem) = relative_path_problem(&relative) {
                bail!("Plugin artifact path {relative} {problem}");
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push((entry.path(), relative));
            } else if kind.is_file() {
                ensure!(
                    files.len() < MAX_FILES,
                    "Plugin artifact has too many files"
                );
                let path = entry.path();
                total += fs::symlink_metadata(&path)?.len();
                ensure!(
                    total <= MAX_BYTES,
                    "Plugin artifact exceeds {MAX_BYTES} bytes"
                );
                hashes.push((relative.clone(), file_sha256(&path)?));
                files.insert(relative);
            } else {
                bail!("Plugin artifact path {relative} is a link or special file");
            }
        }
    }
    hashes.sort();
    let mut tree = Sha256::new();
    for (path, hash) in &hashes {
        tree.update(path.as_bytes());
        tree.update([0]);
        tree.update(hash.as_bytes());
        tree.update(b"\n");
    }
    Ok((files, format!("sha256:{}", hex(&tree.finalize()))))
}

/// Copies regular files and directories, skipping a top-level `.git`.
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir(to)?;
    let mut pending = vec![(from.to_owned(), to.to_owned(), true)];
    let mut count = 0usize;
    while let Some((source, target, top)) = pending.pop() {
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            if top && entry.file_name() == ".git" {
                continue;
            }
            let kind = entry.file_type()?;
            let destination = target.join(entry.file_name());
            if kind.is_dir() {
                fs::create_dir(&destination)?;
                pending.push((entry.path(), destination, false));
            } else if kind.is_file() {
                count += 1;
                ensure!(count <= MAX_FILES, "Plugin artifact has too many files");
                fs::copy(entry.path(), &destination)?;
            } else {
                bail!(
                    "Local plugin source contains a link or special file: {}",
                    entry.path().display()
                );
            }
        }
    }
    Ok(())
}

/// Whether `value` is safe to pass to Git as a URL or ref argument.
pub fn git_argument(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len())
        && !value.starts_with('-')
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// A full lowercase SHA-1 commit ID.
pub fn commit_id(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Clones `url` without checkout, resolves the pin, and checks it out
/// detached. Submodules are not fetched. Returns the commit ID.
fn clone(url: &str, git_ref: Option<&str>, commit: Option<&str>, into: &Path) -> Result<String> {
    ensure!(git_argument(url, 2048), "Git URL is invalid");
    if let Some(git_ref) = git_ref {
        ensure!(
            git_argument(git_ref, 256) && !git_ref.contains(".."),
            "Git ref is invalid"
        );
    }
    if let Some(commit) = commit {
        ensure!(
            commit_id(commit),
            "Git commit must be a full 40-character commit ID"
        );
    }
    ensure!(
        git_ref.is_some() || commit.is_some(),
        "A Git source needs a ref or a commit"
    );
    let mut command = git(None);
    command
        .args(["clone", "--quiet", "--no-checkout", "--"])
        .arg(url)
        .arg(into);
    run(&mut command, GIT_TIMEOUT, "git clone")?;
    let resolved = match git_ref {
        Some(git_ref) => [
            format!("refs/remotes/origin/{git_ref}^{{commit}}"),
            format!("refs/tags/{git_ref}^{{commit}}"),
        ]
        .iter()
        .find_map(|candidate| rev_parse(into, candidate).ok())
        .ok_or_else(|| anyhow!("Git ref {git_ref} is not a branch or tag of the repository"))?,
        None => rev_parse(into, &format!("{}^{{commit}}", commit.unwrap_or_default()))
            .map_err(|_| anyhow!("Git commit is not in the repository"))?,
    };
    if let Some(commit) = commit {
        ensure!(
            resolved == commit,
            "Git ref resolves to {resolved}, not the pinned commit {commit}"
        );
    }
    let mut checkout = git(Some(into));
    checkout.args(["checkout", "--quiet", "--detach", &resolved]);
    run(&mut checkout, GIT_TIMEOUT, "git checkout")?;
    ensure!(
        rev_parse(into, "HEAD")? == resolved,
        "Git checkout did not land on {resolved}"
    );
    Ok(resolved)
}

fn git(dir: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    if let Some(dir) = dir {
        command.arg("-C").arg(dir);
    }
    command
        .args([
            "-c",
            "advice.detachedHead=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    command
}

fn rev_parse(dir: &Path, spec: &str) -> Result<String> {
    let mut command = git(Some(dir));
    command.args(["rev-parse", "--verify", "--quiet", spec]);
    let output = run(&mut command, GIT_TIMEOUT, "git rev-parse")?;
    let id = output.trim().to_owned();
    ensure!(commit_id(&id), "git rev-parse returned no commit");
    Ok(id)
}

/// Runs a short-output command to completion within `timeout`; kills it on
/// timeout. Stderr is discarded so remote text never reaches replies.
fn run(command: &mut Command, timeout: Duration, label: &str) -> Result<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("Could not start {label}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{label} timed out after {} seconds", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = String::new();
    if let Some(pipe) = child.stdout.take() {
        pipe.take(64 * 1024).read_to_string(&mut stdout)?;
    }
    ensure!(status.success(), "{label} failed");
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_arguments_refuse_option_injection() {
        assert!(git_argument("https://example.com/a.git", 2048));
        assert!(!git_argument("--upload-pack=touch /tmp/x", 2048));
        assert!(!git_argument("a b", 2048));
        assert!(!git_argument("", 2048));
        assert!(commit_id("0123456789abcdef0123456789abcdef01234567"));
        assert!(!commit_id("0123456789ABCDEF0123456789abcdef01234567"));
        assert!(!commit_id("abc"));
    }
}
