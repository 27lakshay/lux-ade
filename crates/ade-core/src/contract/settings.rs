//! Profile settings (F013, F014, F015): appearance and motion today, with room
//! for typography and keybindings. They are durable profile state, so every
//! client applies the same preferences; a change reaches every subscriber as
//! a `settings_changed` frame.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<SettingsGetRequest, Settings>("settings.get", Tier::Query),
        // Setting a key to the value it has changes nothing and sends no frame.
        OperationSpec::new::<SettingsSetRequest, Settings>("settings.set", Tier::IdempotentCommand),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<SettingsChanged>("settings_changed")]
}

/// Light, dark, or follow the system.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Appearance {
    Light,
    Dark,
    #[default]
    System,
}

/// Reduce motion: follow the system, always, or never.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReducedMotion {
    #[default]
    System,
    On,
    Off,
}

/// Every profile setting, each at its default until set. Typography (F014)
/// and keybindings (F015) join as keys here.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileSettings {
    pub appearance: Appearance,
    pub reduced_motion: ReducedMotion,
}

/// The keys `settings.set` accepts, in wire form.
pub const KEYS: [&str; 2] = ["appearance", "reduced_motion"];

/// `settings.get`: read every profile setting.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsGetRequest {}

/// `settings.set`: change the named settings and leave the others. A key the
/// profile does not keep is refused with `unknown_setting`, before anything
/// changes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsSetRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<ReducedMotion>,
}

wire_tag!(SettingsTag, "settings");
wire_tag!(SettingsChangedTag, "settings_changed");

/// The `settings.get` and `settings.set` reply: every setting as it is now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct Settings {
    #[serde(rename = "type")]
    pub tag: SettingsTag,
    pub settings: ProfileSettings,
}

/// The `settings_changed` feed frame: every setting after a change.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SettingsChanged {
    #[serde(rename = "type")]
    pub tag: SettingsChangedTag,
    pub settings: ProfileSettings,
    pub boot_id: String,
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde_json::{Value, json};

    fn spec(op: &str) -> Value {
        bundle()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone()
    }

    fn validator(name: &str) -> jsonschema::Validator {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).expect("generated schema compiles")
    }

    #[test]
    fn settings_operations_declare_tiers_and_round_trip() {
        assert_eq!(spec("settings.get")["tier"], "query");
        assert_eq!(spec("settings.set")["tier"], "idempotent_command");
        let set = spec("settings.set")["request"].as_str().unwrap().to_owned();
        let valid = validator(&set);
        assert!(valid.is_valid(&json!({"op": "settings.set", "appearance": "dark"})));
        assert!(valid.is_valid(&json!({"op": "settings.set", "reduced_motion": "on"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "appearance": "sepia"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "colour": "red"})));
        let reply = spec("settings.get")["response"]
            .as_str()
            .unwrap()
            .to_owned();
        let wire = serde_json::to_value(Settings {
            tag: Default::default(),
            settings: ProfileSettings::default(),
        })
        .unwrap();
        assert_eq!(
            wire,
            json!({"type": "settings", "settings": {"appearance": "system", "reduced_motion": "system"}})
        );
        assert!(validator(&reply).is_valid(&wire));
        for key in KEYS {
            assert!(wire["settings"].get(key).is_some(), "{key}");
        }
    }
}
