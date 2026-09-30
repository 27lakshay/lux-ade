//! Pure manifest validation and data-schema admission. The registry calls
//! these before it records or activates an artifact, so an incompatible
//! manifest never reaches an activation.
//!
//! Path segment rules follow Orca's plugin path safety
//! (`orca/src/shared/plugins/plugin-path-safety.ts`, MIT), studied, not copied.
use ade_core::contract::plugins::{
    MANIFEST_VERSION, PluginManifest, PluginSettingContribution, PluginSettingKind,
    SUPPORTED_API_VERSIONS,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

/// Manifests larger than this are rejected before parsing.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ID: usize = 64;
const MAX_TITLE: usize = 256;
const MAX_NAME: usize = 128;
const MAX_COMMANDS: usize = 256;
const MAX_PANELS: usize = 64;
const MAX_SETTINGS: usize = 128;
const MAX_THEMES: usize = 32;

/// Parses and validates `ade-plugin.json`. `files` lists every regular file in
/// the artifact as a `/`-separated relative path; entry points must be among them.
pub fn read(bytes: &[u8], files: &BTreeSet<String>) -> Result<PluginManifest, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "Plugin manifest exceeds {MAX_MANIFEST_BYTES} bytes"
        ));
    }
    let manifest: PluginManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("Plugin manifest is invalid: {error}"))?;
    let problems = problems(&manifest, files);
    if problems.is_empty() {
        Ok(manifest)
    } else {
        Err(format!(
            "Plugin manifest is invalid: {}",
            problems.join("; ")
        ))
    }
}

