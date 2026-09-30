//! Current-format ADE definitions. Parsing is read-only; installation has its own revision boundary.
use super::{PaletteMode, builtin_palette, palettes};
use jsonc_parser::{CollectOptions, ParseOptions, ast, common::Ranged, parse_to_ast};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
mod source;
pub use source::{ThemeSourceCandidate, ThemeSourceValidation, validate_source};

pub const MAX_SOURCE_BYTES: usize = 256 * 1024;
pub(super) fn valid_id(id: &str) -> bool {
    id.split_once(':').is_some_and(|(namespace, key)| {
        [namespace, key].iter().all(|part| {
            !part.is_empty()
                && part.len() <= 128
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    })
}
const MAX_DIAGNOSTICS: usize = 128;
const MAX_DEPTH: usize = 64;

// Scan tokens before recursive AST construction; brackets inside strings/comments do not count.
fn nesting_limit(source: &str) -> Option<(usize, usize)> {
    use jsonc_parser::{Scanner, ScannerOptions, tokens::Token};
    let options = ScannerOptions {
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    };
    let mut scanner = Scanner::new(source, &options);
    let mut depth = 0usize;
    while let Ok(Some(token)) = scanner.scan() {
        match token {
            Token::OpenBrace | Token::OpenBracket => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Some((scanner.token_start(), scanner.token_end()));
                }
            }
            Token::CloseBrace | Token::CloseBracket => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    None
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeOrigin {
    Bundled,
    Imported,
    User,
    Plugin,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ThemeProvenance {
    pub kind: ThemeOrigin,
    pub source: Option<String>,
    pub source_version: Option<String>,
    pub source_digest: Option<String>,
    pub author: Option<String>,
    pub license: Option<String>,
}

/// A declared default is resolved independently of current profile appearance.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct ThemeSection {
    pub defaults: Option<String>,
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct ThemeDefinition {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub mode: PaletteMode,
    pub provenance: ThemeProvenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<super::pack::ThemePackIdentity>,
    pub app: Option<ThemeSection>,
    pub terminal: Option<ThemeSection>,
    pub syntax: Option<ThemeSection>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

/// Offsets and lengths count UTF-8 bytes; line and column are one-based (column counts characters).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub path: String,
    pub offset: usize,
    pub length: usize,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ThemeValidation {
    pub valid: bool,
    pub definition: Option<ThemeDefinition>,
    pub diagnostics: Vec<ThemeDiagnostic>,
}

struct Report<'a> {
    source: &'a str,
    locations: BTreeMap<String, (usize, usize)>,
    diagnostics: Vec<ThemeDiagnostic>,
    errors: bool,
}

impl Report<'_> {
    fn add(
        &mut self,
        severity: DiagnosticSeverity,
        code: &str,
        path: &str,
        message: impl Into<String>,
    ) {
        self.errors |= severity == DiagnosticSeverity::Error;
        if self.diagnostics.len() >= MAX_DIAGNOSTICS {
            // A warning-heavy document must still expose the first required error.
            if severity == DiagnosticSeverity::Error
                && !self
                    .diagnostics
                    .iter()
                    .any(|d| d.severity == DiagnosticSeverity::Error)
            {
                self.diagnostics.pop();
            } else {
                return;
            }
        }
        let mut parent = path;
        let (offset, end) = loop {
            if let Some(range) = self.locations.get(parent) {
                break *range;
            }
            if parent.is_empty() {
                break (0, 0);
            }
            parent = parent.rsplit_once('/').map_or("", |(parent, _)| parent);
        };
        let prefix = &self.source[..offset];
        self.diagnostics.push(ThemeDiagnostic {
            severity,
            code: code.into(),
            message: message.into(),
            path: path.into(),
            offset,
            length: end.saturating_sub(offset),
            line: prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
            column: prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1,
        });
    }

    fn walk(&mut self, node: &ast::Value<'_>, path: &str, depth: usize) {
        let range = node.range();
        self.locations.insert(path.into(), (range.start, range.end));
        if depth > MAX_DEPTH {
            self.add(
                DiagnosticSeverity::Error,
                "depth_limit",
                path,
                "Theme nesting exceeds 64 levels.",
            );
            return;
        }
        match node {
            ast::Value::Object(object) => {
                let mut names = BTreeSet::new();
                for property in &object.properties {
                    let name = property.name.as_str();
                    let child = pointer(path, name);
                    self.walk(&property.value, &child, depth + 1);
                    if !names.insert(name) {
                        self.add(
                            DiagnosticSeverity::Error,
                            "duplicate_key",
                            &child,
                            "Duplicate object keys are ambiguous.",
                        );
                    }
                }
            }
            ast::Value::Array(array) => {
                for (index, value) in array.elements.iter().enumerate() {
                    self.walk(value, &pointer(path, &index.to_string()), depth + 1);
                }
            }
            ast::Value::NumberLit(number)
                if number.value.parse::<serde_json::Number>().is_err() =>
            {
                self.add(
                    DiagnosticSeverity::Error,
                    "invalid_number",
                    path,
                    "Numeric data must be representable as a JSON number.",
                );
            }
            _ => {}
        }
    }
}

fn pointer(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn terminal_role(role: &str) -> bool {
    role == "terminal" || role.starts_with("terminal-")
}

fn supports(section: &str, role: &str) -> bool {
    match section {
        "app" => !terminal_role(role) && !role.starts_with("syntax-"),
        "terminal" => terminal_role(role),
        "syntax" => {
            role.starts_with("syntax-")
                || matches!(
                    role,
                    "base"
                        | "accent"
                        | "accent-foreground"
                        | "muted-foreground"
                        | "panel"
                        | "attention-muted"
                        | "destructive"
                        | "attention"
                        | "info"
                        | "info-muted"
                        | "diff-add"
                        | "diff-remove"
                        | "diff-add-muted"
                        | "diff-remove-muted"
                )
        }
        _ => false,
    }
}

pub fn known_role(section: &str, role: &str) -> bool {
    if palettes()["graphite"].contains_key(role) && supports(section, role) {
        return true;
    }
    section == "terminal"
        && (matches!(
            role,
            "terminal-cursor-text" | "terminal-selection-foreground"
        ) || role.strip_prefix("terminal-ansi-").is_some_and(|index| {
            index
                .parse::<u8>()
                .is_ok_and(|value| value.to_string() == index)
        }))
}

fn normalized_color(role: &str, color: &str) -> Option<String> {
    if matches!(
        role,
        "terminal-cursor"
            | "terminal-cursor-text"
            | "terminal-selection-foreground"
            | "terminal-selection"
    ) && matches!(color, "cell-foreground" | "cell-background")
    {
        return Some(color.into());
    }
    let hex = color.strip_prefix('#')?;
    let alpha = role == "terminal-selection";
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !(matches!(hex.len(), 3 | 6) || (alpha && matches!(hex.len(), 4 | 8)))
    {
        return None;
    }
    let value = if hex.len() <= 4 {
        hex.chars().flat_map(|ch| [ch, ch]).collect::<String>()
    } else {
        hex.into()
    };
    Some(format!("#{}", value.to_ascii_lowercase()))
}

fn section(report: &mut Report<'_>, name: &str, section: &mut ThemeSection, mode: PaletteMode) {
    let path = pointer("", name);
    for key in section.extensions.keys() {
        report.add(
            DiagnosticSeverity::Warning,
            "unsupported_extension",
            &pointer(&path, key),
            "Unsupported section data is retained without applying it.",
        );
    }
    if let Some(id) = &section.defaults {
        if let Some(default) = builtin_palette(id).filter(|default| default.mode == mode) {
            for (role, value) in &default.tokens {
                if supports(name, role) {
                    section
                        .tokens
                        .entry(role.clone())
                        .or_insert_with(|| value.clone());
                }
            }
            if name == "terminal" {
                for (index, color) in super::TerminalAppearance::for_palette(default)
                    .palette
                    .iter()
                    .enumerate()
                {
                    section
                        .tokens
                        .entry(format!("terminal-ansi-{index}"))
                        .or_insert_with(|| {
                            format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
                        });
                }
                let background = section.tokens["terminal"].clone();
                section
                    .tokens
                    .entry("terminal-cursor-text".into())
                    .or_insert(background);
                section
                    .tokens
                    .entry("terminal-selection-foreground".into())
                    .or_insert_with(|| "cell-foreground".into());
            }
        } else {
            report.add(
                DiagnosticSeverity::Error,
                "invalid_default",
                &pointer(&path, "defaults"),
                "Defaults must name a bundled variant with the definition's mode.",
            );
        }
    }
    let mut required: BTreeSet<String> = palettes()["graphite"]
        .keys()
        .filter(|role| supports(name, role))
        .cloned()
        .collect();
    if name == "terminal" {
        required.extend((0..256).map(|index| format!("terminal-ansi-{index}")));
        required.extend([
            "terminal-cursor-text".into(),
            "terminal-selection-foreground".into(),
        ]);
    }
    for role in &required {
        if !section.tokens.contains_key(role) {
            report.add(
                DiagnosticSeverity::Error,
                "missing_role",
                &pointer(&pointer(&path, "tokens"), role),
                format!("Required {name} role '{role}' has no value or declared default."),
            );
        }
    }
    for (role, value) in &mut section.tokens {
        let token_path = pointer(&pointer(&path, "tokens"), role);
        if name == "terminal" && role.starts_with("terminal-ansi-") && !known_role(name, role) {
            report.add(
                DiagnosticSeverity::Error,
                "invalid_palette_index",
                &token_path,
                "Terminal palette indexes must be canonical integers from 0 through 255.",
            );
            continue;
        }
        if !known_role(name, role) {
            report.add(
                DiagnosticSeverity::Warning,
                "unsupported_extension",
                &token_path,
                "Unsupported token is retained without applying it.",
            );
            continue;
        }
        if let Some(normalized) = normalized_color(role, value) {
            // Defaults use the same normalization but do not count as source edits.
            if normalized != *value && report.locations.contains_key(&token_path) {
                report.add(
                    DiagnosticSeverity::Info,
                    "normalized",
                    &token_path,
                    format!("Literal normalized to {normalized}."),
                );
            }
            *value = normalized;
        } else {
            report.add(
                DiagnosticSeverity::Error,
                "invalid_color",
                &token_path,
                "Use literal sRGB hex; alpha and cell-relative values require an eligible role.",
            );
        }
    }
}

pub fn validate(source: &str) -> ThemeValidation {
    let mut report = Report {
        source,
        locations: BTreeMap::new(),
        diagnostics: vec![],
        errors: false,
    };
    let options = ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    };
    let parsed = if source.len() > MAX_SOURCE_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "size_limit",
            "",
            "Theme source exceeds 256 KiB.",
        );
        None
    } else if let Some(range) = nesting_limit(source) {
        report.locations.insert("".into(), range);
        report.add(
            DiagnosticSeverity::Error,
            "depth_limit",
            "",
            "Theme nesting exceeds 64 levels.",
        );
        None
    } else {
        match parse_to_ast(source, &CollectOptions::default(), &options) {
            Ok(parsed) => parsed.value,
            Err(error) => {
                let range = error.range();
                report.locations.insert("".into(), (range.start, range.end));
                report.add(
                    DiagnosticSeverity::Error,
                    "parse_error",
                    "",
                    error.to_string(),
                );
                None
            }
        }
    };
    let mut definition = None;
    if let Some(ast) = parsed {
        report.walk(&ast, "", 0);
        if !report.errors {
            match serde_json::from_value::<ThemeDefinition>(Value::from(ast)) {
                Ok(mut value) => {
                    if value.format != "ade-theme" {
                        report.add(
                            DiagnosticSeverity::Error,
                            "unsupported_format",
                            "/format",
                            "Expected ade-theme format.",
                        );
                    }
                    if value.version != 1 {
                        report.add(
                            DiagnosticSeverity::Error,
                            "unsupported_version",
                            "/version",
                            "Only current ADE theme version 1 is supported.",
                        );
                    }
                    if !valid_id(&value.id) {
                        report.add(
                            DiagnosticSeverity::Error,
                            "invalid_id",
                            "/id",
                            "Use a stable namespaced ID, such as user:my-theme.",
                        );
                    }
                    if value.pack.as_ref().is_some_and(|pack| !pack.valid()) {
                        report.add(DiagnosticSeverity::Error, "invalid_pack_identity", "/pack", "Use a stable namespaced pack ID and a nonempty pack name without control characters.");
                    }
                    if value.name.trim().is_empty() || value.name.len() > 256 {
                        report.add(
                            DiagnosticSeverity::Error,
                            "invalid_name",
                            "/name",
                            "A display name must contain text and fit within 256 bytes.",
                        );
                    }
                    if !matches!(value.provenance.kind, ThemeOrigin::User)
                        && (value
                            .provenance
                            .source
                            .as_ref()
                            .is_none_or(|s| s.trim().is_empty())
                            || [
                                value.provenance.source_version.as_ref(),
                                value.provenance.source_digest.as_ref(),
                            ]
                            .iter()
                            .all(|s| s.is_none_or(|s| s.trim().is_empty())))
                    {
                        report.add(
                            DiagnosticSeverity::Error,
                            "missing_provenance",
                            "/provenance",
                            "Source definitions require an origin and source version or digest.",
                        );
                    }
                    for (key, metadata) in [
                        ("source", &value.provenance.source),
                        ("source_version", &value.provenance.source_version),
                        ("source_digest", &value.provenance.source_digest),
                        ("author", &value.provenance.author),
                        ("license", &value.provenance.license),
                    ] {
                        if metadata.as_ref().is_some_and(|text| {
                            text.len() > 4096 || text.chars().any(char::is_control)
                        }) {
                            report.add(DiagnosticSeverity::Error, "invalid_metadata", &pointer("/provenance", key), "Provenance metadata must fit within 4 KiB and contain no control characters.");
                        }
                    }
                    for key in value.extensions.keys() {
                        report.add(
                            DiagnosticSeverity::Warning,
                            "unsupported_extension",
                            &pointer("", key),
                            "Unsupported definition data is retained without applying it.",
                        );
                    }
                    if value.app.is_none() && value.terminal.is_none() && value.syntax.is_none() {
                        report.add(
                            DiagnosticSeverity::Error,
                            "missing_section",
                            "",
                            "Provide at least one app, terminal or syntax section.",
                        );
                    }
                    for (name, section_value) in [
                        ("app", &mut value.app),
                        ("terminal", &mut value.terminal),
                        ("syntax", &mut value.syntax),
                    ] {
                        if let Some(section_value) = section_value {
                            section(&mut report, name, section_value, value.mode);
                        }
                    }
                    if !report.errors {
                        if serde_json::to_vec(&value)
                            .is_ok_and(|bytes| bytes.len() <= MAX_SOURCE_BYTES)
                        {
                            definition = Some(value);
                        } else {
                            report.add(DiagnosticSeverity::Error, "normalized_size_limit", "", "Normalized theme exceeds 256 KiB. Reduce extension data before importing.");
                        }
                    }
                }
                Err(error) => report.add(
                    DiagnosticSeverity::Error,
                    "invalid_definition",
                    "",
                    error.to_string(),
                ),
            }
        }
    } else if !report.errors {
        report.add(
            DiagnosticSeverity::Error,
            "missing_document",
            "",
            "Provide a theme definition object.",
        );
    }
    ThemeValidation {
        valid: definition.is_some(),
        definition,
        diagnostics: report.diagnostics,
    }
}

#[cfg(test)]
mod tests;
