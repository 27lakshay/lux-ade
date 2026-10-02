//! External session import (F042).
//!
//! Reads native Claude Code and Codex sessions from their on-disk stores and
//! records them as read-only conversations with status `imported`. The native
//! session reference and source file are kept in `history_imports`, one row
//! per provider and native session ID, which makes the import idempotent: a
//! repeat adds only records the native session appended since, and refuses a
//! native history that no longer starts with what was imported. Imported
//! messages enter the history search index through the ordinary `messages`
//! triggers.
//!
//! ADE does not resume an imported session (decision D04: record the actual
//! capability). Every import reports `resumable: false` with the reason, and
//! the conversation commands refuse to send to an imported conversation.
//!
//! The parsers are pure (`claude`, `codex`, `parse`); this file owns the
//! filesystem reads and the one database transaction.
use crate::model::{Conversation, Message, new_id, now_ms};
use ade_core::contract::history::*;
use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

mod claude;
use ade_core::native_history::{codex, parse};
pub(crate) mod native_page;

use parse::{Parsed, Plan, Prior};

/// The status an imported conversation carries. Send, queue and resume refuse
/// it, and the prompt queue never dispatches it.
pub const IMPORTED_STATUS: &str = "imported";
pub const RESUME_UNAVAILABLE: &str = "ADE shows imported native sessions read-only and cannot \
     resume them yet; continue the work in a new conversation";

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS history_imports(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  provider TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT,
  source_path TEXT NOT NULL,
  native_cwd TEXT,
  item_count INTEGER NOT NULL,
  digest TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  UNIQUE(provider, native_session_id)
);
";

/// Native files larger than this are refused rather than read into memory.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// How much of each file a scan reads for its metadata.
const SCAN_PREFIX_BYTES: u64 = 256 * 1024;
/// The newest files a scan considers; `more` reports anything beyond.
const SCAN_FILES: usize = 2000;

pub fn ensure_table(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA)?;
    Ok(())
}

/// One provider's native session store.
pub struct NativeStore {
    pub provider: HistoryImportProvider,
    pub account_id: Option<String>,
    /// The provider's config home: `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
    pub home: PathBuf,
}

impl NativeStore {
    /// The daemon user's own store, from the provider's environment variable
    /// or its default under `HOME`.
    pub fn default_for(provider: HistoryImportProvider) -> Result<Self> {
        let (variable, fallback) = match provider {
            HistoryImportProvider::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            HistoryImportProvider::Codex => ("CODEX_HOME", ".codex"),
        };
        let home = match std::env::var_os(variable).map(PathBuf::from) {
            Some(home) if home.is_absolute() => home,
            _ => std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|home| home.is_absolute())
                .context("HOME is not an absolute path; the native session store is unknown")?
                .join(fallback),
        };
        Ok(Self {
            provider,
            account_id: None,
            home,
        })
    }

    fn roots(&self) -> Vec<PathBuf> {
        match self.provider {
            HistoryImportProvider::Claude => vec![self.home.join("projects")],
            HistoryImportProvider::Codex => {
                vec![
                    self.home.join("sessions"),
                    self.home.join("archived_sessions"),
                ]
            }
        }
    }

    fn describe(&self) -> String {
        match self.provider {
            HistoryImportProvider::Claude => self.home.join("projects"),
            HistoryImportProvider::Codex => self.home.clone(),
        }
        .to_string_lossy()
        .into_owned()
    }

    /// Every session file in the store with its native session ID, or why
    /// the store cannot be read.
    fn session_files(&self) -> Result<Vec<(String, PathBuf)>> {
        let roots = self.roots();
        ensure!(
            roots[0].is_dir(),
            "No {} session store at {}",
            provider_name(self.provider),
            roots[0].display()
        );
        let mut files = Vec::new();
        for root in roots.iter().filter(|root| root.is_dir()) {
            // Claude: projects/<project>/<id>.jsonl. Codex: sessions/YYYY/MM/DD/
            // rollout-*.jsonl, and archived_sessions/rollout-*.jsonl.
            let depth = match self.provider {
                HistoryImportProvider::Claude => 1,
                HistoryImportProvider::Codex => 3,
            };
            collect(root, depth, &mut |path| {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if let Some(id) = file_session_id(self.provider, name) {
                    files.push((id.to_owned(), path.to_owned()));
                }
            })?;
        }
        Ok(files)
    }
}

