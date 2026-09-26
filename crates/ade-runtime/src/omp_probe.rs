//! Read-only native Oh My Pi account inspection for the pinned 18.3.0 schema.
use crate::provider::account_probe::{self, Inspection};
use ade_core::model::{AccountExecution, OmpIdentity};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    io::ErrorKind,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

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
        "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // OMP also discovers global plugins and config below HOME, beyond its agent dir.
    command.env("HOME", native_home);
    command.env("PI_CODING_AGENT_DIR", native_home);
    command.env("ADE_OMP_ACCOUNT_HOME", native_home);
}

fn private_file(file: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(file)?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "Oh My Pi credential store is not a private regular file"
    );
    Ok(())
}

fn source_present(file: &Path) -> bool {
    std::fs::symlink_metadata(file).is_ok()
}

fn no_dotenv_files(directory: &Path) -> Result<()> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        ensure!(
            name != ".env" && !name.starts_with(".env."),
            "Managed Oh My Pi cannot load native .env files from {}",
            directory.display()
        );
    }
    Ok(())
}

fn no_native_overrides(home: &Path) -> Result<()> {
    // The pinned CLI accepts config.yaml as well as config.yml for broker discovery.
    for directory in [home.to_path_buf(), home.join(".omp")] {
        if source_present(&directory) {
            let metadata = std::fs::symlink_metadata(&directory)?;
            ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "Managed Oh My Pi native config root is redirected"
            );
        }
        for name in [
            "config.yml",
            "config.yaml",
            "models.yml",
            "auth-broker.token",
        ] {
            ensure!(
                !source_present(&directory.join(name)),
                "Managed Oh My Pi cannot use native auth or model overrides yet"
            );
        }
        no_dotenv_files(&directory)?;
    }
    Ok(())
}

pub fn ensure_workspace_sources(cwd: &str, account: &AccountExecution) -> Result<()> {
    no_native_overrides(Path::new(&account.native_home))?;
    let workspace = Path::new(cwd);
    no_dotenv_files(workspace)?;
    let project_config = workspace.join(".omp");
    if source_present(&project_config) {
        let metadata = std::fs::symlink_metadata(&project_config)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "Managed Oh My Pi project config root is redirected"
        );
    }
    for name in ["config.yml", "config.yaml", "models.yml"] {
        ensure!(
            !source_present(&project_config.join(name)),
            "Managed Oh My Pi cannot use project native auth or model overrides yet"
        );
    }
    Ok(())
}

fn native_bin() -> Option<(PathBuf, Option<PathBuf>)> {
    if std::env::var_os("ADE_OMP_BIN").is_some() {
        return account_probe::executable_stamp_for("ADE_OMP_BIN", "omp")
            .map(|stamp| (stamp.path, None));
    }
    let bun = account_probe::executable_stamp_for("ADE_BUN_BIN", "bun")?.path;
    let cli = ade_platform::resources::resource(
        "providers/omp/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
    );
    cli.is_file().then_some((bun, Some(cli)))
}

pub fn inspect(account: &AccountExecution) -> Inspection {
    if account.provider != "omp" {
        return result("incompatible", "Account is not Oh My Pi", None);
    }
    let Some((executable, script)) = native_bin() else {
        return result(
            "missing_executable",
            "Oh My Pi executable or Bun is unavailable",
            None,
        );
    };
    let mut args: Vec<&str> = Vec::new();
    if let Some(script) = &script {
        args.push(script.to_str().unwrap_or(""));
    }
    args.push("--version");
    let (version_ok, version_output) = match account_probe::command_output_with_timeout(
        &executable,
        &account.native_home,
        &args,
        managed_environment,
        PROBE_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(_) => {
            return result(
                "incompatible",
                "Oh My Pi version check failed or timed out",
                None,
            );
        }
    };
    let version = version_output
        .trim()
        .trim_start_matches("omp/")
        .trim_start_matches('v')
        .to_owned();
    if !version_ok || version != "18.3.0" {
        return result(
            "incompatible",
            "Oh My Pi version is outside the validated 18.3.0 release",
            Some(version),
        );
    }
    let db = Path::new(&account.native_home).join("agent.db");
    if !db.exists() {
        return result(
            "unauthenticated",
            "Oh My Pi has no native credential store in this account home",
            Some(version),
        );
    }
    if private_file(&db).is_err() {
        return result(
            "incompatible",
            "Oh My Pi native credential store is unsafe",
            Some(version),
        );
    }
    if let Err(error) = no_native_overrides(Path::new(&account.native_home)) {
        return result("incompatible", &error.to_string(), Some(version));
    }
    let bun = match account_probe::executable_stamp_for("ADE_BUN_BIN", "bun") {
        Some(stamp) => stamp.path,
        None => {
            return result(
                "missing_executable",
                "Bun is unavailable for Oh My Pi credential inspection",
                Some(version),
            );
        }
    };
    let probe = ade_platform::resources::resource("providers/omp/account-inspect.mjs");
    let probe_text = probe.to_string_lossy();
    let (ok, output) = match account_probe::command_output_with_timeout(
        &bun,
        &account.native_home,
        &[&probe_text, &account.native_home],
        managed_environment,
        PROBE_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(_) => {
            return result(
                "incompatible",
                "Oh My Pi credential inspection failed or timed out",
                Some(version),
            );
        }
    };
    if !ok {
        return result(
            "incompatible",
            "Oh My Pi native credential schema cannot be read",
            Some(version),
        );
    }
    let parsed: Value = match serde_json::from_str(&output) {
        Ok(value) => value,
        Err(_) => {
            return result(
                "incompatible",
                "Oh My Pi credential inspection returned invalid metadata",
                Some(version),
            );
        }
    };
    let state = parsed["state"].as_str().unwrap_or("incompatible");
    let reason = parsed["reason"]
        .as_str()
        .unwrap_or("Oh My Pi credential metadata is unavailable");
    if state != "ready" {
        return result(state, reason, Some(version));
    }
    let identity: OmpIdentity = match serde_json::from_value(parsed["identity"].clone()) {
        Ok(value) => value,
        Err(_) => {
            return result(
                "incompatible",
                "Oh My Pi credential identity is invalid",
                Some(version),
            );
        }
    };
    Inspection {
        state: "ready".into(),
        reason: reason.into(),
        version: Some(version),
        identity: serde_json::to_value(identity).ok(),
    }
}

pub fn ensure_identity(account: &AccountExecution) -> Result<OmpIdentity> {
    let pinned = account
        .omp_identity
        .as_ref()
        .context("Oh My Pi account identity is not pinned")?;
    let inspection = inspect(account);
    ensure!(
        inspection.state == "ready",
        "Oh My Pi account is not ready: {}",
        inspection.reason
    );
    let current: OmpIdentity = serde_json::from_value(
        inspection
            .identity
            .context("Oh My Pi identity is unavailable")?,
    )?;
    ensure!(
        &current == pinned,
        "Oh My Pi account identity changed before starting a turn"
    );
    Ok(current)
}
