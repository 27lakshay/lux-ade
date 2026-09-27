//! The plugin registry (F051) and plugin state (F059).
//!
//! The profile's `sessions.plugins.sqlite3` records each installed plugin: its
//! pinned source, artifact digest, manifest, enabled flag and activation
//! generation. Artifacts live under `sessions.plugins/artifacts/<id>/`. Records
//! and settings are scoped by plugin ID, and records also by namespace.
//!
//! `plugin.install` and `plugin.uninstall` are effect commands. Each has one
//! commit point: the transaction that writes the plugin row also settles its
//! receipt. A receipt still open when the registry opens therefore proves the
//! operation was not applied, and is settled as `not_applied`.
//!
//! Enabling a plugin creates an activation in the registry and records its
//! manifest's static contributions under it. A plugin with a `backend` entry
//! point also gets a headless Node host (F057, `host.rs`), started lazily on
//! the first `plugin.command.invoke` and stopped on disable. A host crash
//! never takes the registry down: invocations fail explicitly while the
//! supervisor restarts the host with bounded backoff.
//!
//! `plugin.command.invoke` is an effect command whose effect happens outside
//! this database, so it has two durable steps: the receipt moves to
//! `dispatched` before the request is written to the host, and settles when
//! the host answers. A receipt found `accepted` after a restart was never
//! sent (`not_applied`); one found `dispatched` may have run, so it becomes
//! `unknown` and is never run again under that ID.
//!
//! Development mode, activation generations and provider leases live in
//! `reload.rs` (F139, F060, 04-S11); their pure decisions are in `dev.rs`.
mod activation;
mod artifact;
mod dev;
mod host;
mod manifest;
mod reload;
mod supervision;

use crate::receipts::{self, Admission, Status};
use activation::{Activation, Registry};
use ade_core::contract::hooks::HookSubscription;
use ade_core::contract::plugins::{
    PluginActivation, PluginCommandInvokeRequest, PluginCommandOutcome, PluginCommandResult,
    PluginDataRecord, PluginDetail, PluginDisableRequest, PluginEnableRequest,
    PluginGenerationOrigin, PluginHostReply, PluginHostRestartRequest, PluginHostStatusRequest,
    PluginInspectRequest, PluginInstallRequest, PluginList, PluginListRequest, PluginManifest,
    PluginRecordDeleteRequest, PluginRecordDeleted, PluginRecordGetRequest, PluginRecordList,
    PluginRecordListRequest, PluginRecordPutRequest, PluginRecordReply, PluginRegistrationKind,
    PluginReply, PluginSettingListRequest, PluginSettingSetRequest, PluginSettingValue,
    PluginSettings, PluginSourceKind, PluginSourcePin, PluginStatus, PluginSummary,
    PluginUninstallRequest, PluginUninstalled,
};
use ade_core::contract::providers::{ProviderWorker, ProviderWorkerPin};
use ade_core::model::now_ms;
use anyhow::{Context, Result, anyhow, ensure};
use manifest::SchemaAdmission;
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS plugins(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
  source_kind TEXT NOT NULL, source_locator TEXT NOT NULL, source_ref TEXT, source_pin TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, artifact_path TEXT NOT NULL, manifest TEXT NOT NULL,
  enabled INTEGER NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_state(
  plugin_id TEXT PRIMARY KEY, activation_generation INTEGER NOT NULL, stored_data_schema INTEGER);
CREATE TABLE IF NOT EXISTS plugin_records(
  plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  revision INTEGER NOT NULL, data_schema INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, namespace, key));
CREATE TABLE IF NOT EXISTS plugin_settings(
  plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, key));
";

const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_RECORD_KEY: usize = 256;
const MAX_LISTED_RECORDS: usize = 1000;
const EFFECT_OPS: [&str; 2] = ["plugin.install", "plugin.uninstall"];
/// The effect command whose effect runs in a plugin host.
const INVOKE_OP: &str = "plugin.command.invoke";
const MAX_INVOKE_ARGS_BYTES: usize = 256 * 1024;

/// An error with a wire code the client SDK knows.
#[derive(Debug)]
struct Coded {
    code: &'static str,
    message: String,
}

impl std::fmt::Display for Coded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Coded {}

fn coded(code: &'static str, message: impl Into<String>) -> Coded {
    Coded {
        code,
        message: message.into(),
    }
}

fn envelope(error: anyhow::Error) -> Value {
    match error.downcast_ref::<Coded>() {
        Some(coded) => json!({"type": "error", "code": coded.code, "message": coded.message}),
        None => ade_core::error::error_envelope(error),
    }
}

fn decode<T: DeserializeOwned>(request: &Value) -> Result<T> {
    let mut body = request.clone();
    if let Some(map) = body.as_object_mut() {
        map.remove("op");
        map.remove("diagnostic_id");
    }
    T::deserialize(&body).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => coded("invalid_request", format!("Missing {field}")),
            None => coded("invalid_request", format!("Invalid request: {text}")),
        }
        .into()
    })
}

fn reply<T: serde::Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

/// Live activation facts that do not survive a restart.
#[derive(Clone)]
struct Live {
    activation: Activation,
    activated_at: i64,
}

struct State {
    db: Connection,
    registry: Registry,
    live: HashMap<String, Live>,
    /// Why an enabled plugin could not be activated when the registry opened.
    errors: HashMap<String, String>,
    /// Effect operation IDs admitted and still running in this process.
    inflight: HashSet<String>,
}

/// The plugin registry. Development-mode watchers share its core.
pub struct Plugins(Arc<Core>);

