//! Provider capabilities, readiness, presets and quota (F027-F030, decision D04).
//!
//! Each adapter declares a revisioned [`CapabilityRecord`] of what its provider
//! actually offers and what ADE can select through it today. A capability the
//! provider has but the adapter does not expose is `native_only`; one nobody
//! has confirmed is `unknown`. Neither is ever reported as supported.
//!
//! Presets are named combinations of provider, model, reasoning and permission
//! mode stored in the profile. They never carry an account, so applying one
//! cannot change account identity. Every read revalidates a preset against the
//! current record and reports conflicts instead of silently adapting it.
//!
//! Quota visibility reads the rate-limit windows the usage domain recorded.
//! ADE never switches account or model when a limit is exhausted.
//!
//! [`adapters`] holds the profile-scoped generic adapter definitions (F024).
//!
//! `provider.registrations` reports every provider registered through the
//! runtime's one provider interface: bundled, adapter and plugin (F023).
use super::usage::{UsageLimitWindow, UsageRecording};
use super::{FrameSpec, OperationSpec, Tier};
use crate::requests::RequestAnswer;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub mod adapters;

pub fn operations() -> Vec<OperationSpec> {
    let mut operations = vec![
        OperationSpec::new::<ProviderCapabilitiesRequest, ProviderCapabilities>(
            "provider.capabilities",
            Tier::Query,
        ),
        // Reads the filesystem and, with an account, runs the provider's
        // read-only status probe. Changes no state.
        OperationSpec::new::<ProviderReadinessRequest, ProviderReadiness>(
            "provider.readiness",
            Tier::Query,
        ),
        OperationSpec::new::<ProviderQuotaRequest, ProviderQuota>("provider.quota", Tier::Query),
        OperationSpec::new::<ProviderInspectRequest, ProviderInspect>(
            "provider.inspect",
            Tier::Query,
        ),
        // Replays every provider registration through the runtime's provider
        // registry and reports each outcome. Starts no worker.
        OperationSpec::new::<ProviderRegistrationsRequest, ProviderRegistrations>(
            "provider.registrations",
            Tier::Query,
        ),
        OperationSpec::new::<PresetListRequest, PresetList>("preset.list", Tier::Query),
        OperationSpec::new::<PresetGetRequest, PresetView>("preset.get", Tier::Query),
        // Guarded by the expected revision; saving the settings a preset
        // already has converges without a new revision.
        OperationSpec::new::<PresetSaveRequest, PresetSaved>(
            "preset.save",
            Tier::IdempotentCommand,
        ),
        // Guarded by the expected revision; deleting an absent preset converges.
        OperationSpec::new::<PresetDeleteRequest, PresetDeleted>(
            "preset.delete",
            Tier::IdempotentCommand,
        ),
    ];
    operations.extend(adapters::operations());
    operations
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// How far ADE supports one provider capability.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    /// The provider offers it and ADE can use it through this adapter.
    Supported,
    /// The provider offers it, but this adapter does not expose it yet.
    NativeOnly,
    /// The provider does not offer it.
    Unsupported,
    /// Nobody has confirmed whether the provider offers it.
    Unknown,
}

/// One capability and why it has that support.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct Capability {
    pub support: Support,
    /// The native mechanism, or what is missing.
    pub note: String,
}

impl Capability {
    pub fn new(support: Support, note: &str) -> Self {
        Self {
            support,
            note: note.into(),
        }
    }
}

/// The shape a provider expects a model ID in.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelFormat {
    /// Any ID or alias the provider accepts, such as `sonnet` or `gpt-5.5`.
    NativeId,
    /// `provider/model`, such as `anthropic/claude-sonnet-5`.
    ProviderQualified,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ModelCapabilities {
    /// Choosing a model when a conversation starts.
    pub selection: Capability,
    pub format: ModelFormat,
    /// Aliases the provider documents. The provider resolves them; ADE does
    /// not know which model an alias means today.
    pub aliases: Vec<String>,
    /// Listing the models an account can use.
    pub discovery: Capability,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ReasoningCapabilities {
    /// Choosing a reasoning level when a conversation starts.
    pub selection: Capability,
    /// The provider's own level names, weakest first.
    pub levels: Vec<String>,
    /// True when the provider offers a different subset per model.
    pub varies_by_model: bool,
}

/// One permission mode and its meaning.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PermissionModeCapability {
    /// The value a conversation's `permission_mode` takes.
    pub id: String,
    pub support: Support,
    pub description: String,
}

