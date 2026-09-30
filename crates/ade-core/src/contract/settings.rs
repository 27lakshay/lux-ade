//! Profile settings (F013, F014, F015): appearance, typography, density, motion, and keybindings.
//! They are durable profile state, so every client applies the same preferences; a change reaches every subscriber as a
//! `settings_changed` frame.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<SystemAppearanceObservation, Settings>(
            "settings.appearance.observe",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<SettingsPalettesRequest, PaletteCatalog>(
            "settings.palettes",
            Tier::Query,
        ),
        OperationSpec::new::<SettingsResetAppearanceRequest, Settings>(
            "settings.appearance.reset",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<SettingsAppearanceRequest, ResolvedAppearance>(
            "settings.appearance",
            Tier::Query,
        ),
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

/// Accessibility preferences: follow the system, enable, or disable.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessibilityPreference {
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

/// Every profile setting, each at its default until set.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Density {
    #[default]
    Default,
    Compact,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalFontKerning {
    #[default]
    Auto,
    Normal,
    None,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCursorShape {
    #[default]
    Block,
    Bar,
    Underline,
}
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ProfileSettings {
    pub appearance_revision: u64,
    pub appearance: Appearance,
    pub app_light_theme: String,
    pub app_dark_theme: String,
    pub terminal_binding: crate::appearance::ThemeBinding,
    pub syntax_binding: crate::appearance::ThemeBinding,
    pub terminal_color_overrides: crate::appearance::TerminalColorOverrides,
    #[schemars(with = "serde_json::Number", range(min = 1.0, max = 21.0))]
    pub terminal_minimum_contrast: f64,
    pub terminal_bold_color: crate::appearance::BoldColor,
    pub reduced_motion: ReducedMotion,
    pub high_contrast: AccessibilityPreference,
    pub reduced_transparency: AccessibilityPreference,
    pub differentiate_without_color: AccessibilityPreference,
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub ui_font_family: String,
    #[schemars(range(min = 12, max = 24))]
    pub ui_font_size: u8,
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub code_font_family: String,
    #[schemars(range(min = 10, max = 32))]
    pub code_font_size: u8,
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub terminal_font_family: String,
    #[schemars(range(min = 6, max = 32))]
    pub terminal_font_size: u8,
    pub density: Density,
    #[schemars(with = "serde_json::Number", range(min = 1.0, max = 2.0))]
    pub terminal_line_height: f64,
    pub terminal_font_kerning: TerminalFontKerning,
    pub terminal_cursor_shape: TerminalCursorShape,
    pub terminal_cursor_blink: bool,
    pub keybindings: Keybindings,
}
impl Default for ProfileSettings {
    fn default() -> Self {
        Self {
            appearance_revision: 0,
            appearance: Default::default(),
            app_light_theme: "ade:chalk".into(),
            app_dark_theme: "ade:graphite".into(),
            terminal_binding: Default::default(),
            syntax_binding: Default::default(),
            terminal_color_overrides: Default::default(),
            terminal_minimum_contrast: 1.0,
            terminal_bold_color: Default::default(),
            reduced_motion: Default::default(),
            high_contrast: Default::default(),
            reduced_transparency: Default::default(),
            differentiate_without_color: Default::default(),
            ui_font_family: "Inter Variable".into(),
            ui_font_size: 13,
            code_font_family: "JetBrains Mono Variable".into(),
            code_font_size: 12,
            terminal_font_family: "JetBrains Mono Variable".into(),
            terminal_font_size: 12,
            density: Density::Default,
            terminal_line_height: 1.35,
            terminal_font_kerning: TerminalFontKerning::Auto,
            terminal_cursor_shape: TerminalCursorShape::Block,
            terminal_cursor_blink: true,
            keybindings: Default::default(),
        }
    }
}

/// The settings.set keys accepted besides reset_keybindings, in wire form.
pub const KEYS: [&str; 24] = [
    "appearance",
    "app_light_theme",
    "app_dark_theme",
    "terminal_binding",
    "syntax_binding",
    "terminal_color_overrides",
    "terminal_minimum_contrast",
    "terminal_bold_color",
    "reduced_motion",
    "high_contrast",
    "reduced_transparency",
    "differentiate_without_color",
    "ui_font_family",
    "ui_font_size",
    "code_font_family",
    "code_font_size",
    "terminal_font_family",
    "terminal_font_size",
    "density",
    "terminal_line_height",
    "terminal_font_kerning",
    "terminal_cursor_shape",
    "terminal_cursor_blink",
    "keybindings",
];

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
    /// Fence custom definitions captured by a selection or preview, including inactive variants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_theme_revisions: Option<std::collections::BTreeMap<String, u64>>,
    /// Reject the entire change if another appearance edit has committed since this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_appearance_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_light_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_dark_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_binding: Option<crate::appearance::ThemeBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syntax_binding: Option<crate::appearance::ThemeBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_color_overrides: Option<crate::appearance::TerminalColorOverrides>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_contrast"
    )]
    #[schemars(with = "serde_json::Number", range(min = 1.0, max = 21.0))]
    pub terminal_minimum_contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_bold_color: Option<crate::appearance::BoldColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<ReducedMotion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_contrast: Option<AccessibilityPreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_transparency: Option<AccessibilityPreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub differentiate_without_color: Option<AccessibilityPreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub ui_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 12, max = 24))]
    pub ui_font_size: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub code_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 10, max = 32))]
    pub code_font_size: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = "^[\\s\\S]{1,128}$"))]
    pub terminal_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 6, max = 32))]
    pub terminal_font_size: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<Density>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_line_height"
    )]
    #[schemars(with = "serde_json::Number", range(min = 1.0, max = 2.0))]
    pub terminal_line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_font_kerning: Option<TerminalFontKerning>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cursor_shape: Option<TerminalCursorShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cursor_blink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybindings: Option<BTreeMap<AppCommand, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_keybindings: Option<KeybindingReset>,
}

