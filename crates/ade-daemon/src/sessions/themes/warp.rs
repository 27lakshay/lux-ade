//! Bounded, read-only import of Warp YAML themes into the shared theme definition.
use ade_core::{
    appearance::{
        PaletteMode, TerminalAppearance,
        definition::{self, DiagnosticSeverity, ThemeDiagnostic, ThemeOrigin},
    },
    contract::themes::{ThemeValidationResponse, WarpThemeValidateRequest, WarpThemeValidation},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use yaml_rust2::{
    parser::{Event, MarkedEventReceiver, Parser},
    scanner::Marker,
};

const MAX_DEPTH: usize = 64;

#[derive(Debug)]
enum Kind {
    Scalar(String),
    Map(Vec<(Node, Node)>),
    Unsupported,
}
#[derive(Debug)]
struct Node {
    kind: Kind,
    offset: usize,
}
#[derive(Default)]
struct Events(Vec<(Event, Marker)>);
impl MarkedEventReceiver for Events {
    fn on_event(&mut self, event: Event, marker: Marker) {
        self.0.push((event, marker));
    }
}

fn parse_node(events: &[(Event, Marker)], index: &mut usize, depth: usize) -> Option<Node> {
    if depth > MAX_DEPTH {
        return None;
    }
    let (event, marker) = events.get(*index)?;
    *index += 1;
    let offset = marker.index();
    let kind = match event {
        Event::Scalar(value, _, 0, None) => Kind::Scalar(value.clone()),
        Event::Scalar(..) | Event::Alias(_) => Kind::Unsupported,
        Event::MappingStart(anchor, tag) => {
            let mut pairs = Vec::new();
            while !matches!(
                events.get(*index).map(|(event, _)| event),
                Some(Event::MappingEnd)
            ) {
                pairs.push((
                    parse_node(events, index, depth + 1)?,
                    parse_node(events, index, depth + 1)?,
                ));
            }
            *index += 1;
            if *anchor == 0 && tag.is_none() {
                Kind::Map(pairs)
            } else {
                Kind::Unsupported
            }
        }
        Event::SequenceStart(anchor, tag) => {
            while !matches!(
                events.get(*index).map(|(event, _)| event),
                Some(Event::SequenceEnd)
            ) {
                parse_node(events, index, depth + 1)?;
            }
            *index += 1;
            let _ = (anchor, tag);
            Kind::Unsupported
        }
        _ => return None,
    };
    Some(Node { kind, offset })
}

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
        path: &str,
        message: impl Into<String>,
    ) {
        if self.diagnostics.len() == 128 {
            if severity == DiagnosticSeverity::Error && !self.errors {
                self.diagnostics.pop();
            } else {
                return;
            }
        }
        self.errors |= severity == DiagnosticSeverity::Error;
        let offset = offset.min(self.source.len());
        let mut line = 1;
        let mut column = 1;
        let mut chars = self.source[..offset].chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    line += 1;
                    column = 1;
                }
                '\n' => {
                    line += 1;
                    column = 1;
                }
                _ => column += 1,
            }
        }
        self.diagnostics.push(ThemeDiagnostic {
            severity,
            code: code.into(),
            message: message.into(),
            path: path.into(),
            offset,
            length: 1,
            line,
            column,
        });
    }
    fn result(
        self,
        definition: Option<definition::ThemeDefinition>,
    ) -> definition::ThemeValidation {
        definition::ThemeValidation {
            valid: !self.errors && definition.is_some(),
            definition,
            diagnostics: self.diagnostics,
        }
    }
}
fn scalar<'a>(node: &'a Node, report: &mut Report<'_>, path: &str) -> Option<&'a str> {
    if let Kind::Scalar(value) = &node.kind {
        Some(value)
    } else {
        report.add(
            DiagnosticSeverity::Error,
            "invalid_yaml_shape",
            node.offset,
            path,
            "Expected a YAML scalar.",
        );
        None
    }
}
fn unique_mapping<'a>(
    node: &'a Node,
    report: &mut Report<'_>,
    path: &str,
) -> Option<Vec<(&'a str, &'a Node)>> {
    let Kind::Map(pairs) = &node.kind else {
        report.add(
            DiagnosticSeverity::Error,
            "invalid_yaml_shape",
            node.offset,
            path,
            "Expected a YAML mapping.",
        );
        return None;
    };
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for (key_node, value) in pairs {
        let Some(key) = scalar(key_node, report, path) else {
            continue;
        };
        if !seen.insert(key) {
            report.add(
                DiagnosticSeverity::Error,
                "duplicate_key",
                key_node.offset,
                &format!("{path}/{key}"),
                "Duplicate YAML mapping key is ambiguous.",
            );
        }
        result.push((key, value));
    }
    Some(result)
}
fn hex(value: &str) -> Option<String> {
    let value = value.strip_prefix('#')?;
    if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) || !matches!(value.len(), 3 | 6) {
        return None;
    }
    let value = if value.len() == 3 {
        value.chars().flat_map(|c| [c, c]).collect()
    } else {
        value.to_owned()
    };
    Some(format!("#{}", value.to_ascii_lowercase()))
}
fn invalid(report: Report<'_>) -> WarpThemeValidation {
    WarpThemeValidation {
        tag: Default::default(),
        source: None,
        preview: None,
        validation: ThemeValidationResponse {
            tag: Default::default(),
            validation: report.result(None),
            target: None,
        },
    }
}

