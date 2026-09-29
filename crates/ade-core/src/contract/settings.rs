//! Profile settings (F013, F014, F015): appearance, motion and keybindings,
//! with room for typography. They are durable profile state, so every client
//! applies the same preferences; a change reaches every subscriber as a
//! `settings_changed` frame.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

/// An app command a key runs: the desktop's application-menu commands
/// (F015). Every client reads the same keys for them from the daemon.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "kebab-case")]
pub enum AppCommand {
    NewConversation,
    NewTab,
    NewTerminal,
    CloseTab,
    SplitRight,
    CommandPalette,
    ToggleLeftSidebar,
    ToggleRightSidebar,
    ToggleDevPanel,
    OpenSettings,
}

impl AppCommand {
    pub const ALL: [Self; 10] = [
        Self::NewConversation,
        Self::NewTab,
        Self::NewTerminal,
        Self::CloseTab,
        Self::SplitRight,
        Self::CommandPalette,
        Self::ToggleLeftSidebar,
        Self::ToggleRightSidebar,
        Self::ToggleDevPanel,
        Self::OpenSettings,
    ];

    /// The command's ID on the wire.
    pub fn id(self) -> &'static str {
        match self {
            Self::NewConversation => "new-conversation",
            Self::NewTab => "new-tab",
            Self::NewTerminal => "new-terminal",
            Self::CloseTab => "close-tab",
            Self::SplitRight => "split-right",
            Self::CommandPalette => "command-palette",
            Self::ToggleLeftSidebar => "toggle-left-sidebar",
            Self::ToggleRightSidebar => "toggle-right-sidebar",
            Self::ToggleDevPanel => "toggle-dev-panel",
            Self::OpenSettings => "open-settings",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|command| command.id() == id)
    }

    /// The key the command has until the person changes it, as an Electron
    /// accelerator.
    pub fn default_key(self) -> &'static str {
        match self {
            Self::OpenSettings => "CmdOrCtrl+,",
            Self::NewConversation => "CmdOrCtrl+N",
            Self::NewTab => "CmdOrCtrl+T",
            // VS Code's key for a new terminal; CmdOrCtrl+T stays with new tabs.
            Self::NewTerminal => "Ctrl+Shift+`",
            Self::CloseTab => "CmdOrCtrl+W",
            Self::CommandPalette => "CmdOrCtrl+Shift+P",
            Self::ToggleLeftSidebar => "CmdOrCtrl+B",
            Self::ToggleRightSidebar => "CmdOrCtrl+Alt+B",
            Self::SplitRight => "CmdOrCtrl+\\",
            Self::ToggleDevPanel => "CmdOrCtrl+.",
        }
    }
}

/// Every app command's key: an Electron accelerator, or null when the
/// command has no key.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Keybindings {
    #[serde(rename = "new-conversation")]
    pub new_conversation: Option<String>,
    #[serde(rename = "new-tab")]
    pub new_tab: Option<String>,
    #[serde(rename = "new-terminal")]
    pub new_terminal: Option<String>,
    #[serde(rename = "close-tab")]
    pub close_tab: Option<String>,
    #[serde(rename = "split-right")]
    pub split_right: Option<String>,
    #[serde(rename = "command-palette")]
    pub command_palette: Option<String>,
    #[serde(rename = "toggle-left-sidebar")]
    pub toggle_left_sidebar: Option<String>,
    #[serde(rename = "toggle-right-sidebar")]
    pub toggle_right_sidebar: Option<String>,
    #[serde(rename = "toggle-dev-panel")]
    pub toggle_dev_panel: Option<String>,
    #[serde(rename = "open-settings")]
    pub open_settings: Option<String>,
}

impl Keybindings {
    /// The command's key, or `None` when it has none.
    pub fn get(&self, command: AppCommand) -> Option<&str> {
        self.slot(command).as_deref()
    }

    pub fn set(&mut self, command: AppCommand, key: Option<String>) {
        *self.slot_mut(command) = key;
    }

    fn slot(&self, command: AppCommand) -> &Option<String> {
        match command {
            AppCommand::NewConversation => &self.new_conversation,
            AppCommand::NewTab => &self.new_tab,
            AppCommand::NewTerminal => &self.new_terminal,
            AppCommand::CloseTab => &self.close_tab,
            AppCommand::SplitRight => &self.split_right,
            AppCommand::CommandPalette => &self.command_palette,
            AppCommand::ToggleLeftSidebar => &self.toggle_left_sidebar,
            AppCommand::ToggleRightSidebar => &self.toggle_right_sidebar,
            AppCommand::ToggleDevPanel => &self.toggle_dev_panel,
            AppCommand::OpenSettings => &self.open_settings,
        }
    }

