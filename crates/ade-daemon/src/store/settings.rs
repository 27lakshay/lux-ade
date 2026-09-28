//! Profile settings: one row per key the person set, in `profile_settings`
//! (created by the catalog projects migration). A key never set reads as its
//! default.
use super::*;
use ade_core::contract::settings::{ProfileSettings, SettingsSetRequest};

impl Store {
    /// Every setting: the stored value, or the default.
    pub fn settings(&self) -> Result<ProfileSettings> {
        let rows: Vec<(String, String)> = self
            .connection
            .prepare("SELECT key,value FROM profile_settings")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut settings = serde_json::to_value(ProfileSettings::default())?;
        for (key, value) in rows {
            // A key a later build added and this one does not know stays stored.
            if settings.get(&key).is_some() {
                settings[key] = serde_json::from_str(&value)?;
            }
        }
        Ok(serde_json::from_value(settings)?)
    }

    /// Stores the named settings. Returns every setting and whether any changed.
    pub fn set_settings(&self, change: &SettingsSetRequest) -> Result<(ProfileSettings, bool)> {
        let before = self.settings()?;
        let tx = self.transaction()?;
        let now = now_ms();
        if let Value::Object(fields) = serde_json::to_value(change)? {
            for (key, value) in fields {
                tx.execute(
                    "INSERT INTO profile_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                    params![key, value.to_string(), now],
                )?;
            }
        }
        tx.commit()?;
        let after = self.settings()?;
        let changed = after != before;
        Ok((after, changed))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Database;
    use ade_core::contract::settings::{Appearance, ReducedMotion};

    #[test]
    fn settings_default_until_set_and_persist() {
        let db = Database::new();
        let store = db.open();
        assert_eq!(store.settings().unwrap(), Default::default());
        let change = ade_core::contract::settings::SettingsSetRequest {
            appearance: Some(Appearance::Dark),
            reduced_motion: None,
        };
        let (settings, changed) = store.set_settings(&change).unwrap();
        assert!(changed);
        assert_eq!(settings.appearance, Appearance::Dark);
        assert_eq!(settings.reduced_motion, ReducedMotion::System);
        assert!(!store.set_settings(&change).unwrap().1);
        drop(store);
        assert_eq!(db.open().settings().unwrap().appearance, Appearance::Dark);
    }
}
