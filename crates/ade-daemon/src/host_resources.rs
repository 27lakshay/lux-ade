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
//! Beyond checkouts, the registry holds two more kinds of claim, stored in the
//! same table with an empty identity chain (which older daemons read as a key
//! that nests with nothing):
//! - A service port. A service run reserves each assigned TCP port before
//!   launch, commits `dispatched` before the launch, binds the claim to the
//!   listener once the run's own process tree is verified listening, and
//!   releases it only after a verified stop that also observes no listener
//!   left on the port.
//! - A device. Each device effect (boot, install, launch) holds its simulator
//!   or emulator exclusively for the effect and settles by its receipt: an
//!   effect whose outcome is unknown leaves the claim quarantined. A run can
//!   also hold a device for longer with `resources.device.hold`.
//!
//! The registry is local cooperation between ADE daemons. External programs
//! that ignore it remain outside the guarantee.
use crate::model::{new_id, now_ms};
use crate::receipts::{self, Admission, Status};
use ade_core::contract::resources::{
    ClaimMode, ClaimPhase, ClaimPurpose, ClaimState, HostResourcesState, RegistryScope,
    RegistryState, RegistryStatus, ResourceClaim, ResourceKind, ResourcesClaimResolveRequest,
    ResourcesDeviceHoldRequest, ResourcesDeviceReleaseRequest, ResourcesRegistryAcceptRequest,
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

/// Whether an existing path, whose final components from the resource
/// upward are `names`, was created at an unborn reservation `outer` that is
/// not yet bound: some ancestor-or-self of the path sits in the reserved
/// parent under the reserved folded name. Between Git creating the path and
/// the reservation binding to it, [`Key::within`] cannot see this, because
/// the created directory's identity is not in the reservation yet.
pub fn born_inside_unborn(key: &Key, names: &[String], outer: &Key) -> bool {
    let Some(reserved) = &outer.unborn else {
        return false;
    };
    key.host == outer.host
        && key.unborn.is_none()
        && (0..key.chain.len()).any(|index| {
            key.chain[index + 1..] == outer.chain[..]
                && names.get(index).map(|name| fold_name(name)).as_ref() == Some(reserved)
        })
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

/// A lease's shared-use claim from an earlier incarnation of this profile is
/// superseded when the profile's own reconciliation leases the same key
/// again: the checkout stays protected by the new claim throughout.
///
/// Only a lease claim qualifies: shared, with no operation ID, and
/// quarantined because its owner was lost while it was in use. A claim that
/// an effect (setup, carry, resources) holds under an operation ID records
/// that the effect's outcome is unknown, so only explicit resolution retires
/// it.
pub fn superseded_by(
    old: &Claim,
    key: &Key,
    mode: ClaimMode,
    purpose: ClaimPurpose,
    profile: &str,
    incarnation: &str,
) -> bool {
    purpose == ClaimPurpose::Use
        && mode == ClaimMode::Shared
        && old.mode == ClaimMode::Shared
        && old.operation_id.is_none()
        && old.reason.as_deref() == Some("owner_lost_during_use")
        && old.purpose == ClaimPurpose::Use
        && old.state == ClaimState::Quarantined
        && old.owner_profile == profile
        && old.owner_incarnation != incarnation
        && old.key == *key
}

/// What a claim is on. A checkout's identity is its [`Key`] chain; a port or
/// device claim carries its identity here and an empty chain.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resource {
    #[default]
    Checkout,
    /// A TCP port on this host, whatever the address.
    Port { port: u16 },
    /// A simulator or emulator by its ADE device ID.
    Device { device_id: String },
}

impl Resource {
    fn kind(&self) -> ResourceKind {
        match self {
            Self::Checkout => ResourceKind::Checkout,
            Self::Port { .. } => ResourceKind::Port,
            Self::Device { .. } => ResourceKind::Device,
        }
    }

    /// The value a claim records as its `path`, which resolution confirms.
    pub fn label(&self) -> Option<String> {
        match self {
            Self::Checkout => None,
            Self::Port { port } => Some(format!("tcp:{port}")),
            Self::Device { device_id } => Some(device_id.clone()),
        }
    }
}

/// A claim someone wants to take, as the compatibility decisions see it.
#[derive(Clone, Copy, Debug)]
pub struct Wanted<'a> {
    pub key: &'a Key,
    pub resource: &'a Resource,
    pub mode: ClaimMode,
    pub purpose: ClaimPurpose,
    pub holder: Option<&'a str>,
    pub operation_id: Option<&'a str>,
    pub profile: &'a str,
    pub incarnation: &'a str,
    /// The caller verified that nothing it manages uses the resource now: for
    /// a port, the profile's catalogue records no run of the holder and a
    /// bind probe found the port free.
    pub verified_idle: bool,
}

/// Two claims on one TCP port always conflict, whatever their mode, owner or
/// holder: a port has one listener set per host, and a second run that binds
/// it either fails or silently shares traffic. Quarantine does not weaken
/// this.
pub fn port_conflicts(held: u16, wanted: u16) -> bool {
    held == wanted
}

/// Whether a held device claim refuses a wanted one on the same device.
/// - A quarantined claim refuses everything until reconciled or resolved.
/// - Within one daemon incarnation, device effects are serialized in process,
///   and a run's hold admits this profile's own effects; only two different
///   runs' holds conflict.
/// - Across profiles or incarnations, anything but shared-with-shared
///   conflicts.
pub fn device_conflicts(held: &Claim, wanted: &Wanted) -> bool {
    if held.state == ClaimState::Quarantined {
        return true;
    }
    if held.owner_incarnation == wanted.incarnation {
        return match (held.holder.as_deref(), wanted.holder) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        };
    }
    !(held.mode == ClaimMode::Shared && wanted.mode == ClaimMode::Shared)
}