/// How long an approval can last. ADE never widens a grant while mapping it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct GrantCapabilities {
    /// Approving one request only.
    pub once: Capability,
    /// Approving similar requests for the rest of the session.
    pub session: Capability,
    /// Approving similar requests in saved native settings.
    pub persistent: Capability,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ConversationCapabilities {
    /// Adding input to a running turn.
    pub steering: Capability,
    /// Returning the conversation, and possibly files, to an earlier point.
    pub rewind: Capability,
    /// Summarizing earlier context on request.
    pub compaction: Capability,
    /// Reopening a native session after a restart.
    pub resume: Capability,
    /// Importing native history that ADE did not create.
    pub import: Capability,
    /// Branching a native session into a new one.
    pub fork: Capability,
    /// Changing account inside one conversation.
    pub account_switch: Capability,
}

/// What an adapter declares about its provider.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CapabilityRecord {
    pub provider: String,
    pub name: String,
    /// Raised by the adapter whenever the declared capabilities change.
    pub revision: u32,
    /// SHA-256 of this record with an empty fingerprint. A change without a
    /// new revision means the declaration drifted.
    pub fingerprint: String,
    /// The provider version or document the record was checked against.
    pub checked_against: String,
    pub models: ModelCapabilities,
    pub reasoning: ReasoningCapabilities,
    pub permission_modes: Vec<PermissionModeCapability>,
    pub grants: GrantCapabilities,
    pub conversation: ConversationCapabilities,
    /// Whether the provider reports quota or rate-limit windows.
    pub quota: Capability,
    /// Whether ADE can manage several accounts for this provider.
    pub managed_accounts: Capability,
}

/// `provider.capabilities`: the capability records ADE ships.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ProviderCapabilitiesRequest {
    /// One provider; every provider when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

wire_tag!(ProviderCapabilitiesTag, "provider_capabilities");

/// The `provider.capabilities` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderCapabilities {
    #[serde(rename = "type")]
    pub tag: ProviderCapabilitiesTag,
    pub providers: Vec<CapabilityRecord>,
}

/// `provider.readiness`: whether a provider, or one of its accounts, can run.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderReadinessRequest {
    pub provider: String,
    /// A managed account to probe. Without it ADE checks installation only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// Inspect one enabled plugin worker without opening a session or submitting input.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderInspectRequest {
    pub provider: String,
}

/// The overall readiness verdict.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessState {
    /// Installed, compatible, signed in and matching the pinned identity.
    Ready,
    /// Executables were found; version and sign-in were not checked.
    InstalledUnchecked,
    MissingExecutable,
    /// The installed version is outside the validated range, or its output
    /// could not be read.
    Incompatible,
    NeedsAuthentication,
    /// Signed in, but the account's identity has not been pinned.
    NeedsVerification,
    /// Signed in as someone other than the pinned identity.
    IdentityChanged,
    AccountDisabled,
    /// The check itself failed; nothing is known.
    Unavailable,
}

wire_tag!(ProviderInspectTag, "provider_inspect");

/// A capability advertised by a provider worker. Support and current availability are independent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerCapability {
    pub name: ProviderWorkerCapabilityName,
    pub support: Support,
    pub available: bool,
    pub reason: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderWorkerCapabilityName {
    Streaming,
    Images,
    TextAttachments,
    Resume,
    Cancel,
    Steering,
    ToolApproval,
    Questions,
    ChildTranscript,
}

