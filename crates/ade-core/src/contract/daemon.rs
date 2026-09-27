//! Daemon control, feed and browser owner contracts.
//!
//! The daemon answers `hello`, `runtime.*` and `session.subscribe` itself, and
//! relays `browser.*` reads and mutations to the registered browser owner (the
//! desktop main process). Browser owner replies carry the owner's own field
//! names, including the camelCase tab records.
use super::workspaces::CatalogFrame;
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<HelloRequest, DaemonHello>("hello", Tier::Query),
        OperationSpec::new::<RuntimeStatusRequest, RuntimeStatus>("runtime.status", Tier::Query),
        OperationSpec::new::<RuntimePrepareRestartRequest, RestartPrepared>(
            "runtime.prepare_restart",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<SessionSubscribeRequest, CatalogFrame>(
            "session.subscribe",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserOwnerGetRequest, BrowserOwnerReply>(
            "browser.owner.get",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserOwnerRegisterRequest, BrowserOwnerReply>(
            "browser.owner.register",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserOwnerUnregisterRequest, BrowserOwnerReleased>(
            "browser.owner.unregister",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserListRequest, BrowserTabs>("browser.list", Tier::Query),
        OperationSpec::new::<BrowserInspectRequest, BrowserTabReply>(
            "browser.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserOpenRequest, BrowserMutation>(
            "browser.open",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<BrowserNavigateRequest, BrowserMutation>(
            "browser.navigate",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<BrowserCloseRequest, BrowserMutation>(
            "browser.close",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<BrowserOperationRequest, BrowserOperation>(
            "browser.operation",
            Tier::Query,
        ),
        OperationSpec::new::<DiagnosticsStatusRequest, DiagnosticsStatus>(
            "diagnostics.status",
            Tier::Query,
        ),
        OperationSpec::new::<DiagnosticsExportRequest, DiagnosticsExport>(
            "diagnostics.export",
            Tier::Query,
        ),
        OperationSpec::new::<RuntimeRecoveryRequest, RuntimeRecovery>(
            "runtime.recovery",
            Tier::Query,
        ),
        OperationSpec::new::<RuntimeRecoveryReleaseRequest, RuntimeRecoveryReleased>(
            "runtime.recovery.release",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    // The services domain owns the `service_changed` frame.
    vec![]
}

/// Keeps an explicit JSON `null` distinct from an absent field: absent is
/// `None` (by `default`), and `null` is `Some(Value::Null)`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// `hello`: the handshake every connection sends first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct HelloRequest {}

/// `runtime.status`: read the daemon and runtime supervisor state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct RuntimeStatusRequest {}

/// `runtime.prepare_restart`: drain the daemon so a new build can take over.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RuntimePrepareRestartRequest {
    /// The `boot_id` from `runtime.status`; a different daemon refuses.
    pub boot_id: String,
}

/// `session.subscribe`: turn this connection into the feed. The reply is the
/// first `catalog` frame; later lines are feed frames.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SessionSubscribeRequest {}

/// `browser.owner.get`: read the live browser owner of a profile.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct BrowserOwnerGetRequest {
    /// Defaults to this daemon's browser profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// `browser.owner.register`: name the Unix socket that owns the profile's browser.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOwnerRegisterRequest {
    pub profile_id: String,
    pub owner_id: String,
    /// An absolute path to a private, owned Unix socket.
    pub socket_path: String,
}

/// `browser.owner.unregister`: release the owner registration.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOwnerUnregisterRequest {
    pub profile_id: String,
    pub owner_id: String,
}

/// `browser.list`: list the tabs under one exact owner.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserListRequest {
    pub profile_id: String,
    pub owner_id: String,
}

/// `browser.inspect`: inspect one exact tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserInspectRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
}

/// `browser.open`: open a tab. `operation_id` is the caller-owned operation
/// ID; the daemon still accepts it as `request_id`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOpenRequest {
    pub profile_id: String,
    pub owner_id: String,
    #[serde(alias = "request_id")]
    pub operation_id: String,
    /// An `http://` or `https://` URL of at most 8192 bytes.
    pub url: String,
    /// The browser partition the tab lives in, from `browser.partition.list`.
    /// The `default` partition when absent. The partition is part of the
    /// operation's fingerprint only when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_id: Option<String>,
}

/// `browser.navigate`: load a URL in an exact tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserNavigateRequest {
    pub profile_id: String,
    pub owner_id: String,
    #[serde(alias = "request_id")]
    pub operation_id: String,
    pub tab_id: String,
    pub url: String,
}

/// `browser.close`: close an exact tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserCloseRequest {
    pub profile_id: String,
    pub owner_id: String,
    #[serde(alias = "request_id")]
    pub operation_id: String,
    pub tab_id: String,
}

/// `browser.operation`: read a browser mutation's receipt by its operation ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOperationRequest {
    /// Defaults to this daemon's browser profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(alias = "request_id")]
    pub operation_id: String,
}

