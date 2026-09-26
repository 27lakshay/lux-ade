//! Fresh, bounded Claude CLI identity checks. Never retain native command output.
use ade_core::model::{AccountExecution, ClaudeIdentity};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{ErrorKind, Read},
    os::{
        fd::AsRawFd,
        unix::{fs::MetadataExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Inspection {
    pub state: String,
    pub reason: String,
    pub version: Option<String>,
    pub identity: Option<Value>,
}

fn result(state: &str, reason: &str, version: Option<String>) -> Inspection {
    Inspection {
        state: state.into(),
        reason: reason.into(),
        version,
        identity: None,
    }
}

/// Environment shared by the native status probe and managed SDK sidecar.
pub fn managed_environment(command: &mut Command, native_home: &str, executable: &str) {
    command.env_clear();
    for name in [
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("CLAUDE_CONFIG_DIR", native_home);
    command.env("ANTHROPIC_CONFIG_DIR", native_home);
    command.env("ADE_CLAUDE_BIN", executable);
}

fn resolve_executable(bin_env: &str, default: &str) -> Option<PathBuf> {
    let configured = std::env::var_os(bin_env).unwrap_or_else(|| default.into());
    let candidate = PathBuf::from(&configured);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.canonicalize().ok().filter(|path| path.is_file());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(&candidate))
        .find_map(|path| path.canonicalize().ok().filter(|path| path.is_file()))
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ExecutableStamp {
    pub(crate) path: PathBuf,
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanos: i64,
}

pub(crate) fn executable_stamp_for(bin_env: &str, default: &str) -> Option<ExecutableStamp> {
    let path = resolve_executable(bin_env, default)?;
    let metadata = std::fs::metadata(&path).ok()?;
    Some(ExecutableStamp {
        path,
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanos: metadata.mtime_nsec(),
    })
}

fn executable_stamp() -> Option<ExecutableStamp> {
    executable_stamp_for("ADE_CLAUDE_BIN", "claude")
}

pub(crate) fn stop_probe(child: &mut Child) {
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    let _ = child.wait();
}

pub(crate) fn command_output(
    executable: &Path,
    native_home: &str,
    args: &[&str],
    environment: fn(&mut Command, &str, &str),
) -> Result<(bool, String)> {
    command_output_with_timeout(executable, native_home, args, environment, STATUS_TIMEOUT)
}

pub(crate) fn command_output_with_timeout(
    executable: &Path,
    native_home: &str,
    args: &[&str],
    environment: fn(&mut Command, &str, &str),
    timeout: Duration,
) -> Result<(bool, String)> {
    let executable_text = executable
        .to_str()
        .context("Invalid Claude executable path")?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    environment(&mut command, native_home, executable_text);
    let mut child = command
        .spawn()
        .context("Claude executable could not start")?;
    let deadline = Instant::now() + timeout;
    let mut output = child.stdout.take().context("Claude output unavailable")?;
    let flags = unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(output.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        stop_probe(&mut child);
        anyhow::bail!("Claude output cannot be inspected");
    }
    let mut bytes = Vec::new();
    let mut eof = false;
    let status = loop {
        let mut chunk = [0u8; 4096];
        match output.read(&mut chunk) {
            Ok(0) => eof = true,
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() as u64 > OUTPUT_LIMIT {
                    stop_probe(&mut child);
                    anyhow::bail!("Claude identity output exceeded its limit");
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => {
                stop_probe(&mut child);
                return Err(error.into());
            }
        }
        if let Some(status) = child.try_wait()?
            && eof
        {
            break status;
        }
        if Instant::now() >= deadline {
            stop_probe(&mut child);
            anyhow::bail!("Claude identity check timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = String::from_utf8(bytes).context("Claude identity output was not UTF-8")?;
    Ok((status.success(), output))
}

pub fn inspect(account: &AccountExecution) -> Inspection {
    if account.provider != "claude" {
        return result(
            "incompatible",
            "Managed account inspection is unavailable for this provider",
            None,
        );
    }
    let Some(executable) = executable_stamp() else {
        return result(
            "missing_executable",
            "Claude Code executable is unavailable",
            None,
        );
    };
    let (version_ok, version_text) = match command_output(
        &executable.path,
        &account.native_home,
        &["--version"],
        managed_environment,
    ) {
        Ok(output) => output,
        Err(_) => {
            return result(
                "incompatible",
                "Claude Code version check failed or timed out",
                None,
            );
        }
    };
    let version = version_text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_owned();
    let parts: Vec<_> = version.split('.').collect();
    let compatible = version_ok
        && parts.len() == 3
        && parts[0] == "2"
        && parts[1] == "1"
        && parts[2].parse::<u64>().is_ok_and(|patch| patch >= 283);
    if !compatible {
        return result(
            "incompatible",
            "Claude Code version is outside the validated 2.1.x range",
            Some(version),
        );
    }
    let (status_ok, status_text) = match command_output(
        &executable.path,
        &account.native_home,
        &["--setting-sources", "", "auth", "status"],
        managed_environment,
    ) {
        Ok(output) => output,
        Err(_) => {
            return result(
                "incompatible",
                "Claude Code auth status failed or timed out",
                Some(version),
            );
        }
    };
    if executable_stamp() != Some(executable) {
        return result(
            "incompatible",
            "Claude Code executable changed during inspection",
            Some(version),
        );
    }
    if !status_ok {
        return result(
            "unauthenticated",
            "Claude Code is not authenticated in this account home",
            Some(version),
        );
    }
    let parsed: Value = match serde_json::from_str(&status_text) {
        Ok(value) => value,
        Err(_) => {
            return result(
                "incompatible",
                "Claude Code auth status format is unsupported",
                Some(version),
            );
        }
    };
    if parsed["loggedIn"] == false {
        return result(
            "unauthenticated",
            "Claude Code is not authenticated in this account home",
            Some(version),
        );
    }
    let fields = (
        parsed["loggedIn"].as_bool(),
        parsed["authMethod"].as_str(),
        parsed["apiProvider"].as_str(),
        parsed["configDirectory"].as_str(),
        parsed["email"].as_str(),
        parsed["orgId"].as_str(),
    );
    let (
        Some(true),
        Some(auth_method),
        Some(api_provider),
        Some(directory),
        Some(email),
        Some(org_id),
    ) = fields
    else {
        return result(
            "incompatible",
            "Claude Code auth status is missing required identity fields",
            Some(version),
        );
    };
    if directory != account.native_home
        || auth_method != "claude.ai"
        || api_provider != "firstParty"
        || email.is_empty()
        || email.len() > 320
        || org_id.is_empty()
        || org_id.len() > 256
    {
        return result(
            "incompatible",
            "Claude Code auth status does not match a first-party account home",
            Some(version),
        );
    }
    Inspection {
        state: "ready".into(),
        reason: "Claude Code account is ready".into(),
        version: Some(version),
        identity: Some(serde_json::json!(ClaudeIdentity {
            auth_method: auth_method.into(),
            api_provider: api_provider.into(),
            email: email.into(),
            org_id: org_id.into(),
        })),
    }
}

pub fn verify_launch(account: &AccountExecution) -> Result<String> {
    let pinned = account
        .claude_identity
        .as_ref()
        .context("Claude account has not been verified")?;
    let executable = executable_stamp().context("Claude Code executable is unavailable")?;
    let inspection = inspect(account);
    ensure!(
        inspection.state == "ready",
        "Claude account is not ready: {}",
        inspection.reason
    );
    ensure!(
        inspection.identity.as_ref() == Some(&serde_json::json!(pinned)),
        "Claude account identity changed; verify it before launching again"
    );
    ensure!(
        executable_stamp() == Some(executable.clone()),
        "Claude Code executable changed during launch check"
    );
    Ok(executable.path.to_string_lossy().into_owned())
}
