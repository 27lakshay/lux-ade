mod browser_tools;
mod diagnostics;

use crate::browser_reconcile::{HeldReceipt, owner_settlement};
use ade_core::contract::conversations::Ack;
use ade_core::contract::daemon::{
    BrowserCloseRequest, BrowserInspectRequest, BrowserListRequest, BrowserMutation,
    BrowserNavigateRequest, BrowserOpenRequest, BrowserOperation, BrowserOperationRequest,
    BrowserOperationState, BrowserOwnerGetRequest, BrowserOwnerRegisterRequest,
    BrowserOwnerReleased, BrowserOwnerReply, BrowserOwnerUnregisterRequest, BrowserTabReply,
    BrowserTabs, DaemonHello, HelloRequest, RestartPrepared, RuntimePrepareRestartRequest,
    RuntimeStatus, RuntimeStatusRequest, SessionSubscribeRequest,
};
use ade_core::contract::services::{
    ServiceProxy, ServiceProxyEnsureRequest, ServiceProxyInspectRequest, ServiceProxyRecovery,
    ServiceProxyRecoveryInspectRequest, ServiceProxyRecoveryReset,
    ServiceProxyRecoveryResetRequest, ServiceProxyRecoveryRetryRequest, ServiceProxyRemapRequest,
    ServiceProxyRetireRequest, ServiceProxyRetired, ServiceProxyTarget, ServiceProxyTargetRequest,
};
use ade_core::contract::terminals::{
    TerminalRestartRequest, TerminalRetireRequest, TerminalStopRequest, runtime as terminal_runtime,
};
use ade_core::runtime_protocol::{
    AgentOp, Proxy, ProxyEnsure, ProxyRecoveryRetry, ProxyRoute, ProxyTarget,
    terminal::Command as TerminalCommand,
};
use ade_daemon::{
    receipts::{self, Admission, Status},
    runtime::{self, Supervisor},
    sessions::Sessions,
    worktrees::Lease,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
/// Decodes a terminal request into its typed contract. An absent field keeps
/// the `Missing <field>` wording the handlers used before typing.
fn decode_terminal_request<T: serde::de::DeserializeOwned>(request: &Value) -> anyhow::Result<T> {
    T::deserialize(request).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => anyhow::anyhow!("Missing {field}"),
            None => anyhow::anyhow!("Invalid request: {text}"),
        }
    })
}
fn error_response(error: impl Into<anyhow::Error>) -> Value {
    ade_core::error::error_envelope(error.into())
}

/// Older wording for absent proxy request fields.
const SERVICE_NAME: (&str, &str) = ("name", "Missing service name");
const PORT_VARIABLE: (&str, &str) = ("port_variable", "Missing port variable");
const ROUTE_FIELDS: &[(&str, &str)] = &[
    SERVICE_NAME,
    PORT_VARIABLE,
    ("expected_route_id", "Missing expected route ID"),
    (
        "expected_service_identity",
        "Missing expected service identity",
    ),
    ("expected_target_port", "Missing expected target port"),
    ("expected_proxy_port", "Missing expected proxy port"),
];

/// Decodes a daemon-level request into its typed contract. An absent field
/// reads `Missing <field>` unless `messages` keeps an older wording for it.
fn decode_request<T: serde::de::DeserializeOwned>(
    request: &Value,
    messages: &[(&str, &str)],
) -> anyhow::Result<T> {
    T::deserialize(request).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => match messages.iter().find(|(name, _)| *name == field) {
                Some((_, message)) => anyhow::anyhow!("{message}"),
                None => anyhow::anyhow!("Missing {field}"),
            },
            None => anyhow::anyhow!("Invalid request: {text}"),
        }
    })
}

/// Forwards a runtime proxy reply once it matches its contract.
fn runtime_reply<T: serde::de::DeserializeOwned + serde::Serialize>(
    reply: Value,
) -> anyhow::Result<Value> {
    let typed: T = serde_json::from_value(reply)
        .map_err(|error| anyhow::anyhow!("Runtime proxy reply failed its contract: {error}"))?;
    Ok(serde_json::to_value(typed)?)
}

/// Narrows a port the daemon already bounded to the runtime protocol's `u16`.
fn port(value: u64) -> anyhow::Result<u16> {
    u16::try_from(value).map_err(|_| anyhow::anyhow!("Port {value} is out of range"))
}

/// Checks the reviewed route a retire or retry must still match.
fn expected_route<'a>(
    route_id: &'a str,
    identity: &'a str,
    target_port: u64,
    proxy_port: u64,
) -> anyhow::Result<(&'a str, &'a str, u64, u64)> {
    anyhow::ensure!(!route_id.is_empty(), "Missing expected route ID");
    anyhow::ensure!(!identity.is_empty(), "Missing expected service identity");
    anyhow::ensure!(
        (1..=65535).contains(&target_port),
        "Missing expected target port"
    );
    anyhow::ensure!(
        (1..=65535).contains(&proxy_port),
        "Missing expected proxy port"
    );
    Ok((route_id, identity, target_port, proxy_port))
}
const MAX_REQUEST: u64 = 12 * 1024 * 1024;
const MAX_BROWSER_REPLY: u64 = 1024 * 1024;
const BROWSER_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BROWSER_RECEIPTS: i64 = 4096;

#[derive(Clone)]
struct BrowserOwner {
    profile_id: String,
    owner_id: String,
    socket: PathBuf,
    device: u64,
    inode: u64,
}

impl BrowserOwner {
    fn same_endpoint(&self, other: &Self) -> bool {
        self.profile_id == other.profile_id
            && self.owner_id == other.owner_id
            && self.device == other.device
            && self.inode == other.inode
    }
}

fn browser_error(code: &str, message: &str) -> Value {
    json!({"type":"error","code":code,"message":message})
}

/// Decodes a request into its typed contract in `ade_core::contract::daemon`.
fn decode<T: DeserializeOwned>(request: &Value) -> anyhow::Result<T> {
    T::deserialize(request).map_err(|error| anyhow::anyhow!("Invalid request: {error}"))
}

/// Decodes a browser request after its fields passed the legacy checks, which
/// keep the existing error wording.
fn browser_decode<T: DeserializeOwned>(request: &Value) -> Result<T, Value> {
    decode(request).map_err(|error| browser_error("invalid_request", &error.to_string()))
}

/// Serializes a typed contract reply.
fn reply<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("contract replies serialize")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// The payload a browser mutation's receipt fingerprints. The owner recomputes
/// this fingerprint from the same array, so its order and shape are fixed.
fn browser_payload(
    op: &str,
    profile_id: &str,
    owner_id: &str,
    tab_id: Option<&str>,
    url: Option<&str>,
) -> Value {
    json!([op, profile_id, owner_id, tab_id, url])
}

/// A browser mutation receipt as the journal holds it. `result` carries
/// `{"owner_id"}` while the mutation is dispatched or unknown, and the owner's
/// reply once it settles; both name the owner.
struct BrowserReceipt {
    fingerprint: String,
    status: Status,
    result: Option<Value>,
}

impl BrowserReceipt {
    fn owner_id(&self) -> String {
        self.result
            .as_ref()
            .and_then(|result| result["owner_id"].as_str())
            .unwrap_or_default()
            .to_owned()
    }
}

