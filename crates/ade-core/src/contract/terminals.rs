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
use serde_json::Value;

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
        // Closing stops the terminal's processes and removes its record: an
        // effect across the runtime and the profile database, recorded by the
        // daemon's envelope (`crates/ade-daemon/src/envelope.rs`).
        OperationSpec::new::<TerminalCloseRequest, Ack>("terminal.close", Tier::EffectCommand),
    ]
}

/// Feed frames. Terminal stream frames bypass `session.subscribe`; they have
/// their own stream contract: [`stream_frames`].
pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<TerminalChanged>("terminal_changed")]
}

/// What a terminal runs. A `shell` is the workspace's primary shell or one
/// added by `terminal.create`; the others run a managed program.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKind {
    Shell,
    /// A workspace service's terminal (`service_id`).
    Service,
    /// A script run's terminal (`script_run_id`).
    Script,
}

/// Whether a terminal's process runs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    /// No process has started yet; attaching starts the shell.
    #[default]
    NotStarted,
    Running,
    /// The process ended on its own; `exit_code` says how, when known.
    Exited,
    /// ADE stopped it, or the runtime that ran it is gone.
    Stopped,
}

/// A terminal as the catalog lists it. It is owned by its workspace and
/// stored by the daemon; `status`, `busy`, `foreground` and a title the
/// program set follow the runtime and reach the feed as `terminal_changed`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct TerminalRecord {
    pub id: String,
    pub workspace_id: String,
    /// A `TerminalKind`. The contract keeps it an open string so a client
    /// built before a new kind still reads the catalog.
    #[schemars(with = "String")]
    pub kind: TerminalKind,
    /// The title given at creation, else the title the program set, else
    /// its command or the service or script name.
    pub title: String,
    /// A `TerminalStatus`, an open string for the same reason as `kind`.
    #[schemars(with = "String")]
    pub status: TerminalStatus,
    /// Set when `status` is `exited` and the process reported a code. A
    /// process ended by a signal reports 128 plus the signal number.
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// A process other than the terminal's own program holds its foreground,
    /// such as a command started from the shell. Closing asks first.
    #[serde(default)]
    pub busy: bool,
    /// The busy foreground process's command name, such as `sleep`.
    #[serde(default)]
    pub foreground: Option<String>,
    /// The workspace's first shell. Closing it gives the workspace a new one.
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub service_id: Option<String>,
    #[serde(default)]
    pub script_run_id: Option<String>,
}

wire_tag!(TerminalChangedTag, "terminal_changed");

/// The `terminal_changed` feed frame: a terminal's status, busy state or
/// title changed. At most four per second per terminal. A terminal added or
/// removed arrives as a `catalog` frame instead.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalChanged {
    #[serde(rename = "type")]
    pub tag: TerminalChangedTag,
    pub terminal: TerminalRecord,
    pub boot_id: String,
    pub revision: u64,
}

/// Every frame a terminal attachment can receive. The runtime's terminal host
/// writes them (crates/ade-runtime/src/bin/supervisor/terminal_host.rs) and the
/// daemon copies them to the client without parsing; the daemon and the
/// supervisor add only `error` frames of their own. The SDK checks each frame
/// against this contract as it arrives.
pub fn stream_frames() -> Vec<FrameSpec> {
    vec![
        FrameSpec::new::<TerminalSnapshotFrame>("snapshot"),
        FrameSpec::new::<TerminalOutputFrame>("terminal"),
        FrameSpec::new::<TerminalResizeFrame>("terminal_resize"),
        FrameSpec::new::<TerminalViewportFrame>("viewport"),
        FrameSpec::new::<TerminalMetricsFrame>("metrics"),
        FrameSpec::new::<TerminalDetachedFrame>("detached"),
        FrameSpec::new::<TerminalWarningFrame>("warning"),
        FrameSpec::new::<TerminalErrorFrame>("error"),
        FrameSpec::new::<TerminalConversationFrame>("conversation"),
        FrameSpec::new::<Ack>("ack"),
    ]
}

