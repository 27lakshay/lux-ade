//! Conversations on providers outside the static catalogue (F023, F024): a
//! profile's generic adapters (`adapter:<id>`) and installed plugin provider
//! workers (`plugin:<id>`).
//!
//! - A new conversation is validated against the descriptor the provider's
//!   registry entry publishes, not the static list.
//! - It is pinned when created: an adapter conversation to the definition's
//!   revision, a plugin conversation to the plugin's current activation
//!   through a provider lease. A run carries that pin in its runtime `Spec`.
//! - The catalogue lists ready adapters and live plugin providers, with the
//!   capabilities their probe or handshake declared.
//! - `adapter.remove` and `plugin.uninstall` are refused while a run uses the
//!   provider.
use super::*;
use ade_core::contract::providers::ProviderWorker;
use ade_core::contract::providers::adapters::AdapterPin;
use ade_core::provider::Descriptor;
use ade_runtime::adapters::PROVIDER_PREFIX as ADAPTER_PREFIX;
use ade_runtime::provider::registry::{PLUGIN_PREFIX, ProviderEntry};

/// A provider a conversation names, by origin.
enum Named<'a> {
    Adapter(&'a str),
    Plugin(&'a str),
    Other,
}

fn named(provider: &str) -> Named<'_> {
    if let Some(id) = provider.strip_prefix(ADAPTER_PREFIX) {
        Named::Adapter(id)
    } else if let Some(id) = provider.strip_prefix(PLUGIN_PREFIX) {
        Named::Plugin(id)
    } else {
        Named::Other
    }
}

/// The key a plugin worker's handshake is cached under: the artifact it ran.
fn handshake_key(worker: &ProviderWorker) -> String {
    format!(
        "{}\n{}\n{}",
        worker.pin.plugin_id, worker.pin.version, worker.pin.artifact_digest
    )
}

fn conflict(message: String) -> Value {
    json!({"type": "error", "code": "conflict", "message": message})
}

impl Sessions {
    pub(super) fn live_workers(&self) -> Result<Vec<(String, ProviderWorker)>> {
        match &self.plugins {
            Ok(plugins) => plugins.provider_workers(),
            Err(error) => Err(anyhow!("Plugin registry is unavailable: {error}")),
        }
    }

    /// The descriptor a new conversation on `provider` is validated against,
    /// when the provider is registered outside the static catalogue.
    pub(super) fn registered_descriptor(&self, provider: &str) -> Result<Option<Descriptor>> {
        match named(provider) {
            Named::Other => Ok(None),
            Named::Adapter(id) => self.adapters.descriptor_for_new(id).map(Some),
            Named::Plugin(id) => {
                let (name, worker) = self
                    .live_workers()?
                    .into_iter()
                    .find(|(_, worker)| worker.pin.plugin_id == id)
                    .with_context(|| {
                        format!("No enabled plugin registers provider {provider}; enable it first")
                    })?;
                Ok(Some(
                    ade_runtime::provider::worker::WorkerEntry { worker, name }.descriptor(),
                ))
            }
        }
    }

    /// The capability record of `provider` when it is registered outside the
    /// static catalogue, built from the descriptor the catalogue shows (a
    /// plugin's last handshake, once one has run). `None` for a bundled
    /// provider; an error when the adapter is not ready or the plugin is not
    /// enabled.
    pub(super) fn registered_record(
        &self,
        provider: &str,
    ) -> Result<Option<ade_core::contract::providers::CapabilityRecord>> {
        if matches!(named(provider), Named::Other) {
            return Ok(None);
        }
        let shown = self
            .provider_descriptors()
            .into_iter()
            .find(|descriptor| descriptor.id == provider);
        let descriptor = match shown {
            Some(descriptor) => descriptor,
            None => self
                .registered_descriptor(provider)?
                .ok_or_else(|| ade_core::error::ProviderNotFound(provider.to_owned()))?,
        };
        let declared = self.declared_operations(&self.data.lock().unwrap(), provider);
        Ok(Some(crate::capabilities::core::registered_record(
            &descriptor,
            declared.as_deref().ok(),
        )))
    }