fn browser_receipt(connection: &Connection, operation_id: &str) -> Option<BrowserReceipt> {
    let (fingerprint, status, result) = connection
        .query_row(
            "SELECT fingerprint,status,result FROM operations WHERE id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .ok()??;
    Some(BrowserReceipt {
        fingerprint,
        status: Status::parse(&status).ok()?,
        result: result
            .map(|text| serde_json::from_str(&text))
            .transpose()
            .ok()?,
    })
}

/// The reply to a mutation whose operation ID the journal already holds, or
/// `None` for a new one.
fn browser_replay(admission: anyhow::Result<Admission>) -> Option<Value> {
    Some(match admission {
        Ok(Admission::New) => return None,
        Ok(Admission::Conflict) => browser_error(
            "conflict",
            "Browser request ID has another target or payload",
        ),
        Ok(Admission::Expired) => {
            browser_error("conflict", "Browser request ID has expired; use a new one")
        }
        Ok(Admission::Replay(receipt)) => match receipt.status {
            Status::Settled => receipt.result.unwrap_or(Value::Null),
            Status::Unknown => browser_error(
                "outcome_unknown",
                "Browser operation outcome is unknown; inspect before another action",
            ),
            Status::Accepted | Status::Dispatched | Status::Acknowledged => {
                browser_error("in_progress", "Browser operation is still in progress")
            }
        },
        Err(_) => browser_error("unavailable", "Browser operation journal is unavailable"),
    })
}

fn browser_id(value: &Value, field: &str) -> anyhow::Result<String> {
    let id = value[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing {field}"))?;
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "Invalid {field}"
    );
    Ok(id.to_owned())
}

/// Reads the operation ID from `operation_id`, or from its legacy name `request_id`.
fn browser_request_id(value: &Value) -> anyhow::Result<String> {
    let id = value
        .get("operation_id")
        .or_else(|| value.get("request_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Missing request_id"))?;
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "Invalid request_id"
    );
    Ok(id.to_owned())
}

fn daemon_browser_profile(socket: &str) -> anyhow::Result<String> {
    if let Some(home) = std::env::var_os("ADE_RUNTIME_HOME") {
        let path = Path::new(&home);
        anyhow::ensure!(
            path.file_name().is_some_and(|name| name == "runtime"),
            "Managed browser profile has an invalid runtime home"
        );
        let id = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow::anyhow!("Managed browser profile has no identity"))?;
        return browser_id(&json!({"profile_id":id}), "profile_id");
    }
    let endpoint = Path::new(socket);
    let absolute = if endpoint.is_absolute() {
        endpoint.to_path_buf()
    } else {
        std::env::current_dir()?.join(endpoint)
    };
    let digest = Sha256::digest(absolute.to_string_lossy().as_bytes());
    let suffix: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!("fixed-{suffix}"))
}

fn browser_socket(path: &Path) -> anyhow::Result<(u64, u64)> {
    anyhow::ensure!(path.is_absolute(), "Browser owner socket must be absolute");
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Browser owner socket has no parent"))?;
    let parent_meta = std::fs::symlink_metadata(parent)?;
    let socket_meta = std::fs::symlink_metadata(path)?;
    let uid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        parent_meta.file_type().is_dir()
            && parent_meta.uid() == uid
            && parent_meta.permissions().mode() & 0o077 == 0,
        "Browser owner socket parent must be a private owned directory"
    );
    anyhow::ensure!(
        socket_meta.file_type().is_socket()
            && socket_meta.uid() == uid
            && socket_meta.permissions().mode() & 0o077 == 0,
        "Browser owner endpoint must be a private owned Unix socket"
    );
    Ok((socket_meta.dev(), socket_meta.ino()))
}

