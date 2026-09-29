//! `workspace.create_worktree` and `workspace.delete_worktree`: the chained
//! lifecycle and workspace calls a client used to make, as one daemon
//! operation each.
//!
//! Each operation is a row in the profile database (`store::worktree_operations`)
//! that names the step it takes next. Admission commits the row with its
//! receipt; the handler then advances it as far as it can, and a tick advances
//! every running row, so a lifecycle worker's completion, or a daemon that
//! stopped between two steps, is picked up without the caller.
//!
//! - Create: the lifecycle creates the branch and tree (setup hooks
//!   included), under this operation's ID; then the daemon opens the tree as a
//!   workspace, names it and settles.
//! - Delete: the daemon checks the blockers again, removes the workspace from
//!   ADE (the `workspace.remove` step), then the lifecycle removes the tree
//!   under this operation's ID. A tree that cannot be removed gets its
//!   workspace back, without its layouts and terminals.
//!
//! A repository another operation holds makes a step wait, never fail. A
//! terminal that is still stopping is retried with backoff, a few times. Any
//! other step error fails the operation, so one operation never stalls the
//! others.
use super::{Host, decode, now_ms, reply};
use ade_core::contract::workspaces::{
    WorkspaceCreateWorktreeRequest, WorkspaceDeleteWorktreeRequest, WorkspaceWorktreeKind,
    WorkspaceWorktreeStatus,
};
use ade_core::contract::worktrees::{
    CleanupBlocker, WorktreeCleanupPlan, WorktreeOperationStatus as Job, WorktreeState,
};
use ade_core::error::{LifecycleBusy, TerminalsStillStopping};
use ade_core::model::{ProjectKind, WorkspaceKind};
use ade_core::workspaces::{DeleteBlocker, DeleteBlockerKind, NotDeletable};
use ade_daemon::store::{WorktreeAdmission, WorktreeOperationRecord as Record, WorktreeStep};
use anyhow::{Context, ensure};
use serde_json::{Value, json};
use std::path::Path;

const CREATE: &str = "workspace.create_worktree";
const DELETE: &str = "workspace.delete_worktree";

/// How often running operations are advanced.
pub(super) const TICK: std::time::Duration = std::time::Duration::from_millis(250);
/// Transient step failures before the operation fails.
const MAX_ATTEMPTS: u32 = 4;
/// The first retry delay; each later one doubles it.
const FIRST_RETRY_MS: i64 = 500;

/// What one step did.
enum Progress {
    /// The state changed; store it and take the next step.
    Next(Box<Record>),
    /// The lifecycle is still working, or holds the repository for another
    /// operation; look again on the next tick.
    Wait,
}

fn check_id(id: &str) -> anyhow::Result<()> {
    ensure!(
        !id.is_empty() && id.len() <= ade_daemon::envelope::MAX_ID_BYTES,
        "Invalid operation_id: use 1 to 256 bytes of text"
    );
    Ok(())
}

fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|path| path.to_str().map(str::to_owned))
        .unwrap_or_else(|| path.to_owned())
}

/// Records a failure on the operation from an error, keeping its code.
fn fail(mut record: Record, error: anyhow::Error) -> Record {
    let envelope = ade_core::error::error_envelope(error);
    record.status = WorkspaceWorktreeStatus::Failed;
    record.step = WorktreeStep::Done;
    record.retry_at = None;
    record.error = envelope["message"].as_str().map(str::to_owned);
    record.code = envelope["code"].as_str().map(str::to_owned);
    record
}

/// Whether the lifecycle refused only because another operation holds the repository.
fn busy(error: &anyhow::Error) -> bool {
    error.downcast_ref::<LifecycleBusy>().is_some()
}

/// A deterministic failure for E2E, debug builds only: fails when
/// `ADE_E2E_WORKTREE_FAILPOINT` lists `point` (comma separated).
fn failpoint(point: &str) -> anyhow::Result<()> {
    if cfg!(debug_assertions)
        && std::env::var("ADE_E2E_WORKTREE_FAILPOINT")
            .is_ok_and(|points| points.split(',').any(|listed| listed == point))
    {
        anyhow::bail!("E2E failpoint {point}");
    }
    Ok(())
}