/// Whether a held claim refuses a wanted one, for every kind of resource.
/// Claims on different hosts or different kinds never conflict.
pub fn claim_conflicts(held: &Claim, wanted: &Wanted) -> bool {
    if held.key.host != wanted.key.host {
        return false;
    }
    match (&held.resource, wanted.resource) {
        (Resource::Checkout, Resource::Checkout) => {
            conflicts((&held.key, held.mode), (wanted.key, wanted.mode))
        }
        (Resource::Port { port: a }, Resource::Port { port: b }) => port_conflicts(*a, *b),
        (Resource::Device { device_id: a }, Resource::Device { device_id: b }) => {
            a == b && device_conflicts(held, wanted)
        }
        _ => false,
    }
}

/// Whether taking `wanted` is the reconciliation that retires a quarantined
/// claim of this profile, which the new claim then protects throughout.
/// - Checkout: [`superseded_by`].
/// - Port: the same holder (service run identity) takes the same port again
///   after verifying it idle. This also retires this daemon's own claim left
///   active when a verified stop could not settle it, since the catalogue
///   then records no run.
/// - Device: a replay of the same operation ID, whose receipt reconciliation
///   observes the device, or the same run's hold taken again.
pub fn supersedes(old: &Claim, wanted: &Wanted) -> bool {
    if old.owner_profile != wanted.profile || old.resource != *wanted.resource {
        return false;
    }
    let quarantined = old.state == ClaimState::Quarantined;
    let same = |a: Option<&str>, b: Option<&str>| a.is_some() && a == b;
    match wanted.resource {
        Resource::Checkout => superseded_by(
            old,
            wanted.key,
            wanted.mode,
            wanted.purpose,
            wanted.profile,
            wanted.incarnation,
        ),
        Resource::Port { .. } => {
            wanted.verified_idle
                && same(old.holder.as_deref(), wanted.holder)
                && (quarantined || old.owner_incarnation == wanted.incarnation)
        }
        Resource::Device { .. } => {
            quarantined
                && (same(old.operation_id.as_deref(), wanted.operation_id)
                    || (old.operation_id.is_none() && same(old.holder.as_deref(), wanted.holder)))
        }
    }
}

/// How a device effect's claim settles, from its receipt after the effect
/// returned. No receipt, or one never dispatched, means no effect started. A
/// settled receipt means the outcome was observed. Anything else (dispatched,
/// acknowledged, unknown) may still be changing the device.
pub fn settle_effect(receipt: Option<Status>) -> Settlement {
    match receipt {
        None | Some(Status::Accepted) | Some(Status::Settled) => Settlement::Release,
        Some(Status::Dispatched | Status::Acknowledged | Status::Unknown) => {
            Settlement::Quarantine("outcome_unknown")
        }
    }
}

/// How a service port claim settles after the service's run was verified
/// stopped. `listening` is the set of TCP ports observed listening on the host
/// afterwards, or `None` when observation failed. A listener left on the port
/// may be an escaped descendant of the run, so it is not proof of release.
pub fn settle_port_after_stop(port: u16, listening: Option<&[u16]>) -> Settlement {
    match listening {
        None => Settlement::Quarantine("listener_observation_unavailable"),
        Some(ports) if ports.contains(&port) => {
            Settlement::Quarantine("listener_remains_after_stop")
        }
        Some(_) => Settlement::Release,
    }
}

/// Whether this daemon may settle a claim for `holder` after verifying that
/// the holder stopped: the claim is this profile's, names the holder, and its
/// owning incarnation is this one or has lost its liveness lock.
pub fn settled_by_holder(
    claim: &Claim,
    holder: &str,
    profile: &str,
    incarnation: &str,
    owner_live: bool,
) -> bool {
    claim.owner_profile == profile
        && claim.holder.as_deref() == Some(holder)
        && (claim.owner_incarnation == incarnation || !owner_live)
}

/// The canonical claim identity for a device ID, so case variants of one
/// simulator collide. Displays are not claimed: they are observed, never
/// booted or installed to, and are not simulators or emulators.
pub fn device_claim_id(device_id: &str) -> Result<Option<String>> {
    let target = crate::devices::Target::parse(device_id)?;
    Ok(match target {
        crate::devices::Target::Display(_) => None,
        other => Some(other.id()),
    })
}

/// The phase a new claim starts in. A port claim is `reserved` until its
/// launch is dispatched, so losing the owner before launch releases it. A
/// device claim is taken immediately around its use, so it starts `active`
/// and owner loss quarantines it. Checkout use is `active`; checkout
/// lifecycle claims are `reserved`.
pub fn initial_phase(resource: &Resource, purpose: ClaimPurpose) -> ClaimPhase {
    match (resource, purpose) {
        (Resource::Port { .. }, _) => ClaimPhase::Reserved,
        (Resource::Device { .. }, _) | (Resource::Checkout, ClaimPurpose::Use) => {
            ClaimPhase::Active
        }
        (Resource::Checkout, _) => ClaimPhase::Reserved,
    }
}

