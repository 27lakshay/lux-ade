//! Agent run contracts: lifecycle commands, review prompts, child transcripts,
//! and the two runtime supervisor operations the profile daemon sends.
//!
//! `agent.send` and `agent.answer` live in [`super::conversations`].
use super::conversations::Ack;
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<AgentCancelRequest, AgentCancelOutcome>(
            "agent.cancel",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<AgentTerminateRequest, AgentTerminateOutcome>(
            "agent.terminate",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<AgentResumeRequest, Ack>("agent.resume", Tier::EffectCommand),
        OperationSpec::new::<AgentDisconnectRequest, Ack>("agent.disconnect", Tier::EffectCommand),
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

/// `agent.cancel`: target one immutable ADE runtime attempt and submission.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentCancelRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub conversation_id: String,
    /// Runtime attempt and ADE submission are the immutable target identity.
    pub source_attempt_id: String,
    pub submission_id: String,
    /// Native turn, when known. Absence is never a wildcard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub turn_id: Option<String>,
}

/// The `agent.cancel` reply. It reports what the provider acknowledged within
/// a short bounded wait, never a confirmed stop: the Conversation's `stop`
/// record follows the same operation to its confirmed or unresolved outcome.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentCancelOutcome {
    #[serde(rename = "type")]
    pub tag: AgentCancelOutcomeTag,
    pub operation_id: String,
    pub conversation_id: String,
    pub source_attempt_id: String,
    pub submission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub delivery: StopDelivery,
    /// The provider's interruption evidence; null while delivery is pending.
    pub evidence: Option<super::providers::ProviderCancelEvidence>,
}

/// Whether the provider answered the cancellation request.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopDelivery {
    /// The request was sent and no reply has arrived yet.
    Pending,
    /// The provider replied. This is acknowledgement, not proof of stop.
    Acknowledged,
    /// The provider replied with a refusal or error; the work may continue.
    Refused,
    /// No provider was attached, or the reply was lost.
    Unknown,
}

/// Where a Stop stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopOutcome {
    /// Asked for; no terminal evidence yet.
    Requested,
    /// Native terminal evidence or runtime-owned process exit ended the target.
    Confirmed,
    /// The target may still run, or work the provider queued can still run.
    /// `escalation` names what ADE can do next.
    Unresolved,
}

/// Evidence that confirmed a Stop.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopConfirmation {
    /// The provider reported the targeted turn or submission finished.
    NativeTerminal,
    /// The runtime confirmed that the provider process it owns exited.
    /// Child or background processes the provider started may survive it
    /// unless `background_work_remaining` is false.
    ProcessExit,
}

/// A declared step ADE offers when a Stop is unresolved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopEscalation {
    /// `agent.terminate`: end the runtime-owned provider process.
    TerminateProcess,
}

/// The latest Stop on a Conversation, keyed by its operation. It is bound
/// to one attempt and submission: a successor never settles it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ConversationStop {
    pub operation_id: String,
    pub source_attempt_id: String,
    pub submission_id: String,
    pub turn_id: Option<String>,
    pub requested_at_ms: i64,
    pub delivery: StopDelivery,
    pub outcome: StopOutcome,
    pub confirmation: Option<StopConfirmation>,
    /// The native terminal status that settled it, such as `interrupted`
    /// or `completed` when the turn ended before the interruption took hold.
    pub native_status: Option<String>,
    /// The provider's latest interruption evidence: scope, remaining
    /// foreground, queued and background work.
    pub evidence: Option<super::providers::ProviderCancelEvidence>,
    /// Why the outcome is unresolved, in plain words.
    pub reason: Option<String>,
    pub escalation: Option<StopEscalation>,
    pub settled_at_ms: Option<i64>,
}

impl ConversationStop {
    /// Records that the target may still run, offering termination.
    pub fn unresolve(&mut self, reason: String) {
        self.outcome = StopOutcome::Unresolved;
        self.confirmation = None;
        self.reason = Some(reason);
        self.escalation = Some(StopEscalation::TerminateProcess);
    }
    /// Records the evidence that ended the target. Queued native input that
    /// can still run keeps the Stop unresolved even so.
    pub fn confirm(&mut self, by: StopConfirmation, native_status: Option<String>, at_ms: i64) {
        self.native_status = native_status;
        self.settled_at_ms = Some(at_ms);
        let queued = self
            .evidence
            .as_ref()
            .and_then(|evidence| evidence.queued_work_count)
            .unwrap_or(0);
        if queued > 0 {
            self.unresolve(format!(
                "The turn ended, but {queued} queued input{} can still run",
                if queued == 1 { "" } else { "s" }
            ));
            return;
        }
        self.outcome = StopOutcome::Confirmed;
        self.confirmation = Some(by);
        self.reason = None;
        self.escalation = None;
    }
}

