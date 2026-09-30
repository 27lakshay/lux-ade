//! Profile settings: one row per key the person set, in `profile_settings`.
//! A key never set reads as its default. The `keybindings` row holds only
//! the commands whose key differs from the default (a key, or null for
//! none); every other command reads its default key.
use super::*;
use ade_core::appearance::{
    BuiltinPalette, PaletteMode, ThemeBinding, ThemeSectionKind, builtin_palette,
};
use ade_core::contract::settings::{
    AppCommand, KeybindingReset, Keybindings, ProfileSettings, SettingsSetRequest,
};
use ade_core::contract::settings::{AppearanceDiagnostic, AppearanceDiagnosticCode};
use ade_core::error::{InvalidKeybinding, KeybindingConflict};
use std::collections::BTreeMap;

/// The commands whose key the person changed, and the key each has now.
type Overrides = BTreeMap<AppCommand, Option<String>>;

const KEYBINDINGS: &str = "keybindings";

impl Store {
    /// Every setting: the stored value, or the default.
    pub fn settings(&self) -> Result<ProfileSettings> {
        let rows: Vec<(String, String)> = self
            .connection
            .prepare("SELECT key,value FROM profile_settings")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut settings = serde_json::to_value(ProfileSettings::default())?;
        let mut overrides = Overrides::new();
        for (key, value) in rows {
            if key == KEYBINDINGS {
                overrides = serde_json::from_str(&value)?;
            } else if matches!(key.as_str(), "app_light_theme" | "app_dark_theme") {
                // A malformed selection must not prevent querying settings or restoring defaults.
                // app_palette_variant reports the retained invalid row as a diagnostic.
                if let Ok(selected) = serde_json::from_str::<String>(&value) {
                    settings[key] = json!(selected);
                }
            } else if settings.get(&key).is_some() {
                settings[key] = serde_json::from_str(&value)?;
            }
        }
        let mut settings: ProfileSettings = serde_json::from_value(settings)?;
        settings.keybindings = effective(&overrides);
        Ok(settings)
    }

    pub fn app_palette(&self) -> Result<BuiltinPalette> {
        let settings = self.settings()?;
        let light = match settings.appearance {
            ade_core::contract::settings::Appearance::Light => true,
            ade_core::contract::settings::Appearance::Dark => false,
            ade_core::contract::settings::Appearance::System => {
                self.system_appearance()? == Some(ade_core::appearance::PaletteMode::Light)
            }
        };
        Ok(self
            .app_palette_variant(if light {
                ade_core::appearance::PaletteMode::Light
            } else {
                ade_core::appearance::PaletteMode::Dark
            })?
            .0)
    }

    pub fn app_palette_variant(
        &self,
        mode: PaletteMode,
    ) -> Result<(BuiltinPalette, Option<AppearanceDiagnostic>)> {
        let key = if mode == PaletteMode::Light {
            "app_light_theme"
        } else {
            "app_dark_theme"
        };
        let stored: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM profile_settings WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()?;
        let fallback = builtin_palette(if mode == PaletteMode::Light {
            "ade:chalk"
        } else {
            "ade:graphite"
        })
        .context("Built-in fallback palette is unavailable")?
        .clone();
        let Some(stored) = stored else {
            return Ok((fallback, None));
        };
        match serde_json::from_str::<String>(&stored) {
            Ok(id) => self.resolve_selection(&id, ThemeSectionKind::App, Some(mode), mode),
            Err(_) => Ok((
                fallback.clone(),
                Some(AppearanceDiagnostic {
                    code: AppearanceDiagnosticCode::InvalidSelection,
                    slot: mode,
                    selected_id: None,
                    fallback_id: fallback.id,
                    message: "The stored theme selection is invalid. Using the core fallback."
                        .into(),
                }),
            )),
        }
    }

