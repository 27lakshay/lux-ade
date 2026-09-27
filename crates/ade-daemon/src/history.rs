//! Combined history, work search and external session import (F041, F042, F043).
//!
//! The search index is a recoverable asynchronous projection (proposed
//! architecture, section 6). Triggers on `messages` append one row per change
//! to `history_journal` inside the writer's own transaction; that is the only
//! work added to a history write. A background indexer, on its own connection
//! and in its own short transactions, reads each changed message's current
//! state, updates a contentless FTS5 index and advances a recorded high-water
//! mark. Because it re-reads current state instead of replaying changes, a
//! crash between batches only repeats idempotent work. A version mismatch or a
//! journal behind the high-water mark rebuilds the index from durable history
//! under a new epoch, which expires older search cursors.
use crate::model::{Conversation, Message};
use ade_core::contract::history::*;
use anyhow::{Context, Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

mod core;
pub mod import;
use self::core::{IndexState, Step};

/// Messages indexed per transaction, so a writer never waits long on the index.
const BATCH: i64 = 100;
/// Index steps per indexer wake before it yields.
const STEPS_PER_WAKE: usize = 20;
const WAKE: Duration = Duration::from_millis(250);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS history_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history_index_state(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, epoch INTEGER NOT NULL, applied INTEGER NOT NULL, rebuilding INTEGER NOT NULL CHECK(rebuilding IN (0,1)), backfill_after TEXT);
INSERT OR IGNORE INTO history_index_state VALUES(1,0,0,0,1,NULL);
CREATE TABLE IF NOT EXISTS history_docs(doc INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, observed_at INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(body, notes, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS history_journal_insert AFTER INSERT ON messages BEGIN
  INSERT INTO history_journal(message_id,changed_at) VALUES(new.id,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS history_journal_update AFTER UPDATE ON messages BEGIN
  INSERT INTO history_journal(message_id,changed_at) VALUES(new.id,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS history_journal_delete AFTER DELETE ON messages BEGIN
  INSERT INTO history_journal(message_id,changed_at) VALUES(old.id,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
";

pub struct History {
    db: Mutex<Connection>,
    last_error: Mutex<Option<String>>,
}

impl History {
    /// Opens the history projection inside the profile database at `path`,
    /// which [`crate::store::Store::open`] has already migrated, and starts
    /// its indexer.
    pub fn open(path: &Path) -> Result<Arc<Self>> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        // Search reports each conversation's rewind epoch with its matches.
        tx.execute_batch(crate::store::HISTORY_EPOCHS)?;
        tx.execute_batch(crate::store::TOMBSTONES)?;
        import::ensure_table(&tx)?;
        tx.commit()?;
        let history = Arc::new(Self {
            db: Mutex::new(db),
            last_error: Mutex::new(None),
        });
        let weak = Arc::downgrade(&history);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(WAKE);
                let Some(history) = weak.upgrade() else {
                    break;
                };
                history.catch_up(STEPS_PER_WAKE);
            }
        });
        Ok(history)
    }

    /// Runs up to `steps` index steps, recording and clearing failures.
    fn catch_up(&self, steps: usize) {
        for _ in 0..steps {
            match self.step() {
                Ok(worked) => {
                    *self.last_error.lock().unwrap() = None;
                    if !worked {
                        return;
                    }
                }
                Err(error) => {
                    tracing::warn!(target: "ade", event = "history_index_failed", error = %error);
                    *self.last_error.lock().unwrap() =
                        Some("The history index update failed; it will retry".into());
                    return;
                }
            }
        }
    }

    /// Performs one planned step in one transaction. False when idle.
    fn step(&self) -> Result<bool> {
        let db = self.db.lock().unwrap();
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let state = read_state(&tx)?;
        let step = core::plan(&state, journal_head(&tx)?);
        match step {
            Step::Idle => return Ok(false),
            Step::Reset => reset(&tx, &state)?,
            Step::Backfill { after } => {
                let ids = tx
                    .prepare(
                        "SELECT id FROM messages WHERE (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2",
                    )?
                    .query_map(params![after, BATCH], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for id in &ids {
                    index_message(&tx, id, None)?;
                }
                let done = (ids.len() as i64) < BATCH;
                tx.execute(
                    "UPDATE history_index_state SET rebuilding=?1,backfill_after=?2 WHERE id=1",
                    params![!done, if done { None } else { ids.last() }],
                )?;
            }
            Step::Apply { after } => {
                let entries = tx
                    .prepare("SELECT seq,message_id,changed_at FROM history_journal WHERE seq>?1 ORDER BY seq LIMIT ?2")?
                    .query_map(params![after, BATCH], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let (messages, through) = core::collapse(&entries);
                // Sequences are never reused, so a gap below the head means
                // the entries were already pruned; move past it.
                let through = through.unwrap_or_else(|| journal_head(&tx).unwrap_or(after));
                for (id, first_change) in &messages {
                    index_message(&tx, id, Some(*first_change))?;
                }
                tx.execute(
                    "UPDATE history_index_state SET applied=?1 WHERE id=1",
                    [through],
                )?;
                tx.execute("DELETE FROM history_journal WHERE seq<=?1", [through])?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    fn status(&self, db: &Connection) -> Result<HistoryIndexStatus> {
        let state = read_state(db)?;
        let head = journal_head(db)?;
        let (pending_changes, caught_up) = core::lag(&state, head);
        Ok(HistoryIndexStatus {
            epoch: u64::try_from(state.epoch).unwrap_or(0),
            rebuilding: state.rebuilding || core::plan(&state, head) == Step::Reset,
            pending_changes,
            caught_up,
            last_error: self.last_error.lock().unwrap().clone(),
        })
    }

    /// Handles one `history.*` operation.
    pub fn command(&self, request: &Value) -> Result<Value> {
        let op = request["op"].as_str().unwrap_or("");
        let result = match op {
            "history.search" => self.search(decode(request)?),
            "history.list" => self.list(decode(request)?),
            "history.index.status" => {
                decode::<HistoryIndexStatusRequest>(request)?;
                let db = self.db.lock().unwrap();
                reply(&HistoryIndexReply {
                    tag: Default::default(),
                    index: self.status(&db)?,
                })
            }
            "history.index.rebuild" => self.rebuild(decode(request)?),
            _ => Err(anyhow!("Unknown history operation")),
        };
        result.map_err(|error| {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                tracing::error!(target: "ade", event = "history_read_failed", error = %error);
                anyhow!("History is unavailable; retry")
            } else {
                error
            }
        })
    }

    fn rebuild(&self, request: HistoryIndexRebuildRequest) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let state = read_state(&tx)?;
        if u64::try_from(state.epoch).ok() == Some(request.expected_epoch) {
            reset(&tx, &state)?;
        }
        let index = self.status(&tx)?;
        tx.commit()?;
        reply(&HistoryIndexReply {
            tag: Default::default(),
            index,
        })
    }

    fn search(&self, request: HistorySearchRequest) -> Result<Value> {
        let limit = request.limit.unwrap_or(20);
        ensure!(
            (1..=50).contains(&limit),
            "History search limit must be 1 to 50"
        );
        let terms = core::terms(&request.query)?;
        let mut db = self.db.lock().unwrap();
        // One read snapshot, so the status describes the rows returned.
        let tx = db.transaction()?;
        let index = self.status(&tx)?;
        let epoch = i64::try_from(index.epoch)?;
        let before = request
            .cursor
            .as_deref()
            .map(|cursor| core::parse_search_cursor(cursor, epoch))
            .transpose()?;
        check_filters(
            &tx,
            request.workspace_id.as_deref(),
            request.conversation_id.as_deref(),
        )?;
        let mut statement = tx.prepare(
            "SELECT history_fts.rowid,d.observed_at,m.data,c.data,
                    i.native_session_id,i.source_path,i.native_cwd,i.account_id,i.imported_at,
                    COALESCE(e.epoch,0)
             FROM history_fts
             JOIN history_docs d ON d.doc=history_fts.rowid
             JOIN messages m ON m.id=d.message_id
             JOIN conversations c ON c.id=m.conversation_id
             LEFT JOIN history_imports i ON i.conversation_id=c.id
             LEFT JOIN conversation_history_epochs e ON e.conversation_id=c.id
             WHERE history_fts MATCH ?1 AND (?2 IS NULL OR history_fts.rowid<?2)
               AND (?3 IS NULL OR c.workspace_id=?3)
               AND (?4 IS NULL OR json_extract(c.data,'$.provider')=?4)
               AND (?5 IS NULL OR m.conversation_id=?5)
             ORDER BY history_fts.rowid DESC LIMIT ?6",
        )?;
        let mut rows = statement.query(params![
            core::fts_query(&terms),
            before,
            request.workspace_id,
            request.provider,
            request.conversation_id,
            limit as i64 + 1,
        ])?;
        let mut results = Vec::new();
        let mut last = None;
        let mut more = false;
        while let Some(row) = rows.next()? {
            if results.len() as u64 == limit {
                more = true;
                break;
            }
            let doc: i64 = row.get(0)?;
            let message: Message = serde_json::from_str(&row.get::<_, String>(2)?)?;
            let conversation: Conversation = serde_json::from_str(&row.get::<_, String>(3)?)?;
            let notes = core::feedback_text(message.review_feedback.as_ref());
            let excerpt = core::excerpt(&message.text, &terms)
                .or_else(|| core::excerpt(&notes, &terms))
                .unwrap_or_else(|| core::opening(&message.text));
            results.push(HistoryMatch {
                has_review_feedback: !notes.is_empty(),
                observed_at: row.get(1)?,
                provenance: provenance(&conversation, import::ImportRow::from_row(row, 4)?),
                message_id: message.id,
                role: message.role,
                kind: message.kind,
                sequence: message.sequence,
                history_epoch: u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                excerpt,
            });
            last = Some(doc);
        }
        let next_cursor = more
            .then_some(last)
            .flatten()
            .map(|doc| core::search_cursor(epoch, doc));
        reply(&HistorySearch {
            tag: Default::default(),
            results,
            next_cursor,
            index,
        })
    }

    fn list(&self, request: HistoryListRequest) -> Result<Value> {
        let limit = request.limit.unwrap_or(50);
        ensure!(
            (1..=100).contains(&limit),
            "History list limit must be 1 to 100"
        );
        let after = request
            .cursor
            .as_deref()
            .map(core::parse_list_cursor)
            .transpose()?;
        let (after_time, after_id) = after.unzip();
        let db = self.db.lock().unwrap();
        check_filters(&db, request.workspace_id.as_deref(), None)?;
        let mut statement = db.prepare(
            "SELECT c.data,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id),
                    json_extract(c.data,'$.updated_at') AS updated,
                    i.native_session_id,i.source_path,i.native_cwd,i.account_id,i.imported_at
             FROM conversations c
             LEFT JOIN history_imports i ON i.conversation_id=c.id
             WHERE NOT EXISTS(SELECT 1 FROM conversation_tombstones t WHERE t.conversation_id=c.id)
               AND (?1 IS NULL OR c.workspace_id=?1)
               AND (?2 IS NULL OR json_extract(c.data,'$.provider')=?2)
               AND (?3 IS NULL OR updated<?3 OR (updated=?3 AND c.id<?4))
             ORDER BY updated DESC, c.id DESC LIMIT ?5",
        )?;
        let mut rows = statement.query(params![
            request.workspace_id,
            request.provider,
            after_time,
            after_id,
            limit as i64 + 1,
        ])?;
        let mut conversations = Vec::new();
        let mut more = false;
        while let Some(row) = rows.next()? {
            if conversations.len() as u64 == limit {
                more = true;
                break;
            }
            let conversation: Conversation = serde_json::from_str(&row.get::<_, String>(0)?)?;
            conversations.push(HistoryConversation {
                status: conversation.status.clone(),
                message_count: row.get::<_, i64>(1)?.try_into()?,
                provenance: provenance(&conversation, import::ImportRow::from_row(row, 3)?),
            });
        }
        let next_cursor =
            more.then(|| conversations.last())
                .flatten()
                .map(|last: &HistoryConversation| {
                    core::list_cursor(
                        last.provenance.conversation_updated_at,
                        &last.provenance.conversation_id,
                    )
                });
        reply(&HistoryList {
            tag: Default::default(),
            conversations,
            next_cursor,
        })
    }
}

fn provenance(conversation: &Conversation, import: Option<import::ImportRow>) -> HistoryProvenance {
    let (imported_id, import) = import
        .map(|row| (row.native_session_id, row.source))
        .unzip();
    HistoryProvenance {
        conversation_id: conversation.id.clone(),
        conversation_title: conversation.title.clone(),
        provider: conversation.provider.clone(),
        workspace_id: conversation.workspace_id.clone(),
        account_id: conversation.account_id.clone(),
        native_session_id: conversation.provider_thread_id.clone().or(imported_id),
        conversation_updated_at: conversation.updated_at,
        import,
    }
}

/// Refuses a filter that names no record, so a typo is not read as "no results".
fn check_filters(
    db: &Connection,
    workspace_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<()> {
    for (table, noun, id) in [
        ("workspaces", "workspace", workspace_id),
        ("conversations", "conversation", conversation_id),
    ] {
        if let Some(id) = id {
            let exists: bool = db.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
                [id],
                |row| row.get(0),
            )?;
            ensure!(exists, "Unknown {noun} ID: {id}");
        }
    }
    // A search scoped to a deleted Conversation is refused, not answered empty.
    if let Some(id) = conversation_id
        && crate::store::is_deleted(db, id)?
    {
        return Err(ade_core::error::ConversationDeleted(id.to_owned()).into());
    }
    Ok(())
}

fn read_state(db: &Connection) -> Result<IndexState> {
    db.query_row(
        "SELECT version,epoch,applied,rebuilding,backfill_after FROM history_index_state WHERE id=1",
        [],
        |row| {
            Ok(IndexState {
                version: row.get(0)?,
                epoch: row.get(1)?,
                applied: row.get(2)?,
                rebuilding: row.get(3)?,
                backfill_after: row.get(4)?,
            })
        },
    )
    .optional()?
    .context("History index state is missing")
}

/// The highest journal sequence ever assigned. `AUTOINCREMENT` keeps it even
/// after applied entries are pruned.
fn journal_head(db: &Connection) -> Result<i64> {
    Ok(db
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='history_journal'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// Discards the index and starts a rebuild under a new epoch. Every change up
/// to the current head is covered by the rebuild, which reads current state.
fn reset(tx: &Connection, state: &IndexState) -> Result<()> {
    let head = journal_head(tx)?;
    tx.execute_batch("DELETE FROM history_fts; DELETE FROM history_docs;")?;
    tx.execute("DELETE FROM history_journal WHERE seq<=?1", [head])?;
    tx.execute(
        "UPDATE history_index_state SET version=?1,epoch=?2,applied=?3,rebuilding=1,backfill_after=NULL WHERE id=1",
        params![core::INDEX_VERSION, state.epoch.max(0) + 1, head],
    )?;
    Ok(())
}

/// Makes the index match one message's current state: indexed when it exists,
/// absent when it was deleted.
fn index_message(tx: &Connection, id: &str, observed_at: Option<i64>) -> Result<()> {
    let data: Option<String> = tx
        .query_row("SELECT data FROM messages WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    let doc: Option<i64> = tx
        .query_row(
            "SELECT doc FROM history_docs WHERE message_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(doc) = doc {
        tx.execute("DELETE FROM history_fts WHERE rowid=?1", [doc])?;
    }
    let Some(data) = data else {
        tx.execute("DELETE FROM history_docs WHERE message_id=?1", [id])?;
        return Ok(());
    };
    // An unreadable record stays searchable by nothing rather than stopping
    // the indexer; the durable record itself is untouched.
    let (body, notes) = match serde_json::from_str::<Message>(&data) {
        Ok(message) => (
            message.text,
            core::feedback_text(message.review_feedback.as_ref()),
        ),
        Err(_) => (String::new(), String::new()),
    };
    let doc = match doc {
        Some(doc) => doc,
        None => tx.query_row(
            "INSERT INTO history_docs(message_id,observed_at) VALUES(?1,?2) RETURNING doc",
            params![id, observed_at],
            |row| row.get(0),
        )?,
    };
    tx.execute(
        "INSERT INTO history_fts(rowid,body,notes) VALUES(?1,?2,?3)",
        params![doc, body, notes],
    )?;
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(request: &Value) -> Result<T> {
    T::deserialize(request).map_err(|error| anyhow!("Invalid request: {error}"))
}

fn reply<T: serde::Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}