impl Plugins {
    /// Opens the registry, activates every enabled plugin, retires
    /// generations nothing holds and resumes development-mode watchers.
    pub fn open(database: &Path, directory: &Path) -> Result<Self> {
        let core = Arc::new(Core::open(database, directory)?);
        core.resume()?;
        Ok(Self(core))
    }

    /// The lifecycle hooks each live activation's manifest subscribes to,
    /// ordered by plugin ID. A disabled plugin or a failed activation has none.
    pub fn hook_subscriptions(&self) -> Result<Vec<HookSubscription>> {
        self.0.hook_subscriptions()
    }

    /// The provider worker each live activation publishes (F023).
    pub fn provider_workers(&self) -> Result<Vec<(String, ProviderWorker)>> {
        self.0.provider_workers()
    }

    /// Handles one `plugin.*` operation. Plugin errors carry a wire code.
    pub fn command(&self, request: &Value) -> Result<Value> {
        self.0.command(request)
    }

    /// Whether a development-mode reload changed an activation since the
    /// last call. Hook subscriptions follow activations.
    pub fn take_activation_change(&self) -> bool {
        self.0.activation_changed.swap(false, Ordering::SeqCst)
    }
}

struct Core {
    state: Mutex<State>,
    /// Backend hosts. No host call runs while `state` is locked.
    hosts: Arc<host::Hosts>,
    artifacts: PathBuf,
    staging: PathBuf,
    /// Development-mode watchers by plugin ID. Lock order: `state`, then this.
    watches: Mutex<HashMap<String, Arc<reload::Watch>>>,
    /// Serializes reloads, so two watchers never stage the same plugin at once.
    reloads: Mutex<()>,
    /// Set when a reload changes an activation outside a `plugin.*` command.
    activation_changed: AtomicBool,
}

/// One row of `plugins`.
struct Installed {
    detail: PluginDetail,
    enabled: bool,
}