fn provider_name(provider: HistoryImportProvider) -> &'static str {
    match provider {
        HistoryImportProvider::Claude => "Claude Code",
        HistoryImportProvider::Codex => "Codex",
    }
}

/// Visits regular files up to `depth` directories below `root`, without
/// following symbolic links inside the store.
fn collect(root: &Path, depth: usize, visit: &mut dyn FnMut(&Path)) -> Result<()> {
    for entry in
        std::fs::read_dir(root).with_context(|| format!("Cannot read {}", root.display()))?
    {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_file() {
            visit(&entry.path());
        } else if kind.is_dir() && depth > 0 {
            collect(&entry.path(), depth - 1, visit)?;
        }
    }
    Ok(())
}

/// A native session ID in canonical UUID form.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && id.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

/// The session ID a store file name carries: `<id>.jsonl` for Claude Code,
/// `rollout-<time>-<id>.jsonl` for Codex.
fn file_session_id(provider: HistoryImportProvider, name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    let id = match provider {
        HistoryImportProvider::Claude => stem,
        HistoryImportProvider::Codex => {
            let rest = stem.strip_prefix("rollout-")?;
            rest.get(rest.len().checked_sub(36)?..)?
        }
    };
    valid_session_id(id).then_some(id)
}

fn read(path: &Path, prefix: Option<u64>) -> Result<(String, u64, i64)> {
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "{} is not a regular file",
        path.display()
    );
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |age| age.as_millis().min(i64::MAX as u128) as i64);
    let mut bytes = Vec::new();
    match prefix {
        Some(limit) => {
            file.take(limit).read_to_end(&mut bytes)?;
            Ok((String::from_utf8_lossy(&bytes).into_owned(), size, modified))
        }
        None => {
            ensure!(
                size <= MAX_FILE_BYTES,
                "The native session file is larger than {} MiB; ADE does not import it",
                MAX_FILE_BYTES / 1024 / 1024
            );
            file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 <= MAX_FILE_BYTES,
                "The native session file grew past the import limit while it was read"
            );
            ensure!(
                ade_core::json_budget::within_budget(&bytes, MAX_FILE_BYTES as usize),
                ade_core::error::Failure::ResourceLimit
            );
            let text = String::from_utf8(bytes)
                .map_err(|_| anyhow!("The native session file is not valid UTF-8"))?;
            Ok((text, size, modified))
        }
    }
}

fn parse_text(provider: HistoryImportProvider, text: &str) -> Parsed {
    match provider {
        HistoryImportProvider::Claude => claude::parse(text),
        HistoryImportProvider::Codex => codex::parse(text),
    }
}

fn codex_titles(store: &NativeStore) -> std::collections::HashMap<String, String> {
    if store.provider != HistoryImportProvider::Codex {
        return Default::default();
    }
    read(
        &store.home.join("session_index.jsonl"),
        Some(MAX_FILE_BYTES),
    )
    .map(|(text, _, _)| codex::index_titles(&text))
    .unwrap_or_default()
}

/// Whether a native working directory is `root` or lies inside it.
fn within(cwd: &str, root: &Path) -> bool {
    Path::new(cwd).starts_with(root)
}

/// Lists the store's sessions, newest first, reading only the start of each
/// file. It touches no database; [`mark_imported`] fills in earlier imports.
pub fn scan(store: &NativeStore, workspace_root: Option<&Path>, limit: usize) -> HistoryImportScan {
    let mut reply = HistoryImportScan {
        tag: Default::default(),
        store: HistoryImportStore {
            provider: store.provider,
            account_id: store.account_id.clone(),
            root: store.describe(),
            available: true,
            unavailable_reason: None,
        },
        sessions: Vec::new(),
        more: false,
        unreadable: 0,
    };
    let files = match store.session_files() {
        Ok(files) => files,
        Err(error) => {
            reply.store.available = false;
            reply.store.unavailable_reason = Some(format!("{error:#}"));
            return reply;
        }
    };
    let titles = codex_titles(store);
    let mut stamped: Vec<(i64, String, PathBuf)> = files
        .into_iter()
        .map(|(id, path)| {
            let modified = std::fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |age| age.as_millis().min(i64::MAX as u128) as i64);
            (modified, id, path)
        })
        .collect();
    stamped.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    if stamped.len() > SCAN_FILES {
        stamped.truncate(SCAN_FILES);
        reply.more = true;
    }
    for (_, id, path) in stamped {
        let Ok((text, size_bytes, modified_at)) = read(&path, Some(SCAN_PREFIX_BYTES)) else {
            reply.unreadable += 1;
            continue;
        };
        let parsed = parse_text(store.provider, &text);
        if let Some(root) = workspace_root
            && !parsed.cwd.as_deref().is_some_and(|cwd| within(cwd, root))
        {
            continue;
        }
        if reply.sessions.len() == limit {
            reply.more = true;
            break;
        }
        reply.sessions.push(HistoryImportCandidate {
            title: titles.get(&id).cloned().or(parsed.title),
            native_session_id: id,
            cwd: parsed.cwd,
            modified_at,
            size_bytes,
            source_path: path.to_string_lossy().into_owned(),
            imported_conversation_id: None,
        });
    }
    reply
}

