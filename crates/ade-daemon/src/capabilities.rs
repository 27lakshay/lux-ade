//! Provider capability records, installation checks and profile presets
//! (F027-F029, decision D04).
//!
//! The adapters in `ade-runtime` declare what their providers offer; this
//! module seals those records with a fingerprint, checks installation by
//! resolving executables without running them, and stores presets in the
//! profile database. The `provider_presets` table lives in `sessions.sqlite`
//! and is created here idempotently. Pure decisions live in [`core`].
use ade_core::contract::providers::*;
use ade_core::error::ProviderNotFound;
use anyhow::{Context as _, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

pub mod core;

const SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS provider_presets(name TEXT PRIMARY KEY, data TEXT NOT NULL);";

/// Every adapter's sealed capability record, in catalogue order.
pub fn records() -> Vec<CapabilityRecord> {
    ade_runtime::capabilities::records()
        .into_iter()
        .map(core::seal)
        .collect()
}

/// One provider's sealed record.
pub fn record(provider: &str) -> Result<CapabilityRecord> {
    records()
        .into_iter()
        .find(|record| record.provider == provider)
        .ok_or_else(|| ProviderNotFound(provider.to_owned()).into())
}

/// Resolves the executable an override or `PATH` names, as the runtime does
/// at launch. It only reads file metadata; nothing is executed.
fn resolve(configured: OsString, search: Option<OsString>) -> Option<PathBuf> {
    let candidate = PathBuf::from(&configured);
    let executable = |path: PathBuf| {
        use std::os::unix::fs::PermissionsExt;
        let path = path.canonicalize().ok()?;
        let metadata = std::fs::metadata(&path).ok()?;
        (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then_some(path)
    };
    if candidate.is_absolute() || candidate.components().count() > 1 {
        return executable(candidate);
    }
    std::env::split_paths(&search?).find_map(|directory| executable(directory.join(&candidate)))
}

/// Checks that each executable `provider` needs can be found on this host,
/// for a launch with or without a managed account. An executable that launch
/// does not run is skipped rather than required. The daemon and runtime share
/// an environment, so this sees what a launch would, but an external update
/// can change it at any time.
pub fn installation(provider: &str, managed: bool) -> Result<Vec<ReadinessCheck>> {
    let needs = ade_runtime::capabilities::installation(provider)
        .ok_or_else(|| ProviderNotFound(provider.to_owned()))?;
    Ok(needs
        .iter()
        .map(|need| {
            let configured = std::env::var_os(need.env);
            let (state, detail) = match (configured, need.default) {
                _ if !need.used(managed) => (
                    CheckState::Skipped,
                    "Not used by this launch; the provider CLI runs directly".to_owned(),
                ),
                (None, None) => (CheckState::Skipped, "Bundled with ADE".to_owned()),
                (Some(value), _) => match resolve(value.clone(), std::env::var_os("PATH")) {
                    Some(path) => (CheckState::Passed, path.display().to_string()),
                    None => (
                        CheckState::Failed,
                        format!(
                            "{} names {}, which is not an executable file; fix or unset it",
                            need.env,
                            Path::new(&value).display()
                        ),
                    ),
                },
                (None, Some(name)) => match resolve(name.into(), std::env::var_os("PATH")) {
                    Some(path) => (CheckState::Passed, path.display().to_string()),
                    None => (
                        CheckState::Failed,
                        format!(
                            "{name} is not on PATH; install it or set {} to its full path",
                            need.env
                        ),
                    ),
                },
            };
            ReadinessCheck {
                check: need.check.into(),
                state,
                detail,
            }
        })
        .collect())
}

/// Presets stored in the profile database.
pub struct Presets {
    db: Mutex<Connection>,
}

impl Presets {
    /// Opens preset state inside the profile database at `path`.
    pub fn open(path: &Path) -> Result<Arc<Self>> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(SCHEMA)?;
        Ok(Arc::new(Self { db: Mutex::new(db) }))
    }

    pub fn list(&self) -> Result<Vec<Preset>> {
        let db = self.db.lock().unwrap();
        let mut statement = db.prepare("SELECT data FROM provider_presets ORDER BY name")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter().map(|text| decode(text)).collect()
    }

    pub fn get(&self, name: &str) -> Result<Option<Preset>> {
        let name = core::preset_name(name)?;
        let db = self.db.lock().unwrap();
        stored(&db, &name)
    }

    /// Creates or replaces a preset after validating it against `record`.
    /// Returns the stored preset and whether anything changed.
    pub fn save(
        &self,
        request: &PresetSaveRequest,
        record: &CapabilityRecord,
        now: i64,
    ) -> Result<(Preset, bool)> {
        let name = core::preset_name(&request.name)?;
        let settings = PresetSettings {
            provider: request.provider.clone(),
            model: request.model.clone(),
            reasoning: request.reasoning.clone(),
            permission_mode: request
                .permission_mode
                .clone()
                .unwrap_or_else(|| "default".into()),
        };
        let conflicts = core::validate(&settings, record);
        ensure!(
            conflicts.is_empty(),
            "{}",
            conflicts
                .iter()
                .map(|c| c.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        );
        let db = self.db.lock().unwrap();
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let existing = stored(&tx, &name)?;
        let revision = match (&existing, request.expected_revision) {
            // Saving what is already stored converges without a new revision.
            (Some(current), _) if current.settings == settings => {
                return Ok((current.clone(), false));
            }
            (None, None) => 1,
            (None, Some(_)) => {
                bail!(
                    "Preset {name} no longer exists; save it without an expected revision to create it"
                )
            }
            (Some(current), None) => bail!(
                "Preset {name} already exists at revision {}; pass it as the expected revision to replace it",
                current.revision
            ),
            (Some(current), Some(expected)) if current.revision != expected => bail!(
                "Preset {name} changed to revision {}; reload it and retry",
                current.revision
            ),
            (Some(current), Some(_)) => current.revision + 1,
        };
        let preset = Preset {
            name: name.clone(),
            settings,
            revision,
            capability_revision: record.revision,
            capability_fingerprint: record.fingerprint.clone(),
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO provider_presets(name,data) VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET data=?2",
            params![name, serde_json::to_string(&preset)?],
        )?;
        tx.commit()?;
        Ok((preset, true))
    }

    /// Deletes a preset at the revision the caller saw. Deleting an absent
    /// preset converges and reports `false`.
    pub fn delete(&self, name: &str, expected_revision: u64) -> Result<(String, bool)> {
        let name = core::preset_name(name)?;
        let db = self.db.lock().unwrap();
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let Some(current) = stored(&tx, &name)? else {
            return Ok((name, false));
        };
        ensure!(
            current.revision == expected_revision,
            "Preset {name} changed to revision {}; reload it and retry",
            current.revision
        );
        tx.execute("DELETE FROM provider_presets WHERE name=?1", [&name])?;
        tx.commit()?;
        Ok((name, true))
    }
}

fn stored(db: &Connection, name: &str) -> Result<Option<Preset>> {
    db.query_row(
        "SELECT data FROM provider_presets WHERE name=?1",
        [name],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .as_deref()
    .map(decode)
    .transpose()
}

fn decode(text: &str) -> Result<Preset> {
    serde_json::from_str(text).context("A stored preset is unreadable")
}