/// An operation handled by the current worker protocol. Unknown methods cannot be declared supported.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderWorkerMethod {
    Initialize,
    Open,
    Send,
    Steer,
    Cancel,
    Answer,
    History,
    ConfigureMcp,
    Compact,
    Rewind,
    ChildTranscript,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderWorkerAvailability {
    Available,
    Unavailable,
    Unsupported,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerOperation {
    pub method: ProviderWorkerMethod,
    pub tier: super::Tier,
    pub availability: ProviderWorkerAvailability,
    pub reason: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerLimits {
    #[schemars(range(min = 1, max = 1048576))]
    pub max_input_frame_bytes: u32,
    /// Maximum immediate child values in any input JSON object or array.
    #[schemars(range(min = 1, max = 1024))]
    pub max_input_entries: u32,
    #[schemars(range(min = 1, max = 15000))]
    pub max_initialize_ms: u32,
    #[schemars(range(min = 1, max = 1048576))]
    pub max_output_frame_bytes: u32,
    /// Maximum visible transcript items returned by open, history or child transcript.
    #[schemars(range(min = 1, max = 32))]
    pub max_history_page_items: u32,
    /// Maximum immediate child values in any output JSON object or array.
    #[schemars(range(min = 1, max = 32))]
    pub max_output_entries: u32,
    #[schemars(range(min = 2, max = 8))]
    pub max_concurrency: u32,
    #[schemars(range(min = 1, max = 10000))]
    pub max_partial_frame_ms: u32,
    #[schemars(range(min = 1, max = 45000))]
    pub max_operation_ms: u32,
    #[schemars(range(min = 1, max = 5000))]
    pub max_cleanup_ms: u32,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderWorkerFailureCode {
    InvalidRequest,
    Unsupported,
    AuthenticationRequired,
    PermissionDenied,
    RateLimited,
    ResourceLimit,
    ProviderFailure,
    ProtocolMismatch,
    TransportFailure,
    Timeout,
    Shutdown,
    Cancelled,
    IntegrationBug,
    Internal,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerFailure {
    pub code: ProviderWorkerFailureCode,
    pub message: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderWorkerJsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[cfg(test)]
mod provider_worker_jsonrpc_tests {
    use super::ProviderWorkerJsonRpcVersion;

    #[test]
    fn version_uses_the_json_rpc_wire_value() {
        assert_eq!(
            serde_json::to_string(&ProviderWorkerJsonRpcVersion::V2).unwrap(),
            r#""2.0""#
        );
        assert_eq!(
            serde_json::from_str::<ProviderWorkerJsonRpcVersion>(r#""2.0""#).unwrap(),
            ProviderWorkerJsonRpcVersion::V2
        );
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum ProviderWorkerRequestId {
    String(String),
    Integer(i64),
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum ProviderWorkerResponseId {
    String(String),
    Integer(i64),
    Null(()),
}

/// The request envelope spoken by every provider worker. Parameters remain
/// provider-specific JSON, but the JSON-RPC envelope and method are generated.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerRequest {
    pub jsonrpc: ProviderWorkerJsonRpcVersion,
    pub id: ProviderWorkerRequestId,
    pub method: ProviderWorkerMethod,
    pub params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerRpcError {
    pub code: i32,
    pub message: String,
    pub data: ProviderWorkerFailure,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerResultResponse {
    pub jsonrpc: ProviderWorkerJsonRpcVersion,
    pub id: ProviderWorkerResponseId,
    pub result: serde_json::Value,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerErrorResponse {
    pub jsonrpc: ProviderWorkerJsonRpcVersion,
    pub id: ProviderWorkerResponseId,
    pub error: ProviderWorkerRpcError,
}

/// A JSON-RPC response with an ADE-owned typed failure in error.data.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(untagged)]
pub enum ProviderWorkerResponse {
    Result(ProviderWorkerResultResponse),
    Error(ProviderWorkerErrorResponse),
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerSteerRequest {
    pub session: String,
    pub turn: String,
    pub message_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<crate::prompt::Content>,
}
/// What the adapter can prove after requesting a native interruption.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCancelScope {
    Turn,
    Submission,
    Session,
    Process,
    Unknown,
}

/// Evidence returned by a native cancellation command and any follow-up status sample.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderCancelEvidence {
    pub scope: ProviderCancelScope,
    pub interruption_requested: bool,
    pub termination: ProviderCancelTermination,
    /// Null means the provider has no evidence about remaining foreground work.
    #[serde(default)]
    pub active_work_remaining: Option<bool>,
    /// Null means the provider has no queue-depth evidence.
    #[serde(default)]
    pub queued_work_count: Option<u64>,
    /// Null means the provider has no evidence about background work.
    #[serde(default)]
    pub background_work_remaining: Option<bool>,
    /// Unix milliseconds for a point-in-time native state sample, when available.
    #[serde(default)]
    pub observed_at_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCancelTermination {
    Requested,
    Confirmed,
    Unknown,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerCancelResult {
    #[serde(rename = "type")]
    pub tag: ProviderWorkerCancelTag,
    pub evidence: ProviderCancelEvidence,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderWorkerCancelTag {
    CancelResult,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerCancelRequest {
    pub session: String,
    pub source_attempt_id: String,
    pub submission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerAnswerRequest {
    pub id: serde_json::Value,
    pub operation_id: String,
    pub answer: RequestAnswer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerCompactRequest {
    pub session: String,
    pub operation: String,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerRewindRequest {
    pub session: String,
    #[serde(default)]
    pub turn: Option<String>,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_message: Option<crate::provider::NativeMessageLocator>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerRewindResult {
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<crate::contract::conversations::RewindScope>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerConfigureMcpRequest {
    pub servers: serde_json::Map<String, serde_json::Value>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerChildTranscriptRequest {
    pub session: String,
    pub child: String,
    pub offset: u64,
    pub cursor: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerAck {}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerOpenRequest {
    pub resume: Option<String>,
    pub config: crate::provider::Config,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerSendRequest {
    pub session: String,
    pub source_attempt_id: String,
    pub submission: String,
    pub message_id: Option<String>,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<crate::prompt::Content>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerSendResult {
    pub turn: Option<String>,
    pub admitted: bool,
    pub dispatch: crate::contract::conversations::SubmissionDispatch,
    pub native_outcome: crate::contract::conversations::SubmissionNativeOutcome,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerEventNotification {
    pub jsonrpc: ProviderWorkerJsonRpcVersion,
    pub method: ProviderWorkerEventMethod,
    pub params: crate::provider::Event,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug)]
pub enum ProviderWorkerEventMethod {
    #[serde(rename = "event")]
    Event,
}

/// Native snapshot identity; never an ADE feed cursor or message sequence.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderHistorySnapshot {
    pub provider: String,
    pub session: String,
    pub execution_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<String>,
    pub source: String,
    pub generation: String,
    /// Actual measured native file bytes; unknown is absent/null, never a page cap or synthetic zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Native source timestamp in milliseconds since Unix epoch; unknown is absent/null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at_ms: Option<i64>,
    pub consistency: ProviderHistoryConsistency,
    pub invalidation_epoch: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHistoryConsistency {
    Snapshot,
    BestEffort,
}

/// Pinned by the daemon/runtime for this query. Querying never implicitly opens/resumes execution.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderHistoryContext {
    pub provider: String,
    pub execution_id: String,
    pub account_id: Option<String>,
    pub lineage: Option<String>,
    pub invalidation_epoch: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerHistoryRequest {
    pub session: String,
    pub context: ProviderHistoryContext,
    pub snapshot: Option<ProviderHistorySnapshot>,
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 32))]
    pub max_items: u32,
    #[schemars(range(min = 1, max = 524288))]
    pub max_bytes: u32,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerHistoryPage {
    pub snapshot: ProviderHistorySnapshot,
    pub items: Vec<crate::provider::Item>,
    pub next_cursor: Option<String>,
    /// Genuine native continuation after each item, when the source supports exact byte-window trimming.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub item_cursors: Vec<String>,
    pub complete: bool,
    pub retained_bytes: u64,
    /// A failed refresh may retain only content with this exact snapshot identity.
    pub error: Option<ProviderWorkerFailure>,
}

/// Version metadata declared by the packaged SDK worker.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerRequirements {
    pub sdk_api_version: u32,
    pub sdk_version: String,
    pub effect_version: String,
    pub platform_node_version: String,
    pub node_engine: String,
}

/// Exact JSON-RPC initialize reply; every field is required and unknown fields are rejected.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerInitialize {
    pub protocol_version: u32,
    pub compatible_protocol_versions: Vec<u32>,
    pub name: String,
    pub capabilities: Vec<ProviderWorkerCapability>,
    pub permission_modes: Vec<String>,
    pub operations: Vec<ProviderWorkerOperation>,
    pub limits: ProviderWorkerLimits,
    pub requirements: ProviderWorkerRequirements,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderInspect {
    #[serde(rename = "type")]
    pub tag: ProviderInspectTag,
    pub provider: String,
    pub state: ReadinessState,
    pub reason: String,
    pub version: Option<String>,
    pub descriptor: Option<ProviderWorkerInitialize>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Passed,
    Failed,
    Skipped,
}

/// One step of a readiness check.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ReadinessCheck {
    /// Such as `executable:claude`, `runtime:node` or `account`.
    pub check: String,
    pub state: CheckState,
    pub detail: String,
}

wire_tag!(ProviderReadinessTag, "provider_readiness");

/// The `provider.readiness` reply. It is a snapshot: an external CLI update
/// changes it, so launches check again.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderReadiness {
    #[serde(rename = "type")]
    pub tag: ProviderReadinessTag,
    pub provider: String,
    pub account_id: Option<String>,
    pub state: ReadinessState,
    /// What to do next, in words a person can act on.
    pub reason: String,
    /// The version the account probe read, when it ran.
    pub version: Option<String>,
    pub checks: Vec<ReadinessCheck>,
    pub capability_revision: u32,
    pub checked_at: i64,
}

/// `provider.quota`: reported limits per provider and account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ProviderQuotaRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaState {
    /// The provider reported at least one window.
    Reported,
    /// The provider reports limits, but none has arrived for this account.
    NotReported,
    /// The provider does not report limits, or nobody has confirmed it does.
    Unavailable,
}

/// The quota picture for one provider and account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct QuotaEntry {
    pub provider: String,
    /// Null for the provider's own login.
    pub account_id: Option<String>,
    pub state: QuotaState,
    pub reason: String,
    pub windows: Vec<UsageLimitWindow>,
    /// True when a window that has not yet reset reports exhaustion. ADE does
    /// not switch account or model in response.
    pub exhausted: bool,
    /// When the newest window was received, in milliseconds since the epoch.
    pub observed_at: Option<i64>,
    /// How old that report is.
    pub age_ms: Option<i64>,
}

wire_tag!(ProviderQuotaTag, "provider_quota");

/// The `provider.quota` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderQuota {
    #[serde(rename = "type")]
    pub tag: ProviderQuotaTag,
    pub entries: Vec<QuotaEntry>,
    pub recording: UsageRecording,
}

/// The artifact a provider worker runs. A session started on one pin stays
/// on it: a newer version serves new sessions only (architecture section 8).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorkerPin {
    pub plugin_id: String,
    pub version: String,
    /// `sha256:<hex>` over the installed artifact's files.
    pub artifact_digest: String,
    /// The plugin activation that published the registration. A lease does
    /// not depend on it: re-enabling the same artifact does not change code.
    pub activation_generation: u64,
}

/// What the runtime needs to start one plugin provider worker.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderWorker {
    /// `plugin:<plugin_id>`.
    pub provider: String,
    pub pin: ProviderWorkerPin,
    /// The absolute, version-addressed artifact directory.
    pub artifact_path: String,
    /// The manifest's `entry_points.provider`, relative to `artifact_path`.
    pub entry: String,
}

/// Who registered a provider. Every origin goes through the same registry
/// and the same provider interface; none has a privileged path.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderOrigin {
    /// Shipped with ADE.
    Bundled,
    /// A profile's generic ACP or custom executable adapter definition.
    Adapter { adapter_id: String, revision: u64 },
    /// An installed plugin's `provider` entry point.
    Plugin { pin: ProviderWorkerPin },
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationState {
    /// The provider is registered under this ID.
    Registered,
    /// The registry refused it; `reason` says why.
    Refused,
}

/// One registration and its outcome.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ProviderRegistrationView {
    pub provider: String,
    pub name: String,
    pub origin: ProviderOrigin,
    pub state: RegistrationState,
    /// Null when registered.
    pub reason: Option<String>,
}

/// `provider.registrations`: every registered provider and its origin.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ProviderRegistrationsRequest {}

wire_tag!(ProviderRegistrationsTag, "provider_registrations");

/// The `provider.registrations` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProviderRegistrations {
    #[serde(rename = "type")]
    pub tag: ProviderRegistrationsTag,
    pub providers: Vec<ProviderRegistrationView>,
    /// Why the plugin registry could not be read, when it could not. Plugin
    /// providers are then missing from `providers`, not reported as absent.
    pub plugins_unavailable: Option<String>,
}

/// A preset's launch settings.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PresetSettings {
    pub provider: String,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub permission_mode: String,
}

/// A stored preset.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct Preset {
    pub name: String,
    pub settings: PresetSettings,
    /// Starts at 1 and rises with each change.
    pub revision: u64,
    /// The capability record the settings were validated against when saved.
    pub capability_revision: u32,
    pub capability_fingerprint: String,
    pub updated_at: i64,
}

/// The preset field a conflict concerns.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresetField {
    Name,
    Provider,
    Model,
    Reasoning,
    PermissionMode,
}

/// A setting the provider's current capabilities do not allow.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PresetConflict {
    pub field: PresetField,
    pub message: String,
}

/// How the provider's capability record changed since a preset was saved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityChange {
    Unchanged,
    /// The adapter published a newer revision.
    Revised,
    /// The record changed without a new revision.
    Drifted,
    /// The adapter is older than the one the preset was saved with.
    Downgraded,
}

/// A preset checked against the current capability record.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckedPreset {
    pub preset: Preset,
    pub capability_change: CapabilityChange,
    /// Empty when the preset can be applied as saved.
    pub conflicts: Vec<PresetConflict>,
}

/// `preset.list`: every preset in the profile, by name.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct PresetListRequest {}

/// `preset.get`: one preset and its conflicts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetGetRequest {
    pub name: String,
}

/// `preset.save`: create or replace a preset. The daemon refuses settings the
/// provider's current capabilities do not allow.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetSaveRequest {
    /// Trimmed by the daemon; 1 to 80 characters without control characters.
    pub name: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// `default` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// The revision being replaced. Absent to create a new preset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

/// `preset.delete`: remove a preset at the revision the caller saw.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetDeleteRequest {
    pub name: String,
    pub expected_revision: u64,
}

wire_tag!(PresetListTag, "presets");
wire_tag!(PresetViewTag, "preset");
wire_tag!(PresetSavedTag, "preset_saved");
wire_tag!(PresetDeletedTag, "preset_deleted");

/// The `preset.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetList {
    #[serde(rename = "type")]
    pub tag: PresetListTag,
    pub presets: Vec<CheckedPreset>,
}

/// The `preset.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetView {
    #[serde(rename = "type")]
    pub tag: PresetViewTag,
    #[serde(flatten)]
    pub checked: CheckedPreset,
}

/// The `preset.save` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetSaved {
    #[serde(rename = "type")]
    pub tag: PresetSavedTag,
    pub preset: Preset,
    /// False when the preset already had these settings.
    pub changed: bool,
}

