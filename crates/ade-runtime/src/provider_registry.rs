//! The one provider interface every provider registers through (F023).
//!
//! Claude Code, Codex and Oh My Pi, the generic ACP and custom
//! executable adapters, and installed plugin workers all register a
//! [`ProviderEntry`] in a [`Registry`] through [`Registry::register`]. Bundled
//! providers get no other path: [`crate::provider::spawn`] resolves them
//! through [`bundled`], and the namespace and replacement rules in [`decide`]
//! apply to every origin alike (architecture sections 7 and 8).
//!
//! The interface has two halves:
//!
//! - [`ProviderEntry`], per provider: its descriptor (what a launch may ask
//!   for), capability record, readiness requirements, native process scope
//!   and `launch`, which starts one owned native process.
//! - [`Provider`], per started process: `open` launches a new native session
//!   or resumes a versioned native handle and returns normalized history
//!   ([`crate::provider::Item`], native IDs kept as provenance); `send` and
//!   `steer` submit turns; `cancel` interrupts; `answer` settles questions
//!   and approvals.
//!
//! Attaching is the runtime supervisor's job, not an entry's: a client
//! re-attaches to a run through the acknowledged event journal in
//! [`crate::agent_runtime`], identically for every origin. An entry declares
//! only whether its native process may be shared ([`ProcessScope`]).
//!
//! Leases (architecture section 8): a plugin worker session stays on the
//! artifact that started it. [`lease`] decides which artifact a new or
//! resumed session runs on and refuses rather than silently moving a session
//! to another version; [`retirable`] decides when an old artifact may go.
//!
//! Pattern studied from Paseo `packages/plugin/src/server/provider.ts`
//! (Apache-2.0): one registration contract for every provider, with protocol
//! versions negotiated at connect. No code copied.
use crate::capabilities::{CapabilityRecord, Executable};
use crate::provider::{Descriptor, Event, Provider};
use ade_core::contract::providers::{
    ProviderOrigin, ProviderRegistrationView, ProviderWorkerInitialize, ProviderWorkerPin,
    RegistrationState,
};
use ade_core::model::AccountExecution;
use anyhow::{Result, bail, ensure};
use std::sync::{Arc, OnceLock, mpsc};

/// The prefix of every plugin provider ID.
pub const PLUGIN_PREFIX: &str = "plugin:";

/// The provider ID a plugin's `provider` entry point registers under.
pub fn plugin_provider_id(plugin_id: &str) -> String {
    format!("{PLUGIN_PREFIX}{plugin_id}")
}

/// Which runs may share one native process. Every current entry starts one
/// process per run; a shared scope needs its own lifetime rules first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessScope {
    Run,
}

/// What one provider offers the runtime.
pub trait ProviderEntry: Send + Sync {
    /// The settings a launch may ask for. `Config::validate_against` checks
    /// a launch against it.
    fn descriptor(&self) -> Descriptor;
    /// The declared capability record, or `None` when the provider only
    /// declares its capabilities once started (plugin workers, ACP peers).
    fn capabilities(&self) -> Option<CapabilityRecord> {
        None
    }
    /// The executables a launch needs, checked without running them.
    fn installation(&self) -> &'static [Executable] {
        &[]
    }
    fn process_scope(&self) -> ProcessScope {
        ProcessScope::Run
    }
    /// What the provider's worker declares at its `initialize` handshake, when
    /// it is known without starting it: a bundled worker answers with exactly
    /// this descriptor. `None` for a provider known only once started.
    fn worker_descriptor(&self) -> Option<ProviderWorkerInitialize> {
        None
    }
    /// Starts one owned native process. `account` already belongs to this
    /// provider; [`Registry::launch`] checks that before calling.
    fn launch(
        &self,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<dyn Provider>>;
}

/// What the registry does with one registration request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing holds the ID; register it.
    Register,
    /// The same origin already holds it; nothing changes.
    Unchanged,
    /// A newer registration from the same owner replaces the current one.
    /// Runs already started keep the entry they launched with.
    Replace,
    Refuse(String),
}

