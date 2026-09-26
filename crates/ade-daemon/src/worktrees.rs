//! Worktrunk lifecycle operations. No shell aliases, editor launch, or provisioning policy.
//! Commands run off the client/Conversation path; intent survives daemon failure.
use crate::model::{new_id, now_ms};
use ade_core::error::LifecycleFailure;
use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub use ade_core::worktrees::Config;

#[derive(Clone, Serialize, Deserialize)]
struct Repository {
    id: String,
    root: String,
    common_dir: String,
    #[serde(default)]
    source_common_dir: Option<String>,
    #[serde(default)]
    root_device: Option<String>,
    #[serde(default)]
    root_inode: Option<String>,
    #[serde(default)]
    source_root_device: Option<String>,
    #[serde(default)]
    source_root_inode: Option<String>,
    #[serde(default)]
    common_device: Option<String>,
    #[serde(default)]
    common_inode: Option<String>,
    #[serde(default)]
    source_common_device: Option<String>,
    #[serde(default)]
    source_common_inode: Option<String>,
    #[serde(default)]
    needs_rebind: bool,
    #[serde(default)]
    binding_generation: i64,
    config: Config,
    cache: Value,
    refreshed_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Operation {
    id: String,
    repository_id: String,
    #[serde(default)]
    binding_generation: i64,
    request: Value,
    #[serde(default)]
    worktree_path: Option<String>,
    status: String,
    result: Value,
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
}
impl Operation {
    fn failure(&mut self, error: anyhow::Error) {
        let envelope = ade_core::error::error_envelope(error);
        self.error = envelope["message"].as_str().map(str::to_owned);
        self.code = envelope["code"].as_str().map(str::to_owned);
        self.recovery = envelope["recovery"].as_str().map(str::to_owned);
    }
}
struct Data {
    db: Connection,
    busy: HashSet<String>,
    leases: HashMap<PathBuf, usize>,
    removing: HashSet<PathBuf>,
}
fn identity(path: &str) -> Result<(String, String)> {
    let metadata = std::fs::metadata(path).context("Repository path is unavailable")?;
    ensure!(metadata.is_dir(), "Repository path must be a directory");
    Ok((metadata.dev().to_string(), metadata.ino().to_string()))
}
fn within_saved_identity(path: &Path, saved: (&str, &str)) -> bool {
    path.ancestors().any(|ancestor| {
        std::fs::metadata(ancestor).is_ok_and(|metadata| {
            metadata.dev().to_string() == saved.0 && metadata.ino().to_string() == saved.1
        })
    })
}
fn repository_binding_matches(repository: &Repository) -> bool {
    let Some((root_device, root_inode, common_device, common_inode)) = repository
        .root_device
        .as_deref()
        .zip(repository.root_inode.as_deref())
        .zip(
            repository
                .common_device
                .as_deref()
                .zip(repository.common_inode.as_deref()),
        )
        .map(|((a, b), (c, d))| (a, b, c, d))
    else {
        return false;
    };
    identity(&repository.root)
        .is_ok_and(|(device, inode)| device == root_device && inode == root_inode)
        && identity(&repository.common_dir)
            .is_ok_and(|(device, inode)| device == common_device && inode == common_inode)
}
// Operation receipts are the durable setup ledger. Refreshing the Git listing or
// changing configuration must not turn a failed/interrupted setup into success.
fn setup_state(
    db: &Connection,
    repository: &str,
    binding_generation: i64,
    branch: &str,
    path: &str,
) -> Result<&'static str> {
    let receipt: Option<String> = db.query_row(
        "SELECT data FROM operations WHERE json_extract(data,'$.repository_id')=?1 AND COALESCE(json_extract(data,'$.binding_generation'),0)=?2 AND json_extract(data,'$.request.op')='worktree.switch' AND (json_extract(data,'$.request.target')=?3 OR json_extract(data,'$.request.target')=?4 OR json_extract(data,'$.worktree_path')=?4) ORDER BY rowid DESC LIMIT 1",
        params![repository, binding_generation, branch, path], |row| row.get(0),
    ).optional()?;
    Ok(match receipt {
        Some(row) => match serde_json::from_str::<Operation>(&row)?.status.as_str() {
            "succeeded" => "ready",
            "running" => "preparing",
            "interrupted" => "interrupted",
            _ => "failed",
        },
        // Existing external checkouts have no lux-ade setup obligation until a
        // lifecycle operation is requested for them.
        None => "ready",
    })
}
pub struct Worktrees {
    data: Mutex<Data>,
    directory: PathBuf,
    binary: String,
    worker: PathBuf,
}
pub struct Lease {
    hub: Arc<Worktrees>,
    path: PathBuf,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut d = self.hub.data.lock().unwrap();
        if let Some(n) = d.leases.get_mut(&self.path) {
            *n -= 1;
            if *n == 0 {
                d.leases.remove(&self.path);
            }
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(db: &Connection, table: &str, id: &str) -> Result<T> {
    let s: Option<String> = db
        .query_row(
            &format!("SELECT data FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(serde_json::from_str(
        &s.context("Unknown worktree record")?,
    )?)
}
fn put(db: &Connection, table: &str, id: &str, value: &impl Serialize) -> Result<()> {
    db.execute(&format!("INSERT INTO {table}(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data"),params![id,serde_json::to_string(value)?])?;
    Ok(())
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .with_context(|| format!("Missing or invalid {k}"))
}
pub(crate) fn neutral(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy();
        if k.starts_with("WORKTRUNK_")
            || k.starts_with("GIT_CONFIG_")
            || [
                "GIT_DIR",
                "GIT_COMMON_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_NAMESPACE",
                "GIT_GLOB_PATHSPECS",
                "GIT_NOGLOB_PATHSPECS",
                "GIT_ICASE_PATHSPECS",
                "GIT_LITERAL_PATHSPECS",
            ]
            .contains(&k.as_ref())
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
}
// Drain both pipes concurrently with bounded retention. Killing a timed-out process
// group prevents a hook's pipe from leaving the worker blocked indefinitely.
fn run(command: Command, timeout: u64, lock: Option<&File>) -> Result<Value> {
    run_input(command, timeout, lock, None)
}
fn e2e_pause_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
}
fn e2e_pause(directory: &Path) -> Result<()> {
    if directory.join("armed").exists() {
        std::fs::write(directory.join("signal"), b"ready")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.join("release").exists() {
            ensure!(
                Instant::now() < deadline,
                "Timed out waiting for E2E worker release"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}
pub(crate) fn run_input(
    mut command: Command,
    timeout: u64,
    lock: Option<&File>,
    input: Option<Vec<u8>>,
) -> Result<Value> {
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(lock) = lock {
        let fd = lock.as_raw_fd();
        command.env("ADE_LIFECYCLE_LOCK_FD", fd.to_string());
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    if e2e_pause_enabled()
        && lock.is_some()
        && let Ok(directory) = std::env::var("ADE_E2E_WORKTREE_SPAWN_PAUSE_DIR")
    {
        e2e_pause(Path::new(&directory))?;
    }
    if e2e_pause_enabled()
        && lock.is_some()
        && command.get_args().any(|arg| arg == "remove")
        && let Ok(directory) = std::env::var("ADE_E2E_WORKTREE_REMOVE_PAUSE_DIR")
    {
        e2e_pause(Path::new(&directory))?;
    }
    let mut child = command
        .spawn()
        .map_err(|_| LifecycleFailure::LifecycleUnavailable)?;
    fn drain(
        mut pipe: impl Read + Send + 'static,
    ) -> std::thread::JoinHandle<std::io::Result<(Vec<u8>, bool)>> {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut buf = [0; 8192];
            let mut truncated = false;
            loop {
                let n = pipe.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                let retain = n.min((4 * 1024 * 1024_usize).saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..retain]);
                truncated |= retain < n;
            }
            Ok((kept, truncated))
        })
    }
    let writer = input.map(|bytes| {
        let mut pipe = child.stdin.take().unwrap();
        std::thread::spawn(move || pipe.write_all(&bytes))
    });
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let start = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if start.elapsed() > Duration::from_secs(timeout) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A background hook may keep inherited pipes open after wt exits. Do not join
    // it indefinitely; the repository flock remains inherited by that hook.
    let pipe_deadline = Instant::now() + Duration::from_secs(2);
    while (!stdout.is_finished() || !stderr.is_finished()) && Instant::now() < pipe_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    ensure!(
        stdout.is_finished() && stderr.is_finished(),
        LifecycleFailure::LifecycleOutcomeUnknown
    );
    if let Some(writer) = writer
        && writer.is_finished()
    {
        let _ = writer.join();
    }
    let (out, too_large) = stdout
        .join()
        .map_err(|_| anyhow!("stdout reader failed"))??;
    let (err, err_large) = stderr
        .join()
        .map_err(|_| anyhow!("stderr reader failed"))??;
    ensure!(
        !too_large && !err_large,
        LifecycleFailure::LifecycleInvalidOutput
    );
    Ok(
        json!({"exit_code":code,"stdout":String::from_utf8(out).context("Git output contains non-UTF-8 paths or text")?,"stderr":String::from_utf8_lossy(&err),"elapsed_ms":start.elapsed().as_millis() as u64}),
    )
}
pub(crate) fn successful(output: &Value) -> Result<&str> {
    match output["exit_code"].as_i64() {
        Some(0) => {}
        Some(86) if output["stderr"].as_str() == Some("ADE_WORKER_NEEDS_REBIND_V1\n") => {
            return Err(ade_core::error::NeedsRebind.into());
        }
        Some(_) => return Err(LifecycleFailure::LifecycleCommandFailed.into()),
        None => return Err(LifecycleFailure::LifecycleOutcomeUnknown.into()),
    }
    output["stdout"]
        .as_str()
        .ok_or_else(|| LifecycleFailure::LifecycleInvalidOutput.into())
}

pub(crate) fn git(root: &str, args: &[&str]) -> Result<String> {
    let mut c = Command::new("git");
    neutral(&mut c);
    c.current_dir(root).args(args);
    let o = run(c, 10, None)?;
    Ok(successful(&o)?.trim_end().to_owned())
}

impl Worktrees {
    pub fn open(directory: &Path) -> Result<Arc<Self>> {
        std::fs::create_dir_all(directory)?;
        let config = directory.join("empty.toml");
        if !config.exists() {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&config)?
                .write_all(
                    b"# lux-ade lifecycle defaults. Configure each repository explicitly.\n",
                )?;
        }
        let db = Connection::open(directory.join("lifecycle.sqlite3"))?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            (0..=3).contains(&version),
            "Unsupported lifecycle database version {version}"
        );
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS owned(id TEXT PRIMARY KEY,data TEXT NOT NULL);")?;
        if version < 2 {
            let tx = rusqlite::Transaction::new_unchecked(
                &db,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let rows: Vec<String> = tx
                .prepare("SELECT data FROM repositories")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for row in rows {
                let mut repository: Repository = serde_json::from_str(&row)?;
                if repository.needs_rebind {
                    continue;
                }
                match (identity(&repository.root), identity(&repository.common_dir)) {
                    (Ok((root_device, root_inode)), Ok((common_device, common_inode))) => {
                        repository.root_device = Some(root_device);
                        repository.root_inode = Some(root_inode);
                        repository.common_device = Some(common_device);
                        repository.common_inode = Some(common_inode);
                    }
                    _ => repository.needs_rebind = true,
                }
                put(&tx, "repositories", &repository.id, &repository)?;
            }
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = rusqlite::Transaction::new_unchecked(
                &db,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let rows: Vec<String> = tx
                .prepare("SELECT data FROM repositories")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for row in rows {
                let mut repository: Repository = serde_json::from_str(&row)?;
                // A schema-2 repository already rebound once has lost its source
                // identity. Leave it unknown so another rebind fails closed.
                if repository.binding_generation == 0 {
                    repository.source_root_device = repository.root_device.clone();
                    repository.source_root_inode = repository.root_inode.clone();
                    repository.source_common_device = repository.common_device.clone();
                    repository.source_common_inode = repository.common_inode.clone();
                }
                put(&tx, "repositories", &repository.id, &repository)?;
            }
            tx.pragma_update(None, "user_version", 3)?;
            tx.commit()?;
        }
        let pending: Vec<String> = db
            .prepare("SELECT data FROM operations")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for row in pending {
            let mut op: Operation = serde_json::from_str(&row)?;
            if op.status == "running" {
                op.status = "interrupted".into();
                op.failure(LifecycleFailure::LifecycleOutcomeUnknown.into());
                op.finished_at = Some(now_ms());
                put(&db, "operations", &op.id, &op)?;
            }
        }
        Ok(Arc::new(Self {
            data: Mutex::new(Data {
                db,
                busy: HashSet::new(),
                leases: HashMap::new(),
                removing: HashSet::new(),
            }),
            directory: directory.into(),
            worker: std::env::current_exe()?,
            binary: std::env::var("ADE_WT_BIN").unwrap_or_else(|_| "wt".into()),
        }))
    }
    pub fn active_operations(&self) -> usize {
        self.data.lock().unwrap().busy.len()
    }
    pub fn lease(self: &Arc<Self>, root: &str) -> Result<Lease> {
        self.acquire_lease(root, false)
    }
    /// Agent admission and removal protection are decided under the same lock.
    /// Shells can still open an unprepared checkout to diagnose or repair setup.
    pub fn agent_lease(self: &Arc<Self>, root: &str) -> Result<Lease> {
        self.acquire_lease(root, true)
    }
    fn acquire_lease(self: &Arc<Self>, root: &str, agent: bool) -> Result<Lease> {
        if self.has_pending_rebind()? {
            return Err(ade_core::error::NeedsRebind.into());
        }
        let path = std::fs::canonicalize(root)?;
        let common = if agent {
            git(
                root,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .ok()
            .and_then(|p| std::fs::canonicalize(p).ok())
        } else {
            None
        };
        let branch = if agent && common.is_some() {
            git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default()
        } else {
            String::new()
        };
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.removing.iter().any(|p| path.starts_with(p)),
            "Worktree removal is in progress"
        );
        if agent {
            let rows: Vec<String> =
                d.db.prepare("SELECT data FROM repositories")?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
            for row in rows {
                let repo: Repository = serde_json::from_str(&row)?;
                ensure!(
                    repository_binding_matches(&repo),
                    ade_core::error::NeedsRebind
                );
                let belongs = common.as_deref() == Some(Path::new(&repo.common_dir))
                    || path.starts_with(&repo.root)
                    || repo.cache.as_array().is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item["path"].as_str().is_some_and(|p| path.starts_with(p)))
                    });
                if !belongs {
                    continue;
                }
                ensure!(
                    !d.busy.contains(&repo.id),
                    "Worktree setup/lifecycle operation is in progress"
                );
                let state = setup_state(
                    &d.db,
                    &repo.id,
                    repo.binding_generation,
                    &branch,
                    path.to_str().context("Path must be UTF-8")?,
                )?;
                ensure!(
                    state == "ready",
                    "Worktree setup is {state}; complete a successful Worktree switch before starting an Agent"
                );
            }
        }
        *d.leases.entry(path.clone()).or_default() += 1;
        Ok(Lease {
            hub: self.clone(),
            path,
        })
    }
    /// Review and lifecycle operations share this admission gate and crash-safe flock.
    pub(crate) fn review_guard(self: &Arc<Self>, root: &str) -> Result<ReviewGuard> {
        let lease = self.lease(root)?;
        let state = self.command(&json!({"op":"worktree.repository","path":root}))?;
        let id = state["repository"]["id"]
            .as_str()
            .context("Missing repository")?
            .to_owned();
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.busy.contains(&id),
            "Repository is busy; retry after the current operation"
        );
        ensure!(d.busy.len() < 8, "Too many Git operations");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.directory.join(format!("{id}.lock")))?;
        ensure!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "A Git or Worktrunk command still holds the repository lock"
        );
        d.busy.insert(id.clone());
        Ok(ReviewGuard {
            hub: self.clone(),
            id,
            file,
            _lease: lease,
        })
    }
    fn command_for(&self, repo: &Repository, args: &[String]) -> Result<Command> {
        let (device, inode) = repo
            .root_device
            .as_deref()
            .zip(repo.root_inode.as_deref())
            .ok_or(ade_core::error::NeedsRebind)?;
        let (common_device, common_inode) = repo
            .common_device
            .as_deref()
            .zip(repo.common_inode.as_deref())
            .ok_or(ade_core::error::NeedsRebind)?;
        let mut c = Command::new(&self.worker);
        c.arg("--worktree-worker").arg(&self.binary);
        neutral(&mut c);
        c.current_dir(&repo.root)
            .env("ADE_EXPECT_CWD_DEV", device)
            .env("ADE_EXPECT_CWD_INO", inode)
            .env("ADE_EXPECT_GIT_COMMON_DEV", common_device)
            .env("ADE_EXPECT_GIT_COMMON_INO", common_inode);
        let empty = self.directory.join("empty.toml");
        c.env("WORKTRUNK_SYSTEM_CONFIG_PATH", &empty);
        c.arg("--config").arg(
            repo.config
                .user_config
                .as_deref()
                .map(Path::new)
                .unwrap_or(&empty),
        );
        if let Some(p) = &repo.config.project_config {
            c.env("WORKTRUNK_PROJECT_CONFIG_PATH", p);
        }
        if !repo.config.hooks {
            c.env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "core.hooksPath")
                .env("GIT_CONFIG_VALUE_0", "/dev/null");
        }
        c.args([
            "--config-set",
            "list.json-schema=2",
            "--config-set",
            "list.full=false",
        ]);
        if let Some(template) = &repo.config.path_template {
            c.arg("--config-set").arg(format!(
                "worktree-path={}",
                serde_json::to_string(template).unwrap()
            ));
        }
        c.args(args);
        Ok(c)
    }
    fn list(&self, repo: &Repository, lock: &File) -> Result<Value> {
        let result = run(
            self.command_for(repo, &["list".into(), "--format=json".into()])?,
            repo.config.timeout_seconds,
            Some(lock),
        )?;
        let list: Value =
            serde_json::from_str(successful(&result)?).context("Invalid Worktrunk list JSON")?;
        ensure!(
            list["schema"] == 2,
            "Unsupported Worktrunk list schema; schema 2 is required"
        );
        let mut items = list["items"]
            .as_array()
            .context("Worktrunk omitted items")?
            .clone();
        for item in &mut items {
            if let Some(path) = item["worktree"]["path"].as_str() {
                item["path"] = json!(path);
            }
        }
        Ok(json!(items))
    }
    fn snapshot(&self, id: &str) -> Result<Value> {
        let d = self.data.lock().unwrap();
        let r: Repository = read_json(&d.db, "repositories", id)?;
        let operations: Vec<Value> = d.db
            .prepare("SELECT data FROM operations WHERE json_extract(data, '$.repository_id')=?1 ORDER BY rowid DESC LIMIT 100")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|row| {
                let mut value: Value = serde_json::from_str(&row?)?;
                if let Some(result) = value["result"].as_object_mut() {
                    result.remove("stdout");
                    result.remove("stderr");
                }
                if let Some(error) = value["error"].as_str() {
                    value["error"] = json!(error.chars().take(4096).collect::<String>());
                }
                Ok(value)
            })
            .collect::<Result<_>>()?;
        let mut cache = r.cache.clone();
        if let Some(items) = cache.as_array_mut() {
            for item in items {
                if let Some(path) = item["path"].as_str() {
                    let readiness = setup_state(
                        &d.db,
                        id,
                        r.binding_generation,
                        item["branch"].as_str().unwrap_or(""),
                        path,
                    )?;
                    let owner: Option<String> =
                        d.db.query_row("SELECT data FROM owned WHERE id=?1", [path], |r| r.get(0))
                            .optional()?;
                    item["ade_owned"] = json!(
                        owner
                            .as_deref()
                            .and_then(|v| serde_json::from_str::<Value>(v).ok())
                            .is_some_and(|v| v["repository_id"] == id
                                && std::fs::read_to_string(v["marker"].as_str().unwrap_or(""))
                                    .ok()
                                    .as_deref()
                                    == v["token"].as_str())
                    );
                    item["setup_state"] = json!(if d.busy.contains(id) {
                        "preparing"
                    } else {
                        readiness
                    });
                }
            }
        }
        let mut repository = json!(r);
        repository.as_object_mut().unwrap().remove("cache");
        Ok(
            json!({"type":"worktree_state","repository":repository,"worktrees":cache,"busy":d.busy.contains(id),"operations":operations.into_iter().filter(|o|o["repository_id"]==id).collect::<Vec<_>>()}),
        )
    }
    pub fn has_pending_rebind(&self) -> Result<bool> {
        let d = self.data.lock().unwrap();
        let rows: Vec<String> =
            d.db.prepare("SELECT data FROM repositories")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        for row in rows {
            let repository: Repository = serde_json::from_str(&row)?;
            if repository.needs_rebind || !repository_binding_matches(&repository) {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// If this profile had a lifecycle record for the saved core repository,
    /// the core binding must select the same physical Git repository.
    pub fn validate_core_binding(
        &self,
        saved_common: &str,
        source_identity: (u64, u64),
        selected_common: &str,
    ) -> Result<()> {
        let d = self.data.lock().unwrap();
        let rows: Vec<String> =
            d.db.prepare("SELECT data FROM repositories")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        for row in rows {
            let repository: Repository = serde_json::from_str(&row)?;
            for saved in [
                repository
                    .source_root_device
                    .as_deref()
                    .zip(repository.source_root_inode.as_deref()),
                repository
                    .source_common_device
                    .as_deref()
                    .zip(repository.source_common_inode.as_deref()),
            ]
            .into_iter()
            .flatten()
            {
                ensure!(
                    !within_saved_identity(Path::new(selected_common), saved),
                    "Selected directory belongs to a saved source Worktrunk repository"
                );
            }
            let same_source = repository
                .source_common_device
                .as_deref()
                .zip(repository.source_common_inode.as_deref())
                .is_some_and(|(device, inode)| {
                    device == source_identity.0.to_string()
                        && inode == source_identity.1.to_string()
                });
            if same_source
                || repository.source_common_dir.as_deref() == Some(saved_common)
                || repository.needs_rebind && repository.common_dir == saved_common
            {
                ensure!(
                    !repository.needs_rebind && repository_binding_matches(&repository),
                    "Rebind the matching Worktrunk repository first"
                );
                ensure!(
                    repository.common_dir == selected_common,
                    "Selected Git common directory differs from the Worktrunk binding"
                );
            }
        }
        Ok(())
    }
    fn rebind_repository(&self, id: &str, selected: &str) -> Result<Value> {
        let path = std::fs::canonicalize(selected)
            .context("Selected repository directory is unavailable")?;
        ensure!(path.is_dir(), "Selected repository must be a directory");
        let path_text = path.to_str().context("Path must be UTF-8")?;
        let selected_identity = identity(path_text)?;
        let common = std::fs::canonicalize(git(
            path_text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?)?;
        ensure!(common.is_dir(), "Git common directory is unavailable");
        let common_text = common
            .to_str()
            .context("Git common directory must be UTF-8")?;
        let common_identity = identity(common_text)?;
        let listing = git(path_text, &["worktree", "list", "--porcelain", "-z"])?;
        let primary = listing
            .split('\0')
            .find_map(|line| line.strip_prefix("worktree "))
            .context("Repository has no primary worktree")?;
        let primary = std::fs::canonicalize(primary)?;
        ensure!(
            primary.is_dir(),
            "Primary checkout directory is unavailable"
        );
        let primary_text = primary
            .to_str()
            .context("Primary checkout path must be UTF-8")?;
        let primary_identity = identity(primary_text)?;
        let primary_common = std::fs::canonicalize(git(
            primary_text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?)?;
        ensure!(
            primary_common == common,
            "Selected checkout and primary checkout differ"
        );
        let d = self.data.lock().unwrap();
        let mut repository: Repository = read_json(&d.db, "repositories", id)?;
        let saved_root = repository
            .source_root_device
            .as_deref()
            .zip(repository.source_root_inode.as_deref())
            .context("Saved repository root identity is unavailable; rebind remains fenced")?;
        let saved_common = repository
            .source_common_device
            .as_deref()
            .zip(repository.source_common_inode.as_deref())
            .context("Saved Git common directory identity is unavailable; rebind remains fenced")?;
        ensure!(
            saved_root != (primary_identity.0.as_str(), primary_identity.1.as_str())
                && saved_common != (common_identity.0.as_str(), common_identity.1.as_str()),
            "Select a different physical repository from the saved checkout"
        );
        ensure!(
            repository.needs_rebind || !repository_binding_matches(&repository),
            "Repository is already bound"
        );
        ensure!(
            common != Path::new(&repository.common_dir) || !repository_binding_matches(&repository),
            "Select a different repository from the source checkout"
        );
        ensure!(
            !d.busy.contains(id),
            "Repository lifecycle operation is running"
        );
        ensure!(
            !d.leases
                .keys()
                .any(|lease| lease.starts_with(&path) || lease.starts_with(&primary)),
            "Repository has an active execution lease"
        );
        let rows: Vec<String> =
            d.db.prepare("SELECT data FROM repositories WHERE id!=?1")?
                .query_map([id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        for row in rows {
            let other: Repository = serde_json::from_str(&row)?;
            for saved in [
                other
                    .source_root_device
                    .as_deref()
                    .zip(other.source_root_inode.as_deref()),
                other
                    .source_common_device
                    .as_deref()
                    .zip(other.source_common_inode.as_deref()),
            ]
            .into_iter()
            .flatten()
            {
                ensure!(
                    !within_saved_identity(&primary, saved)
                        && !within_saved_identity(&common, saved),
                    "Selected directory belongs to another saved source repository"
                );
            }
            ensure!(
                other.common_dir != common.to_string_lossy(),
                "Git common directory belongs to another repository identity"
            );
        }
        ensure!(
            std::fs::canonicalize(selected)? == path
                && std::fs::canonicalize(primary_text)? == primary,
            "Repository path changed during rebind"
        );
        let verified_common = std::fs::canonicalize(git(
            path_text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?)?;
        ensure!(
            verified_common == common,
            "Git common directory changed during rebind"
        );
        ensure!(
            identity(path_text)? == selected_identity
                && identity(primary_text)? == primary_identity
                && identity(common_text)? == common_identity,
            "Repository directory changed during rebind"
        );
        repository.root = primary_text.into();
        repository
            .source_common_dir
            .get_or_insert_with(|| repository.common_dir.clone());
        repository.common_dir = common
            .to_str()
            .context("Git common directory must be UTF-8")?
            .into();
        let (root_device, root_inode) = primary_identity;
        let (common_device, common_inode) = common_identity;
        repository.root_device = Some(root_device);
        repository.root_inode = Some(root_inode);
        repository.common_device = Some(common_device);
        repository.common_inode = Some(common_inode);
        repository.needs_rebind = false;
        repository.binding_generation = repository
            .binding_generation
            .checked_add(1)
            .context("Repository binding generation overflow")?;
        repository.cache = json!([]);
        repository.refreshed_at = None;
        repository.config = Config::default();
        let tx =
            rusqlite::Transaction::new_unchecked(&d.db, rusqlite::TransactionBehavior::Immediate)?;
        put(&tx, "repositories", id, &repository)?;
        tx.execute(
            "DELETE FROM owned WHERE json_extract(data,'$.repository_id')=?1",
            [id],
        )?;
        tx.commit()?;
        drop(d);
        self.snapshot(id)
    }
    fn rebind_catalog(&self) -> Result<Value> {
        let d = self.data.lock().unwrap();
        let rows: Vec<String> =
            d.db.prepare("SELECT data FROM repositories ORDER BY rowid")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        let mut repositories = Vec::with_capacity(rows.len());
        for row in rows {
            let repository: Repository = serde_json::from_str(&row)?;
            let rebindable = repository.source_root_device.is_some()
                && repository.source_root_inode.is_some()
                && repository.source_common_device.is_some()
                && repository.source_common_inode.is_some();
            repositories.push(json!({"id":repository.id,"root":repository.root,
                "common_dir":repository.common_dir,
                "needs_rebind":repository.needs_rebind || !repository_binding_matches(&repository),
                "rebindable":rebindable,
                "binding_generation":repository.binding_generation}));
        }
        Ok(json!({"type":"worktree_rebind_catalog","repositories":repositories}))
    }
    pub fn command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let op = field(request, "op")?;
        if op == "worktree.rebind.list" {
            return self.rebind_catalog();
        }
        if op == "worktree.rebind" {
            return self
                .rebind_repository(field(request, "repository_id")?, field(request, "path")?);
        }
        if op != "worktree.operation" && self.has_pending_rebind()? {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if op == "worktree.repository" {
            let path = std::fs::canonicalize(field(request, "path")?)?;
            let path = path.to_str().context("Path must be UTF-8")?;
            let common = git(
                path,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )?;
            let common = std::fs::canonicalize(common)?
                .to_string_lossy()
                .into_owned();
            // Always invoke lifecycle commands from the primary checkout, even
            // when the window that opened this repository belongs to a linked tree.
            let listing = git(path, &["worktree", "list", "--porcelain", "-z"])?;
            let root = listing
                .split('\0')
                .find_map(|line| line.strip_prefix("worktree "))
                .context("Repository has no primary worktree")?
                .to_owned();
            ensure!(
                Path::new(&root).is_dir(),
                "Primary checkout directory is unavailable"
            );
            let d = self.data.lock().unwrap();
            let rows: Vec<String> =
                d.db.prepare("SELECT data FROM repositories")?
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
            for row in rows {
                let mut r: Repository = serde_json::from_str(&row)?;
                if r.common_dir == common {
                    ensure!(repository_binding_matches(&r), ade_core::error::NeedsRebind);
                    if !d.busy.contains(&r.id) {
                        r.root = root.clone();
                        put(&d.db, "repositories", &r.id, &r)?;
                    }
                    drop(d);
                    return self.snapshot(&r.id);
                }
            }
            let r = Repository {
                id: new_id("repository"),
                root_device: Some(identity(&root)?.0),
                root_inode: Some(identity(&root)?.1),
                source_root_device: Some(identity(&root)?.0),
                source_root_inode: Some(identity(&root)?.1),
                common_device: Some(identity(&common)?.0),
                common_inode: Some(identity(&common)?.1),
                source_common_device: Some(identity(&common)?.0),
                source_common_inode: Some(identity(&common)?.1),
                root,
                common_dir: common,
                source_common_dir: None,
                config: Config::default(),
                needs_rebind: false,
                binding_generation: 0,
                cache: json!([]),
                refreshed_at: None,
            };
            put(&d.db, "repositories", &r.id, &r)?;
            drop(d);
            return self.snapshot(&r.id);
        }
        let id = field(request, "repository_id")?;
        if op == "worktree.operation" {
            let d = self.data.lock().unwrap();
            let operation: Operation =
                read_json(&d.db, "operations", field(request, "request_id")?)?;
            ensure!(
                operation.repository_id == id,
                "Operation belongs to another repository"
            );
            return Ok(json!({"type":"worktree_operation","operation":operation}));
        }
        if op == "worktree.get" {
            return self.snapshot(id);
        }
        if op == "worktree.configure" {
            let config: Config = serde_json::from_value(request["config"].clone())?;
            ensure!(
                (5..=300).contains(&config.timeout_seconds),
                "Timeout must be 5–300 seconds"
            );
            for p in [&config.user_config, &config.project_config]
                .into_iter()
                .flatten()
            {
                ensure!(
                    Path::new(p).is_absolute() && Path::new(p).is_file(),
                    "Config must name an existing absolute file"
                );
            }
            if let Some(template) = &config.path_template {
                ensure!(
                    !template.is_empty()
                        && template.len() <= 4096
                        && !template.chars().any(char::is_control),
                    "Invalid worktree path template"
                );
            }
            let d = self.data.lock().unwrap();
            ensure!(
                !d.busy.contains(id),
                "Repository lifecycle operation is running"
            );
            let mut r: Repository = read_json(&d.db, "repositories", id)?;
            r.config = config;
            put(&d.db, "repositories", id, &r)?;
            drop(d);
            return self.snapshot(id);
        }
        ensure!(
            ["worktree.refresh", "worktree.switch", "worktree.remove"].contains(&op),
            "Unknown worktree operation"
        );
        let request_id = field(request, "request_id")?;
        ensure!(request_id.len() <= 256, "Request ID too long");
        let mut d = self.data.lock().unwrap();
        if let Ok(existing) = read_json::<Operation>(&d.db, "operations", request_id) {
            ensure!(
                existing.request == *request,
                "Request ID was already used for different parameters"
            );
            drop(d);
            return self.snapshot(id);
        }
        let repo: Repository = read_json(&d.db, "repositories", id)?;
        ensure!(
            !d.busy.contains(id),
            "Repository lifecycle operation is running"
        );
        ensure!(d.busy.len() < 8, "Too many lifecycle operations");
        let mut remove_path = None;
        let mut remove_identity = None;
        if op == "worktree.switch" {
            let target = field(request, "target")?;
            ensure!(!target.starts_with('-'), "Target cannot begin with '-'");
            if request["base"].is_string() {
                ensure!(!field(request, "base")?.starts_with('-'), "Invalid base");
            }
        }
        if op == "worktree.remove" {
            let path = std::fs::canonicalize(field(request, "path")?)?;
            let text = path.to_str().context("Path must be UTF-8")?;
            let owner: Option<String> =
                d.db.query_row("SELECT data FROM owned WHERE id=?1", [text], |r| r.get(0))
                    .optional()?;
            let ownership: Value = serde_json::from_str(&owner.context(
                "This worktree was not created by lux-ade. Remove it with its original owner.",
            )?)?;
            ensure!(
                ownership["repository_id"] == id
                    && std::fs::read_to_string(ownership["marker"].as_str().unwrap_or(""))
                        .ok()
                        .as_deref()
                        == ownership["token"].as_str(),
                "Worktree ownership changed; refresh and use its original owner"
            );
            ensure!(
                path != Path::new(&repo.root),
                "Cannot remove the repository command directory; open the main checkout first"
            );
            ensure!(
                !d.leases.keys().any(|p| p.starts_with(&path)),
                "Worktree has an active terminal or Agent. Exit its shell and disconnect its Agents before removal."
            );
            if request["force"].as_bool() == Some(true) {
                ensure!(
                    request["confirm_path"].as_str() == Some(text),
                    "Forced removal requires confirm_path matching the full path"
                );
            }
            let policy = request["delete_branch"].as_str().unwrap_or("keep");
            ensure!(
                ["keep", "merged"].contains(&policy),
                "Branch policy must be keep or merged"
            );
            remove_identity = Some(identity(text)?);
            remove_path = Some(path);
        }
        // A supervisor retains the lock if this daemon dies. Its wt child does not
        // inherit the descriptor, so background Git helpers cannot strand it.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.directory.join(format!("{id}.lock")))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if let Some(p) = &remove_path {
                d.removing.remove(p);
            }
            bail!("A previous Worktrunk command or hook still holds the repository lock");
        }
        let job = Operation {
            id: request_id.into(),
            repository_id: id.into(),
            binding_generation: repo.binding_generation,
            request: request.clone(),
            worktree_path: None,
            status: "running".into(),
            result: Value::Null,
            error: None,
            code: None,
            recovery: None,
            started_at: now_ms(),
            finished_at: None,
        };
        if let Err(error) = put(&d.db, "operations", &job.id, &job) {
            if let Some(p) = &remove_path {
                d.removing.remove(p);
            }
            return Err(error);
        }
        if let Some(path) = &remove_path {
            d.removing.insert(path.clone());
        }
        d.busy.insert(id.into());
        drop(d);
        let hub = self.clone();
        std::thread::spawn(move || {
            hub.execute(repo, job, lock, remove_path, remove_identity);
        });
        self.snapshot(id)
    }
    fn execute(
        &self,
        mut repo: Repository,
        mut job: Operation,
        lock: File,
        remove_path: Option<PathBuf>,
        remove_identity: Option<(String, String)>,
    ) {
        let result = (|| -> Result<()> {
            // Recheck after admission and immediately before Worktrunk receives
            // the directory. A later external rename remains detectable on the
            // next command, but cannot be made atomic with an external process.
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            for path in [&repo.config.user_config, &repo.config.project_config]
                .into_iter()
                .flatten()
            {
                ensure!(
                    Path::new(path).is_file(),
                    "Configured Worktrunk file is unavailable: {path}"
                );
            }
            let validation = run(
                self.command_for(
                    &repo,
                    &["config".into(), "show".into(), "--format=json".into()],
                )?,
                repo.config.timeout_seconds,
                Some(&lock),
            )?;
            successful(&validation).context("Worktrunk configuration is invalid")?;
            let before = self.list(&repo, &lock)?;
            if job.request["op"] == "worktree.refresh" {
                repo.cache = before;
                repo.refreshed_at = Some(now_ms());
                return Ok(());
            }
            if job.request["op"] == "worktree.switch"
                && let Some(item) = before.as_array().unwrap().iter().find(|item| {
                    item["branch"] == job.request["target"] || item["path"] == job.request["target"]
                })
            {
                job.worktree_path = Some(field(item, "path")?.into());
                put(&self.data.lock().unwrap().db, "operations", &job.id, &job)?;
            }
            // Worktrunk only runs pre-start automatically on creation. An
            // existing checkout left by failed setup needs that blocking hook
            // rerun before a successful switch can clear its admission barrier.
            if job.request["op"] == "worktree.switch"
                && repo.config.hooks
                && let Some(item) = before.as_array().unwrap().iter().find(|item| {
                    item["branch"] == job.request["target"] || item["path"] == job.request["target"]
                })
            {
                let path = field(item, "path")?;
                let failed_before = {
                    let d = self.data.lock().unwrap();
                    let rows: Vec<String> = d.db.prepare("SELECT data FROM operations WHERE json_extract(data,'$.repository_id')=?1 AND id!=?2 ORDER BY rowid DESC")?
                            .query_map(params![repo.id, job.id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
                    rows.iter()
                        .filter_map(|row| serde_json::from_str::<Operation>(row).ok())
                        .find(|op| {
                            op.request["op"] == "worktree.switch"
                                && (op.request["target"] == item["branch"]
                                    || op.request["target"] == item["path"]
                                    || op.worktree_path.as_deref() == Some(path))
                        })
                        .is_some_and(|op| op.status != "succeeded")
                };
                if failed_before {
                    let mut target = repo.clone();
                    target.root = path.into();
                    let (device, inode) = identity(path)?;
                    let target_common = std::fs::canonicalize(git(
                        path,
                        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                    )?)?;
                    ensure!(
                        target_common == Path::new(&repo.common_dir)
                            && identity(path)? == (device.clone(), inode.clone()),
                        ade_core::error::NeedsRebind
                    );
                    target.root_device = Some(device);
                    target.root_inode = Some(inode);
                    job.result = run(
                        self.command_for(&target, &["hook".into(), "pre-start".into()])?,
                        repo.config.timeout_seconds,
                        Some(&lock),
                    )?;
                    successful(&job.result).context("Worktree setup retry failed")?;
                }
            }
            let mut args = if job.request["op"] == "worktree.switch" {
                let mut a = vec!["switch".into(), "--format=json".into(), "--no-cd".into()];
                if job.request["create"].as_bool() == Some(true) {
                    a.push("--create".into());
                }
                if let Some(base) = job.request["base"].as_str() {
                    a.extend(["--base".into(), base.into()]);
                }
                a
            } else {
                let path = remove_path.as_ref().context("Missing removal path")?;
                let ownership: Value = {
                    let d = self.data.lock().unwrap();
                    let stored: String = d.db.query_row(
                        "SELECT data FROM owned WHERE id=?1",
                        [path.to_string_lossy().as_ref()],
                        |r| r.get(0),
                    )?;
                    serde_json::from_str(&stored)?
                };
                let admin = std::fs::canonicalize(git(
                    path.to_str().context("Path must be UTF-8")?,
                    &["rev-parse", "--absolute-git-dir"],
                )?)?;
                let marker = PathBuf::from(
                    ownership["marker"]
                        .as_str()
                        .context("Missing ownership marker")?,
                );
                ensure!(
                    marker.parent() == Some(admin.as_path())
                        && std::fs::read_to_string(&marker).ok().as_deref()
                            == ownership["token"].as_str(),
                    "Worktree ownership changed before removal"
                );
                ensure!(
                    before
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|i| i["path"].as_str() == path.to_str()),
                    "Worktree no longer belongs to this repository"
                );
                let mut a = vec![
                    "remove".into(),
                    "--format=json".into(),
                    "--foreground".into(),
                ];
                if job.request["delete_branch"].as_str() != Some("merged") {
                    a.push("--no-delete-branch".into());
                }
                if job.request["force"].as_bool() == Some(true) {
                    a.push("--force".into());
                }
                a
            };
            if !repo.config.hooks {
                args.push("--no-hooks".into());
            }
            if remove_path.is_some() {
                args.push("--".into());
            }
            args.push(if let Some(path) = &remove_path {
                path.to_string_lossy().into_owned()
            } else {
                field(&job.request, "target")?.into()
            });
            let mut command = self.command_for(&repo, &args)?;
            if let (Some(path), Some((device, inode))) = (&remove_path, &remove_identity) {
                ensure!(
                    std::fs::canonicalize(path)? == *path,
                    ade_core::error::NeedsRebind
                );
                ensure!(
                    identity(path.to_str().context("Path must be UTF-8")?)?
                        == (device.clone(), inode.clone()),
                    ade_core::error::NeedsRebind
                );
                command
                    .env("ADE_EXPECT_REMOVE_PATH", path)
                    .env("ADE_EXPECT_REMOVE_DEV", device)
                    .env("ADE_EXPECT_REMOVE_INO", inode);
            }
            let output = run(command, repo.config.timeout_seconds, Some(&lock));
            // A failing hook/timeout is not a rollback. Always inspect actual state.
            let after = self.list(&repo, &lock);
            if let Ok(after) = &after {
                repo.cache = after.clone();
                repo.refreshed_at = Some(now_ms());
                for item in after.as_array().unwrap() {
                    if let Some(path) = item["path"].as_str() {
                        if job.request["op"] == "worktree.switch"
                            && (item["branch"] == job.request["target"]
                                || item["path"] == job.request["target"])
                        {
                            job.worktree_path = Some(path.into());
                        }
                        let was_present =
                            before.as_array().unwrap().iter().any(|i| i["path"] == path);
                        // Only claim the requested branch, never another process's tree.
                        if !was_present
                            && item["branch"] == job.request["target"]
                            && job.request["op"] == "worktree.switch"
                        {
                            let admin = git(path, &["rev-parse", "--absolute-git-dir"])?;
                            let marker = Path::new(&admin).join("ade-owner");
                            let token = new_id("ownership");
                            OpenOptions::new()
                                .create_new(true)
                                .write(true)
                                .mode(0o600)
                                .open(&marker)?
                                .write_all(token.as_bytes())?;
                            self.data.lock().unwrap().db.execute(
                                "INSERT OR REPLACE INTO owned(id,data) VALUES(?1,?2)",
                                params![
                                    path,
                                    json!({"repository_id":repo.id,"marker":marker,"token":token})
                                        .to_string()
                                ],
                            )?;
                        }
                    }
                }
            }
            job.result = output?;
            let command_result = successful(&job.result).map(|_| ());
            if let Some(stdout) = job.result["stdout"].as_str()
                && let Ok(value) = serde_json::from_str::<Value>(stdout)
            {
                let first = value.as_array().and_then(|a| a.first()).unwrap_or(&value);
                job.result["branch_outcome"] = first["branch_outcome"].clone();
                job.result["value"] = value;
            }
            if let Err(error) = after {
                if let Err(command_error) = command_result {
                    return Err(command_error.context(format!(
                        "Post-command worktree reconciliation also failed: {error}"
                    )));
                }
                bail!("Command completed; reconciliation failed: {error}");
            }
            command_result?;
            ensure!(
                !job.result["value"].is_null(),
                "Worktrunk returned invalid operation JSON; inspect the refreshed worktree state"
            );
            if let Some(path) = &remove_path {
                ensure!(
                    !repo
                        .cache
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|i| i["path"].as_str() == path.to_str()),
                    "Removal did not remove the worktree"
                );
                self.data.lock().unwrap().db.execute(
                    "DELETE FROM owned WHERE id=?1",
                    [path.to_string_lossy().as_ref()],
                )?;
            }
            Ok(())
        })();
        job.status = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        }
        .into();
        if let Err(error) = result {
            job.failure(error);
        }
        job.finished_at = Some(now_ms());
        // Successful daemon completion releases the inherited lock explicitly;
        // daemon death leaves the supervisor holding it until wt exits.
        unsafe {
            libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
        }
        let mut d = self.data.lock().unwrap();
        if let Err(e) = put(&d.db, "repositories", &repo.id, &repo)
            .and_then(|_| put(&d.db, "operations", &job.id, &job))
        {
            eprintln!("Could not persist worktree completion: {e}");
        }
        d.busy.remove(&repo.id);
        if let Some(path) = remove_path {
            d.removing.remove(&path);
        }
    }
}

/// Internal subprocess entry point. Keep the inherited flock only in this
/// supervisor: Git's fsmonitor daemon must never inherit a lifecycle lock.
pub fn worker_main() -> Result<()> {
    let fd: i32 = std::env::var("ADE_LIFECYCLE_LOCK_FD")?.parse()?;
    ensure!(fd > 2, "Invalid lifecycle lock descriptor");
    ensure!(
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } >= 0,
        "Could not isolate lifecycle lock"
    );
    if e2e_pause_enabled()
        && let Ok(directory) = std::env::var("ADE_E2E_WORKER_PAUSE_DIR")
    {
        e2e_pause(Path::new(&directory))?;
    }
    match (
        std::env::var("ADE_EXPECT_CWD_DEV").ok(),
        std::env::var("ADE_EXPECT_CWD_INO").ok(),
    ) {
        (Some(device), Some(inode)) => {
            let current = std::fs::metadata(".").context("Supervised directory is unavailable")?;
            ensure!(
                current.dev().to_string() == device && current.ino().to_string() == inode,
                ade_core::error::NeedsRebind
            );
        }
        (None, None) => {}
        _ => bail!("Incomplete supervised directory identity"),
    }
    match (
        std::env::var("ADE_EXPECT_GIT_COMMON_DEV").ok(),
        std::env::var("ADE_EXPECT_GIT_COMMON_INO").ok(),
    ) {
        (Some(device), Some(inode)) => {
            let output = Command::new("git")
                .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
                .env("GIT_OPTIONAL_LOCKS", "0")
                .output()
                .context("Could not resolve supervised Git common directory")?;
            ensure!(output.status.success(), ade_core::error::NeedsRebind);
            let common = std::str::from_utf8(&output.stdout)?.trim_end();
            let common = std::fs::canonicalize(common)
                .context("Supervised Git common directory is unavailable")?;
            let current = std::fs::metadata(common)?;
            ensure!(
                current.dev().to_string() == device && current.ino().to_string() == inode,
                ade_core::error::NeedsRebind
            );
        }
        (None, None) => {}
        _ => bail!("Incomplete supervised Git common directory identity"),
    }
    match (
        std::env::var("ADE_EXPECT_REMOVE_PATH").ok(),
        std::env::var("ADE_EXPECT_REMOVE_DEV").ok(),
        std::env::var("ADE_EXPECT_REMOVE_INO").ok(),
    ) {
        (Some(path), Some(device), Some(inode)) => {
            ensure!(
                std::fs::canonicalize(&path)? == Path::new(&path),
                ade_core::error::NeedsRebind
            );
            ensure!(
                identity(&path)? == (device, inode),
                ade_core::error::NeedsRebind
            );
        }
        (None, None, None) => {}
        _ => bail!("Incomplete supervised removal target identity"),
    }
    let mut args = std::env::args_os().skip(2);
    let binary = args.next().context("Missing supervised command")?;
    let status = Command::new(binary)
        .args(args)
        .env_remove("ADE_LIFECYCLE_LOCK_FD")
        .env_remove("ADE_EXPECT_CWD_DEV")
        .env_remove("ADE_EXPECT_CWD_INO")
        .env_remove("ADE_EXPECT_GIT_COMMON_DEV")
        .env_remove("ADE_EXPECT_GIT_COMMON_INO")
        .env_remove("ADE_EXPECT_REMOVE_PATH")
        .env_remove("ADE_EXPECT_REMOVE_DEV")
        .env_remove("ADE_EXPECT_REMOVE_INO")
        .env_remove("ADE_E2E_WORKER_PAUSE_DIR")
        .env_remove("ADE_E2E_WORKER_PAUSE_ENABLED")
        .env_remove("ADE_E2E_WORKTREE_SPAWN_PAUSE_DIR")
        .env_remove("ADE_E2E_WORKTREE_REMOVE_PAUSE_DIR")
        .status()
        .context("Could not start supervised command; check Git or Worktrunk installation")?;
    std::process::exit(status.code().unwrap_or(1));
}

/// The subprocess supervisor inherits `file`; a daemon crash cannot unlock live Git.
pub(crate) struct ReviewGuard {
    hub: Arc<Worktrees>,
    id: String,
    pub file: File,
    _lease: Lease,
}
impl Drop for ReviewGuard {
    fn drop(&mut self) {
        // Closing our descriptor releases it only after every supervisor exits.
        self.hub.data.lock().unwrap().busy.remove(&self.id);
    }
}

#[cfg(test)]
mod safe_lifecycle_error_tests {
    use super::*;
    #[test]
    fn legacy_running_receipt_reopens_as_uncertain_without_replaying_request() {
        let directory = std::env::temp_dir().join(new_id("ade-lifecycle-recovery-test"));
        std::fs::create_dir(&directory).unwrap();
        let hub = Worktrees::open(&directory).unwrap();
        let legacy = json!({"id":"old-operation","repository_id":"repo",
            "request":{"op":"worktree.remove","path":"/do-not-run","request_id":"old-operation"},
            "status":"running","result":null,"error":null,"started_at":1,"finished_at":null});
        hub.data
            .lock()
            .unwrap()
            .db
            .execute(
                "INSERT INTO operations(id,data) VALUES(?1,?2)",
                params!["old-operation", legacy.to_string()],
            )
            .unwrap();
        drop(hub);
        let hub = Worktrees::open(&directory).unwrap();
        let receipt: Operation =
            read_json(&hub.data.lock().unwrap().db, "operations", "old-operation").unwrap();
        assert_eq!(receipt.status, "interrupted");
        assert_eq!(receipt.code.as_deref(), Some("lifecycle_outcome_unknown"));
        assert_eq!(
            receipt.recovery.as_deref(),
            Some("inspect_repository_before_retry")
        );
        assert_eq!(receipt.request, legacy["request"]);
        assert!(receipt.result.is_null());
        assert_eq!(hub.active_operations(), 0);
        drop(hub);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn legacy_completed_receipt_defaults_new_fields_without_changing_result() {
        let legacy = json!({"id":"old","repository_id":"repo","request":{},
            "status":"failed","result":{"exit_code":1},"error":"legacy failure",
            "started_at":1,"finished_at":2});
        let receipt: Operation = serde_json::from_value(legacy.clone()).unwrap();
        assert!(receipt.code.is_none());
        assert!(receipt.recovery.is_none());
        let encoded = serde_json::to_value(receipt).unwrap();
        assert_eq!(encoded["result"], legacy["result"]);
        assert_eq!(encoded["error"], legacy["error"]);
        assert!(encoded.get("code").is_none());
    }
    #[test]
    fn command_failure_never_discloses_hook_or_remote_output() {
        let secret = "https://token:private@host/repo; hook-secret";
        let error = successful(&json!({"exit_code":1,"stdout":"", "stderr":secret})).unwrap_err();
        let envelope = ade_core::error::error_envelope(error.context(secret));
        assert_eq!(envelope["code"], "lifecycle_command_failed");
        assert_eq!(envelope["recovery"], "inspect_repository");
        assert!(!envelope.to_string().contains(secret));
    }
    #[test]
    fn interrupted_command_requires_reconciliation_and_does_not_claim_failure() {
        let output = json!({"exit_code":null,"stdout":"", "stderr":"sensitive output"});
        let envelope = ade_core::error::error_envelope(successful(&output).unwrap_err());
        assert_eq!(envelope["code"], "lifecycle_outcome_unknown");
        assert_eq!(envelope["recovery"], "inspect_repository_before_retry");
        assert!(!envelope.to_string().contains("sensitive output"));
        assert_eq!(
            successful(&json!({"exit_code":0,"stdout":"ok"})).unwrap(),
            "ok"
        );
    }
}