    /// The capability records of every ready adapter and live plugin provider.
    pub(super) fn registered_records(
        &self,
    ) -> Vec<ade_core::contract::providers::CapabilityRecord> {
        let d = self.data.lock().unwrap();
        self.provider_descriptors()
            .iter()
            .filter(|descriptor| !matches!(named(&descriptor.id), Named::Other))
            .map(|descriptor| {
                let declared = self.declared_operations(&d, &descriptor.id);
                crate::capabilities::core::registered_record(descriptor, declared.as_deref().ok())
            })
            .collect()
    }

    /// Pins a conversation just created on a registered provider. A plugin
    /// lease that cannot be taken now is taken at the first launch instead.
    pub(super) fn pin_new(&self, conversation: &Conversation) -> Result<()> {
        match named(&conversation.provider) {
            Named::Other => {}
            Named::Adapter(id) => self.adapters.pin(&conversation.id, id)?,
            Named::Plugin(id) => {
                if let Ok(plugins) = &self.plugins
                    && let Err(error) = plugins.lease_provider(id, &conversation.id)
                {
                    tracing::warn!(target: "ade", event = "provider_lease_deferred", error = %error);
                }
            }
        }
        Ok(())
    }

    /// What a new run of `conversation` launches: the worker its lease pins,
    /// or the adapter definition its pin allows.
    pub(super) fn launch_pins(
        &self,
        conversation: &Conversation,
    ) -> Result<(Option<ProviderWorker>, Option<AdapterPin>)> {
        match named(&conversation.provider) {
            Named::Other => Ok((None, None)),
            Named::Adapter(id) => Ok((
                None,
                Some(self.adapters.launch_pin(
                    &conversation.id,
                    id,
                    conversation.provider_thread_id.is_some(),
                )?),
            )),
            Named::Plugin(id) => {
                ensure!(
                    self.live_workers()?
                        .iter()
                        .any(|(_, worker)| worker.pin.plugin_id == id),
                    "Plugin {id} is not enabled; its conversations stay readable, but they cannot run until it is enabled again"
                );
                let plugins = self.plugins.as_ref().map_err(|error| anyhow!("{error}"))?;
                Ok((Some(plugins.lease_provider(id, &conversation.id)?), None))
            }
        }
    }

    /// Every provider a new conversation can use: the bundled catalogue, the
    /// ready adapters and the live plugin providers. A plugin provider shows
    /// the capabilities its last handshake declared, once one has run.
    pub(super) fn provider_descriptors(&self) -> Vec<Descriptor> {
        let mut descriptors = provider::descriptors().to_vec();
        match self.adapters.ready_descriptors() {
            Ok(ready) => descriptors.extend(ready),
            Err(error) => {
                tracing::warn!(target: "ade", event = "adapter_descriptors_unavailable", error = %error)
            }
        }
        if let Ok(workers) = self.live_workers() {
            let handshakes = self.provider_handshakes.lock().unwrap();
            for (name, worker) in workers {
                let descriptor = handshakes.get(&handshake_key(&worker)).cloned().flatten();
                descriptors.push(descriptor.unwrap_or_else(|| {
                    ade_runtime::provider::worker::WorkerEntry { worker, name }.descriptor()
                }));
            }
        }
        descriptors
    }

    /// The operations `provider`'s worker declares, which decide its
    /// conversation controls, or why none are known. Every worker-backed
    /// provider answers the same way: a bundled provider with the descriptor
    /// its worker answers `initialize` with, a plugin with what its worker
    /// declared at its last handshake, and a generic ACP adapter with what its
    /// probe recorded.
    pub(super) fn declared_operations(
        &self,
        d: &Data,
        provider: &str,
    ) -> std::result::Result<Vec<ade_core::contract::providers::ProviderWorkerOperation>, String>
    {
        match named(provider) {
            Named::Other => ade_runtime::provider::registry::bundled()
                .get(provider)
                .and_then(|registered| registered.entry.worker_descriptor())
                .map(|descriptor| descriptor.operations)
                .ok_or_else(|| format!("Unknown provider {provider}")),
            Named::Adapter(id) => self.adapters.declared_operations(id),
            Named::Plugin(_) => d.worker_operations.get(provider).cloned().ok_or_else(|| {
                "The provider plugin's worker has not completed its handshake; its controls are unknown".into()
            }),
        }
    }

