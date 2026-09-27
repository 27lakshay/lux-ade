//! Conversation, draft, send-intent, queue, window, attachment, prompt and
//! answer contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::{Attachment, Conversation, Draft, Message, PendingRequest, QueuedPrompt};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

mod drafts;
pub use drafts::*;

pub fn operations() -> Vec<OperationSpec> {
    let mut operations = vec![
        OperationSpec::new::<ConversationGetRequest, ConversationSnapshot>(
            "conversation.get",
            Tier::Query,
        ),
        OperationSpec::new::<AgentSendRequest, Ack>("agent.send", Tier::EffectCommand),
        OperationSpec::new::<AgentAnswerRequest, Ack>("agent.answer", Tier::EffectCommand),
        // Each call makes a Conversation with a fresh ID, so a retry duplicates it.
        OperationSpec::new::<ConversationCreateRequest, ConversationCreated>(
            "conversation.create",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<DraftGetRequest, DraftReply>("draft.get", Tier::Query),
        OperationSpec::new::<DraftSaveRequest, DraftReply>("draft.save", Tier::IdempotentCommand),
        OperationSpec::new::<DraftSendGetRequest, SendIntentState>("draft.send.get", Tier::Query),
        OperationSpec::new::<DraftSendPrepareRequest, SendIntentPrepared>(
            "draft.send.prepare",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<DraftSendCompleteRequest, DraftReply>(
            "draft.send.complete",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<DraftSendAbortRequest, DraftReply>(
            "draft.send.abort",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<DraftSendListRequest, PendingSendList>("draft.send.list", Tier::Query),
        // Settles the send the only way the daemon's evidence allows; it never dispatches.
        OperationSpec::new::<DraftSendAcknowledgeRequest, SendAcknowledged>(
            "draft.send.acknowledge",
            Tier::IdempotentCommand,
        ),
        // The queue delivers each queued prompt to the provider when it drains.
        OperationSpec::new::<QueueEnqueueRequest, Ack>("queue.enqueue", Tier::EffectCommand),
        OperationSpec::new::<QueueCancelRequest, Ack>("queue.cancel", Tier::IdempotentCommand),
        OperationSpec::new::<QueuePauseRequest, Ack>("queue.pause", Tier::EffectCommand),
        OperationSpec::new::<WindowSaveRequest, Ack>("window.save", Tier::IdempotentCommand),
        OperationSpec::new::<WindowCloseRequest, Ack>("window.close", Tier::IdempotentCommand),
        OperationSpec::new::<AttachmentPutRequest, AttachmentReply>(
            "attachment.put",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<AttachmentImportRequest, AttachmentReply>(
            "attachment.import",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<AttachmentInspectRequest, AttachmentInspection>(
            "attachment.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<AttachmentReclaimPreviewRequest, AttachmentReclaimPreviewReply>(
            "attachment.reclaim.preview",
            Tier::Query,
        ),
        OperationSpec::new::<AttachmentReclaimApplyRequest, AttachmentReclaim>(
            "attachment.reclaim.apply",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ConversationControlsRequest, ConversationControls>(
            "conversation.controls",
            Tier::Query,
        ),
        // Adds user input to a running provider turn; a retry must not add it twice.
        OperationSpec::new::<ConversationSteerRequest, ConversationControlReply>(
            "conversation.steer",
            Tier::EffectCommand,
        ),
        // Asks the provider to compact its context; a retry must not compact twice.
        OperationSpec::new::<ConversationCompactRequest, ConversationControlReply>(
            "conversation.compact",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ConversationRewindPreviewRequest, ConversationRewindPreview>(
            "conversation.rewind.preview",
            Tier::Query,
        ),
        // Rewrites files or history; a retry must not rewind twice.
        OperationSpec::new::<ConversationRewindRequest, ConversationControlReply>(
            "conversation.rewind",
            Tier::EffectCommand,
        ),
        // Setting the same wake time again converges; a new time replaces the old one.
        OperationSpec::new::<ConversationSnoozeRequest, ConversationSnoozeReply>(
            "conversation.snooze",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ConversationUnsnoozeRequest, ConversationSnoozeReply>(
            "conversation.unsnooze",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ConversationSnoozeListRequest, ConversationSnoozeList>(
            "conversation.snooze.list",
            Tier::Query,
        ),
    ];
    operations.extend(drafts::operations());
    operations
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<ConversationChanged>(
        "conversation_changed",
    )]
}

/// `conversation.get`: one page of a conversation's messages, newest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationGetRequest {
    pub conversation_id: String,
    /// Return messages with a sequence below this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub before: Option<i64>,
    /// Page size; the daemon uses 50 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `agent.send`: submit a prompt. `request_id` is the caller-owned operation ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentSendRequest {
    pub conversation_id: String,
    pub request_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// `agent.answer`: answer a pending provider request by its ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentAnswerRequest {
    pub conversation_id: String,
    pub request_id: String,
    pub decision: String,
    /// Structured answers; required by the `answer` decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub answers: Option<Value>,
}

wire_tag!(ConversationSnapshotTag, "conversation_snapshot");
wire_tag!(ConversationChangedTag, "conversation_changed");
wire_tag!(AckTag, "ack");

/// The `conversation.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSnapshot {
    #[serde(rename = "type")]
    pub tag: ConversationSnapshotTag,
    pub conversation: Conversation,
    pub messages: Vec<Message>,
    pub requests: Vec<PendingRequest>,
    pub queued: Vec<QueuedPrompt>,
    pub boot_id: String,
    pub revision: u64,
}

/// The `conversation_changed` feed frame.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationChanged {
    #[serde(rename = "type")]
    pub tag: ConversationChangedTag,
    pub conversation: Conversation,
    pub messages: Vec<Message>,
    pub requests: Vec<PendingRequest>,
    pub queued: Vec<QueuedPrompt>,
    pub boot_id: String,
    pub revision: u64,
}

/// A bare acceptance reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct Ack {
    #[serde(rename = "type")]
    pub tag: AckTag,
}

/// Keeps a present `null` as `Some(Value::Null)`, so an explicit null stays
/// distinct from an absent field, as the untyped handler saw it.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// `conversation.create`: make a Conversation in a workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationCreateRequest {
    pub workspace_id: String,
    /// Defaults to `New Conversation`; at most 256 bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub title: Option<String>,
    /// Provider ID; defaults to `codex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub provider: Option<String>,
    /// Provider settings; the daemon validates them for the provider.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub provider_config: Option<Value>,
    /// A managed account of the same provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub account_id: Option<String>,
    /// A saved preset whose provider, model and permission mode the
    /// Conversation uses. Refused when the provider's current capabilities
    /// conflict with it; never combined with `provider_config`. A preset
    /// carries no account, so it never changes `account_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub preset: Option<String>,
}

/// The `conversation.create` reply: an `ack` carrying the new Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationCreated {
    #[serde(rename = "type")]
    pub tag: AckTag,
    pub conversation: Conversation,
}

/// `draft.get`: read one window's draft of a Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftGetRequest {
    pub conversation_id: String,
    pub window_id: String,
}

/// `draft.save`: store a newer draft revision for one window.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSaveRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    pub text: String,
    pub revision: i64,
    pub conversation_id: String,
    pub window_id: String,
    /// Resolve a conflict: save only if the stored revision is still this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub expected_revision: Option<i64>,
}

/// `draft.send.get`: read the window's unresolved send intent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendGetRequest {
    pub conversation_id: String,
    pub window_id: String,
}

