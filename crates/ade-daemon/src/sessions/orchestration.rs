//! Delegation, parent and child tracking, child messages and waits (F104,
//! F106, F107).
//!
//! The parent and child link lives in `state.sqlite` beside the Conversations
//! it joins, so it outlives both Agents' processes. Delegation and child
//! messages are effect commands: the receipt, the link and the queued prompt
//! commit in one transaction, and the existing prompt queue delivers the
//! prompt. Nothing here replays a prompt; a queue that cannot deliver pauses
//! and a wait reports it as blocked. Waits read state and never hold a
//! request open, so they cannot delay other requests or a daemon restart.
use super::*;
use crate::receipts::{self, Admission};
use ade_core::contract::orchestration::{
    ChildDelegated, ChildGetRequest, ChildList, ChildMessageQueued, ChildRecord, ChildReply,
    ChildSendRequest, ChildWait, ChildWaitRequest, ChildrenRequest, DelegateRequest,
    WorkspaceChoice, WorkspaceMode,
};
use ade_core::contract::worktrees::WorktreeOperationReply;
use rusqlite::{Connection, OptionalExtension, params};

mod policy;

const DELEGATE: &str = "orchestration.delegate";
const CHILD_SEND: &str = "orchestration.child.send";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS orchestration_children(child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, attribution TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth>0), provider TEXT NOT NULL, account_id TEXT, workspace_id TEXT NOT NULL, workspace_mode TEXT NOT NULL CHECK(workspace_mode IN ('same','new_worktree')), worktree_operation_id TEXT, task_message_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_children_parent ON orchestration_children(parent_id);
CREATE TABLE IF NOT EXISTS orchestration_messages(id TEXT PRIMARY KEY, child_id TEXT NOT NULL, operation_id TEXT NOT NULL, attribution TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_messages_child ON orchestration_messages(child_id);";

const CHILD_COLUMNS: &str = "child_id,parent_id,operation_id,attribution,depth,provider,account_id,workspace_id,workspace_mode,worktree_operation_id,task_message_id,created_at";

/// Creates the orchestration tables when they are missing.
fn ensure_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    receipts::ensure(connection)
}

/// A stored link, without the child's live state.
fn link_row(row: &rusqlite::Row) -> rusqlite::Result<ChildRecord> {
    let mode: String = row.get(8)?;
    Ok(ChildRecord {
        child_conversation_id: row.get(0)?,
        parent_conversation_id: row.get(1)?,
        operation_id: row.get(2)?,
        attribution: row.get(3)?,
        depth: row.get(4)?,
        provider: row.get(5)?,
        account_id: row.get(6)?,
        workspace_id: row.get(7)?,
        workspace_mode: if mode == "new_worktree" {
            WorkspaceMode::NewWorktree
        } else {
            WorkspaceMode::Same
        },
        worktree_operation_id: row.get(9)?,
        task_message_id: row.get(10)?,
        created_at: row.get(11)?,
        status: String::new(),
        error: None,
    })
}

fn link(connection: &Connection, child: &str) -> Result<Option<ChildRecord>> {
    Ok(connection
        .query_row(
            &format!("SELECT {CHILD_COLUMNS} FROM orchestration_children WHERE child_id=?1"),
            [child],
            link_row,
        )
        .optional()?)
}