wire_tag!(HelloTag, "hello");
wire_tag!(RuntimeStatusTag, "runtime_status");
wire_tag!(DaemonAckTag, "ack");
wire_tag!(BrowserOwnerTag, "browser_owner");
wire_tag!(BrowserTabsTag, "browser_tabs");
wire_tag!(BrowserTabTag, "browser_tab");
wire_tag!(BrowserMutationTag, "browser_mutation");
wire_tag!(BrowserOperationTag, "browser_operation");
wire_tag!(DiagnosticsStatusTag, "diagnostics_status");
wire_tag!(DiagnosticsExportTag, "diagnostics_export");
wire_tag!(RuntimeRecoveryTag, "runtime_recovery");
wire_tag!(RuntimeRecoveryReleasedTag, "runtime_recovery_released");

/// The `hello` reply: build identity and every protocol version.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DaemonHello {
    #[serde(rename = "type")]
    pub tag: HelloTag,
    /// `ADE_BUILD_ID`, or `null` when the daemon was built without one.
    pub build_id: Option<String>,
    pub application_protocol: String,
    pub runtime_protocol: String,
    pub runtime_instance: String,
    pub runtime_pid: u32,
    pub runtime_socket: String,
    pub pid: u32,
    pub session_protocol: String,
    pub worktree_protocol: String,
    pub review_protocol: String,
    pub response_owner: String,
    pub terminal_snapshot_format: String,
    pub terminal_snapshot_formats: Vec<String>,
    pub boot_id: String,
}

/// The `runtime.status` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RuntimeStatus {
    #[serde(rename = "type")]
    pub tag: RuntimeStatusTag,
    pub application_protocol: String,
    pub runtime_protocol: String,
    pub boot_id: String,
    pub pid: u32,
    pub runtime_pid: u32,
    pub runtime_instance: String,
    pub runtime_socket: String,
    pub connected_agents: u64,
    pub active_git_operations: u64,
    pub stopping: bool,
    /// The runtime supervisor's terminal list, relayed as it sends it.
    #[schemars(with = "Value")]
    pub terminals: Value,
    /// The runtime supervisor's agent runs without their command logs.
    #[schemars(with = "Value")]
    pub agents: Value,
}

/// The `runtime.prepare_restart` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RestartPrepared {
    #[serde(rename = "type")]
    pub tag: DaemonAckTag,
    pub boot_id: String,
    pub runtime_instance: String,
}

/// The `browser.owner.get` and `browser.owner.register` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOwnerReply {
    #[serde(rename = "type")]
    pub tag: BrowserOwnerTag,
    pub profile_id: String,
    pub owner_id: String,
}

/// The `browser.owner.unregister` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOwnerReleased {
    #[serde(rename = "type")]
    pub tag: DaemonAckTag,
    pub profile_id: String,
    pub owner_id: String,
}

/// One browser tab as the owner reports it. The owner uses camelCase names.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabRecord {
    pub id: String,
    /// The owner's browser storage profile.
    pub profile_id: String,
    pub requested_url: String,
    pub observed_url: String,
    pub title: String,
    pub loading: bool,
    pub error: String,
    /// The tab's browser partition; absent for `default`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_id: Option<String>,
}

/// The `browser.list` reply, relayed from the owner.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserTabs {
    #[serde(rename = "type")]
    pub tag: BrowserTabsTag,
    pub profile_id: String,
    pub owner_id: String,
    /// The owner's browser storage profile.
    #[serde(rename = "profileId")]
    pub browser_profile_id: String,
    #[serde(rename = "selectedId")]
    pub selected_id: Option<String>,
    pub tabs: Vec<BrowserTabRecord>,
}

/// The `browser.inspect` reply, relayed from the owner.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserTabReply {
    #[serde(rename = "type")]
    pub tag: BrowserTabTag,
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    pub tab: BrowserTabRecord,
}

/// The `browser.open`, `browser.navigate`, `browser.close`, `browser.click` and
/// `browser.type` reply, relayed from the owner. `payload_fingerprint` is the
/// daemon's fingerprint of the operation, its profile, owner, tab and URL, and
/// for click and type the selector and typed input.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserMutation {
    #[serde(rename = "type")]
    pub tag: BrowserMutationTag,
    pub profile_id: String,
    pub owner_id: String,
    pub request_id: String,
    pub payload_fingerprint: String,
    pub op: String,
    pub tab_id: String,
}

/// Where a browser mutation stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOperationState {
    /// The daemon admitted the mutation and has no outcome yet.
    Accepted,
    /// The outcome was lost; inspect before another action.
    Unknown,
    /// The outcome is known. After a crash the owner proves it from its tabs;
    /// `result` is then the mutation, or a `not_applied` error when the tabs
    /// show the effect never happened. A new request ID may then try again.
    Completed,
}

