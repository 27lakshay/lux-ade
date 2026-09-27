//! The profile MCP catalog: entry model, validation, scope resolution and the
//! provider-native projections (F131, decision D14, architecture section 9).
//!
//! Everything here is pure. The daemon stores entries in the profile state
//! database and calls these functions; provider adapters read the projection.
//!
//! Protocol targets, checked 2026-09-27 against modelcontextprotocol.io:
//! the current revision is 2026-07-28, which defines the stdio and Streamable
//! HTTP bindings. Handshake-era revisions (2025-11-25 and earlier) remain in
//! use by deployed servers. The legacy HTTP+SSE transport (2024-11-05) is
//! modelled as `sse` only because Claude Code and Oh My Pi still accept it.
//!
//! ADE runs no MCP gateway yet. Every projection is a direct provider
//! configuration: the provider negotiates protocol version, capabilities and
//! authorization with the server itself, on its single leg.
use anyhow::{Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// MCP protocol revisions the modelled transports follow, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2026-07-28", "2025-11-25", "2025-06-18"];

/// Providers that have an MCP projection.
pub const PROJECTED_PROVIDERS: &[&str] = &["claude", "codex", "omp"];

/// Providers whose adapter passes the projection to the provider at launch:
/// Codex as one `mcp_servers.<name>` config override per server on
/// `thread/start` and `thread/resume`, Claude as the SDK's `mcpServers` query
/// option, and Oh My Pi as the `.mcp.json` of an ADE-owned extension package
/// named with `--extension`. Oh My Pi reads an explicitly named extension
/// package's sibling `.mcp.json` (`docs/extension-loading.md`,
/// `docs/mcp-config.md` "OMP extension packages"), so ADE never writes the
/// user's own `mcp.json`, and the user's native entries keep precedence.
pub const WIRED_PROVIDERS: &[&str] = &["claude", "codex", "omp"];

const MAX_NAME: usize = 64;
const MAX_TEXT: usize = 4096;
const MAX_ITEMS: usize = 64;

/// A value set in a server's environment or HTTP headers. Secrets are never
/// stored: they are read at launch from the named environment variable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum SettingValue {
    /// A non-secret value stored as written.
    Literal(String),
    /// The name of an environment variable in the provider's launch environment.
    Env(String),
}

/// How the server's code reached this host. ADE records it; it installs nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum Installation {
    /// A user-managed executable.
    Manual,
    /// A package pinned to an exact version, named as in the MCP registry's `server.json`.
    Package {
        registry: PackageRegistry,
        identifier: String,
        version: String,
    },
    /// A server someone else hosts; used with an HTTP transport.
    Remote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PackageRegistry {
    Npm,
    Pypi,
    Oci,
}

/// How a provider reaches the server. Inlined in schemas: `cwd` is optional
/// in a request and always present in a reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(inline)]
pub enum Transport {
    /// A subprocess the provider launches, speaking newline-delimited JSON-RPC.
    Stdio {
        /// An absolute path or a bare name looked up on the provider's PATH.
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, SettingValue>,
        /// An absolute directory, or null for the provider's default.
        cwd: Option<String>,
    },
    /// The Streamable HTTP binding.
    StreamableHttp {
        url: String,
        headers: BTreeMap<String, SettingValue>,
    },
    /// The legacy HTTP+SSE transport from protocol revision 2024-11-05.
    Sse {
        url: String,
        headers: BTreeMap<String, SettingValue>,
    },
}

/// Which workspaces an entry applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scope {
    /// Every workspace in the profile.
    Profile,
    Workspaces {
        workspace_ids: Vec<String>,
    },
    /// Every workspace checked out from these repositories.
    Repositories {
        repository_ids: Vec<String>,
    },
}

/// Which providers an entry applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderSelection {
    All,
    Only { provider_ids: Vec<String> },
}