impl Host {
    pub(super) fn workspace_create_worktree(&self, request: &Value) -> anyhow::Result<Value> {
        let create: WorkspaceCreateWorktreeRequest = decode(request)?;
        check_id(&create.operation_id)?;
        let payload = ade_daemon::envelope::payload(request);
        if let Some(known) = self.known_operation(&create.operation_id, CREATE, &payload)? {
            return Ok(known);
        }
        let project = self.sessions.project(&create.project_id)?;
        ensure!(
            project.kind == ProjectKind::Repository,
            ade_core::error::ProjectNotRepository(create.project_id.clone())
        );
        let name = ade_core::workspaces::display_name(&create.name)
            .map_err(ade_core::error::InvalidWorkspaceName)?;
        let lifecycle_id = self.lifecycle_repository(&project.id, None)?;
        let now = now_ms();
        self.admit(
            CREATE,
            &payload,
            Record {
                operation_id: create.operation_id,
                kind: WorkspaceWorktreeKind::CreateWorktree,
                status: WorkspaceWorktreeStatus::Running,
                step: WorktreeStep::Tree,
                project_id: project.id,
                lifecycle_id,
                workspace_id: None,
                worktree_path: None,
                name: Some(name),
                base: create.base,
                delete_branch: None,
                restore_workspace: false,
                attempts: 0,
                retry_at: None,
                error: None,
                code: None,
                created_at: now,
                updated_at: now,
            },
        )
    }

    pub(super) fn workspace_delete_worktree(&self, request: &Value) -> anyhow::Result<Value> {
        let delete: WorkspaceDeleteWorktreeRequest = decode(request)?;
        check_id(&delete.operation_id)?;
        let payload = ade_daemon::envelope::payload(request);
        if let Some(known) = self.known_operation(&delete.operation_id, DELETE, &payload)? {
            return Ok(known);
        }
        let id = delete.workspace_id.as_str();
        ensure!(!id.is_empty(), "Missing workspace_id");
        let removed = self.sessions.workspace_removed(id)?;
        self.sessions.refresh_workspace_facts(Some(id))?;
        let workspace = self.sessions.workspace(id)?;
        let root = canonical(&workspace.root);
        match workspace.kind {
            WorkspaceKind::LinkedWorktree => {}
            WorkspaceKind::PrimaryCheckout => {
                return Err(
                    ade_core::error::WorktreeDeleteBlocked(vec![DeleteBlocker::tree(
                        CleanupBlocker::PrimaryCheckout,
                        &root,
                    )])
                    .into(),
                );
            }
            WorkspaceKind::Folder => {
                return Err(ade_core::error::WorktreeDeleteBlocked(vec![DeleteBlocker {
                    kind: DeleteBlockerKind::Kind(NotDeletable::NotAWorktree),
                    id: id.to_owned(),
                    label: "A plain folder has no worktree to delete".into(),
                }])
                .into());
            }
        }
        let lifecycle_id = self.lifecycle_repository(&workspace.project_id, Some(&root))?;
        // Everything that would stop either step, checked before either runs
        // and again before the workspace is removed.
        let blockers = self.delete_blockers(id, &root, &lifecycle_id, !removed)?;
        if !blockers.is_empty() {
            return Err(ade_core::error::WorktreeDeleteBlocked(blockers).into());
        }
        let now = now_ms();
        self.admit(
            DELETE,
            &payload,
            Record {
                operation_id: delete.operation_id,
                kind: WorkspaceWorktreeKind::DeleteWorktree,
                status: WorkspaceWorktreeStatus::Running,
                step: WorktreeStep::Workspace,
                project_id: workspace.project_id,
                lifecycle_id,
                workspace_id: Some(id.to_owned()),
                worktree_path: Some(root),
                name: None,
                base: None,
                delete_branch: delete.delete_branch,
                restore_workspace: !removed,
                attempts: 0,
                retry_at: None,
                error: None,
                code: None,
                created_at: now,
                updated_at: now,
            },
        )
    }

