//! `settings.get` and `settings.set`: profile preferences every client
//! applies. A change reaches every subscriber as a `settings_changed` frame.
use super::*;
use ade_core::appearance::ThemeSectionKind;
use ade_core::contract::settings::{
    AppCommand, KEYS, Settings, SettingsGetRequest, SettingsSetRequest,
};
use ade_core::error::UnknownSetting;

/// Refuses, by name, a key the profile does not keep or a command that does
/// not exist, before anything changes.
fn known_names(request: &Value) -> Result<()> {
    let Some(fields) = request.as_object() else {
        return Ok(());
    };
    for key in fields.keys() {
        if !matches!(
            key.as_str(),
            "op" | "diagnostic_id"
                | "reset_keybindings"
                | "expected_appearance_revision"
                | "expected_theme_revisions"
        ) && !KEYS.contains(&key.as_str())
        {
            return Err(UnknownSetting(key.clone()).into());
        }
    }
    let bound = request["keybindings"]
        .as_object()
        .into_iter()
        .flat_map(|keys| keys.keys().map(String::as_str));
    let reset = request["reset_keybindings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    for id in bound.chain(reset) {
        if AppCommand::from_id(id).is_none() {
            return Err(UnknownSetting(format!("keybindings.{id}")).into());
        }
    }
    Ok(())
}

impl Sessions {
    pub(super) fn appearance_propagation(
        &self,
        desired: &ade_core::appearance::TerminalAppearanceProjection,
    ) -> ade_core::contract::settings::AppearancePropagation {
        use ade_core::contract::settings::AppearancePropagation;
        match self
            .runtime
            .command(ade_core::contract::terminals::runtime::Command::AppearanceGet)
            .and_then(|value| {
                Ok(serde_json::from_value::<
                    ade_core::appearance::TerminalAppearanceProjection,
                >(value)?)
            }) {
            Ok(applied) if applied == *desired => AppearancePropagation::Applied {
                revision: desired.profile.revision,
            },
            Ok(applied) => AppearancePropagation::Pending {
                desired_revision: desired.profile.revision,
                applied_revision: applied.profile.revision,
            },
            Err(error) => AppearancePropagation::Unavailable {
                desired_revision: desired.profile.revision,
                message: error.to_string(),
            },
        }
    }