impl Core {
    /// Opens the registry database, settles interrupted effects, removes
    /// staging leftovers and artifacts of uninstalled plugins, then activates
    /// every enabled plugin with a fresh generation.
    fn open(database: &Path, directory: &Path) -> Result<Self> {
        let db = Connection::open(database)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.execute_batch(SCHEMA)?;
        db.execute_batch(reload::SCHEMA)?;
        receipts::ensure(&db)?;
        settle_interrupted(&db)?;
        let artifacts = directory.join("artifacts");
        let staging = directory.join("staging");
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&artifacts)?;
        let plugins = Self {
            state: Mutex::new(State {
                db,
                registry: Registry::default(),
                live: HashMap::new(),
                errors: HashMap::new(),
                inflight: HashSet::new(),
            }),
            hosts: host::Hosts::new(),
            artifacts,
            staging,
            watches: Mutex::new(HashMap::new()),
            reloads: Mutex::new(()),
            activation_changed: AtomicBool::new(false),
        };
        plugins.collect_garbage()?;
        plugins.restore()?;
        Ok(plugins)
    }

    fn collect_garbage(&self) -> Result<()> {
        let state = self.state.lock().unwrap();
        let installed: HashSet<String> = state
            .db
            .prepare("SELECT id FROM plugins")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for entry in fs::read_dir(&self.artifacts)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !installed.contains(&name) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    fn restore(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let enabled: Vec<String> = state
            .db
            .prepare("SELECT id FROM plugins WHERE enabled=1 ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in enabled {
            if let Err(error) = activate(&mut state, &id, PluginGenerationOrigin::Restore) {
                tracing::warn!(target: "ade", event = "plugin_activation_failed");
                state.errors.insert(id, error.to_string());
            }
        }
        Ok(())
    }

    fn hook_subscriptions(&self) -> Result<Vec<HookSubscription>> {
        let state = self.state.lock().unwrap();
        let mut ids: Vec<&String> = state.live.keys().collect();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let generation = state.live[id].activation.generation;
            for event in installed(&state, id)?.detail.manifest.contributes.hooks {
                out.push(HookSubscription {
                    plugin_id: id.clone(),
                    event,
                    activation_generation: generation,
                });
            }
        }
        Ok(out)
    }

    /// The provider worker each live activation with a `provider` entry point
    /// publishes, with the plugin's name, ordered by plugin ID (F023). The pin
    /// is the verified artifact the activation runs; a session started on it
    /// leases that artifact, not whatever is installed later.
    pub fn provider_workers(&self) -> Result<Vec<(String, ProviderWorker)>> {
        let state = self.state.lock().unwrap();
        let mut ids: Vec<&String> = state.live.keys().collect();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let plugin = installed(&state, id)?.detail;
            let Some(entry) = plugin.manifest.entry_points.provider.clone() else {
                continue;
            };
            out.push((
                plugin.summary.name.clone(),
                ProviderWorker {
                    provider: ade_runtime::provider::registry::plugin_provider_id(id),
                    pin: ProviderWorkerPin {
                        plugin_id: id.clone(),
                        version: plugin.summary.version.clone(),
                        artifact_digest: plugin.artifact_digest.clone(),
                        activation_generation: state.live[id].activation.generation,
                    },
                    artifact_path: plugin.artifact_path.clone(),
                    entry,
                },
            ));
        }
        Ok(out)
    }

    /// Handles one `plugin.*` operation. Plugin errors carry a wire code.
    fn command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let op = request["op"].as_str().unwrap_or("");
        let result = (|| match op {
            "plugin.list" => self.list(decode(request)?),
            "plugin.inspect" => self.inspect(decode(request)?),
            "plugin.install" => self.install(decode(request)?),
            "plugin.uninstall" => self.uninstall(decode(request)?),
            "plugin.enable" => self.enable(decode(request)?),
            "plugin.disable" => self.disable(decode(request)?),
            "plugin.record.get" => self.record_get(decode(request)?),
            "plugin.record.list" => self.record_list(decode(request)?),
            "plugin.record.put" => self.record_put(decode(request)?),
            "plugin.record.delete" => self.record_delete(decode(request)?),
            "plugin.setting.list" => self.setting_list(decode(request)?),
            "plugin.setting.set" => self.setting_set(decode(request)?),
            "plugin.command.invoke" => self.invoke(decode(request)?),
            "plugin.host.status" => self.host_status(decode(request)?),
            "plugin.host.restart" => self.host_restart(decode(request)?),
            "plugin.dev.enter" => self.dev_enter(decode(request)?),
            "plugin.dev.leave" => self.dev_leave(decode(request)?),
            "plugin.generation.list" => self.generation_list(decode(request)?),
            _ => Err(anyhow!("Unknown plugin operation")),
        })();
        Ok(result.unwrap_or_else(envelope))
    }

    fn list(&self, _: PluginListRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        let ids: Vec<String> = state
            .db
            .prepare("SELECT id FROM plugins ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let plugins = ids
            .iter()
            .map(|id| Ok(installed(&state, id)?.detail.summary))
            .collect::<Result<_>>()?;
        reply(&PluginList {
            tag: Default::default(),
            plugins,
        })
    }

    fn inspect(&self, request: PluginInspectRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        detail_reply(&state, &request.plugin_id)
    }

    fn enable(&self, request: PluginEnableRequest) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        let id = &request.plugin_id;
        installed(&state, id)?;
        if !state.live.contains_key(id) {
            state.errors.remove(id);
            activate(&mut state, id, PluginGenerationOrigin::Enable)?;
            // The generation is already durable; flip the flag after the
            // activation exists, and undo the activation if that write fails.
            if let Err(error) = state.db.execute(
                "UPDATE plugins SET enabled=1,updated_at=?2 WHERE id=?1",
                params![id, now_ms()],
            ) {
                if let Some(live) = state.live.remove(id) {
                    state.registry.deactivate(&live.activation);
                }
                return Err(error.into());
            }
        }
        detail_reply(&state, id)
    }

    fn disable(&self, request: PluginDisableRequest) -> Result<Value> {
        let id = &request.plugin_id;
        let through = {
            let mut state = self.state.lock().unwrap();
            let current = installed(&state, id)?;
            if current.enabled {
                state.db.execute(
                    "UPDATE plugins SET enabled=0,updated_at=?2 WHERE id=?1",
                    params![id, now_ms()],
                )?;
            }
            state.errors.remove(id);
            if let Some(live) = state.live.remove(id) {
                state.registry.deactivate(&live.activation);
            }
            // Development mode ends with the activation it reloads.
            self.end_dev(&state, id)?;
            current.detail.summary.activation_generation
        };
        // Outside the registry lock: the plugin's deactivate hook runs with a
        // bounded wait, and every generation issued so far is retired.
        self.hosts.stop(id, through);
        let draining = self.hosts.draining(id);
        let mut state = self.state.lock().unwrap();
        self.settle(&mut state, id, &draining)?;
        detail_reply(&state, id)
    }

    /// The launch spec for the plugin's live activation, or why it has none.
    fn launch_spec(&self, plugin_id: &str) -> Result<host::LaunchSpec> {
        let state = self.state.lock().unwrap();
        let plugin = installed(&state, plugin_id)?;
        let Some(live) = state.live.get(plugin_id) else {
            return Err(coded(
                "invalid_request",
                format!("Plugin {plugin_id} is not enabled"),
            )
            .into());
        };
        let Some(entry) = plugin.detail.manifest.entry_points.backend.clone() else {
            return Err(coded(
                "invalid_request",
                format!("Plugin {plugin_id} declares no backend entry point"),
            )
            .into());
        };
        let settings =
            serde_json::from_value::<PluginSettings>(settings_reply(&state.db, plugin_id)?)?
                .settings
                .into_iter()
                .map(|setting| (setting.key, setting.value))
                .collect();
        Ok(host::LaunchSpec {
            plugin_id: plugin_id.to_owned(),
            generation: live.activation.generation,
            artifact_path: plugin.detail.artifact_path.clone(),
            entry,
            commands: state
                .registry
                .registrations(plugin_id)
                .into_iter()
                .filter(|registration| registration.kind == PluginRegistrationKind::Command)
                .map(|registration| registration.id)
                .collect(),
            settings,
        })
    }

    fn invoke(&self, request: PluginCommandInvokeRequest) -> Result<Value> {
        let payload = serde_json::to_value(&request)?;
        let operation_id = request.operation_id.clone();
        if let Some(stored) = self.admit(INVOKE_OP, &operation_id, &payload)? {
            return Ok(stored);
        }
        let prepared = (|| {
            ensure!(
                request.args.to_string().len() <= MAX_INVOKE_ARGS_BYTES,
                coded(
                    "invalid_request",
                    format!("Command arguments exceed {MAX_INVOKE_ARGS_BYTES} bytes")
                )
            );
            let spec = self.launch_spec(&request.plugin_id)?;
            ensure!(
                spec.commands.contains(&request.command_id),
                coded(
                    "invalid_request",
                    format!(
                        "Plugin {} activation {} has no command {}",
                        request.plugin_id, spec.generation, request.command_id
                    )
                )
            );
            let process = self.hosts.ensure(&spec).map_err(|message| {
                coded("not_applied", format!("{message}; the command did not run"))
            })?;
            // The last durable step before plugin code can run.
            let state = self.state.lock().unwrap();
            receipts::settle(&state.db, &operation_id, Status::Dispatched, None, now_ms())?;
            Ok(process)
        })();
        let process = match prepared {
            Ok(process) => process,
            Err(error) => return Ok(self.settle_failure(&operation_id, error)),
        };
        let called = process.call(
            "invoke",
            json!({
                "generation": process.key.generation,
                "command_id": request.command_id,
                "args": request.args,
                "invocation_id": operation_id,
            }),
            host::INVOKE_TIMEOUT,
        );
        let outcome = match called {
            Ok(result) => PluginCommandOutcome::Completed {
                value: result.get("value").cloned().unwrap_or(Value::Null),
            },
            Err(host::CallError::Failed(message)) => PluginCommandOutcome::Failed { message },
            Err(host::CallError::NotRun(message)) => {
                return Ok(self.settle_failure(
                    &operation_id,
                    coded("not_applied", format!("{message}; the command did not run")).into(),
                ));
            }
            Err(host::CallError::Unknown(message)) => {
                // A host that stopped answering is killed; its exit counts as
                // a crash and the supervisor restarts it with backoff.
                self.hosts.kill(&request.plugin_id, process.key);
                return Ok(self.settle_unknown(&operation_id, &message));
            }
        };
        let response = reply(&PluginCommandResult {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            command_id: request.command_id,
            generation: process.key.generation,
            attempt: process.key.attempt,
            outcome,
        })?;
        let mut state = self.state.lock().unwrap();
        state.inflight.remove(&operation_id);
        if let Err(error) = receipts::settle(
            &state.db,
            &operation_id,
            Status::Settled,
            Some(&response),
            now_ms(),
        ) {
            // The command ran; only its record failed. The caller gets the
            // result; a replay finds the receipt open and reports it unknown.
            tracing::warn!(target: "ade", event = "plugin_receipt_settle_failed", error = %error);
        }
        Ok(response)
    }

    /// Records an invocation whose outcome cannot be proven. The receipt
    /// stays `unknown`; a replay reports `outcome_unknown` and never re-runs.
    fn settle_unknown(&self, operation_id: &str, message: &str) -> Value {
        let reply = json!({"type": "error", "code": "outcome_unknown",
            "message": format!("{message}. The command may or may not have run; inspect the plugin's state before retrying with a new operation ID")});
        let mut state = self.state.lock().unwrap();
        state.inflight.remove(operation_id);
        if let Err(error) = receipts::settle(
            &state.db,
            operation_id,
            Status::Unknown,
            Some(&reply),
            now_ms(),
        ) {
            tracing::warn!(target: "ade", event = "plugin_receipt_settle_failed", error = %error);
        }
        reply
    }

    fn host_reply(&self, plugin_id: &str) -> Result<Value> {
        let (has_backend, generation) = {
            let state = self.state.lock().unwrap();
            let plugin = installed(&state, plugin_id)?;
            (
                plugin.detail.manifest.entry_points.backend.is_some(),
                state
                    .live
                    .get(plugin_id)
                    .map(|live| live.activation.generation),
            )
        };
        reply(&PluginHostReply {
            tag: Default::default(),
            host: self.hosts.status(plugin_id, has_backend, generation),
        })
    }

    fn host_status(&self, request: PluginHostStatusRequest) -> Result<Value> {
        self.host_reply(&request.plugin_id)
    }

    fn host_restart(&self, request: PluginHostRestartRequest) -> Result<Value> {
        let spec = self.launch_spec(&request.plugin_id)?;
        self.hosts.restart(&spec).map_err(|error| match error {
            host::RestartError::NotApplied(message) => coded("not_applied", message),
            host::RestartError::Failed(message) => coded("failed", message),
        })?;
        self.host_reply(&request.plugin_id)
    }

    /// Admits an effect command. Returns the stored reply for a known ID.
    fn admit(&self, op: &str, operation_id: &str, payload: &Value) -> Result<Option<Value>> {
        ensure!(
            !operation_id.is_empty() && operation_id.len() <= 256,
            coded("invalid_request", "operation_id must be 1 to 256 bytes")
        );
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let tx = state.db.transaction()?;
        match receipts::begin(&tx, operation_id, op, payload, Some("plugin"), now_ms())? {
            Admission::New => {
                tx.commit()?;
                state.inflight.insert(operation_id.to_owned());
                Ok(None)
            }
            Admission::Replay(receipt) => match (receipt.status, receipt.result) {
                // An unknown outcome replays its stored explanation; it never re-runs.
                (Status::Settled | Status::Unknown, Some(result)) => Ok(Some(result)),
                _ if state.inflight.contains(operation_id) => Err(coded(
                    "in_progress",
                    format!("Operation {operation_id} is still running; inspect the plugin"),
                )
                .into()),
                _ => Err(coded(
                    "outcome_unknown",
                    format!("Operation {operation_id} has no recorded outcome; inspect the plugin"),
                )
                .into()),
            },
            Admission::Conflict => Err(coded(
                "conflict",
                format!("Operation ID {operation_id} was already used for a different request"),
            )
            .into()),
            Admission::Expired => Err(coded(
                "invalid_request",
                format!("Operation ID {operation_id} is past its receipt retention; use a new ID"),
            )
            .into()),
        }
    }

    /// Records a failed effect as its settled outcome so a replay returns the
    /// same failure. The failure happened before the commit point.
    fn settle_failure(&self, operation_id: &str, error: anyhow::Error) -> Value {
        let reply = match error.downcast_ref::<Coded>() {
            Some(_) => envelope(error),
            None => json!({"type": "error", "code": "not_applied",
                "message": format!("{error:#}; nothing was installed or removed")}),
        };
        let mut state = self.state.lock().unwrap();
        state.inflight.remove(operation_id);
        if let Err(error) = receipts::settle(
            &state.db,
            operation_id,
            Status::Settled,
            Some(&reply),
            now_ms(),
        ) {
            tracing::warn!(target: "ade", event = "plugin_receipt_settle_failed", error = %error);
        }
        reply
    }

    fn install(&self, request: PluginInstallRequest) -> Result<Value> {
        let payload = serde_json::to_value(&request)?;
        let id = request.operation_id.clone();
        if let Some(stored) = self.admit("plugin.install", &id, &payload)? {
            return Ok(stored);
        }
        let staged = match artifact::stage(&request.source, &self.staging) {
            Ok(staged) => staged,
            Err(error) => return Ok(self.settle_failure(&id, error)),
        };
        let outcome = self.commit_install(&request, &staged);
        artifact::discard(&staged.staging);
        match outcome {
            Ok(reply) => {
                self.state.lock().unwrap().inflight.remove(&id);
                Ok(reply)
            }
            Err(error) => Ok(self.settle_failure(&id, error)),
        }
    }

    fn commit_install(
        &self,
        request: &PluginInstallRequest,
        staged: &artifact::Staged,
    ) -> Result<Value> {
        let manifest = manifest::read(&staged.manifest_bytes()?, &staged.files)
            .map_err(|message| coded("invalid_request", message))?;
        if let Some(expected) = &request.expected_version {
            ensure!(
                *expected == manifest.version,
                coded(
                    "invalid_request",
                    format!(
                        "Artifact version is {}, not the expected {expected}",
                        manifest.version
                    )
                )
            );
        }
        let mut state = self.state.lock().unwrap();
        let existing = installed(&state, &manifest.id).ok();
        if existing.as_ref().is_some_and(|current| current.enabled)
            || state.live.contains_key(&manifest.id)
        {
            return Err(coded(
                "conflict",
                format!(
                    "Plugin {} is enabled; disable it before replacing its artifact",
                    manifest.id
                ),
            )
            .into());
        }
        let stored_schema: Option<u32> = state
            .db
            .query_row(
                "SELECT stored_data_schema FROM plugin_state WHERE plugin_id=?1",
                [&manifest.id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let data_schema = match manifest::admit_data_schema(stored_schema, manifest.data_schema) {
            SchemaAdmission::Accept(schema) => schema,
            SchemaAdmission::Downgrade { stored, incoming } => {
                return Err(coded(
                    "invalid_request",
                    format!(
                        "Plugin {} data is at schema {stored}; this artifact declares {incoming}. Rolling back code does not roll back data",
                        manifest.id
                    ),
                ).into());
            }
        };
        let path = artifact::place(staged, &self.artifacts, &manifest.id, &manifest.version)?;
        let now = now_ms();
        let installed_at = existing
            .as_ref()
            .map_or(now, |current| current.detail.summary.installed_at);
        let tx = state.db.transaction()?;
        tx.execute(
            "INSERT INTO plugins(id,name,version,source_kind,source_locator,source_ref,source_pin,
               artifact_digest,artifact_path,manifest,enabled,installed_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,
               source_kind=excluded.source_kind,source_locator=excluded.source_locator,
               source_ref=excluded.source_ref,source_pin=excluded.source_pin,
               artifact_digest=excluded.artifact_digest,artifact_path=excluded.artifact_path,
               manifest=excluded.manifest,enabled=0,updated_at=excluded.updated_at",
            params![
                manifest.id,
                manifest.name,
                manifest.version,
                source_kind(staged.pin.kind),
                staged.pin.locator,
                staged.pin.git_ref,
                staged.pin.pin,
                staged.digest,
                path.to_string_lossy(),
                serde_json::to_string(&manifest)?,
                installed_at,
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO plugin_state(plugin_id,activation_generation,stored_data_schema) VALUES(?1,0,?2)
             ON CONFLICT(plugin_id) DO UPDATE SET stored_data_schema=excluded.stored_data_schema",
            params![manifest.id, data_schema],
        )?;
        let detail = read_installed(&tx, &manifest.id)?.detail;
        let response = reply(&PluginReply {
            tag: Default::default(),
            plugin: detail,
        })?;
        receipts::settle(
            &tx,
            &request.operation_id,
            Status::Settled,
            Some(&response),
            now,
        )?;
        tx.commit()?;
        state.errors.remove(&manifest.id);
        Ok(response)
    }

    fn uninstall(&self, request: PluginUninstallRequest) -> Result<Value> {
        let payload = serde_json::to_value(&request)?;
        let operation_id = request.operation_id.clone();
        if let Some(stored) = self.admit("plugin.uninstall", &operation_id, &payload)? {
            return Ok(stored);
        }
        match self.commit_uninstall(&request) {
            Ok(reply) => {
                self.state.lock().unwrap().inflight.remove(&operation_id);
                // Past the commit point; a leftover directory is removed on the next open.
                if let Err(error) = fs::remove_dir_all(self.artifacts.join(&request.plugin_id)) {
                    tracing::warn!(target: "ade", event = "plugin_artifact_remove_failed", error = %error);
                }
                Ok(reply)
            }
            Err(error) => Ok(self.settle_failure(&operation_id, error)),
        }
    }

    fn commit_uninstall(&self, request: &PluginUninstallRequest) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        let id = &request.plugin_id;
        // A plugin uninstalled earlier without a purge may still hold data;
        // purging it is the only way to install an older data schema again.
        let leftover: bool = state.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_records WHERE plugin_id=?1)
               OR EXISTS(SELECT 1 FROM plugin_settings WHERE plugin_id=?1)
               OR EXISTS(SELECT 1 FROM plugin_state WHERE plugin_id=?1 AND stored_data_schema IS NOT NULL)",
            [id],
            |row| row.get(0),
        )?;
        let present: bool = state.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugins WHERE id=?1)",
            [id],
            |row| row.get(0),
        )?;
        let current = if present || !(request.purge_data && leftover) {
            Some(installed(&state, id)?)
        } else {
            None
        };
        ensure!(
            !current.is_some_and(|current| current.enabled) && !state.live.contains_key(id),
            coded(
                "conflict",
                format!("Plugin {id} is enabled; disable it before uninstalling")
            )
        );
        let leases = reload::lease_count(&state.db, id)?;
        // A disabled plugin gains no new drain, so the set can only shrink.
        let draining = self.hosts.draining(id).len();
        if let Some(message) = dev::uninstall_refusal(id, leases, draining) {
            return Err(coded("conflict", message).into());
        }
        let tx = state.db.transaction()?;
        tx.execute("DELETE FROM plugins WHERE id=?1", [id])?;
        tx.execute("DELETE FROM plugin_generations WHERE plugin_id=?1", [id])?;
        tx.execute("DELETE FROM plugin_dev WHERE plugin_id=?1", [id])?;
        if request.purge_data {
            tx.execute("DELETE FROM plugin_records WHERE plugin_id=?1", [id])?;
            tx.execute("DELETE FROM plugin_settings WHERE plugin_id=?1", [id])?;
            // The generation counter stays so a reinstall never reuses one.
            tx.execute(
                "UPDATE plugin_state SET stored_data_schema=NULL WHERE plugin_id=?1",
                [id],
            )?;
        }
        let response = reply(&PluginUninstalled {
            tag: Default::default(),
            plugin_id: id.clone(),
            data_purged: request.purge_data,
        })?;
        receipts::settle(
            &tx,
            &request.operation_id,
            Status::Settled,
            Some(&response),
            now_ms(),
        )?;
        tx.commit()?;
        state.errors.remove(id);
        Ok(response)
    }

    fn record_get(&self, request: PluginRecordGetRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        installed(&state, &request.plugin_id)?;
        record_address(&request.namespace, &request.key)?;
        let record = read_record(
            &state.db,
            &request.plugin_id,
            &request.namespace,
            &request.key,
        )?;
        reply(&PluginRecordReply {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            record,
        })
    }

    fn record_list(&self, request: PluginRecordListRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        installed(&state, &request.plugin_id)?;
        record_address(&request.namespace, "k")?;
        let records = state
            .db
            .prepare(
                "SELECT key FROM plugin_records WHERE plugin_id=?1 AND namespace=?2 ORDER BY key LIMIT ?3",
            )?
            .query_map(
                params![request.plugin_id, request.namespace, MAX_LISTED_RECORDS as i64 + 1],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            records.len() <= MAX_LISTED_RECORDS,
            coded(
                "invalid_request",
                format!("Namespace holds more than {MAX_LISTED_RECORDS} records; read them by key")
            )
        );
        let records = records
            .iter()
            .map(|key| {
                read_record(&state.db, &request.plugin_id, &request.namespace, key)?
                    .context("Plugin record vanished while listing")
            })
            .collect::<Result<_>>()?;
        reply(&PluginRecordList {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            namespace: request.namespace,
            records,
        })
    }

    fn record_put(&self, request: PluginRecordPutRequest) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        let plugin = installed(&state, &request.plugin_id)?;
        record_address(&request.namespace, &request.key)?;
        let text = serde_json::to_string(&request.value)?;
        ensure!(
            text.len() <= MAX_RECORD_BYTES,
            coded(
                "invalid_request",
                format!("Plugin record exceeds {MAX_RECORD_BYTES} bytes")
            )
        );
        let tx = state.db.transaction()?;
        let current = read_record(&tx, &request.plugin_id, &request.namespace, &request.key)?;
        let revision = current.as_ref().map_or(0, |record| record.revision);
        if let Some(expected) = request.expected_revision {
            ensure!(
                expected == revision,
                coded(
                    "conflict",
                    format!("Plugin record is at revision {revision}, not {expected}")
                )
            );
        }
        let schema = plugin.detail.summary.data_schema;
        tx.execute(
            "INSERT INTO plugin_records(plugin_id,namespace,key,value,revision,data_schema,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(plugin_id,namespace,key) DO UPDATE SET value=excluded.value,
               revision=excluded.revision,data_schema=excluded.data_schema,updated_at=excluded.updated_at",
            params![
                request.plugin_id,
                request.namespace,
                request.key,
                text,
                revision as i64 + 1,
                schema,
                now_ms()
            ],
        )?;
        let record = read_record(&tx, &request.plugin_id, &request.namespace, &request.key)?;
        tx.commit()?;
        reply(&PluginRecordReply {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            record,
        })
    }

    fn record_delete(&self, request: PluginRecordDeleteRequest) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        installed(&state, &request.plugin_id)?;
        record_address(&request.namespace, &request.key)?;
        let tx = state.db.transaction()?;
        let current = read_record(&tx, &request.plugin_id, &request.namespace, &request.key)?;
        if let Some(expected) = request.expected_revision {
            let revision = current.as_ref().map_or(0, |record| record.revision);
            ensure!(
                expected == revision,
                coded(
                    "conflict",
                    format!("Plugin record is at revision {revision}, not {expected}")
                )
            );
        }
        tx.execute(
            "DELETE FROM plugin_records WHERE plugin_id=?1 AND namespace=?2 AND key=?3",
            params![request.plugin_id, request.namespace, request.key],
        )?;
        tx.commit()?;
        reply(&PluginRecordDeleted {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            namespace: request.namespace,
            key: request.key,
            deleted: current.is_some(),
        })
    }

    fn setting_list(&self, request: PluginSettingListRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        settings_reply(&state.db, &request.plugin_id)
    }

    fn setting_set(&self, request: PluginSettingSetRequest) -> Result<Value> {
        let state = self.state.lock().unwrap();
        let plugin = installed(&state, &request.plugin_id)?;
        let declared = plugin
            .detail
            .manifest
            .contributes
            .settings
            .iter()
            .find(|setting| setting.key == request.key)
            .ok_or_else(|| {
                coded(
                    "invalid_request",
                    format!(
                        "Plugin {} declares no setting {}",
                        request.plugin_id, request.key
                    ),
                )
            })?;
        if let Some(problem) = manifest::setting_value_problem(declared.kind, &request.value) {
            return Err(coded(
                "invalid_request",
                format!("Setting {} {problem}", request.key),
            )
            .into());
        }
        if request.value.is_null() {
            state.db.execute(
                "DELETE FROM plugin_settings WHERE plugin_id=?1 AND key=?2",
                params![request.plugin_id, request.key],
            )?;
        } else {
            state.db.execute(
                "INSERT INTO plugin_settings(plugin_id,key,value,updated_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![
                    request.plugin_id,
                    request.key,
                    request.value.to_string(),
                    now_ms()
                ],
            )?;
        }
        let reply = settings_reply(&state.db, &request.plugin_id)?;
        drop(state);
        // The next host start, including a crash restart, activates with the
        // new value. Without a live backend activation there is nothing to
        // refresh; the next launch spec reads the database.
        if let Ok(spec) = self.launch_spec(&request.plugin_id) {
            self.hosts.refresh(&spec);
        }
        Ok(reply)
    }
}