wire_tag!(TerminalSnapshotTag, "snapshot");
wire_tag!(TerminalOutputTag, "terminal");
wire_tag!(TerminalResizeTag, "terminal_resize");
wire_tag!(TerminalViewportTag, "viewport");
wire_tag!(TerminalMetricsTag, "metrics");
wire_tag!(TerminalDetachedTag, "detached");
wire_tag!(TerminalWarningTag, "warning");
wire_tag!(TerminalErrorTag, "error");
wire_tag!(TerminalConversationTag, "conversation");

/// The first frame of an attachment, and a later one marked `resync` when the
/// runtime skipped output this viewer could not keep up with. Which recovery
/// fields it carries depends on the `snapshot_format` the attachment asked for.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalSnapshotFrame {
    #[serde(rename = "type")]
    pub tag: TerminalSnapshotTag,
    /// The terminal incarnation this attachment is bound to.
    pub run_id: String,
    pub attachment: u64,
    /// Set on a snapshot that replaces the screen mid-stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resync: Option<bool>,
    pub metrics: TerminalMetrics,
    /// The runtime's simulated conversation text (a prototype leftover).
    pub conversation: String,
    pub streaming: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_owner: Option<String>,
    /// `ghostty-snapshot-v1-herdr-<pin>` or `xterm-replay-v1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_snapshot_format: Option<String>,
    /// The Ghostty snapshot, base64 encoded, when the attachment asked for
    /// `snapshot_format: binary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_snapshot_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_recovery: Option<TerminalRecovery>,
    /// The active screen, in a plain snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_screen_bytes: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_screen_error: Option<String>,
}

/// How a snapshot restores the screen, by snapshot format.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(untagged)]
pub enum TerminalRecovery {
    Ghostty(GhosttyRecovery),
    XtermReplay(XtermReplayRecovery),
    Plain(PlainScreenRecovery),
}

/// A Ghostty snapshot: both screens, history up to the limit, and any
/// unfinished escape sequence.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GhosttyRecovery {
    pub scope: String,
    pub history_limit_bytes: u64,
    pub continuation_limit_bytes: u64,
}

/// Recorded output and resizes from the start of the process, up to a limit.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct XtermReplayRecovery {
    /// False when the output passed `limit_bytes`; `events` is then empty.
    pub complete: bool,
    pub reason: Option<String>,
    pub initial_cols: u16,
    pub initial_rows: u16,
    /// The live-output offset the replay reaches.
    pub through_offset: u64,
    pub limit_bytes: u64,
    pub events: Vec<XtermReplayEvent>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum XtermReplayEvent {
    Output { offset: u64, bytes_base64: String },
    Resize { offset: u64, cols: u16, rows: u16 },
}

/// The active screen's text grid as the runtime's parser holds it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlainScreenRecovery {
    pub parser: String,
    pub scope: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub parser_ground: bool,
}

/// PTY output. `offset` is where these bytes start in the terminal's output.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalOutputFrame {
    #[serde(rename = "type")]
    pub tag: TerminalOutputTag,
    /// The bytes as lossy UTF-8.
    pub data: String,
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub run_id: String,
}

/// The PTY's size changed, at this point in its output.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalResizeFrame {
    #[serde(rename = "type")]
    pub tag: TerminalResizeTag,
    pub cols: u16,
    pub rows: u16,
    pub offset: u64,
    pub run_id: String,
}

/// This attachment gained or lost ownership of the terminal's size.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalViewportFrame {
    #[serde(rename = "type")]
    pub tag: TerminalViewportTag,
    pub owner: bool,
    pub attachment: u64,
    pub run_id: String,
}