/// Every reason `manifest` cannot be installed, in a stable order.
pub fn problems(manifest: &PluginManifest, files: &BTreeSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    if manifest.manifest_version != MANIFEST_VERSION {
        out.push(format!(
            "manifest_version {} is not supported; expected {MANIFEST_VERSION}",
            manifest.manifest_version
        ));
    }
    if !plugin_id(&manifest.id) {
        out.push("id must be publisher.name in lowercase letters, digits and hyphens".into());
    }
    if !text(&manifest.name, MAX_NAME) {
        out.push(format!("name must be 1 to {MAX_NAME} printable characters"));
    }
    if manifest.version.len() > 64 || semver::Version::parse(&manifest.version).is_err() {
        out.push("version must be a semantic version".into());
    }
    if !SUPPORTED_API_VERSIONS.contains(&manifest.api_version) {
        out.push(format!(
            "api_version {} is not supported by this ADE",
            manifest.api_version
        ));
    }
    if manifest.data_schema == 0 {
        out.push("data_schema must be at least 1".into());
    }
    if let Some(description) = &manifest.description
        && description.chars().count() > 1024
    {
        out.push("description exceeds 1024 characters".into());
    }
    let entries = &manifest.entry_points;
    let declared = [
        ("ui", &entries.ui),
        ("backend", &entries.backend),
        ("provider", &entries.provider),
    ];
    if declared.iter().all(|(_, path)| path.is_none()) {
        out.push("entry_points must declare ui, backend or provider".into());
    }
    for (name, path) in declared {
        let Some(path) = path else { continue };
        if let Some(problem) = relative_path_problem(path) {
            out.push(format!("entry_points.{name} {problem}"));
        } else if !files.contains(path) {
            out.push(format!("entry_points.{name} {path} is not in the artifact"));
        }
    }
    let contributes = &manifest.contributes;
    if contributes.commands.len() > MAX_COMMANDS {
        out.push(format!("at most {MAX_COMMANDS} commands"));
    }
    if contributes.panels.len() > MAX_PANELS {
        out.push(format!("at most {MAX_PANELS} panels"));
    }
    if contributes.settings.len() > MAX_SETTINGS {
        out.push(format!("at most {MAX_SETTINGS} settings"));
    }
    if contributes.themes.len() > MAX_THEMES {
        out.push(format!("at most {MAX_THEMES} themes"));
    }
    let theme_prefix = format!("plugin.{}:", manifest.id);
    let mut theme_ids = HashSet::new();
    for theme in &contributes.themes {
        let source = match serde_json::to_string(theme) {
            Ok(source) => source,
            Err(error) => {
                out.push(format!("theme definition cannot be serialized: {error}"));
                continue;
            }
        };
        let validated = ade_core::appearance::definition::validate(&source);
        let sections = [
            ("app", &theme.app),
            ("terminal", &theme.terminal),
            ("syntax", &theme.syntax),
        ];
        let unsupported_roles = sections.into_iter().any(|(kind, section)| {
            section.as_ref().is_some_and(|section| {
                section
                    .tokens
                    .keys()
                    .any(|role| !ade_core::appearance::definition::known_role(kind, role))
            })
        });
        if !validated.valid || unsupported_roles {
            out.push(format!("theme {} is invalid", theme.id));
            continue;
        }
        if !theme.id.starts_with(&theme_prefix) || theme.id.len() == theme_prefix.len() {
            out.push(format!(
                "theme {} must use namespaced ID {theme_prefix}<name>",
                theme.id
            ));
        }
        if !theme_ids.insert(theme.id.as_str()) {
            out.push(format!("theme {} is declared twice", theme.id));
        }
        if !matches!(
            theme.provenance.kind,
            ade_core::appearance::definition::ThemeOrigin::Plugin
        ) {
            out.push(format!("theme {} provenance kind must be plugin", theme.id));
        }
        if !theme.extensions.is_empty()
            || [&theme.app, &theme.terminal, &theme.syntax]
                .into_iter()
                .flatten()
                .any(|section| !section.extensions.is_empty())
            || validated
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unsupported_extension")
        {
            out.push(format!(
                "theme {} contains unsupported extension data",
                theme.id
            ));
        }
    }
    if !contributes.commands.is_empty() && entries.ui.is_none() && entries.backend.is_none() {
        out.push("commands need a ui or backend entry point".into());
    }
    if !contributes.panels.is_empty() && entries.ui.is_none() {
        out.push("panels need a ui entry point".into());
    }
    // Hooks run in the backend host after the event commits.
    if !contributes.hooks.is_empty() && entries.backend.is_none() {
        out.push("hooks need a backend entry point".into());
    }
    let mut events = HashSet::new();
    for event in &contributes.hooks {
        if !events.insert(*event) {
            out.push(format!("hook {} is declared twice", event.as_str()));
        }
    }
    let mut seen = HashSet::new();
    for (kind, id, title) in contributes
        .commands
        .iter()
        .map(|c| ("command", &c.id, &c.title))
        .chain(
            contributes
                .panels
                .iter()
                .map(|p| ("panel", &p.id, &p.title)),
        )
    {
        if !contribution_id(&manifest.id, id) {
            out.push(format!(
                "{kind} {id} must be {}.<name> in lowercase letters, digits, hyphens and underscores",
                manifest.id
            ));
        }
        if !seen.insert((kind, id.as_str())) {
            out.push(format!("{kind} {id} is declared twice"));
        }
        if !text(title, MAX_TITLE) {
            out.push(format!(
                "{kind} {id} title must be 1 to {MAX_TITLE} characters"
            ));
        }
    }
    let mut keys = HashSet::new();
    for setting in &contributes.settings {
        if !local_name(&setting.key) {
            out.push(format!(
                "setting {} must be lowercase letters, digits, hyphens and underscores",
                setting.key
            ));
        }
        if !keys.insert(setting.key.as_str()) {
            out.push(format!("setting {} is declared twice", setting.key));
        }
        if !text(&setting.title, MAX_TITLE) {
            out.push(format!(
                "setting {} title must be 1 to {MAX_TITLE} characters",
                setting.key
            ));
        }
        if let Some(problem) = default_problem(setting) {
            out.push(problem);
        }
    }
    out
}

