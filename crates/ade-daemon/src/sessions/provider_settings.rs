//! Provider settings (ticket 08): requested model, reasoning level and
//! permission mode, beside what the provider itself reported in effect.
//!
//! Choices are rediscovered from what the open provider session listed
//! (Codex `model/list`, Claude `supportedModels()`, Oh My Pi
//! `get_available_models`): the models, and for the model in question the
//! reasoning levels and permission modes it offers, narrowed to what ADE can
//! request. Where the provider lists nothing, ADE's static table applies and
//! is labelled so.
//!
//! A change is an effect command at a known revision. The model is applied
//! first, then every dependent setting — changed or kept — is checked against
//! the new model's choices; one it does not offer refuses the whole change,
//! so nothing is applied. Nothing is replaced by another value or widened. An
//! idle Agent is relaunched under the new settings; a failed relaunch keeps
//! the stored revision and reports the native error rather than claiming a
//! rollback.
use super::*;
use ade_core::contract::conversations::{
    ChoicesSource, ConversationSettings, ConversationSettingsRequest,
    ConversationSettingsUpdateRequest, ConversationSettingsUpdated, DiscoveredModel, SettingSource,
    SettingState, SettingsDiscovery,
};
use ade_core::provider::{NativeChoices, NativeModel};

/// Statuses in which a turn may be running; settings wait for it to end.
const TURN_RUNNING: &[&str] = &["starting", "running", "waiting", "cancelling"];

pub(super) fn handles(op: &str) -> bool {
    matches!(op, "conversation.settings" | "conversation.settings.update")
}

fn state(
    requested: Option<&str>,
    reported: Option<&str>,
    (choices, choices_source): (Vec<String>, ChoicesSource),
    supported: bool,
    reason: Option<String>,
) -> SettingState {
    let (effective, source) = match (reported, requested) {
        (Some(value), _) => (Some(value.to_owned()), SettingSource::NativeReported),
        (None, Some(_)) => (None, SettingSource::RequestedOnly),
        (None, None) => (None, SettingSource::ProviderDefault),
    };
    SettingState {
        requested: requested.map(str::to_owned),
        effective,
        source,
        choices,
        choices_source,
        supported,
        reason,
    }
}

/// The choices ADE can offer for one model of a provider.
struct Choices {
    models: (Vec<String>, ChoicesSource),
    reasoning: (Vec<String>, ChoicesSource),
    permission: (Vec<String>, ChoicesSource),
}

/// Narrows ADE's table to what the provider listed for `model`, in the
/// provider's order; with no list for that model, the table applies.
fn narrow(table: &[String], listed: Option<&Vec<String>>) -> (Vec<String>, ChoicesSource) {
    match listed {
        Some(listed) => (
            listed
                .iter()
                .filter(|value| table.contains(value))
                .cloned()
                .collect(),
            ChoicesSource::NativeReported,
        ),
        None => (table.to_vec(), ChoicesSource::Static),
    }
}

fn choices(
    provider: &str,
    permission_table: &[String],
    catalogue: Option<&NativeChoices>,
    model: Option<&NativeModel>,
) -> Choices {
    let levels: Vec<String> = ade_core::provider::reasoning_efforts(provider)
        .iter()
        .map(|level| (*level).to_owned())
        .collect();
    Choices {
        models: match catalogue {
            Some(catalogue) => (
                catalogue.models.iter().map(|m| m.id.clone()).collect(),
                ChoicesSource::NativeReported,
            ),
            None => (vec![], ChoicesSource::Unavailable),
        },
        reasoning: narrow(&levels, model.and_then(|m| m.reasoning_efforts.as_ref())),
        permission: narrow(
            permission_table,
            model.and_then(|m| m.permission_modes.as_ref()),
        ),
    }
}

/// The listed model a setting depends on: the requested one, else the one
/// in effect (when it still applies), else the provider's listed default.
fn subject<'a>(
    catalogue: Option<&'a NativeChoices>,
    requested: Option<&str>,
    effective: Option<&str>,
) -> Option<&'a NativeModel> {
    let catalogue = catalogue?;
    match requested.or(effective) {
        Some(model) => catalogue.model(model),
        None => catalogue.default_model(),
    }
}