/// The reply to `ping`, and a broadcast every second while the shell runs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalMetricsFrame {
    #[serde(rename = "type")]
    pub tag: TerminalMetricsTag,
    pub metrics: TerminalMetrics,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalMetrics {
    /// The runtime supervisor's process ID.
    pub pid: u32,
    pub uptime_ms: u64,
    /// Attachments and session subscribers.
    pub clients: u64,
    pub workspace_id: String,
    pub terminal_id: String,
    pub run_id: String,
    /// A service or script run's incarnation; null for shells.
    pub transfer_id: Option<String>,
    /// All output so far, in bytes: the offset the next output frame starts at.
    pub terminal_bytes: u64,
    pub events: u64,
    pub reply_dropped_bytes: u64,
    pub viewer_resyncs: u64,
    pub viewer_queue_limit_bytes: u64,
    /// `[width, height]` in pixels.
    pub pixel_size: (u16, u16),
    pub scrollback_bytes: u64,
    /// The attachment that owns the terminal's size.
    pub resize_owner: Option<u64>,
    pub shell_pid: Option<u32>,
    pub shell_running: bool,
    pub durable_log_error: Option<String>,
    pub descendants: Vec<TerminalDescendant>,
    /// How the process ended, once it has. Its shape varies with how it ended
    /// and whether its process tree was confirmed stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<Value>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalDescendant {
    pub pid: i32,
    pub started: u64,
}

/// The reply to `detach`; the connection closes after it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalDetachedFrame {
    #[serde(rename = "type")]
    pub tag: TerminalDetachedTag,
    pub attachment: u64,
    pub run_id: String,
}

/// Something went wrong that the terminal keeps running through, such as
/// dropped PTY replies.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalWarningFrame {
    #[serde(rename = "type")]
    pub tag: TerminalWarningTag,
    pub message: String,
}

/// A refused or failed request, a failed restore, or the process exiting.
/// `code` is set for refusals a client acts on: `stale_incarnation` and
/// `incarnation_exited` from the runtime, `needs_rebind` and other typed codes
/// from the daemon, and the SDK's own `output_gap`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalErrorFrame {
    #[serde(rename = "type")]
    pub tag: TerminalErrorTag,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// The runtime's simulated conversation (a prototype leftover), broadcast to
/// every attachment while `simulate` runs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalConversationFrame {
    #[serde(rename = "type")]
    pub tag: TerminalConversationTag,
    pub text: String,
    pub streaming: bool,
}

/// `terminal.create`: add another terminal to a workspace.
///
/// `operation_id` is the caller-owned receipt ID. Without one, every call
/// creates a new terminal.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalCreateRequest {
    pub workspace_id: String,
    /// Absent or a string of 1 to 256 bytes; the daemon rejects `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub operation_id: Option<String>,
    /// The terminal's title, 1 to 100 characters with no control characters.
    /// Without one the title follows the program.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Open a tab `tab-<terminal_id>` for the new terminal in the window's
    /// layout for this workspace, in the same transaction. An unknown window
    /// is `window_not_found` and creates no terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<TerminalPlace>,
}

/// Where `terminal.create` opens the new terminal's tab: a window, and a pane
/// in it (the focused pane when absent).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct TerminalPlace {
    pub window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

/// `terminal.close`: stop a terminal and remove it from its workspace.
///
/// A busy terminal (a command holds its foreground) is refused with
/// `terminal_busy`, naming the command in `foreground`, unless `force` is
/// true. The primary shell's workspace gets a new, not yet started primary
/// shell. Service, script and Conversation terminals are closed through
/// their own commands and are refused here.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalCloseRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub terminal_id: String,
    /// Close even when busy, ending the running command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// `terminal.operation`: read the terminal a `terminal.create` receipt produced.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalOperationRequest {
    pub workspace_id: String,
    pub operation_id: String,
}

/// `terminal.restart`: start a new shell in an exited terminal. Without
/// `workspace_id` the daemon uses its default workspace; without
/// `terminal_id` it uses the workspace's primary terminal.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct TerminalRestartRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
}

