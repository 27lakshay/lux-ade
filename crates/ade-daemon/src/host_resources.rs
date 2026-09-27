//! HostResources: host-local physical resource claims shared by every
//! profile's daemon (proposed architecture, section 5).
//!
//! The registry is one SQLite file in the profiles home, next to the profile
//! registry, so every profile on the host sees the same claims. A claim is
//! keyed by host plus the filesystem identity (device, inode, generation) of
//! the resource and each of its ancestors, never by a profile path, so
//! symlinked or renamed paths to one checkout collide and a replacement at the
//! same path does not inherit the old claim.
//!
//! Rules this module keeps:
//! - Shared use admits other shared use. An exclusive lifecycle claim refuses
//!   any claim on, inside, or (for another lifecycle claim) around it.
//! - Lifecycle claims are reserved before the effect, and each phase is
//!   committed before the next step. An unborn path is reserved by parent
//!   identity plus folded name, then bound to the identity Git created.
//! - Each daemon incarnation holds a liveness flock. A lost lock or a missing
//!   PID never clears an unresolved claim: it quarantines it. Only a claim
//!   still in `reserved`, before any effect, is released on owner loss.
//! - A registry that is missing, replaced or unreadable blocks new lifecycle
//!   claims until explicit recovery; it is never silently recreated empty.
//!
//! The registry is local cooperation between ADE daemons. External programs
//! that ignore it remain outside the guarantee.
use crate::model::{new_id, now_ms};
use crate::receipts::{self, Admission, Status};
use ade_core::contract::resources::{
    ClaimMode, ClaimPhase, ClaimPurpose, ClaimState, HostResourcesState, RegistryScope,
    RegistryState, RegistryStatus, ResourceClaim, ResourcesClaimResolveRequest,
    ResourcesRegistryAcceptRequest,
};
use ade_core::error::{HostResourceConflict, HostResourcesUnavailable};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    os::{fd::AsRawFd, unix::fs::MetadataExt, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};

/// The registry file, in the profiles home next to `registry.json`.
pub const REGISTRY_FILE: &str = "host-resources.sqlite3";
/// Serializes registry creation, migration and recovery across daemons.
const INIT_LOCK: &str = "host-resources.lock";
/// One liveness lock per daemon incarnation.
const OWNERS: &str = "host-resources.owners";
const FORMAT: &str = "1";
/// The profile database's record of the registry it last bound to.
const BINDING_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS host_resources_binding(id INTEGER PRIMARY KEY CHECK(id=1), host_id TEXT NOT NULL, registry TEXT NOT NULL, bound_at INTEGER NOT NULL);";
const REGISTRY_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS registry(key TEXT PRIMARY KEY, value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, data TEXT NOT NULL);";

// ---------------------------------------------------------------------------
// Pure core: identity, compatibility, owner loss, recovery and location.
// ---------------------------------------------------------------------------

/// One directory's filesystem identity. `generation` is the birth time, so a
/// reused inode at a replaced path reads as a different resource.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Node {
    pub device: String,
    pub inode: String,
    pub generation: String,
}

/// A physical key: the host plus the identity chain from the resource up to
/// the filesystem root. An unborn reservation starts its chain at the parent
/// and names the path it will create by its case-folded final component.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Key {
    pub host: String,
    pub chain: Vec<Node>,
    pub unborn: Option<String>,
}

impl Key {
    /// Whether this key names `outer`'s resource or something inside it.
    pub fn within(&self, outer: &Key) -> bool {
        if self.host != outer.host {
            return false;
        }
        match (&outer.unborn, outer.chain.first()) {
            // Nothing exists inside an unborn path yet; only the same
            // reservation is within it.
            (Some(name), parent) => {
                self.unborn.as_ref() == Some(name) && self.chain.first() == parent
            }
            (None, Some(node)) => self.chain.contains(node),
            (None, None) => false,
        }
    }
}

/// Folds a final path component the way case-insensitive volumes compare it.
/// On a case-sensitive volume this can only over-report a conflict.
pub fn fold_name(name: &str) -> String {
    name.to_lowercase()
}

/// Whether a held claim refuses a wanted one. Quarantine does not weaken a
/// claim: it keeps conflicting as its mode says until it is resolved.
pub fn conflicts(held: (&Key, ClaimMode), wanted: (&Key, ClaimMode)) -> bool {
    match (held.1, wanted.1) {
        (ClaimMode::Shared, ClaimMode::Shared) => false,
        // Removing or creating a checkout refuses use inside it; use of an
        // ancestor directory does not own its children's lifecycle.
        (ClaimMode::Exclusive, ClaimMode::Shared) => wanted.0.within(held.0),
        (ClaimMode::Shared, ClaimMode::Exclusive) => held.0.within(wanted.0),
        (ClaimMode::Exclusive, ClaimMode::Exclusive) => {
            held.0.within(wanted.0) || wanted.0.within(held.0)
        }
    }
}

/// What happens to a claim whose owning incarnation is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerLoss {
    Keep,
    Release,
    Quarantine(&'static str),
}

