//! `provider.capabilities`, `provider.readiness`, `provider.quota` and `preset.*`.
use super::*;
use crate::capabilities::{self as caps, core};
use ade_core::contract::accounts::AccountInspection;
use ade_core::contract::providers::*;
use ade_core::contract::usage::UsageLimits;

impl Sessions {
    pub(super) fn capability_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let result = match request["op"].as_str().unwrap_or("") {
            "provider.capabilities" => {
                let query: ProviderCapabilitiesRequest = decode(request)?;
                // Adapters and plugin providers are described by the
                // descriptor their registry entry publishes.
                let providers = match query.provider.as_deref() {
                    Some(provider) => match self.registered_record(provider)? {
                        Some(record) => vec![record],
                        None => vec![caps::record(provider)?],
                    },
                    None => {
                        let mut records = caps::records();
                        records.extend(self.registered_records());
                        records
                    }
                };
                reply(&ProviderCapabilities {
                    tag: Default::default(),
                    providers,
                })
            }
            "provider.readiness" => self.readiness(decode(request)?),
            "provider.quota" => self.quota(decode(request)?),
            "provider.registrations" => self.registrations(decode(request)?),
            "preset.list" => {
                let _: PresetListRequest = decode(request)?;
                let records = caps::records();
                reply(&PresetList {
                    tag: Default::default(),
                    presets: self
                        .presets
                        .list()?
                        .into_iter()
                        .map(|preset| core::check(preset, &records))
                        .collect(),
                })
            }
            "preset.get" => {
                let get: PresetGetRequest = decode(request)?;
                let preset = self
                    .presets
                    .get(&get.name)?
                    .ok_or_else(|| anyhow!("No preset is named {}", get.name.trim()))?;
                reply(&PresetView {
                    tag: Default::default(),
                    checked: core::check(preset, &caps::records()),
                })
            }
            "preset.save" => {
                let save: PresetSaveRequest = decode(request)?;
                let record = caps::record(non_empty("provider", &save.provider)?)?;
                let (preset, changed) = self.presets.save(&save, &record, now_ms())?;
                reply(&PresetSaved {
                    tag: Default::default(),
                    preset,
                    changed,
                })
            }
            "preset.delete" => {
                let delete: PresetDeleteRequest = decode(request)?;
                let (name, deleted) = self
                    .presets
                    .delete(&delete.name, delete.expected_revision)?;
                reply(&PresetDeleted {
                    tag: Default::default(),
                    name,
                    deleted,
                })
            }
            _ => bail!("Unknown session operation"),
        };
        result.map_err(|error| {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                tracing::error!(target: "ade", event = "presets_failed", error = %error);
                anyhow!("Presets are unavailable; retry")
            } else {
                error
            }
        })
    }

    /// Replays every registration through the runtime's provider registry.
    /// A plugin registry that cannot be read is reported, not hidden.
    fn registrations(&self, _: ProviderRegistrationsRequest) -> Result<Value> {
        let (workers, plugins_unavailable) = match &self.plugins {
            Ok(plugins) => match plugins.provider_workers() {
                Ok(workers) => (workers, None),
                Err(error) => {
                    tracing::warn!(target: "ade", event = "provider_workers_unavailable", error = %error);
                    (
                        vec![],
                        Some("Installed plugins could not be read; retry".to_owned()),
                    )
                }
            },
            Err(error) => (
                vec![],
                Some(format!("Plugin registry is unavailable: {error}")),
            ),
        };
        let (_, providers) =
            ade_runtime::provider::registry::compose(self.adapters.definitions()?, workers);
        reply(&ProviderRegistrations {
            tag: Default::default(),
            providers,
            plugins_unavailable,
        })
    }

    fn readiness(self: &Arc<Self>, request: ProviderReadinessRequest) -> Result<Value> {
        let provider = non_empty("provider", &request.provider)?;
        let account_id = request.account_id.filter(|id| !id.is_empty());
        if let Some(record) = self.registered_record(provider)? {
            return registered_readiness(record, account_id);
        }
        let record = caps::record(provider)?;
        let mut version = None;
        let account = match account_id.as_deref() {
            None => None,
            Some(id) => {
                let account = self.data.lock().unwrap().store.account(id)?;
                ensure!(
                    account.provider == provider,
                    "Account belongs to another provider"
                );
                Some(account)
            }
        };
        let mut checks = caps::installation(provider, account.is_some())?;
        let installed = checks.iter().all(|c| c.state != CheckState::Failed);
        let inspection = match &account {
            Some(account) if installed && account.state != "disabled" => Some(
                self.account_command(&json!({"op": "account.inspect", "account_id": account.id}))
                    .and_then(|value| Ok(serde_json::from_value::<AccountInspection>(value)?))
                    .map(|reply| reply.inspection)
                    .map_err(|error| error.to_string()),
            ),
            _ => None,
        };
        if let Some(Ok(inspection)) = &inspection {
            version.clone_from(&inspection.version);
        }
        let pinned = account
            .as_ref()
            .map(|a| {
                let identity = match a.provider.as_str() {
                    "claude" => serde_json::to_value(&a.claude_identity)?,
                    "codex" => serde_json::to_value(&a.codex_identity)?,
                    _ => serde_json::to_value(&a.omp_identity)?,
                };
                Ok::<_, anyhow::Error>(identity)
            })
            .transpose()?
            .filter(|identity| !identity.is_null());
        let facts = account.as_ref().map(|a| core::AccountFacts {
            state: &a.state,
            pinned: pinned.clone(),
            inspection: inspection
                .as_ref()
                .map(|probe| probe.as_ref().map_err(Clone::clone)),
        });
        let (state, reason) = core::readiness(&record, &checks, facts.as_ref());
        if account.is_some() {
            checks.push(ReadinessCheck {
                check: "account".into(),
                state: match (&inspection, state) {
                    (None, _) => CheckState::Skipped,
                    (_, ReadinessState::Ready) => CheckState::Passed,
                    _ => CheckState::Failed,
                },
                detail: reason.clone(),
            });
        }
        reply(&ProviderReadiness {
            tag: Default::default(),
            provider: provider.to_owned(),
            account_id,
            state,
            reason,
            version,
            checks,
            capability_revision: record.revision,
            checked_at: now_ms(),
        })
    }

    fn quota(self: &Arc<Self>, request: ProviderQuotaRequest) -> Result<Value> {
        let records = caps::records();
        let mut provider = request.provider.clone();
        if let Some(provider) = provider.as_deref() {
            caps::record(provider)?;
        }
        let accounts: Vec<(String, String)> = {
            let d = self.data.lock().unwrap();
            if let Some(id) = request.account_id.as_deref() {
                let account = d.store.account(id)?;
                ensure!(
                    provider.as_deref().is_none_or(|p| p == account.provider),
                    "Account belongs to another provider"
                );
                // An account belongs to one provider; show only that one.
                provider = Some(account.provider);
            }
            d.store
                .accounts()?
                .into_iter()
                .filter(|a| a.state != "disabled")
                .map(|a| (a.provider, a.id))
                .collect()
        };
        let mut limits = json!({"op": "usage.limits"});
        if let Some(provider) = &provider {
            limits["provider"] = json!(provider);
        }
        if let Some(account) = &request.account_id {
            limits["account_id"] = json!(account);
        }
        let limits: UsageLimits = serde_json::from_value(self.usage.command(&limits)?)?;
        let entries = core::quota(
            &records,
            &accounts,
            &limits.windows,
            &core::QuotaScope {
                provider: provider.as_deref(),
                account_id: request.account_id.as_deref(),
            },
            now_ms(),
        );
        reply(&ProviderQuota {
            tag: Default::default(),
            entries,
            recording: limits.recording,
        })
    }
}

/// Readiness of an adapter or plugin provider. Its registry entry is ready
/// (a probed adapter, an enabled plugin), which is all ADE can check before
/// launch; it runs on the agent's own login, so no account applies.
fn registered_readiness(record: CapabilityRecord, account_id: Option<String>) -> Result<Value> {
    ensure!(
        account_id.is_none(),
        "{} uses the agent's own login; ADE manages no accounts for it",
        record.provider
    );
    let checks = vec![ReadinessCheck {
        check: "registration".into(),
        state: CheckState::Passed,
        detail: format!("{} is registered and can start", record.name),
    }];
    let (state, reason) = core::readiness(&record, &checks, None);
    reply(&ProviderReadiness {
        tag: Default::default(),
        provider: record.provider.clone(),
        account_id: None,
        state,
        reason,
        version: None,
        checks,
        capability_revision: record.revision,
        checked_at: now_ms(),
    })
}
