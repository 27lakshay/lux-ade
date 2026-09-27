//! Managed service, stable-URL proxy and listener contracts.
//!
//! The runtime-facing `proxy.*` calls are daemon-to-runtime and are not typed
//! here. The daemon forwards the runtime's proxy replies with the shapes below.
use super::conversations::Ack;
use super::placement::ExecutionHost;
use super::{FrameSpec, OperationSpec, Tier};
use crate::services::{Config, Service};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ServiceConfigureRequest, ServiceReply>(
            "service.configure",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ServiceListRequest, ServiceList>("service.list", Tier::Query),
        OperationSpec::new::<ServiceInspectRequest, ServiceInspection>(
            "service.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<ServiceStartRequest, ServiceReply>(
            "service.start",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ServiceStopRequest, ServiceReply>("service.stop", Tier::EffectCommand),
        OperationSpec::new::<ServiceRemoveRequest, Ack>("service.remove", Tier::EffectCommand),
        OperationSpec::new::<ServiceHealthSampleRequest, ServiceHealthSample>(
            "service.health.sample",
            Tier::Query,
        ),
        OperationSpec::new::<ServiceProxyEnsureRequest, ServiceProxy>(
            "service.proxy.ensure",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ServiceProxyInspectRequest, ServiceProxy>(
            "service.proxy.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<ServiceProxyTargetRequest, ServiceProxyTarget>(
            "service.proxy.target",
            Tier::Query,
        ),
        OperationSpec::new::<ServiceProxyRemapRequest, ServiceProxy>(
            "service.proxy.remap",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ServiceProxyRetireRequest, ServiceProxyRetired>(
            "service.proxy.retire",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ServiceProxyRecoveryInspectRequest, ServiceProxyRecovery>(
            "service.proxy.recovery.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<ServiceProxyRecoveryRetryRequest, ServiceProxy>(
            "service.proxy.recovery.retry",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ServiceProxyRecoveryResetRequest, ServiceProxyRecoveryReset>(
            "service.proxy.recovery.reset",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ListenerListRequest, ListenerInventory>("listener.list", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<ServiceChanged>("service_changed")]
}

/// `service.configure`: create or edit a service recipe.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceConfigureRequest {
    pub workspace_id: String,
    pub name: String,
    /// The revision the caller last saw; 0 creates the service.
    pub revision: i64,
    /// Decoded as a [`Config`] by the handler, so malformed recipes keep the
    /// daemon's own validation messages.
    #[schemars(with = "Config")]
    pub config: Value,
}

/// `service.list`: a workspace's services and their execution state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceListRequest {
    pub workspace_id: String,
}

/// `service.inspect`: execution, readiness, peers and bounded output of one service.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceInspectRequest {
    pub workspace_id: String,
    pub name: String,
    /// Output tail in bytes, 1 to 32768; the daemon uses 8192 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub tail_bytes: Option<u64>,
    /// A one-off HTTP probe. The handler validates it, so its messages stay
    /// specific.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "HealthCheckRequest")]
    pub health_check: Option<Value>,
}

/// The HTTP probe `service.inspect` accepts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct HealthCheckRequest {
    pub port_variable: String,
    pub path: String,
    #[schemars(range(min = 50, max = 2000))]
    pub timeout_ms: u64,
}

/// `service.start`: launch a configured service, or return its live run.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceStartRequest {
    pub workspace_id: String,
    pub name: String,
}

/// `service.stop`: stop a service and confirm its process exited.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceStopRequest {
    pub workspace_id: String,
    pub name: String,
}

/// `service.remove`: delete a stopped service at the revision the caller saw.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceRemoveRequest {
    pub workspace_id: String,
    pub name: String,
    pub revision: i64,
}

/// `service.health.sample`: probe the service's configured health policy now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceHealthSampleRequest {
    pub workspace_id: String,
    pub name: String,
}

/// `service.proxy.ensure`: create or reuse the stable URL for one service port.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyEnsureRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
}

/// `service.proxy.inspect`: read one stable URL.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyInspectRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
}

