//! Read-only gathering for `diagnostics.status` and `diagnostics.export`.
//!
//! Every read here opens its own read-only SQLite connection, so a report
//! never takes a store's writer lock and never creates tables. A store that
//! cannot be read is reported as unavailable, never as empty.

pub mod processes;
pub mod redact;

use crate::receipts::{self, Status};
use ade_core::contract::daemon::{
    DiagnosticLogs, DiagnosticReceipts, DiagnosticService, DiagnosticTerminal, DiagnosticUnknown,
    DiagnosticUnknownSource,
};
use ade_core::contract::terminals::runtime::Terminal;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

/// Most unknown executions one report lists.
pub const UNKNOWN_LIMIT: usize = 100;
/// Most services one report lists.
pub const SERVICE_LIMIT: usize = 200;
/// The log budgets `ade_platform::diagnostics::init` enforces.
pub const LOG_FILES_PER_PROCESS: u64 = 7;
pub const LOG_DAILY_BYTES: u64 = 8 * 1024 * 1024;
/// Bytes read from the end of each log file when collecting recent events.
const LOG_TAIL_BYTES: u64 = 256 * 1024;
/// Newest log files read when collecting recent events.
const LOG_FILES_READ: usize = 16;

/// The profile daemon's databases, by the names `Sessions::open` gives them.
pub struct Stores {
    pub sessions: PathBuf,
    /// Every other store that carries effect receipts, by report name.
    pub receipts: Vec<(&'static str, PathBuf)>,
}

impl Stores {
    pub fn in_directory(directory: &Path) -> Self {
        let sessions = directory.join("sessions.sqlite");
        Self {
            receipts: receipts::side_stores(&sessions),
            sessions,
        }
    }
}

/// Opens a database for reading only. `None` when it is absent or unreadable.
pub fn read_only(path: &Path) -> Option<Connection> {
    if !path.is_file() {
        return None;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection.busy_timeout(Duration::from_secs(1)).ok()?;
    Some(connection)
}

/// One `GROUP BY status` row of an `operations` table: the status, its row
/// count, its oldest creation time and how many rows are past retention.
pub type StatusGroup = (String, u64, Option<i64>, u64);

/// Folds status groups into one store's tally. Expired rows count as expired
/// only; they are neither past retention nor the oldest live receipt.
pub fn tally(store: &str, groups: &[StatusGroup]) -> DiagnosticReceipts {
    let mut tally = DiagnosticReceipts {
        store: store.into(),
        available: true,
        ..DiagnosticReceipts::default()
    };
    for (status, count, oldest, past) in groups {
        if status == "expired" {
            tally.expired += count;
            continue;
        }
        match Status::parse(status) {
            Ok(Status::Accepted) => tally.accepted += count,
            Ok(Status::Dispatched) => tally.dispatched += count,
            Ok(Status::Acknowledged) => tally.acknowledged += count,
            Ok(Status::Settled) => tally.settled += count,
            Ok(Status::Unknown) => tally.unknown += count,
            Err(_) => tally.other += count,
        }
        tally.past_retention += past;
        tally.oldest_created_at = match (tally.oldest_created_at, oldest) {
            (Some(a), Some(b)) => Some(a.min(*b)),
            (a, b) => a.or(*b),
        };
    }
    tally
}

/// An unavailable store's tally: zero counts with `available` false.
pub fn unavailable_tally(store: &str) -> DiagnosticReceipts {
    DiagnosticReceipts {
        store: store.into(),
        ..DiagnosticReceipts::default()
    }
}

/// Counts one database's receipts and lists its unknown ones, newest first.
pub fn receipts(
    connection: &Connection,
    store: &str,
    now: i64,
) -> Result<(DiagnosticReceipts, Vec<DiagnosticUnknown>)> {
    let cutoff = now.saturating_sub(receipts::RETENTION_MS);
    let groups: Vec<StatusGroup> = connection
        .prepare(
            "SELECT status, COUNT(*), MIN(created_at), SUM(created_at < ?1) FROM operations GROUP BY status",
        )?
        .query_map([cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let unknown = connection
        .prepare(
            "SELECT id, op, updated_at FROM operations WHERE status = ?1 ORDER BY updated_at DESC LIMIT ?2",
        )?
        .query_map(
            params![Status::Unknown.as_str(), UNKNOWN_LIMIT as i64],
            |row| {
                Ok(DiagnosticUnknown {
                    source: DiagnosticUnknownSource::Receipt,
                    subject: row.get(0)?,
                    operation: Some(row.get(1)?),
                    scope: Some(store.into()),
                    reason: "the effect's outcome was lost; reconcile before retrying".into(),
                    since: Some(row.get(2)?),
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    Ok((tally(store, &groups), unknown))
}

/// Durable queue depths in the sessions store.
pub struct SessionQueues {
    pub queued_prompts: u64,
    pub send_outbox: u64,
    pub attachment_bytes: u64,
}

pub fn session_queues(connection: &Connection) -> Result<SessionQueues> {
    let count = |sql: &str| -> Result<u64> {
        Ok(connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))?
            .max(0) as u64)
    };
    Ok(SessionQueues {
        queued_prompts: count("SELECT COUNT(*) FROM queued_prompts WHERE status = 'queued'")?,
        send_outbox: count(
            "SELECT COUNT(*) FROM send_intents WHERE state IN ('pending', 'rejected')",
        )?,
        attachment_bytes: count("SELECT COALESCE(SUM(length(data)), 0) FROM attachments")?,
    })
}

/// Conversations whose turn an interruption left unproven. Every loss path
/// (a daemon restart, a runtime loss, an unconfirmed provider stop or an
/// unconfirmed prompt delivery) records why in `error`. A turn the provider
/// itself reported interrupted, as after a user's cancel, has no such error
/// and a known outcome, so it is not unknown execution.
pub fn interrupted_conversations(connection: &Connection) -> Result<Vec<DiagnosticUnknown>> {
    Ok(connection
        .prepare(
            "SELECT id, workspace_id, json_extract(data, '$.updated_at') FROM conversations c WHERE NOT EXISTS(SELECT 1 FROM conversation_tombstones t WHERE t.conversation_id=c.id) AND json_extract(data, '$.status') = 'interrupted' AND json_extract(data, '$.error') IS NOT NULL ORDER BY json_extract(data, '$.updated_at') DESC LIMIT ?1",
        )?
        .query_map([UNKNOWN_LIMIT as i64], |row| {
            Ok(DiagnosticUnknown {
                source: DiagnosticUnknownSource::Conversation,
                subject: row.get(0)?,
                operation: None,
                scope: Some(row.get(1)?),
                reason: "a daemon or runtime loss interrupted the turn; resume explicitly".into(),
                since: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Configured services, with `running` left for [`mark_services`].
pub fn services(connection: &Connection) -> Result<Vec<DiagnosticService>> {
    Ok(connection
        .prepare(
            "SELECT workspace_id, name, json_extract(data, '$.identity'), json_extract(data, '$.revision'), json_extract(data, '$.terminal_id'), json_extract(data, '$.last_run_transfer_id') FROM services ORDER BY workspace_id, name LIMIT ?1",
        )?
        .query_map([SERVICE_LIMIT as i64], |row| {
            Ok(DiagnosticService {
                workspace_id: row.get(0)?,
                name: row.get(1)?,
                identity: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                revision: row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64,
                terminal_id: row.get(4)?,
                last_run_transfer_id: row.get(5)?,
                running: None,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Marks each service running when a runtime terminal with its terminal ID
/// runs a shell. Without an observation every service stays `None`.
pub fn mark_services(services: &mut [DiagnosticService], terminals: Option<&[DiagnosticTerminal]>) {
    let Some(terminals) = terminals else {
        return;
    };
    for service in services {
        service.running = Some(service.terminal_id.as_ref().is_some_and(|id| {
            terminals
                .iter()
                .any(|terminal| terminal.terminal_id == *id && terminal.shell_running)
        }));
    }
}

fn metric_str(metrics: &Value, key: &str) -> Option<String> {
    metrics[key].as_str().map(str::to_owned)
}

/// Summarizes runtime terminals. A shell whose exit the runtime could not
/// verify is an unknown execution.
pub fn terminals(list: &[Terminal]) -> (Vec<DiagnosticTerminal>, Vec<DiagnosticUnknown>) {
    let mut summaries = Vec::new();
    let mut unknown = Vec::new();
    for terminal in list {
        let metrics = &terminal.metrics;
        let exit_kind = metrics["exit_status"]["kind"].as_str().map(str::to_owned);
        let summary = DiagnosticTerminal {
            workspace_id: terminal.workspace.id.clone(),
            terminal_id: terminal.workspace.terminal_id.clone(),
            run_id: metric_str(metrics, "run_id"),
            transfer_id: metric_str(metrics, "transfer_id"),
            shell_running: terminal.shell_running(),
            shell_pid: metrics["shell_pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok()),
            clients: metrics["clients"].as_u64(),
            scrollback_bytes: metrics["scrollback_bytes"].as_u64(),
            reply_dropped_bytes: metrics["reply_dropped_bytes"].as_u64(),
            durable_log_failed: !metrics["durable_log_error"].is_null(),
            exit_kind,
        };
        if !summary.shell_running && summary.exit_kind.as_deref() == Some("unknown") {
            unknown.push(DiagnosticUnknown {
                source: DiagnosticUnknownSource::Terminal,
                subject: summary.terminal_id.clone(),
                operation: None,
                scope: Some(summary.workspace_id.clone()),
                reason: "the runtime could not verify the shell's exit".into(),
                since: None,
            });
        }
        summaries.push(summary);
    }
    (summaries, unknown)
}

/// Sums an optional per-terminal metric. `None` when no terminal reports it.
pub fn sum_metric(
    terminals: &[DiagnosticTerminal],
    metric: impl Fn(&DiagnosticTerminal) -> Option<u64>,
) -> Option<u64> {
    terminals
        .iter()
        .filter_map(metric)
        .fold(None, |sum, value| {
            Some(sum.unwrap_or(0).saturating_add(value))
        })
}

/// Keeps at most `limit` unknown executions, in the given order.
pub fn bound_unknown(
    mut unknown: Vec<DiagnosticUnknown>,
    limit: usize,
) -> (Vec<DiagnosticUnknown>, bool) {
    let truncated = unknown.len() > limit;
    unknown.truncate(limit);
    (unknown, truncated)
}

fn log_files(directory: &Path) -> Option<Vec<(PathBuf, std::fs::Metadata)>> {
    let mut files: Vec<_> = std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| (entry.path(), metadata))
        })
        .collect();
    files.sort_by_key(|(_, metadata)| metadata.modified().ok());
    Some(files)
}

/// The log folder's size against its budgets.
pub fn log_retention(directory: &Path) -> DiagnosticLogs {
    let files = log_files(directory);
    DiagnosticLogs {
        available: files.is_some(),
        files: files.as_ref().map_or(0, |files| files.len() as u64),
        bytes: files
            .as_ref()
            .map_or(0, |files| files.iter().map(|(_, meta)| meta.len()).sum()),
        max_files_per_process: LOG_FILES_PER_PROCESS,
        daily_byte_budget: LOG_DAILY_BYTES,
    }
}

/// The newest allow-listed log records, oldest first, and whether older
/// readable records were left out. Each file contributes at most its last
/// 256 KiB, and only the 16 newest files are read.
pub fn recent_events(directory: &Path, max: usize) -> (Vec<Value>, bool) {
    let Some(files) = log_files(directory) else {
        return (Vec::new(), false);
    };
    let skipped_files = files.len() > LOG_FILES_READ;
    let mut records = Vec::new();
    let mut partial = skipped_files;
    for (path, metadata) in files.iter().rev().take(LOG_FILES_READ) {
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let start = metadata.len().saturating_sub(LOG_TAIL_BYTES);
        if file.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }
        let mut reader = BufReader::new(file.take(LOG_TAIL_BYTES));
        let mut line = Vec::new();
        if start > 0 {
            partial = true;
            // The first line is cut by the seek.
            let _ = reader.read_until(b'\n', &mut line);
        }
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if !line.ends_with(b"\n") {
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if let Some(record) = ade_platform::diagnostics::safe_record(&value) {
                records.push(record);
            }
        }
    }
    select_events(records, max, partial)
}

/// Orders records by timestamp and keeps the newest `max`. Records without a
/// timestamp sort first. `partial` says older records were already skipped.
pub fn select_events(mut records: Vec<Value>, max: usize, partial: bool) -> (Vec<Value>, bool) {
    records.sort_by(|a, b| {
        a["timestamp"]
            .as_str()
            .unwrap_or("")
            .cmp(b["timestamp"].as_str().unwrap_or(""))
    });
    let dropped = records.len() > max;
    let keep_from = records.len().saturating_sub(max);
    (records.split_off(keep_from), partial || dropped)
}

/// 16 hex digits of the SHA-256 of the host name, or `unknown`.
pub fn host_key() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its full length, and gethostname
    // writes at most that many bytes.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    let length = buffer.iter().position(|byte| *byte == 0).unwrap_or(0);
    if result != 0 || length == 0 {
        return "unknown".into();
    }
    Sha256::digest(&buffer[..length])[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::model::WorkspaceRecord;
    use serde_json::json;

    #[test]
    fn stores_report_every_receipt_store_including_plugins() {
        let stores = Stores::in_directory(Path::new("/profile"));
        assert_eq!(stores.sessions, Path::new("/profile/sessions.sqlite"));
        assert_eq!(
            stores.receipts,
            vec![
                (
                    "lifecycle",
                    PathBuf::from("/profile/sessions.worktrees/lifecycle.sqlite3")
                ),
                ("review", PathBuf::from("/profile/sessions.review.sqlite3")),
                (
                    "plugins",
                    PathBuf::from("/profile/sessions.plugins.sqlite3")
                ),
                (
                    "envelope",
                    PathBuf::from("/profile/sessions.envelope.sqlite3")
                ),
            ]
        );
    }

    #[test]
    fn plugin_store_unknown_receipt_is_reported() {
        let connection = Connection::open_in_memory().unwrap();
        receipts::ensure(&connection).unwrap();
        receipts::begin(
            &connection,
            "op_1",
            "plugin.command",
            &json!({}),
            Some("plugin"),
            10,
        )
        .unwrap();
        receipts::settle(&connection, "op_1", Status::Unknown, None, 20).unwrap();
        let (tally, unknown) = receipts(&connection, "plugins", 30).unwrap();
        assert_eq!(tally.store, "plugins");
        assert_eq!(tally.unknown, 1);
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].subject, "op_1");
        assert_eq!(unknown[0].scope.as_deref(), Some("plugins"));
    }

    #[test]
    fn only_an_interruption_with_a_recorded_loss_is_unknown() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE conversations(id TEXT, workspace_id TEXT, data TEXT);{}",
                crate::store::TOMBSTONES
            ))
            .unwrap();
        for (id, data) in [
            (
                "lost",
                json!({"status": "interrupted", "error": "The daemon restarted during this turn.", "updated_at": 2}),
            ),
            (
                "cancelled",
                json!({"status": "interrupted", "error": null, "updated_at": 3}),
            ),
            (
                "idle",
                json!({"status": "ready", "error": "old", "updated_at": 4}),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO conversations VALUES(?1, 'w', ?2)",
                    params![id, data.to_string()],
                )
                .unwrap();
        }
        let unknown = interrupted_conversations(&connection).unwrap();
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].subject, "lost");
        assert_eq!(unknown[0].since, Some(2));
    }

    #[test]
    fn tally_counts_statuses_and_keeps_expired_out_of_retention() {
        let groups = vec![
            ("accepted".to_owned(), 1, Some(50), 0),
            ("settled".to_owned(), 4, Some(10), 2),
            ("unknown".to_owned(), 2, Some(30), 1),
            ("expired".to_owned(), 9, Some(1), 9),
            ("future".to_owned(), 1, Some(40), 0),
        ];
        let tally = tally("sessions", &groups);
        assert_eq!(
            tally,
            DiagnosticReceipts {
                store: "sessions".into(),
                available: true,
                accepted: 1,
                dispatched: 0,
                acknowledged: 0,
                settled: 4,
                unknown: 2,
                expired: 9,
                other: 1,
                past_retention: 3,
                oldest_created_at: Some(10),
            }
        );
        let empty = unavailable_tally("review");
        assert!(!empty.available);
        assert_eq!(empty.settled, 0);
    }

    fn terminal(id: &str, metrics: Value) -> Terminal {
        Terminal {
            workspace: WorkspaceRecord {
                extra_terminals: vec![],
                id: "workspace_1".into(),
                repository_id: None,
                root: "/private/root".into(),
                name: "Private name".into(),
                terminal_id: id.into(),
                needs_rebind: false,
                worktree_lifecycle_needs_rebind: false,
            },
            metrics,
        }
    }

    #[test]
    fn terminals_report_incarnations_and_unverified_exits() {
        let list = vec![
            terminal(
                "terminal_1",
                json!({"shell_running": true, "run_id": "run_1", "transfer_id": "transfer_1",
                    "shell_pid": 42, "clients": 2, "scrollback_bytes": 100, "reply_dropped_bytes": 7,
                    "durable_log_error": null}),
            ),
            terminal(
                "terminal_2",
                json!({"shell_running": false, "exit_status": {"kind": "unknown"},
                    "reply_dropped_bytes": 3, "durable_log_error": "disk full"}),
            ),
            terminal(
                "terminal_3",
                json!({"shell_running": false, "exit_status": {"kind": "exited", "code": 0}}),
            ),
        ];
        let (summaries, unknown) = terminals(&list);
        assert_eq!(summaries.len(), 3);
        assert_eq!(summaries[0].transfer_id.as_deref(), Some("transfer_1"));
        assert_eq!(summaries[0].shell_pid, Some(42));
        assert!(!summaries[0].durable_log_failed);
        assert!(summaries[1].durable_log_failed);
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].subject, "terminal_2");
        assert_eq!(unknown[0].source, DiagnosticUnknownSource::Terminal);
        assert_eq!(sum_metric(&summaries, |t| t.reply_dropped_bytes), Some(10));
        assert_eq!(sum_metric(&summaries[2..], |t| t.reply_dropped_bytes), None);
        let serialized = serde_json::to_string(&summaries).unwrap();
        assert!(!serialized.contains("/private/root"));
        assert!(!serialized.contains("Private name"));
    }

    #[test]
    fn services_are_running_only_with_a_live_terminal_observation() {
        let service = |terminal: Option<&str>| DiagnosticService {
            workspace_id: "workspace_1".into(),
            name: "web".into(),
            identity: "service_1".into(),
            revision: 1,
            terminal_id: terminal.map(str::to_owned),
            last_run_transfer_id: None,
            running: None,
        };
        let mut services = vec![
            service(Some("terminal_1")),
            service(Some("terminal_2")),
            service(None),
        ];
        mark_services(&mut services, None);
        assert!(services.iter().all(|service| service.running.is_none()));
        let (live, _) = terminals(&[
            terminal("terminal_1", json!({"shell_running": true})),
            terminal("terminal_2", json!({"shell_running": false})),
        ]);
        mark_services(&mut services, Some(&live));
        let running: Vec<_> = services.iter().map(|service| service.running).collect();
        assert_eq!(running, vec![Some(true), Some(false), Some(false)]);
    }

    #[test]
    fn events_keep_the_newest_by_timestamp() {
        let records = vec![
            json!({"event": "b", "timestamp": "2026-09-27T00:00:02Z"}),
            json!({"event": "a", "timestamp": "2026-09-27T00:00:01Z"}),
            json!({"event": "c", "timestamp": "2026-09-27T00:00:03Z"}),
        ];
        let (kept, truncated) = select_events(records.clone(), 2, false);
        assert_eq!(
            kept.iter()
                .map(|e| e["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["b", "c"]
        );
        assert!(truncated);
        let (kept, truncated) = select_events(records.clone(), 5, false);
        assert_eq!(kept.len(), 3);
        assert!(!truncated);
        assert!(select_events(records, 5, true).1);
        assert_eq!(
            select_events(vec![json!({"event": "x"})], 0, false),
            (vec![], true)
        );
    }

    #[test]
    fn unknown_lists_are_bounded() {
        let entry = |n: usize| DiagnosticUnknown {
            source: DiagnosticUnknownSource::Receipt,
            subject: format!("op_{n}"),
            operation: None,
            scope: None,
            reason: String::new(),
            since: None,
        };
        let (kept, truncated) = bound_unknown((0..5).map(entry).collect(), 3);
        assert_eq!(kept.len(), 3);
        assert_eq!(kept[0].subject, "op_0");
        assert!(truncated);
        assert!(!bound_unknown((0..3).map(entry).collect(), 3).1);
    }
}
