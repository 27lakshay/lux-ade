//! Read-only file validation. Packs disclose independent candidates; installation accepts an explicit subset.
use super::*;
use crate::appearance::pack::{MAX_PACK_BYTES, MAX_PACK_MEMBERS, ThemePackIdentity};

pub struct ThemeSourceCandidate {
    pub source: String,
    pub validation: ThemeValidation,
}
pub struct ThemeSourceValidation {
    pub pack: Option<ThemePackIdentity>,
    pub container_valid: bool,
    pub diagnostics: Vec<ThemeDiagnostic>,
    pub candidates: Vec<ThemeSourceCandidate>,
}

pub fn validate_source(source: &str) -> ThemeSourceValidation {
    let mut report = Report {
        source,
        locations: BTreeMap::new(),
        diagnostics: vec![],
        errors: false,
    };
    let mut result = ThemeSourceValidation {
        pack: None,
        container_valid: false,
        diagnostics: vec![],
        candidates: vec![],
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
    let parsed = if source.len() > MAX_PACK_BYTES {
        report.add(
            DiagnosticSeverity::Error,
            "size_limit",
            "",
            "Theme file exceeds 512 KiB.",
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
    if let Some(ast) = parsed {
        report.walk(&ast, "", 0);
        if !report.errors {
            let value = Value::from(ast);
            if value.get("format").and_then(Value::as_str) != Some("ade-theme-pack") {
                result.container_valid = true;
                result.candidates.push(ThemeSourceCandidate {
                    source: source.into(),
                    validation: validate(source),
                });
            } else {
                if value.get("version").and_then(Value::as_u64) != Some(1) {
                    report.add(
                        DiagnosticSeverity::Error,
                        "unsupported_version",
                        "/version",
                        "Only current ADE pack version 1 is supported.",
                    );
                }
                let identity = ThemePackIdentity {
                    id: value.get("id").and_then(Value::as_str).unwrap_or("").into(),
                    name: value
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                };
                if !identity.valid() {
                    report.add(DiagnosticSeverity::Error, "invalid_pack_identity", if valid_id(&identity.id) { "/name" } else { "/id" }, "Use a stable namespaced pack ID and a nonempty pack name without control characters.");
                }
                if let Some(object) = value.as_object() {
                    for key in object.keys().filter(|key| {
                        !matches!(
                            key.as_str(),
                            "format" | "version" | "id" | "name" | "themes"
                        )
                    }) {
                        report.add(DiagnosticSeverity::Error, "unsupported_pack_field", &pointer("", key), "Unsupported pack header field. Definition extensions remain supported as inert data.");
                    }
                }
                let members = value.get("themes").and_then(Value::as_array);
                if members
                    .is_none_or(|members| members.is_empty() || members.len() > MAX_PACK_MEMBERS)
                {
                    report.add(
                        DiagnosticSeverity::Error,
                        "member_limit",
                        "/themes",
                        "A pack must contain between 1 and 16 definitions.",
                    );
                }
                let mut ids = BTreeSet::new();
                if let Some(members) = members {
                    for (index, member) in members.iter().enumerate() {
                        if let Some(id) = member.get("id").and_then(Value::as_str)
                            && !ids.insert(id)
                        {
                            report.add(
                                DiagnosticSeverity::Error,
                                "duplicate_theme_id",
                                &format!("/themes/{index}/id"),
                                "Pack member IDs must be distinct.",
                            );
                        }
                    }
                    if !report.errors {
                        result.pack = Some(identity.clone());
                        result.container_valid = true;
                        for index in 0..members.len() {
                            let path = format!("/themes/{index}");
                            let (start, end) = report.locations[&path];
                            let raw = &source[start..end];
                            let mut validation = validate(raw);
                            let mut accepted_source = raw.to_owned();
                            if let Some(definition) = &mut validation.definition {
                                definition.pack = Some(identity.clone());
                                accepted_source = serde_json::to_string(definition)
                                    .expect("Validated JSON definition");
                                if accepted_source.len() > MAX_SOURCE_BYTES {
                                    validation.valid = false;
                                    validation.definition = None;
                                    if validation.diagnostics.len() >= MAX_DIAGNOSTICS {
                                        validation.diagnostics.pop();
                                    }
                                    validation.diagnostics.push(ThemeDiagnostic {
                                        severity: DiagnosticSeverity::Error,
                                        code: "normalized_size_limit".into(),
                                        message: "Definition with pack identity exceeds 256 KiB."
                                            .into(),
                                        path: String::new(),
                                        offset: 0,
                                        length: raw.len(),
                                        line: 1,
                                        column: 1,
                                    });
                                }
                            }
                            for diagnostic in &mut validation.diagnostics {
                                diagnostic.path = format!("{path}{}", diagnostic.path);
                                diagnostic.offset += start;
                                let prefix = &source[..diagnostic.offset];
                                diagnostic.line =
                                    prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
                                diagnostic.column =
                                    prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1;
                            }
                            result.candidates.push(ThemeSourceCandidate {
                                source: accepted_source,
                                validation,
                            });
                        }
                    }
                }
            }
        }
    } else if !report.errors {
        report.add(
            DiagnosticSeverity::Error,
            "empty_document",
            "",
            "Provide an ADE definition or pack.",
        );
    }
    result.diagnostics = report.diagnostics;
    result
}
