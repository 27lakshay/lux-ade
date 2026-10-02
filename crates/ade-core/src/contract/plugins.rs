//! Plugin installation, lifecycle and state contracts (F051, F059).
//!
//! [`PluginManifest`] is the `ade-plugin.json` schema that the future plugin
//! hosts and UI slots read. The registry validates it before any activation.
//! An installed plugin tracks three separate identities: the artifact version
//! (the manifest `version` plus its source pin), the activation generation (a
//! per-plugin counter that rises on every activation) and the data schema.
//!
//! A plugin with a `backend` entry point runs in a headless Node host process
//! (F057). The daemon starts one host per activation generation, lazily, on
//! the first command invocation, restarts it after a crash with bounded
//! backoff, and stops it when the plugin is disabled.
//!
//! A plugin installed from a local directory can enter development mode
//! (F139, F060). The daemon then watches the source directory and, after the
//! writes settle, installs the changed tree as a new artifact and starts a new
//! activation generation. The old generation's backend host drains its open
//! calls with a bounded wait before it is deactivated. A generation that
//! provider sessions still lease keeps its artifact until they end.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The manifest file at the root of every plugin artifact.
pub const MANIFEST_FILE: &str = "ade-plugin.json";
/// The only manifest format this daemon reads.
pub const MANIFEST_VERSION: u32 = 1;
/// The plugin API versions this daemon can activate.
pub const SUPPORTED_API_VERSIONS: &[u32] = &[1];

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<PluginListRequest, PluginList>("plugin.list", Tier::Query),
        OperationSpec::new::<PluginInspectRequest, PluginReply>("plugin.inspect", Tier::Query),
        OperationSpec::new::<PluginInstallRequest, PluginReply>(
            "plugin.install",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<PluginUninstallRequest, PluginUninstalled>(
            "plugin.uninstall",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<PluginEnableRequest, PluginReply>(
            "plugin.enable",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginDisableRequest, PluginReply>(
            "plugin.disable",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginRecordGetRequest, PluginRecordReply>(
            "plugin.record.get",
            Tier::Query,
        ),
        OperationSpec::new::<PluginRecordListRequest, PluginRecordList>(
            "plugin.record.list",
            Tier::Query,
        ),
        OperationSpec::new::<PluginRecordPutRequest, PluginRecordReply>(
            "plugin.record.put",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginRecordDeleteRequest, PluginRecordDeleted>(
            "plugin.record.delete",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginSettingListRequest, PluginSettings>(
            "plugin.setting.list",
            Tier::Query,
        ),
        OperationSpec::new::<PluginSettingSetRequest, PluginSettings>(
            "plugin.setting.set",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginCommandInvokeRequest, PluginCommandResult>(
            "plugin.command.invoke",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<PluginHostStatusRequest, PluginHostReply>(
            "plugin.host.status",
            Tier::Query,
        ),
        OperationSpec::new::<PluginHostRestartRequest, PluginHostReply>(
            "plugin.host.restart",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginDevEnterRequest, PluginGenerations>(
            "plugin.dev.enter",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginDevLeaveRequest, PluginGenerations>(
            "plugin.dev.leave",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<PluginGenerationListRequest, PluginGenerations>(
            "plugin.generation.list",
            Tier::Query,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/// `ade-plugin.json`, format version 1. Unknown fields are rejected so a
/// newer manifest never activates with parts silently ignored.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    /// Always 1.
    pub manifest_version: u32,
    /// `publisher.name`: lowercase letters, digits and single hyphens in each
    /// dot-separated part, at least two parts, at most 64 bytes.
    pub id: String,
    /// Display name, 1 to 128 characters.
    pub name: String,
    /// The artifact version, in strict semantic versioning.
    pub version: String,
    /// The plugin API version the code targets.
    pub api_version: u32,
    /// The version of the plugin's durable data layout, from 1. It is separate
    /// from the artifact version: code rollback never rolls data back.
    pub data_schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// At least one entry point, each a relative path inside the artifact.
    pub entry_points: PluginEntryPoints,
    #[serde(default)]
    pub contributes: PluginContributions,
}

/// Where each host loads the plugin from. Paths are relative to the artifact root.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct PluginEntryPoints {
    /// Loaded into the trusted application renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<String>,
    /// Loaded by a separate restartable backend host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Loaded by a runtime-supervised provider worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Static contributions the registry records for each activation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct PluginContributions {
    #[serde(default)]
    pub commands: Vec<PluginCommandContribution>,
    #[serde(default)]
    pub panels: Vec<PluginPanelContribution>,
    #[serde(default)]
    pub settings: Vec<PluginSettingContribution>,
    /// Static, validated declarative theme definitions contributed by this plugin.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<crate::appearance::definition::ThemeDefinition>,
    /// Lifecycle events delivered to the backend entry point after they commit (F058).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<super::hooks::HookEvent>,
    /// Timeline renderers the UI entry point registers, one per message kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timeline: Vec<PluginTimelineContribution>,
    /// Composer contributions the UI entry point registers, one per context node kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub composer: Vec<PluginComposerContribution>,
}

/// A renderer for timeline messages of one kind. Its ID and `item_kind` start
/// with the plugin ID and a dot. A message of that kind keeps its canonical
/// text, which every client shows when the renderer is missing or fails.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginTimelineContribution {
    pub id: String,
    /// The renderer's payload version, from 1.
    pub version: u32,
    /// The message `kind` this renders.
    pub item_kind: String,
    pub title: String,
    /// Top-level payload fields the renderer needs. A payload without them is
    /// not passed to the renderer; the canonical text shows instead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_fields: Vec<String>,
    /// Actions offered on an item of this kind, shown whether or not the
    /// renderer is available. Each runs a command this plugin declares, through
    /// `plugin.command.invoke` (an effect command with a receipt), with
    /// `{conversation_id, message_id}` as its arguments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<PluginTimelineAction>,
}

/// One action on a timeline item: a readable title and a declared command.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginTimelineAction {
    pub title: String,
    /// A command ID from this plugin's `contributes.commands`.
    pub command: String,
}

/// A composer contribution: context nodes of one kind in a draft, and a
/// side-effect-free transform that prepares the prompt before it is sent. Its
/// ID and `node_kind` start with the plugin ID and a dot. A node of that kind
/// keeps a plain-text fallback in `data.text`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginComposerContribution {
    pub id: String,
    /// The node and transform version, from 1.
    pub version: u32,
    /// The draft context node `kind` this contribution owns.
    pub node_kind: String,
    pub title: String,
}

/// A command. Its ID starts with the plugin ID and a dot.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginCommandContribution {
    pub id: String,
    pub title: String,
}

/// A panel for the UI host. Its ID starts with the plugin ID and a dot.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginPanelContribution {
    pub id: String,
    pub title: String,
}

/// A declared setting. Only declared keys may be set.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginSettingContribution {
    pub key: String,
    pub title: String,
    pub kind: PluginSettingKind,
    /// Must match `kind`. A `credential_ref` setting has no default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<Value>")]
    pub default: Option<Value>,
}

/// A setting's value type. `credential_ref` holds a reference to a credential
/// kept elsewhere (an account ID or keychain item), never the secret itself.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSettingKind {
    String,
    Boolean,
    Number,
    CredentialRef,
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// Where to install from. Every source ends pinned: a local directory by its
/// content digest, a package by its archive digest, Git by its commit.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginSource {
    /// An absolute path to an unpacked plugin directory.
    Local { path: String },
    /// An absolute path to a `.tgz` package archive, as `pnpm pack` writes it.
    Package {
        path: String,
        /// The expected lowercase hex SHA-256 of the archive.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
    },
    /// A Git repository. Give `commit`, `ref` or both; with both, the ref must
    /// resolve to that commit.
    Git {
        url: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
        /// A full 40-character commit ID.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
    },
}

/// `plugin.install`: copy a pinned artifact into the profile and record it.
/// Replacing an installed plugin requires it to be disabled first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginInstallRequest {
    pub operation_id: String,
    pub source: PluginSource,
    /// Refuse the artifact unless its manifest declares exactly this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// `plugin.uninstall`: remove a disabled plugin and its artifacts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginUninstallRequest {
    pub operation_id: String,
    pub plugin_id: String,
    /// Also delete the plugin's records and settings. Without it they stay
    /// and a reinstall of the same ID finds them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub purge_data: bool,
}

/// `plugin.list`: every installed plugin.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginListRequest {}

/// `plugin.inspect`: one plugin with its manifest and live registrations.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginInspectRequest {
    pub plugin_id: String,
}

/// `plugin.enable`: start a new activation. Enabling an enabled plugin
/// returns its current state and starts nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginEnableRequest {
    pub plugin_id: String,
}

