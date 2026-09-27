//! Terminal contracts: the daemon's `terminal.*` operations and the
//! daemon-to-runtime terminal commands.
//!
//! The runtime commands (`terminal.ensure`, `terminal.launch`, `terminal.list`,
//! `terminal.tail`, and the runtime side of `terminal.stop`, `terminal.retire`
//! and `terminal.restart`) travel only between the daemon and the runtime
//! supervisor. The daemon's command socket rejects them, so they live in
//! [`runtime`] and stay out of the client bundle.
use super::conversations::{Ack, AckTag};
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<TerminalCreateRequest, TerminalCreated>(
            "terminal.create",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<TerminalOperationRequest, TerminalOperation>(
            "terminal.operation",
            Tier::Query,
        ),
        OperationSpec::new::<TerminalRestartRequest, Ack>("terminal.restart", Tier::EffectCommand),
        OperationSpec::new::<TerminalStopRequest, Ack>("terminal.stop", Tier::EffectCommand),
        OperationSpec::new::<TerminalRetireRequest, Ack>("terminal.retire", Tier::EffectCommand),
    ]
}

/// Terminal stream frames bypass `session.subscribe`: the daemon copies them
/// from the runtime without parsing, so they have no feed contract.
pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `terminal.create`: add another terminal to a workspace.
///
/// `operation_id` is the caller-owned receipt ID; `request_id` is accepted as
/// its older name. Without one, every call creates a new terminal.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalCreateRequest {
    pub workspace_id: String,
    /// Absent or a string of 1 to 256 bytes; the daemon rejects `null`.
    #[serde(default, alias = "request_id", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub operation_id: Option<String>,
}

/// `terminal.operation`: read the terminal a `terminal.create` receipt produced.
/// `request_id` is accepted as the older name of `operation_id`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalOperationRequest {
    pub workspace_id: String,
    #[serde(alias = "request_id")]
    pub operation_id: String,
}

/// `terminal.restart`: start a new shell in an exited terminal. Without
/// `workspace_id` the daemon uses its default workspace; without
/// `terminal_id` it uses the workspace's primary terminal.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct TerminalRestartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
}

/// `terminal.stop`: stop a workspace terminal's shell.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalStopRequest {
    pub workspace_id: String,
    pub terminal_id: String,
}

/// `terminal.retire`: remove a stopped terminal from its workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalRetireRequest {
    pub workspace_id: String,
    pub terminal_id: String,
}

wire_tag!(TerminalOperationTag, "terminal_operation");

/// The `terminal.create` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalCreated {
    #[serde(rename = "type")]
    pub tag: AckTag,
    pub terminal_id: String,
}

/// The `terminal.operation` reply. `request_id` echoes the requested
/// operation ID under its older name.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalOperation {
    #[serde(rename = "type")]
    pub tag: TerminalOperationTag,
    pub workspace_id: String,
    pub request_id: String,
    pub terminal_id: String,
}

/// Daemon-to-runtime terminal commands and replies. Rust only.
pub mod runtime {
    use crate::model::WorkspaceRecord;
    use crate::terminal_launch::Launch;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    /// A runtime terminal command, tagged by `op`.
    #[derive(Serialize, Deserialize, Clone, Debug)]
    #[serde(tag = "op")]
    pub enum Command {
        #[serde(rename = "terminal.list")]
        List,
        #[serde(rename = "terminal.tail")]
        Tail {
            workspace_id: String,
            terminal_id: String,
            limit_bytes: u64,
        },
        #[serde(rename = "terminal.stop")]
        Stop {
            workspace_id: String,
            terminal_id: String,
        },
        #[serde(rename = "terminal.retire")]
        Retire {
            workspace_id: String,
            terminal_id: String,
        },
        #[serde(rename = "terminal.ensure")]
        Ensure(Ensure),
        #[serde(rename = "terminal.restart")]
        Restart(Ensure),
        #[serde(rename = "terminal.launch")]
        Launch {
            workspace: WorkspaceRecord,
            terminal_key: String,
            launch: Launch,
            session_subscribers: usize,
        },
    }

    /// Start a terminal's shell if it is absent (`terminal.ensure`) or exited
    /// (`terminal.restart`). `existing_only` refuses to start a new shell.
    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub struct Ensure {
        pub workspace: WorkspaceRecord,
        pub terminal_key: String,
        pub existing_only: bool,
        pub session_subscribers: usize,
    }

    impl Command {
        pub fn to_value(&self) -> Value {
            serde_json::to_value(self).expect("terminal commands serialize")
        }
    }

    /// The `terminal.list` reply.
    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub struct Terminals {
        pub terminals: Vec<Terminal>,
    }

    /// One runtime terminal. `metrics` is the terminal host's open-ended
    /// metrics object (`shell_running`, `transfer_id`, `shell_pid`, ...).
    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub struct Terminal {
        pub workspace: WorkspaceRecord,
        #[serde(default)]
        pub metrics: Value,
    }

    impl Terminal {
        pub fn shell_running(&self) -> bool {
            self.metrics["shell_running"] == true
        }
    }

