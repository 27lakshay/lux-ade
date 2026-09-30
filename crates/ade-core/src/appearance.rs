//! Literal ADE palettes and their terminal projection. No UI or process dependencies.
pub mod definition;
pub mod pack;
use crate::contract::settings::Appearance;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[repr(C)]
#[serde(deny_unknown_fields)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Literal sRGB or the underlying cell color after reverse-video resolution.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum TerminalColor {
    Literal(Rgb),
    Alpha(Rgba),
    Cell(CellColor),
}

/// Eight-bit alpha is retained exactly; only view rendering composites it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeSectionKind {
    App,
    Terminal,
    Syntax,
}

impl ThemeSectionKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Terminal => "terminal",
            Self::Syntax => "syntax",
        }
    }
}

impl definition::ThemeDefinition {
    /// Resolve a complete section against core scaffolding, never the currently visible theme.
    /// Unsupported extension tokens remain stored but cannot enter a consumer projection.
    pub fn palette(&self, kind: ThemeSectionKind) -> Option<BuiltinPalette> {
        let section = match kind {
            ThemeSectionKind::App => &self.app,
            ThemeSectionKind::Terminal => &self.terminal,
            ThemeSectionKind::Syntax => &self.syntax,
        }
        .as_ref()?;
        let fallback = if self.mode == PaletteMode::Light {
            "ade:chalk"
        } else {
            "ade:graphite"
        };
        let mut palette = builtin_palette(section.defaults.as_deref().unwrap_or(fallback))?.clone();
        palette.id = self.id.clone();
        palette.name = self.name.clone();
        palette.mode = self.mode;
        for (role, value) in &section.tokens {
            if definition::known_role(kind.name(), role) {
                palette.tokens.insert(role.clone(), value.clone());
            }
        }
        Some(palette)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CellColor {
    CellForeground,
    CellBackground,
}

/// Cursor fill is literal RGB or the resolved cursor cell color.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum CursorColor {
    Literal(Rgb),
    Cell(CellColor),
}

/// Bold color is a rendering policy; it never changes native palette/query values.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum BoldColor {
    Literal(Rgb),
    Mode(BoldColorMode),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BoldColorMode {
    #[default]
    Inherit,
    Bright,
}

impl Default for BoldColor {
    fn default() -> Self {
        Self::Mode(BoldColorMode::Inherit)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct TerminalAppearance {
    pub revision: u64,
    #[schemars(with = "serde_json::Number", range(min = 1.0, max = 21.0))]
    pub minimum_contrast: f64,
    pub bold_color: BoldColor,
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: CursorColor,
    pub cursor_text: TerminalColor,
    pub selection_foreground: TerminalColor,
    pub selection_background: TerminalColor,
    #[schemars(length(equal = 256))]
    pub palette: Vec<Rgb>,
    pub dark: bool,
}

/// Explicit profile overrides; omitted roles retain the selected theme's colors.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TerminalColorOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_text: Option<TerminalColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<TerminalColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<TerminalColor>,
}

impl TerminalColorOverrides {
    pub fn apply(&self, appearance: &mut TerminalAppearance) {
        if let Some(color) = &self.cursor_text {
            appearance.cursor_text = color.clone();
        }
        if let Some(color) = &self.selection_foreground {
            appearance.selection_foreground = color.clone();
        }
        if let Some(color) = &self.selection_background {
            appearance.selection_background = color.clone();
        }
    }
}

/// The daemon's complete desired defaults, keyed by durable terminal identity.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TerminalAppearanceProjection {
    pub profile: TerminalAppearance,
    pub overrides: BTreeMap<String, TerminalAppearance>,
}
impl TerminalAppearanceProjection {
    pub fn for_terminal(&self, id: &str) -> &TerminalAppearance {
        self.overrides.get(id).unwrap_or(&self.profile)
    }
}

/// How a color consumer selects a variant independently of app chrome.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ThemeBinding {
    #[default]
    FollowApp,
    Paired {
        light: String,
        dark: String,
    },
    Fixed {
        theme_id: String,
    },
}

type Palettes = BTreeMap<String, BTreeMap<String, String>>;

pub fn palettes() -> &'static Palettes {
    static PALETTES: OnceLock<Palettes> = OnceLock::new();
    PALETTES.get_or_init(|| {
        serde_json::from_str(include_str!("appearance/builtin.json"))
            .expect("bundled palettes are valid")
    })
}

/// A palette variant has a fixed mode; system following belongs to the selection.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaletteMode {
    Light,
    Dark,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BuiltinPalette {
    pub id: String,
    pub name: String,
    pub mode: PaletteMode,
    pub tokens: BTreeMap<String, String>,
}

