//! Plugin provider workers (F023): a plugin's `provider` entry point runs as
//! a runtime-supervised Node process speaking the provider worker protocol,
//! JSON-RPC 2.0 over stdio, documented in `docs/provider-worker-protocol.md`.
//!
//! A worker registers through the same [`ProviderEntry`] interface as the
//! bundled providers. Its launch is pinned by a [`ProviderWorker`]: the run
//! that starts it holds that artifact for its whole life, so a newer plugin
//! version never replaces the code under an active session.
//!
//! Every reply is checked before ADE acts on it. A handshake with an unknown
//! protocol version, a history item without a native ID, or a malformed
//! reply fails the launch or the call; nothing is guessed. A worker that
//! crashes ends its run with an exit event; ADE does not restart it and
//! replay the turn, because the worker may already have acted.
use super::registry::{PLUGIN_PREFIX, ProviderEntry, plugin_provider_id};
use super::{Config, Connected, Descriptor, Event, Item, Provider};
use crate::{model::PendingRequest, rpc::Framing, rpc::Rpc};
use ade_core::contract::providers::{
    ProviderWorker, ProviderWorkerAccountContext, ProviderWorkerAccountInspection,
    ProviderWorkerAccountState,
};
use ade_core::model::AccountExecution;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Command;
use std::sync::{Arc, mpsc};
use std::time::Duration;

/// Protocol versions this ADE speaks, oldest first.
pub const PROTOCOL_VERSIONS: &[u32] = &[2];
const INITIALIZE_LIMIT: Duration = Duration::from_secs(15);
const MAX_NAME: usize = 80;
const MAX_MODES: usize = 16;
const MAX_ID: usize = 256;
const MAX_ITEM_TEXT: usize = 1024 * 1024;

/// What a worker declared in `initialize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handshake {
    pub protocol_version: u32,
    pub descriptor: Descriptor,
    pub wire_descriptor: ade_core::contract::providers::ProviderWorkerInitialize,
}

/// Checks the pin's paths before anything is executed: the artifact path is
/// absolute and the entry stays inside it.
pub fn check_launch(worker: &ProviderWorker) -> Result<()> {
    ensure!(
        worker.provider == plugin_provider_id(&worker.pin.plugin_id),
        "Provider worker {} does not belong to plugin {}",
        worker.provider,
        worker.pin.plugin_id
    );
    let artifact = Path::new(&worker.artifact_path);
    ensure!(
        artifact.is_absolute()
            && artifact
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
        "Provider worker artifact path must be absolute without '.' or '..'"
    );
    let entry = Path::new(&worker.entry);
    ensure!(
        !worker.entry.is_empty()
            && !worker.entry.contains('\\')
            && entry
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Provider worker entry must be a relative path inside the artifact"
    );
    Ok(())
}

fn local_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// An item kind: a local name, or a plugin-namespaced kind such as
/// `acme.notes.card` that a timeline contribution declares.
fn item_kind(value: &str) -> bool {
    value.len() <= 128 && value.split('.').all(local_name)
}

/// Validates a worker's `initialize` reply against the provider ID it was
/// started as. Fails closed on any unsupported or malformed declaration.
fn node_runtime_version() -> Result<semver::Version> {
    let runtime = std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into());
    let output = Command::new(runtime)
        .arg("--version")
        .output()
        .context("Could not read the selected Node runtime version")?;
    ensure!(
        output.status.success(),
        "Selected Node runtime version probe failed"
    );
    let text = std::str::from_utf8(&output.stdout)
        .context("Selected Node runtime version was not UTF-8")?
        .trim();
    semver::Version::parse(text.strip_prefix('v').unwrap_or(text))
        .context("Selected Node runtime returned an invalid version")
}

fn node_engine_supports(range: &str, version: &semver::Version) -> Result<bool> {
    ensure!(
        !range.trim().is_empty(),
        "Provider worker omitted its Node engine requirement"
    );
    let mut supported = false;
    for alternative in range.split("||") {
        let requirement = semver::VersionReq::parse(alternative.trim())
            .context("Provider worker declared an invalid Node engine range")?;
        supported |= requirement.matches(version);
    }
    Ok(supported)
}

