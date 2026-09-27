//! Execution host placement contracts (F126, F127, F129; architecture section 9).
//!
//! Every workspace, conversation, terminal and service runs on exactly one
//! execution host. The local host is the default: a resource this daemon holds
//! in its own state is local. A resource created on a remote host through the
//! remote transport is recorded here with that host's ID, and its host never
//! changes afterwards. Placement of new work names its host explicitly; a
//! placement on a host that is not available is refused and never falls back
//! to the local host. Remote previews are forwarded through the remote
//! transport; remote device control is not offered.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        // The local host and every registered remote host, with the evidence
        // this daemon holds about each one's readiness and capabilities.
        OperationSpec::new::<PlacementHostsRequest, ExecutionHosts>("placement.hosts", Tier::Query),
        // Decides whether new work of one kind may be placed on a host. It
        // never substitutes another host.
        OperationSpec::new::<PlacementCheckRequest, PlacementDecision>(
            "placement.check",
            Tier::Query,
        ),
        // Records the remote host of a resource created there. Repeating the
        // same record converges; a different host for a recorded resource, or
        // a remote host for a resource this daemon holds locally, is refused.
        OperationSpec::new::<PlacementRecordRequest, PlacementReply>(
            "placement.record",
            Tier::IdempotentCommand,
        ),
        // The execution host of one resource: recorded, or local because this
        // daemon holds it. A resource neither holds is refused, not assumed local.
        OperationSpec::new::<PlacementResolveRequest, PlacementReply>(
            "placement.resolve",
            Tier::Query,
        ),
        // Recorded remote placements, optionally for one host.
        OperationSpec::new::<PlacementListRequest, Placements>("placement.list", Tier::Query),
        // Forgets the record of a remote resource that no longer exists.
        // Releasing an absent record converges. The remote host is untouched.
        OperationSpec::new::<PlacementReleaseRequest, PlacementReleased>(
            "placement.release",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// An execution host. `local` is the host this daemon runs on; a remote host
/// is named by its `remote.host.*` registry ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionHost {
    // A struct variant, so a stray `host_id` on a local host is refused.
    Local {},
    Remote { host_id: String },
}

/// The kinds of work that carry an execution host.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Workspace,
    Conversation,
    Terminal,
    Service,
}

/// One placed resource. Everything except a workspace names its workspace,
/// and must run on that workspace's host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlacedResource {
    Workspace {
        workspace_id: String,
    },
    Conversation {
        workspace_id: String,
        conversation_id: String,
    },
    Terminal {
        workspace_id: String,
        terminal_id: String,
    },
    Service {
        workspace_id: String,
        name: String,
    },
}

/// What this daemon can prove about a host being able to take new work.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostReadiness {
    /// The local host: this daemon is answering.
    Ready,
    /// The remote daemon last started with compatible protocols. The client's
    /// remote transport must also be connected before work is sent.
    Started,
    /// The host cannot take new work; `reason` says why.
    Unavailable,
    /// The last start's outcome is unknown; probe before placing work.
    Unknown,
}

/// How a service preview on this host reaches the viewer.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreviewTransport {
    /// The URL is opened on this machine as it is.
    Direct,
    /// A loopback URL on the remote host is forwarded over the remote SSH transport.
    SshForward,
}

/// Whether device and computer control is available on a host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceAccess {
    /// Devices attached to this machine; each reports its own availability.
    LocalHost,
    /// Not offered. Nothing is redirected to a local device instead.
    Unsupported,
}

/// What a host can run and expose.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct HostCapabilities {
    /// The resource kinds a placement may target on this host.
    pub resources: Vec<ResourceKind>,
    pub previews: PreviewTransport,
    pub devices: DeviceAccess,
}

/// One execution host and what this daemon knows about it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ExecutionHostEntry {
    pub host: ExecutionHost,
    pub label: String,
    pub readiness: HostReadiness,
    /// Why the host is not ready, or what the client must still confirm.
    pub reason: Option<String>,
    pub capabilities: HostCapabilities,
    /// Remote hosts only: the remote daemon's socket from its last start.
    pub remote_socket: Option<String>,
    /// Remote hosts only: the remote profile from its last start.
    pub remote_profile_id: Option<String>,
}

/// `placement.hosts`: every execution host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct PlacementHostsRequest {}

/// `placement.check`: may new work of `resource` kind be placed on `host`?
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementCheckRequest {
    pub host: ExecutionHost,
    pub resource: ResourceKind,
    /// For anything but a workspace: the workspace the work belongs to. Its
    /// host must be `host`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `placement.record`: record the host of a resource created on a remote host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementRecordRequest {
    pub resource: PlacedResource,
    pub host: ExecutionHost,
}

/// `placement.resolve`: the host of one resource.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementResolveRequest {
    pub resource: PlacedResource,
}

/// `placement.list`: recorded placements, all or for one remote host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct PlacementListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

/// `placement.release`: forget one recorded placement.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementReleaseRequest {
    pub resource: PlacedResource,
}

