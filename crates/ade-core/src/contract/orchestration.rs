//! Delegation and orchestration contracts (F104, F105, F106, F107).
//!
//! A parent Conversation delegates work to a new child Conversation. The
//! daemon records the parent and child link durably, independent of either
//! Agent's process lifetime. Messages to a child travel through the child's
//! durable prompt queue. A wait is a non-blocking query: the daemon answers at
//! once with the child's outcome or a pending state, and the caller repeats it
//! until the returned deadline.
//!
//! Messages travel both ways. The parent Agent or the user queues a message
//! for a child; the child's Agent or the user queues a message for the child's
//! parent. Each message has its own ID and attribution, and
//! `orchestration.child.messages` lists both directions with their delivery.
//! A child's pending questions and approvals appear on its record, and the
//! parent Agent or the user answers each one once through
//! `orchestration.child.answer`.
//!
//! A parallel run group starts one task as several sibling children, one per
//! provider or account, under one group identity. Comparing a group reads
//! each run's Git state; it never merges or moves anything.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        // Creates a Conversation and queues its task; a retry must not create another.
        OperationSpec::new::<DelegateRequest, ChildDelegated>(
            "orchestration.delegate",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ChildrenRequest, ChildList>("orchestration.children", Tier::Query),
        OperationSpec::new::<ChildGetRequest, ChildReply>("orchestration.child.get", Tier::Query),
        // Queues one prompt for the child; a retry must not queue it twice.
        OperationSpec::new::<ChildSendRequest, ChildMessageQueued>(
            "orchestration.child.send",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ChildWaitRequest, ChildWait>("orchestration.child.wait", Tier::Query),
        // Answers one pending request of the child, as `agent.answer` does:
        // the same answer again converges, and a different one is refused.
        OperationSpec::new::<ChildAnswerRequest, ChildAnswered>(
            "orchestration.child.answer",
            Tier::EffectCommand,
        ),
        // Queues one prompt for the child's parent; a retry must not queue it twice.
        OperationSpec::new::<ParentSendRequest, ParentMessageQueued>(
            "orchestration.parent.send",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ChildMessagesRequest, ChildMessages>(
            "orchestration.child.messages",
            Tier::Query,
        ),
        // Creates every run's Conversation and queues its task; a retry must not create them again.
        OperationSpec::new::<GroupStartRequest, GroupStarted>(
            "orchestration.group.start",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<GroupsRequest, GroupList>("orchestration.groups", Tier::Query),
        OperationSpec::new::<GroupGetRequest, GroupReply>("orchestration.group.get", Tier::Query),
        OperationSpec::new::<GroupCompareRequest, GroupComparison>(
            "orchestration.group.compare",
            Tier::Query,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// Who asks. An Agent caller names its own Conversation; the daemon records
/// the attribution and refuses an Agent that acts as another Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Caller {
    User,
    Agent { conversation_id: String },
}

/// The child's provider account, stated explicitly.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AccountChoice {
    /// The parent's account; the child must use the parent's provider.
    Inherit,
    /// A managed account of the child's provider.
    Managed { account_id: String },
    /// The provider's own ambient login, outside ADE's managed accounts.
    Ambient,
}

/// Where the child works, stated explicitly. Parallel children in the same
/// workspace share its files; ADE never merges their edits.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum WorkspaceChoice {
    /// The parent's workspace.
    Same,
    /// A new linked worktree made by a succeeded `worktree.switch` with
    /// `create`, then opened as `workspace_id`. The daemon verifies both.
    NewWorktree {
        workspace_id: String,
        project_id: String,
        worktree_operation_id: String,
    },
}

/// `orchestration.delegate`: start a child Conversation for a task.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DelegateRequest {
    /// Caller-owned operation ID; a retry with the same payload returns the same child.
    pub operation_id: String,
    pub parent_conversation_id: String,
    pub caller: Caller,
    /// The child's provider ID, stated explicitly.
    pub provider: String,
    pub account: AccountChoice,
    pub workspace: WorkspaceChoice,
    /// The first prompt; at most 64 KiB.
    pub task: String,
    /// Defaults to the task's first line, cut to 45 characters; at most 256 bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub title: Option<String>,
    /// Provider settings; the daemon validates them for the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub provider_config: Option<Value>,
    /// Context for the child, stated explicitly: live attachments of the
    /// parent Conversation, at most 8. The daemon copies them to the child
    /// under new IDs and sends them with the task; the child's provider must
    /// accept each. None when absent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_attachments: Vec<crate::model::Attachment>,
}

/// `orchestration.children`: the children a Conversation delegated, oldest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildrenRequest {
    pub parent_conversation_id: String,
}