    /// Bundled palettes already have every section. Custom records project only their declared section.
    fn selection_palette(
        &self,
        id: &str,
        section: ThemeSectionKind,
    ) -> Result<(Option<BuiltinPalette>, AppearanceDiagnosticCode)> {
        if let Some(palette) = builtin_palette(id) {
            return Ok((
                Some(palette.clone()),
                AppearanceDiagnosticCode::MissingTheme,
            ));
        }
        match self.theme_optional(id) {
            Ok(Some(record)) => {
                let validation = ade_core::appearance::definition::validate(
                    &serde_json::to_string(&record.definition)?,
                );
                match validation
                    .definition
                    .filter(|definition| definition.id == id)
                {
                    Some(definition) => Ok((
                        definition.palette(section),
                        AppearanceDiagnosticCode::MissingSection,
                    )),
                    None => Ok((None, AppearanceDiagnosticCode::InvalidDefinition)),
                }
            }
            Ok(None) => Ok((None, AppearanceDiagnosticCode::MissingTheme)),
            Err(_) => Ok((None, AppearanceDiagnosticCode::InvalidDefinition)),
        }
    }

    pub(super) fn resolve_selection(
        &self,
        id: &str,
        section: ThemeSectionKind,
        required_mode: Option<PaletteMode>,
        mode: PaletteMode,
    ) -> Result<(BuiltinPalette, Option<AppearanceDiagnostic>)> {
        let (selected, missing) = self.selection_palette(id, section)?;
        let code = match selected {
            Some(palette) if required_mode.is_none_or(|mode| palette.mode == mode) => {
                return Ok((palette, None));
            }
            Some(_) => AppearanceDiagnosticCode::WrongMode,
            None => missing,
        };
        let fallback = builtin_palette(if mode == PaletteMode::Light {
            "ade:chalk"
        } else {
            "ade:graphite"
        })
        .context("Built-in theme fallback is unavailable")?
        .clone();
        let missing_theme = matches!(&code, AppearanceDiagnosticCode::MissingTheme);
        let diagnostic = AppearanceDiagnostic {
            code,
            slot: mode,
            selected_id: Some(id.into()),
            fallback_id: fallback.id.clone(),
            message: if missing_theme {
                let qualification = if section == ThemeSectionKind::App {
                    ""
                } else {
                    " for this mode"
                };
                format!(
                    "Selected theme {id} is unavailable{qualification}. Using {}.",
                    fallback.name
                )
            } else {
                format!(
                    "Selected theme {id} cannot supply the {} section for this mode. Using {}.",
                    section.name(),
                    fallback.name
                )
            },
        };
        Ok((fallback, Some(diagnostic)))
    }

    fn system_appearance(&self) -> Result<Option<ade_core::appearance::PaletteMode>> {
        let stored: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM profile_settings WHERE key='system_appearance'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        stored
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(Into::into)
    }