    /// The `terminal.ensure`, `terminal.restart` and `terminal.launch` reply.
    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub struct Ensured {
        #[serde(default)]
        pub metrics: Value,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{DEFINITIONS, bundle};
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

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
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("{DEFINITIONS}{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, value: &T) -> Value {
        let mut wire = serde_json::to_value(value).unwrap();
        wire["op"] = json!(op);
        assert!(valid(&names(op).0, &wire), "{op} rejected {wire}");
        let again: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(again).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
        wire
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, value: &T) -> Value {
        let wire = serde_json::to_value(value).unwrap();
        assert!(valid(&names(op).1, &wire), "{op} reply rejected {wire}");
        let again: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(again).unwrap(), wire);
        wire
    }

    #[test]
    fn terminal_create_round_trips_and_accepts_request_id() {
        let wire = request(
            "terminal.create",
            &TerminalCreateRequest {
                workspace_id: "workspace_1".into(),
                operation_id: Some("create_1".into()),
            },
        );
        assert_eq!(
            wire,
            json!({"op": "terminal.create", "workspace_id": "workspace_1", "operation_id": "create_1"})
        );
        request(
            "terminal.create",
            &TerminalCreateRequest {
                workspace_id: "workspace_1".into(),
                operation_id: None,
            },
        );
        let older: TerminalCreateRequest =
            serde_json::from_value(json!({"workspace_id": "w", "request_id": "r"})).unwrap();
        assert_eq!(older.operation_id.as_deref(), Some("r"));
        let wire = response(
            "terminal.create",
            &TerminalCreated {
                tag: AckTag::Tag,
                terminal_id: "terminal_1".into(),
            },
        );
        assert_eq!(wire, json!({"type": "ack", "terminal_id": "terminal_1"}));
    }

    #[test]
    fn terminal_operation_round_trips() {
        request(
            "terminal.operation",
            &TerminalOperationRequest {
                workspace_id: "workspace_1".into(),
                operation_id: "create_1".into(),
            },
        );
        let older: TerminalOperationRequest =
            serde_json::from_value(json!({"workspace_id": "w", "request_id": "r"})).unwrap();
        assert_eq!(older.operation_id, "r");
        let wire = response(
            "terminal.operation",
            &TerminalOperation {
                tag: TerminalOperationTag::Tag,
                workspace_id: "workspace_1".into(),
                request_id: "create_1".into(),
                terminal_id: "terminal_1".into(),
            },
        );
        assert_eq!(
            wire,
            json!({"type": "terminal_operation", "workspace_id": "workspace_1",
                "request_id": "create_1", "terminal_id": "terminal_1"})
        );
    }

    #[test]
    fn terminal_lifecycle_round_trips() {
        let wire = request("terminal.restart", &TerminalRestartRequest::default());
        assert_eq!(wire, json!({"op": "terminal.restart"}));
        request(
            "terminal.restart",
            &TerminalRestartRequest {
                workspace_id: Some("workspace_1".into()),
                terminal_id: Some("terminal_1".into()),
            },
        );
        let target = || ("workspace_1".to_owned(), "terminal_1".to_owned());
        let (workspace_id, terminal_id) = target();
        request(
            "terminal.stop",
            &TerminalStopRequest {
                workspace_id,
                terminal_id,
            },
        );
        let (workspace_id, terminal_id) = target();
        request(
            "terminal.retire",
            &TerminalRetireRequest {
                workspace_id,
                terminal_id,
            },
        );
        for op in ["terminal.restart", "terminal.stop", "terminal.retire"] {
            assert_eq!(response(op, &Ack::default()), json!({"type": "ack"}));
        }
        assert!(!valid(
            "TerminalStopRequest",
            &json!({"op": "terminal.stop", "workspace_id": "w"})
        ));
    }

    #[test]
    fn runtime_commands_keep_their_wire_shape() {
        let workspace: crate::model::WorkspaceRecord = serde_json::from_value(json!({
            "id": "w", "repository_id": null, "root": "/tmp/w", "name": "w", "terminal_id": "t",
        }))
        .unwrap();
        assert_eq!(
            runtime::Command::List.to_value(),
            json!({"op": "terminal.list"})
        );
        assert_eq!(
            runtime::Command::Stop {
                workspace_id: "w".into(),
                terminal_id: "t".into()
            }
            .to_value(),
            json!({"op": "terminal.stop", "workspace_id": "w", "terminal_id": "t"})
        );
        let ensure = runtime::Command::Restart(runtime::Ensure {
            workspace: workspace.clone(),
            terminal_key: "w".into(),
            existing_only: false,
            session_subscribers: 2,
        })
        .to_value();
        assert_eq!(
            ensure,
            json!({"op": "terminal.restart", "workspace": serde_json::to_value(&workspace).unwrap(),
                "terminal_key": "w", "existing_only": false, "session_subscribers": 2})
        );
        let list: runtime::Terminals = serde_json::from_value(json!({
            "type": "terminals",
            "terminals": [{"workspace": workspace, "metrics": {"shell_running": true}}],
        }))
        .unwrap();
        assert!(list.terminals[0].shell_running());
    }
}
