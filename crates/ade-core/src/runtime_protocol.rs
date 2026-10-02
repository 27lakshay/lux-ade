//! The daemon-to-runtime protocol (`ade-runtime-v8`): typed requests and replies
//! for every operation the application daemon sends to the runtime supervisor.
//!
//! Both sides use these types. The daemon serializes them into a
//! `serde_json::Value` before writing a frame, and `Value` keeps its keys sorted,
//! so the frames on the socket are byte-for-byte the frames the untyped
//! `json!` call sites wrote before. The types are Rust only; they are not part
//! of the public `@ade/contracts` bundle.
//!
//! A runtime socket carries three kinds of first frame:
//!
//! * [`Connect`]: `hello`, `runtime.stop`, `owner.claim` and `terminal.connect`.
//!   A claim turns the connection into the owner's control socket, which then
//!   carries [`Control`] commands, one reply per command.
//! * [`AgentRequest`]: one `agent.*` request per connection, with the owner token.
//! * Terminal stream frames after `terminal.connect`. The daemon relays them
//!   without parsing, so they are not typed here.
//!
//! Incarnation and generation (proposed architecture, section 4): the runtime
//! incarnation is `instance_id`, checked by `hello`, `owner.claim`,
//! `runtime.stop` and the handoff ticket. Every later command is fenced by the
//! owner `token`, which exists only on the incarnation that admitted the claim,
//! so a command cannot reach a successor runtime. The attempt identity of an
//! Agent is its `run` ID, fresh for each run. Gaps are listed in
//! `.scratch/ade-v1/evidence/phase2-runtime-contracts.md`: terminal control
//! commands name a terminal, not the shell run inside it, and no command carries
//! a numeric attempt generation.
pub use crate::contract::terminals::runtime as terminal;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

/// The runtime protocol version both sides must agree on before any claim.
pub const VERSION: &str = crate::protocol::RUNTIME_PROTOCOL;

macro_rules! tag {
    ($name:ident, $value:literal) => {
        #[doc = concat!("The `", $value, "` reply tag.")]
        #[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
        pub enum $name {
            #[default]
            #[serde(rename = $value)]
            Tag,
        }
    };
}
tag!(HelloTag, "hello");
tag!(HandoffTag, "handoff");
tag!(AckTag, "ack");
tag!(ErrorTag, "error");
tag!(EventsTag, "events");

/// A first frame on a new runtime connection, other than an `agent.*` request.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op")]
pub enum Connect {
    /// Identify the runtime; answered with [`Hello`].
    #[serde(rename = "hello")]
    Hello,
    /// Stop the runtime. Refused while a daemon owns it.
    #[serde(rename = "runtime.stop")]
    Stop(RuntimeStop),
    /// Claim ownership; the connection becomes the owner's control socket.
    #[serde(rename = "owner.claim")]
    Claim(OwnerClaim),
    /// Attach a terminal byte stream for the owner.
    #[serde(rename = "terminal.connect")]
    TerminalConnect(TerminalConnect),
}

/// `runtime.stop`. `instance_id` must name the running incarnation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RuntimeStop {
    pub instance_id: String,
    /// Stop even though live shells or Agents remain.
    #[serde(default)]
    pub stop_active: bool,
}

/// `owner.claim`. `ticket` is required while an unexpired handoff exists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct OwnerClaim {
    /// A fresh 36-character UUID that fences every later owner command.
    pub token: String,
    /// The handoff ticket, or null. Always present on the wire.
    #[serde(default)]
    pub ticket: Option<String>,
    pub instance_id: String,
    pub runtime_protocol: String,
}

/// `terminal.connect`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TerminalConnect {
    pub token: String,
    pub workspace_id: String,
}

/// A command on the owner's control socket.
#[derive(Clone, Debug)]
pub enum Control {
    /// `terminal.*`
    Terminal(terminal::Command),
    /// `proxy.*`
    Proxy(Proxy),
    /// `owner.*`
    Owner(Owner),
}

impl Control {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("runtime control commands serialize")
    }
}

impl From<terminal::Command> for Control {
    fn from(command: terminal::Command) -> Self {
        Self::Terminal(command)
    }
}
impl From<Proxy> for Control {
    fn from(command: Proxy) -> Self {
        Self::Proxy(command)
    }
}
impl From<Owner> for Control {
    fn from(command: Owner) -> Self {
        Self::Owner(command)
    }
}

