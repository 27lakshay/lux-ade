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

/// The `browser.open`, `browser.navigate` and `browser.close` reply, relayed
/// from the owner. `payload_fingerprint` is the daemon's fingerprint of the
/// operation, its profile, owner, tab and URL.
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
}