fn browser_connect(owner: &BrowserOwner) -> anyhow::Result<UnixStream> {
    let (device, inode) = browser_socket(&owner.socket)?;
    anyhow::ensure!(
        device == owner.device && inode == owner.inode,
        "Browser owner socket changed"
    );
    let stream = UnixStream::connect(&owner.socket)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
        anyhow::ensure!(
            result == 0 && uid == unsafe { libc::geteuid() },
            "Browser owner peer has another user identity"
        );
    }
    stream.set_read_timeout(Some(BROWSER_TIMEOUT))?;
    stream.set_write_timeout(Some(BROWSER_TIMEOUT))?;
    Ok(stream)
}
struct ProbeBudget {
    active: Mutex<usize>,
    available: Condvar,
}
struct ProbePermit<'a>(&'a ProbeBudget);
impl ProbeBudget {
    fn acquire(&self) -> ProbePermit<'_> {
        let mut active = self.active.lock().unwrap();
        while *active >= 4 {
            active = self.available.wait(active).unwrap();
        }
        *active += 1;
        ProbePermit(self)
    }
}
impl Drop for ProbePermit<'_> {
    fn drop(&mut self) {
        let mut active = self.0.active.lock().unwrap();
        *active -= 1;
        self.0.available.notify_one();
    }
}
struct Host {
    socket: PathBuf,
    /// The profile's durable state directory.
    directory: PathBuf,
    profile_id: String,
    sessions: Arc<Sessions>,
    runtime: Arc<Supervisor>,
    default_workspace: String,
    leases: Mutex<HashMap<String, Lease>>,
    browser_owner: Mutex<Option<BrowserOwner>>,
    /// In-memory receipts for browser mutations, on the shared receipt table.
    browser_receipts: Mutex<Connection>,
    browser_budget: ProbeBudget,
    proxy_probe: ProbeBudget,
    admission: RwLock<()>,
    stopping: AtomicBool,
}
impl Host {
    fn owner_is_current(&self, owner: &BrowserOwner) -> bool {
        self.browser_owner
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| current.same_endpoint(owner))
    }

    fn browser_operation(&self, request: &Value, profile_id: &str) -> Value {
        if let Err(error) = browser_request_id(request) {
            return browser_error("invalid_request", &error.to_string());
        }
        let lookup: BrowserOperationRequest = match browser_decode(request) {
            Ok(lookup) => lookup,
            Err(error) => return error,
        };
        let request_id = lookup.operation_id;
        let receipt = browser_receipt(&self.browser_receipts.lock().unwrap(), &request_id);
        let local = receipt.map(|receipt| {
            let (state, result) = match receipt.status {
                Status::Settled => (
                    BrowserOperationState::Completed,
                    receipt.result.clone().unwrap_or(Value::Null),
                ),
                Status::Unknown => (BrowserOperationState::Unknown, Value::Null),
                Status::Accepted | Status::Dispatched | Status::Acknowledged => {
                    (BrowserOperationState::Accepted, Value::Null)
                }
            };
            BrowserOperation {
                tag: Default::default(),
                profile_id: profile_id.to_owned(),
                owner_id: receipt.owner_id(),
                request_id: request_id.clone(),
                payload_fingerprint: receipt.fingerprint,
                state,
                op: None,
                result: Some(result),
            }
        });
        if let Some(value) = &local
            && value.state != BrowserOperationState::Unknown
        {
            return reply(value);
        }
        let unavailable = || {
            local
                .as_ref()
                .map(reply)
                .unwrap_or_else(|| browser_error("unavailable", "Browser operation is unavailable"))
        };
        let owner = self.browser_owner.lock().unwrap().clone();
        let Some(owner) = owner.filter(|owner| owner.profile_id == profile_id) else {
            return unavailable();
        };
        let _permit = self.browser_budget.acquire();
        let mut stream = match browser_connect(&owner) {
            Ok(stream) => stream,
            Err(_) => return unavailable(),
        };
        let command = json!({"op":"browser.operation","profile_id":profile_id,
            "owner_id":owner.owner_id,"request_id":request_id});
        if writeln!(stream, "{command}").is_err() {
            return unavailable();
        }
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        if reader
            .by_ref()
            .take(MAX_BROWSER_REPLY + 1)
            .read_until(b'\n', &mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BROWSER_REPLY
            || bytes.last() != Some(&b'\n')
        {
            return unavailable();
        }
        let owner_reply: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return unavailable(),
        };
        if !owner_reply.is_object()
            || !owner_reply["type"].is_string()
            || owner_reply["profile_id"] != profile_id
            || owner_reply["owner_id"] != owner.owner_id
            || owner_reply["request_id"] != request_id
            || !self.owner_is_current(&owner)
        {
            return unavailable();
        }
        let Some(local) = local else {
            if owner_reply["type"] == "error" {
                return owner_reply;
            }
            return match serde_json::from_value::<BrowserOperation>(owner_reply) {
                Ok(typed) => reply(&typed),
                Err(_) => browser_error("unavailable", "Browser operation is unavailable"),
            };
        };
        let fingerprint = local.payload_fingerprint.as_str();
        // The owner reconciles an interrupted mutation against its tabs; only
        // an answer that proves the outcome settles the unknown receipt.
        let held = HeldReceipt {
            profile_id,
            owner_id: &local.owner_id,
            request_id: &request_id,
            fingerprint,
        };
        let Some(result) = owner_settlement(&held, &owner.owner_id, &owner_reply) else {
            return reply(&local);
        };
        // Only an unknown receipt may settle here; a concurrent settle wins.
        let connection = self.browser_receipts.lock().unwrap();
        let unknown = browser_receipt(&connection, &request_id).is_some_and(|receipt| {
            receipt.fingerprint == fingerprint && receipt.status == Status::Unknown
        });
        if !unknown
            || receipts::settle(
                &connection,
                &request_id,
                Status::Settled,
                Some(result),
                now_ms(),
            )
            .is_err()
        {
            return reply(&local);
        }
        reply(&BrowserOperation {
            state: BrowserOperationState::Completed,
            result: Some(result.clone()),
            ..local
        })
    }

    fn browser_mutation(&self, request: &Value, profile_id: &str, op: &str) -> Value {
        // These checks keep the existing error wording and order; the typed
        // decode below then cannot fail on a missing field.
        if let Err(error) = browser_id(request, "owner_id") {
            return browser_error("invalid_request", &error.to_string());
        }
        if let Err(error) = browser_request_id(request) {
            return browser_error("invalid_request", &error.to_string());
        }
        let needs_tab = op != "browser.open";
        let needs_url = op != "browser.close";
        if needs_tab && let Err(error) = browser_id(request, "tab_id") {
            return browser_error("invalid_request", &error.to_string());
        }
        if needs_url
            && !request["url"].as_str().is_some_and(|url| {
                !url.is_empty()
                    && url.len() <= 8192
                    && (url.starts_with("http://") || url.starts_with("https://"))
            })
        {
            return browser_error("invalid_request", "Invalid browser URL");
        }
        let allowed = [
            "op",
            "profile_id",
            "owner_id",
            "operation_id",
            "request_id",
            "diagnostic_id",
            if needs_tab { "tab_id" } else { "" },
            if needs_url { "url" } else { "" },
        ];
        if request
            .as_object()
            .is_none_or(|fields| fields.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            return browser_error("invalid_request", "Unknown browser mutation field");
        }
        let decoded = match op {
            "browser.open" => browser_decode::<BrowserOpenRequest>(request)
                .map(|open| (open.owner_id, open.operation_id, None, Some(open.url))),
            "browser.navigate" => browser_decode::<BrowserNavigateRequest>(request).map(|nav| {
                (
                    nav.owner_id,
                    nav.operation_id,
                    Some(nav.tab_id),
                    Some(nav.url),
                )
            }),
            _ => browser_decode::<BrowserCloseRequest>(request)
                .map(|close| (close.owner_id, close.operation_id, Some(close.tab_id), None)),
        };
        let (owner_id, request_id, tab_id, url) = match decoded {
            Ok(fields) => fields,
            Err(error) => return error,
        };
        let payload = browser_payload(op, profile_id, &owner_id, tab_id.as_deref(), url.as_deref());
        let fingerprint = receipts::fingerprint(&payload);
        {
            // Probe the journal without admitting: dropping the transaction
            // rolls back the receipt a new ID would create.
            let mut connection = self.browser_receipts.lock().unwrap();
            let probe = connection.transaction().map_err(anyhow::Error::from);
            let admission = probe.and_then(|probe| {
                receipts::begin(&probe, &request_id, op, &payload, None, now_ms())
            });
            if let Some(reply) = browser_replay(admission) {
                return reply;
            }
        }
        let owner = self.browser_owner.lock().unwrap().clone();
        let Some(owner) =
            owner.filter(|owner| owner.profile_id == profile_id && owner.owner_id == owner_id)
        else {
            return browser_error("unavailable", "Browser owner changed; inspect it again");
        };
        let _permit = self.browser_budget.acquire();
        // Admit after acquiring the bounded dispatch permit. A concurrent
        // same-ID request then observes the dispatched receipt.
        let mut connection = self.browser_receipts.lock().unwrap();
        let admission = match connection.transaction() {
            Ok(admission) => admission,
            Err(_) => {
                return browser_error("unavailable", "Browser operation journal is unavailable");
            }
        };
        if let Some(reply) = browser_replay(receipts::begin(
            &admission,
            &request_id,
            op,
            &payload,
            None,
            now_ms(),
        )) {
            return reply;
        }
        let held: i64 = admission
            .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
            .unwrap_or(i64::MAX);
        if held > MAX_BROWSER_RECEIPTS {
            return browser_error(
                "overloaded",
                "Browser operation journal is full; restart after inspecting outstanding work",
            );
        }
        // Returning before the commit below rolls the admission back.
        let current_owner = self.browser_owner.lock().unwrap();
        if !current_owner
            .as_ref()
            .is_some_and(|current| current.same_endpoint(&owner))
        {
            return browser_error("unavailable", "Browser owner changed before dispatch");
        }
        let mut stream = match browser_connect(&owner) {
            Ok(stream) => stream,
            Err(_) => return browser_error("unavailable", "Browser owner is unavailable"),
        };
        let dispatched = receipts::settle(
            &admission,
            &request_id,
            Status::Dispatched,
            Some(&json!({"owner_id": owner_id})),
            now_ms(),
        );
        if dispatched.is_err() || admission.commit().is_err() {
            return browser_error("unavailable", "Browser operation journal is unavailable");
        }
        drop(connection);
        let mut command = json!({"op":op,"profile_id":profile_id,"owner_id":owner_id,
            "request_id":request_id,"payload_fingerprint":fingerprint});
        if let Some(tab_id) = &tab_id {
            command["tab_id"] = json!(tab_id);
        }
        if let Some(url) = &url {
            command["url"] = json!(url);
        }
        let uncertain = || {
            browser_error(
                "outcome_unknown",
                "Browser owner reply was lost; inspect this operation before retrying",
            )
        };
        let written = writeln!(stream, "{command}");
        drop(current_owner);
        let mut outcome = if written.is_err() {
            uncertain()
        } else {
            let mut reader = BufReader::new(stream);
            let mut bytes = Vec::new();
            if reader
                .by_ref()
                .take(MAX_BROWSER_REPLY + 1)
                .read_until(b'\n', &mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_BROWSER_REPLY
                || bytes.last() != Some(&b'\n')
            {
                uncertain()
            } else {
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value)
                        if value.is_object()
                            && value["profile_id"] == profile_id
                            && value["owner_id"] == owner_id
                            && value["request_id"] == request_id
                            && value["payload_fingerprint"] == fingerprint
                            && value["type"].is_string()
                            && (value["type"] == "error"
                                || browser_id(&value, "tab_id").ok().is_some_and(
                                    |reply_tab| {
                                        tab_id.as_ref().is_none_or(|target| target == &reply_tab)
                                    },
                                )) =>
                    {
                        if value["type"] == "error" {
                            value
                        } else {
                            // A reply outside the contract leaves the outcome unknown.
                            serde_json::from_value::<BrowserMutation>(value)
                                .map_or_else(|_| uncertain(), |typed| reply(&typed))
                        }
                    }
                    _ => uncertain(),
                }
            }
        };
        if !self.owner_is_current(&owner) {
            outcome = uncertain();
        }
        let (status, result) = if outcome["code"] == "outcome_unknown" {
            (Status::Unknown, None)
        } else {
            (Status::Settled, Some(&outcome))
        };
        let _ = receipts::settle(
            &self.browser_receipts.lock().unwrap(),
            &request_id,
            status,
            result,
            now_ms(),
        );
        outcome
    }

    fn browser_command(&self, request: &Value) -> Value {
        let op = request["op"].as_str().unwrap_or("");
        let profile_id = if matches!(op, "browser.owner.get" | "browser.operation")
            && request.get("profile_id").is_none()
        {
            self.profile_id.clone()
        } else {
            match browser_id(request, "profile_id") {
                Ok(id) => id,
                Err(error) => return browser_error("invalid_request", &error.to_string()),
            }
        };
        if profile_id != self.profile_id {
            return browser_error(
                "unavailable",
                "Browser profile is unavailable on this daemon",
            );
        }
        if op == "browser.operation" {
            return self.browser_operation(request, &profile_id);
        }
        if matches!(op, "browser.open" | "browser.navigate" | "browser.close") {
            return self.browser_mutation(request, &profile_id, op);
        }
        if op == "browser.owner.register" {
            if let Err(error) = browser_id(request, "owner_id") {
                return browser_error("invalid_request", &error.to_string());
            }
            if !request["socket_path"].is_string() {
                return browser_error("invalid_request", "Missing socket_path");
            }
            let register: BrowserOwnerRegisterRequest = match browser_decode(request) {
                Ok(register) => register,
                Err(error) => return error,
            };
            let socket = PathBuf::from(register.socket_path);
            let (device, inode) = match browser_socket(&socket) {
                Ok(identity) => identity,
                Err(_) => {
                    return browser_error(
                        "invalid_request",
                        "Browser owner socket is not a private owned Unix socket",
                    );
                }
            };
            let candidate = BrowserOwner {
                profile_id,
                owner_id: register.owner_id,
                socket,
                device,
                inode,
            };
            let mut current = self.browser_owner.lock().unwrap();
            if let Some(previous) = current.as_ref()
                && !previous.same_endpoint(&candidate)
                && browser_connect(previous).is_ok()
            {
                return browser_error("conflict", "Another live browser owner is registered");
            }
            *current = Some(candidate.clone());
            return reply(&BrowserOwnerReply {
                tag: Default::default(),
                profile_id: candidate.profile_id,
                owner_id: candidate.owner_id,
            });
        }
        if op == "browser.owner.unregister" {
            if let Err(error) = browser_id(request, "owner_id") {
                return browser_error("invalid_request", &error.to_string());
            }
            let unregister: BrowserOwnerUnregisterRequest = match browser_decode(request) {
                Ok(unregister) => unregister,
                Err(error) => return error,
            };
            let mut current = self.browser_owner.lock().unwrap();
            if current.as_ref().is_some_and(|owner| {
                owner.profile_id == profile_id && owner.owner_id == unregister.owner_id
            }) {
                *current = None;
                return reply(&BrowserOwnerReleased {
                    tag: Default::default(),
                    profile_id,
                    owner_id: unregister.owner_id,
                });
            }
            return browser_error("unavailable", "Browser owner is unavailable");
        }
        let current = self.browser_owner.lock().unwrap().clone();
        let Some(owner) = current.filter(|owner| owner.profile_id == profile_id) else {
            return browser_error("unavailable", "Browser owner is unavailable");
        };
        if op != "browser.owner.get" {
            let requested = match browser_id(request, "owner_id") {
                Ok(id) => id,
                Err(error) => return browser_error("invalid_request", &error.to_string()),
            };
            if requested != owner.owner_id {
                return browser_error("unavailable", "Browser owner changed; inspect it again");
            }
        }
        if op == "browser.inspect"
            && let Err(error) = browser_id(request, "tab_id")
        {
            return browser_error("invalid_request", &error.to_string());
        }
        let tab_id = match op {
            "browser.owner.get" => browser_decode::<BrowserOwnerGetRequest>(request).map(|_| None),
            "browser.list" => browser_decode::<BrowserListRequest>(request).map(|_| None),
            _ => {
                browser_decode::<BrowserInspectRequest>(request).map(|inspect| Some(inspect.tab_id))
            }
        };
        let tab_id = match tab_id {
            Ok(tab_id) => tab_id,
            Err(error) => return error,
        };
        let _permit = self.browser_budget.acquire();
        let mut stream = match browser_connect(&owner) {
            Ok(stream) => stream,
            Err(_) => return browser_error("unavailable", "Browser owner is unavailable"),
        };
        if op == "browser.owner.get" {
            return reply(&BrowserOwnerReply {
                tag: Default::default(),
                profile_id: owner.profile_id,
                owner_id: owner.owner_id,
            });
        }
        let mut command = json!({"op":op,"profile_id":owner.profile_id,"owner_id":owner.owner_id});
        if let Some(tab_id) = &tab_id {
            command["tab_id"] = json!(tab_id);
        }
        if writeln!(stream, "{command}").is_err() {
            return browser_error("unavailable", "Browser owner did not accept the request");
        }
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        if reader
            .by_ref()
            .take(MAX_BROWSER_REPLY + 1)
            .read_until(b'\n', &mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BROWSER_REPLY
            || bytes.last() != Some(&b'\n')
        {
            return browser_error(
                "unavailable",
                "Browser owner response is unavailable or too large",
            );
        }
        let response: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return browser_error("protocol", "Browser owner returned invalid JSON"),
        };
        if !response.is_object()
            || !response["type"].is_string()
            || response["profile_id"] != owner.profile_id
            || response["owner_id"] != owner.owner_id
            || (op == "browser.inspect"
                && response["type"] != "error"
                && response["tab_id"] != request["tab_id"])
        {
            return browser_error(
                "unavailable",
                "Browser owner identity changed during the request",
            );
        }
        // An unregistered or replaced owner may finish an in-flight read. Never
        // present its response as current browser state.
        if !self.owner_is_current(&owner) {
            return browser_error("unavailable", "Browser owner changed during the request");
        }
        if response["type"] == "error" {
            return response;
        }
        let typed = if op == "browser.list" {
            serde_json::from_value::<BrowserTabs>(response).map(|tabs| reply(&tabs))
        } else {
            serde_json::from_value::<BrowserTabReply>(response).map(|tab| reply(&tab))
        };
        typed.unwrap_or_else(|_| {
            browser_error("protocol", "Browser owner reply failed its contract")
        })
    }

    /// Reads the workspace's service list after checking that the service has
    /// the port variable.
    /// This daemon's socket, which a stable proxy dials for its current target.
    fn daemon_socket(&self) -> anyhow::Result<String> {
        Ok(self
            .socket
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Daemon socket path is not UTF-8"))?
            .into())
    }

    fn proxy_service(&self, workspace: &str, name: &str, variable: &str) -> anyhow::Result<Value> {
        self.sessions.ensure_workspace_bound(workspace)?;
        let listed = self
            .sessions
            .command(&json!({"op":"service.list","workspace_id":workspace}))?;
        let service = listed["services"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .ok_or_else(|| anyhow::anyhow!("Unknown managed service"))?;
        anyhow::ensure!(
            service["ports"][variable].as_u64().is_some(),
            "Service has no configured port variable"
        );
        Ok(listed)
    }

    fn proxy_ensure(&self, request: &Value) -> anyhow::Result<Value> {
        let remap = request["op"] == "service.proxy.remap";
        let (workspace, name, variable, expected) = if remap {
            let remap: ServiceProxyRemapRequest = decode_request(
                request,
                &[
                    SERVICE_NAME,
                    PORT_VARIABLE,
                    (
                        "expected_service_identity",
                        "Service identity changed; inspect it again",
                    ),
                    (
                        "expected_target_port",
                        "Service target port changed; inspect it again",
                    ),
                    ("expected_route_identity", "Missing expected route identity"),
                    ("expected_route_port", "Missing expected route port"),
                ],
            )?;
            (
                remap.workspace_id,
                remap.name,
                remap.port_variable,
                Some((
                    remap.expected_service_identity,
                    remap.expected_target_port,
                    remap.expected_route_identity,
                    remap.expected_route_port,
                )),
            )
        } else {
            let ensure: ServiceProxyEnsureRequest =
                decode_request(request, &[SERVICE_NAME, PORT_VARIABLE])?;
            (ensure.workspace_id, ensure.name, ensure.port_variable, None)
        };
        let listed = self.proxy_service(&workspace, &name, &variable)?;
        let service = listed["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap();
        let identity = service["identity"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Service identity unavailable"))?;
        let target_port = service["ports"][&variable].as_u64().unwrap();
        let (expected_route_identity, expected_route_port) = match &expected {
            Some((service_identity, service_port, route_identity, route_port)) => {
                anyhow::ensure!(
                    service_identity == identity,
                    "Service identity changed; inspect it again"
                );
                anyhow::ensure!(
                    *service_port == target_port,
                    "Service target port changed; inspect it again"
                );
                anyhow::ensure!(
                    !route_identity.is_empty(),
                    "Missing expected route identity"
                );
                anyhow::ensure!(
                    (1..=65535).contains(route_port),
                    "Missing expected route port"
                );
                (route_identity.as_str(), *route_port)
            }
            None => ("", 0),
        };
        runtime_reply::<ServiceProxy>(self.runtime.command(Proxy::Ensure(ProxyEnsure {
            target: ProxyTarget {
                workspace_id: workspace,
                service_name: name,
                port_variable: variable,
            },
            service_identity: identity.into(),
            target_port: port(target_port)?,
            remap,
            expected_route_identity: expected_route_identity.into(),
            expected_route_port: port(expected_route_port)?,
            daemon_socket: self.daemon_socket()?,
        }))?)
    }

    fn proxy_inspect(&self, request: &Value) -> anyhow::Result<Value> {
        let inspect: ServiceProxyInspectRequest =
            decode_request(request, &[SERVICE_NAME, PORT_VARIABLE])?;
        self.sessions
            .ensure_workspace_bound(&inspect.workspace_id)?;
        runtime_reply::<ServiceProxy>(self.runtime.command(Proxy::Inspect(ProxyTarget {
            workspace_id: inspect.workspace_id,
            service_name: inspect.name,
            port_variable: inspect.port_variable,
        }))?)
    }

    fn proxy_retire(&self, request: &Value) -> anyhow::Result<Value> {
        let retire: ServiceProxyRetireRequest = decode_request(request, ROUTE_FIELDS)?;
        self.sessions.ensure_workspace_bound(&retire.workspace_id)?;
        let (route_id, identity, target_port, proxy_port) = expected_route(
            &retire.expected_route_id,
            &retire.expected_service_identity,
            retire.expected_target_port,
            retire.expected_proxy_port,
        )?;
        runtime_reply::<ServiceProxyRetired>(self.runtime.command(Proxy::Retire(ProxyRoute {
            target: ProxyTarget {
                workspace_id: retire.workspace_id,
                service_name: retire.name,
                port_variable: retire.port_variable,
            },
            expected_route_id: route_id.into(),
            expected_service_identity: identity.into(),
            expected_target_port: port(target_port)?,
            expected_proxy_port: port(proxy_port)?,
        }))?)
    }

    fn proxy_recovery_inspect(&self, request: &Value) -> anyhow::Result<Value> {
        let ServiceProxyRecoveryInspectRequest {} = decode_request(request, &[])?;
        runtime_reply::<ServiceProxyRecovery>(self.runtime.command(Proxy::RecoveryInspect)?)
    }

    fn proxy_recovery_retry(&self, request: &Value) -> anyhow::Result<Value> {
        let retry: ServiceProxyRecoveryRetryRequest = decode_request(request, ROUTE_FIELDS)?;
        self.sessions.ensure_workspace_bound(&retry.workspace_id)?;
        let (route_id, identity, target_port, proxy_port) = expected_route(
            &retry.expected_route_id,
            &retry.expected_service_identity,
            retry.expected_target_port,
            retry.expected_proxy_port,
        )?;
        let route = ProxyRoute {
            target: ProxyTarget {
                workspace_id: retry.workspace_id,
                service_name: retry.name,
                port_variable: retry.port_variable,
            },
            expected_route_id: route_id.into(),
            expected_service_identity: identity.into(),
            expected_target_port: port(target_port)?,
            expected_proxy_port: port(proxy_port)?,
        };
        runtime_reply::<ServiceProxy>(self.runtime.command(Proxy::RecoveryRetry(
            ProxyRecoveryRetry {
                route,
                daemon_socket: self.daemon_socket()?,
            },
        ))?)
    }

    fn proxy_recovery_reset(&self, request: &Value) -> anyhow::Result<Value> {
        let reset: ServiceProxyRecoveryResetRequest = decode_request(
            request,
            &[(
                "expected_registry_sha256",
                "Missing expected registry SHA-256",
            )],
        )?;
        runtime_reply::<ServiceProxyRecoveryReset>(self.runtime.command(Proxy::RecoveryReset {
            expected_registry_sha256: reset.expected_registry_sha256,
        })?)
    }

    fn proxy_target(&self, request: &Value) -> anyhow::Result<Value> {
        const TARGET_CHANGED: &str = "Stable service proxy target changed; explicitly remap it";
        let target: ServiceProxyTargetRequest = decode_request(
            request,
            &[
                SERVICE_NAME,
                PORT_VARIABLE,
                ("expected_port", TARGET_CHANGED),
                ("service_identity", TARGET_CHANGED),
                ("connected_host", "Invalid connected proxy host"),
            ],
        )?;
        let (workspace, name, variable) = (
            target.workspace_id.as_str(),
            target.name.as_str(),
            target.port_variable.as_str(),
        );
        let listed = self.proxy_service(workspace, name, variable)?;
        anyhow::ensure!(
            listed["states"][name]["state"] == "running",
            "Managed service is unavailable"
        );
        let service = listed["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap();
        let port = service["ports"][variable].as_u64().unwrap();
        anyhow::ensure!(
            target.expected_port == port && service["identity"] == target.service_identity,
            TARGET_CHANGED
        );
        let transfer = listed["states"][name]["metrics"]["transfer_id"].clone();
        let pid = listed["states"][name]["metrics"]["shell_pid"].clone();
        let (Some(transfer_id), Some(process)) = (transfer.as_str(), pid.as_u64()) else {
            anyhow::bail!("Service process identity unavailable");
        };
        let host = Some(target.connected_host.as_str())
            .filter(|host| matches!(*host, "127.0.0.1" | "::1"))
            .ok_or_else(|| anyhow::anyhow!("Invalid connected proxy host"))?;
        let family = if host == "127.0.0.1" { "ipv4" } else { "ipv6" };
        // This observation happens after the proxy has connected but before it
        // forwards any request bytes. Bound concurrent lsof probes;
        // never reuse a positive result after the listener may have changed.
        let _probe = self.proxy_probe.acquire();
        let inventory = self.sessions.command(&json!({"op":"listener.list"}))?;
        let rows = inventory["listeners"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Listener inventory is unavailable"))?;
        let covers_loopback = |address: &str| match family {
            "ipv4" => matches!(address, "127.0.0.1" | "0.0.0.0" | "*"),
            _ => matches!(address, "::1" | "::" | "*"),
        };
        // `listener.list` attributes a row to this service only when its PID
        // is in the current run's process tree, so a child that binds for a
        // wrapper (`pnpm dev` -> node) is wired and any other holder is not.
        let owned = |row: &Value| row["workspace_id"] == workspace && row["service_name"] == name;
        let on_port = |row: &&Value| {
            row["family"] == family
                && row["port"] == port
                && row["address"].as_str().is_some_and(covers_loopback)
        };
        let own = rows.iter().filter(on_port).any(owned);
        let contested = rows.iter().filter(on_port).any(|row| !owned(row));
        anyhow::ensure!(
            own && !contested,
            "Service has no verified loopback listener"
        );
        drop(_probe);
        let current = self
            .sessions
            .command(&json!({"op":"service.list","workspace_id":workspace}))?;
        anyhow::ensure!(
            current["states"][name]["state"] == "running"
                && current["states"][name]["metrics"]["transfer_id"] == transfer
                && current["states"][name]["metrics"]["shell_pid"] == pid
                && current["services"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| {
                        item["name"] == name
                            && item["identity"] == service["identity"]
                            && item["ports"][variable] == port
                    })),
            "Managed service changed during proxy resolution"
        );
        Ok(serde_json::to_value(ServiceProxyTarget {
            tag: Default::default(),
            host: host.to_owned(),
            port,
            transfer_id: transfer_id.to_owned(),
            pid: process,
        })?)
    }

    fn refresh_leases(&self) -> anyhow::Result<()> {
        let mut leases = self.leases.lock().unwrap();
        let mut live = HashSet::new();
        for terminal in self.runtime_terminals()? {
            let workspace = terminal.workspace;
            if self.sessions.ensure_workspace_bound(&workspace.id).is_err() {
                continue;
            }
            if terminal.metrics["shell_running"] != true {
                let stored = self.sessions.workspace(&workspace.id)?;
                if stored.terminal_id != workspace.terminal_id
                    && !stored.extra_terminals.contains(&workspace.terminal_id)
                {
                    self.runtime.command(terminal_runtime::Command::Retire {
                        workspace_id: workspace.id,
                        terminal_id: workspace.terminal_id,
                    })?;
                }
                continue;
            }
            let stored = self.sessions.workspace(&workspace.id)?;
            anyhow::ensure!(
                stored.root == workspace.root
                    && (stored.terminal_id == workspace.terminal_id
                        || stored.extra_terminals.contains(&workspace.terminal_id)),
                "Runtime terminal does not match durable workspace"
            );
            live.insert(workspace.id.clone());
            if let std::collections::hash_map::Entry::Vacant(e) = leases.entry(workspace.id) {
                e.insert(self.sessions.worktrees.lease(&workspace.root)?);
            }
        }
        leases.retain(|id, _| live.contains(id));
        Ok(())
    }
    fn ensure_terminal(
        &self,
        id: &str,
        terminal_id: Option<&str>,
        restart: bool,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!id.is_empty(), "Choose a workspace folder first");
        let mut leases = self.leases.lock().unwrap();
        self.sessions.ensure_workspace_bound(id)?;
        let mut workspace = self.sessions.workspace(id)?;
        let key = if let Some(terminal) = terminal_id {
            anyhow::ensure!(
                terminal == workspace.terminal_id
                    || workspace.extra_terminals.iter().any(|id| id == terminal),
                "Unknown workspace terminal"
            );
            if terminal == workspace.terminal_id {
                workspace.id.clone()
            } else {
                terminal.to_owned()
            }
        } else {
            workspace.id.clone()
        };
        if let Some(terminal) = terminal_id {
            workspace.terminal_id = terminal.into();
        }
        let reserved = self.sessions.terminal_reserved(&workspace.terminal_id)?;
        anyhow::ensure!(
            !restart || !reserved,
            "Use service.start for a service terminal, or return the Conversation to the GUI"
        );
        // Acquire the worktree lease before allowing a shell to start.
        let lease = if !leases.contains_key(id) {
            Some(self.sessions.worktrees.lease(&workspace.root)?)
        } else {
            None
        };
        self.sessions.ensure_workspace_bound(id)?;
        let ensure = terminal_runtime::Ensure {
            workspace,
            terminal_key: Some(key),
            existing_only: reserved,
            session_subscribers: self.sessions.subscribers.load(Ordering::Relaxed),
        };
        let command = if restart {
            terminal_runtime::Command::Restart(ensure)
        } else {
            terminal_runtime::Command::Ensure(ensure)
        };
        let result: terminal_runtime::Ensured =
            serde_json::from_value(self.runtime.command(command)?)?;
        if result.metrics["shell_running"] == true
            && let Some(lease) = lease
        {
            leases.insert(id.to_owned(), lease);
        } // refresh_leases retires a lease only after every shell in the workspace exits.
        Ok(())
    }
    fn status(&self, request: &Value) -> anyhow::Result<Value> {
        let RuntimeStatusRequest {} = decode(request)?;
        let terminals = self.runtime.command(TerminalCommand::List)?;
        let mut agents = self.runtime.agent(AgentOp::List)?;
        if let Some(runs) = agents["agents"].as_array_mut() {
            for run in runs {
                run.as_object_mut().unwrap().remove("commands");
            }
        }
        Ok(reply(&RuntimeStatus {
            tag: Default::default(),
            application_protocol: runtime::APPLICATION_PROTOCOL.into(),
            runtime_protocol: runtime::PROTOCOL.into(),
            boot_id: self.sessions.boot_id.clone(),
            pid: std::process::id(),
            runtime_pid: self.runtime.pid,
            runtime_instance: self.runtime.instance.clone(),
            runtime_socket: self.runtime.socket.to_string_lossy().into_owned(),
            connected_agents: self.sessions.connected_agents() as u64,
            active_git_operations: self.sessions.worktrees.active_operations() as u64,
            stopping: self.stopping.load(Ordering::Acquire),
            terminals: terminals["terminals"].clone(),
            agents: agents["agents"].clone(),
        }))
    }
    fn hello(&self) -> Value {
        reply(&DaemonHello {
            tag: Default::default(),
            build_id: std::env::var("ADE_BUILD_ID").ok(),
            application_protocol: runtime::APPLICATION_PROTOCOL.into(),
            runtime_protocol: runtime::PROTOCOL.into(),
            runtime_instance: self.runtime.instance.clone(),
            runtime_pid: self.runtime.pid,
            runtime_socket: self.runtime.socket.to_string_lossy().into_owned(),
            pid: std::process::id(),
            session_protocol: "ade-sessions-v1".into(),
            worktree_protocol: "ade-worktrees-v1".into(),
            review_protocol: "ade-review-v1".into(),
            response_owner: "daemon-v1".into(),
            terminal_snapshot_format: "ghostty-snapshot-v1-herdr-9c96f7d".into(),
            terminal_snapshot_formats: vec![
                "ghostty-snapshot-v1-herdr-9c96f7d".into(),
                "xterm-replay-v1".into(),
            ],
            boot_id: self.sessions.boot_id.clone(),
        })
    }
    /// The runtime's terminal catalogue.
    fn runtime_terminals(&self) -> anyhow::Result<Vec<terminal_runtime::Terminal>> {
        let state = self.runtime.command(terminal_runtime::Command::List)?;
        let state: terminal_runtime::Terminals = serde_json::from_value(state)
            .map_err(|_| anyhow::anyhow!("Invalid terminal catalogue"))?;
        Ok(state.terminals)
    }
    /// `terminal.restart`: start a new shell in an exited workspace terminal.
    fn terminal_restart(&self, request: &Value) -> anyhow::Result<Value> {
        let restart: TerminalRestartRequest = decode_terminal_request(request)?;
        self.ensure_terminal(
            restart
                .workspace_id
                .as_deref()
                .unwrap_or(&self.default_workspace),
            restart.terminal_id.as_deref(),
            true,
        )?;
        Ok(serde_json::to_value(Ack::default())?)
    }
    /// `terminal.stop` and `terminal.retire`.
    fn terminal_lifecycle(&self, request: &Value) -> anyhow::Result<Value> {
        let stop = request["op"] == "terminal.stop";
        let (workspace, terminal) = if stop {
            let TerminalStopRequest {
                workspace_id,
                terminal_id,
            } = decode_terminal_request(request)?;
            (workspace_id, terminal_id)
        } else {
            let TerminalRetireRequest {
                workspace_id,
                terminal_id,
            } = decode_terminal_request(request)?;
            (workspace_id, terminal_id)
        };
        let _leases = self.leases.lock().unwrap();
        self.sessions.ensure_workspace_bound(&workspace)?;
        let stored = self.sessions.workspace(&workspace)?;
        if stop {
            anyhow::ensure!(
                stored.terminal_id == terminal || stored.extra_terminals.contains(&terminal),
                "Unknown workspace terminal"
            );
            self.runtime.command(terminal_runtime::Command::Stop {
                workspace_id: workspace,
                terminal_id: terminal,
            })?;
            return Ok(serde_json::to_value(Ack::default())?);
        }
        anyhow::ensure!(
            !self.sessions.terminal_reserved(&terminal)?,
            "Remove its service, or return the Conversation to the GUI before retiring this terminal"
        );
        if let Some(entry) = self.runtime_terminals()?.iter().find(|entry| {
            entry.workspace.id == workspace && entry.workspace.terminal_id == terminal
        }) {
            anyhow::ensure!(
                !entry.shell_running(),
                "Stop the shell before retiring its terminal"
            );
        }
        // Commit retirement before releasing runtime storage. If the daemon
        // dies between these steps, refresh_leases reaps the exited orphan.
        self.sessions.retire_terminal(&workspace, &terminal)?;
        self.runtime.command(terminal_runtime::Command::Retire {
            workspace_id: workspace,
            terminal_id: terminal,
        })?;
        Ok(serde_json::to_value(Ack::default())?)
    }
    fn prepare_restart(&self, request: &Value) -> anyhow::Result<Value> {
        let _gate = self
            .admission
            .try_write()
            .map_err(|_| anyhow::anyhow!("A command is still being admitted; retry shortly"))?;
        anyhow::ensure!(
            decode::<RuntimePrepareRestartRequest>(request)
                .is_ok_and(|restart| restart.boot_id == self.sessions.boot_id),
            "Application daemon changed; inspect runtime.status again"
        );
        anyhow::ensure!(
            !self.stopping.load(Ordering::Acquire),
            "Application daemon is already restarting"
        );
        anyhow::ensure!(
            self.sessions.worktrees.active_operations() == 0,
            "Git or worktree operations are still running; retry after completion"
        );
        self.sessions.prepare_restart()?;
        if let Err(error) = self.runtime.prepare_handoff() {
            self.sessions.abort_restart();
            return Err(error);
        }
        self.stopping.store(true, Ordering::Release);
        Ok(reply(&RestartPrepared {
            tag: Default::default(),
            boot_id: self.sessions.boot_id.clone(),
            runtime_instance: self.runtime.instance.clone(),
        }))
    }
}
fn read_request(reader: &mut BufReader<UnixStream>) -> io::Result<Option<String>> {
    let mut line = String::new();
    let count = reader.by_ref().take(MAX_REQUEST).read_line(&mut line)?;
    if count == 0 {
        return Ok(None);
    }
    if !line.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Request too large",
        ));
    }
    Ok(Some(line))
}
fn handle_connection(mut stream: UnixStream, host: Arc<Host>) -> anyhow::Result<()> {
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .or_else(|error| {
            if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOTCONN)) {
                Ok(())
            } else {
                Err(error)
            }
        })?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(mut first) = read_request(&mut reader)? else {
        return Ok(());
    };
    loop {
        let request: Value = match serde_json::from_str(&first) {
            Ok(request) => request,
            Err(error) => {
                writeln!(stream, "{}", error_response(error))?;
                let Some(next) = read_request(&mut reader)? else {
                    return Ok(());
                };
                first = next;
                continue;
            }
        };
        let op = request["op"].as_str().unwrap_or("");
        let diagnostic_id = request["diagnostic_id"]
            .as_str()
            .filter(|id| ade_core::diagnostics::valid_id(id));
        let operation_family = ade_core::diagnostics::operation_family(op);
        let started = Instant::now();
        if let Some(diagnostic_id) = diagnostic_id {
            tracing::info!(target: "ade", event = "rpc_started", diagnostic_id, operation_family);
        }
        if first.len() > 128 * 1024 && op != "attachment.put" {
            writeln!(
                stream,
                "{}",
                json!({"type":"error","message":"Request exceeds 128 KiB"})
            )?;
            if let Some(diagnostic_id) = diagnostic_id {
                tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
            return Ok(());
        }
        if op == "runtime.prepare_restart" {
            let outcome = host.prepare_restart(&request);
            let event = outcome.unwrap_or_else(error_response);
            let result = writeln!(stream, "{event}");
            if let Some(diagnostic_id) = diagnostic_id {
                let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if event["type"] == "error" || result.is_err() {
                    tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
                } else {
                    tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
                }
            }
            if host.stopping.load(Ordering::Acquire) {
                let _ = UnixStream::connect(&host.socket);
            }
            result?;
            return Ok(());
        }
        if op == "diagnostics.status" || op == "diagnostics.export" {
            // A read that must work while the daemon drains or degrades, so it
            // takes no admission lock.
            let event = host.diagnostics(&request).unwrap_or_else(error_response);
            let result = writeln!(stream, "{event}");
            if let Some(diagnostic_id) = diagnostic_id {
                let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if event["type"] == "error" || result.is_err() {
                    tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
                } else {
                    tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
                }
            }
            result?;
            let Some(next) = read_request(&mut reader)? else {
                return Ok(());
            };
            first = next;
            continue;
        }
        if op == "runtime.status" {
            let event = host.status(&request)?;
            writeln!(stream, "{event}")?;
            if let Some(diagnostic_id) = diagnostic_id {
                tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
            return Ok(());
        }
        let admission = host.admission.read().unwrap();
        anyhow::ensure!(
            !host.stopping.load(Ordering::Acquire),
            "Application daemon is restarting; reconnect"
        );
        if op == "session.subscribe" {
            let SessionSubscribeRequest {} = decode(&request)?;
            let (id, rx) = host.sessions.subscribe()?;
            let sessions = host.sessions.clone();
            let reader_id = id.clone();
            // Dedicated event streams accept no commands. EOF removes the bounded
            // subscription even when no subsequent state change produces a write.
            std::thread::spawn(move || {
                let mut byte = [0];
                let _ = reader.read(&mut byte);
                sessions.unsubscribe(&reader_id);
            });
            drop(admission);
            while let Ok(event) = rx.recv() {
                if writeln!(stream, "{event}").is_err() {
                    break;
                }
            }
            host.sessions.unsubscribe(&id);
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return Ok(());
        }
        if op == "hello" || op.contains('.') {
            let event = if op == "hello" {
                decode::<HelloRequest>(&request).map_or_else(error_response, |_| host.hello())
            } else {
                if op == "worktree.remove" {
                    host.refresh_leases()?;
                }
                match if op == "service.proxy.ensure" || op == "service.proxy.remap" {
                    host.proxy_ensure(&request)
                } else if op == "service.proxy.inspect" {
                    host.proxy_inspect(&request)
                } else if op == "service.proxy.retire" {
                    host.proxy_retire(&request)
                } else if op == "service.proxy.recovery.inspect" {
                    host.proxy_recovery_inspect(&request)
                } else if op == "service.proxy.recovery.retry" {
                    host.proxy_recovery_retry(&request)
                } else if op == "service.proxy.recovery.reset" {
                    host.proxy_recovery_reset(&request)
                } else if op == "service.proxy.target" {
                    host.proxy_target(&request)
                } else if op == "terminal.stop" || op == "terminal.retire" {
                    host.terminal_lifecycle(&request)
                } else if op == "terminal.restart" {
                    host.terminal_restart(&request)
                } else if matches!(
                    op,
                    "browser.owner.register"
                        | "browser.owner.unregister"
                        | "browser.owner.get"
                        | "browser.list"
                        | "browser.inspect"
                        | "browser.open"
                        | "browser.navigate"
                        | "browser.close"
                        | "browser.operation"
                ) {
                    Ok(host.browser_command(&request))
                } else if browser_tools::is_browser_tool(op) {
                    Ok(host.browser_tool(&request))
                } else {
                    host.sessions.command(&request)
                } {
                    Ok(value) => value,
                    Err(error) => error_response(error),
                }
            };
            let write_result = writeln!(stream, "{event}");
            if let Some(diagnostic_id) = diagnostic_id {
                if let Some(run_id) = request["conversation_id"]
                    .as_str()
                    .and_then(|id| host.sessions.diagnostic_run(id))
                {
                    tracing::info!(target: "ade", event = "rpc_run", diagnostic_id, run_id);
                }
                let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if event["type"] == "error" || write_result.is_err() {
                    tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
                } else {
                    tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
                }
            }
            write_result?;
            drop(admission);
            let Some(next) = read_request(&mut reader)? else {
                return Ok(());
            };
            first = next;
            continue;
        }
        let id = request["workspace_id"]
            .as_str()
            .unwrap_or(&host.default_workspace);
        if let Err(error) = host.ensure_terminal(id, request["terminal_id"].as_str(), false) {
            writeln!(stream, "{}", error_response(error))?;
            return Ok(());
        }
        let workspace = host.sessions.workspace(id)?;
        let key = request["terminal_id"]
            .as_str()
            .filter(|t| *t != workspace.terminal_id)
            .unwrap_or(id);
        let mut upstream = host.runtime.terminal(key)?;
        upstream.write_all(first.as_bytes())?;
        drop(admission);
        // Copy bytes without parsing terminal output a second time. Both directions
        // are bounded by Unix socket buffers; slow viewers are evicted upstream.
        let mut input = upstream.try_clone()?;
        std::thread::spawn(move || {
            let _ = io::copy(&mut reader, &mut input);
            let _ = input.shutdown(std::net::Shutdown::Write);
        });
        let result = io::copy(&mut upstream, &mut stream);
        let _ = upstream.shutdown(std::net::Shutdown::Both);
        let _ = stream.shutdown(std::net::Shutdown::Both);
        result?;
        return Ok(());
    }
}
/// Browser mutation receipts live for one daemon process, as they did before
/// they moved onto the shared receipt table.
fn browser_journal() -> anyhow::Result<Connection> {
    let connection = Connection::open_in_memory()?;
    receipts::ensure(&connection)?;
    Ok(connection)
}
pub(super) fn serve(socket: String, directory: PathBuf) -> anyhow::Result<()> {
    // Lock the original directory before recovery or supervisor ownership changes.
    let _writer = runtime::lock(&directory, "writer.lock")?;
    let directory = std::fs::canonicalize(directory)?;
    anyhow::ensure!(
        UnixStream::connect(&socket).is_err(),
        "A daemon is already listening at {socket}"
    );
    let runtime = Arc::new(Supervisor::connect(&directory)?);
    let sessions = Sessions::open(&directory.join("sessions.sqlite"), runtime.clone())?;
    for name in [
        "sessions.sqlite",
        "sessions.sqlite-wal",
        "sessions.sqlite-shm",
    ] {
        let path = directory.join(name);
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    // Installed launches restore the catalogue, or wait for workspace.open.
    // They must never turn the app bundle or Finder's cwd into an editable project.
    let selection = std::env::var_os("ADE_ROOT").is_none()
        && std::env::var("ADE_WORKSPACE_SELECTION").as_deref() == Ok("1");
    let pending_rebind = sessions.has_pending_rebind()?;
    let default_workspace = if selection {
        let catalog = sessions.command(&json!({"op":"catalog.get"}))?;
        catalog["catalog"]["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|workspace| {
                let path = Path::new(workspace["root"].as_str().unwrap_or_default());
                !(path.file_name().is_some_and(|name| name == "Resources")
                    && path.parent().is_some_and(|parent| {
                        parent.file_name().is_some_and(|name| name == "Contents")
                    }))
            })
            .and_then(|workspace| workspace["id"].as_str())
            .unwrap_or_default()
            .to_owned()
    } else {
        let root = std::env::var("ADE_ROOT")
            .unwrap_or(std::env::current_dir()?.to_string_lossy().into_owned());
        if pending_rebind {
            // A restored catalogue may not contain this launcher root. Never
            // create a new fenced workspace merely to start the daemon.
            let root = std::fs::canonicalize(&root)
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned))
                .unwrap_or(root);
            let catalog = sessions.command(&json!({"op":"catalog.get"}))?;
            catalog["catalog"]["workspaces"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|workspace| workspace["root"] == root)
                .and_then(|workspace| workspace["id"].as_str())
                .unwrap_or_default()
                .to_owned()
        } else {
            sessions.open_workspace(&root)?.id
        }
    };

    let host = Arc::new(Host {
        socket: PathBuf::from(&socket),
        directory: directory.clone(),
        profile_id: daemon_browser_profile(&socket)?,
        sessions,
        runtime,
        default_workspace,
        leases: Mutex::new(HashMap::new()),
        browser_owner: Mutex::new(None),
        browser_receipts: Mutex::new(browser_journal()?),
        browser_budget: ProbeBudget {
            active: Mutex::new(0),
            available: Condvar::new(),
        },
        proxy_probe: ProbeBudget {
            active: Mutex::new(0),
            available: Condvar::new(),
        },
        admission: RwLock::new(()),
        stopping: AtomicBool::new(false),
    });
    host.refresh_leases()?;
    if !selection
        && !pending_rebind
        && host
            .sessions
            .ensure_workspace_bound(&host.default_workspace)
            .is_ok()
    {
        host.ensure_terminal(&host.default_workspace, None, false)?;
    }
    let (listener, _socket) = runtime::SocketGuard::bind(Path::new(&socket))?;
    eprintln!(
        "lux-ade daemon {} listening at {socket}; runtime {}; durable state {}",
        std::process::id(),
        host.runtime.pid,
        directory.display()
    );
    while !host.stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if host.stopping.load(Ordering::Acquire) {
                    break;
                }
                let host = host.clone();
                std::thread::spawn(move || {
                    let mut errors = stream.try_clone().ok();
                    if let Err(error) = handle_connection(stream, host)
                        && let Some(stream) = errors.as_mut()
                    {
                        let _ = writeln!(stream, "{}", error_response(error));
                    }
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(e.into()),
        }
    }
    // Returning ends remaining observer threads. No provider or Git worker may be
    // live in this process at this point; the supervisor retains providers and shells.
    Ok(())
}

