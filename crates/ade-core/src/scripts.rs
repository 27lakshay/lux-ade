//! Project-defined package scripts. The manifest is configuration, never a shell
//! command supplied by an ADE request.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Script {
    pub name: String,
    pub command: String,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.'))
}

/// IDs are bound to one visible manifest script and one unguessable run nonce.
pub fn run_name(run_id: &str) -> Result<&str> {
    let body = run_id
        .strip_prefix("script_")
        .context("Invalid script run ID")?;
    let (name, suffix) = body.rsplit_once('_').context("Invalid script run ID")?;
    ensure!(
        valid_name(name)
            && suffix.len() == 36
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'),
        "Invalid script run ID"
    );
    Ok(name)
}

pub fn discover(root: &Path) -> Result<Vec<Script>> {
    let root = root.canonicalize().context("Workspace is unavailable")?;
    let manifest = root.join("package.json");
    if !manifest.exists() {
        return Ok(Vec::new());
    }
    ensure!(
        manifest.canonicalize()?.starts_with(&root),
        "Script manifest escapes its workspace"
    );
    let file = std::fs::File::open(&manifest)?;
    ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "Script manifest exceeds 1 MiB"
    );
    let package: serde_json::Value =
        serde_json::from_reader(file).context("Invalid package.json")?;
    let Some(scripts) = package.get("scripts") else {
        return Ok(Vec::new());
    };
    let scripts: BTreeMap<String, String> =
        serde_json::from_value(scripts.clone()).context("Invalid package.json scripts")?;
    ensure!(scripts.len() <= 256, "Too many workspace scripts");
    Ok(scripts
        .into_iter()
        .filter(|(name, command)| valid_name(name) && !command.is_empty())
        .map(|(name, command)| Script { name, command })
        .collect())
}