impl Serialize for Control {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Terminal(command) => command.serialize(serializer),
            Self::Proxy(command) => command.serialize(serializer),
            Self::Owner(command) => command.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Control {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let op = value.get("op").and_then(Value::as_str).unwrap_or("");
        let family = op.split('.').next().unwrap_or("");
        match family {
            "terminal" => serde_json::from_value(value).map(Self::Terminal),
            "proxy" => serde_json::from_value(value).map(Self::Proxy),
            "owner" => serde_json::from_value(value).map(Self::Owner),
            _ => return Err(D::Error::custom("Unknown runtime control operation")),
        }
        .map_err(D::Error::custom)
    }
}

/// Stable service proxy commands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op")]
pub enum Proxy {
    #[serde(rename = "proxy.ensure")]
    Ensure(ProxyEnsure),
    #[serde(rename = "proxy.inspect")]
    Inspect(ProxyTarget),
    #[serde(rename = "proxy.retire")]
    Retire(ProxyRoute),
    #[serde(rename = "proxy.recovery.inspect")]
    RecoveryInspect,
    #[serde(rename = "proxy.recovery.retry")]
    RecoveryRetry(ProxyRecoveryRetry),
    #[serde(rename = "proxy.recovery.reset")]
    RecoveryReset { expected_registry_sha256: String },
}

/// One service port a stable proxy fronts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProxyTarget {
    pub workspace_id: String,
    pub service_name: String,
    pub port_variable: String,
}

/// `proxy.ensure`. A remap names the route it replaces; otherwise
/// `expected_route_identity` is empty and `expected_route_port` is 0.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProxyEnsure {
    #[serde(flatten)]
    pub target: ProxyTarget,
    pub service_identity: String,
    pub target_port: u16,
    #[serde(default)]
    pub remap: bool,
    #[serde(default)]
    pub expected_route_identity: String,
    #[serde(default)]
    pub expected_route_port: u16,
    pub daemon_socket: String,
}

/// The reviewed route a `proxy.retire` or `proxy.recovery.retry` must match.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProxyRoute {
    #[serde(flatten)]
    pub target: ProxyTarget,
    pub expected_route_id: String,
    pub expected_service_identity: String,
    pub expected_target_port: u16,
    pub expected_proxy_port: u16,
}

/// `proxy.recovery.retry`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProxyRecoveryRetry {
    #[serde(flatten)]
    pub route: ProxyRoute,
    pub daemon_socket: String,
}

/// Ownership handoff commands on the control socket.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "op")]
pub enum Owner {
    /// Succeeds only while the owner is not draining.
    #[serde(rename = "owner.check")]
    Check,
    /// Start draining and issue a [`Handoff`] ticket.
    #[serde(rename = "owner.prepare")]
    Prepare,
    /// Cancel a prepared handoff.
    #[serde(rename = "owner.abort")]
    Abort,
}

/// An `agent.*` request. Each travels on its own connection with the owner token.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentRequest {
    pub token: String,
    #[serde(flatten)]
    pub op: AgentOp,
}

/// The `agent.*` operations.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op")]
pub enum AgentOp {
    /// Probe an account; `account` is an `ade_core::model::AccountExecution`.
    /// For a plugin provider, `worker` is the `ProviderWorker` whose
    /// `account_inspect` reads the account; a bundled provider's account probe
    /// needs none.
    #[serde(rename = "agent.account_inspect")]
    AccountInspect {
        account: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker: Option<Value>,
    },
    /// Read-only initialize/descriptor inspection for an installed provider artifact.
    #[serde(rename = "agent.provider_inspect")]
    ProviderInspect { worker: Value },
    /// List live runs; answered with `contract::agents::AgentList`. Each run
    /// carries the descendants the runtime tracks in its provider's tree.
    #[serde(rename = "agent.list")]
    List,
    /// Start a run. `spec` is the runtime's run spec, compared verbatim with a
    /// live run of the same ID, so it stays a raw value.
    #[serde(rename = "agent.create")]
    Create { spec: Value },
    /// A provider command; `command.method` selects it and `command.key` is its
    /// receipt key.
    #[serde(rename = "agent.command")]
    Command { run: String, command: Value },
    #[serde(rename = "agent.connected")]
    Connected { run: String },
    /// Events after cursor `after`; answered with [`AgentEvents`].
    #[serde(rename = "agent.events")]
    Events { run: String, after: u64 },
    /// Release events through `cursor`.
    #[serde(rename = "agent.ack")]
    Ack { run: String, cursor: u64 },
    #[serde(rename = "agent.stop")]
    Stop { run: String },
}

