use super::*;
use serde_json::json;

fn source() -> serde_json::Value {
    json!({"format":"ade-theme","version":1,"id":"user:sample","name":"Sample","mode":"dark",
        "provenance":{"kind":"user"},"app":{"defaults":"ade:graphite","tokens":{"primary":"#AbC","foreground":"#ECEEF2"}}})
}

#[test]
fn jsonc_normalizes_literals_and_resolves_only_declared_defaults() {
    let text = format!("// theme\n{},", source());
    assert!(!validate(&text).valid); // A comma after the document is not JSONC.
    let text = format!("// theme\n{}", source());
    let result = validate(&text);
    assert!(result.valid, "{:?}", result.diagnostics);
    let app = result.definition.unwrap().app.unwrap();
    assert_eq!(app.tokens["primary"], "#aabbcc");
    assert_eq!(app.tokens["base"], "#101113");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "normalized" && d.line == 2)
    );
    let mut value = source();
    value["app"].as_object_mut().unwrap().remove("defaults");
    let result = validate(&value.to_string());
    assert!(!result.valid);
    assert!(result.definition.is_none());
    assert!(result.diagnostics.iter().any(|d| d.code == "missing_role"));
}

#[test]
fn duplicates_versions_css_and_wrong_mode_defaults_are_errors() {
    for text in [
        "{\"format\":\"ade-theme\",\"version\":1,\"version\":1}",
        "{format:'ade-theme'}",
        "{\"format\":\"ade-theme\" \"version\":1}",
    ] {
        assert!(!validate(text).valid);
    }
    for (path, value, code) in [
        ("/version", json!(2), "unsupported_version"),
        (
            "/app/tokens/primary",
            json!("var(--primary)"),
            "invalid_color",
        ),
        ("/app/tokens/foreground", json!("#fff8"), "invalid_color"),
        ("/app/defaults", json!("ade:chalk"), "invalid_default"),
        ("/id", json!("Sample"), "invalid_id"),
    ] {
        let mut data = source();
        *data.pointer_mut(path).unwrap() = value;
        let result = validate(&data.to_string());
        assert!(!result.valid, "{path}");
        assert!(
            result.diagnostics.iter().any(|d| d.code == code),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn cursor_fill_does_not_accept_alpha() {
    let mut data = source();
    data["terminal"] = json!({"defaults":"ade:graphite","tokens":{"terminal-cursor":"#11223344"}});
    let result = validate(&data.to_string());
    assert!(!result.valid);
    assert!(result.diagnostics.iter().any(|d| d.code == "invalid_color"));
}
#[test]
fn terminal_only_symbols_alpha_extended_palette_and_extensions_are_preserved() {
    let mut data = source();
    data.as_object_mut().unwrap().remove("app");
    data["terminal"] = json!({"defaults":"ade:graphite","tokens":{
        "terminal-cursor":"cell-foreground","terminal-cursor-text":"cell-background","terminal-selection":"#abc8","terminal-ansi-255":"#123456"}});
    data["future"] = json!({"data":"retained"});
    let result = validate(&data.to_string());
    assert!(result.valid, "{:?}", result.diagnostics);
    let definition = result.definition.unwrap();
    let terminal_appearance = crate::appearance::TerminalAppearance::for_palette(
        &definition
            .palette(crate::appearance::ThemeSectionKind::Terminal)
            .unwrap(),
    );
    assert_eq!(
        terminal_appearance.cursor,
        crate::appearance::CursorColor::Cell(crate::appearance::CellColor::CellForeground)
    );
    assert!(definition.app.is_none());
    let terminal = definition.terminal.unwrap();
    assert_eq!(terminal.tokens["terminal-cursor-text"], "cell-background");
    assert_eq!(terminal.tokens["terminal-cursor"], "cell-foreground");
    assert_eq!(terminal.tokens["terminal-selection"], "#aabbcc88");
    assert_eq!(terminal.tokens["terminal-ansi-255"], "#123456");
    assert_eq!(terminal.tokens["terminal-ansi-16"], "#000000");
    assert_eq!(
        terminal.tokens["terminal-selection-foreground"],
        "cell-foreground"
    );
    assert_eq!(definition.extensions["future"], json!({"data":"retained"}));
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "unsupported_extension")
    );
}

#[test]
fn malformed_and_bounded_input_never_produces_a_definition() {
    for text in ["", "null", "[]", "{", &" ".repeat(MAX_SOURCE_BYTES + 1)] {
        let result = validate(text);
        assert!(!result.valid);
        assert!(result.definition.is_none());
        assert!(!result.diagnostics.is_empty());
    }
    let mut data = source();
    data["provenance"] = json!({"kind":"imported","source":"fixture"});
    assert!(!validate(&data.to_string()).valid);
    data["provenance"]["source_digest"] = json!("sha256:fixture");
    assert!(validate(&data.to_string()).valid);
}

#[test]
fn nesting_is_bounded_before_ast_construction_and_literal_brackets_are_ignored() {
    let text = format!("{}null{}", "[".repeat(65), "]".repeat(65));
    let result = validate(&text);
    assert!(!result.valid);
    assert_eq!(result.diagnostics[0].code, "depth_limit");
    let mut data = source();
    data["name"] = json!("[".repeat(100));
    assert!(validate(&data.to_string()).valid);
}

#[test]
fn numeric_extensions_do_not_silently_change_type_and_palette_indexes_are_bounded() {
    let text = source()
        .to_string()
        .replace("\"format\"", "\"extension\":1e999,\"format\"");
    let report = validate(&text);
    assert!(!report.valid);
    assert!(
        report
            .diagnostics
            .iter()
            .any(|d| d.code == "invalid_number")
    );
    let mut data = source();
    data["terminal"] = json!({"defaults":"ade:graphite","tokens":{"terminal-ansi-256":"#ffffff"}});
    let report = validate(&data.to_string());
    assert!(!report.valid);
    assert!(
        report
            .diagnostics
            .iter()
            .any(|d| d.code == "invalid_palette_index")
    );
}

#[test]
fn normalized_definition_round_trips_without_losing_section_identity_or_extensions() {
    let mut data = source();
    data["extension"] = json!({"revision":42,"values":[true, null, "data"]});
    let first = validate(&data.to_string());
    assert!(first.valid);
    let serialized = serde_json::to_string(&first.definition.unwrap()).unwrap();
    let second = validate(&serialized);
    assert!(second.valid, "{:?}", second.diagnostics);
    assert_eq!(
        serialized,
        serde_json::to_string(&second.definition.unwrap()).unwrap()
    );
}

#[test]
fn default_expansion_must_fit_the_current_format_round_trip_limit() {
    let mut data = source();
    data["extension"] = json!("x".repeat(MAX_SOURCE_BYTES - 800));
    let text = data.to_string();
    assert!(text.len() < MAX_SOURCE_BYTES);
    let result = validate(&text);
    assert!(!result.valid);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "normalized_size_limit")
    );
}