/// `plugin.disable`: end the current activation and dispose only its registrations.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginDisableRequest {
    pub plugin_id: String,
}

/// `plugin.record.get`: one namespaced record, or null.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordGetRequest {
    pub plugin_id: String,
    pub namespace: String,
    pub key: String,
}

/// `plugin.record.list`: the records in one namespace, by key.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordListRequest {
    pub plugin_id: String,
    pub namespace: String,
}

/// `plugin.record.put`: write a record of at most 64 KiB of JSON.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordPutRequest {
    pub plugin_id: String,
    pub namespace: String,
    pub key: String,
    #[schemars(with = "Value")]
    pub value: Value,
    /// Write only if the record is at this revision; 0 means it must not exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

/// `plugin.record.delete`: delete a record; deleting a missing record succeeds.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordDeleteRequest {
    pub plugin_id: String,
    pub namespace: String,
    pub key: String,
    /// Delete only if the record is at this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

/// `plugin.setting.list`: every declared setting with its effective value.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginSettingListRequest {
    pub plugin_id: String,
}

/// `plugin.setting.set`: set a declared setting; null restores its default.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginSettingSetRequest {
    pub plugin_id: String,
    pub key: String,
    #[schemars(with = "Value")]
    pub value: Value,
}

