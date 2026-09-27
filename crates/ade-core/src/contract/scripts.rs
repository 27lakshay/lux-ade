//! Workspace script contracts: configured scripts and their supervised runs.
use super::placement::ExecutionHost;
use super::{FrameSpec, OperationSpec, Tier};
use crate::scripts::Script;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ScriptListRequest, ScriptList>("script.list", Tier::Query),
        OperationSpec::new::<ScriptInspectRequest, ScriptInspection>("script.inspect", Tier::Query),
        OperationSpec::new::<ScriptStartRequest, ScriptRun>("script.start", Tier::EffectCommand),
        OperationSpec::new::<ScriptStopRequest, ScriptRun>("script.stop", Tier::EffectCommand),
        OperationSpec::new::<ScriptRetireRequest, ScriptRetired>(
            "script.retire",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ScriptRunsRequest, ScriptRuns>("script.runs", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `script.list`: the workspace's configured package scripts and ADE recipes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptListRequest {
    pub workspace_id: String,
}

/// `script.runs`: the workspace's registered script runs the runtime still knows.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRunsRequest {
    pub workspace_id: String,
}

/// `script.start`: launch a configured script by name as a supervised PTY.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptStartRequest {
    pub workspace_id: String,
    pub name: String,
}

/// `script.inspect`: one run's state and output tail.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptInspectRequest {
    pub workspace_id: String,
    pub run_id: String,
    /// Output tail size, 1 to 32768 bytes; the daemon uses 8192 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub tail_bytes: Option<u64>,
}

/// `script.stop`: stop a run and wait up to five seconds for it to exit.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptStopRequest {
    pub workspace_id: String,
    pub run_id: String,
}

/// `script.retire`: remove a stopped run and its retained output.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRetireRequest {
    pub workspace_id: String,
    pub run_id: String,
}

wire_tag!(ScriptsTag, "scripts");
wire_tag!(ScriptRunsTag, "script_runs");
wire_tag!(ScriptRunTag, "script_run");
wire_tag!(ScriptRetiredTag, "ack");

/// The `script.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptList {
    #[serde(rename = "type")]
    pub tag: ScriptsTag,
    pub workspace_id: String,
    pub scripts: Vec<Script>,
}

/// A run's observed process state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptRunStatus {
    Running,
    Exited,
    Unknown,
}

/// One run as `script.runs` lists it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRunState {
    pub run_id: String,
    /// The script name encoded in the run ID; empty if it does not parse.
    pub name: String,
    pub state: ScriptRunStatus,
    /// The runtime's terminal metrics, passed through unchanged.
    #[schemars(with = "Value")]
    pub metrics: Value,
    /// The runtime's exit outcome (`kind` is `success`, `failure`, `signaled`
    /// or `unknown`), present once the runtime reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub exit_status: Option<Value>,
}

/// The `script.runs` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRuns {
    #[serde(rename = "type")]
    pub tag: ScriptRunsTag,
    pub workspace_id: String,
    /// The execution host the workspace's scripts run on, from its placement.
    pub execution_host: ExecutionHost,
    pub runs: Vec<ScriptRunState>,
}

/// The `script.start` and `script.stop` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRun {
    #[serde(rename = "type")]
    pub tag: ScriptRunTag,
    pub workspace_id: String,
    /// The execution host the workspace's scripts run on, from its placement.
    pub execution_host: ExecutionHost,
    #[serde(flatten)]
    pub run: ScriptRunState,
    /// The selected Node toolchain, on `script.start` of a Node-based script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub toolchain: Option<Value>,
}

/// Whether the returned output covers everything the run produced.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputCoverageStatus {
    Complete,
    Pending,
    Incomplete,
}

/// Why output coverage is pending or incomplete.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputCoverageReason {
    CaptureError,
    DurableOutputUnavailable,
    RetentionOverflow,
    SegmentGap,
    ProcessRunning,
    ExitUnknown,
    CaptureGap,
    TailLimited,
}

/// How much of a run's output the durable spool holds and the reply returns.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct OutputCoverage {
    pub status: OutputCoverageStatus,
    /// Null when the status is `complete`.
    pub reason: Option<OutputCoverageReason>,
    pub produced_bytes: Option<u64>,
    pub captured_through_offset: Option<u64>,
    pub returned_start_offset: Option<u64>,
}

/// The `script.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptInspection {
    #[serde(rename = "type")]
    pub tag: ScriptRunTag,
    pub workspace_id: String,
    /// The execution host the workspace's scripts run on, from its placement.
    pub execution_host: ExecutionHost,
    #[serde(flatten)]
    pub run: ScriptRunState,
    /// The runtime's live `terminal.tail` reply, passed through unchanged.
    #[schemars(with = "Value")]
    pub output: Value,
    pub output_coverage: OutputCoverage,
    /// The durable spool tail, passed through unchanged.
    #[schemars(with = "Value")]
    pub durable_output: Value,
}

