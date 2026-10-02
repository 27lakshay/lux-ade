//! Pure decisions for provider capabilities, presets, readiness and quota.
//! Nothing here reads the clock, the filesystem or a database.
use ade_core::contract::providers::*;
use ade_core::contract::usage::UsageLimitWindow;
use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const MAX_NAME_CHARS: usize = 80;
const MAX_MODEL_BYTES: usize = 256;
const MAX_REASONING_BYTES: usize = 64;

/// Fills in the record's fingerprint: SHA-256 over its JSON with an empty
/// fingerprint. Field order is fixed by the struct, so equal records match.
pub fn seal(mut record: CapabilityRecord) -> CapabilityRecord {
    record.fingerprint = String::new();
    let bytes = serde_json::to_vec(&record).expect("capability records serialize");
    let digest = Sha256::digest(&bytes);
    record.fingerprint = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    record
}

/// The capability record of a provider registered outside the static
/// catalogue (a generic adapter or a plugin worker), built from the
/// descriptor its registry entry publishes. Only what the descriptor states
/// is claimed: a listed capability is supported, a descriptor capability it
/// omits is unsupported, and anything the descriptor cannot express is
/// unknown. Steering, rewind, compaction and managed accounts follow the
/// operations its worker declares (`operations`), with the worker's own
/// reason; without a declaration they are unknown.
pub fn registered_record(
    descriptor: &ade_core::provider::Descriptor,
    operations: Option<&[ade_core::contract::providers::ProviderWorkerOperation]>,
) -> CapabilityRecord {
    use ade_core::contract::providers::{ProviderWorkerAvailability, ProviderWorkerMethod};
    let operation = |method: ProviderWorkerMethod| {
        let Some(operations) = operations else {
            return Capability::new(
                Support::Unknown,
                "The provider's worker has not declared its operations yet",
            );
        };
        match operations
            .iter()
            .find(|operation| operation.method == method)
        {
            Some(operation) if operation.availability == ProviderWorkerAvailability::Available => {
                Capability::new(Support::Supported, "Declared by the provider's worker")
            }
            Some(operation) if !operation.reason.is_empty() => {
                Capability::new(Support::Unsupported, &operation.reason)
            }
            _ => Capability::new(
                Support::Unsupported,
                "The provider's worker does not declare this operation",
            ),
        }
    };
    let declares = |name: &str| descriptor.capabilities.iter().any(|c| c == name);
    let unknown = || {
        Capability::new(
            Support::Unknown,
            "The provider's registration does not declare this",
        )
    };
    let declared = |name: &str| {
        if declares(name) {
            Capability::new(
                Support::Supported,
                "Declared by the provider's registration",
            )
        } else {
            Capability::new(
                Support::Unsupported,
                "The provider's registration does not offer this",
            )
        }
    };
    let approvals = ["tool_approval", "command_approval", "file_approval"];
    seal(CapabilityRecord {
        provider: descriptor.id.clone(),
        name: descriptor.name.clone(),
        revision: 0,
        fingerprint: String::new(),
        checked_against: "Descriptor published by the provider registry".into(),
        models: ModelCapabilities {
            selection: unknown(),
            format: ModelFormat::NativeId,
            aliases: vec![],
            discovery: unknown(),
        },
        reasoning: ReasoningCapabilities {
            selection: unknown(),
            levels: vec![],
            varies_by_model: false,
        },
        permission_modes: descriptor
            .permission_modes
            .iter()
            .map(|mode| PermissionModeCapability {
                id: mode.clone(),
                support: Support::Supported,
                description: "Declared by the provider's registration".into(),
            })
            .collect(),
        grants: GrantCapabilities {
            once: if approvals.iter().any(|name| declares(name)) {
                Capability::new(
                    Support::Supported,
                    "Declared by the provider's registration",
                )
            } else {
                unknown()
            },
            session: unknown(),
            persistent: unknown(),
        },
        conversation: ConversationCapabilities {
            steering: operation(ProviderWorkerMethod::Steer),
            rewind: operation(ProviderWorkerMethod::Rewind),
            compaction: operation(ProviderWorkerMethod::Compact),
            resume: declared("resume"),
            import: unknown(),
            fork: unknown(),
            account_switch: Capability::new(
                Support::Unsupported,
                "ADE moves a conversation to another account only for a bundled provider",
            ),
        },
        quota: unknown(),
        managed_accounts: operation(ProviderWorkerMethod::AccountInspect),
    })
}