/// `service.proxy.remap`: point a stable URL at the service's current identity
/// and port, only if both reviewed targets still match.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRemapRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
    pub expected_service_identity: String,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_target_port: u64,
    pub expected_route_identity: String,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_route_port: u64,
}

/// `service.proxy.retire`: retire exactly one reviewed stable URL.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRetireRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
    pub expected_route_id: String,
    pub expected_service_identity: String,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_target_port: u64,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_proxy_port: u64,
}

/// `service.proxy.recovery.inspect`: blocked routes or a corrupt registry.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ServiceProxyRecoveryInspectRequest {}

/// `service.proxy.recovery.retry`: rebind a blocked route's original port.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRecoveryRetryRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
    pub expected_route_id: String,
    pub expected_service_identity: String,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_target_port: u64,
    #[schemars(range(min = 1, max = 65535))]
    pub expected_proxy_port: u64,
}

/// `service.proxy.recovery.reset`: archive and reset an inspected corrupt registry.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRecoveryResetRequest {
    pub expected_registry_sha256: String,
}

/// `service.proxy.target`: the runtime proxy asks the daemon to verify its
/// target before forwarding one connection.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyTargetRequest {
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
    pub expected_port: u64,
    pub service_identity: String,
    /// `127.0.0.1` or `::1`.
    pub connected_host: String,
}

/// `listener.list`: observe local TCP listeners and service port assignments.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ListenerListRequest {}

wire_tag!(ServiceTag, "service");
wire_tag!(ServicesTag, "services");
wire_tag!(ServiceInspectionTag, "service_inspection");
wire_tag!(ServiceHealthSampleTag, "service_health_sample");
wire_tag!(ServiceChangedTag, "service_changed");
wire_tag!(ServiceProxyTag, "service_proxy");
wire_tag!(ServiceProxyRetiredTag, "service_proxy_retired");
wire_tag!(ServiceProxyRecoveryTag, "service_proxy_recovery");
wire_tag!(ServiceProxyRecoveryResetTag, "service_proxy_recovery_reset");
wire_tag!(ResetStatus, "reset");
wire_tag!(ServiceProxyTargetTag, "service_proxy_target");
wire_tag!(ListenersTag, "listeners");
wire_tag!(LocalPrivateScope, "local_private");
wire_tag!(RuntimeOwner, "runtime");
wire_tag!(LocalHostScope, "local_host");
wire_tag!(PartialCoverage, "partial");
wire_tag!(TcpProtocol, "tcp");
wire_tag!(Unverified, "unverified");

/// Whether a service's recorded run is live in the current runtime.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Running,
    Exited,
    Stopped,
    Unavailable,
}

/// One service's entry in [`ServiceList::states`].
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceExecution {
    pub state: ExecutionState,
    /// The runtime terminal metrics, or null when the service has no live terminal.
    #[schemars(with = "Value")]
    pub metrics: Option<Value>,
}

/// The `service.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceList {
    #[serde(rename = "type")]
    pub tag: ServicesTag,
    pub services: Vec<Service>,
    /// Keyed by service name.
    pub states: BTreeMap<String, ServiceExecution>,
}

/// The `service.configure`, `service.start` and `service.stop` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceReply {
    #[serde(rename = "type")]
    pub tag: ServiceTag,
    pub service: Service,
    /// Present on `service.start`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// The launched terminal's metrics; present on `service.start`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub metrics: Option<Value>,
    /// Peer URLs placed in the run's environment; present on `service.start`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_peers: Option<BTreeMap<String, String>>,
}

impl ServiceReply {
    /// A reply showing `service` with its secret values redacted.
    pub fn service(service: Service) -> Self {
        Self {
            tag: ServiceTag::Tag,
            service: service.redacted(),
            terminal_id: None,
            metrics: None,
            effective_peers: None,
        }
    }
}

/// What the daemon could observe about a running service's ports.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessState {
    Stopped,
    Exited,
    Unknown,
    UnknownNoPortCheck,
    PortConflict,
    TcpListening,
    NotObserved,
    ObservationUnavailable,
    /// The service's process tree listens, but not on every assigned port: it
    /// most likely lost the bind and chose another port. Not ready, not wired.
    BoundUnassignedPort,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessBasis {
    /// Every verified listener is the service's direct process.
    DirectProcessTcpListener,
    /// At least one verified listener is a descendant of the direct process.
    ProcessTreeTcpListener,
    ExecutionState,
    IdentityChanged,
}