/// `terminal.stop`: stop a workspace terminal's shell.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalStopRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub workspace_id: String,
    pub terminal_id: String,
}

/// `terminal.retire`: remove a stopped terminal from its workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalRetireRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
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

/// The `terminal.operation` reply. `operation_id` echoes the requested
/// operation ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct TerminalOperation {
    #[serde(rename = "type")]
    pub tag: TerminalOperationTag,
    pub workspace_id: String,
    pub operation_id: String,
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
            /// Refuse with `terminal_busy` instead of stopping when a command
            /// holds the terminal's foreground. The runtime checks this in the
            /// same step as the stop.
            #[serde(default, skip_serializing_if = "std::ops::Not::not")]
            if_idle: bool,
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
            workspace: Workspace,
            /// The runtime key; absent means the workspace ID.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            terminal_key: Option<String>,
            launch: Launch,
            #[serde(default)]
            session_subscribers: usize,
        },
    }

    /// The terminal a runtime command names: its workspace's ID and folder,
    /// and the terminal's own ID.
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
    pub struct Workspace {
        pub id: String,
        pub root: String,
        pub terminal_id: String,
    }

    impl Workspace {
        pub fn new(workspace: &WorkspaceRecord, terminal_id: &str) -> Self {
            Self {
                id: workspace.id.clone(),
                root: workspace.root.clone(),
                terminal_id: terminal_id.to_owned(),
            }
        }
    }

    /// Start a terminal's shell if it is absent (`terminal.ensure`) or exited
    /// (`terminal.restart`). `existing_only` refuses to start a new shell.
    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub struct Ensure {
        pub workspace: Workspace,
        /// The runtime key; absent means the workspace ID.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub terminal_key: Option<String>,
        #[serde(default)]
        pub existing_only: bool,
        #[serde(default)]
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
        pub workspace: Workspace,
        #[serde(default)]
        pub metrics: Value,
        #[serde(default)]
        pub activity: Activity,
    }

    /// What runs in a runtime terminal now (`ade_runtime::foreground`).
    #[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
    pub struct Activity {
        /// Another process group holds the PTY's foreground.
        #[serde(default)]
        pub busy: bool,
        /// That group leader's command name.
        #[serde(default)]
        pub foreground: Option<String>,
        /// The window title the program last set (OSC 0 or 2).
        #[serde(default)]
        pub title: Option<String>,
        /// The terminal's own program's command name, such as `zsh`.
        #[serde(default)]
        pub program: Option<String>,
        /// `terminal.stop` was asked of this incarnation.
        #[serde(default)]
        pub stop_requested: bool,
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
    fn terminal_create_round_trips() {
        let wire = request(
            "terminal.create",
            &TerminalCreateRequest {
                workspace_id: "workspace_1".into(),
                operation_id: Some("create_1".into()),
                title: None,
                place: None,
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
                title: Some("Build".into()),
                place: Some(TerminalPlace {
                    window_id: "window_1".into(),
                    pane_id: None,
                }),
            },
        );
        let older: TerminalCreateRequest =
            serde_json::from_value(json!({"workspace_id": "w", "request_id": "r"})).unwrap();
        assert!(
            older.operation_id.is_none(),
            "request_id is not an operation ID"
        );
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
        assert!(
            serde_json::from_value::<TerminalOperationRequest>(
                json!({"workspace_id": "w", "request_id": "r"})
            )
            .is_err()
        );
        let wire = response(
            "terminal.operation",
            &TerminalOperation {
                tag: TerminalOperationTag::Tag,
                workspace_id: "workspace_1".into(),
                operation_id: "create_1".into(),
                terminal_id: "terminal_1".into(),
            },
        );
        assert_eq!(
            wire,
            json!({"type": "terminal_operation", "workspace_id": "workspace_1",
                "operation_id": "create_1", "terminal_id": "terminal_1"})
        );
    }

    #[test]
    fn terminal_lifecycle_round_trips() {
        let wire = request(
            "terminal.restart",
            &TerminalRestartRequest {
                operation_id: "restart_1".into(),
                ..Default::default()
            },
        );
        assert_eq!(
            wire,
            json!({"op": "terminal.restart", "operation_id": "restart_1"})
        );
        assert!(!valid(
            "TerminalRestartRequest",
            &json!({"op": "terminal.restart"})
        ));
        request(
            "terminal.restart",
            &TerminalRestartRequest {
                operation_id: "restart_2".into(),
                workspace_id: Some("workspace_1".into()),
                terminal_id: Some("terminal_1".into()),
            },
        );
        let target = || ("workspace_1".to_owned(), "terminal_1".to_owned());
        let (workspace_id, terminal_id) = target();
        request(
            "terminal.stop",
            &TerminalStopRequest {
                operation_id: "stop_1".into(),
                workspace_id,
                terminal_id,
            },
        );
        let (workspace_id, terminal_id) = target();
        request(
            "terminal.retire",
            &TerminalRetireRequest {
                operation_id: "retire_1".into(),
                workspace_id,
                terminal_id,
            },
        );
        for op in ["terminal.restart", "terminal.stop", "terminal.retire"] {
            assert_eq!(response(op, &Ack::default()), json!({"type": "ack"}));
        }
        assert!(!valid(
            "TerminalStopRequest",
            &json!({"op": "terminal.stop", "operation_id": "o", "workspace_id": "w"})
        ));
    }

    #[test]
    fn terminal_close_and_records_round_trip() {
        let wire = request(
            "terminal.close",
            &TerminalCloseRequest {
                operation_id: "close_1".into(),
                terminal_id: "terminal_1".into(),
                force: Some(true),
            },
        );
        assert_eq!(
            wire,
            json!({"op": "terminal.close", "operation_id": "close_1",
                "terminal_id": "terminal_1", "force": true})
        );
        assert!(!valid(
            "TerminalCloseRequest",
            &json!({"op": "terminal.close", "terminal_id": "t"})
        ));
        assert_eq!(
            response("terminal.close", &Ack::default()),
            json!({"type": "ack"})
        );
        let record = TerminalRecord {
            id: "terminal_1".into(),
            workspace_id: "workspace_1".into(),
            kind: TerminalKind::Shell,
            title: "zsh".into(),
            status: TerminalStatus::Exited,
            exit_code: Some(3),
            busy: false,
            foreground: None,
            primary: true,
            service_id: None,
            script_run_id: None,
        };
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["status"], "exited");
        assert_eq!(wire["kind"], "shell");
        assert!(valid("TerminalRecord", &wire));
        // A kind or status added later still passes an older client's contract.
        let mut newer = wire.clone();
        newer["kind"] = json!("pty");
        newer["status"] = json!("paused");
        assert!(valid("TerminalRecord", &newer));
        let frame = TerminalChanged {
            tag: TerminalChangedTag::Tag,
            terminal: record,
            boot_id: "boot_1".into(),
            revision: 4,
        };
        assert!(valid(
            "TerminalChanged",
            &serde_json::to_value(frame).unwrap()
        ));
    }

    #[test]
    fn runtime_commands_keep_their_wire_shape() {
        let workspace = runtime::Workspace {
            id: "w".into(),
            root: "/tmp/w".into(),
            terminal_id: "t".into(),
        };
        assert_eq!(
            runtime::Command::List.to_value(),
            json!({"op": "terminal.list"})
        );
        assert_eq!(
            runtime::Command::Stop {
                workspace_id: "w".into(),
                terminal_id: "t".into(),
                if_idle: false,
            }
            .to_value(),
            json!({"op": "terminal.stop", "workspace_id": "w", "terminal_id": "t"})
        );
        let ensure = runtime::Command::Restart(runtime::Ensure {
            workspace: workspace.clone(),
            terminal_key: Some("w".into()),
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
