//! Git worktree lifecycle operations. No shell aliases, editor launch, or provisioning policy.
//! Commands run off the client/Conversation path; intent survives daemon failure.
use crate::host_resources::{self, HostResources, Settlement, Target};
use crate::model::{new_id, now_ms};
use crate::receipts::{self, Admission, Status};
use ade_core::contract::hooks::{HookDelivery, HookSubscription};
use ade_core::contract::resources::{
    ClaimMode, ClaimPurpose, ResourcesClaimResolveRequest, ResourcesInspectRequest,
    ResourcesRegistryAcceptRequest,
};
use ade_core::contract::resources::{ClaimState, RegistryState};
use ade_core::contract::worktrees::{
    BranchPolicy, CleanupBlocker, CleanupOutcome, HookPhase, SetupState, WorktreeAdoptRequest,
    WorktreeArchive, WorktreeArchiveEntry, WorktreeArchivedRequest, WorktreeCleanupCandidate,
    WorktreeCleanupPlan, WorktreeCleanupPlanRequest, WorktreeCleanupRequest, WorktreeCleanupTree,
    WorktreeConfigureRequest, WorktreeCreateRequest, WorktreeGetRequest, WorktreeHookRun,
    WorktreeItem, WorktreeOperation as Operation, WorktreeOperationReply, WorktreeOperationRequest,
    WorktreeOperationStatus as JobStatus, WorktreePhase, WorktreeRebindCandidate,
    WorktreeRebindRequest, WorktreeRefreshRequest, WorktreeRemoveRequest, WorktreeRepository,
    WorktreeRepositoryRequest, WorktreeSetupRequest, WorktreeState, WorktreeSwitchRequest,
};
use ade_core::contract::worktrees::{
    WorktreeCarryPreviewRequest, WorktreeCarryRequest, WorktreeResourcesApplyRequest,
};
use ade_core::error::{HostResourceConflict, HostResourcesUnavailable, LifecycleFailure};
use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

mod carry;
mod hooks;
mod policy;
pub use policy::{LeaseRefresh, needs_live_leases};
mod resources;
mod transfer;
use hooks::{HookContext, LiveHooks, last_verdict, run_hooks};

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
impl Repository {
    /// The repository as `worktree_state` reports it, without its cached listing.
    fn contract(&self) -> WorktreeRepository {
        WorktreeRepository {
            id: self.id.clone(),
            root: self.root.clone(),
            common_dir: self.common_dir.clone(),
            source_common_dir: self.source_common_dir.clone(),
            root_device: self.root_device.clone(),
            root_inode: self.root_inode.clone(),
            source_root_device: self.source_root_device.clone(),
            source_root_inode: self.source_root_inode.clone(),
            common_device: self.common_device.clone(),
            common_inode: self.common_inode.clone(),
            source_common_device: self.source_common_device.clone(),
            source_common_inode: self.source_common_inode.clone(),
            needs_rebind: self.needs_rebind,
            binding_generation: self.binding_generation,
            config: self.config.clone(),
            refreshed_at: self.refreshed_at,
        }
    }
}

/// The lifecycle operation ledger. Schema 4 renamed it from `operations`,
/// which now holds the shared effect receipts of [`crate::receipts`].
const LEDGER: &str = "jobs";
/// The lifecycle database schema this build creates and reads. Nothing
/// upgrades an older one until ADE launches (decision D19).
pub const LIFECYCLE_SCHEMA_VERSION: i64 = 6;
/// The lifecycle tables: registered repositories, ADE-owned trees, tree
/// phases, archive records and the operation ledger (`LEDGER`). The shared
/// receipt table is added by `receipts::ensure`.
const LIFECYCLE_SCHEMA: &str = "
    CREATE TABLE repositories(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE owned(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE trees(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE archived(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
";

fn record_failure(job: &mut Operation, error: anyhow::Error) {
    let envelope = ade_core::error::error_envelope(error);
    job.error = envelope["message"].as_str().map(str::to_owned);
    job.code = envelope["code"].as_str().map(str::to_owned);
    job.recovery = envelope["recovery"].as_str().map(str::to_owned);
}

/// Decodes a request into its typed contract. An absent field keeps the
/// `Missing or invalid <field>` wording of [`field`].
fn decode<T: DeserializeOwned>(request: &Value) -> Result<T> {
    T::deserialize(request).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => anyhow!("Missing or invalid {field}"),
            None => anyhow!(text),
        }
    })
}

/// Applies the string limits of [`field`] to a decoded value.
fn valid<'a>(key: &str, value: &'a str) -> Result<&'a str> {
    ensure!(
        !value.is_empty() && value.len() <= 4096 && !value.contains('\0'),
        "Missing or invalid {key}"
    );
    Ok(value)
}

fn reply<T: Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

/// A lifecycle effect command. Each carries a caller-owned operation ID whose
/// receipt lives in the lifecycle database's `operations` table.
enum Effect {
    Switch(WorktreeSwitchRequest),
    Remove(WorktreeRemoveRequest),
    Refresh(WorktreeRefreshRequest),
    Create(WorktreeCreateRequest),
    Setup(WorktreeSetupRequest),
    Cleanup(WorktreeCleanupRequest),
    Carry(WorktreeCarryRequest),
    Resources(WorktreeResourcesApplyRequest),
}

impl Effect {
    fn decode(op: &str, request: &Value) -> Result<Self> {
        Ok(match op {
            "worktree.switch" => Self::Switch(decode(request)?),
            "worktree.remove" => Self::Remove(decode(request)?),
            "worktree.refresh" => Self::Refresh(decode(request)?),
            "worktree.create" => Self::Create(decode(request)?),
            "worktree.setup" => Self::Setup(decode(request)?),
            "worktree.cleanup" => Self::Cleanup(decode(request)?),
            "worktree.carry" => Self::Carry(decode(request)?),
            "worktree.resources.apply" => Self::Resources(decode(request)?),
            _ => bail!("Unknown worktree operation"),
        })
    }
    fn project_id(&self) -> &str {
        match self {
            Self::Switch(request) => &request.project_id,
            Self::Remove(request) => &request.project_id,
            Self::Refresh(request) => &request.project_id,
            Self::Create(request) => &request.project_id,
            Self::Setup(request) => &request.project_id,
            Self::Cleanup(request) => &request.project_id,
            Self::Carry(request) => &request.project_id,
            Self::Resources(request) => &request.project_id,
        }
    }
    fn operation_id(&self) -> &str {
        match self {
            Self::Switch(request) => &request.operation_id,
            Self::Remove(request) => &request.operation_id,
            Self::Refresh(request) => &request.operation_id,
            Self::Create(request) => &request.operation_id,
            Self::Setup(request) => &request.operation_id,
            Self::Cleanup(request) => &request.operation_id,
            Self::Carry(request) => &request.operation_id,
            Self::Resources(request) => &request.operation_id,
        }
    }
    /// The canonical payload the receipt fingerprints; the fingerprint drops
    /// `operation_id`.
    fn payload(&self) -> Result<Value> {
        Ok(match self {
            Self::Switch(request) => serde_json::to_value(request)?,
            Self::Remove(request) => serde_json::to_value(request)?,
            Self::Refresh(request) => serde_json::to_value(request)?,
            Self::Create(request) => serde_json::to_value(request)?,
            Self::Setup(request) => serde_json::to_value(request)?,
            Self::Cleanup(request) => serde_json::to_value(request)?,
            Self::Carry(request) => serde_json::to_value(request)?,
            Self::Resources(request) => serde_json::to_value(request)?,
        })
    }
}

/// What admission decided and reserved for an effect's worker thread.
struct Admitted {
    remove_path: Option<PathBuf>,
    remove_identity: Option<(String, String)>,
    remove_claim: Option<String>,
    setup_path: Option<PathBuf>,
    use_claim: Option<String>,
    cleanup: Vec<PathBuf>,
    carry: Option<transfer::CarryAdmitted>,
    resources_path: Option<PathBuf>,
}

/// A tree's lifecycle phase, keyed by its canonical path in the `trees`
/// table. Only trees ADE created or ran hooks in have one.
#[derive(Clone, Serialize, Deserialize)]
struct TreeRecord {
    project_id: String,
    binding_generation: i64,
    branch: Option<String>,
    phase: WorktreePhase,
    /// The operation that last changed the phase.
    operation_id: String,
    updated_at: i64,
}

/// `worktree_state` leaves hook output to `worktree.operation`.
fn strip_hook_output(hooks: Option<&mut Value>) {
    for run in hooks.and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(run) = run.as_object_mut() {
            run.remove("output");
        }
    }
}

fn read_tree(db: &Connection, path: &str) -> Result<Option<TreeRecord>> {
    let row: Option<String> = db
        .query_row("SELECT data FROM trees WHERE id=?1", [path], |row| {
            row.get(0)
        })
        .optional()?;
    row.map(|row| Ok(serde_json::from_str(&row)?)).transpose()
}

/// The phase of a tree in this repository binding; a record left by another
/// binding does not describe it.
fn tree_phase(
    db: &Connection,
    repository: &str,
    binding_generation: i64,
    path: &str,
) -> Result<Option<WorktreePhase>> {
    Ok(read_tree(db, path)?
        .filter(|tree| {
            tree.project_id == repository && tree.binding_generation == binding_generation
        })
        .map(|tree| tree.phase))
}

/// ADE's removal authority over `path`, from its ownership record and marker.
fn authority(db: &Connection, repository: &str, path: &str) -> Result<policy::Authority> {
    let owner: Option<String> = db
        .query_row("SELECT data FROM owned WHERE id=?1", [path], |r| r.get(0))
        .optional()?;
    let Some(owner) = owner else {
        return Ok(policy::Authority::None);
    };
    let owner: Value = serde_json::from_str(&owner)?;
    let marker = std::fs::read_to_string(owner["marker"].as_str().unwrap_or("")).ok();
    Ok(policy::authority_of(
        Some(&owner),
        repository,
        identity(path).ok(),
        marker.as_deref(),
    ))
}

/// Parses `git worktree list --porcelain -z` into listing items.
fn parse_listing(text: &str) -> Result<Value> {
    let mut items = Vec::new();
    let mut item = serde_json::Map::new();
    for line in text.split('\0') {
        if line.is_empty() {
            if !item.is_empty() {
                ensure!(
                    item.contains_key("path"),
                    "Git worktree listing omitted a path"
                );
                items.push(Value::Object(std::mem::take(&mut item)));
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            ensure!(item.is_empty(), "Invalid Git worktree listing");
            item.insert("path".into(), json!(path));
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            item.insert("branch".into(), json!(branch));
        } else if line == "detached" {
            item.insert("detached".into(), json!(true));
        } else if line == "bare" {
            item.insert("bare".into(), json!(true));
        } else if line == "locked" || line.starts_with("locked ") {
            item.insert("locked".into(), json!(true));
            if let Some(reason) = line.strip_prefix("locked ") {
                item.insert("lock_reason".into(), json!(reason));
            }
        } else if line == "prunable" || line.starts_with("prunable ") {
            item.insert("prunable".into(), json!(true));
        }
    }
    ensure!(item.is_empty(), "Unterminated Git worktree listing");
    Ok(json!(items))
}

/// A failed or uncertain hook, recorded with its own code and recovery. The
/// message names the hook, never its output.
#[derive(Debug)]
struct HookFailure {
    phase: HookPhase,
    name: String,
    uncertain: bool,
}
impl std::fmt::Display for HookFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let phase = match self.phase {
            HookPhase::Setup => "Setup",
            HookPhase::Teardown => "Teardown",
        };
        if self.uncertain {
            write!(
                f,
                "{phase} hook {} did not finish cleanly; its processes may still run. The tree was kept; inspect it and its host resource claim before retrying",
                self.name
            )
        } else {
            write!(
                f,
                "{phase} hook {} failed. The tree was kept; read the hook output with worktree.operation, then retry",
                self.name
            )
        }
    }
}
impl std::error::Error for HookFailure {}

