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
mod conversations;
mod migrations;
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
use conversations::*;
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
        Ok(Transaction::new_unchecked(
            &self.connection,
            TransactionBehavior::Immediate,
        )?)
    }
}
