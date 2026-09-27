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
use ade_core::contract::providers::ProviderWorker;
use ade_core::model::AccountExecution;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Command;
use std::sync::{Arc, mpsc};
use std::time::Duration;

/// Protocol versions this ADE speaks, oldest first.
pub const PROTOCOL_VERSIONS: &[u32] = &[1];
/// Capability names a worker may declare. Others are ignored, never claimed.
pub const KNOWN_CAPABILITIES: &[&str] = &[
    "streaming",
    "images",
    "text_attachments",
    "resume",
    "cancel",
    "steering",
    "tool_approval",
    "questions",
];
const INITIALIZE_LIMIT: Duration = Duration::from_secs(15);
const MAX_NAME: usize = 80;
const MAX_MODES: usize = 16;
const MAX_ID: usize = 256;
const MAX_ITEM_TEXT: usize = 1024 * 1024;
const MAX_HISTORY: usize = 10_000;

/// What a worker declared in `initialize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handshake {
    pub protocol_version: u32,
    pub descriptor: Descriptor,
    /// Capability names ADE did not recognize and therefore does not use.
    pub ignored_capabilities: Vec<String>,
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

/// Validates a worker's `initialize` reply against the provider ID it was
/// started as. Fails closed on any unsupported or malformed declaration.
pub fn check_handshake(provider: &str, reply: &Value) -> Result<Handshake> {
    let version = reply["protocol_version"]
        .as_u64()
        .context("Provider worker omitted protocol_version")?;
    ensure!(
        PROTOCOL_VERSIONS.iter().any(|v| u64::from(*v) == version),
        "Provider worker speaks protocol {version}; this ADE supports {PROTOCOL_VERSIONS:?}"
    );
    let name = reply["name"]
        .as_str()
        .context("Provider worker omitted its name")?;
    ensure!(
        !name.trim().is_empty()
            && name.chars().count() <= MAX_NAME
            && !name.chars().any(char::is_control),
        "Provider worker name must be 1 to {MAX_NAME} printable characters"
    );
    let strings = |field: &str| -> Result<Vec<String>> {
        match &reply[field] {
            Value::Null => Ok(vec![]),
            Value::Array(values) => values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .with_context(|| format!("Provider worker {field} must be strings"))
                })
                .collect(),
            _ => bail!("Provider worker {field} must be a list"),
        }
    };
    let mut capabilities = Vec::new();
    let mut ignored = Vec::new();
    for capability in strings("capabilities")? {
        if capabilities.contains(&capability) || ignored.contains(&capability) {
            continue;
        }
        if KNOWN_CAPABILITIES.contains(&capability.as_str()) {
            capabilities.push(capability);
        } else {
            ignored.push(capability);
        }
    }
    let permission_modes = strings("permission_modes")?;
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
            name: name.into(),
            capabilities,
            permission_modes,
            setting_sources: vec![],
        },
        ignored_capabilities: ignored,
    })
}

/// Checks the normalized history a worker returned from `open`. Every item
/// keeps its native ID as provenance, so an item without one, or a repeated
/// one, is refused rather than renumbered.
pub fn check_history(history: &[Item]) -> Result<()> {
    ensure!(
        history.len() <= MAX_HISTORY,
        "Provider worker history exceeds {MAX_HISTORY} items"
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
            local_name(&item.role) && local_name(&item.kind) && local_name(&item.status),
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
        ensure!(
            account.is_none(),
            "Plugin providers use their own login; ADE does not manage their accounts yet"
        );
        Ok(Worker::spawn(&self.worker, cwd, events)?)
    }
}

/// One running worker process.
pub struct Worker {
    rpc: Arc<Rpc>,
    handshake: Handshake,
}

impl Worker {
    pub fn spawn(
        worker: &ProviderWorker,
        cwd: &str,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        check_launch(worker)?;
        let entry = Path::new(&worker.artifact_path).join(&worker.entry);
        ensure!(
            entry.is_file(),
            "Provider worker entry {} is missing from the pinned artifact",
            worker.entry
        );
        let mut command =
            Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
        command
            .arg(&entry)
            .current_dir(cwd)
            .env("ADE_PROVIDER_ID", &worker.provider)
            .env("ADE_PLUGIN_ID", &worker.pin.plugin_id)
            .env("ADE_PLUGIN_VERSION", &worker.pin.version);
        let rpc = Rpc::spawn_with(command, events, Framing::JsonRpc2, super::bridge_event)?;
        let handshake = rpc
            .request_within(
                "initialize",
                json!({
                    "versions": PROTOCOL_VERSIONS,
                    "provider": worker.provider,
                    "plugin": {"id": worker.pin.plugin_id, "version": worker.pin.version},
                }),
                Some(INITIALIZE_LIMIT),
            )
            .and_then(|reply| check_handshake(&worker.provider, &reply))
            .context("The provider worker did not complete its initialize handshake");
        match handshake {
            Ok(handshake) => Ok(Arc::new(Self { rpc, handshake })),
            Err(error) => match rpc.stop_confirmed() {
                Ok(()) => Err(error),
                Err(stop) => Err(error.context(stop.to_string())),
            },
        }
    }