/// Records an operation failure; a hook failure gets its own code.
fn record_outcome(job: &mut Operation, error: anyhow::Error) {
    if let Some(refusal) = error.downcast_ref::<transfer::Refusal>() {
        job.error = Some(refusal.message.clone());
        job.code = Some(refusal.code.into());
        job.recovery = Some(refusal.recovery.into());
        return;
    }
    let hook = error.downcast_ref::<HookFailure>().map(|failure| {
        let code = match (failure.phase, failure.uncertain) {
            (_, true) => "hook_outcome_unknown",
            (HookPhase::Setup, false) => "setup_hook_failed",
            (HookPhase::Teardown, false) => "teardown_hook_failed",
        };
        let recovery = match failure.phase {
            HookPhase::Setup => "rerun_setup",
            HookPhase::Teardown => "inspect_tree_before_removal",
        };
        (failure.to_string(), code, recovery)
    });
    match hook {
        Some((message, code, recovery)) => {
            job.error = Some(message);
            job.code = Some(code.into());
            job.recovery = Some(recovery.into());
        }
        None => record_failure(job, error),
    }
}

/// Checks an operation ID against its receipt without keeping a new one.
fn probe(db: &Connection, id: &str, op: &str, payload: &Value) -> Result<Admission> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
    // Dropping the transaction rolls back the receipt `begin` adds for a new ID.
    receipts::begin(&tx, id, op, payload, None, now_ms())
}

/// The receipt state that matches a ledger status.
fn receipt_status(status: JobStatus) -> Status {
    match status {
        JobStatus::Running => Status::Dispatched,
        JobStatus::Interrupted => Status::Unknown,
        JobStatus::Succeeded | JobStatus::Partial | JobStatus::Failed => Status::Settled,
    }
}

/// Brings a ledger row's receipt up to date with the row: a job the daemon
/// interrupted at restart settles its receipt as unknown.
fn reconcile_receipt(db: &Connection, job: &Operation) -> Result<()> {
    let stored: Option<String> = db
        .query_row(
            "SELECT status FROM operations WHERE id=?1",
            [&job.id],
            |row| row.get(0),
        )
        .optional()?;
    let current = match stored.as_deref() {
        None => bail!("Worktree operation {} has no receipt", job.id),
        Some("expired") => return Ok(()),
        Some(status) => Status::parse(status)?,
    };
    let target = receipt_status(job.status);
    if current != target && current.may_become(target) {
        receipts::settle(
            db,
            &job.id,
            target,
            None,
            job.finished_at.unwrap_or(job.started_at),
        )?;
    }
    Ok(())
}
struct Data {
    db: Connection,
    busy: HashSet<String>,
    leases: HashMap<PathBuf, usize>,
    /// The host shared-use claim behind each leased path; `None` while the
    /// host registry is blocked and cannot record it.
    host_claims: HashMap<PathBuf, Option<String>>,
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
    // A tree with a recorded phase is ready only in the `ready` phase. A
    // path inside the tree takes the tree's phase.
    let mut phase = None;
    for ancestor in Path::new(path).ancestors() {
        if let Some(ancestor) = ancestor.to_str()
            && let Some(found) = tree_phase(db, repository, binding_generation, ancestor)?
        {
            phase = Some(found);
            break;
        }
    }
    if let Some(phase) = phase {
        return Ok(match policy::readiness(phase) {
            SetupState::Ready => "ready",
            SetupState::Preparing => "preparing",
            SetupState::Interrupted => "interrupted",
            SetupState::Failed => "failed",
        });
    }
    let receipt: Option<String> = db.query_row(
        "SELECT data FROM jobs WHERE json_extract(data,'$.project_id')=?1 AND COALESCE(json_extract(data,'$.binding_generation'),0)=?2 AND json_extract(data,'$.request.op')='worktree.switch' AND (json_extract(data,'$.request.target')=?3 OR json_extract(data,'$.request.target')=?4 OR json_extract(data,'$.worktree_path')=?4) ORDER BY rowid DESC LIMIT 1",
        params![repository, binding_generation, branch, path], |row| row.get(0),
    ).optional()?;
    Ok(match receipt {
        Some(row) => match serde_json::from_str::<Operation>(&row)?.status {
            JobStatus::Succeeded => "ready",
            JobStatus::Running => "preparing",
            JobStatus::Interrupted => "interrupted",
            JobStatus::Partial | JobStatus::Failed => "failed",
        },
        // Existing external checkouts have no lux-ade setup obligation until a
        // lifecycle operation is requested for them.
        None => "ready",
    })
}
pub struct Worktrees {
    data: Mutex<Data>,
    directory: PathBuf,
    worker: PathBuf,
    /// Claims shared with every profile's daemon on this host. Lock order:
    /// `data`, then the registry.
    resources: HostResources,
    /// The hook each running operation is executing (F067).
    live: LiveHooks,
    /// The catalog project ID for a Git common directory. A new lifecycle
    /// repository takes it, so the catalog and the lifecycle share one ID.
    project_ids: std::sync::OnceLock<ProjectIds>,
}
/// Finds or creates the catalog project for a Git common directory.
pub type ProjectIds = Arc<dyn Fn(&str) -> Result<Option<String>> + Send + Sync>;
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
                if let Some(Some(claim)) = d.host_claims.remove(&self.path) {
                    self.hub.resources.settle(&claim, Settlement::Release);
                }
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
    command: Command,
    timeout: u64,
    lock: Option<&File>,
    input: Option<Vec<u8>>,
) -> Result<Value> {
    let captured = capture(command, timeout, lock, input, 4 * 1024 * 1024, false, None)?;
    ensure!(
        captured.pipes_closed,
        LifecycleFailure::LifecycleOutcomeUnknown
    );
    ensure!(
        !captured.truncated,
        LifecycleFailure::LifecycleInvalidOutput
    );
    Ok(
        json!({"exit_code":captured.code,"stdout":String::from_utf8(captured.stdout).context("Git output contains non-UTF-8 paths or text")?,"stderr":String::from_utf8_lossy(&captured.stderr),"elapsed_ms":captured.elapsed_ms}),
    )
}

/// What a supervised process left behind. `code` is `None` when it was
/// killed or its state could not be read.
struct Captured {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Output beyond the cap was dropped.
    truncated: bool,
    timed_out: bool,
    /// Both pipes reached end of file within two seconds of exit. When false,
    /// some descendant still holds them and the output is empty.
    pipes_closed: bool,
    elapsed_ms: u64,
}

/// Receives each chunk of a supervised process's output as it arrives.
type Tap = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Runs a command in its own process group, draining both pipes
/// concurrently and keeping at most `cap` bytes of each: the first bytes, or
/// with `tail` the last. Only a failure to start is an error; after that the
/// outcome is always reported, never assumed.
fn capture(
    mut command: Command,
    timeout: u64,
    lock: Option<&File>,
    input: Option<Vec<u8>>,
    cap: usize,
    tail: bool,
    tap: Option<Tap>,
) -> Result<Captured> {
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
        cap: usize,
        tail: bool,
        tap: Option<Tap>,
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
                if let Some(tap) = &tap {
                    tap(&buf[..n]);
                }
                if tail {
                    kept.extend_from_slice(&buf[..n]);
                    // Trim in batches so a chatty hook costs linear time.
                    if kept.len() > cap * 2 {
                        kept.drain(..kept.len() - cap);
                        truncated = true;
                    }
                } else {
                    let retain = n.min(cap.saturating_sub(kept.len()));
                    kept.extend_from_slice(&buf[..retain]);
                    truncated |= retain < n;
                }
            }
            if kept.len() > cap {
                kept.drain(..kept.len() - cap);
                truncated = true;
            }
            Ok((kept, truncated))
        })
    }
    let writer = input.map(|bytes| {
        let mut pipe = child.stdin.take().unwrap();
        std::thread::spawn(move || pipe.write_all(&bytes))
    });
    let stdout = drain(child.stdout.take().unwrap(), cap, tail, tap.clone());
    let stderr = drain(child.stderr.take().unwrap(), cap, tail, tap);
    let start = Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            // The state cannot be read: stop the group and report no code.
            Err(_) => {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                break None;
            }
        }
        if start.elapsed() > Duration::from_secs(timeout) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A Git helper may keep inherited pipes open. Do not join it indefinitely;
    // the repository flock remains held by the supervised worker.
    let pipe_deadline = Instant::now() + Duration::from_secs(2);
    while (!stdout.is_finished() || !stderr.is_finished()) && Instant::now() < pipe_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let elapsed_ms = start.elapsed().as_millis() as u64;
    if !stdout.is_finished() || !stderr.is_finished() {
        return Ok(Captured {
            code,
            stdout: Vec::new(),
            stderr: Vec::new(),
            truncated: false,
            timed_out,
            pipes_closed: false,
            elapsed_ms,
        });
    }
    if let Some(writer) = writer
        && writer.is_finished()
    {
        let _ = writer.join();
    }
    let (out, out_cut) = stdout
        .join()
        .map_err(|_| anyhow!("stdout reader failed"))??;
    let (err, err_cut) = stderr
        .join()
        .map_err(|_| anyhow!("stderr reader failed"))??;
    Ok(Captured {
        code,
        stdout: out,
        stderr: err,
        truncated: out_cut || err_cut,
        timed_out,
        pipes_closed: true,
        elapsed_ms,
    })
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

/// The canonical directory new trees go in: the configured one, else the
/// primary checkout's parent.
fn worktree_parent(repo: &Repository) -> Result<PathBuf> {
    let default_parent = Path::new(&repo.root)
        .parent()
        .context("Repository has no parent")?;
    let parent = repo
        .config
        .directory
        .as_deref()
        .map(Path::new)
        .unwrap_or(default_parent);
    let parent = parent
        .canonicalize()
        .context("Worktree directory is unavailable")?;
    ensure!(parent.is_dir(), "Worktree directory is not a directory");
    Ok(parent)
}