/// `orchestration.child.get`: one child and its parent link.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildGetRequest {
    pub child_conversation_id: String,
}

/// `orchestration.child.send`: queue a message for a delegated child.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildSendRequest {
    /// Caller-owned operation ID; a retry with the same payload returns the same message.
    pub operation_id: String,
    pub child_conversation_id: String,
    pub caller: Caller,
    /// At most 64 KiB.
    pub text: String,
}

/// `orchestration.child.wait`: read whether a child's turn has settled.
///
/// The daemon never holds the request open. Send `timeout_ms` on the first
/// call and the returned `deadline_ms` on each repeat.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildWaitRequest {
    pub child_conversation_id: String,
    /// The delegated task or child message to wait for; the newest one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub message_id: Option<String>,
    /// From 0 to 86 400 000; 0 when absent. Ignored when `deadline_ms` is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub timeout_ms: Option<u64>,
    /// An absolute deadline in Unix milliseconds from an earlier reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub deadline_ms: Option<i64>,
}

/// `orchestration.child.answer`: answer a question or approval a child is
/// waiting on, from the parent's view.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildAnswerRequest {
    pub child_conversation_id: String,
    /// One of the child's `pending_requests`.
    pub request_id: String,
    pub caller: Caller,
    /// As for `agent.answer`: accept, decline, cancel or answer.
    pub decision: String,
    /// Structured answers; required by the `answer` decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub answers: Option<Value>,
}

/// `orchestration.parent.send`: queue a message from a delegated child to
/// its parent Conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ParentSendRequest {
    /// Caller-owned operation ID; a retry with the same payload returns the same message.
    pub operation_id: String,
    /// The child that sends; its parent receives.
    pub child_conversation_id: String,
    /// The child's own Agent, or the user.
    pub caller: Caller,
    /// At most 64 KiB. The parent receives it after a line naming the child.
    pub text: String,
}

/// `orchestration.child.messages`: every message between a child and its
/// parent, oldest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildMessagesRequest {
    pub child_conversation_id: String,
}

wire_tag!(ChildDelegatedTag, "child_delegated");
wire_tag!(ChildListTag, "child_list");
wire_tag!(ChildTag, "child");
wire_tag!(ChildMessageQueuedTag, "child_message_queued");
wire_tag!(ChildWaitTag, "child_wait");
wire_tag!(ChildAnsweredTag, "child_answered");
wire_tag!(ParentMessageQueuedTag, "parent_message_queued");
wire_tag!(ChildMessagesTag, "child_messages");

/// What a pending request asks for.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Approval,
    Question,
}

/// A question or approval the child waits on, as its parent sees it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ChildRequest {
    pub request_id: String,
    pub kind: RequestKind,
    /// The provider's request method.
    pub method: String,
    /// The provider's request, including its questions or command.
    #[schemars(with = "Value")]
    pub params: Value,
}

/// How the child's workspace was chosen.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    Same,
    NewWorktree,
}

/// A durable parent and child link with the child's current Conversation state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ChildRecord {
    pub child_conversation_id: String,
    pub parent_conversation_id: String,
    /// The `orchestration.delegate` operation that created the child.
    pub operation_id: String,
    /// `user`, or `agent:` followed by the delegating Conversation ID.
    pub attribution: String,
    /// 1 for a child of a top-level Conversation.
    pub depth: u32,
    pub provider: String,
    pub account_id: Option<String>,
    pub workspace_id: String,
    pub workspace_mode: WorkspaceMode,
    pub worktree_operation_id: Option<String>,
    /// The queued prompt that carries the task.
    pub task_message_id: String,
    pub created_at: i64,
    /// The child Conversation's status, or `unavailable` when it is gone.
    pub status: String,
    pub error: Option<String>,
    /// Questions and approvals the child waits on, oldest first. Answer each
    /// once with `orchestration.child.answer`.
    pub pending_requests: Vec<ChildRequest>,
}