/// Everything a caller sets on a catalog entry. Inlined like [`Transport`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct Definition {
    pub enabled: bool,
    pub installation: Installation,
    pub transport: Transport,
    pub scope: Scope,
    pub providers: ProviderSelection,
}

/// One catalog entry. `name` is its identity within the profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Server {
    pub name: String,
    /// Starts at 1 and increases with each update.
    pub revision: u64,
    pub definition: Definition,
}

/// The workspace a resolution is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target<'a> {
    pub workspace_id: &'a str,
    pub repository_id: Option<&'a str>,
    pub provider: &'a str,
}

/// Why an entry does not reach a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Exclusion {
    Disabled,
    OutsideScope,
    ProviderNotSelected,
    /// The provider's native configuration cannot express the entry faithfully.
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Excluded {
    pub name: String,
    pub reason: Exclusion,
    pub detail: String,
}

/// One entry in a provider's native shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Projected {
    pub name: String,
    pub revision: u64,
    /// The provider-native server object.
    pub native: Value,
}

/// The servers that apply to one workspace and provider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Resolution {
    pub servers: Vec<Projected>,
    pub excluded: Vec<Excluded>,
    /// The provider's whole native document, or null when the provider has no projection.
    pub document: Option<Value>,
    /// The document's format: `claude_mcp_json`, `codex_config_toml` or `omp_mcp_json`.
    pub format: Option<String>,
}

/// Checks an entry name: 1 to 64 lowercase letters, digits, `-` or `_`,
/// starting with a letter or digit. The same key is valid in every provider.
pub fn validate_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    ensure!(
        !name.is_empty()
            && name.len() <= MAX_NAME
            && chars
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
        "MCP server name must be 1 to 64 lowercase letters, digits, - or _"
    );
    Ok(())
}

/// Checks a definition before it is stored. `providers` lists the known provider IDs.
pub fn validate(definition: &Definition, providers: &[&str]) -> Result<()> {
    match &definition.installation {
        Installation::Package {
            identifier,
            version,
            ..
        } => {
            text("Package identifier", identifier)?;
            ensure!(
                is_exact_version(version),
                "Package version must be an exact version, not a range or tag"
            );
        }
        Installation::Manual | Installation::Remote => {}
    }
    match &definition.transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            ensure!(
                !matches!(definition.installation, Installation::Remote),
                "A remote installation needs an HTTP transport"
            );
            text("Command", command)?;
            ensure!(args.len() <= MAX_ITEMS, "At most 64 arguments are allowed");
            let mut secret_flag = false;
            for arg in args {
                ensure!(arg.len() <= MAX_TEXT, "Argument exceeds 4096 bytes");
                no_placeholder("Argument", arg)?;
                let key = arg.trim_start_matches('-');
                ensure!(
                    !secret_flag && !key.split_once('=').is_some_and(|(k, _)| is_secret_key(k)),
                    "Arguments must not carry secrets; pass them through an env credential reference"
                );
                secret_flag = arg.starts_with('-') && !arg.contains('=') && is_secret_key(key);
            }
            settings("Environment variable", env, is_env_name)?;
            if let Some(cwd) = cwd {
                text("Working directory", cwd)?;
                ensure!(cwd.starts_with('/'), "Working directory must be absolute");
            }
        }
        Transport::StreamableHttp { url, headers } | Transport::Sse { url, headers } => {
            ensure!(
                matches!(definition.installation, Installation::Remote),
                "An HTTP transport needs a remote installation"
            );
            validate_url(url)?;
            settings("Header", headers, is_header_name)?;
        }
    }
    match &definition.scope {
        Scope::Profile => {}
        Scope::Workspaces { workspace_ids: ids }
        | Scope::Repositories {
            repository_ids: ids,
        } => identifiers("Scope", ids)?,
    }
    if let ProviderSelection::Only { provider_ids } = &definition.providers {
        identifiers("Provider selection", provider_ids)?;
        for id in provider_ids {
            ensure!(providers.contains(&id.as_str()), "Unknown provider {id}");
        }
    }
    Ok(())
}