/// How the current record differs from the one a preset was saved against.
pub fn compare(
    saved_revision: u32,
    saved_fingerprint: &str,
    current: &CapabilityRecord,
) -> CapabilityChange {
    use std::cmp::Ordering::*;
    match current.revision.cmp(&saved_revision) {
        Greater => CapabilityChange::Revised,
        Less => CapabilityChange::Downgraded,
        Equal if current.fingerprint == saved_fingerprint => CapabilityChange::Unchanged,
        Equal => CapabilityChange::Drifted,
    }
}

/// Trims a preset name and refuses one that is empty, too long or holds
/// control characters.
pub fn preset_name(name: &str) -> Result<String> {
    let name = name.trim();
    ensure!(!name.is_empty(), "Missing name");
    ensure!(
        name.chars().count() <= MAX_NAME_CHARS,
        "Preset name must be at most {MAX_NAME_CHARS} characters"
    );
    ensure!(
        !name.chars().any(char::is_control),
        "Preset name must not contain control characters"
    );
    Ok(name.to_owned())
}

fn conflict(field: PresetField, message: String) -> PresetConflict {
    PresetConflict { field, message }
}

fn plain_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

/// Every reason `settings` cannot launch on the provider `record` describes.
/// Only choices the record marks `supported` pass: a capability the provider
/// has natively but ADE cannot select is a conflict, not a silent no-op.
pub fn validate(settings: &PresetSettings, record: &CapabilityRecord) -> Vec<PresetConflict> {
    let mut conflicts = Vec::new();
    let name = &record.name;
    if settings.provider != record.provider {
        conflicts.push(conflict(
            PresetField::Provider,
            format!("Preset is for {}, not {name}", settings.provider),
        ));
        return conflicts;
    }
    if let Some(model) = &settings.model {
        if record.models.selection.support != Support::Supported {
            conflicts.push(conflict(
                PresetField::Model,
                format!(
                    "{name} model selection is unavailable: {}",
                    record.models.selection.note
                ),
            ));
        } else if !plain_text(model, MAX_MODEL_BYTES) {
            conflicts.push(conflict(
                PresetField::Model,
                format!("Model must be 1 to {MAX_MODEL_BYTES} bytes without surrounding spaces or control characters"),
            ));
        }
    }
    if let Some(level) = &settings.reasoning {
        let reasoning = &record.reasoning;
        if reasoning.selection.support != Support::Supported {
            conflicts.push(conflict(
                PresetField::Reasoning,
                format!(
                    "{name} reasoning selection is unavailable: {}",
                    reasoning.selection.note
                ),
            ));
        } else if !plain_text(level, MAX_REASONING_BYTES)
            || !reasoning.levels.is_empty() && !reasoning.levels.contains(level)
        {
            conflicts.push(conflict(
                PresetField::Reasoning,
                format!("{name} does not offer reasoning level {level}"),
            ));
        }
    }
    match record
        .permission_modes
        .iter()
        .find(|mode| mode.id == settings.permission_mode)
    {
        Some(mode) if mode.support == Support::Supported => {}
        Some(mode) => conflicts.push(conflict(
            PresetField::PermissionMode,
            format!(
                "{name} permission mode {} is unavailable: {}",
                mode.id, mode.description
            ),
        )),
        None => conflicts.push(conflict(
            PresetField::PermissionMode,
            format!("{name} has no permission mode {}", settings.permission_mode),
        )),
    }
    conflicts
}

/// A stored preset checked against the current records. A preset whose
/// provider no longer has a record keeps its settings and reports why it
/// cannot be applied.
pub fn check(preset: Preset, records: &[CapabilityRecord]) -> CheckedPreset {
    match records
        .iter()
        .find(|record| record.provider == preset.settings.provider)
    {
        Some(record) => CheckedPreset {
            capability_change: compare(
                preset.capability_revision,
                &preset.capability_fingerprint,
                record,
            ),
            conflicts: validate(&preset.settings, record),
            preset,
        },
        None => CheckedPreset {
            capability_change: CapabilityChange::Downgraded,
            conflicts: vec![conflict(
                PresetField::Provider,
                format!("Provider {} is not available", preset.settings.provider),
            )],
            preset,
        },
    }
}

