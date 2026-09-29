//! Profile settings: one row per key the person set, in `profile_settings`.
//! A key never set reads as its default. The `keybindings` row holds only
//! the commands whose key differs from the default (a key, or null for
//! none); every other command reads its default key.
use super::*;
use ade_core::contract::settings::{
    AppCommand, KeybindingReset, Keybindings, ProfileSettings, SettingsSetRequest,
};
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
            } else if settings.get(&key).is_some() {
                settings[key] = serde_json::from_str(&value)?;
            }
        }
        let mut settings: ProfileSettings = serde_json::from_value(settings)?;
        settings.keybindings = effective(&overrides);
        Ok(settings)
    }

    /// Stores the named settings. Returns every setting and whether any
    /// changed. An invalid or conflicting key changes nothing.
    pub fn set_settings(&self, change: &SettingsSetRequest) -> Result<(ProfileSettings, bool)> {
        let before = self.settings()?;
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
        if let Some(reduced_motion) = change.reduced_motion {
            rows.push(("reduced_motion", serde_json::to_value(reduced_motion)?));
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
}