fn text(label: &str, value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= MAX_TEXT,
        "{label} must be 1 to 4096 bytes"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "{label} must not contain control characters"
    );
    no_placeholder(label, value)
}

/// Claude Code and Oh My Pi expand `${VAR}` in stored text, so a literal
/// containing it would change meaning between providers.
fn no_placeholder(label: &str, value: &str) -> Result<()> {
    ensure!(
        !value.contains("${") && !value.contains('\0'),
        "{label} must not contain ${{ or NUL; use an env reference"
    );
    Ok(())
}

fn identifiers(label: &str, ids: &[String]) -> Result<()> {
    ensure!(
        !ids.is_empty() && ids.len() <= MAX_ITEMS,
        "{label} must list 1 to 64 IDs"
    );
    let unique: BTreeSet<_> = ids.iter().collect();
    ensure!(unique.len() == ids.len(), "{label} lists an ID twice");
    ensure!(
        ids.iter().all(|id| !id.is_empty() && id.len() <= 512),
        "{label} lists an invalid ID"
    );
    Ok(())
}

fn settings(
    label: &str,
    values: &BTreeMap<String, SettingValue>,
    valid_key: fn(&str) -> bool,
) -> Result<()> {
    ensure!(values.len() <= MAX_ITEMS, "At most 64 {label} entries");
    let mut folded = BTreeSet::new();
    for (key, value) in values {
        ensure!(valid_key(key), "{label} name {key:?} is invalid");
        // HTTP header names are case-insensitive; refuse two spellings of one name.
        ensure!(
            folded.insert(key.to_ascii_lowercase()) || label != "Header",
            "Header {key} is set twice"
        );
        match value {
            SettingValue::Literal(literal) => {
                ensure!(
                    literal.len() <= MAX_TEXT,
                    "{label} {key} exceeds 4096 bytes"
                );
                ensure!(
                    !literal.chars().any(|c| c.is_control() && c != '\t'),
                    "{label} {key} must not contain control characters"
                );
                no_placeholder(label, literal)?;
                ensure!(
                    !is_secret_key(key),
                    "{label} {key} looks like a credential; store an env reference, not the value"
                );
            }
            SettingValue::Env(variable) => ensure!(
                is_env_name(variable),
                "{label} {key} references an invalid environment variable name"
            ),
        }
    }
    Ok(())
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 128
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// Whether a key names a credential. Such values must be env references.
pub fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    ["authorization", "cookie"].contains(&key.as_str())
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "api_key",
            "apikey",
            "credential",
            "private_key",
            "access_key",
            "auth",
        ]
        .iter()
        .any(|part| key.contains(part))
}

fn is_exact_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<_> = core.split('.').collect();
    !version.is_empty()
        && version.len() <= 128
        && (1..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+_".contains(c))
}

/// HTTPS, or plain HTTP to a loopback host. No embedded credentials.
fn validate_url(url: &str) -> Result<()> {
    text("URL", url)?;
    ensure!(
        !url.contains(char::is_whitespace),
        "URL must not contain spaces"
    );
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        bail!("URL must start with https:// or http://");
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    ensure!(
        !authority.is_empty() && !authority.contains('@'),
        "URL must name a host and must not embed credentials"
    );
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .unwrap_or("")
            .trim_start_matches('[')
    } else {
        authority.split(':').next().unwrap_or("")
    };
    ensure!(
        secure || matches!(host, "localhost" | "127.0.0.1" | "::1"),
        "Plain HTTP is allowed only to a loopback host"
    );
    if let Some(query) = rest[end..].split_once('?').map(|(_, q)| q) {
        let query = query.split('#').next().unwrap_or("");
        ensure!(
            !query
                .split('&')
                .any(|pair| is_secret_key(pair.split('=').next().unwrap_or(""))),
            "URL query must not carry credentials; use a header env reference"
        );
    }
    Ok(())
}