/// Marks every plugin receipt left open by a previous process as not applied.
/// Each plugin effect commits its state change and settles its receipt in one
/// transaction, so an open receipt proves the change never committed.
fn settle_interrupted(db: &Connection) -> Result<()> {
    let open: Vec<(String, String, String)> = db
        .prepare(
            "SELECT id,op,status FROM operations WHERE status IN ('accepted','dispatched','acknowledged','unknown')",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, op, status) in open {
        if op == INVOKE_OP {
            if let Some((next, reply)) = interrupted_invocation(Status::parse(&status)?) {
                receipts::settle(db, &id, next, Some(&reply), now_ms())?;
            }
            continue;
        }
        if !EFFECT_OPS.contains(&op.as_str()) {
            continue;
        }
        let reply = json!({"type": "error", "code": "not_applied",
            "message": format!("{op} was interrupted before it committed; nothing was changed. Retry with a new operation ID")});
        receipts::settle(db, &id, Status::Settled, Some(&reply), now_ms())?;
    }
    Ok(())
}

/// What an invocation receipt left open by a previous process becomes. One
/// never marked dispatched was never written to a host, so it did not run. One
/// marked dispatched may have run in a host that died with the daemon.
fn interrupted_invocation(status: Status) -> Option<(Status, Value)> {
    match status {
        Status::Accepted => Some((
            Status::Settled,
            json!({"type": "error", "code": "not_applied",
                "message": "plugin.command.invoke was interrupted before it reached the plugin host; the command did not run. Retry with a new operation ID"}),
        )),
        Status::Dispatched | Status::Acknowledged => Some((
            Status::Unknown,
            json!({"type": "error", "code": "outcome_unknown",
                "message": "plugin.command.invoke was interrupted after it reached the plugin host; the command may or may not have run. Inspect the plugin's state before retrying with a new operation ID"}),
        )),
        Status::Settled | Status::Unknown => None,
    }
}