/// `draft.send.prepare`: record the exact prompt and draft before dispatch.
/// `request_id` is the send's ID and becomes the accepted message's ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendPrepareRequest {
    /// One review anchor; excludes `review_feedback`.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub review_anchor: Option<Value>,
    /// A review feedback batch; excludes `review_anchor`.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub review_feedback: Option<Value>,
    pub draft_text: String,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    pub conversation_id: String,
    pub window_id: String,
    pub request_id: String,
    pub text: String,
}

/// `draft.send.complete`: clear the draft once the prompt was accepted.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendCompleteRequest {
    pub conversation_id: String,
    pub window_id: String,
    pub request_id: String,
}

/// `draft.send.abort`: release a send the daemon rejected before admission.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendAbortRequest {
    pub conversation_id: String,
    pub window_id: String,
    pub request_id: String,
}

/// `draft.send.list`: list one window's unresolved sends across Conversations,
/// ordered by Conversation ID. A later page sends the previous `next_cursor`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendListRequest {
    pub window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub after: Option<String>,
    /// Page size from 1 to 200; the daemon uses 50 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `draft.send.acknowledge`: settle one listed send once the caller has shown
/// its outcome. An accepted prompt completes; a rejected one aborts. A prompt
/// the daemon has not accepted is refused, because only delivery can settle it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftSendAcknowledgeRequest {
    pub conversation_id: String,
    pub window_id: String,
    pub request_id: String,
}

/// `queue.enqueue`: queue a prompt. `request_id` becomes the queued prompt's ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct QueueEnqueueRequest {
    pub conversation_id: String,
    pub request_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// `queue.cancel`: cancel a queued prompt that has not been submitted.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct QueueCancelRequest {
    pub conversation_id: String,
    pub request_id: String,
}

/// `queue.pause`: pause or resume a Conversation's prompt queue.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct QueuePauseRequest {
    pub conversation_id: String,
    pub paused: bool,
}

/// `window.save`: store one window's layout record.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowSaveRequest {
    /// The window record, in the shape `catalog.get` lists it.
    #[schemars(with = "Value")]
    pub window: Value,
}

/// `window.close`: forget a window's record, unless it is the last one.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowCloseRequest {
    pub window_id: String,
}

/// `attachment.put`: upload attachment bytes. `request_id` becomes the attachment ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentPutRequest {
    /// Standard base64 of the file bytes.
    pub data: String,
    pub name: String,
    pub conversation_id: String,
    pub request_id: String,
}

/// `attachment.import`: attach a regular file that the daemon reads from disk.
/// `request_id` becomes the attachment ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentImportRequest {
    pub path: String,
    pub conversation_id: String,
    pub request_id: String,
}

/// `attachment.inspect`: read a live attachment's metadata and digest.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentInspectRequest {
    pub conversation_id: String,
    pub attachment_id: String,
}

/// `attachment.reclaim.preview`: report what reclaiming one attachment would free.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReclaimPreviewRequest {
    pub conversation_id: String,
    pub attachment_id: String,
}

/// `attachment.reclaim.apply`: discard one unreferenced attachment's payload.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReclaimApplyRequest {
    pub conversation_id: String,
    pub attachment_id: String,
    /// The preview's `generation`; a changed attachment is refused.
    pub expected_generation: String,
}