/// Whether an entry applies to a workspace and provider, before projection.
pub fn applies(definition: &Definition, target: &Target<'_>) -> Result<(), (Exclusion, String)> {
    if !definition.enabled {
        return Err((Exclusion::Disabled, "The entry is disabled".into()));
    }
    let in_scope = match &definition.scope {
        Scope::Profile => true,
        Scope::Workspaces { workspace_ids } => {
            workspace_ids.iter().any(|id| id == target.workspace_id)
        }
        Scope::Repositories { repository_ids } => target
            .repository_id
            .is_some_and(|repository| repository_ids.iter().any(|id| id == repository)),
    };
    if !in_scope {
        return Err((
            Exclusion::OutsideScope,
            "The workspace is outside the entry's scope".into(),
        ));
    }
    if let ProviderSelection::Only { provider_ids } = &definition.providers
        && !provider_ids.iter().any(|id| id == target.provider)
    {
        return Err((
            Exclusion::ProviderNotSelected,
            format!("The entry does not select provider {}", target.provider),
        ));
    }
    Ok(())
}

/// Variables Claude Code reads as empty in remote URLs and headers, so a
/// reference to one would silently send nothing.
const CLAUDE_BLANKED: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "HTTPS_PROXY",
    "NPM_TOKEN",
];

/// One entry in the provider's native shape, or why it cannot be expressed.
pub fn project(transport: &Transport, provider: &str) -> Result<Value, String> {
    match provider {
        "claude" => project_claude(transport),
        "codex" => project_codex(transport),
        "omp" => project_omp(transport),
        other => Err(format!("ADE has no MCP projection for provider {other}")),
    }
}

/// `${VAR}` for references, the text for literals.
fn expanded(values: &BTreeMap<String, SettingValue>) -> Map<String, Value> {
    values
        .iter()
        .map(|(key, value)| {
            let text = match value {
                SettingValue::Literal(text) => text.clone(),
                SettingValue::Env(variable) => format!("${{{variable}}}"),
            };
            (key.clone(), Value::String(text))
        })
        .collect()
}

fn project_claude(transport: &Transport) -> Result<Value, String> {
    match transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            if cwd.is_some() {
                return Err("Claude Code has no working-directory setting for MCP servers".into());
            }
            Ok(json!({"type": "stdio", "command": command, "args": args, "env": expanded(env)}))
        }
        Transport::StreamableHttp { url, headers } | Transport::Sse { url, headers } => {
            if let Some(variable) = headers.values().find_map(|value| match value {
                SettingValue::Env(variable) if CLAUDE_BLANKED.contains(&variable.as_str()) => {
                    Some(variable)
                }
                _ => None,
            }) {
                return Err(format!(
                    "Claude Code blanks {variable} in remote headers; reference a differently named variable"
                ));
            }
            let kind = if matches!(transport, Transport::Sse { .. }) {
                "sse"
            } else {
                "http"
            };
            Ok(json!({"type": kind, "url": url, "headers": expanded(headers)}))
        }
    }
}