/// `plugin.command.invoke`: run a command the plugin's backend registered.
/// The host starts on first use. A command whose outcome cannot be proven,
/// because its host crashed or timed out while running it, settles as
/// `outcome_unknown` and is never run again under the same operation ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginCommandInvokeRequest {
    pub operation_id: String,
    pub plugin_id: String,
    /// A command the manifest declares and the current activation registered.
    pub command_id: String,
    /// JSON arguments passed to the handler, at most 256 KiB.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    #[schemars(with = "Value")]
    pub args: Value,
}

/// `plugin.host.status`: the backend host's supervision state. It never
/// starts a host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginHostStatusRequest {
    pub plugin_id: String,
}

/// `plugin.host.restart`: clear the crash count and start a fresh host for
/// the current activation. Invocations running in the old host settle as
/// `outcome_unknown`. The error code `not_applied` means the request was
/// refused before any host was touched. The code `failed` means a start was
/// attempted and failed, after the old host, if one ran, was already
/// stopped; `plugin.host.status` then shows the backoff or errored host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginHostRestartRequest {
    pub plugin_id: String,
}

/// `plugin.dev.enter`: watch an enabled plugin's local source directory and
/// reload it on change. Each reload that changes the artifact starts a new
/// activation generation; a reload that fails leaves the current one running.
/// Entering again only updates the debounce. Disabling the plugin ends
/// development mode.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginDevEnterRequest {
    pub plugin_id: String,
    /// How long the source must stay unchanged before a reload, 50 to 10000
    /// ms. Defaults to 300 ms. A source that keeps changing reloads at most
    /// 10 s after its first unsettled change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debounce_ms: Option<u32>,
}

/// `plugin.dev.leave`: stop watching. The last reloaded artifact stays
/// installed and active. Leaving a plugin not in development mode succeeds.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginDevLeaveRequest {
    pub plugin_id: String,
}

/// `plugin.generation.list`: the plugin's activation generations, newest
/// first, and its development mode. It records the retirement of generations
/// nothing holds any more; it never starts or stops a host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginGenerationListRequest {
    pub plugin_id: String,
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

wire_tag!(PluginsTag, "plugins");
wire_tag!(PluginTag, "plugin");
wire_tag!(PluginUninstalledTag, "plugin_uninstalled");
wire_tag!(PluginRecordTag, "plugin_record");
wire_tag!(PluginRecordsTag, "plugin_records");
wire_tag!(PluginRecordDeletedTag, "plugin_record_deleted");
wire_tag!(PluginSettingsTag, "plugin_settings");
wire_tag!(PluginCommandResultTag, "plugin_command_result");
wire_tag!(PluginHostTag, "plugin_host");
wire_tag!(PluginGenerationsTag, "plugin_generations");

/// The kind of source a plugin was installed from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSourceKind {
    Local,
    Package,
    Git,
}

