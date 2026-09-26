//! Checked-in workspace recipes and root package scripts. A script request
//! names existing project configuration; it never carries an ad-hoc command.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

fn manifest_present(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Script {
    PackageJson {
        name: String,
        command: String,
    },
    AdeRecipe {
        name: String,
        program: String,
        args: Vec<String>,
        cwd: String,
    },
}
impl Script {
    pub fn name(&self) -> &str {
        match self {
            Self::PackageJson { name, .. } | Self::AdeRecipe { name, .. } => name,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeFile {
    schema_version: u32,
    scripts: BTreeMap<String, Recipe>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default = "default_cwd")]
    cwd: String,
}
fn default_cwd() -> String {
    ".".into()
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

fn load_package(root: &Path, scripts: &mut BTreeMap<String, Script>) -> Result<()> {
    let manifest = root.join("package.json");
    if !manifest_present(&manifest)? {
        return Ok(());
    }
    ensure!(
        manifest.canonicalize()?.starts_with(root),
        "Script manifest escapes its workspace"
    );
    let file = std::fs::File::open(&manifest)?;
    ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "Script manifest exceeds 1 MiB"
    );
    let package: serde_json::Value =
        serde_json::from_reader(file).context("Invalid package.json")?;
    let Some(configured) = package.get("scripts") else {
        return Ok(());
    };
    let configured: BTreeMap<String, String> =
        serde_json::from_value(configured.clone()).context("Invalid package.json scripts")?;
    ensure!(
        configured.len() <= 256,
        "Too many workspace package scripts"
    );
    for (name, command) in configured {
        if valid_name(&name) && !command.is_empty() {
            scripts.insert(name.clone(), Script::PackageJson { name, command });
        }
    }
    Ok(())
}

fn load_recipes(root: &Path, scripts: &mut BTreeMap<String, Script>) -> Result<()> {
    let manifest = root.join(".ade/scripts.json");
    if !manifest_present(&manifest)? {
        return Ok(());
    }
    ensure!(
        manifest.canonicalize()?.starts_with(root),
        "Script manifest escapes its workspace"
    );
    let file = std::fs::File::open(&manifest)?;
    ensure!(
        file.metadata()?.len() <= 64 * 1024,
        "ADE script manifest exceeds 64 KiB"
    );
    let configured: RecipeFile =
        serde_json::from_reader(file).context("Invalid ADE script manifest")?;
    ensure!(
        configured.schema_version == 1,
        "Unsupported ADE script schema version"
    );
    ensure!(
        configured.scripts.len() <= 64,
        "Too many ADE workspace scripts"
    );
    for (name, recipe) in configured.scripts {
        ensure!(valid_name(&name), "Invalid ADE script name");
        ensure!(
            !scripts.contains_key(&name),
            "Duplicate workspace script name: {name}"
        );
        ensure!(
            !recipe.program.is_empty()
                && recipe.program.len() <= 4096
                && !recipe.program.contains('\0'),
            "Invalid ADE script executable"
        );
        ensure!(
            recipe.args.len() <= 64
                && recipe
                    .args
                    .iter()
                    .all(|arg| arg.len() <= 8192 && !arg.contains('\0')),
            "Invalid ADE script arguments"
        );
        ensure!(
            !recipe.cwd.is_empty()
                && recipe.cwd.len() <= 4096
                && Path::new(&recipe.cwd)
                    .components()
                    .all(|component| matches!(component, Component::Normal(_) | Component::CurDir)),
            "ADE script directory must be workspace-relative"
        );
        let cwd = root
            .join(&recipe.cwd)
            .canonicalize()
            .context("ADE script directory is unavailable")?;
        ensure!(
            cwd.starts_with(root) && cwd.is_dir(),
            "ADE script directory escapes its workspace or is unavailable"
        );
        scripts.insert(
            name.clone(),
            Script::AdeRecipe {
                name,
                program: recipe.program,
                args: recipe.args,
                cwd: recipe.cwd,
            },
        );
    }
    Ok(())
}

pub fn discover(root: &Path) -> Result<Vec<Script>> {
    let root = root.canonicalize().context("Workspace is unavailable")?;
    let mut scripts = BTreeMap::new();
    load_package(&root, &mut scripts)?;
    load_recipes(&root, &mut scripts)?;
    Ok(scripts.into_values().collect())
}