/// Port readiness; application readiness is never inferred.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct Readiness {
    pub state: ReadinessState,
    pub basis: ReadinessBasis,
    pub application_ready: Unverified,
    pub observation_error: Option<String>,
}

/// The `service.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceInspection {
    #[serde(rename = "type")]
    pub tag: ServiceInspectionTag,
    pub service: Service,
    pub execution_state: ExecutionState,
    pub execution_error: Option<String>,
    pub readiness: Readiness,
    /// The live terminal tail, or `{available: false, reason}`.
    #[schemars(with = "Value")]
    pub logs: Value,
    /// The durable run log tail, or `{available: false, reason}`.
    #[schemars(with = "Value")]
    pub durable_logs: Value,
    pub effective_peers: BTreeMap<String, String>,
    /// Absent when the service changed during inspection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_peer_endpoints: Option<BTreeMap<String, String>>,
    pub peer_error: Option<String>,
    /// The requested one-off probe result; present when `health_check` was sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub health: Option<Value>,
    /// The configured policy's latest monitored result.
    #[schemars(with = "Value")]
    pub health_monitor: Value,
}

/// The `service.health.sample` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceHealthSample {
    #[serde(rename = "type")]
    pub tag: ServiceHealthSampleTag,
    #[schemars(with = "Value")]
    pub health_monitor: Value,
}

/// The `service_changed` feed frame, sent when a run starts or stops.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceChanged {
    #[serde(rename = "type")]
    pub tag: ServiceChangedTag,
    pub service: Service,
    /// The launched terminal's metrics; present when a run starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub metrics: Option<Value>,
    pub boot_id: String,
    pub revision: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyAvailability {
    Bound,
    PortOccupied,
}

/// A stable URL. The `service.proxy.ensure`, `service.proxy.inspect`,
/// `service.proxy.remap` and `service.proxy.recovery.retry` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxy {
    #[serde(rename = "type")]
    pub tag: ServiceProxyTag,
    /// Null when the route's port is occupied.
    pub url: Option<String>,
    pub port: u16,
    pub scope: LocalPrivateScope,
    pub owner: RuntimeOwner,
    pub service_identity: String,
    pub target_port: u16,
    pub route_id: String,
    /// The execution host of the routed service, from its workspace's
    /// placement. The runtime omits it; the daemon adds it after checking the
    /// service runs on this host.
    pub execution_host: ExecutionHost,
    /// Present, as `port_occupied`, only from `service.proxy.inspect` on a blocked route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<ProxyAvailability>,
}

/// The `service.proxy.retire` reply: the route as it was retired.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRetired {
    #[serde(rename = "type")]
    pub tag: ServiceProxyRetiredTag,
    pub url: String,
    pub port: u16,
    pub scope: LocalPrivateScope,
    pub owner: RuntimeOwner,
    pub service_identity: String,
    pub target_port: u16,
    pub route_id: String,
}

/// One route in [`ServiceProxyRecovery::routes`].
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRoute {
    #[serde(rename = "type")]
    pub tag: ServiceProxyTag,
    /// Null when the route's port is occupied.
    pub url: Option<String>,
    pub port: u16,
    pub scope: LocalPrivateScope,
    pub owner: RuntimeOwner,
    pub service_identity: String,
    pub target_port: u16,
    pub route_id: String,
    pub workspace_id: String,
    pub name: String,
    pub port_variable: String,
    pub availability: ProxyAvailability,
    /// Why the port is unavailable; present when it is occupied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Healthy,
    Degraded,
    Corrupt,
}

/// The `service.proxy.recovery.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRecovery {
    #[serde(rename = "type")]
    pub tag: ServiceProxyRecoveryTag,
    pub status: RecoveryStatus,
    /// Present when the registry is corrupt; empty when no bounded digest exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_sha256: Option<String>,
    /// Present when the registry is corrupt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub routes: Vec<ServiceProxyRoute>,
}

