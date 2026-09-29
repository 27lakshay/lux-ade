//! `settings.get` and `settings.set`: profile preferences every client
//! applies. A change reaches every subscriber as a `settings_changed` frame.
use super::*;
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
        if !matches!(key.as_str(), "op" | "diagnostic_id" | "reset_keybindings")
            && !KEYS.contains(&key.as_str())
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
                known_names(request)?;
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
