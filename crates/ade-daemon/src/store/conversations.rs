use super::*;

/// Where a prompt stands after `enqueue_content` inserted or found it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueEntry {
    /// Waiting in the queue.
    Queued,
    /// Already submitted to the provider.
    Delivered,
    /// Cancelled before delivery; it will not run.
    Cancelled,
}

/// Statuses from which an unpaused queue dispatches its head. Every move into
/// `interrupted` or `error` pauses the queue, so these dispatch only after the
/// user resumes it, as `agent.send` may. Keep in step with `queue_heads`.
pub const QUEUE_DISPATCH_STATUSES: &[&str] = &["idle", "ready", "interrupted", "error"];

/// The refusal for a disabled account, the same when a Conversation is
/// created on it and when its Agent launches.
pub const ACCOUNT_DISABLED: &str =
    "Conversation account is disabled in ADE; create or choose another account";

pub(crate) const HISTORY_EPOCHS: &str = "CREATE TABLE IF NOT EXISTS conversation_history_epochs(conversation_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=0));";

/// One row per deleted Conversation. The `conversations` row stays behind the
/// tombstone as the anchor its attachment payloads reference until retention
/// reclaims them, but nothing reads or writes it as a live Conversation again.
/// `Store::open` creates the table; it has no numbered migration.
pub(crate) const TOMBSTONES: &str = "CREATE TABLE IF NOT EXISTS conversation_tombstones(conversation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, deleted_at INTEGER NOT NULL);";

/// SQL that keeps only Conversations without a tombstone; `c` is the alias.
pub(crate) const NOT_DELETED: &str =
    "NOT EXISTS(SELECT 1 FROM conversation_tombstones t WHERE t.conversation_id=c.id)";

pub(crate) fn is_deleted(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_tombstones WHERE conversation_id=?1)",
        [id],
        |row| row.get(0),
    )?)
}

/// The Conversation, refused as deleted when it has a tombstone.
pub(super) fn live_conversation(db: &Connection, id: &str) -> Result<Conversation> {
    let conversation = one(db, "conversations", id)?;
    if is_deleted(db, id)? {
        return Err(ade_core::error::ConversationDeleted(id.to_owned()).into());
    }
    Ok(conversation)
}

/// What [`delete_conversation`] removed.
pub struct Deleted {
    pub conversation: Conversation,
    pub removed: ade_core::contract::conversations::ConversationDeletion,
    pub attachments_left: u64,
    /// Layouts that lost the Conversation's tabs, for the caller to publish.
    pub layouts: Vec<ade_core::contract::layout::LayoutRecord>,
}

/// Deletes rows of `table` that belong to the Conversation; a table no
/// feature has created yet holds none.
fn delete_rows(db: &Connection, table: &str, id: &str) -> Result<u64> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    Ok(db.execute(
        &format!("DELETE FROM {table} WHERE conversation_id=?1"),
        [id],
    )? as u64)
}