/// The `orchestration.delegate` reply: the child is admitted and its task is
/// queued. It says nothing about completion; wait for that.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildDelegated {
    #[serde(rename = "type")]
    pub tag: ChildDelegatedTag,
    pub child: ChildRecord,
}

/// The `orchestration.children` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildList {
    #[serde(rename = "type")]
    pub tag: ChildListTag,
    pub parent_conversation_id: String,
    pub children: Vec<ChildRecord>,
}

/// The `orchestration.child.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildReply {
    #[serde(rename = "type")]
    pub tag: ChildTag,
    pub child: ChildRecord,
}

/// The `orchestration.child.send` reply: the message is durably queued.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildMessageQueued {
    #[serde(rename = "type")]
    pub tag: ChildMessageQueuedTag,
    pub child_conversation_id: String,
    pub message_id: String,
    pub attribution: String,
}

/// The `orchestration.child.answer` reply: the answer is on its way to the
/// child's Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildAnswered {
    #[serde(rename = "type")]
    pub tag: ChildAnsweredTag,
    pub child_conversation_id: String,
    pub request_id: String,
    pub attribution: String,
}

/// The `orchestration.parent.send` reply: the message is durably queued for
/// the parent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ParentMessageQueued {
    #[serde(rename = "type")]
    pub tag: ParentMessageQueuedTag,
    pub parent_conversation_id: String,
    pub child_conversation_id: String,
    pub message_id: String,
    pub attribution: String,
}

/// Which way a message travelled.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageDirection {
    /// The delegated task or a message for the child.
    ToChild,
    /// A message from the child for its parent.
    ToParent,
}

/// Where a message stands in its receiver's prompt queue.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageDelivery {
    /// Durably queued; not yet submitted.
    Queued,
    /// Submitted to the receiver's Agent as a prompt.
    Submitted,
    /// Removed from the queue before submission.
    Cancelled,
    /// Neither queued nor recorded, for example after the receiver was removed.
    Missing,
}

/// One message between a child and its parent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ChildMessage {
    pub message_id: String,
    pub direction: MessageDirection,
    /// The Conversation that receives it.
    pub receiver_conversation_id: String,
    pub operation_id: String,
    /// `user`, or `agent:` followed by the sending Conversation ID.
    pub attribution: String,
    pub created_at: i64,
    pub delivery: MessageDelivery,
}

/// The `orchestration.child.messages` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildMessages {
    #[serde(rename = "type")]
    pub tag: ChildMessagesTag,
    pub child_conversation_id: String,
    pub parent_conversation_id: String,
    pub messages: Vec<ChildMessage>,
}

/// How far an unsettled turn has progressed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingPhase {
    /// Durably queued; not yet submitted to the provider.
    Queued,
    Starting,
    Running,
    Cancelling,
}

/// How a settled turn ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Interrupted,
    /// The turn ended but ADE holds no evidence of how.
    Unknown,
}

/// What a wait observed. Only `pending` means the caller should ask again.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WaitState {
    Settled {
        outcome: Outcome,
        error: Option<String>,
    },
    Pending {
        phase: PendingPhase,
    },
    /// The child asked a question or needs approval. Answer each request once
    /// with `agent.answer` on the child Conversation.
    NeedsInput {
        request_ids: Vec<String>,
    },
    /// The message will not progress without intervention.
    Blocked {
        reason: String,
    },
    /// The deadline passed while the turn was still pending.
    TimedOut {
        phase: PendingPhase,
    },
    /// The child Conversation no longer exists.
    Unavailable {
        reason: String,
    },
}

