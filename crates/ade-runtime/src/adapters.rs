//! Generic adapters (F024): any ACP agent, or a plain CLI agent, launched
//! from a profile-scoped definition.
//!
//! [`validate`] is the one check every stored definition passes. [`probe`]
//! reports what an adapter can do right now, and [`spawn`] starts it behind
//! the ordinary [`Provider`] interface.
use crate::provider::{Config, Event, Provider};
use ade_core::contract::providers::adapters::{
    AdapterDefinition, AdapterKind, ExecutableIdentity, ProbeOutcome,
};
use anyhow::{Context, Result, bail, ensure};
use std::{
    os::unix::fs::MetadataExt,
    path::{Component, Path},
    process::Command,
    sync::{Arc, mpsc},
    time::Duration,
};

pub mod acp;
mod acp_session;
mod executable;

/// Prefix that keeps adapter provider IDs apart from bundled providers.
pub const PROVIDER_PREFIX: &str = "adapter:";
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 32;
const MAX_TEXT: usize = 4096;
/// A probe must answer well inside a client's 30-second request deadline.
const PROBE_INITIALIZE_LIMIT: Duration = Duration::from_secs(15);

/// The provider ID a conversation uses for an adapter.
pub fn provider_id(id: &str) -> String {
    format!("{PROVIDER_PREFIX}{id}")
}

/// Environment names refused because they usually carry credentials. A
/// definition is stored in plain text, so a secret does not belong in it.
fn secret_like(name: &str) -> bool {
    const WORDS: &[&str] = &[
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PASS",
        "CREDENTIAL",
        "CREDENTIALS",
        "KEY",
        "APIKEY",
        "AUTH",
        "COOKIE",
        "SESSION",
        "PRIVATE",
    ];
    name.split('_').any(|word| WORDS.contains(&word))
}

fn text(value: &str, field: &str, max: usize) -> Result<()> {
    ensure!(
        value.len() <= max && !value.contains('\0'),
        "{field} must be at most {max} bytes without NUL characters"
    );
    Ok(())
}

/// Validates a definition before it is stored or launched.
pub fn validate(definition: &AdapterDefinition) -> Result<()> {
    let id = &definition.id;
    ensure!(
        !id.is_empty()
            && id.len() <= 40
            && id.starts_with(|c: char| c.is_ascii_lowercase())
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "Adapter ID must be 1 to 40 lowercase letters, digits or '-', starting with a letter"
    );
    let name = definition.name.trim();
    ensure!(
        !name.is_empty()
            && definition.name.chars().count() <= 80
            && !definition.name.chars().any(char::is_control),
        "Adapter name must be 1 to 80 characters without control characters"
    );
    text(&definition.command, "Command", MAX_TEXT)?;
    let command = Path::new(&definition.command);
    ensure!(
        command.is_absolute()
            && command
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
        "Command must be an absolute path without '.' or '..'; ADE does not search PATH"
    );
    ensure!(
        definition.args.len() <= MAX_ARGS,
        "At most {MAX_ARGS} arguments are allowed"
    );
    for arg in &definition.args {
        text(arg, "Each argument", MAX_TEXT)?;
    }
    ensure!(
        definition.env.len() <= MAX_ENV,
        "At most {MAX_ENV} environment variables are allowed"
    );
    for (key, value) in &definition.env {
        ensure!(
            !key.is_empty()
                && key.len() <= 64
                && key.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
                && key
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "Environment names must be uppercase letters, digits or '_'"
        );
        ensure!(
            !secret_like(key),
            "Environment variable {key} looks like a credential; sign in with the agent's own login instead"
        );
        text(value, "Each environment value", MAX_TEXT)?;
    }
    match (definition.kind, &definition.executable) {
        (AdapterKind::Acp, None) => {}
        (AdapterKind::Acp, Some(_)) => bail!("ACP adapters take no executable settings"),
        (AdapterKind::Executable, None) => {
            bail!("Custom executable adapters need executable settings")
        }
        (AdapterKind::Executable, Some(settings)) => ensure!(
            (1..=3600).contains(&settings.timeout_seconds),
            "timeout_seconds must be from 1 to 3600"
        ),
    }
    Ok(())
}

/// The launch command. The daemon's environment is inherited, then the
/// definition's non-secret variables are added.
pub(crate) fn command(definition: &AdapterDefinition, cwd: &str) -> Command {
    let mut command = Command::new(&definition.command);
    command
        .args(&definition.args)
        .envs(&definition.env)
        .current_dir(cwd);
    command
}

/// What a custom executable adapter can do, before any probe.
pub fn executable_capabilities() -> Vec<String> {
    executable::CAPABILITIES
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

/// Adapters have no model, permission-mode or settings-source options yet.
pub(crate) fn ensure_default_config(config: &Config) -> Result<()> {
    ensure!(
        config.model.is_none()
            && config.permission_mode == "default"
            && config.setting_sources.is_empty(),
        "This adapter declares no model, permission-mode or settings-source options"
    );
    Ok(())
}

/// Confirms the command is an executable regular file and returns its identity.
pub fn check_executable(path: &str) -> Result<ExecutableIdentity> {
    let metadata = std::fs::metadata(path).context("The adapter's executable does not exist")?;
    ensure!(
        metadata.is_file(),
        "The adapter's command is not a regular file"
    );
    let c_path = std::ffi::CString::new(path).context("Command contains a NUL character")?;
    ensure!(
        unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } == 0,
        "The adapter's command is not executable by this user"
    );
    Ok(ExecutableIdentity {
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
        size: metadata.size(),
        modified_ms: metadata.mtime() * 1000 + metadata.mtime_nsec() / 1_000_000,
    })
}