/// Why `id` may not be registered by `origin`, if it may not. Each origin
/// owns one namespace, so no registration can shadow another origin's ID.
pub fn namespace_problem(id: &str, origin: &ProviderOrigin) -> Option<String> {
    let local = |value: &str| {
        !value.is_empty()
            && value.len() <= 64
            && value.starts_with(|c: char| c.is_ascii_lowercase())
            && value
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    match origin {
        ProviderOrigin::Bundled => {
            (!local(id)).then(|| format!("Bundled provider ID {id} must be a bare lowercase name"))
        }
        ProviderOrigin::Adapter { adapter_id, .. } => {
            let expected = crate::adapters::provider_id(adapter_id);
            (id != expected).then(|| format!("Adapter {adapter_id} registers as {expected}"))
        }
        ProviderOrigin::Plugin { pin } => {
            let expected = plugin_provider_id(&pin.plugin_id);
            if id != expected {
                Some(format!("Plugin {} registers as {expected}", pin.plugin_id))
            } else if pin.version.is_empty() || !pin.artifact_digest.starts_with("sha256:") {
                Some(format!(
                    "Plugin {} registration lacks a version or artifact digest",
                    pin.plugin_id
                ))
            } else {
                None
            }
        }
    }
}

/// Decides a registration of `incoming` under an ID `existing` may already
/// hold. Only the owner that holds an ID may replace it, and only with a
/// newer registration: a late registration from an older activation or
/// adapter revision never displaces a newer one.
pub fn decide(existing: Option<&ProviderOrigin>, incoming: &ProviderOrigin) -> Decision {
    use ProviderOrigin::*;
    let Some(existing) = existing else {
        return Decision::Register;
    };
    if existing == incoming {
        return Decision::Unchanged;
    }
    match (existing, incoming) {
        (
            Adapter {
                adapter_id: held,
                revision: current,
            },
            Adapter {
                adapter_id,
                revision,
            },
        ) if held == adapter_id => {
            if revision > current {
                Decision::Replace
            } else {
                Decision::Refuse(format!(
                    "Adapter {adapter_id} revision {revision} is not newer than registered revision {current}"
                ))
            }
        }
        (Plugin { pin: held }, Plugin { pin }) if held.plugin_id == pin.plugin_id => {
            if pin.activation_generation > held.activation_generation {
                Decision::Replace
            } else {
                Decision::Refuse(format!(
                    "Plugin {} activation {} is not newer than registered activation {}",
                    pin.plugin_id, pin.activation_generation, held.activation_generation
                ))
            }
        }
        _ => Decision::Refuse("Another provider already holds this ID".into()),
    }
}

/// Whether `requester` may remove a registration `existing` holds. Only the
/// exact origin that registered it may: late cleanup from activation 1 never
/// removes what activation 2 registered.
pub fn may_unregister(existing: &ProviderOrigin, requester: &ProviderOrigin) -> bool {
    existing == requester
}

/// Whether two pins name the same code. The activation generation is not
/// part of it: re-enabling the same artifact changes no code.
pub fn same_artifact(a: &ProviderWorkerPin, b: &ProviderWorkerPin) -> bool {
    a.plugin_id == b.plugin_id && a.version == b.version && a.artifact_digest == b.artifact_digest
}

/// Which worker artifact a session runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseDecision {
    /// A new session takes the current registration and leases it.
    Start(ProviderWorkerPin),
    /// An existing session stays on the artifact it leased, even when a newer
    /// version is registered for new sessions.
    Keep(ProviderWorkerPin),
    /// Fail closed: nothing is launched, and the session is not moved.
    Refuse(String),
}

/// Decides which worker artifact serves a session. `leased` is the pin the
/// session started on (none for a new session); `current` is the plugin's
/// live registration; `retained` lists artifacts still installed on this host.
pub fn lease(
    leased: Option<&ProviderWorkerPin>,
    current: Option<&ProviderWorkerPin>,
    retained: &[ProviderWorkerPin],
) -> LeaseDecision {
    match (leased, current) {
        (None, Some(current)) => LeaseDecision::Start(current.clone()),
        (None, None) => LeaseDecision::Refuse(
            "No enabled plugin registers this provider; enable the plugin first".into(),
        ),
        (Some(leased), _) => {
            if let Some(current) = current.filter(|current| same_artifact(current, leased)) {
                LeaseDecision::Keep(current.clone())
            } else if retained.iter().any(|kept| same_artifact(kept, leased)) {
                LeaseDecision::Keep(leased.clone())
            } else {
                LeaseDecision::Refuse(format!(
                    "Plugin {} version {} started this session and is no longer installed; ADE does not move a session to another provider version",
                    leased.plugin_id, leased.version
                ))
            }
        }
    }
}