/// What a Conversation's open provider session was bound to when it opened:
/// the ADE attempt, the account context and generation it was checked
/// against, the native session it opened and the settings revision it used.
/// A later account change, settings change or reattach records a new one.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ConversationExecution {
    pub source_attempt_id: String,
    /// Managed or ambient; an ambient session uses the machine's own login,
    /// which ADE does not isolate.
    pub account_context: crate::model::AccountContext,
    pub account_id: Option<String>,
    /// The managed account generation verified before the session opened.
    pub account_generation: Option<u64>,
    pub native_session: String,
    pub settings_revision: u64,
    /// Whether the runtime reattached to a session that survived a daemon restart.
    pub reattached: bool,
    pub opened_at_ms: i64,
}

/// `agent.terminate`: end the provider process the runtime owns for this
/// attempt. Unlike `agent.cancel` it does not depend on the provider's
/// cooperation, and unlike `agent.disconnect` it may interrupt a running
/// turn. It never reaches a later attempt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentTerminateRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub conversation_id: String,
    pub source_attempt_id: String,
}

wire_tag!(AgentTerminateOutcomeTag, "agent_terminate_outcome");

/// What terminating the provider process proved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentTerminateOutcome {
    #[serde(rename = "type")]
    pub tag: AgentTerminateOutcomeTag,
    pub operation_id: String,
    pub conversation_id: String,
    pub source_attempt_id: String,
    /// Whether the runtime confirmed the provider process exited.
    pub process_exited: bool,
    /// What termination cannot prove, in plain words.
    pub limits: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentCancelOutcomeTag {
    AgentCancelOutcome,
}

/// `agent.resume`: reconnect the Conversation's Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentResumeRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub conversation_id: String,
    /// Required when the newest prompt's native outcome is unknown: reopening
    /// its native session may continue that interrupted work. ADE never
    /// resends the prompt either way.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub continue_interrupted: bool,
}

/// `agent.disconnect`: stop the Conversation's idle Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AgentDisconnectRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub conversation_id: String,
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
    /// The processes the runtime tracks in the provider's tree other than the
    /// provider itself, as last observed. It includes descendants that left
    /// the provider's process group. The daemon records them with the attempt,
    /// so one that escapes between the daemon's own observations stays
    /// attributed after a runtime loss (R006). Absent from a runtime that
    /// does not track provider trees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descendants: Option<Vec<TrackedDescendant>>,
}