/// The `browser.operation` reply: the daemon's receipt, or the owner's.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserOperation {
    #[serde(rename = "type")]
    pub tag: BrowserOperationTag,
    pub profile_id: String,
    pub owner_id: String,
    pub request_id: String,
    pub payload_fingerprint: String,
    pub state: BrowserOperationState,
    /// The mutation's operation; only the owner's receipt carries it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    /// The completed mutation's reply. The daemon's receipt sends `null`
    /// before completion; the owner's omits it without a tab.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub result: Option<Value>,
}

/// `diagnostics.status`: read queue, counter, receipt, execution, claim and
/// retention state, with the reasons behind every unknown execution.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct DiagnosticsStatusRequest {}

/// `diagnostics.export`: build a bounded, redacted diagnostics bundle. The
/// daemon returns it; the caller decides where to save it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct DiagnosticsExportRequest {
    /// The most recent operational log records to include, from 0 to 1000.
    /// Defaults to 200.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = 1000))]
    pub max_events: Option<u32>,
}

/// How far a reported number can be trusted.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticProvenance {
    /// Read from the owner of the state at report time.
    Exact,
    /// Counted in memory or over a partial window; `note` says which.
    Approximate,
    /// The source could not be read; the value is absent.
    Unavailable,
}

/// The unit a queue gauge counts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticUnit {
    Items,
    Bytes,
}

/// What a diagnostic counter counts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCounterKind {
    Dropped,
    Coalesced,
}

/// The window a counter covers.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticWindow {
    /// Since this daemon process started; a restart resets it.
    DaemonBoot,
    /// Summed over the runtime's current terminal incarnations only.
    LiveIncarnations,
}

/// Where an unknown execution was found.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticUnknownSource {
    /// An effect receipt in `unknown` status.
    Receipt,
    /// A lease the daemon could not resolve after a restart.
    Claim,
    /// A runtime terminal whose exit could not be verified.
    Terminal,
    /// A Conversation whose run was interrupted or disconnected.
    Conversation,
    /// The runtime itself could not be observed.
    Runtime,
}

/// The identities a report correlates.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticIdentity {
    /// A stable, non-reversible key for this host: 16 hex digits of the
    /// SHA-256 of its host name, or `unknown`.
    pub host_key: String,
    pub os: String,
    pub arch: String,
    pub profile_id: String,
    pub boot_id: String,
    pub daemon_pid: u32,
    /// `ADE_BUILD_ID`, or `null` when the daemon was built without one.
    pub build_id: Option<String>,
    pub application_protocol: String,
    pub runtime_protocol: String,
    /// The runtime incarnation.
    pub runtime_instance: String,
    pub runtime_pid: u32,
}

/// The depth of one queue or spool.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticQueue {
    pub name: String,
    pub unit: DiagnosticUnit,
    /// `null` when the source was unavailable.
    pub depth: Option<u64>,
    /// The bound, when the queue has one.
    pub capacity: Option<u64>,
    pub provenance: DiagnosticProvenance,
    pub note: String,
}

/// A dropped or coalesced count.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticCounter {
    pub name: String,
    pub kind: DiagnosticCounterKind,
    /// `null` when the source was unavailable.
    pub value: Option<u64>,
    pub window: DiagnosticWindow,
    pub provenance: DiagnosticProvenance,
    pub note: String,
}

/// Effect receipts in one database, counted by status.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct DiagnosticReceipts {
    /// `sessions`, `lifecycle`, `review`, `plugins` or `browser`.
    pub store: String,
    /// False when the database could not be read; every count is then zero.
    pub available: bool,
    pub accepted: u64,
    pub dispatched: u64,
    pub acknowledged: u64,
    pub settled: u64,
    pub unknown: u64,
    pub expired: u64,
    /// Rows with a status this build does not know.
    pub other: u64,
    /// Unexpired receipts older than the retention window, awaiting pruning.
    pub past_retention: u64,
    /// Creation time of the oldest unexpired receipt, in Unix milliseconds.
    pub oldest_created_at: Option<i64>,
}

/// One live Agent run in the runtime.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticRun {
    pub conversation_id: String,
    /// The execution attempt.
    pub run_id: String,
    pub provider: String,
    pub pid: Option<u32>,
    /// Whether the run holds a pinned account context. The context itself is
    /// never reported.
    pub account_pinned: bool,
}

/// One runtime terminal.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticTerminal {
    pub workspace_id: String,
    pub terminal_id: String,
    pub run_id: Option<String>,
    /// The terminal incarnation.
    pub transfer_id: Option<String>,
    pub shell_running: bool,
    pub shell_pid: Option<u32>,
    pub clients: Option<u64>,
    pub scrollback_bytes: Option<u64>,
    pub reply_dropped_bytes: Option<u64>,
    /// The recorded exit kind, when the shell exited.
    pub exit_kind: Option<String>,
    pub durable_log_failed: bool,
}