    /// What keeps the workspace's worktree from being deleted now. With
    /// `listed`, the workspace is still in ADE, so its own blockers count,
    /// and its own terminals and Agents (`active_work`) do not: removing it
    /// ends them. Another operation holding the repository never blocks; the
    /// deletion waits for it.
    fn delete_blockers(
        &self,
        id: &str,
        root: &str,
        lifecycle_id: &str,
        listed: bool,
    ) -> anyhow::Result<Vec<DeleteBlocker>> {
        let mut blockers: Vec<DeleteBlocker> = Vec::new();
        if listed {
            blockers.extend(self.runtime_blockers(id)?.into_iter().map(Into::into));
            blockers.extend(
                self.sessions
                    .workspace_remove_blockers(id)?
                    .into_iter()
                    .map(Into::into),
            );
        }
        self.refresh_leases()?;
        let plan: WorktreeCleanupPlan = serde_json::from_value(
            self.sessions
                .command(&json!({"op": "worktree.cleanup.plan", "project_id": lifecycle_id}))?,
        )
        .context("The worktree lifecycle returned an invalid cleanup plan")?;
        match plan.trees.iter().find(|tree| canonical(&tree.path) == root) {
            None => blockers.push(DeleteBlocker::tree(CleanupBlocker::NotListed, root)),
            Some(tree) => {
                for blocker in &tree.blockers {
                    // An explicit removal is the recovery for an unfinished
                    // setup or teardown.
                    let resolved = matches!(
                        blocker,
                        CleanupBlocker::SetupIncomplete
                            | CleanupBlocker::TeardownIncomplete
                            | CleanupBlocker::LifecycleRunning
                    ) || (*blocker == CleanupBlocker::ActiveWork && listed);
                    if !resolved {
                        blockers.push(DeleteBlocker::tree(*blocker, &tree.path));
                    }
                }
            }
        }
        Ok(blockers)
    }

    /// Advances every running operation; the daemon's tick calls it. One
    /// operation's error is logged and never stops the others.
    pub(super) fn advance_worktree_operations(&self) -> anyhow::Result<()> {
        for record in self.sessions.running_worktree_operations()? {
            if let Err(error) = self.advance(&record.operation_id) {
                eprintln!(
                    "Workspace worktree operation {}: {error:#}",
                    record.operation_id
                );
            }
        }
        Ok(())
    }

    /// The current state of an operation admitted before under the same ID
    /// and payload, or the refusal for a reused ID; `None` for a new ID.
    fn known_operation(
        &self,
        id: &str,
        op: &str,
        payload: &Value,
    ) -> anyhow::Result<Option<Value>> {
        match self.sessions.probe_worktree_operation(id, op, payload)? {
            WorktreeAdmission::New => {
                // The lifecycle step runs under this ID; one the lifecycle
                // already used for its own command would never settle.
                if self.sessions.worktrees.job(id)?.is_some() {
                    return Ok(Some(refusal(id, WorktreeAdmission::Conflict)));
                }
                Ok(None)
            }
            WorktreeAdmission::Known(_) => Ok(Some(self.advance(id)?)),
            refused => Ok(Some(refusal(id, refused))),
        }
    }

    fn admit(&self, op: &str, payload: &Value, record: Record) -> anyhow::Result<Value> {
        let id = record.operation_id.clone();
        match self
            .sessions
            .admit_worktree_operation(op, payload, &record)?
        {
            WorktreeAdmission::New | WorktreeAdmission::Known(_) => self.advance(&id),
            refused => Ok(refusal(&id, refused)),
        }
    }

    /// Takes every step the operation can take now and returns its state.
    fn advance(&self, id: &str) -> anyhow::Result<Value> {
        let _steps = self.worktree_steps.lock().unwrap();
        loop {
            let record = self
                .sessions
                .worktree_operation(id)?
                .context("The operation's recorded state is missing")?;
            if record.status != WorkspaceWorktreeStatus::Running
                || record.retry_at.is_some_and(|at| at > now_ms())
            {
                return Ok(reply(&record.reply()));
            }
            let step = match record.kind {
                WorkspaceWorktreeKind::CreateWorktree => self.create_step(record.clone()),
                WorkspaceWorktreeKind::DeleteWorktree => self.delete_step(record.clone()),
            };
            let mut next = match step {
                Ok(Progress::Next(next)) => *next,
                Ok(Progress::Wait) => return Ok(reply(&record.reply())),
                Err(error)
                    if error.downcast_ref::<TerminalsStillStopping>().is_some()
                        && record.attempts + 1 < MAX_ATTEMPTS =>
                {
                    let mut later = record.clone();
                    later.attempts += 1;
                    later.retry_at =
                        Some(now_ms() + FIRST_RETRY_MS * (1_i64 << later.attempts.min(10)));
                    self.sessions.save_worktree_operation(&mut later)?;
                    return Ok(reply(&later.reply()));
                }
                Err(error) => self.restored(fail(record, error)),
            };
            next.retry_at = None;
            self.sessions.save_worktree_operation(&mut next)?;
        }
    }