/// Deletes a Conversation inside the caller's transaction, which also holds
/// its receipt. Refuses one that runs a turn or that a terminal owns. The
/// messages go, and the history index drops them through its delete
/// journal; so do the pending requests, drafts, draft history and stashes,
/// context captures, queue, send intents, snooze and account-switch records.
/// Its tabs leave every layout. Attachment payloads stay: nothing
/// references them now, so retention's attachment rule reclaims them after
/// its grace period, and never one that something still references.
pub fn delete_conversation(
    db: &Connection,
    id: &str,
    operation_id: &str,
    now: i64,
) -> Result<Deleted> {
    let conversation = live_conversation(db, id)?;
    ensure!(
        !BUSY.contains(&conversation.status.as_str()) && conversation.active_turn_id.is_none(),
        "Cancel the active turn before deleting this Conversation"
    );
    ensure!(
        conversation.terminal_owner.is_none(),
        "Return this Conversation from its terminal before deleting it"
    );
    let layouts = super::layouts::remove_target(
        db,
        &ade_core::contract::layout::TabTarget::Conversation { id: id.to_owned() },
    )?;
    let removed = ade_core::contract::conversations::ConversationDeletion {
        messages: delete_rows(db, "messages", id)?,
        requests: delete_rows(db, "requests", id)?,
        drafts: delete_rows(db, "drafts", id)? + delete_rows(db, "draft_context", id)?,
        draft_history: delete_rows(db, "draft_history", id)?,
        draft_stashes: delete_rows(db, "draft_stashes", id)?,
        queued_prompts: delete_rows(db, "queued_prompts", id)?,
        send_intents: delete_rows(db, "send_intents", id)?,
        snoozes: delete_rows(db, "conversation_snoozes", id)?,
        layouts_changed: layouts.len() as u64,
    };
    delete_rows(db, "context_nodes", id)?;
    delete_rows(db, "account_switches", id)?;
    db.execute(
        "INSERT INTO conversation_tombstones(conversation_id,operation_id,deleted_at) VALUES(?1,?2,?3)",
        params![id, operation_id, now],
    )?;
    let attachments_left: i64 = db.query_row(
        "SELECT count(*) FROM attachments WHERE conversation_id=?1 AND state='live'",
        [id],
        |row| row.get(0),
    )?;
    Ok(Deleted {
        conversation,
        removed,
        attachments_left: attachments_left.max(0) as u64,
        layouts,
    })
}

