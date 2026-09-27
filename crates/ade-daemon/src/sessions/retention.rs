//! `retention.preview` and `retention.apply` (F138), and the scheduled
//! receipt prune.
//!
//! The eligibility rules live in [`crate::retention`]. This module gathers
//! the facts they need: attachment references from the profile database,
//! unreferenced skill files, the runtime's service log directory against every
//! terminal that could own a log, and rotated diagnostic logs. Apply gathers
//! again under the session lock and removes only when the set still has the
//! preview's generation. Each removal re-checks its item's fingerprint and
//! then confirms the item is gone before reporting it removed.
use super::*;
use crate::receipts;
use crate::retention::{self as rules, Selected, Verdict};
use ade_core::contract::retention::{
    RetentionApply, RetentionApplyRequest, RetentionCandidate, RetentionItemResult, RetentionKind,
    RetentionObservedLog, RetentionOutcome, RetentionPreview, RetentionPreviewRequest,
    RetentionReceiptStore, RetentionWithheld,
};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use std::path::PathBuf;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS retention_applies(generation TEXT PRIMARY KEY, result TEXT NOT NULL, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS retention_prunes(store TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, expired INTEGER, error TEXT);";

/// The daemon stores that carry an `operations` table, by the paths
/// `Sessions::open` derives from the profile database.
fn receipt_stores(sessions: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        (
            "lifecycle",
            sessions
                .with_extension("worktrees")
                .join("lifecycle.sqlite3"),
        ),
        ("review", sessions.with_extension("review.sqlite3")),
        ("plugins", sessions.with_extension("plugins.sqlite3")),
    ]
}

fn has_table(connection: &Connection, name: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )?)
}

/// Opens another daemon store for one statement, never creating it.
fn open_existing(path: &Path, flags: OpenFlags) -> Result<Option<Connection>> {
    if !path.is_file() {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    Ok(Some(connection))
}

fn prune_connection(connection: &Connection, now: i64) -> Result<u64> {
    if !has_table(connection, "operations")? {
        return Ok(0);
    }
    Ok(receipts::prune(connection, now)? as u64)
}

fn past_retention(connection: &Connection, now: i64) -> Result<u64> {
    if !has_table(connection, "operations")? {
        return Ok(0);
    }
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM operations WHERE status!='expired' AND created_at<?1",
        [now.saturating_sub(receipts::RETENTION_MS)],
        |row| row.get(0),
    )?;
    Ok(count.max(0) as u64)
}

fn modified_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// One file's identity at gather time.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileId {
    path: PathBuf,
    ino: u64,
    len: u64,
    mtime_ns: i64,
}

impl FileId {
    fn read(path: PathBuf) -> std::io::Result<Option<Self>> {
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() {
            return Ok(None);
        }
        Ok(Some(Self {
            ino: metadata.ino(),
            len: metadata.len(),
            mtime_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
            path,
        }))
    }

    fn fingerprint(&self) -> String {
        let name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("{name}:{}:{}:{}", self.ino, self.len, self.mtime_ns)
    }
}

/// How apply removes one candidate.
enum Action {
    Attachment { conversation: String },
    SkillBlob,
    Files(Vec<FileId>),
}

struct Entry {
    selected: Selected,
    candidate: RetentionCandidate,
    action: Action,
}

struct Gathered {
    entries: Vec<Entry>,
    truncated: bool,
    generation: String,
    withheld: Vec<RetentionWithheld>,
}