/// The `orchestration.child.wait` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildWait {
    #[serde(rename = "type")]
    pub tag: ChildWaitTag,
    pub child_conversation_id: String,
    pub message_id: String,
    #[serde(flatten)]
    pub state: WaitState,
    /// Whether the wait has an answer; false only for `pending`.
    pub done: bool,
    pub deadline_ms: i64,
}

/// One run of a parallel group: a provider, its account and its workspace,
/// each stated explicitly.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RunSpec {
    pub provider: String,
    pub account: AccountChoice,
    /// Each `new_worktree` run needs its own workspace. Runs in the same
    /// workspace share its files, and their changes cannot be told apart.
    pub workspace: WorkspaceChoice,
    /// Provider settings; the daemon validates them for the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub provider_config: Option<Value>,
}

/// `orchestration.group.start`: start one task as sibling children of a parent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupStartRequest {
    /// Caller-owned operation ID; a retry with the same payload returns the same group.
    pub operation_id: String,
    pub parent_conversation_id: String,
    pub caller: Caller,
    /// The first prompt of every run; at most 64 KiB.
    pub task: String,
    /// Every run's title. Defaults to the task's first line, cut to 45 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub title: Option<String>,
    /// From 2 to 8 runs, in the order the group reports them.
    pub runs: Vec<RunSpec>,
}

/// `orchestration.groups`: the parallel groups a Conversation started, oldest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupsRequest {
    pub parent_conversation_id: String,
}

/// `orchestration.group.get`: one group and its runs' status.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupGetRequest {
    pub group_id: String,
}

/// `orchestration.group.compare`: each run's outcome and Git changes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupCompareRequest {
    pub group_id: String,
}

wire_tag!(GroupStartedTag, "group_started");
wire_tag!(GroupListTag, "group_list");
wire_tag!(GroupTag, "group");
wire_tag!(GroupComparisonTag, "group_comparison");

/// Where a group stands as a whole.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupState {
    /// A run asks a question, needs approval or is blocked.
    NeedsAttention,
    /// No run needs attention and at least one is still pending.
    Running,
    /// Every run completed.
    Completed,
    /// Every run ended, and at least one did not provably complete.
    Ended,
}

/// Counts of the group's runs by their newest message's state. A timed-out
/// observation counts as pending.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct GroupSummary {
    pub state: GroupState,
    pub runs: u32,
    pub pending: u32,
    pub needs_input: u32,
    pub blocked: u32,
    pub completed: u32,
    pub failed: u32,
    pub interrupted: u32,
    /// Ended without evidence of how.
    pub unknown: u32,
    /// The run's Conversation no longer exists.
    pub unavailable: u32,
}

/// One run of a group and where its newest message stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RunRecord {
    /// The run's position in the start request, from 0.
    pub index: u32,
    /// The run's child link. Its `operation_id` is `<group ID>/<index>`.
    pub child: ChildRecord,
    /// The child's newest task or message.
    pub message_id: String,
    pub progress: WaitState,
    /// The workspace HEAD when the group started; null when it had none.
    pub base_commit: Option<String>,
}

/// A group and its runs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct GroupRecord {
    pub group_id: String,
    pub parent_conversation_id: String,
    /// The `orchestration.group.start` operation that created the group.
    pub operation_id: String,
    /// `user`, or `agent:` followed by the starting Conversation ID.
    pub attribution: String,
    pub title: String,
    pub created_at: i64,
    pub summary: GroupSummary,
    pub runs: Vec<RunRecord>,
}

/// The `orchestration.group.start` reply: every run is admitted and its task
/// is queued. It says nothing about completion.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupStarted {
    #[serde(rename = "type")]
    pub tag: GroupStartedTag,
    pub group: GroupRecord,
}

/// The `orchestration.groups` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupList {
    #[serde(rename = "type")]
    pub tag: GroupListTag,
    pub parent_conversation_id: String,
    pub groups: Vec<GroupRecord>,
}

/// The `orchestration.group.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupReply {
    #[serde(rename = "type")]
    pub tag: GroupTag,
    pub group: GroupRecord,
}

