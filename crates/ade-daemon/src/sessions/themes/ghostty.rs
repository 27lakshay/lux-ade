//! Ghostty color admission and inert setting proposals. No includes, paths or command execution.
use ade_core::appearance::{
    Rgb,
    definition::{self, DiagnosticSeverity, ThemeDiagnostic, ThemeValidation},
};
use ade_core::contract::themes::{
    GhosttyAppearancePolicies, GhosttyThemeValidateRequest, GhosttyThemeValidation,
    ThemeValidationResponse,
};
use ade_runtime::ghostty_colors;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

struct Report<'a> {
    source: &'a str,
    diagnostics: Vec<ThemeDiagnostic>,
    errors: bool,
}
impl Report<'_> {
    fn add(
        &mut self,
        severity: DiagnosticSeverity,
        code: &str,
        offset: usize,
        length: usize,
        key: &str,
        message: &str,
    ) {
        self.errors |= severity == DiagnosticSeverity::Error;
        if self.diagnostics.len() == 128 {
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
        let prefix = &self.source[..offset];
        self.diagnostics.push(ThemeDiagnostic {
            severity,
            code: code.into(),
            message: message.into(),
            path: format!("/ghostty/{key}"),
            offset,
            length,
            line: prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
            column: prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1,
        });
    }
    fn finish(self, definition: Option<definition::ThemeDefinition>) -> ThemeValidation {
        ThemeValidation {
            valid: !self.errors && definition.is_some(),
            definition,
            diagnostics: self.diagnostics,
        }
    }
}
fn hex(rgb: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b)
}
fn role(key: &str) -> Option<&'static str> {
    match key {
        "foreground" => Some("terminal-foreground"),
        "background" => Some("terminal"),
        "cursor-color" => Some("terminal-cursor"),
        "cursor-text" => Some("terminal-cursor-text"),
        "selection-foreground" => Some("terminal-selection-foreground"),
        "selection-background" => Some("terminal-selection"),
        _ => None,
    }
}
fn parse(
    request: &GhosttyThemeValidateRequest,
) -> (ThemeValidation, Option<String>, GhosttyAppearancePolicies) {
    let mut policies = GhosttyAppearancePolicies::default();
    let mut report = Report {
        source: &request.source,
        diagnostics: vec![],
        errors: false,
    };
    if request.source.len() > definition::MAX_SOURCE_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "source_limit",
            0,
            0,
            "",
            "Ghostty theme text exceeds 256 KiB.",
        );
        return (report.finish(None), None, policies);
    }
    let Some(default_palette) = ghostty_colors::default_palette() else {
        report.add(
            DiagnosticSeverity::Error,
            "parser_unavailable",
            0,
            0,
            "",
            "This build does not contain the pinned native Ghostty color parser.",
        );
        return (report.finish(None), None, policies);
    };
    let defaults: Vec<_> = default_palette.into_iter().map(hex).collect();
    let mut palette = defaults.clone();
    let mut colors = BTreeMap::<&str, String>::new();
    let mut seen = BTreeMap::<String, ()>::new();
    let mut offset = 0;
    let mut color_assignments = 0;
    for raw in request.source.split_inclusive('\n') {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let entry = line.trim_matches([' ', '\t', '\r']);
        let start = offset + (entry.as_ptr() as usize - line.as_ptr() as usize);
        if line.len() > 4094 {
            report.add(
                DiagnosticSeverity::Error,
                "line_limit",
                offset,
                line.len(),
                "",
                "A Ghostty configuration line exceeds its pinned 4094-byte data limit.",
            );
            offset += raw.len();
            continue;
        }
        offset += raw.len();
        if entry.is_empty() || entry.starts_with('#') {
            continue;
        }
        let (key, value) = match entry.split_once('=') {
            Some((key, value)) => (
                key.trim_matches([' ', '\t']),
                Some(value.trim_matches([' ', '\t'])),
            ),
            None => (entry, None),
        };
        let value = value.map(|value| {
            if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
                &value[1..value.len() - 1]
            } else {
                value
            }
        });
        if matches!(key, "minimum-contrast" | "bold-color") {
            let valid = match (key, value) {
                ("minimum-contrast", Some(value)) => {
                    let ratio = if value.is_empty() {
                        Some(1.0)
                    } else {
                        value.parse::<f64>().ok()
                    };
                    if let Some(ratio) = ratio.filter(|ratio| ratio.is_finite()) {
                        policies.minimum_contrast = Some(ratio.clamp(1.0, 21.0));
                        if !(1.0..=21.0).contains(&ratio) {
                            report.add(DiagnosticSeverity::Warning, "policy_clamped", start, entry.len(), key,
                                "Ghostty clamps minimum contrast to 1–21. The optional proposal uses that clamped value.");
                        }
                        true
                    } else {
                        false
                    }
                }
                ("bold-color", Some(value)) => {
                    let bold = match value {
                        "" => Some(ade_core::appearance::BoldColor::default()),
                        "bright" => Some(ade_core::appearance::BoldColor::Mode(
                            ade_core::appearance::BoldColorMode::Bright,
                        )),
                        _ => ghostty_colors::parse(value)
                            .map(ade_core::appearance::BoldColor::Literal),
                    };
                    if let Some(bold) = bold {
                        policies.bold_color = Some(bold);
                        true
                    } else {
                        false
                    }
                }
                _ => false,
            };
            if valid {
                if seen.insert(key.into(), ()).is_some() {
                    report.add(DiagnosticSeverity::Warning, "duplicate_policy", start, entry.len(), key,
                        "This optional setting repeats. The last supported assignment or reset is proposed.");
                }
                report.add(DiagnosticSeverity::Warning, "optional_policy", start, entry.len(), key,
                    "This setting is proposed separately. Color preview and installation do not apply it; review and accept a profile settings change explicitly.");
            } else {
                report.add(DiagnosticSeverity::Warning, "unsupported_policy", start, entry.len(), key,
                    "This appearance setting value cannot be imported. It remains source data and is not applied. Minimum contrast requires a finite decimal number; bold color requires bright or a pinned Ghostty color.");
            }
            continue;
        }
        let supported = key == "palette" || role(key).is_some();
        if !supported {
            let generates = matches!(key, "palette-generate" | "palette-harmonious")
                && !matches!(value, Some("false" | "0" | ""));
            let policy = matches!(
                key,
                "cursor-opacity"
                    | "cursor-style"
                    | "cursor-style-blink"
                    | "bold-is-bright"
                    | "font-family"
                    | "font-size"
                    | "background-opacity"
            );
            report.add(if generates { DiagnosticSeverity::Error } else { DiagnosticSeverity::Warning },
                if generates { "unsupported_palette_generation" } else if policy { "unsupported_policy" } else { "ignored_option" }, start, entry.len(), key,
                if generates { "Generated and harmonious palettes are not supported; importing these colors would change their meaning." }
                else if policy { "This appearance setting is not supported by this importer. It remains source data and is not applied." }
                else { "This option is retained as source data but is not applied. Theme-file import applies terminal colors only." });
            continue;
        }
        color_assignments += 1;
        let Some(value) = value else {
            report.add(DiagnosticSeverity::Error, "value_required", start, entry.len(), key, "A color assignment requires '='. Use an empty value to reset to the pinned default.");
            continue;
        };
        let value_offset = start + (value.as_ptr() as usize - entry.as_ptr() as usize);
        if key == "palette" {
            if value.is_empty() {
                palette.clone_from(&defaults);
                seen.retain(|key, _| !key.starts_with("palette:"));
            } else if let Some((index, rgb)) = ghostty_colors::parse_palette_entry(value) {
                let identity = format!("palette:{index}");
                if seen.insert(identity, ()).is_some() {
                    report.add(
                        DiagnosticSeverity::Warning,
                        "duplicate_assignment",
                        value_offset,
                        value.len(),
                        key,
                        "This palette index repeats. Ghostty uses the last valid assignment.",
                    );
                }
                palette[index as usize] = hex(rgb);
            } else {
                report.add(DiagnosticSeverity::Error, "invalid_palette", value_offset, value.len(), key, "Use a palette index from 0 to 255 and a color accepted by the pinned Ghostty parser.");
            }
            continue;
        }
        if seen.insert(key.into(), ()).is_some() {
            report.add(
                DiagnosticSeverity::Warning,
                "duplicate_assignment",
                value_offset,
                value.len(),
                key,
                "This color repeats. Ghostty uses the last valid assignment or reset.",
            );
        }
        if value.is_empty() {
            colors.remove(key);
            continue;
        }
        if matches!(value, "cell-foreground" | "cell-background")
            && matches!(
                key,
                "cursor-color" | "cursor-text" | "selection-foreground" | "selection-background"
            )
        {
            colors.insert(key, value.into());
        } else if let Some(rgb) = ghostty_colors::parse(value) {
            colors.insert(key, hex(rgb));
        } else {
            report.add(DiagnosticSeverity::Error, "invalid_color", value_offset, value.len(), key, "This color is not accepted by the pinned Ghostty parser. Inline comments are color data, not comments.");
        }
    }
    if color_assignments == 0 {
        report.add(
            DiagnosticSeverity::Error,
            "missing_colors",
            0,
            0,
            "",
            "The selected file contains no supported terminal color assignments.",
        );
    }
    let foreground = colors
        .get("foreground")
        .cloned()
        .unwrap_or_else(|| "#ffffff".into());
    let background = colors
        .get("background")
        .cloned()
        .unwrap_or_else(|| "#282c34".into());
    let mut tokens = BTreeMap::from([
        ("terminal".into(), background.clone()),
        ("terminal-foreground".into(), foreground.clone()),
        ("terminal-cursor".into(), foreground.clone()),
        ("terminal-cursor-text".into(), background.clone()),
        ("terminal-selection-foreground".into(), background),
        ("terminal-selection".into(), foreground),
    ]);
    for (index, color) in palette.into_iter().enumerate() {
        tokens.insert(format!("terminal-ansi-{index}"), color);
    }
    for (key, value) in colors {
        tokens.insert(role(key).unwrap().into(), value);
    }
    let source = json!({
        "format": "ade-theme", "version": 1, "id": request.id, "name": request.name, "mode": request.mode,
        "provenance": { "kind": "imported", "source": request.source_name.as_deref().unwrap_or("Ghostty theme text"),
            "source_version": ghostty_colors::version(), "source_digest": format!("sha256:{:x}", Sha256::digest(request.source.as_bytes())) },
        "terminal": { "tokens": tokens },
        "x-ghostty": { "source": request.source },
    }).to_string();
    if source.len() > definition::MAX_SOURCE_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "normalized_source_limit",
            0,
            0,
            "",
            "The retained Ghostty text and materialized ADE definition exceed 256 KiB.",
        );
    }
    if report.errors {
        return (report.finish(None), None, policies);
    }
    let normalized = definition::validate(&source);
    // Definition admission checks IDs and metadata; map these diagnostics to the supplied file.
    for diagnostic in normalized.diagnostics {
        if diagnostic.code == "unsupported_extension" && diagnostic.path == "/x-ghostty" {
            continue;
        }
        report.add(
            diagnostic.severity,
            &diagnostic.code,
            0,
            0,
            "",
            &diagnostic.message,
        );
    }
    if report.errors {
        return (report.finish(None), None, policies);
    }
    (report.finish(normalized.definition), Some(source), policies)
}