/// The static registrations a manifest contributes to its activation.
fn contributions(manifest: &PluginManifest) -> Vec<(PluginRegistrationKind, String)> {
    let contributes = &manifest.contributes;
    contributes
        .commands
        .iter()
        .map(|c| (PluginRegistrationKind::Command, c.id.clone()))
        .chain(
            contributes
                .panels
                .iter()
                .map(|p| (PluginRegistrationKind::Panel, p.id.clone())),
        )
        .collect()
}

/// Bumps and persists the plugin's generation, verifies its artifact, then
/// activates it with its manifest's contributions.
fn activate(state: &mut State, id: &str, origin: PluginGenerationOrigin) -> Result<()> {
    let plugin = installed(state, id)?;
    artifact::verify(
        Path::new(&plugin.detail.artifact_path),
        &plugin.detail.artifact_digest,
    )
    .map_err(|error| {
        coded(
            "not_applied",
            format!("{error:#}; plugin was not activated"),
        )
    })?;
    let generation = plugin.detail.summary.activation_generation + 1;
    // Persist first: a crash after this never reuses the generation.
    let now = now_ms();
    let tx = state.db.transaction()?;
    tx.execute(
        "UPDATE plugin_state SET activation_generation=?2 WHERE plugin_id=?1",
        params![id, generation as i64],
    )?;
    reload::record_generation(&tx, id, generation, &plugin.detail, origin, now)?;
    tx.commit()?;
    let activation = state
        .registry
        .activate_all(id, generation, &contributions(&plugin.detail.manifest))
        .map_err(|error| coded("conflict", format!("{error}; plugin was not activated")))?;
    state.live.insert(
        id.to_owned(),
        Live {
            activation,
            activated_at: now,
        },
    );
    Ok(())
}

