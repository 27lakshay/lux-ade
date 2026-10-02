//! Profile MCP catalog contracts (F131).
//!
//! Catalog writes change only the profile's own configuration and carry the
//! entry revision the caller saw, so they are idempotent commands: a repeat
//! converges and a stale revision is refused. Nothing here launches a server.
use super::{FrameSpec, OperationSpec, Tier};
use crate::mcp::{Definition, Excluded, Projected, Server};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<McpServerListRequest, McpServers>("mcp.server.list", Tier::Query),
        OperationSpec::new::<McpServerInspectRequest, McpServerInspection>(
            "mcp.server.inspect",
            Tier::Query,
        ),
        // Creates revision 1. Repeating it with the same definition returns the
        // stored entry; a different definition is refused.
        OperationSpec::new::<McpServerAddRequest, McpServerReply>(
            "mcp.server.add",
            Tier::IdempotentCommand,
        ),
        // Guarded by the expected revision; a repeat that already applied converges.
        OperationSpec::new::<McpServerUpdateRequest, McpServerReply>(
            "mcp.server.update",
            Tier::IdempotentCommand,
        ),
        // Guarded by the expected revision; removing an absent entry converges.
        OperationSpec::new::<McpServerRemoveRequest, McpServerRemoved>(
            "mcp.server.remove",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<McpResolveRequest, McpResolution>("mcp.resolve", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `mcp.server.list`: every catalog entry in the profile, in name order.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct McpServerListRequest {}

/// `mcp.server.inspect`: one entry and how each provider can express it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerInspectRequest {
    pub name: String,
}

/// `mcp.server.add`: record a new server once for the profile.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerAddRequest {
    pub name: String,
    pub definition: Definition,
}

/// `mcp.server.update`: replace an entry's definition.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerUpdateRequest {
    pub name: String,
    /// The revision the caller last saw.
    pub expected_revision: u64,
    pub definition: Definition,
}

/// `mcp.server.remove`: delete an entry at the revision the caller saw.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerRemoveRequest {
    pub name: String,
    pub expected_revision: u64,
}

/// `mcp.resolve`: the servers that apply to one workspace and provider, in
/// the provider's native configuration shape.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpResolveRequest {
    pub workspace_id: String,
    pub provider: String,
}

wire_tag!(McpServersTag, "mcp_servers");
wire_tag!(McpServerTag, "mcp_server");
wire_tag!(McpServerInspectionTag, "mcp_server_inspection");
wire_tag!(McpServerRemovedTag, "mcp_server_removed");
wire_tag!(McpResolutionTag, "mcp_resolution");

/// The `mcp.server.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServers {
    #[serde(rename = "type")]
    pub tag: McpServersTag,
    pub servers: Vec<Server>,
}

/// The `mcp.server.add` and `mcp.server.update` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerReply {
    #[serde(rename = "type")]
    pub tag: McpServerTag,
    pub server: Server,
}

/// The `mcp.server.remove` reply. `removed` is false when no entry existed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerRemoved {
    #[serde(rename = "type")]
    pub tag: McpServerRemovedTag,
    pub name: String,
    pub removed: bool,
}

/// Whether one provider can express an entry, and whether its adapter reads it yet.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ProviderSupport {
    pub provider: String,
    /// The provider-native server object, or null when it cannot be expressed.
    pub native: Option<Value>,
    /// Why the provider cannot express the entry; null when it can.
    pub unsupported_reason: Option<String>,
    /// True only when the provider's worker declares `configure_mcp` available.
    pub wired: bool,
}

/// The `mcp.server.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpServerInspection {
    #[serde(rename = "type")]
    pub tag: McpServerInspectionTag,
    pub server: Server,
    pub providers: Vec<ProviderSupport>,
    /// MCP protocol revisions the modelled transports follow, newest first.
    pub protocol_versions: Vec<String>,
}

/// The `mcp.resolve` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct McpResolution {
    #[serde(rename = "type")]
    pub tag: McpResolutionTag,
    pub workspace_id: String,
    pub provider: String,
    /// `direct`: the provider connects to each server itself and negotiates
    /// protocol version, capabilities and authorization on that one leg. ADE
    /// runs no MCP gateway yet.
    pub delivery: String,
    /// True only when the provider's worker declares `configure_mcp`
    /// available, so `document` reaches it at launch and resume. When false,
    /// this is what ADE would pass; the provider does not see it.
    pub wired: bool,
    pub servers: Vec<Projected>,
    pub excluded: Vec<Excluded>,
    /// The provider's native configuration document.
    pub document: Value,
    /// `claude_mcp_json`, `codex_config_toml` (the TOML tables as JSON),
    /// `omp_mcp_json`, or `worker_mcp_json`: the provider-neutral projection a
    /// worker without a native one receives (`docs/provider-authoring.md`).
    pub format: String,
    pub protocol_versions: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition() -> Value {
        json!({"enabled": true, "installation": {"source": "manual"},
            "transport": {"type": "stdio", "command": "/usr/local/bin/srv", "args": [],
                "env": {"TOKEN": {"env": "SRV_TOKEN"}}, "cwd": null},
            "scope": {"kind": "workspaces", "workspace_ids": ["w1"]},
            "providers": {"kind": "only", "provider_ids": ["codex"]}})
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: Value) {
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    #[test]
    fn requests_and_replies_keep_their_wire_shape() {
        round_trip::<McpServerAddRequest>(json!({"name": "srv", "definition": definition()}));
        round_trip::<McpServerUpdateRequest>(
            json!({"name": "srv", "expected_revision": 2, "definition": definition()}),
        );
        let server = json!({"name": "srv", "revision": 1, "definition": definition()});
        round_trip::<McpServers>(json!({"type": "mcp_servers", "servers": [server.clone()]}));
        round_trip::<McpServerReply>(json!({"type": "mcp_server", "server": server.clone()}));
        round_trip::<McpServerRemoved>(
            json!({"type": "mcp_server_removed", "name": "srv", "removed": false}),
        );
        round_trip::<McpServerInspection>(json!({"type": "mcp_server_inspection",
            "server": server, "protocol_versions": ["2026-07-28"],
            "providers": [{"provider": "claude", "native": null,
                "unsupported_reason": "x", "wired": false}]}));
        round_trip::<McpResolution>(json!({"type": "mcp_resolution", "workspace_id": "w1",
            "provider": "codex", "delivery": "direct", "wired": false,
            "servers": [{"name": "srv", "revision": 1, "native": {"command": "srv"}}],
            "excluded": [{"name": "old", "reason": "outside_scope", "detail": "d"}],
            "document": {"mcp_servers": {}}, "format": "codex_config_toml",
            "protocol_versions": ["2026-07-28"]}));
    }

    #[test]
    fn a_raw_secret_field_is_not_accepted() {
        let mut wire = json!({"name": "srv", "definition": definition()});
        wire["definition"]["transport"]["token"] = json!("ghp_x");
        assert!(serde_json::from_value::<McpServerAddRequest>(wire).is_err());
    }
}