/// The settings a new Conversation takes from a checked preset. A preset
/// with any conflict is refused and never adapted; one for another provider
/// than the caller named is refused rather than switching provider. Launches
/// carry no reasoning level yet, so a preset holding one is refused too.
pub fn apply<'a>(checked: &'a CheckedPreset, provider: Option<&str>) -> Result<&'a PresetSettings> {
    let preset = &checked.preset;
    let settings = &preset.settings;
    if let Some(provider) = provider {
        ensure!(
            provider == settings.provider,
            "Preset {} is for {}, not {provider}",
            preset.name,
            settings.provider
        );
    }
    ensure!(
        checked.conflicts.is_empty(),
        "Preset {} conflicts with the current {} capabilities: {}. Update the preset and retry",
        preset.name,
        settings.provider,
        checked
            .conflicts
            .iter()
            .map(|c| c.message.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    );
    ensure!(
        settings.reasoning.is_none(),
        "Preset {} sets a reasoning level, which launches cannot carry yet",
        preset.name
    );
    Ok(settings)
}

/// What a managed account contributes to a readiness verdict.
pub struct AccountFacts<'a> {
    /// The stored account state: `unverified`, `verified` or `disabled`.
    pub state: &'a str,
    /// The pinned identity, as `account.verify` stored it.
    pub pinned: Option<Value>,
    /// The probe's result; `None` when the probe was not run.
    pub inspection: Option<Result<&'a ade_core::contract::accounts::Inspection, String>>,
}

/// The verdict for a provider's installation checks and, when given, one
/// managed account. It is `ready` only when every step was proven.
pub fn readiness(
    record: &CapabilityRecord,
    installation: &[ReadinessCheck],
    account: Option<&AccountFacts>,
) -> (ReadinessState, String) {
    let name = &record.name;
    if let Some(missing) = installation
        .iter()
        .find(|check| check.state == CheckState::Failed)
    {
        return (ReadinessState::MissingExecutable, missing.detail.clone());
    }
    let Some(account) = account else {
        let reason = if record.managed_accounts.support == Support::Supported {
            format!(
                "{name} is installed. Its version and sign-in are checked per managed account; pass an account to check them"
            )
        } else {
            format!("{name} is installed. ADE cannot check its version or sign-in before launch")
        };
        return (ReadinessState::InstalledUnchecked, reason);
    };
    if account.state == "disabled" {
        return (
            ReadinessState::AccountDisabled,
            "This account is disabled in ADE; create or choose another account".into(),
        );
    }
    let inspection = match &account.inspection {
        None => {
            return (
                ReadinessState::Unavailable,
                "The account was not checked".into(),
            );
        }
        Some(Err(error)) => {
            return (
                ReadinessState::Unavailable,
                format!("The account check failed: {error}"),
            );
        }
        Some(Ok(inspection)) => inspection,
    };
    match inspection.state.as_str() {
        "ready" => {}
        "missing_executable" => {
            return (ReadinessState::MissingExecutable, inspection.reason.clone());
        }
        "incompatible" => return (ReadinessState::Incompatible, inspection.reason.clone()),
        // The probe could not run or finish, which says nothing about the CLI.
        "unavailable" => return (ReadinessState::Unavailable, inspection.reason.clone()),
        "unauthenticated" => {
            return (
                ReadinessState::NeedsAuthentication,
                format!(
                    "{}. Sign in with the {name} CLI in this account's native home",
                    inspection.reason
                ),
            );
        }
        other => {
            return (
                ReadinessState::Unavailable,
                format!("The account check returned an unknown state {other}"),
            );
        }
    }
    match (account.state, &account.pinned, &inspection.identity) {
        ("verified", Some(pinned), Some(identity)) if pinned == identity => (
            ReadinessState::Ready,
            format!("{name} is installed, compatible and signed in as the pinned identity"),
        ),
        ("verified", Some(_), _) => (
            ReadinessState::IdentityChanged,
            "The signed-in identity differs from the pinned one; inspect and verify the account again".into(),
        ),
        _ => (
            ReadinessState::NeedsVerification,
            "The account is signed in but its identity is not pinned; verify it with account verify".into(),
        ),
    }
}

/// Whether a window reports exhaustion that has not yet reset.
fn exhausted(window: &UsageLimitWindow) -> bool {
    !window.reset_since_observed
        && (window.status.as_deref() == Some("rejected")
            || window.used_percent.is_some_and(|used| used >= 100.0))
}