/// The `script.retire` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ScriptRetired {
    #[serde(rename = "type")]
    pub tag: ScriptRetiredTag,
    pub workspace_id: String,
    pub run_id: String,
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

    fn metrics() -> Value {
        json!({"transfer_id": "transfer_1", "shell_running": false, "terminal_bytes": 3,
            "exit_status": {"kind": "success", "code": 0}})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<ScriptListRequest>(
            "script.list",
            json!({"op": "script.list", "workspace_id": "w"}),
        );
        request::<ScriptRunsRequest>(
            "script.runs",
            json!({"op": "script.runs", "workspace_id": "w"}),
        );
        request::<ScriptStartRequest>(
            "script.start",
            json!({"op": "script.start", "workspace_id": "w", "name": "dev"}),
        );
        request::<ScriptInspectRequest>(
            "script.inspect",
            json!({"op": "script.inspect", "workspace_id": "w", "run_id": "r", "tail_bytes": 4096}),
        );
        request::<ScriptInspectRequest>(
            "script.inspect",
            json!({"op": "script.inspect", "workspace_id": "w", "run_id": "r"}),
        );
        request::<ScriptStopRequest>(
            "script.stop",
            json!({"op": "script.stop", "workspace_id": "w", "run_id": "r"}),
        );
        request::<ScriptRetireRequest>(
            "script.retire",
            json!({"op": "script.retire", "workspace_id": "w", "run_id": "r"}),
        );
        let (name, _) = names("script.start");
        assert!(!valid(
            &name,
            &json!({"op": "script.start", "workspace_id": "w"})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "script.start", "workspace_id": "w", "name": "dev", "extra": 1})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<ScriptList>(
            "script.list",
            json!({"type": "scripts", "workspace_id": "w", "scripts": [
                {"kind": "package_json", "name": "dev", "command": "vite"},
                {"kind": "ade_recipe", "name": "db", "program": "docker", "args": ["up"], "cwd": "."},
            ]}),
        );
        response::<ScriptRuns>(
            "script.runs",
            json!({"type": "script_runs", "workspace_id": "w", "execution_host": {"kind": "local"}, "runs": [
                {"run_id": "r", "name": "dev", "state": "exited", "metrics": metrics(),
                 "exit_status": {"kind": "success", "code": 0}},
                {"run_id": "s", "name": "", "state": "running", "metrics": {"shell_running": true}},
            ]}),
        );
        response::<ScriptRun>(
            "script.start",
            json!({"type": "script_run", "workspace_id": "w", "execution_host": {"kind": "local"},
                "run_id": "r", "name": "dev", "state": "running", "metrics": {"shell_running": true}, "toolchain": {"node": "22"}}),
        );
        response::<ScriptRun>(
            "script.stop",
            json!({"type": "script_run", "workspace_id": "w", "execution_host": {"kind": "local"},
                "run_id": "r", "name": "dev",
                "state": "exited", "metrics": metrics(), "exit_status": {"kind": "success", "code": 0}}),
        );
        response::<ScriptInspection>(
            "script.inspect",
            json!({"type": "script_run", "workspace_id": "w", "execution_host": {"kind": "local"},
                "run_id": "r", "name": "dev",
                "state": "exited", "metrics": metrics(), "exit_status": {"kind": "success", "code": 0},
                "output": {"transfer_id": "transfer_1", "data": "abc"},
                "output_coverage": {"status": "complete", "reason": null, "produced_bytes": 3,
                    "captured_through_offset": 3, "returned_start_offset": 0},
                "durable_output": {"available": true}}),
        );
        response::<ScriptInspection>(
            "script.inspect",
            json!({"type": "script_run", "workspace_id": "w", "execution_host": {"kind": "local"},
                "run_id": "r", "name": "dev",
                "state": "unknown", "metrics": null, "output": {},
                "output_coverage": {"status": "incomplete", "reason": "durable_output_unavailable",
                    "produced_bytes": null, "captured_through_offset": null, "returned_start_offset": null},
                "durable_output": {"available": false}}),
        );
        response::<ScriptRetired>(
            "script.retire",
            json!({"type": "ack", "workspace_id": "w", "run_id": "r"}),
        );
        let (_, name) = names("script.stop");
        assert!(!valid(
            &name,
            &json!({"type": "script_run", "workspace_id": "w", "run_id": "r", "name": "dev",
                "state": "stopped", "metrics": {}})
        ));
    }
}
