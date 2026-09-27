//! Shared pieces of the adapters' capability declarations (F028, decision D04).
//!
//! Each adapter module declares its own record and installation requirements;
//! [`records`] and [`installation`] only collect them.
pub use ade_core::contract::providers::{
    Capability, CapabilityRecord, ConversationCapabilities, GrantCapabilities, ModelCapabilities,
    ModelFormat, PermissionModeCapability, ReasoningCapabilities, Support,
};

/// An executable a provider needs on this host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Executable {
    /// `executable:<name>` for the provider CLI, `runtime:<name>` for the
    /// bridge's script runtime.
    pub check: &'static str,
    /// The environment variable that overrides the executable.
    pub env: &'static str,
    /// The name looked up on `PATH`. `None` means ADE ships it, so only an
    /// override set in `env` is checked.
    pub default: Option<&'static str>,
}

/// Every adapter's declaration, in catalogue order. Fingerprints are empty;
/// the daemon computes them.
pub fn records() -> Vec<CapabilityRecord> {
    vec![
        crate::omp::capabilities(),
        crate::opencode::capabilities(),
        crate::codex::capabilities(),
        crate::claude::capabilities(),
    ]
}

/// The executables `provider` needs, or `None` for an unknown provider.
pub fn installation(provider: &str) -> Option<&'static [Executable]> {
    match provider {
        "claude" => Some(crate::claude::INSTALLATION),
        "codex" => Some(crate::codex::INSTALLATION),
        "omp" => Some(crate::omp::INSTALLATION),
        "opencode" => Some(crate::opencode::INSTALLATION),
        _ => None,
    }
}

pub(crate) fn capability(support: Support, note: &str) -> Capability {
    Capability::new(support, note)
}

pub(crate) fn mode(id: &str, support: Support, description: &str) -> PermissionModeCapability {
    PermissionModeCapability {
        id: id.into(),
        support,
        description: description.into(),
    }
}

pub(crate) fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_match_the_descriptors_launches_validate_against() {
        let records = records();
        let descriptors = ade_core::provider::descriptors();
        assert_eq!(records.len(), descriptors.len());
        for (record, descriptor) in records.iter().zip(descriptors) {
            assert_eq!(record.provider, descriptor.id);
            assert_eq!(record.name, descriptor.name);
            let selectable: Vec<_> = record
                .permission_modes
                .iter()
                .filter(|mode| mode.support == Support::Supported)
                .map(|mode| mode.id.clone())
                .collect();
            assert_eq!(
                selectable, descriptor.permission_modes,
                "{}",
                record.provider
            );
            assert!(record.fingerprint.is_empty());
            assert!(record.revision >= 1);
            assert!(installation(&record.provider).is_some());
        }
    }

    #[test]
    fn reasoning_levels_are_only_declared_selectable_when_a_launch_can_carry_them() {
        // `provider::Config` has no reasoning field yet, so no adapter may
        // claim reasoning selection until one is added end to end.
        for record in records() {
            assert_ne!(
                record.reasoning.selection.support,
                Support::Supported,
                "{}",
                record.provider
            );
        }
    }
}