/// The resolved, pinned source of an installed artifact.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginSourcePin {
    pub kind: PluginSourceKind,
    /// The local path, package path or Git URL the artifact came from.
    pub locator: String,
    /// The requested Git ref, if any.
    pub git_ref: Option<String>,
    /// `sha256:<hex>` for local and package sources; the commit ID for Git.
    pub pin: String,
}

/// Whether the plugin should be active.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginStatus {
    Enabled,
    Disabled,
}

/// A registration kind in the activation registry.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum PluginRegistrationKind {
    Command,
    Panel,
    Timeline,
    Composer,
}

/// One registration owned by an activation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginRegistration {
    pub kind: PluginRegistrationKind,
    pub id: String,
}

/// The live activation of an enabled plugin.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginActivation {
    pub generation: u64,
    pub activated_at: i64,
    pub registrations: Vec<PluginRegistration>,
}

/// An installed plugin as `plugin.list` shows it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    /// The artifact version from the manifest.
    pub version: String,
    pub status: PluginStatus,
    pub source: PluginSourcePin,
    /// The highest activation generation issued so far; 0 before the first.
    pub activation_generation: u64,
    /// The data schema the installed code declares.
    pub data_schema: u32,
    /// The highest data schema any installed code has declared. Records may
    /// carry any schema up to this one.
    pub stored_data_schema: u32,
    /// The live activation; null while disabled or when activation failed.
    pub activation: Option<PluginActivation>,
    /// Why an enabled plugin has no activation after a daemon restart.
    pub activation_error: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

/// The `plugin.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginList {
    #[serde(rename = "type")]
    pub tag: PluginsTag,
    pub plugins: Vec<PluginSummary>,
}

/// An installed plugin with its manifest and artifact.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginDetail {
    #[serde(flatten)]
    pub summary: PluginSummary,
    /// `sha256:<hex>` over the installed artifact's files.
    pub artifact_digest: String,
    pub artifact_path: String,
    pub manifest: PluginManifest,
}

/// The `plugin.inspect`, `plugin.install`, `plugin.enable` and `plugin.disable` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginReply {
    #[serde(rename = "type")]
    pub tag: PluginTag,
    pub plugin: PluginDetail,
}

/// The `plugin.uninstall` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginUninstalled {
    #[serde(rename = "type")]
    pub tag: PluginUninstalledTag,
    pub plugin_id: String,
    pub data_purged: bool,
}

/// One namespaced durable record.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginDataRecord {
    pub namespace: String,
    pub key: String,
    #[schemars(with = "Value")]
    pub value: Value,
    /// Starts at 1 and rises by one on every write.
    pub revision: u64,
    /// The plugin data schema in force when the record was written.
    pub data_schema: u32,
    pub updated_at: i64,
}

/// The `plugin.record.get` and `plugin.record.put` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordReply {
    #[serde(rename = "type")]
    pub tag: PluginRecordTag,
    pub plugin_id: String,
    pub record: Option<PluginDataRecord>,
}

/// The `plugin.record.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordList {
    #[serde(rename = "type")]
    pub tag: PluginRecordsTag,
    pub plugin_id: String,
    pub namespace: String,
    pub records: Vec<PluginDataRecord>,
}

/// The `plugin.record.delete` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginRecordDeleted {
    #[serde(rename = "type")]
    pub tag: PluginRecordDeletedTag,
    pub plugin_id: String,
    pub namespace: String,
    pub key: String,
    /// False when there was no record to delete.
    pub deleted: bool,
}

/// One declared setting and its effective value.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginSettingValue {
    pub key: String,
    pub kind: PluginSettingKind,
    /// The stored value, or the default when none is stored; null if neither.
    #[schemars(with = "Value")]
    pub value: Value,
    /// Whether `value` is the declared default.
    pub is_default: bool,
}

/// The `plugin.setting.list` and `plugin.setting.set` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginSettings {
    #[serde(rename = "type")]
    pub tag: PluginSettingsTag,
    pub plugin_id: String,
    pub settings: Vec<PluginSettingValue>,
}

/// What a command handler did.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PluginCommandOutcome {
    /// The handler returned; `value` is its JSON result, null for none.
    Completed {
        #[schemars(with = "Value")]
        value: Value,
    },
    /// The handler ran and threw. Any effects it had before throwing stand.
    Failed { message: String },
}