/// The `preset.delete` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PresetDeleted {
    #[serde(rename = "type")]
    pub tag: PresetDeletedTag,
    pub name: String,
    /// False when no preset had this name.
    pub deleted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String) {
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

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn capability(support: &str) -> Value {
        json!({"support": support, "note": "n"})
    }

    fn preset() -> Value {
        json!({"name": "Fast", "settings": {"provider": "claude", "model": "sonnet",
            "reasoning": null, "permission_mode": "default"}, "revision": 2,
            "capability_revision": 1, "capability_fingerprint": "ab", "updated_at": 5})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<ProviderCapabilitiesRequest>(
            "provider.capabilities",
            json!({"op": "provider.capabilities"}),
        );
        request::<ProviderCapabilitiesRequest>(
            "provider.capabilities",
            json!({"op": "provider.capabilities", "provider": "codex"}),
        );
        request::<ProviderReadinessRequest>(
            "provider.readiness",
            json!({"op": "provider.readiness", "provider": "claude", "account_id": "a"}),
        );
        request::<ProviderQuotaRequest>("provider.quota", json!({"op": "provider.quota"}));
        request::<ProviderRegistrationsRequest>(
            "provider.registrations",
            json!({"op": "provider.registrations"}),
        );
        request::<PresetListRequest>("preset.list", json!({"op": "preset.list"}));
        request::<PresetGetRequest>("preset.get", json!({"op": "preset.get", "name": "Fast"}));
        request::<PresetSaveRequest>(
            "preset.save",
            json!({"op": "preset.save", "name": "Fast", "provider": "codex",
                "model": "gpt-5.5", "permission_mode": "read-only", "expected_revision": 3}),
        );
        request::<PresetDeleteRequest>(
            "preset.delete",
            json!({"op": "preset.delete", "name": "Fast", "expected_revision": 1}),
        );
        let (name, _) = names("provider.readiness");
        assert!(!valid(&name, &json!({"op": "provider.readiness"})));
        let (name, _) = names("preset.delete");
        assert!(!valid(
            &name,
            &json!({"op": "preset.delete", "name": "Fast"})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        let conversation = json!({"steering": capability("supported"),
            "rewind": capability("native_only"), "compaction": capability("native_only"),
            "resume": capability("supported"), "import": capability("unknown"),
            "fork": capability("unsupported"), "account_switch": capability("unsupported")});
        response::<ProviderCapabilities>(
            "provider.capabilities",
            json!({"type": "provider_capabilities", "providers": [{
                "provider": "claude", "name": "Claude Code", "revision": 1, "fingerprint": "ab",
                "checked_against": "SDK 0.3.281",
                "models": {"selection": capability("supported"), "format": "native_id",
                    "aliases": ["sonnet"], "discovery": capability("native_only")},
                "reasoning": {"selection": capability("native_only"),
                    "levels": ["low", "high"], "varies_by_model": true},
                "permission_modes": [{"id": "default", "support": "supported",
                    "description": "Ask"}],
                "grants": {"once": capability("supported"), "session": capability("native_only"),
                    "persistent": capability("native_only")},
                "conversation": conversation, "quota": capability("supported"),
                "managed_accounts": capability("supported"),
            }]}),
        );
        response::<ProviderReadiness>(
            "provider.readiness",
            json!({"type": "provider_readiness", "provider": "codex", "account_id": null,
                "state": "installed_unchecked", "reason": "r", "version": null,
                "checks": [{"check": "executable:codex", "state": "passed", "detail": "/bin/codex"}],
                "capability_revision": 1, "checked_at": 7}),
        );
        response::<ProviderQuota>(
            "provider.quota",
            json!({"type": "provider_quota", "entries": [{"provider": "omp", "account_id": null,
                "state": "unavailable", "reason": "r", "windows": [], "exhausted": false,
                "observed_at": null, "age_ms": null}],
                "recording": {"dropped_batches": 0, "last_error": null}}),
        );
        response::<ProviderRegistrations>(
            "provider.registrations",
            json!({"type": "provider_registrations", "providers": [
                {"provider": "claude", "name": "Claude Code", "origin": {"kind": "bundled"},
                    "state": "registered", "reason": null},
                {"provider": "adapter:x", "name": "X", "origin": {"kind": "adapter",
                    "adapter_id": "x", "revision": 2}, "state": "registered", "reason": null},
                {"provider": "plugin:acme.agent", "name": "Agent", "origin": {"kind": "plugin",
                    "pin": {"plugin_id": "acme.agent", "version": "1.0.0",
                        "artifact_digest": "sha256:ab", "activation_generation": 3}},
                    "state": "refused", "reason": "r"}],
                "plugins_unavailable": null}),
        );
        let checked = json!({"preset": preset(), "capability_change": "revised",
            "conflicts": [{"field": "reasoning", "message": "m"}]});
        response::<PresetList>(
            "preset.list",
            json!({"type": "presets", "presets": [checked]}),
        );
        response::<PresetView>(
            "preset.get",
            json!({"type": "preset", "preset": preset(), "capability_change": "unchanged",
                "conflicts": []}),
        );
        response::<PresetSaved>(
            "preset.save",
            json!({"type": "preset_saved", "preset": preset(), "changed": true}),
        );
        response::<PresetDeleted>(
            "preset.delete",
            json!({"type": "preset_deleted", "name": "Fast", "deleted": false}),
        );
    }
}
