//! The durable state of `workspace.create_worktree` and
//! `workspace.delete_worktree`. Each is a few steps across the worktree
//! lifecycle and this database; the row records which step comes next, so a
//! daemon that stops mid-way continues where it was. The receipt shares the
//! row's transactions: admission commits both, and the final state settles
//! the receipt with the reply a retry returns.
use super::*;
use crate::receipts::{self, Admission, Status};
use ade_core::contract::workspaces::{
    WorkspaceWorktreeKind, WorkspaceWorktreeOperation, WorkspaceWorktreeStatus,
};
use ade_core::contract::worktrees::BranchPolicy;
use serde::Deserialize;

/// The step an operation takes next.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStep {
    /// Create or remove the tree through the lifecycle, then wait for it.
    Tree,
    /// Open the created tree as a workspace, or remove the workspace from ADE.
    Workspace,
    /// Nothing is left to do.
    Done,
}

/// One workspace worktree operation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorktreeOperationRecord {
    pub operation_id: String,
    pub kind: WorkspaceWorktreeKind,
    pub status: WorkspaceWorktreeStatus,
    pub step: WorktreeStep,
    pub project_id: String,
    /// The lifecycle repository ID; the project ID unless the lifecycle
    /// still used its own ID when the operation began.
    pub lifecycle_id: String,
    pub workspace_id: Option<String>,
    pub worktree_path: Option<String>,
    /// The name a created workspace takes.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub delete_branch: Option<BranchPolicy>,
    /// A deletion that fails restores the workspace it removed from ADE.
    #[serde(default)]
    pub restore_workspace: bool,
    pub error: Option<String>,
    pub code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl WorktreeOperationRecord {
    /// The reply this state gives.
    pub fn reply(&self) -> WorkspaceWorktreeOperation {
        WorkspaceWorktreeOperation {
            tag: Default::default(),
            operation_id: self.operation_id.clone(),
            kind: self.kind,
            status: self.status,
            project_id: self.project_id.clone(),
            workspace_id: self.workspace_id.clone(),
            worktree_path: self.worktree_path.clone(),
            error: self.error.clone(),
            code: self.code.clone(),
        }
    }
}

/// What admitting a workspace worktree operation found.
pub enum WorktreeAdmission {
    /// Recorded now; the caller advances it.
    New,
    /// The same ID and payload were admitted before: its current state.
    Known(Box<WorktreeOperationRecord>),
    /// The ID was used for another request.
    Conflict,
    /// The ID's receipt is past retention.
    Expired,
}

fn status_text(status: WorkspaceWorktreeStatus) -> &'static str {
    match status {
        WorkspaceWorktreeStatus::Running => "running",
        WorkspaceWorktreeStatus::Succeeded => "succeeded",
        WorkspaceWorktreeStatus::Failed => "failed",
    }
}

