//! The activation registry: which activation owns each registration.
//!
//! Every handle carries the activation (plugin ID and generation) that created
//! it. Removal matches the whole activation, so late cleanup from generation 1
//! can never remove a registration that generation 2 now owns. The registry is
//! plain data: it runs no plugin callbacks, so holding its lock never waits on
//! plugin code.
//!
//! Pattern studied from Orca `src/main/plugins/plugin-command-registry.test.ts`
//! and OpenCode `packages/core/src/plugin.ts` (both MIT); no code copied.
use ade_core::contract::plugins::{PluginRegistration, PluginRegistrationKind};
use std::collections::{BTreeMap, HashMap};

/// One activation of one plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activation {
    pub plugin_id: String,
    pub generation: u64,
}

/// A registration handle. Only the activation that created it can remove it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handle {
    pub activation: Activation,
    pub kind: PluginRegistrationKind,
    pub id: String,
}

/// Whether a generation may still act for its plugin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fence {
    Current,
    Stale,
}

/// Compares an activation's generation with the plugin's current one.
pub fn fence(current: Option<u64>, generation: u64) -> Fence {
    if current == Some(generation) {
        Fence::Current
    } else {
        Fence::Stale
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryError {
    /// The generation is not above every generation already seen for the plugin.
    GenerationReused { plugin_id: String, generation: u64 },
    /// The activation has been superseded or deactivated.
    Stale(Activation),
    /// Another plugin already holds this registration.
    Conflict {
        kind: PluginRegistrationKind,
        id: String,
        owner: String,
    },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GenerationReused {
                plugin_id,
                generation,
            } => write!(
                f,
                "Plugin {plugin_id} activation generation {generation} was already used"
            ),
            Self::Stale(activation) => write!(
                f,
                "Plugin {} activation {} is no longer current",
                activation.plugin_id, activation.generation
            ),
            Self::Conflict { kind, id, owner } => {
                let kind = match kind {
                    PluginRegistrationKind::Command => "command",
                    PluginRegistrationKind::Panel => "panel",
                };
                write!(f, "The {kind} {id} is already registered by plugin {owner}")
            }
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Default)]
pub struct Registry {
    /// The current generation of each active plugin.
    current: HashMap<String, u64>,
    /// The highest generation ever activated per plugin; it only rises.
    highest: HashMap<String, u64>,
    entries: BTreeMap<(PluginRegistrationKind, String), Handle>,
}

impl Registry {
    /// Starts `generation` for its plugin and supersedes any earlier
    /// activation. Handles of the earlier one stay until it is cleaned up or
    /// the new one registers the same IDs.
    pub fn activate(
        &mut self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<Activation, RegistryError> {
        if self
            .highest
            .get(plugin_id)
            .is_some_and(|highest| generation <= *highest)
        {
            return Err(RegistryError::GenerationReused {
                plugin_id: plugin_id.to_owned(),
                generation,
            });
        }
        self.highest.insert(plugin_id.to_owned(), generation);
        self.current.insert(plugin_id.to_owned(), generation);
        Ok(Activation {
            plugin_id: plugin_id.to_owned(),
            generation,
        })
    }

    pub fn current(&self, plugin_id: &str) -> Option<u64> {
        self.current.get(plugin_id).copied()
    }

    /// Registers `(kind, id)` for a current activation. A newer activation of
    /// the same plugin takes over an ID its predecessor held; another plugin's
    /// ID is a conflict.
    pub fn register(
        &mut self,
        activation: &Activation,
        kind: PluginRegistrationKind,
        id: &str,
    ) -> Result<Handle, RegistryError> {
        if fence(self.current(&activation.plugin_id), activation.generation) == Fence::Stale {
            return Err(RegistryError::Stale(activation.clone()));
        }
        let key = (kind, id.to_owned());
        if let Some(existing) = self.entries.get(&key)
            && existing.activation.plugin_id != activation.plugin_id
        {
            return Err(RegistryError::Conflict {
                kind,
                id: id.to_owned(),
                owner: existing.activation.plugin_id.clone(),
            });
        }
        let handle = Handle {
            activation: activation.clone(),
            kind,
            id: id.to_owned(),
        };
        self.entries.insert(key, handle.clone());
        Ok(handle)
    }

    /// Removes one registration if `handle` still owns it. Returns whether it
    /// did. The plugin hosts (not built yet) call this for dynamic registrations.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn unregister(&mut self, handle: &Handle) -> bool {
        let key = (handle.kind, handle.id.clone());
        if self
            .entries
            .get(&key)
            .is_some_and(|owner| owner.activation == handle.activation)
        {
            self.entries.remove(&key);
            true
        } else {
            false
        }
    }

    /// Ends `activation`: removes only the registrations it still owns, and
    /// clears the plugin's current generation only if it is this one.
    /// Returns the removed handles.
    pub fn deactivate(&mut self, activation: &Activation) -> Vec<Handle> {
        if self.current(&activation.plugin_id) == Some(activation.generation) {
            self.current.remove(&activation.plugin_id);
        }
        let owned: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, handle)| handle.activation == *activation)
            .map(|(key, _)| key.clone())
            .collect();
        owned
            .into_iter()
            .filter_map(|key| self.entries.remove(&key))
            .collect()
    }

    /// The registrations the plugin's current activation owns.
    pub fn registrations(&self, plugin_id: &str) -> Vec<PluginRegistration> {
        let Some(generation) = self.current(plugin_id) else {
            return Vec::new();
        };
        self.entries
            .values()
            .filter(|handle| {
                handle.activation.plugin_id == plugin_id
                    && handle.activation.generation == generation
            })
            .map(|handle| PluginRegistration {
                kind: handle.kind,
                id: handle.id.clone(),
            })
            .collect()
    }

    /// Why [`Registry::activate_all`] would refuse these arguments, without
    /// changing anything. A reload asks before it commits its generation.
    pub fn refusal(
        &self,
        plugin_id: &str,
        generation: u64,
        contributions: &[(PluginRegistrationKind, String)],
    ) -> Option<RegistryError> {
        if self
            .highest
            .get(plugin_id)
            .is_some_and(|highest| generation <= *highest)
        {
            return Some(RegistryError::GenerationReused {
                plugin_id: plugin_id.to_owned(),
                generation,
            });
        }
        contributions.iter().find_map(|(kind, id)| {
            self.entries
                .get(&(*kind, id.clone()))
                .filter(|existing| existing.activation.plugin_id != plugin_id)
                .map(|existing| RegistryError::Conflict {
                    kind: *kind,
                    id: id.clone(),
                    owner: existing.activation.plugin_id.clone(),
                })
        })
    }

    /// Activates `generation` and registers every `(kind, id)`, or changes
    /// nothing. Conflicts are checked before any mutation, so a refused
    /// activation neither consumes its generation nor disturbs the current one.
    pub fn activate_all(
        &mut self,
        plugin_id: &str,
        generation: u64,
        contributions: &[(PluginRegistrationKind, String)],
    ) -> Result<Activation, RegistryError> {
        if let Some(error) = self.refusal(plugin_id, generation, contributions) {
            return Err(error);
        }
        let activation = self.activate(plugin_id, generation)?;
        for (kind, id) in contributions {
            self.register(&activation, *kind, id)?;
        }
        Ok(activation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PluginRegistrationKind::{Command, Panel};

    #[test]
    fn late_cleanup_from_an_old_generation_leaves_the_new_one_intact() {
        let mut registry = Registry::default();
        let v1 = registry.activate("acme.notes", 1).unwrap();
        let old = registry.register(&v1, Command, "acme.notes.open").unwrap();
        registry.register(&v1, Panel, "acme.notes.side").unwrap();
        let v2 = registry.activate("acme.notes", 2).unwrap();
        registry.register(&v2, Command, "acme.notes.open").unwrap();

        // Generation 1 is stale: it can no longer register.
        assert_eq!(
            registry.register(&v1, Command, "acme.notes.late"),
            Err(RegistryError::Stale(v1.clone()))
        );
        // Its late cleanup removes what it still owns and nothing of generation 2.
        assert!(!registry.unregister(&old));
        let removed = registry.deactivate(&v1);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "acme.notes.side");
        assert_eq!(registry.current("acme.notes"), Some(2));
        assert_eq!(
            registry.registrations("acme.notes"),
            vec![PluginRegistration {
                kind: Command,
                id: "acme.notes.open".into()
            }]
        );
    }

    #[test]
    fn generations_only_rise() {
        let mut registry = Registry::default();
        let v2 = registry.activate("a.b", 2).unwrap();
        registry.deactivate(&v2);
        assert!(matches!(
            registry.activate("a.b", 2),
            Err(RegistryError::GenerationReused { .. })
        ));
        assert!(matches!(
            registry.activate("a.b", 1),
            Err(RegistryError::GenerationReused { .. })
        ));
        assert!(registry.activate("a.b", 3).is_ok());
        assert_eq!(fence(Some(3), 3), Fence::Current);
        assert_eq!(fence(Some(3), 2), Fence::Stale);
        assert_eq!(fence(None, 3), Fence::Stale);
    }

    #[test]
    fn another_plugins_id_is_a_conflict_and_rolls_back_only_the_new_activation() {
        let mut registry = Registry::default();
        registry
            .activate_all("a.one", 1, &[(Command, "shared.cmd".into())])
            .unwrap();
        let error = registry
            .activate_all(
                "b.two",
                1,
                &[(Panel, "b.two.side".into()), (Command, "shared.cmd".into())],
            )
            .unwrap_err();
        assert_eq!(
            error,
            RegistryError::Conflict {
                kind: Command,
                id: "shared.cmd".into(),
                owner: "a.one".into()
            }
        );
        assert_eq!(registry.current("b.two"), None);
        assert!(registry.registrations("b.two").is_empty());
        assert_eq!(registry.registrations("a.one").len(), 1);
    }

    #[test]
    fn a_refused_reload_changes_nothing() {
        let mut registry = Registry::default();
        registry
            .activate_all("a.one", 1, &[(Command, "x.cmd".into())])
            .unwrap();
        registry
            .activate_all("b.two", 1, &[(Command, "b.two.cmd".into())])
            .unwrap();
        assert!(
            registry
                .activate_all(
                    "b.two",
                    2,
                    &[(Command, "b.two.cmd".into()), (Command, "x.cmd".into())]
                )
                .is_err()
        );
        assert_eq!(registry.current("b.two"), Some(1));
        assert_eq!(registry.registrations("b.two").len(), 1);
        assert!(registry.activate("b.two", 2).is_ok());
    }

    #[test]
    fn a_reload_takes_over_kept_ids_and_old_cleanup_drops_only_removed_ones() {
        let mut registry = Registry::default();
        let v1 = registry
            .activate_all(
                "a.b",
                1,
                &[(Command, "a.b.keep".into()), (Command, "a.b.gone".into())],
            )
            .unwrap();
        let next = [(Command, "a.b.keep".into()), (Panel, "a.b.new".into())];
        assert_eq!(registry.refusal("a.b", 2, &next), None);
        assert!(registry.refusal("a.b", 1, &next).is_some());
        registry.activate_all("a.b", 2, &next).unwrap();
        let removed = registry.deactivate(&v1);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "a.b.gone");
        assert_eq!(registry.current("a.b"), Some(2));
        assert_eq!(registry.registrations("a.b").len(), 2);
    }

    #[test]
    fn deactivating_the_current_generation_clears_it() {
        let mut registry = Registry::default();
        let v1 = registry
            .activate_all("a.b", 1, &[(Command, "a.b.c".into())])
            .unwrap();
        assert_eq!(registry.deactivate(&v1).len(), 1);
        assert_eq!(registry.current("a.b"), None);
        assert!(registry.deactivate(&v1).is_empty());
    }
}