/// Lock release, socket loss or a missing PID is not proof that work stopped.
/// Only a reservation that never reached its effect may be released.
pub fn on_owner_lost(phase: ClaimPhase, state: ClaimState) -> OwnerLoss {
    if state == ClaimState::Quarantined {
        return OwnerLoss::Keep;
    }
    match phase {
        ClaimPhase::Reserved => OwnerLoss::Release,
        ClaimPhase::Active => OwnerLoss::Quarantine("owner_lost_during_use"),
        ClaimPhase::Dispatched | ClaimPhase::Bound => OwnerLoss::Quarantine("outcome_unknown"),
    }
}

/// How a lifecycle claim settles once its operation stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settlement {
    Release,
    Quarantine(&'static str),
}

/// `dispatched` is whether the effect was handed to Git. `observed` is
/// whether the actual checkout state was read back after the command exited.
/// An effect whose aftermath was not observed stays quarantined.
pub fn settle_lifecycle(dispatched: bool, observed: bool) -> Settlement {
    if !dispatched || observed {
        Settlement::Release
    } else {
        Settlement::Quarantine("outcome_unknown")
    }
}

/// A shared-use claim from an earlier incarnation of this profile is
/// superseded when the profile's own reconciliation claims the same key
/// again: the checkout stays protected by the new claim throughout.
pub fn superseded_by(
    old: &Claim,
    key: &Key,
    purpose: ClaimPurpose,
    profile: &str,
    incarnation: &str,
) -> bool {
    purpose == ClaimPurpose::Use
        && old.purpose == ClaimPurpose::Use
        && old.state == ClaimState::Quarantined
        && old.owner_profile == profile
        && old.owner_incarnation != incarnation
        && old.key == *key
}

/// Explicit recovery may release only a quarantined claim, and only when the
/// caller names the path the claim records.
pub fn may_resolve(claim: &Claim, confirm_path: &str) -> Result<()> {
    ensure!(
        claim.state == ClaimState::Quarantined,
        "Claim {} is active; only a quarantined claim can be resolved",
        claim.id
    );
    ensure!(
        claim.path == confirm_path,
        "confirm_path must equal the claim's recorded path"
    );
    Ok(())
}

/// Why the registry refuses new claims.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Blocked {
    /// This profile bound to a registry that is no longer on disk.
    Missing,
    /// The registry on disk is not the one this profile bound to.
    Replaced { bound: String, found: String },
    /// The file is not a readable registry. Recovery moves it aside.
    Unreadable(String),
    /// A newer ADE wrote this registry. Recovery must not touch it.
    Unsupported(String),
    /// The registry directory or file could not be opened. Recovery retries
    /// without moving anything.
    Unavailable(String),
}

impl Blocked {
    fn message(&self) -> String {
        match self {
            Self::Missing => "The host resource registry this profile used is missing; ADE will not create an empty one that forgets other profiles' claims. Accept the registry explicitly to continue.".into(),
            Self::Replaced { bound, found } => format!("The host resource registry was replaced (bound {bound}, found {found}); claims recorded in the old registry are not visible. Accept the new registry explicitly to continue."),
            Self::Unreadable(detail) => format!("The host resource registry is unreadable ({detail}); ADE left it unchanged. Accepting moves it aside and starts a new registry."),
            Self::Unsupported(format) => format!("The host resource registry has format {format}, which this ADE version does not support; update ADE. It was left unchanged."),
            Self::Unavailable(detail) => format!("The host resource registry could not be opened ({detail}). Check the profiles folder, then accept the registry to retry."),
        }
    }
}

/// What opening the registry file should do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opening {
    Create,
    Open,
    Refuse(Blocked),
}

/// A profile that has bound to a registry never creates a replacement.
pub fn opening(file_exists: bool, bound: Option<&str>) -> Opening {
    match (file_exists, bound) {
        (false, Some(_)) => Opening::Refuse(Blocked::Missing),
        (false, None) => Opening::Create,
        (true, _) => Opening::Open,
    }
}

/// Checks an existing registry's identity against the profile's binding.
pub fn verify(
    integrity: &str,
    format: Option<&str>,
    host: Option<&str>,
    bound: Option<&str>,
) -> std::result::Result<(), Blocked> {
    if integrity != "ok" {
        return Err(Blocked::Unreadable("integrity check failed".into()));
    }
    let Some(host) = host else {
        return Err(Blocked::Unreadable("no host identity".into()));
    };
    match format {
        Some(FORMAT) => {}
        Some(other) => return Err(Blocked::Unsupported(other.into())),
        None => return Err(Blocked::Unreadable("no format".into())),
    }
    match bound {
        Some(bound) if bound != host => Err(Blocked::Replaced {
            bound: bound.into(),
            found: host.into(),
        }),
        _ => Ok(()),
    }
}

/// Where the registry lives and which profile this daemon claims for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub directory: PathBuf,
    pub scope: RegistryScope,
    pub profile: String,
}