impl AgentOp {
    /// The run this operation targets, when it targets one.
    pub fn run(&self) -> Option<&str> {
        match self {
            Self::Command { run, .. }
            | Self::Connected { run }
            | Self::Events { run, .. }
            | Self::Ack { run, .. }
            | Self::Stop { run } => Some(run),
            Self::AccountInspect { .. }
            | Self::ProviderInspect { .. }
            | Self::List
            | Self::Create { .. } => None,
        }
    }
}

/// The `hello` reply.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hello {
    #[serde(rename = "type")]
    pub tag: HelloTag,
    pub runtime_protocol: String,
    /// Always present; null when the runtime was built without an ID.
    pub build_id: Option<String>,
    pub pid: u32,
    /// The runtime incarnation.
    pub instance_id: String,
    pub data_directory: String,
}

/// Why a `hello` reply cannot be used.
#[derive(Debug, PartialEq, Eq)]
pub enum HelloRefusal {
    /// Another protocol version; its terminals are left alone.
    Incompatible,
    /// A runtime serving another data directory.
    OtherDirectory,
    /// A compatible version that omitted or malformed a field.
    Malformed(String),
}

impl std::fmt::Display for HelloRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Incompatible => {
                f.write_str("Incompatible runtime; existing terminals were preserved")
            }
            Self::OtherDirectory => f.write_str("Runtime belongs to another data directory"),
            Self::Malformed(error) => write!(f, "Runtime omitted identity: {error}"),
        }
    }
}
impl std::error::Error for HelloRefusal {}

impl Hello {
    /// Accepts a `hello` reply only from this protocol version serving
    /// `data_directory`. The version is checked before the shape, so a runtime
    /// of another version is always reported as incompatible.
    pub fn accept(reply: &Value, data_directory: Option<&str>) -> Result<Self, HelloRefusal> {
        if reply.get("runtime_protocol").and_then(Value::as_str) != Some(VERSION) {
            return Err(HelloRefusal::Incompatible);
        }
        let hello: Self = serde_json::from_value(reply.clone())
            .map_err(|error| HelloRefusal::Malformed(error.to_string()))?;
        if data_directory != Some(hello.data_directory.as_str()) {
            return Err(HelloRefusal::OtherDirectory);
        }
        Ok(hello)
    }
}

/// The `owner.prepare` reply. The daemon persists it verbatim as its handoff
/// record so its successor can present the ticket in `owner.claim`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Handoff {
    #[serde(rename = "type")]
    pub tag: HandoffTag,
    pub instance_id: String,
    pub ticket: String,
    /// Milliseconds since the Unix epoch.
    pub expires_at: i64,
}

impl Handoff {
    /// The ticket a successor presents to `instance_id` at `now_ms`, or `None`
    /// when the record names another incarnation, has expired or is not a
    /// handoff record.
    pub fn ticket_for(record: &Value, instance_id: &str, now_ms: i64) -> Option<String> {
        let handoff: Self = serde_json::from_value(record.clone()).ok()?;
        (handoff.instance_id == instance_id && handoff.expires_at > now_ms)
            .then_some(handoff.ticket)
    }
}

/// A bare `ack` reply.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ack {
    #[serde(rename = "type")]
    pub tag: AckTag,
}

/// An error reply on a connection or control socket.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Error {
    #[serde(rename = "type")]
    pub tag: ErrorTag,
    pub message: String,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            tag: ErrorTag::Tag,
            message: message.into(),
        }
    }
}

/// An error reply to an `agent.*` request. `code` is always present.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentError {
    #[serde(rename = "type")]
    pub tag: ErrorTag,
    /// [`OWNER_FENCED`] when the token is stale or its owner is draining: no
    /// effect was admitted, and the caller may retry after `owner.check`.
    pub code: Option<String>,
    pub message: String,
}

/// The `agent.*` error code for a stale or draining owner.
pub const OWNER_FENCED: &str = "owner_fenced";

