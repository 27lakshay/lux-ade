//! Delegation, parent and child tracking, child messages and waits (F104,
//! F106, F107).
//!
//! Messages travel both ways through the receiver's durable prompt queue: the
//! parent (or the user) messages a child, and a child (or the user) messages
//! its parent. A child's pending questions show on its record, and its parent
//! answers each once through the same answer path as `agent.answer`.
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
    ChildAnswerRequest, ChildAnswered, ChildDelegated, ChildGetRequest, ChildList, ChildMessage,
    ChildMessageQueued, ChildMessages, ChildMessagesRequest, ChildRecord, ChildReply, ChildRequest,
    ChildSendRequest, ChildWait, ChildWaitRequest, ChildrenRequest, DelegateRequest,
    MessageDelivery, MessageDirection, ParentMessageQueued, ParentSendRequest, WorkspaceChoice,
    WorkspaceMode,
};
use ade_core::contract::worktrees::WorktreeOperationReply;
use rusqlite::{Connection, OptionalExtension, params};

mod group_policy;
mod groups;
mod policy;

const DELEGATE: &str = "orchestration.delegate";
const CHILD_SEND: &str = "orchestration.child.send";
const PARENT_SEND: &str = "orchestration.parent.send";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS orchestration_children(child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, attribution TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth>0), provider TEXT NOT NULL, account_id TEXT, workspace_id TEXT NOT NULL, workspace_mode TEXT NOT NULL CHECK(workspace_mode IN ('same','new_worktree')), worktree_operation_id TEXT, task_message_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_children_parent ON orchestration_children(parent_id);
CREATE TABLE IF NOT EXISTS orchestration_messages(id TEXT PRIMARY KEY, child_id TEXT NOT NULL, operation_id TEXT NOT NULL, attribution TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_messages_child ON orchestration_messages(child_id);
CREATE TABLE IF NOT EXISTS orchestration_parent_messages(id TEXT PRIMARY KEY, child_id TEXT NOT NULL, parent_id TEXT NOT NULL, operation_id TEXT NOT NULL, attribution TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_parent_messages_child ON orchestration_parent_messages(child_id);";

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
        pending_requests: Vec::new(),
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
        .query_row("SELECT data FROM conversations WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM conversation_tombstones WHERE conversation_id=?1)", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .map(|data| serde_json::from_str(&data).context("Stored Conversation is invalid"))
        .transpose()
}

/// The provider requests a Conversation still waits on, oldest first.
fn pending_requests(connection: &Connection, id: &str) -> Result<Vec<ChildRequest>> {
    let mut statement = connection.prepare(
        "SELECT data FROM requests WHERE conversation_id=?1 AND status='pending' ORDER BY rowid",
    )?;
    let rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
    rows.map(|data| {
        let request: PendingRequest =
            serde_json::from_str(&data?).context("Stored request is invalid")?;
        Ok(ChildRequest {
            request_id: request.id,
            kind: policy::request_kind(&request.method),
            method: request.method,
            params: request.params,
        })
    })
    .collect()
}

/// Fills a link with its child's current status and pending requests.
fn with_state(connection: &Connection, mut record: ChildRecord) -> Result<ChildRecord> {
    match conversation(connection, &record.child_conversation_id)? {
        Some(child) => {
            record.pending_requests = pending_requests(connection, &child.id)?;
            record.status = child.status;
            record.error = child.error;
        }
        None => record.status = "unavailable".into(),
    }
    Ok(record)
}

/// Queues a prompt inside the caller's transaction, under the same bound as `queue.enqueue`.
fn enqueue(connection: &Connection, conversation: &str, id: &str, text: &str) -> Result<()> {
    enqueue_with(connection, conversation, id, text, &[])
}

/// Queues a prompt with attachments the Conversation already owns.
fn enqueue_with(
    connection: &Connection,
    conversation: &str,
    id: &str,
    text: &str,
    attachments: &[ade_core::model::Attachment],
) -> Result<()> {
    let queued: i64 = connection.query_row(
        "SELECT count(*) FROM queued_prompts WHERE conversation_id=?1 AND status='queued'",
        [conversation],
        |row| row.get(0),
    )?;
    ensure!(queued < 32, "Limit of 32 queued prompts reached");
    connection.execute(
        "INSERT INTO queued_prompts(id,conversation_id,text,status,attachments) VALUES(?1,?2,?3,'queued',?4)",
        params![id, conversation, text, serde_json::to_string(attachments)?],
    )?;
    Ok(())
}

/// A child to create inside the caller's transaction.
struct NewChild<'a> {
    parent_id: &'a str,
    /// The operation recorded on the link and the task message.
    operation_id: &'a str,
    attribution: &'a str,
    depth: u32,
    provider: &'a str,
    provider_config: crate::provider::Config,
    /// The registry descriptor of an adapter or plugin provider; `None` for a
    /// provider in the static catalogue.
    registered: Option<&'a crate::provider::Descriptor>,
    account: Option<&'a str>,
    workspace_id: &'a str,
    /// `same` or `new_worktree`.
    mode: &'a str,
    worktree_operation: Option<&'a str>,
    title: &'a str,
    task: &'a str,
    /// Attachments of the parent to copy to the child and send with the task.
    context: &'a [ade_core::model::Attachment],
    now: i64,
}

/// Creates the child Conversation, queues its task and records the link, all
/// in the caller's transaction on the store's connection.
fn insert_child(tx: &Connection, store: &Store, child: NewChild) -> Result<Conversation> {
    let created = match child.registered {
        None => store.create_with_account(
            child.workspace_id,
            child.title,
            child.provider,
            child.provider_config,
            child.account,
        )?,
        Some(descriptor) => store.create_registered(
            child.workspace_id,
            child.title,
            descriptor,
            child.provider_config,
        )?,
    };
    let task = new_id("message");
    let context = store.copy_attachments(tx, child.parent_id, &created.id, child.context)?;
    if !context.is_empty() {
        let prompt = store.prompt(&created.id, child.task, &context)?;
        ade_core::prompt_context::admit(&created.provider, &prompt)?;
    }
    enqueue_with(tx, &created.id, &task, child.task, &context)?;
    tx.execute(
        &format!("INSERT INTO orchestration_children({CHILD_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"),
        params![created.id, child.parent_id, child.operation_id, child.attribution, child.depth,
            child.provider, child.account, child.workspace_id, child.mode, child.worktree_operation,
            task, child.now],
    )?;
    tx.execute(
        "INSERT INTO orchestration_messages(id,child_id,operation_id,attribution,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![task, created.id, child.operation_id, child.attribution, child.now],
    )?;
    Ok(created)
}

/// The child's newest task or message.
fn newest_message(connection: &Connection, child: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT id FROM orchestration_messages WHERE child_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1",
        [child],
        |row| row.get(0),
    )?)
}