pub fn check_handshake(provider: &str, reply: &Value) -> Result<Handshake> {
    let descriptor: ade_core::contract::providers::ProviderWorkerInitialize =
        serde_json::from_value(reply.clone())
            .context("Provider worker returned a malformed initialize response")?;
    let version = descriptor.protocol_version;
    ensure!(
        PROTOCOL_VERSIONS.contains(&version),
        "Provider worker speaks unsupported protocol {version}; this ADE supports {PROTOCOL_VERSIONS:?}"
    );
    use ade_core::contract::Tier;
    use ade_core::contract::providers::{
        ProviderWorkerAvailability, ProviderWorkerCapabilityName, ProviderWorkerMethod, Support,
    };

    ensure!(
        descriptor.compatible_protocol_versions.contains(&version)
            && descriptor
                .compatible_protocol_versions
                .iter()
                .any(|v| PROTOCOL_VERSIONS.contains(v)),
        "Provider worker declares no compatible protocol"
    );
    let node_version = node_runtime_version()?;
    ensure!(
        descriptor.requirements.sdk_api_version == 2
            && descriptor.requirements.sdk_version == "0.2.0"
            && descriptor.requirements.effect_version == "4.0.0-rc.118"
            && descriptor.requirements.platform_node_version == "4.0.0-rc.118"
            && node_engine_supports(&descriptor.requirements.node_engine, &node_version)?,
        "Provider worker package requirements are incompatible with Node {node_version}"
    );
    let declared = [
        descriptor.limits.max_input_frame_bytes,
        descriptor.limits.max_input_entries,
        descriptor.limits.max_initialize_ms,
        descriptor.limits.max_output_frame_bytes,
        descriptor.limits.max_history_page_items,
        descriptor.limits.max_output_entries,
        descriptor.limits.max_concurrency,
        descriptor.limits.max_partial_frame_ms,
        descriptor.limits.max_operation_ms,
        descriptor.limits.max_cleanup_ms,
    ];
    let supported = [
        16_777_216, 1_024, 15_000, 4_194_304, 32, 32, 8, 10_000, 45_000, 5_000,
    ];
    ensure!(
        declared.iter().all(|n| *n > 0)
            && descriptor.limits.max_concurrency >= 2
            && declared.iter().zip(supported).all(|(n, max)| *n <= max),
        "Provider worker limits exceed host bounds"
    );
    let mut seen_operations = HashSet::new();
    let expected = [
        (ProviderWorkerMethod::Initialize, Tier::Query),
        (ProviderWorkerMethod::Open, Tier::EffectCommand),
        (ProviderWorkerMethod::Send, Tier::EffectCommand),
        (ProviderWorkerMethod::Steer, Tier::EffectCommand),
        (ProviderWorkerMethod::Cancel, Tier::IdempotentCommand),
        (ProviderWorkerMethod::Answer, Tier::EffectCommand),
        (ProviderWorkerMethod::History, Tier::Query),
    ];
    let optional = [
        (ProviderWorkerMethod::ConfigureMcp, Tier::IdempotentCommand),
        (ProviderWorkerMethod::Compact, Tier::EffectCommand),
        (ProviderWorkerMethod::Rewind, Tier::EffectCommand),
        (ProviderWorkerMethod::ChildTranscript, Tier::Query),
        (ProviderWorkerMethod::AccountInspect, Tier::Query),
    ];
    for operation in &descriptor.operations {
        ensure!(
            seen_operations.insert(operation.method),
            "Provider worker declared duplicate operations"
        );
        ensure!(
            expected
                .iter()
                .chain(optional.iter())
                .any(|(method, tier)| *method == operation.method && *tier == operation.tier),
            "Provider worker declared an unsupported operation tier"
        );
        if operation.method == ProviderWorkerMethod::Initialize {
            ensure!(
                operation.availability == ProviderWorkerAvailability::Available,
                "Provider worker initialize operation must be available"
            );
        }
        ensure!(
            operation.reason.len() <= 512 && !operation.reason.chars().any(char::is_control),
            "Provider worker operation reason is invalid"
        );
    }
    ensure!(
        expected
            .iter()
            .all(|(method, _)| seen_operations.contains(method)),
        "Provider worker omitted a protocol operation"
    );
    if let Some(peer) = &descriptor.native_peer {
        check_native_peer(peer)?;
    }
    let wire_descriptor = descriptor.clone();
    let name = descriptor.name;
    ensure!(
        !name.trim().is_empty()
            && name.chars().count() <= MAX_NAME
            && !name.chars().any(char::is_control),
        "Provider worker name must be 1 to {MAX_NAME} printable characters"
    );
    let mut capabilities = Vec::new();
    let mut seen_capabilities = HashSet::new();
    for capability in descriptor.capabilities {
        ensure!(
            seen_capabilities.insert(capability.name),
            "Provider worker declared a duplicate capability"
        );
        ensure!(
            capability.reason.len() <= 512 && !capability.reason.chars().any(char::is_control),
            "Provider worker capability reason is invalid"
        );
        if capability.support == Support::Supported && capability.available {
            let value = match capability.name {
                ProviderWorkerCapabilityName::Streaming => "streaming",
                ProviderWorkerCapabilityName::Images => "images",
                ProviderWorkerCapabilityName::TextAttachments => "text_attachments",
                ProviderWorkerCapabilityName::Resume => "resume",
                ProviderWorkerCapabilityName::Cancel => "cancel",
                ProviderWorkerCapabilityName::Steering => "steering",
                ProviderWorkerCapabilityName::ToolApproval => "tool_approval",
                ProviderWorkerCapabilityName::Questions => "questions",
                ProviderWorkerCapabilityName::ChildTranscript => "child_transcript",
            };
            capabilities.push(value.to_owned());
        }
    }
    let permission_modes = descriptor.permission_modes;
    ensure!(
        permission_modes
            .first()
            .is_some_and(|mode| mode == "default"),
        "Provider worker permission_modes must start with default"
    );
    ensure!(
        permission_modes.len() <= MAX_MODES
            && permission_modes.iter().all(|mode| local_name(mode))
            && permission_modes.iter().collect::<HashSet<_>>().len() == permission_modes.len(),
        "Provider worker permission_modes must be at most {MAX_MODES} distinct names"
    );
    Ok(Handshake {
        protocol_version: version as u32,
        descriptor: Descriptor {
            id: provider.into(),
            name,
            capabilities,
            permission_modes,
            setting_sources: vec![],
        },
        wire_descriptor,
    })
}

/// A native peer report is bounded, printable evidence; it grants nothing.
fn check_native_peer(peer: &ade_core::contract::providers::ProviderWorkerNativePeer) -> Result<()> {
    let printable = |value: &str, max: usize| {
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
    };
    ensure!(
        local_name(&peer.protocol)
            && peer.name.as_deref().is_none_or(|v| printable(v, 128))
            && peer.version.as_deref().is_none_or(|v| printable(v, 64))
            && peer.features.len() <= 32
            && peer.features.iter().all(|f| local_name(f))
            && peer.features.iter().collect::<HashSet<_>>().len() == peer.features.len()
            && peer.auth_methods.len() <= 16
            && peer.auth_methods.iter().all(|m| printable(m, 128)),
        "Provider worker native peer report is malformed"
    );
    Ok(())
}

