//! Development mode, activation generations and provider leases (F139,
//! F060, 04-S11).
//!
//! In development mode a watcher thread scans the plugin's local source
//! directory. When the scan changes and then stays quiet for the debounce,
//! the watcher copies the tree into staging exactly as `plugin.install`
//! does. A copy that raced a write is discarded and waits for the next quiet
//! period. A copy whose digest matches the installed artifact changes
//! nothing. Otherwise the reload places the new artifact, records the next
//! generation durably, and only then makes it current in the registry. The
//! old generation's leftover registrations are removed through its own
//! activation, so this late cleanup never touches the new one.
//!
//! Outside the registry lock, the old backend host drains: its open calls
//! finish, within a bound, before its `deactivate` runs and its process
//! group is killed. The new host starts at once, so a broken reload shows up
//! as the reload's message and in `plugin.host.status`.
//!
//! Every activation writes a row to `plugin_generations`. A superseded
//! generation stays until nothing holds it: a draining host or a provider
//! lease. A provider session leases the generation that was current when it
//! started and keeps it, and its artifact, until the session ends. A reload
//! may not raise the data schema while any provider session holds a lease.
//! Artifact directories that no held generation references are removed.
use super::dev::{self, SchemaChange, Settle, Tick};
use super::*;
use ade_core::contract::plugins::{
    PluginDevEnterRequest, PluginDevLeaveRequest, PluginDevMode, PluginGeneration,
    PluginGenerationListRequest, PluginGenerationState, PluginGenerations, PluginReload,
    PluginReloadStatus, PluginSource,
};
use std::sync::Weak;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS plugin_dev(
  plugin_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, debounce_ms INTEGER NOT NULL,
  entered_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_generations(
  plugin_id TEXT NOT NULL, generation INTEGER NOT NULL, version TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, artifact_path TEXT NOT NULL, origin TEXT NOT NULL,
  activated_at INTEGER NOT NULL, superseded_at INTEGER, retired_at INTEGER,
  PRIMARY KEY(plugin_id, generation));
CREATE TABLE IF NOT EXISTS plugin_provider_leases(
  plugin_id TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
  leased_at INTEGER NOT NULL, PRIMARY KEY(plugin_id, session_id));
";

/// How often a watcher scans its source.
const POLL: Duration = Duration::from_millis(250);
/// Retired generations kept per plugin for inspection.
const RETIRED_KEPT: i64 = 20;
const MAX_SESSION_ID: usize = 256;

/// One development-mode watcher. Its thread ends once `stop` is set.
pub(super) struct Watch {
    stop: AtomicBool,
    debounce_ms: AtomicU32,
    status: Mutex<WatchStatus>,
}

#[derive(Default)]
struct WatchStatus {
    last_change_at: Option<i64>,
    reload_due_at: Option<i64>,
    last_reload: Option<PluginReload>,
    watch_error: Option<String>,
}

/// What one reload attempt did.
enum Outcome {
    Activated {
        generation: u64,
        host_error: Option<String>,
    },
    Unchanged,
    Refused(String),
    Failed(String),
    /// The source changed while it was copied; the next scan sees it.
    Moving,
}

/// A committed reload whose hosts still need switching.
struct Committed {
    new: u64,
    has_backend: bool,
}

fn origin_name(origin: PluginGenerationOrigin) -> &'static str {
    match origin {
        PluginGenerationOrigin::Enable => "enable",
        PluginGenerationOrigin::Restore => "restore",
        PluginGenerationOrigin::DevReload => "dev_reload",
    }
}

fn parse_origin(name: &str) -> Result<PluginGenerationOrigin> {
    Ok(match name {
        "enable" => PluginGenerationOrigin::Enable,
        "restore" => PluginGenerationOrigin::Restore,
        "dev_reload" => PluginGenerationOrigin::DevReload,
        other => return Err(anyhow!("Stored generation origin {other} is unknown")),
    })
}

/// Records that `generation` activated `detail`'s artifact.
pub(super) fn record_generation(
    db: &Connection,
    id: &str,
    generation: u64,
    detail: &PluginDetail,
    origin: PluginGenerationOrigin,
    now: i64,
) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO plugin_generations(plugin_id,generation,version,artifact_digest,
           artifact_path,origin,activated_at,superseded_at,retired_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,NULL)",
        params![
            id,
            generation as i64,
            detail.summary.version,
            detail.artifact_digest,
            detail.artifact_path,
            origin_name(origin),
            now
        ],
    )?;
    Ok(())
}

