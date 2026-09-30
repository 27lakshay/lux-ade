use super::*;
use crate::store::terminal_records::{self, Stored};
use ade_core::appearance::{PaletteMode, ThemeBinding};
use ade_core::contract::settings::ProfileSettings;

struct Reference {
    id: String,
    impact: ThemeRemovalImpact,
}

fn references(settings: &ProfileSettings, terminals: &[Stored]) -> Vec<Reference> {
    let mut refs = Vec::new();
    let mut add = |consumer: ThemeConsumer,
                   terminal: Option<&Stored>,
                   slot: ThemeSelectionSlot,
                   id: &str,
                   indirect: bool| {
        let owner = terminal.map_or("profile", |terminal| terminal.id.as_str());
        let consumer_name = match consumer {
            ThemeConsumer::App => "app",
            ThemeConsumer::Terminal => "terminal",
            ThemeConsumer::Syntax => "syntax",
        };
        let slot_name = match slot {
            ThemeSelectionSlot::Light => "light",
            ThemeSelectionSlot::Dark => "dark",
            ThemeSelectionSlot::Fixed => "fixed",
        };
        refs.push(Reference {
            id: id.into(),
            impact: ThemeRemovalImpact {
                key: format!("{consumer_name}/{owner}/{slot_name}"),
                consumer,
                slot,
                workspace_id: terminal.map(|terminal| terminal.workspace_id.clone()),
                terminal_id: terminal.map(|terminal| terminal.id.clone()),
                indirect,
                fallback_id: String::new(),
            },
        });
    };
    add(
        ThemeConsumer::App,
        None,
        ThemeSelectionSlot::Light,
        &settings.app_light_theme,
        false,
    );
    add(
        ThemeConsumer::App,
        None,
        ThemeSelectionSlot::Dark,
        &settings.app_dark_theme,
        false,
    );
    let mut bindings = vec![
        (ThemeConsumer::Terminal, None, &settings.terminal_binding),
        (ThemeConsumer::Syntax, None, &settings.syntax_binding),
    ];
    bindings.extend(terminals.iter().filter_map(|terminal| {
        terminal
            .appearance_binding
            .as_ref()
            .map(|binding| (ThemeConsumer::Terminal, Some(terminal), binding))
    }));
    for (consumer, terminal, binding) in bindings {
        match binding {
            ThemeBinding::FollowApp => {
                add(
                    consumer.clone(),
                    terminal,
                    ThemeSelectionSlot::Light,
                    &settings.app_light_theme,
                    true,
                );
                add(
                    consumer,
                    terminal,
                    ThemeSelectionSlot::Dark,
                    &settings.app_dark_theme,
                    true,
                );
            }
            ThemeBinding::Fixed { theme_id } => add(
                consumer,
                terminal,
                ThemeSelectionSlot::Fixed,
                theme_id,
                false,
            ),
            ThemeBinding::Paired { light, dark } => {
                add(
                    consumer.clone(),
                    terminal,
                    ThemeSelectionSlot::Light,
                    light,
                    false,
                );
                add(consumer, terminal, ThemeSelectionSlot::Dark, dark, false);
            }
        }
    }
    refs
}

fn fallback(mode: PaletteMode) -> &'static str {
    if mode == PaletteMode::Light {
        "ade:chalk"
    } else {
        "ade:graphite"
    }
}

fn replace(binding: &mut ThemeBinding, id: &str, mode: PaletteMode) -> bool {
    let mut changed = false;
    let mut set = |selected: &mut String, mode| {
        if selected == id {
            *selected = fallback(mode).into();
            changed = true;
        }
    };
    match binding {
        ThemeBinding::FollowApp => {}
        ThemeBinding::Fixed { theme_id } => set(theme_id, mode),
        ThemeBinding::Paired { light, dark } => {
            set(light, PaletteMode::Light);
            set(dark, PaletteMode::Dark);
        }
    }
    changed
}

pub(crate) struct RemovedTheme {
    pub removal: ThemeRemoval,
    pub terminal_bindings_changed: bool,
}

impl Store {
    pub(super) fn selected_theme_ids(&self) -> Result<BTreeSet<String>> {
        Ok(references(
            &self.settings()?,
            &terminal_records::retained(&self.connection)?,
        )
        .into_iter()
        .map(|reference| reference.id)
        .collect())
    }