pub(super) fn message_by_id(db: &Connection, id: &str) -> Result<Option<Message>> {
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
pub(super) fn write_conversation(db: &Connection, conversation: &Conversation) -> Result<()> {
    let old: Conversation = live_conversation(db, &conversation.id)?;
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
    pub fn conversation(&self, id: &str) -> Result<Conversation> {
        live_conversation(&self.connection, id)
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
        self.insert_conversation(workspace_id, title, provider, provider_config, account_id)
    }
    /// Creates a Conversation on a provider outside the static catalogue: a
    /// generic adapter or a plugin provider, validated against the descriptor
    /// its registry entry publishes. Such providers manage no accounts.
    pub fn create_registered(
        &self,
        workspace_id: &str,
        title: &str,
        descriptor: &crate::provider::Descriptor,
        provider_config: crate::provider::Config,
    ) -> Result<Conversation> {
        provider_config.validate_against(descriptor)?;
        self.insert_conversation(workspace_id, title, &descriptor.id, provider_config, None)
    }
    fn insert_conversation(
        &self,
        workspace_id: &str,
        title: &str,
        provider: &str,
        provider_config: crate::provider::Config,
        account_id: Option<&str>,
    ) -> Result<Conversation> {
        if let Some(id) = account_id {
            let account = self.account(id)?;
            ensure!(
                account.provider == provider,
                "Account belongs to another provider"
            );
            // Fail closed now rather than at the first launch.
            ensure!(account.state != "disabled", ACCOUNT_DISABLED);
        }
        check_text(title)?;
        let conversation = Conversation {
            terminal_owner: None,
            view_terminal: None,
            queue_paused: false,
            queue_resumed_during: None,
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
    /// How many times a rewind replaced this Conversation's history (F039).
    /// The table is created on first use rather than by a numbered migration.
    pub fn history_epoch(&self, conversation: &str) -> Result<u64> {
        self.connection.execute_batch(HISTORY_EPOCHS)?;
        let epoch: Option<i64> = self
            .connection
            .query_row(
                "SELECT epoch FROM conversation_history_epochs WHERE conversation_id=?1",
                [conversation],
                |row| row.get(0),
            )
            .optional()?;
        Ok(epoch.unwrap_or(0).max(0) as u64)
    }
    /// Every message from `sequence` on, oldest first.
    pub fn messages_from(&self, conversation: &str, sequence: i64) -> Result<Vec<Message>> {
        let mut statement = self.connection.prepare(
            "SELECT data FROM messages WHERE conversation_id=?1 AND sequence>=?2 ORDER BY sequence",
        )?;
        let messages = statement
            .query_map(params![conversation, sequence], |r| r.get::<_, String>(0))?
            .map(|row| decode(row?))
            .collect::<Result<_>>()?;
        Ok(messages)
    }
    /// Removes every message from `sequence` on and moves the history epoch,
    /// in one transaction with `settle`, which records the operation's
    /// outcome. Returns how many messages went and the new epoch. The search
    /// index drops them through its delete journal. `moved` names the
    /// provider session the rewind left and the fork it continues in; the
    /// Conversation moves only if it is still on the session it left.
    pub fn rewind_history(
        &self,
        conversation: &str,
        sequence: i64,
        moved: Option<(&str, &str)>,
        settle: impl FnOnce(&Connection, u64, u64) -> Result<()>,
    ) -> Result<(u64, u64)> {
        self.connection.execute_batch(HISTORY_EPOCHS)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if let Some((from, to)) = moved {
            let mut current: Conversation = live_conversation(&tx, conversation)?;
            ensure!(
                current.provider_thread_id.as_deref() == Some(from),
                "The Conversation's provider session changed during the rewind"
            );
            current.provider_thread_id = Some(to.to_owned());
            current.updated_at = now_ms();
            write_conversation(&tx, &current)?;
        }
        let removed = tx.execute(
            "DELETE FROM messages WHERE conversation_id=?1 AND sequence>=?2",
            params![conversation, sequence],
        )?;
        tx.execute(
            "INSERT INTO conversation_history_epochs(conversation_id,epoch) VALUES(?1,1)
             ON CONFLICT(conversation_id) DO UPDATE SET epoch=epoch+1",
            [conversation],
        )?;
        let epoch: i64 = tx.query_row(
            "SELECT epoch FROM conversation_history_epochs WHERE conversation_id=?1",
            [conversation],
            |row| row.get(0),
        )?;
        let epoch = epoch.max(0) as u64;
        settle(&tx, removed as u64, epoch)?;
        tx.commit()?;
        Ok((removed as u64, epoch))
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
        self.enqueue_content(conversation, id, text, &[]).map(drop)
    }
    /// Queues a prompt under `id`, or finds the same prompt already under it
    /// and reports where it stands.
    /// Where a queued prompt stands now, without changing anything. `None`
    /// when no prompt or message has this ID.
    pub fn queue_entry(&self, id: &str) -> Result<Option<QueueEntry>> {
        if message_by_id(&self.connection, id)?.is_some() {
            return Ok(Some(QueueEntry::Delivered));
        }
        let state: Option<String> = self
            .connection
            .query_row(
                "SELECT status FROM queued_prompts WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(state.map(|state| match state.as_str() {
            "cancelled" => QueueEntry::Cancelled,
            "submitted" => QueueEntry::Delivered,
            _ => QueueEntry::Queued,
        }))
    }
    pub fn enqueue_content(
        &self,
        conversation: &str,
        id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<QueueEntry> {
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
            return Ok(QueueEntry::Delivered);
        }
        let prior: Option<(String, String, Vec<Attachment>, String)> = tx
            .query_row(
                "SELECT conversation_id,text,attachments,status FROM queued_prompts WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        attachment_row(row, 2)?,
                        row.get(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((owner, value, previous, state)) = prior {
            ensure!(
                owner == conversation && value == text && previous == attachments,
                "Queue ID belongs to another prompt"
            );
            return Ok(match state.as_str() {
                "cancelled" => QueueEntry::Cancelled,
                "submitted" => QueueEntry::Delivered,
                _ => QueueEntry::Queued,
            });
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
        Ok(QueueEntry::Queued)
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
        self.connection.prepare("SELECT q.id,q.conversation_id,q.text,q.status,q.attachments FROM queued_prompts q JOIN conversations c ON c.id=q.conversation_id WHERE q.status='queued' AND c.workspace_id NOT IN (SELECT workspace_id FROM workspace_tombstones) AND json_extract(c.data,'$.terminal_owner') IS NULL AND COALESCE(json_extract(c.data,'$.queue_paused'),0)=0 AND json_extract(c.data,'$.status') IN ('idle','ready','interrupted','error') AND q.rowid=(SELECT MIN(h.rowid) FROM queued_prompts h WHERE h.conversation_id=q.conversation_id AND h.status='queued') ORDER BY q.rowid LIMIT 16")?
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
        let mut conversation: Conversation = live_conversation(&tx, conversation_id)?;
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
        self.commit_conversation_as(conversation, messages, requests, false)
    }
    /// Commits a status change that lost the run: its provider stop was not
    /// confirmed or the runtime is gone. A turn in flight is recorded as an
    /// unknown outcome, never as interrupted or failed.
    pub fn commit_lost_run(
        &self,
        conversation: &Conversation,
        requests: &[PendingRequest],
    ) -> Result<()> {
        self.commit_conversation_as(conversation, &[], requests, true)
    }
    fn commit_conversation_as(
        &self,
        conversation: &Conversation,
        messages: &[Message],
        requests: &[PendingRequest],
        lost_run: bool,
    ) -> Result<()> {
        let started = std::time::Instant::now();
        activity::ensure(&self.connection)?;
        let tx = self.transaction()?;
        let prior: Conversation = live_conversation(&tx, &conversation.id)?;
        write_conversation(&tx, conversation)?;
        // Activity commits with the state change it records.
        let now = now_ms();
        let recorded = if lost_run {
            activity::lost_turn_activity(&prior, conversation)
        } else {
            activity::turn_activity(&prior, conversation)
        };
        if let Some(recorded) = recorded {
            enqueue_turn_hook(&tx, &recorded, &conversation.provider, now)?;
            activity::record(&tx, recorded, now)?;
        }
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
            if message.role == "user" {
                check_text(&message.text)?;
            } else {
                // Provider output is bounded with an explicit marker rather
                // than refused, so a long reply cannot fail the Conversation.
                crate::transcript::bound_message(&mut message.text, &mut message.content);
            }
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
            } else if let Some(recorded) = activity::request_activity(conversation, request) {
                activity::record(&tx, recorded, now)?;
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
        activity::ensure(&self.connection)?;
        let tx = self.transaction()?;
        for mut conversation in all::<Conversation>(
            &tx,
            &format!("SELECT data FROM conversations c WHERE {NOT_DELETED}"),
        )? {
            if live.contains(&conversation.id) {
                continue;
            }
            let prior = conversation.clone();
            if BUSY.contains(&conversation.status.as_str()) {
                conversation.status = "interrupted".into();
                // Runtime loss interrupts queue ordering as well as the turn.
                // Resume reconciles history; only explicit queue continuation
                // may dispatch instructions that followed the interrupted one.
                conversation.queue_paused = true;
                conversation.error=Some("The daemon restarted during this turn. Its previous process and approval requests are no longer active; resume the conversation explicitly.".into());
                conversation.updated_at = now_ms();
                let lost = activity::unknown_turn(&prior, &conversation);
                enqueue_turn_hook(&tx, &lost, &conversation.provider, conversation.updated_at)?;
                activity::record(&tx, lost, conversation.updated_at)?;
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
}

/// A settled turn's lifecycle hook commits with the activity that records it (F058).
fn enqueue_turn_hook(
    tx: &Connection,
    recorded: &activity::Recorded,
    provider: &str,
    now: i64,
) -> Result<()> {
    if let Some(event) = crate::hooks::Event::turn_settled(
        &recorded.source_key,
        recorded.kind,
        &recorded.target,
        provider,
    ) {
        crate::hooks::enqueue(tx, &event, now)?;
    }
    Ok(())
}