/// Whether an artifact may be removed: no active session leases it.
pub fn retirable(artifact: &ProviderWorkerPin, active: &[ProviderWorkerPin]) -> bool {
    !active.iter().any(|lease| same_artifact(lease, artifact))
}

/// One registered provider.
#[derive(Clone)]
pub struct Registered {
    pub id: String,
    pub origin: ProviderOrigin,
    pub entry: Arc<dyn ProviderEntry>,
}

/// Registered providers in registration order.
#[derive(Clone, Default)]
pub struct Registry {
    entries: Vec<Registered>,
}

impl Registry {
    /// Registers `entry` under `id` for `origin`, applying [`namespace_problem`]
    /// and [`decide`]. Returns the decision taken; a refusal is an error.
    pub fn register(
        &mut self,
        id: &str,
        origin: ProviderOrigin,
        entry: Arc<dyn ProviderEntry>,
    ) -> Result<Decision> {
        if let Some(problem) = namespace_problem(id, &origin) {
            bail!(problem);
        }
        ensure!(
            entry.descriptor().id == id,
            "Provider entry describes {} but registers as {id}",
            entry.descriptor().id
        );
        let index = self.entries.iter().position(|r| r.id == id);
        let decision = decide(index.map(|i| &self.entries[i].origin), &origin);
        let registered = Registered {
            id: id.to_owned(),
            origin,
            entry,
        };
        match (&decision, index) {
            (Decision::Refuse(reason), _) => bail!("{reason}"),
            (Decision::Register, _) => self.entries.push(registered),
            (Decision::Replace, Some(index)) => self.entries[index] = registered,
            _ => {}
        }
        Ok(decision)
    }

    /// Removes `id` if `origin` registered it. Returns whether it was removed.
    pub fn unregister(&mut self, id: &str, origin: &ProviderOrigin) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|r| !(r.id == id && may_unregister(&r.origin, origin)));
        self.entries.len() != before
    }

    pub fn get(&self, id: &str) -> Option<&Registered> {
        self.entries.iter().find(|r| r.id == id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Registered> {
        self.entries.iter()
    }

    /// Starts `id` for one run. The account must belong to this provider.
    pub fn launch(
        &self,
        id: &str,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<dyn Provider>> {
        if let Some(account) = account {
            ensure!(
                account.provider == id,
                "Agent account belongs to another provider"
            );
        }
        let Some(registered) = self.get(id) else {
            bail!("Unsupported provider {id}");
        };
        registered.entry.launch(cwd, account, events)
    }
}

/// A provider shipped with ADE. Its launch is the adapter's own; the entry
/// adds nothing an installed provider could not also declare.
struct Bundled {
    id: &'static str,
    capabilities: fn() -> CapabilityRecord,
    installation: &'static [Executable],
    /// The descriptor the bundled worker is given and answers `initialize` with.
    worker: fn() -> ProviderWorkerInitialize,
    launch: Launch,
}

type Launch =
    fn(&str, Option<&AccountExecution>, mpsc::SyncSender<Event>) -> Result<Arc<dyn Provider>>;

impl ProviderEntry for Bundled {
    fn descriptor(&self) -> Descriptor {
        crate::provider::descriptor(self.id)
            .cloned()
            .unwrap_or_else(|_| Descriptor {
                id: self.id.into(),
                name: self.id.into(),
                capabilities: vec![],
                permission_modes: vec![],
                setting_sources: vec![],
            })
    }
    fn capabilities(&self) -> Option<CapabilityRecord> {
        Some((self.capabilities)())
    }
    fn installation(&self) -> &'static [Executable] {
        self.installation
    }
    fn worker_descriptor(&self) -> Option<ProviderWorkerInitialize> {
        Some((self.worker)())
    }
    fn launch(
        &self,
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<dyn Provider>> {
        (self.launch)(cwd, account, events)
    }
}

fn launch_omp(
    cwd: &str,
    account: Option<&AccountExecution>,
    events: mpsc::SyncSender<Event>,
) -> Result<Arc<dyn Provider>> {
    Ok(crate::provider::worker::Worker::spawn_omp(
        cwd, account, events,
    )?)
}

fn launch_codex(
    cwd: &str,
    account: Option<&AccountExecution>,
    events: mpsc::SyncSender<Event>,
) -> Result<Arc<dyn Provider>> {
    Ok(crate::provider::worker::Worker::spawn_codex(
        cwd, account, events,
    )?)
}

fn launch_claude(
    cwd: &str,
    account: Option<&AccountExecution>,
    events: mpsc::SyncSender<Event>,
) -> Result<Arc<dyn Provider>> {
    Ok(crate::provider::worker::Worker::spawn_claude(
        cwd, account, events,
    )?)
}

/// The bundled providers, registered through [`Registry::register`] in
/// catalogue order.
pub fn bundled() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let entries = [
            Bundled {
                id: "omp",
                capabilities: crate::omp::capabilities,
                installation: crate::omp::INSTALLATION,
                worker: crate::omp::worker_descriptor,
                launch: launch_omp,
            },
            Bundled {
                id: "codex",
                capabilities: crate::codex::capabilities,
                installation: crate::codex::INSTALLATION,
                worker: crate::codex::public_descriptor,
                launch: launch_codex,
            },
            Bundled {
                id: "claude",
                capabilities: crate::claude::capabilities,
                installation: crate::claude::INSTALLATION,
                worker: crate::claude::worker_descriptor,
                launch: launch_claude,
            },
        ];
        let mut registry = Registry::default();
        for entry in entries {
            let id = entry.id;
            registry
                .register(id, ProviderOrigin::Bundled, Arc::new(entry))
                .expect("bundled providers register under distinct bare IDs");
        }
        registry
    })
}