fn project_codex(transport: &Transport) -> Result<Value, String> {
    match transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            let mut literal = Map::new();
            let mut forwarded = Vec::new();
            for (key, value) in env {
                match value {
                    SettingValue::Literal(text) => {
                        literal.insert(key.clone(), Value::String(text.clone()));
                    }
                    SettingValue::Env(variable) if variable == key => {
                        forwarded.push(Value::String(variable.clone()))
                    }
                    SettingValue::Env(variable) => {
                        return Err(format!(
                            "Codex forwards a variable only under its own name; {key} cannot read {variable}"
                        ));
                    }
                }
            }
            let mut native = json!({"command": command, "args": args, "enabled": true});
            if !literal.is_empty() {
                native["env"] = Value::Object(literal);
            }
            if !forwarded.is_empty() {
                native["env_vars"] = Value::Array(forwarded);
            }
            if let Some(cwd) = cwd {
                native["cwd"] = Value::String(cwd.clone());
            }
            Ok(native)
        }
        Transport::StreamableHttp { url, headers } => {
            let mut literal = Map::new();
            let mut from_env = Map::new();
            for (key, value) in headers {
                match value {
                    SettingValue::Literal(text) => literal.insert(key.clone(), text.clone().into()),
                    SettingValue::Env(variable) => {
                        from_env.insert(key.clone(), variable.clone().into())
                    }
                };
            }
            let mut native = json!({"url": url, "enabled": true});
            if !literal.is_empty() {
                native["http_headers"] = Value::Object(literal);
            }
            if !from_env.is_empty() {
                native["env_http_headers"] = Value::Object(from_env);
            }
            Ok(native)
        }
        Transport::Sse { .. } => {
            Err("Codex supports stdio and Streamable HTTP servers, not legacy SSE".into())
        }
    }
}

/// Oh My Pi resolves `env` and `headers` values again before connecting: a
/// value starting with `!` runs as a shell command and a value that names a
/// set environment variable is replaced by it. A literal of either shape
/// would not reach the server as written.
fn omp_literals(values: &BTreeMap<String, SettingValue>) -> Result<(), String> {
    for (key, value) in values {
        if let SettingValue::Literal(text) = value
            && (text.starts_with('!') || is_env_name(text))
        {
            return Err(format!(
                "Oh My Pi would reinterpret the literal value of {key}; use an env reference"
            ));
        }
    }
    Ok(())
}

fn project_omp(transport: &Transport) -> Result<Value, String> {
    match transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            omp_literals(env)?;
            let mut native =
                json!({"type": "stdio", "command": command, "args": args, "env": expanded(env)});
            if let Some(cwd) = cwd {
                native["cwd"] = Value::String(cwd.clone());
            }
            Ok(native)
        }
        Transport::StreamableHttp { url, headers } | Transport::Sse { url, headers } => {
            omp_literals(headers)?;
            let kind = if matches!(transport, Transport::Sse { .. }) {
                "sse"
            } else {
                "http"
            };
            Ok(json!({"type": kind, "url": url, "headers": expanded(headers)}))
        }
    }
}

fn document(provider: &str, servers: Map<String, Value>) -> Option<(Value, &'static str)> {
    match provider {
        "claude" => Some((json!({"mcpServers": servers}), "claude_mcp_json")),
        "codex" => Some((json!({"mcp_servers": servers}), "codex_config_toml")),
        "omp" => Some((json!({"mcpServers": servers}), "omp_mcp_json")),
        _ => None,
    }
}