/// `publisher.name`: at least two dot-separated parts, each lowercase letters
/// and digits joined by single hyphens.
pub fn plugin_id(id: &str) -> bool {
    id.len() <= MAX_ID
        && id.split('.').count() >= 2
        && id.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && !part.contains("--")
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// A record namespace, record key segment or setting key: 1 to 64 bytes of
/// lowercase letters, digits, `-` and `_`, starting with a letter or digit.
pub fn local_name(name: &str) -> bool {
    (1..=MAX_ID).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// A command or panel ID: the plugin ID, a dot, then a local name. Scoping
/// every contribution under its plugin ID keeps two plugins from colliding.
pub fn contribution_id(plugin: &str, id: &str) -> bool {
    id.len() <= 2 * MAX_ID
        && id
            .strip_prefix(plugin)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(local_name)
}

fn text(value: &str, max: usize) -> bool {
    let count = value.chars().count();
    (1..=max).contains(&count) && !value.trim().is_empty() && !value.chars().any(char::is_control)
}

/// Why `path` is not a safe `/`-separated path inside an artifact.
pub fn relative_path_problem(path: &str) -> Option<&'static str> {
    if path.is_empty() || path.len() > 512 || path.starts_with('/') {
        return Some("must be a non-empty relative path");
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Some("must not contain empty or dot segments");
        }
        if segment.contains('\\') || segment.chars().any(char::is_control) {
            return Some("must not contain backslashes or control characters");
        }
    }
    None
}

/// Why `value` cannot be stored for a setting of `kind`. Null always clears.
pub fn setting_value_problem(kind: PluginSettingKind, value: &Value) -> Option<String> {
    let ok = match (kind, value) {
        (_, Value::Null) => true,
        (PluginSettingKind::String, Value::String(text)) => text.len() <= 16 * 1024,
        (PluginSettingKind::Boolean, Value::Bool(_)) => true,
        (PluginSettingKind::Number, Value::Number(_)) => true,
        (PluginSettingKind::CredentialRef, reference @ Value::Object(_)) => {
            serde_json::from_value::<ade_core::credentials::CredentialReference>(reference.clone())
                .is_ok_and(|reference| reference.validate().is_ok())
        }
        _ => false,
    };
    (!ok).then(|| match kind {
        PluginSettingKind::String => "must be a string of at most 16 KiB".into(),
        PluginSettingKind::Boolean => "must be true or false".into(),
        PluginSettingKind::Number => "must be a number".into(),
        PluginSettingKind::CredentialRef => "must be a credential reference, {\"env\": \"NAME\"} \
             or {\"keychain\": {\"service\": \"...\", \"account\": \"...\"}}, or {\"secret\": \"...\"} \
             to move a value into the Keychain"
            .into(),
    })
}

fn default_problem(setting: &PluginSettingContribution) -> Option<String> {
    let default = setting.default.as_ref()?;
    if setting.kind == PluginSettingKind::CredentialRef {
        return Some(format!(
            "setting {} is a credential reference and cannot have a default",
            setting.key
        ));
    }
    setting_value_problem(setting.kind, default)
        .map(|problem| format!("setting {} default {problem}", setting.key))
}

/// How a newly installed artifact's data schema relates to the stored data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaAdmission {
    /// Accept, and record this as the stored data schema.
    Accept(u32),
    /// Refuse: the code is older than data already written. Code rollback is
    /// not data rollback.
    Downgrade { stored: u32, incoming: u32 },
}