/// A Conversation, or `None` when it no longer exists.
fn conversation(connection: &Connection, id: &str) -> Result<Option<Conversation>> {
    connection
        .query_row("SELECT data FROM conversations WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .map(|data| serde_json::from_str(&data).context("Stored Conversation is invalid"))
        .transpose()
}

/// Fills a link with its child's current status.
fn with_state(connection: &Connection, mut record: ChildRecord) -> Result<ChildRecord> {
    match conversation(connection, &record.child_conversation_id)? {
        Some(child) => {
            record.status = child.status;
            record.error = child.error;
        }
        None => record.status = "unavailable".into(),
    }
    Ok(record)
}

/// Queues a prompt inside the caller's transaction, under the same bound as `queue.enqueue`.
fn enqueue(connection: &Connection, conversation: &str, id: &str, text: &str) -> Result<()> {
    let queued: i64 = connection.query_row(
        "SELECT count(*) FROM queued_prompts WHERE conversation_id=?1 AND status='queued'",
        [conversation],
        |row| row.get(0),
    )?;
    ensure!(queued < 32, "Limit of 32 queued prompts reached");
    connection.execute(
        "INSERT INTO queued_prompts(id,conversation_id,text,status,attachments) VALUES(?1,?2,?3,'queued','[]')",
        params![id, conversation, text],
    )?;
    Ok(())
}

/// The stored reply for a repeated operation ID, or `None` for a new one.
/// A receipt that never settled has no provable outcome, so it is an error.
fn replay(admission: Admission, what: &str) -> Result<Option<Value>> {
    match admission {
        Admission::New => Ok(None),
        Admission::Replay(receipt) => match (receipt.status, receipt.result) {
            (receipts::Status::Settled, Some(result)) => Ok(Some(result)),
            _ => bail!("The earlier {what} has no recorded outcome; inspect before retrying"),
        },
        Admission::Conflict => bail!("Operation ID was already used for a different {what}"),
        Admission::Expired => bail!("Operation ID has expired; use a new ID"),
    }
}

/// A read-only look at an operation ID before work outside the store lock.
fn peek(
    connection: &Connection,
    id: &str,
    op: &str,
    payload: &Value,
    what: &str,
) -> Result<Option<Value>> {
    let tx = connection.unchecked_transaction()?;
    let admission = receipts::begin(&tx, id, op, payload, None, now_ms())?;
    drop(tx);
    replay(admission, what)
}

fn canonical(path: &str) -> Result<String> {
    Ok(std::fs::canonicalize(path)
        .with_context(|| format!("Path is unavailable: {path}"))?
        .to_string_lossy()
        .into_owned())
}

impl Sessions {
    pub(super) fn orchestration_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            DELEGATE => self.delegate(decode(request)?),
            "orchestration.children" => {
                let list: ChildrenRequest = decode(request)?;
                let parent = non_empty("parent_conversation_id", &list.parent_conversation_id)?;
                let d = self.data.lock().unwrap();
                let db = &d.store.connection;
                ensure_schema(db)?;
                let mut statement = db.prepare(&format!(
                    "SELECT {CHILD_COLUMNS} FROM orchestration_children WHERE parent_id=?1 ORDER BY created_at,rowid"
                ))?;
                let links = statement
                    .query_map([parent], link_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                ensure!(
                    !links.is_empty() || conversation(db, parent)?.is_some(),
                    "Unknown conversations ID: {parent}"
                );
                let children = links
                    .into_iter()
                    .map(|record| with_state(db, record))
                    .collect::<Result<_>>()?;
                reply(&ChildList {
                    tag: Default::default(),
                    parent_conversation_id: parent.to_owned(),
                    children,
                })
            }
            "orchestration.child.get" => {
                let get: ChildGetRequest = decode(request)?;
                let child = non_empty("child_conversation_id", &get.child_conversation_id)?;
                let d = self.data.lock().unwrap();
                let db = &d.store.connection;
                ensure_schema(db)?;
                let record = link(db, child)?.context("Conversation is not a delegated child")?;
                reply(&ChildReply {
                    tag: Default::default(),
                    child: with_state(db, record)?,
                })
            }
            CHILD_SEND => self.child_send(decode(request)?),
            "orchestration.child.wait" => self.child_wait(decode(request)?),
            _ => bail!("Unknown session operation"),
        }
    }

    fn delegate(self: &Arc<Self>, delegate: DelegateRequest) -> Result<Value> {
        policy::check_id("operation_id", &delegate.operation_id)?;
        let parent_id = non_empty("parent_conversation_id", &delegate.parent_conversation_id)?;
        let attribution = policy::authorize_delegation(&delegate.caller, parent_id)?;
        policy::check_id("provider", &delegate.provider)?;
        policy::check_text(&delegate.task)?;
        let title = policy::child_title(delegate.title.as_deref(), &delegate.task)?;
        let provider_config: crate::provider::Config = serde_json::from_value(
            delegate
                .provider_config
                .clone()
                .unwrap_or_else(|| json!({})),
        )?;
        // The fingerprint covers the typed request, so transport fields such
        // as a diagnostic ID never turn a retry into a conflict.
        let payload = serde_json::to_value(&delegate)?;
        let operation_id = delegate.operation_id.as_str();
        let parent = {
            let d = self.data.lock().unwrap();
            ensure_schema(&d.store.connection)?;
            if let Some(result) = peek(
                &d.store.connection,
                operation_id,
                DELEGATE,
                &payload,
                "delegation",
            )? {
                return Ok(result);
            }
            d.store.conversation(parent_id)?
        };
        // The worktree ledger has its own lock; consult it outside the store lock.
        let (workspace_id, mode, worktree_operation) = match &delegate.workspace {
            WorkspaceChoice::Same => (parent.workspace_id.clone(), "same", None),
            WorkspaceChoice::NewWorktree {
                workspace_id,
                repository_id,
                worktree_operation_id,
            } => {
                self.verify_new_worktree(
                    &parent.workspace_id,
                    non_empty("workspace_id", workspace_id)?,
                    non_empty("repository_id", repository_id)?,
                    non_empty("worktree_operation_id", worktree_operation_id)?,
                )?;
                (
                    workspace_id.clone(),
                    "new_worktree",
                    Some(worktree_operation_id.clone()),
                )
            }
        };
        self.ensure_workspace_bound(&workspace_id)?;

        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        let now = now_ms();
        let (created, result) = persistence_result((|| -> Result<_> {
            let db = &d.store.connection;
            let tx = db.unchecked_transaction()?;
            let admission = receipts::begin(
                &tx,
                operation_id,
                DELEGATE,
                &payload,
                Some(&attribution),
                now,
            )?;
            if let Some(result) = replay(admission, "delegation")? {
                return Ok((None, result));
            }
            let parent = conversation(&tx, parent_id)?
                .with_context(|| format!("Unknown conversations ID: {parent_id}"))?;
            let parent_depth: u32 = tx
                .query_row(
                    "SELECT depth FROM orchestration_children WHERE child_id=?1",
                    [parent_id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            let siblings: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_children WHERE parent_id=?1",
                [parent_id],
                |row| row.get(0),
            )?;
            let depth = policy::child_depth(parent_depth, siblings as usize)?;
            let account = policy::resolve_account(
                &delegate.account,
                &delegate.provider,
                &parent.provider,
                parent.account_id.as_deref(),
            )?;
            let child = d.store.create_with_account(
                &workspace_id,
                &title,
                &delegate.provider,
                provider_config,
                account.as_deref(),
            )?;
            let task = new_id("message");
            enqueue(&tx, &child.id, &task, &delegate.task)?;
            tx.execute(
                &format!("INSERT INTO orchestration_children({CHILD_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"),
                params![child.id, parent_id, operation_id, attribution, depth, delegate.provider,
                    account, workspace_id, mode, worktree_operation, task, now],
            )?;
            tx.execute(
                "INSERT INTO orchestration_messages(id,child_id,operation_id,attribution,created_at) VALUES(?1,?2,?3,?4,?5)",
                params![task, child.id, operation_id, attribution, now],
            )?;
            let record = with_state(
                &tx,
                link(&tx, &child.id)?.context("Delegation link was not stored")?,
            )?;
            let result = reply(&ChildDelegated {
                tag: Default::default(),
                child: record,
            })?;
            receipts::settle(
                &tx,
                operation_id,
                receipts::Status::Settled,
                Some(&result),
                now,
            )?;
            tx.commit()?;
            Ok((Some(child), result))
        })())?;
        if let Some(child) = created {
            self.catalog_changed(&mut d)?;
            self.changed(&mut d, &child, &[])?;
        }
        Ok(result)
    }

    /// Confirms a `new_worktree` choice against the lifecycle ledger.
    fn verify_new_worktree(
        &self,
        parent_workspace: &str,
        workspace_id: &str,
        repository_id: &str,
        operation_id: &str,
    ) -> Result<()> {
        let workspace = self.workspace(workspace_id)?;
        let reply: WorktreeOperationReply =
            serde_json::from_value(self.worktrees.command(&json!({
                "op": "worktree.operation",
                "repository_id": repository_id,
                "operation_id": operation_id,
            }))?)
            .context("Worktree ledger returned an invalid operation")?;
        let operation = reply.operation;
        let path = operation
            .worktree_path
            .as_deref()
            .map(canonical)
            .transpose()?;
        let root = canonical(&workspace.root)?;
        policy::verify_new_worktree(&policy::WorktreeEvidence {
            status: operation.status,
            op: operation.request["op"].as_str(),
            create: operation.request["create"] == true,
            path: path.as_deref(),
            workspace_root: &root,
            workspace_id,
            parent_workspace_id: parent_workspace,
        })
    }

    fn child_send(self: &Arc<Self>, send: ChildSendRequest) -> Result<Value> {
        policy::check_id("operation_id", &send.operation_id)?;
        let child_id = non_empty("child_conversation_id", &send.child_conversation_id)?;
        policy::check_text(&send.text)?;
        let payload = serde_json::to_value(&send)?;
        let operation_id = send.operation_id.as_str();
        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        let now = now_ms();
        let (child, result) = persistence_result((|| -> Result<_> {
            let db = &d.store.connection;
            ensure_schema(db)?;
            let tx = db.unchecked_transaction()?;
            let record = link(&tx, child_id)?.context("Conversation is not a delegated child")?;
            let attribution =
                policy::authorize_message(&send.caller, &record.parent_conversation_id)?;
            let admission = receipts::begin(
                &tx,
                operation_id,
                CHILD_SEND,
                &payload,
                Some(&attribution),
                now,
            )?;
            if let Some(result) = replay(admission, "child message")? {
                return Ok((None, result));
            }
            let child =
                conversation(&tx, child_id)?.context("The child Conversation no longer exists")?;
            let message = new_id("message");
            enqueue(&tx, child_id, &message, &send.text)?;
            tx.execute(
                "INSERT INTO orchestration_messages(id,child_id,operation_id,attribution,created_at) VALUES(?1,?2,?3,?4,?5)",
                params![message, child_id, operation_id, attribution, now],
            )?;
            let result = reply(&ChildMessageQueued {
                tag: Default::default(),
                child_conversation_id: child_id.to_owned(),
                message_id: message,
                attribution,
            })?;
            receipts::settle(
                &tx,
                operation_id,
                receipts::Status::Settled,
                Some(&result),
                now,
            )?;
            tx.commit()?;
            Ok((Some(child), result))
        })())?;
        if let Some(child) = child {
            self.changed(&mut d, &child, &[])?;
        }
        Ok(result)
    }

    fn child_wait(&self, wait: ChildWaitRequest) -> Result<Value> {
        let child_id = non_empty("child_conversation_id", &wait.child_conversation_id)?;
        let now = now_ms();
        let deadline = policy::deadline(now, wait.timeout_ms, wait.deadline_ms)?;
        let d = self.data.lock().unwrap();
        let db = &d.store.connection;
        ensure_schema(db)?;
        link(db, child_id)?.context("Conversation is not a delegated child")?;
        let message_id: String = match wait.message_id.as_deref() {
            Some(id) => db
                .query_row(
                    "SELECT id FROM orchestration_messages WHERE id=?1 AND child_id=?2",
                    params![id, child_id],
                    |row| row.get(0),
                )
                .optional()?
                .context("Message is not a task or message sent to this child")?,
            None => db.query_row(
                "SELECT id FROM orchestration_messages WHERE child_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1",
                [child_id],
                |row| row.get(0),
            )?,
        };
        let child = conversation(db, child_id)?;
        let (state, done) = match &child {
            None => {
                policy::resolve_wait(&message_id, policy::Progress::Missing, None, now, deadline)
            }
            Some(child) => {
                let submitted = d
                    .store
                    .message(&message_id)?
                    .is_some_and(|message| message.conversation_id == child.id);
                let queued: Option<String> = db
                    .query_row(
                        "SELECT status FROM queued_prompts WHERE id=?1 AND conversation_id=?2",
                        params![message_id, child.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let progress = match (submitted, queued.as_deref()) {
                    (true, _) => policy::Progress::Submitted,
                    (false, Some("queued")) => policy::Progress::Queued,
                    (false, Some("cancelled")) => policy::Progress::Cancelled,
                    _ => policy::Progress::Missing,
                };
                let pending_requests = d
                    .store
                    .pending(&child.id)?
                    .into_iter()
                    .filter(|request| request.status == "pending")
                    .map(|request| request.id)
                    .collect();
                let view = policy::ChildView {
                    status: &child.status,
                    current_submission: child.runtime_submission.as_deref(),
                    queue_paused: child.queue_paused,
                    error: child.error.as_deref(),
                    terminal_owned: child.terminal_owner.is_some(),
                    pending_requests,
                };
                policy::resolve_wait(&message_id, progress, Some(&view), now, deadline)
            }
        };
        reply(&ChildWait {
            tag: Default::default(),
            child_conversation_id: child_id.to_owned(),
            message_id,
            state,
            done,
            deadline_ms: deadline,
        })
    }
}