/// A managed profile's runtime home is `<profiles home>/profiles/<id>/runtime`
/// (see `ade-control`); the registry sits in that profiles home. A daemon
/// outside that layout coordinates with nobody, so its registry is private
/// and inspection says so. `ADE_HOST_RESOURCES_HOME` overrides the directory.
pub fn locate(explicit: Option<&Path>, runtime_home: Option<&Path>, private: &Path) -> Location {
    let managed = runtime_home.and_then(|home| {
        (home.file_name()? == "runtime").then_some(())?;
        let profile = home.parent()?;
        let id = uuid::Uuid::parse_str(profile.file_name()?.to_str()?).ok()?;
        let profiles = profile.parent()?;
        (profiles.file_name()? == "profiles").then_some(())?;
        Some((profiles.parent()?.to_path_buf(), id.to_string()))
    });
    let profile = managed
        .as_ref()
        .map(|(_, id)| id.clone())
        .unwrap_or_else(|| format!("path:{}", private.display()));
    match (explicit, managed) {
        (Some(directory), _) => Location {
            directory: directory.into(),
            scope: RegistryScope::Host,
            profile,
        },
        (None, Some((directory, _))) => Location {
            directory,
            scope: RegistryScope::Host,
            profile,
        },
        (None, None) => Location {
            directory: private.into(),
            scope: RegistryScope::Profile,
            profile,
        },
    }
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/// A stored claim.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claim {
    pub id: String,
    pub key: Key,
    pub path: String,
    pub mode: ClaimMode,
    pub purpose: ClaimPurpose,
    pub phase: ClaimPhase,
    pub state: ClaimState,
    pub owner_profile: String,
    pub owner_incarnation: String,
    pub owner_pid: u32,
    pub operation_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a claim is taken on.
pub enum Target<'a> {
    /// An existing directory.
    Existing(&'a Path),
    /// A path that does not exist yet and will be created.
    Unborn(&'a Path),
}

fn node(path: &Path) -> Result<Node> {
    let metadata =
        std::fs::metadata(path).with_context(|| format!("{} is unavailable", path.display()))?;
    let generation = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or_else(|| "0".into(), |time| time.as_nanos().to_string());
    Ok(Node {
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
        generation,
    })
}

fn chain(path: &Path) -> Result<Vec<Node>> {
    path.ancestors().map(node).collect()
}

/// Resolves a target to its canonical display path and physical key.
fn resolve(host: &str, target: &Target) -> Result<(String, Key)> {
    let (path, key) = match target {
        Target::Existing(path) => {
            let path = std::fs::canonicalize(path)?;
            ensure!(path.is_dir(), "Claimed path must be a directory");
            let key = Key {
                host: host.into(),
                chain: chain(&path)?,
                unborn: None,
            };
            (path, key)
        }
        Target::Unborn(path) => {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("Reserved path needs a UTF-8 final name")?;
            let parent = std::fs::canonicalize(path.parent().context("Path has no parent")?)?;
            ensure!(
                std::fs::symlink_metadata(parent.join(name)).is_err(),
                "Reserved path already exists"
            );
            let key = Key {
                host: host.into(),
                chain: chain(&parent)?,
                unborn: Some(fold_name(name)),
            };
            (parent.join(name), key)
        }
    };
    Ok((path.to_str().context("Path must be UTF-8")?.to_owned(), key))
}

fn read_claims(db: &Connection) -> Result<Vec<Claim>> {
    let rows: Vec<String> = db
        .prepare("SELECT data FROM claims ORDER BY rowid")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    rows.iter()
        .map(|row| serde_json::from_str(row).context("Host resource claim is unreadable"))
        .collect()
}

fn read_claim(db: &Connection, id: &str) -> Result<Claim> {
    let row: Option<String> = db
        .query_row("SELECT data FROM claims WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    serde_json::from_str(&row.context("Unknown host resource claim")?)
        .context("Host resource claim is unreadable")
}

fn write_claim(db: &Connection, claim: &Claim) -> Result<()> {
    db.execute(
        "INSERT INTO claims(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![claim.id, serde_json::to_string(claim)?],
    )?;
    Ok(())
}

fn bound_host(profile_db: &Connection) -> Result<Option<String>> {
    profile_db.execute_batch(BINDING_SCHEMA)?;
    Ok(profile_db
        .query_row(
            "SELECT host_id FROM host_resources_binding WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

fn bind(profile_db: &Connection, host: &str, registry: &Path) -> Result<()> {
    profile_db.execute_batch(BINDING_SCHEMA)?;
    profile_db.execute(
        "INSERT INTO host_resources_binding(id,host_id,registry,bound_at) VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,registry=excluded.registry,bound_at=excluded.bound_at",
        params![host, registry.to_string_lossy(), now_ms()],
    )?;
    Ok(())
}

fn flock(file: &File, operation: i32) -> bool {
    unsafe { libc::flock(file.as_raw_fd(), operation) == 0 }
}

fn lock_file(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?)
}

fn valid_incarnation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

struct Open {
    db: Connection,
    host: String,
    /// Held for this incarnation's lifetime; its release is not proof of exit.
    _owner: File,
}

pub struct HostResources {
    location: Location,
    incarnation: String,
    inner: Mutex<std::result::Result<Open, Blocked>>,
}

impl HostResources {
    /// Opens the registry this daemon's location names. A registry problem
    /// yields a blocked registry, not an error, so the daemon still starts
    /// and can stop existing work and run explicit recovery.
    pub fn open(location: Location, profile_db: &Connection) -> Result<Self> {
        let incarnation = new_id("incarnation");
        let bound = bound_host(profile_db)?;
        let opened = open_registry(&location, &incarnation, bound.as_deref(), None)
            .unwrap_or_else(|error| Err(Blocked::Unavailable(error.to_string())));
        if let Ok(open) = &opened
            && bound.is_none()
        {
            bind(profile_db, &open.host, &location.directory)?;
        }
        let hub = Self {
            location,
            incarnation,
            inner: Mutex::new(opened),
        };
        if let Err(error) = hub.sweep() {
            eprintln!("Host resource sweep failed: {error}");
        }
        Ok(hub)
    }

    fn path(&self) -> PathBuf {
        self.location.directory.join(REGISTRY_FILE)
    }

    /// Whether an incarnation still holds its liveness lock. Anything this
    /// daemon cannot decide counts as live, so it never releases a claim.
    fn live(&self, incarnation: &str) -> bool {
        if incarnation == self.incarnation {
            return true;
        }
        if !valid_incarnation(incarnation) {
            return true;
        }
        let path = self
            .location
            .directory
            .join(OWNERS)
            .join(format!("{incarnation}.lock"));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => true,
            Ok(file) => {
                if flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
                    flock(&file, libc::LOCK_UN);
                    false
                } else {
                    true
                }
            }
        }
    }

    /// Applies owner loss to every claim whose incarnation lost its lock.
    fn sweep_in(&self, tx: &Connection) -> Result<HashSet<String>> {
        let mut dead = HashSet::new();
        for mut claim in read_claims(tx)? {
            if !dead.contains(&claim.owner_incarnation) && self.live(&claim.owner_incarnation) {
                continue;
            }
            dead.insert(claim.owner_incarnation.clone());
            match on_owner_lost(claim.phase, claim.state) {
                OwnerLoss::Keep => {}
                OwnerLoss::Release => {
                    tx.execute("DELETE FROM claims WHERE id=?1", [&claim.id])?;
                }
                OwnerLoss::Quarantine(reason) => {
                    claim.state = ClaimState::Quarantined;
                    claim.reason = Some(reason.into());
                    claim.updated_at = now_ms();
                    write_claim(tx, &claim)?;
                }
            }
        }
        Ok(dead)
    }

    fn sweep(&self) -> Result<()> {
        let guard = self.inner.lock().unwrap();
        let Ok(open) = &*guard else { return Ok(()) };
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let dead = self.sweep_in(&tx)?;
        let referenced: HashSet<String> = read_claims(&tx)?
            .into_iter()
            .map(|claim| claim.owner_incarnation)
            .collect();
        tx.commit()?;
        // A dead incarnation's lock file goes only when no claim names it.
        for incarnation in dead.difference(&referenced) {
            let _ = std::fs::remove_file(
                self.location
                    .directory
                    .join(OWNERS)
                    .join(format!("{incarnation}.lock")),
            );
        }
        Ok(())
    }

    fn unavailable(blocked: &Blocked) -> anyhow::Error {
        HostResourcesUnavailable(blocked.message()).into()
    }

    /// Takes a claim. Shared use starts `active`; lifecycle claims start
    /// `reserved` and must be advanced before their effect.
    pub fn acquire(
        &self,
        target: Target,
        mode: ClaimMode,
        purpose: ClaimPurpose,
        operation_id: Option<&str>,
    ) -> Result<String> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let (path, key) = resolve(&open.host, &target)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        self.sweep_in(&tx)?;
        for held in read_claims(&tx)? {
            if superseded_by(
                &held,
                &key,
                purpose,
                &self.location.profile,
                &self.incarnation,
            ) {
                tx.execute("DELETE FROM claims WHERE id=?1", [&held.id])?;
                continue;
            }
            if conflicts((&held.key, held.mode), (&key, mode)) {
                let whose = if held.owner_profile == self.location.profile {
                    "this profile".to_owned()
                } else {
                    format!("profile {}", held.owner_profile)
                };
                return Err(HostResourceConflict(format!(
                    "{path} conflicts with the {state} {mode} {purpose} claim on {held_path} held by {whose} (claim {id}). Inspect it with resources.inspect before retrying.",
                    state = label(&held.state),
                    mode = label(&held.mode),
                    purpose = label(&held.purpose),
                    held_path = held.path,
                    id = held.id,
                ))
                .into());
            }
        }
        let now = now_ms();
        let claim = Claim {
            id: new_id("claim"),
            key,
            path,
            mode,
            purpose,
            phase: if purpose == ClaimPurpose::Use {
                ClaimPhase::Active
            } else {
                ClaimPhase::Reserved
            },
            state: ClaimState::Active,
            owner_profile: self.location.profile.clone(),
            owner_incarnation: self.incarnation.clone(),
            owner_pid: std::process::id(),
            operation_id: operation_id.map(str::to_owned),
            reason: None,
            created_at: now,
            updated_at: now,
        };
        write_claim(&tx, &claim)?;
        tx.commit()?;
        Ok(claim.id)
    }

    /// Runs `change` on one of this incarnation's claims and commits it.
    fn update(&self, id: &str, change: impl FnOnce(&mut Claim) -> Result<()>) -> Result<()> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let mut claim = read_claim(&tx, id)?;
        ensure!(
            claim.owner_incarnation == self.incarnation,
            "Claim {id} belongs to another daemon incarnation"
        );
        change(&mut claim)?;
        claim.updated_at = now_ms();
        write_claim(&tx, &claim)?;
        tx.commit()?;
        Ok(())
    }

    /// Commits `dispatched` before the effect starts. An error here must stop
    /// the effect.
    pub fn dispatch(&self, id: &str) -> Result<()> {
        self.update(id, |claim| {
            ensure!(
                claim.state == ClaimState::Active && claim.phase == ClaimPhase::Reserved,
                "Claim {} is not a live reservation",
                claim.id
            );
            claim.phase = ClaimPhase::Dispatched;
            Ok(())
        })
    }

    /// Binds an unborn reservation to the identity of the path now created.
    /// The created directory must sit in the reserved parent under the
    /// reserved name.
    pub fn bind_created(&self, id: &str, created: &Path) -> Result<()> {
        let created = std::fs::canonicalize(created)?;
        let identity = chain(&created)?;
        let name = created
            .file_name()
            .and_then(|name| name.to_str())
            .map(fold_name);
        self.update(id, |claim| {
            ensure!(
                claim.key.unborn.is_some()
                    && claim.key.unborn == name
                    && identity.get(1..) == Some(claim.key.chain.as_slice()),
                "Created path is not the reserved path"
            );
            claim.key.chain = identity;
            claim.key.unborn = None;
            claim.path = created.to_string_lossy().into_owned();
            claim.phase = ClaimPhase::Bound;
            Ok(())
        })
    }

    /// Quarantines one of this incarnation's claims.
    pub fn quarantine(&self, id: &str, reason: &str) -> Result<()> {
        self.update(id, |claim| {
            claim.state = ClaimState::Quarantined;
            claim.reason = Some(reason.into());
            Ok(())
        })
    }

    /// Releases one of this incarnation's active claims.
    pub fn release(&self, id: &str) -> Result<()> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let claim = read_claim(&tx, id)?;
        ensure!(
            claim.owner_incarnation == self.incarnation && claim.state == ClaimState::Active,
            "Claim {id} is not an active claim of this daemon"
        );
        tx.execute("DELETE FROM claims WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Settles a lifecycle claim; a failure leaves the claim in place.
    pub fn settle(&self, id: &str, settlement: Settlement) {
        let result = match settlement {
            Settlement::Release => self.release(id),
            Settlement::Quarantine(reason) => self.quarantine(id, reason),
        };
        if let Err(error) = result {
            eprintln!("Host resource claim {id} could not settle: {error}");
        }
    }

    /// The registry status and its claims, optionally narrowed to one path.
    pub fn inspect(&self, path: Option<&str>) -> Result<HostResourcesState> {
        let _ = self.sweep();
        let guard = self.inner.lock().unwrap();
        let (host, blocked, claims) = match &*guard {
            Ok(open) => (Some(open.host.clone()), None, read_claims(&open.db)?),
            Err(blocked) => (None, Some(blocked.message()), Vec::new()),
        };
        let filter = match (path, &host) {
            (Some(path), Some(host)) => {
                let path = Path::new(path);
                let target = if std::fs::symlink_metadata(path).is_ok() {
                    Target::Existing(path)
                } else {
                    Target::Unborn(path)
                };
                Some(resolve(host, &target)?.1)
            }
            _ => None,
        };
        let claims = claims
            .into_iter()
            .filter(|claim| {
                filter
                    .as_ref()
                    .is_none_or(|key| key.within(&claim.key) || claim.key.within(key))
            })
            .map(|claim| self.view(claim))
            .collect();
        Ok(HostResourcesState {
            tag: Default::default(),
            registry: RegistryStatus {
                path: self.path().to_string_lossy().into_owned(),
                scope: self.location.scope,
                host_id: host,
                state: if blocked.is_some() {
                    RegistryState::Blocked
                } else {
                    RegistryState::Ready
                },
                reason: blocked,
            },
            profile: self.location.profile.clone(),
            incarnation: self.incarnation.clone(),
            claims,
        })
    }

    fn view(&self, claim: Claim) -> ResourceClaim {
        let identity = claim.key.chain.first().cloned().unwrap_or(Node {
            device: String::new(),
            inode: String::new(),
            generation: String::new(),
        });
        ResourceClaim {
            owner_live: self.live(&claim.owner_incarnation),
            mine: claim.owner_incarnation == self.incarnation,
            id: claim.id,
            host_id: claim.key.host,
            path: claim.path,
            device: identity.device,
            inode: identity.inode,
            generation: identity.generation,
            unborn_name: claim.key.unborn,
            mode: claim.mode,
            purpose: claim.purpose,
            phase: claim.phase,
            state: claim.state,
            owner_profile: claim.owner_profile,
            owner_incarnation: claim.owner_incarnation,
            owner_pid: claim.owner_pid,
            operation_id: claim.operation_id,
            reason: claim.reason,
            created_at: claim.created_at,
            updated_at: claim.updated_at,
        }
    }

    /// `resources.claim.resolve`: an effect command whose receipt lives in
    /// the registry that owns the claim.
    pub fn resolve_claim(&self, request: &ResourcesClaimResolveRequest) -> Result<Value> {
        let payload = serde_json::to_value(request)?;
        {
            let guard = self.inner.lock().unwrap();
            let open = guard.as_ref().map_err(Self::unavailable)?;
            let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
            match receipts::begin(
                &tx,
                &request.operation_id,
                "resources.claim.resolve",
                &payload,
                None,
                now_ms(),
            )? {
                Admission::New => {}
                Admission::Replay(_) => {
                    drop(tx);
                    drop(guard);
                    return Ok(serde_json::to_value(self.inspect(None)?)?);
                }
                Admission::Conflict => {
                    bail!("Operation ID was already used for different parameters")
                }
                Admission::Expired => {
                    bail!("Operation ID is past its 30-day receipt retention; use a new ID")
                }
            }
            let claim = read_claim(&tx, &request.claim_id)?;
            may_resolve(&claim, &request.confirm_path)?;
            tx.execute("DELETE FROM claims WHERE id=?1", [&claim.id])?;
            receipts::settle(
                &tx,
                &request.operation_id,
                Status::Settled,
                Some(&json!({"resolved": claim.id})),
                now_ms(),
            )?;
            tx.commit()?;
        }
        Ok(serde_json::to_value(self.inspect(None)?)?)
    }

    /// `resources.registry.accept`: binds this profile to the registry on
    /// disk, creating one when it is missing and moving an unreadable one
    /// aside. The receipt lives in the profile database that owns the
    /// binding. Returns whether the daemon now uses a different registry, so
    /// its live claims must be taken again.
    pub fn accept(
        &self,
        profile_db: &Connection,
        request: &ResourcesRegistryAcceptRequest,
    ) -> Result<bool> {
        let registry = self.path();
        ensure!(
            request.confirm_registry == registry.to_string_lossy(),
            "confirm_registry must equal the registry path from resources.inspect"
        );
        let payload = serde_json::to_value(request)?;
        let tx = Transaction::new_unchecked(profile_db, TransactionBehavior::Immediate)?;
        match receipts::begin(
            &tx,
            &request.operation_id,
            "resources.registry.accept",
            &payload,
            None,
            now_ms(),
        )? {
            Admission::New => {}
            Admission::Replay(_) => return Ok(false),
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new ID")
            }
        }
        let mut guard = self.inner.lock().unwrap();
        let mut rebound = false;
        let blocked = match &*guard {
            Ok(_) => None,
            Err(blocked) => Some(blocked.clone()),
        };
        if let Some(blocked) = blocked {
            if let Blocked::Unsupported(_) = blocked {
                return Err(Self::unavailable(&blocked));
            }
            let aside = matches!(blocked, Blocked::Unreadable(_))
                .then(|| format!("unreadable-{}", now_ms()));
            let opened = open_registry(&self.location, &self.incarnation, None, aside.as_deref())?;
            match &opened {
                Ok(open) => bind(&tx, &open.host, &self.location.directory)?,
                Err(still) => return Err(Self::unavailable(still)),
            }
            *guard = opened;
            rebound = true;
        }
        receipts::settle(
            &tx,
            &request.operation_id,
            Status::Settled,
            Some(&json!({"ready": guard.is_ok()})),
            now_ms(),
        )?;
        tx.commit()?;
        Ok(rebound)
    }
}

fn label<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
        .replace('_', " ")
}