/// Provider leases held on the plugin, by generation.
fn leases_by_generation(db: &Connection, id: &str) -> Result<HashMap<u64, u32>> {
    Ok(db
        .prepare(
            "SELECT generation,COUNT(*) FROM plugin_provider_leases WHERE plugin_id=?1 GROUP BY generation",
        )?
        .query_map([id], |row| {
            Ok((row.get::<_, i64>(0)?.max(0) as u64, row.get::<_, u32>(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Provider leases held on any generation of the plugin.
/// The provider sessions that lease any generation of plugin `id`.
pub(super) fn leased_sessions(db: &Connection, id: &str) -> Result<Vec<String>> {
    let mut statement = db.prepare(
        "SELECT session_id FROM plugin_provider_leases WHERE plugin_id=?1 ORDER BY session_id",
    )?;
    let rows = statement.query_map([id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn lease_count(db: &Connection, id: &str) -> Result<u32> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM plugin_provider_leases WHERE plugin_id=?1",
        [id],
        |row| row.get(0),
    )?)
}

fn not_enabled(id: &str) -> Coded {
    coded("invalid_request", format!("Plugin {id} is not enabled"))
}

impl Core {
    /// After open: settles every plugin's generations and resumes the
    /// watchers of plugins still live in development mode. A plugin whose
    /// activation failed leaves development mode.
    pub(super) fn resume(self: &Arc<Self>) -> Result<()> {
        let state = &mut *self.state.lock().unwrap();
        let ids: Vec<String> = state
            .db
            .prepare("SELECT id FROM plugins ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in &ids {
            self.settle(state, id, &HashSet::new())?;
        }
        let dev: Vec<(String, String, u32)> = state
            .db
            .prepare("SELECT plugin_id,source_path,debounce_ms FROM plugin_dev ORDER BY plugin_id")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, source, debounce) in dev {
            if state.live.contains_key(&id) {
                self.watch(&id, &source, debounce);
            } else {
                state
                    .db
                    .execute("DELETE FROM plugin_dev WHERE plugin_id=?1", [&id])?;
            }
        }
        Ok(())
    }

    pub(super) fn dev_enter(self: &Arc<Self>, request: PluginDevEnterRequest) -> Result<Value> {
        let debounce = dev::debounce_ms(request.debounce_ms)
            .map_err(|message| coded("invalid_request", message))?;
        let id = &request.plugin_id;
        {
            let state = self.state.lock().unwrap();
            let plugin = installed(&state, id)?;
            let source = &plugin.detail.summary.source;
            ensure!(
                source.kind == PluginSourceKind::Local,
                coded(
                    "invalid_request",
                    format!(
                        "Plugin {id} was installed from a {} source; development mode needs a local directory",
                        source_kind(source.kind)
                    )
                )
            );
            ensure!(state.live.contains_key(id), not_enabled(id));
            state.db.execute(
                "INSERT INTO plugin_dev(plugin_id,source_path,debounce_ms,entered_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(plugin_id) DO UPDATE SET source_path=excluded.source_path,
                   debounce_ms=excluded.debounce_ms",
                params![id, source.locator, debounce, now_ms()],
            )?;
            // Under the registry lock, so a concurrent disable cannot leave a
            // watcher behind.
            self.watch(id, &source.locator, debounce);
        }
        self.generation_list(PluginGenerationListRequest {
            plugin_id: request.plugin_id,
        })
    }

    pub(super) fn dev_leave(&self, request: PluginDevLeaveRequest) -> Result<Value> {
        {
            let state = self.state.lock().unwrap();
            installed(&state, &request.plugin_id)?;
            self.end_dev(&state, &request.plugin_id)?;
        }
        self.generation_list(PluginGenerationListRequest {
            plugin_id: request.plugin_id,
        })
    }

    /// Leaves development mode. The caller holds the registry lock.
    pub(super) fn end_dev(&self, state: &State, id: &str) -> Result<()> {
        state
            .db
            .execute("DELETE FROM plugin_dev WHERE plugin_id=?1", [id])?;
        if let Some(watch) = self.watches.lock().unwrap().remove(id) {
            watch.stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Starts a watcher, or retunes the running one. The caller holds the
    /// registry lock.
    fn watch(self: &Arc<Self>, id: &str, source: &str, debounce_ms: u32) {
        let mut watches = self.watches.lock().unwrap();
        if let Some(watch) = watches.get(id) {
            watch.debounce_ms.store(debounce_ms, Ordering::SeqCst);
            return;
        }
        let watch = Arc::new(Watch {
            stop: AtomicBool::new(false),
            debounce_ms: AtomicU32::new(debounce_ms),
            status: Mutex::new(WatchStatus::default()),
        });
        watches.insert(id.to_owned(), watch.clone());
        let core = Arc::downgrade(self);
        let id = id.to_owned();
        let source = PathBuf::from(source);
        std::thread::spawn(move || run_watch(core, id, source, watch));
    }

    /// One reload attempt, serialized with every other reload.
    fn reload(&self, id: &str, source: &Path, before: &str, watch: &Watch) -> Outcome {
        let _serial = self.reloads.lock().unwrap();
        let staged = match artifact::stage(
            &PluginSource::Local {
                path: source.to_string_lossy().into_owned(),
            },
            &self.staging,
        ) {
            Ok(staged) => staged,
            Err(error) => return Outcome::Failed(format!("{error:#}")),
        };
        let committed = match dev::fingerprint(source) {
            Ok(after) if dev::copy_is_consistent(before, &after) => {
                self.commit_reload(id, &staged, watch)
            }
            _ => Err(Outcome::Moving),
        };
        artifact::discard(&staged.staging);
        let committed = match committed {
            Ok(committed) => committed,
            Err(outcome) => return outcome,
        };
        self.activation_changed.store(true, Ordering::SeqCst);
        // The old host finishes its calls on a drain thread; the new one
        // starts now so a broken reload is visible at once.
        let host_error = committed
            .has_backend
            .then(|| {
                self.launch_spec(id)
                    .map_err(|error| format!("{error:#}"))
                    .and_then(|spec| self.hosts.ensure(&spec))
                    .err()
            })
            .flatten();
        let mut state = self.state.lock().unwrap();
        let draining = self.hosts.draining(id);
        if let Err(error) = self.settle(&mut state, id, &draining) {
            tracing::warn!(target: "ade", event = "plugin_generation_settle_failed", error = %error);
        }
        Outcome::Activated {
            generation: committed.new,
            host_error,
        }
    }

    /// Validates the staged tree and makes it the next generation, or
    /// explains why the current generation keeps running.
    fn commit_reload(
        &self,
        id: &str,
        staged: &artifact::Staged,
        watch: &Watch,
    ) -> Result<Committed, Outcome> {
        let failed = |error: anyhow::Error| Outcome::Failed(format!("{error:#}"));
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        if watch.stop.load(Ordering::SeqCst) {
            return Err(Outcome::Refused(
                "Development mode ended before the reload committed".into(),
            ));
        }
        let Some(live) = state.live.get(id).cloned() else {
            return Err(Outcome::Refused(format!("Plugin {id} is not enabled")));
        };
        let plugin = installed(state, id).map_err(failed)?;
        let manifest = manifest::read(&staged.manifest_bytes().map_err(failed)?, &staged.files)
            .map_err(Outcome::Failed)?;
        if manifest.id != id {
            return Err(Outcome::Refused(format!(
                "The source now declares plugin {}, not {id}; install it as a separate plugin",
                manifest.id
            )));
        }
        if staged.digest == plugin.detail.artifact_digest {
            return Err(Outcome::Unchanged);
        }
        let leases = lease_count(&state.db, id).map_err(failed)?;
        let schema = match dev::reload_schema(
            plugin.detail.summary.stored_data_schema,
            manifest.data_schema,
            leases,
        ) {
            SchemaChange::Accept(schema) => schema,
            SchemaChange::Refuse(message) => return Err(Outcome::Refused(message)),
        };
        let registrations = contributions(&manifest);
        let generation = plugin.detail.summary.activation_generation + 1;
        if let Some(error) = state.registry.refusal(id, generation, &registrations) {
            return Err(Outcome::Refused(format!(
                "{error}; the current generation keeps running"
            )));
        }
        let path =
            artifact::place(staged, &self.artifacts, id, &manifest.version).map_err(failed)?;
        let now = now_ms();
        let mut detail = plugin.detail;
        detail.summary.version = manifest.version.clone();
        detail.artifact_digest = staged.digest.clone();
        detail.artifact_path = path.to_string_lossy().into_owned();
        let written = (|| -> Result<()> {
            let tx = state.db.transaction()?;
            tx.execute(
                "UPDATE plugins SET name=?2,version=?3,source_pin=?4,artifact_digest=?5,
                   artifact_path=?6,manifest=?7,updated_at=?8 WHERE id=?1",
                params![
                    id,
                    manifest.name,
                    manifest.version,
                    staged.pin.pin,
                    detail.artifact_digest,
                    detail.artifact_path,
                    serde_json::to_string(&manifest)?,
                    now
                ],
            )?;
            tx.execute(
                "UPDATE plugin_state SET activation_generation=?2,stored_data_schema=?3 WHERE plugin_id=?1",
                params![id, generation as i64, schema],
            )?;
            record_generation(
                &tx,
                id,
                generation,
                &detail,
                PluginGenerationOrigin::DevReload,
                now,
            )?;
            tx.commit()?;
            Ok(())
        })();
        // A failed write leaves the placed directory unreferenced; the next
        // settle removes it.
        written.map_err(failed)?;
        let activation = state
            .registry
            .activate_all(id, generation, &registrations)
            .map_err(|error| {
                Outcome::Failed(format!(
                    "{error}; generation {generation} was recorded but not activated"
                ))
            })?;
        // Late cleanup of the old generation removes only what it still owns.
        state.registry.deactivate(&live.activation);
        state.live.insert(
            id.to_owned(),
            Live {
                activation,
                activated_at: now,
            },
        );
        // Publish the drain while the registry still protects the generation change.
        // Otherwise a concurrent generation query can retire its live artifact.
        self.hosts.supersede(id, live.activation.generation);
        Ok(Committed {
            new: generation,
            has_backend: manifest.entry_points.backend.is_some(),
        })
    }

    /// Records superseded and retired generations, forgets old retired ones
    /// and removes artifact directories no held generation references. The
    /// caller holds the registry lock and passes the draining generations.
    pub(super) fn settle(
        &self,
        state: &mut State,
        id: &str,
        draining: &HashSet<u64>,
    ) -> Result<()> {
        let current = state.live.get(id).map(|live| live.activation.generation);
        let leases = leases_by_generation(&state.db, id)?;
        let open: Vec<i64> = state
            .db
            .prepare(
                "SELECT generation FROM plugin_generations WHERE plugin_id=?1 AND retired_at IS NULL",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let now = now_ms();
        let tx = state.db.transaction()?;
        for generation in open {
            let number = generation.max(0) as u64;
            let is_current = current == Some(number);
            if !is_current {
                tx.execute(
                    "UPDATE plugin_generations SET superseded_at=COALESCE(superseded_at,?3)
                     WHERE plugin_id=?1 AND generation=?2",
                    params![id, generation, now],
                )?;
            }
            let held = leases.get(&number).copied().unwrap_or(0);
            if dev::settle(is_current, draining.contains(&number), held) == Settle::Retire {
                tx.execute(
                    "UPDATE plugin_generations SET retired_at=?3 WHERE plugin_id=?1 AND generation=?2",
                    params![id, generation, now],
                )?;
            }
        }
        tx.execute(
            "DELETE FROM plugin_generations WHERE plugin_id=?1 AND retired_at IS NOT NULL
               AND generation NOT IN (SELECT generation FROM plugin_generations
                 WHERE plugin_id=?1 AND retired_at IS NOT NULL ORDER BY generation DESC LIMIT ?2)",
            params![id, RETIRED_KEPT],
        )?;
        tx.commit()?;
        self.collect_versions(&state.db, id)
    }

    /// Removes the plugin's artifact directories that neither the installed
    /// row nor a held generation references. Directories are compared by
    /// name, so a moved profile never loses a referenced artifact.
    fn collect_versions(&self, db: &Connection, id: &str) -> Result<()> {
        let parent = self.artifacts.join(id);
        if !parent.is_dir() {
            return Ok(());
        }
        let keep: HashSet<std::ffi::OsString> = db
            .prepare(
                "SELECT artifact_path FROM plugins WHERE id=?1
                 UNION SELECT artifact_path FROM plugin_generations WHERE plugin_id=?1 AND retired_at IS NULL",
            )?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|path| Path::new(&path).file_name().map(ToOwned::to_owned))
            .collect();
        for entry in fs::read_dir(&parent)? {
            let entry = entry?;
            if !keep.contains(&entry.file_name())
                && let Err(error) = fs::remove_dir_all(entry.path())
            {
                tracing::warn!(target: "ade", event = "plugin_artifact_remove_failed", error = %error);
            }
        }
        Ok(())
    }

    pub(super) fn generation_list(&self, request: PluginGenerationListRequest) -> Result<Value> {
        let id = &request.plugin_id;
        let mut state = self.state.lock().unwrap();
        let draining = self.hosts.draining(id);
        installed(&state, id)?;
        self.settle(&mut state, id, &draining)?;
        let current = state.live.get(id).map(|live| live.activation.generation);
        let leases = leases_by_generation(&state.db, id)?;
        let generations = state
            .db
            .prepare(
                "SELECT generation,version,artifact_digest,origin,activated_at,superseded_at,retired_at
                 FROM plugin_generations WHERE plugin_id=?1 ORDER BY generation DESC",
            )?
            .query_map([id], |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(
                |(generation, version, digest, origin, activated_at, superseded_at, retired_at)| {
                    let held = leases.get(&generation).copied().unwrap_or(0);
                    let state = match retired_at {
                        Some(_) => PluginGenerationState::Retired,
                        None => match dev::settle(
                            current == Some(generation),
                            draining.contains(&generation),
                            held,
                        ) {
                            Settle::Current => PluginGenerationState::Current,
                            Settle::Draining => PluginGenerationState::Draining,
                            Settle::Leased => PluginGenerationState::Leased,
                            Settle::Retire => PluginGenerationState::Retired,
                        },
                    };
                    Ok(PluginGeneration {
                        generation,
                        version,
                        artifact_digest: digest,
                        origin: parse_origin(&origin)?,
                        state,
                        activated_at,
                        superseded_at,
                        retired_at,
                        provider_leases: held,
                    })
                },
            )
            .collect::<Result<_>>()?;
        let dev = state
            .db
            .query_row(
                "SELECT source_path,debounce_ms,entered_at FROM plugin_dev WHERE plugin_id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(source_path, debounce_ms, entered_at)| {
                let watch = self.watches.lock().unwrap().get(id).cloned();
                let status = watch.as_ref().map(|watch| watch.status.lock().unwrap());
                PluginDevMode {
                    source_path,
                    debounce_ms,
                    entered_at,
                    watching: watch.is_some(),
                    last_change_at: status.as_ref().and_then(|s| s.last_change_at),
                    reload_due_at: status.as_ref().and_then(|s| s.reload_due_at),
                    last_reload: status.as_ref().and_then(|s| s.last_reload.clone()),
                    watch_error: status.as_ref().and_then(|s| s.watch_error.clone()),
                }
            });
        reply(&PluginGenerations {
            tag: Default::default(),
            plugin_id: request.plugin_id,
            dev,
            generations,
        })
    }
}

/// The watcher loop: scan, debounce, reload. It holds only a weak reference
/// to the registry between scans, so it ends with the registry.
fn run_watch(core: Weak<Core>, id: String, source: PathBuf, watch: Arc<Watch>) {
    let mut debounce = dev::Debounce::default();
    // No baseline yet: the first scan counts as a change, so entering
    // development mode picks up edits made before it.
    let mut last: Option<String> = None;
    loop {
        std::thread::sleep(POLL);
        if watch.stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(core) = core.upgrade() else {
            break;
        };
        let now = now_ms();
        let scan = dev::fingerprint(&source);
        let mut status = watch.status.lock().unwrap();
        let fingerprint = match scan {
            Ok(fingerprint) => {
                status.watch_error = None;
                fingerprint
            }
            Err(error) => {
                status.watch_error = Some(error);
                continue;
            }
        };
        let changed = last.as_deref() != Some(fingerprint.as_str());
        if changed && last.is_some() {
            status.last_change_at = Some(now);
        }
        last = Some(fingerprint.clone());
        let quiet = i64::from(watch.debounce_ms.load(Ordering::SeqCst));
        match debounce.observe(changed, now, quiet, dev::MAX_WAIT_MS) {
            Tick::Idle => status.reload_due_at = None,
            Tick::Waiting { due_at } => status.reload_due_at = Some(due_at),
            Tick::Fire => {
                status.reload_due_at = None;
                drop(status);
                let outcome = core.reload(&id, &source, &fingerprint, &watch);
                let (status, generation, message) = match outcome {
                    Outcome::Activated {
                        generation,
                        host_error,
                    } => (PluginReloadStatus::Activated, Some(generation), host_error),
                    Outcome::Unchanged => (PluginReloadStatus::Unchanged, None, None),
                    Outcome::Refused(message) => (PluginReloadStatus::Refused, None, Some(message)),
                    Outcome::Failed(message) => (PluginReloadStatus::Failed, None, Some(message)),
                    Outcome::Moving => continue,
                };
                if status != PluginReloadStatus::Unchanged {
                    tracing::info!(target: "ade", event = "plugin_dev_reload", status = ?status);
                }
                watch.status.lock().unwrap().last_reload = Some(PluginReload {
                    at: now_ms(),
                    status,
                    generation,
                    message,
                });
            }
        }
    }
}

impl Plugins {
    /// Leases the plugin's current generation to a provider session, or
    /// returns the lease the session already holds. The session keeps that
    /// generation and its artifact until [`Plugins::release_provider`], even
    /// across reloads and daemon restarts.
    pub fn lease_provider(&self, plugin_id: &str, session_id: &str) -> Result<ProviderWorker> {
        ensure!(
            (1..=MAX_SESSION_ID).contains(&session_id.len()),
            coded("invalid_request", "session_id must be 1 to 256 bytes")
        );
        let state = self.0.state.lock().unwrap();
        let plugin = installed(&state, plugin_id)?;
        let entry = plugin
            .detail
            .manifest
            .entry_points
            .provider
            .clone()
            .ok_or_else(|| {
                coded(
                    "invalid_request",
                    format!("Plugin {plugin_id} declares no provider entry point"),
                )
            })?;
        let worker =
            |generation: i64, version, artifact_digest, artifact_path, entry| ProviderWorker {
                provider: ade_runtime::provider::registry::plugin_provider_id(plugin_id),
                pin: ProviderWorkerPin {
                    plugin_id: plugin_id.to_owned(),
                    version,
                    artifact_digest,
                    activation_generation: generation.max(0) as u64,
                },
                artifact_path,
                entry,
            };
        let held: Option<(i64, String, String, String)> = state
            .db
            .query_row(
                "SELECT l.generation,g.version,g.artifact_digest,g.artifact_path FROM plugin_provider_leases l
                 JOIN plugin_generations g ON g.plugin_id=l.plugin_id AND g.generation=l.generation
                 WHERE l.plugin_id=?1 AND l.session_id=?2",
                params![plugin_id, session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((generation, version, digest, artifact_path)) = held {
            // The leased generation's own manifest decides its entry; the
            // installed one may be newer.
            let entry = artifact_entry(Path::new(&artifact_path)).unwrap_or(entry);
            return Ok(worker(generation, version, digest, artifact_path, entry));
        }
        let live = state
            .live
            .get(plugin_id)
            .ok_or_else(|| not_enabled(plugin_id))?;
        let generation = live.activation.generation as i64;
        state.db.execute(
            "INSERT INTO plugin_provider_leases(plugin_id,session_id,generation,leased_at) VALUES(?1,?2,?3,?4)",
            params![plugin_id, session_id, generation, now_ms()],
        )?;
        Ok(worker(
            generation,
            plugin.detail.summary.version,
            plugin.detail.artifact_digest,
            plugin.detail.artifact_path,
            entry,
        ))
    }

    /// Ends a provider session's lease. Returns whether it held one. A
    /// superseded generation that nothing else holds retires.
    pub fn release_provider(&self, plugin_id: &str, session_id: &str) -> Result<bool> {
        let mut state = self.0.state.lock().unwrap();
        let draining = self.0.hosts.draining(plugin_id);
        let released = state.db.execute(
            "DELETE FROM plugin_provider_leases WHERE plugin_id=?1 AND session_id=?2",
            params![plugin_id, session_id],
        )? > 0;
        if released && installed(&state, plugin_id).is_ok() {
            self.0.settle(&mut state, plugin_id, &draining)?;
        }
        Ok(released)
    }
}

/// The provider entry point in an installed artifact's own manifest.
fn artifact_entry(artifact: &Path) -> Option<String> {
    let bytes = fs::read(artifact.join(ade_core::contract::plugins::MANIFEST_FILE)).ok()?;
    serde_json::from_slice::<PluginManifest>(&bytes)
        .ok()?
        .entry_points
        .provider
}
