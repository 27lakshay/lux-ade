//! Delegation and orchestration contracts (F104, F106, F107).
//!
//! A parent Conversation delegates work to a new child Conversation. The
//! daemon records the parent and child link durably, independent of either
//! Agent's process lifetime. Messages to a child travel through the child's
//! durable prompt queue. A wait is a non-blocking query: the daemon answers at
//! once with the child's outcome or a pending state, and the caller repeats it
//! until the returned deadline.
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
        repository_id: String,
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

wire_tag!(ChildDelegatedTag, "child_delegated");
wire_tag!(ChildListTag, "child_list");
wire_tag!(ChildTag, "child");
wire_tag!(ChildMessageQueuedTag, "child_message_queued");
wire_tag!(ChildWaitTag, "child_wait");

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
            "task_message_id": "m", "created_at": 5, "status": "idle", "error": null})
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
                    "repository_id": "r", "worktree_operation_id": "wop"},
                "task": "do it", "title": "Child", "provider_config": {}}),
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
}