    /// Retain the host observation even while an explicit mode is selected.
    pub fn observe_system_appearance(
        &self,
        mode: ade_core::appearance::PaletteMode,
    ) -> Result<(ProfileSettings, bool)> {
        let before = self.settings()?;
        let previous = self.system_appearance()?;
        let changed = before.appearance == ade_core::contract::settings::Appearance::System
            && previous.unwrap_or(ade_core::appearance::PaletteMode::Dark) != mode;
        let tx = self.transaction()?;
        tx.execute(
            "INSERT INTO profile_settings(key,value,updated_at) VALUES('system_appearance',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            params![serde_json::to_string(&mode)?, now_ms()],
        )?;
        if changed {
            let revision = before
                .appearance_revision
                .checked_add(1)
                .context("Appearance revision exhausted")?;
            tx.execute(
                "INSERT INTO profile_settings(key,value,updated_at) VALUES('appearance_revision',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![serde_json::to_string(&revision)?, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok((self.settings()?, changed))
    }

    pub fn terminal_appearance(&self) -> Result<ade_core::appearance::TerminalAppearance> {
        let settings = self.settings()?;
        let palette = self
            .resolve_theme_binding(&settings.terminal_binding, ThemeSectionKind::Terminal)?
            .0;
        let mut appearance = ade_core::appearance::TerminalAppearance::for_palette(&palette);
        settings.terminal_color_overrides.apply(&mut appearance);
        appearance.minimum_contrast = settings.terminal_minimum_contrast;
        appearance.bold_color = settings.terminal_bold_color;
        appearance.revision = settings.appearance_revision;
        Ok(appearance)
    }

    pub(crate) fn validate_theme_binding(
        &self,
        binding: &ThemeBinding,
        section: ThemeSectionKind,
    ) -> Result<()> {
        let selections = match binding {
            ThemeBinding::FollowApp => vec![],
            ThemeBinding::Fixed { theme_id } => vec![(theme_id, None)],
            ThemeBinding::Paired { light, dark } => vec![
                (light, Some(PaletteMode::Light)),
                (dark, Some(PaletteMode::Dark)),
            ],
        };
        for (id, mode) in selections {
            let palette = self.selection_palette(id, section)?.0.with_context(|| {
                format!("Theme {id} has no available {} section", section.name())
            })?;
            ensure!(
                mode.is_none_or(|mode| palette.mode == mode),
                "Theme {id} does not match the selected mode slot"
            );
        }
        Ok(())
    }

    pub(crate) fn resolve_theme_binding(
        &self,
        binding: &ThemeBinding,
        section: ThemeSectionKind,
    ) -> Result<(BuiltinPalette, String, Option<AppearanceDiagnostic>)> {
        self.resolve_theme_binding_variant(binding, section, self.app_palette()?.mode)
    }

    pub(crate) fn resolve_theme_binding_variant(
        &self,
        binding: &ThemeBinding,
        section: ThemeSectionKind,
        mode: PaletteMode,
    ) -> Result<(BuiltinPalette, String, Option<AppearanceDiagnostic>)> {
        let (id, required_mode) = match binding {
            ThemeBinding::FollowApp => {
                let (app, diagnostic) = self.app_palette_variant(mode)?;
                if diagnostic.is_some() {
                    return Ok((
                        app.clone(),
                        diagnostic
                            .as_ref()
                            .and_then(|d| d.selected_id.clone())
                            .unwrap_or(app.id),
                        diagnostic,
                    ));
                }
                (app.id, Some(mode))
            }
            ThemeBinding::Fixed { theme_id } => (theme_id.clone(), None),
            ThemeBinding::Paired { light, dark } => (
                if mode == PaletteMode::Light {
                    light.clone()
                } else {
                    dark.clone()
                },
                Some(mode),
            ),
        };
        let (palette, diagnostic) = self.resolve_selection(&id, section, required_mode, mode)?;
        Ok((palette, id, diagnostic))
    }

    pub fn terminal_appearance_projection(
        &self,
    ) -> Result<ade_core::appearance::TerminalAppearanceProjection> {
        let profile = self.terminal_appearance()?;
        let colors = self.settings()?.terminal_color_overrides;
        let mut overrides = BTreeMap::new();
        for terminal in super::terminal_records::visible(&self.connection)? {
            if let Some(binding) = terminal.appearance_binding {
                let mut appearance = ade_core::appearance::TerminalAppearance::for_palette(
                    &self
                        .resolve_theme_binding(&binding, ThemeSectionKind::Terminal)?
                        .0,
                );
                colors.apply(&mut appearance);
                appearance.minimum_contrast = profile.minimum_contrast;
                appearance.bold_color = profile.bold_color.clone();
                appearance.revision = profile.revision;
                overrides.insert(terminal.id, appearance);
            }
        }
        Ok(ade_core::appearance::TerminalAppearanceProjection { profile, overrides })
    }

    /// Stores the named settings. Returns every setting and whether any
    /// changed. An invalid or conflicting key changes nothing.
    pub fn set_settings(&self, change: &SettingsSetRequest) -> Result<(ProfileSettings, bool)> {
        let before = self.settings()?;
        if let Some(revisions) = &change.expected_theme_revisions {
            ensure!(
                revisions.len() <= 32,
                "Check at most 32 definition revisions"
            );
            for (id, expected) in revisions {
                let current = self.theme(id)?.revision;
                if *expected != current {
                    return Err(ade_core::error::ThemeConflict {
                        id: id.clone(),
                        expected: *expected,
                        current,
                    }
                    .into());
                }
            }
        }
        if let Some(expected) = change.expected_appearance_revision
            && expected != before.appearance_revision
        {
            return Err(ade_core::error::AppearanceConflict {
                expected,
                current: before.appearance_revision,
            }
            .into());
        }
        for (id, mode) in [
            (
                &change.app_light_theme,
                ade_core::appearance::PaletteMode::Light,
            ),
            (
                &change.app_dark_theme,
                ade_core::appearance::PaletteMode::Dark,
            ),
        ] {
            if let Some(id) = id {
                let palette = self
                    .selection_palette(id, ThemeSectionKind::App)?
                    .0
                    .with_context(|| format!("Theme {id} has no available app section"))?;
                ensure!(
                    palette.mode == mode,
                    "App palette {id} does not match the selected mode slot"
                );
            }
        }
        if let Some(binding) = &change.terminal_binding {
            self.validate_theme_binding(binding, ThemeSectionKind::Terminal)?;
        }
        if let Some(binding) = &change.syntax_binding {
            self.validate_theme_binding(binding, ThemeSectionKind::Syntax)?;
        }
        if let Some(ratio) = change.terminal_minimum_contrast {
            ensure!(
                ratio.is_finite() && (1.0..=21.0).contains(&ratio),
                "Terminal contrast must be between 1 and 21"
            );
        }
        for family in [
            &change.ui_font_family,
            &change.code_font_family,
            &change.terminal_font_family,
        ]
        .into_iter()
        .flatten()
        {
            validate_font_family(family)?;
        }
        for (size, range, name) in [
            (change.ui_font_size, 12..=24, "UI font size"),
            (change.code_font_size, 10..=32, "Code font size"),
            (change.terminal_font_size, 6..=32, "Terminal font size"),
        ] {
            if let Some(size) = size {
                ensure!(range.contains(&size), "{name} is out of range");
            }
        }
        if let Some(height) = change.terminal_line_height {
            ensure!(
                height.is_finite() && (1.0..=2.0).contains(&height),
                "Terminal line height must be between 1 and 2"
            );
        }
        let keys_changed = change.keybindings.is_some() || change.reset_keybindings.is_some();
        let overrides = if keys_changed {
            let overrides = self.keybinding_overrides()?;
            Some(changed_overrides(overrides, change)?)
        } else {
            None
        };
        let tx = self.transaction()?;
        let now = now_ms();
        let mut rows = Vec::new();
        if let Some(appearance) = change.appearance {
            rows.push(("appearance", serde_json::to_value(appearance)?));
        }
        if let Some(id) = &change.app_light_theme {
            rows.push(("app_light_theme", json!(id)));
        }
        if let Some(id) = &change.app_dark_theme {
            rows.push(("app_dark_theme", json!(id)));
        }
        if let Some(binding) = &change.terminal_binding {
            rows.push(("terminal_binding", serde_json::to_value(binding)?));
        }
        if let Some(binding) = &change.syntax_binding {
            rows.push(("syntax_binding", serde_json::to_value(binding)?));
        }
        if let Some(colors) = &change.terminal_color_overrides {
            rows.push(("terminal_color_overrides", serde_json::to_value(colors)?));
        }
        if let Some(ratio) = change.terminal_minimum_contrast {
            rows.push(("terminal_minimum_contrast", json!(ratio)));
        }
        if let Some(policy) = &change.terminal_bold_color {
            rows.push(("terminal_bold_color", serde_json::to_value(policy)?));
        }
        let repairing_selection = (change.app_light_theme.is_some()
            && self
                .app_palette_variant(ade_core::appearance::PaletteMode::Light)?
                .1
                .is_some())
            || (change.app_dark_theme.is_some()
                && self
                    .app_palette_variant(ade_core::appearance::PaletteMode::Dark)?
                    .1
                    .is_some());
        let appearance_changed = change
            .terminal_binding
            .as_ref()
            .is_some_and(|binding| binding != &before.terminal_binding)
            || change
                .terminal_color_overrides
                .as_ref()
                .is_some_and(|colors| colors != &before.terminal_color_overrides)
            || change
                .terminal_minimum_contrast
                .is_some_and(|ratio| ratio != before.terminal_minimum_contrast)
            || change
                .terminal_bold_color
                .as_ref()
                .is_some_and(|policy| policy != &before.terminal_bold_color)
            || change
                .syntax_binding
                .as_ref()
                .is_some_and(|binding| binding != &before.syntax_binding)
            || repairing_selection
            || change
                .appearance
                .is_some_and(|value| value != before.appearance)
            || change
                .app_light_theme
                .as_ref()
                .is_some_and(|value| value != &before.app_light_theme)
            || change
                .app_dark_theme
                .as_ref()
                .is_some_and(|value| value != &before.app_dark_theme);
        if appearance_changed {
            let revision = before
                .appearance_revision
                .checked_add(1)
                .context("Appearance revision exhausted")?;
            rows.push(("appearance_revision", json!(revision)));
        }
        if let Some(reduced_motion) = change.reduced_motion {
            rows.push(("reduced_motion", serde_json::to_value(reduced_motion)?));
        }
        for (key, preference) in [
            ("high_contrast", change.high_contrast),
            ("reduced_transparency", change.reduced_transparency),
            (
                "differentiate_without_color",
                change.differentiate_without_color,
            ),
        ] {
            if let Some(preference) = preference {
                rows.push((key, serde_json::to_value(preference)?));
            }
        }
        for (key, value) in [
            (
                "ui_font_family",
                change.ui_font_family.as_ref().map(|v| json!(v)),
            ),
            ("ui_font_size", change.ui_font_size.map(|v| json!(v))),
            (
                "code_font_family",
                change.code_font_family.as_ref().map(|v| json!(v)),
            ),
            ("code_font_size", change.code_font_size.map(|v| json!(v))),
            (
                "terminal_font_family",
                change.terminal_font_family.as_ref().map(|v| json!(v)),
            ),
            (
                "terminal_font_size",
                change.terminal_font_size.map(|v| json!(v)),
            ),
            ("density", change.density.map(|v| json!(v))),
            (
                "terminal_line_height",
                change.terminal_line_height.map(|v| json!(v)),
            ),
            (
                "terminal_font_kerning",
                change.terminal_font_kerning.map(|v| json!(v)),
            ),
            (
                "terminal_cursor_shape",
                change.terminal_cursor_shape.map(|v| json!(v)),
            ),
            (
                "terminal_cursor_blink",
                change.terminal_cursor_blink.map(|v| json!(v)),
            ),
        ] {
            if let Some(value) = value {
                rows.push((key, value));
            }
        }
        match &overrides {
            Some(overrides) if overrides.is_empty() => {
                tx.execute("DELETE FROM profile_settings WHERE key=?1", [KEYBINDINGS])?;
            }
            Some(overrides) => rows.push((KEYBINDINGS, serde_json::to_value(overrides)?)),
            None => {}
        }
        for (key, value) in rows {
            tx.execute(
                "INSERT INTO profile_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![key, value.to_string(), now],
            )?;
        }
        tx.commit()?;
        let after = self.settings()?;
        let changed = after != before;
        Ok((after, changed))
    }

    fn keybinding_overrides(&self) -> Result<Overrides> {
        let stored: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM profile_settings WHERE key=?1",
                [KEYBINDINGS],
                |row| row.get(0),
            )
            .optional()?;
        Ok(match stored {
            Some(text) => serde_json::from_str(&text)?,
            None => Overrides::new(),
        })
    }
}

fn validate_font_family(family: &str) -> Result<()> {
    ensure!(!family.trim().is_empty(), "Font family must not be empty");
    ensure!(
        family.chars().count() <= 128,
        "Font family must be at most 128 characters"
    );
    ensure!(
        !family.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    ',' | ';'
                        | ':'
                        | '{'
                        | '}'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '<'
                        | '>'
                        | '"'
                        | '\''
                        | '\\'
                        | '/'
                        | '*'
                )
        }),
        "Font family contains a control character or CSS delimiter"
    );
    Ok(())
}

