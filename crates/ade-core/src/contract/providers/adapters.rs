//! Generic ACP and custom executable adapters (F024, decision D04).
//!
//! A profile keeps its own adapter definitions. Each one names an absolute
//! executable, its arguments and non-secret environment, and the protocol it
//! speaks: the Agent Client Protocol, or plain text in and text out.
//!
//! An adapter's capabilities are never assumed. `adapter.probe` starts the
//! bundled ACP provider worker on the agent, which negotiates with the agent
//! and reports the capabilities and operations that negotiation supports; ADE
//! records them with the identity of the executable it probed. A later
//! change to the definition or the executable makes that probe `stale`. A
//! custom executable is checked without running it, because running it would
//! send a prompt; its capabilities are the fixed minimum ADE can honour.
use super::super::{OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<AdapterListRequest, AdapterList>("adapter.list", Tier::Query),
        // Stores the whole definition. Repeating the same definition changes
        // nothing; a different one bumps the revision and invalidates the probe.
        OperationSpec::new::<AdapterPutRequest, AdapterPut>("adapter.put", Tier::IdempotentCommand),
        OperationSpec::new::<AdapterRemoveRequest, AdapterRemoved>(
            "adapter.remove",
            Tier::IdempotentCommand,
        ),
        // Replaces the stored probe with a fresh one. ACP `initialize` has no
        // agent-side effect, and a custom executable is not run.
        OperationSpec::new::<AdapterProbeRequest, AdapterProbed>(
            "adapter.probe",
            Tier::IdempotentCommand,
        ),
    ]
}

/// The protocol an adapter speaks on its standard streams.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AdapterKind {
    /// Agent Client Protocol v1: JSON-RPC 2.0, one message per line, run
    /// through the bundled ACP provider worker (`providers/acp`).
    Acp,
    /// A plain CLI agent: one process per prompt, standard output is the reply.
    Executable,
}

/// How a custom executable receives the prompt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PromptInput {
    /// Written to standard input, which is then closed.
    Stdin,
    /// Appended as the final argument.
    Argument,
}

/// Settings only a custom executable has.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutableSettings {
    pub prompt_input: PromptInput,
    /// A turn still running after this many seconds is stopped and reported
    /// failed. From 1 to 3600.
    pub timeout_seconds: u32,
}

/// One adapter as the profile stores it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterDefinition {
    /// Lowercase letters, digits and `-`, starting with a letter; at most 40
    /// characters. Conversations name it as `adapter:<id>`.
    pub id: String,
    /// Display name, 1 to 80 characters.
    pub name: String,
    pub kind: AdapterKind,
    /// Absolute path of the executable. ADE does not search `PATH`.
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Extra environment on top of the daemon's. Names that look like
    /// credentials are refused: sign in with the agent's own login instead.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Required for `executable`, refused for `acp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<ExecutableSettings>,
}

/// File identity of the executable a probe checked. Device and inode are
/// decimal strings because they can exceed a JSON-safe integer.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ExecutableIdentity {
    pub device: String,
    pub inode: String,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub modified_ms: i64,
}

/// The result of one probe.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProbeOutcome {
    Ready {
        /// ADE capability names, in the vocabulary of provider descriptors.
        capabilities: Vec<String>,
        /// For an ACP adapter, the bundled ACP worker's `initialize` reply,
        /// including what the agent itself negotiated (`native_peer`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker: Option<Box<super::ProviderWorkerInitialize>>,
    },
    Failed {
        /// A bounded, secret-free reason. Agent output is never included.
        error: String,
    },
}

/// The stored probe of one adapter.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct AdapterProbe {
    /// The definition revision that was probed.
    pub revision: u64,
    pub probed_at: i64,
    /// Absent when the executable could not be inspected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<ExecutableIdentity>,
    pub outcome: ProbeOutcome,
}

/// The adapter definition one run launches. A conversation starts on one
/// definition revision; a run carries that definition so the runtime never
/// reads the profile's store, and a later edit never changes a running agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterPin {
    pub revision: u64,
    pub definition: AdapterDefinition,
}

/// Whether an adapter may be trusted to have the probed capabilities now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AdapterReadiness {
    /// Never probed at this revision.
    Unprobed,
    /// The last probe succeeded and nothing has changed since.
    Ready,
    /// The last probe failed.
    Failed,
    /// The definition or the executable changed after the last probe.
    Stale,
}

/// One adapter with its revision and probe.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct AdapterRecord {
    /// `adapter:<id>`, the provider ID conversations use.
    pub provider_id: String,
    pub definition: AdapterDefinition,
    /// Starts at 1 and grows each time the stored definition changes.
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub readiness: AdapterReadiness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<AdapterProbe>,
}

/// `adapter.list`: every adapter this profile defines, by ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterListRequest {}

/// `adapter.put`: create or replace one adapter definition.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterPutRequest {
    pub definition: AdapterDefinition,
    /// When present, the put is refused unless the stored revision equals it;
    /// 0 means the adapter must not exist yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

/// `adapter.remove`: delete one adapter definition and its probe.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterRemoveRequest {
    pub id: String,
}

/// `adapter.probe`: check the executable and record its capabilities.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterProbeRequest {
    pub id: String,
    /// When present, the probe is refused unless the stored revision equals it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

wire_tag!(AdapterListTag, "adapters");
wire_tag!(AdapterPutTag, "adapter_put");
wire_tag!(AdapterRemovedTag, "adapter_removed");
wire_tag!(AdapterProbedTag, "adapter_probed");

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterList {
    #[serde(rename = "type")]
    pub tag: AdapterListTag,
    pub adapters: Vec<AdapterRecord>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterPut {
    #[serde(rename = "type")]
    pub tag: AdapterPutTag,
    /// False when the stored definition was already identical.
    pub changed: bool,
    pub adapter: AdapterRecord,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterRemoved {
    #[serde(rename = "type")]
    pub tag: AdapterRemovedTag,
    pub id: String,
    /// False when no adapter had this ID.
    pub removed: bool,
}

/// A probe that ran. A failed probe is still a completed operation; its
/// outcome says why the adapter is not ready.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AdapterProbed {
    #[serde(rename = "type")]
    pub tag: AdapterProbedTag,
    pub adapter: AdapterRecord,
}