/// Checks the normalized history a worker returned from `open`. Every item
/// keeps its native ID as provenance, so an item without one, or a repeated
/// one, is refused rather than renumbered.
pub fn check_history(history: &[Item]) -> Result<()> {
    check_history_with_limits(history, 32, 524_288)
}

fn check_history_with_limits(history: &[Item], max_items: usize, max_bytes: usize) -> Result<()> {
    ensure!(
        history.len() <= max_items,
        "Provider worker history exceeds {max_items} items"
    );
    ensure!(
        ade_core::json_budget::encoded_size(&history)? <= max_bytes,
        ade_core::error::Failure::ResourceLimit
    );
    let mut seen = HashSet::new();
    for item in history {
        ensure!(
            !item.id.is_empty() && item.id.len() <= MAX_ID,
            "Provider worker history item has no native ID"
        );
        ensure!(
            seen.insert(item.id.as_str()),
            "Provider worker history repeats item {}",
            item.id
        );
        ensure!(
            local_name(&item.role) && item_kind(&item.kind) && local_name(&item.status),
            "Provider worker history item {} has a malformed role, kind or status",
            item.id
        );
        ensure!(
            item.text.len() <= MAX_ITEM_TEXT,
            "Provider worker history item {} exceeds {MAX_ITEM_TEXT} bytes",
            item.id
        );
    }
    Ok(())
}

/// A plugin's provider entry point, pinned to one artifact.
pub struct WorkerEntry {
    pub worker: ProviderWorker,
    /// The plugin's display name, until a handshake supplies the worker's own.
    pub name: String,
}

impl ProviderEntry for WorkerEntry {
    /// The static descriptor offers only the default configuration; a
    /// started worker is validated against its own handshake.
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            id: self.worker.provider.clone(),
            name: self.name.clone(),
            capabilities: vec![],
            permission_modes: vec!["default".into()],
            setting_sources: vec![],
        }
    }
    fn launch(
        &self,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<dyn Provider>> {
        Ok(Worker::spawn(&self.worker, cwd, account, events)?)
    }
}

/// The environment variable that carries a managed account's public context
/// ([`ProviderWorkerAccountContext`]) to every worker launched on it.
pub const ACCOUNT_CONTEXT: &str = "ADE_ACCOUNT_CONTEXT";

/// The public context of the managed account `account`, as JSON.
fn account_context(account: &AccountExecution) -> Result<String> {
    Ok(serde_json::to_string(&ProviderWorkerAccountContext {
        account_id: account.id.clone(),
        provider: account.provider.clone(),
        generation: account.generation,
        native_home: account.native_home.clone(),
        identity: account.identity(),
    })?)
}