/// Resolves `worktree.create` into the switch form the creation path runs:
/// a named branch, its base and its path, all recorded before Git runs.
fn creation_spec(repo: &Repository, request: &Value, branches: &[String]) -> Result<Value> {
    let create: WorktreeCreateRequest = decode(request)?;
    let repository = Path::new(&repo.root)
        .file_name()
        .context("Repository has no directory name")?
        .to_string_lossy()
        .into_owned();
    let parent = worktree_parent(repo)?;
    let named = policy::resolve_name(
        &policy::Naming {
            repository: &repository,
            prefix: repo.config.branch_prefix.as_deref(),
            name: create.name.as_deref(),
            branch: create.branch.as_deref(),
        },
        branches,
        // An explicit path replaces the generated directory.
        |directory| {
            create.path.is_none() && std::fs::symlink_metadata(parent.join(directory)).is_ok()
        },
    )?;
    let base = create
        .base
        .or_else(|| repo.config.default_base.clone())
        .unwrap_or_else(|| "HEAD".into());
    let path = match create.path {
        Some(path) => path,
        None => parent
            .join(&named.directory)
            .to_str()
            .context("Path must be UTF-8")?
            .to_owned(),
    };
    Ok(json!({"target": named.branch, "create": true, "base": base, "path": path}))
}

fn creation_path(repo: &Repository, request: &Value) -> Result<PathBuf> {
    let target = field(request, "target")?;
    ensure!(!target.starts_with('-'), "Invalid branch name");
    let slug = target.replace('/', "-");
    ensure!(
        slug != "." && slug != ".." && !slug.is_empty(),
        "Invalid branch name"
    );
    let parent = worktree_parent(repo)?;
    let candidate = if let Some(path) = request["path"].as_str() {
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "Worktree path must be absolute");
        path
    } else {
        parent.join(format!(
            "{}-{slug}",
            Path::new(&repo.root)
                .file_name()
                .context("Repository has no directory name")?
                .to_string_lossy()
        ))
    };
    ensure!(
        candidate
            .parent()
            .is_some_and(|path| path.canonicalize().ok().as_deref() == Some(parent.as_path())),
        "Worktree path must be directly inside its configured directory"
    );
    // Record the canonical path: Git lists trees by it, and settling the
    // creation claim compares the listing with this path.
    let name = candidate
        .file_name()
        .context("Worktree path must name a directory")?;
    Ok(parent.join(name))
}

fn path_is_free(path: &Path) -> bool {
    !path.exists() && std::fs::symlink_metadata(path).is_err()
}

/// The tree's Git admin directory. Callers read it before taking the data
/// lock: a lease's drop takes that lock while the Sessions lock is held, so a
/// slow Git here must not run under it.
fn admin_dir(path: &str) -> Result<String> {
    git(path, &["rev-parse", "--absolute-git-dir"])
}

