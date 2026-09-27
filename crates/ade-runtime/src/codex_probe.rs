//! Bounded native Codex account readback for managed, file-backed homes.
use crate::provider::account_probe::{self, Inspection};
use ade_core::model::{AccountExecution, CodexIdentity};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    io::{ErrorKind, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(4);
const OUTPUT_LIMIT: usize = 64 * 1024;
const CONFIG: &str = "cli_auth_credentials_store = \"file\"\n";

pub fn effective_config_supported(config: &Value) -> bool {
    config["config"]["cli_auth_credentials_store"] == "file"
        && (config["config"]["model_provider"].is_null()
            || config["config"]["model_provider"] == "openai")
        && config["config"]["chatgpt_base_url"] == "https://chatgpt.com/backend-api/"
}

pub fn readback_identity(response: &Value) -> Result<CodexIdentity> {
    ensure!(
        response["account"]["type"] == "chatgpt" && response["requiresOpenaiAuth"] == true,
        "Codex account is not a supported ChatGPT workspace"
    );
    let email = response["account"]["email"]
        .as_str()
        .context("Codex account email is unavailable")?;
    let account_id = response["workspaceRouting"]["chatgptAccountId"]
        .as_str()
        .context("Codex selected workspace routing is unavailable")?;
    ensure!(
        !email.is_empty()
            && email.len() <= 320
            && email.trim() == email
            && !email.chars().any(char::is_control)
            && !account_id.is_empty()
            && account_id.len() <= 256
            && account_id.trim() == account_id
            && !account_id.chars().any(char::is_control),
        "Codex account identity fields are invalid"
    );
    Ok(CodexIdentity {
        email: email.into(),
        chatgpt_account_id: account_id.into(),
    })
}

fn result(state: &str, reason: &str, version: Option<String>) -> Inspection {
    Inspection {
        state: state.into(),
        reason: reason.into(),
        version,
        identity: None,
    }
}

pub fn managed_environment(command: &mut Command, native_home: &str, _executable: &str) {
    command.env_clear();
    for name in [
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("CODEX_HOME", native_home);
}

fn private_file(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Codex account file is redirected"
    );
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "Codex account file is not private"
    );
    Ok(())
}

fn native_config(home: &str) -> Result<()> {
    let home = Path::new(home);
    private_file(&home.join("config.toml"))?;
    ensure!(
        std::fs::read_to_string(home.join("config.toml"))? == CONFIG,
        "Codex account configuration changed"
    );
    Ok(())
}

struct Probe {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    pending: Vec<u8>,
    total: usize,
    deadline: Instant,
}

impl Drop for Probe {
    fn drop(&mut self) {
        account_probe::stop_probe(&mut self.child);
    }
}

