//! Agent run contracts: lifecycle commands, review prompts, child transcripts,
//! and the two runtime supervisor operations the profile daemon sends.
//!
//! `agent.send` and `agent.answer` live in [`super::conversations`].
use super::conversations::Ack;
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::Attachment;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<AgentCancelRequest, Ack>("agent.cancel", Tier::EffectCommand),
        OperationSpec::new::<AgentResumeRequest, Ack>("agent.resume", Tier::EffectCommand),
        OperationSpec::new::<AgentDisconnectRequest, Ack>("agent.disconnect", Tier::EffectCommand),
        OperationSpec::new::<AgentSendReviewRequest, Ack>("agent.send_review", Tier::EffectCommand),
        OperationSpec::new::<AgentChildTranscriptRequest, ChildTranscriptPage>(
            "agent.child_transcript",
            Tier::Query,
        ),
        OperationSpec::new::<AgentListRequest, AgentList>("agent.list", Tier::Query),
        OperationSpec::new::<AgentAccountInspectRequest, AgentAccountInspection>(
            "agent.account_inspect",
            Tier::Query,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// Deserializes a field that is present, keeping an explicit `null` as
/// `Some(null)` so a handler can tell it from an absent field.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// `agent.cancel`: cancel the Conversation's active turn.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentCancelRequest {
    pub conversation_id: String,
    /// The turn the caller saw active. When present, the cancel applies only
    /// while that turn is still the active one, so a late or retried cancel
    /// never stops its successor. Absent, it cancels whatever turn is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub turn_id: Option<String>,
}

/// `agent.resume`: reconnect the Conversation's Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentResumeRequest {
    pub conversation_id: String,
}

/// `agent.disconnect`: stop the Conversation's idle Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentDisconnectRequest {
    pub conversation_id: String,
}

/// `agent.send_review`: submit a prompt that carries review feedback.
/// `request_id` is the caller-owned send identity shared with the draft send
/// intent. Exactly one of `review_anchor` and `review_feedback` is present.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentSendReviewRequest {
    pub conversation_id: String,
    pub request_id: String,
    pub text: String,
    /// Review prompts reject attachments; an empty list is accepted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// One review anchor.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub review_anchor: Option<Value>,
    /// A review feedback batch.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Value")]
    pub review_feedback: Option<Value>,
}

/// `agent.child_transcript`: one page of a provider child agent's transcript.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentChildTranscriptRequest {
    pub conversation_id: String,
    /// The parent message that records the child agents.
    pub message_id: String,
    pub child_id: String,
    /// Item offset; the daemon uses 0 when it is absent and allows at most 100000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub offset: Option<u64>,
    /// Provider page cursor, at most 4096 bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub cursor: Option<String>,
}

wire_tag!(ChildTranscriptTag, "child_transcript");

/// The `agent.child_transcript` reply, passed through from the provider bridge.
/// Offset-paged providers send `next_offset` (null on the last page); cursor-paged
/// providers send `next_cursor` instead.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ChildTranscriptPage {
    #[serde(rename = "type")]
    pub tag: ChildTranscriptTag,
    pub child_id: String,
    /// Provider-projected transcript items.
    #[schemars(with = "Vec<Value>")]
    pub items: Vec<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub next_offset: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<Option<String>>,
}

/// `agent.list`: the runtime supervisor's live Agent runs. The profile daemon
/// sends it on the runtime socket; `token` is the daemon's owner token.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentListRequest {
    pub token: String,
}

wire_tag!(AgentsTag, "agents");

/// The `agent.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentList {
    #[serde(rename = "type")]
    pub tag: AgentsTag,
    pub agents: Vec<AgentRun>,
}

/// One live Agent run in the runtime supervisor.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentRun {
    pub spec: AgentRunSpec,
    /// The provider process ID, when the adapter has one.
    pub pid: Option<u32>,
    /// Command keys the run holds receipts for.
    pub commands: Vec<String>,
}

/// The identity an Agent run was created with.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentRunSpec {
    pub conversation: String,
    pub run: String,
    pub provider: String,
    pub root: String,
    /// The pinned account execution context, or null for ambient credentials.
    #[serde(default)]
    #[schemars(with = "Value")]
    pub account: Option<Value>,
    /// The plugin provider worker a plugin-provider run is leased to; absent
    /// for bundled providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<super::providers::ProviderWorker>,
    /// The generic adapter definition an `adapter:` run launches, pinned by
    /// revision; absent for every other provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<super::providers::adapters::AdapterPin>,
}

/// `agent.account_inspect`: probe a provider account's native status. The
/// profile daemon sends it on the runtime socket; `token` is its owner token.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentAccountInspectRequest {
    pub token: String,
    /// The account execution context (`ade_core::model::AccountExecution`).
    #[schemars(with = "Value")]
    pub account: Value,
}

