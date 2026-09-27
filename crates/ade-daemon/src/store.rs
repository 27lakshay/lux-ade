//! The daemon is the sole writer; windows persist references, never process handles.
use crate::model::*;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const TEXT_LIMIT: usize = 1024 * 1024;
const BUSY: &[&str] = &["starting", "running", "waiting", "cancelling"];
pub struct Store {
    pub(crate) connection: Connection,
    data_directory: PathBuf,
}

mod account_switches;
mod accounts;
mod activity;
mod attachments;
mod bindings;
pub mod context_nodes;
mod conversations;
mod drafts;
mod migrations;
pub mod runtime_recovery;
mod send_intents;
mod send_outbox;
mod snoozes;
mod terminals;
#[cfg(test)]
mod tests;
mod windows;

pub use account_switches::SwitchCommit;
pub use attachments::*;
pub use bindings::*;
pub(crate) use conversations::HISTORY_EPOCHS;
use conversations::*;
pub use conversations::{QUEUE_DISPATCH_STATUSES, QueueEntry};
pub use drafts::{DraftContent, Restored};
pub use send_intents::*;
pub use send_outbox::*;
pub(crate) use terminals::forget_terminal_views;

fn decode<T: DeserializeOwned>(value: String) -> Result<T> {
    Ok(serde_json::from_str(&value)?)
}
fn encode(value: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn check_text(text: &str) -> Result<()> {
    ensure!(text.len() <= TEXT_LIMIT, "Text exceeds 1 MiB");
    Ok(())
}
fn check_id(id: &str) -> Result<()> {
    ensure!(!id.is_empty() && id.len() <= 512, "Invalid identifier");
    Ok(())
}
fn one<T: DeserializeOwned>(db: &Connection, table: &str, id: &str) -> Result<T> {
    let value: Option<String> = db
        .query_row(
            &format!("SELECT data FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    decode(value.with_context(|| format!("Unknown {table} ID: {id}"))?)
}
fn all<T: DeserializeOwned>(db: &Connection, query: &str) -> Result<Vec<T>> {
    let mut statement = db.prepare(query)?;
    statement
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|row| decode(row?))
        .collect()
}

impl Store {
    fn transaction(&self) -> Result<Transaction<'_>> {
        begin_write(&self.connection)
    }
}

/// How many times [`begin_write`] asks for the write lock. Each attempt waits
/// up to the connection's busy timeout.
const WRITE_LOCK_ATTEMPTS: usize = 2;

/// Opens a write transaction with `BEGIN IMMEDIATE`, retrying while the
/// database is busy or locked.
///
/// The write lock is taken at `BEGIN`, where the busy timeout applies. A
/// deferred transaction that reads first and then writes cannot wait: SQLite
/// refuses the upgrade at once with `SQLITE_BUSY` when another connection is
/// writing, which under load surfaced as a failed save. Retrying here is safe
/// because nothing has run inside the transaction yet.
pub fn begin_write(connection: &Connection) -> Result<Transaction<'_>> {
    let mut attempt = 1;
    loop {
        match Transaction::new_unchecked(connection, TransactionBehavior::Immediate) {
            Ok(tx) => return Ok(tx),
            Err(error)
                if attempt < WRITE_LOCK_ATTEMPTS
                    && classify_sqlite(&error).is_some_and(StorageFailure::retryable) =>
            {
                tracing::warn!(target: "ade", event = "storage_busy_retry", attempt);
                attempt += 1;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

use ade_core::error::StorageFailure;

fn classify_sqlite(error: &rusqlite::Error) -> Option<StorageFailure> {
    match error {
        rusqlite::Error::SqliteFailure(failure, _) => {
            Some(StorageFailure::classify(Some(failure.extended_code), None))
        }
        _ => None,
    }
}

/// The storage class of `error`, when a SQLite error or an out-of-space I/O
/// error caused it. Any other SQLite-library error (a missing row, a column
/// that does not decode) is a storage failure of no known kind. Other I/O
/// errors are left to their callers, which name the file they concern.
pub fn storage_failure(error: &anyhow::Error) -> Option<StorageFailure> {
    error.chain().find_map(|cause| {
        if let Some(sqlite) = cause.downcast_ref::<rusqlite::Error>() {
            return Some(classify_sqlite(sqlite).unwrap_or(StorageFailure::Failed));
        }
        let io = cause.downcast_ref::<std::io::Error>()?;
        let failure = StorageFailure::classify(None, io.raw_os_error());
        (failure == StorageFailure::Full).then_some(failure)
    })
}