/// One process a runtime tracks by identity: a PID with the platform start
/// stamp that tells a reused PID apart.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrackedDescendant {
    pub pid: i32,
    /// Platform start stamp; only equality and ordering are meaningful.
    pub started: u64,
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
    /// For a plugin provider, the pinned `ProviderWorker` whose
    /// `account_inspect` reads the account. Absent for a bundled provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<Value>")]
    pub worker: Option<Value>,
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
            let wire = if op == "agent.cancel" {
                json!({"op": op, "operation_id": "o", "conversation_id": "conversation_1",
                    "source_attempt_id": "run_1", "submission_id": "submission_1"})
            } else {
                json!({"op": op, "operation_id": "o", "conversation_id": "conversation_1"})
            };
            match op {
                "agent.cancel" => drop(request::<AgentCancelRequest>(op, wire)),
                "agent.resume" => drop(request::<AgentResumeRequest>(op, wire)),
                _ => drop(request::<AgentDisconnectRequest>(op, wire)),
            }
            if op == "agent.cancel" {
                response::<AgentCancelOutcome>(
                    op,
                    json!({"type": "agent_cancel_outcome", "operation_id": "o",
                        "conversation_id": "conversation_1", "source_attempt_id": "run_1",
                        "submission_id": "submission_1", "delivery": "acknowledged",
                        "evidence": {"scope": "turn", "interruption_requested": true,
                            "termination": "unknown", "active_work_remaining": null,
                            "queued_work_count": null, "background_work_remaining": null,
                            "observed_at_ms": null}}),
                );
            } else {
                response::<Ack>(op, json!({"type": "ack"}));
            }
            let (name, _, _) = operation(op);
            assert!(!validator(&name).is_valid(&json!({"op": op})));
            assert!(
                !validator(&name).is_valid(&json!({"op": op, "conversation_id": "conversation_1"}))
            );
        }
        let fenced: AgentCancelRequest = request(
            "agent.cancel",
            json!({"op": "agent.cancel", "operation_id": "o", "conversation_id": "conversation_1",
                "source_attempt_id":"run_1", "submission_id":"submission_1", "turn_id": "turn_1"}),
        );
        assert_eq!(fenced.turn_id.as_deref(), Some("turn_1"));
        // A pending delivery carries no evidence yet.
        response::<AgentCancelOutcome>(
            "agent.cancel",
            json!({"type": "agent_cancel_outcome", "operation_id": "o",
                "conversation_id": "conversation_1", "source_attempt_id": "run_1",
                "submission_id": "submission_1", "delivery": "pending", "evidence": null}),
        );
        drop(request::<AgentTerminateRequest>(
            "agent.terminate",
            json!({"op": "agent.terminate", "operation_id": "o", "conversation_id": "conversation_1",
                "source_attempt_id": "run_1"}),
        ));
        response::<AgentTerminateOutcome>(
            "agent.terminate",
            json!({"type": "agent_terminate_outcome", "operation_id": "o",
                "conversation_id": "conversation_1", "source_attempt_id": "run_1",
                "process_exited": true, "limits": []}),
        );
        let (name, _, _) = operation("agent.terminate");
        assert!(!validator(&name).is_valid(
            &json!({"op": "agent.terminate", "operation_id": "o", "conversation_id": "conversation_1"})
        ));
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
                "descendants": [{"pid": 43, "started": 1_700_000_000_000_000_u64}],
            }]}),
        );
        assert_eq!(list.agents[0].spec.run, "run_1");
        assert_eq!(list.agents[0].descendants, None);
        assert_eq!(
            list.agents[1].descendants,
            Some(vec![TrackedDescendant {
                pid: 43,
                started: 1_700_000_000_000_000
            }])
        );
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

#[cfg(test)]
mod stop_tests {
    use super::*;
    use crate::contract::providers::{
        ProviderCancelEvidence, ProviderCancelScope, ProviderCancelTermination,
    };

    fn requested(queued: Option<u64>) -> ConversationStop {
        ConversationStop {
            operation_id: "stop-1".into(),
            source_attempt_id: "attempt".into(),
            submission_id: "submission".into(),
            turn_id: Some("turn".into()),
            requested_at_ms: 1,
            delivery: StopDelivery::Acknowledged,
            outcome: StopOutcome::Requested,
            confirmation: None,
            native_status: None,
            evidence: Some(ProviderCancelEvidence {
                scope: ProviderCancelScope::Turn,
                interruption_requested: true,
                termination: ProviderCancelTermination::Requested,
                active_work_remaining: None,
                queued_work_count: queued,
                background_work_remaining: None,
                observed_at_ms: None,
            }),
            reason: None,
            escalation: None,
            settled_at_ms: None,
        }
    }

    #[test]
    fn terminal_evidence_confirms_a_stop_without_queued_input() {
        let mut stop = requested(Some(0));
        stop.confirm(
            StopConfirmation::NativeTerminal,
            Some("interrupted".into()),
            9,
        );
        assert_eq!(stop.outcome, StopOutcome::Confirmed);
        assert_eq!(stop.confirmation, Some(StopConfirmation::NativeTerminal));
        assert_eq!(stop.native_status.as_deref(), Some("interrupted"));
        assert_eq!((stop.escalation, stop.settled_at_ms), (None, Some(9)));
    }

    #[test]
    fn queued_native_input_keeps_an_ended_turn_unresolved() {
        let mut stop = requested(Some(2));
        stop.confirm(
            StopConfirmation::NativeTerminal,
            Some("interrupted".into()),
            9,
        );
        assert_eq!(stop.outcome, StopOutcome::Unresolved);
        assert_eq!(stop.confirmation, None);
        assert_eq!(stop.escalation, Some(StopEscalation::TerminateProcess));
        assert_eq!(
            stop.reason.as_deref(),
            Some("The turn ended, but 2 queued inputs can still run")
        );
    }

    #[test]
    fn process_exit_confirms_an_unresolved_stop() {
        let mut stop = requested(None);
        stop.unresolve("The provider refused the cancellation".into());
        stop.confirm(StopConfirmation::ProcessExit, None, 12);
        assert_eq!(stop.outcome, StopOutcome::Confirmed);
        assert_eq!(stop.confirmation, Some(StopConfirmation::ProcessExit));
        assert_eq!((stop.reason, stop.escalation), (None, None));
    }
}
