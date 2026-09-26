//! Resolve a workspace's declared script tools without borrowing ADE's provider runtimes.
use anyhow::{Context, Result, ensure};
use semver::{Version, VersionReq};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use crate::worktrees::run_input;

pub(crate) struct Selected {
    pub program: String,
    pub env: BTreeMap<String, String>,
    pub description: Value,
}

#[derive(Default)]
struct Declaration {
    manager: Option<String>,
    version: Option<String>,
    node_file: Option<String>,
    engines: Vec<String>,
    lock_managers: BTreeSet<String>,
}

fn read_small(path: &Path, max: u64) -> Result<String> {
    let file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= max,
        "Project toolchain file is too large: {}",
        path.display()
    );
    Ok(fs::read_to_string(path)?)
}

fn config_root(workspace: &Path) -> PathBuf {
    let mut current = workspace;
    loop {
        if current.join(".git").exists()
            || current.join("pnpm-workspace.yaml").exists()
            || current.join("lerna.json").exists()
            || fs::read_to_string(current.join("package.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .is_some_and(|value| value.get("workspaces").is_some())
        {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    workspace.to_path_buf()
}

fn declaration(workspace: &Path) -> Result<Declaration> {
    let root = config_root(workspace);
    let mut result = Declaration::default();
    let mut current = workspace.to_path_buf();
    loop {
        let package = current.join("package.json");
        if package.exists() {
            let value: Value = serde_json::from_str(&read_small(&package, 1024 * 1024)?)
                .with_context(|| format!("Invalid {}", package.display()))?;
            if let Some(spec) = value["packageManager"].as_str() {
                let (name, version) = spec
                    .rsplit_once('@')
                    .context("Invalid packageManager declaration")?;
                ensure!(
                    ["npm", "pnpm", "yarn", "bun"].contains(&name),
                    "Unsupported package manager: {name}"
                );
                let version = version.split('+').next().unwrap_or(version);
                Version::parse(version).context("packageManager needs an exact version")?;
                if let Some(previous) = &result.manager {
                    ensure!(
                        previous == name && result.version.as_deref() == Some(version),
                        "Conflicting packageManager declarations between package and workspace root"
                    );
                }
                result.manager = Some(name.into());
                result.version = Some(version.into());
            }
            if let Some(range) = value["engines"]["node"].as_str() {
                result.engines.push(range.into());
            }
        }
        for (file, manager) in [
            ("package-lock.json", "npm"),
            ("npm-shrinkwrap.json", "npm"),
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
        ] {
            if current.join(file).exists() {
                result.lock_managers.insert(manager.into());
            }
        }
        for file in [".node-version", ".nvmrc"] {
            let path = current.join(file);
            if path.exists() {
                let requested = read_small(&path, 4096)?
                    .trim()
                    .trim_start_matches('v')
                    .to_owned();
                ensure!(
                    !requested.is_empty()
                        && requested.split('.').all(
                            |part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
                        ),
                    "Unsupported Node version in {}",
                    path.display()
                );
                if let Some(previous) = &result.node_file {
                    ensure!(
                        previous == &requested,
                        "Conflicting Node version files in workspace hierarchy"
                    );
                }
                result.node_file = Some(requested);
            }
        }
        if current == root {
            break;
        }
        current = current
            .parent()
            .context("Workspace escaped its configuration root")?
            .to_path_buf();
    }
    ensure!(
        result.lock_managers.len() <= 1,
        "Conflicting package-manager lockfiles"
    );
    if let Some(manager) = &result.manager {
        ensure!(
            result.lock_managers.is_empty() || result.lock_managers.contains(manager),
            "packageManager conflicts with workspace lockfile"
        );
    } else {
        result.manager = result
            .lock_managers
            .iter()
            .next()
            .cloned()
            .or_else(|| Some("npm".into()));
    }
    Ok(result)
}

fn tool_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(value) = std::env::var_os("ADE_PROJECT_TOOL_PATHS") {
        directories.extend(std::env::split_paths(&value));
    }
    directories.extend(ade_platform::tool_paths::host_tool_dirs());
    let mut seen = BTreeSet::new();
    directories.retain(|path| path.is_dir() && seen.insert(path.clone()));
    directories
}

fn version(program: &Path, cwd: &Path, path: &str) -> Option<String> {
    let mut command = Command::new(program);
    command
        .arg("--version")
        .current_dir(cwd)
        .env("PATH", path)
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_DEFAULT_TO_LATEST", "0")
        .env("COREPACK_ENABLE_AUTO_PIN", "0");
    let result = run_input(command, 5, None, None).ok()?;
    if result["exit_code"] != 0 {
        return None;
    }
    Some(
        result["stdout"]
            .as_str()?
            .trim()
            .trim_start_matches('v')
            .to_owned(),
    )
}

fn path_with(first: &[&Path], dirs: &[PathBuf]) -> Result<String> {
    let all = first
        .iter()
        .map(|path| path.to_path_buf())
        .chain(dirs.iter().cloned());
    std::env::join_paths(all)?
        .into_string()
        .map_err(|_| anyhow::anyhow!("Project tool PATH is not UTF-8"))
}

fn matching_node(value: &str, declared: &Declaration) -> Result<bool> {
    let parsed = Version::parse(value).context("Installed Node returned an invalid version")?;
    if let Some(file) = &declared.node_file {
        let parts = file.split('.').collect::<Vec<_>>();
        let actual = [
            parsed.major.to_string(),
            parsed.minor.to_string(),
            parsed.patch.to_string(),
        ];
        if parts
            .iter()
            .zip(actual.iter())
            .any(|(expected, actual)| expected != actual)
        {
            return Ok(false);
        }
    }
    for range in &declared.engines {
        let request = VersionReq::parse(&range.split_whitespace().collect::<Vec<_>>().join(","))
            .with_context(|| format!("Unsupported engines.node range: {range}"))?;
        if !request.matches(&parsed) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn select(workspace: &Path, explicit_program: Option<&str>) -> Result<Selected> {
    let workspace = workspace
        .canonicalize()
        .context("Workspace is unavailable")?;
    let declared = declaration(&workspace)?;
    let manager = declared.manager.as_deref().unwrap_or("npm");
    let command = explicit_program.unwrap_or(manager);
    ensure!(
        ["node", "npm", "pnpm", "yarn", "bun"].contains(&command),
        "Unsupported resolved tool"
    );
    let dirs = tool_dirs();
    let node = if command == "bun" && declared.node_file.is_none() && declared.engines.is_empty() {
        None
    } else {
        let mut found = None;
        for directory in &dirs {
            let candidate = directory.join("node");
            if !candidate.is_file() || candidate.metadata()?.permissions().mode() & 0o111 == 0 {
                continue;
            }
            let path = path_with(&[directory], &dirs)?;
            if let Some(value) = version(&candidate, &workspace, &path)
                && matching_node(&value, &declared)?
            {
                found = Some((candidate, value));
                break;
            }
        }
        Some(found.context(
            "Project Node runtime is unavailable or does not satisfy its declared version",
        )?)
    };
    let mut found = None;
    for directory in &dirs {
        let candidate = directory.join(command);
        if !candidate.is_file() || candidate.metadata()?.permissions().mode() & 0o111 == 0 {
            continue;
        }
        let node_dir = node.as_ref().and_then(|(path, _)| path.parent());
        let first = node_dir
            .into_iter()
            .chain(std::iter::once(directory.as_path()))
            .collect::<Vec<_>>();
        let path = path_with(&first, &dirs)?;
        if let Some(value) = version(&candidate, &workspace, &path) {
            let expected = if command == manager {
                declared.version.as_deref()
            } else {
                None
            };
            if expected.is_none_or(|expected| expected == value) {
                found = Some((candidate, value, path));
                break;
            }
        }
    }
    let (program, value, path) = found.with_context(|| format!("Project {command} executable is unavailable or its version differs from the workspace declaration"))?;
    let mut env = BTreeMap::new();
    env.insert("PATH".into(), path);
    env.insert("COREPACK_ENABLE_NETWORK".into(), "0".into());
    env.insert("COREPACK_DEFAULT_TO_LATEST".into(), "0".into());
    env.insert("COREPACK_ENABLE_AUTO_PIN".into(), "0".into());
    Ok(Selected {
        program: program.to_string_lossy().into_owned(),
        env,
        description: serde_json::json!({"manager":manager,"manager_version":declared.version,
            "program":program,"version":value,"node":node.as_ref().map(|(path, value)|
                serde_json::json!({"program":path,"version":value}))}),
    })
}
