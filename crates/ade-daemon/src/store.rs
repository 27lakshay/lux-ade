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
pub(crate) struct CatalogBindingClaim {
    workspace: Option<(u64, u64)>,
    repository: Option<(String, Option<(u64, u64)>)>,
}
#[derive(Serialize)]
pub struct WorkspaceRebindEntry {
    id: String,
    root: String,
    name: String,
    needs_rebind: bool,
    rebindable: bool,
}
fn binding_matches(db: &Connection, kind: &str, id: &str, root: &str) -> Result<bool> {
    let saved: Option<(String, String)> = db
        .query_row(
            "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((device, inode)) = saved else {
        return Ok(false);
    };
    let Ok(metadata) = std::fs::metadata(root) else {
        return Ok(false);
    };
    Ok(metadata.is_dir()
        && device == metadata.dev().to_string()
        && inode == metadata.ino().to_string())
}
fn current_binding_identity(db: &Connection, kind: &str, id: &str) -> Result<Option<(u64, u64)>> {
    let saved: Option<(String, String)> = db
        .query_row(
            "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    saved
        .map(|(device, inode)| Ok((device.parse()?, inode.parse()?)))
        .transpose()
}
fn physical_binding_matches(root: &str, expected: Option<(u64, u64)>) -> bool {
    expected.is_some_and(|expected| {
        std::fs::metadata(root)
            .is_ok_and(|metadata| metadata.is_dir() && (metadata.dev(), metadata.ino()) == expected)
    })
}
pub(crate) fn probe_catalog_bindings(catalog: &mut Catalogue, claims: &[CatalogBindingClaim]) {
    if cfg!(debug_assertions)
        && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
        && let Ok(directory) = std::env::var("ADE_E2E_CATALOG_PAUSE_DIR")
        && Path::new(&directory).join("armed").exists()
    {
        let directory = Path::new(&directory);
        let _ = std::fs::write(directory.join("signal"), b"");
        for _ in 0..500 {
            if directory.join("release").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    for (workspace, claim) in catalog.workspaces.iter_mut().zip(claims) {
        let repository_unbound = claim.repository.as_ref().is_some_and(|(root, expected)| {
            !physical_binding_matches(root, *expected)
                || !linked_common_matches(&workspace.root, root)
        });
        workspace.needs_rebind |=
            repository_unbound || !physical_binding_matches(&workspace.root, claim.workspace);
    }
}
fn small_git_path(path: &Path, prefix: &str) -> Option<PathBuf> {
    if !std::fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(4097).read_to_string(&mut text).ok()?;
    if text.len() > 4096 {
        return None;
    }
    let value = text.trim_end_matches(['\r', '\n']);
    let value = value.strip_prefix(prefix)?;
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return None;
    }
    Some(PathBuf::from(value))
}
fn linked_common_matches(workspace_root: &str, repository_root: &str) -> bool {
    // This runs while the store mutex is held. Inspect the standard on-disk
    // Git layout directly so catalogue polling cannot wait on a Git child.
    // Unrecognized layouts fail closed and can be explicitly rebound.
    let Some(expected) = std::fs::canonicalize(repository_root).ok() else {
        return false;
    };
    let root = Path::new(workspace_root);
    for ancestor in root.ancestors() {
        let dot_git = ancestor.join(".git");
        match std::fs::symlink_metadata(&dot_git) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
        let Ok(metadata) = std::fs::metadata(&dot_git) else {
            return false;
        };
        let git_dir = if metadata.is_dir() {
            dot_git
        } else if metadata.is_file() {
            let Some(pointer) = small_git_path(&dot_git, "gitdir: ") else {
                return false;
            };
            if pointer.is_absolute() {
                pointer
            } else {
                ancestor.join(pointer)
            }
        } else {
            return false;
        };
        let Some(git_dir) = std::fs::canonicalize(git_dir).ok() else {
            return false;
        };
        let common_file = git_dir.join("commondir");
        let common = match std::fs::symlink_metadata(&common_file) {
            Ok(_) => {
                let Some(pointer) = small_git_path(&common_file, "") else {
                    return false;
                };
                if pointer.is_absolute() {
                    pointer
                } else {
                    git_dir.join(pointer)
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => git_dir,
            Err(_) => return false,
        };
        return std::fs::canonicalize(common).is_ok_and(|common| common == expected);
    }
    // A bare repository has no .git entry; its root is the common directory.
    root == expected
        && root.join("HEAD").is_file()
        && root.join("objects").is_dir()
        && root.join("refs").is_dir()
}
fn saved_binding_identity(db: &Connection, kind: &str, id: &str) -> Result<Option<(u64, u64)>> {
    let saved: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT source_device,source_inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    saved
        .and_then(|(device, inode)| device.zip(inode))
        .map(|(device, inode)| Ok((device.parse()?, inode.parse()?)))
        .transpose()
}
fn write_binding(db: &Connection, kind: &str, id: &str, root: &str) -> Result<()> {
    let metadata = std::fs::metadata(root).context("Selected directory is unavailable")?;
    ensure!(metadata.is_dir(), "Selected path must be a directory");
    write_binding_identity(db, kind, id, (metadata.dev(), metadata.ino()))
}
fn write_binding_identity(
    db: &Connection,
    kind: &str,
    id: &str,
    identity: (u64, u64),
) -> Result<()> {
    db.execute("INSERT INTO path_bindings(kind,id,device,inode,source_device,source_inode) VALUES(?1,?2,?3,?4,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET device=excluded.device,inode=excluded.inode",
        params![kind, id, identity.0.to_string(), identity.1.to_string()])?;
    Ok(())
}
fn ensure_not_source_directory(db: &Connection, root: &str) -> Result<()> {
    let mut rows = db.prepare("SELECT source_device,source_inode FROM path_bindings WHERE source_device IS NOT NULL AND source_inode IS NOT NULL")?;
    let sources: Vec<(String, String)> = rows
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for ancestor in Path::new(root).ancestors() {
        let Ok(metadata) = std::fs::metadata(ancestor) else {
            continue;
        };
        ensure!(
            !sources
                .iter()
                .any(|(device, inode)| device == &metadata.dev().to_string()
                    && inode == &metadata.ino().to_string()),
            "Selected directory belongs to a saved source workspace or repository"
        );
    }
    Ok(())
}
fn verify_binding_identity(root: &str, identity: (u64, u64)) -> Result<()> {
    let metadata = std::fs::metadata(root).context("Selected directory is unavailable")?;
    ensure!(
        metadata.is_dir() && (metadata.dev(), metadata.ino()) == identity,
        "Selected directory changed during rebind"
    );
    Ok(())
}

#[derive(Serialize)]
pub struct AttachmentReclaimPreview {
    pub attachment_id: String,
    pub conversation_id: String,
    pub generation: String,
    pub state: String,
    pub created_at: i64,
    pub payload_bytes: i64,
    pub estimated_reusable_payload_bytes: i64,
    pub protected_by: Vec<String>,
    pub reclaimable: bool,
}

fn attachment_reclaim_preview_from(
    db: &Connection,
    conversation: &str,
    id: &str,
) -> Result<AttachmentReclaimPreview> {
    one::<Conversation>(db, "conversations", conversation)?;
    check_id(id)?;
    let (owner, metadata, generation, state, created_at, payload_bytes):
        (String, String, String, String, i64, i64) = db
        .query_row(
            "SELECT conversation_id,metadata,generation,state,created_at,length(data) FROM attachments WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .context("Attachment is unavailable")?;
    ensure!(
        owner == conversation,
        "Attachment belongs to another Conversation"
    );
    ensure!(
        matches!(state.as_str(), "live" | "discarded"),
        "Attachment state is invalid"
    );
    let attachment: Attachment = decode(metadata)?;
    ensure!(
        !generation.is_empty()
            && attachment.id == id
            && ((state == "live" && payload_bytes == attachment.size as i64)
                || (state == "discarded" && payload_bytes == 0)),
        "Attachment payload or generation is invalid"
    );
    let mut protected_by = Vec::new();
    for (name, query) in [
        (
            "message",
            "SELECT EXISTS(SELECT 1 FROM messages m, json_each(m.data,'$.attachments') a WHERE m.conversation_id=?1 AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "draft",
            "SELECT EXISTS(SELECT 1 FROM drafts d, json_each(d.attachments) a WHERE d.conversation_id=?1 AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "queued_prompt",
            "SELECT EXISTS(SELECT 1 FROM queued_prompts q, json_each(q.attachments) a WHERE q.conversation_id=?1 AND q.status='queued' AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "send_intent",
            "SELECT EXISTS(SELECT 1 FROM send_intents s, json_each(s.attachments) a WHERE s.conversation_id=?1 AND s.state IN ('pending','rejected') AND json_extract(a.value,'$.id')=?2)",
        ),
    ] {
        let found: i64 = db.query_row(query, params![conversation, id], |row| row.get(0))?;
        if found != 0 {
            protected_by.push(name.to_owned());
        }
    }
    if state == "discarded" {
        protected_by.push("already_discarded".to_owned());
    }
    let reclaimable = protected_by.is_empty();
    Ok(AttachmentReclaimPreview {
        attachment_id: id.to_owned(),
        conversation_id: conversation.to_owned(),
        generation,
        state,
        created_at,
        payload_bytes,
        estimated_reusable_payload_bytes: if reclaimable { payload_bytes } else { 0 },
        protected_by,
        reclaimable,
    })
}

#[derive(Clone, Serialize)]
pub struct SendIntent {
    pub request_id: String,
    pub conversation_id: String,
    pub window_id: String,
    pub draft_revision: i64,
    pub draft_text: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub state: String,
    pub review_anchor: Option<serde_json::Value>,
    pub review_feedback: Option<serde_json::Value>,
}

fn send_intent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendIntent> {
    let stored: Option<serde_json::Value> = row
        .get::<_, Option<String>>(8)?
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let is_batch = stored
        .as_ref()
        .is_some_and(|value| value["format"] == "ade-review-feedback-v1");
    Ok(SendIntent {
        request_id: row.get(0)?,
        conversation_id: row.get(1)?,
        window_id: row.get(2)?,
        draft_revision: row.get(3)?,
        draft_text: row.get(4)?,
        text: row.get(5)?,
        attachments: attachment_row(row, 6)?,
        state: row.get(7)?,
        review_anchor: if is_batch { None } else { stored.clone() },
        review_feedback: if is_batch { stored } else { None },
    })
}

fn draft_from(db: &Connection, conversation: &str, window: &str) -> Result<Draft> {
    one::<Conversation>(db, "conversations", conversation)?;
    check_id(window)?;
    Ok(db.query_row("SELECT text,revision,attachments FROM drafts WHERE conversation_id=?1 AND window_id=?2",
        params![conversation,window], |row| Ok(Draft { text: row.get(0)?, revision: row.get(1)?,
            attachments: attachment_row(row, 2)? })).optional()?.unwrap_or_default())
}

pub(crate) fn forget_terminal_views(tx: &Connection, terminal: &str) -> Result<()> {
    for mut window in all::<WindowRecord>(tx, "SELECT data FROM windows")? {
        window.tabs.terminals.retain(|tab| tab.id != terminal);
        window
            .tabs
            .closed_terminals
            .retain(|tab| tab.id != terminal);
        if window.tabs.active_terminal.as_deref() == Some(terminal) {
            window.tabs.active_terminal = None;
        }
        tx.execute(
            "UPDATE windows SET data=?2 WHERE id=?1",
            params![window.id, encode(&window)?],
        )?;
    }
    Ok(())
}

fn decode<T: DeserializeOwned>(value: String) -> Result<T> {
    Ok(serde_json::from_str(&value)?)
}
fn encode(value: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn attachment_row(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Vec<Attachment>> {
    let value: String = row.get(column)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
fn validate_attachments(
    db: &Connection,
    conversation: &str,
    attachments: &[Attachment],
) -> Result<()> {
    ensure!(
        attachments.len() <= crate::prompt::ATTACHMENT_COUNT,
        "Limit of 8 attachments per prompt"
    );
    let mut ids = std::collections::HashSet::new();
    let mut bytes = 0usize;
    for attachment in attachments {
        ensure!(ids.insert(&attachment.id), "Duplicate attachment");
        let (owner, metadata, state, size): (String, String, String, i64) = db
            .query_row(
                "SELECT conversation_id,metadata,state,length(data) FROM attachments WHERE id=?1",
                [&attachment.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .context("Attachment is missing; attach the file again")?;
        ensure!(
            owner == conversation
                && state == "live"
                && size == attachment.size as i64
                && decode::<Attachment>(metadata)? == *attachment,
            "Attachment is unavailable, belongs to another Conversation, or its metadata changed"
        );
        bytes = bytes
            .checked_add(attachment.size)
            .context("Attachment size overflow")?;
    }
    ensure!(
        bytes <= crate::prompt::ATTACHMENT_LIMIT,
        "Attachments exceed 8 MiB per prompt"
    );
    Ok(())
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
fn message_by_id(db: &Connection, id: &str) -> Result<Option<Message>> {
    db.query_row("SELECT data FROM messages WHERE id=?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()?
    .map(decode)
    .transpose()
}
fn next_sequence(db: &Connection, conversation: &str) -> Result<i64> {
    let current: i64 = db.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM messages WHERE conversation_id=?1",
        [conversation],
        |r| r.get(0),
    )?;
    current.checked_add(1).context("Message sequence exhausted")
}
fn write_conversation(db: &Connection, conversation: &Conversation) -> Result<()> {
    let old: Conversation = one(db, "conversations", &conversation.id)?;
    ensure!(
        old.workspace_id == conversation.workspace_id
            && old.provider == conversation.provider
            && old.account_id == conversation.account_id
            && old.account_context == conversation.account_context,
        "Conversation identity cannot change"
    );
    check_text(&conversation.title)?;
    if let Some(error) = &conversation.error {
        check_text(error)?;
    }
    db.execute(
        "UPDATE conversations SET data=?2 WHERE id=?1",
        params![conversation.id, encode(conversation)?],
    )?;
    Ok(())
}
fn write_message(db: &Connection, message: &Message) -> Result<()> {
    db.execute("INSERT INTO messages(id,conversation_id,provider_item_id,sequence,data) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET provider_item_id=excluded.provider_item_id,data=excluded.data",
        params![message.id,message.conversation_id,message.provider_item_id,message.sequence,encode(message)?])?;
    Ok(())
}

impl Store {
    pub fn attach(
        &self,
        conversation: &str,
        id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<Attachment> {
        check_id(id)?;
        self.conversation(conversation)?;
        ensure!(
            !name.is_empty() && name.len() <= 255 && !name.contains(['\0', '\n', '\r']),
            "Invalid attachment name"
        );
        let media_type = crate::prompt::media_type(bytes)?;
        let attachment = Attachment {
            id: id.into(),
            name: name.into(),
            media_type: media_type.into(),
            size: bytes.len(),
        };
        let tx = self.transaction()?;
        let prior: Option<(String, String, Vec<u8>, String)> = tx
            .query_row(
                "SELECT conversation_id,metadata,data,state FROM attachments WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((owner, metadata, data, state)) = prior {
            ensure!(
                state == "live"
                    && owner == conversation
                    && decode::<Attachment>(metadata)? == attachment
                    && data == bytes,
                "Attachment ID was already used or discarded"
            );
            return Ok(attachment);
        }
        let total: i64 = tx.query_row(
            "SELECT COALESCE(sum(length(data)),0) FROM attachments WHERE conversation_id=?1",
            [conversation],
            |row| row.get(0),
        )?;
        ensure!(
            total + bytes.len() as i64 <= 128 * 1024 * 1024,
            "Conversation attachment storage exceeds 128 MiB"
        );
        tx.execute(
            "INSERT INTO attachments(id,conversation_id,metadata,data,generation,state,created_at) VALUES(?1,?2,?3,?4,?5,'live',?6)",
            params![id, conversation, encode(&attachment)?, bytes, new_id("attachment_generation"), now_ms()],
        )?;
        tx.commit()?;
        Ok(attachment)
    }
    /// Only an explicit exact-ID discard can reclaim an upload. Unsaved client-held
    /// uploads have no durable reference, so they are never swept automatically.
    pub fn attachment_reclaim_preview(
        &self,
        conversation: &str,
        id: &str,
    ) -> Result<AttachmentReclaimPreview> {
        attachment_reclaim_preview_from(&self.connection, conversation, id)
    }
    pub fn attachment_inspect(&self, conversation: &str, id: &str) -> Result<(Attachment, String)> {
        use sha2::{Digest, Sha256};
        let preview = attachment_reclaim_preview_from(&self.connection, conversation, id)?;
        ensure!(preview.state == "live", "Attachment is unavailable");
        let (metadata, data): (String, Vec<u8>) = self.connection.query_row(
            "SELECT metadata,data FROM attachments WHERE id=?1 AND conversation_id=?2 AND state='live'",
            params![id, conversation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let attachment: Attachment = decode(metadata)?;
        ensure!(
            data.len() == attachment.size,
            "Attachment payload is invalid"
        );
        let digest = Sha256::digest(data);
        Ok((
            attachment,
            digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        ))
    }
    pub fn attachment_reclaim_apply(
        &self,
        conversation: &str,
        id: &str,
        expected_generation: &str,
    ) -> Result<(AttachmentReclaimPreview, i64)> {
        ensure!(
            !expected_generation.is_empty(),
            "Expected attachment generation is required"
        );
        let tx = self.transaction()?;
        let preview = attachment_reclaim_preview_from(&tx, conversation, id)?;
        ensure!(
            preview.generation == expected_generation,
            "Attachment changed since reclaim preview; inspect it again"
        );
        ensure!(
            preview.reclaimable || preview.state == "discarded",
            "Attachment is still referenced; inspect it again before reclaiming"
        );
        if preview.state == "live" {
            ensure!(
                tx.execute(
                    "UPDATE attachments SET data=X'',state='discarded' WHERE id=?1 AND generation=?2 AND state='live'",
                    params![id, expected_generation],
                )? == 1,
                "Attachment changed during reclaim"
            );
        }
        tx.commit()?;
        let reclaimed = if preview.state == "live" {
            preview.payload_bytes
        } else {
            0
        };
        Ok((
            AttachmentReclaimPreview {
                state: "discarded".into(),
                payload_bytes: 0,
                estimated_reusable_payload_bytes: 0,
                protected_by: vec!["already_discarded".into()],
                reclaimable: false,
                ..preview
            },
            reclaimed,
        ))
    }
    pub fn prompt(
        &self,
        conversation: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<crate::prompt::Prompt> {
        use base64::Engine;
        validate_attachments(&self.connection, conversation, attachments)?;
        let content = attachments
            .iter()
            .map(|attachment| {
                let bytes: Vec<u8> = self.connection.query_row(
                    "SELECT data FROM attachments WHERE id=?1 AND state='live'",
                    [&attachment.id],
                    |row| row.get(0),
                )?;
                Ok(crate::prompt::Content {
                    attachment: attachment.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(crate::prompt::Prompt {
            text: text.into(),
            attachments: content,
        })
    }
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        let data_directory = parent.canonicalize()?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            (0..=15).contains(&version),
            "Unsupported database version {version}; preserve the database and use a compatible build"
        );
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        if version == 0 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("
                CREATE TABLE repositories(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
                CREATE TABLE workspaces(id TEXT PRIMARY KEY,repository_id TEXT REFERENCES repositories(id),root TEXT NOT NULL UNIQUE,terminal_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
                CREATE TABLE conversations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),data TEXT NOT NULL);
                CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),provider_item_id TEXT,sequence INTEGER NOT NULL CHECK(sequence>0),data TEXT NOT NULL,UNIQUE(conversation_id,sequence),UNIQUE(conversation_id,provider_item_id));
                CREATE TABLE requests(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),status TEXT NOT NULL,data TEXT NOT NULL);
                CREATE TABLE windows(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),conversation_id TEXT REFERENCES conversations(id),data TEXT NOT NULL);
                PRAGMA user_version=1;
            ")?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let conversations: Vec<Conversation> =
                all(&tx, "SELECT data FROM conversations ORDER BY rowid")?;
            for conversation in conversations {
                conversation
                    .provider_config
                    .validate(&conversation.provider)?;
                write_conversation(&tx, &conversation)?;
            }
            tx.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); PRAGMA user_version=2;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(2,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("PRAGMA user_version=3;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(3,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE drafts(conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), text TEXT NOT NULL, PRIMARY KEY(conversation_id,window_id)); PRAGMA user_version=4;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(4,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE queued_prompts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','submitted','cancelled'))); CREATE INDEX queued_conversations ON queued_prompts(status,conversation_id); PRAGMA user_version=5;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(5,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 6 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE attachments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), metadata TEXT NOT NULL, data BLOB NOT NULL); ALTER TABLE drafts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'; ALTER TABLE queued_prompts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=6;")?;
            // Test-only checkpoint permits a real process kill after migration DDL,
            // before its transaction commits. Production builds have no hook.
            #[cfg(test)]
            migration_interruption_checkpoint();
            tx.execute("INSERT INTO schema_migrations VALUES(6,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 7 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE services(workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id,name)); CREATE TABLE service_ports(workspace_id TEXT NOT NULL, name TEXT NOT NULL, variable TEXT NOT NULL, port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1024 AND 65535), PRIMARY KEY(workspace_id,name,variable), FOREIGN KEY(workspace_id,name) REFERENCES services(workspace_id,name) ON DELETE CASCADE); PRAGMA user_version=7;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(7,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 8 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS send_intents(request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, draft_revision INTEGER NOT NULL CHECK(draft_revision>0), draft_text TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','rejected','aborted','completed'))); CREATE UNIQUE INDEX IF NOT EXISTS pending_send_owner ON send_intents(conversation_id,window_id) WHERE state IN ('pending','rejected'); PRAGMA user_version=8;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(8,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 9 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=9;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(9,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 10 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let rows = {
                let mut statement = tx.prepare("SELECT workspace_id,name,data FROM services")?;
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (workspace, name, data) in rows {
                let mut service: ade_core::services::Service = serde_json::from_str(&data)?;
                if service.identity.is_empty() {
                    service.identity = crate::model::new_id("service");
                    tx.execute(
                        "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2",
                        params![workspace, name, serde_json::to_string(&service)?],
                    )?;
                }
            }
            tx.execute_batch("PRAGMA user_version=10;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(10,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 11 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("ALTER TABLE attachments ADD COLUMN generation TEXT NOT NULL DEFAULT ''; ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','discarded')); ALTER TABLE attachments ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;")?;
            tx.execute(
                "UPDATE attachments SET generation=lower(hex(randomblob(16)))",
                [],
            )?;
            tx.execute_batch("PRAGMA user_version=11;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(11,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 12 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_send_hold = tx
                .prepare("PRAGMA table_info(send_intents)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "restore_hold");
            if !has_send_hold {
                tx.execute_batch("ALTER TABLE send_intents ADD COLUMN restore_hold INTEGER NOT NULL DEFAULT 0 CHECK(restore_hold IN (0,1));")?;
            }
            tx.execute_batch("CREATE TABLE restore_fence(id INTEGER PRIMARY KEY CHECK(id=1), worktree_lifecycle_needs_rebind INTEGER NOT NULL CHECK(worktree_lifecycle_needs_rebind IN (0,1)), restored_from_backup INTEGER NOT NULL CHECK(restored_from_backup IN (0,1))); INSERT INTO restore_fence VALUES(1,0,0); PRAGMA user_version=12;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(12,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 13 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS path_bindings(kind TEXT NOT NULL CHECK(kind IN ('workspace','repository')), id TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL, source_device TEXT, source_inode TEXT, PRIMARY KEY(kind,id));")?;
            let repositories: Vec<Repository> = all(&tx, "SELECT data FROM repositories")?;
            for mut repository in repositories {
                if repository.needs_rebind {
                    continue;
                }
                if std::fs::metadata(&repository.root).is_ok_and(|item| item.is_dir()) {
                    write_binding(&tx, "repository", &repository.id, &repository.root)?;
                } else {
                    repository.needs_rebind = true;
                    tx.execute(
                        "UPDATE repositories SET data=?2 WHERE id=?1",
                        params![repository.id, encode(&repository)?],
                    )?;
                }
            }
            let workspaces: Vec<WorkspaceRecord> = all(&tx, "SELECT data FROM workspaces")?;
            for mut workspace in workspaces {
                if workspace.needs_rebind {
                    continue;
                }
                if std::fs::metadata(&workspace.root).is_ok_and(|item| item.is_dir()) {
                    write_binding(&tx, "workspace", &workspace.id, &workspace.root)?;
                } else {
                    workspace.needs_rebind = true;
                    tx.execute(
                        "UPDATE workspaces SET data=?2 WHERE id=?1",
                        params![workspace.id, encode(&workspace)?],
                    )?;
                }
            }
            tx.execute_batch("PRAGMA user_version=13;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(13,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 14 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_source = tx
                .prepare("PRAGMA table_info(path_bindings)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "source_device");
            if !has_source {
                tx.execute_batch("ALTER TABLE path_bindings ADD COLUMN source_device TEXT; ALTER TABLE path_bindings ADD COLUMN source_inode TEXT;")?;
            }
            // A previously restored schema-13 profile may already have rebound.
            // Its original source cannot be reconstructed from the current row.
            tx.execute("UPDATE path_bindings SET source_device=device,source_inode=inode WHERE (SELECT restored_from_backup FROM restore_fence WHERE id=1)=0", [])?;
            tx.execute_batch("PRAGMA user_version=14;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(14,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 15 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_anchor = tx
                .prepare("PRAGMA table_info(send_intents)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "review_anchor");
            if !has_anchor {
                tx.execute_batch("ALTER TABLE send_intents ADD COLUMN review_anchor TEXT;")?;
            }
            tx.execute_batch("PRAGMA user_version=15;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(15,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        ensure!(
            connection.query_row(
                "SELECT COUNT(*) FROM restore_fence WHERE id=1 AND restored_from_backup IN (0,1)",
                [],
                |row| row.get::<_, i64>(0)
            )? == 1,
            "Schema-12 restore fence is missing; preserve this profile and use a compatible build"
        );
        Ok(Self {
            connection,
            data_directory,
        })
    }
    fn account_home(&self, id: &str) -> Result<PathBuf> {
        use std::os::unix::fs::MetadataExt;
        let suffix = id.strip_prefix("account_").context("Invalid account ID")?;
        ensure!(
            suffix.len() == 36
                && suffix.split('-').map(str::len).eq([8, 4, 4, 4, 12])
                && suffix
                    .chars()
                    .all(|character| character == '-' || character.is_ascii_hexdigit()),
            "Invalid account ID"
        );
        let homes = self.data_directory.join("provider-accounts");
        let home = homes.join(id);
        let profile_owner = std::fs::metadata(&self.data_directory)?.uid();
        for directory in [&homes, &home] {
            let metadata = std::fs::symlink_metadata(directory)?;
            ensure!(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.uid() == profile_owner
                    && metadata.mode() & 0o077 == 0,
                "Account native home is unavailable or redirected"
            );
        }
        Ok(home)
    }
    pub fn create_account(&self, provider: &str, name: &str) -> Result<Account> {
        crate::provider::descriptor(provider)?;
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.len() <= 80 && !name.contains(['\0', '\n', '\r']),
            "Account name must contain 1 to 80 characters without control line breaks"
        );
        let id = new_id("account");
        let homes = self.data_directory.join("provider-accounts");
        match std::fs::create_dir(&homes) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let homes_metadata = std::fs::symlink_metadata(&homes)?;
        ensure!(
            homes_metadata.is_dir() && !homes_metadata.file_type().is_symlink(),
            "Account native home root is redirected"
        );
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        ensure!(
            homes_metadata.uid() == std::fs::metadata(&self.data_directory)?.uid(),
            "Account native home root has another owner"
        );
        std::fs::set_permissions(&homes, std::fs::Permissions::from_mode(0o700))?;
        let home = homes.join(&id);
        std::fs::create_dir(&home)?;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))?;
        let home = self.account_home(&id)?;
        let account = Account {
            id,
            provider: provider.into(),
            name: name.into(),
            native_home: home.to_string_lossy().into_owned(),
            generation: 0,
            state: "unverified".into(),
            claude_identity: None,
            codex_identity: None,
            omp_identity: None,
        };
        if provider == "codex" {
            use std::io::Write;
            let mut config = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(home.join("config.toml"))?;
            config.write_all(b"cli_auth_credentials_store = \"file\"\n")?;
            config.sync_all()?;
        }
        self.connection.execute(
            "INSERT INTO accounts(id,provider,data) VALUES(?1,?2,?3)",
            params![account.id, account.provider, encode(&account)?],
        )?;
        Ok(account)
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        all::<Account>(&self.connection, "SELECT data FROM accounts ORDER BY rowid")?
            .into_iter()
            .map(|mut account| {
                account.native_home = self
                    .account_home(&account.id)?
                    .to_string_lossy()
                    .into_owned();
                Ok(account)
            })
            .collect()
    }
    pub fn account(&self, id: &str) -> Result<Account> {
        let mut account: Account = one(&self.connection, "accounts", id)?;
        account.native_home = self
            .account_home(&account.id)?
            .to_string_lossy()
            .into_owned();
        Ok(account)
    }
    pub fn verify_claude_account(
        &self,
        id: &str,
        generation: u64,
        identity: ClaudeIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(
            account.provider == "claude",
            "Account does not use Claude Code"
        );
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .claude_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Claude account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.claude_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn verify_codex_account(
        &self,
        id: &str,
        generation: u64,
        identity: ade_core::model::CodexIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(account.provider == "codex", "Account does not use Codex");
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .codex_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Codex account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.codex_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn verify_omp_account(
        &self,
        id: &str,
        generation: u64,
        identity: ade_core::model::OmpIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(account.provider == "omp", "Account does not use Oh My Pi");
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .omp_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Oh My Pi account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.omp_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn disable_account(&self, id: &str) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        account.generation = account
            .generation
            .checked_add(1)
            .context("Account generation exhausted")?;
        account.state = "disabled".into();
        account.claude_identity = None;
        account.codex_identity = None;
        account.omp_identity = None;
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn send_intent(&self, conversation: &str, window: &str) -> Result<Option<SendIntent>> {
        self.conversation(conversation)?;
        check_id(window)?;
        self.connection.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor FROM send_intents WHERE conversation_id=?1 AND window_id=?2 AND state IN ('pending','rejected')",
            params![conversation, window],
            send_intent_row,
        ).optional().map_err(Into::into)
    }
    /// A request ID prepared by a draft owner cannot be repurposed by another
    /// caller, even if the owner later aborts that send.
    pub fn guard_send_intent(
        &self,
        conversation: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
        review_payload: Option<&serde_json::Value>,
    ) -> Result<()> {
        let intent: Option<SendIntent> = self.connection.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?;
        if let Some(intent) = intent {
            self.ensure_send_intent_unheld(request_id)?;
            ensure!(
                intent.conversation_id == conversation
                    && intent.text == text
                    && intent.attachments == attachments
                    && intent
                        .review_anchor
                        .as_ref()
                        .or(intent.review_feedback.as_ref())
                        == review_payload,
                "Send intent ID was already used for a different prompt or conversation"
            );
            ensure!(intent.state != "aborted", "Send intent was aborted");
            ensure!(
                intent.state != "rejected",
                "Send intent was rejected before admission; abort it before preparing another prompt"
            );
            if intent.state == "completed" {
                ensure!(
                    message_by_id(&self.connection, request_id)?.is_some(),
                    "Completed send intent has no accepted message"
                );
            }
        }
        Ok(())
    }
    fn ensure_send_intent_unheld(&self, request_id: &str) -> Result<()> {
        let held: Option<i64> = self
            .connection
            .query_row(
                "SELECT restore_hold FROM send_intents WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .optional()?;
        if held == Some(1) {
            return Err(ade_core::error::RestoredSendHeld.into());
        }
        Ok(())
    }
    /// Persist the exact payload and request ID before the caller dispatches it.
    pub fn prepare_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
        draft: &Draft,
        text: &str,
        review_payload: Option<&serde_json::Value>,
    ) -> Result<SendIntent> {
        check_id(request_id)?;
        check_id(window)?;
        check_text(&draft.text)?;
        check_text(text)?;
        ensure!(
            !text.trim().is_empty() || !draft.attachments.is_empty(),
            "Prompt is empty"
        );
        validate_attachments(&self.connection, conversation, &draft.attachments)?;
        let tx = self.transaction()?;
        if let Some(existing) = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()? {
            ensure!(existing.conversation_id == conversation && existing.window_id == window
                && existing.draft_revision == draft.revision && existing.draft_text == draft.text
                && existing.text == text
                && existing.attachments == draft.attachments
                && existing.review_anchor.as_ref().or(existing.review_feedback.as_ref()) == review_payload,
                "Send intent ID was already used for a different prompt or owner");
            return Ok(existing);
        }
        ensure!(
            message_by_id(&tx, request_id)?.is_none(),
            "Send intent ID was already accepted as a message"
        );
        let saved = draft_from(&tx, conversation, window)?;
        ensure!(
            saved.text == draft.text
                && saved.revision == draft.revision
                && saved.attachments == draft.attachments
                && saved.revision > 0,
            "Draft changed before prompt admission"
        );
        ensure!(tx.query_row(
            "SELECT 1 FROM send_intents WHERE conversation_id=?1 AND window_id=?2 AND state IN ('pending','rejected')",
            params![conversation,window], |_| Ok(()),
        ).optional()?.is_none(), "Resolve the pending send before preparing another prompt");
        tx.execute("INSERT INTO send_intents(request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)",
            params![request_id,conversation,window,draft.revision,draft.text,text,encode(&draft.attachments)?,review_payload.map(serde_json::to_string).transpose()?])?;
        tx.commit()?;
        Ok(SendIntent {
            request_id: request_id.into(),
            conversation_id: conversation.into(),
            window_id: window.into(),
            draft_revision: draft.revision,
            draft_text: draft.text.clone(),
            text: text.into(),
            attachments: draft.attachments.clone(),
            state: "pending".into(),
            review_anchor: review_payload
                .filter(|value| value["format"] != "ade-review-feedback-v1")
                .cloned(),
            review_feedback: review_payload
                .filter(|value| value["format"] == "ade-review-feedback-v1")
                .cloned(),
        })
    }
    /// An acknowledged user message and draft clear settle together. A missing
    /// message leaves the intent pending, even if the caller received no reply.
    pub fn complete_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
    ) -> Result<Draft> {
        check_id(request_id)?;
        check_id(window)?;
        self.ensure_send_intent_unheld(request_id)?;
        let tx = self.transaction()?;
        let intent: SendIntent = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?.context("Unknown send intent")?;
        ensure!(
            intent.conversation_id == conversation && intent.window_id == window,
            "Send intent ID belongs to another owner"
        );
        if intent.state == "completed" {
            return Ok(Draft {
                text: String::new(),
                revision: intent
                    .draft_revision
                    .checked_add(1)
                    .context("Draft revision exhausted")?,
                attachments: vec![],
            });
        }
        let message = message_by_id(&tx, request_id)?
            .context("Prompt has not been accepted; retry delivery")?;
        ensure!(
            message.conversation_id == conversation
                && message.role == "user"
                && message.text == intent.text
                && message.attachments == intent.attachments,
            "Accepted prompt conflicts with send intent"
        );
        let saved = draft_from(&tx, conversation, window)?;
        ensure!(
            saved.revision == intent.draft_revision
                && saved.text == intent.draft_text
                && saved.attachments == intent.attachments,
            "Draft changed while send was pending; resolve the conflict"
        );
        let next = saved
            .revision
            .checked_add(1)
            .context("Draft revision exhausted")?;
        tx.execute("UPDATE drafts SET revision=?3,text='',attachments='[]' WHERE conversation_id=?1 AND window_id=?2",
            params![conversation,window,next])?;
        tx.execute(
            "UPDATE send_intents SET state='completed' WHERE request_id=?1",
            [request_id],
        )?;
        tx.commit()?;
        Ok(Draft {
            text: String::new(),
            revision: next,
            attachments: vec![],
        })
    }
    /// Only the daemon's own rejected pre-admission send can unlock this intent.
    pub fn reject_send_intent(
        &self,
        conversation: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<()> {
        let tx = self.transaction()?;
        if message_by_id(&tx, request_id)?.is_none() {
            let encoded = encode(&attachments)?;
            tx.execute("UPDATE send_intents SET state='rejected' WHERE request_id=?1 AND conversation_id=?2 AND text=?3 AND attachments=?4 AND state='pending' AND restore_hold=0",
                params![request_id,conversation,text,encoded])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn abort_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
    ) -> Result<Draft> {
        check_id(request_id)?;
        self.ensure_send_intent_unheld(request_id)?;
        let tx = self.transaction()?;
        let intent: SendIntent = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?.context("Unknown send intent")?;
        ensure!(
            intent.conversation_id == conversation && intent.window_id == window,
            "Send intent ID belongs to another owner"
        );
        ensure!(
            intent.state == "rejected" || intent.state == "aborted",
            "Send outcome is not a confirmed pre-admission rejection"
        );
        ensure!(
            message_by_id(&tx, request_id)?.is_none(),
            "Prompt was accepted; reconcile the send"
        );
        if intent.state == "rejected" {
            tx.execute(
                "UPDATE send_intents SET state='aborted' WHERE request_id=?1",
                [request_id],
            )?;
        }
        let draft = draft_from(&tx, conversation, window)?;
        tx.commit()?;
        Ok(draft)
    }
    pub fn draft(&self, conversation: &str, window: &str) -> Result<Draft> {
        draft_from(&self.connection, conversation, window)
    }
    /// Called under the Sessions store lock, including the revision comparison.
    pub fn resolve_draft(
        &self,
        conversation: &str,
        window: &str,
        draft: &Draft,
        expected: i64,
    ) -> Result<Draft> {
        let saved = self.draft(conversation, window)?;
        if saved.revision != expected {
            return Ok(saved);
        }
        self.save_draft(conversation, window, draft)
    }
    pub fn save_draft(&self, conversation: &str, window: &str, draft: &Draft) -> Result<Draft> {
        self.conversation(conversation)?;
        check_id(window)?;
        check_text(&draft.text)?;
        validate_attachments(&self.connection, conversation, &draft.attachments)?;
        ensure!(draft.revision > 0, "Invalid draft revision");
        ensure!(
            self.send_intent(conversation, window)?.is_none(),
            "Resolve the pending send before editing this draft"
        );
        // Each window owns a separate draft. Older asynchronous writes cannot
        // overwrite newer text, including a clear after successful submission.
        self.connection.execute("INSERT INTO drafts(conversation_id,window_id,revision,text,attachments) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(conversation_id,window_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachments=excluded.attachments WHERE excluded.revision>drafts.revision",params![conversation,window,draft.revision,draft.text,encode(&draft.attachments)?])?;
        self.draft(conversation, window)
    }
    fn transaction(&self) -> Result<Transaction<'_>> {
        Ok(Transaction::new_unchecked(
            &self.connection,
            TransactionBehavior::Immediate,
        )?)
    }
    pub fn workspace(&self, id: &str) -> Result<WorkspaceRecord> {
        one(&self.connection, "workspaces", id)
    }
    pub fn rebind_workspaces(&self) -> Result<Vec<WorkspaceRebindEntry>> {
        let workspaces: Vec<WorkspaceRecord> = all(
            &self.connection,
            "SELECT data FROM workspaces ORDER BY rowid",
        )?;
        workspaces
            .into_iter()
            .map(|workspace| {
                let repository_unbound = match &workspace.repository_id {
                    Some(id) => {
                        let repository = self.repository(id)?;
                        repository.needs_rebind
                            || !binding_matches(
                                &self.connection,
                                "repository",
                                id,
                                &repository.root,
                            )?
                            || !linked_common_matches(&workspace.root, &repository.root)
                    }
                    None => false,
                };
                let needs_rebind = workspace.needs_rebind
                    || repository_unbound
                    || !binding_matches(
                        &self.connection,
                        "workspace",
                        &workspace.id,
                        &workspace.root,
                    )?;
                let rebindable =
                    saved_binding_identity(&self.connection, "workspace", &workspace.id)?.is_some();
                Ok(WorkspaceRebindEntry {
                    id: workspace.id,
                    root: workspace.root,
                    name: workspace.name,
                    needs_rebind,
                    rebindable,
                })
            })
            .collect()
    }
    pub fn repository(&self, id: &str) -> Result<Repository> {
        one(&self.connection, "repositories", id)
    }
    pub fn rebind_repositories(&self) -> Result<Vec<(String, String, bool, bool)>> {
        let repositories: Vec<Repository> = all(
            &self.connection,
            "SELECT data FROM repositories ORDER BY rowid",
        )?;
        repositories
            .into_iter()
            .map(|repository| {
                let needs_rebind = repository.needs_rebind
                    || !binding_matches(
                        &self.connection,
                        "repository",
                        &repository.id,
                        &repository.root,
                    )?;
                let rebindable =
                    saved_binding_identity(&self.connection, "repository", &repository.id)?
                        .is_some();
                Ok((repository.id, repository.root, needs_rebind, rebindable))
            })
            .collect()
    }
    pub fn repository_bound(&self, id: &str) -> Result<bool> {
        let repository = self.repository(id)?;
        Ok(!repository.needs_rebind
            && binding_matches(&self.connection, "repository", id, &repository.root)?)
    }
    pub fn workspace_binding_identity(&self, id: &str) -> Result<(u64, u64)> {
        self.binding_identity("workspace", id)
    }
    pub fn repository_binding_identity(&self, id: &str) -> Result<(u64, u64)> {
        self.binding_identity("repository", id)
    }
    fn binding_identity(&self, kind: &str, id: &str) -> Result<(u64, u64)> {
        let saved: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
                params![kind, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (device, inode) = saved.context(ade_core::error::NeedsRebind)?;
        Ok((device.parse()?, inode.parse()?))
    }
    pub fn ensure_workspace_bound(&self, id: &str) -> Result<()> {
        // A path can be replaced by an external process after this check and
        // before a spawned child opens it. Callers recheck at admission and
        // launch; durable device/inode identity catches later attempts, but
        // path-based OS APIs cannot make that handoff fully atomic.
        let workspace = self.workspace(id)?;
        if workspace.needs_rebind {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if !binding_matches(&self.connection, "workspace", id, &workspace.root)? {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if let Some(repository_id) = &workspace.repository_id {
            let repository: Repository = one(&self.connection, "repositories", repository_id)?;
            if repository.needs_rebind
                || !binding_matches(
                    &self.connection,
                    "repository",
                    repository_id,
                    &repository.root,
                )?
                || !linked_common_matches(&workspace.root, &repository.root)
            {
                return Err(ade_core::error::NeedsRebind.into());
            }
        }
        Ok(())
    }
    pub fn has_pending_rebind(&self) -> Result<bool> {
        let marker: i64 = self.connection.query_row(
            "SELECT worktree_lifecycle_needs_rebind FROM restore_fence WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(marker != 0 || self.has_unbound_records()?)
    }
    pub fn has_unbound_records(&self) -> Result<bool> {
        let pending: i64 = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE json_extract(data,'$.needs_rebind')=1 OR json_extract(data,'$.worktree_lifecycle_needs_rebind')=1 UNION ALL SELECT 1 FROM repositories WHERE json_extract(data,'$.needs_rebind')=1 OR json_extract(data,'$.worktree_lifecycle_needs_rebind')=1)",
            [], |row| row.get(0),
        )?;
        if pending != 0 {
            return Ok(true);
        }
        let workspaces: Vec<WorkspaceRecord> =
            all(&self.connection, "SELECT data FROM workspaces")?;
        for workspace in workspaces {
            if !binding_matches(
                &self.connection,
                "workspace",
                &workspace.id,
                &workspace.root,
            )? {
                return Ok(true);
            }
            if let Some(repository_id) = &workspace.repository_id {
                let repository: Repository = one(&self.connection, "repositories", repository_id)?;
                if !linked_common_matches(&workspace.root, &repository.root) {
                    return Ok(true);
                }
            }
        }
        let repositories: Vec<Repository> = all(&self.connection, "SELECT data FROM repositories")?;
        for repository in repositories {
            if !binding_matches(
                &self.connection,
                "repository",
                &repository.id,
                &repository.root,
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn release_restore_fence(&self) -> Result<()> {
        ensure!(
            !self.has_unbound_records()?,
            "Restore bindings remain unresolved"
        );
        self.connection.execute(
            "UPDATE restore_fence SET worktree_lifecycle_needs_rebind=0 WHERE id=1",
            [],
        )?;
        Ok(())
    }
    /// The indexed root and public JSON change in one SQLite transaction. An
    /// interrupted command therefore leaves the old fenced row or the new row.
    pub fn rebind_repository(
        &self,
        id: &str,
        common: &str,
        identity: (u64, u64),
    ) -> Result<Repository> {
        let tx = self.transaction()?;
        let mut repository: Repository = one(&tx, "repositories", id)?;
        let source_identity = saved_binding_identity(&tx, "repository", id)?
            .context("Saved repository physical identity is unavailable; rebind remains fenced")?;
        ensure!(
            source_identity != identity,
            "Select a different physical repository from the saved checkout"
        );
        ensure_not_source_directory(&tx, common)?;
        ensure!(
            repository.needs_rebind || !binding_matches(&tx, "repository", id, &repository.root)?,
            "Repository is already bound"
        );
        ensure!(
            repository.root != common || !binding_matches(&tx, "repository", id, common)?,
            "Select a different repository from the source checkout"
        );
        let collision: Option<String> = tx
            .query_row(
                "SELECT id FROM repositories WHERE root=?1 AND id!=?2",
                params![common, id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            collision.is_none(),
            "Repository path belongs to another identity"
        );
        repository.root = common.into();
        repository.needs_rebind = false;
        repository.worktree_lifecycle_needs_rebind = false;
        tx.execute(
            "UPDATE repositories SET root=?2,data=?3 WHERE id=?1",
            params![id, common, encode(&repository)?],
        )?;
        verify_binding_identity(common, identity)?;
        write_binding_identity(&tx, "repository", id, identity)?;
        tx.commit()?;
        Ok(repository)
    }
    pub fn repository_source_identity(&self, id: &str) -> Result<(u64, u64)> {
        saved_binding_identity(&self.connection, "repository", id)?
            .context("Saved repository physical identity is unavailable; rebind remains fenced")
    }
    pub fn reject_source_path(&self, path: &str) -> Result<()> {
        ensure_not_source_directory(&self.connection, path)
    }
    pub fn rebind_workspace(
        &self,
        id: &str,
        root: &str,
        common: Option<&str>,
        identity: (u64, u64),
    ) -> Result<WorkspaceRecord> {
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        let source_identity = saved_binding_identity(&tx, "workspace", id)?
            .context("Saved workspace physical identity is unavailable; rebind remains fenced")?;
        ensure!(
            source_identity != identity,
            "Select a different physical directory from the saved workspace"
        );
        ensure!(
            workspace.repository_id.is_some() || common.is_none(),
            "An ordinary workspace cannot rebind to a Git checkout; bind a repository first"
        );
        ensure_not_source_directory(&tx, root)?;
        let linked_repository = workspace
            .repository_id
            .as_ref()
            .map(|repository_id| one::<Repository>(&tx, "repositories", repository_id))
            .transpose()?;
        let linked_common_changed = linked_repository
            .as_ref()
            .is_some_and(|repository| !linked_common_matches(&workspace.root, &repository.root));
        ensure!(
            workspace.needs_rebind
                || !binding_matches(&tx, "workspace", id, &workspace.root)?
                || linked_common_changed,
            "Workspace is already bound"
        );
        ensure!(
            workspace.root != root
                || !binding_matches(&tx, "workspace", id, root)?
                || linked_common_changed,
            "Select a different directory from the source workspace"
        );
        let collision: Option<String> = tx
            .query_row(
                "SELECT id FROM workspaces WHERE root=?1 AND id!=?2",
                params![root, id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            collision.is_none(),
            "Workspace path belongs to another identity"
        );
        if let Some(repository) = linked_repository {
            let repository_id = &repository.id;
            ensure!(
                !repository.needs_rebind
                    && binding_matches(&tx, "repository", repository_id, &repository.root)?,
                "Rebind the repository first"
            );
            ensure!(
                Some(repository.root.as_str()) == common,
                "Workspace Git common directory differs from its repository binding"
            );
        }
        workspace.root = root.into();
        workspace.needs_rebind = false;
        workspace.worktree_lifecycle_needs_rebind = false;
        tx.execute(
            "UPDATE workspaces SET root=?2,data=?3 WHERE id=?1",
            params![id, root, encode(&workspace)?],
        )?;
        verify_binding_identity(root, identity)?;
        write_binding_identity(&tx, "workspace", id, identity)?;
        tx.commit()?;
        Ok(workspace)
    }
    pub fn restored_from_backup(&self) -> Result<bool> {
        let restored: i64 = self.connection.query_row(
            "SELECT restored_from_backup FROM restore_fence WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(restored != 0)
    }
    pub fn inherited_binding(&self, root: &str) -> Result<(bool, bool)> {
        let mut needs_rebind = false;
        let mut lifecycle_needs_rebind = false;
        let workspaces: Vec<WorkspaceRecord> =
            all(&self.connection, "SELECT data FROM workspaces")?;
        for workspace in workspaces {
            if Path::new(root).starts_with(&workspace.root) {
                needs_rebind |= workspace.needs_rebind;
                lifecycle_needs_rebind |= workspace.worktree_lifecycle_needs_rebind;
            }
        }
        Ok((needs_rebind, lifecycle_needs_rebind))
    }
    pub fn conversation(&self, id: &str) -> Result<Conversation> {
        one(&self.connection, "conversations", id)
    }
    pub fn catalog(&self) -> Result<Catalogue> {
        let tx = self.connection.unchecked_transaction()?;
        let result = Catalogue {
            workspaces: all(&tx, "SELECT data FROM workspaces ORDER BY rowid")?,
            conversations: all(&tx, "SELECT data FROM conversations ORDER BY rowid")?,
            windows: all(&tx, "SELECT data FROM windows ORDER BY rowid")?,
        };
        tx.commit()?;
        Ok(result)
    }
    pub(crate) fn catalog_binding_claims(
        &self,
        catalog: &Catalogue,
    ) -> Result<Vec<CatalogBindingClaim>> {
        catalog
            .workspaces
            .iter()
            .map(|workspace| {
                let repository = workspace
                    .repository_id
                    .as_ref()
                    .map(|id| {
                        let record: Repository = one(&self.connection, "repositories", id)?;
                        let expected =
                            current_binding_identity(&self.connection, "repository", id)?;
                        Ok::<_, anyhow::Error>((
                            record.root,
                            if record.needs_rebind { None } else { expected },
                        ))
                    })
                    .transpose()?;
                Ok(CatalogBindingClaim {
                    workspace: current_binding_identity(
                        &self.connection,
                        "workspace",
                        &workspace.id,
                    )?,
                    repository,
                })
            })
            .collect()
    }
    pub fn reserve_terminal(&self, id: &str, instance: &str) -> Result<Conversation> {
        let tx = self.transaction()?;
        let mut c: Conversation = one(&tx, "conversations", id)?;
        if c.terminal_owner.is_some() {
            return Ok(c);
        }
        ensure!(
            !BUSY.contains(&c.status.as_str()) && c.active_turn_id.is_none(),
            "Cancel the active turn before transferring"
        );
        ensure!(
            c.provider_thread_id.is_some(),
            "Start the Conversation before transferring"
        );
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", &c.workspace_id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        let terminal_id = new_id("terminal");
        workspace.extra_terminals.push(terminal_id.clone());
        tx.execute(
            "UPDATE workspaces SET data=?1 WHERE id=?2",
            params![encode(&workspace)?, workspace.id],
        )?;
        c.terminal_owner = Some(TerminalOwner {
            terminal_id,
            transfer_id: new_id("transfer"),
            runtime_instance: instance.into(),
        });
        c.queue_paused = true;
        c.status = "terminal".into();
        c.updated_at = now_ms();
        write_conversation(&tx, &c)?;
        tx.commit()?;
        Ok(c)
    }
    pub fn terminal_reserved(&self, terminal: &str) -> Result<bool> {
        if ade_core::scripts::run_name(terminal).is_ok() {
            return Ok(true);
        }
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE (json_extract(data,'$.terminal_owner.terminal_id')=?1 OR json_extract(data,'$.view_terminal.terminal_id')=?1) UNION ALL SELECT 1 FROM services WHERE json_extract(data,'$.terminal_id')=?1)", [terminal], |row| row.get(0))?)
    }
    pub fn register_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", workspace_id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        ensure!(
            !workspace.extra_terminals.iter().any(|id| id == run_id),
            "Script run already exists"
        );
        workspace.extra_terminals.push(run_id.to_owned());
        tx.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![workspace_id, encode(&workspace)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn retire_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        let workspace = self.workspace(workspace_id)?;
        ensure!(
            workspace.extra_terminals.iter().any(|id| id == run_id),
            "Script run is unavailable"
        );
        self.retire_terminal(workspace_id, run_id)
    }
    pub fn create_terminal(&self, id: &str) -> Result<String> {
        let tx = self.connection.unchecked_transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        let terminal = new_id("terminal");
        workspace.extra_terminals.push(terminal.clone());
        tx.execute(
            "UPDATE workspaces SET data=?1 WHERE id=?2",
            params![encode(&workspace)?, id],
        )?;
        tx.commit()?;
        Ok(terminal)
    }
    pub fn retire_terminal(&self, id: &str, terminal: &str) -> Result<()> {
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        if workspace.terminal_id != terminal
            && !workspace
                .extra_terminals
                .iter()
                .any(|item| item == terminal)
        {
            return Ok(());
        }
        if workspace.terminal_id == terminal {
            workspace.terminal_id = new_id("terminal");
        } else {
            workspace.extra_terminals.retain(|item| item != terminal);
        }
        tx.execute(
            "UPDATE workspaces SET terminal_id=?2,data=?3 WHERE id=?1",
            params![id, workspace.terminal_id, encode(&workspace)?],
        )?;
        forget_terminal_views(&tx, terminal)?;
        tx.commit()?;
        Ok(())
    }
    pub fn workspace_open(
        &self,
        root: &str,
        repository_root: Option<&str>,
    ) -> Result<WorkspaceRecord> {
        ensure!(!root.is_empty(), "Workspace root is empty");
        let (mut needs_rebind, worktree_lifecycle_needs_rebind) = self.inherited_binding(root)?;
        needs_rebind |= self.has_pending_rebind()?;
        let tx = self.transaction()?;
        let existing: Option<String> = tx
            .query_row("SELECT data FROM workspaces WHERE root=?1", [root], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(existing) = existing {
            let mut workspace: WorkspaceRecord = decode(existing)?;
            let repository_changed = if let Some(repository_id) = &workspace.repository_id {
                let repository: Repository = one(&tx, "repositories", repository_id)?;
                repository.needs_rebind
                    || !binding_matches(&tx, "repository", repository_id, &repository.root)?
                    || !linked_common_matches(&workspace.root, &repository.root)
            } else {
                false
            };
            if !workspace.needs_rebind
                && (repository_changed
                    || !binding_matches(&tx, "workspace", &workspace.id, &workspace.root)?)
            {
                workspace.needs_rebind = true;
                tx.execute(
                    "UPDATE workspaces SET data=?2 WHERE id=?1",
                    params![workspace.id, encode(&workspace)?],
                )?;
            }
            tx.commit()?;
            return Ok(workspace);
        }
        // A new path has no saved identity to recover. Persisting it while a
        // restored claim is unresolved would give it a fenced, unbindable ID
        // and could also block the original workspace from selecting it.
        ensure!(!needs_rebind, ade_core::error::NeedsRebind);
        let repository_id = if let Some(repository_root) = repository_root {
            ensure!(!repository_root.is_empty(), "Repository root is empty");
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM repositories WHERE root=?1",
                    [repository_root],
                    |r| r.get(0),
                )
                .optional()?;
            Some(if let Some(id) = existing {
                id
            } else {
                let repository = Repository {
                    id: new_id("repo"),
                    root: repository_root.into(),
                    needs_rebind: false,
                    worktree_lifecycle_needs_rebind: false,
                };
                tx.execute(
                    "INSERT INTO repositories VALUES(?1,?2,?3)",
                    params![repository.id, repository.root, encode(&repository)?],
                )?;
                if !needs_rebind {
                    write_binding(&tx, "repository", &repository.id, &repository.root)?;
                }
                repository.id
            })
        } else {
            None
        };
        if let Some(id) = &repository_id {
            let repository: Repository = one(&tx, "repositories", id)?;
            needs_rebind |= repository.needs_rebind
                || !binding_matches(&tx, "repository", id, &repository.root)?;
        }
        let workspace = WorkspaceRecord {
            extra_terminals: Vec::new(),
            id: new_id("workspace"),
            repository_id,
            root: root.into(),
            needs_rebind,
            worktree_lifecycle_needs_rebind,
            name: Path::new(root)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(root)
                .into(),
            terminal_id: new_id("terminal"),
        };
        tx.execute(
            "INSERT INTO workspaces VALUES(?1,?2,?3,?4,?5)",
            params![
                workspace.id,
                workspace.repository_id,
                workspace.root,
                workspace.terminal_id,
                encode(&workspace)?
            ],
        )?;
        write_binding(&tx, "workspace", &workspace.id, &workspace.root)?;
        tx.commit()?;
        Ok(workspace)
    }
    pub fn create_conversation(&self, workspace_id: &str, title: &str) -> Result<Conversation> {
        self.create_with_provider(workspace_id, title, "codex", Default::default())
    }
    pub fn create_with_provider(
        &self,
        workspace_id: &str,
        title: &str,
        provider: &str,
        provider_config: crate::provider::Config,
    ) -> Result<Conversation> {
        self.create_with_account(workspace_id, title, provider, provider_config, None)
    }
    pub fn create_with_account(
        &self,
        workspace_id: &str,
        title: &str,
        provider: &str,
        provider_config: crate::provider::Config,
        account_id: Option<&str>,
    ) -> Result<Conversation> {
        provider_config.validate(provider)?;
        if let Some(id) = account_id {
            let account = self.account(id)?;
            ensure!(
                account.provider == provider,
                "Account belongs to another provider"
            );
        }
        check_text(title)?;
        let conversation = Conversation {
            terminal_owner: None,
            view_terminal: None,
            queue_paused: false,
            runtime_run: None,
            runtime_cursor: 0,
            runtime_submission: None,
            id: new_id("conversation"),
            workspace_id: workspace_id.into(),
            title: title.into(),
            provider: provider.into(),
            account_id: account_id.map(str::to_owned),
            account_context: if account_id.is_some() {
                "managed"
            } else {
                "legacy_ambient"
            }
            .into(),
            provider_config,
            provider_thread_id: None,
            status: "idle".into(),
            active_turn_id: None,
            error: None,
            updated_at: now_ms(),
        };
        self.connection.execute(
            "INSERT INTO conversations VALUES(?1,?2,?3)",
            params![conversation.id, workspace_id, encode(&conversation)?],
        )?;
        Ok(conversation)
    }
    pub fn messages(&self, id: &str, before: Option<i64>, limit: usize) -> Result<Vec<Message>> {
        self.conversation(id)?;
        let mut statement = self.connection.prepare("SELECT data FROM messages WHERE conversation_id=?1 AND (?2 IS NULL OR sequence<?2) ORDER BY sequence DESC LIMIT ?3")?;
        let mut messages: Vec<Message> = statement
            .query_map(params![id, before, limit.min(200) as i64], |r| {
                r.get::<_, String>(0)
            })?
            .map(|row| decode(row?))
            .collect::<Result<_>>()?;
        messages.reverse();
        Ok(messages)
    }
    pub fn message(&self, id: &str) -> Result<Option<Message>> {
        message_by_id(&self.connection, id)
    }
    /// Page backward through a workspace's durable review anchors. The scan cap
    /// bounds one request even when few notes match the requested text/path.
    pub fn search_review_feedback(
        &self,
        workspace_id: &str,
        path: Option<&str>,
        query: Option<&str>,
        before: Option<i64>,
        limit: usize,
    ) -> Result<(Vec<Value>, Option<i64>)> {
        self.workspace(workspace_id)?;
        ensure!(
            path.is_some() || query.is_some(),
            "Specify a review path or note query"
        );
        ensure!(
            path.is_none_or(|value| !value.is_empty() && value.len() <= 4096),
            "Invalid review path query"
        );
        ensure!(
            query.is_none_or(|value| !value.trim().is_empty() && value.len() <= 256),
            "Invalid review note query"
        );
        ensure!(
            before.is_none_or(|value| value > 0),
            "Invalid review search cursor"
        );
        ensure!(
            (1..=50).contains(&limit),
            "Review search limit must be 1 to 50"
        );
        let mut statement = self.connection.prepare("SELECT m.rowid,m.data FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.workspace_id=?1 AND (?2 IS NULL OR m.rowid<?2) ORDER BY m.rowid DESC LIMIT 501")?;
        let mut rows = statement.query(params![workspace_id, before])?;
        let mut results = Vec::new();
        let mut cursor = None;
        let mut scanned = 0;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let message: Message = decode(row.get::<_, String>(1)?)?;
            scanned += 1;
            cursor = Some(rowid);
            if let Some(feedback) = message.review_feedback
                && let Some(notes) = feedback["notes"].as_array()
            {
                let matching: Vec<_> = notes
                    .iter()
                    .filter(|note| {
                        path.is_none_or(|path| note["anchor"]["path"].as_str() == Some(path))
                            && query.is_none_or(|query| {
                                note["note"].as_str().is_some_and(|value| {
                                    value.to_lowercase().contains(&query.to_lowercase())
                                })
                            })
                    })
                    .cloned()
                    .collect();
                if !matching.is_empty() {
                    results.push(json!({"message_id":message.id,"conversation_id":message.conversation_id,
                            "review_feedback":{"format":"ade-review-feedback-v1","workspace_id":workspace_id,"notes":matching}}));
                }
            }
            if results.len() >= limit || scanned >= 500 {
                break;
            }
        }
        let next_cursor = if scanned >= 500 || (results.len() >= limit && rows.next()?.is_some()) {
            cursor
        } else {
            None
        };
        Ok((results, next_cursor))
    }
    pub fn pending(&self, id: &str) -> Result<Vec<PendingRequest>> {
        self.conversation(id)?;
        let mut statement = self.connection.prepare("SELECT data FROM requests WHERE conversation_id=?1 AND status IN ('pending','responding') ORDER BY rowid")?;
        statement
            .query_map([id], |r| r.get::<_, String>(0))?
            .map(|row| decode(row?))
            .collect()
    }
    pub fn interaction(&self, conversation: &str, id: &str) -> Result<Option<PendingRequest>> {
        self.conversation(conversation)?;
        self.connection
            .query_row(
                "SELECT data FROM requests WHERE id=?1 AND conversation_id=?2",
                params![id, conversation],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(decode)
            .transpose()
    }
    pub fn queued(&self, conversation: &str) -> Result<Vec<QueuedPrompt>> {
        self.conversation(conversation)?;
        self.connection.prepare("SELECT id,conversation_id,text,status,attachments FROM queued_prompts WHERE conversation_id=?1 AND status='queued' ORDER BY rowid")?
            .query_map([conversation], |row| Ok(QueuedPrompt { id:row.get(0)?,conversation_id:row.get(1)?,text:row.get(2)?,status:row.get(3)?,attachments:attachment_row(row,4)? }))?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }
    pub fn enqueue(&self, conversation: &str, id: &str, text: &str) -> Result<()> {
        self.enqueue_content(conversation, id, text, &[])
    }
    pub fn enqueue_content(
        &self,
        conversation: &str,
        id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<()> {
        check_id(id)?;
        ensure!(
            (!text.trim().is_empty() || !attachments.is_empty()) && text.len() <= 64 * 1024,
            "Prompt needs text or attachments, with text up to 64 KiB"
        );
        validate_attachments(&self.connection, conversation, attachments)?;
        self.conversation(conversation)?;
        let tx = self.transaction()?;
        if let Some(message) = message_by_id(&tx, id)? {
            ensure!(
                message.conversation_id == conversation
                    && message.role == "user"
                    && message.text == text
                    && message.attachments == attachments,
                "Submission ID belongs to another prompt"
            );
            return Ok(());
        }
        let prior: Option<(String, String, Vec<Attachment>)> = tx
            .query_row(
                "SELECT conversation_id,text,attachments FROM queued_prompts WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, attachment_row(row, 2)?)),
            )
            .optional()?;
        if let Some((owner, value, previous)) = prior {
            ensure!(
                owner == conversation && value == text && previous == attachments,
                "Queue ID belongs to another prompt"
            );
            return Ok(());
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM queued_prompts WHERE conversation_id=?1 AND status='queued'",
            [conversation],
            |row| row.get(0),
        )?;
        ensure!(count < 32, "Limit of 32 queued prompts reached");
        tx.execute(
            "INSERT INTO queued_prompts(id,conversation_id,text,status,attachments) VALUES(?1,?2,?3,'queued',?4)",
            params![id, conversation, text, encode(&attachments)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn cancel_queued(&self, conversation: &str, id: &str) -> Result<()> {
        self.conversation(conversation)?;
        let prior: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT conversation_id,status FROM queued_prompts WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (owner, state) = prior.context("Unknown queued prompt")?;
        ensure!(
            owner == conversation,
            "Queued prompt belongs to another Conversation"
        );
        ensure!(
            state != "submitted",
            "Prompt has already been submitted; cancel the active turn instead"
        );
        self.connection.execute(
            "UPDATE queued_prompts SET status='cancelled' WHERE id=?1",
            [id],
        )?;
        Ok(())
    }
    pub fn queue_heads(&self) -> Result<Vec<QueuedPrompt>> {
        self.connection.prepare("SELECT q.id,q.conversation_id,q.text,q.status,q.attachments FROM queued_prompts q JOIN conversations c ON c.id=q.conversation_id WHERE q.status='queued' AND json_extract(c.data,'$.terminal_owner') IS NULL AND COALESCE(json_extract(c.data,'$.queue_paused'),0)=0 AND json_extract(c.data,'$.status') IN ('idle','ready') AND q.rowid=(SELECT MIN(h.rowid) FROM queued_prompts h WHERE h.conversation_id=q.conversation_id AND h.status='queued') ORDER BY q.rowid LIMIT 16")?
            .query_map([],|row| Ok(QueuedPrompt {id:row.get(0)?,conversation_id:row.get(1)?,text:row.get(2)?,status:row.get(3)?,attachments:attachment_row(row,4)?}))?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }
    pub fn begin_turn(
        &self,
        conversation_id: &str,
        request_id: &str,
        text: &str,
    ) -> Result<BeginTurn> {
        self.begin_content_turn(conversation_id, request_id, text, &[], false)
    }
    pub fn begin_queued_turn(
        &self,
        conversation_id: &str,
        request_id: &str,
        text: &str,
    ) -> Result<BeginTurn> {
        self.begin_content_turn(conversation_id, request_id, text, &[], true)
    }
    pub fn begin_content_turn(
        &self,
        conversation_id: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
        queued: bool,
    ) -> Result<BeginTurn> {
        self.begin_content_turn_with_feedback(
            conversation_id,
            request_id,
            text,
            attachments,
            queued,
            None,
        )
    }
    pub fn begin_content_turn_with_feedback(
        &self,
        conversation_id: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
        queued: bool,
        review_feedback: Option<&serde_json::Value>,
    ) -> Result<BeginTurn> {
        check_id(request_id)?;
        check_text(text)?;
        ensure!(
            !text.trim().is_empty() || !attachments.is_empty(),
            "Prompt is empty"
        );
        validate_attachments(&self.connection, conversation_id, attachments)?;
        let tx = self.transaction()?;
        let mut conversation: Conversation = one(&tx, "conversations", conversation_id)?;
        ensure!(
            conversation.terminal_owner.is_none(),
            "Return this Conversation from its terminal before sending"
        );
        let entry: Option<(String, String, String, Vec<Attachment>)> = tx
            .query_row(
                "SELECT conversation_id,text,status,attachments FROM queued_prompts WHERE id=?1",
                [request_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        attachment_row(row, 3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((owner, value, state, previous)) = entry {
            ensure!(
                owner == conversation_id && value == text && previous == attachments,
                "Queue ID belongs to another prompt"
            );
            ensure!(state != "cancelled", "Queued prompt was cancelled");
        }
        let head: Option<(String,String)> = tx.query_row("SELECT id,text FROM queued_prompts WHERE conversation_id=?1 AND status='queued' ORDER BY rowid LIMIT 1",[conversation_id],|row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        if queued {
            ensure!(!conversation.queue_paused, "Prompt queue is paused");
            ensure!(
                head.as_ref()
                    .is_some_and(|(id, value)| id == request_id && value == text),
                "Queued prompt changed or was cancelled"
            );
        }
        if let Some(message) = message_by_id(&tx, request_id)? {
            ensure!(
                message.conversation_id == conversation_id
                    && message.role == "user"
                    && message.text == text
                    && message.attachments == attachments
                    && message.review_feedback.as_ref() == review_feedback,
                "Submission ID was already used for a different prompt or conversation"
            );
            return Ok(BeginTurn {
                conversation,
                message,
                duplicate: true,
            });
        }
        ensure!(
            !BUSY.contains(&conversation.status.as_str()),
            "Conversation already has an active turn"
        );
        ensure!(
            head.as_ref().is_none_or(|(id, _)| id == request_id),
            "Earlier prompts are queued; enqueue this prompt to preserve order"
        );
        let message = Message {
            content: None,
            review_feedback: review_feedback.cloned(),
            id: request_id.into(),
            conversation_id: conversation_id.into(),
            role: "user".into(),
            kind: "text".into(),
            text: text.into(),
            status: "completed".into(),
            turn_id: None,
            provider_item_id: None,
            sequence: next_sequence(&tx, conversation_id)?,
            attachments: attachments.to_vec(),
        };
        write_message(&tx, &message)?;
        tx.execute("UPDATE queued_prompts SET status='submitted' WHERE id=?1 AND conversation_id=?2 AND status='queued'",params![request_id,conversation_id])?;
        if conversation.title == "New Conversation" {
            conversation.title = text
                .lines()
                .next()
                .unwrap_or(text)
                .chars()
                .take(45)
                .collect();
        }
        conversation.runtime_submission = Some(request_id.into());
        conversation.status = "starting".into();
        conversation.active_turn_id = None;
        conversation.error = None;
        conversation.updated_at = now_ms();
        write_conversation(&tx, &conversation)?;
        tx.commit()?;
        Ok(BeginTurn {
            conversation,
            message,
            duplicate: false,
        })
    }
    pub fn commit_conversation(
        &self,
        conversation: &Conversation,
        messages: &[Message],
        requests: &[PendingRequest],
    ) -> Result<()> {
        let started = std::time::Instant::now();
        let tx = self.transaction()?;
        write_conversation(&tx, conversation)?;
        for incoming in messages {
            check_id(&incoming.id)?;

            ensure!(
                incoming.conversation_id == conversation.id,
                "Message belongs to another conversation"
            );
            let by_id = message_by_id(&tx, &incoming.id)?;
            if let Some(existing) = &by_id {
                ensure!(
                    existing.conversation_id == conversation.id,
                    "Message ID belongs to another conversation"
                );
            }
            let by_provider: Option<Message> = if let Some(provider_id) = &incoming.provider_item_id
            {
                tx.query_row(
                    "SELECT data FROM messages WHERE conversation_id=?1 AND provider_item_id=?2",
                    params![conversation.id, provider_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(decode)
                .transpose()?
            } else {
                None
            };
            if let (Some(a), Some(b)) = (&by_id, &by_provider) {
                ensure!(a.id == b.id, "Provider item conflicts with another message");
            }
            let mut message = incoming.clone();
            if let Some(existing) = by_id.or(by_provider) {
                ensure!(
                    existing.role == message.role && existing.kind == message.kind,
                    "Message identity cannot change"
                );
                ensure!(
                    existing.provider_item_id.is_none()
                        || message.provider_item_id == existing.provider_item_id,
                    "Provider item identity cannot change"
                );
                // Accepted submissions remain immutable for idempotent retries.
                if existing.role == "user" {
                    // Providers may echo expanded file text or only image markers.
                    // Our accepted payload is authoritative for retries and display.
                    message.text = existing.text;
                    message.attachments = existing.attachments;
                    message.review_feedback = existing.review_feedback;
                }
                message.id = existing.id;
                message.sequence = existing.sequence;
            } else {
                ensure!(
                    message.sequence == 0,
                    "New messages must request sequence allocation with zero"
                );
                message.sequence = next_sequence(&tx, &conversation.id)?;
            }
            check_text(&message.text)?;
            if let Some(content) = &message.content {
                content.validate()?;
            }
            write_message(&tx, &message)?;
        }
        for request in requests {
            check_id(&request.id)?;
            ensure!(
                request.conversation_id == conversation.id,
                "Request belongs to another conversation"
            );
            let prior: Option<PendingRequest> = tx
                .query_row(
                    "SELECT data FROM requests WHERE id=?1",
                    [&request.id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(decode)
                .transpose()?;
            if let Some(prior) = prior {
                ensure!(
                    prior.conversation_id == request.conversation_id
                        && prior.run_id == request.run_id
                        && prior.rpc_id == request.rpc_id
                        && prior.method == request.method
                        && prior.params == request.params
                        && (prior.answer_fingerprint.is_none()
                            || prior.answer_fingerprint == request.answer_fingerprint)
                        && (!prior.answer_dispatched || request.answer_dispatched)
                        && request.answer_attempt >= prior.answer_attempt,
                    "Request identity cannot change"
                );
                ensure!(
                    matches!(prior.status.as_str(), "pending" | "responding")
                        || request.status == prior.status,
                    "Resolved request cannot be reopened or resolved again"
                );
            }
            tx.execute("INSERT INTO requests VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",params![request.id,request.conversation_id,request.status,encode(request)?])?;
        }
        tx.commit()?;
        crate::bench::elapsed("conversation_commit_us", started);
        Ok(())
    }
    pub fn recover_interrupted(&self) -> Result<()> {
        self.recover_except(&std::collections::HashSet::new())
    }
    pub fn recover_except(&self, live: &std::collections::HashSet<String>) -> Result<()> {
        let tx = self.transaction()?;
        for mut conversation in all::<Conversation>(&tx, "SELECT data FROM conversations")? {
            if live.contains(&conversation.id) {
                continue;
            }
            if BUSY.contains(&conversation.status.as_str()) {
                conversation.status = "interrupted".into();
                // Runtime loss interrupts queue ordering as well as the turn.
                // Resume reconciles history; only explicit queue continuation
                // may dispatch instructions that followed the interrupted one.
                conversation.queue_paused = true;
                conversation.error=Some("The daemon restarted during this turn. Its previous process and approval requests are no longer active; resume the conversation explicitly.".into());
                conversation.updated_at = now_ms();
            } else if conversation.provider_thread_id.is_some() && conversation.status == "ready" {
                conversation.status = "disconnected".into();
                conversation.updated_at = now_ms();
            }
            conversation.active_turn_id = None;
            write_conversation(&tx, &conversation)?;
        }
        for mut request in all::<PendingRequest>(
            &tx,
            "SELECT data FROM requests WHERE status IN ('pending','responding')",
        )? {
            if live.contains(&request.conversation_id) {
                continue;
            }
            request.status = "invalidated".into();
            tx.execute(
                "UPDATE requests SET status=?2,data=?3 WHERE id=?1",
                params![request.id, request.status, encode(&request)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn save_window(&self, window: &WindowRecord) -> Result<()> {
        check_id(&window.id)?;
        ensure!(
            (1..=5).contains(&window.focused_pane),
            "Unknown focused pane"
        );
        ensure!(window.panes.valid(), "Pane dimensions are out of bounds");
        ensure!(
            [window.x, window.y, window.width, window.height]
                .iter()
                .all(|n| n.is_finite()),
            "Window geometry must be finite"
        );
        ensure!(
            (1000.0..=10000.0).contains(&window.width)
                && (700.0..=10000.0).contains(&window.height),
            "Window dimensions are out of bounds"
        );
        let url = &window.browser_url;
        ensure!(
            url.len() <= 8192 && !url.chars().any(char::is_control),
            "Invalid browser URL"
        );
        ensure!(
            url.is_empty()
                || url == "about:blank"
                || ["http://", "https://"].iter().any(|scheme| url
                    .strip_prefix(scheme)
                    .is_some_and(|rest| !rest.is_empty()
                        && !rest.starts_with('/')
                        && !rest.chars().any(char::is_whitespace))),
            "Only the local fixture or HTTP(S) browser URLs may be persisted"
        );
        let tx = self.transaction()?;
        let _: WorkspaceRecord = one(&tx, "workspaces", &window.workspace_id)?;
        let tabs = &window.tabs;
        ensure!(
            tabs.terminals.len() <= 64
                && tabs.browsers.len() <= 32
                && tabs.closed_terminals.len() <= 32
                && tabs.closed_browsers.len() <= 16,
            "Too many tabs"
        );
        let mut ids = std::collections::HashSet::new();
        for tab in tabs.terminals.iter().chain(tabs.closed_terminals.iter()) {
            check_id(&tab.id)?;
            ensure!(
                ids.insert(&tab.id) && tab.title.len() <= 256,
                "Invalid terminal tab"
            );
            let workspace: WorkspaceRecord = one(&tx, "workspaces", &tab.workspace_id)?;
            ensure!(
                tab.id == workspace.terminal_id || workspace.extra_terminals.contains(&tab.id),
                "Unknown terminal tab"
            );
        }
        ids.clear();
        for tab in tabs.browsers.iter().chain(tabs.closed_browsers.iter()) {
            check_id(&tab.id)?;
            ensure!(
                ids.insert(&tab.id)
                    && tab.title.len() <= 256
                    && tab.url.len() <= 8192
                    && !tab.url.chars().any(char::is_control),
                "Invalid browser tab"
            );
            ensure!(
                tab.url.is_empty()
                    || ["http://", "https://"].iter().any(|scheme| tab
                        .url
                        .strip_prefix(scheme)
                        .is_some_and(|rest| !rest.is_empty()
                            && !rest.starts_with('/')
                            && !rest.chars().any(char::is_whitespace))),
                "Browser tabs require HTTP(S) URLs"
            );
        }
        ensure!(
            tabs.active_terminal.as_ref().is_none_or(|id| tabs
                .terminals
                .iter()
                .any(|t| &t.id == id && t.workspace_id == window.workspace_id)),
            "Active terminal must belong to the window workspace"
        );
        ensure!(
            tabs.active_browser
                .as_ref()
                .is_none_or(|id| tabs.browsers.iter().any(|t| &t.id == id)),
            "Unknown active browser tab"
        );
        if let Some(id) = &window.conversation_id {
            let conversation: Conversation = one(&tx, "conversations", id)?;
            ensure!(
                conversation.workspace_id == window.workspace_id,
                "Window conversation belongs to another workspace"
            );
        }
        tx.execute("INSERT INTO windows VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,conversation_id=excluded.conversation_id,data=excluded.data",params![window.id,window.workspace_id,window.conversation_id,encode(window)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn close_window(&self, id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM windows WHERE id=?1 AND (SELECT count(*) FROM windows)>1",
            [id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
fn migration_interruption_checkpoint() {
    let Some(marker) = std::env::var_os("ADE_STORE_MIGRATION_TEST_CHECKPOINT") else {
        return;
    };
    std::fs::write(marker, b"migration-six-uncommitted").unwrap();
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_reservation_is_atomic_durable_and_fences_prompt_admission() {
        let db = Database::new();
        let store = db.open();
        let (w, mut c) = fixture(&store);
        c.provider_thread_id = Some("native-session".into());
        c.status = "ready".into();
        store.commit_conversation(&c, &[], &[]).unwrap();
        store.enqueue(&c.id, "queued", "Keep queued").unwrap();
        let owned = store.reserve_terminal(&c.id, "runtime").unwrap();
        let owner = owned.terminal_owner.unwrap();
        assert!(
            store
                .workspace(&w.id)
                .unwrap()
                .extra_terminals
                .contains(&owner.terminal_id)
        );
        assert_eq!(
            store
                .reserve_terminal(&c.id, "runtime")
                .unwrap()
                .terminal_owner
                .unwrap()
                .transfer_id,
            owner.transfer_id
        );
        drop(store);
        let store = db.open();
        store.recover_interrupted().unwrap();
        assert!(store.conversation(&c.id).unwrap().queue_paused);
        assert!(store.terminal_reserved(&owner.terminal_id).unwrap());
        assert!(store.queue_heads().unwrap().is_empty());
        assert!(
            store
                .begin_turn(&c.id, "manual", "Cannot race the terminal")
                .is_err()
        );
        assert!(
            store
                .begin_queued_turn(&c.id, "queued", "Keep queued")
                .is_err()
        );
        assert_eq!(store.queued(&c.id).unwrap().len(), 1);
        assert!(store.message("manual").unwrap().is_none());
    }
    #[test]
    fn queue_consumption_is_atomic_ordered_and_not_replayed_after_restart() {
        let db = Database::new();
        let store = db.open();
        let (_, mut c) = fixture(&store);
        store.enqueue(&c.id, "first", "First").unwrap();
        store.enqueue(&c.id, "second", "Second").unwrap();
        assert!(store.begin_queued_turn(&c.id, "second", "Second").is_err());
        c.queue_paused = true;
        store.commit_conversation(&c, &[], &[]).unwrap();
        assert!(store.queue_heads().unwrap().is_empty());
        assert!(store.begin_queued_turn(&c.id, "first", "First").is_err());
        c.queue_paused = false;
        store.commit_conversation(&c, &[], &[]).unwrap();
        store.begin_queued_turn(&c.id, "first", "First").unwrap();
        assert_eq!(store.queued(&c.id).unwrap()[0].id, "second");
        drop(store);
        let store = db.open();
        assert!(store.message("first").unwrap().is_some());
        assert!(store.queue_heads().unwrap().is_empty());
        store.enqueue(&c.id, "first", "First").unwrap();
        assert_eq!(store.queued(&c.id).unwrap().len(), 1);
        store.cancel_queued(&c.id, "second").unwrap();
        store.enqueue(&c.id, "second", "Second").unwrap();
        assert!(store.queued(&c.id).unwrap().is_empty());
        assert!(store.begin_turn(&c.id, "second", "Second").is_err());
        assert!(store.cancel_queued(&c.id, "first").is_err());
    }
    #[test]
    fn attachment_migration_preserves_v5_drafts_and_queued_prompts() {
        let db = Database::new();
        let store = db.open();
        let (_, c) = fixture(&store);
        store
            .save_draft(
                &c.id,
                "window",
                &Draft {
                    text: "Draft before upgrade".into(),
                    revision: 4,
                    attachments: vec![],
                },
            )
            .unwrap();
        store
            .enqueue(&c.id, "queued-before-upgrade", "Queued before upgrade")
            .unwrap();
        store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DELETE FROM schema_migrations WHERE version=7; DROP TABLE attachments; ALTER TABLE drafts DROP COLUMN attachments; ALTER TABLE queued_prompts DROP COLUMN attachments; DELETE FROM schema_migrations WHERE version=6; PRAGMA user_version=5;").unwrap();
        drop(store);
        let store = db.open();
        let draft = store.draft(&c.id, "window").unwrap();
        assert_eq!(draft.text, "Draft before upgrade");
        assert_eq!(draft.revision, 4);
        assert!(draft.attachments.is_empty());
        let queued = store.queued(&c.id).unwrap();
        assert_eq!(queued[0].text, "Queued before upgrade");
        assert!(queued[0].attachments.is_empty());
        let attachment = store
            .attach(&c.id, "file", "example.txt", b"Snapshot")
            .unwrap();
        store
            .save_draft(
                &c.id,
                "window",
                &Draft {
                    text: draft.text,
                    revision: 5,
                    attachments: vec![attachment.clone()],
                },
            )
            .unwrap();
        drop(store);
        let store = db.open();
        assert_eq!(
            store.draft(&c.id, "window").unwrap().attachments.as_slice(),
            std::slice::from_ref(&attachment)
        );
        assert!(
            store.prompt(&c.id, "", &[attachment]).unwrap().attachments[0]
                .text_block()
                .unwrap()
                .ends_with("Snapshot")
        );
    }
    #[test]
    fn queue_migration_preserves_drafts_and_conversations() {
        let db = Database::new();
        let store = db.open();
        let (_, c) = fixture(&store);
        store
            .save_draft(
                &c.id,
                "window",
                &Draft {
                    attachments: vec![],
                    text: "Keep".into(),
                    revision: 1,
                },
            )
            .unwrap();
        store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DELETE FROM schema_migrations WHERE version=7; DROP TABLE attachments; ALTER TABLE drafts DROP COLUMN attachments; DROP TABLE queued_prompts; DELETE FROM schema_migrations WHERE version>=5; PRAGMA user_version=4;").unwrap();
        drop(store);
        let store = db.open();
        assert_eq!(store.draft(&c.id, "window").unwrap().text, "Keep");
        store.enqueue(&c.id, "queued", "New").unwrap();
        assert_eq!(store.queue_heads().unwrap()[0].id, "queued");
    }
    #[test]
    fn drafts_are_scoped_durable_and_ignore_late_writes() {
        let db = Database::new();
        let store = db.open();
        let (workspace, first) = fixture(&store);
        let second = store
            .create_with_provider(&workspace.id, "Second", "codex", Default::default())
            .unwrap();
        store
            .save_draft(
                &first.id,
                "window-a",
                &Draft {
                    attachments: vec![],
                    text: "First draft".into(),
                    revision: 2,
                },
            )
            .unwrap();
        store
            .save_draft(
                &first.id,
                "window-a",
                &Draft {
                    attachments: vec![],
                    text: "late stale draft".into(),
                    revision: 1,
                },
            )
            .unwrap();
        store
            .save_draft(
                &first.id,
                "window-b",
                &Draft {
                    attachments: vec![],
                    text: "Independent draft".into(),
                    revision: 1,
                },
            )
            .unwrap();
        assert!(store.draft(&second.id, "window-a").unwrap().text.is_empty());
        drop(store);
        let store = db.open();
        assert_eq!(
            store.draft(&first.id, "window-a").unwrap().text,
            "First draft"
        );
        assert_eq!(
            store.draft(&first.id, "window-b").unwrap().text,
            "Independent draft"
        );
        store
            .save_draft(
                &first.id,
                "window-a",
                &Draft {
                    attachments: vec![],
                    text: String::new(),
                    revision: 3,
                },
            )
            .unwrap();
        store
            .save_draft(
                &first.id,
                "window-a",
                &Draft {
                    attachments: vec![],
                    text: "stale retry".into(),
                    revision: 2,
                },
            )
            .unwrap();
        assert!(store.draft(&first.id, "window-a").unwrap().text.is_empty());
    }
    #[test]
    fn pristine_draft_is_read_only_and_revisioned_empty_save_still_clears() {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        let pristine = store.draft(&conversation.id, "window").unwrap();
        assert_eq!(pristine.revision, 0);
        assert!(pristine.text.is_empty());
        assert!(
            store
                .save_draft(&conversation.id, "window", &pristine)
                .is_err()
        );
        store
            .save_draft(
                &conversation.id,
                "window",
                &Draft {
                    text: "saved text".into(),
                    revision: 1,
                    attachments: vec![],
                },
            )
            .unwrap();
        assert!(
            store
                .save_draft(&conversation.id, "window", &pristine)
                .is_err()
        );
        assert_eq!(
            store.draft(&conversation.id, "window").unwrap().text,
            "saved text"
        );
        store
            .save_draft(
                &conversation.id,
                "window",
                &Draft {
                    text: String::new(),
                    revision: 2,
                    attachments: vec![],
                },
            )
            .unwrap();
        let cleared = store.draft(&conversation.id, "window").unwrap();
        assert!(cleared.text.is_empty());
        assert_eq!(cleared.revision, 2);
    }
    #[test]
    fn draft_resolution_rejects_intervening_writer_and_preserves_text() {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        let draft = |text: &str, revision| Draft {
            text: text.into(),
            revision,
            attachments: vec![],
        };
        store
            .save_draft(&conversation.id, "window", &draft("third writer", 8))
            .unwrap();
        let stale = store
            .resolve_draft(&conversation.id, "window", &draft("chosen local", 9), 7)
            .unwrap();
        assert_eq!(stale.text, "third writer");
        assert_eq!(stale.revision, 8);
        let resolved = store
            .resolve_draft(&conversation.id, "window", &draft("chosen local", 9), 8)
            .unwrap();
        assert_eq!(resolved.text, "chosen local");
        assert_eq!(resolved.revision, 9);
    }
    #[test]
    fn draft_migration_preserves_existing_conversations() {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DROP TABLE attachments; DROP TABLE drafts; DROP TABLE queued_prompts; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3;").unwrap();
        drop(store);
        let store = db.open();
        assert_eq!(
            store.conversation(&conversation.id).unwrap().title,
            conversation.title
        );
        assert!(
            store
                .draft(&conversation.id, "window-a")
                .unwrap()
                .text
                .is_empty()
        );
    }
    struct Database {
        directory: std::path::PathBuf,
    }
    impl Database {
        fn new() -> Self {
            Self {
                directory: std::env::temp_dir().join(new_id("ade-store-test")),
            }
        }
        fn path(&self) -> std::path::PathBuf {
            self.directory.join("state.sqlite")
        }
        fn open(&self) -> Store {
            Store::open(&self.path()).unwrap()
        }
    }
    impl Drop for Database {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    #[test]
    fn new_submission_identity_is_durable_with_its_prompt() {
        let db = Database::new();
        let store = db.open();
        let (_, mut c) = fixture(&store);
        c.runtime_run = Some("existing-run".into());
        c.runtime_submission = Some("old-submission".into());
        c.status = "ready".into();
        store.commit_conversation(&c, &[], &[]).unwrap();
        store
            .begin_turn(&c.id, "new-submission", "new prompt")
            .unwrap();
        drop(store); // daemon dies before any subsequent transaction or send
        let recovered = db.open().conversation(&c.id).unwrap();
        assert_eq!(
            recovered.runtime_submission.as_deref(),
            Some("new-submission")
        );
        assert_eq!(recovered.runtime_run.as_deref(), Some("existing-run"));
        assert_eq!(recovered.status, "starting");
    }
    #[test]
    fn event_cursor_and_projection_commit_or_rollback_together() {
        let db = Database::new();
        let store = db.open();
        let (_, mut c) = fixture(&store);
        c.runtime_run = Some("run".into());
        c.runtime_cursor = 1;
        let message = assistant(&c, "event-message", "provider-item");
        store
            .commit_conversation(&c, std::slice::from_ref(&message), &[])
            .unwrap();
        c.runtime_cursor = 2;
        let mut invalid = message;
        invalid.conversation_id = "another-conversation".into();
        assert!(store.commit_conversation(&c, &[invalid], &[]).is_err());
        drop(store);
        let reopened = db.open();
        assert_eq!(reopened.conversation(&c.id).unwrap().runtime_cursor, 1);
        assert_eq!(
            reopened.message("event-message").unwrap().unwrap().text,
            "hello"
        );
    }
    fn fixture(store: &Store) -> (WorkspaceRecord, Conversation) {
        let workspace = store
            .workspace_open("/test/project", Some("/test/project"))
            .unwrap();
        let conversation = store.create_conversation(&workspace.id, "Test").unwrap();
        (workspace, conversation)
    }
    #[test]
    fn structured_plan_updates_survive_reopen_and_reject_invalid_content() {
        use crate::transcript::{Content, PlanStep, StepStatus};
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        let mut message = assistant(&conversation, "plan-message", "turn:plan");
        message.kind = "plan".into();
        message.content = Some(Content::Plan {
            explanation: None,
            steps: vec![PlanStep {
                step: "Inspect".into(),
                status: StepStatus::InProgress,
            }],
        });
        store
            .commit_conversation(&conversation, &[message.clone()], &[])
            .unwrap();
        let sequence = store.message(&message.id).unwrap().unwrap().sequence;
        message.content = Some(Content::Plan {
            explanation: None,
            steps: vec![PlanStep {
                step: "Inspect".into(),
                status: StepStatus::Completed,
            }],
        });
        store
            .commit_conversation(&conversation, &[message.clone()], &[])
            .unwrap();
        drop(store);
        let store = db.open();
        let restored = store.message(&message.id).unwrap().unwrap();
        assert_eq!(restored.content, message.content);
        assert_eq!(restored.sequence, sequence);
        message.content = Some(Content::Plan {
            explanation: None,
            steps: vec![PlanStep {
                step: String::new(),
                status: StepStatus::Pending,
            }],
        });
        assert!(
            store
                .commit_conversation(&conversation, &[message], &[])
                .is_err()
        );
        assert_eq!(
            store.message("plan-message").unwrap().unwrap().content,
            restored.content
        );
    }
    fn assistant(conversation: &Conversation, id: &str, provider: &str) -> Message {
        Message {
            content: None,
            review_feedback: None,
            attachments: vec![],
            id: id.into(),
            conversation_id: conversation.id.clone(),
            role: "assistant".into(),
            kind: "text".into(),
            text: "hello".into(),
            status: "completed".into(),
            turn_id: Some("turn-1".into()),
            provider_item_id: Some(provider.into()),
            sequence: 0,
        }
    }
    fn window(workspace: &WorkspaceRecord, conversation: &Conversation, id: &str) -> WindowRecord {
        WindowRecord {
            dock_layout: None,
            panes: Default::default(),
            tabs: Default::default(),
            focused_pane: 5,
            id: id.into(),
            workspace_id: workspace.id.clone(),
            conversation_id: Some(conversation.id.clone()),
            browser_url: String::new(),
            x: 10.0,
            y: 20.0,
            width: 1200.0,
            height: 800.0,
        }
    }
    #[test]
    fn pane_layout_restores_and_rejects_invalid_sizes() {
        let db = Database::new();
        let store = db.open();
        let (workspace, conversation) = fixture(&store);
        let mut record = window(&workspace, &conversation, "layout-window");
        record.panes.sidebar_visible = false;
        record.panes.browser_width = 420.;
        record.dock_layout = Some(serde_json::json!({"active_panel":"pane-test","closed":[]}));
        store.save_window(&record).unwrap();
        drop(store);
        let store = db.open();
        let restored = store.catalog().unwrap().windows.remove(0);
        assert!(!restored.panes.sidebar_visible);
        assert_eq!(restored.panes.browser_width, 420.);
        assert_eq!(restored.dock_layout, record.dock_layout);
        for invalid in [f32::NAN, f32::INFINITY, 0., 601.] {
            record.panes.browser_width = invalid;
            assert!(store.save_window(&record).is_err());
        }
        let mut legacy = serde_json::to_value(&restored).unwrap();
        legacy.as_object_mut().unwrap().remove("panes");
        let legacy: WindowRecord = serde_json::from_value(legacy).unwrap();
        assert!(
            legacy.panes.sidebar_visible
                && legacy.panes.terminal_visible
                && !legacy.panes.browser_visible
        );
        assert!(legacy.panes.valid());
    }
    #[test]
    fn tabs_validate_ownership_and_restore_closed_views() {
        let db = Database::new();
        let store = db.open();
        let (workspace, conversation) = fixture(&store);
        let extra = store.create_terminal(&workspace.id).unwrap();
        let mut record = window(&workspace, &conversation, "tabs-window");
        record.tabs.initialized = true;
        let tab = TerminalTab {
            id: extra.clone(),
            workspace_id: workspace.id.clone(),
            title: "Second shell".into(),
        };
        record.tabs.terminals.push(tab.clone());
        record.tabs.active_terminal = Some(extra.clone());
        store.save_window(&record).unwrap();
        record.tabs.closed_terminals.push(tab.clone());
        assert!(
            store.save_window(&record).is_err(),
            "open/closed duplicates must be rejected"
        );
        record.tabs.terminals.clear();
        assert!(
            store.save_window(&record).is_err(),
            "active terminal must be an open view"
        );
        record.tabs.active_terminal = None;
        store.save_window(&record).unwrap();
        record.tabs.closed_terminals[0].id = "unknown-shell".into();
        assert!(store.save_window(&record).is_err());
        let other = store.workspace_open("/test/other", None).unwrap();
        record.tabs.closed_terminals[0] = TerminalTab {
            workspace_id: other.id,
            ..tab
        };
        assert!(
            store.save_window(&record).is_err(),
            "terminal identity cannot move between workspaces"
        );
        drop(store);
        let reopened = db.open();
        assert!(
            reopened
                .workspace(&workspace.id)
                .unwrap()
                .extra_terminals
                .contains(&extra)
        );
        let restored = reopened.catalog().unwrap().windows.remove(0);
        assert_eq!(restored.tabs.closed_terminals[0].id, extra);
        let mut legacy = serde_json::to_value(&restored).unwrap();
        legacy.as_object_mut().unwrap().remove("tabs");
        assert!(
            !serde_json::from_value::<WindowRecord>(legacy)
                .unwrap()
                .tabs
                .initialized
        );
    }
    #[test]
    fn reopen_retains_identity_history_resume_and_windows() {
        let db = Database::new();
        let store = db.open();
        let (workspace, mut conversation) = fixture(&store);
        let original = store
            .begin_turn(&conversation.id, "submission-1", "prompt")
            .unwrap();
        conversation.status = "idle".into();
        conversation.provider_thread_id = Some("provider-thread".into());
        store
            .commit_conversation(
                &conversation,
                &[assistant(&conversation, "answer", "provider-item")],
                &[],
            )
            .unwrap();
        store
            .save_window(&window(&workspace, &conversation, "window-1"))
            .unwrap();
        store
            .save_window(&window(&workspace, &conversation, "window-2"))
            .unwrap();
        store.close_window("window-2").unwrap();
        store.close_window("window-1").unwrap();
        drop(store);
        let store = db.open();
        let reopened = store
            .workspace_open("/test/project", Some("/test/project"))
            .unwrap();
        assert_eq!(workspace.id, reopened.id);
        assert_eq!(workspace.repository_id, reopened.repository_id);
        assert_eq!(workspace.terminal_id, reopened.terminal_id);
        assert_eq!(
            store
                .conversation(&conversation.id)
                .unwrap()
                .provider_thread_id
                .as_deref(),
            Some("provider-thread")
        );
        let messages = store.messages(&conversation.id, None, 200).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, original.message.id);
        assert_eq!(store.catalog().unwrap().windows[0].id, "window-1");
    }
    #[test]
    fn recovery_invalidates_requests_but_keeps_resume_and_submission() {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        let mut conversation = store
            .begin_turn(&conversation.id, "submission", "prompt")
            .unwrap()
            .conversation;
        conversation.status = "waiting".into();
        conversation.provider_thread_id = Some("thread".into());
        conversation.active_turn_id = Some("turn".into());
        let request = PendingRequest {
            id: "permission".into(),
            conversation_id: conversation.id.clone(),
            run_id: "run".into(),
            rpc_id: serde_json::json!({"opaque":[1,"a"]}),
            method: "approval".into(),
            params: serde_json::json!({"command":"test"}),
            status: "pending".into(),
            answer_fingerprint: None,
            answer_dispatched: false,
            answer_attempt: 0,
        };
        store
            .commit_conversation(&conversation, &[], std::slice::from_ref(&request))
            .unwrap();
        drop(store);
        let store = db.open();
        store.recover_interrupted().unwrap();
        let recovered = store.conversation(&conversation.id).unwrap();
        assert_eq!(recovered.status, "interrupted");
        assert!(recovered.error.is_some());
        assert!(recovered.active_turn_id.is_none());
        assert_eq!(
            recovered.provider_thread_id,
            conversation.provider_thread_id
        );
        assert!(store.pending(&conversation.id).unwrap().is_empty());
        assert!(
            store
                .begin_turn(&conversation.id, "submission", "prompt")
                .unwrap()
                .duplicate
        );
        assert!(
            store
                .commit_conversation(&recovered, &[], &[request])
                .is_err()
        );
        assert!(
            !store
                .begin_turn(&conversation.id, "new-submission", "new prompt")
                .unwrap()
                .duplicate
        );
    }
    #[test]
    fn submissions_are_idempotent_even_while_busy_and_reject_key_reuse() {
        let db = Database::new();
        let store = db.open();
        let (workspace, conversation) = fixture(&store);
        store
            .begin_turn(&conversation.id, "request", "prompt")
            .unwrap();
        assert!(
            store
                .begin_turn(&conversation.id, "request", "prompt")
                .unwrap()
                .duplicate
        );
        assert!(
            store
                .begin_turn(&conversation.id, "request", "different")
                .is_err()
        );
        assert!(store.begin_turn(&conversation.id, "next", "next").is_err());
        let other = store.create_conversation(&workspace.id, "other").unwrap();
        assert!(store.begin_turn(&other.id, "request", "prompt").is_err());
        assert_eq!(store.conversation(&other.id).unwrap().status, "idle");
        assert!(
            store
                .begin_turn(&other.id, "huge", &"a".repeat(TEXT_LIMIT + 1))
                .is_err()
        );
        assert_eq!(
            store.messages(&conversation.id, None, 200).unwrap().len(),
            1
        );
    }
    #[test]
    fn transaction_rejects_cross_conversation_writes_without_partial_changes() {
        let db = Database::new();
        let store = db.open();
        let (workspace, mut conversation) = fixture(&store);
        let other = store.create_conversation(&workspace.id, "other").unwrap();
        let first = assistant(&conversation, "m1", "p1");
        store
            .commit_conversation(&conversation, std::slice::from_ref(&first), &[])
            .unwrap();
        conversation.title = "must roll back".into();
        let wrong = assistant(&other, "m2", "p2");
        assert!(
            store
                .commit_conversation(
                    &conversation,
                    &[assistant(&conversation, "m3", "p3"), wrong],
                    &[]
                )
                .is_err()
        );
        assert_eq!(store.conversation(&conversation.id).unwrap().title, "Test");
        assert_eq!(
            store.messages(&conversation.id, None, 200).unwrap().len(),
            1
        );
        let mut stolen = first;
        stolen.conversation_id = other.id.clone();
        assert!(store.commit_conversation(&other, &[stolen], &[]).is_err());
    }
    #[test]
    fn provider_replay_retains_message_identity_and_sequence_with_bounded_pages() {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        let messages: Vec<_> = (0..205)
            .map(|i| assistant(&conversation, &format!("m{i}"), &format!("p{i}")))
            .collect();
        store
            .commit_conversation(&conversation, &messages, &[])
            .unwrap();
        let mut replay = assistant(&conversation, "different-id", "p0");
        replay.text = "final".into();
        store
            .commit_conversation(&conversation, &[replay], &[])
            .unwrap();
        let page = store.messages(&conversation.id, None, usize::MAX).unwrap();
        assert_eq!(page.len(), 200);
        assert_eq!(page[0].sequence, 6);
        assert_eq!(page.last().unwrap().sequence, 205);
        let old = store
            .messages(&conversation.id, Some(page[0].sequence), 200)
            .unwrap();
        assert_eq!(old.len(), 5);
        assert_eq!(old[0].id, "m0");
        assert_eq!(old[0].text, "final");
        assert_eq!(old[0].sequence, 1);
        assert!(store.message("different-id").unwrap().is_none());
        assert!(
            store
                .messages(&conversation.id, None, 0)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn invalid_windows_and_future_database_fail_without_clobbering() {
        let db = Database::new();
        let store = db.open();
        let (workspace, conversation) = fixture(&store);
        let mut value = window(&workspace, &conversation, "w");
        value.width = f32::NAN;
        assert!(store.save_window(&value).is_err());
        value.width = 999.0;
        assert!(store.save_window(&value).is_err());
        value.width = 1200.0;
        value.browser_url = "file:///etc/passwd".into();
        assert!(store.save_window(&value).is_err());
        value.browser_url = "https://example.com/path".into();
        store.save_window(&value).unwrap();
        let other = store.workspace_open("/test/other", None).unwrap();
        value.workspace_id = other.id;
        assert!(store.save_window(&value).is_err());
        assert_eq!(
            store.catalog().unwrap().windows[0].workspace_id,
            workspace.id
        );
        store
            .connection
            .pragma_update(None, "user_version", 99)
            .unwrap();
        drop(store);
        assert!(Store::open(&db.path()).is_err());
        let conn = Connection::open(db.path()).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            99
        );
    }
    fn migration_v5_fixture() -> (Database, String) {
        let db = Database::new();
        let store = db.open();
        let (_, conversation) = fixture(&store);
        store
            .save_draft(
                &conversation.id,
                "migration-window",
                &Draft {
                    text: "unsent migration draft".into(),
                    revision: 8,
                    attachments: vec![],
                },
            )
            .unwrap();
        store
            .enqueue(&conversation.id, "migration-queued", "saved queued prompt")
            .unwrap();
        store
            .connection
            .execute_batch(
                "DROP TABLE service_ports; DROP TABLE services;
            DELETE FROM schema_migrations WHERE version >= 6; DROP TABLE attachments;
            ALTER TABLE drafts DROP COLUMN attachments;
            ALTER TABLE queued_prompts DROP COLUMN attachments; PRAGMA user_version=5;",
            )
            .unwrap();
        (db, conversation.id)
    }

    fn assert_v5_migration_rolled_back(db: &Database, conversation: &str) {
        let connection = Connection::open(db.path()).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='attachments'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('drafts') WHERE name='attachments'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM pragma_table_info('queued_prompts') WHERE name='attachments'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version>=6",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT text FROM drafts WHERE conversation_id=?1",
                    [conversation],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "unsent migration draft"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT text FROM queued_prompts WHERE conversation_id=?1",
                    [conversation],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "saved queued prompt"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM conversations WHERE id=?1",
                    [conversation],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_sql_failure_rolls_back_ddl_and_preserves_data_for_retry() {
        let (db, conversation) = migration_v5_fixture();
        let connection = Connection::open(db.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_migration_six BEFORE INSERT ON schema_migrations
            WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END;",
            )
            .unwrap();
        drop(connection);
        let failure = Store::open(&db.path()).err().expect("migration must fail");
        assert!(failure.to_string().contains("fixture migration failure"));
        assert_v5_migration_rolled_back(&db, &conversation);
        let connection = Connection::open(db.path()).unwrap();
        connection
            .execute_batch("DROP TRIGGER reject_migration_six")
            .unwrap();
        drop(connection);
        let restored = db.open();
        assert_eq!(
            restored
                .draft(&conversation, "migration-window")
                .unwrap()
                .text,
            "unsent migration draft"
        );
        assert_eq!(
            restored.queued(&conversation).unwrap()[0].text,
            "saved queued prompt"
        );
        assert_eq!(
            restored
                .connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn newer_schema_rejection_preserves_original_database_bytes_and_journal() {
        let db = Database::new();
        std::fs::create_dir_all(&db.directory).unwrap();
        let connection = Connection::open(db.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE future_payload(id INTEGER PRIMARY KEY, value BLOB);
            INSERT INTO future_payload VALUES(1, X'0001FF'); PRAGMA user_version=99;",
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(db.path()).unwrap();
        let failure = Store::open(&db.path())
            .err()
            .expect("future schema must fail");
        assert!(
            failure
                .to_string()
                .contains("Unsupported database version 99")
        );
        assert_eq!(std::fs::read(db.path()).unwrap(), before);
        assert!(!db.path().with_extension("sqlite-wal").exists());
        assert!(!db.path().with_extension("sqlite-shm").exists());
        let connection = Connection::open(db.path()).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
    }

    #[test]
    #[ignore = "subprocess entry point used by migration kill regression"]
    fn migration_interruption_child() {
        let path = std::env::var_os("ADE_STORE_MIGRATION_TEST_DB").expect("test DB path");
        Store::open(Path::new(&path)).unwrap();
        panic!("migration unexpectedly completed instead of reaching checkpoint");
    }

    #[test]
    fn killed_migration_rolls_back_and_next_start_preserves_saved_data() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let (db, conversation) = migration_v5_fixture();
        let marker = db.directory.join("migration-checkpoint");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::tests::migration_interruption_child",
                "--ignored",
                "--nocapture",
            ])
            .env("ADE_STORE_MIGRATION_TEST_DB", db.path())
            .env("ADE_STORE_MIGRATION_TEST_CHECKPOINT", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Always reap the child, including assertion failures, so test timeouts
        // never leave a writer holding the fixture database open.
        let reached = marker.exists();
        let _ = child.kill();
        let status = child.wait().unwrap();
        assert!(reached, "child did not reach real uncommitted migration");
        assert!(!status.success());
        assert_v5_migration_rolled_back(&db, &conversation);
        let restored = db.open();
        assert_eq!(
            restored
                .draft(&conversation, "migration-window")
                .unwrap()
                .text,
            "unsent migration draft"
        );
        assert_eq!(
            restored.queued(&conversation).unwrap()[0].text,
            "saved queued prompt"
        );
    }
}