/// One configured service and whether its terminal is live.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticService {
    pub workspace_id: String,
    pub name: String,
    /// The service identity.
    pub identity: String,
    pub revision: u64,
    pub terminal_id: Option<String>,
    /// The incarnation of the service's last run.
    pub last_run_transfer_id: Option<String>,
    /// `null` when the runtime was not observed.
    pub running: Option<bool>,
}

/// Live execution as the runtime reports it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticLive {
    /// False when the runtime could not be asked; runs and terminals are then
    /// empty and every service's `running` is `null`.
    pub observed: bool,
    pub runtime_instance: String,
    pub runs: Vec<DiagnosticRun>,
    pub terminals: Vec<DiagnosticTerminal>,
    pub services: Vec<DiagnosticService>,
}

/// A lease the daemon holds as unresolved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticUnresolvedClaim {
    /// `agent`, `service` or `script`.
    pub kind: String,
    pub workspace_id: String,
    /// The Conversation ID, service name or script run ID.
    pub subject: String,
    /// The run or terminal incarnation the lease expects, when recorded.
    pub incarnation: Option<String>,
    pub reason: String,
    /// Whether the unresolved lease still holds the worktree lease.
    pub holds_worktree: bool,
}

/// Lease and claim state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticClaims {
    /// Workspaces whose worktree lease a live terminal holds.
    pub terminal_worktree_leases: Vec<String>,
    /// Worktree leases the session layer holds for service and script terminals.
    pub session_worktree_leases: u64,
    pub unresolved: Vec<DiagnosticUnresolvedClaim>,
    pub active_git_operations: u64,
}

/// The local diagnostic log folder against its budget.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticLogs {
    pub available: bool,
    pub files: u64,
    pub bytes: u64,
    /// Rotated files kept per process.
    pub max_files_per_process: u64,
    /// Bytes one process may write to its current daily file.
    pub daily_byte_budget: u64,
}

/// Retention state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticRetention {
    pub receipt_retention_ms: i64,
    /// Receipts past retention across every readable store, awaiting pruning.
    pub receipts_past_retention: u64,
    pub logs: DiagnosticLogs,
    /// Bytes of stored attachment data, or `null` when unreadable.
    pub attachment_bytes: Option<u64>,
}

/// One execution whose outcome ADE cannot prove, and why.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticUnknown {
    pub source: DiagnosticUnknownSource,
    /// The operation, Conversation, terminal or claim subject.
    pub subject: String,
    /// The operation name, for a receipt.
    pub operation: Option<String>,
    /// The store or workspace that holds it.
    pub scope: Option<String>,
    pub reason: String,
    /// When it was last updated, in Unix milliseconds.
    pub since: Option<i64>,
}

/// The `diagnostics.status` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticsStatus {
    #[serde(rename = "type")]
    pub tag: DiagnosticsStatusTag,
    /// Unix milliseconds.
    pub generated_at: i64,
    pub identity: DiagnosticIdentity,
    pub queues: Vec<DiagnosticQueue>,
    pub counters: Vec<DiagnosticCounter>,
    pub receipts: Vec<DiagnosticReceipts>,
    pub live: DiagnosticLive,
    pub claims: DiagnosticClaims,
    pub retention: DiagnosticRetention,
    /// At most 100 entries.
    pub unknown: Vec<DiagnosticUnknown>,
    /// Whether `unknown` was cut to its bound.
    pub unknown_truncated: bool,
    /// Fixed descriptions of sources that could not be read.
    pub degraded: Vec<String>,
}

/// What redaction removed from a bundle.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct DiagnosticRedaction {
    /// The rule set's version.
    pub policy: String,
    /// Values dropped because their key names a credential.
    pub credential_fields: u64,
    /// Values dropped because their key names transcript or output content.
    pub transcript_fields: u64,
    /// Credential-shaped substrings replaced inside strings.
    pub secret_patterns: u64,
    /// Home-directory prefixes replaced with `~`.
    pub home_paths: u64,
    /// Strings, arrays, objects or nesting cut to their bounds.
    pub truncations: u64,
}

/// The `diagnostics.export` reply: a bounded, redacted, inspectable bundle.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DiagnosticsExport {
    #[serde(rename = "type")]
    pub tag: DiagnosticsExportTag,
    /// The bundle format, `ade-diagnostics-v1`.
    pub format: String,
    pub generated_at: i64,
    /// The bound the serialized bundle stays under.
    pub max_bytes: u64,
    /// What the bundle never contains.
    pub excluded: Vec<String>,
    pub redaction: DiagnosticRedaction,
    pub status: DiagnosticsStatus,
    /// Allow-listed operational log records, oldest first. Each carries only
    /// known fields: event, timestamp, process, pid, diagnostic and run IDs,
    /// operation family, elapsed time and fixed error codes.
    pub events: Vec<Value>,
    /// Whether older records were left out to meet a bound.
    pub events_truncated: bool,
}