/// The `plugin.command.invoke` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginCommandResult {
    #[serde(rename = "type")]
    pub tag: PluginCommandResultTag,
    pub plugin_id: String,
    pub command_id: String,
    /// The activation generation whose host ran the command.
    pub generation: u64,
    /// The host start attempt within that generation.
    pub attempt: u64,
    pub outcome: PluginCommandOutcome,
}

/// The backend host's state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginHostState {
    /// The plugin declares no backend entry point.
    NoBackend,
    /// The plugin has no live activation.
    Inactive,
    /// Activated; the host starts on the first invocation.
    Idle,
    Running,
    /// Crashed; an automatic restart is scheduled at `retry_at`.
    Backoff,
    /// Crashed more often than the restart schedule allows; run `plugin.host.restart`.
    Errored,
    /// Stopped by the daemon; the next invocation starts it again.
    Stopped,
}

/// One plugin's backend host as the supervisor sees it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginHostStatus {
    pub plugin_id: String,
    pub state: PluginHostState,
    /// The activation generation the host serves.
    pub generation: Option<u64>,
    /// The last host start attempt within the generation; 0 before the first.
    pub attempt: u64,
    pub pid: Option<u32>,
    pub started_at: Option<i64>,
    /// Consecutive crashes counted toward the restart schedule.
    pub crashes: u32,
    /// When the next automatic restart is due, in backoff.
    pub retry_at: Option<i64>,
    pub last_error: Option<String>,
    /// Whether a running host answered a health probe; null when none ran.
    pub responsive: Option<bool>,
    /// Commands the running host reports as registered.
    pub registered: Vec<String>,
    /// The last lines the host wrote to stderr, oldest first.
    pub log_tail: Vec<String>,
}

/// The `plugin.host.status` and `plugin.host.restart` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginHostReply {
    #[serde(rename = "type")]
    pub tag: PluginHostTag,
    pub host: PluginHostStatus,
}

/// What started an activation generation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginGenerationOrigin {
    /// `plugin.enable`.
    Enable,
    /// The daemon reactivated an enabled plugin when it started.
    Restore,
    /// A development-mode reload.
    DevReload,
}

/// Where an activation generation is in its life.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginGenerationState {
    /// The live activation. New work goes here.
    Current,
    /// Superseded; its backend host is finishing open calls before it is
    /// deactivated and stopped.
    Draining,
    /// Superseded; provider sessions still lease it, so its artifact stays.
    Leased,
    /// Nothing holds it. Its artifact may have been removed.
    Retired,
}

/// One activation generation of one plugin.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginGeneration {
    pub generation: u64,
    /// The artifact version the generation ran.
    pub version: String,
    pub artifact_digest: String,
    pub origin: PluginGenerationOrigin,
    pub state: PluginGenerationState,
    pub activated_at: i64,
    /// When a newer generation replaced it or the plugin was disabled.
    pub superseded_at: Option<i64>,
    pub retired_at: Option<i64>,
    /// Provider sessions that lease this generation.
    pub provider_leases: u32,
}

/// The result of one development-mode reload attempt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginReloadStatus {
    /// A new generation is current.
    Activated,
    /// The copied tree matched the installed artifact; nothing changed.
    Unchanged,
    /// The reload would break a rule (another plugin's registration, a data
    /// schema change while provider sessions lease the plugin, a different
    /// plugin ID); the current generation keeps running.
    Refused,
    /// Copying or validating the source failed; the current generation keeps
    /// running.
    Failed,
}

/// The last development-mode reload attempt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginReload {
    pub at: i64,
    pub status: PluginReloadStatus,
    /// The generation it activated.
    pub generation: Option<u64>,
    /// Why it was refused or failed, or why the new backend host did not start.
    pub message: Option<String>,
}

/// A plugin's development mode.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PluginDevMode {
    /// The watched source directory: the plugin's local source locator.
    pub source_path: String,
    pub debounce_ms: u32,
    pub entered_at: i64,
    /// Whether this daemon is watching the source now.
    pub watching: bool,
    /// When the watcher last saw the source change.
    pub last_change_at: Option<i64>,
    /// When the pending change will reload, if one is pending.
    pub reload_due_at: Option<i64>,
    pub last_reload: Option<PluginReload>,
    /// Why the last scan of the source directory failed, until one succeeds.
    pub watch_error: Option<String>,
}