    fn create_step(&self, mut record: Record) -> anyhow::Result<Progress> {
        match record.step {
            WorktreeStep::Tree => {
                let Some(job) = self.lifecycle_job(&record)? else {
                    let mut create = json!({
                        "op": "worktree.create",
                        "project_id": record.lifecycle_id,
                        "operation_id": record.operation_id,
                        "name": record.name,
                    });
                    if let Some(base) = &record.base {
                        create["base"] = json!(base);
                    }
                    return match self.sessions.command(&create) {
                        Ok(_) => Ok(Progress::Wait),
                        Err(error) if busy(&error) => Ok(Progress::Wait),
                        Err(error) => Err(error),
                    };
                };
                match job.status {
                    Job::Running => Ok(Progress::Wait),
                    Job::Succeeded => {
                        record.worktree_path = Some(
                            job.worktree_path
                                .context("The worktree was created without a folder")?,
                        );
                        record.step = WorktreeStep::Workspace;
                        Ok(Progress::Next(Box::new(record)))
                    }
                    _ => Ok(Progress::Next(Box::new(job_failure(record, &job)))),
                }
            }
            WorktreeStep::Workspace => {
                let path = record
                    .worktree_path
                    .clone()
                    .context("The created worktree has no folder")?;
                let workspace = self.sessions.open_workspace(&path)?;
                record.workspace_id = Some(workspace.id.clone());
                // The folder is named after the branch slug; ADE shows the
                // name as the person typed it.
                if let Some(name) = record.name.as_ref().filter(|name| **name != workspace.name) {
                    let renamed = failpoint("rename").and_then(|()| {
                        self.sessions.command(&json!({
                            "op": "workspace.rename", "workspace_id": workspace.id, "name": name,
                        }))
                    });
                    // The failed state names the workspace, which exists unnamed.
                    if let Err(error) = renamed {
                        return Ok(Progress::Next(Box::new(fail(record, error))));
                    }
                }
                self.sessions.refresh_workspace_facts(Some(&workspace.id))?;
                record.status = WorkspaceWorktreeStatus::Succeeded;
                record.step = WorktreeStep::Done;
                Ok(Progress::Next(Box::new(record)))
            }
            WorktreeStep::Done => Ok(Progress::Wait),
        }
    }

    fn delete_step(&self, mut record: Record) -> anyhow::Result<Progress> {
        let workspace = record
            .workspace_id
            .clone()
            .context("The deletion names no workspace")?;
        let path = record
            .worktree_path
            .clone()
            .context("The deletion names no worktree")?;
        match record.step {
            WorktreeStep::Workspace => {
                if !self.sessions.workspace_removed(&workspace)? {
                    // Nothing is removed while another operation holds the
                    // repository, so a wait never leaves the workspace gone.
                    if self
                        .sessions
                        .worktrees
                        .repository_busy(&record.lifecycle_id)?
                    {
                        return Ok(Progress::Wait);
                    }
                    // The tree may have changed since admission: a tree that
                    // became dirty is refused before anything changes.
                    let blockers =
                        self.delete_blockers(&workspace, &path, &record.lifecycle_id, true)?;
                    ensure!(
                        blockers.is_empty(),
                        ade_core::error::WorktreeDeleteBlocked(blockers)
                    );
                    self.remove_from_ade(&workspace, &record.operation_id)?;
                }
                // A deterministic crash point for E2E: the workspace is
                // removed and the tree is not.
                ade_daemon::receipts::e2e_pause(DELETE);
                record.step = WorktreeStep::Tree;
                Ok(Progress::Next(Box::new(record)))
            }
            WorktreeStep::Tree => {
                let Some(job) = self.lifecycle_job(&record)? else {
                    // A restarted daemon has no leases yet; the lifecycle
                    // must see that nothing uses the tree.
                    self.refresh_leases()?;
                    failpoint("remove_tree")?;
                    let mut remove = json!({
                        "op": "worktree.remove",
                        "project_id": record.lifecycle_id,
                        "operation_id": record.operation_id,
                        "path": path,
                    });
                    if let Some(policy) = record.delete_branch {
                        remove["delete_branch"] = serde_json::to_value(policy)?;
                    }
                    return match self.sessions.command(&remove) {
                        Ok(_) => Ok(Progress::Wait),
                        Err(error) if busy(&error) => Ok(Progress::Wait),
                        Err(error) => Err(error),
                    };
                };
                match job.status {
                    Job::Running => Ok(Progress::Wait),
                    Job::Succeeded | Job::Partial => {
                        record.status = WorkspaceWorktreeStatus::Succeeded;
                        record.step = WorktreeStep::Done;
                        Ok(Progress::Next(Box::new(record)))
                    }
                    // An interrupted removal that left no tree removed it.
                    Job::Interrupted if !Path::new(&path).exists() => {
                        record.status = WorkspaceWorktreeStatus::Succeeded;
                        record.step = WorktreeStep::Done;
                        Ok(Progress::Next(Box::new(record)))
                    }
                    _ => Ok(Progress::Next(Box::new(
                        self.restored(job_failure(record, &job)),
                    ))),
                }
            }
            WorktreeStep::Done => Ok(Progress::Wait),
        }
    }