/// Approved metadata, independent of the display name or token values.
pub fn builtin_catalog() -> &'static [BuiltinPalette] {
    static CATALOG: OnceLock<Vec<BuiltinPalette>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        [
            ("graphite", "Graphite", PaletteMode::Dark),
            ("carbon", "Carbon", PaletteMode::Dark),
            ("chalk", "Chalk", PaletteMode::Light),
            ("linen", "Linen", PaletteMode::Light),
            ("obsidian", "Obsidian", PaletteMode::Dark),
            ("ink", "Ink", PaletteMode::Dark),
            ("midnight", "Midnight", PaletteMode::Dark),
            ("onyx", "Onyx", PaletteMode::Dark),
            ("porcelain", "Porcelain", PaletteMode::Light),
            ("pearl", "Pearl", PaletteMode::Light),
            ("ice", "Ice", PaletteMode::Light),
            ("quartz", "Quartz", PaletteMode::Light),
        ]
        .into_iter()
        .map(|(key, name, mode)| BuiltinPalette {
            id: format!("ade:{key}"),
            name: name.into(),
            mode,
            tokens: palettes()[key].clone(),
        })
        .collect()
    })
}

pub fn builtin_palette(id: &str) -> Option<&'static BuiltinPalette> {
    builtin_catalog().iter().find(|palette| palette.id == id)
}

impl TerminalAppearance {
    /// System mode uses the headless default until an OS observation is available.
    pub fn for_mode(mode: Appearance) -> Self {
        let id = if mode == Appearance::Light {
            "ade:chalk"
        } else {
            "ade:graphite"
        };
        Self::for_palette(builtin_palette(id).expect("default palette exists"))
    }

    pub fn for_palette(palette: &BuiltinPalette) -> Self {
        let dark = palette.mode == PaletteMode::Dark;
        let tokens = &palette.tokens;
        let color = |name: &str| {
            let value = u32::from_str_radix(&tokens[name][1..], 16)
                .expect("bundled palette colors are six-digit RGB");
            Rgb {
                r: (value >> 16) as u8,
                g: (value >> 8) as u8,
                b: value as u8,
            }
        };
        let mut colors: Vec<_> = (0..16)
            .map(|i| color(&format!("terminal-ansi-{i}")))
            .collect();
        // Ghostty's conventional 6×6×6 color cube and 24 gray levels. Only
        // the first sixteen entries are replaced by these ADE palettes.
        for r in [0, 95, 135, 175, 215, 255] {
            for g in [0, 95, 135, 175, 215, 255] {
                for b in [0, 95, 135, 175, 215, 255] {
                    colors.push(Rgb { r, g, b });
                }
            }
        }
        for i in 0..24 {
            let level = 8 + i * 10;
            colors.push(Rgb {
                r: level,
                g: level,
                b: level,
            });
        }
        for (index, entry) in colors.iter_mut().enumerate().skip(16) {
            let key = format!("terminal-ansi-{index}");
            if tokens.contains_key(&key) {
                *entry = color(&key);
            }
        }
        let policy =
            |name: &str, fallback: TerminalColor| match tokens.get(name).map(String::as_str) {
                Some("cell-foreground") => TerminalColor::Cell(CellColor::CellForeground),
                Some("cell-background") => TerminalColor::Cell(CellColor::CellBackground),
                Some(value) if value.len() == 9 => {
                    let rgba = u32::from_str_radix(&value[1..], 16).expect("validated RGBA");
                    TerminalColor::Alpha(Rgba {
                        r: (rgba >> 24) as u8,
                        g: (rgba >> 16) as u8,
                        b: (rgba >> 8) as u8,
                        a: rgba as u8,
                    })
                }
                Some(_) => TerminalColor::Literal(color(name)),
                None => fallback,
            };
        Self {
            revision: 0,
            minimum_contrast: 1.0,
            bold_color: Default::default(),
            foreground: color("terminal-foreground"),
            background: color("terminal"),
            cursor: match tokens["terminal-cursor"].as_str() {
                "cell-foreground" => CursorColor::Cell(CellColor::CellForeground),
                "cell-background" => CursorColor::Cell(CellColor::CellBackground),
                _ => CursorColor::Literal(color("terminal-cursor")),
            },
            cursor_text: policy(
                "terminal-cursor-text",
                TerminalColor::Literal(color("terminal")),
            ),
            selection_foreground: policy(
                "terminal-selection-foreground",
                TerminalColor::Cell(CellColor::CellForeground),
            ),
            selection_background: policy(
                "terminal-selection",
                TerminalColor::Literal(color("terminal")),
            ),
            palette: colors,
            dark,
        }
    }
}

impl Default for TerminalAppearance {
    fn default() -> Self {
        Self::for_mode(Appearance::System)
    }
}