/// A directory the daemon may remove files from: a real directory, not a link.
fn plain_directory(path: &Path) -> std::io::Result<Option<()>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(Some(())),
        Ok(_) => Err(std::io::Error::other("is not a plain directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn attachments(store: &Store, now: i64, entries: &mut Vec<Entry>) -> Result<Option<String>> {
    let rows: Vec<(String, String)> = store
        .connection
        .prepare("SELECT id,conversation_id FROM attachments WHERE state='live' ORDER BY id")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut unchecked = 0usize;
    for (id, conversation) in rows {
        let Ok(preview) = store.attachment_reclaim_preview(&conversation, &id) else {
            unchecked += 1;
            continue;
        };
        let facts = rules::AttachmentFacts {
            state: &preview.state,
            protected_by: &preview.protected_by,
            created_at: preview.created_at,
        };
        if let Verdict::Remove(reason) = rules::attachment(&facts, now) {
            entries.push(Entry {
                selected: Selected {
                    kind: RetentionKind::Attachment,
                    id: id.clone(),
                    fingerprint: preview.generation.clone(),
                },
                candidate: RetentionCandidate {
                    kind: RetentionKind::Attachment,
                    id,
                    scope: Some(conversation.clone()),
                    bytes: preview.payload_bytes.max(0) as u64,
                    last_activity_at: Some(preview.created_at),
                    reason: reason.into(),
                },
                action: Action::Attachment { conversation },
            });
        }
    }
    Ok((unchecked > 0)
        .then(|| format!("{unchecked} attachments failed their integrity check and were kept")))
}

fn skill_blobs(connection: &Connection, entries: &mut Vec<Entry>) -> Result<()> {
    if !has_table(connection, "skill_blobs")? || !has_table(connection, "skill_bundles")? {
        return Ok(());
    }
    let rows: Vec<(String, i64, i64, bool)> = connection
        .prepare(
            "SELECT s.content_hash,COUNT(*),COALESCE(SUM(length(s.data)),0),EXISTS(SELECT 1 FROM skill_bundles b WHERE b.content_hash=s.content_hash) FROM skill_blobs s GROUP BY s.content_hash",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (hash, files, bytes, referenced) in rows {
        if let Verdict::Remove(reason) = rules::skill_blob(referenced) {
            entries.push(Entry {
                selected: Selected {
                    kind: RetentionKind::SkillBlob,
                    id: hash.clone(),
                    fingerprint: format!("{files}:{bytes}"),
                },
                candidate: RetentionCandidate {
                    kind: RetentionKind::SkillBlob,
                    id: hash,
                    scope: None,
                    bytes: bytes.max(0) as u64,
                    last_activity_at: None,
                    reason: reason.into(),
                },
                action: Action::SkillBlob,
            });
        }
    }
    Ok(())
}

/// Every service log key a workspace terminal, script run, service record or
/// runtime terminal could still write or read.
fn owned_service_log_keys(store: &Store, runtime: &[(String, String)]) -> Result<HashSet<String>> {
    let mut owners: Vec<(String, String)> = runtime.to_vec();
    for workspace in store.catalog()?.workspaces {
        owners.push((workspace.id.clone(), workspace.terminal_id.clone()));
        for extra in &workspace.extra_terminals {
            owners.push((workspace.id.clone(), extra.clone()));
        }
    }
    for (table, query) in [
        (
            "services",
            "SELECT workspace_id,json_extract(data,'$.terminal_id') FROM services WHERE json_extract(data,'$.terminal_id') IS NOT NULL",
        ),
        (
            "terminal_creations",
            "SELECT workspace_id,terminal_id FROM terminal_creations",
        ),
    ] {
        if !has_table(&store.connection, table)? {
            continue;
        }
        let rows: Vec<(String, String)> = store
            .connection
            .prepare(query)?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        owners.extend(rows);
    }
    Ok(owners
        .iter()
        .map(|(workspace, terminal)| ade_runtime::service_logs::key(workspace, terminal))
        .collect())
}

fn service_logs(
    directory: &Path,
    owned: &HashSet<String>,
    now: i64,
    entries: &mut Vec<Entry>,
) -> std::io::Result<()> {
    if plain_directory(directory)?.is_none() {
        return Ok(());
    }
    let mut groups: BTreeMap<String, Vec<FileId>> = BTreeMap::new();
    let mut unsafe_keys = HashSet::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some((key, _)) = name.to_str().and_then(rules::service_log_file) else {
            continue;
        };
        match FileId::read(entry.path())? {
            Some(file) => groups.entry(key.to_owned()).or_default().push(file),
            // A link or special file under a runtime key: never touch the key.
            None => {
                unsafe_keys.insert(key.to_owned());
            }
        }
    }
    for (key, mut files) in groups {
        if unsafe_keys.contains(&key) {
            continue;
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let last_write_ms = files.iter().map(|file| file.mtime_ns / 1_000_000).max();
        let facts = rules::ServiceLogFacts {
            owned: owned.contains(&key),
            last_write_ms,
        };
        if let Verdict::Remove(reason) = rules::service_log(&facts, now) {
            entries.push(Entry {
                selected: Selected {
                    kind: RetentionKind::ServiceLog,
                    id: key.clone(),
                    fingerprint: files
                        .iter()
                        .map(FileId::fingerprint)
                        .collect::<Vec<_>>()
                        .join(","),
                },
                candidate: RetentionCandidate {
                    kind: RetentionKind::ServiceLog,
                    id: key,
                    scope: None,
                    bytes: files.iter().map(|file| file.len).sum(),
                    last_activity_at: last_write_ms,
                    reason: reason.into(),
                },
                action: Action::Files(files),
            });
        }
    }
    Ok(())
}

fn diagnostic_logs(directory: &Path, now: i64, entries: &mut Vec<Entry>) -> std::io::Result<()> {
    if plain_directory(directory)?.is_none() {
        return Ok(());
    }
    let mut by_process: BTreeMap<String, Vec<(String, std::fs::Metadata, PathBuf)>> =
        BTreeMap::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(process) = rules::diagnostic_log_process(&name).map(str::to_owned) else {
            continue;
        };
        let metadata = std::fs::symlink_metadata(entry.path())?;
        by_process
            .entry(process)
            .or_default()
            .push((name, metadata, entry.path()));
    }
    for (_, mut files) in by_process {
        // The appender's dated names sort by day; the last is the current file.
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let newest = files.len().saturating_sub(1);
        for (index, (name, metadata, path)) in files.into_iter().enumerate() {
            if !metadata.file_type().is_file() {
                continue;
            }
            let facts = rules::DiagnosticLogFacts {
                newest_of_process: index == newest,
                modified_ms: modified_ms(&metadata),
            };
            let Verdict::Remove(reason) = rules::diagnostic_log(&facts, now) else {
                continue;
            };
            let Some(file) = FileId::read(path)? else {
                continue;
            };
            entries.push(Entry {
                selected: Selected {
                    kind: RetentionKind::DiagnosticLog,
                    id: name.clone(),
                    fingerprint: file.fingerprint(),
                },
                candidate: RetentionCandidate {
                    kind: RetentionKind::DiagnosticLog,
                    id: name,
                    scope: None,
                    bytes: file.len,
                    last_activity_at: facts.modified_ms,
                    reason: reason.into(),
                },
                action: Action::Files(vec![file]),
            });
        }
    }
    Ok(())
}

/// Parses the runtime terminal list into (workspace ID, terminal ID) pairs.
/// Any malformed item fails the whole list, so no log is judged unowned by
/// a list the daemon could not read completely.
fn runtime_terminal_owners(catalogue: &Value) -> Result<Vec<(String, String)>> {
    catalogue["terminals"]
        .as_array()
        .context("Invalid terminal catalogue")?
        .iter()
        .map(|item| {
            let workspace = &item["workspace"];
            Ok((
                workspace["id"]
                    .as_str()
                    .context("Terminal without a workspace")?
                    .to_owned(),
                workspace["terminal_id"]
                    .as_str()
                    .context("Terminal without an ID")?
                    .to_owned(),
            ))
        })
        .collect()
}

fn remove_files(files: &[FileId]) -> Result<u64> {
    for file in files {
        let current = FileId::read(file.path.clone())
            .context("Could not read the file")?
            .context("The file is no longer a regular file")?;
        ensure!(current == *file, "The file changed since the preview");
    }
    let mut removed = 0;
    for file in files {
        std::fs::remove_file(&file.path).context("Could not remove the file")?;
        match std::fs::symlink_metadata(&file.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => bail!("A file of the same name exists after removal"),
            Err(error) => return Err(error).context("Could not confirm the removal"),
        }
        removed += file.len;
    }
    Ok(removed)
}

fn remove_skill_blob(connection: &Connection, hash: &str, fingerprint: &str) -> Result<u64> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let (files, bytes, referenced): (i64, i64, bool) = tx.query_row(
        "SELECT COUNT(*),COALESCE(SUM(length(data)),0),EXISTS(SELECT 1 FROM skill_bundles WHERE content_hash=?1) FROM skill_blobs WHERE content_hash=?1",
        [hash],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    ensure!(!referenced, "An installed skill references it again");
    ensure!(
        format!("{files}:{bytes}") == fingerprint,
        "The skill files changed since the preview"
    );
    let deleted = tx.execute(
        "DELETE FROM skill_blobs WHERE content_hash=?1 AND NOT EXISTS(SELECT 1 FROM skill_bundles WHERE content_hash=?1)",
        [hash],
    )?;
    ensure!(
        deleted as i64 == files,
        "The skill files changed during removal"
    );
    tx.commit()?;
    Ok(bytes.max(0) as u64)
}

impl Sessions {
    pub(super) fn retention_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "retention.preview" => {
                let RetentionPreviewRequest {} = decode(request)?;
                reply(&self.retention_preview()?)
            }
            "retention.apply" => {
                let apply: RetentionApplyRequest = decode(request)?;
                reply(&self.retention_apply(non_empty("generation", &apply.generation)?)?)
            }
            _ => bail!("Unknown retention operation"),
        }
    }

    /// The runtime's terminal owners, or why they were not observed.
    fn retention_runtime_owners(&self) -> std::result::Result<Vec<(String, String)>, String> {
        if self.runtime.draining() {
            return Err("the runtime is draining for a restart".into());
        }
        self.runtime
            .command(TerminalCommand::List)
            .and_then(|catalogue| runtime_terminal_owners(&catalogue))
            .map_err(|_| "the runtime terminal list could not be read".into())
    }

    fn retention_gather(
        &self,
        store: &Store,
        runtime: std::result::Result<Vec<(String, String)>, String>,
        now: i64,
    ) -> Result<Gathered> {
        let mut entries = Vec::new();
        let mut withheld = Vec::new();
        if let Some(reason) = attachments(store, now, &mut entries)? {
            withheld.push(RetentionWithheld {
                kind: RetentionKind::Attachment,
                reason,
            });
        }
        skill_blobs(&store.connection, &mut entries)?;
        match runtime {
            Ok(runtime) => {
                let owned = owned_service_log_keys(store, &runtime)?;
                let directory = self.runtime.data_directory().join("service-logs");
                if let Err(error) = service_logs(&directory, &owned, now, &mut entries) {
                    withheld.push(RetentionWithheld {
                        kind: RetentionKind::ServiceLog,
                        reason: format!("the service log directory could not be read: {error}"),
                    });
                }
            }
            Err(reason) => withheld.push(RetentionWithheld {
                kind: RetentionKind::ServiceLog,
                reason: format!("{reason}; no service log is judged unowned without it"),
            }),
        }
        if let Err(error) = diagnostic_logs(&ade_platform::resources::logs(), now, &mut entries) {
            withheld.push(RetentionWithheld {
                kind: RetentionKind::DiagnosticLog,
                reason: format!("the diagnostic log directory could not be read: {error}"),
            });
        }
        entries.sort_by(|a, b| {
            (a.selected.kind, &a.selected.id).cmp(&(b.selected.kind, &b.selected.id))
        });
        let truncated = entries.len() > rules::CANDIDATE_LIMIT;
        entries.truncate(rules::CANDIDATE_LIMIT);
        let mut selected: Vec<Selected> = entries.iter().map(|e| e.selected.clone()).collect();
        let generation = rules::generation(&mut selected, truncated);
        Ok(Gathered {
            entries,
            truncated,
            generation,
            withheld,
        })
    }

    fn retention_receipts(
        &self,
        connection: &Connection,
        now: i64,
    ) -> Result<Vec<RetentionReceiptStore>> {
        let path = connection.path().map(PathBuf::from);
        let mut stores = vec![("sessions", None)];
        if let Some(path) = &path {
            stores.extend(
                receipt_stores(path)
                    .into_iter()
                    .map(|(name, path)| (name, Some(path))),
            );
        }
        let mut report = Vec::new();
        for (name, path) in stores {
            let past = match &path {
                None => past_retention(connection, now).ok(),
                Some(path) => open_existing(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .ok()
                    .flatten()
                    .and_then(|other| past_retention(&other, now).ok()),
            };
            let last: Option<(i64, Option<i64>, Option<String>)> = connection
                .query_row(
                    "SELECT ran_at,expired,error FROM retention_prunes WHERE store=?1",
                    [name],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            report.push(RetentionReceiptStore {
                store: name.into(),
                past_retention: past,
                last_pruned_at: last.as_ref().map(|(at, _, _)| *at),
                last_expired: last
                    .as_ref()
                    .and_then(|(_, expired, _)| expired.map(|n| n.max(0) as u64)),
                last_error: last.and_then(|(_, _, error)| error),
            });
        }
        Ok(report)
    }

    fn retention_preview(&self) -> Result<RetentionPreview> {
        let runtime = self.retention_runtime_owners();
        let now = now_ms();
        let d = self.data.lock().unwrap();
        d.store.connection.execute_batch(SCHEMA)?;
        let gathered = self.retention_gather(&d.store, runtime, now)?;
        let receipts = self.retention_receipts(&d.store.connection, now)?;
        drop(d);
        let observed = |name: &str, path: PathBuf| RetentionObservedLog {
            name: name.into(),
            bytes: std::fs::metadata(path).ok().map(|m| m.len()),
            note: "appended by a running process; ADE never truncates it under its writer".into(),
        };
        let candidates: Vec<RetentionCandidate> =
            gathered.entries.into_iter().map(|e| e.candidate).collect();
        Ok(RetentionPreview {
            tag: Default::default(),
            generation: gathered.generation,
            generated_at: now,
            policy: rules::policy(),
            reclaimable_bytes: candidates.iter().map(|c| c.bytes).sum(),
            candidates,
            truncated: gathered.truncated,
            withheld: gathered.withheld,
            receipts,
            observed_logs: vec![
                observed(
                    "daemon.log",
                    ade_platform::resources::runtime_home().join("daemon.log"),
                ),
                observed(
                    "runtime.log",
                    self.runtime.data_directory().join("runtime.log"),
                ),
            ],
        })
    }

    fn retention_apply(&self, generation: &str) -> Result<RetentionApply> {
        {
            let d = self.data.lock().unwrap();
            d.store.connection.execute_batch(SCHEMA)?;
            let stored: Option<String> = d
                .store
                .connection
                .query_row(
                    "SELECT result FROM retention_applies WHERE generation=?1",
                    [generation],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(stored) = stored {
                let mut result: RetentionApply =
                    serde_json::from_str(&stored).context("Stored retention result is invalid")?;
                result.replayed = true;
                return Ok(result);
            }
        }
        let runtime = self.retention_runtime_owners();
        let now = now_ms();
        let d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        let gathered = self.retention_gather(&d.store, runtime, now)?;
        ensure!(
            gathered.generation == generation,
            "Retention candidates changed since the preview; preview again"
        );
        let mut results = Vec::with_capacity(gathered.entries.len());
        for entry in gathered.entries {
            let removed = match &entry.action {
                Action::Attachment { conversation } => d
                    .store
                    .attachment_reclaim_apply(
                        conversation,
                        &entry.selected.id,
                        &entry.selected.fingerprint,
                    )
                    .map(|(_, bytes)| bytes.max(0) as u64),
                Action::SkillBlob => remove_skill_blob(
                    &d.store.connection,
                    &entry.selected.id,
                    &entry.selected.fingerprint,
                ),
                Action::Files(files) => remove_files(files),
            };
            results.push(match removed {
                Ok(bytes) => RetentionItemResult {
                    kind: entry.selected.kind,
                    id: entry.selected.id,
                    outcome: RetentionOutcome::Removed,
                    bytes,
                    error: None,
                },
                Err(error) => RetentionItemResult {
                    kind: entry.selected.kind,
                    id: entry.selected.id,
                    outcome: RetentionOutcome::Failed,
                    bytes: 0,
                    error: Some(format!("{error:#}")),
                },
            });
        }
        let complete = results
            .iter()
            .all(|result| result.outcome == RetentionOutcome::Removed);
        let result = RetentionApply {
            tag: Default::default(),
            generation: generation.to_owned(),
            replayed: false,
            complete,
            removed_bytes: results.iter().map(|result| result.bytes).sum(),
            results,
            applied_at: now,
        };
        // Only a complete apply replays. After a partial one the set has
        // changed, so a retry must preview again and sees what is left.
        if complete {
            d.store.connection.execute(
                "INSERT OR IGNORE INTO retention_applies(generation,result,applied_at) VALUES(?1,?2,?3)",
                params![generation, serde_json::to_string(&result)?, now],
            )?;
        }
        Ok(result)
    }

    /// Prunes expired receipts in every daemon store and records the outcome
    /// per store. A store that fails is retried on the next tick.
    fn retention_prune(&self, now: i64) -> Result<()> {
        let (path, outcome) = {
            let d = self.data.lock().unwrap();
            d.store.connection.execute_batch(SCHEMA)?;
            d.store.connection.execute(
                "DELETE FROM retention_applies WHERE applied_at<?1",
                [now.saturating_sub(receipts::RETENTION_MS)],
            )?;
            (
                d.store.connection.path().map(PathBuf::from),
                prune_connection(&d.store.connection, now),
            )
        };
        let mut outcomes = vec![("sessions", outcome)];
        if let Some(path) = path {
            for (name, store) in receipt_stores(&path) {
                match open_existing(&store, OpenFlags::SQLITE_OPEN_READ_WRITE) {
                    Ok(None) => {}
                    Ok(Some(connection)) => {
                        outcomes.push((name, prune_connection(&connection, now)))
                    }
                    Err(error) => outcomes.push((name, Err(error))),
                }
            }
        }
        let d = self.data.lock().unwrap();
        for (name, outcome) in outcomes {
            let (expired, error) = match outcome {
                Ok(expired) => (Some(expired as i64), None),
                Err(error) => (None, Some(format!("{error:#}"))),
            };
            d.store.connection.execute(
                "INSERT INTO retention_prunes(store,ran_at,expired,error) VALUES(?1,?2,?3,?4) ON CONFLICT(store) DO UPDATE SET ran_at=?2,expired=?3,error=?4",
                params![name, now, expired, error],
            )?;
        }
        Ok(())
    }

    /// Starts the receipt prune schedule. It stops with the last `Sessions`.
    pub(super) fn start_retention_schedule(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let started_at = now_ms();
        std::thread::spawn(move || {
            let mut last_run = None;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                let now = now_ms();
                if !rules::prune_due(started_at, last_run, now) {
                    continue;
                }
                last_run = Some(now);
                if let Err(error) = hub.retention_prune(now) {
                    eprintln!("Receipt pruning: {error:#}");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_owners_fail_on_any_malformed_terminal() {
        let good = json!({"terminals": [{"workspace": {"id": "w", "terminal_id": "t"}}]});
        assert_eq!(
            runtime_terminal_owners(&good).unwrap(),
            vec![("w".to_owned(), "t".to_owned())]
        );
        let partial = json!({"terminals": [
            {"workspace": {"id": "w", "terminal_id": "t"}},
            {"workspace": {"id": "w"}},
        ]});
        assert!(runtime_terminal_owners(&partial).is_err());
        assert!(runtime_terminal_owners(&json!({})).is_err());
    }
}