fn read(db: &Connection, id: &str) -> Result<Option<WorktreeOperationRecord>> {
    db.query_row(
        "SELECT data FROM workspace_worktree_operations WHERE operation_id=?1",
        [id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(decode)
    .transpose()
}

fn write(db: &Connection, record: &WorktreeOperationRecord) -> Result<()> {
    db.execute(
        "INSERT INTO workspace_worktree_operations(operation_id,status,data,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at",
        params![
            record.operation_id,
            status_text(record.status),
            encode(record)?,
            record.updated_at
        ],
    )?;
    Ok(())
}

fn known(db: &Connection, id: &str, admission: Admission) -> Result<WorktreeAdmission> {
    Ok(match admission {
        Admission::New => WorktreeAdmission::New,
        Admission::Replay(_) => WorktreeAdmission::Known(Box::new(
            read(db, id)?.context("The operation's recorded state is missing")?,
        )),
        Admission::Conflict => WorktreeAdmission::Conflict,
        Admission::Expired => WorktreeAdmission::Expired,
    })
}

impl Store {
    /// Whether `id` was admitted before for `op` and `payload`, without
    /// recording anything.
    pub fn probe_worktree_operation(
        &self,
        id: &str,
        op: &str,
        payload: &Value,
    ) -> Result<WorktreeAdmission> {
        let tx = self.transaction()?;
        let admission = receipts::begin(&tx, id, op, payload, None, now_ms())?;
        // Dropping the transaction forgets a new receipt.
        known(&tx, id, admission)
    }

    /// Admits `record` under its operation ID: the receipt and the row
    /// commit together, dispatched.
    pub fn admit_worktree_operation(
        &self,
        op: &str,
        payload: &Value,
        record: &WorktreeOperationRecord,
    ) -> Result<WorktreeAdmission> {
        let tx = self.transaction()?;
        let now = now_ms();
        let admission = receipts::begin(&tx, &record.operation_id, op, payload, None, now)?;
        if admission != Admission::New {
            return known(&tx, &record.operation_id, admission);
        }
        write(&tx, record)?;
        receipts::settle(&tx, &record.operation_id, Status::Dispatched, None, now)?;
        tx.commit()?;
        Ok(WorktreeAdmission::New)
    }

    pub fn worktree_operation(&self, id: &str) -> Result<Option<WorktreeOperationRecord>> {
        read(&self.connection, id)
    }

    /// Operations still running, oldest first.
    pub fn running_worktree_operations(&self) -> Result<Vec<WorktreeOperationRecord>> {
        all(
            &self.connection,
            "SELECT data FROM workspace_worktree_operations WHERE status='running' ORDER BY rowid",
        )
    }

    /// Stores the operation's next state. A final state settles its receipt
    /// with the reply, in the same transaction.
    pub fn save_worktree_operation(&self, record: &mut WorktreeOperationRecord) -> Result<()> {
        record.updated_at = now_ms();
        let tx = self.transaction()?;
        write(&tx, record)?;
        if record.status != WorkspaceWorktreeStatus::Running {
            let reply = serde_json::to_value(record.reply())?;
            receipts::settle(
                &tx,
                &record.operation_id,
                Status::Settled,
                Some(&json!({"reply": reply})),
                record.updated_at,
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Database;
    use super::*;

    fn record(id: &str) -> WorktreeOperationRecord {
        WorktreeOperationRecord {
            operation_id: id.into(),
            kind: WorkspaceWorktreeKind::CreateWorktree,
            status: WorkspaceWorktreeStatus::Running,
            step: WorktreeStep::Tree,
            project_id: "repo_1".into(),
            lifecycle_id: "repo_1".into(),
            workspace_id: None,
            worktree_path: None,
            name: Some("Payments".into()),
            base: None,
            delete_branch: None,
            restore_workspace: false,
            error: None,
            code: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn an_operation_admits_once_resumes_after_reopen_and_settles_its_receipt() {
        let db = Database::new();
        let store = db.open();
        let payload = json!({"op": "workspace.create_worktree", "operation_id": "op-1",
            "project_id": "repo_1", "name": "Payments"});
        let op = "workspace.create_worktree";
        assert!(matches!(
            store
                .probe_worktree_operation("op-1", op, &payload)
                .unwrap(),
            WorktreeAdmission::New
        ));
        // A probe records nothing.
        assert!(matches!(
            store
                .probe_worktree_operation("op-1", op, &payload)
                .unwrap(),
            WorktreeAdmission::New
        ));
        let mut first = record("op-1");
        assert!(matches!(
            store
                .admit_worktree_operation(op, &payload, &first)
                .unwrap(),
            WorktreeAdmission::New
        ));
        assert!(matches!(
            store
                .admit_worktree_operation(op, &payload, &first)
                .unwrap(),
            WorktreeAdmission::Known(_)
        ));
        let mut other = payload.clone();
        other["name"] = json!("Other");
        assert!(matches!(
            store.admit_worktree_operation(op, &other, &first).unwrap(),
            WorktreeAdmission::Conflict
        ));
        drop(store);
        let store = db.open();
        assert_eq!(
            store.running_worktree_operations().unwrap(),
            vec![first.clone()]
        );
        first.step = WorktreeStep::Done;
        first.status = WorkspaceWorktreeStatus::Succeeded;
        first.workspace_id = Some("workspace_1".into());
        store.save_worktree_operation(&mut first).unwrap();
        assert!(store.running_worktree_operations().unwrap().is_empty());
        let WorktreeAdmission::Known(settled) = store
            .probe_worktree_operation("op-1", op, &payload)
            .unwrap()
        else {
            panic!("the operation is known");
        };
        assert_eq!(settled.workspace_id.as_deref(), Some("workspace_1"));
        let receipt: String = store
            .connection
            .query_row("SELECT status FROM operations WHERE id='op-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(receipt, "settled");
    }
}
