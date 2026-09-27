//! Conversation, draft, send-intent, queue, window, attachment, prompt and
//! answer contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::{Attachment, Conversation, Draft, Message, PendingRequest, QueuedPrompt};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
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
        // The queue delivers each queued prompt to the provider when it drains.
        OperationSpec::new::<QueueEnqueueRequest, Ack>("queue.enqueue", Tier::EffectCommand),
        OperationSpec::new::<QueueCancelRequest, Ack>("queue.cancel", Tier::IdempotentCommand),
        OperationSpec::new::<QueuePauseRequest, Ack>("queue.pause", Tier::IdempotentCommand),
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
    ]
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
    /// `message`, `draft`, `queued_prompt`, `send_intent` or `already_discarded`.
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
            ("queue.enqueue", "effect_command"),
            ("queue.cancel", "idempotent_command"),
            ("queue.pause", "idempotent_command"),
            ("window.save", "idempotent_command"),
            ("window.close", "idempotent_command"),
            ("attachment.put", "idempotent_command"),
            ("attachment.import", "idempotent_command"),
            ("attachment.inspect", "query"),
            ("attachment.reclaim.preview", "query"),
            ("attachment.reclaim.apply", "idempotent_command"),
        ] {
            assert_eq!(tier(op), expected, "{op}");
        }
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