fn installed(state: &State, id: &str) -> Result<Installed> {
    let mut plugin = read_installed(&state.db, id)?;
    let summary = &mut plugin.detail.summary;
    if let Some(live) = state.live.get(id) {
        summary.activation = Some(PluginActivation {
            generation: live.activation.generation,
            activated_at: live.activated_at,
            registrations: state.registry.registrations(id),
        });
    }
    summary.activation_error = state.errors.get(id).cloned();
    Ok(plugin)
}

fn read_installed(db: &Connection, id: &str) -> Result<Installed> {
    let row = db
        .query_row(
            "SELECT p.name,p.version,p.source_kind,p.source_locator,p.source_ref,p.source_pin,
                    p.artifact_digest,p.artifact_path,p.manifest,p.enabled,p.installed_at,p.updated_at,
                    COALESCE(s.activation_generation,0),s.stored_data_schema
             FROM plugins p LEFT JOIN plugin_state s ON s.plugin_id=p.id WHERE p.id=?1",
            [id],
            |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ),
                    (
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, bool>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                    ),
                    (row.get::<_, i64>(12)?, row.get::<_, Option<u32>>(13)?),
                ))
            },
        )
        .optional()?
        .ok_or_else(|| coded("invalid_request", format!("Plugin {id} is not installed")))?;
    let ((name, version, kind, locator, git_ref, pin), rest, (generation, stored)) = row;
    let (digest, path, manifest, enabled, installed_at, updated_at) = rest;
    let manifest: PluginManifest =
        serde_json::from_str(&manifest).context("Stored plugin manifest is invalid")?;
    let kind = match kind.as_str() {
        "local" => PluginSourceKind::Local,
        "package" => PluginSourceKind::Package,
        "git" => PluginSourceKind::Git,
        other => return Err(anyhow!("Stored plugin source kind {other} is unknown")),
    };
    let data_schema = manifest.data_schema;
    Ok(Installed {
        enabled,
        detail: PluginDetail {
            summary: PluginSummary {
                id: id.to_owned(),
                name,
                version,
                status: if enabled {
                    PluginStatus::Enabled
                } else {
                    PluginStatus::Disabled
                },
                source: PluginSourcePin {
                    kind,
                    locator,
                    git_ref,
                    pin,
                },
                activation_generation: generation.max(0) as u64,
                data_schema,
                stored_data_schema: stored.unwrap_or(data_schema),
                activation: None,
                activation_error: None,
                installed_at,
                updated_at,
            },
            artifact_digest: digest,
            artifact_path: path,
            manifest,
        },
    })
}