/// The `service.proxy.recovery.reset` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyRecoveryReset {
    #[serde(rename = "type")]
    pub tag: ServiceProxyRecoveryResetTag,
    pub status: ResetStatus,
    pub previous_sha256: String,
    /// Path of the archived corrupt registry.
    pub archive: String,
}

/// The `service.proxy.target` reply: the verified service process to forward to.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ServiceProxyTarget {
    #[serde(rename = "type")]
    pub tag: ServiceProxyTargetTag,
    pub host: String,
    pub port: u64,
    pub transfer_id: String,
    pub pid: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ListenerFamily {
    Ipv4,
    Ipv6,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ListenerOwnership {
    ManagedService,
    Unknown,
}

/// One observed TCP listener.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ListenerRow {
    pub protocol: TcpProtocol,
    pub address: String,
    pub port: u16,
    pub family: ListenerFamily,
    pub pid: u32,
    pub ownership: ListenerOwnership,
    /// Set when the listener belongs to a verified managed service run.
    pub workspace_id: Option<String>,
    pub service_name: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortObservation {
    VerifiedManaged,
    Contested,
    ObservedOther,
    Unobserved,
}

/// One service port assignment and who was seen listening on it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PortAssignment {
    pub workspace_id: String,
    pub service_name: String,
    pub variable: String,
    pub port: u16,
    pub observation: PortObservation,
}

/// The `listener.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ListenerInventory {
    #[serde(rename = "type")]
    pub tag: ListenersTag,
    pub scope: LocalHostScope,
    pub coverage: PartialCoverage,
    pub listeners: Vec<ListenerRow>,
    pub assignments: Vec<PortAssignment>,
}

#[cfg(test)]
mod tests {
    //! Wire round trips: JSON in the shape the daemon sent and accepted before
    //! typing validates against the generated schema, decodes into the typed
    //! contract and encodes back unchanged.
    use super::super::bundle;
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;

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
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        let validator = jsonschema::validator_for(&schema).expect("generated schema compiles");
        let errors: Vec<_> = validator
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    fn assert_invalid(name: &str, value: &Value) {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        let validator = jsonschema::validator_for(&schema).expect("generated schema compiles");
        assert!(!validator.is_valid(value), "{name} accepted {value}");
    }

    /// A client request line, including `op`.
    fn request<T: Serialize + DeserializeOwned>(wire: Value) {
        let op = wire["op"].as_str().unwrap().to_owned();
        let (name, _) = operation(&op);
        assert_valid(&name, &wire);
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(typed).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    /// A daemon reply to `op`.
    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = operation(op);
        reply::<T>(&name, wire);
    }