    pub fn theme_removal_plan(
        &self,
        request: &ThemeRemovalPlanRequest,
    ) -> Result<ThemeRemovalPlan> {
        let theme = self.theme(&request.id)?.summary();
        let settings = self.settings()?;
        let after = request.after_key.as_deref().unwrap_or("");
        ensure!(after.len() <= 4096, "Invalid removal page cursor");
        let mut impacts: Vec<_> =
            references(&settings, &terminal_records::retained(&self.connection)?)
                .into_iter()
                .filter(|reference| reference.id == request.id)
                .map(|mut reference| {
                    let mode = match reference.impact.slot {
                        ThemeSelectionSlot::Light => PaletteMode::Light,
                        ThemeSelectionSlot::Dark => PaletteMode::Dark,
                        ThemeSelectionSlot::Fixed => theme.mode,
                    };
                    reference.impact.fallback_id = fallback(mode).into();
                    reference.impact
                })
                .collect();
        let total = impacts.len();
        impacts.sort_by(|a, b| a.key.cmp(&b.key));
        impacts.retain(|impact| impact.key.as_str() > after);
        let has_more = impacts.len() > PAGE_SIZE;
        impacts.truncate(PAGE_SIZE);
        let next_key = has_more.then(|| impacts.last().expect("Full removal page").key.clone());
        let removable = writable(&theme.id, &theme.provenance.kind).is_ok();
        Ok(ThemeRemovalPlan {
            tag: Default::default(),
            theme,
            removable,
            appearance_revision: settings.appearance_revision,
            total,
            impacts,
            next_key,
        })
    }

    /// Removal and all direct selection fallbacks commit together. Desired absence replays without mutation.
    pub(crate) fn remove_theme(&self, request: &ThemeRemoveRequest) -> Result<RemovedTheme> {
        check_id(&request.id)?;
        writable(&request.id, &ThemeOrigin::User)?;
        let tx = self.transaction()?;
        let before = self.settings()?;
        let library_revision = revision(&tx)?;
        let Some(theme) = record(&tx, &request.id)? else {
            return Ok(RemovedTheme {
                removal: ThemeRemoval {
                    tag: Default::default(),
                    id: request.id.clone(),
                    changed: false,
                    revision: library_revision,
                    appearance_revision: before.appearance_revision,
                },
                terminal_bindings_changed: false,
            });
        };
        writable(&request.id, &theme.definition.provenance.kind)?;
        if theme.revision != request.expected_revision {
            return Err(ThemeConflict {
                id: request.id.clone(),
                expected: request.expected_revision,
                current: theme.revision,
            }
            .into());
        }
        if before.appearance_revision != request.expected_appearance_revision {
            return Err(ade_core::error::AppearanceConflict {
                expected: request.expected_appearance_revision,
                current: before.appearance_revision,
            }
            .into());
        }
        let mut after = before.clone();
        if after.app_light_theme == request.id {
            after.app_light_theme = fallback(PaletteMode::Light).into();
        }
        if after.app_dark_theme == request.id {
            after.app_dark_theme = fallback(PaletteMode::Dark).into();
        }
        replace(
            &mut after.terminal_binding,
            &request.id,
            theme.definition.mode,
        );
        replace(
            &mut after.syntax_binding,
            &request.id,
            theme.definition.mode,
        );
        let mut terminal_bindings_changed = false;
        // Execute deletion first so a later selection write failure exercises whole-transaction rollback.
        tx.execute("DELETE FROM theme_definitions WHERE id=?1", [&request.id])?;
        for mut terminal in terminal_records::retained(&tx)? {
            if let Some(binding) = &mut terminal.appearance_binding
                && replace(binding, &request.id, theme.definition.mode)
            {
                terminal_records::write(&tx, &terminal)?;
                terminal_bindings_changed = true;
            }
        }
        if after != before || terminal_bindings_changed {
            after.appearance_revision = before
                .appearance_revision
                .checked_add(1)
                .context("Appearance revision exhausted")?;
            let before_value = serde_json::to_value(&before)?;
            let after_value = serde_json::to_value(&after)?;
            for key in [
                "app_light_theme",
                "app_dark_theme",
                "terminal_binding",
                "syntax_binding",
                "appearance_revision",
            ] {
                if before_value[key] != after_value[key] {
                    tx.execute("INSERT INTO profile_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                        params![key, after_value[key].to_string(), now_ms()])?;
                }
            }
        }
        let next = library_revision
            .checked_add(1)
            .context("Theme library revision exhausted")?;
        tx.execute(
            "UPDATE theme_library_state SET revision=?1 WHERE id=1",
            [i64::try_from(next)?],
        )?;
        tx.commit()?;
        Ok(RemovedTheme {
            removal: ThemeRemoval {
                tag: Default::default(),
                id: request.id.clone(),
                changed: true,
                revision: next,
                appearance_revision: after.appearance_revision,
            },
            terminal_bindings_changed,
        })
    }
}