/// Opens or creates the registry under the host-wide init lock. `bound` is
/// the host ID the profile last used; `None` accepts whatever is on disk.
/// `aside` moves an unreadable file (and its journal files) to that suffix
/// before creating a new registry; files are never deleted.
fn open_registry(
    location: &Location,
    incarnation: &str,
    bound: Option<&str>,
    aside: Option<&str>,
) -> Result<std::result::Result<Open, Blocked>> {
    std::fs::create_dir_all(&location.directory)?;
    let init = lock_file(&location.directory.join(INIT_LOCK))?;
    ensure!(
        flock(&init, libc::LOCK_EX),
        "Cannot lock the host resource registry"
    );
    let path = location.directory.join(REGISTRY_FILE);
    if let Some(suffix) = aside {
        for extension in ["", "-wal", "-shm"] {
            let from = PathBuf::from(format!("{}{extension}", path.display()));
            if std::fs::symlink_metadata(&from).is_ok() {
                std::fs::rename(&from, format!("{}.{suffix}{extension}", path.display()))?;
            }
        }
    }
    let metadata = std::fs::symlink_metadata(&path).ok();
    if metadata.as_ref().is_some_and(|m| !m.file_type().is_file()) {
        return Ok(Err(Blocked::Unreadable("not a regular file".into())));
    }
    let db = match opening(metadata.is_some(), bound) {
        Opening::Refuse(blocked) => return Ok(Err(blocked)),
        Opening::Create => {
            let db = Connection::open(&path)?;
            std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            configure(&db)?;
            let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
            tx.execute_batch(REGISTRY_SCHEMA)?;
            tx.execute(
                "INSERT OR IGNORE INTO registry(key,value) VALUES('host_id',?1),('format',?2)",
                params![new_id("host"), FORMAT],
            )?;
            tx.commit()?;
            db
        }
        Opening::Open => {
            let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
            let db = match Connection::open_with_flags(&path, flags) {
                Ok(db) => db,
                Err(error) => return Ok(Err(Blocked::Unreadable(sqlite_detail(&error)))),
            };
            let checked = (|| -> rusqlite::Result<(String, Option<String>, Option<String>)> {
                configure(&db)?;
                let integrity: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
                let meta = |key: &str| {
                    db.query_row("SELECT value FROM registry WHERE key=?1", [key], |row| {
                        row.get::<_, String>(0)
                    })
                    .optional()
                };
                Ok((integrity, meta("format")?, meta("host_id")?))
            })();
            let (integrity, format, host) = match checked {
                Ok(values) => values,
                Err(error) => return Ok(Err(Blocked::Unreadable(sqlite_detail(&error)))),
            };
            if let Err(blocked) = verify(&integrity, format.as_deref(), host.as_deref(), bound) {
                return Ok(Err(blocked));
            }
            db.execute_batch(REGISTRY_SCHEMA)?;
            db
        }
    };
    receipts::ensure(&db)?;
    let host: String = db.query_row(
        "SELECT value FROM registry WHERE key='host_id'",
        [],
        |row| row.get(0),
    )?;
    let owners = location.directory.join(OWNERS);
    std::fs::create_dir_all(&owners)?;
    let owner = lock_file(&owners.join(format!("{incarnation}.lock")))?;
    ensure!(
        flock(&owner, libc::LOCK_EX | libc::LOCK_NB),
        "Host resource incarnation lock is already held"
    );
    flock(&init, libc::LOCK_UN);
    Ok(Ok(Open {
        db,
        host,
        _owner: owner,
    }))
}