/// Names the conversation each already-imported candidate became.
pub fn mark_imported(
    db: &Connection,
    provider: HistoryImportProvider,
    sessions: &mut [HistoryImportCandidate],
) -> Result<()> {
    let mut statement = db.prepare(
        "SELECT conversation_id FROM history_imports WHERE provider=?1 AND native_session_id=?2",
    )?;
    for session in sessions {
        session.imported_conversation_id = statement
            .query_row(params![provider.id(), session.native_session_id], |row| {
                row.get(0)
            })
            .optional()?;
    }
    Ok(())
}

/// A native session read in full and checked against the ID it was asked for.
pub struct NativeSession {
    pub path: PathBuf,
    pub parsed: Parsed,
}

/// Finds and parses one native session. Refuses an ID that names no file,
/// or several, and a file whose records name a different session.
pub fn read_session(store: &NativeStore, id: &str) -> Result<NativeSession> {
    ensure!(
        valid_session_id(id),
        "Native session ID must be a UUID such as 01a076ee-e1bb-71a1-9a20-d12ac6dc30ea"
    );
    let id = id.to_ascii_lowercase();
    let matches: Vec<PathBuf> = store
        .session_files()?
        .into_iter()
        .filter(|(file_id, _)| file_id.eq_ignore_ascii_case(&id))
        .map(|(_, path)| path)
        .collect();
    let path = match matches.as_slice() {
        [] => bail!(
            "No {} session {id} in {}",
            provider_name(store.provider),
            store.describe()
        ),
        [path] => path.clone(),
        _ => bail!(
            "{} files claim session {id}; ADE will not choose between them",
            matches.len()
        ),
    };
    let (text, _, _) = read(&path, None)?;
    let mut parsed = parse_text(store.provider, &text);
    ensure!(
        !parsed.budget_exceeded,
        ade_core::error::Failure::ResourceLimit
    );
    ensure!(
        parsed
            .session_id
            .as_deref()
            .is_some_and(|recorded| recorded.eq_ignore_ascii_case(&id)),
        "{} records a different or no session ID; ADE did not import it",
        path.display()
    );
    if let Some(title) = codex_titles(store).remove(&id) {
        parsed.title = Some(title);
    }
    Ok(NativeSession { path, parsed })
}

fn message_id(provider: HistoryImportProvider, session: &str, key: &str) -> String {
    format!("import:{}:{session}:{key}", provider.id())
}

/// The import metadata of one conversation, read with a history query.
pub struct ImportRow {
    pub native_session_id: String,
    pub source: HistoryImportSource,
}

impl ImportRow {
    /// Reads the five import columns a history query selects in this order:
    /// native session ID, source path, native cwd, account ID, imported at.
    pub fn from_row(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<Option<Self>> {
        let Some(native_session_id) = row.get::<_, Option<String>>(first)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            native_session_id,
            source: HistoryImportSource {
                source_path: row.get(first + 1)?,
                native_cwd: row.get(first + 2)?,
                account_id: row.get(first + 3)?,
                imported_at: row.get(first + 4)?,
                resumable: false,
                resume_unavailable_reason: Some(RESUME_UNAVAILABLE.into()),
            },
        }))
    }
}

/// The request-side facts of one import.
pub struct ImportTarget<'a> {
    pub provider: HistoryImportProvider,
    pub native_session_id: &'a str,
    pub workspace_id: &'a str,
    pub account_id: Option<&'a str>,
}