/// The `agent.events` reply. `E` is the runtime's event envelope.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentEvents<E = Value> {
    #[serde(rename = "type")]
    pub tag: EventsTag,
    pub events: Vec<E>,
    /// The run's journal is closed; no later event will arrive.
    pub closed: bool,
    /// Why output was lost, when it was.
    pub output_failure: Option<String>,
}

/// Decodes a request, naming the protocol in the error.
pub fn decode<T: serde::de::DeserializeOwned>(request: &Value) -> Result<T, String> {
    serde_json::from_value(request.clone())
        .map_err(|error| format!("Invalid runtime request: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::terminals::runtime::Workspace;
    use serde_json::json;

    /// Encodes `typed`, compares it with the frame the untyped call site wrote,
    /// and decodes the frame back into the same value.
    fn wire<T>(typed: T, expected: Value)
    where
        T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let encoded = serde_json::to_value(&typed).unwrap();
        assert_eq!(encoded, expected);
        assert_eq!(
            serde_json::to_string(&encoded).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        assert_eq!(serde_json::from_value::<T>(expected).unwrap(), typed);
    }

    fn workspace() -> Workspace {
        Workspace {
            id: "w".into(),
            root: "/tmp/w".into(),
            terminal_id: "t".into(),
        }
    }

    #[test]
    fn connection_requests_keep_their_frames() {
        wire(Connect::Hello, json!({"op": "hello"}));
        wire(
            Connect::Stop(RuntimeStop {
                instance_id: "i".into(),
                stop_active: true,
            }),
            json!({"op": "runtime.stop", "instance_id": "i", "stop_active": true}),
        );
        wire(
            Connect::Claim(OwnerClaim {
                token: "t".into(),
                ticket: None,
                instance_id: "i".into(),
                runtime_protocol: VERSION.into(),
            }),
            json!({"op": "owner.claim", "token": "t", "ticket": null, "instance_id": "i",
                "runtime_protocol": "ade-runtime-v8"}),
        );
        wire(
            Connect::TerminalConnect(TerminalConnect {
                token: "t".into(),
                workspace_id: "w".into(),
            }),
            json!({"op": "terminal.connect", "token": "t", "workspace_id": "w"}),
        );
        // Older callers omit optional fields.
        assert_eq!(
            decode::<Connect>(&json!({"op": "runtime.stop", "instance_id": "i"})).unwrap(),
            Connect::Stop(RuntimeStop {
                instance_id: "i".into(),
                stop_active: false
            })
        );
        assert!(decode::<Connect>(&json!({"op": "runtime.stop"})).is_err());
        assert!(decode::<Connect>(&json!({"op": "owner.claim", "token": "t"})).is_err());
        assert!(decode::<Connect>(&json!({"op": "runtime.explode"})).is_err());
    }

    #[test]
    fn control_commands_keep_their_frames() {
        let cases = [
            (Control::from(Owner::Check), json!({"op": "owner.check"})),
            (
                Control::from(Owner::Prepare),
                json!({"op": "owner.prepare"}),
            ),
            (Control::from(Owner::Abort), json!({"op": "owner.abort"})),
            (
                Control::from(Proxy::RecoveryInspect),
                json!({"op": "proxy.recovery.inspect"}),
            ),
            (
                Control::from(Proxy::RecoveryReset {
                    expected_registry_sha256: "ab".into(),
                }),
                json!({"op": "proxy.recovery.reset", "expected_registry_sha256": "ab"}),
            ),
            (
                terminal::Command::Tail {
                    workspace_id: "w".into(),
                    terminal_id: "t".into(),
                    limit_bytes: 4096,
                }
                .into(),
                json!({"op": "terminal.tail", "workspace_id": "w", "terminal_id": "t",
                    "limit_bytes": 4096}),
            ),
            (
                terminal::Command::Launch {
                    workspace: workspace(),
                    terminal_key: Some("run".into()),
                    launch: serde_json::from_value(json!({"transfer_id": "x", "program": "sh",
                        "args": [], "env": {}, "cwd": "/tmp/w"}))
                    .unwrap(),
                    session_subscribers: 1,
                }
                .into(),
                json!({"op": "terminal.launch", "workspace": workspace(), "terminal_key": "run",
                    "launch": {"transfer_id": "x", "program": "sh", "args": [], "env": {},
                        "cwd": "/tmp/w"},
                    "session_subscribers": 1}),
            ),
        ];
        for (typed, frame) in cases {
            assert_eq!(typed.to_value(), frame);
            let decoded: Control = decode(&frame).unwrap();
            assert_eq!(decoded.to_value(), frame);
        }
    }

    #[test]
    fn proxy_commands_keep_their_frames() {
        let target = ProxyTarget {
            workspace_id: "w".into(),
            service_name: "web".into(),
            port_variable: "PORT".into(),
        };
        wire(
            Proxy::Ensure(ProxyEnsure {
                target: target.clone(),
                service_identity: "s".into(),
                target_port: 3000,
                remap: false,
                expected_route_identity: String::new(),
                expected_route_port: 0,
                daemon_socket: "/d.sock".into(),
            }),
            json!({"op": "proxy.ensure", "workspace_id": "w", "service_name": "web",
                "port_variable": "PORT", "service_identity": "s", "target_port": 3000,
                "remap": false, "expected_route_identity": "", "expected_route_port": 0,
                "daemon_socket": "/d.sock"}),
        );
        wire(
            Proxy::Inspect(target.clone()),
            json!({"op": "proxy.inspect", "workspace_id": "w", "service_name": "web",
                "port_variable": "PORT"}),
        );
        let route = ProxyRoute {
            target,
            expected_route_id: "r".into(),
            expected_service_identity: "s".into(),
            expected_target_port: 3000,
            expected_proxy_port: 41000,
        };
        let route_frame = json!({"workspace_id": "w", "service_name": "web",
            "port_variable": "PORT", "expected_route_id": "r", "expected_service_identity": "s",
            "expected_target_port": 3000, "expected_proxy_port": 41000});
        let mut retire = route_frame.clone();
        retire["op"] = json!("proxy.retire");
        wire(Proxy::Retire(route.clone()), retire);
        let mut retry = route_frame;
        retry["op"] = json!("proxy.recovery.retry");
        retry["daemon_socket"] = json!("/d.sock");
        wire(
            Proxy::RecoveryRetry(ProxyRecoveryRetry {
                route,
                daemon_socket: "/d.sock".into(),
            }),
            retry,
        );
        // Ports outside u16 are refused before they reach the proxy manager.
        assert!(
            decode::<Control>(&json!({"op": "proxy.ensure", "workspace_id": "w",
                "service_name": "web", "port_variable": "PORT", "service_identity": "s",
                "target_port": 70000, "daemon_socket": "/d"}))
            .is_err()
        );
    }

    #[test]
    fn terminal_commands_accept_the_older_optional_fields() {
        let decoded: Control =
            decode(&json!({"op": "terminal.ensure", "workspace": workspace()})).unwrap();
        let Control::Terminal(terminal::Command::Ensure(ensure)) = decoded else {
            panic!("decoded {decoded:?}");
        };
        assert_eq!(ensure.terminal_key, None);
        assert!(!ensure.existing_only);
        assert_eq!(ensure.session_subscribers, 0);
    }

    #[test]
    fn unknown_or_misrouted_control_operations_are_refused() {
        for frame in [
            json!({"op": "terminal.connect", "token": "t", "workspace_id": "w"}),
            json!({"op": "agent.list"}),
            json!({"op": "hello"}),
            json!({}),
            json!({"op": "proxy.explode"}),
        ] {
            assert!(decode::<Control>(&frame).is_err(), "{frame}");
        }
    }

    #[test]
    fn agent_requests_keep_their_frames() {
        let cases = [
            (AgentOp::List, json!({"op": "agent.list"})),
            (
                AgentOp::AccountInspect {
                    account: json!({"provider": "codex"}),
                    worker: None,
                },
                json!({"op": "agent.account_inspect", "account": {"provider": "codex"}}),
            ),
            (
                AgentOp::Create {
                    spec: json!({"run": "r", "conversation": "c"}),
                },
                json!({"op": "agent.create", "spec": {"run": "r", "conversation": "c"}}),
            ),
            (
                AgentOp::Command {
                    run: "r".into(),
                    command: json!({"method": "send", "key": "send:s"}),
                },
                json!({"op": "agent.command", "run": "r",
                    "command": {"method": "send", "key": "send:s"}}),
            ),
            (
                AgentOp::Connected { run: "r".into() },
                json!({"op": "agent.connected", "run": "r"}),
            ),
            (
                AgentOp::Events {
                    run: "r".into(),
                    after: 7,
                },
                json!({"op": "agent.events", "run": "r", "after": 7}),
            ),
            (
                AgentOp::Ack {
                    run: "r".into(),
                    cursor: 7,
                },
                json!({"op": "agent.ack", "run": "r", "cursor": 7}),
            ),
            (
                AgentOp::Stop { run: "r".into() },
                json!({"op": "agent.stop", "run": "r"}),
            ),
        ];
        for (op, mut frame) in cases {
            frame["token"] = json!("owner");
            wire(
                AgentRequest {
                    token: "owner".into(),
                    op,
                },
                frame,
            );
        }
        assert!(decode::<AgentRequest>(&json!({"op": "agent.list"})).is_err());
        assert!(
            decode::<AgentRequest>(&json!({"op": "agent.events", "run": "r",
            "token": "o"}))
            .is_err()
        );
        assert!(decode::<AgentRequest>(&json!({"op": "agent.explode", "token": "o"})).is_err());
    }

    #[test]
    fn replies_keep_their_frames() {
        wire(
            Hello {
                tag: HelloTag::Tag,
                runtime_protocol: VERSION.into(),
                build_id: None,
                pid: 9,
                instance_id: "i".into(),
                data_directory: "/data".into(),
            },
            json!({"type": "hello", "runtime_protocol": "ade-runtime-v8", "build_id": null,
                "pid": 9, "instance_id": "i", "data_directory": "/data"}),
        );
        wire(
            Handoff {
                tag: HandoffTag::Tag,
                instance_id: "i".into(),
                ticket: "k".into(),
                expires_at: 5,
            },
            json!({"type": "handoff", "instance_id": "i", "ticket": "k", "expires_at": 5}),
        );
        wire(Ack::default(), json!({"type": "ack"}));
        wire(Error::new("No"), json!({"type": "error", "message": "No"}));
        wire(
            AgentError {
                tag: ErrorTag::Tag,
                code: None,
                message: "No".into(),
            },
            json!({"type": "error", "code": null, "message": "No"}),
        );
        wire(
            AgentEvents::<Value> {
                tag: EventsTag::Tag,
                events: vec![json!({"sequence": 1})],
                closed: false,
                output_failure: None,
            },
            json!({"type": "events", "events": [{"sequence": 1}], "closed": false,
                "output_failure": null}),
        );
    }

    #[test]
    fn hello_is_accepted_only_from_this_version_and_directory() {
        let reply = json!({"type": "hello", "runtime_protocol": VERSION, "build_id": "b",
            "pid": 9, "instance_id": "i", "data_directory": "/data"});
        assert_eq!(
            Hello::accept(&reply, Some("/data")).unwrap().instance_id,
            "i"
        );
        assert_eq!(
            Hello::accept(&reply, Some("/other")),
            Err(HelloRefusal::OtherDirectory)
        );
        assert_eq!(
            Hello::accept(&reply, None),
            Err(HelloRefusal::OtherDirectory)
        );
        // A different version is incompatible even when its shape differs.
        assert_eq!(
            Hello::accept(
                &json!({"runtime_protocol": "ade-runtime-v9"}),
                Some("/data")
            ),
            Err(HelloRefusal::Incompatible)
        );
        assert_eq!(
            Hello::accept(&json!({"type": "error", "message": "x"}), Some("/data")),
            Err(HelloRefusal::Incompatible)
        );
        let mut missing = reply.clone();
        missing.as_object_mut().unwrap().remove("instance_id");
        assert!(matches!(
            Hello::accept(&missing, Some("/data")),
            Err(HelloRefusal::Malformed(_))
        ));
    }

    #[test]
    fn a_handoff_ticket_is_presented_only_to_its_live_incarnation() {
        let record = json!({"type": "handoff", "instance_id": "i", "ticket": "k",
            "expires_at": 100});
        assert_eq!(Handoff::ticket_for(&record, "i", 99), Some("k".into()));
        assert_eq!(Handoff::ticket_for(&record, "i", 100), None);
        assert_eq!(Handoff::ticket_for(&record, "successor", 99), None);
        assert_eq!(Handoff::ticket_for(&json!({"ticket": "k"}), "i", 0), None);
        assert_eq!(
            Handoff::ticket_for(
                &json!({"type": "handoff", "instance_id": "i",
                "ticket": 7, "expires_at": 100}),
                "i",
                0
            ),
            None
        );
    }
}
