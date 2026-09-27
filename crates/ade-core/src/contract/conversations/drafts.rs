//! Draft recall and stash contracts (F036).
//!
//! Draft history keeps each window's sent and discarded drafts so a user can
//! recall them. A named stash keeps a draft, its attachments and its context
//! nodes per Conversation, so any window of that Conversation can restore it.
//! Every restore names the window draft revision the caller saw; a newer
//! draft is never overwritten, and a displaced non-empty draft is kept in
//! history before the restore replaces it.
use super::{DraftSchema, OperationSpec, Tier};
use crate::model::{Attachment, Draft};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<DraftHistoryListRequest, DraftHistoryList>(
            "draft.history.list",
            Tier::Query,
        ),
        // A retry finds the draft already at the requested revision and content.
        OperationSpec::new::<DraftHistoryRestoreRequest, DraftRestored>(
            "draft.history.restore",
            Tier::IdempotentCommand,
        ),
        // Saving the same content again converges; replacing needs the stash revision.
        OperationSpec::new::<DraftStashSaveRequest, DraftStashReply>(
            "draft.stash.save",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<DraftStashListRequest, DraftStashList>(
            "draft.stash.list",
            Tier::Query,
        ),
        OperationSpec::new::<DraftStashRestoreRequest, DraftRestored>(
            "draft.stash.restore",
            Tier::IdempotentCommand,
        ),
        // Dropping an absent stash converges; a changed stash is refused.
        OperationSpec::new::<DraftStashDropRequest, DraftStashDropped>(
            "draft.stash.drop",
            Tier::IdempotentCommand,
        ),
    ]
}

wire_tag!(DraftHistoryTag, "draft_history");
wire_tag!(DraftRestoreTag, "draft_restore");
wire_tag!(DraftStashTag, "draft_stash");
wire_tag!(DraftStashesTag, "draft_stashes");
wire_tag!(DraftStashDroppedTag, "draft_stash_dropped");

/// A reference the prompt carried besides its text and attachments, such as a
/// file, selection, terminal excerpt or review comment. ADE keeps `data`
/// exactly as the client supplied it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct DraftContextNode {
    pub id: String,
    pub kind: String,
    #[schemars(with = "Value")]
    pub data: Value,
}

/// Why a draft entered a window's history.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftHistoryKind {
    /// The draft was sent and its prompt accepted.
    Sent,
    /// The draft was cleared, or a restore replaced it.
    Discarded,
}

/// One recalled draft of a window.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct DraftHistoryEntry {
    pub id: i64,
    pub conversation_id: String,
    pub window_id: String,
    pub kind: DraftHistoryKind,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub context_nodes: Vec<DraftContextNode>,
    /// The window draft revision this text had when it was recorded.
    pub draft_revision: i64,
    /// Milliseconds since the Unix epoch.
    pub recorded_at: i64,
}

/// `draft.history.list`: a Conversation's recalled drafts, newest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftHistoryListRequest {
    pub conversation_id: String,
    /// Only this window's drafts; every window's when it is absent, so a
    /// closed or crashed window's drafts stay reachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub window_id: Option<String>,
    /// Return entries with an ID below this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub before: Option<i64>,
    /// Page size from 1 to 100; the daemon uses 20 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// The `draft.history.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftHistoryList {
    #[serde(rename = "type")]
    pub tag: DraftHistoryTag,
    pub entries: Vec<DraftHistoryEntry>,
    /// The `before` value of the next page; null on the last page.
    pub next_before: Option<i64>,
}

/// `draft.history.restore`: make a recalled draft the window's draft. The
/// entry may come from any window of the Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftHistoryRestoreRequest {
    pub conversation_id: String,
    pub window_id: String,
    pub entry_id: i64,
    /// The window draft revision the caller last saw; 0 when it saw none.
    pub expected_revision: i64,
    /// The revision the restored draft takes; greater than `expected_revision`.
    pub revision: i64,
}

/// A named draft kept for a Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct DraftStash {
    pub conversation_id: String,
    pub name: String,
    /// Starts at 1 and grows each time the stash is replaced.
    pub revision: i64,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub context_nodes: Vec<DraftContextNode>,
    /// The window that last saved it.
    pub window_id: String,
    /// Milliseconds since the Unix epoch.
    pub saved_at: i64,
}

/// `draft.stash.save`: keep a draft under a name. Saving a different draft
/// under a taken name needs the stash's current revision.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashSaveRequest {
    pub conversation_id: String,
    pub window_id: String,
    /// 1 to 128 characters, without control characters.
    pub name: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_nodes: Vec<DraftContextNode>,
    /// Replace the stash only if it is still at this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub expected_revision: Option<i64>,
}

/// How a stash save settled.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftStashSaveOutcome {
    Created,
    Replaced,
    /// The stash already held this draft; nothing was written.
    Unchanged,
}

/// The `draft.stash.save` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashReply {
    #[serde(rename = "type")]
    pub tag: DraftStashTag,
    pub outcome: DraftStashSaveOutcome,
    pub stash: DraftStash,
}

/// `draft.stash.list`: a Conversation's stashes, most recently saved first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashListRequest {
    pub conversation_id: String,
}

/// The `draft.stash.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashList {
    #[serde(rename = "type")]
    pub tag: DraftStashesTag,
    pub stashes: Vec<DraftStash>,
}

/// `draft.stash.restore`: make a stash the window's draft. The stash stays.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashRestoreRequest {
    pub conversation_id: String,
    pub window_id: String,
    pub name: String,
    /// The stash revision the caller listed; a replaced stash is refused.
    pub stash_revision: i64,
    /// The window draft revision the caller last saw; 0 when it saw none.
    pub expected_revision: i64,
    /// The revision the restored draft takes; greater than `expected_revision`.
    pub revision: i64,
}

/// How a restore settled.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftRestoreOutcome {
    Restored,
    /// A retry: the draft already holds this content at `revision`.
    AlreadyRestored,
    /// The window draft moved past `expected_revision`; nothing was written.
    /// `draft` is the current one; review it and restore again with its revision.
    Conflict,
}

/// The `draft.history.restore` and `draft.stash.restore` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftRestored {
    #[serde(rename = "type")]
    pub tag: DraftRestoreTag,
    pub outcome: DraftRestoreOutcome,
    /// The window's draft after the call.
    #[schemars(with = "DraftSchema")]
    pub draft: Draft,
    /// The restored context nodes. The window draft does not store them, so
    /// the caller reattaches them; empty on a conflict.
    pub context_nodes: Vec<DraftContextNode>,
    /// The history entry that keeps the draft this restore replaced; null
    /// when it replaced nothing worth keeping.
    pub displaced_entry_id: Option<i64>,
}

/// `draft.stash.drop`: delete a stash at the revision the caller saw.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashDropRequest {
    pub conversation_id: String,
    pub name: String,
    pub stash_revision: i64,
}

/// The `draft.stash.drop` reply. `dropped` is false when no stash had the name.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DraftStashDropped {
    #[serde(rename = "type")]
    pub tag: DraftStashDroppedTag,
    pub conversation_id: String,
    pub name: String,
    pub dropped: bool,
}