    /// A failed deletion gives back the workspace it removed from ADE when the
    /// tree is still there. The workspace returns without its layouts and
    /// terminals; the error says so, or says the restore failed too.
    fn restored(&self, mut record: Record) -> Record {
        let (Some(workspace), Some(path)) = (&record.workspace_id, &record.worktree_path) else {
            return record;
        };
        if record.kind != WorkspaceWorktreeKind::DeleteWorktree
            || !record.restore_workspace
            || !self.sessions.workspace_removed(workspace).unwrap_or(false)
            || !Path::new(path).is_dir()
        {
            return record;
        }
        let note = match failpoint("restore").and_then(|()| self.sessions.open_workspace(path)) {
            Ok(_) => "The workspace is back in ADE, without its previous layouts and terminals."
                .to_owned(),
            Err(error) => format!(
                "The workspace could not be restored ({error:#}); open its folder to bring it back."
            ),
        };
        let error = record.error.take().unwrap_or_default();
        record.error = Some(format!("{error} {note}").trim().to_owned());
        record
    }

    /// The lifecycle's ledger row for this operation, checked to be the step
    /// this operation dispatched.
    fn lifecycle_job(
        &self,
        record: &Record,
    ) -> anyhow::Result<Option<ade_core::contract::worktrees::WorktreeOperation>> {
        let Some(job) = self.sessions.worktrees.job(&record.operation_id)? else {
            return Ok(None);
        };
        let expected = match record.kind {
            WorkspaceWorktreeKind::CreateWorktree => "worktree.create",
            WorkspaceWorktreeKind::DeleteWorktree => "worktree.remove",
        };
        ensure!(
            job.request["op"] == expected,
            "Operation ID {} was already used for another worktree operation",
            record.operation_id
        );
        Ok(Some(job))
    }

    /// Registers the project's repository with the lifecycle, from `path` or
    /// its first checkout on disk, and returns the lifecycle's ID for it.
    fn lifecycle_repository(&self, project: &str, path: Option<&str>) -> anyhow::Result<String> {
        let roots = match path {
            Some(path) => vec![path.to_owned()],
            None => self.sessions.project_roots(project)?,
        };
        let root = roots
            .into_iter()
            .find(|root| Path::new(root).is_dir())
            .with_context(|| format!("Project {project} has no checkout on disk"))?;
        let state: WorktreeState = serde_json::from_value(
            self.sessions
                .command(&json!({"op": "worktree.repository", "path": root}))?,
        )
        .context("The worktree lifecycle returned an invalid repository")?;
        Ok(state.repository.id)
    }
}

/// A failed lifecycle job, with its own message and code.
fn job_failure(
    mut record: Record,
    job: &ade_core::contract::worktrees::WorktreeOperation,
) -> Record {
    record.status = WorkspaceWorktreeStatus::Failed;
    record.step = WorktreeStep::Done;
    record.error = Some(job.error.clone().unwrap_or_else(|| {
        format!("The worktree operation ended {:?}", job.status).to_lowercase()
    }));
    record.code = job.code.clone();
    record
}

fn refusal(id: &str, admission: WorktreeAdmission) -> Value {
    match admission {
        WorktreeAdmission::Expired => ade_daemon::envelope::error(
            "expired",
            &format!(
                "Operation ID {id} is past its 30-day receipt retention; use a new operation ID"
            ),
        ),
        _ => ade_daemon::envelope::error(
            "conflict",
            &format!("Operation ID {id} was already used for a different request"),
        ),
    }
}
