//! `settings.get` and `settings.set`: profile preferences every client
//! applies. A change reaches every subscriber as a `settings_changed` frame.
use super::*;
use ade_core::contract::settings::{KEYS, Settings, SettingsGetRequest, SettingsSetRequest};

impl Sessions {
    pub(super) fn settings_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "settings.get" => {
                let SettingsGetRequest {} = decode(request)?;
                reply(&Settings {
                    tag: Default::default(),
                    settings: self.data.lock().unwrap().store.settings()?,
                })
            }
            "settings.set" => {
                // An unknown key is refused by name, before anything changes.
                if let Some(fields) = request.as_object() {
                    for key in fields.keys() {
                        if !matches!(key.as_str(), "op" | "diagnostic_id")
                            && !KEYS.contains(&key.as_str())
                        {
                            return Err(ade_core::error::UnknownSetting(key.clone()).into());
                        }
                    }
                }
                let change: SettingsSetRequest = decode(request)?;
                let mut d = self.data.lock().unwrap();
                let (settings, changed) = d.store.set_settings(&change)?;
                if changed {
                    self.publish(
                        &mut d,
                        json!({"type": "settings_changed", "settings": settings}),
                    );
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
