//! The profile's browser library (F092, F093, F094): named browser
//! partitions, imported bookmarks and history, and held design-context
//! captures. One SQLite file in the profile directory, created idempotently.
//!
//! Rules this module keeps:
//! - A partition is registered once by a caller-owned ID. `default` is
//!   implicit and reserved. The browser owner creates partition storage; this
//!   registry is what the daemon checks before it lets a tab open in one.
//! - An import never writes its source. SQLite sources are copied into a
//!   private staging directory first, because Chrome holds its `History`
//!   database locked while it runs; the copy is checked with `quick_check`.
//! - An import stores every requested class in one transaction, or nothing.
//!   A repeated import ID with the same request returns the stored record.
//! - A capture's attachment bytes are held here until both attachments are
//!   stored, so a repeat re-stores the identical bytes rather than capturing
//!   the page again.
pub mod bplist;
pub mod sources;

use crate::model::now_ms;
use ade_core::contract::browser::{
    BrowserImport, BrowserImportAvailability, BrowserImportClass, BrowserImportClassPreview,
    BrowserImportSource, BrowserImportedClass, BrowserPartition,
};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sources::{Bookmark, HistoryCollector, HistoryEntry, Parsed};
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub const LIBRARY_FILE: &str = "browser-library.sqlite3";
const STAGING_DIR: &str = "browser-import-staging";
/// The most named partitions one profile holds.
pub const PARTITION_LIMIT: u64 = 32;
pub const DEFAULT_PARTITION: &str = "default";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS browser_partitions(
  partition_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS browser_imports(
  import_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS browser_bookmarks(
  import_id TEXT NOT NULL, partition_id TEXT NOT NULL, position INTEGER NOT NULL,
  folder TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, added_at_ms INTEGER,
  PRIMARY KEY(import_id, position));
CREATE TABLE IF NOT EXISTS browser_history(
  import_id TEXT NOT NULL, partition_id TEXT NOT NULL, position INTEGER NOT NULL,
  url TEXT NOT NULL, title TEXT NOT NULL, visit_count INTEGER NOT NULL, last_visit_ms INTEGER,
  PRIMARY KEY(import_id, position));
CREATE INDEX IF NOT EXISTS browser_bookmarks_partition ON browser_bookmarks(partition_id);
CREATE INDEX IF NOT EXISTS browser_history_partition ON browser_history(partition_id);
CREATE TABLE IF NOT EXISTS browser_captures(
  capture_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
  context BLOB, screenshot BLOB, reply TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
";

/// A failure with its wire error code.
#[derive(Debug)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Refused {}

pub fn refused(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Refused {
        code,
        message: message.into(),
    }
    .into()
}

/// The wire code of a library failure: its `Refused` code, else `unavailable`.
pub fn error_code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<Refused>()
        .map_or("unavailable", |refused| refused.code)
}

/// A partition ID: 1 to 64 lowercase letters, digits, `-` or `_`, starting
/// with a letter or digit.
pub fn valid_partition_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// A partition name: 1 to 64 characters, no control characters, not blank.
pub fn valid_partition_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=64).contains(&count) && !name.chars().any(char::is_control) && !name.trim().is_empty()
}