    pub fn handshake(&self) -> &Handshake {
        &self.handshake
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
    fn pid(&self) -> Option<u32> {
        Some(self.rpc.pid())
    }
    fn descendants(&self) -> Option<Vec<crate::descendants::Identity>> {
        Some(self.rpc.descendants())
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
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
        check_history(&connected.history)?;
        Ok(connected)
    }
    fn send(
        &self,
        session: &str,
        submission: &str,
        message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        self.turn(
            "send",
            json!({"session":session,"submission":submission,"message_id":message_id,
                "text":prompt.text,"attachments":prompt.attachments}),
        )
    }
    fn steer(
        &self,
        session: &str,
        turn: &str,
        message_id: &str,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        ensure!(
            self.supports("steering"),
            "This provider worker does not support steering a running turn"
        );
        self.turn(
            "steer",
            json!({"session":session,"turn":turn,"message_id":message_id,
                "text":prompt.text,"attachments":prompt.attachments}),
        )
    }
    fn cancel(&self, session: &str, turn: &str) -> Result<()> {
        ensure!(
            self.supports("cancel"),
            "This provider worker does not support interruption"
        );
        self.rpc
            .request("cancel", json!({"session":session,"turn":turn}))?;
        Ok(())
    }
    fn prepare_submission(&self) -> Option<String> {
        Some(uuid::Uuid::new_v4().to_string())
    }
    fn validate_answer(
        &self,
        _: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
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
        self.validate_answer(p, decision, answers)?;
        self.rpc.request(
            "answer",
            json!({"id":p.rpc_id,"decision":decision,"answers":answers}),
        )?;
        Ok(())
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.rpc.request(
            "answer",
            json!({"id":id,"decision":"decline","reason":message}),
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

/// Whether `provider` names a plugin worker rather than a bundled provider
/// or adapter.
pub fn is_plugin_provider(provider: &str) -> bool {
    provider.starts_with(PLUGIN_PREFIX)
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

    #[test]
    fn a_conforming_handshake_becomes_the_launch_descriptor() {
        let handshake = check_handshake(
            "plugin:acme.agent",
            &json!({"protocol_version": 1, "name": "Acme Agent",
                "capabilities": ["streaming", "cancel", "teleport", "cancel"],
                "permission_modes": ["default", "read-only"]}),
        )
        .unwrap();
        assert_eq!(handshake.descriptor.id, "plugin:acme.agent");
        assert_eq!(handshake.descriptor.capabilities, ["streaming", "cancel"]);
        assert_eq!(handshake.ignored_capabilities, ["teleport"]);
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
    fn nonconforming_handshakes_fail_closed() {
        let base = json!({"protocol_version": 1, "name": "A", "capabilities": [],
            "permission_modes": ["default"]});
        check_handshake("plugin:a.b", &base).unwrap();
        let cases: [(&str, Value); 7] = [
            ("protocol_version", json!(2)),
            ("protocol_version", Value::Null),
            ("name", json!(" ")),
            ("capabilities", json!("streaming")),
            ("permission_modes", json!(["plan"])),
            ("permission_modes", json!(["default", "default"])),
            ("permission_modes", json!(["default", "a b"])),
        ];
        for (field, value) in cases {
            let mut reply = base.clone();
            reply[field] = value.clone();
            assert!(
                check_handshake("plugin:a.b", &reply).is_err(),
                "{field}={value} should be refused"
            );
        }
    }

    fn item(id: &str) -> Item {
        Item {
            content: None,
            id: id.into(),
            client_id: None,
            turn: Some("t1".into()),
            role: "assistant".into(),
            kind: "message".into(),
            text: "hi".into(),
            status: "completed".into(),
        }
    }

    #[test]
    fn history_keeps_native_ids_or_is_refused() {
        check_history(&[item("a"), item("b")]).unwrap();
        assert!(check_history(&[item("a"), item("a")]).is_err());
        assert!(check_history(&[item("")]).is_err());
        let mut odd = item("c");
        odd.role = "assistant\n".into();
        assert!(check_history(&[odd]).is_err());
    }
}