/// A plugin worker's environment on a managed account: cleared of everything
/// but locale and path variables, with `HOME` at the account's native home, so
/// no ambient login or credential reaches it; the account's context is in
/// [`ACCOUNT_CONTEXT`].
fn managed_worker_environment(command: &mut Command, account: &AccountExecution) -> Result<()> {
    command.env_clear();
    for name in [
        "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("HOME", &account.native_home)
        .env(ACCOUNT_CONTEXT, account_context(account)?);
    Ok(())
}

/// The largest identity a worker's `account_inspect` may report, as JSON.
const MAX_IDENTITY_BYTES: usize = 4096;

/// Checks a worker's `account_inspect` result.
fn check_account_inspection(reply: Value) -> Result<ProviderWorkerAccountInspection> {
    let inspection: ProviderWorkerAccountInspection = serde_json::from_value(reply)
        .context("Provider worker returned a malformed account inspection")?;
    ensure!(
        inspection.reason.len() <= 512 && !inspection.reason.chars().any(char::is_control),
        "Provider worker account inspection reason is invalid"
    );
    ensure!(
        inspection
            .version
            .as_ref()
            .is_none_or(|version| version.len() <= 64 && !version.chars().any(char::is_control)),
        "Provider worker account inspection version is invalid"
    );
    if let Some(identity) = &inspection.identity {
        ensure!(
            !identity.is_empty() && serde_json::to_vec(identity)?.len() <= MAX_IDENTITY_BYTES,
            "Provider worker account identity must be a non-empty object of at most {MAX_IDENTITY_BYTES} bytes"
        );
    }
    ensure!(
        inspection.state != ProviderWorkerAccountState::Ready || inspection.identity.is_some(),
        "Provider worker reported a ready account without an identity"
    );
    Ok(inspection)
}

/// Inspects managed account `account` through the plugin worker's own
/// `account_inspect`, run in the account's launch environment.
pub fn inspect_account(
    worker: &ProviderWorker,
    account: &AccountExecution,
) -> Result<ProviderWorkerAccountInspection> {
    use super::Provider;
    let (events, receiver) = mpsc::sync_channel(32);
    let _drain = std::thread::spawn(move || while receiver.recv().is_ok() {});
    let process = Worker::start(worker, &account.native_home, Some(account), events)?;
    let inspection = process.account_inspection();
    process.stop_confirmed()?;
    inspection
}

/// One running worker process.
pub struct Worker {
    rpc: Arc<Rpc>,
    handshake: Handshake,
    /// Checks a provider repeats before each open and send, such as a managed
    /// account's pinned identity and workspace credential sources.
    preflight: Option<Box<dyn Fn() -> Result<()> + Send + Sync>>,
    /// For a plugin worker on a managed account: the account whose pinned
    /// identity the worker's `account_inspect` must still report before each
    /// open and send.
    pinned_account: Option<AccountExecution>,
}

impl Worker {
    /// Starts a plugin's worker for a run. On a managed account the worker
    /// must report, through its own `account_inspect`, the identity ADE pinned
    /// for the account before each open and send.
    pub fn spawn(
        worker: &ProviderWorker,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        let mut started = Self::start(worker, cwd, account, events)?;
        if let Some(account) = account {
            Arc::get_mut(&mut started)
                .context("A new provider worker is not shared")?
                .pinned_account = Some(account.clone());
        }
        Ok(started)
    }

    fn start(
        worker: &ProviderWorker,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        check_launch(worker)?;
        if let Some(account) = account {
            ensure!(
                account.provider == worker.provider,
                "Agent account belongs to another provider"
            );
        }
        let entry = Path::new(&worker.artifact_path).join(&worker.entry);
        ensure!(
            entry.is_file(),
            "Provider worker entry {} is missing from the pinned artifact",
            worker.entry
        );
        let mut command =
            Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
        if let Some(account) = account {
            managed_worker_environment(&mut command, account)?;
        }
        command
            .arg(&entry)
            .current_dir(cwd)
            .env("ADE_PROVIDER_ID", &worker.provider)
            .env("ADE_PLUGIN_ID", &worker.pin.plugin_id)
            .env("ADE_PLUGIN_VERSION", &worker.pin.version);
        Self::spawn_command(
            command,
            &worker.provider,
            json!({
                "versions": PROTOCOL_VERSIONS, "provider": worker.provider,
                "plugin": {"id": worker.pin.plugin_id, "version": worker.pin.version},
            }),
            events,
            Vec::new(),
        )
    }

    pub fn spawn_codex(
        cwd: &str,
        account: Option<&ade_core::model::AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        // Readiness is checked here, before the worker starts, so an incompatible
        // or changed installation reaches the Conversation as its own reason;
        // behind the worker it would be reduced to a generic provider failure.
        if let Some(account) = account {
            crate::provider::codex_probe::verify_launch(account)?;
        }
        let mut command =
            Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
        command
            .arg(ade_platform::resources::resource(
                "providers/codex/worker.mjs",
            ))
            .current_dir(cwd)
            .env("ADE_PROVIDER_ID", "codex");
        if let Some(account) = account {
            command.env(ACCOUNT_CONTEXT, account_context(account)?);
        }
        Self::spawn_command(
            command,
            "codex",
            json!({"versions": PROTOCOL_VERSIONS, "provider":"codex"}),
            events,
            Vec::new(),
        )
    }

    pub fn spawn_claude(
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        let executable = account
            .map(crate::provider::account_probe::verify_launch)
            .transpose()?;
        let mut command =
            Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
        command
            .arg(ade_platform::resources::resource(
                "providers/claude/worker.mjs",
            ))
            .current_dir(cwd);
        if let (Some(account), Some(executable)) = (account, executable.as_deref()) {
            crate::provider::account_probe::managed_environment(
                &mut command,
                &account.native_home,
                executable,
            );
            command.env(ACCOUNT_CONTEXT, account_context(account)?);
            if let Some(directory) = std::env::var_os("ADE_DATA_DIR") {
                command.env("ADE_DATA_DIR", directory);
            }
            // The named test seam: protocol suites replace the Claude Agent SDK with a
            // deterministic double. It survives the cleared managed environment only when
            // the runtime itself was started with it.
            if let Some(module) = std::env::var_os("ADE_E2E_CLAUDE_SDK") {
                command.env("ADE_E2E_CLAUDE_SDK", module);
            }
        }
        command.env("ADE_PROVIDER_ID", "claude").env(
            "ADE_CLAUDE_WORKER_DESCRIPTOR",
            serde_json::to_string(&crate::claude::worker_descriptor())?,
        );
        Self::spawn_command(
            command,
            "claude",
            json!({"versions":PROTOCOL_VERSIONS,"provider":"claude"}),
            events,
            // The worker passes setting sources to the Agent SDK; the worker protocol has
            // no field to declare them, so the built-in catalogue's sources apply.
            ade_core::provider::descriptor("claude")?
                .setting_sources
                .clone(),
        )
    }
    /// A generic ACP agent (F024) through the bundled ACP worker. The worker
    /// launches the definition's executable with its arguments and extra
    /// environment, negotiates ACP `initialize` with it before answering its
    /// own, and declares only what that negotiation supports.
    pub fn spawn_acp(
        definition: &ade_core::contract::providers::adapters::AdapterDefinition,
        cwd: &str,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        let provider = crate::adapters::provider_id(&definition.id);
        let mut command =
            Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
        command
            .arg(ade_platform::resources::resource(
                "providers/acp/worker.mjs",
            ))
            .current_dir(cwd)
            .env("ADE_PROVIDER_ID", &provider)
            .env(
                "ADE_ACP_AGENT",
                serde_json::to_string(&json!({
                    "name": definition.name,
                    "command": definition.command,
                    "args": definition.args,
                    "env": definition.env,
                }))?,
            );
        Self::spawn_command(
            command,
            &provider,
            json!({"versions": PROTOCOL_VERSIONS, "provider": provider}),
            events,
            Vec::new(),
        )
    }
    /// Oh My Pi through its public worker. Bun runs `providers/omp/worker.mjs`,
    /// because the worker imports OMP's TypeScript RPC frame sources; the
    /// worker owns the native OMP RPC process.
    pub fn spawn_omp(
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        if let Some(account) = account {
            crate::provider::omp_probe::ensure_identity(account)?;
            crate::provider::omp_probe::ensure_workspace_sources(cwd, account)?;
        }
        let mut command =
            Command::new(std::env::var("ADE_BUN_BIN").unwrap_or_else(|_| "bun".into()));
        if account.is_some() {
            command.arg("--no-env-file");
        }
        command
            .arg(ade_platform::resources::resource(
                "providers/omp/worker.mjs",
            ))
            .current_dir(cwd);
        if let Some(account) = account {
            crate::provider::omp_probe::managed_environment(&mut command, &account.native_home, "");
            let identity = account
                .omp_identity
                .as_ref()
                .context("Oh My Pi identity is not pinned")?;
            command.env("ADE_OMP_EXPECTED_PROVIDER", &identity.provider);
            if let Ok(bin) = std::env::var("ADE_OMP_BIN") {
                command.env("ADE_OMP_BIN", bin);
            }
            command.env(ACCOUNT_CONTEXT, account_context(account)?);
            if let Some(directory) = std::env::var_os("ADE_DATA_DIR") {
                command.env("ADE_DATA_DIR", directory);
            }
        }
        command.env("ADE_PROVIDER_ID", "omp").env(
            "ADE_OMP_WORKER_DESCRIPTOR",
            serde_json::to_string(&crate::omp::worker_descriptor())?,
        );
        let mut worker = Self::spawn_command(
            command,
            "omp",
            json!({"versions":PROTOCOL_VERSIONS,"provider":"omp"}),
            events,
            Vec::new(),
        )?;
        if let Some(account) = account.cloned() {
            let cwd = cwd.to_owned();
            Arc::get_mut(&mut worker)
                .context("A new provider worker is not shared")?
                .preflight = Some(Box::new(move || {
                crate::provider::omp_probe::ensure_identity(&account)?;
                crate::provider::omp_probe::ensure_workspace_sources(&cwd, &account)
            }));
        }
        Ok(worker)
    }
    fn spawn_command(
        mut command: Command,
        provider: &str,
        initialize: Value,
        events: mpsc::SyncSender<Event>,
        setting_sources: Vec<String>,
    ) -> Result<Arc<Self>> {
        if provider == "codex" {
            command
                .env(
                    "ADE_CODEX_NATIVE_CLIENT",
                    ade_platform::resources::sibling_binary("ade-runtime")?,
                )
                .env(
                    "ADE_CODEX_WORKER_DESCRIPTOR",
                    serde_json::to_string(&crate::codex::public_descriptor())?,
                );
        }
        let rpc = Rpc::spawn_with_limit(
            command,
            events,
            Framing::JsonRpc2,
            super::bridge_event,
            // The largest output frame any worker may declare; the handshake then
            // holds the worker to its own declared limit.
            4 * 1024 * 1024,
        )?;
        let handshake = rpc
            .request_within("initialize", initialize, Some(INITIALIZE_LIMIT))
            .and_then(|reply| check_handshake(provider, &reply))
            .context("The provider worker did not complete its initialize handshake");
        match handshake {
            Ok(mut handshake) => {
                handshake.descriptor.setting_sources = setting_sources;
                Ok(Arc::new(Self {
                    rpc,
                    handshake,
                    preflight: None,
                    pinned_account: None,
                }))
            }
            Err(error) => match rpc.stop_confirmed() {
                Ok(()) => Err(error),
                Err(stop) => Err(error.context(stop.to_string())),
            },
        }
    }

    pub fn handshake(&self) -> &Handshake {
        &self.handshake
    }

    /// The worker's own report of its managed account's native login.
    fn account_inspection(&self) -> Result<ProviderWorkerAccountInspection> {
        self.ensure_operation("account_inspect")?;
        check_account_inspection(self.rpc.request("account_inspect", json!({}))?)
    }

    /// Refuses unless the worker still reports the identity ADE pinned for its
    /// managed account: a login changed underneath ADE is never used.
    fn check_pinned_account(&self) -> Result<()> {
        let Some(account) = &self.pinned_account else {
            return Ok(());
        };
        let inspection = self.account_inspection()?;
        ensure!(
            inspection.state == ProviderWorkerAccountState::Ready,
            "{} account is not ready: {}",
            account.provider,
            inspection.reason
        );
        ensure!(
            account.worker_identity.is_some() && inspection.identity == account.worker_identity,
            "{} account identity changed since it was verified; inspect and verify the account again",
            account.provider
        );
        Ok(())
    }

    fn ensure_operation(&self, method: &str) -> Result<()> {
        use ade_core::contract::providers::{
            ProviderWorkerAvailability as Availability, ProviderWorkerMethod as Method,
        };
        let expected = match method {
            "open" => Method::Open,
            "send" => Method::Send,
            "steer" => Method::Steer,
            "cancel" => Method::Cancel,
            "answer" => Method::Answer,
            "history" => Method::History,
            "configure_mcp" => Method::ConfigureMcp,
            "compact" => Method::Compact,
            "rewind" => Method::Rewind,
            "child_transcript" => Method::ChildTranscript,
            "account_inspect" => Method::AccountInspect,
            _ => anyhow::bail!("Unknown provider worker operation"),
        };
        let operation = self
            .handshake
            .wire_descriptor
            .operations
            .iter()
            .find(|operation| operation.method == expected)
            .context("Provider worker omitted an operation declaration")?;
        match operation.availability {
            Availability::Available => Ok(()),
            Availability::Unavailable => anyhow::bail!(
                "Provider worker operation {method} is unavailable: {}",
                operation.reason
            ),
            Availability::Unsupported => anyhow::bail!(
                "Provider worker does not support {method}: {}",
                operation.reason
            ),
        }
    }

    fn supports(&self, capability: &str) -> bool {
        self.handshake
            .descriptor
            .capabilities
            .iter()
            .any(|c| c == capability)
    }

    fn turn(&self, method: &str, params: Value) -> Result<String> {
        self.rpc.request(method, params)?["turn"]
            .as_str()
            .filter(|turn| !turn.is_empty() && turn.len() <= MAX_ID)
            .map(str::to_owned)
            .context("Provider worker omitted the turn ID")
    }
}

impl Provider for Worker {
    fn history(
        &self,
        request: &ade_core::contract::providers::ProviderWorkerHistoryRequest,
    ) -> Result<ade_core::contract::providers::ProviderWorkerHistoryPage> {
        self.ensure_operation("history")?;
        Ok(serde_json::from_value(
            self.rpc
                .request("history", serde_json::to_value(request)?)?,
        )?)
    }
    fn child_transcript(
        &self,
        session: &str,
        child: &str,
        offset: u64,
        cursor: Option<&str>,
    ) -> Result<Value> {
        self.ensure_operation("child_transcript")?;
        self.rpc.request(
            "child_transcript",
            json!({"session":session,"child":child,"offset":offset,"cursor":cursor}),
        )
    }
    fn configure_mcp(&self, servers: Value) -> Result<()> {
        self.ensure_operation("configure_mcp")?;
        self.rpc
            .request("configure_mcp", json!({"servers":servers}))?;
        Ok(())
    }
    fn compact(&self, session: &str, operation: &str) -> Result<()> {
        self.ensure_operation("compact")?;
        self.rpc
            .request("compact", json!({"session":session,"operation":operation}))?;
        Ok(())
    }
    fn rewind(
        &self,
        session: &str,
        turn: &str,
        operation: &str,
        native_message: Option<&ade_core::provider::NativeMessageLocator>,
    ) -> Result<Option<String>> {
        self.ensure_operation("rewind")?;
        let mut params = json!({"session":session,"turn":turn,"operation":operation});
        if let Some(locator) = native_message {
            params["native_message"] = serde_json::to_value(locator)?;
        }
        let reply = self.rpc.request("rewind", params)?;
        let reply: ade_core::contract::providers::ProviderWorkerRewindResult =
            serde_json::from_value(reply)?;
        Ok(reply.session)
    }
    fn pid(&self) -> Option<u32> {
        Some(self.rpc.pid())
    }
    fn descendants(&self) -> Option<Vec<crate::descendants::Identity>> {
        Some(self.rpc.descendants())
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        self.ensure_operation("open")?;
        if let Some(preflight) = &self.preflight {
            preflight()?;
        }
        self.check_pinned_account()?;
        config.validate_against(&self.handshake.descriptor)?;
        ensure!(
            resume.is_none() || self.supports("resume"),
            "This provider worker does not declare resume"
        );
        let connected = super::response_session(&self.rpc, resume, config)?;
        ensure!(
            !connected.session.is_empty() && connected.session.len() <= MAX_ID,
            "Provider worker returned a malformed session ID"
        );
        check_history_with_limits(
            &connected.history,
            self.handshake.wire_descriptor.limits.max_history_page_items as usize,
            524_288,
        )?;
        Ok(connected)
    }
    fn send(
        &self,
        _session: &str,
        _submission: &str,
        _message_id: Option<&str>,
        _prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        anyhow::bail!("Provider worker send requires attempt-aware delivery evidence")
    }
    fn send_evidence(
        &self,
        session: &str,
        source_attempt_id: &str,
        submission: &str,
        message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<ade_core::contract::providers::ProviderWorkerSendResult> {
        self.ensure_operation("send")?;
        if let Some(preflight) = &self.preflight {
            preflight()?;
        }
        self.check_pinned_account()?;
        let params = json!({"session":session,"source_attempt_id":source_attempt_id,"submission":submission,"message_id":message_id,"text":prompt.text,"attachments":prompt.attachments});
        within_input_frame(
            &params,
            self.handshake.wire_descriptor.limits.max_input_frame_bytes,
        )?;
        let value = self.rpc.request("send", params)?;
        Ok(serde_json::from_value(value)?)
    }
    fn steer(
        &self,
        session: &str,
        turn: &str,
        message_id: &str,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        self.ensure_operation("steer")?;
        self.turn(
            "steer",
            json!({"session":session,"turn":turn,"message_id":message_id,
                "text":prompt.text,"attachments":prompt.attachments}),
        )
    }
    fn cancel(&self, _session: &str, _turn: &str) -> Result<()> {
        anyhow::bail!("Provider worker cancellation requires attempt and submission identity")
    }
    fn cancel_target(
        &self,
        session: &str,
        source_attempt_id: &str,
        submission_id: &str,
        turn: Option<&str>,
    ) -> Result<ade_core::contract::providers::ProviderCancelEvidence> {
        self.ensure_operation("cancel")?;
        ensure!(
            self.supports("cancel"),
            "This provider worker does not support interruption"
        );
        let response = self.rpc.request("cancel", json!({"session":session,"source_attempt_id":source_attempt_id,"submission_id":submission_id,"turn":turn}))?;
        let response: ade_core::contract::providers::ProviderWorkerCancelResult =
            serde_json::from_value(response)?;
        Ok(response.evidence)
    }
    fn prepare_submission(&self) -> Option<String> {
        Some(uuid::Uuid::new_v4().to_string())
    }
    fn answer_native(
        &self,
        p: &PendingRequest,
        operation_id: &str,
        answer: &ade_core::requests::RequestAnswer,
    ) -> Result<()> {
        self.ensure_operation("answer")?;
        self.validate_native_answer(p, answer)?;
        let request = ade_core::contract::providers::ProviderWorkerAnswerRequest {
            id: p.rpc_id.clone(),
            operation_id: operation_id.into(),
            answer: serde_json::from_value(serde_json::to_value(answer)?)?,
            reason: None,
        };
        self.rpc.request("answer", serde_json::to_value(request)?)?;
        Ok(())
    }
    fn validate_answer(
        &self,
        p: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        if matches!(
            p.method.as_str(),
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
                | "item/tool/requestUserInput"
        ) {
            crate::codex::approval_result(&p.method, &p.params, decision, answers)?;
            return Ok(());
        }
        ensure!(
            ["accept", "decline", "answer"].contains(&decision),
            "Unknown decision"
        );
        ensure!(
            decision != "answer" || answers.is_some_and(Value::is_object),
            "Answers must be an object"
        );
        Ok(())
    }
    fn answer(&self, p: &PendingRequest, decision: &str, answers: Option<&Value>) -> Result<()> {
        self.ensure_operation("answer")?;
        self.validate_answer(p, decision, answers)?;
        self.rpc.request(
            "answer",
            json!({"id":p.rpc_id,"decision":decision,"answers":answers,"reason":null}),
        )?;
        Ok(())
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.ensure_operation("answer")?;
        // A refusal: `reason` tells the worker to refuse the native request
        // rather than answer it; the decline choice keeps the request typed.
        self.rpc.request(
            "answer",
            json!({"id":id,"operation_id":format!("reject:{id}"),
                "answer":{"kind":"choice","value":"decline"},"reason":message}),
        )?;
        Ok(())
    }
    fn stop(&self) {
        self.rpc.stop();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.rpc.stop_confirmed()
    }
}

/// Performs only the bounded handshake, drains any unexpected events, and confirms shutdown.
pub fn inspect(worker: &ProviderWorker) -> Result<serde_json::Value> {
    use super::Provider;
    let (events, receiver) = mpsc::sync_channel(32);
    let process = Worker::start(worker, &worker.artifact_path, None, events)?;
    let handshake = process.handshake().clone();
    let _drain = std::thread::spawn(move || while receiver.recv().is_ok() {});
    let descriptor = handshake.descriptor.clone();
    process.stop_confirmed()?;
    let (state, reason) = native_readiness(&handshake.wire_descriptor);
    Ok(serde_json::json!({
        "type": "provider_inspect",
        "provider": descriptor.id,
        "state": state,
        "reason": reason,
        "version": worker.pin.version,
        "descriptor": handshake.wire_descriptor,
    }))
}

/// What a read-only handshake shows about native work. A worker that declares
/// `open` or `send` unavailable, such as one whose native executable is
/// missing, is unavailable for that reason; otherwise readiness is unchecked.
fn native_readiness(
    descriptor: &ade_core::contract::providers::ProviderWorkerInitialize,
) -> (&'static str, String) {
    use ade_core::contract::providers::{
        ProviderWorkerAvailability as Availability, ProviderWorkerMethod as Method,
    };
    match descriptor.operations.iter().find(|operation| {
        matches!(operation.method, Method::Open | Method::Send)
            && operation.availability == Availability::Unavailable
    }) {
        Some(operation) => ("unavailable", operation.reason.clone()),
        None => (
            "installed_unchecked",
            "Installed worker completed compatible read-only initialization; native provider readiness and authentication were not checked".into(),
        ),
    }
}

/// Whether `provider` names a plugin worker rather than a bundled provider
/// or adapter.
pub fn is_plugin_provider(provider: &str) -> bool {
    provider.starts_with(PLUGIN_PREFIX)
}

/// Refuses, before writing, a request past the worker's declared input frame
/// limit: the worker would end its transport, not just refuse this prompt. The
/// request envelope adds under 256 bytes.
fn within_input_frame(params: &Value, limit: u32) -> Result<()> {
    let size = serde_json::to_vec(params)?.len() + 256;
    ensure!(
        size <= limit as usize,
        "The prompt is {size} bytes with its attachments; this provider worker accepts at most {limit}. Nothing was sent."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::providers::ProviderWorkerPin;

    fn worker() -> ProviderWorker {
        ProviderWorker {
            provider: "plugin:acme.agent".into(),
            pin: ProviderWorkerPin {
                plugin_id: "acme.agent".into(),
                version: "1.0.0".into(),
                artifact_digest: "sha256:aa".into(),
                activation_generation: 1,
            },
            artifact_path: "/profile/plugins/artifacts/acme.agent/1.0.0-aa".into(),
            entry: "dist/provider.js".into(),
        }
    }

    #[test]
    fn a_prompt_past_the_declared_input_frame_is_refused_before_writing() {
        let prompt =
            json!({"text": "look", "attachments": [{"data": "A".repeat(2 * 1024 * 1024)}]});
        let error = within_input_frame(&prompt, 1_048_576)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("accepts at most 1048576. Nothing was sent."),
            "{error}"
        );
        assert!(within_input_frame(&prompt, 16_777_216).is_ok());
    }

    #[test]
    fn launch_paths_stay_inside_the_pinned_artifact() {
        check_launch(&worker()).unwrap();
        let mut w = worker();
        w.entry = "../other/provider.js".into();
        assert!(check_launch(&w).is_err());
        let mut w = worker();
        w.entry = "/bin/sh".into();
        assert!(check_launch(&w).is_err());
        let mut w = worker();
        w.artifact_path = "relative/dir".into();
        assert!(check_launch(&w).is_err());
        let mut w = worker();
        w.provider = "plugin:other.agent".into();
        assert!(check_launch(&w).is_err());
        assert!(is_plugin_provider("plugin:acme.agent"));
        assert!(!is_plugin_provider("claude"));
    }

    fn valid_handshake() -> Value {
        json!({
            "protocol_version": 2, "compatible_protocol_versions": [2], "name": "A",
            "capabilities": [], "permission_modes": ["default"],
            "operations": [
                {"method":"initialize","tier":"query","availability":"available","reason":""},
                {"method":"open","tier":"effect_command","availability":"available","reason":""},
                {"method":"send","tier":"effect_command","availability":"available","reason":""},
                {"method":"steer","tier":"effect_command","availability":"unsupported","reason":""},
                {"method":"cancel","tier":"idempotent_command","availability":"available","reason":""},
                {"method":"answer","tier":"effect_command","availability":"unsupported","reason":""},
                {"method":"history","tier":"query","availability":"unsupported","reason":""}],
            "limits": {"max_input_frame_bytes":1048576,"max_input_entries":1024,"max_output_frame_bytes":1048576,"max_history_page_items":32,"max_output_entries":32,
                "max_initialize_ms":15000,
                "max_concurrency":8,"max_partial_frame_ms":10000,"max_operation_ms":45000,"max_cleanup_ms":5000},
            "requirements":{"sdk_api_version":2,"sdk_version":"0.2.0","effect_version":"4.0.0-rc.118",
                "platform_node_version":"4.0.0-rc.118","node_engine":">=22"}
        })
    }

    #[test]
    fn a_conforming_handshake_becomes_the_launch_descriptor() {
        let mut reply = valid_handshake();
        reply["name"] = json!("Acme Agent");
        reply["permission_modes"] = json!(["default", "read-only"]);
        reply["capabilities"] = json!([
            {"name":"streaming","support":"supported","available":true,"reason":""},
            {"name":"cancel","support":"supported","available":true,"reason":""},
            {"name":"images","support":"supported","available":false,"reason":"Requires image entitlement"}]);
        let handshake = check_handshake("plugin:acme.agent", &reply).unwrap();
        assert_eq!(handshake.descriptor.id, "plugin:acme.agent");
        assert_eq!(handshake.descriptor.capabilities, ["streaming", "cancel"]);
        let config = Config {
            permission_mode: "read-only".into(),
            ..Config::default()
        };
        config.validate_against(&handshake.descriptor).unwrap();
        let plan = Config {
            permission_mode: "plan".into(),
            ..Config::default()
        };
        assert!(plan.validate_against(&handshake.descriptor).is_err());
    }

    #[test]
    fn malformed_and_incompatible_descriptors_fail_closed() {
        let base = valid_handshake();
        check_handshake("plugin:a.b", &base).unwrap();
        let mut too_little_concurrency = base.clone();
        too_little_concurrency["limits"]["max_concurrency"] = json!(1);
        assert!(
            check_handshake("plugin:a.b", &too_little_concurrency).is_err(),
            "one total worker leaves no reserved control capacity"
        );
        let cases = [
            ("unsupported protocol", json!({"protocol_version":1})),
            (
                "v1 worker is rejected",
                json!({"protocol_version":1,"compatible_protocol_versions":[1],"requirements":{"sdk_api_version":1,"sdk_version":"0.1.0","effect_version":"4.0.0-rc.118","platform_node_version":"4.0.0-rc.118","node_engine":">=22"}}),
            ),
            (
                "compatibility mismatch",
                json!({"compatible_protocol_versions":[]}),
            ),
            ("missing descriptor field", json!({"requirements":null})),
            (
                "unknown capability",
                json!({"capabilities":[{"name":"teleport","support":"supported","available":true,"reason":""}]}),
            ),
            (
                "unsupported SDK API",
                json!({"requirements":{"sdk_api_version":9,"sdk_version":"0.2.0","effect_version":"4.0.0-rc.118","platform_node_version":"4.0.0-rc.118","node_engine":">=22"}}),
            ),
            (
                "oversized limit",
                json!({"limits":{"max_input_frame_bytes":16777217,"max_input_entries":1024,"max_initialize_ms":15000,"max_output_frame_bytes":1048576,"max_history_page_items":32,"max_output_entries":32,"max_concurrency":8,"max_partial_frame_ms":10000,"max_operation_ms":45000,"max_cleanup_ms":5000}}),
            ),
            (
                "wrong operation tier",
                json!({"operations":[{"method":"send","tier":"query","availability":"available","reason":""}]}),
            ),
        ];
        for (label, change) in cases {
            let mut reply = base.clone();
            for (key, value) in change.as_object().unwrap() {
                reply[key] = value.clone();
            }
            assert!(
                check_handshake("plugin:a.b", &reply).is_err(),
                "{label} must fail"
            );
        }
        let mut extra = base;
        extra["unrecognized"] = json!(true);
        assert!(check_handshake("plugin:a.b", &extra).is_err());
    }

    fn item(id: &str) -> Item {
        Item {
            content: None,
            id: id.into(),
            native_message: None,
            client_id: None,
            turn: Some("t1".into()),
            role: "assistant".into(),
            kind: "message".into(),
            text: "hi".into(),
            status: "completed".into(),
        }
    }

    #[test]
    fn a_worker_declaring_native_work_unavailable_is_unavailable_for_its_reason() {
        let ready: ade_core::contract::providers::ProviderWorkerInitialize =
            serde_json::from_value(valid_handshake()).unwrap();
        assert_eq!(native_readiness(&ready).0, "installed_unchecked");
        let mut missing = valid_handshake();
        missing["operations"][2] = json!({"method":"send","tier":"effect_command",
            "availability":"unavailable","reason":"OpenCode is not installed"});
        let missing = serde_json::from_value(missing).unwrap();
        assert_eq!(
            native_readiness(&missing),
            ("unavailable", "OpenCode is not installed".to_owned())
        );
    }

    #[test]
    fn history_keeps_native_ids_or_is_refused() {
        check_history(&[item("a"), item("b")]).unwrap();
        assert!(check_history(&[item("a"), item("a")]).is_err());
        assert!(check_history(&[item("")]).is_err());
        let mut odd = item("c");
        odd.role = "assistant\n".into();
        assert!(check_history(&[odd]).is_err());
        // A plugin-namespaced kind is accepted; empty or malformed segments are not.
        let mut custom = item("d");
        custom.kind = "acme.notes.card".into();
        check_history(&[custom.clone()]).unwrap();
        for kind in ["acme..card", ".card", "acme.notes.", "acme/notes"] {
            custom.kind = kind.into();
            assert!(check_history(&[custom.clone()]).is_err(), "{kind}");
        }
    }
}