impl Sessions {
    pub(super) fn provider_settings_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "conversation.settings" => {
                let query: ConversationSettingsRequest = decode(request)?;
                let id = non_empty("conversation_id", &query.conversation_id)?;
                reply(&self.settings(id)?)
            }
            "conversation.settings.update" => self.update_settings(decode(request)?),
            _ => bail!("Unknown settings operation"),
        }
    }

    /// The permission modes ADE can request from a Conversation's provider.
    fn permission_table(&self, provider: &str) -> Result<Vec<String>> {
        Ok(match self.registered_descriptor(provider)? {
            Some(descriptor) => descriptor.permission_modes,
            None => crate::provider::descriptor(provider)?
                .permission_modes
                .clone(),
        })
    }

    fn settings(&self, id: &str) -> Result<ConversationSettings> {
        let (c, connected, run, catalogue) = {
            let d = self.data.lock().unwrap();
            let agent = d.agents.get(id);
            (
                d.store.conversation(id)?,
                agent.is_some(),
                agent.map(|agent| agent.run_id.clone()),
                agent.and_then(|agent| agent.native_choices.clone()),
            )
        };
        let config = &c.provider_config;
        let native = c.native_settings.clone().unwrap_or_default();
        let model = subject(
            catalogue.as_ref(),
            config.model.as_deref(),
            native.model.as_deref(),
        );
        let table = self.permission_table(&c.provider)?;
        let offered = choices(&c.provider, &table, catalogue.as_ref(), model);
        let reasoning_supported = !ade_core::provider::reasoning_efforts(&c.provider).is_empty();
        let discovery = match &catalogue {
            Some(catalogue) => SettingsDiscovery {
                available: true,
                source: Some(catalogue.source.clone()),
                source_attempt_id: run,
                reason: None,
                models: catalogue
                    .models
                    .iter()
                    .map(|listed| {
                        let offered = choices(&c.provider, &table, None, Some(listed));
                        DiscoveredModel {
                            native: listed.clone(),
                            reasoning_choices: offered.reasoning.0,
                            reasoning_choices_source: offered.reasoning.1,
                            permission_choices: offered.permission.0,
                            permission_choices_source: offered.permission.1,
                        }
                    })
                    .collect(),
            },
            None => SettingsDiscovery {
                available: false,
                source: None,
                source_attempt_id: None,
                reason: Some(if connected {
                    format!("{} listed no models for this session", c.provider)
                } else {
                    "No Agent is connected; choices are discovered when one opens".into()
                }),
                models: vec![],
            },
        };
        Ok(ConversationSettings {
            tag: Default::default(),
            conversation_id: c.id.clone(),
            provider: c.provider.clone(),
            revision: c.settings_revision,
            model: state(
                config.model.as_deref(),
                native.model.as_deref(),
                offered.models,
                true,
                None,
            ),
            reasoning_effort: state(
                config.reasoning_effort.as_deref(),
                native.reasoning_effort.as_deref(),
                offered.reasoning,
                reasoning_supported,
                (!reasoning_supported)
                    .then(|| format!("ADE cannot select a reasoning level for {}", c.provider)),
            ),
            permission_mode: state(
                Some(config.permission_mode.as_str()),
                native.permission_mode.as_deref(),
                offered.permission,
                true,
                None,
            ),
            discovery,
            agent_connected: connected,
            turn_running: TURN_RUNNING.contains(&c.status.as_str()),
        })
    }

    fn update_settings(
        self: &Arc<Self>,
        update: ConversationSettingsUpdateRequest,
    ) -> Result<Value> {
        let id = non_empty("conversation_id", &update.conversation_id)?;
        let permission_table = {
            let provider = self.data.lock().unwrap().store.conversation(id)?.provider;
            self.permission_table(&provider)?
        };
        let (changed, relaunch) = {
            let mut d = self.data.lock().unwrap();
            let mut c = d.store.conversation(id)?;
            ensure!(
                update.expected_revision == c.settings_revision,
                "Settings changed since revision {}; read them again before changing them",
                update.expected_revision
            );
            ensure!(
                !TURN_RUNNING.contains(&c.status.as_str()),
                "A turn is running; change settings when it ends"
            );
            let catalogue = d.agents.get(id).and_then(|a| a.native_choices.as_ref());
            let mut next = c.provider_config.clone();
            let mut changed = Vec::new();
            // The model first: every setting after it is checked against it.
            if let Some(model) = &update.model {
                let model = (!model.is_empty()).then(|| model.clone());
                if model != next.model {
                    if let (Some(model), Some(catalogue)) = (&model, catalogue) {
                        ensure!(
                            catalogue.model(model).is_some(),
                            "{} does not list model {model} for this session",
                            c.provider
                        );
                    }
                    next.model = model;
                    changed.push("model".to_owned());
                }
            }
            let model_changed = changed.iter().any(|setting| setting == "model");
            // The model in effect still applies only when the model is unchanged.
            let effective = c
                .native_settings
                .as_ref()
                .and_then(|native| native.model.as_deref())
                .filter(|_| !model_changed);
            let model = subject(catalogue, next.model.as_deref(), effective);
            let offered = choices(&c.provider, &permission_table, catalogue, model);
            // Named as the person knows it: the requested or reported name, else the default's.
            let subject_name = match (next.model.as_deref().or(effective), model) {
                (Some(name), _) => name.to_owned(),
                (None, Some(model)) => model.id.clone(),
                (None, None) => format!("{}'s default model", c.provider),
            };
            if let Some(level) = &update.reasoning_effort {
                let level = (!level.is_empty()).then(|| level.clone());
                if level != next.reasoning_effort {
                    next.reasoning_effort = level;
                    changed.push("reasoning_effort".to_owned());
                }
            }
            if let Some(mode) = &update.permission_mode
                && *mode != next.permission_mode
            {
                next.permission_mode = mode.clone();
                changed.push("permission_mode".to_owned());
            }
            // Dependent settings, the new ones and the ones kept, against the new model.
            let kept = |setting: &str| {
                if changed.iter().any(|c| c == setting) {
                    String::new()
                } else {
                    ", which stays requested; choose one it offers or reset it".to_owned()
                }
            };
            if let Some(level) = &next.reasoning_effort {
                ensure!(
                    !ade_core::provider::reasoning_efforts(&c.provider).is_empty(),
                    "Unsupported reasoning level for {}",
                    c.provider
                );
                ensure!(
                    offered.reasoning.0.contains(level),
                    "{subject_name} does not offer reasoning level {level}{}",
                    kept("reasoning_effort")
                );
            }
            if offered.permission.1 == ChoicesSource::Static {
                ensure!(
                    offered.permission.0.contains(&next.permission_mode),
                    "{} does not offer permission mode {}",
                    c.provider,
                    next.permission_mode
                );
            } else {
                ensure!(
                    offered.permission.0.contains(&next.permission_mode),
                    "{subject_name} does not offer permission mode {}{}",
                    next.permission_mode,
                    kept("permission_mode")
                );
            }
            match self.registered_descriptor(&c.provider)? {
                Some(descriptor) => next.validate_against(&descriptor)?,
                None => next.validate(&c.provider)?,
            }
            let relaunch = !changed.is_empty() && d.agents.contains_key(id);
            if !changed.is_empty() {
                c.provider_config = next;
                c.settings_revision += 1;
                // What the provider reported belongs to the previous settings.
                c.native_settings = None;
                c.updated_at = now_ms();
                persistence_result(d.store.commit_conversation(&c, &[], &[]))?;
                self.changed(&mut d, &c, &[])?;
            }
            (changed, relaunch)
        };
        let native_error = relaunch
            .then(|| {
                self.disconnect(id)
                    .and_then(|()| self.resume(id))
                    .err()
                    .map(|error| format!("{error:#}"))
            })
            .flatten();
        reply(&ConversationSettingsUpdated {
            tag: Default::default(),
            conversation_id: id.to_owned(),
            changed,
            relaunched: relaunch && native_error.is_none(),
            native_error,
            settings: self.settings(id)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, levels: Option<&[&str]>, default: bool) -> NativeModel {
        NativeModel {
            id: id.into(),
            is_default: default,
            reasoning_efforts: levels.map(|l| l.iter().map(|v| (*v).to_owned()).collect()),
            ..NativeModel::default()
        }
    }

    #[test]
    fn dependent_choices_come_from_the_model_in_question_and_never_widen_the_table() {
        let catalogue = NativeChoices {
            source: "model/list".into(),
            models: vec![
                model("big", Some(&["low", "medium", "high", "ultra"]), true),
                model("small", Some(&["low"]), false),
                model("unlisted-levels", None, false),
            ],
        };
        let table = vec!["default".to_owned(), "read-only".to_owned()];
        let small = choices("codex", &table, Some(&catalogue), catalogue.model("small"));
        assert_eq!(
            small.reasoning,
            (vec!["low".to_owned()], ChoicesSource::NativeReported)
        );
        assert_eq!(small.models.1, ChoicesSource::NativeReported);
        assert_eq!(small.permission, (table.clone(), ChoicesSource::Static));
        // A level the provider lists but ADE cannot request is not offered.
        let big = choices(
            "codex",
            &table,
            Some(&catalogue),
            subject(Some(&catalogue), None, None),
        );
        assert_eq!(big.reasoning.0, ["low", "medium", "high"]);
        let unlisted = choices(
            "codex",
            &table,
            Some(&catalogue),
            catalogue.model("unlisted-levels"),
        );
        assert_eq!(unlisted.reasoning.1, ChoicesSource::Static);
        let offline = choices("codex", &table, None, None);
        assert_eq!(offline.models, (vec![], ChoicesSource::Unavailable));
        assert_eq!(offline.reasoning.1, ChoicesSource::Static);
    }
}