#[cfg(test)]
mod error_envelope_tests {
    use super::*;
    #[test]
    fn classified_errors_have_stable_recovery_and_drop_sensitive_context() {
        let error = anyhow::Error::new(ade_core::error::Failure::Authentication)
            .context("provider payload secret");
        let response = error_response(error);
        assert_eq!(response["code"], "authentication");
        assert_eq!(response["recovery"], "sign_in");
        assert!(!response.to_string().contains("secret"));
        let response = error_response(ade_core::error::TransportError::OutcomeUnknown);
        assert_eq!(response["code"], "outcome_unknown");
        assert_eq!(response["recovery"], "reconnect_and_reconcile");
    }
    #[test]
    fn browser_fingerprint_matches_the_owner_recomputation() {
        // The desktop owner recomputes sha256(JSON.stringify([op, profile,
        // owner, tab ?? null, url ?? null])) and refuses a mismatch.
        for payload in [
            browser_payload(
                "browser.open",
                "fixed",
                "owner-1",
                None,
                Some("https://example.com/a?b=\"c\""),
            ),
            browser_payload("browser.close", "fixed", "owner-1", Some("tab_1"), None),
        ] {
            let legacy = format!("{:x}", Sha256::digest(payload.to_string().as_bytes()));
            assert_eq!(receipts::fingerprint(&payload), legacy);
        }
    }
    #[test]
    fn browser_replays_keep_their_error_codes() {
        let replay = |status| {
            browser_replay(Ok(Admission::Replay(receipts::Receipt {
                status,
                result: Some(json!({"type": "browser_mutation"})),
            })))
            .unwrap()
        };
        assert_eq!(replay(Status::Dispatched)["code"], "in_progress");
        assert_eq!(replay(Status::Unknown)["code"], "outcome_unknown");
        assert_eq!(replay(Status::Settled)["type"], "browser_mutation");
        assert_eq!(
            browser_replay(Ok(Admission::Conflict)).unwrap()["code"],
            "conflict"
        );
        assert!(browser_replay(Ok(Admission::New)).is_none());
    }
    #[test]
    fn browser_receipt_names_its_owner_from_dispatch_to_settlement() {
        let mut connection = browser_journal().unwrap();
        let payload = browser_payload("browser.close", "fixed", "owner-1", Some("tab_1"), None);
        let admission = connection.transaction().unwrap();
        assert_eq!(
            receipts::begin(&admission, "op-1", "browser.close", &payload, None, 1).unwrap(),
            Admission::New
        );
        let owner = json!({"owner_id": "owner-1"});
        receipts::settle(&admission, "op-1", Status::Dispatched, Some(&owner), 1).unwrap();
        admission.commit().unwrap();
        receipts::settle(&connection, "op-1", Status::Unknown, None, 2).unwrap();
        let receipt = browser_receipt(&connection, "op-1").unwrap();
        assert_eq!(receipt.status, Status::Unknown);
        assert_eq!(receipt.owner_id(), "owner-1");
        assert_eq!(receipt.fingerprint, receipts::fingerprint(&payload));
        let probe = connection.transaction().unwrap();
        assert!(receipts::begin(&probe, "op-2", "browser.close", &payload, None, 3).is_ok());
        drop(probe);
        assert!(browser_receipt(&connection, "op-2").is_none());
    }
    #[test]
    fn unclassified_validation_errors_preserve_compatible_shape() {
        assert_eq!(
            error_response(anyhow::anyhow!("Invalid draft revision")),
            json!({"type":"error","message":"Invalid draft revision"})
        );
    }
}