    /// Discovers the capabilities of each live plugin provider whose artifact
    /// has not been handshaken yet: the worker is started, answers
    /// `initialize` and is stopped. Call it without the session lock.
    pub(super) fn discover_plugin_providers(&self) {
        let Ok(workers) = self.live_workers() else {
            return;
        };
        for (_, worker) in workers {
            let key = handshake_key(&worker);
            if self.provider_handshakes.lock().unwrap().contains_key(&key) {
                continue;
            }
            let (events, _receiver) = mpsc::sync_channel(64);
            let cwd = std::env::temp_dir();
            let descriptor = match ade_runtime::provider::worker::Worker::spawn(
                &worker,
                &cwd.to_string_lossy(),
                None,
                events,
            ) {
                Ok(started) => {
                    let descriptor = started.handshake().descriptor.clone();
                    self.data.lock().unwrap().worker_operations.insert(
                        worker.provider.clone(),
                        started.handshake().wire_descriptor.operations.clone(),
                    );
                    match started.stop_confirmed() {
                        Ok(()) => Some(descriptor),
                        Err(error) => {
                            tracing::warn!(target: "ade", event = "provider_handshake_stop_failed", error = %error);
                            Some(descriptor)
                        }
                    }
                }
                Err(error) => {
                    // Cached as unknown: a broken artifact is not started on
                    // every catalogue read. A new activation retries.
                    tracing::warn!(target: "ade", event = "provider_handshake_failed", error = %error);
                    None
                }
            };
            self.provider_handshakes
                .lock()
                .unwrap()
                .insert(key, descriptor);
        }
    }

    /// Why `provider` may not be removed now: a connected Agent, or one whose
    /// stop is unresolved, runs on it.
    fn provider_in_use(d: &Data, provider: &str) -> Result<Option<String>> {
        let mut users = Vec::new();
        for id in d.agents.keys() {
            if d.store.conversation(id)?.provider == provider {
                users.push(id.clone());
            }
        }
        for unresolved in d.unresolved.values() {
            if let leases::Holder::Agent { provider: held, .. } = &unresolved.claim.holder
                && held == provider
                && let leases::LeaseKey::Agent(id) = &unresolved.claim.key
            {
                users.push(id.clone());
            }
        }
        users.sort();
        users.dedup();
        Ok((!users.is_empty()).then(|| {
            format!(
                "{provider} is in use by {} running Conversation(s) ({}); stop them first",
                users.len(),
                users.join(", ")
            )
        }))
    }

    /// `adapter.remove`: refused while a run uses the adapter. The session
    /// lock is held across the check and the removal, so no run starts on the
    /// adapter in between; a later launch finds it removed.
    pub(super) fn remove_adapter(&self, request: &Value) -> Result<Value> {
        let d = self.data.lock().unwrap();
        if let Some(id) = request["id"].as_str()
            && let Some(message) =
                Self::provider_in_use(&d, &ade_runtime::adapters::provider_id(id))?
        {
            return Ok(conflict(message));
        }
        self.adapters.command(request)
    }

    /// `plugin.uninstall`: refused while a run uses the plugin's provider.
    /// Once the plugin is disabled, idle conversations give up their leases,
    /// so their history stays readable but they cannot run again. The leases
    /// end inside the admitted uninstall, never before it: a refused
    /// uninstall leaves each conversation on the generation it started on.
    pub(super) fn uninstall_plugin(
        &self,
        plugins: &crate::plugins::Plugins,
        request: &Value,
    ) -> Result<Value> {
        let d = self.data.lock().unwrap();
        let Some(id) = request["plugin_id"].as_str() else {
            return plugins.command(request);
        };
        let provider = ade_runtime::provider::registry::plugin_provider_id(id);
        if let Some(message) = Self::provider_in_use(&d, &provider)? {
            return Ok(conflict(message));
        }
        let live = plugins
            .provider_workers()?
            .iter()
            .any(|(_, worker)| worker.pin.plugin_id == id);
        let idle: Vec<String> = if live {
            Vec::new()
        } else {
            d.store
                .catalog()?
                .conversations
                .into_iter()
                .filter(|conversation| conversation.provider == provider)
                .map(|conversation| conversation.id)
                .collect()
        };
        plugins.uninstall_releasing(request, &idle)
    }
}