wire_tag!(DraftTag, "draft");
wire_tag!(SendIntentTag, "send_intent");
wire_tag!(PendingSendsTag, "pending_sends");
wire_tag!(SendAcknowledgedTag, "send_acknowledged");
wire_tag!(AttachmentTag, "attachment");
wire_tag!(AttachmentInspectionTag, "attachment_inspection");
wire_tag!(AttachmentReclaimPreviewTag, "attachment_reclaim_preview");
wire_tag!(AttachmentReclaimTag, "attachment_reclaim");
wire_tag!(ExplicitSingleAttachment, "explicit_single_attachment");
wire_tag!(NotEnumerated, "not_enumerated");

/// The schema of [`Draft`], which the model defines without one.
#[derive(JsonSchema)]
#[schemars(rename = "Draft")]
#[allow(dead_code)]
struct DraftSchema {
    text: String,
    revision: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Attachment>,
}

/// The reply to `draft.get`, `draft.save`, `draft.send.complete` and `draft.send.abort`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftReply {
    #[serde(rename = "type")]
    pub tag: DraftTag,
    #[schemars(with = "DraftSchema")]
    pub draft: Draft,
}

/// A prompt recorded before dispatch, with the draft it came from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct SendIntent {
    pub request_id: String,
    pub conversation_id: String,
    pub window_id: String,
    pub draft_revision: i64,
    pub draft_text: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    /// `pending`, `rejected`, `completed` or `aborted`.
    pub state: String,
    /// Null unless the send carries one review anchor.
    #[schemars(with = "Value")]
    pub review_anchor: Option<Value>,
    /// Null unless the send carries a review feedback batch.
    #[schemars(with = "Value")]
    pub review_feedback: Option<Value>,
}

/// The `draft.send.get` reply. `intent` is null when no send is unresolved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SendIntentState {
    #[serde(rename = "type")]
    pub tag: SendIntentTag,
    pub intent: Option<SendIntent>,
    /// Whether the profile was restored from a backup, which holds its sends.
    pub restored_from_backup: bool,
}

/// The `draft.send.prepare` reply: the new or already recorded intent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SendIntentPrepared {
    #[serde(rename = "type")]
    pub tag: SendIntentTag,
    pub intent: SendIntent,
}

/// What the daemon knows about an unresolved send.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendOutcome {
    /// Recorded, but no accepted message exists. Retry delivery with the same ID.
    Prepared,
    /// The prompt was accepted as a message. Acknowledge it to clear the draft.
    Accepted,
    /// The daemon rejected it before admission. Acknowledge it to release the draft.
    Rejected,
    /// A restored backup holds it until its source outcome is reconciled.
    Held,
    /// A rejected intent has an accepted message. The records disagree; the
    /// daemon settles neither way.
    Conflict,
}

/// One unresolved send and what the daemon knows about it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PendingSend {
    pub intent: SendIntent,
    pub outcome: SendOutcome,
}

/// The `draft.send.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PendingSendList {
    #[serde(rename = "type")]
    pub tag: PendingSendsTag,
    pub sends: Vec<PendingSend>,
    /// Whether the profile was restored from a backup, which holds its sends.
    pub restored_from_backup: bool,
    /// The cursor for the next page; null on the last page.
    pub next_cursor: Option<String>,
}

/// How an acknowledged send settled.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendResolution {
    /// The accepted prompt's draft was cleared.
    Completed,
    /// The rejected prompt was released; the draft keeps its text.
    Aborted,
}

/// The `draft.send.acknowledge` reply, with the window's current draft.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SendAcknowledged {
    #[serde(rename = "type")]
    pub tag: SendAcknowledgedTag,
    pub request_id: String,
    pub conversation_id: String,
    pub resolution: SendResolution,
    #[schemars(with = "DraftSchema")]
    pub draft: Draft,
}

/// The `attachment.put` and `attachment.import` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReply {
    #[serde(rename = "type")]
    pub tag: AttachmentTag,
    pub attachment: Attachment,
}

/// The `attachment.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentInspection {
    #[serde(rename = "type")]
    pub tag: AttachmentInspectionTag,
    pub attachment: Attachment,
    /// Lowercase hex SHA-256 of the payload.
    pub sha256: String,
}

/// One attachment's retention state and what protects it from reclaim.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReclaimPreview {
    pub attachment_id: String,
    pub conversation_id: String,
    pub generation: String,
    /// `live` or `discarded`.
    pub state: String,
    pub created_at: i64,
    pub payload_bytes: i64,
    pub estimated_reusable_payload_bytes: i64,
    /// `message`, `draft`, `queued_prompt`, `send_intent`, `draft_stash` or `already_discarded`.
    pub protected_by: Vec<String>,
    pub reclaimable: bool,
}

/// The `attachment.reclaim.preview` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReclaimPreviewReply {
    #[serde(rename = "type")]
    pub tag: AttachmentReclaimPreviewTag,
    pub preview: AttachmentReclaimPreview,
    pub scope: ExplicitSingleAttachment,
    /// Always false: only an explicit reclaim frees an attachment.
    pub automatic_gc_eligible: bool,
    pub client_held_uploads: NotEnumerated,
    pub filesystem_reclaimed_bytes: u64,
}