/// The `agent.account_inspect` reply: an untagged account inspection.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentAccountInspection {
    pub state: String,
    pub reason: String,
    pub version: Option<String>,
    /// The provider-specific identity, when the account is ready.
    #[schemars(with = "Value")]
    pub identity: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::super::{DEFINITIONS, bundle};
    use super::*;
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

    fn operation(op: &str) -> (String, String, String) {
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
            spec["tier"].as_str().unwrap().to_owned(),
        )
    }

    fn assert_valid(name: &str, value: &Value) {
        let errors: Vec<_> = validator(name)
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    /// A wire request (with `op`) validates and survives a typed round trip.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let (name, _, _) = operation(op);
        assert_valid(&name, &wire);
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(&decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
        decoded
    }

    /// A wire reply validates and survives a typed round trip.
    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let (_, name, _) = operation(op);
        assert_valid(&name, &wire);
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
        decoded
    }

    #[test]
    fn tiers_are_declared() {
        for (op, tier) in [
            ("agent.cancel", "effect_command"),
            ("agent.resume", "effect_command"),
            ("agent.disconnect", "effect_command"),
            ("agent.send_review", "effect_command"),
            ("agent.child_transcript", "query"),
            ("agent.list", "query"),
            ("agent.account_inspect", "query"),
        ] {
            assert_eq!(operation(op).2, tier, "{op}");
        }
    }

    #[test]
    fn lifecycle_commands_round_trip() {
        for op in ["agent.cancel", "agent.resume", "agent.disconnect"] {
            let wire = json!({"op": op, "conversation_id": "conversation_1"});
            match op {
                "agent.cancel" => drop(request::<AgentCancelRequest>(op, wire)),
                "agent.resume" => drop(request::<AgentResumeRequest>(op, wire)),
                _ => drop(request::<AgentDisconnectRequest>(op, wire)),
            }
            response::<Ack>(op, json!({"type": "ack"}));
            let (name, _, _) = operation(op);
            assert!(!validator(&name).is_valid(&json!({"op": op})));
        }
        let fenced: AgentCancelRequest = request(
            "agent.cancel",
            json!({"op": "agent.cancel", "conversation_id": "conversation_1", "turn_id": "turn_1"}),
        );
        assert_eq!(fenced.turn_id.as_deref(), Some("turn_1"));
    }

    #[test]
    fn send_review_keeps_explicit_null_payloads() {
        let feedback = json!({"workspace_id": "workspace_1", "comments": []});
        let decoded: AgentSendReviewRequest = request(
            "agent.send_review",
            json!({"op": "agent.send_review", "conversation_id": "conversation_1",
                "request_id": "send_1", "text": "review", "review_feedback": feedback}),
        );
        assert_eq!(decoded.review_feedback, Some(feedback));
        assert_eq!(decoded.review_anchor, None);
        let decoded: AgentSendReviewRequest = serde_json::from_value(json!({
            "conversation_id": "c", "request_id": "r", "text": "t",
            "attachments": [], "review_anchor": null,
        }))
        .unwrap();
        assert_eq!(decoded.review_anchor, Some(Value::Null));
        assert_eq!(decoded.review_feedback, None);
        let (name, _, _) = operation("agent.send_review");
        assert!(!validator(&name).is_valid(&json!({
            "op": "agent.send_review", "conversation_id": "c", "request_id": "r",
            "text": "t", "note": "extra",
        })));
    }

    #[test]
    fn child_transcript_round_trips_both_page_styles() {
        let decoded: AgentChildTranscriptRequest = request(
            "agent.child_transcript",
            json!({"op": "agent.child_transcript", "conversation_id": "c",
                "message_id": "m", "child_id": "child", "offset": 50, "cursor": "next"}),
        );
        assert_eq!(decoded.offset, Some(50));
        request::<AgentChildTranscriptRequest>(
            "agent.child_transcript",
            json!({"op": "agent.child_transcript", "conversation_id": "c",
                "message_id": "m", "child_id": "child"}),
        );
        let page: ChildTranscriptPage = response(
            "agent.child_transcript",
            json!({"type": "child_transcript", "child_id": "child",
                "items": [{"kind": "text"}], "next_offset": null}),
        );
        assert_eq!(page.next_offset, Some(None));
        response::<ChildTranscriptPage>(
            "agent.child_transcript",
            json!({"type": "child_transcript", "child_id": "child", "items": [],
                "next_offset": 100}),
        );
        response::<ChildTranscriptPage>(
            "agent.child_transcript",
            json!({"type": "child_transcript", "child_id": "child", "items": [],
                "next_cursor": "cursor_2"}),
        );
    }

    #[test]
    fn runtime_operations_round_trip() {
        request::<AgentListRequest>("agent.list", json!({"op": "agent.list", "token": "owner"}));
        let list: AgentList = response(
            "agent.list",
            json!({"type": "agents", "agents": [{
                "spec": {"conversation": "c", "run": "run_1", "provider": "codex",
                    "root": "/tmp/project", "account": null},
                "pid": 42, "commands": ["open"],
            }, {
                "spec": {"conversation": "d", "run": "run_2", "provider": "claude",
                    "root": "/tmp/project", "account": {"id": "account_1"}},
                "pid": null, "commands": [],
            }]}),
        );
        assert_eq!(list.agents[0].spec.run, "run_1");
        request::<AgentAccountInspectRequest>(
            "agent.account_inspect",
            json!({"op": "agent.account_inspect", "token": "owner",
                "account": {"id": "account_1", "provider": "codex",
                    "native_home": "/tmp/home", "generation": 1}}),
        );
        response::<AgentAccountInspection>(
            "agent.account_inspect",
            json!({"state": "ready", "reason": "Ready", "version": "1.0.0",
                "identity": {"email": "a@example.com"}}),
        );
        response::<AgentAccountInspection>(
            "agent.account_inspect",
            json!({"state": "missing", "reason": "Not installed", "version": null,
                "identity": null}),
        );
    }
}