/// Every command's key: its override, or its default.
fn effective(overrides: &Overrides) -> Keybindings {
    let mut keys = Keybindings::default();
    for (command, key) in overrides {
        keys.set(*command, key.clone());
    }
    keys
}

/// Applies a change's resets, then its keys, to the stored overrides, and
/// refuses a key that is not an accelerator or that two commands would share.
fn changed_overrides(mut overrides: Overrides, change: &SettingsSetRequest) -> Result<Overrides> {
    match &change.reset_keybindings {
        Some(KeybindingReset::All(_)) => overrides.clear(),
        Some(KeybindingReset::Commands(commands)) => {
            for command in commands {
                ensure!(
                    !change
                        .keybindings
                        .as_ref()
                        .is_some_and(|keys| keys.contains_key(command)),
                    "{} is both reset and given a key; send one",
                    command.id()
                );
                overrides.remove(command);
            }
        }
        None => {}
    }
    for (command, key) in change.keybindings.iter().flatten() {
        if let Some(key) = key {
            ade_core::keybindings::validate(key).map_err(|reason| InvalidKeybinding {
                command: command.id().into(),
                key: key.clone(),
                reason,
            })?;
        }
        if key.as_deref() == Some(command.default_key()) {
            overrides.remove(command);
        } else {
            overrides.insert(*command, key.clone());
        }
    }
    if let Some((key, commands)) = ade_core::keybindings::conflict(&effective(&overrides)) {
        return Err(KeybindingConflict {
            key,
            commands: commands.iter().map(|command| command.id().into()).collect(),
        }
        .into());
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::super::tests::Database;
    use ade_core::contract::settings::{
        AppCommand, Appearance, KeybindingReset, ReducedMotion, SettingsSetRequest,
    };

    #[test]
    fn settings_default_until_set_and_persist() {
        let db = Database::new();
        let store = db.open();
        assert_eq!(store.settings().unwrap(), Default::default());
        let change = SettingsSetRequest {
            appearance: Some(Appearance::Dark),
            ..Default::default()
        };
        let (settings, changed) = store.set_settings(&change).unwrap();
        assert!(changed);
        assert_eq!(settings.appearance, Appearance::Dark);
        assert_eq!(settings.reduced_motion, ReducedMotion::System);
        assert!(!store.set_settings(&change).unwrap().1);
        drop(store);
        assert_eq!(db.open().settings().unwrap().appearance, Appearance::Dark);
    }

    #[test]
    fn keybindings_merge_reset_and_refuse_before_anything_changes() {
        let db = Database::new();
        let store = db.open();
        let bind = |pairs: &[(AppCommand, Option<&str>)]| SettingsSetRequest {
            keybindings: Some(
                pairs
                    .iter()
                    .map(|(command, key)| (*command, key.map(str::to_owned)))
                    .collect(),
            ),
            ..Default::default()
        };
        let (settings, changed) = store
            .set_settings(&bind(&[
                (AppCommand::NewTab, Some("CmdOrCtrl+Shift+T")),
                (AppCommand::ToggleDevPanel, None),
            ]))
            .unwrap();
        assert!(changed);
        assert_eq!(
            settings.keybindings.get(AppCommand::NewTab),
            Some("CmdOrCtrl+Shift+T")
        );
        assert_eq!(settings.keybindings.get(AppCommand::ToggleDevPanel), None);
        assert_eq!(
            settings.keybindings.get(AppCommand::CloseTab),
            Some("CmdOrCtrl+W")
        );
        // A conflict or an invalid key changes nothing, appearance included.
        let mut clash = bind(&[(AppCommand::CloseTab, Some("CmdOrCtrl+Shift+T"))]);
        clash.appearance = Some(Appearance::Light);
        let error = store.set_settings(&clash).unwrap_err();
        assert!(
            error
                .downcast_ref::<ade_core::error::KeybindingConflict>()
                .is_some()
        );
        let error = store
            .set_settings(&bind(&[(AppCommand::CloseTab, Some("Ctrl+"))]))
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<ade_core::error::InvalidKeybinding>()
                .is_some()
        );
        assert_eq!(store.settings().unwrap().appearance, Appearance::System);
        // Resetting one command leaves the other override.
        let reset_one = SettingsSetRequest {
            reset_keybindings: Some(KeybindingReset::Commands(vec![AppCommand::NewTab])),
            ..Default::default()
        };
        let settings = store.set_settings(&reset_one).unwrap().0;
        assert_eq!(
            settings.keybindings.get(AppCommand::NewTab),
            Some("CmdOrCtrl+T")
        );
        assert_eq!(settings.keybindings.get(AppCommand::ToggleDevPanel), None);
        let both = SettingsSetRequest {
            reset_keybindings: Some(KeybindingReset::Commands(vec![AppCommand::NewTab])),
            ..bind(&[(AppCommand::NewTab, Some("F5"))])
        };
        assert!(store.set_settings(&both).is_err());
        let reset_all = SettingsSetRequest {
            reset_keybindings: Some(KeybindingReset::All(Default::default())),
            ..Default::default()
        };
        assert!(store.set_settings(&reset_all).unwrap().1);
        assert_eq!(store.settings().unwrap(), Default::default());
        assert!(!store.set_settings(&reset_all).unwrap().1);
    }
    #[test]
    fn typography_density_and_cursor_preferences_persist_independently() {
        use ade_core::contract::settings::{Density, TerminalCursorShape, TerminalFontKerning};

        let db = Database::new();
        let store = db.open();
        let defaults = store.settings().unwrap();
        let appearance_before = store.terminal_appearance_projection().unwrap();
        let (updated, changed) = store
            .set_settings(&SettingsSetRequest {
                ui_font_family: Some("UI Custom".into()),
                ui_font_size: Some(24),
                code_font_family: Some("Code Custom".into()),
                code_font_size: Some(32),
                terminal_font_family: Some("Terminal Custom".into()),
                terminal_font_size: Some(6),
                density: Some(Density::Compact),
                terminal_line_height: Some(2.0),
                terminal_font_kerning: Some(TerminalFontKerning::None),
                terminal_cursor_shape: Some(TerminalCursorShape::Underline),
                terminal_cursor_blink: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert!(changed);
        assert_eq!(updated.appearance_revision, defaults.appearance_revision);
        assert_eq!(
            store.terminal_appearance_projection().unwrap(),
            appearance_before
        );
        assert_eq!(updated.ui_font_family, "UI Custom");
        assert_eq!(updated.ui_font_size, 24);
        assert_eq!(updated.code_font_family, "Code Custom");
        assert_eq!(updated.code_font_size, 32);
        assert_eq!(updated.terminal_font_family, "Terminal Custom");
        assert_eq!(updated.terminal_font_size, 6);
        assert_eq!(updated.density, Density::Compact);
        assert_eq!(updated.terminal_line_height, 2.0);
        assert_eq!(updated.terminal_font_kerning, TerminalFontKerning::None);
        assert_eq!(
            updated.terminal_cursor_shape,
            TerminalCursorShape::Underline
        );
        assert!(!updated.terminal_cursor_blink);

        let (partial, changed) = store
            .set_settings(&SettingsSetRequest {
                ui_font_size: Some(12),
                ..Default::default()
            })
            .unwrap();
        assert!(changed);
        assert_eq!(partial.ui_font_family, "UI Custom");
        assert_eq!(partial.ui_font_size, 12);
        assert_eq!(partial.code_font_family, "Code Custom");
        assert!(!partial.terminal_cursor_blink);
        drop(store);
        let reopened = db.open().settings().unwrap();
        assert_eq!(reopened.ui_font_family, "UI Custom");
        assert_eq!(reopened.ui_font_size, 12);
        assert_eq!(reopened.code_font_family, "Code Custom");
        assert_eq!(reopened.code_font_size, 32);
        assert_eq!(reopened.terminal_font_family, "Terminal Custom");
        assert_eq!(reopened.terminal_font_size, 6);
        assert_eq!(reopened.density, Density::Compact);
        assert_eq!(reopened.terminal_line_height, 2.0);
        assert_eq!(reopened.terminal_font_kerning, TerminalFontKerning::None);
        assert_eq!(
            reopened.terminal_cursor_shape,
            TerminalCursorShape::Underline
        );
        assert!(!reopened.terminal_cursor_blink);
        assert_eq!(reopened.appearance_revision, defaults.appearance_revision);
    }

    #[test]
    fn invalid_typography_preferences_are_rejected_without_any_mutation() {
        let db = Database::new();
        let store = db.open();
        let before = store.settings().unwrap();
        let invalid = [
            SettingsSetRequest {
                ui_font_family: Some("  ".into()),
                ..Default::default()
            },
            SettingsSetRequest {
                code_font_family: Some("bad;font".into()),
                ..Default::default()
            },
            SettingsSetRequest {
                terminal_font_family: Some("bad/font".into()),
                ..Default::default()
            },
            SettingsSetRequest {
                terminal_font_family: Some("x".repeat(129)),
                ..Default::default()
            },
            SettingsSetRequest {
                ui_font_size: Some(11),
                ..Default::default()
            },
            SettingsSetRequest {
                code_font_size: Some(33),
                ..Default::default()
            },
            SettingsSetRequest {
                terminal_font_size: Some(5),
                ..Default::default()
            },
            SettingsSetRequest {
                terminal_line_height: Some(f64::NAN),
                ..Default::default()
            },
            SettingsSetRequest {
                terminal_line_height: Some(2.01),
                ..Default::default()
            },
        ];
        for (index, change) in invalid.into_iter().enumerate() {
            let change = SettingsSetRequest {
                appearance: Some(Appearance::Dark),
                ..change
            };
            assert!(
                store.set_settings(&change).is_err(),
                "invalid case {index}: {change:?}"
            );
            assert_eq!(store.settings().unwrap(), before);
        }
    }
}