/// Records ADE's removal authority over `path`, whose admin directory
/// [`admin_dir`] read. Touches only the filesystem and `db`.
fn claim_worktree(
    db: &Connection,
    project_id: &str,
    path: &str,
    admin: &str,
    adopted: bool,
) -> Result<()> {
    let marker = Path::new(admin).join("ade-owner");
    let token = new_id("ownership");
    // The tree's physical identity: authority stops if the path is replaced.
    let (device, inode) = identity(path)?;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&marker)?
        .write_all(token.as_bytes())?;
    put(
        db,
        "owned",
        path,
        &json!({"project_id":project_id,
        "marker":marker,"token":token,"adopted":adopted,
        "device":device,"inode":inode}),
    )?;
    Ok(())
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
        let path = directory.join("lifecycle.sqlite3");
        let db = Connection::open(&path)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            version == 0 || version == LIFECYCLE_SCHEMA_VERSION,
            "The worktree lifecycle database {} has schema version {version}; this build reads only schema {LIFECYCLE_SCHEMA_VERSION} and does not upgrade older databases before launch. Delete the database to start this profile's lifecycle again",
            path.display()
        );
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        if version == 0 {
            let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
            tx.execute_batch(LIFECYCLE_SCHEMA)?;
            receipts::ensure(&tx)?;
            tx.pragma_update(None, "user_version", LIFECYCLE_SCHEMA_VERSION)?;
            tx.commit()?;
        }
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let pending: Vec<String> = tx
            .prepare("SELECT data FROM jobs ORDER BY rowid")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for row in pending {
            let mut op: Operation = serde_json::from_str(&row)?;
            if op.status == JobStatus::Running {
                op.status = JobStatus::Interrupted;
                record_failure(&mut op, LifecycleFailure::LifecycleOutcomeUnknown.into());
                op.finished_at = Some(now_ms());
                put(&tx, LEDGER, &op.id, &op)?;
            }
            reconcile_receipt(&tx, &op)?;
        }
        // No lifecycle work survives a daemon stop, so a phase still in
        // progress did not finish.
        let trees: Vec<(String, String)> = tx
            .prepare("SELECT id,data FROM trees")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (path, row) in trees {
            let mut tree: TreeRecord = serde_json::from_str(&row)?;
            let settled = policy::on_restart(tree.phase);
            if settled != tree.phase {
                tree.phase = settled;
                tree.updated_at = now_ms();
                put(&tx, "trees", &path, &tree)?;
            }
        }
        receipts::prune(&tx, now_ms())?;
        tx.commit()?;
        let location = host_resources::locate(
            std::env::var_os("ADE_HOST_RESOURCES_HOME")
                .map(PathBuf::from)
                .as_deref(),
            std::env::var_os("ADE_RUNTIME_HOME")
                .map(PathBuf::from)
                .as_deref(),
            directory,
        );
        let resources = HostResources::open(location, &db)?;
        Ok(Arc::new(Self {
            data: Mutex::new(Data {
                db,
                busy: HashSet::new(),
                leases: HashMap::new(),
                host_claims: HashMap::new(),
                removing: HashSet::new(),
            }),
            directory: directory.into(),
            worker: std::env::current_exe()?,
            resources,
            live: LiveHooks::default(),
            project_ids: std::sync::OnceLock::new(),
        }))
    }
    /// Names the catalog's project IDs for repositories registered from now on.
    pub fn set_project_ids(&self, ids: ProjectIds) {
        let _ = self.project_ids.set(ids);
    }
    /// Whether a lifecycle or review operation holds the repository now.
    pub fn repository_busy(&self, id: &str) -> Result<bool> {
        let d = self.data.lock().unwrap();
        Ok(d.busy.contains(id))
    }
    /// The lifecycle repository whose canonical Git common directory is
    /// `common`, without registering one.
    pub fn repository_for_common(&self, common: &str) -> Result<Option<String>> {
        let Ok(common) = std::fs::canonicalize(common) else {
            return Ok(None);
        };
        let d = self.data.lock().unwrap();
        let rows: Vec<String> =
            d.db.prepare("SELECT data FROM repositories ORDER BY rowid")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        for row in rows {
            let repository: Repository = serde_json::from_str(&row)?;
            if Path::new(&repository.common_dir) == common {
                return Ok(Some(repository.id));
            }
        }
        Ok(None)
    }
    /// A lifecycle operation's ledger row, or `None` when none was admitted
    /// under this ID.
    pub fn job(&self, operation_id: &str) -> Result<Option<Operation>> {
        let d = self.data.lock().unwrap();
        d.db.query_row(
            &format!("SELECT data FROM {LEDGER} WHERE id=?1"),
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|row| Ok(serde_json::from_str(&row)?))
        .transpose()
    }
    /// The canonical paths of the trees ADE holds removal authority over,
    /// with an intact ownership marker.
    pub fn owned_paths(&self) -> Result<HashSet<String>> {
        let d = self.data.lock().unwrap();
        let rows: Vec<(String, String)> =
            d.db.prepare("SELECT id,data FROM owned")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            .filter(|(_, owner)| {
                serde_json::from_str::<Value>(owner).is_ok_and(|owner| {
                    std::fs::read_to_string(owner["marker"].as_str().unwrap_or(""))
                        .ok()
                        .as_deref()
                        == owner["token"].as_str()
                })
            })
            .map(|(path, _)| path)
            .collect())
    }
    pub fn active_operations(&self) -> usize {
        self.data.lock().unwrap().busy.len()
    }
    /// Hook deliveries staged by lifecycle commits, for the outbox relay (F058).
    pub fn staged_hook_deliveries(&self) -> Result<Vec<HookDelivery>> {
        crate::hooks::staged(&self.data.lock().unwrap().db)
    }
    pub fn forget_hook_deliveries(&self, effect_ids: &[String]) -> Result<()> {
        crate::hooks::forget_staged(&self.data.lock().unwrap().db, effect_ids)
    }
    pub fn sync_hook_subscriptions(&self, subscriptions: &[HookSubscription]) -> Result<()> {
        crate::hooks::replace_subscriptions(&self.data.lock().unwrap().db, subscriptions)
    }
    pub fn lease(self: &Arc<Self>, root: &str) -> Result<Lease> {
        self.acquire_lease(root, false)
    }
    /// The host claim registry, for port and device claims.
    pub fn host_resources(&self) -> &HostResources {
        &self.resources
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
        if !d.leases.contains_key(&path) {
            let claim = self.use_claim(&path)?;
            d.host_claims.insert(path.clone(), claim);
        }
        *d.leases.entry(path.clone()).or_default() += 1;
        Ok(Lease {
            hub: self.clone(),
            path,
        })
    }
    /// Takes the host shared-use claim for a leased path. Another profile's
    /// lifecycle claim refuses the lease. A blocked registry admits the lease
    /// without a record so existing work can continue; lifecycle commands stay
    /// refused until the registry is recovered.
    fn use_claim(&self, path: &Path) -> Result<Option<String>> {
        match self.resources.acquire(
            Target::Existing(path),
            ClaimMode::Shared,
            ClaimPurpose::Use,
            None,
        ) {
            Ok(id) => Ok(Some(id)),
            Err(error) if error.downcast_ref::<HostResourcesUnavailable>().is_some() => {
                eprintln!(
                    "Lease on {} is not recorded host-wide: {error}",
                    path.display()
                );
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
    /// `resources.*` operations: inspect claims, resolve a quarantined claim,
    /// accept a replaced registry.
    pub fn resources_command(&self, request: &Value) -> Result<Value> {
        match field(request, "op")? {
            "resources.inspect" => {
                let inspect: ResourcesInspectRequest = decode(request)?;
                if let Some(path) = &inspect.path {
                    valid("path", path)?;
                }
                reply(
                    &self
                        .resources
                        .inspect_kind(inspect.path.as_deref(), inspect.resource)?,
                )
            }
            op @ ("resources.device.hold" | "resources.device.release") => {
                reply(&self.resources.device_command(op, request)?)
            }
            "resources.claim.resolve" => {
                let resolve: ResourcesClaimResolveRequest = decode(request)?;
                ensure!(
                    valid("operation_id", &resolve.operation_id)?.len() <= 256,
                    "Operation ID too long"
                );
                valid("claim_id", &resolve.claim_id)?;
                valid("confirm_path", &resolve.confirm_path)?;
                self.resources.resolve_claim(&resolve)
            }
            "resources.registry.accept" => {
                let accept: ResourcesRegistryAcceptRequest = decode(request)?;
                ensure!(
                    valid("operation_id", &accept.operation_id)?.len() <= 256,
                    "Operation ID too long"
                );
                valid("confirm_registry", &accept.confirm_registry)?;
                let mut d = self.data.lock().unwrap();
                match self.resources.accept(&d.db, &accept)? {
                    crate::host_resources::AcceptOutcome::Replayed(recorded) => {
                        return Ok(recorded);
                    }
                    crate::host_resources::AcceptOutcome::Ran { rebound: true } => {
                        // Claims taken before recovery live in the old registry.
                        let paths: Vec<PathBuf> = d.leases.keys().cloned().collect();
                        for path in paths {
                            let claim = self.use_claim(&path).unwrap_or_else(|error| {
                                eprintln!(
                                    "Lease on {} was not re-claimed: {error}",
                                    path.display()
                                );
                                None
                            });
                            d.host_claims.insert(path, claim);
                        }
                    }
                    crate::host_resources::AcceptOutcome::Ran { rebound: false } => {}
                }
                // The binding committed with its receipt acknowledged. The
                // data lock stays held until the reply is recorded, so a
                // concurrent retry of the same ID cannot settle it first. A
                // crash before the record leaves the receipt acknowledged,
                // and the first retry settles it (`HostResources::accept`).
                let accepted = reply(&self.resources.inspect(None)?)?;
                crate::receipts::e2e_pause("resources.registry.accept");
                crate::host_resources::HostResources::record_accept_reply(
                    &d.db,
                    &accept.operation_id,
                    &accepted,
                );
                Ok(accepted)
            }
            _ => bail!("Unknown resources operation"),
        }
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
            "A Git lifecycle command still holds the repository lock"
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
        c.arg("--worktree-worker").arg("git");
        neutral(&mut c);
        c.current_dir(&repo.root)
            .env("ADE_EXPECT_CWD_DEV", device)
            .env("ADE_EXPECT_CWD_INO", inode)
            .env("ADE_EXPECT_GIT_COMMON_DEV", common_device)
            .env("ADE_EXPECT_GIT_COMMON_INO", common_inode);
        c.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.hooksPath")
            .env("GIT_CONFIG_VALUE_0", "/dev/null");
        c.args(args);
        Ok(c)
    }
    fn list(&self, repo: &Repository, lock: &File) -> Result<Value> {
        let result = run(
            self.command_for(
                repo,
                &[
                    "worktree".into(),
                    "list".into(),
                    "--porcelain".into(),
                    "-z".into(),
                ],
            )?,
            repo.config.timeout_seconds,
            Some(lock),
        )?;
        parse_listing(successful(&result)?)
    }
    /// Local branch names, read under the repository lock.
    fn branches(&self, repo: &Repository, lock: &File) -> Result<Vec<String>> {
        let result = run(
            self.command_for(
                repo,
                &[
                    "for-each-ref".into(),
                    "--format=%(refname:short)".into(),
                    "refs/heads".into(),
                ],
            )?,
            repo.config.timeout_seconds,
            Some(lock),
        )?;
        Ok(successful(&result)?
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }
    fn put_tree(&self, path: &str, tree: &TreeRecord) -> Result<()> {
        put(&self.data.lock().unwrap().db, "trees", path, tree)
    }
    fn set_phase(
        &self,
        repo: &Repository,
        job: &Operation,
        path: &str,
        branch: Option<&str>,
        phase: WorktreePhase,
    ) -> Result<()> {
        self.put_tree(
            path,
            &TreeRecord {
                project_id: repo.id.clone(),
                binding_generation: repo.binding_generation,
                branch: branch.map(str::to_owned),
                phase,
                operation_id: job.id.clone(),
                updated_at: now_ms(),
            },
        )
    }
    fn hook_context<'a>(
        &'a self,
        repo: &'a Repository,
        job: &'a Operation,
        tree: &'a Path,
        branch: Option<&'a str>,
        lock: &'a File,
    ) -> HookContext<'a> {
        HookContext {
            worker: &self.worker,
            tree,
            branch,
            root: &repo.root,
            operation_id: &job.id,
            lock,
            live: &self.live,
        }
    }
    /// Runs the setup hooks in `path` and records the phase they leave. The
    /// tree is `setting_up` durably before the first hook starts. Returns
    /// the runs and whether processes may outlive them.
    fn setup_tree(
        &self,
        repo: &Repository,
        job: &Operation,
        lock: &File,
        path: &Path,
        branch: Option<&str>,
    ) -> Result<(Vec<WorktreeHookRun>, Result<()>)> {
        let text = path.to_str().context("Path must be UTF-8")?;
        if repo.config.setup.is_empty() {
            self.set_phase(repo, job, text, branch, WorktreePhase::Ready)?;
            return Ok((Vec::new(), Ok(())));
        }
        self.set_phase(repo, job, text, branch, WorktreePhase::SettingUp)?;
        let runs = run_hooks(
            &repo.config.setup,
            HookPhase::Setup,
            &self.hook_context(repo, job, path, branch, lock),
        );
        let last = last_verdict(&runs);
        self.set_phase(repo, job, text, branch, policy::after_setup(last))?;
        let outcome = match runs.last() {
            Some(run) if run.verdict != ade_core::contract::worktrees::HookVerdict::Succeeded => {
                Err(HookFailure {
                    phase: HookPhase::Setup,
                    name: run.name.clone(),
                    uncertain: policy::hook_uncertain(run.verdict),
                }
                .into())
            }
            _ => Ok(()),
        };
        Ok((runs, outcome))
    }
    /// Runs the teardown hooks in `path`. On success the tree stays
    /// `tearing_down` for the removal that follows; on failure it records the
    /// phase the failure leaves.
    fn teardown_tree(
        &self,
        repo: &Repository,
        job: &Operation,
        lock: &File,
        path: &Path,
        branch: Option<&str>,
    ) -> Result<(Vec<WorktreeHookRun>, Result<()>)> {
        let text = path.to_str().context("Path must be UTF-8")?;
        self.set_phase(repo, job, text, branch, WorktreePhase::TearingDown)?;
        let runs = run_hooks(
            &repo.config.teardown,
            HookPhase::Teardown,
            &self.hook_context(repo, job, path, branch, lock),
        );
        let outcome = match policy::after_teardown(last_verdict(&runs)) {
            None => Ok(()),
            Some(phase) => {
                self.set_phase(repo, job, text, branch, phase)?;
                let run = runs.last().context("Teardown failed without a hook run")?;
                Err(HookFailure {
                    phase: HookPhase::Teardown,
                    name: run.name.clone(),
                    uncertain: policy::hook_uncertain(run.verdict),
                }
                .into())
            }
        };
        Ok((runs, outcome))
    }
    fn snapshot(&self, id: &str) -> Result<Value> {
        let d = self.data.lock().unwrap();
        let r: Repository = read_json(&d.db, "repositories", id)?;
        let operations: Vec<Operation> = d.db
            .prepare("SELECT data FROM jobs WHERE json_extract(data, '$.project_id')=?1 ORDER BY rowid DESC LIMIT 100")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|row| {
                let mut operation: Operation = serde_json::from_str(&row?)?;
                if let Some(result) = operation.result.as_object_mut() {
                    result.remove("stdout");
                    result.remove("stderr");
                    strip_hook_output(result.get_mut("hooks"));
                    if let Some(trees) = result.get_mut("trees").and_then(Value::as_array_mut) {
                        for tree in trees {
                            strip_hook_output(tree.get_mut("hooks"));
                        }
                    }
                }
                if let Some(error) = &mut operation.error {
                    *error = error.chars().take(4096).collect();
                }
                Ok(operation)
            })
            .collect::<Result<_>>()?;
        let mut cache = r.cache.clone();
        if let Some(items) = cache.as_array_mut() {
            for item in items {
                if let Some(path) = item["path"].as_str().map(str::to_owned) {
                    let path = path.as_str();
                    let phase = tree_phase(&d.db, id, r.binding_generation, path)?;
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
                            .is_some_and(|v| v["project_id"] == id
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
                    if let Some(phase) = phase {
                        item["phase"] = json!(phase);
                    }
                }
            }
        }
        let worktrees: Vec<WorktreeItem> =
            serde_json::from_value(cache).context("Cached worktree listing is invalid")?;
        reply(&WorktreeState {
            tag: Default::default(),
            repository: r.contract(),
            worktrees,
            busy: d.busy.contains(id),
            operations,
        })
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
                    "Selected directory belongs to a saved source Git lifecycle repository"
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
                    "Rebind the matching Git lifecycle repository first"
                );
                ensure!(
                    repository.common_dir == selected_common,
                    "Selected Git common directory differs from the lifecycle binding"
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
            "DELETE FROM owned WHERE json_extract(data,'$.project_id')=?1",
            [id],
        )?;
        // Phases describe the old binding's trees, not the new checkout's.
        tx.execute(
            "DELETE FROM trees WHERE json_extract(data,'$.project_id')=?1",
            [id],
        )?;
        tx.commit()?;
        drop(d);
        self.snapshot(id)
    }
    /// The lifecycle's repositories for `rebind.list`, and whether each needs a rebind.
    pub fn rebind_candidates(&self) -> Result<Vec<WorktreeRebindCandidate>> {
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
            repositories.push(WorktreeRebindCandidate {
                needs_rebind: repository.needs_rebind || !repository_binding_matches(&repository),
                rebindable,
                binding_generation: repository.binding_generation,
                id: repository.id,
                root: repository.root,
                common_dir: repository.common_dir,
            });
        }
        Ok(repositories)
    }
    pub fn command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let op = field(request, "op")?;
        if op == "worktree.rebind" {
            let rebind: WorktreeRebindRequest = decode(request)?;
            return self.rebind_repository(
                valid("project_id", &rebind.project_id)?,
                valid("path", &rebind.path)?,
            );
        }
        if op != "worktree.operation" && self.has_pending_rebind()? {
            return Err(ade_core::error::NeedsRebind.into());
        }
        match op {
            "worktree.repository" => {
                let register: WorktreeRepositoryRequest = decode(request)?;
                self.register(valid("path", &register.path)?)
            }
            "worktree.operation" => {
                let lookup: WorktreeOperationRequest = decode(request)?;
                let id = valid("project_id", &lookup.project_id)?;
                let d = self.data.lock().unwrap();
                let operation: Operation =
                    read_json(&d.db, LEDGER, valid("operation_id", &lookup.operation_id)?)?;
                ensure!(
                    operation.project_id == id,
                    "Operation belongs to another repository"
                );
                let running_hook = (operation.status == JobStatus::Running)
                    .then(|| self.live.progress(&operation.id))
                    .flatten();
                reply(&WorktreeOperationReply {
                    tag: Default::default(),
                    operation,
                    running_hook,
                })
            }
            "worktree.get" => {
                let get: WorktreeGetRequest = decode(request)?;
                self.snapshot(valid("project_id", &get.project_id)?)
            }
            "worktree.configure" => {
                let configure: WorktreeConfigureRequest = decode(request)?;
                self.configure(
                    valid("project_id", &configure.project_id)?,
                    configure.config.into(),
                )
            }
            "worktree.carry.preview" => {
                let preview: WorktreeCarryPreviewRequest = decode(request)?;
                self.carry_preview(&preview)
            }
            "worktree.cleanup.plan" => {
                let plan: WorktreeCleanupPlanRequest = decode(request)?;
                self.cleanup_plan(valid("project_id", &plan.project_id)?)
            }
            "worktree.archived" => {
                let archived: WorktreeArchivedRequest = decode(request)?;
                self.archived(valid("project_id", &archived.project_id)?)
            }
            "worktree.adopt" => {
                let adopt: WorktreeAdoptRequest = decode(request)?;
                self.adopt(
                    valid("project_id", &adopt.project_id)?,
                    valid("path", &adopt.path)?,
                    adopt.confirm_path.as_deref(),
                )
            }
            _ => self.start(op, request),
        }
    }
    fn register(&self, path: &str) -> Result<Value> {
        let path = std::fs::canonicalize(path)?;
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
        // The catalog's project for this repository, found before the
        // lifecycle lock: the catalog takes its own lock to create one.
        let project = self
            .project_ids
            .get()
            .map(|ids| ids(&common))
            .transpose()?
            .flatten();
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
        let id = project
            .filter(|id| read_json::<Repository>(&d.db, "repositories", id).is_err())
            .unwrap_or_else(|| new_id("repository"));
        let r = Repository {
            id,
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
        self.snapshot(&r.id)
    }
    fn configure(&self, id: &str, config: Config) -> Result<Value> {
        policy::validate_config(&config)?;
        resources::validate_rules(&config.resources)?;
        if let Some(directory) = &config.directory {
            ensure!(
                Path::new(directory).is_absolute() && Path::new(directory).is_dir(),
                "Worktree directory must be an existing absolute directory"
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
        self.snapshot(id)
    }
    fn adopt(&self, id: &str, path: &str, confirm_path: Option<&str>) -> Result<Value> {
        let path = std::fs::canonicalize(path)?;
        let text = path.to_str().context("Path must be UTF-8")?;
        ensure!(
            confirm_path == Some(text),
            "Adoption requires confirm_path matching the full path"
        );
        let repo: Repository = read_json(&self.data.lock().unwrap().db, "repositories", id)?;
        ensure!(
            repository_binding_matches(&repo),
            ade_core::error::NeedsRebind
        );
        ensure!(
            path != Path::new(&repo.root),
            "The primary checkout cannot be adopted"
        );
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.directory.join(format!("{id}.lock")))?;
        ensure!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "Repository lifecycle operation is running"
        );
        let listing = self.list(&repo, &lock)?;
        ensure!(
            listing
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["path"].as_str() == Some(text) && item["prunable"] != true),
            "Selected path is not an available linked worktree"
        );
        let common = std::fs::canonicalize(git(
            text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?)?;
        ensure!(
            common == Path::new(&repo.common_dir),
            "Worktree belongs to another repository"
        );
        let physical = identity(text)?;
        let admin = admin_dir(text)?;
        let d = self.data.lock().unwrap();
        ensure!(
            !d.busy.contains(id) && !d.leases.keys().any(|held| held.starts_with(&path)),
            "Worktree has active ADE work"
        );
        ensure!(
            !d.removing.iter().any(|removing| path.starts_with(removing)),
            "Worktree removal is in progress"
        );
        ensure!(
            d.db.query_row("SELECT 1 FROM owned WHERE id=?1", [text], |_| Ok(()))
                .optional()?
                .is_none(),
            "Worktree already has ADE removal authority"
        );
        // A shared-use claim held for the adoption refuses it while any
        // profile creates or removes this path, and a blocked registry
        // refuses it outright: authority is granted only when the host
        // registry confirms no conflicting lifecycle work.
        let claim = self.resources.acquire(
            Target::Existing(&path),
            ClaimMode::Shared,
            ClaimPurpose::Use,
            None,
        )?;
        let granted = (|| -> Result<()> {
            ensure!(
                std::fs::canonicalize(text)? == path && identity(text)? == physical,
                ade_core::error::NeedsRebind
            );
            claim_worktree(&d.db, id, text, &admin, true)
        })();
        self.resources.settle(&claim, Settlement::Release);
        granted?;
        drop(d);
        self.snapshot(id)
    }
    /// Admits `worktree.switch`, `worktree.remove` or `worktree.refresh` and
    /// runs it on a supervised worker thread. The receipt, checked first,
    /// replays a known operation ID with the same parameters and rejects one
    /// reused with different parameters.
    fn start(self: &Arc<Self>, op: &str, request: &Value) -> Result<Value> {
        let effect = Effect::decode(op, request)?;
        let id = valid("project_id", effect.project_id())?;
        let operation_id = valid("operation_id", effect.operation_id())?;
        ensure!(operation_id.len() <= 256, "Operation ID too long");
        let payload = effect.payload()?;
        let mut d = self.data.lock().unwrap();
        match probe(&d.db, operation_id, op, &payload)? {
            Admission::New => {}
            Admission::Replay(_) => {
                drop(d);
                return self.snapshot(id);
            }
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
            }
        }
        let repo: Repository = read_json(&d.db, "repositories", id)?;
        ensure!(
            !d.busy.contains(id),
            ade_core::error::LifecycleBusy("Repository lifecycle operation is running")
        );
        ensure!(
            d.busy.len() < 8,
            ade_core::error::LifecycleBusy("Too many lifecycle operations")
        );
        let mut remove_path = None;
        let mut remove_identity = None;
        let mut setup_path = None;
        let mut cleanup = Vec::new();
        let mut carry = None;
        let mut resources_path = None;
        let mut resources_claim = None;
        match &effect {
            Effect::Carry(request) => {
                carry = Some(self.admit_carry(&d, &repo, request, operation_id)?);
            }
            Effect::Resources(request) => {
                let (path, claim) = self.admit_resources(&d, &repo, request, operation_id)?;
                resources_path = Some(path);
                resources_claim = Some(claim);
            }
            Effect::Create(create) => {
                for (key, value) in [
                    ("name", &create.name),
                    ("branch", &create.branch),
                    ("base", &create.base),
                    ("path", &create.path),
                ] {
                    if let Some(value) = value {
                        ensure!(
                            valid(key, value)?.len() <= 1024 && !value.starts_with('-'),
                            "Invalid {key}"
                        );
                    }
                }
                ensure!(
                    create.name.is_none() || create.branch.is_none(),
                    "Name a workspace or a branch, not both"
                );
                if let Some(fetch) = &create.fetch {
                    ensure!(
                        create.base.is_none(),
                        "A fetched source replaces base; send one or the other"
                    );
                    valid("fetch.remote", &fetch.remote)?;
                    valid("fetch.ref", &fetch.reference)?;
                }
            }
            Effect::Setup(setup) => {
                let path = std::fs::canonicalize(valid("path", &setup.path)?)?;
                let text = path.to_str().context("Path must be UTF-8")?;
                ensure!(
                    path != Path::new(&repo.root),
                    "Setup hooks run only in linked trees"
                );
                ensure!(
                    authority(&d.db, id, text)? == policy::Authority::Verified,
                    "Setup runs only in a tree ADE created or adopted"
                );
                policy::may_setup(tree_phase(&d.db, id, repo.binding_generation, text)?)?;
                setup_path = Some(path);
            }
            Effect::Cleanup(request) => {
                ensure!(
                    (1..=policy::MAX_CLEANUP_PATHS).contains(&request.paths.len()),
                    "Cleanup takes 1–{} paths",
                    policy::MAX_CLEANUP_PATHS
                );
                for path in &request.paths {
                    let path = valid("paths", path)?;
                    ensure!(
                        Path::new(path).is_absolute(),
                        "Cleanup paths must be absolute"
                    );
                    // A path that no longer resolves is reported, not skipped silently.
                    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
                    ensure!(!cleanup.contains(&path), "Cleanup paths repeat");
                    cleanup.push(path);
                }
            }
            Effect::Switch(switch) => {
                let target = valid("target", &switch.target)?;
                ensure!(!target.starts_with('-'), "Target cannot begin with '-'");
                if let Some(base) = &switch.base {
                    ensure!(!valid("base", base)?.starts_with('-'), "Invalid base");
                }
            }
            Effect::Remove(remove) => {
                ensure!(
                    remove.force != Some(true),
                    "Forced worktree removal is unavailable"
                );
                let path = std::fs::canonicalize(valid("path", &remove.path)?)?;
                let text = path.to_str().context("Path must be UTF-8")?;
                // The same check setup, carry, resources and cleanup apply:
                // repository, marker token and the recorded physical
                // identity, so a replacement at the same path is refused.
                policy::may_remove(authority(&d.db, id, text)?)?;
                ensure!(
                    path != Path::new(&repo.root),
                    "Cannot remove the repository command directory; open the main checkout first"
                );
                ensure!(
                    !d.leases.keys().any(|p| p.starts_with(&path)),
                    "Worktree has an active terminal or Agent. Exit its shell and disconnect its Agents before removal."
                );
                let policy = remove.delete_branch.as_deref().unwrap_or("keep");
                ensure!(
                    ["keep", "merged"].contains(&policy),
                    "Branch policy must be keep or merged"
                );
                remove_identity = Some(identity(text)?);
                remove_path = Some(path);
            }
            Effect::Refresh(_) => {}
        }
        // The exclusive removal claim refuses use by any profile before the
        // lifecycle command receives the path.
        let remove_claim = match &remove_path {
            Some(path) => Some(self.resources.acquire(
                Target::Existing(path),
                ClaimMode::Exclusive,
                ClaimPurpose::Remove,
                Some(operation_id),
            )?),
            None => None,
        };
        // Setup hooks use the tree like any other work does.
        let use_claim = match &setup_path {
            Some(path) => Some(self.resources.acquire(
                Target::Existing(path),
                ClaimMode::Shared,
                ClaimPurpose::Use,
                Some(operation_id),
            )?),
            None => resources_claim,
        };
        let release_claim = || {
            let carried = carry.iter().flat_map(|carry| carry.claims());
            for claim in [&remove_claim, &use_claim]
                .into_iter()
                .flatten()
                .chain(carried)
            {
                self.resources.settle(claim, Settlement::Release);
            }
        };
        // A supervisor retains the lock if this daemon dies. Its Git child does not
        // inherit the descriptor, so background Git helpers cannot strand it.
        // No effect has started, so every claim taken above is released on
        // any failure to take the lock, including failing to open it.
        let lock = match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.directory.join(format!("{id}.lock")))
        {
            Ok(lock) => lock,
            Err(error) => {
                release_claim();
                return Err(error.into());
            }
        };
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if let Some(p) = &remove_path {
                d.removing.remove(p);
            }
            release_claim();
            return Err(ade_core::error::LifecycleBusy(
                "A previous Git lifecycle command still holds the repository lock",
            )
            .into());
        }
        let job = Operation {
            id: operation_id.into(),
            project_id: id.into(),
            binding_generation: repo.binding_generation,
            request: request.clone(),
            worktree_path: remove_path
                .as_ref()
                .or(setup_path.as_ref())
                .or(resources_path.as_ref())
                .map(PathBuf::as_path)
                .or(carry.as_ref().map(|carry| carry.target()))
                .map(|path| path.to_string_lossy().into_owned()),
            status: JobStatus::Running,
            result: Value::Null,
            error: None,
            code: None,
            recovery: None,
            started_at: now_ms(),
            finished_at: None,
        };
        // The receipt and the ledger row commit in one transaction.
        if let Err(error) = (|| -> Result<()> {
            let tx = Transaction::new_unchecked(&d.db, TransactionBehavior::Immediate)?;
            ensure!(
                receipts::begin(&tx, &job.id, op, &payload, None, job.started_at)?
                    == Admission::New,
                "Operation ID was already used for different parameters"
            );
            put(&tx, LEDGER, &job.id, &job)?;
            receipts::settle(&tx, &job.id, Status::Dispatched, None, job.started_at)?;
            tx.commit()?;
            Ok(())
        })() {
            if let Some(p) = &remove_path {
                d.removing.remove(p);
            }
            release_claim();
            return Err(error);
        }
        if let Some(path) = &remove_path {
            d.removing.insert(path.clone());
        }
        // New leases inside a tree being cleaned up are refused from here on.
        d.removing.extend(cleanup.iter().cloned());
        d.busy.insert(id.into());
        drop(d);
        let hub = self.clone();
        let admitted = Admitted {
            remove_path,
            remove_identity,
            remove_claim,
            setup_path,
            use_claim,
            cleanup,
            carry,
            resources_path,
        };
        std::thread::spawn(move || {
            hub.execute(repo, job, lock, admitted);
        });
        self.snapshot(id)
    }
    fn execute(&self, repo: Repository, job: Operation, lock: File, admitted: Admitted) {
        let Admitted {
            remove_path,
            remove_identity,
            remove_claim,
            setup_path,
            use_claim,
            cleanup,
            carry,
            resources_path,
        } = admitted;
        if let Some(carry) = carry {
            return self.execute_carry(repo, job, lock, carry);
        }
        if let (Some(path), Some(claim)) = (resources_path, &use_claim) {
            return self.execute_resources(repo, job, lock, path, claim.clone());
        }
        if let Some(path) = setup_path {
            return self.execute_setup(repo, job, lock, path, use_claim);
        }
        if job.request["op"] == "worktree.cleanup" {
            return self.execute_cleanup(repo, job, lock, cleanup);
        }
        self.execute_git(repo, job, lock, remove_path, remove_identity, remove_claim);
    }
    /// `worktree.setup`: runs the setup hooks again in an owned tree.
    fn execute_setup(
        &self,
        repo: Repository,
        mut job: Operation,
        lock: File,
        path: PathBuf,
        claim: Option<String>,
    ) {
        let mut runs = Vec::new();
        let result = (|| -> Result<()> {
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            let listing = self.list(&repo, &lock)?;
            let text = path.to_str().context("Path must be UTF-8")?;
            let item = listing
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["path"].as_str() == Some(text))
                .context("Worktree is absent from Git listing")?;
            ensure!(
                item["prunable"] != true,
                "Worktree is unavailable to Git; refresh and inspect it"
            );
            {
                let d = self.data.lock().unwrap();
                ensure!(
                    authority(&d.db, &repo.id, text)? == policy::Authority::Verified,
                    "Worktree removal authority changed; refresh and inspect before retrying"
                );
                policy::may_setup(tree_phase(&d.db, &repo.id, repo.binding_generation, text)?)?;
            }
            let (done, outcome) =
                self.setup_tree(&repo, &job, &lock, &path, item["branch"].as_str())?;
            runs = done;
            outcome
        })();
        if let Some(claim) = &claim {
            let settlement = if runs
                .last()
                .is_some_and(|run| policy::hook_uncertain(run.verdict))
            {
                Settlement::Quarantine("hook_outcome_unknown")
            } else {
                Settlement::Release
            };
            self.resources.settle(claim, settlement);
        }
        job.result = json!({"value": {"path": job.worktree_path}});
        if !runs.is_empty() {
            job.result["hooks"] = json!(runs);
        }
        self.finish(repo, job, lock, result, None, Vec::new());
    }
    /// Records a finished operation: the repository, the ledger row and the
    /// settled receipt commit together, then the repository is free.
    fn finish(
        &self,
        repo: Repository,
        mut job: Operation,
        lock: File,
        result: Result<()>,
        status: Option<JobStatus>,
        removing: Vec<PathBuf>,
    ) {
        job.status = status.unwrap_or(if result.is_ok() {
            JobStatus::Succeeded
        } else {
            JobStatus::Failed
        });
        if let Err(error) = result {
            record_outcome(&mut job, error);
        }
        job.finished_at = Some(now_ms());
        unsafe {
            libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
        }
        let mut d = self.data.lock().unwrap();
        if let Err(e) = (|| -> Result<()> {
            let tx = Transaction::new_unchecked(&d.db, TransactionBehavior::Immediate)?;
            put(&tx, "repositories", &repo.id, &repo)?;
            put(&tx, LEDGER, &job.id, &job)?;
            reconcile_receipt(&tx, &job)?;
            // Lifecycle hooks commit with the completion they describe (F058).
            if job.status == JobStatus::Succeeded
                && let Some(event) = crate::hooks::Event::worktree(
                    job.request["op"].as_str().unwrap_or(""),
                    &job.id,
                    &job.project_id,
                    job.worktree_path.as_deref(),
                )
            {
                crate::hooks::enqueue(&tx, &event, now_ms())?;
            }
            tx.commit()?;
            Ok(())
        })() {
            eprintln!("Could not persist worktree completion: {e}");
        }
        d.busy.remove(&repo.id);
        for path in removing {
            d.removing.remove(&path);
        }
    }
    fn execute_git(
        &self,
        mut repo: Repository,
        mut job: Operation,
        lock: File,
        remove_path: Option<PathBuf>,
        remove_identity: Option<(String, String)>,
        remove_claim: Option<String>,
    ) {
        // The lifecycle claim, whether the command received the effect, and
        // whether the checkout state was read back after the command exited.
        let mut claim = remove_claim;
        let mut dispatched = false;
        let mut observed = false;
        // The creation request in switch form; `worktree.create` replaces it
        // with its resolved names.
        let creating = matches!(
            job.request["op"].as_str(),
            Some("worktree.switch" | "worktree.create")
        );
        let mut spec = job.request.clone();
        let mut resolved: Option<Value> = None;
        let mut phase_recorded = false;
        let mut created: Option<PathBuf> = None;
        let mut removed_head: Option<String> = None;
        let mut torn_down = false;
        let mut hooks_uncertain = false;
        let mut hook_runs: Vec<WorktreeHookRun> = Vec::new();
        let result = (|| -> Result<()> {
            // Recheck after admission and immediately before Git receives
            // the directory. A later external rename remains detectable on the
            // next command, but cannot be made atomic with an external process.
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            let before = self.list(&repo, &lock)?;
            if job.request["op"] == "worktree.refresh" {
                repo.cache = before;
                repo.refreshed_at = Some(now_ms());
                return Ok(());
            }
            // `worktree.create` resolves its names first and then runs as a
            // creating switch. The resolved branch, base and path are durable
            // before Git or any hook runs.
            if job.request["op"] == "worktree.create" {
                let branches = self.branches(&repo, &lock)?;
                spec = creation_spec(&repo, &job.request, &branches)?;
                job.worktree_path = spec["path"].as_str().map(str::to_owned);
                resolved = Some(json!({"branch": spec["target"], "base": spec["base"],
                    "path": spec["path"]}));
                job.result = json!({"resolved": resolved});
                put(&self.data.lock().unwrap().db, LEDGER, &job.id, &job)?;
                let create: WorktreeCreateRequest = decode(&job.request)?;
                if let Some(fetch) = &create.fetch {
                    // The fetch target is durable before the network effect.
                    let fetched = resolved.as_mut().context("Missing resolved names")?;
                    fetched["fetch"] = json!({"remote": fetch.remote, "ref": fetch.reference,
                        "local": carry::fetched_ref(&job.id)});
                    job.result = json!({"resolved": fetched});
                    put(&self.data.lock().unwrap().db, LEDGER, &job.id, &job)?;
                    let (_, commit) = self.fetch_source(&repo, &lock, &job, fetch)?;
                    spec["base"] = json!(commit);
                    fetched["base"] = json!(commit);
                    job.result = json!({"resolved": fetched});
                    put(&self.data.lock().unwrap().db, LEDGER, &job.id, &job)?;
                }
            }
            if creating
                && job.request["op"] == "worktree.switch"
                && let Some(item) =
                    before.as_array().unwrap().iter().find(|item| {
                        item["branch"] == spec["target"] || item["path"] == spec["target"]
                    })
            {
                job.worktree_path = Some(field(item, "path")?.into());
                put(&self.data.lock().unwrap().db, LEDGER, &job.id, &job)?;
            }
            let mut removed_branch = None;
            let args = if creating {
                let target = field(&spec, "target")?;
                git(&repo.root, &["check-ref-format", "--branch", target])?;
                if let Some(existing) = before
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["branch"] == target)
                {
                    ensure!(spec["create"] != true, "Branch is already checked out");
                    job.worktree_path = Some(field(existing, "path")?.into());
                    repo.cache = before;
                    repo.refreshed_at = Some(now_ms());
                    job.result =
                        json!({"exit_code":0,"value":{"path":job.worktree_path,"existing":true}});
                    return Ok(());
                }
                let path = creation_path(&repo, &spec)?;
                if !path_is_free(&path) {
                    // Another profile may be creating this very path. Its
                    // claim is the explicit answer; a probe that is admitted
                    // is released at once and the path is simply taken.
                    match self.resources.acquire(
                        Target::Existing(&path),
                        ClaimMode::Exclusive,
                        ClaimPurpose::Create,
                        Some(&job.id),
                    ) {
                        Err(error) if error.downcast_ref::<HostResourceConflict>().is_some() => {
                            return Err(error);
                        }
                        Ok(probe) => self.resources.release(&probe)?,
                        Err(_) => {}
                    }
                    bail!("Worktree path already exists");
                }
                // Reserve the unborn path host-wide before it is created.
                claim = Some(self.resources.acquire(
                    Target::Unborn(&path),
                    ClaimMode::Exclusive,
                    ClaimPurpose::Create,
                    Some(&job.id),
                )?);
                job.worktree_path = Some(path.to_string_lossy().into_owned());
                // The tree is `creating` before Git runs, so an Agent is
                // refused until setup has finished.
                self.set_phase(
                    &repo,
                    &job,
                    path.to_str().context("Path must be UTF-8")?,
                    Some(target),
                    WorktreePhase::Creating,
                )?;
                phase_recorded = true;
                let mut a = vec!["worktree".into(), "add".into()];
                if spec["create"] == true {
                    a.extend(["-b".into(), target.into()]);
                }
                a.push(path.to_string_lossy().into_owned());
                if spec["create"] == true {
                    let base = spec["base"].as_str().unwrap_or("HEAD");
                    ensure!(!base.starts_with('-'), "Invalid base");
                    a.push(base.into());
                } else {
                    a.push(target.into());
                }
                a
            } else {
                let path = remove_path.as_ref().context("Missing removal path")?;
                let ownership: Value = {
                    let d = self.data.lock().unwrap();
                    ensure!(
                        authority(
                            &d.db,
                            &repo.id,
                            path.to_str().context("Path must be UTF-8")?
                        )? == policy::Authority::Verified,
                        "Worktree ownership changed before removal"
                    );
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
                let item = before
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["path"].as_str() == path.to_str())
                    .context("Worktree is absent from Git listing")?;
                ensure!(
                    item["locked"] != true && item["prunable"] != true,
                    "Locked or unavailable worktree cannot be removed"
                );
                ensure!(
                    git(
                        path.to_str().unwrap(),
                        &["status", "--porcelain", "--untracked-files=all"]
                    )?
                    .is_empty(),
                    "Worktree has uncommitted or untracked files"
                );
                removed_branch = item["branch"].as_str().map(str::to_owned);
                removed_head = git(path.to_str().unwrap(), &["rev-parse", "HEAD"]).ok();
                if !repo.config.teardown.is_empty() {
                    // Teardown acts on the tree, so the removal claim is
                    // dispatched first: a daemon lost during teardown leaves
                    // the tree quarantined, not free.
                    if let Some(claim) = &claim {
                        self.resources.dispatch(claim)?;
                        dispatched = true;
                    }
                    let (runs, outcome) =
                        self.teardown_tree(&repo, &job, &lock, path, removed_branch.as_deref())?;
                    torn_down = true;
                    hooks_uncertain = runs
                        .last()
                        .is_some_and(|run| policy::hook_uncertain(run.verdict));
                    hook_runs = runs;
                    // A hook that finished leaves the tree's state known.
                    observed = !hooks_uncertain;
                    outcome?;
                    ensure!(
                        git(
                            path.to_str().unwrap(),
                            &["status", "--porcelain", "--untracked-files=all"]
                        )?
                        .is_empty(),
                        "Teardown left uncommitted or untracked files; the tree was kept"
                    );
                }
                vec![
                    "worktree".into(),
                    "remove".into(),
                    path.to_string_lossy().into_owned(),
                ]
            };
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
            // The phase commits before the command starts; a failed commit stops here.
            if let Some(claim) = &claim
                && !dispatched
            {
                self.resources.dispatch(claim)?;
                dispatched = true;
            }
            let output = run(command, repo.config.timeout_seconds, Some(&lock));
            // A failed or timed-out Git command is not a rollback. Inspect actual state.
            let after = self.list(&repo, &lock);
            let exited = match &output {
                Ok(_) => true,
                // The command never started, so it had no effect.
                Err(error) => {
                    error.downcast_ref::<LifecycleFailure>()
                        == Some(&LifecycleFailure::LifecycleUnavailable)
                }
            };
            observed = exited
                && after.as_ref().is_ok_and(|listing| {
                    remove_path.is_some()
                        || created_settled(
                            self,
                            claim.as_deref(),
                            listing,
                            job.worktree_path.as_deref(),
                        )
                });
            if let Ok(after) = &after {
                repo.cache = after.clone();
                repo.refreshed_at = Some(now_ms());
                for item in after.as_array().unwrap() {
                    if let Some(path) = item["path"].as_str() {
                        if creating
                            && (item["branch"] == spec["target"] || item["path"] == spec["target"])
                        {
                            job.worktree_path = Some(path.into());
                        }
                        let was_present =
                            before.as_array().unwrap().iter().any(|i| i["path"] == path);
                        // Only claim the requested branch, never another process's tree.
                        if !was_present && item["branch"] == spec["target"] && creating {
                            let admin = admin_dir(path)?;
                            claim_worktree(
                                &self.data.lock().unwrap().db,
                                &repo.id,
                                path,
                                &admin,
                                false,
                            )?;
                            created = Some(PathBuf::from(path));
                        }
                    }
                }
                // A creation that left no tree leaves no phase; one whose
                // tree exists without a confirmed command is not ready.
                if phase_recorded && created.is_none() {
                    let path = job.worktree_path.clone().unwrap_or_default();
                    if after
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["path"] == path.as_str())
                    {
                        self.set_phase(
                            &repo,
                            &job,
                            &path,
                            spec["target"].as_str(),
                            WorktreePhase::SetupInterrupted,
                        )?;
                    } else {
                        self.data
                            .lock()
                            .unwrap()
                            .db
                            .execute("DELETE FROM trees WHERE id=?1", [&path])?;
                    }
                }
            }
            job.result = output?;
            let command_result = successful(&job.result).map(|_| ());
            job.result["value"] =
                json!({"path":job.worktree_path,"git_exit_code":job.result["exit_code"]});
            if let Some(resolved) = &resolved {
                job.result["resolved"] = resolved.clone();
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
            // A new tree is ready only after its setup hooks all succeed. A
            // failed hook keeps the tree, owned and visibly failed.
            if let Some(path) = &created {
                // Ignored resources arrive before setup hooks, which may need them.
                if !repo.config.resources.is_empty() {
                    let results = self.apply_resources(&repo, &lock, path);
                    job.result["resources"] = json!(results);
                    if let Err(error) = transfer::resources_outcome(&results) {
                        self.set_phase(
                            &repo,
                            &job,
                            path.to_str().context("Path must be UTF-8")?,
                            spec["target"].as_str(),
                            WorktreePhase::SetupFailed,
                        )?;
                        return Err(error);
                    }
                }
                let (runs, outcome) =
                    self.setup_tree(&repo, &job, &lock, path, spec["target"].as_str())?;
                hooks_uncertain = runs
                    .last()
                    .is_some_and(|run| policy::hook_uncertain(run.verdict));
                hook_runs = runs;
                outcome?;
            }
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
                let text = path.to_string_lossy();
                let mut entry = WorktreeArchiveEntry {
                    path: text.clone().into_owned(),
                    branch: removed_branch.clone(),
                    head: removed_head.clone(),
                    branch_deleted: false,
                    operation_id: job.id.clone(),
                    archived_at: now_ms(),
                };
                self.retire(&repo.id, &entry)?;
                if job.request["delete_branch"] == "merged" {
                    let branch =
                        removed_branch.context("Detached worktree has no branch to delete")?;
                    let command =
                        self.command_for(&repo, &["branch".into(), "-d".into(), branch.clone()])?;
                    let deletion = run(command, repo.config.timeout_seconds, Some(&lock))?;
                    job.result["branch_deletion"] = deletion.clone();
                    if deletion["exit_code"] != 0 {
                        bail!(
                            "Worktree removed; branch {branch} was retained. Inspect its merge state before deleting it."
                        );
                    }
                    entry.branch_deleted = true;
                    self.retire(&repo.id, &entry)?;
                }
            }
            Ok(())
        })();
        if let Some(claim) = &claim {
            let settlement = if hooks_uncertain {
                Settlement::Quarantine("hook_outcome_unknown")
            } else {
                host_resources::settle_lifecycle(dispatched, observed)
            };
            self.resources.settle(claim, settlement);
        }
        // Teardown ran but the tree is still listed: it is not ready again.
        if torn_down
            && result.is_err()
            && let Some(path) = remove_path.as_ref().and_then(|path| path.to_str())
            && repo
                .cache
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["path"] == path))
        {
            let phase = if observed && !hooks_uncertain {
                WorktreePhase::TeardownFailed
            } else {
                WorktreePhase::TeardownInterrupted
            };
            let current = read_tree(&self.data.lock().unwrap().db, path);
            if let Ok(Some(mut tree)) = current
                && tree.phase == WorktreePhase::TearingDown
            {
                tree.phase = phase;
                tree.updated_at = now_ms();
                if let Err(error) = self.put_tree(path, &tree) {
                    eprintln!("Could not record teardown outcome: {error}");
                }
            }
        }
        if !hook_runs.is_empty() {
            job.result["hooks"] = json!(hook_runs);
        }
        let partial = result.is_err()
            && job.request["op"] == "worktree.remove"
            && job.result["branch_deletion"].is_object()
            && job.worktree_path.as_deref().is_some_and(|path| {
                !repo
                    .cache
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["path"] == path))
            });
        let status = if result.is_ok() {
            JobStatus::Succeeded
        } else if partial {
            JobStatus::Partial
        } else {
            JobStatus::Failed
        };
        // Successful daemon completion releases the inherited lock explicitly;
        // daemon death leaves the supervisor holding it until Git exits.
        self.finish(
            repo,
            job,
            lock,
            result,
            Some(status),
            remove_path.into_iter().collect(),
        );
    }
    /// Drops ADE's authority and phase for a removed tree and keeps its
    /// archive record, in one transaction.
    fn retire(&self, project_id: &str, entry: &WorktreeArchiveEntry) -> Result<()> {
        let d = self.data.lock().unwrap();
        let tx = Transaction::new_unchecked(&d.db, TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM owned WHERE id=?1", [&entry.path])?;
        tx.execute("DELETE FROM trees WHERE id=?1", [&entry.path])?;
        put(
            &tx,
            "archived",
            &format!("{}\0{}", entry.operation_id, entry.path),
            &json!({"project_id": project_id, "entry": entry}),
        )?;
        tx.commit()?;
        Ok(())
    }
    /// `worktree.archived`: the newest 200 archive records.
    fn archived(&self, id: &str) -> Result<Value> {
        let d = self.data.lock().unwrap();
        let _: Repository = read_json(&d.db, "repositories", id)?;
        let entries = d
            .db
            .prepare(
                "SELECT data FROM archived WHERE json_extract(data,'$.project_id')=?1 ORDER BY json_extract(data,'$.entry.archived_at') DESC, rowid DESC LIMIT 200",
            )?
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|row| {
                let row: Value = serde_json::from_str(&row?)?;
                Ok(serde_json::from_value(row["entry"].clone())?)
            })
            .collect::<Result<_>>()?;
        reply(&WorktreeArchive {
            tag: Default::default(),
            project_id: id.into(),
            entries,
        })
    }
    /// Gathers the facts cleanup eligibility depends on for one tree.
    /// `running` is the cleanup that is asking, which does not block itself.
    fn tree_facts(
        &self,
        repo: &Repository,
        listing: &Value,
        path: &Path,
        running: bool,
    ) -> Result<policy::TreeFacts> {
        let text = path.to_str().context("Path must be UTF-8")?;
        let item = listing
            .as_array()
            .and_then(|items| items.iter().find(|item| item["path"] == text));
        // Status is read before the data lock: Git may be slow.
        let dirty = match item {
            Some(_) => git(text, &["status", "--porcelain", "--untracked-files=all"])
                .ok()
                .map(|status| !status.is_empty()),
            None => None,
        };
        let inspection = self.resources.inspect(Some(text));
        let claims = match &inspection {
            Err(_) => policy::Claims::Unavailable,
            Ok(state) if state.registry.state == RegistryState::Blocked => {
                policy::Claims::Unavailable
            }
            Ok(state) => {
                let inside: Vec<_> = state
                    .claims
                    .iter()
                    .filter(|claim| Path::new(&claim.path).starts_with(path))
                    .collect();
                if inside
                    .iter()
                    .any(|claim| claim.state == ClaimState::Quarantined)
                {
                    policy::Claims::Uncertain
                } else if inside.is_empty() {
                    policy::Claims::Free
                } else {
                    policy::Claims::Held
                }
            }
        };
        let d = self.data.lock().unwrap();
        Ok(policy::TreeFacts {
            primary: path == Path::new(&repo.root),
            listed: item.is_some(),
            authority: authority(&d.db, &repo.id, text)?,
            locked: item.is_some_and(|item| item["locked"] == true),
            prunable: item.is_some_and(|item| item["prunable"] == true),
            dirty,
            leased: d.leases.keys().any(|lease| lease.starts_with(path)),
            busy: !running && d.busy.contains(&repo.id),
            claims,
            phase: tree_phase(&d.db, &repo.id, repo.binding_generation, text)?,
        })
    }
    /// `worktree.cleanup.plan`: every linked tree with its blockers. It reads
    /// a fresh Git listing and changes nothing.
    fn cleanup_plan(&self, id: &str) -> Result<Value> {
        let repo: Repository = read_json(&self.data.lock().unwrap().db, "repositories", id)?;
        ensure!(
            repository_binding_matches(&repo),
            ade_core::error::NeedsRebind
        );
        let listing = parse_listing(&git(
            &repo.root,
            &["worktree", "list", "--porcelain", "-z"],
        )?)?;
        let mut trees = Vec::new();
        for item in listing.as_array().unwrap() {
            let path = field(item, "path")?;
            if path == repo.root || item["bare"] == true {
                continue;
            }
            let facts = self.tree_facts(&repo, &listing, Path::new(path), false)?;
            let blockers = policy::cleanup_blockers(&facts);
            trees.push(WorktreeCleanupCandidate {
                path: path.into(),
                branch: item["branch"].as_str().map(str::to_owned),
                phase: facts.phase,
                eligible: blockers.is_empty(),
                blockers,
            });
        }
        reply(&WorktreeCleanupPlan {
            tag: Default::default(),
            project_id: id.into(),
            trees,
        })
    }
    /// `worktree.cleanup`: each tree is classified again, claimed
    /// exclusively, torn down, removed and archived in turn. A tree that is
    /// blocked is skipped; nothing is forced.
    fn execute_cleanup(
        &self,
        mut repo: Repository,
        mut job: Operation,
        lock: File,
        paths: Vec<PathBuf>,
    ) {
        let mut trees = Vec::new();
        let result = (|| -> Result<()> {
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            let policy = match job.request["delete_branch"].as_str() {
                Some("merged") => BranchPolicy::Merged,
                _ => BranchPolicy::Keep,
            };
            for path in &paths {
                // Each tree is judged against a listing read after the previous one.
                let listing = self.list(&repo, &lock)?;
                trees.push(self.cleanup_tree(&repo, &job, &lock, &listing, path, policy));
            }
            let after = self.list(&repo, &lock)?;
            repo.cache = after;
            repo.refreshed_at = Some(now_ms());
            Ok(())
        })();
        let outcomes: Vec<CleanupOutcome> = trees.iter().map(|tree| tree.outcome).collect();
        job.result = json!({"trees": trees});
        let (status, result) = match result {
            Err(error) => (
                if outcomes.contains(&CleanupOutcome::Archived) {
                    JobStatus::Partial
                } else {
                    JobStatus::Failed
                },
                Err(error),
            ),
            Ok(()) => {
                let status = policy::cleanup_status(&outcomes);
                let archived = outcomes
                    .iter()
                    .filter(|outcome| **outcome == CleanupOutcome::Archived)
                    .count();
                let result = if status == JobStatus::Succeeded {
                    Ok(())
                } else {
                    Err(anyhow!(
                        "Cleanup archived {archived} of {} trees; see result.trees for each tree's blockers or failure",
                        outcomes.len()
                    ))
                };
                (status, result)
            }
        };
        self.finish(repo, job, lock, result, Some(status), paths);
    }
    /// Retires one tree for `worktree.cleanup`. Never returns an error: every
    /// path ends in a reported outcome.
    fn cleanup_tree(
        &self,
        repo: &Repository,
        job: &Operation,
        lock: &File,
        listing: &Value,
        path: &Path,
        policy: BranchPolicy,
    ) -> WorktreeCleanupTree {
        let mut tree = WorktreeCleanupTree {
            path: path.to_string_lossy().into_owned(),
            outcome: CleanupOutcome::Skipped,
            blockers: Vec::new(),
            error: None,
            hooks: Vec::new(),
            branch_deleted: None,
        };
        let facts = match self.tree_facts(repo, listing, path, true) {
            Ok(facts) => facts,
            Err(error) => {
                tree.blockers.push(CleanupBlocker::StatusUnknown);
                tree.error = Some(error.to_string());
                return tree;
            }
        };
        tree.blockers = policy::cleanup_blockers(&facts);
        if !tree.blockers.is_empty() {
            return tree;
        }
        let claim = match self.resources.acquire(
            Target::Existing(path),
            ClaimMode::Exclusive,
            ClaimPurpose::Remove,
            Some(&job.id),
        ) {
            Ok(claim) => claim,
            Err(error) => {
                tree.blockers.push(
                    if error.downcast_ref::<HostResourcesUnavailable>().is_some() {
                        CleanupBlocker::RegistryUnavailable
                    } else {
                        CleanupBlocker::ClaimHeld
                    },
                );
                tree.error = Some(error.to_string());
                return tree;
            }
        };
        let mut dispatched = false;
        let mut observed = false;
        let mut uncertain = false;
        let outcome = (|| -> Result<bool> {
            let text = path.to_str().context("Path must be UTF-8")?;
            let item = listing
                .as_array()
                .and_then(|items| items.iter().find(|item| item["path"] == text))
                .context("Worktree is absent from Git listing")?;
            let branch = item["branch"].as_str().map(str::to_owned);
            let head = git(text, &["rev-parse", "HEAD"]).ok();
            let (device, inode) = identity(text)?;
            self.resources.dispatch(&claim)?;
            dispatched = true;
            if !repo.config.teardown.is_empty() {
                let (runs, outcome) =
                    self.teardown_tree(repo, job, lock, path, branch.as_deref())?;
                uncertain = runs
                    .last()
                    .is_some_and(|run| policy::hook_uncertain(run.verdict));
                tree.hooks = runs;
                observed = !uncertain;
                outcome?;
                ensure!(
                    git(text, &["status", "--porcelain", "--untracked-files=all"])?.is_empty(),
                    "Teardown left uncommitted or untracked files; the tree was kept"
                );
            }
            ensure!(
                authority(&self.data.lock().unwrap().db, &repo.id, text)?
                    == policy::Authority::Verified,
                "Worktree ownership changed before removal"
            );
            let mut command =
                self.command_for(repo, &["worktree".into(), "remove".into(), text.into()])?;
            command
                .env("ADE_EXPECT_REMOVE_PATH", path)
                .env("ADE_EXPECT_REMOVE_DEV", &device)
                .env("ADE_EXPECT_REMOVE_INO", &inode);
            let output = run(command, repo.config.timeout_seconds, Some(lock));
            let after = self.list(repo, lock);
            let exited = match &output {
                Ok(_) => true,
                Err(error) => {
                    error.downcast_ref::<LifecycleFailure>()
                        == Some(&LifecycleFailure::LifecycleUnavailable)
                }
            };
            observed = exited && after.is_ok();
            let after = after?;
            successful(&output?)?;
            ensure!(
                !after
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["path"] == text),
                "Removal did not remove the worktree"
            );
            let mut entry = WorktreeArchiveEntry {
                path: text.into(),
                branch: branch.clone(),
                head,
                branch_deleted: false,
                operation_id: job.id.clone(),
                archived_at: now_ms(),
            };
            self.retire(&repo.id, &entry)?;
            if policy == BranchPolicy::Merged
                && let Some(branch) = branch
            {
                // `-d` refuses an unmerged branch; that is reported, not forced.
                let deletion = run(
                    self.command_for(repo, &["branch".into(), "-d".into(), branch])?,
                    repo.config.timeout_seconds,
                    Some(lock),
                )?;
                entry.branch_deleted = deletion["exit_code"] == 0;
                tree.branch_deleted = Some(entry.branch_deleted);
                self.retire(&repo.id, &entry)?;
            }
            Ok(true)
        })();
        let settlement = if uncertain {
            Settlement::Quarantine("hook_outcome_unknown")
        } else {
            host_resources::settle_lifecycle(dispatched, observed)
        };
        self.resources.settle(&claim, settlement);
        match outcome {
            Ok(_) => tree.outcome = CleanupOutcome::Archived,
            Err(error) => {
                tree.outcome = if settlement == Settlement::Release {
                    CleanupOutcome::Failed
                } else {
                    CleanupOutcome::Unknown
                };
                // A tree whose teardown ran and that still exists is not ready.
                if let Some(text) = path.to_str() {
                    let record = read_tree(&self.data.lock().unwrap().db, text);
                    if let Ok(Some(mut record)) = record
                        && record.phase == WorktreePhase::TearingDown
                    {
                        record.phase = if tree.outcome == CleanupOutcome::Failed {
                            WorktreePhase::TeardownFailed
                        } else {
                            WorktreePhase::TeardownInterrupted
                        };
                        record.updated_at = now_ms();
                        if let Err(error) = self.put_tree(text, &record) {
                            eprintln!("Could not record teardown outcome: {error}");
                        }
                    }
                }
                let mut failed = job.clone();
                record_outcome(&mut failed, error);
                tree.error = failed.error;
            }
        }
        tree
    }
}