wire_tag!(ExecutionHostsTag, "execution_hosts");
wire_tag!(PlacementDecisionTag, "placement_decision");
wire_tag!(PlacementTag, "placement");
wire_tag!(PlacementsTag, "placements");
wire_tag!(PlacementReleasedTag, "placement_released");

/// The `placement.hosts` reply. The local host is always first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ExecutionHosts {
    #[serde(rename = "type")]
    pub tag: ExecutionHostsTag,
    pub hosts: Vec<ExecutionHostEntry>,
}

/// The `placement.check` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PlacementDecision {
    #[serde(rename = "type")]
    pub tag: PlacementDecisionTag,
    pub host: ExecutionHost,
    pub resource: ResourceKind,
    /// True only when this daemon's evidence allows the placement.
    pub admitted: bool,
    /// Why the placement is refused, or what the client must still confirm.
    pub reason: Option<String>,
    /// True for a remote host: the work is sent through the remote transport,
    /// which must be connected to this host at that moment.
    pub requires_remote_transport: bool,
}

/// Where a resource's host identity comes from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlacementSource {
    /// This daemon holds the resource, so it runs on the local host.
    LocalState,
    /// A `placement.record` names its remote host.
    Recorded,
}

/// One resource and its execution host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Placement {
    pub resource: PlacedResource,
    pub host: ExecutionHost,
    pub source: PlacementSource,
    /// When the record was written; null for local state.
    pub recorded_at_ms: Option<i64>,
}

/// The `placement.record` and `placement.resolve` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementReply {
    #[serde(rename = "type")]
    pub tag: PlacementTag,
    pub placement: Placement,
}

/// The `placement.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct Placements {
    #[serde(rename = "type")]
    pub tag: PlacementsTag,
    pub placements: Vec<Placement>,
}

/// The `placement.release` reply. `released` is false when nothing was recorded.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PlacementReleased {
    #[serde(rename = "type")]
    pub tag: PlacementReleasedTag,
    pub resource: PlacedResource,
    pub released: bool,
}

impl PlacedResource {
    pub fn kind(&self) -> ResourceKind {
        match self {
            Self::Workspace { .. } => ResourceKind::Workspace,
            Self::Conversation { .. } => ResourceKind::Conversation,
            Self::Terminal { .. } => ResourceKind::Terminal,
            Self::Service { .. } => ResourceKind::Service,
        }
    }

    pub fn workspace_id(&self) -> &str {
        match self {
            Self::Workspace { workspace_id }
            | Self::Conversation { workspace_id, .. }
            | Self::Terminal { workspace_id, .. }
            | Self::Service { workspace_id, .. } => workspace_id,
        }
    }

    /// The resource's own key within its kind: the workspace, conversation or
    /// terminal ID, or the service name.
    pub fn key(&self) -> &str {
        match self {
            Self::Workspace { workspace_id } => workspace_id,
            Self::Conversation {
                conversation_id, ..
            } => conversation_id,
            Self::Terminal { terminal_id, .. } => terminal_id,
            Self::Service { name, .. } => name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: Value) {
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    #[test]
    fn requests_and_replies_keep_their_wire_shape() {
        round_trip::<PlacementCheckRequest>(json!({"host": {"kind": "local"},
            "resource": "workspace"}));
        round_trip::<PlacementCheckRequest>(
            json!({"host": {"kind": "remote", "host_id": "devbox"},
            "resource": "terminal", "workspace_id": "w1"}),
        );
        round_trip::<PlacementRecordRequest>(
            json!({"host": {"kind": "remote", "host_id": "devbox"},
            "resource": {"kind": "service", "workspace_id": "w1", "name": "web"}}),
        );
        round_trip::<PlacementReply>(json!({"type": "placement", "placement": {
            "resource": {"kind": "conversation", "workspace_id": "w1", "conversation_id": "c1"},
            "host": {"kind": "local"}, "source": "local_state", "recorded_at_ms": null}}));
        round_trip::<ExecutionHosts>(json!({"type": "execution_hosts", "hosts": [{
            "host": {"kind": "remote", "host_id": "devbox"}, "label": "Devbox",
            "readiness": "unavailable", "reason": "not paired",
            "capabilities": {"resources": ["workspace"], "previews": "ssh_forward",
                "devices": "unsupported"},
            "remote_socket": null, "remote_profile_id": null}]}));
        round_trip::<PlacementDecision>(json!({"type": "placement_decision",
            "host": {"kind": "remote", "host_id": "devbox"}, "resource": "workspace",
            "admitted": false, "reason": "r", "requires_remote_transport": true}));
    }

    #[test]
    fn a_host_is_named_explicitly() {
        // No bare string, no implicit default and no stray fields.
        for wire in [
            json!({"host": "local", "resource": "workspace"}),
            json!({"resource": "workspace"}),
            json!({"host": {"kind": "remote"}, "resource": "workspace"}),
            json!({"host": {"kind": "local", "host_id": "devbox"}, "resource": "workspace"}),
            json!({"host": {"kind": "any"}, "resource": "workspace"}),
        ] {
            assert!(serde_json::from_value::<PlacementCheckRequest>(wire).is_err());
        }
    }
}