    /// The server authenticates the current local desktop owner before calling this.
    pub fn observe_system_appearance(
        &self,
        mode: ade_core::appearance::PaletteMode,
    ) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        let (settings, changed) = d.store.observe_system_appearance(mode)?;
        if changed {
            self.publish(
                &mut d,
                json!({"type": "settings_changed", "settings": settings}),
            );
        }
        self.runtime
            .command(
                ade_core::contract::terminals::runtime::Command::Appearance {
                    appearance: d.store.terminal_appearance_projection()?,
                },
            )
            .context("Appearance saved, but the terminal update could not be confirmed")?;
        reply(&Settings {
            tag: Default::default(),
            settings,
        })
    }

    pub(super) fn settings_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "settings.palettes" => {
                let ade_core::contract::settings::SettingsPalettesRequest {} = decode(request)?;
                reply(&ade_core::contract::settings::PaletteCatalog {
                    tag: Default::default(),
                    palettes: ade_core::appearance::builtin_catalog().to_vec(),
                })
            }
            "settings.appearance" => {
                use ade_core::contract::settings::{ResolvedAppearance, SettingsAppearanceRequest};
                let SettingsAppearanceRequest {} = decode(request)?;
                let d = self.data.lock().unwrap();
                let terminal = d.store.terminal_appearance()?;
                let propagation =
                    self.appearance_propagation(&d.store.terminal_appearance_projection()?);
                let palette = d.store.app_palette()?;
                let settings = d.store.settings()?;
                let (light_palette, light_diagnostic) = d
                    .store
                    .app_palette_variant(ade_core::appearance::PaletteMode::Light)?;
                let (dark_palette, dark_diagnostic) = d
                    .store
                    .app_palette_variant(ade_core::appearance::PaletteMode::Dark)?;
                let (syntax_palette, selected_id, syntax_diagnostic) = d
                    .store
                    .resolve_theme_binding(&settings.syntax_binding, ThemeSectionKind::Syntax)?;
                reply(&ResolvedAppearance {
                    tag: Default::default(),
                    revision: terminal.revision,
                    theme_id: palette.id.clone(),
                    preference: settings.appearance,
                    diagnostics: [light_diagnostic, dark_diagnostic]
                        .into_iter()
                        .flatten()
                        .collect(),
                    light_palette: light_palette.clone(),
                    dark_palette: dark_palette.clone(),
                    mode: palette.mode,
                    tokens: palette.tokens.clone(),
                    syntax: ade_core::contract::settings::ResolvedSyntaxAppearance {
                        light_palette: d
                            .store
                            .resolve_theme_binding_variant(
                                &settings.syntax_binding,
                                ThemeSectionKind::Syntax,
                                ade_core::appearance::PaletteMode::Light,
                            )?
                            .0
                            .clone(),
                        dark_palette: d
                            .store
                            .resolve_theme_binding_variant(
                                &settings.syntax_binding,
                                ThemeSectionKind::Syntax,
                                ade_core::appearance::PaletteMode::Dark,
                            )?
                            .0
                            .clone(),
                        binding: settings.syntax_binding,
                        selected_id,
                        palette: syntax_palette.clone(),
                        diagnostics: syntax_diagnostic.into_iter().collect(),
                    },
                    terminal,
                    terminal_diagnostics: d
                        .store
                        .resolve_theme_binding(
                            &settings.terminal_binding,
                            ThemeSectionKind::Terminal,
                        )?
                        .2
                        .into_iter()
                        .collect(),
                    propagation,
                })
            }
            "settings.get" => {
                let SettingsGetRequest {} = decode(request)?;
                reply(&Settings {
                    tag: Default::default(),
                    settings: self.data.lock().unwrap().store.settings()?,
                })
            }
            "settings.set" | "settings.appearance.reset" => {
                let change = if request["op"] == "settings.appearance.reset" {
                    let reset: ade_core::contract::settings::SettingsResetAppearanceRequest =
                        decode(request)?;
                    SettingsSetRequest {
                        appearance: Some(Default::default()),
                        app_light_theme: Some("ade:chalk".into()),
                        app_dark_theme: Some("ade:graphite".into()),
                        terminal_binding: Some(Default::default()),
                        syntax_binding: Some(Default::default()),
                        terminal_color_overrides: Some(Default::default()),
                        terminal_minimum_contrast: Some(1.0),
                        terminal_bold_color: Some(Default::default()),
                        expected_appearance_revision: Some(reset.expected_appearance_revision),
                        ..Default::default()
                    }
                } else {
                    known_names(request)?;
                    decode::<SettingsSetRequest>(request)?
                };
                let mut d = self.data.lock().unwrap();
                let (settings, changed) = d.store.set_settings(&change)?;
                if changed {
                    self.publish(
                        &mut d,
                        json!({"type": "settings_changed", "settings": settings}),
                    );
                }
                if change.appearance.is_some()
                    || change.app_light_theme.is_some()
                    || change.app_dark_theme.is_some()
                    || change.terminal_binding.is_some()
                    || change.syntax_binding.is_some()
                    || change.terminal_color_overrides.is_some()
                    || change.terminal_minimum_contrast.is_some()
                    || change.terminal_bold_color.is_some()
                {
                    self.runtime
                        .command(
                            ade_core::contract::terminals::runtime::Command::Appearance {
                                appearance: d.store.terminal_appearance_projection()?,
                            },
                        )
                        .context(
                            "Appearance saved, but the terminal update could not be confirmed",
                        )?;
                }
                reply(&Settings {
                    tag: Default::default(),
                    settings,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
}