fn configure(db: &Connection) -> rusqlite::Result<()> {
    db.busy_timeout(Duration::from_secs(5))?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

/// A short SQLite failure category without file contents.
fn sqlite_detail(error: &rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(code) => format!("{code:?}"),
        None => "invalid registry schema".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(value: &str) -> Node {
        Node {
            device: "1".into(),
            inode: value.into(),
            generation: "7".into(),
        }
    }

    /// `path` lists identities from the resource up to the root.
    fn key(path: &[&str]) -> Key {
        Key {
            host: "host".into(),
            chain: path.iter().map(|inode| n(inode)).collect(),
            unborn: None,
        }
    }

    fn unborn(name: &str, parent: &[&str]) -> Key {
        Key {
            unborn: Some(fold_name(name)),
            ..key(parent)
        }
    }

    use ClaimMode::{Exclusive, Shared};

    #[test]
    fn shared_use_admits_shared_use_and_refuses_lifecycle_on_or_around_it() {
        let tree = key(&["tree", "work", "root"]);
        let inside = key(&["src", "tree", "work", "root"]);
        let sibling = key(&["other", "work", "root"]);
        assert!(!conflicts((&tree, Shared), (&tree, Shared)));
        assert!(conflicts((&tree, Shared), (&tree, Exclusive)));
        assert!(conflicts((&inside, Shared), (&tree, Exclusive)));
        assert!(conflicts((&tree, Exclusive), (&inside, Shared)));
        assert!(!conflicts((&sibling, Shared), (&tree, Exclusive)));
        // Using the parent directory does not own a child's lifecycle.
        let parent = key(&["work", "root"]);
        assert!(!conflicts((&parent, Shared), (&tree, Exclusive)));
        assert!(!conflicts((&tree, Exclusive), (&parent, Shared)));
    }

    #[test]
    fn exclusive_claims_refuse_nested_lifecycle_both_ways() {
        let tree = key(&["tree", "work", "root"]);
        let inside = key(&["src", "tree", "work", "root"]);
        assert!(conflicts((&tree, Exclusive), (&tree, Exclusive)));
        assert!(conflicts((&tree, Exclusive), (&inside, Exclusive)));
        assert!(conflicts((&inside, Exclusive), (&tree, Exclusive)));
        let parent = key(&["work", "root"]);
        assert!(conflicts((&parent, Exclusive), (&tree, Exclusive)));
    }

    #[test]
    fn identity_not_path_decides_and_a_replacement_is_a_new_resource() {
        let original = key(&["tree", "work", "root"]);
        let mut replaced = original.clone();
        replaced.chain[0].generation = "8".into();
        assert!(!conflicts((&original, Shared), (&replaced, Exclusive)));
        let mut other_host = original.clone();
        other_host.host = "elsewhere".into();
        assert!(!conflicts((&original, Shared), (&other_host, Exclusive)));
    }

    #[test]
    fn unborn_reservations_collide_by_parent_and_folded_name() {
        let a = unborn("Feature", &["work", "root"]);
        let b = unborn("feature", &["work", "root"]);
        let c = unborn("feature", &["elsewhere", "root"]);
        let d = unborn("other", &["work", "root"]);
        assert!(conflicts((&a, Exclusive), (&b, Exclusive)));
        assert!(!conflicts((&a, Exclusive), (&c, Exclusive)));
        assert!(!conflicts((&a, Exclusive), (&d, Exclusive)));
        // Removing an ancestor of the reserved path refuses the creation.
        let work = key(&["work", "root"]);
        assert!(conflicts((&work, Exclusive), (&a, Exclusive)));
        assert!(!conflicts((&work, Shared), (&a, Exclusive)));
    }

    #[test]
    fn owner_loss_releases_only_reservations_that_never_started() {
        use ClaimPhase::*;
        assert_eq!(
            on_owner_lost(Reserved, ClaimState::Active),
            OwnerLoss::Release
        );
        assert_eq!(
            on_owner_lost(Dispatched, ClaimState::Active),
            OwnerLoss::Quarantine("outcome_unknown")
        );
        assert_eq!(
            on_owner_lost(Bound, ClaimState::Active),
            OwnerLoss::Quarantine("outcome_unknown")
        );
        assert_eq!(
            on_owner_lost(Active, ClaimState::Active),
            OwnerLoss::Quarantine("owner_lost_during_use")
        );
        for phase in [Reserved, Dispatched, Bound, Active] {
            assert_eq!(
                on_owner_lost(phase, ClaimState::Quarantined),
                OwnerLoss::Keep
            );
        }
    }

    #[test]
    fn lifecycle_settles_by_evidence_not_by_command_status() {
        assert_eq!(settle_lifecycle(false, false), Settlement::Release);
        assert_eq!(settle_lifecycle(true, true), Settlement::Release);
        assert_eq!(
            settle_lifecycle(true, false),
            Settlement::Quarantine("outcome_unknown")
        );
    }

    fn claim(state: ClaimState, purpose: ClaimPurpose, incarnation: &str) -> Claim {
        Claim {
            id: "claim_1".into(),
            key: key(&["tree", "root"]),
            path: "/w/tree".into(),
            mode: Shared,
            purpose,
            phase: ClaimPhase::Active,
            state,
            owner_profile: "p".into(),
            owner_incarnation: incarnation.into(),
            owner_pid: 1,
            operation_id: None,
            reason: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn only_this_profiles_own_quarantined_use_of_the_same_key_is_superseded() {
        let same = key(&["tree", "root"]);
        let use_ = ClaimPurpose::Use;
        let old = claim(ClaimState::Quarantined, use_, "old");
        assert!(superseded_by(&old, &same, use_, "p", "new"));
        assert!(!superseded_by(&old, &same, use_, "other", "new"));
        assert!(!superseded_by(&old, &same, use_, "p", "old"));
        assert!(!superseded_by(
            &old,
            &same,
            ClaimPurpose::Remove,
            "p",
            "new"
        ));
        assert!(!superseded_by(
            &old,
            &key(&["other", "root"]),
            use_,
            "p",
            "new"
        ));
        let active = claim(ClaimState::Active, use_, "old");
        assert!(!superseded_by(&active, &same, use_, "p", "new"));
        let removal = claim(ClaimState::Quarantined, ClaimPurpose::Remove, "old");
        assert!(!superseded_by(&removal, &same, use_, "p", "new"));
    }

    #[test]
    fn explicit_resolution_needs_quarantine_and_the_recorded_path() {
        let active = claim(ClaimState::Active, ClaimPurpose::Use, "i");
        assert!(may_resolve(&active, "/w/tree").is_err());
        let quarantined = claim(ClaimState::Quarantined, ClaimPurpose::Use, "i");
        assert!(may_resolve(&quarantined, "/w/other").is_err());
        assert!(may_resolve(&quarantined, "/w/tree").is_ok());
    }

    #[test]
    fn a_bound_profile_never_creates_a_replacement_registry() {
        assert_eq!(opening(false, None), Opening::Create);
        assert_eq!(opening(true, None), Opening::Open);
        assert_eq!(opening(true, Some("h")), Opening::Open);
        assert_eq!(opening(false, Some("h")), Opening::Refuse(Blocked::Missing));
    }

    #[test]
    fn corruption_or_replacement_blocks_instead_of_forgetting_owners() {
        assert_eq!(verify("ok", Some("1"), Some("h"), Some("h")), Ok(()));
        assert_eq!(verify("ok", Some("1"), Some("h"), None), Ok(()));
        assert!(matches!(
            verify("*** page 3 corrupt", Some("1"), Some("h"), Some("h")),
            Err(Blocked::Unreadable(_))
        ));
        assert!(matches!(
            verify("ok", Some("1"), None, None),
            Err(Blocked::Unreadable(_))
        ));
        assert_eq!(
            verify("ok", Some("1"), Some("new"), Some("old")),
            Err(Blocked::Replaced {
                bound: "old".into(),
                found: "new".into()
            })
        );
        assert_eq!(
            verify("ok", Some("2"), Some("h"), Some("h")),
            Err(Blocked::Unsupported("2".into()))
        );
    }

    #[test]
    fn managed_profiles_share_the_profiles_home_and_others_stay_private() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let runtime = PathBuf::from(format!("/h/profiles-v2/profiles/{id}/runtime"));
        let private = Path::new("/h/data/sessions.worktrees");
        assert_eq!(
            locate(None, Some(&runtime), private),
            Location {
                directory: "/h/profiles-v2".into(),
                scope: RegistryScope::Host,
                profile: id.into(),
            }
        );
        let loose = locate(None, Some(Path::new("/tmp/x/runtime")), private);
        assert_eq!(loose.scope, RegistryScope::Profile);
        assert_eq!(loose.directory, private);
        let not_uuid = locate(None, Some(Path::new("/h/profiles/abc/runtime")), private);
        assert_eq!(not_uuid.scope, RegistryScope::Profile);
        let explicit = locate(Some(Path::new("/shared")), None, private);
        assert_eq!(explicit.scope, RegistryScope::Host);
        assert_eq!(explicit.directory, PathBuf::from("/shared"));
        assert_eq!(explicit.profile, format!("path:{}", private.display()));
    }
}