/// Whether a creation's outcome is known from the listing: the reserved path
/// is absent, or it is a listed worktree now bound to its created identity.
fn created_settled(
    hub: &Worktrees,
    claim: Option<&str>,
    listing: &Value,
    path: Option<&str>,
) -> bool {
    let (Some(claim), Some(path)) = (claim, path) else {
        return true;
    };
    if std::fs::symlink_metadata(path).is_err() {
        return true;
    }
    listing
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["path"] == path))
        && hub
            .resources
            .bind_created(claim, Path::new(path))
            .inspect_err(|error| eprintln!("Created worktree could not be bound: {error}"))
            .is_ok()
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
        .context("Could not start supervised command; check Git installation")?;
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
    fn a_running_job_reopens_as_uncertain_without_replaying_request() {
        let directory = std::env::temp_dir().join(new_id("ade-lifecycle-recovery-test"));
        std::fs::create_dir(&directory).unwrap();
        let hub = Worktrees::open(&directory).unwrap();
        let request =
            json!({"op":"worktree.remove","path":"/do-not-run","operation_id":"running-operation"});
        let job = json!({"id":"running-operation","project_id":"repo","binding_generation":0,
            "request":request,"worktree_path":null,
            "status":"running","result":null,"error":null,"started_at":1,"finished_at":null});
        {
            let d = hub.data.lock().unwrap();
            receipts::begin(
                &d.db,
                "running-operation",
                "worktree.remove",
                &request,
                None,
                1,
            )
            .unwrap();
            d.db.execute(
                "INSERT INTO jobs(id,data) VALUES(?1,?2)",
                params!["running-operation", job.to_string()],
            )
            .unwrap();
        }
        drop(hub);
        let hub = Worktrees::open(&directory).unwrap();
        let receipt: Operation =
            read_json(&hub.data.lock().unwrap().db, LEDGER, "running-operation").unwrap();
        assert_eq!(receipt.status, JobStatus::Interrupted);
        assert_eq!(receipt.code.as_deref(), Some("lifecycle_outcome_unknown"));
        assert_eq!(
            receipt.recovery.as_deref(),
            Some("inspect_repository_before_retry")
        );
        assert_eq!(receipt.request, request);
        assert!(receipt.result.is_null());
        assert_eq!(hub.active_operations(), 0);
        drop(hub);
        std::fs::remove_dir_all(directory).unwrap();
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
