//! Daemon-owned review: Git is authoritative; clients send intent, never shell commands.
//! References: Orca's literal pathspecs/per-file reads, T3's bounded diffs, Herdr's
//! demand-driven refresh, Paseo's unborn-index handling, Ghostex's typed operations.
use crate::{
    model::{new_id, now_ms},
    worktrees::{self, ReviewGuard, Worktrees},
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::hash_map::DefaultHasher,
    ffi::CString,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

type StatusCache = Arc<Mutex<Option<(Instant, Value)>>>;
const DIFF_SNAPSHOT_MAX_BYTES: usize = 16 * 1024 * 1024;
const DIFF_PAGE_MAX_BYTES: usize = 240 * 1024;
const DIFF_PAGE_MAX_ROWS: usize = 1000;
const DIFF_SNAPSHOT_TTL: Duration = Duration::from_secs(120);

struct DiffSnapshot {
    workspace_id: String,
    root: String,
    path: String,
    staged: bool,
    revision: String,
    token: String,
    header: String,
    patch: String,
    body_start: usize,
    binary: bool,
    conflict: bool,
    created: Instant,
}

impl DiffSnapshot {
    fn new(
        workspace_id: &str,
        root: &str,
        path: &str,
        staged: bool,
        state: &Value,
        patch: String,
    ) -> Result<Self> {
        let revision = state["revision"]
            .as_str()
            .context("Missing review revision")?
            .to_owned();
        let index_token = state["index_token"]
            .as_str()
            .context("Missing index token")?;
        let token = fingerprint(&[patch.as_bytes(), index_token.as_bytes()]);
        let body_start = patch
            .match_indices("\n@@ ")
            .next()
            .map_or(patch.len(), |(offset, _)| offset + 1);
        let header = patch[..body_start].to_owned();
        ensure!(
            header.len() <= 64 * 1024,
            "Diff header exceeds the paged review limit"
        );
        let binary = patch.contains("Binary files ") || patch.contains("GIT binary patch");
        let conflict = state["files"]
            .as_array()
            .and_then(|files| files.iter().find(|file| file["path"] == path))
            .is_some_and(|file| file["conflict"] == true);
        Ok(Self {
            workspace_id: workspace_id.to_owned(),
            root: root.to_owned(),
            path: path.to_owned(),
            staged,
            revision,
            token,
            header,
            patch,
            body_start,
            binary,
            conflict,
            created: Instant::now(),
        })
    }
}

#[derive(Clone)]
struct DiffCursor {
    snapshot_id: String,
    offset: usize,
    hunk: String,
    old_line: u64,
    new_line: u64,
}

#[derive(Default)]
struct DiffPages {
    snapshots: std::collections::HashMap<String, DiffSnapshot>,
    cursors: std::collections::HashMap<String, DiffCursor>,
}

impl DiffPages {
    fn prune(&mut self) {
        self.snapshots
            .retain(|_, snapshot| snapshot.created.elapsed() < DIFF_SNAPSHOT_TTL);
        self.cursors
            .retain(|_, cursor| self.snapshots.contains_key(&cursor.snapshot_id));
        while self.snapshots.len() > 2 {
            if let Some(oldest) = self
                .snapshots
                .iter()
                .min_by_key(|(_, item)| item.created)
                .map(|(id, _)| id.clone())
            {
                self.snapshots.remove(&oldest);
                self.cursors
                    .retain(|_, cursor| cursor.snapshot_id != oldest);
            }
        }
    }
}

fn bounded_line(line: &str) -> (&str, bool) {
    const LIMIT: usize = 8192;
    if line.len() <= LIMIT {
        return (line, false);
    }
    let mut end = LIMIT;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    (&line[..end], true)
}

fn next_diff_row(raw: &str, state: &mut DiffCursor) -> Value {
    let line = raw.strip_suffix('\n').unwrap_or(raw);
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (text, truncated) = bounded_line(line);
    let (kind, old_line, new_line) = if line.starts_with("@@ ") {
        state.hunk = line.to_owned();
        let mut parts = line.split_whitespace();
        let _ = parts.next();
        state.old_line = parts
            .next()
            .and_then(|part| part.strip_prefix('-'))
            .and_then(|part| part.split(',').next())
            .and_then(|number| number.parse().ok())
            .unwrap_or(0);
        state.new_line = parts
            .next()
            .and_then(|part| part.strip_prefix('+'))
            .and_then(|part| part.split(',').next())
            .and_then(|number| number.parse().ok())
            .unwrap_or(0);
        ("hunk", None, None)
    } else if line.starts_with(' ') {
        let old = state.old_line;
        let new = state.new_line;
        state.old_line += 1;
        state.new_line += 1;
        ("context", Some(old), Some(new))
    } else if line.starts_with('+') {
        let new = state.new_line;
        state.new_line += 1;
        ("added", None, Some(new))
    } else if line.starts_with('-') {
        let old = state.old_line;
        state.old_line += 1;
        ("removed", Some(old), None)
    } else {
        ("meta", None, None)
    };
    json!({"kind":kind,"old_line":old_line,"new_line":new_line,"text":text,
        "hunk":state.hunk,"truncated":truncated})
}

fn page_rows(
    snapshot: &DiffSnapshot,
    cursor: &DiffCursor,
) -> Result<(Vec<Value>, Option<DiffCursor>)> {
    ensure!(
        cursor.offset >= snapshot.body_start && cursor.offset <= snapshot.patch.len(),
        "Invalid diff page cursor"
    );
    let mut next = cursor.clone();
    let mut rows = Vec::new();
    let mut encoded_bytes = 1024 + snapshot.header.len().min(64 * 1024);
    while next.offset < snapshot.patch.len() && rows.len() < DIFF_PAGE_MAX_ROWS {
        let tail = &snapshot.patch[next.offset..];
        let len = tail.find('\n').map_or(tail.len(), |index| index + 1);
        let mut candidate = next.clone();
        let row = next_diff_row(&tail[..len], &mut candidate);
        let size = serde_json::to_vec(&row)?.len() + 1;
        if !rows.is_empty() && encoded_bytes + size > DIFF_PAGE_MAX_BYTES {
            break;
        }
        ensure!(
            encoded_bytes + size <= DIFF_PAGE_MAX_BYTES,
            "Diff row exceeds page limit"
        );
        candidate.offset += len;
        next = candidate;
        encoded_bytes += size;
        rows.push(row);
    }
    let continuation = (next.offset < snapshot.patch.len()).then_some(next);
    Ok((rows, continuation))
}

pub struct Review {
    worktrees: Arc<Worktrees>,
    db: Mutex<Connection>,
    // A short shared cache collapses refreshes from multiple windows. No polling
    // or repository scan exists when no Changes window requests it.
    cache: Mutex<std::collections::HashMap<String, StatusCache>>,
    diff_pages: Mutex<DiffPages>,
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0') && s.len() <= 16384)
        .with_context(|| format!("Missing or invalid {key}"))
}
fn fingerprint(parts: &[&[u8]]) -> String {
    let mut h = DefaultHasher::new();
    for part in parts {
        part.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}
fn path_arg(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && !path.contains('\0')
            && path.len() <= 4096
            && Path::new(path)
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Invalid repository-relative path"
    );
    Ok(())
}
#[derive(PartialEq, Eq)]
struct DiscardFileState {
    device: u64,
    inode: u64,
    length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
    digest: String,
}

fn discard_file_digest(path: &Path) -> Result<Option<DiscardFileState>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path);
    let mut file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "Discard target is not an ordinary file");
    ensure!(
        metadata.len() <= 64 * 1024 * 1024,
        "Discard target exceeds the 64 MiB safety limit"
    );
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut bytes)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        ensure!(
            total <= 64 * 1024 * 1024,
            "Discard target exceeds the 64 MiB safety limit"
        );
        hash.update(&bytes[..read]);
    }
    let after = file.metadata()?;
    ensure!(
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ) == (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec()
        ),
        "File changed while checking discard preconditions"
    );
    Ok(Some(DiscardFileState {
        device: after.dev(),
        inode: after.ino(),
        length: after.len(),
        modified: (after.mtime(), after.mtime_nsec()),
        changed: (after.ctime(), after.ctime_nsec()),
        digest: format!("{:x}", hash.finalize()),
    }))
}

