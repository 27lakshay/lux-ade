//! Conversation read, prompt and answer contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::{Attachment, Conversation, Message, PendingRequest, QueuedPrompt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ConversationGetRequest, ConversationSnapshot>(
            "conversation.get",
            Tier::Query,
        ),
        OperationSpec::new::<AgentSendRequest, Ack>("agent.send", Tier::EffectCommand),
        OperationSpec::new::<AgentAnswerRequest, Ack>("agent.answer", Tier::EffectCommand),
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