/// A run identity or other holder: 1 to 128 printable ASCII characters.
pub fn valid_holder(holder: &str) -> bool {
    !holder.is_empty() && holder.len() <= 128 && holder.bytes().all(|b| b.is_ascii_graphic())
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

/// What `resources.registry.accept` did.
#[derive(Debug, PartialEq)]
pub enum AcceptOutcome {
    /// It ran; `rebound` says the daemon now uses a different registry.
    Ran { rebound: bool },
    /// The ID was accepted before; the reply it recorded, if any.
    Replayed(Option<Value>),
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

/// Whether an explicit accept may recover from `blocked`, given the other
/// daemon incarnations on this host that still hold their liveness locks.
///
/// A missing or unreadable registry is recovered by starting an empty one.
/// A live daemon may still hold claims in the old file through its open
/// connection, and an empty registry would forget them, so recovery waits
/// until no other incarnation is live. A newer registry is never replaced.
/// Retrying an open, or adopting a replacement that other daemons already
/// use, forgets nothing and is always allowed.
pub fn may_accept(blocked: &Blocked, live_others: &[String]) -> std::result::Result<(), String> {
    match blocked {
        Blocked::Unsupported(_) => Err(blocked.message()),
        Blocked::Missing | Blocked::Unreadable(_) if !live_others.is_empty() => Err(format!(
            "{} {} still live on this host and may hold claims in the old host resource registry (incarnations {}); an empty registry would forget them. Stop those profiles, then accept the registry again. ADE left it unchanged.",
            live_others.len(),
            if live_others.len() == 1 {
                "ADE daemon is"
            } else {
                "ADE daemons are"
            },
            live_others.join(", ")
        )),
        _ => Ok(()),
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
    /// Absent in claims written before ports and devices were claimable.
    #[serde(default)]
    pub resource: Resource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listener_pid: Option<u32>,
}

/// What a claim is taken on.
pub enum Target<'a> {
    /// An existing directory.
    Existing(&'a Path),
    /// A path that does not exist yet and will be created.
    Unborn(&'a Path),
}

/// A claim being taken: a checkout resolved from the filesystem, or a port
/// or device named by its identity.
enum Taking<'a> {
    Checkout(Target<'a>),
    Other(Resource),
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
/// Also returns, for an existing path, the final component of each node in
/// its chain (the root's is empty).
fn resolve(host: &str, target: &Target) -> Result<(String, Key, Vec<String>)> {
    let mut names = Vec::new();
    let (path, key) = match target {
        Target::Existing(path) => {
            let path = std::fs::canonicalize(path)?;
            ensure!(path.is_dir(), "Claimed path must be a directory");
            let key = Key {
                host: host.into(),
                chain: chain(&path)?,
                unborn: None,
            };
            names = path
                .ancestors()
                .map(|ancestor| {
                    ancestor
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default()
                })
                .collect();
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
    Ok((
        path.to_str().context("Path must be UTF-8")?.to_owned(),
        key,
        names,
    ))
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

    /// Other daemon incarnations whose liveness lock is still held, sorted.
    /// Lock files with names this module never writes are ignored.
    fn live_others(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.location.directory.join(OWNERS)) else {
            return Vec::new();
        };
        let mut live: Vec<String> = entries
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().into_string().ok()?;
                let incarnation = name.strip_suffix(".lock")?.to_owned();
                (incarnation != self.incarnation
                    && valid_incarnation(&incarnation)
                    && self.live(&incarnation))
                .then_some(incarnation)
            })
            .collect();
        live.sort();
        live
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

    /// Takes a checkout claim. Shared use starts `active`; lifecycle claims
    /// start `reserved` and must be advanced before their effect.
    pub fn acquire(
        &self,
        target: Target,
        mode: ClaimMode,
        purpose: ClaimPurpose,
        operation_id: Option<&str>,
    ) -> Result<String> {
        self.take(
            Taking::Checkout(target),
            mode,
            purpose,
            None,
            operation_id,
            false,
        )
    }

    /// Reserves a TCP port for a service run before launch. The claim starts
    /// `reserved`; commit [`HostResources::dispatch`] before the launch.
    /// `verified_idle` says the caller found no run of `holder` in its
    /// catalogue and the port free, which retires this profile's quarantined
    /// claim for the same holder and port.
    pub fn reserve_port(&self, port: u16, holder: &str, verified_idle: bool) -> Result<String> {
        self.take(
            Taking::Other(Resource::Port { port }),
            ClaimMode::Exclusive,
            ClaimPurpose::Use,
            Some(holder),
            None,
            verified_idle,
        )
    }

    /// Claims a device exclusively for one effect (`operation_id`) or one
    /// run's hold (`holder`). The claim starts `active`, so owner loss
    /// quarantines it. Repeating a hold for the same holder returns its claim.
    pub fn claim_device(
        &self,
        device_id: &str,
        holder: Option<&str>,
        operation_id: Option<&str>,
    ) -> Result<String> {
        self.take(
            Taking::Other(Resource::Device {
                device_id: device_id.into(),
            }),
            ClaimMode::Exclusive,
            ClaimPurpose::Use,
            holder,
            operation_id,
            false,
        )
    }

    fn take(
        &self,
        taking: Taking,
        mode: ClaimMode,
        purpose: ClaimPurpose,
        holder: Option<&str>,
        operation_id: Option<&str>,
        verified_idle: bool,
    ) -> Result<String> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let (path, key, resource, names) = match taking {
            Taking::Checkout(target) => {
                let (path, key, names) = resolve(&open.host, &target)?;
                (path, key, Resource::Checkout, names)
            }
            Taking::Other(resource) => {
                let key = Key {
                    host: open.host.clone(),
                    chain: Vec::new(),
                    unborn: None,
                };
                (
                    resource.label().unwrap_or_default(),
                    key,
                    resource,
                    Vec::new(),
                )
            }
        };
        let wanted = Wanted {
            key: &key,
            resource: &resource,
            mode,
            purpose,
            holder,
            operation_id,
            profile: &self.location.profile,
            incarnation: &self.incarnation,
            verified_idle,
        };
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        self.sweep_in(&tx)?;
        for held in read_claims(&tx)? {
            // A repeated hold by the same run converges on its claim.
            if matches!(resource, Resource::Device { .. })
                && holder.is_some()
                && held.holder.as_deref() == holder
                && held.resource == resource
                && held.owner_incarnation == self.incarnation
                && held.state == ClaimState::Active
                && operation_id.is_none()
                && held.operation_id.is_none()
            {
                return Ok(held.id);
            }
            if supersedes(&held, &wanted) {
                tx.execute("DELETE FROM claims WHERE id=?1", [&held.id])?;
                continue;
            }
            let unbound_create = held.resource == Resource::Checkout
                && held.mode == ClaimMode::Exclusive
                && born_inside_unborn(&key, &names, &held.key);
            if unbound_create || claim_conflicts(&held, &wanted) {
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
            phase: initial_phase(&resource, purpose),
            state: ClaimState::Active,
            owner_profile: self.location.profile.clone(),
            owner_incarnation: self.incarnation.clone(),
            owner_pid: std::process::id(),
            operation_id: operation_id.map(str::to_owned),
            reason: None,
            created_at: now,
            updated_at: now,
            resource,
            holder: holder.map(str::to_owned),
            listener_pid: None,
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

    /// Binds this incarnation's launched port claim for `holder` to the
    /// listener verified in the service's own process tree. Writes nothing
    /// when the claim is already bound to that listener.
    pub fn bind_listener(&self, holder: &str, port: u16, pid: u32) -> Result<()> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let mut changed = false;
        for mut claim in read_claims(&tx)? {
            if claim.owner_incarnation != self.incarnation
                || claim.holder.as_deref() != Some(holder)
                || claim.resource != (Resource::Port { port })
                || claim.state != ClaimState::Active
                || !matches!(claim.phase, ClaimPhase::Dispatched | ClaimPhase::Bound)
                || (claim.phase == ClaimPhase::Bound && claim.listener_pid == Some(pid))
            {
                continue;
            }
            claim.phase = ClaimPhase::Bound;
            claim.listener_pid = Some(pid);
            claim.updated_at = now_ms();
            write_claim(&tx, &claim)?;
            changed = true;
        }
        if changed {
            tx.commit()?;
        }
        Ok(())
    }

    /// Settles every claim `holder` has in this profile after the caller
    /// verified that the holder stopped. `decide` returns the settlement for
    /// one claim, or `None` to leave it. Claims of an earlier incarnation are
    /// included only once it lost its liveness lock ([`settled_by_holder`]).
    /// Returns how many claims were released.
    pub fn settle_holder(
        &self,
        holder: &str,
        decide: impl Fn(&Claim) -> Option<Settlement>,
    ) -> Result<usize> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let mut released = 0;
        for mut claim in read_claims(&tx)? {
            let owner_live = self.live(&claim.owner_incarnation);
            if !settled_by_holder(
                &claim,
                holder,
                &self.location.profile,
                &self.incarnation,
                owner_live,
            ) {
                continue;
            }
            match decide(&claim) {
                None => {}
                Some(Settlement::Release) => {
                    tx.execute("DELETE FROM claims WHERE id=?1", [&claim.id])?;
                    released += 1;
                }
                Some(Settlement::Quarantine(reason)) => {
                    claim.state = ClaimState::Quarantined;
                    claim.reason = Some(reason.into());
                    claim.updated_at = now_ms();
                    write_claim(&tx, &claim)?;
                }
            }
        }
        tx.commit()?;
        Ok(released)
    }

    /// `resources.device.hold` and `resources.device.release`.
    pub fn device_command(&self, op: &str, request: &Value) -> Result<HostResourcesState> {
        match op {
            "resources.device.hold" => {
                let hold: ResourcesDeviceHoldRequest = serde_json::from_value(request.clone())?;
                ensure!(
                    valid_holder(&hold.holder),
                    "holder must be 1 to 128 printable ASCII characters"
                );
                let device = device_claim_id(&hold.device_id)?.context(
                    "Displays are observed, not held; hold a simulator, emulator or Android device",
                )?;
                self.claim_device(&device, Some(&hold.holder), None)?;
            }
            "resources.device.release" => {
                let release: ResourcesDeviceReleaseRequest =
                    serde_json::from_value(request.clone())?;
                ensure!(
                    valid_holder(&release.holder),
                    "holder must be 1 to 128 printable ASCII characters"
                );
                let device = device_claim_id(&release.device_id)?
                    .context("Displays are observed, not held")?;
                self.release_hold(&device, &release.holder)?;
            }
            _ => bail!("Unknown resources operation"),
        }
        self.inspect_kind(None, Some(ResourceKind::Device))
    }

    /// Releases this incarnation's active hold. A quarantined hold of this
    /// profile for the same run is refused rather than reported released.
    fn release_hold(&self, device_id: &str, holder: &str) -> Result<()> {
        let guard = self.inner.lock().unwrap();
        let open = guard.as_ref().map_err(Self::unavailable)?;
        let tx = Transaction::new_unchecked(&open.db, TransactionBehavior::Immediate)?;
        let resource = Resource::Device {
            device_id: device_id.into(),
        };
        for claim in read_claims(&tx)? {
            if claim.resource != resource
                || claim.holder.as_deref() != Some(holder)
                || claim.operation_id.is_some()
                || claim.owner_profile != self.location.profile
            {
                continue;
            }
            ensure!(
                claim.state == ClaimState::Active && claim.owner_incarnation == self.incarnation,
                "The hold on {device_id} for {holder} is quarantined ({}); inspect the device, then release it with resources.claim.resolve (claim {})",
                claim.reason.as_deref().unwrap_or("owner lost"),
                claim.id
            );
            tx.execute("DELETE FROM claims WHERE id=?1", [&claim.id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The registry status and its claims, optionally narrowed to one path.
    pub fn inspect(&self, path: Option<&str>) -> Result<HostResourcesState> {
        self.inspect_kind(path, None)
    }

    /// The registry status and its claims, optionally narrowed to one
    /// checkout path and to one kind of resource.
    pub fn inspect_kind(
        &self,
        path: Option<&str>,
        kind: Option<ResourceKind>,
    ) -> Result<HostResourcesState> {
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
                kind.is_none_or(|kind| claim.resource.kind() == kind)
                    && filter.as_ref().is_none_or(|key| {
                        claim.resource == Resource::Checkout
                            && (key.within(&claim.key) || claim.key.within(key))
                    })
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
        let (port, device_id) = match &claim.resource {
            Resource::Checkout => (None, None),
            Resource::Port { port } => (Some(*port), None),
            Resource::Device { device_id } => (None, Some(device_id.clone())),
        };
        ResourceClaim {
            owner_live: self.live(&claim.owner_incarnation),
            mine: claim.owner_incarnation == self.incarnation,
            id: claim.id,
            host_id: claim.key.host,
            resource: claim.resource.kind(),
            path: claim.path,
            port,
            device_id,
            holder: claim.holder,
            listener_pid: claim.listener_pid,
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
                Admission::Replay(receipt) => {
                    drop(tx);
                    drop(guard);
                    // R002: the recorded reply, not the registry as it reads now.
                    if let Some(reply) = receipts::recorded_reply(&receipt) {
                        return Ok(reply);
                    }
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
            // The claim is gone once this commits; the reply is recorded next.
            receipts::settle(
                &tx,
                &request.operation_id,
                Status::Acknowledged,
                Some(&json!({"resolved": claim.id})),
                now_ms(),
            )?;
            tx.commit()?;
        }
        let reply = serde_json::to_value(self.inspect(None)?)?;
        let guard = self.inner.lock().unwrap();
        if let Ok(open) = guard.as_ref() {
            let recorded = receipts::settle(
                &open.db,
                &request.operation_id,
                Status::Settled,
                Some(&json!({"reply": reply})),
                now_ms(),
            );
            if let Err(error) = recorded {
                tracing::warn!(
                    "The reply to {} was not recorded: {error:#}",
                    request.operation_id
                );
            }
        }
        Ok(reply)
    }

    /// Records the reply of an accept that ran, so a retry returns it.
    pub fn record_accept_reply(profile_db: &Connection, operation_id: &str, reply: &Value) {
        let recorded = receipts::settle(
            profile_db,
            operation_id,
            Status::Settled,
            Some(&json!({"reply": reply})),
            now_ms(),
        );
        if let Err(error) = recorded {
            tracing::warn!("The reply to {operation_id} was not recorded: {error:#}");
        }
    }

    /// `resources.registry.accept`: binds this profile to the registry on
    /// disk, creating one when it is missing and moving an unreadable one
    /// aside. The receipt lives in the profile database that owns the
    /// binding. Returns whether the daemon now uses a different registry, so
    /// its live claims must be taken again. The caller records its reply with
    /// [`Self::record_accept_reply`].
    pub fn accept(
        &self,
        profile_db: &Connection,
        request: &ResourcesRegistryAcceptRequest,
    ) -> Result<AcceptOutcome> {
        let registry = self.path();
        let payload = serde_json::to_value(request)?;
        let tx = Transaction::new_unchecked(profile_db, TransactionBehavior::Immediate)?;
        // The receipt is read first, so a reused ID with another payload is a
        // conflict even when that payload would also fail validation.
        match receipts::begin(
            &tx,
            &request.operation_id,
            "resources.registry.accept",
            &payload,
            None,
            now_ms(),
        )? {
            Admission::New => {}
            Admission::Replay(receipt) => {
                return Ok(AcceptOutcome::Replayed(receipts::recorded_reply(&receipt)));
            }
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new ID")
            }
        }
        // Returning an error drops the transaction, so a refusal records nothing.
        ensure!(
            request.confirm_registry == registry.to_string_lossy(),
            "confirm_registry must equal the registry path from resources.inspect"
        );
        let mut guard = self.inner.lock().unwrap();
        let mut rebound = false;
        let blocked = match &*guard {
            Ok(_) => None,
            Err(blocked) => Some(blocked.clone()),
        };
        if let Some(blocked) = blocked {
            if let Err(refusal) = may_accept(&blocked, &self.live_others()) {
                return Err(HostResourcesUnavailable(refusal).into());
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
            Status::Acknowledged,
            Some(&json!({"ready": guard.is_ok()})),
            now_ms(),
        )?;
        tx.commit()?;
        Ok(AcceptOutcome::Ran { rebound })
    }
}

/// The holder name of a service run's port claims. The service identity
/// changes when a service is removed and defined again, so a new definition
/// never inherits an old one's claims.
pub fn service_holder(workspace_id: &str, name: &str, identity: &str) -> String {
    format!("service:{workspace_id}/{name}#{identity}")
}

/// A service run's port claims from reservation through launch. Dropped
/// before [`PortReservation::launched`], it settles by [`settle_lifecycle`]:
/// released when the launch was never dispatched, quarantined when it was.
pub struct PortReservation<'a> {
    resources: &'a HostResources,
    claims: Vec<String>,
    dispatched: bool,
    launched: bool,
}

impl<'a> PortReservation<'a> {
    /// Reserves every port, or none: a conflict releases what was taken.
    pub fn reserve(
        resources: &'a HostResources,
        ports: impl IntoIterator<Item = u16>,
        holder: &str,
        verified_idle: bool,
    ) -> Result<Self> {
        let mut reservation = Self {
            resources,
            claims: Vec::new(),
            dispatched: false,
            launched: false,
        };
        let ports: std::collections::BTreeSet<u16> = ports.into_iter().collect();
        for port in ports {
            let claim = resources.reserve_port(port, holder, verified_idle)?;
            reservation.claims.push(claim);
        }
        Ok(reservation)
    }

    /// Commits `dispatched` on every claim. An error means the launch must
    /// not start; the claims are then released on drop.
    pub fn dispatch(&mut self) -> Result<()> {
        for claim in &self.claims {
            self.resources.dispatch(claim)?;
        }
        self.dispatched = true;
        Ok(())
    }

    /// The runtime accepted the launch. The claims stay `dispatched` until
    /// a listener is verified, and are released by a verified stop.
    pub fn launched(mut self) {
        self.launched = true;
    }
}

impl Drop for PortReservation<'_> {
    fn drop(&mut self) {
        if self.launched {
            return;
        }
        let settlement = settle_lifecycle(self.dispatched, false);
        for claim in &self.claims {
            self.resources.settle(claim, settlement);
        }
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
    fn a_path_created_at_an_unbound_reservation_is_inside_it() {
        let names = |list: &[&str]| {
            list.iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>()
        };
        let create = unborn("Feature", &["work", "root"]);
        // Git created work/feature; the Create claim is not bound yet, so
        // identity alone sees no conflict.
        let created = key(&["new", "work", "root"]);
        assert!(!conflicts((&create, Exclusive), (&created, Shared)));
        assert!(born_inside_unborn(
            &created,
            &names(&["feature", "work", ""]),
            &create
        ));
        let nested = key(&["src", "new", "work", "root"]);
        assert!(born_inside_unborn(
            &nested,
            &names(&["src", "FEATURE", "work", ""]),
            &create
        ));
        // A sibling in the same parent, or the same name elsewhere, is not.
        assert!(!born_inside_unborn(
            &key(&["other", "work", "root"]),
            &names(&["other", "work", ""]),
            &create
        ));
        assert!(!born_inside_unborn(
            &key(&["new", "elsewhere", "root"]),
            &names(&["feature", "elsewhere", ""]),
            &create
        ));
        // The parent itself is not inside the reservation.
        assert!(!born_inside_unborn(
            &key(&["work", "root"]),
            &names(&["work", ""]),
            &create
        ));
        // A bound claim is decided by identity alone.
        assert!(!born_inside_unborn(
            &created,
            &names(&["feature", "work", ""]),
            &key(&["new", "work", "root"])
        ));
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
            resource: Resource::Checkout,
            holder: None,
            listener_pid: None,
        }
    }

    fn other_key() -> Key {
        Key {
            host: "host".into(),
            chain: Vec::new(),
            unborn: None,
        }
    }

    fn port(port: u16) -> Resource {
        Resource::Port { port }
    }

    fn device(id: &str) -> Resource {
        Resource::Device {
            device_id: id.into(),
        }
    }

    /// A held non-checkout claim owned by `profile`/`incarnation`.
    fn held(resource: Resource, profile: &str, incarnation: &str) -> Claim {
        Claim {
            key: other_key(),
            path: resource.label().unwrap_or_default(),
            mode: Exclusive,
            owner_profile: profile.into(),
            owner_incarnation: incarnation.into(),
            resource,
            ..claim(ClaimState::Active, ClaimPurpose::Use, incarnation)
        }
    }

    fn wanted<'a>(key: &'a Key, resource: &'a Resource, profile: &'a str) -> Wanted<'a> {
        Wanted {
            key,
            resource,
            mode: Exclusive,
            purpose: ClaimPurpose::Use,
            holder: None,
            operation_id: None,
            profile,
            incarnation: "mine",
            verified_idle: false,
        }
    }

    #[test]
    fn a_port_is_one_claim_per_host_whatever_the_owner_mode_or_state() {
        let empty = other_key();
        let p5173 = port(5173);
        let want = wanted(&empty, &p5173, "a");
        for (profile, incarnation) in [("b", "theirs"), ("a", "mine"), ("a", "old")] {
            let mut claim = held(port(5173), profile, incarnation);
            assert!(claim_conflicts(&claim, &want), "{profile}/{incarnation}");
            claim.mode = Shared;
            claim.state = ClaimState::Quarantined;
            assert!(claim_conflicts(&claim, &want));
        }
        assert!(!claim_conflicts(&held(port(5174), "b", "theirs"), &want));
        let mut elsewhere = held(port(5173), "b", "theirs");
        elsewhere.key.host = "other-host".into();
        assert!(!claim_conflicts(&elsewhere, &want));
        // Different kinds never collide, even when their labels could.
        assert!(!claim_conflicts(&held(device("tcp:5173"), "b", "t"), &want));
        let tree = key(&["tree", "root"]);
        assert!(!claim_conflicts(
            &claim(ClaimState::Active, ClaimPurpose::Use, "t"),
            &wanted(&empty, &p5173, "a")
        ));
        let checkout = Resource::Checkout;
        assert!(!claim_conflicts(
            &held(port(5173), "b", "t"),
            &wanted(&tree, &checkout, "a")
        ));
    }

    #[test]
    fn a_device_is_exclusive_across_profiles_and_between_runs() {
        let key = other_key();
        let sim = device("ios-sim:A");
        let effect = wanted(&key, &sim, "a");
        // Another profile's effect or hold refuses this profile's effect.
        assert!(claim_conflicts(
            &held(device("ios-sim:A"), "b", "theirs"),
            &effect
        ));
        assert!(!claim_conflicts(
            &held(device("ios-sim:B"), "b", "theirs"),
            &effect
        ));
        // An earlier incarnation of this profile is not this daemon.
        assert!(claim_conflicts(
            &held(device("ios-sim:A"), "a", "old"),
            &effect
        ));
        // This daemon's own hold admits its own effects...
        let mut hold = held(device("ios-sim:A"), "a", "mine");
        hold.holder = Some("run-1".into());
        assert!(!claim_conflicts(&hold, &effect));
        // ...but another run of this profile cannot hold it too.
        let other_run = Wanted {
            holder: Some("run-2"),
            ..effect
        };
        assert!(claim_conflicts(&hold, &other_run));
        // Quarantine refuses everyone, this daemon included.
        hold.state = ClaimState::Quarantined;
        assert!(claim_conflicts(&hold, &effect));
        // Shared use by two profiles is compatible; nothing else is.
        let mut shared = held(device("ios-sim:A"), "b", "theirs");
        shared.mode = Shared;
        assert!(!claim_conflicts(
            &shared,
            &Wanted {
                mode: Shared,
                ..effect
            }
        ));
        assert!(claim_conflicts(&shared, &effect));
    }

    #[test]
    fn only_the_owning_profiles_reconciliation_retires_a_quarantined_port_or_device() {
        let key = other_key();
        let p = port(3000);
        let mut old = held(port(3000), "a", "old");
        old.state = ClaimState::Quarantined;
        old.holder = Some("service:w/web#1".into());
        let restart = Wanted {
            holder: Some("service:w/web#1"),
            verified_idle: true,
            ..wanted(&key, &p, "a")
        };
        assert!(supersedes(&old, &restart));
        assert!(!supersedes(
            &old,
            &Wanted {
                verified_idle: false,
                ..restart
            }
        ));
        assert!(!supersedes(
            &old,
            &Wanted {
                holder: Some("service:w/web#2"),
                ..restart
            }
        ));
        assert!(!supersedes(
            &old,
            &Wanted {
                profile: "b",
                ..restart
            }
        ));
        let p2 = port(3001);
        assert!(!supersedes(
            &old,
            &Wanted {
                resource: &p2,
                ..restart
            }
        ));
        // Another live incarnation's active claim is never retired; this
        // daemon's own stale one is, once the catalogue shows no run.
        let mut active = old.clone();
        active.state = ClaimState::Active;
        assert!(!supersedes(&active, &restart));
        active.owner_incarnation = "mine".into();
        assert!(supersedes(&active, &restart));
        assert!(!supersedes(
            &active,
            &Wanted {
                verified_idle: false,
                ..restart
            }
        ));

        let sim = device("ios-sim:A");
        let mut effect = held(device("ios-sim:A"), "a", "mine");
        effect.state = ClaimState::Quarantined;
        effect.operation_id = Some("op-1".into());
        let replay = Wanted {
            operation_id: Some("op-1"),
            ..wanted(&key, &sim, "a")
        };
        assert!(supersedes(&effect, &replay));
        assert!(!supersedes(
            &effect,
            &Wanted {
                operation_id: Some("op-2"),
                ..replay
            }
        ));
        assert!(!supersedes(
            &effect,
            &Wanted {
                operation_id: None,
                ..replay
            }
        ));
        let mut hold = held(device("ios-sim:A"), "a", "old");
        hold.state = ClaimState::Quarantined;
        hold.holder = Some("run-1".into());
        let again = Wanted {
            holder: Some("run-1"),
            ..wanted(&key, &sim, "a")
        };
        assert!(supersedes(&hold, &again));
        assert!(!supersedes(
            &hold,
            &Wanted {
                holder: Some("run-2"),
                ..again
            }
        ));
    }

    #[test]
    fn device_effects_settle_by_their_receipt() {
        assert_eq!(settle_effect(None), Settlement::Release);
        assert_eq!(settle_effect(Some(Status::Accepted)), Settlement::Release);
        assert_eq!(settle_effect(Some(Status::Settled)), Settlement::Release);
        for status in [Status::Dispatched, Status::Acknowledged, Status::Unknown] {
            assert_eq!(
                settle_effect(Some(status)),
                Settlement::Quarantine("outcome_unknown")
            );
        }
    }

    #[test]
    fn a_stopped_services_port_is_released_only_when_observed_free() {
        assert_eq!(
            settle_port_after_stop(3000, Some(&[8080])),
            Settlement::Release
        );
        assert_eq!(settle_port_after_stop(3000, Some(&[])), Settlement::Release);
        assert_eq!(
            settle_port_after_stop(3000, Some(&[3000])),
            Settlement::Quarantine("listener_remains_after_stop")
        );
        assert_eq!(
            settle_port_after_stop(3000, None),
            Settlement::Quarantine("listener_observation_unavailable")
        );
    }

    #[test]
    fn a_verified_stop_settles_only_this_profiles_claims_for_that_holder() {
        let mut claim = held(port(3000), "a", "mine");
        claim.holder = Some("h".into());
        assert!(settled_by_holder(&claim, "h", "a", "mine", true));
        assert!(!settled_by_holder(&claim, "other", "a", "mine", true));
        assert!(!settled_by_holder(&claim, "h", "b", "mine", true));
        claim.owner_incarnation = "old".into();
        assert!(!settled_by_holder(&claim, "h", "a", "mine", true));
        assert!(settled_by_holder(&claim, "h", "a", "mine", false));
        claim.holder = None;
        assert!(!settled_by_holder(&claim, "h", "a", "mine", false));
    }

    #[test]
    fn owner_loss_releases_a_port_only_before_launch_and_quarantines_devices() {
        assert_eq!(
            initial_phase(&port(1), ClaimPurpose::Use),
            ClaimPhase::Reserved
        );
        assert_eq!(
            initial_phase(&device("x"), ClaimPurpose::Use),
            ClaimPhase::Active
        );
        assert_eq!(
            initial_phase(&Resource::Checkout, ClaimPurpose::Use),
            ClaimPhase::Active
        );
        assert_eq!(
            initial_phase(&Resource::Checkout, ClaimPurpose::Remove),
            ClaimPhase::Reserved
        );
        // Through the shared owner-loss rule: reserved releases; dispatched,
        // bound and active quarantine.
        assert_eq!(
            on_owner_lost(
                initial_phase(&port(1), ClaimPurpose::Use),
                ClaimState::Active
            ),
            OwnerLoss::Release
        );
        assert_eq!(
            on_owner_lost(
                initial_phase(&device("x"), ClaimPurpose::Use),
                ClaimState::Active
            ),
            OwnerLoss::Quarantine("owner_lost_during_use")
        );
    }

    #[test]
    fn device_claims_use_the_canonical_id_and_skip_displays() {
        let udid = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            device_claim_id(&format!("ios-sim:{udid}")).unwrap(),
            Some(format!("ios-sim:{}", udid.to_uppercase()))
        );
        assert_eq!(
            device_claim_id("android-avd:Pixel_9").unwrap(),
            Some("android-avd:Pixel_9".into())
        );
        assert_eq!(device_claim_id(&format!("display:{udid}")).unwrap(), None);
        assert!(device_claim_id("ios-sim:nope").is_err());
        assert!(valid_holder("run_1"));
        assert!(!valid_holder(""));
        assert!(!valid_holder("has space"));
        assert!(!valid_holder(&"x".repeat(129)));
    }

    #[test]
    fn port_and_device_claims_stay_readable_and_inert_for_older_daemons() {
        // A claim written before this change reads as a checkout.
        let mut old =
            serde_json::to_value(claim(ClaimState::Active, ClaimPurpose::Use, "i")).unwrap();
        let object = old.as_object_mut().unwrap();
        object.remove("resource");
        let read: Claim = serde_json::from_value(old).unwrap();
        assert_eq!(read.resource, Resource::Checkout);
        // A port claim's empty chain nests with no checkout key either way,
        // which is how an older daemon's `conflicts` sees it.
        let port_key = other_key();
        let tree = key(&["tree", "root"]);
        assert!(!port_key.within(&tree));
        assert!(!tree.within(&port_key));
        assert!(!conflicts((&port_key, Exclusive), (&tree, Exclusive)));
        let wire = serde_json::to_value(held(port(3000), "a", "i")).unwrap();
        assert_eq!(
            wire["resource"],
            serde_json::json!({"kind": "port", "port": 3000})
        );
        assert_eq!(wire["path"], "tcp:3000");
    }

    #[test]
    fn only_this_profiles_own_quarantined_lease_of_the_same_key_is_superseded() {
        let same = key(&["tree", "root"]);
        let use_ = ClaimPurpose::Use;
        let lost = |state, purpose| Claim {
            reason: Some("owner_lost_during_use".into()),
            ..claim(state, purpose, "old")
        };
        let old = lost(ClaimState::Quarantined, use_);
        assert!(superseded_by(&old, &same, Shared, use_, "p", "new"));
        assert!(!superseded_by(&old, &same, Shared, use_, "other", "new"));
        assert!(!superseded_by(&old, &same, Shared, use_, "p", "old"));
        assert!(!superseded_by(
            &old,
            &same,
            Shared,
            ClaimPurpose::Remove,
            "p",
            "new"
        ));
        assert!(!superseded_by(
            &old,
            &key(&["other", "root"]),
            Shared,
            use_,
            "p",
            "new"
        ));
        assert!(!superseded_by(&old, &same, Exclusive, use_, "p", "new"));
        let active = lost(ClaimState::Active, use_);
        assert!(!superseded_by(&active, &same, Shared, use_, "p", "new"));
        let removal = lost(ClaimState::Quarantined, ClaimPurpose::Remove);
        assert!(!superseded_by(&removal, &same, Shared, use_, "p", "new"));
    }

    #[test]
    fn a_lease_after_restart_never_retires_an_effects_quarantined_claim() {
        let same = key(&["tree", "root"]);
        let use_ = ClaimPurpose::Use;
        // Setup's shared claim, quarantined because a hook timed out.
        let setup = Claim {
            operation_id: Some("op_setup".into()),
            reason: Some("hook_outcome_unknown".into()),
            ..claim(ClaimState::Quarantined, use_, "old")
        };
        assert!(!superseded_by(&setup, &same, Shared, use_, "p", "new"));
        // Carry's exclusive target claim, quarantined with an unknown outcome.
        let carry = Claim {
            mode: Exclusive,
            operation_id: Some("op_carry".into()),
            reason: Some("carry_outcome_unknown".into()),
            ..claim(ClaimState::Quarantined, use_, "old")
        };
        assert!(!superseded_by(&carry, &same, Shared, use_, "p", "new"));
        // An effect's claim whose owner was lost mid-effect.
        let mid_effect = Claim {
            operation_id: Some("op_resources".into()),
            reason: Some("owner_lost_during_use".into()),
            ..claim(ClaimState::Quarantined, use_, "old")
        };
        assert!(!superseded_by(&mid_effect, &same, Shared, use_, "p", "new"));
        // Through the take decision: the carry claim survives and refuses the
        // lease that a new incarnation wants.
        let wanted = Wanted {
            key: &same,
            resource: &Resource::Checkout,
            mode: Shared,
            purpose: use_,
            holder: None,
            operation_id: None,
            profile: "p",
            incarnation: "new",
            verified_idle: false,
        };
        assert!(!supersedes(&carry, &wanted));
        assert!(claim_conflicts(&carry, &wanted));
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
    fn recovery_never_starts_an_empty_registry_while_another_daemon_is_live() {
        let live = vec!["incarnation_a".to_owned()];
        for blocked in [Blocked::Missing, Blocked::Unreadable("x".into())] {
            assert!(may_accept(&blocked, &[]).is_ok());
            let refusal = may_accept(&blocked, &live).unwrap_err();
            assert!(refusal.contains("incarnation_a") && refusal.contains("still live"));
        }
        // Retrying an open or adopting a replacement forgets nothing.
        assert!(may_accept(&Blocked::Unavailable("x".into()), &live).is_ok());
        let replaced = Blocked::Replaced {
            bound: "a".into(),
            found: "b".into(),
        };
        assert!(may_accept(&replaced, &live).is_ok());
        // A newer registry is never replaced, live daemons or not.
        assert!(may_accept(&Blocked::Unsupported("2".into()), &[]).is_err());
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