#[cfg(target_os = "macos")]
fn discard_parent(root: &Path, relative: &Path, binding: (u64, u64)) -> Result<fs::File> {
    let mut directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)?;
    let identity = directory.metadata()?;
    ensure!(
        (identity.dev(), identity.ino()) == binding,
        "Discard root changed during execution; inspect the workspace before retrying"
    );
    for component in relative
        .parent()
        .context("Missing discard parent")?
        .components()
    {
        let Component::Normal(name) = component else {
            bail!("Invalid discard path component")
        };
        let name = CString::new(name.as_bytes())?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        directory = unsafe { fs::File::from_raw_fd(descriptor) };
    }
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn discard_exchange(
    root: &Path,
    root_binding: (u64, u64),
    stage_root: &Path,
    stage_binding: (u64, u64),
    relative: &Path,
    flags: libc::c_uint,
) -> Result<()> {
    let target_parent = discard_parent(root, relative, root_binding)?;
    let staged_parent = discard_parent(stage_root, relative, stage_binding)?;
    let target = root.join(relative);
    let staged = stage_root.join(relative);
    let target_name = CString::new(
        target
            .file_name()
            .context("Missing discard filename")?
            .as_bytes(),
    )?;
    let staged_name = CString::new(
        staged
            .file_name()
            .context("Missing staged filename")?
            .as_bytes(),
    )?;
    let target_metadata = target_parent.metadata()?;
    let stage_metadata = staged_parent.metadata()?;
    ensure!(
        target_metadata.dev() == stage_metadata.dev(),
        "Discard backup is not on the target volume; no file was changed"
    );
    // ADE supports destructive exchange only on local APFS. Some filesystems
    // report RENAME_SWAP support without honoring its no-loss semantics.
    let mut volume: libc::statfs = unsafe { std::mem::zeroed() };
    let checked = unsafe { libc::fstatfs(target_parent.as_raw_fd(), &raw mut volume) };
    ensure!(checked == 0, "Could not verify discard filesystem");
    let kind = unsafe { std::ffi::CStr::from_ptr(volume.f_fstypename.as_ptr()) };
    ensure!(
        kind.to_bytes() == b"apfs" && volume.f_flags & (libc::MNT_LOCAL as u32) != 0,
        "Discard requires a verified local APFS volume"
    );
    if flags == libc::RENAME_SWAP {
        let probe_id = new_id("discard-probe");
        let probe_a = staged
            .parent()
            .unwrap()
            .join(format!(".ade-swap-probe-{probe_id}-a"));
        let probe_b = staged
            .parent()
            .unwrap()
            .join(format!(".ade-swap-probe-{probe_id}-b"));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_a)?
            .write_all(b"a")?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_b)?
            .write_all(b"b")?;
        let a = CString::new(probe_a.file_name().unwrap().as_bytes())?;
        let b = CString::new(probe_b.file_name().unwrap().as_bytes())?;
        let probe = unsafe {
            libc::renameatx_np(
                staged_parent.as_raw_fd(),
                a.as_ptr(),
                staged_parent.as_raw_fd(),
                b.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        ensure!(
            probe == 0 && fs::read(&probe_a)? == b"b" && fs::read(&probe_b)? == b"a",
            "Discard filesystem did not exchange probe files; no user file was changed"
        );
        fs::remove_file(probe_a)?;
        fs::remove_file(probe_b)?;
    }
    let result = unsafe {
        libc::renameatx_np(
            staged_parent.as_raw_fd(),
            staged_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            flags,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    target_parent.sync_all()?;
    staged_parent.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn discard_exchange(
    _root: &Path,
    _root_binding: (u64, u64),
    _stage_root: &Path,
    _stage_binding: (u64, u64),
    _relative: &Path,
    _flags: libc::c_uint,
) -> Result<()> {
    bail!("Reviewed discard requires a supported macOS APFS volume")
}

fn discard_stage_path(git: &Git<'_>, request_id: &str, path: &str) -> Result<PathBuf> {
    let private = git.text(&[
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "ade-discard-v1",
    ])?;
    let private = Path::new(private.trim_end());
    match fs::create_dir(private) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let private_dir = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(private)?;
    private_dir.set_permissions(fs::Permissions::from_mode(0o700))?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}", git.root, request_id).as_bytes())
    );
    let stage = private.join(key);
    fs::create_dir(&stage)?;
    let stage_dir = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&stage)?;
    stage_dir.set_permissions(fs::Permissions::from_mode(0o700))?;
    let prefix = format!("{}/", stage.display());
    worktrees::successful(&git.run(
        &["checkout-index", &format!("--prefix={prefix}"), "--", path],
        None,
        30,
    )?)?;
    let staged = stage.join(path);
    ensure!(
        fs::symlink_metadata(&staged)?.file_type().is_file(),
        "Index did not materialize an ordinary file for discard"
    );
    fs::File::open(&staged)?.sync_all()?;
    let mut directory = staged.parent().unwrap();
    loop {
        fs::File::open(directory)?.sync_all()?;
        if directory == stage {
            break;
        }
        directory = directory.parent().context("Incomplete discard stage")?;
    }
    private_dir.sync_all()?;
    Ok(stage)
}
struct Git<'a> {
    root: &'a str,
    guard: &'a ReviewGuard,
    binding: (u64, u64),
    common_binding: Option<(u64, u64)>,
}
impl Git<'_> {
    fn ensure_root_bound(&self) -> Result<()> {
        ensure!(
            fs::metadata(self.root)
                .is_ok_and(|item| { item.is_dir() && (item.dev(), item.ino()) == self.binding }),
            ade_core::error::NeedsRebind
        );
        Ok(())
    }
    fn worker_command(&self, args: &[&str]) -> Result<Command> {
        let mut c = Command::new(std::env::current_exe()?);
        c.args(["--worktree-worker", "git"]);
        worktrees::neutral(&mut c);
        c.current_dir(self.root)
            .env("ADE_EXPECT_CWD_DEV", self.binding.0.to_string())
            .env("ADE_EXPECT_CWD_INO", self.binding.1.to_string())
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_EDITOR", "true")
            .args(["-c", "color.ui=false", "-c", "core.quotePath=true"])
            .args(args);
        if let Some((device, inode)) = self.common_binding {
            c.env("ADE_EXPECT_GIT_COMMON_DEV", device.to_string())
                .env("ADE_EXPECT_GIT_COMMON_INO", inode.to_string());
        }
        if cfg!(debug_assertions)
            && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
            && let Ok(directory) = std::env::var("ADE_E2E_REVIEW_PAUSE_DIR")
        {
            c.env_remove("ADE_E2E_REVIEW_PAUSE_DIR")
                .env("ADE_E2E_WORKER_PAUSE_DIR", directory);
        }
        Ok(c)
    }
    fn run(&self, args: &[&str], input: Option<Vec<u8>>, timeout: u64) -> Result<Value> {
        let c = self.worker_command(args)?;
        worktrees::run_input(c, timeout, Some(&self.guard.file), input)
    }
    fn stream_diff(&self, args: &[&str], untracked: bool) -> Result<String> {
        let mut command = self.worker_command(args)?;
        let fd = self.guard.file.as_raw_fd();
        command
            .env("ADE_LIFECYCLE_LOCK_FD", fd.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let overflow = Arc::new(AtomicBool::new(false));
        let output_overflow = overflow.clone();
        let stdout = child.stdout.take().context("Missing Git stdout")?;
        let output = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
            let mut reader = stdout;
            let mut output = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let count = reader.read(&mut chunk)?;
                if count == 0 {
                    break;
                }
                if output.len().saturating_add(count) > DIFF_SNAPSHOT_MAX_BYTES {
                    output_overflow.store(true, Ordering::Release);
                    break;
                }
                output.extend_from_slice(&chunk[..count]);
            }
            Ok(output)
        });
        let stderr = child.stderr.take().context("Missing Git stderr")?;
        let errors = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
            let mut reader = stderr;
            let mut output = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = reader.read(&mut chunk)?;
                if count == 0 {
                    break;
                }
                if output.len() < 64 * 1024 {
                    output.extend_from_slice(&chunk[..count.min(64 * 1024 - output.len())]);
                }
            }
            Ok(output)
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        let (status, too_large, timed_out) = loop {
            if overflow.load(Ordering::Acquire) {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                break (child.wait()?, true, false);
            }
            if let Some(status) = child.try_wait()? {
                break (status, false, false);
            }
            if Instant::now() >= deadline {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                break (child.wait()?, false, true);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let pipe_deadline = Instant::now() + Duration::from_secs(2);
        while (!output.is_finished() || !errors.is_finished()) && Instant::now() < pipe_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        ensure!(
            output.is_finished() && errors.is_finished(),
            "Git diff output remained open after the worker stopped"
        );
        let bytes = output
            .join()
            .map_err(|_| anyhow::anyhow!("Git stdout reader failed"))??;
        let error_bytes = errors
            .join()
            .map_err(|_| anyhow::anyhow!("Git stderr reader failed"))??;
        ensure!(
            !too_large && !overflow.load(Ordering::Acquire),
            "Diff exceeds the 16 MiB paged review limit"
        );
        ensure!(
            !timed_out,
            "Diff generation exceeded the 15-second review limit"
        );
        ensure!(
            status.success() || untracked && status.code() == Some(1),
            "Git diff failed: {}",
            String::from_utf8_lossy(&error_bytes)
        );
        self.ensure_root_bound()?;
        String::from_utf8(bytes).context("Git diff contains non-UTF-8 text")
    }
    fn text(&self, args: &[&str]) -> Result<String> {
        let out = self.run(args, None, 15)?;
        Ok(worktrees::successful(&out)?.to_owned())
    }
    fn index_token(&self, head: &str) -> Result<String> {
        let index = self.text(&["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
        let mut h = DefaultHasher::new();
        head.hash(&mut h);
        match fs::File::open(index.trim_end()) {
            Ok(mut f) => {
                let mut b = [0; 65536];
                loop {
                    let n = f.read(&mut b)?;
                    if n == 0 {
                        break;
                    }
                    h.write(&b[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                "unborn".hash(&mut h);
            }
            Err(e) => return Err(e.into()),
        }
        Ok(format!("{:016x}", h.finish()))
    }
    fn status(&self) -> Result<Value> {
        self.ensure_root_bound()?;
        let raw = self.text(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--untracked-files=all",
            "--no-renames",
        ])?;
        let mut state = parse_status(&raw)?;
        let head = format!("{}:{}", state["head"], state["branch"]);
        let token = self.index_token(&head)?;
        let mut stamps = String::new();
        for file in state["files"].as_array().unwrap() {
            let path = file["path"].as_str().unwrap();
            if let Ok(m) = fs::symlink_metadata(Path::new(self.root).join(path)) {
                use std::os::unix::fs::MetadataExt;
                stamps.push_str(&format!(
                    "{}:{}:{}:{}:{}:{};",
                    m.ino(),
                    m.len(),
                    m.mtime(),
                    m.mtime_nsec(),
                    m.ctime(),
                    m.ctime_nsec()
                ));
            }
        }
        self.ensure_root_bound()?;
        state["index_token"] = json!(token);
        state["revision"] = json!(fingerprint(&[
            raw.as_bytes(),
            token.as_bytes(),
            stamps.as_bytes()
        ]));
        state["type"] = json!("review_status");
        state["root"] = json!(self.root);
        Ok(state)
    }
    fn diff_source(&self, path: &str, staged: bool, state: &Value) -> Result<String> {
        path_arg(path)?;
        let file = state["files"]
            .as_array()
            .context("Missing changed files")?
            .iter()
            .find(|file| file["path"] == path)
            .context("File is no longer changed; refresh")?;
        ensure!(
            file[if staged { "staged" } else { "unstaged" }] == true,
            "This file has no changes in that area"
        );
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
        ];
        if staged {
            args.push("--cached");
        }
        let untracked = file["untracked"] == true;
        if untracked {
            args.extend(["--no-index", "--", "/dev/null", path]);
        } else {
            args.extend(["--", path]);
        }
        self.stream_diff(&args, untracked)
    }
    fn diff(&self, path: &str, staged: bool) -> Result<Value> {
        path_arg(path)?;
        let state = self.status()?;
        let file = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .context("File is no longer changed; refresh")?;
        ensure!(
            file[if staged { "staged" } else { "unstaged" }] == true,
            "This file has no changes in that area"
        );
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
        ];
        if staged {
            args.push("--cached");
        }
        let untracked = file["untracked"] == true;
        if untracked {
            args.extend(["--no-index", "--", "/dev/null", path]);
        } else {
            args.extend(["--", path]);
        }
        let out = self.run(&args, None, 15)?;
        if !(untracked && out["exit_code"] == 1) {
            worktrees::successful(&out)?;
        }
        let patch = out["stdout"].as_str().context("Missing diff")?;
        let (header, hunks) = split_patch(patch);
        let special = file["conflict"] == true
            || patch.contains("Binary files ")
            || patch.contains("GIT binary patch")
            || header.lines().any(|l| {
                l.starts_with("old mode ")
                    || l.starts_with("new mode ")
                    || l.contains("160000")
                    || l.contains("120000")
            })
            || hunks.is_empty();
        // Do not keep/render a second complete copy of a large patch in each window.
        let token = fingerprint(&[
            patch.as_bytes(),
            state["index_token"].as_str().unwrap().as_bytes(),
        ]);
        Ok(
            json!({"type":"review_diff","path":path,"staged":staged,"token":token,
            "header":header,"hunks":hunks,"hunk_actions":!special,"conflict":file["conflict"],"binary":patch.contains("Binary files "),"bytes":patch.len()}),
        )
    }
}
fn parse_status(raw: &str) -> Result<Value> {
    let mut files = Vec::new();
    let mut branch = "";
    let mut head = "";
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(v) = record.strip_prefix("# branch.head ") {
            branch = v;
            continue;
        }
        if let Some(v) = record.strip_prefix("# branch.oid ") {
            head = v;
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        let (path, xy, sub, conflict, untracked) = if let Some(path) = record.strip_prefix("? ") {
            (path, "??", "N...", false, true)
        } else {
            let n = match record.as_bytes()[0] {
                b'1' => 9,
                b'2' => 10,
                b'u' => 11,
                _ => bail!("Unsupported Git status entry"),
            };
            let fields: Vec<_> = record.splitn(n, ' ').collect();
            ensure!(fields.len() == n, "Malformed Git status");
            if record.starts_with('2') {
                records.next().context("Missing rename source")?;
            }
            (
                fields[n - 1],
                fields[1],
                fields[2],
                record.starts_with('u'),
                false,
            )
        };
        path_arg(path)?;
        ensure!(xy.len() == 2, "Malformed status code");
        files.push(json!({"path":path,"code":xy,"staged":!untracked && !conflict && xy.as_bytes()[0]!=b'.',
            "unstaged":untracked || conflict || xy.as_bytes()[1]!=b'.',"conflict":conflict,"untracked":untracked,"submodule":sub!="N..."}));
        ensure!(
            files.len() <= 20000,
            "More than 20,000 changed files; narrow the repository before using Changes"
        );
    }
    Ok(
        json!({"files":files,"branch":branch,"head":head,"conflicts":files.iter().filter(|f|f["conflict"]==true).count()}),
    )
}
fn split_patch(patch: &str) -> (String, Vec<String>) {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::new());
        }
        if let Some(hunk) = hunks.last_mut() {
            hunk.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    (header, hunks)
}
impl Review {
    pub fn open(path: &Path, worktrees: Arc<Worktrees>) -> Result<Arc<Self>> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, root TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);")?;
        db.execute("UPDATE jobs SET result=json_set(result,'$.status','interrupted','$.error','Daemon stopped during Git operation. Refresh and inspect Git history before retrying; this request will not run again.') WHERE json_extract(result,'$.status')='running'",[])?;
        Ok(Arc::new(Self {
            worktrees,
            db: Mutex::new(db),
            cache: Mutex::new(Default::default()),
            diff_pages: Mutex::new(DiffPages::default()),
        }))
    }
    fn job(&self, root: &str, id: &str, request: Option<&Value>) -> Result<Option<Value>> {
        let db = self.db.lock().unwrap();
        let row: Option<(String, String, String)> = db
            .query_row(
                "SELECT root,request,result FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((old_root, old_request, result)) = row {
            ensure!(old_root == root, "Operation belongs to another workspace");
            if let Some(request) = request {
                ensure!(
                    serde_json::from_str::<Value>(&old_request)? == *request,
                    "Request ID was used for different parameters"
                );
            }
            return Ok(Some(
                json!({"type":"review_operation","operation":serde_json::from_str::<Value>(&result)?}),
            ));
        }
        Ok(None)
    }
    pub fn validate_anchor_then<T>(
        &self,
        root: &str,
        workspace_binding: (u64, u64),
        common_binding: Option<(u64, u64)>,
        anchor: &Value,
        admit: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let metadata = fs::metadata(root)?;
        ensure!(
            metadata.is_dir() && (metadata.dev(), metadata.ino()) == workspace_binding,
            ade_core::error::NeedsRebind
        );
        let canonical = worktrees::git(root, &["rev-parse", "--show-toplevel"])?;
        let root = canonical.as_str();
        let metadata = fs::metadata(root)?;
        ensure!(metadata.is_dir(), ade_core::error::NeedsRebind);
        let guard = self.worktrees.review_guard(root)?;
        let git = Git {
            root,
            guard: &guard,
            binding: (metadata.dev(), metadata.ino()),
            common_binding,
        };
        let path = string(anchor, "path")?;
        path_arg(path)?;
        let staged = anchor["staged"].as_bool().context("Invalid review side")?;
        let revision = string(anchor, "revision")?;
        let token = string(anchor, "token")?;
        let hunk = string(anchor, "hunk")?;
        let line = anchor["line"]
            .as_u64()
            .filter(|line| *line > 0)
            .context("Invalid review line")?;
        let text = anchor["text"]
            .as_str()
            .filter(|text| text.len() <= 8192)
            .context("Invalid review line text")?;
        let state = git.status()?;
        ensure!(
            state["revision"] == revision,
            "Stale diff: workspace changes moved; refresh Changes"
        );
        let patch = git.diff_source(path, staged, &state)?;
        let snapshot = DiffSnapshot::new("", root, path, staged, &state, patch)?;
        ensure!(
            snapshot.token == token,
            "Stale diff: selected file changed; refresh Changes"
        );
        let mut cursor = DiffCursor {
            snapshot_id: String::new(),
            offset: snapshot.body_start,
            hunk: String::new(),
            old_line: 0,
            new_line: 0,
        };
        let mut found = false;
        for raw in snapshot.patch[snapshot.body_start..].split_inclusive('\n') {
            let row = next_diff_row(raw, &mut cursor);
            if row["hunk"] == hunk
                && row["new_line"] == line
                && row["text"] == text
                && row["truncated"] == false
                && (row["kind"] == "added" || row["kind"] == "context")
            {
                found = true;
                break;
            }
        }
        ensure!(found, "Stale diff: selected line changed; refresh Changes");
        ensure!(
            git.status()?["revision"] == revision,
            "Stale diff: workspace changes moved; refresh Changes"
        );
        admit()
    }
    pub fn command(
        self: &Arc<Self>,
        root: &str,
        workspace_binding: (u64, u64),
        common_binding: Option<(u64, u64)>,
        request: &Value,
    ) -> Result<Value> {
        let metadata = fs::metadata(root)?;
        ensure!(
            metadata.is_dir() && (metadata.dev(), metadata.ino()) == workspace_binding,
            ade_core::error::NeedsRebind
        );
        let canonical = worktrees::git(root, &["rev-parse", "--show-toplevel"])?;
        let git_root = canonical.as_str();
        let metadata = fs::metadata(git_root)?;
        let binding = (metadata.dev(), metadata.ino());
        ensure!(
            metadata.is_dir()
                && fs::metadata(root).is_ok_and(|item| {
                    item.is_dir() && (item.dev(), item.ino()) == workspace_binding
                }),
            ade_core::error::NeedsRebind
        );
        let root = git_root;
        let op = string(request, "op")?;
        if op == "review.operation" {
            return self
                .job(root, string(request, "request_id")?, None)?
                .context("Unknown review operation");
        }
        if op == "review.status" {
            // Coalesce per workspace; one slow repository never holds the cache
            // map or blocks reads for another repository.
            let entry = {
                let mut cache = self.cache.lock().unwrap();
                if cache.len() >= 64 && !cache.contains_key(root) {
                    cache.clear();
                }
                cache
                    .entry(root.into())
                    .or_insert_with(|| Arc::new(Mutex::new(None)))
                    .clone()
            };
            let mut cached = entry.lock().unwrap();
            if let Some((time, value)) = cached.as_ref()
                && time.elapsed() < Duration::from_millis(750)
                && request["force"] != true
            {
                return Ok(value.clone());
            }
            let guard = self.worktrees.review_guard(root)?;
            let state = Git {
                root,
                guard: &guard,
                binding,
                common_binding,
            }
            .status()?;
            *cached = Some((Instant::now(), state.clone()));
            return Ok(state);
        }
        if op == "review.diff" {
            let guard = self.worktrees.review_guard(root)?;
            return Git {
                root,
                guard: &guard,
                binding,
                common_binding,
            }
            .diff(string(request, "path")?, request["staged"] == true);
        }
        if op == "review.diff_page" {
            let workspace_id = string(request, "workspace_id")?;
            let path = string(request, "path")?;
            path_arg(path)?;
            let staged = request["staged"].as_bool().context("Invalid review side")?;
            let guard = self.worktrees.review_guard(root)?;
            let git = Git {
                root,
                guard: &guard,
                binding,
                common_binding,
            };
            let state = git.status()?;
            let revision = state["revision"]
                .as_str()
                .context("Missing review revision")?;
            let (snapshot_id, cursor) = if request.get("cursor").is_some() {
                let cursor_id = string(request, "cursor")?;
                ensure!(cursor_id.len() <= 128, "Invalid diff page cursor");
                let mut pages = self.diff_pages.lock().unwrap();
                pages.prune();
                let cursor = pages
                    .cursors
                    .get(cursor_id)
                    .context("Diff page cursor expired; refresh Changes")?
                    .clone();
                let snapshot = pages
                    .snapshots
                    .get(&cursor.snapshot_id)
                    .context("Diff page cursor expired; refresh Changes")?;
                ensure!(
                    snapshot.workspace_id == workspace_id
                        && snapshot.root == root
                        && snapshot.path == path
                        && snapshot.staged == staged,
                    "Diff page cursor belongs to another file or side"
                );
                ensure!(
                    snapshot.revision == revision,
                    "Stale diff: workspace changes moved; refresh Changes"
                );
                (cursor.snapshot_id.clone(), cursor)
            } else {
                let patch = git.diff_source(path, staged, &state)?;
                ensure!(
                    git.status()?["revision"] == revision,
                    "Stale diff: workspace changes moved; refresh Changes"
                );
                let snapshot = DiffSnapshot::new(workspace_id, root, path, staged, &state, patch)?;
                let snapshot_id = new_id("diff");
                let cursor = DiffCursor {
                    snapshot_id: snapshot_id.clone(),
                    offset: snapshot.body_start,
                    hunk: String::new(),
                    old_line: 0,
                    new_line: 0,
                };
                let mut pages = self.diff_pages.lock().unwrap();
                pages.prune();
                pages.snapshots.insert(snapshot_id.clone(), snapshot);
                pages.prune();
                (snapshot_id, cursor)
            };
            let mut pages = self.diff_pages.lock().unwrap();
            let snapshot = pages
                .snapshots
                .get(&snapshot_id)
                .context("Diff page cursor expired; refresh Changes")?;
            if let Some(expected) = request.get("expected_token") {
                ensure!(
                    expected.as_str() == Some(snapshot.token.as_str()),
                    "Stale diff: token changed; refresh Changes"
                );
            }
            let (rows, continuation) = page_rows(snapshot, &cursor)?;
            let token = snapshot.token.clone();
            let header = snapshot.header.clone();
            let bytes = snapshot.patch.len();
            let binary = snapshot.binary;
            let conflict = snapshot.conflict;
            let next_cursor = continuation.map(|continuation| {
                let id = new_id("diff_page");
                if pages.cursors.len() >= 4096 {
                    pages.cursors.clear();
                }
                pages.cursors.insert(id.clone(), continuation);
                id
            });
            return Ok(
                json!({"type":"review_diff_page","path":path,"staged":staged,
                "revision":revision,"token":token,"header":header,"rows":rows,
                "next_cursor":next_cursor,"complete":next_cursor.is_none(),
                "binary":binary,"conflict":conflict,"bytes":bytes}),
            );
        }
        ensure!(
            [
                "review.stage",
                "review.unstage",
                "review.hunk",
                "review.commit",
                "review.discard"
            ]
            .contains(&op),
            "Unknown review operation"
        );
        let id = string(request, "request_id")?;
        ensure!(id.len() <= 256, "Request ID too long");
        if let Some(job) = self.job(root, id, Some(request))? {
            return Ok(job);
        }
        let guard = self.worktrees.review_guard(root)?;
        if let Some(job) = self.job(root, id, Some(request))? {
            return Ok(job);
        }
        let job = json!({"id":id,"status":"running","started_at":now_ms(),"op":op});
        self.db.lock().unwrap().execute(
            "INSERT INTO jobs(id,root,request,result) VALUES(?1,?2,?3,?4)",
            params![id, root, request.to_string(), job.to_string()],
        )?;
        let hub = self.clone();
        let root = root.to_owned();
        let request = request.clone();
        let mut completed = job.clone();
        std::thread::spawn(move || {
            let git = Git {
                root: &root,
                guard: &guard,
                binding,
                common_binding,
            };
            let result = hub.mutate(&git, &request);
            // Mutation may have persisted a recovery location before an
            // irreversible filesystem step. Preserve it in the final receipt.
            if let Ok(Some(saved)) = hub.job(&root, request["request_id"].as_str().unwrap(), None) {
                completed = saved["operation"].clone();
            }
            match result {
                Ok(value) => {
                    completed["status"] = json!("succeeded");
                    completed["result"] = value;
                }
                Err(e) => {
                    completed["status"] = json!("failed");
                    let failure = ade_core::error::error_envelope(e);
                    completed["error"] = failure["message"].clone();
                    completed["code"] = failure["code"].clone();
                    completed["recovery"] = failure["recovery"].clone();
                }
            }
            completed["finished_at"] = json!(now_ms());
            if let Err(e) = hub.db.lock().unwrap().execute(
                "UPDATE jobs SET result=?1 WHERE id=?2",
                params![
                    completed.to_string(),
                    request["request_id"].as_str().unwrap()
                ],
            ) {
                eprintln!("Could not persist Git receipt: {e}");
            }
            if cfg!(debug_assertions)
                && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                && let Ok(directory) = std::env::var("ADE_E2E_REVIEW_PAUSE_DIR")
            {
                let _ = fs::write(Path::new(&directory).join("done"), completed.to_string());
            }
            drop(guard);
            hub.cache.lock().unwrap().remove(&root);
        });
        Ok(json!({"type":"review_operation","operation":job}))
    }
    fn mutate(&self, git: &Git, request: &Value) -> Result<Value> {
        let state = git.status()?;
        let op = string(request, "op")?;
        if op == "review.commit" {
            let message = string(request, "message")?;
            ensure!(!message.trim().is_empty(), "Commit message is empty");
            ensure!(
                request["index_token"] == state["index_token"],
                "Staged changes or HEAD changed. Review them again before committing."
            );
            ensure!(
                state["conflicts"] == 0,
                "Resolve and stage conflicting files before committing"
            );
            ensure!(
                state["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["staged"] == true),
                "There are no staged changes to commit"
            );
            // Explicit user action: Git owns identity, hooks and signing policy. No
            // add-all, amend, --no-verify, identity overrides, or automatic retry.
            let out = git.run(
                &["commit", "--file=-"],
                Some(message.as_bytes().to_vec()),
                120,
            )?;
            worktrees::successful(&out)?;
            return Ok(
                json!({"head":git.text(&["rev-parse","HEAD"])?.trim(),"output":out["stdout"]}),
            );
        }
        let path = string(request, "path")?;
        path_arg(path)?;
        let file = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .context("File is no longer changed; refresh")?;
        if op == "review.discard" {
            ensure!(
                file["unstaged"] == true
                    && file["untracked"] != true
                    && file["conflict"] != true
                    && file["submodule"] != true,
                "Only tracked, non-conflicted working-tree changes can be discarded"
            );
            ensure!(
                request["revision"] == state["revision"],
                "Changes moved since review; preview the file again before discarding"
            );
            match fs::symlink_metadata(Path::new(git.root).join(path)) {
                Ok(metadata) => ensure!(
                    metadata.file_type().is_file(),
                    "Only ordinary tracked files can be discarded"
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure!(
                        file["code"]
                            .as_str()
                            .is_some_and(|code| code.ends_with('D')),
                        "File changed since review; preview it again"
                    );
                }
                Err(error) => return Err(error.into()),
            }
            let diff = git.diff(path, false)?;
            ensure!(
                request["diff_token"] == diff["token"],
                "Diff changed since preview; preview the file again before discarding"
            );
            ensure!(
                request["revision"] == git.status()?["revision"],
                "Changes moved since preview; preview the file again before discarding"
            );
            let target = Path::new(git.root).join(path);
            let before = discard_file_digest(&target)?;
            let stage_root = discard_stage_path(git, string(request, "request_id")?, path)?;
            let stage_identity = fs::metadata(&stage_root)?;
            let stage_binding = (stage_identity.dev(), stage_identity.ino());
            let staged = stage_root.join(path);
            let staged_before = discard_file_digest(&staged)?
                .context("Index file was not materialized for discard")?;
            // An interrupted operation keeps the old file in this private Git
            // directory. Persist its location before changing the worktree.
            if before.is_some() {
                self.db.lock().unwrap().execute(
                    "UPDATE jobs SET result=json_set(result,'$.backup_path',?1) WHERE id=?2",
                    params![
                        staged.to_string_lossy().as_ref(),
                        string(request, "request_id")?
                    ],
                )?;
            }
            ensure!(
                request["revision"] == git.status()?["revision"],
                "Changes moved since preview; preview the file again before discarding"
            );
            if cfg!(debug_assertions)
                && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                && let Ok(directory) = std::env::var("ADE_E2E_DISCARD_BEFORE_APPLY_DIR")
            {
                let directory = Path::new(&directory);
                fs::write(directory.join("signal"), b"ready")?;
                let deadline = Instant::now() + Duration::from_secs(10);
                while !directory.join("release").exists() {
                    ensure!(
                        Instant::now() < deadline,
                        "Timed out waiting for E2E discard release"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            ensure!(
                before == discard_file_digest(&target)?,
                "File changed during discard; preview it again"
            );
            if cfg!(debug_assertions)
                && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                && let Ok(directory) = std::env::var("ADE_E2E_DISCARD_AFTER_CHECK_DIR")
            {
                let directory = Path::new(&directory);
                fs::write(directory.join("signal"), b"ready")?;
                let deadline = Instant::now() + Duration::from_secs(10);
                while !directory.join("release").exists() {
                    ensure!(
                        Instant::now() < deadline,
                        "Timed out waiting for E2E discard release"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            ensure!(
                request["revision"] == git.status()?["revision"],
                "Changes moved during discard; preview it again"
            );
            if cfg!(debug_assertions)
                && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                && let Ok(directory) = std::env::var("ADE_E2E_DISCARD_BEFORE_SWAP_DIR")
            {
                let directory = Path::new(&directory);
                fs::write(directory.join("signal"), b"ready")?;
                let deadline = Instant::now() + Duration::from_secs(10);
                while !directory.join("release").exists() {
                    ensure!(
                        Instant::now() < deadline,
                        "Timed out waiting for E2E discard release"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            if let Some(original) = &before {
                fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&target)?
                    .sync_all()?;
                discard_exchange(
                    Path::new(git.root),
                    git.binding,
                    &stage_root,
                    stage_binding,
                    Path::new(path),
                    libc::RENAME_SWAP,
                )?;
                if cfg!(debug_assertions)
                    && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                    && let Ok(directory) = std::env::var("ADE_E2E_DISCARD_AFTER_SWAP_DIR")
                {
                    let directory = Path::new(&directory);
                    fs::write(
                        directory.join("signal"),
                        staged.to_string_lossy().as_bytes(),
                    )?;
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while !directory.join("release").exists() {
                        ensure!(
                            Instant::now() < deadline,
                            "Timed out waiting for E2E discard release"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                let displaced = discard_file_digest(&staged)?;
                if !displaced.as_ref().is_some_and(|item| {
                    item.device == original.device
                        && item.inode == original.inode
                        && item.length == original.length
                        && item.digest == original.digest
                }) {
                    if let Err(error) = discard_exchange(
                        Path::new(git.root),
                        git.binding,
                        &stage_root,
                        stage_binding,
                        Path::new(path),
                        libc::RENAME_SWAP,
                    ) {
                        bail!(
                            "Concurrent edit during discard; both versions were retained at {} and {}. Reverse exchange failed: {error}",
                            target.display(),
                            staged.display()
                        );
                    }
                    bail!(
                        "File changed during discard; original path was restored. Inspect it before retrying"
                    );
                }
                if cfg!(debug_assertions)
                    && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                    && let Ok(directory) =
                        std::env::var("ADE_E2E_DISCARD_AFTER_DISPLACED_CHECK_DIR")
                {
                    let directory = Path::new(&directory);
                    fs::write(
                        directory.join("signal"),
                        staged.to_string_lossy().as_bytes(),
                    )?;
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while !directory.join("release").exists() {
                        ensure!(
                            Instant::now() < deadline,
                            "Timed out waiting for E2E discard release"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            } else {
                discard_exchange(
                    Path::new(git.root),
                    git.binding,
                    &stage_root,
                    stage_binding,
                    Path::new(path),
                    libc::RENAME_EXCL,
                )?;
            }
            let installed = discard_file_digest(&target)?;
            ensure!(
                installed
                    .as_ref()
                    .is_some_and(|item| item.device == staged_before.device
                        && item.inode == staged_before.inode
                        && item.length == staged_before.length
                        && item.digest == staged_before.digest),
                "File changed during discard; displaced content remains in the Git backup directory"
            );
            let remaining = git.run(&["diff", "--quiet", "--", path], None, 30)?;
            match remaining["exit_code"].as_i64() {
                Some(0) => {}
                Some(1) => bail!(
                    "File changed during discard; displaced content remains at {}",
                    staged.display()
                ),
                _ => bail!(
                    "Could not verify discard result; inspect {} and {} before continuing",
                    target.display(),
                    staged.display()
                ),
            }
        } else if op == "review.hunk" {
            ensure!(
                file["conflict"] != true,
                "Resolve conflicts before staging hunks"
            );
            let staged = request["staged"] == true;
            let diff = git.diff(path, staged)?;
            ensure!(
                diff["token"] == request["token"],
                "Diff changed since review; reload it before applying a hunk"
            );
            ensure!(
                diff["hunk_actions"] == true,
                "This change must be staged or unstaged as a whole file"
            );
            let index = request["hunk"].as_u64().context("Missing hunk index")? as usize;
            let hunk = diff["hunks"]
                .as_array()
                .and_then(|h| h.get(index))
                .and_then(Value::as_str)
                .context("Unknown hunk")?;
            let patch = format!("{}{hunk}", diff["header"].as_str().unwrap()).into_bytes();
            let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
            if staged {
                args.push("--reverse");
            }
            args.push("-");
            let out = git.run(&args, Some(patch), 30)?;
            worktrees::successful(&out)?;
        } else {
            ensure!(
                request["revision"] == state["revision"],
                "Changes moved since review; refresh before staging or unstaging"
            );
            let args = if op == "review.stage" {
                ensure!(file["unstaged"] == true, "File has no unstaged changes");
                vec!["add", "--", path]
            } else if state["head"] == "(initial)" {
                ensure!(file["staged"] == true, "File has no staged changes");
                vec!["rm", "--cached", "-f", "--", path]
            } else {
                ensure!(file["staged"] == true, "File has no staged changes");
                vec!["restore", "--staged", "--", path]
            };
            let out = git.run(&args, None, 30)?;
            worktrees::successful(&out)?;
        }
        Ok(json!({"changed":path,"action":op,"receipt":new_id("git-result")}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_preserves_literal_paths_and_conflicts() {
        let s=parse_status("# branch.head main\0# branch.oid abc\x001 MM N... 100644 100644 100644 a b [x]\nname\0? --new\0u UU N... 100644 100644 100644 100644 a b c conflict\0").unwrap();
        assert_eq!(s["files"][0]["path"], "[x]\nname");
        assert_eq!(s["files"][0]["staged"], true);
        assert_eq!(s["files"][0]["unstaged"], true);
        assert_eq!(s["conflicts"], 1);
    }
    #[test]
    fn hunks_keep_no_newline_markers() {
        let (header, hunks) = split_patch(
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n@@ -12 +12 @@\n-c\n+d\n",
        );
        assert!(header.ends_with("+++ b/a\n"));
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0].contains("\\ No newline"));
    }
    #[test]
    fn paths_cannot_escape() {
        for p in ["../a", "/a", "a/../b", ""] {
            assert!(path_arg(p).is_err());
        }
        for p in ["[a]", ":(glob)*", "--file", "space name"] {
            assert!(path_arg(p).is_ok());
        }
    }
}