pub(super) fn validate(request: &GhosttyThemeValidateRequest) -> GhosttyThemeValidation {
    let (validation, source, policies) = parse(request);
    let preview = validation.definition.as_ref().and_then(|definition| {
        definition.terminal.as_ref().map(|terminal| {
            ade_core::appearance::TerminalAppearance::for_palette(
                &ade_core::appearance::BuiltinPalette {
                    id: definition.id.clone(),
                    name: definition.name.clone(),
                    mode: definition.mode,
                    tokens: terminal.tokens.clone(),
                },
            )
        })
    });
    GhosttyThemeValidation {
        tag: Default::default(),
        source,
        preview,
        policies,
        validation: ThemeValidationResponse {
            tag: Default::default(),
            validation,
            target: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_cell_relative_cursor_fill_without_diagnostic() {
        let result = validate(&GhosttyThemeValidateRequest {
            source: "cursor-color = cell-foreground".into(),
            id: "user:cursor".into(),
            name: "Cursor".into(),
            mode: ade_core::appearance::PaletteMode::Dark,
            source_name: None,
        });
        assert!(
            result.validation.validation.valid,
            "{:?}",
            result.validation.validation.diagnostics
        );
        assert!(
            result
                .source
                .as_deref()
                .unwrap()
                .contains("terminal-cursor\":\"cell-foreground")
        );
        assert_eq!(
            result.preview.unwrap().cursor,
            ade_core::appearance::CursorColor::Cell(
                ade_core::appearance::CellColor::CellForeground
            )
        );
    }
}