/// A caller-owned import or capture ID.
pub fn valid_request_id(id: &str, max: usize) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The canonical fingerprint of an import request.
pub fn import_fingerprint(
    partition_id: &str,
    source: BrowserImportSource,
    source_profile: Option<&str>,
    classes: &[BrowserImportClass],
) -> String {
    let mut sorted = classes.to_vec();
    sorted.sort();
    let canonical = json!([partition_id, source, source_profile, sorted]).to_string();
    hex(&Sha256::digest(canonical.as_bytes()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One class read from its source, or why it could not be.
pub enum ClassRead {
    Bookmarks(Parsed<Bookmark>),
    History(Parsed<HistoryEntry>),
    Unavailable(BrowserImportAvailability, String),
}

impl ClassRead {
    fn counts(&self) -> (Option<String>, u64, u64, u64) {
        match self {
            ClassRead::Bookmarks(p) => (
                Some(p.format.clone()),
                p.entries.len() as u64,
                p.skipped,
                p.truncated,
            ),
            ClassRead::History(p) => (
                Some(p.format.clone()),
                p.entries.len() as u64,
                p.skipped,
                p.truncated,
            ),
            ClassRead::Unavailable(..) => (None, 0, 0, 0),
        }
    }

    pub fn preview(&self, class: BrowserImportClass, path: &Path) -> BrowserImportClassPreview {
        let (format, importable, skipped, truncated) = self.counts();
        let (availability, reason) = match self {
            ClassRead::Unavailable(availability, reason) => (*availability, Some(reason.clone())),
            _ => (BrowserImportAvailability::Ready, None),
        };
        BrowserImportClassPreview {
            class,
            availability,
            path: path.display().to_string(),
            format,
            importable,
            skipped,
            truncated,
            reason,
        }
    }
}

fn unavailable_io(error: &std::io::Error) -> ClassRead {
    match error.kind() {
        ErrorKind::NotFound => ClassRead::Unavailable(
            BrowserImportAvailability::Missing,
            "The file does not exist".into(),
        ),
        ErrorKind::PermissionDenied => ClassRead::Unavailable(
            BrowserImportAvailability::PermissionDenied,
            "macOS denied access; grant ADE Full Disk Access to read Safari data".into(),
        ),
        _ => ClassRead::Unavailable(
            BrowserImportAvailability::Unsupported,
            format!("The file could not be read: {error}"),
        ),
    }
}

fn unsupported(message: impl std::fmt::Display) -> ClassRead {
    ClassRead::Unavailable(BrowserImportAvailability::Unsupported, message.to_string())
}

/// Opens a regular source file read-only without following a final symlink
/// and returns its size, or why it cannot be read.
fn open_source(path: &Path, limit: u64) -> Result<(File, u64), ClassRead> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                unsupported("The file is a symbolic link")
            } else {
                unavailable_io(&error)
            }
        })?;
    let metadata = file.metadata().map_err(|error| unavailable_io(&error))?;
    if !metadata.is_file() {
        return Err(unsupported("The source is not a regular file"));
    }
    if metadata.len() > limit {
        return Err(unsupported(format!(
            "The file is larger than the {limit}-byte import bound"
        )));
    }
    Ok((file, metadata.len()))
}

fn read_bookmarks(path: &Path, source: BrowserImportSource) -> ClassRead {
    let (file, _) = match open_source(path, sources::BOOKMARK_FILE_LIMIT) {
        Ok(opened) => opened,
        Err(read) => return read,
    };
    let mut bytes = Vec::new();
    if let Err(error) = file
        .take(sources::BOOKMARK_FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
    {
        return unavailable_io(&error);
    }
    let parsed = match source {
        BrowserImportSource::Chrome => sources::parse_chrome_bookmarks(&bytes),
        BrowserImportSource::Safari => sources::parse_safari_bookmarks(&bytes),
    };
    parsed.map_or_else(unsupported, ClassRead::Bookmarks)
}

/// A private copy of a source database, removed when dropped.
struct Staged {
    directory: PathBuf,
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn copy_file(mut from: File, to: &Path, limit: u64) -> std::io::Result<()> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)?;
    let copied = std::io::copy(&mut (&mut from).take(limit + 1), &mut out)?;
    if copied > limit {
        return Err(std::io::Error::other("The file grew past the import bound"));
    }
    Ok(())
}

use std::os::unix::fs::PermissionsExt;

/// Copies a SQLite source and its journal files into a private staging
/// directory and opens the copy after a `quick_check`.
fn stage_database(path: &Path, staging_root: &Path) -> Result<(Staged, Connection), ClassRead> {
    let (file, _) = open_source(path, sources::HISTORY_FILE_LIMIT)?;
    let fail =
        |error: std::io::Error| unsupported(format!("The file could not be copied: {error}"));
    fs::create_dir_all(staging_root).map_err(fail)?;
    fs::set_permissions(staging_root, fs::Permissions::from_mode(0o700)).map_err(fail)?;
    let directory = staging_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&directory).map_err(fail)?;
    let staged = Staged { directory };
    let copy = staged.directory.join("source.sqlite");
    copy_file(file, &copy, sources::HISTORY_FILE_LIMIT).map_err(fail)?;
    // A running browser may hold a hot journal; copy it so SQLite rolls the
    // copy back to its last committed state.
    for suffix in ["-journal", "-wal"] {
        let companion = PathBuf::from(format!("{}{suffix}", path.display()));
        match open_source(&companion, sources::HISTORY_FILE_LIMIT) {
            Ok((file, _)) => copy_file(
                file,
                &PathBuf::from(format!("{}{suffix}", copy.display())),
                sources::HISTORY_FILE_LIMIT,
            )
            .map_err(fail)?,
            Err(ClassRead::Unavailable(BrowserImportAvailability::Missing, _)) => {}
            Err(read) => return Err(read),
        }
    }
    let connection = Connection::open(&copy)
        .map_err(|error| unsupported(format!("The database could not be opened: {error}")))?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| unsupported(format!("The database is damaged or locked: {error}")))?;
    if check != "ok" {
        return Err(unsupported(format!(
            "The database failed its integrity check: {check}; close the browser and retry"
        )));
    }
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| unsupported(error.to_string()))?;
    Ok((staged, connection))
}