/// `runtime.recovery`: read the reports the daemon wrote when it found that
/// the runtime restarted under a new incarnation. Newest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct RuntimeRecoveryRequest {
    /// Only reports that still hold a quarantined or unknown attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_only: Option<bool>,
}

/// `runtime.recovery.release`: accept an `unknown` attempt as stopped without
/// proof, so its workspace can admit new work. An attempt whose processes are
/// observed running is refused. Nothing is replayed. Repeating it after the
/// attempt is resolved returns the same report.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RuntimeRecoveryReleaseRequest {
    pub report_id: String,
    /// The attempt's `key` from the report.
    pub attempt_key: String,
}

/// What kind of execution an old runtime incarnation owned.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveredAttemptKind {
    /// A Conversation's provider run and its turn, if one was in flight.
    ProviderTurn,
    /// A plain workspace terminal shell.
    Terminal,
    /// A reserved service run.
    Service,
    /// A script run.
    Script,
}

/// How runtime restart reconciliation classified one attempt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryClassification {
    /// Positive evidence that nothing observed from the attempt still runs.
    Settled,
    /// Processes from the attempt still run without an owner. Its resources
    /// stay reserved until they exit.
    Quarantined,
    /// No evidence either way. Its resources stay reserved until evidence
    /// appears or the user releases it.
    Unknown,
}

/// One attempt an old runtime incarnation owned.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RecoveredAttempt {
    /// Stable within the report: `agent:<conversation>`,
    /// `terminal:<workspace>:<terminal>`, `service:<workspace>:<name>` or
    /// `script:<workspace>:<run>`.
    pub key: String,
    pub kind: RecoveredAttemptKind,
    pub workspace_id: String,
    /// The Conversation ID, terminal ID, service name or script run ID.
    pub subject: String,
    /// The run ID or terminal transfer ID, when recorded.
    pub attempt: Option<String>,
    /// The runtime incarnation that owned it, when recorded.
    pub runtime_instance: Option<String>,
    pub classification: RecoveryClassification,
    /// The evidence behind the classification, in one sentence.
    pub reason: String,
    /// Processes observed still running, for a quarantined attempt.
    pub pids: Vec<u32>,
    /// A provider turn was in flight: its effects are unknown and it was not replayed.
    pub outcome_unknown: bool,
    /// When a later observation or the user resolved a quarantined or unknown attempt.
    pub resolved_at: Option<i64>,
    /// How it was resolved.
    pub resolution: Option<String>,
}

/// One runtime restart reconciliation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryReport {
    pub id: String,
    /// The runtime incarnations that had stopped.
    pub previous_instances: Vec<String>,
    /// The runtime incarnation the daemon found instead.
    pub current_instance: String,
    pub detected_at: i64,
    pub attempts: Vec<RecoveredAttempt>,
    /// Attempts still quarantined or unknown and not resolved.
    pub open: u32,
}

/// The `runtime.recovery` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RuntimeRecovery {
    #[serde(rename = "type")]
    pub tag: RuntimeRecoveryTag,
    pub current_instance: String,
    pub reports: Vec<RecoveryReport>,
}