/// The servers that reach `target.provider` in `target.workspace_id`, in name order.
pub fn resolve(servers: &[Server], target: &Target<'_>) -> Resolution {
    let mut sorted: Vec<&Server> = servers.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let mut projected = Vec::new();
    let mut excluded = Vec::new();
    for server in sorted {
        let outcome = applies(&server.definition, target).and_then(|()| {
            project(&server.definition.transport, target.provider)
                .map_err(|detail| (Exclusion::Unsupported, detail))
        });
        match outcome {
            Ok(native) => projected.push(Projected {
                name: server.name.clone(),
                revision: server.revision,
                native,
            }),
            Err((reason, detail)) => excluded.push(Excluded {
                name: server.name.clone(),
                reason,
                detail,
            }),
        }
    }
    let natives = projected
        .iter()
        .map(|server| (server.name.clone(), server.native.clone()))
        .collect();
    let (document, format) = match document(target.provider, natives) {
        Some((document, format)) => (Some(document), Some(format.to_owned())),
        None => (None, None),
    };
    Resolution {
        servers: projected,
        excluded,
        document,
        format,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDERS: &[&str] = &["claude", "codex", "omp", "opencode"];

    fn stdio(env: &[(&str, SettingValue)]) -> Definition {
        Definition {
            enabled: true,
            installation: Installation::Package {
                registry: PackageRegistry::Npm,
                identifier: "@modelcontextprotocol/server-github".into(),
                version: "2025.4.8".into(),
            },
            transport: Transport::Stdio {
                command: "npx".into(),
                args: vec![
                    "-y".into(),
                    "@modelcontextprotocol/server-github@2025.4.8".into(),
                ],
                env: env
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), v.clone()))
                    .collect(),
                cwd: None,
            },
            scope: Scope::Profile,
            providers: ProviderSelection::All,
        }
    }

    fn http(url: &str, headers: &[(&str, SettingValue)]) -> Definition {
        Definition {
            installation: Installation::Remote,
            transport: Transport::StreamableHttp {
                url: url.into(),
                headers: headers
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), v.clone()))
                    .collect(),
            },
            ..stdio(&[])
        }
    }

    fn env(name: &str) -> SettingValue {
        SettingValue::Env(name.into())
    }

    fn literal(text: &str) -> SettingValue {
        SettingValue::Literal(text.into())
    }

    fn target<'a>(
        workspace: &'a str,
        repository: Option<&'a str>,
        provider: &'a str,
    ) -> Target<'a> {
        Target {
            workspace_id: workspace,
            repository_id: repository,
            provider,
        }
    }

    fn server(name: &str, definition: Definition) -> Server {
        Server {
            name: name.into(),
            revision: 1,
            definition,
        }
    }

    #[test]
    fn names_are_portable_provider_keys() {
        for good in ["github", "a", "my-server_2", "0x"] {
            validate_name(good).unwrap();
        }
        for bad in ["", "GitHub", "-x", "a.b", "a b", &"x".repeat(65)] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn credentials_must_be_references() {
        validate(&stdio(&[("GITHUB_TOKEN", env("GITHUB_TOKEN"))]), PROVIDERS).unwrap();
        validate(&stdio(&[("LOG_LEVEL", literal("debug"))]), PROVIDERS).unwrap();
        let raw = stdio(&[("GITHUB_TOKEN", literal("ghp_x"))]);
        assert!(
            validate(&raw, PROVIDERS)
                .unwrap_err()
                .to_string()
                .contains("credential")
        );
        let header = http(
            "https://mcp.example.com/mcp",
            &[("Authorization", literal("Bearer x"))],
        );
        assert!(validate(&header, PROVIDERS).is_err());
        validate(
            &http(
                "https://mcp.example.com/mcp",
                &[("Authorization", env("EXAMPLE_TOKEN"))],
            ),
            PROVIDERS,
        )
        .unwrap();
        for args in [
            vec!["--api-key=abc"],
            vec!["--token", "abc"],
            vec!["--password", "x"],
        ] {
            let mut definition = stdio(&[]);
            if let Transport::Stdio { args: stored, .. } = &mut definition.transport {
                *stored = args.iter().map(|a| (*a).to_owned()).collect();
            }
            assert!(validate(&definition, PROVIDERS).is_err(), "{args:?}");
        }
    }

    #[test]
    fn urls_are_https_or_loopback_without_embedded_secrets() {
        for good in [
            "https://mcp.example.com/mcp",
            "http://localhost:3000/mcp",
            "http://127.0.0.1/mcp",
            "http://[::1]:8080/mcp",
            "https://x.test/mcp?region=eu",
        ] {
            validate(&http(good, &[]), PROVIDERS).unwrap();
        }
        for bad in [
            "http://mcp.example.com/mcp",
            "https://user:pw@mcp.example.com/mcp",
            "https://x.test/mcp?api_key=1",
            "ftp://x.test",
            "https://",
            "https://x.test/${HOST}",
        ] {
            assert!(validate(&http(bad, &[]), PROVIDERS).is_err(), "{bad}");
        }
    }

    #[test]
    fn installation_and_transport_must_agree_and_versions_are_exact() {
        let mut remote_stdio = stdio(&[]);
        remote_stdio.installation = Installation::Remote;
        assert!(validate(&remote_stdio, PROVIDERS).is_err());
        let mut local_http = http("https://x.test/mcp", &[]);
        local_http.installation = Installation::Manual;
        assert!(validate(&local_http, PROVIDERS).is_err());
        for (version, ok) in [
            ("1.2.3", true),
            ("2025.4.8", true),
            ("1.0.0-beta.1", true),
            ("^1.2.3", false),
            ("latest", false),
            ("1.x", false),
            (">=1", false),
        ] {
            let mut definition = stdio(&[]);
            if let Installation::Package {
                version: stored, ..
            } = &mut definition.installation
            {
                *stored = version.into();
            }
            assert_eq!(validate(&definition, PROVIDERS).is_ok(), ok, "{version}");
        }
    }

    #[test]
    fn placeholders_and_unknown_providers_are_refused() {
        assert!(validate(&stdio(&[("HOME_DIR", literal("${HOME}"))]), PROVIDERS).is_err());
        let mut definition = stdio(&[]);
        definition.providers = ProviderSelection::Only {
            provider_ids: vec!["cursor".into()],
        };
        assert!(validate(&definition, PROVIDERS).is_err());
        definition.providers = ProviderSelection::Only {
            provider_ids: vec![],
        };
        assert!(validate(&definition, PROVIDERS).is_err());
        definition.providers = ProviderSelection::All;
        definition.scope = Scope::Workspaces {
            workspace_ids: vec!["w".into(), "w".into()],
        };
        assert!(validate(&definition, PROVIDERS).is_err());
    }

    #[test]
    fn scope_resolution_follows_workspace_repository_and_provider() {
        let mut only_w1 = stdio(&[]);
        only_w1.scope = Scope::Workspaces {
            workspace_ids: vec!["w1".into()],
        };
        let mut repo = stdio(&[]);
        repo.scope = Scope::Repositories {
            repository_ids: vec!["r1".into()],
        };
        let mut codex_only = stdio(&[]);
        codex_only.providers = ProviderSelection::Only {
            provider_ids: vec!["codex".into()],
        };
        let mut disabled = stdio(&[]);
        disabled.enabled = false;

        assert_eq!(applies(&only_w1, &target("w1", None, "claude")), Ok(()));
        assert_eq!(
            applies(&only_w1, &target("w2", None, "claude"))
                .unwrap_err()
                .0,
            Exclusion::OutsideScope
        );
        assert_eq!(applies(&repo, &target("w9", Some("r1"), "omp")), Ok(()));
        assert_eq!(
            applies(&repo, &target("w9", None, "omp")).unwrap_err().0,
            Exclusion::OutsideScope
        );
        assert_eq!(applies(&codex_only, &target("w", None, "codex")), Ok(()));
        assert_eq!(
            applies(&codex_only, &target("w", None, "claude"))
                .unwrap_err()
                .0,
            Exclusion::ProviderNotSelected
        );
        // Disabled wins over every other reason.
        assert_eq!(
            applies(&disabled, &target("w", None, "claude"))
                .unwrap_err()
                .0,
            Exclusion::Disabled
        );
    }

    #[test]
    fn one_entry_projects_into_each_provider_shape() {
        let definition = stdio(&[
            ("GITHUB_TOKEN", env("GITHUB_TOKEN")),
            ("LOG_LEVEL", literal("debug level")),
        ]);
        let servers = [server("github", definition)];
        let claude = resolve(&servers, &target("w", None, "claude"));
        assert_eq!(claude.format.as_deref(), Some("claude_mcp_json"));
        assert_eq!(
            claude.document.unwrap()["mcpServers"]["github"]["env"],
            json!({"GITHUB_TOKEN": "${GITHUB_TOKEN}", "LOG_LEVEL": "debug level"})
        );
        let codex = resolve(&servers, &target("w", None, "codex"));
        let native = &codex.document.unwrap()["mcp_servers"]["github"];
        assert_eq!(native["env_vars"], json!(["GITHUB_TOKEN"]));
        assert_eq!(native["env"], json!({"LOG_LEVEL": "debug level"}));
        let omp = resolve(&servers, &target("w", None, "omp"));
        assert_eq!(omp.servers.len(), 1);
        let other = resolve(&servers, &target("w", None, "opencode"));
        assert!(other.document.is_none() && other.servers.is_empty());
        assert_eq!(other.excluded[0].reason, Exclusion::Unsupported);
    }

    #[test]
    fn projections_refuse_what_a_provider_cannot_express() {
        // Codex forwards variables only under their own names.
        let renamed = stdio(&[("GH_TOKEN", env("GITHUB_TOKEN"))]);
        assert!(project(&renamed.transport, "codex").is_err());
        assert!(project(&renamed.transport, "claude").is_ok());
        // Claude Code has no cwd; Codex and Oh My Pi do.
        let mut with_cwd = stdio(&[]);
        if let Transport::Stdio { cwd, .. } = &mut with_cwd.transport {
            *cwd = Some("/srv".into());
        }
        assert!(project(&with_cwd.transport, "claude").is_err());
        assert_eq!(
            project(&with_cwd.transport, "codex").unwrap()["cwd"],
            "/srv"
        );
        // Codex has no legacy SSE.
        let sse = Transport::Sse {
            url: "https://x.test/sse".into(),
            headers: BTreeMap::new(),
        };
        assert!(project(&sse, "codex").is_err());
        assert_eq!(project(&sse, "claude").unwrap()["type"], "sse");
        // Claude Code blanks some credential variables in remote headers.
        let blanked = http("https://x.test/mcp", &[("X-Key", env("ANTHROPIC_API_KEY"))]);
        assert!(project(&blanked.transport, "claude").is_err());
        let codex = project(&blanked.transport, "codex").unwrap();
        assert_eq!(
            codex["env_http_headers"],
            json!({"X-Key": "ANTHROPIC_API_KEY"})
        );
        // Oh My Pi would run `!…` or substitute a bare variable name.
        for value in ["!echo hi", "DEBUG"] {
            let definition = stdio(&[("MODE", literal(value))]);
            assert!(project(&definition.transport, "omp").is_err(), "{value}");
            assert!(project(&definition.transport, "claude").is_ok());
        }
    }

    #[test]
    fn resolution_is_ordered_and_reports_every_exclusion() {
        let mut disabled = stdio(&[]);
        disabled.enabled = false;
        let servers = [
            server("zeta", stdio(&[])),
            server("alpha", stdio(&[])),
            server("off", disabled),
        ];
        let resolution = resolve(&servers, &target("w", None, "claude"));
        let names: Vec<_> = resolution.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alpha", "zeta"]);
        assert_eq!(resolution.excluded.len(), 1);
        assert_eq!(resolution.excluded[0].reason, Exclusion::Disabled);
    }

    #[test]
    fn definitions_round_trip_and_reject_unknown_fields() {
        let definition = http("https://x.test/mcp", &[("Authorization", env("X_TOKEN"))]);
        let wire = serde_json::to_value(&definition).unwrap();
        assert_eq!(
            wire["transport"],
            json!({"type": "streamable_http", "url": "https://x.test/mcp",
                "headers": {"Authorization": {"env": "X_TOKEN"}}})
        );
        assert_eq!(wire["installation"], json!({"source": "remote"}));
        let back: Definition = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(back, definition);
        let mut extra = wire;
        extra["secret"] = json!("x");
        assert!(serde_json::from_value::<Definition>(extra).is_err());
    }
}