fn source_kind(kind: PluginSourceKind) -> &'static str {
    match kind {
        PluginSourceKind::Local => "local",
        PluginSourceKind::Package => "package",
        PluginSourceKind::Git => "git",
    }
}

fn detail_reply(state: &State, id: &str) -> Result<Value> {
    reply(&PluginReply {
        tag: Default::default(),
        plugin: installed(state, id)?.detail,
    })
}

fn record_address(namespace: &str, key: &str) -> Result<()> {
    ensure!(
        manifest::local_name(namespace),
        coded(
            "invalid_request",
            "Namespace must be 1 to 64 lowercase letters, digits, hyphens and underscores"
        )
    );
    ensure!(
        (1..=MAX_RECORD_KEY).contains(&key.len()) && !key.chars().any(char::is_control),
        coded(
            "invalid_request",
            format!("Record key must be 1 to {MAX_RECORD_KEY} bytes without control characters")
        )
    );
    Ok(())
}

fn read_record(
    db: &Connection,
    plugin: &str,
    namespace: &str,
    key: &str,
) -> Result<Option<PluginDataRecord>> {
    db.query_row(
        "SELECT value,revision,data_schema,updated_at FROM plugin_records
         WHERE plugin_id=?1 AND namespace=?2 AND key=?3",
        params![plugin, namespace, key],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )
    .optional()?
    .map(|(value, revision, data_schema, updated_at)| {
        Ok(PluginDataRecord {
            namespace: namespace.to_owned(),
            key: key.to_owned(),
            value: serde_json::from_str(&value).context("Stored plugin record is invalid")?,
            revision: revision.max(0) as u64,
            data_schema,
            updated_at,
        })
    })
    .transpose()
}