/// Where one message to a child stands, resolved against `deadline`.
fn observe(
    store: &Store,
    child_id: &str,
    message_id: &str,
    now: i64,
    deadline: i64,
) -> Result<(ade_core::contract::orchestration::WaitState, bool)> {
    let db = &store.connection;
    let Some(child) = conversation(db, child_id)? else {
        return Ok(policy::resolve_wait(
            message_id,
            policy::Progress::Missing,
            None,
            now,
            deadline,
        ));
    };
    let submitted = store
        .message(message_id)?
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
    let pending_requests = store
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
        pending_requests,
    };
    Ok(policy::resolve_wait(
        message_id,
        progress,
        Some(&view),
        now,
        deadline,
    ))
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
    let tx = crate::store::begin_write(connection)?;
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
            "orchestration.child.answer" => self.child_answer(decode(request)?),
            PARENT_SEND => self.parent_send(decode(request)?),
            "orchestration.child.messages" => self.child_messages(decode(request)?),
            groups::START => self.group_start(decode(request)?),
            "orchestration.groups" => self.groups(decode(request)?),
            "orchestration.group.get" => self.group_get(decode(request)?),
            "orchestration.group.compare" => self.group_compare(decode(request)?),
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
            // Creating the schema and probing the receipt both write, so a
            // busy database is reported as such, never as a raw SQL error.
            let admitted = persistence_result((|| {
                ensure_schema(&d.store.connection)?;
                peek(
                    &d.store.connection,
                    operation_id,
                    DELEGATE,
                    &payload,
                    "delegation",
                )
            })())?;
            if let Some(result) = admitted {
                return Ok(result);
            }
            d.store.conversation(parent_id)?
        };
        // The worktree ledger has its own lock; consult it outside the store lock.
        let (workspace_id, mode, worktree_operation) = match &delegate.workspace {
            WorkspaceChoice::Same => (parent.workspace_id.clone(), "same", None),
            WorkspaceChoice::NewWorktree {
                workspace_id,
                project_id,
                worktree_operation_id,
            } => {
                self.verify_new_worktree(
                    &parent.workspace_id,
                    non_empty("workspace_id", workspace_id)?,
                    non_empty("project_id", project_id)?,
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
        // Adapters and plugin providers are validated through the provider
        // registry, as `conversation.create` does, outside the store lock.
        let registered = self.registered_descriptor(&delegate.provider)?;

        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        if !delegate.context_attachments.is_empty() {
            // Name a missing, foreign or changed attachment plainly, before the
            // transaction reports any database refusal as a failed save.
            d.store
                .prompt(parent_id, &delegate.task, &delegate.context_attachments)?;
        }
        let now = now_ms();
        let (created, result) = persistence_result((|| -> Result<_> {
            let db = &d.store.connection;
            let tx = crate::store::begin_write(db)?;
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
            policy::registered_account(
                &delegate.provider,
                registered.is_some(),
                account.as_deref(),
            )?;
            let child = insert_child(
                &tx,
                &d.store,
                NewChild {
                    parent_id,
                    operation_id,
                    attribution: &attribution,
                    depth,
                    provider: &delegate.provider,
                    provider_config,
                    registered: registered.as_ref(),
                    account: account.as_deref(),
                    workspace_id: &workspace_id,
                    mode,
                    worktree_operation: worktree_operation.as_deref(),
                    title: &title,
                    task: &delegate.task,
                    context: &delegate.context_attachments,
                    now,
                },
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
            self.pin_new(&child)?;
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
        project_id: &str,
        operation_id: &str,
    ) -> Result<()> {
        let workspace = self.workspace(workspace_id)?;
        let reply: WorktreeOperationReply =
            serde_json::from_value(self.worktrees.command(&json!({
                "op": "worktree.operation",
                "project_id": project_id,
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
            let tx = crate::store::begin_write(db)?;
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

    /// Answers a child's pending request for its parent Agent or the user.
    /// The request must be the child's own; `answer` refuses a stale one and
    /// a second, different answer.
    fn child_answer(&self, answer: ChildAnswerRequest) -> Result<Value> {
        let child_id = non_empty("child_conversation_id", &answer.child_conversation_id)?;
        let request_id = non_empty("request_id", &answer.request_id)?;
        let attribution = {
            let d = self.data.lock().unwrap();
            ensure_schema(&d.store.connection)?;
            let record = link(&d.store.connection, child_id)?
                .context("Conversation is not a delegated child")?;
            policy::authorize_message(&answer.caller, &record.parent_conversation_id)?
        };
        self.answer(
            child_id,
            request_id,
            non_empty("decision", &answer.decision)?,
            answer.answers.as_ref(),
        )?;
        reply(&ChildAnswered {
            tag: Default::default(),
            child_conversation_id: child_id.to_owned(),
            request_id: request_id.to_owned(),
            attribution,
        })
    }

    /// Queues a child's message for its parent, in the same transaction as
    /// its receipt and its record.
    fn parent_send(self: &Arc<Self>, send: ParentSendRequest) -> Result<Value> {
        policy::check_id("operation_id", &send.operation_id)?;
        let child_id = non_empty("child_conversation_id", &send.child_conversation_id)?;
        policy::check_text(&send.text)?;
        let payload = serde_json::to_value(&send)?;
        let operation_id = send.operation_id.as_str();
        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        let now = now_ms();
        let (parent, result) = persistence_result((|| -> Result<_> {
            let db = &d.store.connection;
            ensure_schema(db)?;
            let tx = crate::store::begin_write(db)?;
            let record = link(&tx, child_id)?.context("Conversation is not a delegated child")?;
            let attribution = policy::authorize_parent_message(&send.caller, child_id)?;
            let admission = receipts::begin(
                &tx,
                operation_id,
                PARENT_SEND,
                &payload,
                Some(&attribution),
                now,
            )?;
            if let Some(result) = replay(admission, "parent message")? {
                return Ok((None, result));
            }
            let parent_id = record.parent_conversation_id.as_str();
            let parent = conversation(&tx, parent_id)?
                .context("The parent Conversation no longer exists")?;
            let prompt = policy::parent_prompt(child_id, &send.text);
            policy::check_text(&prompt)?;
            let message = new_id("message");
            enqueue(&tx, parent_id, &message, &prompt)?;
            tx.execute(
                "INSERT INTO orchestration_parent_messages(id,child_id,parent_id,operation_id,attribution,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![message, child_id, parent_id, operation_id, attribution, now],
            )?;
            let result = reply(&ParentMessageQueued {
                tag: Default::default(),
                parent_conversation_id: parent_id.to_owned(),
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
            Ok((Some(parent), result))
        })())?;
        if let Some(parent) = parent {
            self.changed(&mut d, &parent, &[])?;
        }
        Ok(result)
    }

    /// Both directions of a child's messages, oldest first, with where each
    /// stands in its receiver's queue.
    fn child_messages(&self, request: ChildMessagesRequest) -> Result<Value> {
        let child_id = non_empty("child_conversation_id", &request.child_conversation_id)?;
        let d = self.data.lock().unwrap();
        let db = &d.store.connection;
        ensure_schema(db)?;
        let record = link(db, child_id)?.context("Conversation is not a delegated child")?;
        let mut statement = db.prepare(
            "SELECT id,'to_child',child_id,operation_id,attribution,created_at,rowid FROM orchestration_messages WHERE child_id=?1
             UNION ALL
             SELECT id,'to_parent',parent_id,operation_id,attribution,created_at,rowid FROM orchestration_parent_messages WHERE child_id=?1
             ORDER BY 6,7",
        )?;
        let rows = statement
            .query_map([child_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut messages = Vec::with_capacity(rows.len());
        for (id, direction, receiver, operation_id, attribution, created_at) in rows {
            let delivery = match d.store.queue_entry(&id)? {
                Some(crate::store::QueueEntry::Delivered) => MessageDelivery::Submitted,
                Some(crate::store::QueueEntry::Cancelled) => MessageDelivery::Cancelled,
                Some(crate::store::QueueEntry::Queued) => MessageDelivery::Queued,
                None => MessageDelivery::Missing,
            };
            messages.push(ChildMessage {
                message_id: id,
                direction: if direction == "to_parent" {
                    MessageDirection::ToParent
                } else {
                    MessageDirection::ToChild
                },
                receiver_conversation_id: receiver,
                operation_id,
                attribution,
                created_at,
                delivery,
            });
        }
        reply(&ChildMessages {
            tag: Default::default(),
            child_conversation_id: child_id.to_owned(),
            parent_conversation_id: record.parent_conversation_id,
            messages,
        })
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
            None => newest_message(db, child_id)?,
        };
        let (state, done) = observe(&d.store, child_id, &message_id, now, deadline)?;
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