    fn slot_mut(&mut self, command: AppCommand) -> &mut Option<String> {
        match command {
            AppCommand::NewConversation => &mut self.new_conversation,
            AppCommand::NewTab => &mut self.new_tab,
            AppCommand::NewTerminal => &mut self.new_terminal,
            AppCommand::CloseTab => &mut self.close_tab,
            AppCommand::SplitRight => &mut self.split_right,
            AppCommand::CommandPalette => &mut self.command_palette,
            AppCommand::ToggleLeftSidebar => &mut self.toggle_left_sidebar,
            AppCommand::ToggleRightSidebar => &mut self.toggle_right_sidebar,
            AppCommand::ToggleDevPanel => &mut self.toggle_dev_panel,
            AppCommand::OpenSettings => &mut self.open_settings,
        }
    }
}

impl Default for Keybindings {
    /// Every command at its default key.
    fn default() -> Self {
        let mut keys = Self {
            new_conversation: None,
            new_tab: None,
            new_terminal: None,
            close_tab: None,
            split_right: None,
            command_palette: None,
            toggle_left_sidebar: None,
            toggle_right_sidebar: None,
            toggle_dev_panel: None,
            open_settings: None,
        };
        for command in AppCommand::ALL {
            keys.set(command, Some(command.default_key().to_owned()));
        }
        keys
    }
}

/// Every profile setting, each at its default until set. Typography (F014)
/// joins as a key here.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileSettings {
    pub appearance: Appearance,
    pub reduced_motion: ReducedMotion,
    pub keybindings: Keybindings,
}

/// The keys `settings.set` accepts besides `reset_keybindings`, in wire form.
pub const KEYS: [&str; 3] = ["appearance", "reduced_motion", "keybindings"];

/// Which keybindings `settings.set` returns to their defaults: `"all"`, or
/// the listed commands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum KeybindingReset {
    All(AllTag),
    Commands(Vec<AppCommand>),
}

/// `settings.get`: read every profile setting.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsGetRequest {}

/// `settings.set`: change the named settings and leave the others. A key the
/// profile does not keep, or a command in `keybindings` or
/// `reset_keybindings` that does not exist, is refused with
/// `unknown_setting`, before anything changes.
///
/// `keybindings` binds each named command to an Electron accelerator, or
/// unbinds it with null; the other commands keep their keys.
/// `reset_keybindings` first returns the named commands, or `"all"`, to their
/// default keys; a command may not appear in both. A key that is not an
/// accelerator is `invalid_keybinding`; two commands left on the same key is
/// `keybinding_conflict`. Either refusal changes nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsSetRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<ReducedMotion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybindings: Option<BTreeMap<AppCommand, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_keybindings: Option<KeybindingReset>,
}

wire_tag!(AllTag, "all");
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
        assert!(valid.is_valid(&json!({"op": "settings.set",
            "keybindings": {"new-tab": "CmdOrCtrl+Shift+T", "close-tab": null}})));
        assert!(valid.is_valid(&json!({"op": "settings.set", "reset_keybindings": "all"})));
        assert!(valid.is_valid(&json!({"op": "settings.set", "reset_keybindings": ["new-tab"]})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "reset_keybindings": "some"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "reset_keybindings": ["nope"]})));
        let change: SettingsSetRequest = serde_json::from_value(json!({
            "keybindings": {"new-tab": null}, "reset_keybindings": "all"}))
        .unwrap();
        assert_eq!(change.keybindings.unwrap()[&AppCommand::NewTab], None);
        assert_eq!(
            change.reset_keybindings,
            Some(KeybindingReset::All(AllTag::Tag))
        );
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
            json!({"type": "settings", "settings": {"appearance": "system", "reduced_motion": "system",
                "keybindings": {"new-conversation": "CmdOrCtrl+N", "new-tab": "CmdOrCtrl+T",
                    "new-terminal": "Ctrl+Shift+`", "close-tab": "CmdOrCtrl+W",
                    "split-right": "CmdOrCtrl+\\", "command-palette": "CmdOrCtrl+Shift+P",
                    "toggle-left-sidebar": "CmdOrCtrl+B", "toggle-right-sidebar": "CmdOrCtrl+Alt+B",
                    "toggle-dev-panel": "CmdOrCtrl+.", "open-settings": "CmdOrCtrl+,"}}})
        );
        for command in AppCommand::ALL {
            assert_eq!(AppCommand::from_id(command.id()), Some(command));
            assert_eq!(serde_json::to_value(command).unwrap(), command.id());
        }
        assert!(validator(&reply).is_valid(&wire));
        for key in KEYS {
            assert!(wire["settings"].get(key).is_some(), "{key}");
        }
    }
}