/// The `runtime.recovery.release` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RuntimeRecoveryReleased {
    #[serde(rename = "type")]
    pub tag: RuntimeRecoveryReleasedTag,
    pub attempt_key: String,
    pub report: RecoveryReport,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{DEFINITIONS, bundle};
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn validator(name: &str) -> jsonschema::Validator {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("{DEFINITIONS}{name}"),
        });
        jsonschema::validator_for(&schema).expect("generated schema compiles")
    }

    fn operation(op: &str) -> (String, String) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
        )
    }

    fn assert_valid(name: &str, value: &Value) {
        let errors: Vec<_> = validator(name)
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    /// A wire request, as a client sends it, decodes and re-encodes unchanged.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let (name, _) = operation(op);
        let mut line = wire.clone();
        line["op"] = json!(op);
        assert_valid(&name, &line);
        let decoded: T = serde_json::from_value(line).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
        decoded
    }

    /// A wire reply, as the daemon sends it today, decodes and re-encodes unchanged.
    fn reply<T: Serialize + DeserializeOwned>(name: &str, wire: Value) -> T {
        assert_valid(name, &wire);
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
        decoded
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let (_, name) = operation(op);
        reply(&name, wire)
    }

    fn tab() -> Value {
        json!({"id": "tab_1", "profileId": "fixed", "requestedUrl": "https://example.com/",
            "observedUrl": "", "title": "Example", "loading": false, "error": ""})
    }

    #[test]
    fn every_daemon_operation_declares_its_tier() {
        let bundle = bundle();
        let tiers: Vec<_> = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|spec| spec["domain"] == "daemon")
            .map(|spec| {
                (
                    spec["name"].as_str().unwrap().to_owned(),
                    spec["tier"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let expected: Vec<_> = [
            ("hello", "query"),
            ("runtime.status", "query"),
            ("runtime.prepare_restart", "effect_command"),
            ("session.subscribe", "query"),
            ("browser.owner.get", "query"),
            ("browser.owner.register", "idempotent_command"),
            ("browser.owner.unregister", "idempotent_command"),
            ("browser.list", "query"),
            ("browser.inspect", "query"),
            ("browser.open", "effect_command"),
            ("browser.navigate", "effect_command"),
            ("browser.close", "effect_command"),
            ("browser.operation", "query"),
            ("diagnostics.status", "query"),
            ("diagnostics.export", "query"),
            ("runtime.recovery", "query"),
            ("runtime.recovery.release", "idempotent_command"),
        ]
        .iter()
        .map(|(name, tier)| ((*name).to_owned(), (*tier).to_owned()))
        .collect();
        assert_eq!(tiers, expected);
    }

    #[test]
    fn control_operations_round_trip() {
        request::<HelloRequest>("hello", json!({}));
        response::<DaemonHello>(
            "hello",
            json!({"type": "hello", "build_id": null, "application_protocol": "ade-application-v1",
                "runtime_protocol": "ade-runtime-v8", "runtime_instance": "instance_1",
                "runtime_pid": 11, "runtime_socket": "/tmp/runtime.sock", "pid": 12,
                "session_protocol": "ade-sessions-v1", "worktree_protocol": "ade-worktrees-v1",
                "review_protocol": "ade-review-v1", "response_owner": "daemon-v1",
                "terminal_snapshot_format": "ghostty-snapshot-v1-herdr-9c96f7d",
                "terminal_snapshot_formats": ["ghostty-snapshot-v1-herdr-9c96f7d", "xterm-replay-v1"],
                "boot_id": "boot_1"}),
        );
        request::<RuntimeStatusRequest>("runtime.status", json!({}));
        response::<RuntimeStatus>(
            "runtime.status",
            json!({"type": "runtime_status", "application_protocol": "ade-application-v1",
                "runtime_protocol": "ade-runtime-v8", "boot_id": "boot_1", "pid": 12,
                "runtime_pid": 11, "runtime_instance": "instance_1",
                "runtime_socket": "/tmp/runtime.sock", "connected_agents": 0,
                "active_git_operations": 0, "stopping": false,
                "terminals": [{"workspace": {"id": "workspace_1"}}], "agents": null}),
        );
        request::<RuntimePrepareRestartRequest>(
            "runtime.prepare_restart",
            json!({"boot_id": "boot_1"}),
        );
        response::<RestartPrepared>(
            "runtime.prepare_restart",
            json!({"type": "ack", "boot_id": "boot_1", "runtime_instance": "instance_1"}),
        );
        request::<SessionSubscribeRequest>("session.subscribe", json!({}));
        assert_eq!(operation("session.subscribe").1, "CatalogFrame");
    }

    #[test]
    fn browser_owner_operations_round_trip() {
        let get: BrowserOwnerGetRequest = request("browser.owner.get", json!({}));
        assert!(get.profile_id.is_none());
        request::<BrowserOwnerGetRequest>("browser.owner.get", json!({"profile_id": "fixed"}));
        request::<BrowserOwnerRegisterRequest>(
            "browser.owner.register",
            json!({"profile_id": "fixed", "owner_id": "owner_1", "socket_path": "/tmp/o.sock"}),
        );
        request::<BrowserOwnerUnregisterRequest>(
            "browser.owner.unregister",
            json!({"profile_id": "fixed", "owner_id": "owner_1"}),
        );
        let owner = json!({"type": "browser_owner", "profile_id": "fixed", "owner_id": "owner_1"});
        response::<BrowserOwnerReply>("browser.owner.get", owner.clone());
        response::<BrowserOwnerReply>("browser.owner.register", owner);
        response::<BrowserOwnerReleased>(
            "browser.owner.unregister",
            json!({"type": "ack", "profile_id": "fixed", "owner_id": "owner_1"}),
        );
    }

    #[test]
    fn browser_reads_round_trip() {
        request::<BrowserListRequest>(
            "browser.list",
            json!({"profile_id": "fixed", "owner_id": "owner_1"}),
        );
        request::<BrowserInspectRequest>(
            "browser.inspect",
            json!({"profile_id": "fixed", "owner_id": "owner_1", "tab_id": "tab_1"}),
        );
        response::<BrowserTabs>(
            "browser.list",
            json!({"type": "browser_tabs", "profile_id": "fixed", "owner_id": "owner_1",
                "profileId": "fixed", "selectedId": "tab_1", "tabs": [tab()]}),
        );
        response::<BrowserTabs>(
            "browser.list",
            json!({"type": "browser_tabs", "profile_id": "fixed", "owner_id": "owner_1",
                "profileId": "fixed", "selectedId": null, "tabs": []}),
        );
        response::<BrowserTabReply>(
            "browser.inspect",
            json!({"type": "browser_tab", "profile_id": "fixed", "owner_id": "owner_1",
                "tab_id": "tab_1", "tab": tab()}),
        );
    }

    #[test]
    fn browser_mutations_accept_operation_id_and_legacy_request_id() {
        let open: BrowserOpenRequest = request(
            "browser.open",
            json!({"profile_id": "fixed", "owner_id": "owner_1", "operation_id": "op_1",
                "url": "https://example.com/"}),
        );
        assert_eq!(open.operation_id, "op_1");
        request::<BrowserNavigateRequest>(
            "browser.navigate",
            json!({"profile_id": "fixed", "owner_id": "owner_1", "operation_id": "op_2",
                "tab_id": "tab_1", "url": "https://example.com/"}),
        );
        request::<BrowserCloseRequest>(
            "browser.close",
            json!({"profile_id": "fixed", "owner_id": "owner_1", "operation_id": "op_3",
                "tab_id": "tab_1"}),
        );
        let legacy: BrowserCloseRequest = serde_json::from_value(json!({"op": "browser.close",
            "profile_id": "fixed", "owner_id": "owner_1", "request_id": "op_3", "tab_id": "tab_1"}))
        .unwrap();
        assert_eq!(legacy.operation_id, "op_3");
        let lookup: BrowserOperationRequest =
            serde_json::from_value(json!({"op": "browser.operation", "request_id": "op_3"}))
                .unwrap();
        assert_eq!(lookup.operation_id, "op_3");
        request::<BrowserOperationRequest>("browser.operation", json!({"operation_id": "op_3"}));
        response::<BrowserMutation>(
            "browser.open",
            json!({"type": "browser_mutation", "profile_id": "fixed", "owner_id": "owner_1",
                "request_id": "op_1", "payload_fingerprint": "a".repeat(64), "op": "browser.open",
                "tab_id": "tab_1"}),
        );
    }

    #[test]
    fn browser_operation_keeps_null_and_absent_results_apart() {
        let fingerprint = "b".repeat(64);
        let local: BrowserOperation = response(
            "browser.operation",
            json!({"type": "browser_operation", "profile_id": "fixed", "owner_id": "owner_1",
                "request_id": "op_1", "payload_fingerprint": fingerprint, "state": "accepted",
                "result": null}),
        );
        assert_eq!(local.result, Some(Value::Null));
        let pending: BrowserOperation = response(
            "browser.operation",
            json!({"type": "browser_operation", "profile_id": "fixed", "owner_id": "owner_1",
                "request_id": "op_1", "payload_fingerprint": fingerprint, "state": "unknown",
                "op": "browser.close"}),
        );
        assert!(pending.result.is_none());
        response::<BrowserOperation>(
            "browser.operation",
            json!({"type": "browser_operation", "profile_id": "fixed", "owner_id": "owner_1",
                "request_id": "op_1", "payload_fingerprint": fingerprint, "state": "completed",
                "result": {"type": "error", "code": "conflict", "message": "Busy"}}),
        );
        assert!(
            !validator("BrowserOperation").is_valid(&json!({"type": "browser_operation",
            "profile_id": "fixed", "owner_id": "owner_1", "request_id": "op_1",
            "payload_fingerprint": fingerprint, "state": "done"}))
        );
    }

    fn diagnostics_status_wire() -> Value {
        json!({"type": "diagnostics_status", "generated_at": 1_700_000_000_000_i64,
            "identity": {"host_key": "0123456789abcdef", "os": "macos", "arch": "aarch64",
                "profile_id": "fixed-1", "boot_id": "boot_1", "daemon_pid": 12, "build_id": null,
                "application_protocol": "ade-application-v1", "runtime_protocol": "ade-runtime-v8",
                "runtime_instance": "instance_1", "runtime_pid": 11},
            "queues": [{"name": "conversation.queued_prompts", "unit": "items", "depth": 2,
                "capacity": null, "provenance": "exact", "note": ""},
                {"name": "send.outbox", "unit": "items", "depth": null, "capacity": null,
                "provenance": "unavailable", "note": "sessions store unreadable"}],
            "counters": [{"name": "feed.subscribers_evicted", "kind": "dropped", "value": 0,
                "window": "daemon_boot", "provenance": "approximate", "note": ""}],
            "receipts": [{"store": "sessions", "available": true, "accepted": 0, "dispatched": 1,
                "acknowledged": 0, "settled": 4, "unknown": 1, "expired": 0, "other": 0,
                "past_retention": 0, "oldest_created_at": 1_699_000_000_000_i64}],
            "live": {"observed": true, "runtime_instance": "instance_1",
                "runs": [{"conversation_id": "conversation_1", "run_id": "run_1",
                    "provider": "codex", "pid": 42, "account_pinned": true}],
                "terminals": [{"workspace_id": "workspace_1", "terminal_id": "terminal_1",
                    "run_id": "run_2", "transfer_id": "transfer_1", "shell_running": true,
                    "shell_pid": 43, "clients": 1, "scrollback_bytes": 10,
                    "reply_dropped_bytes": 0, "exit_kind": null, "durable_log_failed": false}],
                "services": [{"workspace_id": "workspace_1", "name": "web", "identity": "service_1",
                    "revision": 3, "terminal_id": "terminal_2", "last_run_transfer_id": null,
                    "running": null}]},
            "claims": {"terminal_worktree_leases": ["workspace_1"], "session_worktree_leases": 1,
                "unresolved": [{"kind": "agent", "workspace_id": "workspace_1",
                    "subject": "conversation_1", "incarnation": "run_1",
                    "reason": "the runtime Agent catalogue was not observed", "holds_worktree": true}],
                "active_git_operations": 0},
            "retention": {"receipt_retention_ms": 2_592_000_000_i64, "receipts_past_retention": 0,
                "logs": {"available": true, "files": 2, "bytes": 100, "max_files_per_process": 7,
                    "daily_byte_budget": 8_388_608},
                "attachment_bytes": null},
            "unknown": [{"source": "receipt", "subject": "op_1", "operation": "terminal.create",
                "scope": "sessions", "reason": "the outcome was lost", "since": 1_700_000_000_000_i64}],
            "unknown_truncated": false,
            "degraded": []})
    }

    #[test]
    fn diagnostics_operations_round_trip() {
        request::<DiagnosticsStatusRequest>("diagnostics.status", json!({}));
        response::<DiagnosticsStatus>("diagnostics.status", diagnostics_status_wire());
        let export: DiagnosticsExportRequest = request("diagnostics.export", json!({}));
        assert!(export.max_events.is_none());
        request::<DiagnosticsExportRequest>("diagnostics.export", json!({"max_events": 0}));
        let (name, _) = operation("diagnostics.export");
        assert!(
            !validator(&name).is_valid(&json!({"op": "diagnostics.export", "max_events": 1001}))
        );
        response::<DiagnosticsExport>(
            "diagnostics.export",
            json!({"type": "diagnostics_export", "format": "ade-diagnostics-v1",
                "generated_at": 1_700_000_000_000_i64, "max_bytes": 1_048_576,
                "excluded": ["credentials"],
                "redaction": {"policy": "ade-redaction-v1", "credential_fields": 0,
                    "transcript_fields": 0, "secret_patterns": 1, "home_paths": 0, "truncations": 0},
                "status": diagnostics_status_wire(),
                "events": [{"event": "rpc_failed", "operation_family": "agent"}],
                "events_truncated": true}),
        );
    }

    #[test]
    fn runtime_recovery_operations_round_trip() {
        let all: RuntimeRecoveryRequest = request("runtime.recovery", json!({}));
        assert!(all.open_only.is_none());
        request::<RuntimeRecoveryRequest>("runtime.recovery", json!({"open_only": true}));
        request::<RuntimeRecoveryReleaseRequest>(
            "runtime.recovery.release",
            json!({"report_id": "recovery_1", "attempt_key": "script:workspace_1:run_2"}),
        );
        let report = json!({"id": "recovery_1", "previous_instances": ["instance_0"],
            "current_instance": "instance_1", "detected_at": 1_700_000_000_000_i64, "open": 1,
            "attempts": [{"key": "agent:conversation_1", "kind": "provider_turn",
                "workspace_id": "workspace_1", "subject": "conversation_1", "attempt": "run_1",
                "runtime_instance": "instance_0", "classification": "settled",
                "reason": "the provider process exited mid-turn", "pids": [],
                "outcome_unknown": true, "resolved_at": null, "resolution": null},
                {"key": "script:workspace_1:run_2", "kind": "script", "workspace_id": "workspace_1",
                "subject": "run_2", "attempt": null, "runtime_instance": null,
                "classification": "quarantined", "reason": "2 processes still run",
                "pids": [41, 42], "outcome_unknown": false, "resolved_at": null,
                "resolution": null}]});
        response::<RuntimeRecovery>(
            "runtime.recovery",
            json!({"type": "runtime_recovery", "current_instance": "instance_1",
                "reports": [report.clone()]}),
        );
        response::<RuntimeRecoveryReleased>(
            "runtime.recovery.release",
            json!({"type": "runtime_recovery_released", "attempt_key": "script:workspace_1:run_2",
                "report": report}),
        );
        let (name, _) = operation("runtime.recovery.release");
        assert!(!validator(&name).is_valid(&json!({"op": "runtime.recovery.release"})));
    }
}