    fn reply<T: Serialize + DeserializeOwned>(name: &str, wire: Value) {
        assert_valid(name, &wire);
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    fn config() -> Value {
        json!({"program": "pnpm", "args": ["dev"], "env": {"MODE": "dev"}, "cwd": ".",
            "ports": ["PORT"], "peers": {"API_URL": {"service": "api", "port_variable": "PORT"}},
            "health": {"port_variable": "PORT", "path": "/health", "timeout_ms": 500, "interval_ms": 5000}})
    }

    fn service() -> Value {
        json!({"identity": "service_1", "terminal_id": "terminal_1",
            "terminal_owner": {"terminal_id": "terminal_1", "transfer_id": "transfer_1",
                "runtime_instance": "runtime_1"},
            "last_run_transfer_id": "transfer_1", "workspace_id": "workspace_1", "name": "web",
            "revision": 2, "config": config(), "ports": {"PORT": 20001},
            "hostname": "web-abcdef.localhost", "launch_peers": {"API_URL": "http://127.0.0.1:20002"}})
    }

    fn stopped_service() -> Value {
        json!({"identity": "service_1", "terminal_id": null, "terminal_owner": null,
            "workspace_id": "workspace_1", "name": "web", "revision": 1,
            "config": {"program": "pnpm", "args": [], "env": {}, "cwd": ".", "ports": []},
            "ports": {}, "hostname": "web-abcdef.localhost"})
    }

    fn proxy() -> Value {
        json!({"type": "service_proxy", "url": "http://127.0.0.1:41000/", "port": 41000,
            "scope": "local_private", "owner": "runtime", "service_identity": "service_1",
            "target_port": 20001, "route_id": "route_1"})
    }

    #[test]
    fn services_declare_tiers_and_frames() {
        let bundle = bundle();
        let ours = |spec: &&Value| spec["domain"] == "services";
        let tiers: Vec<_> = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(ours)
            .map(|spec| {
                (
                    spec["name"].as_str().unwrap(),
                    spec["tier"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            tiers,
            [
                ("service.configure", "idempotent_command"),
                ("service.list", "query"),
                ("service.inspect", "query"),
                ("service.start", "effect_command"),
                ("service.stop", "effect_command"),
                ("service.remove", "effect_command"),
                ("service.health.sample", "query"),
                ("service.proxy.ensure", "idempotent_command"),
                ("service.proxy.inspect", "query"),
                ("service.proxy.target", "query"),
                ("service.proxy.remap", "effect_command"),
                ("service.proxy.retire", "effect_command"),
                ("service.proxy.recovery.inspect", "query"),
                ("service.proxy.recovery.retry", "effect_command"),
                ("service.proxy.recovery.reset", "effect_command"),
                ("listener.list", "query"),
            ]
        );
        let kinds: Vec<_> = bundle["frames"]
            .as_array()
            .unwrap()
            .iter()
            .filter(ours)
            .map(|spec| spec["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["service_changed"]);
    }

    #[test]
    fn service_requests_round_trip() {
        request::<ServiceConfigureRequest>(json!({"op": "service.configure",
            "workspace_id": "workspace_1", "name": "web", "config": config(), "revision": 0}));
        request::<ServiceConfigureRequest>(json!({"op": "service.configure",
            "workspace_id": "workspace_1", "name": "web", "config": {"program": "pnpm"}, "revision": 3}));
        request::<ServiceListRequest>(json!({"op": "service.list", "workspace_id": "workspace_1"}));
        request::<ServiceInspectRequest>(json!({"op": "service.inspect",
            "workspace_id": "workspace_1", "name": "web"}));
        request::<ServiceInspectRequest>(json!({"op": "service.inspect",
            "workspace_id": "workspace_1", "name": "web", "tail_bytes": 4096,
            "health_check": {"port_variable": "PORT", "path": "/", "timeout_ms": 500}}));
        request::<ServiceStartRequest>(json!({"op": "service.start",
            "workspace_id": "workspace_1", "name": "web"}));
        request::<ServiceStopRequest>(json!({"op": "service.stop",
            "workspace_id": "workspace_1", "name": "web"}));
        request::<ServiceRemoveRequest>(json!({"op": "service.remove",
            "workspace_id": "workspace_1", "name": "web", "revision": 2}));
        request::<ServiceHealthSampleRequest>(json!({"op": "service.health.sample",
            "workspace_id": "workspace_1", "name": "web"}));
        request::<ListenerListRequest>(json!({"op": "listener.list"}));
    }

    #[test]
    fn proxy_requests_round_trip() {
        request::<ServiceProxyEnsureRequest>(json!({"op": "service.proxy.ensure",
            "workspace_id": "workspace_1", "name": "web", "port_variable": "PORT"}));
        request::<ServiceProxyInspectRequest>(json!({"op": "service.proxy.inspect",
            "workspace_id": "workspace_1", "name": "web", "port_variable": "PORT"}));
        request::<ServiceProxyRemapRequest>(json!({"op": "service.proxy.remap",
            "workspace_id": "workspace_1", "name": "web", "port_variable": "PORT",
            "expected_service_identity": "service_1", "expected_target_port": 20001,
            "expected_route_identity": "service_0", "expected_route_port": 20000}));
        let route = json!({"workspace_id": "workspace_1", "name": "web", "port_variable": "PORT",
            "expected_route_id": "route_1", "expected_service_identity": "service_1",
            "expected_target_port": 20001, "expected_proxy_port": 41000});
        let mut retire = route.clone();
        retire["op"] = json!("service.proxy.retire");
        request::<ServiceProxyRetireRequest>(retire);
        let mut retry = route;
        retry["op"] = json!("service.proxy.recovery.retry");
        request::<ServiceProxyRecoveryRetryRequest>(retry);
        request::<ServiceProxyRecoveryInspectRequest>(
            json!({"op": "service.proxy.recovery.inspect"}),
        );
        request::<ServiceProxyRecoveryResetRequest>(json!({"op": "service.proxy.recovery.reset",
            "expected_registry_sha256": "a".repeat(64)}));
        // The runtime proxy's own request line.
        request::<ServiceProxyTargetRequest>(json!({"op": "service.proxy.target",
            "workspace_id": "workspace_1", "name": "web", "port_variable": "PORT",
            "expected_port": 20001, "service_identity": "service_1", "connected_host": "127.0.0.1"}));
    }

    #[test]
    fn requests_reject_what_the_daemon_rejects() {
        let (name, _) = operation("service.configure");
        assert_invalid(
            &name,
            &json!({"op": "service.configure", "workspace_id": "w",
            "name": "web", "revision": 0, "config": {"program": "x", "unknown": 1}}),
        );
        let (name, _) = operation("service.proxy.remap");
        assert_invalid(
            &name,
            &json!({"op": "service.proxy.remap", "workspace_id": "w",
            "name": "web", "port_variable": "PORT", "expected_service_identity": "s",
            "expected_target_port": 0, "expected_route_identity": "r", "expected_route_port": 1}),
        );
        let (name, _) = operation("service.inspect");
        assert_invalid(
            &name,
            &json!({"op": "service.inspect", "workspace_id": "w",
            "name": "web", "health_check": {"port_variable": "PORT", "path": "/", "timeout_ms": 10}}),
        );
    }

    #[test]
    fn service_replies_round_trip() {
        response::<ServiceList>(
            "service.list",
            json!({"type": "services",
            "services": [service(), stopped_service()],
            "states": {"web": {"state": "running", "metrics": {"transfer_id": "transfer_1",
                "shell_running": true, "shell_pid": 42}},
                "api": {"state": "stopped", "metrics": null}}}),
        );
        response::<ServiceReply>(
            "service.configure",
            json!({"type": "service", "service": stopped_service()}),
        );
        response::<ServiceReply>(
            "service.start",
            json!({"type": "service", "service": service(),
            "terminal_id": "terminal_1", "metrics": {"transfer_id": "transfer_1"},
            "effective_peers": {"API_URL": "http://127.0.0.1:20002"}}),
        );
        response::<ServiceReply>(
            "service.stop",
            json!({"type": "service", "service": service()}),
        );
        response::<Ack>("service.remove", json!({"type": "ack"}));
        response::<ServiceHealthSample>(
            "service.health.sample",
            json!({
            "type": "service_health_sample",
            "health_monitor": {"state": "unknown", "basis": "identity_changed"}}),
        );
        reply::<ServiceChanged>(
            "ServiceChanged",
            json!({"type": "service_changed",
            "service": service(), "metrics": {"transfer_id": "transfer_1"},
            "revision": 7, "boot_id": "boot_1"}),
        );
        reply::<ServiceChanged>(
            "ServiceChanged",
            json!({"type": "service_changed",
            "service": stopped_service(), "revision": 8, "boot_id": "boot_1"}),
        );
    }

    #[test]
    fn inspection_replies_round_trip() {
        response::<ServiceInspection>(
            "service.inspect",
            json!({"type": "service_inspection",
            "service": service(), "execution_state": "running", "execution_error": null,
            "readiness": {"state": "tcp_listening", "basis": "direct_process_tcp_listener",
                "application_ready": "unverified", "observation_error": null},
            "logs": {"available": true, "transfer_id": "transfer_1", "text": "ok"},
            "durable_logs": {"available": false, "reason": "not_started"},
            "effective_peers": {"API_URL": "http://127.0.0.1:20002"},
            "current_peer_endpoints": {"API_URL": "http://127.0.0.1:20002"},
            "peer_error": null,
            "health": {"state": "healthy", "basis": "http_status", "status_code": 200,
                "port_variable": "PORT", "path": "/health"},
            "health_monitor": {"state": "disabled"}}),
        );
        response::<ServiceInspection>(
            "service.inspect",
            json!({"type": "service_inspection",
            "service": stopped_service(), "execution_state": "unavailable",
            "execution_error": "Service changed during inspection; refresh",
            "readiness": {"state": "unknown", "basis": "identity_changed",
                "application_ready": "unverified",
                "observation_error": "Service changed during inspection; refresh"},
            "logs": {"available": false, "reason": "service_changed_during_inspection"},
            "durable_logs": {"available": false, "reason": "service_changed_during_inspection"},
            "effective_peers": {}, "peer_error": "Service changed during inspection; refresh",
            "health_monitor": {"state": "unknown", "basis": "identity_changed"}}),
        );
        response::<ServiceInspection>(
            "service.inspect",
            json!({"type": "service_inspection",
            "service": service(), "execution_state": "running", "execution_error": null,
            "readiness": {"state": "bound_unassigned_port", "basis": "process_tree_tcp_listener",
                "application_ready": "unverified", "observation_error": null},
            "logs": {"available": true, "transfer_id": "transfer_1", "text": "ok"},
            "durable_logs": {"available": false, "reason": "not_started"},
            "effective_peers": {}, "current_peer_endpoints": {}, "peer_error": null,
            "health": {"state": "unhealthy", "basis": "assigned_port_not_bound",
                "port_variable": "PORT", "path": "/health"},
            "health_monitor": {"state": "disabled"}}),
        );
    }

    #[test]
    fn proxy_replies_round_trip() {
        let mut routed = proxy();
        routed["execution_host"] = json!({"kind": "local"});
        response::<ServiceProxy>("service.proxy.ensure", routed.clone());
        // A reply without its execution host is refused, never assumed local.
        assert!(serde_json::from_value::<ServiceProxy>(proxy()).is_err());
        let mut blocked = routed;
        blocked["url"] = Value::Null;
        blocked["availability"] = json!("port_occupied");
        response::<ServiceProxy>("service.proxy.inspect", blocked);
        let mut retired = proxy();
        retired["type"] = json!("service_proxy_retired");
        response::<ServiceProxyRetired>("service.proxy.retire", retired);
        let mut bound = proxy();
        bound["workspace_id"] = json!("workspace_1");
        bound["name"] = json!("web");
        bound["port_variable"] = json!("PORT");
        bound["availability"] = json!("bound");
        let mut occupied = bound.clone();
        occupied["url"] = Value::Null;
        occupied["availability"] = json!("port_occupied");
        occupied["reason"] = json!("Address already in use");
        response::<ServiceProxyRecovery>(
            "service.proxy.recovery.inspect",
            json!({
            "type": "service_proxy_recovery", "status": "degraded", "routes": [bound, occupied]}),
        );
        response::<ServiceProxyRecovery>(
            "service.proxy.recovery.inspect",
            json!({
            "type": "service_proxy_recovery", "status": "corrupt", "registry_sha256": "",
            "reason": "Invalid registry", "routes": []}),
        );
        response::<ServiceProxyRecoveryReset>(
            "service.proxy.recovery.reset",
            json!({
            "type": "service_proxy_recovery_reset", "status": "reset",
            "previous_sha256": "a".repeat(64), "archive": "/tmp/proxies.corrupt-1.json"}),
        );
        response::<ServiceProxyTarget>(
            "service.proxy.target",
            json!({
            "type": "service_proxy_target", "host": "127.0.0.1", "port": 20001,
            "transfer_id": "transfer_1", "pid": 42}),
        );
    }

    #[test]
    fn listener_inventory_round_trips() {
        response::<ListenerInventory>(
            "listener.list",
            json!({"type": "listeners",
            "scope": "local_host", "coverage": "partial",
            "listeners": [
                {"protocol": "tcp", "address": "127.0.0.1", "port": 20001, "family": "ipv4",
                    "pid": 42, "ownership": "managed_service", "workspace_id": "workspace_1",
                    "service_name": "web"},
                {"protocol": "tcp", "address": "*", "port": 5432, "family": "ipv6",
                    "pid": 7, "ownership": "unknown", "workspace_id": null, "service_name": null}],
            "assignments": [{"workspace_id": "workspace_1", "service_name": "web",
                "variable": "PORT", "port": 20001, "observation": "verified_managed"}]}),
        );
    }
}