/// The accounts a quota view covers for one provider.
pub struct QuotaScope<'a> {
    pub provider: Option<&'a str>,
    pub account_id: Option<&'a str>,
}

/// Groups reported windows per provider and account. Every managed account
/// and the provider's own login get an entry, so an account that never
/// reported says so rather than disappearing.
pub fn quota(
    records: &[CapabilityRecord],
    accounts: &[(String, String)],
    windows: &[UsageLimitWindow],
    scope: &QuotaScope,
    now: i64,
) -> Vec<QuotaEntry> {
    let mut entries = Vec::new();
    for record in records
        .iter()
        .filter(|record| scope.provider.is_none_or(|p| p == record.provider))
    {
        let mut keys: BTreeSet<Option<String>> = BTreeSet::new();
        match scope.account_id {
            Some(id) => {
                keys.insert(Some(id.to_owned()));
            }
            None => {
                keys.insert(None);
                keys.extend(
                    accounts
                        .iter()
                        .filter(|(provider, _)| *provider == record.provider)
                        .map(|(_, id)| Some(id.clone())),
                );
                keys.extend(
                    windows
                        .iter()
                        .filter(|w| w.provider == record.provider)
                        .map(|w| w.account_id.clone()),
                );
            }
        }
        for key in keys {
            let owned: Vec<UsageLimitWindow> = windows
                .iter()
                .filter(|w| w.provider == record.provider && w.account_id == key)
                .cloned()
                .collect();
            let observed_at = owned.iter().map(|w| w.observed_at).max();
            let (state, reason) = if !owned.is_empty() {
                (
                    QuotaState::Reported,
                    "Limits as the provider last reported them; ADE does not probe between turns"
                        .to_owned(),
                )
            } else if record.quota.support == Support::Supported {
                (
                    QuotaState::NotReported,
                    format!(
                        "{} reports limits during turns; none has arrived yet",
                        record.name
                    ),
                )
            } else {
                (
                    QuotaState::Unavailable,
                    format!(
                        "{} limits are unavailable: {}",
                        record.name, record.quota.note
                    ),
                )
            };
            entries.push(QuotaEntry {
                provider: record.provider.clone(),
                account_id: key,
                state,
                reason,
                exhausted: owned.iter().any(exhausted),
                windows: owned,
                observed_at,
                age_ms: observed_at.map(|at| (now - at).max(0)),
            });
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::accounts::Inspection;
    use serde_json::json;

    /// A plugin worker declares streaming and resume only. Its record claims
    /// those, refuses accounts, and leaves the rest unknown; readiness then
    /// says ADE cannot check it before launch rather than asking for an account.
    #[test]
    fn a_registered_provider_record_claims_only_its_declaration() {
        let descriptor = ade_core::provider::Descriptor {
            id: "plugin:e2e.agent".into(),
            name: "E2E agent".into(),
            capabilities: vec!["streaming".into(), "resume".into()],
            permission_modes: vec!["default".into()],
            setting_sources: vec![],
        };
        let record = registered_record(&descriptor, None);
        assert_eq!(record.provider, "plugin:e2e.agent");
        assert_eq!(record.conversation.resume.support, Support::Supported);
        assert_eq!(record.conversation.steering.support, Support::Unknown);
        assert_eq!(record.grants.once.support, Support::Unknown);
        assert_eq!(record.managed_accounts.support, Support::Unknown);
        assert_eq!(record.permission_modes.len(), 1);
        assert_eq!(record, seal(record.clone()));
        let (state, reason) = readiness(&record, &[], None);
        assert_eq!(state, ReadinessState::InstalledUnchecked);
        assert!(reason.contains("cannot check"));
        let mut without_resume = descriptor.clone();
        without_resume.capabilities = vec!["tool_approval".into()];
        let record = registered_record(&without_resume, None);
        assert_eq!(record.conversation.resume.support, Support::Unsupported);
        assert_eq!(record.grants.once.support, Support::Supported);
        // A worker's declared operations decide its controls and managed accounts.
        use ade_core::contract::providers::{
            ProviderWorkerAvailability as Availability, ProviderWorkerMethod as Method,
            ProviderWorkerOperation,
        };
        let declared = |method, availability, reason: &str| ProviderWorkerOperation {
            method,
            tier: ade_core::contract::Tier::Query,
            availability,
            reason: reason.into(),
        };
        let operations = [
            declared(Method::Compact, Availability::Available, ""),
            declared(Method::Steer, Availability::Unsupported, "No steer"),
            declared(Method::AccountInspect, Availability::Available, ""),
        ];
        let record = registered_record(&descriptor, Some(&operations));
        assert_eq!(record.conversation.compaction.support, Support::Supported);
        assert_eq!(record.conversation.steering.support, Support::Unsupported);
        assert_eq!(record.conversation.steering.note, "No steer");
        assert_eq!(record.conversation.rewind.support, Support::Unsupported);
        assert_eq!(record.managed_accounts.support, Support::Supported);
    }

    fn cap(support: Support) -> Capability {
        Capability::new(support, "note")
    }

    fn record() -> CapabilityRecord {
        seal(CapabilityRecord {
            provider: "p".into(),
            name: "P".into(),
            revision: 2,
            fingerprint: String::new(),
            checked_against: "v1".into(),
            models: ModelCapabilities {
                selection: cap(Support::Supported),
                format: ModelFormat::NativeId,
                aliases: vec![],
                discovery: cap(Support::NativeOnly),
            },
            reasoning: ReasoningCapabilities {
                selection: cap(Support::Supported),
                levels: vec!["low".into(), "high".into()],
                varies_by_model: false,
            },
            permission_modes: vec![
                PermissionModeCapability {
                    id: "default".into(),
                    support: Support::Supported,
                    description: "d".into(),
                },
                PermissionModeCapability {
                    id: "yolo".into(),
                    support: Support::NativeOnly,
                    description: "not offered".into(),
                },
            ],
            grants: GrantCapabilities {
                once: cap(Support::Supported),
                session: cap(Support::NativeOnly),
                persistent: cap(Support::Unknown),
            },
            conversation: ConversationCapabilities {
                steering: cap(Support::NativeOnly),
                rewind: cap(Support::NativeOnly),
                compaction: cap(Support::NativeOnly),
                resume: cap(Support::Supported),
                import: cap(Support::Unknown),
                fork: cap(Support::Unsupported),
                account_switch: cap(Support::Unknown),
            },
            quota: cap(Support::Supported),
            managed_accounts: cap(Support::Supported),
        })
    }

    fn settings(model: Option<&str>, reasoning: Option<&str>, mode: &str) -> PresetSettings {
        PresetSettings {
            provider: "p".into(),
            model: model.map(Into::into),
            reasoning: reasoning.map(Into::into),
            permission_mode: mode.into(),
        }
    }

    fn fields(conflicts: &[PresetConflict]) -> Vec<PresetField> {
        conflicts.iter().map(|c| c.field).collect()
    }

    #[test]
    fn fingerprints_are_stable_and_follow_content() {
        let a = record();
        assert_eq!(a.fingerprint.len(), 64);
        assert_eq!(seal(a.clone()).fingerprint, a.fingerprint);
        let mut b = a.clone();
        b.conversation.steering = cap(Support::Supported);
        assert_ne!(seal(b).fingerprint, a.fingerprint);
    }

    #[test]
    fn revision_comparison_names_every_kind_of_change() {
        let current = record();
        let fp = current.fingerprint.clone();
        assert_eq!(compare(2, &fp, &current), CapabilityChange::Unchanged);
        assert_eq!(compare(1, &fp, &current), CapabilityChange::Revised);
        assert_eq!(compare(3, &fp, &current), CapabilityChange::Downgraded);
        assert_eq!(compare(2, "other", &current), CapabilityChange::Drifted);
    }

    #[test]
    fn supported_settings_validate_cleanly() {
        let record = record();
        assert!(validate(&settings(Some("m-1"), Some("high"), "default"), &record).is_empty());
        assert!(validate(&settings(None, None, "default"), &record).is_empty());
    }

    #[test]
    fn unsupported_or_malformed_choices_are_conflicts() {
        let record = record();
        let c = validate(&settings(Some(" m"), Some("max"), "yolo"), &record);
        assert_eq!(
            fields(&c),
            [
                PresetField::Model,
                PresetField::Reasoning,
                PresetField::PermissionMode
            ]
        );
        let c = validate(&settings(None, None, "nope"), &record);
        assert_eq!(fields(&c), [PresetField::PermissionMode]);
        let mut other = settings(None, None, "default");
        other.provider = "q".into();
        assert_eq!(fields(&validate(&other, &record)), [PresetField::Provider]);
    }

    #[test]
    fn native_only_reasoning_is_refused_rather_than_ignored() {
        let mut record = record();
        record.reasoning.selection = cap(Support::NativeOnly);
        let c = validate(&settings(None, Some("low"), "default"), &record);
        assert_eq!(fields(&c), [PresetField::Reasoning]);
        assert!(c[0].message.contains("unavailable"));
    }

    #[test]
    fn open_reasoning_levels_accept_any_plain_value() {
        let mut record = record();
        record.reasoning.levels.clear();
        assert!(validate(&settings(None, Some("xhigh"), "default"), &record).is_empty());
        assert_eq!(
            fields(&validate(&settings(None, Some(""), "default"), &record)),
            [PresetField::Reasoning]
        );
    }

    #[test]
    fn preset_names_are_trimmed_and_bounded() {
        assert_eq!(preset_name("  Fast  ").unwrap(), "Fast");
        assert!(preset_name("   ").is_err());
        assert!(preset_name("a\nb").is_err());
        assert!(preset_name(&"x".repeat(81)).is_err());
        assert!(preset_name(&"é".repeat(80)).is_ok());
    }

    fn preset(revision: u32, fingerprint: &str, mode: &str) -> Preset {
        Preset {
            name: "n".into(),
            settings: settings(None, None, mode),
            revision: 1,
            capability_revision: revision,
            capability_fingerprint: fingerprint.into(),
            updated_at: 0,
        }
    }

    #[test]
    fn checking_a_preset_revalidates_against_the_current_record() {
        let records = [record()];
        let fp = records[0].fingerprint.clone();
        let fresh = check(preset(2, &fp, "default"), &records);
        assert_eq!(fresh.capability_change, CapabilityChange::Unchanged);
        assert!(fresh.conflicts.is_empty());
        let stale = check(preset(1, "old", "yolo"), &records);
        assert_eq!(stale.capability_change, CapabilityChange::Revised);
        assert_eq!(fields(&stale.conflicts), [PresetField::PermissionMode]);
        let mut orphan = preset(2, &fp, "default");
        orphan.settings.provider = "gone".into();
        assert_eq!(
            fields(&check(orphan, &records).conflicts),
            [PresetField::Provider]
        );
    }

    #[test]
    fn applying_a_preset_refuses_conflicts_instead_of_adapting() {
        let records = [record()];
        let fp = records[0].fingerprint.clone();
        let mut fresh = preset(2, &fp, "default");
        fresh.settings.model = Some("m-1".into());
        let checked = check(fresh, &records);
        let settings = apply(&checked, Some("p")).unwrap();
        assert_eq!(settings.model.as_deref(), Some("m-1"));
        assert_eq!(apply(&checked, None).unwrap(), settings);
        assert!(
            apply(&checked, Some("other"))
                .unwrap_err()
                .to_string()
                .contains("is for p, not other")
        );
        let stale = check(preset(1, "old", "yolo"), &records);
        assert!(
            apply(&stale, None)
                .unwrap_err()
                .to_string()
                .contains("conflicts with the current p capabilities")
        );
        let mut reasoning = preset(2, &fp, "default");
        reasoning.settings.reasoning = Some("high".into());
        assert!(apply(&check(reasoning, &records), None).is_err());
    }

    fn passed() -> Vec<ReadinessCheck> {
        vec![ReadinessCheck {
            check: "executable:p".into(),
            state: CheckState::Passed,
            detail: "/bin/p".into(),
        }]
    }

    fn inspection(state: &str, identity: Option<Value>) -> Inspection {
        Inspection {
            state: state.into(),
            reason: "Reason".into(),
            version: Some("1.0.0".into()),
            identity,
        }
    }

    #[test]
    fn readiness_without_an_account_never_claims_ready() {
        let record = record();
        assert_eq!(
            readiness(&record, &passed(), None).0,
            ReadinessState::InstalledUnchecked
        );
        let mut missing = passed();
        missing[0].state = CheckState::Failed;
        missing[0].detail = "Install P".into();
        assert_eq!(
            readiness(&record, &missing, None),
            (ReadinessState::MissingExecutable, "Install P".into())
        );
    }

    #[test]
    fn readiness_maps_each_account_outcome() {
        let record = record();
        let who = json!({"email": "a@b.c"});
        let verdict =
            |state: &str, pinned: Option<Value>, probe: Option<Result<&Inspection, String>>| {
                readiness(
                    &record,
                    &passed(),
                    Some(&AccountFacts {
                        state,
                        pinned,
                        inspection: probe,
                    }),
                )
                .0
            };
        let ready = inspection("ready", Some(who.clone()));
        assert_eq!(
            verdict("verified", Some(who.clone()), Some(Ok(&ready))),
            ReadinessState::Ready
        );
        assert_eq!(
            verdict("verified", Some(json!({"email": "x"})), Some(Ok(&ready))),
            ReadinessState::IdentityChanged
        );
        assert_eq!(
            verdict("unverified", None, Some(Ok(&ready))),
            ReadinessState::NeedsVerification
        );
        assert_eq!(
            verdict("disabled", Some(who.clone()), Some(Ok(&ready))),
            ReadinessState::AccountDisabled
        );
        for (state, expected) in [
            ("unauthenticated", ReadinessState::NeedsAuthentication),
            ("incompatible", ReadinessState::Incompatible),
            ("unavailable", ReadinessState::Unavailable),
            ("missing_executable", ReadinessState::MissingExecutable),
            ("something_new", ReadinessState::Unavailable),
        ] {
            let probe = inspection(state, None);
            assert_eq!(
                verdict("verified", Some(who.clone()), Some(Ok(&probe))),
                expected,
                "{state}"
            );
        }
        assert_eq!(
            verdict("verified", Some(who.clone()), Some(Err("timeout".into()))),
            ReadinessState::Unavailable
        );
        assert_eq!(
            verdict("verified", Some(who), None),
            ReadinessState::Unavailable
        );
    }

    fn window(
        account: Option<&str>,
        used: Option<f64>,
        status: Option<&str>,
        reset: bool,
    ) -> UsageLimitWindow {
        UsageLimitWindow {
            provider: "p".into(),
            account_id: account.map(Into::into),
            limit_id: "five_hour".into(),
            used_percent: used,
            window_minutes: Some(300),
            resets_at: None,
            status: status.map(Into::into),
            plan: None,
            observed_at: 1_000,
            source: "rate_limit_event".into(),
            reset_since_observed: reset,
        }
    }

    #[test]
    fn quota_lists_every_account_and_marks_unreported_ones() {
        let records = [record()];
        let accounts = [
            ("p".to_owned(), "a1".to_owned()),
            ("q".to_owned(), "a9".to_owned()),
        ];
        let windows = [window(Some("a1"), Some(40.0), None, false)];
        let all = QuotaScope {
            provider: None,
            account_id: None,
        };
        let entries = quota(&records, &accounts, &windows, &all, 4_000);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].account_id, None);
        assert_eq!(entries[0].state, QuotaState::NotReported);
        assert_eq!(entries[1].account_id.as_deref(), Some("a1"));
        assert_eq!(entries[1].state, QuotaState::Reported);
        assert_eq!(entries[1].age_ms, Some(3_000));
        assert!(!entries[1].exhausted);
    }

    #[test]
    fn quota_is_unavailable_when_the_provider_does_not_report_it() {
        let mut record = record();
        record.quota = cap(Support::Unknown);
        let scope = QuotaScope {
            provider: Some("p"),
            account_id: None,
        };
        let entries = quota(&[record], &[], &[], &scope, 0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, QuotaState::Unavailable);
        assert_eq!(entries[0].observed_at, None);
    }

    #[test]
    fn exhaustion_counts_only_windows_that_have_not_reset() {
        let records = [record()];
        let scope = QuotaScope {
            provider: None,
            account_id: Some("a1"),
        };
        let at = |w: UsageLimitWindow| quota(&records, &[], &[w], &scope, 2_000)[0].exhausted;
        assert!(at(window(Some("a1"), Some(100.0), None, false)));
        assert!(at(window(Some("a1"), None, Some("rejected"), false)));
        assert!(!at(window(Some("a1"), Some(100.0), None, true)));
        assert!(!at(window(
            Some("a1"),
            Some(99.5),
            Some("allowed_warning"),
            false
        )));
    }
}