impl Probe {
    fn start(executable: &Path, home: &str) -> Result<Self> {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--listen", "stdio://"])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        managed_environment(
            &mut command,
            home,
            executable
                .to_str()
                .context("Invalid Codex executable path")?,
        );
        let mut child = command
            .spawn()
            .context("Codex app-server could not start")?;
        let input = child
            .stdin
            .take()
            .context("Codex probe stdin unavailable")?;
        let output = child
            .stdout
            .take()
            .context("Codex probe stdout unavailable")?;
        for fd in [input.as_raw_fd(), output.as_raw_fd()] {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                account_probe::stop_probe(&mut child);
                bail!("Codex probe pipe is unavailable");
            }
        }
        Ok(Self {
            child,
            input,
            output,
            pending: Vec::new(),
            total: 0,
            deadline: Instant::now() + TIMEOUT,
        })
    }

    fn write(&mut self, value: Value) -> Result<()> {
        let bytes = format!("{value}\n").into_bytes();
        let mut written = 0;
        while written < bytes.len() {
            ensure!(
                Instant::now() < self.deadline,
                "Codex account probe timed out"
            );
            match self.input.write(&bytes[written..]) {
                Ok(0) => bail!("Codex account probe disconnected"),
                Ok(count) => written += count,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.write(json!({"id":id,"method":method,"params":params}))?;
        loop {
            ensure!(
                Instant::now() < self.deadline,
                "Codex account probe timed out"
            );
            if let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = self.pending.drain(..=end).collect();
                let message: Value =
                    serde_json::from_slice(&line).context("Codex account response is invalid")?;
                if message["id"] == id {
                    ensure!(
                        message.get("error").is_none(),
                        "Codex account request failed"
                    );
                    return message
                        .get("result")
                        .cloned()
                        .context("Codex account response omitted result");
                }
                continue;
            }
            let mut chunk = [0u8; 4096];
            match self.output.read(&mut chunk) {
                Ok(0) => bail!("Codex account probe disconnected"),
                Ok(count) => {
                    self.total += count;
                    ensure!(
                        self.total <= OUTPUT_LIMIT,
                        "Codex account response exceeded its limit"
                    );
                    self.pending.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

pub fn inspect(account: &AccountExecution) -> Inspection {
    if account.provider != "codex" {
        return result("incompatible", "Account is not Codex", None);
    }
    let Some(executable) = account_probe::executable_stamp_for("ADE_CODEX_BIN", "codex") else {
        return result(
            "missing_executable",
            "Codex executable is unavailable",
            None,
        );
    };
    let (version_ok, version_text) = match account_probe::command_output(
        &executable.path,
        &account.native_home,
        &["--version"],
        managed_environment,
    ) {
        Ok(value) => value,
        Err(_) => {
            return result(
                "unavailable",
                "Codex version check failed or timed out; retry",
                None,
            );
        }
    };
    let version = version_text
        .split_whitespace()
        .last()
        .unwrap_or("")
        .to_owned();
    if !version_ok || version != "0.157.0" {
        return result(
            "incompatible",
            "Codex version is outside the validated 0.157.0 build",
            Some(version),
        );
    }
    if native_config(&account.native_home).is_err() {
        return result(
            "incompatible",
            "Codex account file configuration is unsafe or changed",
            Some(version),
        );
    }
    if private_file(&Path::new(&account.native_home).join("auth.json")).is_err() {
        return result(
            "unauthenticated",
            "Codex file credentials are missing or unsafe",
            Some(version),
        );
    }
    let details = (|| -> Result<(Value, Value)> {
        let mut probe = Probe::start(&executable.path, &account.native_home)?;
        probe.request(
            1,
            "initialize",
            json!({"clientInfo":{"name":"ade","title":"lux-ade","version":"0.3.0"},
            "capabilities":{"experimentalApi":true}}),
        )?;
        probe.write(json!({"method":"initialized","params":{}}))?;
        let config = probe.request(2, "config/read", json!({"includeLayers":false}))?;
        let account = probe.request(3, "account/read", json!({"refreshToken":false}))?;
        Ok((config, account))
    })();
    if account_probe::executable_stamp_for("ADE_CODEX_BIN", "codex") != Some(executable) {
        return result(
            "incompatible",
            "Codex executable changed during inspection",
            Some(version),
        );
    }
    let (config, response) = match details {
        Ok(value) => value,
        Err(_) => {
            return result(
                "unavailable",
                "Codex account read failed or timed out; retry",
                Some(version),
            );
        }
    };
    if !effective_config_supported(&config) {
        return result(
            "incompatible",
            "Codex effective configuration may override file credentials",
            Some(version),
        );
    }
    if response["account"].is_null() {
        return result(
            "unauthenticated",
            "Codex is not authenticated in this account home",
            Some(version),
        );
    }
    let identity = match readback_identity(&response) {
        Ok(identity) => identity,
        Err(error) => return result("incompatible", &error.to_string(), Some(version)),
    };
    Inspection {
        state: "ready".into(),
        reason: "Codex account is ready".into(),
        version: Some(version),
        identity: Some(json!(identity)),
    }
}

pub fn verify_launch(account: &AccountExecution) -> Result<String> {
    let pinned = account
        .codex_identity
        .as_ref()
        .context("Codex account has not been verified")?;
    let executable = account_probe::executable_stamp_for("ADE_CODEX_BIN", "codex")
        .context("Codex executable is unavailable")?;
    let inspection = inspect(account);
    ensure!(
        inspection.state == "ready",
        "Codex account is not ready: {}",
        inspection.reason
    );
    ensure!(
        inspection.identity.as_ref() == Some(&json!(pinned)),
        "Codex account identity changed; verify it before launching again"
    );
    ensure!(
        account_probe::executable_stamp_for("ADE_CODEX_BIN", "codex") == Some(executable.clone()),
        "Codex executable changed during launch check"
    );
    Ok(executable.path.to_string_lossy().into_owned())
}