fn columns(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

fn read_history(path: &Path, source: BrowserImportSource, staging_root: &Path) -> ClassRead {
    let (_staged, connection) = match stage_database(path, staging_root) {
        Ok(staged) => staged,
        Err(read) => return read,
    };
    let result = (|| -> Result<Parsed<HistoryEntry>> {
        let (format, sql, total_sql) = match source {
            BrowserImportSource::Chrome => {
                let version: Option<i64> = connection
                    .query_row("SELECT value FROM meta WHERE key='version'", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .optional()
                    .unwrap_or(None)
                    .and_then(|value| value.parse().ok());
                let format =
                    sources::chrome_history_format(version, &columns(&connection, "urls")?)?;
                (
                    format,
                    "SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden=0 \
                     ORDER BY last_visit_time DESC",
                    "SELECT count(*) FROM urls WHERE hidden=0",
                )
            }
            BrowserImportSource::Safari => {
                let format = sources::safari_history_format(
                    &columns(&connection, "history_items")?,
                    &columns(&connection, "history_visits")?,
                )?;
                (
                    format,
                    "SELECT i.url, \
                       COALESCE((SELECT v.title FROM history_visits v WHERE v.history_item=i.id \
                         ORDER BY v.visit_time DESC LIMIT 1), ''), \
                       i.visit_count, \
                       (SELECT max(v.visit_time) FROM history_visits v WHERE v.history_item=i.id) AS t \
                     FROM history_items i ORDER BY t DESC",
                    "SELECT count(*) FROM history_items",
                )
            }
        };
        let total: i64 = connection.query_row(total_sql, [], |row| row.get(0))?;
        let mut collector = HistoryCollector::new(format);
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query([])?;
        let mut scanned = 0i64;
        while let Some(row) = rows.next()? {
            scanned += 1;
            let url: String = row.get::<_, Option<String>>(0)?.unwrap_or_default();
            let title: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            let visits: i64 = row.get::<_, Option<i64>>(2)?.unwrap_or(0);
            let last = match source {
                BrowserImportSource::Chrome => row
                    .get::<_, Option<i64>>(3)?
                    .and_then(sources::chrome_time_ms),
                BrowserImportSource::Safari => row
                    .get::<_, Option<f64>>(3)?
                    .and_then(sources::safari_time_ms),
            };
            if !collector.push(&url, &title, visits, last) {
                break;
            }
        }
        Ok(collector.finish(u64::try_from(total - scanned).unwrap_or(0)))
    })();
    result.map_or_else(unsupported, ClassRead::History)
}

/// Reads one class from its source file.
pub fn read_class(
    home: &Path,
    staging_root: &Path,
    source: BrowserImportSource,
    profile: Option<&str>,
    class: BrowserImportClass,
) -> (PathBuf, ClassRead) {
    let path = sources::source_path(home, source, profile, class);
    let read = match class {
        BrowserImportClass::Bookmarks => read_bookmarks(&path, source),
        BrowserImportClass::History => read_history(&path, source, staging_root),
    };
    (path, read)
}

/// A held or completed design-context capture.
pub struct HeldCapture {
    pub fingerprint: String,
    pub completed: bool,
    pub context: Option<Vec<u8>>,
    pub screenshot: Option<Vec<u8>>,
    pub reply: Value,
}

pub struct Library {
    db: Connection,
    directory: PathBuf,
}

impl Library {
    /// Opens (creating when absent) the library in a profile directory.
    pub fn open(directory: &Path) -> Result<Self> {
        let db = Connection::open(directory.join(LIBRARY_FILE))
            .context("Browser library is unavailable")?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.execute_batch(SCHEMA)?;
        Ok(Self {
            db,
            directory: directory.to_owned(),
        })
    }

    pub fn staging_root(&self) -> PathBuf {
        self.directory.join(STAGING_DIR)
    }

    pub fn partitions(&self) -> Result<Vec<BrowserPartition>> {
        let mut partitions = vec![BrowserPartition {
            partition_id: DEFAULT_PARTITION.into(),
            name: "Default".into(),
            created_at_ms: None,
        }];
        let mut statement = self.db.prepare(
            "SELECT partition_id, name, created_at_ms FROM browser_partitions ORDER BY created_at_ms, partition_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(BrowserPartition {
                partition_id: row.get(0)?,
                name: row.get(1)?,
                created_at_ms: Some(row.get(2)?),
            })
        })?;
        for row in rows {
            partitions.push(row?);
        }
        Ok(partitions)
    }

    /// True for `default` and every registered partition.
    pub fn partition_exists(&self, id: &str) -> Result<bool> {
        if id == DEFAULT_PARTITION {
            return Ok(true);
        }
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM browser_partitions WHERE partition_id=?1",
                [id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Registers a partition; the bool is false when it already existed.
    pub fn create_partition(&mut self, id: &str, name: &str) -> Result<(BrowserPartition, bool)> {
        if !valid_partition_id(id) || id == DEFAULT_PARTITION {
            return Err(refused(
                "invalid_request",
                "partition_id must be 1 to 64 lowercase letters, digits, - or _, and not default",
            ));
        }
        if !valid_partition_name(name) {
            return Err(refused(
                "invalid_request",
                "name must be 1 to 64 characters without control characters",
            ));
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, i64)> = tx
            .query_row(
                "SELECT name, created_at_ms FROM browser_partitions WHERE partition_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing, created_at_ms)) = existing {
            if existing != name {
                return Err(refused(
                    "conflict",
                    format!("Partition {id} already exists with another name"),
                ));
            }
            return Ok((
                BrowserPartition {
                    partition_id: id.into(),
                    name: existing,
                    created_at_ms: Some(created_at_ms),
                },
                false,
            ));
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM browser_partitions", [], |row| {
            row.get(0)
        })?;
        if count as u64 >= PARTITION_LIMIT {
            return Err(refused(
                "conflict",
                format!("A profile holds at most {PARTITION_LIMIT} named partitions"),
            ));
        }
        let created_at_ms = now_ms();
        tx.execute(
            "INSERT INTO browser_partitions(partition_id, name, created_at_ms) VALUES(?1, ?2, ?3)",
            params![id, name, created_at_ms],
        )?;
        tx.commit()?;
        Ok((
            BrowserPartition {
                partition_id: id.into(),
                name: name.into(),
                created_at_ms: Some(created_at_ms),
            },
            true,
        ))
    }

    /// A stored import and its request fingerprint.
    pub fn import(&self, import_id: &str) -> Result<Option<(String, BrowserImport)>> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT fingerprint, record FROM browser_imports WHERE import_id=?1",
                [import_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(fingerprint, record)| {
            Ok((
                fingerprint,
                serde_json::from_str(&record).context("Stored browser import is damaged")?,
            ))
        })
        .transpose()
    }

    /// Stores every read class and the import record in one transaction.
    /// Returns the stored record, which is the earlier one when the same
    /// import ID was stored meanwhile with the same fingerprint.
    pub fn store_import(
        &mut self,
        fingerprint: &str,
        mut record: BrowserImport,
        reads: Vec<(BrowserImportClass, ClassRead)>,
    ) -> Result<BrowserImport> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT fingerprint, record FROM browser_imports WHERE import_id=?1",
                [&record.import_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((prior_fingerprint, prior_record)) = prior {
            if prior_fingerprint != fingerprint {
                return Err(refused(
                    "conflict",
                    "import_id was already used for another import",
                ));
            }
            return Ok(serde_json::from_str(&prior_record)?);
        }
        for (class, read) in reads {
            let imported = match read {
                ClassRead::Bookmarks(parsed) => {
                    let mut insert = tx.prepare(
                        "INSERT INTO browser_bookmarks(import_id, partition_id, position, folder, title, url, added_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    )?;
                    for (position, entry) in parsed.entries.iter().enumerate() {
                        insert.execute(params![
                            record.import_id,
                            record.partition_id,
                            position as i64,
                            serde_json::to_string(&entry.folder)?,
                            entry.title,
                            entry.url,
                            entry.added_at_ms,
                        ])?;
                    }
                    BrowserImportedClass {
                        class,
                        format: parsed.format,
                        imported: parsed.entries.len() as u64,
                        skipped: parsed.skipped,
                        truncated: parsed.truncated,
                    }
                }
                ClassRead::History(parsed) => {
                    let mut insert = tx.prepare(
                        "INSERT INTO browser_history(import_id, partition_id, position, url, title, visit_count, last_visit_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    )?;
                    for (position, entry) in parsed.entries.iter().enumerate() {
                        insert.execute(params![
                            record.import_id,
                            record.partition_id,
                            position as i64,
                            entry.url,
                            entry.title,
                            entry.visit_count,
                            entry.last_visit_ms,
                        ])?;
                    }
                    BrowserImportedClass {
                        class,
                        format: parsed.format,
                        imported: parsed.entries.len() as u64,
                        skipped: parsed.skipped,
                        truncated: parsed.truncated,
                    }
                }
                ClassRead::Unavailable(_, reason) => {
                    return Err(refused(
                        "unavailable",
                        format!("{class:?} could not be read: {reason}; nothing was imported"),
                    ));
                }
            };
            record.classes.push(imported);
        }
        record.imported_at_ms = now_ms();
        tx.execute(
            "INSERT INTO browser_imports(import_id, fingerprint, record, created_at_ms) VALUES(?1,?2,?3,?4)",
            params![
                record.import_id,
                fingerprint,
                serde_json::to_string(&record)?,
                record.imported_at_ms
            ],
        )?;
        tx.commit()?;
        Ok(record)
    }

    pub fn capture(&self, capture_id: &str) -> Result<Option<HeldCapture>> {
        type Row = (String, String, Option<Vec<u8>>, Option<Vec<u8>>, String);
        let row: Option<Row> = self
            .db
            .query_row(
                "SELECT fingerprint, state, context, screenshot, reply FROM browser_captures WHERE capture_id=?1",
                [capture_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        row.map(|(fingerprint, state, context, screenshot, reply)| {
            Ok(HeldCapture {
                fingerprint,
                completed: state == "completed",
                context,
                screenshot,
                reply: serde_json::from_str(&reply).context("Stored capture is damaged")?,
            })
        })
        .transpose()
    }

    /// Holds a capture's bytes before its attachments are stored. Fails when
    /// the capture ID is already held.
    pub fn hold_capture(
        &self,
        capture_id: &str,
        fingerprint: &str,
        context: &[u8],
        screenshot: Option<&[u8]>,
        reply: &Value,
    ) -> Result<()> {
        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO browser_captures(capture_id, fingerprint, state, context, screenshot, reply, created_at_ms) VALUES(?1,?2,'pending',?3,?4,?5,?6)",
            params![capture_id, fingerprint, context, screenshot, reply.to_string(), now_ms()],
        )?;
        if inserted != 1 {
            return Err(refused(
                "conflict",
                "capture_id is already in use; repeat the same capture to finish it",
            ));
        }
        Ok(())
    }

    /// Marks a capture complete and drops its held bytes.
    pub fn complete_capture(&self, capture_id: &str) -> Result<()> {
        self.db.execute(
            "UPDATE browser_captures SET state='completed', context=NULL, screenshot=NULL WHERE capture_id=?1",
            [capture_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partition_ids_and_names_are_bounded() {
        for good in ["work", "a", "client-2", "x_y", &"a".repeat(64)] {
            assert!(valid_partition_id(good), "{good}");
        }
        for bad in [
            "",
            "Work",
            "-a",
            "_a",
            "a b",
            "../a",
            "a.b",
            &"a".repeat(65),
        ] {
            assert!(!valid_partition_id(bad), "{bad}");
        }
        assert!(valid_partition_name("Client A"));
        assert!(!valid_partition_name(" "));
        assert!(!valid_partition_name("a\nb"));
        assert!(!valid_partition_name(&"x".repeat(65)));
    }

    #[test]
    fn an_import_fingerprint_ignores_class_order_only() {
        use BrowserImportClass::*;
        use BrowserImportSource::*;
        let a = import_fingerprint("default", Chrome, Some("Default"), &[Bookmarks, History]);
        assert_eq!(
            a,
            import_fingerprint("default", Chrome, Some("Default"), &[History, Bookmarks])
        );
        assert_ne!(
            a,
            import_fingerprint("work", Chrome, Some("Default"), &[Bookmarks, History])
        );
        assert_ne!(
            a,
            import_fingerprint("default", Chrome, Some("Profile 1"), &[Bookmarks, History])
        );
        assert_ne!(
            a,
            import_fingerprint("default", Chrome, Some("Default"), &[Bookmarks])
        );
    }

    #[test]
    fn refusals_carry_their_wire_code() {
        let error = refused("conflict", "x");
        assert_eq!(error_code(&error), "conflict");
        assert_eq!(error_code(&anyhow::anyhow!("disk")), "unavailable");
    }
}