/// The `attachment.reclaim.apply` reply; `attachment` is the state after reclaim.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AttachmentReclaim {
    #[serde(rename = "type")]
    pub tag: AttachmentReclaimTag,
    pub attachment: AttachmentReclaimPreview,
    pub reclaimed_payload_bytes: i64,
    pub filesystem_reclaimed_bytes: u64,
    pub scope: ExplicitSingleAttachment,
}

// Conversation controls (F035, F039, F040) and snoozing (F046).
//
// A control is available only when the Conversation's provider adapter
// performs it natively, or, for file rewind, when ADE's checkpoints do. An
// unavailable control is reported with its reason and never emulated: a steer
// is never turned into a queued message, and compaction never reports a new
// context state that the provider did not report.

wire_tag!(ConversationControlsTag, "conversation_controls");
wire_tag!(ConversationControlReplyTag, "conversation_control");
wire_tag!(ConversationRewindPreviewTag, "conversation_rewind_preview");
wire_tag!(ConversationSnoozeReplyTag, "conversation_snooze");
wire_tag!(ConversationSnoozeListTag, "conversation_snooze_list");

/// A control whose support depends on the provider or on ADE's checkpoints.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationControl {
    /// Add input to the running turn (F035).
    Steer,
    /// Compact the provider's context (F040).
    Compact,
    /// Return the provider's history to an earlier point (F039).
    RewindConversation,
    /// Return the workspace files to a checkpoint (F039).
    RewindFiles,
}

/// Whether one control may run on a Conversation now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ControlAvailability {
    pub control: ConversationControl,
    pub available: bool,
    /// What performs the control: a native provider method such as
    /// `turn/steer`, or `ade.checkpoints` for file rewind. Absent when nothing does.
    pub mechanism: Option<String>,
    /// Why the control is unavailable; absent when it is available.
    pub reason: Option<String>,
}

/// `conversation.controls`: which controls the Conversation supports now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationControlsRequest {
    pub conversation_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationControls {
    #[serde(rename = "type")]
    pub tag: ConversationControlsTag,
    pub conversation_id: String,
    pub provider: String,
    pub controls: Vec<ControlAvailability>,
    /// The active snooze, if any.
    pub snooze: Option<ConversationSnooze>,
}

/// `conversation.steer`: add input to the running turn. The provider must
/// accept it into `turn_id`; it is never queued as a new prompt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSteerRequest {
    /// Caller-owned operation ID; it also becomes the steered message's ID.
    pub operation_id: String,
    pub conversation_id: String,
    /// The turn the caller saw running. Steering refuses when another turn is active.
    pub turn_id: String,
    /// At most 1 MiB.
    pub text: String,
}

/// `conversation.compact`: ask the provider to compact its context now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationCompactRequest {
    pub operation_id: String,
    pub conversation_id: String,
}

/// What a rewind returns to an earlier point.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewindScope {
    /// The provider's conversation history.
    Conversation,
    /// The workspace's working tree and index, from an ADE checkpoint.
    Files,
}

/// `conversation.rewind.preview`: whether a rewind may run, and what a file
/// rewind would change.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationRewindPreviewRequest {
    pub conversation_id: String,
    pub scope: RewindScope,
    /// The checkpoint a file rewind restores; required for `files`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationRewindPreview {
    #[serde(rename = "type")]
    pub tag: ConversationRewindPreviewTag,
    pub conversation_id: String,
    pub scope: RewindScope,
    pub availability: ControlAvailability,
    /// The checkpoint restore preview; present for an available file rewind.
    pub files: Option<super::checkpoints::CheckpointRestorePreview>,
}

/// `conversation.rewind`: perform a previewed rewind.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationRewindRequest {
    pub operation_id: String,
    pub conversation_id: String,
    pub scope: RewindScope,
    /// Required for `files`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    /// The preview's `state_token`; required for `files`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_state: Option<String>,
    /// Required when the preview listed uncommitted work it would overwrite.
    #[serde(default)]
    pub confirm_overwrite: bool,
}

/// How a control request ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlOutcome {
    /// Not attempted; `reason` says why. No receipt was recorded.
    Unavailable,
    /// The provider natively acknowledged the request. For compaction this
    /// means it started; the transcript shows when it finishes.
    Acknowledged,
    /// Files were written and verified against the checkpoint.
    Restored,
    /// The workspace already matched the checkpoint.
    Unchanged,
    /// Some files were written but the result does not match the checkpoint.
    Partial,
    /// The provider definitely refused the request, so it took no effect;
    /// `reason` carries the refusal. The receipt is settled, and a new
    /// request needs a new operation ID.
    Refused,
    /// ADE cannot prove whether the effect happened. It is never retried
    /// automatically; inspect the Conversation or workspace.
    Unknown,
}

/// The reply to `conversation.steer`, `conversation.compact` and `conversation.rewind`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ConversationControlReply {
    #[serde(rename = "type")]
    pub tag: ConversationControlReplyTag,
    pub operation_id: String,
    pub conversation_id: String,
    pub control: ConversationControl,
    pub outcome: ControlOutcome,
    pub reason: Option<String>,
    /// The turn the provider accepted steered input into.
    pub turn_id: Option<String>,
    /// The checkpoint restore result of a file rewind.
    pub files: Option<super::checkpoints::CheckpointRestored>,
}