/// Decides whether an artifact declaring `incoming` may be installed over
/// data at `stored` (None for a first install or after a purge).
pub fn admit_data_schema(stored: Option<u32>, incoming: u32) -> SchemaAdmission {
    match stored {
        Some(stored) if incoming < stored => SchemaAdmission::Downgrade { stored, incoming },
        Some(stored) => SchemaAdmission::Accept(stored.max(incoming)),
        None => SchemaAdmission::Accept(incoming),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn files(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    fn base() -> Value {
        json!({"manifest_version": 1, "id": "acme.notes", "name": "Notes", "version": "1.0.0",
            "api_version": 1, "data_schema": 1, "entry_points": {"ui": "dist/ui.js"},
            "contributes": {"commands": [{"id": "acme.notes.open", "title": "Open"}],
                "panels": [{"id": "acme.notes.side", "title": "Notes"}],
                "settings": [{"key": "wrap", "title": "Wrap", "kind": "boolean", "default": false},
                    {"key": "token", "title": "Token", "kind": "credential_ref"}]}})
    }

    fn check(manifest: Value) -> Result<PluginManifest, String> {
        read(
            &serde_json::to_vec(&manifest).unwrap(),
            &files(&["dist/ui.js", "ade-plugin.json"]),
        )
    }

    fn rejects(change: impl FnOnce(&mut Value), expected: &str) {
        let mut manifest = base();
        change(&mut manifest);
        let error = check(manifest).unwrap_err();
        assert!(error.contains(expected), "{error} lacks {expected}");
    }

    #[test]
    fn unsupported_theme_roles_are_rejected_after_diagnostic_limit() {
        let mut manifest = base();
        let tokens: serde_json::Map<String, Value> = (0..256)
            .map(|index| (format!("terminal-ansi-{index}"), json!("#AABBCC")))
            .collect();
        manifest["contributes"]["themes"] = json!([{
            "format": "ade-theme",
            "version": 1,
            "id": "plugin.acme.notes:diagnostic-limit",
            "name": "Diagnostic limit",
            "mode": "dark",
            "provenance": {"kind": "plugin", "source": "acme.notes", "source_version": "1.0.0"},
            "terminal": {"defaults": "ade:graphite", "tokens": tokens}
        }]);

        let theme_source = serde_json::to_string(&manifest["contributes"]["themes"][0]).unwrap();
        let validation = ade_core::appearance::definition::validate(&theme_source);
        assert!(validation.valid, "{:?}", validation.diagnostics);
        let baseline = check(manifest.clone());
        assert!(baseline.is_ok(), "{baseline:?}");
        manifest["contributes"]["themes"][0]["terminal"]["tokens"]
            .as_object_mut()
            .unwrap()
            .insert("zzz-unsupported".into(), json!("#123456"));
        let error = check(manifest).unwrap_err();
        assert!(
            error.contains("theme plugin.acme.notes:diagnostic-limit is invalid"),
            "{error}"
        );
    }

    #[test]
    fn accepts_a_complete_manifest() {
        let manifest = check(base()).unwrap();
        assert_eq!(manifest.id, "acme.notes");
        assert_eq!(manifest.contributes.commands[0].id, "acme.notes.open");
    }

    #[test]
    fn rejects_incompatible_manifests_before_activation() {
        rejects(|m| m["manifest_version"] = json!(2), "manifest_version 2");
        rejects(|m| m["api_version"] = json!(9), "api_version 9");
        rejects(|m| m["data_schema"] = json!(0), "data_schema");
        rejects(|m| m["version"] = json!("1.0"), "semantic version");
        rejects(|m| m["id"] = json!("notes"), "publisher.name");
        rejects(|m| m["id"] = json!("Acme.notes"), "publisher.name");
        rejects(|m| m["id"] = json!("acme..notes"), "publisher.name");
        rejects(|m| m["name"] = json!(" "), "name");
        rejects(|m| m["entry_points"] = json!({}), "must declare");
        rejects(
            |m| m["entry_points"]["ui"] = json!("dist/missing.js"),
            "not in the artifact",
        );
        rejects(
            |m| m["entry_points"]["ui"] = json!("../x.js"),
            "dot segments",
        );
        rejects(|m| m["entry_points"]["ui"] = json!("/abs.js"), "relative");
        rejects(|m| m["surprise"] = json!(true), "unknown field");
    }

    #[test]
    fn contributions_stay_inside_the_plugin_namespace() {
        rejects(
            |m| m["contributes"]["commands"][0]["id"] = json!("other.plugin.open"),
            "must be acme.notes.<name>",
        );
        rejects(
            |m| m["contributes"]["commands"][0]["id"] = json!("acme.notesopen"),
            "must be acme.notes.<name>",
        );
        rejects(
            |m| {
                m["contributes"]["commands"] = json!([{"id": "acme.notes.a", "title": "A"}, {"id": "acme.notes.a", "title": "B"}])
            },
            "declared twice",
        );
        rejects(
            |m| {
                m["entry_points"] = json!({"backend": "dist/ui.js"});
            },
            "panels need a ui entry point",
        );
        rejects(
            |m| m["contributes"]["hooks"] = json!(["turn.settled"]),
            "hooks need a backend entry point",
        );
        rejects(
            |m| m["contributes"]["hooks"] = json!(["turn.started"]),
            "unknown variant",
        );
        rejects(
            |m| {
                m["entry_points"]["backend"] = json!("dist/ui.js");
                m["contributes"]["hooks"] = json!(["turn.settled", "turn.settled"]);
            },
            "hook turn.settled is declared twice",
        );
        // A command and a panel may share a local name; they are separate kinds.
        let mut manifest = base();
        manifest["contributes"]["panels"][0]["id"] = json!("acme.notes.open");
        assert!(check(manifest).is_ok());
    }

    #[test]
    fn settings_defaults_match_their_kind() {
        rejects(
            |m| m["contributes"]["settings"][0]["default"] = json!("yes"),
            "must be true or false",
        );
        rejects(
            |m| m["contributes"]["settings"][1]["default"] = json!("secret"),
            "cannot have a default",
        );
        rejects(
            |m| m["contributes"]["settings"][0]["key"] = json!("Wrap"),
            "setting Wrap",
        );
        assert!(setting_value_problem(PluginSettingKind::Number, &json!(2.5)).is_none());
        assert!(setting_value_problem(PluginSettingKind::Number, &json!("2")).is_some());
        assert!(setting_value_problem(PluginSettingKind::CredentialRef, &json!("")).is_some());
        // A credential is a typed reference; a bare string may be the secret itself.
        assert!(
            setting_value_problem(PluginSettingKind::CredentialRef, &json!("keychain:a/b"))
                .is_some()
        );
        assert!(
            setting_value_problem(
                PluginSettingKind::CredentialRef,
                &json!({"env": "API_TOKEN"})
            )
            .is_none()
        );
        assert!(
            setting_value_problem(
                PluginSettingKind::CredentialRef,
                &json!({"keychain": {"service": "s", "account": "a"}})
            )
            .is_none()
        );
        assert!(
            setting_value_problem(PluginSettingKind::CredentialRef, &json!({"env": "ghp_x"}))
                .is_some()
        );
        assert!(
            setting_value_problem(PluginSettingKind::CredentialRef, &json!({"secret": "x"}))
                .is_some()
        );
        assert!(setting_value_problem(PluginSettingKind::String, &Value::Null).is_none());
    }

    #[test]
    fn names_and_paths() {
        assert!(plugin_id("acme.notes"));
        assert!(plugin_id("a-b.c1.d"));
        assert!(!plugin_id("acme.-notes"));
        assert!(!plugin_id(&format!("a.{}", "b".repeat(64))));
        assert!(local_name("drafts_v2"));
        assert!(!local_name("_x"));
        assert!(!local_name("a.b"));
        assert!(contribution_id("a.b", "a.b.c"));
        assert!(!contribution_id("a.b", "a.b."));
        assert!(!contribution_id("a.b", "a.bc.d"));
        assert!(relative_path_problem("dist/ui.js").is_none());
        assert!(relative_path_problem("dist//ui.js").is_some());
        assert!(relative_path_problem("dist\\..\\x").is_some());
    }

    #[test]
    fn data_schema_never_moves_backwards() {
        assert_eq!(admit_data_schema(None, 3), SchemaAdmission::Accept(3));
        assert_eq!(admit_data_schema(Some(2), 2), SchemaAdmission::Accept(2));
        assert_eq!(admit_data_schema(Some(2), 3), SchemaAdmission::Accept(3));
        assert_eq!(
            admit_data_schema(Some(3), 2),
            SchemaAdmission::Downgrade {
                stored: 3,
                incoming: 2
            }
        );
    }
}