pub(super) fn validate(request: &WarpThemeValidateRequest) -> WarpThemeValidation {
    let mut report = Report {
        source: &request.source,
        diagnostics: Vec::new(),
        errors: false,
    };
    if request.source.len() > definition::MAX_SOURCE_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "source_limit",
            0,
            "",
            "Warp YAML exceeds 256 KiB.",
        );
        return invalid(report);
    }
    let mut sink = Events::default();
    if let Err(error) = Parser::new_from_str(&request.source).load(&mut sink, true) {
        report.add(
            DiagnosticSeverity::Error,
            "parse_error",
            error.marker().index(),
            "",
            error.info(),
        );
        return invalid(report);
    }
    if sink
        .0
        .iter()
        .filter(|(event, _)| *event == Event::DocumentStart)
        .count()
        != 1
    {
        report.add(
            DiagnosticSeverity::Error,
            "document_count",
            0,
            "",
            "Expected exactly one YAML document.",
        );
        return invalid(report);
    }
    let events: Vec<_> = sink
        .0
        .iter()
        .filter(|(event, _)| {
            !matches!(
                event,
                Event::StreamStart | Event::StreamEnd | Event::DocumentStart | Event::DocumentEnd
            )
        })
        .cloned()
        .collect();
    let Some(root) = parse_node(&events, &mut 0, 0) else {
        report.add(
            DiagnosticSeverity::Error,
            "depth_limit",
            0,
            "",
            "Warp YAML structure exceeds 64 levels or is unsupported.",
        );
        return invalid(report);
    };
    let Some(fields) = unique_mapping(&root, &mut report, "") else {
        return invalid(report);
    };
    if report.errors {
        return invalid(report);
    }
    let fields: BTreeMap<_, _> = fields.into_iter().collect();
    let Some(name_node) = fields.get("name") else {
        report.add(
            DiagnosticSeverity::Error,
            "missing_name",
            root.offset,
            "/name",
            "Warp theme name is required.",
        );
        return invalid(report);
    };
    let name = scalar(name_node, &mut report, "/name")
        .unwrap_or_default()
        .to_owned();
    let mut mode = PaletteMode::Dark;
    for (key, node) in &fields {
        match *key {
            "name" | "background" | "foreground" | "cursor" | "terminal_colors" => (),
            "details" => match scalar(node, &mut report, "/details") {
                Some("darker") => mode = PaletteMode::Dark,
                Some("lighter") => mode = PaletteMode::Light,
                Some(_) => report.add(DiagnosticSeverity::Error, "invalid_mode", node.offset, "/details", "Warp details must be darker or lighter."),
                None => (),
            },
            "accent" => report.add(DiagnosticSeverity::Warning, "unsupported_key", node.offset, "/accent", "Warp accent styles Warp UI, which ADE cannot import; a valid accent also supplies the cursor color when cursor is omitted."),
            _ => report.add(DiagnosticSeverity::Warning, "unsupported_key", node.offset, &format!("/{key}"), "Warp field is not applied by ADE."),
        }
    }
    let mut tokens = BTreeMap::new();
    for (key, role) in [
        ("background", "terminal"),
        ("foreground", "terminal-foreground"),
        ("cursor", "terminal-cursor"),
    ] {
        let source_key = if key == "cursor" && !fields.contains_key("cursor") {
            "accent"
        } else {
            key
        };
        if let Some(node) = fields.get(source_key)
            && let Some(value) = scalar(node, &mut report, &format!("/{source_key}"))
        {
            if let Some(value) = hex(value) {
                tokens.insert(role.to_owned(), value);
            } else {
                report.add(
                    DiagnosticSeverity::Error,
                    "invalid_color",
                    node.offset,
                    &format!("/{source_key}"),
                    "Warp colors must be #RGB or #RRGGBB hex values.",
                );
            }
        }
    }
    if let Some(node) = fields.get("terminal_colors")
        && let Some(groups) = unique_mapping(node, &mut report, "/terminal_colors")
    {
        let ansi = [
            "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        ];
        for (group, group_node) in groups {
            let offset = match group {
                "normal" => 0,
                "bright" => 8,
                _ => {
                    report.add(
                        DiagnosticSeverity::Warning,
                        "unsupported_key",
                        group_node.offset,
                        &format!("/terminal_colors/{group}"),
                        "Warp color group is unsupported.",
                    );
                    continue;
                }
            };
            if let Some(colors) = unique_mapping(
                group_node,
                &mut report,
                &format!("/terminal_colors/{group}"),
            ) {
                for (key, color_node) in colors {
                    let Some(index) = ansi.iter().position(|name| *name == key) else {
                        report.add(
                            DiagnosticSeverity::Warning,
                            "unsupported_key",
                            color_node.offset,
                            &format!("/terminal_colors/{group}/{key}"),
                            "Warp terminal color is unsupported.",
                        );
                        continue;
                    };
                    if let Some(value) = scalar(
                        color_node,
                        &mut report,
                        &format!("/terminal_colors/{group}/{key}"),
                    ) {
                        if let Some(value) = hex(value) {
                            tokens.insert(format!("terminal-ansi-{}", offset + index), value);
                        } else {
                            report.add(
                                DiagnosticSeverity::Error,
                                "invalid_color",
                                color_node.offset,
                                &format!("/terminal_colors/{group}/{key}"),
                                "Warp colors must be #RGB or #RRGGBB hex values.",
                            );
                        }
                    }
                }
            }
        }
    }
    if report.errors {
        return invalid(report);
    }
    let base = if mode == PaletteMode::Light {
        "ade:chalk"
    } else {
        "ade:graphite"
    };
    let source = json!({
        "format":"ade-theme", "version":1, "id":request.id, "name":name, "mode":mode,
        "provenance": { "kind":ThemeOrigin::Imported, "source":request.source_name.as_deref().unwrap_or("Warp YAML theme"), "source_version":"Warp custom themes", "source_digest":format!("sha256:{:x}", Sha256::digest(request.source.as_bytes())), "author":null, "license":null },
        "terminal": { "defaults":base, "tokens":tokens }, "x-warp":{"source":request.source}
    }).to_string();
    if source.len() > definition::MAX_SOURCE_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "normalized_size_limit",
            0,
            "",
            "Normalized Warp theme exceeds 256 KiB.",
        );
        return invalid(report);
    }
    let validated = definition::validate(&source);
    for diagnostic in validated.diagnostics {
        if diagnostic.code == "unsupported_extension" && diagnostic.path == "/x-warp" {
            continue;
        }
        let offset = diagnostic
            .path
            .strip_prefix('/')
            .and_then(|key| fields.get(key))
            .map_or(0, |node| node.offset);
        report.add(
            diagnostic.severity,
            &diagnostic.code,
            offset,
            &diagnostic.path,
            diagnostic.message,
        );
    }
    let validation = report.result(validated.definition);
    let preview = validation
        .definition
        .as_ref()
        .and_then(|definition| definition.palette(ade_core::appearance::ThemeSectionKind::Terminal))
        .map(|palette| TerminalAppearance::for_palette(&palette));
    WarpThemeValidation {
        tag: Default::default(),
        source: validation.definition.as_ref().map(|_| source),
        preview,
        validation: ThemeValidationResponse {
            tag: Default::default(),
            validation,
            target: None,
        },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn omitted_cursor_uses_valid_accent_and_reports_unsupported_accent_effects() {
        let result = validate(&request("name: Sample\naccent: '#abcdef'\n"));
        assert!(
            result.validation.validation.valid,
            "{:?}",
            result.validation.validation.diagnostics
        );
        assert_eq!(
            result
                .validation
                .validation
                .definition
                .as_ref()
                .unwrap()
                .terminal
                .as_ref()
                .unwrap()
                .tokens["terminal-cursor"],
            "#abcdef"
        );
        assert!(
            result
                .validation
                .validation
                .diagnostics
                .iter()
                .any(|item| item.path == "/accent" && item.message.contains("Warp UI"))
        );
    }
    use super::*;
    fn request(source: &str) -> WarpThemeValidateRequest {
        WarpThemeValidateRequest {
            source: source.into(),
            id: "user:warp".into(),
            source_name: Some("fixture.yaml".into()),
        }
    }
    #[test]
    fn maps_warp_colors_and_keeps_unsupported_fields_visible() {
        let result = validate(&request(
            "name: Sample\ndetails: darker\nbackground: '#abc'\nforeground: '#123456'\nterminal_colors:\n  normal:\n    red: '#ff0000'\naccent: '#abcdef'\nbackground_image:\n  path: secret.jpg\n",
        ));
        assert!(
            result.validation.validation.valid,
            "{:?}",
            result.validation.validation.diagnostics
        );
        let definition = result.validation.validation.definition.unwrap();
        assert_eq!(definition.name, "Sample");
        let tokens = &definition.terminal.unwrap().tokens;
        assert_eq!(tokens["terminal"], "#aabbcc");
        assert_eq!(tokens["terminal-ansi-1"], "#ff0000");
        assert!(
            result
                .validation
                .validation
                .diagnostics
                .iter()
                .any(|item| item.code == "unsupported_key" && item.path == "/background_image")
        );
        assert!(result.preview.is_some());
    }
    #[test]
    fn blank_name_diagnostic_points_to_yaml_scalar() {
        let source = "name: ''\nbackground: '#123456'\n";
        let result = validate(&request(source));
        let diagnostic = result
            .validation
            .validation
            .diagnostics
            .iter()
            .find(|item| item.code == "invalid_name")
            .unwrap();
        assert_eq!(diagnostic.path, "/name");
        assert_eq!(diagnostic.offset, source.find("''").unwrap());
        assert_eq!((diagnostic.line, diagnostic.column), (1, 7));
    }

    #[test]
    fn standalone_cr_and_crlf_positions_match_yaml_markers() {
        for newline in ["\n", "\r\n", "\r"] {
            let source = format!("name: Sample{newline}background: 'not-a-color'{newline}");
            let result = validate(&request(&source));
            let diagnostic = result
                .validation
                .validation
                .diagnostics
                .iter()
                .find(|item| item.code == "invalid_color")
                .unwrap();
            let offset = source.find("'not-a-color'").unwrap();
            assert_eq!(diagnostic.offset, offset);
            assert_eq!(
                (diagnostic.line, diagnostic.column),
                (2, 13),
                "newline {newline:?}"
            );
        }
    }
    #[test]
    fn rejects_malformed_duplicate_and_oversized_yaml_with_locations() {
        let bad = validate(&request("name: [oops\n"));
        assert!(!bad.validation.validation.valid);
        assert!(bad.validation.validation.diagnostics[0].line > 0);
        let duplicate = validate(&request("name: One\nname: Two\n"));
        assert!(
            duplicate
                .validation
                .validation
                .diagnostics
                .iter()
                .any(|item| item.code == "duplicate_key" && item.line == 2)
        );
        let huge = validate(&request(&"x".repeat(definition::MAX_SOURCE_BYTES + 1)));
        assert_eq!(
            huge.validation.validation.diagnostics[0].code,
            "source_limit"
        );
    }
}