/// A file a run committed since the group started.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CommittedFile {
    /// The literal repository-relative path.
    pub path: String,
    /// The `git diff --name-status` letter, such as A, M, D or T.
    pub code: String,
}

/// What a run committed between the group's start and its current HEAD.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CommittedChanges {
    Known {
        base_commit: String,
        /// Commits reachable from HEAD and not from the base.
        commits: u64,
        files: Vec<CommittedFile>,
        /// More files changed than the reply carries (2 000).
        truncated: bool,
    },
    /// ADE cannot prove what was committed, for example without a base commit.
    Unknown { reason: String },
}

/// A run's Git changes, or why they could not be read.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunChanges {
    Available {
        /// The branch name, or `(detached)`.
        branch: String,
        /// The HEAD commit, or `(initial)` before the first commit.
        head: String,
        /// The workspace's `review.status` revision at the time of the read.
        revision: String,
        conflicts: u64,
        /// Staged, unstaged and untracked changes, as `review.status` reports them.
        uncommitted: Vec<super::review::ReviewFile>,
        committed: CommittedChanges,
    },
    Unavailable {
        reason: String,
    },
}

/// One run's outcome and changes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RunComparison {
    pub index: u32,
    pub child_conversation_id: String,
    pub provider: String,
    pub account_id: Option<String>,
    pub workspace_id: String,
    pub workspace_mode: WorkspaceMode,
    pub progress: WaitState,
    /// The workspace is the parent's or another run's, so its changes are
    /// not this run's alone.
    pub shared_workspace: bool,
    pub changes: RunChanges,
}

/// A path that runs in different workspaces both changed. ADE merges nothing;
/// the person chooses.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PathOverlap {
    pub path: String,
    /// Every run whose workspace changed the path.
    pub runs: Vec<u32>,
}