fn settings_reply(db: &Connection, id: &str) -> Result<Value> {
    let plugin = read_installed(db, id)?;
    let stored: HashMap<String, String> = db
        .prepare("SELECT key,value FROM plugin_settings WHERE plugin_id=?1")?
        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let settings = plugin
        .detail
        .manifest
        .contributes
        .settings
        .iter()
        .map(|setting| {
            let value = stored
                .get(&setting.key)
                .map(|text| serde_json::from_str(text))
                .transpose()
                .context("Stored plugin setting is invalid")?;
            Ok(match value {
                Some(value) => PluginSettingValue {
                    key: setting.key.clone(),
                    kind: setting.kind,
                    value,
                    is_default: false,
                },
                None => PluginSettingValue {
                    key: setting.key.clone(),
                    kind: setting.kind,
                    value: setting.default.clone().unwrap_or(Value::Null),
                    is_default: true,
                },
            })
        })
        .collect::<Result<_>>()?;
    reply(&PluginSettings {
        tag: Default::default(),
        plugin_id: id.to_owned(),
        settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interrupted_invocation_is_not_applied_only_if_it_never_left_the_daemon() {
        let (status, reply) = interrupted_invocation(Status::Accepted).unwrap();
        assert_eq!(status, Status::Settled);
        assert_eq!(reply["code"], "not_applied");
        for open in [Status::Dispatched, Status::Acknowledged] {
            let (status, reply) = interrupted_invocation(open).unwrap();
            assert_eq!(status, Status::Unknown);
            assert_eq!(reply["code"], "outcome_unknown");
            assert!(open.may_become(status));
        }
        assert!(interrupted_invocation(Status::Unknown).is_none());
        assert!(interrupted_invocation(Status::Settled).is_none());
    }
}