/// Checks an adapter now. An ACP agent is launched in `cwd` and asked to
/// `initialize`, then stopped; a custom executable is inspected but not run.
pub fn probe(
    definition: &AdapterDefinition,
    cwd: &str,
) -> (Option<ExecutableIdentity>, ProbeOutcome) {
    let failed = |error: anyhow::Error| ProbeOutcome::Failed {
        error: format!("{error:#}").chars().take(512).collect(),
    };
    if let Err(error) = validate(definition) {
        return (None, failed(error));
    }
    let identity = match check_executable(&definition.command) {
        Ok(identity) => identity,
        Err(error) => return (None, failed(error)),
    };
    let outcome = match definition.kind {
        AdapterKind::Executable => ProbeOutcome::Ready {
            capabilities: executable_capabilities(),
            acp: None,
        },
        AdapterKind::Acp => {
            let (events, _receiver) = mpsc::sync_channel(64);
            match acp_session::Adapter::spawn(definition, cwd, events, PROBE_INITIALIZE_LIMIT) {
                Ok(adapter) => {
                    let handshake = adapter.handshake().clone();
                    match adapter.stop_confirmed() {
                        Ok(()) => ProbeOutcome::Ready {
                            capabilities: acp::capabilities(&handshake),
                            acp: Some(handshake),
                        },
                        Err(error) => failed(error),
                    }
                }
                Err(error) => failed(error),
            }
        }
    };
    (Some(identity), outcome)
}

/// Starts an adapter for one conversation run.
pub fn spawn(
    definition: &AdapterDefinition,
    cwd: &str,
    events: mpsc::SyncSender<Event>,
) -> Result<Arc<dyn Provider>> {
    validate(definition)?;
    Ok(match definition.kind {
        AdapterKind::Acp => {
            acp_session::Adapter::spawn(definition, cwd, events, Duration::from_secs(45))?
        }
        AdapterKind::Executable => executable::Adapter::spawn(definition, cwd, events)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::providers::adapters::{ExecutableSettings, PromptInput};

    fn definition() -> AdapterDefinition {
        serde_json::from_value(serde_json::json!({
            "id":"my-agent",
            "name":"My agent",
            "kind":"acp",
            "command":"/usr/local/bin/my-agent",
            "args":["--acp"],
            "env":{"MY_AGENT_MODE":"fast"}
        }))
        .unwrap()
    }

    #[test]
    fn a_well_formed_definition_passes() {
        validate(&definition()).unwrap();
        let mut exec = definition();
        exec.kind = AdapterKind::Executable;
        exec.executable = Some(ExecutableSettings {
            prompt_input: PromptInput::Stdin,
            timeout_seconds: 600,
        });
        validate(&exec).unwrap();
        assert_eq!(provider_id("my-agent"), "adapter:my-agent");
    }

    #[test]
    fn unknown_fields_are_refused() {
        let value = serde_json::json!({
            "id":"a","name":"A","kind":"acp","command":"/bin/a","api_key":"x"
        });
        assert!(serde_json::from_value::<AdapterDefinition>(value).is_err());
    }

    #[test]
    fn malformed_definitions_fail_closed() {
        type Change = Box<dyn Fn(&mut AdapterDefinition)>;
        let cases: Vec<(&str, Change)> = vec![
            ("id", Box::new(|d| d.id = "My_Agent".into())),
            ("id digit", Box::new(|d| d.id = "1agent".into())),
            ("name", Box::new(|d| d.name = " ".into())),
            ("relative", Box::new(|d| d.command = "my-agent".into())),
            ("dotdot", Box::new(|d| d.command = "/usr/../bin/sh".into())),
            ("nul arg", Box::new(|d| d.args = vec!["a\0b".into()])),
            (
                "env name",
                Box::new(|d| {
                    d.env.insert("lower".into(), "x".into());
                }),
            ),
            (
                "secret env",
                Box::new(|d| {
                    d.env.insert("OPENAI_API_KEY".into(), "sk".into());
                }),
            ),
            (
                "token env",
                Box::new(|d| {
                    d.env.insert("GH_TOKEN".into(), "x".into());
                }),
            ),
            (
                "acp settings",
                Box::new(|d| {
                    d.executable = Some(ExecutableSettings {
                        prompt_input: PromptInput::Argument,
                        timeout_seconds: 5,
                    })
                }),
            ),
            (
                "exec without settings",
                Box::new(|d| d.kind = AdapterKind::Executable),
            ),
            (
                "timeout",
                Box::new(|d| {
                    d.kind = AdapterKind::Executable;
                    d.executable = Some(ExecutableSettings {
                        prompt_input: PromptInput::Stdin,
                        timeout_seconds: 0,
                    })
                }),
            ),
        ];
        for (label, change) in cases {
            let mut d = definition();
            change(&mut d);
            assert!(validate(&d).is_err(), "{label} should be refused");
        }
        // Words inside a name are not credentials.
        let mut d = definition();
        d.env.insert("KEYBOARD_LAYOUT".into(), "us".into());
        d.env.insert("AUTHOR_NAME".into(), "me".into());
        validate(&d).unwrap();
    }

    #[test]
    fn adapters_accept_only_the_default_configuration() {
        ensure_default_config(&Config::default()).unwrap();
        let model = Config {
            model: Some("m".into()),
            ..Config::default()
        };
        assert!(ensure_default_config(&model).is_err());
        let mode = Config {
            permission_mode: "plan".into(),
            ..Config::default()
        };
        assert!(ensure_default_config(&mode).is_err());
    }
}