/// The `orchestration.group.compare` reply. It reads Git and changes nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GroupComparison {
    #[serde(rename = "type")]
    pub tag: GroupComparisonTag,
    pub group_id: String,
    pub summary: GroupSummary,
    pub runs: Vec<RunComparison>,
    /// Paths changed in more than one workspace, sorted by path.
    pub overlaps: Vec<PathOverlap>,
    pub compared_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::json;

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

    fn child() -> Value {
        json!({"child_conversation_id": "c2", "parent_conversation_id": "c1",
            "operation_id": "op", "attribution": "agent:c1", "depth": 1,
            "provider": "codex", "account_id": null, "workspace_id": "w",
            "workspace_mode": "same", "worktree_operation_id": null,
            "task_message_id": "m", "created_at": 5, "status": "waiting", "error": null,
            "pending_requests": [{"request_id": "q", "kind": "question",
                "method": "item/tool/requestUserInput", "params": {"questions": []}}]})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<DelegateRequest>(
            "orchestration.delegate",
            json!({"op": "orchestration.delegate", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "agent", "conversation_id": "c1"},
                "provider": "codex", "account": {"mode": "inherit"},
                "workspace": {"mode": "same"}, "task": "do it"}),
        );
        request::<DelegateRequest>(
            "orchestration.delegate",
            json!({"op": "orchestration.delegate", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "user"},
                "provider": "claude", "account": {"mode": "managed", "account_id": "a"},
                "workspace": {"mode": "new_worktree", "workspace_id": "w2",
                    "project_id": "r", "worktree_operation_id": "wop"},
                "task": "do it", "title": "Child", "provider_config": {},
                "context_attachments": [{"id": "a1", "name": "notes.txt",
                    "media_type": "text/plain", "size": 4}]}),
        );
        request::<ChildrenRequest>(
            "orchestration.children",
            json!({"op": "orchestration.children", "parent_conversation_id": "c1"}),
        );
        request::<ChildGetRequest>(
            "orchestration.child.get",
            json!({"op": "orchestration.child.get", "child_conversation_id": "c2"}),
        );
        request::<ChildSendRequest>(
            "orchestration.child.send",
            json!({"op": "orchestration.child.send", "operation_id": "op2",
                "child_conversation_id": "c2", "caller": {"kind": "user"}, "text": "more"}),
        );
        request::<ChildWaitRequest>(
            "orchestration.child.wait",
            json!({"op": "orchestration.child.wait", "child_conversation_id": "c2",
                "message_id": "m", "timeout_ms": 1000}),
        );
        request::<ChildWaitRequest>(
            "orchestration.child.wait",
            json!({"op": "orchestration.child.wait", "child_conversation_id": "c2",
                "deadline_ms": 99}),
        );
        request::<ChildAnswerRequest>(
            "orchestration.child.answer",
            json!({"op": "orchestration.child.answer", "child_conversation_id": "c2",
                "request_id": "q", "caller": {"kind": "agent", "conversation_id": "c1"},
                "decision": "answer", "answers": {"first": "yes"}}),
        );
        request::<ParentSendRequest>(
            "orchestration.parent.send",
            json!({"op": "orchestration.parent.send", "operation_id": "op3",
                "child_conversation_id": "c2", "caller": {"kind": "agent", "conversation_id": "c2"},
                "text": "done"}),
        );
        request::<ChildMessagesRequest>(
            "orchestration.child.messages",
            json!({"op": "orchestration.child.messages", "child_conversation_id": "c2"}),
        );
        let (name, _) = names("orchestration.delegate");
        // The workspace and account are never implied.
        assert!(!valid(
            &name,
            &json!({"op": "orchestration.delegate", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "user"},
                "provider": "codex", "account": {"mode": "inherit"}, "task": "t"})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "orchestration.delegate", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "user"},
                "provider": "codex", "workspace": {"mode": "same"}, "task": "t"})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "orchestration.delegate", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "agent"},
                "provider": "codex", "account": {"mode": "inherit"},
                "workspace": {"mode": "same"}, "task": "t"})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<ChildDelegated>(
            "orchestration.delegate",
            json!({"type": "child_delegated", "child": child()}),
        );
        response::<ChildList>(
            "orchestration.children",
            json!({"type": "child_list", "parent_conversation_id": "c1", "children": [child()]}),
        );
        response::<ChildReply>(
            "orchestration.child.get",
            json!({"type": "child", "child": child()}),
        );
        response::<ChildMessageQueued>(
            "orchestration.child.send",
            json!({"type": "child_message_queued", "child_conversation_id": "c2",
                "message_id": "m2", "attribution": "user"}),
        );
        response::<ChildAnswered>(
            "orchestration.child.answer",
            json!({"type": "child_answered", "child_conversation_id": "c2",
                "request_id": "q", "attribution": "agent:c1"}),
        );
        response::<ParentMessageQueued>(
            "orchestration.parent.send",
            json!({"type": "parent_message_queued", "parent_conversation_id": "c1",
                "child_conversation_id": "c2", "message_id": "m3", "attribution": "agent:c2"}),
        );
        response::<ChildMessages>(
            "orchestration.child.messages",
            json!({"type": "child_messages", "child_conversation_id": "c2",
                "parent_conversation_id": "c1", "messages": [
                    {"message_id": "m", "direction": "to_child", "receiver_conversation_id": "c2",
                        "operation_id": "op", "attribution": "user", "created_at": 5,
                        "delivery": "submitted"},
                    {"message_id": "m3", "direction": "to_parent", "receiver_conversation_id": "c1",
                        "operation_id": "op3", "attribution": "agent:c2", "created_at": 6,
                        "delivery": "queued"}]}),
        );
        for (state, done) in [
            (
                json!({"state": "settled", "outcome": "failed", "error": "x"}),
                true,
            ),
            (json!({"state": "pending", "phase": "queued"}), false),
            (json!({"state": "needs_input", "request_ids": ["q"]}), true),
            (json!({"state": "blocked", "reason": "paused"}), true),
            (json!({"state": "timed_out", "phase": "running"}), true),
            (json!({"state": "unavailable", "reason": "gone"}), true),
        ] {
            let mut wire = json!({"type": "child_wait", "child_conversation_id": "c2",
                "message_id": "m", "done": done, "deadline_ms": 10});
            wire.as_object_mut()
                .unwrap()
                .extend(state.as_object().unwrap().clone());
            response::<ChildWait>("orchestration.child.wait", wire);
        }
    }

    fn group() -> Value {
        json!({"group_id": "g", "parent_conversation_id": "c1", "operation_id": "op",
            "attribution": "user", "title": "Try", "created_at": 5,
            "summary": {"state": "running", "runs": 2, "pending": 1, "needs_input": 0,
                "blocked": 0, "completed": 1, "failed": 0, "interrupted": 0, "unknown": 0,
                "unavailable": 0},
            "runs": [{"index": 0, "child": child(), "message_id": "m",
                "progress": {"state": "pending", "phase": "queued"}, "base_commit": "abc"}]})
    }

    #[test]
    fn group_requests_round_trip_and_need_explicit_runs() {
        request::<GroupStartRequest>(
            "orchestration.group.start",
            json!({"op": "orchestration.group.start", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "user"}, "task": "do it",
                "runs": [
                    {"provider": "codex", "account": {"mode": "ambient"},
                        "workspace": {"mode": "new_worktree", "workspace_id": "w2",
                            "project_id": "r", "worktree_operation_id": "wop"}},
                    {"provider": "claude", "account": {"mode": "managed", "account_id": "a"},
                        "workspace": {"mode": "same"}, "provider_config": {}}]}),
        );
        request::<GroupsRequest>(
            "orchestration.groups",
            json!({"op": "orchestration.groups", "parent_conversation_id": "c1"}),
        );
        request::<GroupGetRequest>(
            "orchestration.group.get",
            json!({"op": "orchestration.group.get", "group_id": "g"}),
        );
        request::<GroupCompareRequest>(
            "orchestration.group.compare",
            json!({"op": "orchestration.group.compare", "group_id": "g"}),
        );
        let (name, _) = names("orchestration.group.start");
        // A run never implies its workspace.
        assert!(!valid(
            &name,
            &json!({"op": "orchestration.group.start", "operation_id": "op",
                "parent_conversation_id": "c1", "caller": {"kind": "user"}, "task": "t",
                "runs": [{"provider": "codex", "account": {"mode": "ambient"}}]})
        ));
    }

    #[test]
    fn group_replies_round_trip_in_the_daemon_shape() {
        response::<GroupStarted>(
            "orchestration.group.start",
            json!({"type": "group_started", "group": group()}),
        );
        response::<GroupList>(
            "orchestration.groups",
            json!({"type": "group_list", "parent_conversation_id": "c1", "groups": [group()]}),
        );
        response::<GroupReply>(
            "orchestration.group.get",
            json!({"type": "group", "group": group()}),
        );
        let summary = group()["summary"].clone();
        response::<GroupComparison>(
            "orchestration.group.compare",
            json!({"type": "group_comparison", "group_id": "g", "summary": summary,
                "compared_at": 9,
                "overlaps": [{"path": "a.rs", "runs": [0, 1]}],
                "runs": [
                    {"index": 0, "child_conversation_id": "c2", "provider": "codex",
                        "account_id": null, "workspace_id": "w2", "workspace_mode": "new_worktree",
                        "progress": {"state": "settled", "outcome": "completed", "error": null},
                        "shared_workspace": false,
                        "changes": {"state": "available", "branch": "b", "head": "h",
                            "revision": "r", "conflicts": 0,
                            "uncommitted": [{"path": "a.rs", "code": ".M", "staged": false,
                                "unstaged": true, "conflict": false, "untracked": false,
                                "submodule": false}],
                            "committed": {"state": "known", "base_commit": "abc", "commits": 1,
                                "files": [{"path": "b.rs", "code": "A"}], "truncated": false}}},
                    {"index": 1, "child_conversation_id": "c3", "provider": "claude",
                        "account_id": "a", "workspace_id": "w", "workspace_mode": "same",
                        "progress": {"state": "unavailable", "reason": "gone"},
                        "shared_workspace": true,
                        "changes": {"state": "unavailable", "reason": "Workspace moved"}}]}),
        );
    }
}
