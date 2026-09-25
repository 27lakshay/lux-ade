//! The daemon is the sole writer; windows persist references, never process handles.
use crate::model::*;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;

const TEXT_LIMIT: usize = 1024 * 1024;
const BUSY: &[&str] = &["starting", "running", "waiting", "cancelling"];
pub struct Store {
    pub(crate) connection: Connection,
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
        let (owner, metadata): (String, String) = db
            .query_row(
                "SELECT conversation_id,metadata FROM attachments WHERE id=?1",
                [&attachment.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .context("Attachment is missing; attach the file again")?;
        ensure!(
            owner == conversation && decode::<Attachment>(metadata)? == *attachment,
            "Attachment does not belong to this Conversation or its metadata changed"
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
        let prior: Option<(String, String, Vec<u8>)> = tx
            .query_row(
                "SELECT conversation_id,metadata,data FROM attachments WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((owner, metadata, data)) = prior {
            ensure!(
                owner == conversation
                    && decode::<Attachment>(metadata)? == attachment
                    && data == bytes,
                "Attachment ID was already used for different content"
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
            "INSERT INTO attachments(id,conversation_id,metadata,data) VALUES(?1,?2,?3,?4)",
            params![id, conversation, encode(&attachment)?, bytes],
        )?;
        tx.commit()?;
        Ok(attachment)
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
                    "SELECT data FROM attachments WHERE id=?1",
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
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            (0..=7).contains(&version),
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
        Ok(Self { connection })
    }
    pub fn draft(&self, conversation: &str, window: &str) -> Result<Draft> {
        self.conversation(conversation)?;
        check_id(window)?;
        Ok(self
            .connection
            .query_row(
                "SELECT text,revision,attachments FROM drafts WHERE conversation_id=?1 AND window_id=?2",
                params![conversation, window],
                |row| {
                    Ok(Draft {
                        text: row.get(0)?,
                        revision: row.get(1)?,
                        attachments: attachment_row(row, 2)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
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
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE (json_extract(data,'$.terminal_owner.terminal_id')=?1 OR json_extract(data,'$.view_terminal.terminal_id')=?1) UNION ALL SELECT 1 FROM services WHERE json_extract(data,'$.terminal_id')=?1)", [terminal], |row| row.get(0))?)
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
        let tx = self.transaction()?;
        let existing: Option<String> = tx
            .query_row("SELECT data FROM workspaces WHERE root=?1", [root], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(existing) = existing {
            return decode(existing);
        }
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
                };
                tx.execute(
                    "INSERT INTO repositories VALUES(?1,?2,?3)",
                    params![repository.id, repository.root, encode(&repository)?],
                )?;
                repository.id
            })
        } else {
            None
        };
        let workspace = WorkspaceRecord {
            extra_terminals: Vec::new(),
            id: new_id("workspace"),
            repository_id,
            root: root.into(),
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
        provider_config.validate(provider)?;
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
    pub fn pending(&self, id: &str) -> Result<Vec<PendingRequest>> {
        self.conversation(id)?;
        let mut statement = self.connection.prepare("SELECT data FROM requests WHERE conversation_id=?1 AND status IN ('pending','responding') ORDER BY rowid")?;
        statement
            .query_map([id], |r| r.get::<_, String>(0))?
            .map(|row| decode(row?))
            .collect()
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
                    && message.attachments == attachments,
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
        let old: Conversation = one(&tx, "conversations", &conversation.id)?;
        ensure!(
            old.workspace_id == conversation.workspace_id && old.provider == conversation.provider,
            "Conversation identity cannot change"
        );
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
                        && prior.params == request.params,
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