/// A generic ACP or custom executable adapter definition (F024) as a
/// provider entry. Its capabilities come from its probe, not a static record.
pub struct AdapterEntry {
    pub definition: ade_core::contract::providers::adapters::AdapterDefinition,
}

impl ProviderEntry for AdapterEntry {
    fn descriptor(&self) -> Descriptor {
        use ade_core::contract::providers::adapters::AdapterKind;
        Descriptor {
            id: crate::adapters::provider_id(&self.definition.id),
            name: self.definition.name.clone(),
            capabilities: match self.definition.kind {
                AdapterKind::Executable => crate::adapters::executable_capabilities(),
                // An ACP peer's capabilities are known only after `initialize`.
                AdapterKind::Acp => vec![],
            },
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
            "Generic adapters use the agent's own login; ADE does not manage their accounts"
        );
        crate::adapters::spawn(&self.definition, cwd, events)
    }
}

/// Registers the bundled providers, then each adapter definition, then each
/// plugin worker, all through [`Registry::register`], and reports every
/// outcome. A refusal is reported, never dropped.
pub fn compose(
    adapters: Vec<(
        ade_core::contract::providers::adapters::AdapterDefinition,
        u64,
    )>,
    workers: Vec<(String, ade_core::contract::providers::ProviderWorker)>,
) -> (Registry, Vec<ProviderRegistrationView>) {
    let mut registry = bundled().clone();
    let mut views: Vec<ProviderRegistrationView> = registry
        .iter()
        .map(|registered| ProviderRegistrationView {
            provider: registered.id.clone(),
            name: registered.entry.descriptor().name,
            origin: registered.origin.clone(),
            state: RegistrationState::Registered,
            reason: None,
        })
        .collect();
    let mut add = |id: String, origin: ProviderOrigin, entry: Arc<dyn ProviderEntry>| {
        let name = entry.descriptor().name;
        let outcome = registry.register(&id, origin.clone(), entry);
        views.push(ProviderRegistrationView {
            provider: id,
            name,
            origin,
            state: if outcome.is_ok() {
                RegistrationState::Registered
            } else {
                RegistrationState::Refused
            },
            reason: outcome.err().map(|error| error.to_string()),
        });
    };
    for (definition, revision) in adapters {
        let origin = ProviderOrigin::Adapter {
            adapter_id: definition.id.clone(),
            revision,
        };
        add(
            crate::adapters::provider_id(&definition.id),
            origin,
            Arc::new(AdapterEntry { definition }),
        );
    }
    for (name, worker) in workers {
        let origin = ProviderOrigin::Plugin {
            pin: worker.pin.clone(),
        };
        add(
            worker.provider.clone(),
            origin,
            Arc::new(crate::provider::worker::WorkerEntry { worker, name }),
        );
    }
    (registry, views)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(version: &str, digest: &str, generation: u64) -> ProviderWorkerPin {
        ProviderWorkerPin {
            plugin_id: "acme.agent".into(),
            version: version.into(),
            artifact_digest: format!("sha256:{digest}"),
            activation_generation: generation,
        }
    }

    fn plugin(generation: u64) -> ProviderOrigin {
        ProviderOrigin::Plugin {
            pin: pin("1.0.0", "aa", generation),
        }
    }

    struct Fake(String);
    impl ProviderEntry for Fake {
        fn descriptor(&self) -> Descriptor {
            Descriptor {
                id: self.0.clone(),
                name: "Fake".into(),
                capabilities: vec![],
                permission_modes: vec!["default".into()],
                setting_sources: vec![],
            }
        }
        fn launch(
            &self,
            _: &str,
            _: Option<&AccountExecution>,
            _: mpsc::SyncSender<Event>,
        ) -> Result<Arc<dyn Provider>> {
            bail!("fake")
        }
    }

    #[test]
    fn bundled_providers_register_through_the_same_registry_in_catalogue_order() {
        let ids: Vec<_> = bundled().iter().map(|r| r.id.as_str()).collect();
        let catalogue: Vec<_> = crate::provider::descriptors()
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        assert_eq!(ids, catalogue);
        for registered in bundled().iter() {
            assert_eq!(registered.origin, ProviderOrigin::Bundled);
            let record = registered.entry.capabilities().unwrap();
            assert_eq!(record.provider, registered.id);
            assert_eq!(registered.entry.descriptor().id, registered.id);
            assert!(!registered.entry.installation().is_empty());
        }
    }

    #[test]
    fn each_origin_owns_its_namespace() {
        let adapter = ProviderOrigin::Adapter {
            adapter_id: "x".into(),
            revision: 1,
        };
        assert!(namespace_problem("claude", &ProviderOrigin::Bundled).is_none());
        assert!(namespace_problem("plugin:acme.agent", &ProviderOrigin::Bundled).is_some());
        assert!(namespace_problem("adapter:x", &ProviderOrigin::Bundled).is_some());
        assert!(namespace_problem("adapter:x", &adapter).is_none());
        assert!(namespace_problem("claude", &adapter).is_some());
        assert!(namespace_problem("plugin:acme.agent", &plugin(1)).is_none());
        // A plugin can never take a bundled or adapter ID.
        assert!(namespace_problem("claude", &plugin(1)).is_some());
        assert!(namespace_problem("adapter:x", &plugin(1)).is_some());
        assert!(namespace_problem("plugin:other.agent", &plugin(1)).is_some());
        let unpinned = ProviderOrigin::Plugin {
            pin: ProviderWorkerPin {
                artifact_digest: "aa".into(),
                ..pin("1.0.0", "aa", 1)
            },
        };
        assert!(namespace_problem("plugin:acme.agent", &unpinned).is_some());
    }

    #[test]
    fn only_a_newer_registration_from_the_same_owner_replaces() {
        assert_eq!(decide(None, &plugin(1)), Decision::Register);
        assert_eq!(decide(Some(&plugin(1)), &plugin(1)), Decision::Unchanged);
        assert_eq!(decide(Some(&plugin(1)), &plugin(2)), Decision::Replace);
        assert!(matches!(
            decide(Some(&plugin(2)), &plugin(1)),
            Decision::Refuse(_)
        ));
        let other = ProviderOrigin::Plugin {
            pin: ProviderWorkerPin {
                plugin_id: "other.agent".into(),
                ..pin("1.0.0", "aa", 5)
            },
        };
        assert!(matches!(
            decide(Some(&plugin(1)), &other),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            decide(Some(&ProviderOrigin::Bundled), &plugin(1)),
            Decision::Refuse(_)
        ));
        let adapter = |revision| ProviderOrigin::Adapter {
            adapter_id: "x".into(),
            revision,
        };
        assert_eq!(decide(Some(&adapter(1)), &adapter(2)), Decision::Replace);
        assert!(matches!(
            decide(Some(&adapter(2)), &adapter(2 - 1)),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn late_cleanup_never_removes_a_newer_registration() {
        let mut registry = Registry::default();
        let id = "plugin:acme.agent";
        let entry = || Arc::new(Fake(id.into())) as Arc<dyn ProviderEntry>;
        assert_eq!(
            registry.register(id, plugin(1), entry()).unwrap(),
            Decision::Register
        );
        assert_eq!(
            registry.register(id, plugin(2), entry()).unwrap(),
            Decision::Replace
        );
        assert!(registry.register(id, plugin(1), entry()).is_err());
        assert!(!registry.unregister(id, &plugin(1)));
        assert_eq!(registry.get(id).unwrap().origin, plugin(2));
        assert!(registry.unregister(id, &plugin(2)));
        assert!(registry.get(id).is_none());
        // The entry must describe the ID it registers under.
        assert!(
            registry
                .register(id, plugin(3), Arc::new(Fake("plugin:x.y".into())))
                .is_err()
        );
    }

    #[test]
    fn launch_refuses_unknown_providers() {
        let (events, _) = mpsc::sync_channel(1);
        let error = bundled()
            .launch("nope", "/tmp", None, events)
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "Unsupported provider nope");
    }

    #[test]
    fn sessions_stay_on_the_artifact_that_started_them() {
        let v1 = pin("1.0.0", "aa", 1);
        let v2 = pin("2.0.0", "bb", 2);
        // New sessions take the current version.
        assert_eq!(
            lease(None, Some(&v2), &[v1.clone(), v2.clone()]),
            LeaseDecision::Start(v2.clone())
        );
        assert!(matches!(lease(None, None, &[]), LeaseDecision::Refuse(_)));
        // A session on v1 stays on v1 while v1 is retained, even though v2 is current.
        assert_eq!(
            lease(Some(&v1), Some(&v2), &[v1.clone(), v2.clone()]),
            LeaseDecision::Keep(v1.clone())
        );
        // It is refused, not moved, once v1 is gone.
        assert!(matches!(
            lease(Some(&v1), Some(&v2), std::slice::from_ref(&v2)),
            LeaseDecision::Refuse(_)
        ));
        // Re-enabling the same artifact is the same code, under the new activation.
        let reenabled = pin("1.0.0", "aa", 7);
        assert_eq!(
            lease(Some(&v1), Some(&reenabled), &[]),
            LeaseDecision::Keep(reenabled)
        );
        // Same version string, different bytes: not the leased code.
        let rebuilt = pin("1.0.0", "cc", 8);
        assert!(matches!(
            lease(Some(&v1), Some(&rebuilt), std::slice::from_ref(&rebuilt)),
            LeaseDecision::Refuse(_)
        ));
    }

    #[test]
    fn compose_reports_every_origin_and_refusal() {
        use ade_core::contract::providers::ProviderWorker;
        let definition = serde_json::from_value(serde_json::json!({
            "id": "my-agent", "name": "My agent", "kind": "acp",
            "command": "/usr/local/bin/my-agent"
        }))
        .unwrap();
        let worker = |plugin_id: &str, provider: &str| ProviderWorker {
            provider: provider.into(),
            pin: ProviderWorkerPin {
                plugin_id: plugin_id.into(),
                ..pin("1.0.0", "aa", 1)
            },
            artifact_path: "/a".into(),
            entry: "p.js".into(),
        };
        let (registry, views) = compose(
            vec![(definition, 3)],
            vec![
                ("Agent".into(), worker("acme.agent", "plugin:acme.agent")),
                ("Rogue".into(), worker("rogue.agent", "claude")),
            ],
        );
        let states: Vec<_> = views
            .iter()
            .map(|v| (v.provider.as_str(), v.state))
            .collect();
        assert_eq!(
            states,
            [
                ("omp", RegistrationState::Registered),
                ("codex", RegistrationState::Registered),
                ("claude", RegistrationState::Registered),
                ("adapter:my-agent", RegistrationState::Registered),
                ("plugin:acme.agent", RegistrationState::Registered),
                ("claude", RegistrationState::Refused),
            ]
        );
        assert!(
            views[5]
                .reason
                .as_deref()
                .unwrap()
                .contains("plugin:rogue.agent")
        );
        assert_eq!(
            registry.get("claude").unwrap().origin,
            ProviderOrigin::Bundled
        );
        assert_eq!(registry.iter().count(), 5);
    }

    #[test]
    fn an_artifact_is_retired_only_without_active_leases() {
        let v1 = pin("1.0.0", "aa", 1);
        let v2 = pin("2.0.0", "bb", 2);
        assert!(retirable(&v1, std::slice::from_ref(&v2)));
        assert!(!retirable(&v1, &[pin("1.0.0", "aa", 9)]));
        assert!(retirable(&v1, &[]));
    }
}