/// Records one native session as a read-only conversation in one
/// transaction on the profile database, following [`parse::plan`].
pub fn commit(
    db: &Connection,
    target: &ImportTarget<'_>,
    session: &NativeSession,
) -> Result<(HistoryImported, Conversation)> {
    let provider = target.provider.id();
    let id = target.native_session_id.to_ascii_lowercase();
    let items = &session.parsed.items;
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    ensure_table(&tx)?;
    let workspace_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?1)",
        [target.workspace_id],
        |row| row.get(0),
    )?;
    ensure!(
        workspace_exists,
        "Unknown workspace ID: {}",
        target.workspace_id
    );
    let prior: Option<(String, Prior)> = tx
        .query_row(
            "SELECT conversation_id,workspace_id,item_count,digest FROM history_imports
             WHERE provider=?1 AND native_session_id=?2",
            params![provider, id],
            |row| {
                Ok((
                    row.get(0)?,
                    Prior {
                        workspace_id: row.get(1)?,
                        item_count: row.get::<_, i64>(2)?.try_into().unwrap_or(usize::MAX),
                        digest: row.get(3)?,
                    },
                ))
            },
        )
        .optional()?;
    let now = now_ms();
    let last_at = session.parsed.last_at.unwrap_or(now);
    let (known, mut conversation) = match parse::plan(
        prior.as_ref().map(|(_, prior)| prior),
        target.workspace_id,
        items,
    ) {
        Plan::Refuse(reason) => bail!(reason),
        Plan::Create => {
            let conversation = Conversation {
                queue_paused: false,
                queue_resumed_during: None,
                stop: None,
                settings_revision: 0,
                native_settings: None,
                execution: None,
                background: None,
                autonomous_output_at_ms: None,
                runtime_run: None,
                runtime_cursor: 0,
                runtime_submission: None,
                id: new_id("conversation"),
                workspace_id: target.workspace_id.into(),
                title: session.parsed.title.clone().unwrap_or_else(|| {
                    format!("Imported {} session", provider_name(target.provider))
                }),
                provider: provider.into(),
                account_id: None,
                account_context: crate::model::AccountContext::Ambient,
                execution_host: None,
                provider_config: Default::default(),
                provider_thread_id: None,
                status: IMPORTED_STATUS.into(),
                active_turn_id: None,
                error: None,
                updated_at: last_at,
                attention: Default::default(),
                unread: false,
                parent_conversation_id: None,
                group_id: None,
            };
            tx.execute(
                "INSERT INTO conversations VALUES(?1,?2,?3)",
                params![
                    conversation.id,
                    conversation.workspace_id,
                    serde_json::to_string(&conversation)?
                ],
            )?;
            (0, conversation)
        }
        Plan::Extend { known } => {
            let (conversation_id, _) = prior.as_ref().context("Import record is missing")?;
            let data: String = tx
                .query_row(
                    "SELECT data FROM conversations WHERE id=?1",
                    [conversation_id],
                    |row| row.get(0),
                )
                .optional()?
                .context("The imported conversation is missing; ADE did not re-import")?;
            let conversation: Conversation = serde_json::from_str(&data)?;
            ensure!(
                conversation.status == IMPORTED_STATUS,
                "The imported conversation is no longer read-only; ADE did not re-import"
            );
            (known, conversation)
        }
    };
    let mut added = 0_u64;
    let mut updated = 0_u64;
    let mut next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?1",
        [&conversation.id],
        |row| row.get(0),
    )?;
    for (index, item) in items.iter().enumerate() {
        let content = item
            .content
            .clone()
            .filter(|content| content.validate().is_ok());
        let mut message = Message {
            content,
            review_feedback: None,
            delivery: None,
            id: message_id(target.provider, &id, &item.key),
            conversation_id: conversation.id.clone(),
            role: item.role.into(),
            kind: item.kind.into(),
            text: item.text.clone(),
            status: "completed".into(),
            turn_id: None,
            provider_item_id: Some(item.key.clone()),
            native_message: None,
            sequence: 0,
            attachments: vec![],
        };
        if index < known {
            let existing: String = tx
                .query_row(
                    "SELECT data FROM messages WHERE id=?1 AND conversation_id=?2",
                    params![message.id, conversation.id],
                    |row| row.get(0),
                )
                .optional()?
                .context("An imported message is missing; ADE did not re-import")?;
            let existing: Message = serde_json::from_str(&existing)?;
            message.sequence = existing.sequence;
            if existing != message {
                tx.execute(
                    "UPDATE messages SET data=?2 WHERE id=?1",
                    params![message.id, serde_json::to_string(&message)?],
                )?;
                updated += 1;
            }
        } else {
            message.sequence = next;
            next += 1;
            tx.execute(
                "INSERT INTO messages(id,conversation_id,provider_item_id,sequence,data) VALUES(?1,?2,?3,?4,?5)",
                params![
                    message.id,
                    message.conversation_id,
                    message.provider_item_id,
                    message.sequence,
                    serde_json::to_string(&message)?
                ],
            )
            .context("An imported message ID is already in use")?;
            crate::store::record_news(
                &tx,
                &message.conversation_id,
                message.sequence,
                &message.role,
            )?;
            added += 1;
        }
    }
    if prior.is_none() {
        // A first import is old work, not news: it starts read.
        crate::store::seen_as_is(&tx, &conversation.id)?;
    }
    let source_path = session.path.to_string_lossy().into_owned();
    let outcome = if prior.is_none() {
        HistoryImportOutcome::Imported
    } else if added + updated == 0 {
        HistoryImportOutcome::Unchanged
    } else {
        HistoryImportOutcome::Appended
    };
    if outcome != HistoryImportOutcome::Unchanged {
        conversation.updated_at = conversation.updated_at.max(last_at);
        tx.execute(
            "UPDATE conversations SET data=?2 WHERE id=?1",
            params![conversation.id, serde_json::to_string(&conversation)?],
        )?;
        tx.execute(
            "INSERT INTO history_imports VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(provider,native_session_id) DO UPDATE SET account_id=excluded.account_id,
               source_path=excluded.source_path,native_cwd=excluded.native_cwd,
               item_count=excluded.item_count,digest=excluded.digest,imported_at=excluded.imported_at",
            params![
                conversation.id,
                provider,
                id,
                target.workspace_id,
                target.account_id,
                source_path,
                session.parsed.cwd,
                items.len() as i64,
                parse::digest(items),
                now,
            ],
        )?;
    }
    let (account_id, native_cwd, imported_at): (Option<String>, Option<String>, i64) = tx
        .query_row(
            "SELECT account_id,native_cwd,imported_at FROM history_imports WHERE conversation_id=?1",
            [&conversation.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    tx.commit()?;
    let reply = HistoryImported {
        tag: Default::default(),
        outcome,
        conversation: HistoryConversation {
            status: conversation.status.clone(),
            message_count: items.len() as u64,
            provenance: HistoryProvenance {
                conversation_id: conversation.id.clone(),
                conversation_title: conversation.title.clone(),
                provider: conversation.provider.clone(),
                workspace_id: conversation.workspace_id.clone(),
                account_id: None,
                native_session_id: Some(id),
                conversation_updated_at: conversation.updated_at,
                import: Some(HistoryImportSource {
                    source_path,
                    native_cwd,
                    account_id,
                    imported_at,
                    resumable: false,
                    resume_unavailable_reason: Some(RESUME_UNAVAILABLE.into()),
                }),
            },
        },
        added_messages: added,
        updated_messages: updated,
        skipped_records: session.parsed.skipped,
        incomplete_tail: session.parsed.incomplete_tail,
    };
    Ok((reply, conversation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_file_names_carry_the_session_id() {
        let id = "01a076ee-e1bb-71a1-9a20-d12ac6dc30ea";
        assert_eq!(
            file_session_id(HistoryImportProvider::Claude, &format!("{id}.jsonl")),
            Some(id)
        );
        assert_eq!(
            file_session_id(
                HistoryImportProvider::Codex,
                &format!("rollout-2026-09-06T19-06-02-{id}.jsonl")
            ),
            Some(id)
        );
        for name in [
            "notes.jsonl",
            "rollout-x.jsonl",
            "../01a076ee-e1bb-71a1-9a20-d12ac6dc30ea.jsonl",
        ] {
            assert_eq!(file_session_id(HistoryImportProvider::Claude, name), None);
            assert_eq!(file_session_id(HistoryImportProvider::Codex, name), None);
        }
        assert!(!valid_session_id("01a076ee/e1bb-71a1-9a20-d12ac6dc30ea"));
    }

    #[test]
    fn workspace_filtering_matches_whole_path_components() {
        assert!(within("/work/app", Path::new("/work/app")));
        assert!(within("/work/app/sub", Path::new("/work/app")));
        assert!(!within("/work/application", Path::new("/work/app")));
    }
}