/// The `plugin.dev.enter`, `plugin.dev.leave` and `plugin.generation.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PluginGenerations {
    #[serde(rename = "type")]
    pub tag: PluginGenerationsTag,
    pub plugin_id: String,
    /// Null when the plugin is not in development mode.
    pub dev: Option<PluginDevMode>,
    /// Newest first. Only the last 20 retired generations are kept.
    pub generations: Vec<PluginGeneration>,
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

    fn manifest() -> Value {
        json!({"manifest_version": 1, "id": "acme.notes", "name": "Notes", "version": "1.2.0",
            "api_version": 1, "data_schema": 2, "entry_points": {"ui": "dist/ui.js"},
            "contributes": {"commands": [{"id": "acme.notes.open", "title": "Open notes"}],
                "panels": [], "settings": [{"key": "token", "title": "Token", "kind": "credential_ref"},
                    {"key": "wrap", "title": "Wrap", "kind": "boolean", "default": true}]}})
    }

    fn detail() -> Value {
        json!({"id": "acme.notes", "name": "Notes", "version": "1.2.0", "status": "enabled",
            "source": {"kind": "git", "locator": "https://example.com/notes.git", "git_ref": "main",
                "pin": "0123456789abcdef0123456789abcdef01234567"},
            "activation_generation": 3, "data_schema": 2, "stored_data_schema": 2,
            "activation": {"generation": 3, "activated_at": 5,
                "registrations": [{"kind": "command", "id": "acme.notes.open"}]},
            "activation_error": null, "installed_at": 1, "updated_at": 5,
            "artifact_digest": "sha256:ab", "artifact_path": "/p/a", "manifest": manifest()})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<PluginListRequest>("plugin.list", json!({"op": "plugin.list"}));
        request::<PluginInstallRequest>(
            "plugin.install",
            json!({"op": "plugin.install", "operation_id": "o",
                "source": {"kind": "local", "path": "/p"}, "expected_version": "1.0.0"}),
        );
        request::<PluginInstallRequest>(
            "plugin.install",
            json!({"op": "plugin.install", "operation_id": "o",
                "source": {"kind": "package", "path": "/p.tgz", "sha256": "ab"}}),
        );
        request::<PluginInstallRequest>(
            "plugin.install",
            json!({"op": "plugin.install", "operation_id": "o",
                "source": {"kind": "git", "url": "https://x/y.git", "ref": "v1"}}),
        );
        request::<PluginUninstallRequest>(
            "plugin.uninstall",
            json!({"op": "plugin.uninstall", "operation_id": "o", "plugin_id": "a.b", "purge_data": true}),
        );
        request::<PluginEnableRequest>(
            "plugin.enable",
            json!({"op": "plugin.enable", "plugin_id": "a.b"}),
        );
        request::<PluginRecordPutRequest>(
            "plugin.record.put",
            json!({"op": "plugin.record.put", "plugin_id": "a.b", "namespace": "n", "key": "k",
                "value": {"x": [1]}, "expected_revision": 0}),
        );
        request::<PluginSettingSetRequest>(
            "plugin.setting.set",
            json!({"op": "plugin.setting.set", "plugin_id": "a.b", "key": "k", "value": null}),
        );
        request::<PluginCommandInvokeRequest>(
            "plugin.command.invoke",
            json!({"op": "plugin.command.invoke", "operation_id": "o", "plugin_id": "a.b",
                "command_id": "a.b.run", "args": {"n": 1}}),
        );
        request::<PluginCommandInvokeRequest>(
            "plugin.command.invoke",
            json!({"op": "plugin.command.invoke", "operation_id": "o", "plugin_id": "a.b",
                "command_id": "a.b.run"}),
        );
        request::<PluginHostRestartRequest>(
            "plugin.host.restart",
            json!({"op": "plugin.host.restart", "plugin_id": "a.b"}),
        );
        request::<PluginDevEnterRequest>(
            "plugin.dev.enter",
            json!({"op": "plugin.dev.enter", "plugin_id": "a.b", "debounce_ms": 500}),
        );
        request::<PluginDevEnterRequest>(
            "plugin.dev.enter",
            json!({"op": "plugin.dev.enter", "plugin_id": "a.b"}),
        );
        request::<PluginDevLeaveRequest>(
            "plugin.dev.leave",
            json!({"op": "plugin.dev.leave", "plugin_id": "a.b"}),
        );
        request::<PluginGenerationListRequest>(
            "plugin.generation.list",
            json!({"op": "plugin.generation.list", "plugin_id": "a.b"}),
        );
        let (name, _) = names("plugin.command.invoke");
        assert!(!valid(
            &name,
            &json!({"op": "plugin.command.invoke", "plugin_id": "a.b", "command_id": "a.b.run"})
        ));
        let (name, _) = names("plugin.install");
        assert!(!valid(
            &name,
            &json!({"op": "plugin.install", "operation_id": "o", "source": {"kind": "ftp", "path": "/p"}})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "plugin.install", "source": {"kind": "local", "path": "/p"}})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<PluginReply>(
            "plugin.inspect",
            json!({"type": "plugin", "plugin": detail()}),
        );
        let mut summary = detail();
        for key in ["artifact_digest", "artifact_path", "manifest"] {
            summary.as_object_mut().unwrap().remove(key);
        }
        response::<PluginList>(
            "plugin.list",
            json!({"type": "plugins", "plugins": [summary]}),
        );
        response::<PluginUninstalled>(
            "plugin.uninstall",
            json!({"type": "plugin_uninstalled", "plugin_id": "a.b", "data_purged": false}),
        );
        response::<PluginRecordReply>(
            "plugin.record.get",
            json!({"type": "plugin_record", "plugin_id": "a.b", "record": null}),
        );
        response::<PluginRecordList>(
            "plugin.record.list",
            json!({"type": "plugin_records", "plugin_id": "a.b", "namespace": "n", "records": [
                {"namespace": "n", "key": "k", "value": 1, "revision": 2, "data_schema": 1, "updated_at": 3}]}),
        );
        response::<PluginCommandResult>(
            "plugin.command.invoke",
            json!({"type": "plugin_command_result", "plugin_id": "a.b", "command_id": "a.b.run",
                "generation": 2, "attempt": 1, "outcome": {"status": "completed", "value": {"n": 2}}}),
        );
        response::<PluginCommandResult>(
            "plugin.command.invoke",
            json!({"type": "plugin_command_result", "plugin_id": "a.b", "command_id": "a.b.run",
                "generation": 2, "attempt": 1, "outcome": {"status": "failed", "message": "boom"}}),
        );
        response::<PluginHostReply>(
            "plugin.host.status",
            json!({"type": "plugin_host", "host": {"plugin_id": "a.b", "state": "backoff",
                "generation": 2, "attempt": 1, "pid": null, "started_at": 4, "crashes": 1,
                "retry_at": 9, "last_error": "exited with status 70", "responsive": null,
                "registered": [], "log_tail": ["boom"]}}),
        );
        response::<PluginGenerations>(
            "plugin.generation.list",
            json!({"type": "plugin_generations", "plugin_id": "a.b",
                "dev": {"source_path": "/src/a", "debounce_ms": 300, "entered_at": 1,
                    "watching": true, "last_change_at": 7, "reload_due_at": null,
                    "last_reload": {"at": 8, "status": "activated", "generation": 3, "message": null},
                    "watch_error": null},
                "generations": [
                    {"generation": 3, "version": "1.0.0", "artifact_digest": "sha256:b",
                        "origin": "dev_reload", "state": "current", "activated_at": 8,
                        "superseded_at": null, "retired_at": null, "provider_leases": 0},
                    {"generation": 2, "version": "1.0.0", "artifact_digest": "sha256:a",
                        "origin": "enable", "state": "leased", "activated_at": 2,
                        "superseded_at": 8, "retired_at": null, "provider_leases": 1}]}),
        );
        response::<PluginGenerations>(
            "plugin.dev.leave",
            json!({"type": "plugin_generations", "plugin_id": "a.b", "dev": null, "generations": []}),
        );
        response::<PluginSettings>(
            "plugin.setting.list",
            json!({"type": "plugin_settings", "plugin_id": "a.b", "settings": [
                {"key": "wrap", "kind": "boolean", "value": true, "is_default": true}]}),
        );
    }

    #[test]
    fn manifest_rejects_unknown_fields() {
        let parsed: PluginManifest = serde_json::from_value(manifest()).unwrap();
        assert_eq!(parsed.contributes.settings.len(), 2);
        let mut extra = manifest();
        extra["permissions"] = json!(["all"]);
        assert!(serde_json::from_value::<PluginManifest>(extra).is_err());
    }
}