fn deserialize_contrast<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

fn deserialize_line_height<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
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

/// Restore the core appearance defaults without changing other preferences.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SettingsResetAppearanceRequest {
    pub expected_appearance_revision: u64,
}

/// Inspect the saved projection and independently acknowledged runtime state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsAppearanceRequest {}

wire_tag!(AppearanceTag, "appearance");

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AppearancePropagation {
    Applied {
        revision: u64,
    },
    Pending {
        desired_revision: u64,
        applied_revision: u64,
    },
    Unavailable {
        desired_revision: u64,
        message: String,
    },
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AppearanceDiagnosticCode {
    MissingTheme,
    MissingSection,
    InvalidDefinition,
    WrongMode,
    InvalidSelection,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AppearanceDiagnostic {
    pub code: AppearanceDiagnosticCode,
    pub slot: crate::appearance::PaletteMode,
    pub selected_id: Option<String>,
    pub fallback_id: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ResolvedAppearance {
    #[serde(rename = "type")]
    pub tag: AppearanceTag,
    pub revision: u64,
    pub theme_id: String,
    pub preference: Appearance,
    pub diagnostics: Vec<AppearanceDiagnostic>,
    pub light_palette: crate::appearance::BuiltinPalette,
    pub dark_palette: crate::appearance::BuiltinPalette,
    pub mode: crate::appearance::PaletteMode,
    pub tokens: BTreeMap<String, String>,
    pub syntax: ResolvedSyntaxAppearance,
    pub terminal: crate::appearance::TerminalAppearance,
    pub terminal_diagnostics: Vec<AppearanceDiagnostic>,
    pub propagation: AppearancePropagation,
}

/// Independently selected code colors and surface tokens. App chrome is separate.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ResolvedSyntaxAppearance {
    /// Both startup variants; a valid fixed binding repeats its palette in both slots.
    pub light_palette: crate::appearance::BuiltinPalette,
    pub dark_palette: crate::appearance::BuiltinPalette,
    pub binding: crate::appearance::ThemeBinding,
    pub selected_id: String,
    pub palette: crate::appearance::BuiltinPalette,
    pub diagnostics: Vec<AppearanceDiagnostic>,
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
        assert!(valid.is_valid(&json!({"op": "settings.set", "high_contrast": "on", "reduced_transparency": "off", "differentiate_without_color": "system"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "high_contrast": "sometimes"})));
        assert!(valid.is_valid(&json!({"op": "settings.set", "ui_font_family": "Inter Variable", "ui_font_size": 12, "code_font_size": 32, "terminal_font_size": 6, "density": "compact", "terminal_line_height": 2.0, "terminal_font_kerning": "none", "terminal_cursor_shape": "underline", "terminal_cursor_blink": false})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "ui_font_family": ""})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "ui_font_family": "x".repeat(129)})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "density": "spacious"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "terminal_cursor_shape": "circle"})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "ui_font_size": 11})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "code_font_size": 33})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "terminal_font_size": 5})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "terminal_line_height": 2.01})));
        assert!(!valid.is_valid(&json!({"op": "settings.set", "terminal_font_kerning": "wide"})));
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
        assert_eq!(wire["settings"]["high_contrast"], "system");
        assert_eq!(wire["settings"]["reduced_transparency"], "system");
        assert_eq!(wire["settings"]["differentiate_without_color"], "system");
        assert_eq!(wire["settings"]["appearance_revision"], 0);
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

/// Built-in app palette variants, including their explicit mode and complete semantic tokens.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct SettingsPalettesRequest {}

wire_tag!(PalettesTag, "palettes");

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct PaletteCatalog {
    #[serde(rename = "type")]
    pub tag: PalettesTag,
    pub palettes: Vec<crate::appearance::BuiltinPalette>,
}

/// A sequenced OS observation from the registered local desktop owner.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SystemAppearanceObservation {
    pub profile_id: String,
    pub owner_id: String,
    pub sequence: u64,
    pub mode: crate::appearance::PaletteMode,
}