/// A durable snooze: attention to the Conversation is deferred until `until`.
/// It never stops or starts agent work.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ConversationSnooze {
    pub conversation_id: String,
    /// Wake time, milliseconds since the Unix epoch.
    pub until: i64,
    pub snoozed_at: i64,
}

/// `conversation.snooze`: defer attention until a future time, at most 366 days ahead.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSnoozeRequest {
    pub conversation_id: String,
    /// Wake time, milliseconds since the Unix epoch.
    pub until: i64,
}

/// `conversation.unsnooze`: end a snooze now without recording a wake.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationUnsnoozeRequest {
    pub conversation_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSnoozeReply {
    #[serde(rename = "type")]
    pub tag: ConversationSnoozeReplyTag,
    pub conversation_id: String,
    /// The snooze after the command; absent when none is active.
    pub snooze: Option<ConversationSnooze>,
}

/// `conversation.snooze.list`: active snoozes, soonest wake first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSnoozeListRequest {
    /// Page size, at most 500; the daemon uses 100 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ConversationSnoozeList {
    #[serde(rename = "type")]
    pub tag: ConversationSnoozeListTag,
    pub snoozes: Vec<ConversationSnooze>,
}

#[cfg(test)]
mod tests {
    //! Schema round trips for this domain's draft, queue, window and attachment types.
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn validator(name: &str) -> jsonschema::Validator {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).expect("generated schema compiles")
    }

    fn spec(op: &str) -> Value {
        bundle()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone()
    }

    fn assert_valid(name: &str, value: &Value) {
        let errors: Vec<_> = validator(name)
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    /// The daemon decodes today's wire request, and the typed value validates
    /// against the schema and serializes back to the same line.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let name = spec(op)["request"].as_str().unwrap().to_owned();
        assert_valid(&name, &wire);
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(&typed).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
        typed
    }

    /// A reply the handler builds matches the schema and today's JSON.
    fn response<T: Serialize + DeserializeOwned>(op: &str, reply: &T, expected: Value) {
        let name = spec(op)["response"].as_str().unwrap().to_owned();
        let wire = serde_json::to_value(reply).unwrap();
        assert_eq!(wire, expected);
        assert_valid(&name, &wire);
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn attachment() -> Attachment {
        Attachment {
            id: "attachment_1".into(),
            name: "notes.txt".into(),
            media_type: "text/plain".into(),
            size: 12,
        }
    }

    fn intent() -> SendIntent {
        SendIntent {
            request_id: "send_1".into(),
            conversation_id: "conversation_1".into(),
            window_id: "window_1".into(),
            draft_revision: 2,
            draft_text: "draft".into(),
            text: "prompt".into(),
            attachments: vec![attachment()],
            state: "pending".into(),
            review_anchor: None,
            review_feedback: Some(json!({"format": "ade-review-feedback-v1"})),
        }
    }

    fn preview() -> AttachmentReclaimPreview {
        AttachmentReclaimPreview {
            attachment_id: "attachment_1".into(),
            conversation_id: "conversation_1".into(),
            generation: "attachment_generation_1".into(),
            state: "live".into(),
            created_at: 5,
            payload_bytes: 12,
            estimated_reusable_payload_bytes: 12,
            protected_by: Vec::new(),
            reclaimable: true,
        }
    }

    #[test]
    fn tiers_are_declared() {
        let tier = |op: &str| spec(op)["tier"].as_str().unwrap().to_owned();
        for (op, expected) in [
            ("conversation.create", "effect_command"),
            ("draft.get", "query"),
            ("draft.save", "idempotent_command"),
            ("draft.send.get", "query"),
            ("draft.send.prepare", "idempotent_command"),
            ("draft.send.complete", "idempotent_command"),
            ("draft.send.abort", "idempotent_command"),
            ("draft.send.list", "query"),
            ("draft.send.acknowledge", "idempotent_command"),
            ("queue.enqueue", "effect_command"),
            ("queue.cancel", "idempotent_command"),
            ("queue.pause", "effect_command"),
            ("window.save", "idempotent_command"),
            ("window.close", "idempotent_command"),
            ("attachment.put", "idempotent_command"),
            ("attachment.import", "idempotent_command"),
            ("attachment.inspect", "query"),
            ("attachment.reclaim.preview", "query"),
            ("attachment.reclaim.apply", "idempotent_command"),
            ("conversation.controls", "query"),
            ("conversation.steer", "effect_command"),
            ("conversation.compact", "effect_command"),
            ("conversation.rewind.preview", "query"),
            ("conversation.rewind", "effect_command"),
            ("conversation.snooze", "idempotent_command"),
            ("conversation.unsnooze", "idempotent_command"),
            ("conversation.snooze.list", "query"),
            ("draft.history.list", "query"),
            ("draft.history.restore", "idempotent_command"),
            ("draft.stash.save", "idempotent_command"),
            ("draft.stash.list", "query"),
            ("draft.stash.restore", "idempotent_command"),
            ("draft.stash.drop", "idempotent_command"),
        ] {
            assert_eq!(tier(op), expected, "{op}");
        }
    }

    #[test]
    fn conversation_controls_round_trip() {
        let steer: ConversationSteerRequest = request(
            "conversation.steer",
            json!({"op": "conversation.steer", "operation_id": "op_1",
                "conversation_id": "conversation_1", "turn_id": "turn_1", "text": "also check tests"}),
        );
        assert_eq!(steer.turn_id, "turn_1");
        request::<ConversationRewindRequest>(
            "conversation.rewind",
            json!({"op": "conversation.rewind", "operation_id": "op_2",
                "conversation_id": "conversation_1", "scope": "files", "checkpoint_id": "c",
                "expected_state": "token", "confirm_overwrite": false}),
        );
        request::<ConversationSnoozeRequest>(
            "conversation.snooze",
            json!({"op": "conversation.snooze", "conversation_id": "conversation_1", "until": 5}),
        );
        response(
            "conversation.steer",
            &ConversationControlReply {
                tag: Default::default(),
                operation_id: "op_1".into(),
                conversation_id: "conversation_1".into(),
                control: ConversationControl::Steer,
                outcome: ControlOutcome::Unavailable,
                reason: Some("Claude Code: not supported".into()),
                turn_id: None,
                files: None,
            },
            json!({"type": "conversation_control", "operation_id": "op_1",
                "conversation_id": "conversation_1", "control": "steer", "outcome": "unavailable",
                "reason": "Claude Code: not supported", "turn_id": null, "files": null}),
        );
        response(
            "conversation.snooze",
            &ConversationSnoozeReply {
                tag: Default::default(),
                conversation_id: "conversation_1".into(),
                snooze: Some(ConversationSnooze {
                    conversation_id: "conversation_1".into(),
                    until: 10,
                    snoozed_at: 5,
                }),
            },
            json!({"type": "conversation_snooze", "conversation_id": "conversation_1",
                "snooze": {"conversation_id": "conversation_1", "until": 10, "snoozed_at": 5}}),
        );
        assert!(!validator("ConversationRewindRequest").is_valid(&json!({
            "op": "conversation.rewind", "operation_id": "o", "conversation_id": "c", "scope": "all",
        })));
    }

    #[test]
    fn draft_recall_and_stash_round_trip() {
        let save: DraftStashSaveRequest = request(
            "draft.stash.save",
            json!({"op": "draft.stash.save", "conversation_id": "conversation_1",
                "window_id": "window_1", "name": "later", "text": "half a prompt",
                "attachments": [{"id": "attachment_1", "name": "notes.txt",
                    "media_type": "text/plain", "size": 12}],
                "context_nodes": [{"id": "n1", "kind": "file", "data": {"path": "src/a.rs"}}],
                "expected_revision": 2}),
        );
        assert_eq!(save.context_nodes[0].kind, "file");
        request::<DraftStashRestoreRequest>(
            "draft.stash.restore",
            json!({"op": "draft.stash.restore", "conversation_id": "conversation_1",
                "window_id": "window_1", "name": "later", "stash_revision": 3,
                "expected_revision": 4, "revision": 5}),
        );
        request::<DraftHistoryListRequest>(
            "draft.history.list",
            json!({"op": "draft.history.list", "conversation_id": "conversation_1",
                "window_id": "window_1", "before": 9, "limit": 5}),
        );
        response(
            "draft.stash.restore",
            &DraftRestored {
                tag: Default::default(),
                outcome: DraftRestoreOutcome::Conflict,
                draft: Draft {
                    text: "newer".into(),
                    revision: 7,
                    attachments: vec![],
                },
                context_nodes: vec![],
                displaced_entry_id: None,
            },
            json!({"type": "draft_restore", "outcome": "conflict",
                "draft": {"text": "newer", "revision": 7}, "context_nodes": [],
                "displaced_entry_id": null}),
        );
        response(
            "draft.history.list",
            &DraftHistoryList {
                tag: Default::default(),
                entries: vec![DraftHistoryEntry {
                    id: 3,
                    conversation_id: "conversation_1".into(),
                    window_id: "window_1".into(),
                    kind: DraftHistoryKind::Discarded,
                    text: "old".into(),
                    attachments: vec![attachment()],
                    context_nodes: vec![],
                    draft_revision: 2,
                    recorded_at: 10,
                }],
                next_before: None,
            },
            json!({"type": "draft_history", "entries": [{"id": 3,
                "conversation_id": "conversation_1", "window_id": "window_1",
                "kind": "discarded", "text": "old", "attachments": [{"id": "attachment_1",
                    "name": "notes.txt", "media_type": "text/plain", "size": 12}],
                "context_nodes": [], "draft_revision": 2, "recorded_at": 10}],
                "next_before": null}),
        );
        assert!(!validator("DraftStashRestoreRequest").is_valid(&json!({
            "op": "draft.stash.restore", "conversation_id": "c", "window_id": "w",
            "name": "n", "stash_revision": 1, "revision": 2,
        })));
    }

    #[test]
    fn conversation_create_round_trips() {
        let minimal: ConversationCreateRequest = request(
            "conversation.create",
            json!({"op": "conversation.create", "workspace_id": "workspace_1"}),
        );
        assert!(minimal.title.is_none() && minimal.account_id.is_none());
        request::<ConversationCreateRequest>(
            "conversation.create",
            json!({"op": "conversation.create", "workspace_id": "workspace_1",
                "title": "Title", "provider": "claude", "account_id": "account_1",
                "provider_config": {"permission_mode": "plan"}}),
        );
        assert!(!validator("ConversationCreateRequest").is_valid(&json!({
            "op": "conversation.create", "workspace_id": "w", "account_id": null,
        })));
        let conversation: Conversation = serde_json::from_value(json!({
            "id": "conversation_1", "workspace_id": "workspace_1", "title": "Title",
            "provider": "codex", "provider_thread_id": null, "status": "idle",
            "active_turn_id": null, "error": null, "updated_at": 1,
        }))
        .unwrap();
        let created = ConversationCreated {
            tag: AckTag::Tag,
            conversation: conversation.clone(),
        };
        response(
            "conversation.create",
            &created,
            json!({"type": "ack", "conversation": conversation}),
        );
    }

    #[test]
    fn drafts_round_trip() {
        request::<DraftGetRequest>(
            "draft.get",
            json!({"op": "draft.get", "conversation_id": "c", "window_id": "w"}),
        );
        request::<DraftSaveRequest>(
            "draft.save",
            json!({"op": "draft.save", "conversation_id": "c", "window_id": "w",
                "text": "hi", "revision": 1}),
        );
        request::<DraftSaveRequest>(
            "draft.save",
            json!({"op": "draft.save", "conversation_id": "c", "window_id": "w",
                "text": "hi", "revision": 3, "expected_revision": 2,
                "attachments": [attachment()]}),
        );
        let empty = DraftReply {
            tag: DraftTag::Tag,
            draft: Draft::default(),
        };
        response(
            "draft.get",
            &empty,
            json!({"type": "draft", "draft": {"text": "", "revision": 0}}),
        );
        let full = DraftReply {
            tag: DraftTag::Tag,
            draft: Draft {
                text: "hi".into(),
                revision: 3,
                attachments: vec![attachment()],
            },
        };
        response(
            "draft.save",
            &full,
            json!({"type": "draft", "draft": {"text": "hi", "revision": 3,
                "attachments": [attachment()]}}),
        );
        response(
            "draft.send.complete",
            &empty,
            json!({"type": "draft", "draft": {"text": "", "revision": 0}}),
        );
        response(
            "draft.send.abort",
            &full,
            serde_json::to_value(&full).unwrap(),
        );
    }

    #[test]
    fn send_intents_round_trip() {
        request::<DraftSendGetRequest>(
            "draft.send.get",
            json!({"op": "draft.send.get", "conversation_id": "c", "window_id": "w"}),
        );
        let prepare: DraftSendPrepareRequest = request(
            "draft.send.prepare",
            json!({"op": "draft.send.prepare", "conversation_id": "c", "window_id": "w",
                "request_id": "send_1", "draft_text": "draft", "text": "prompt",
                "revision": 1, "review_feedback": {"format": "ade-review-feedback-v1"}}),
        );
        assert!(prepare.review_anchor.is_none() && prepare.review_feedback.is_some());
        let null_anchor: DraftSendPrepareRequest = serde_json::from_value(json!({
            "conversation_id": "c", "window_id": "w", "request_id": "send_1",
            "draft_text": "", "text": "prompt", "revision": 1, "review_anchor": null,
        }))
        .unwrap();
        assert_eq!(null_anchor.review_anchor, Some(Value::Null));
        request::<DraftSendCompleteRequest>(
            "draft.send.complete",
            json!({"op": "draft.send.complete", "conversation_id": "c", "window_id": "w",
                "request_id": "send_1"}),
        );
        request::<DraftSendAbortRequest>(
            "draft.send.abort",
            json!({"op": "draft.send.abort", "conversation_id": "c", "window_id": "w",
                "request_id": "send_1"}),
        );
        let wire_intent = json!({"request_id": "send_1", "conversation_id": "conversation_1",
            "window_id": "window_1", "draft_revision": 2, "draft_text": "draft",
            "text": "prompt", "attachments": [attachment()], "state": "pending",
            "review_anchor": null, "review_feedback": {"format": "ade-review-feedback-v1"}});
        response(
            "draft.send.get",
            &SendIntentState {
                tag: SendIntentTag::Tag,
                intent: None,
                restored_from_backup: false,
            },
            json!({"type": "send_intent", "intent": null, "restored_from_backup": false}),
        );
        response(
            "draft.send.get",
            &SendIntentState {
                tag: SendIntentTag::Tag,
                intent: Some(intent()),
                restored_from_backup: true,
            },
            json!({"type": "send_intent", "intent": wire_intent, "restored_from_backup": true}),
        );
        response(
            "draft.send.prepare",
            &SendIntentPrepared {
                tag: SendIntentTag::Tag,
                intent: intent(),
            },
            json!({"type": "send_intent", "intent": wire_intent}),
        );
    }

    #[test]
    fn send_outbox_round_trips() {
        request::<DraftSendListRequest>(
            "draft.send.list",
            json!({"op": "draft.send.list", "window_id": "w"}),
        );
        request::<DraftSendListRequest>(
            "draft.send.list",
            json!({"op": "draft.send.list", "window_id": "w", "after": "c", "limit": 10}),
        );
        request::<DraftSendAcknowledgeRequest>(
            "draft.send.acknowledge",
            json!({"op": "draft.send.acknowledge", "conversation_id": "c", "window_id": "w",
                "request_id": "send_1"}),
        );
        let wire_intent = serde_json::to_value(intent()).unwrap();
        response(
            "draft.send.list",
            &PendingSendList {
                tag: PendingSendsTag::Tag,
                sends: vec![PendingSend {
                    intent: intent(),
                    outcome: SendOutcome::Accepted,
                }],
                restored_from_backup: false,
                next_cursor: Some("conversation_1".into()),
            },
            json!({"type": "pending_sends", "sends": [{"intent": wire_intent,
                "outcome": "accepted"}], "restored_from_backup": false,
                "next_cursor": "conversation_1"}),
        );
        response(
            "draft.send.list",
            &PendingSendList {
                tag: PendingSendsTag::Tag,
                sends: vec![],
                restored_from_backup: true,
                next_cursor: None,
            },
            json!({"type": "pending_sends", "sends": [], "restored_from_backup": true,
                "next_cursor": null}),
        );
        response(
            "draft.send.acknowledge",
            &SendAcknowledged {
                tag: SendAcknowledgedTag::Tag,
                request_id: "send_1".into(),
                conversation_id: "c".into(),
                resolution: SendResolution::Completed,
                draft: Draft {
                    text: String::new(),
                    revision: 3,
                    attachments: vec![],
                },
            },
            json!({"type": "send_acknowledged", "request_id": "send_1",
                "conversation_id": "c", "resolution": "completed",
                "draft": {"text": "", "revision": 3}}),
        );
        for outcome in ["prepared", "accepted", "rejected", "held", "conflict"] {
            let decoded: SendOutcome = serde_json::from_value(json!(outcome)).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), json!(outcome));
        }
    }

    #[test]
    fn queue_and_windows_round_trip() {
        request::<QueueEnqueueRequest>(
            "queue.enqueue",
            json!({"op": "queue.enqueue", "conversation_id": "c", "request_id": "q",
                "text": "later", "attachments": [attachment()]}),
        );
        request::<QueueCancelRequest>(
            "queue.cancel",
            json!({"op": "queue.cancel", "conversation_id": "c", "request_id": "q"}),
        );
        request::<QueuePauseRequest>(
            "queue.pause",
            json!({"op": "queue.pause", "conversation_id": "c", "paused": true}),
        );
        request::<WindowSaveRequest>(
            "window.save",
            json!({"op": "window.save", "window": {"id": "w", "workspace_id": "ws",
                "conversation_id": null, "browser_url": "", "x": 0.0, "y": 0.0,
                "width": 800.0, "height": 600.0}}),
        );
        request::<WindowCloseRequest>(
            "window.close",
            json!({"op": "window.close", "window_id": "w"}),
        );
        for op in [
            "queue.enqueue",
            "queue.cancel",
            "queue.pause",
            "window.save",
            "window.close",
        ] {
            response(op, &Ack::default(), json!({"type": "ack"}));
        }
    }

    #[test]
    fn attachments_round_trip() {
        request::<AttachmentPutRequest>(
            "attachment.put",
            json!({"op": "attachment.put", "conversation_id": "c", "request_id": "a",
                "name": "pixel.png", "data": "aGk="}),
        );
        request::<AttachmentImportRequest>(
            "attachment.import",
            json!({"op": "attachment.import", "conversation_id": "c", "request_id": "a",
                "path": "/tmp/pixel.png"}),
        );
        request::<AttachmentInspectRequest>(
            "attachment.inspect",
            json!({"op": "attachment.inspect", "conversation_id": "c", "attachment_id": "a"}),
        );
        request::<AttachmentReclaimPreviewRequest>(
            "attachment.reclaim.preview",
            json!({"op": "attachment.reclaim.preview", "conversation_id": "c",
                "attachment_id": "a"}),
        );
        request::<AttachmentReclaimApplyRequest>(
            "attachment.reclaim.apply",
            json!({"op": "attachment.reclaim.apply", "conversation_id": "c",
                "attachment_id": "a", "expected_generation": "g"}),
        );
        let reply = AttachmentReply {
            tag: AttachmentTag::Tag,
            attachment: attachment(),
        };
        let expected = json!({"type": "attachment", "attachment": attachment()});
        response("attachment.put", &reply, expected.clone());
        response("attachment.import", &reply, expected);
        response(
            "attachment.inspect",
            &AttachmentInspection {
                tag: AttachmentInspectionTag::Tag,
                attachment: attachment(),
                sha256: "ab".repeat(32),
            },
            json!({"type": "attachment_inspection", "attachment": attachment(),
                "sha256": "ab".repeat(32)}),
        );
        let preview_wire = serde_json::to_value(preview()).unwrap();
        response(
            "attachment.reclaim.preview",
            &AttachmentReclaimPreviewReply {
                tag: AttachmentReclaimPreviewTag::Tag,
                preview: preview(),
                scope: ExplicitSingleAttachment::Tag,
                automatic_gc_eligible: false,
                client_held_uploads: NotEnumerated::Tag,
                filesystem_reclaimed_bytes: 0,
            },
            json!({"type": "attachment_reclaim_preview", "preview": preview_wire,
                "scope": "explicit_single_attachment", "automatic_gc_eligible": false,
                "client_held_uploads": "not_enumerated", "filesystem_reclaimed_bytes": 0}),
        );
        response(
            "attachment.reclaim.apply",
            &AttachmentReclaim {
                tag: AttachmentReclaimTag::Tag,
                attachment: preview(),
                reclaimed_payload_bytes: 12,
                filesystem_reclaimed_bytes: 0,
                scope: ExplicitSingleAttachment::Tag,
            },
            json!({"type": "attachment_reclaim", "attachment": preview_wire,
                "reclaimed_payload_bytes": 12, "filesystem_reclaimed_bytes": 0,
                "scope": "explicit_single_attachment"}),
        );
    }
}
