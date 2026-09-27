//! Parallel run groups and their comparison (F105).
//!
//! A group starts one task as sibling children of a parent, one per run, under
//! a group identity. Starting a group is one effect command: its receipt, the
//! group, every child Conversation, link and queued task commit in one
//! `state.sqlite` transaction, so a group is never half created and a retry
//! never creates it twice. The group records each run's workspace HEAD at the
//! start, so a comparison can tell what each run committed since. Comparison
//! reads Git through `review.status` and read-only Git commands; it never
//! merges, stages or checks out anything.
use super::group_policy::{self, RunPaths};
use super::*;
use ade_core::contract::orchestration::{
    CommittedChanges, GroupCompareRequest, GroupComparison, GroupGetRequest, GroupList,
    GroupRecord, GroupReply, GroupStartRequest, GroupStarted, GroupsRequest, RunChanges,
    RunComparison, RunRecord,
};
use ade_core::contract::review::ReviewStatus;

pub(super) const START: &str = "orchestration.group.start";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS orchestration_groups(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, attribution TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orchestration_groups_parent ON orchestration_groups(parent_id);
CREATE TABLE IF NOT EXISTS orchestration_group_runs(group_id TEXT NOT NULL, idx INTEGER NOT NULL CHECK(idx>=0), child_id TEXT NOT NULL UNIQUE, base_commit TEXT, PRIMARY KEY(group_id, idx));";

/// Creates the group tables, and the child tables they join, when missing.
fn ensure_group_schema(connection: &Connection) -> Result<()> {
    ensure_schema(connection)?;
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// A group with each run's current state, read on the store's connection.
fn group_record(store: &Store, group_id: &str, now: i64) -> Result<GroupRecord> {
    let db = &store.connection;
    let (parent, operation_id, attribution, title, created_at) = db
        .query_row(
            "SELECT parent_id,operation_id,attribution,title,created_at FROM orchestration_groups WHERE id=?1",
            [group_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .with_context(|| format!("Unknown parallel group ID: {group_id}"))?;
    let mut statement = db.prepare(
        "SELECT idx,child_id,base_commit FROM orchestration_group_runs WHERE group_id=?1 ORDER BY idx",
    )?;
    let rows = statement
        .query_map([group_id], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut runs = Vec::with_capacity(rows.len());
    for (index, child_id, base_commit) in rows {
        let record = link(db, &child_id)?.context("A parallel run lost its child link")?;
        let message_id = newest_message(db, &child_id)?;
        // No deadline: the group view reports pending, never timed out.
        let (progress, _) = observe(store, &child_id, &message_id, now, i64::MAX)?;
        runs.push(RunRecord {
            index,
            child: with_state(db, record)?,
            message_id,
            progress,
            base_commit,
        });
    }
    Ok(GroupRecord {
        group_id: group_id.to_owned(),
        parent_conversation_id: parent,
        operation_id,
        attribution,
        title,
        created_at,
        summary: group_policy::summarize(runs.iter().map(|run| &run.progress)),
        runs,
    })
}

/// A run's verified workspace and base commit, read before the store transaction.
struct Placement {
    workspace_id: String,
    mode: &'static str,
    worktree_operation: Option<String>,
    base_commit: Option<String>,
}

/// Runs a read-only Git command in a workspace's Git root.
fn git(root: &str, args: &[&str]) -> Result<String> {
    let mut full = vec!["--no-optional-locks"];
    full.extend_from_slice(args);
    crate::worktrees::git(root, &full)
}

/// What a run committed since `base`, or why that cannot be proven.
fn committed(root: &str, base: Option<&str>, head: &str) -> CommittedChanges {
    let unknown = |reason: String| CommittedChanges::Unknown { reason };
    let Some(base) = base else {
        return unknown("The workspace had no commit when the group started".into());
    };
    if head == "(initial)" {
        return unknown("The workspace has no commit".into());
    }
    let read = || -> Result<CommittedChanges> {
        let range = format!("{base}..HEAD");
        let commits = git(root, &["rev-list", "--count", &range, "--"])?
            .parse()
            .context("Git returned an invalid commit count")?;
        let raw = git(
            root,
            &[
                "diff",
                "--name-status",
                "-z",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                base,
                "HEAD",
                "--",
            ],
        )?;
        let (files, truncated) =
            group_policy::parse_name_status(&raw, group_policy::MAX_COMMITTED_FILES)?;
        Ok(CommittedChanges::Known {
            base_commit: base.to_owned(),
            commits,
            files,
            truncated,
        })
    };
    read().unwrap_or_else(|error| unknown(format!("Git could not compare commits: {error}")))
}

impl Sessions {
    pub(super) fn group_start(self: &Arc<Self>, start: GroupStartRequest) -> Result<Value> {
        policy::check_id("operation_id", &start.operation_id)?;
        let parent_id = non_empty("parent_conversation_id", &start.parent_conversation_id)?;
        let attribution = policy::authorize_delegation(&start.caller, parent_id)?;
        policy::check_text(&start.task)?;
        let title = policy::child_title(start.title.as_deref(), &start.task)?;
        group_policy::check_runs(&start.runs)?;
        let configs = start
            .runs
            .iter()
            .map(|run| {
                serde_json::from_value::<crate::provider::Config>(
                    run.provider_config.clone().unwrap_or_else(|| json!({})),
                )
                .map_err(anyhow::Error::from)
            })
            .collect::<Result<Vec<_>>>()?;
        let payload = serde_json::to_value(&start)?;
        let operation_id = start.operation_id.as_str();
        let parent = {
            let d = self.data.lock().unwrap();
            ensure_group_schema(&d.store.connection)?;
            if let Some(result) = peek(
                &d.store.connection,
                operation_id,
                START,
                &payload,
                "parallel group",
            )? {
                return Ok(result);
            }
            d.store.conversation(parent_id)?
        };
        // The worktree ledger and Git run outside the store lock.
        let mut placements = Vec::with_capacity(start.runs.len());
        for run in &start.runs {
            let (workspace_id, mode, worktree_operation) = match &run.workspace {
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
            let root = self.workspace(&workspace_id)?.root;
            // An unborn branch or a folder outside Git has no base; a later
            // comparison then reports its commits as unknown.
            let base_commit = git(
                &root,
                &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            )
            .ok()
            .filter(|head| !head.is_empty());
            placements.push(Placement {
                workspace_id,
                mode,
                worktree_operation,
                base_commit,
            });
        }

        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        let now = now_ms();
        let (created, result) = persistence_result((|| -> Result<_> {
            let db = &d.store.connection;
            let tx = db.unchecked_transaction()?;
            let admission =
                receipts::begin(&tx, operation_id, START, &payload, Some(&attribution), now)?;
            if let Some(result) = replay(admission, "parallel group")? {
                return Ok((Vec::new(), result));
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
            let group_id = new_id("group");
            tx.execute(
                "INSERT INTO orchestration_groups(id,parent_id,operation_id,attribution,title,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![group_id, parent_id, operation_id, attribution, title, now],
            )?;
            let mut children = Vec::with_capacity(start.runs.len());
            for (index, ((run, config), placement)) in
                start.runs.iter().zip(configs).zip(&placements).enumerate()
            {
                let depth = policy::child_depth(parent_depth, siblings as usize + index)?;
                let account = policy::resolve_account(
                    &run.account,
                    &run.provider,
                    &parent.provider,
                    parent.account_id.as_deref(),
                )?;
                let run_operation = group_policy::run_operation_id(&group_id, index);
                let child = insert_child(
                    &tx,
                    &d.store,
                    NewChild {
                        parent_id,
                        operation_id: &run_operation,
                        attribution: &attribution,
                        depth,
                        provider: &run.provider,
                        provider_config: config,
                        account: account.as_deref(),
                        workspace_id: &placement.workspace_id,
                        mode: placement.mode,
                        worktree_operation: placement.worktree_operation.as_deref(),
                        title: &title,
                        task: &start.task,
                        now,
                    },
                )?;
                tx.execute(
                    "INSERT INTO orchestration_group_runs(group_id,idx,child_id,base_commit) VALUES(?1,?2,?3,?4)",
                    params![group_id, index as i64, child.id, placement.base_commit],
                )?;
                children.push(child);
            }
            let result = reply(&GroupStarted {
                tag: Default::default(),
                group: group_record(&d.store, &group_id, now)?,
            })?;
            receipts::settle(
                &tx,
                operation_id,
                receipts::Status::Settled,
                Some(&result),
                now,
            )?;
            tx.commit()?;
            Ok((children, result))
        })())?;
        if !created.is_empty() {
            self.catalog_changed(&mut d)?;
            for child in &created {
                self.changed(&mut d, child, &[])?;
            }
        }
        Ok(result)
    }

    pub(super) fn groups(&self, list: GroupsRequest) -> Result<Value> {
        let parent = non_empty("parent_conversation_id", &list.parent_conversation_id)?;
        let d = self.data.lock().unwrap();
        let db = &d.store.connection;
        ensure_group_schema(db)?;
        let ids = db
            .prepare(
                "SELECT id FROM orchestration_groups WHERE parent_id=?1 ORDER BY created_at,rowid",
            )?
            .query_map([parent], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            !ids.is_empty() || conversation(db, parent)?.is_some(),
            "Unknown conversations ID: {parent}"
        );
        let now = now_ms();
        let groups = ids
            .iter()
            .map(|id| group_record(&d.store, id, now))
            .collect::<Result<_>>()?;
        reply(&GroupList {
            tag: Default::default(),
            parent_conversation_id: parent.to_owned(),
            groups,
        })
    }

    pub(super) fn group_get(&self, get: GroupGetRequest) -> Result<Value> {
        let id = non_empty("group_id", &get.group_id)?;
        let d = self.data.lock().unwrap();
        ensure_group_schema(&d.store.connection)?;
        reply(&GroupReply {
            tag: Default::default(),
            group: group_record(&d.store, id, now_ms())?,
        })
    }

    /// Reads each run's outcome and Git changes. Each distinct workspace is
    /// read once, through the same `review.status` path and binding checks
    /// as a person's read. A workspace that cannot be read is reported as
    /// unavailable for its runs; it never fails the whole comparison.
    pub(super) fn group_compare(self: &Arc<Self>, compare: GroupCompareRequest) -> Result<Value> {
        let id = non_empty("group_id", &compare.group_id)?;
        let (group, parent_workspace) = {
            let d = self.data.lock().unwrap();
            ensure_group_schema(&d.store.connection)?;
            let group = group_record(&d.store, id, now_ms())?;
            let parent_workspace =
                conversation(&d.store.connection, &group.parent_conversation_id)?
                    .map(|parent| parent.workspace_id);
            (group, parent_workspace)
        };
        let mut statuses: HashMap<&str, std::result::Result<ReviewStatus, String>> = HashMap::new();
        for run in &group.runs {
            let workspace = run.child.workspace_id.as_str();
            if statuses.contains_key(workspace) {
                continue;
            }
            let status = self
                .command(&json!({"op": "review.status", "workspace_id": workspace, "force": true}))
                .and_then(|value| {
                    serde_json::from_value::<ReviewStatus>(value)
                        .context("Review returned an invalid status")
                })
                .map_err(|error| error.to_string());
            statuses.insert(workspace, status);
        }
        let workspaces: Vec<&str> = group
            .runs
            .iter()
            .map(|run| run.child.workspace_id.as_str())
            .collect();
        // With the parent gone, no run can be proven to share its workspace;
        // only run-to-run sharing is reported then.
        let shared =
            group_policy::shared_workspaces(parent_workspace.as_deref().unwrap_or(""), &workspaces);
        let runs: Vec<RunComparison> = group
            .runs
            .iter()
            .zip(shared)
            .map(|(run, shared_workspace)| {
                let changes = match &statuses[run.child.workspace_id.as_str()] {
                    Err(reason) => RunChanges::Unavailable {
                        reason: reason.clone(),
                    },
                    Ok(status) => RunChanges::Available {
                        branch: status.branch.clone(),
                        head: status.head.clone(),
                        revision: status.revision.clone(),
                        conflicts: status.conflicts,
                        uncommitted: status.files.clone(),
                        committed: committed(
                            &status.root,
                            run.base_commit.as_deref(),
                            &status.head,
                        ),
                    },
                };
                RunComparison {
                    index: run.index,
                    child_conversation_id: run.child.child_conversation_id.clone(),
                    provider: run.child.provider.clone(),
                    account_id: run.child.account_id.clone(),
                    workspace_id: run.child.workspace_id.clone(),
                    workspace_mode: run.child.workspace_mode,
                    progress: run.progress.clone(),
                    shared_workspace,
                    changes,
                }
            })
            .collect();
        let paths: Vec<RunPaths> = runs
            .iter()
            .map(|run| RunPaths {
                index: run.index,
                workspace_id: &run.workspace_id,
                paths: match &run.changes {
                    RunChanges::Unavailable { .. } => None,
                    RunChanges::Available {
                        uncommitted,
                        committed,
                        ..
                    } => {
                        let mut paths: Vec<&str> =
                            uncommitted.iter().map(|file| file.path.as_str()).collect();
                        if let CommittedChanges::Known { files, .. } = committed {
                            paths.extend(files.iter().map(|file| file.path.as_str()));
                        }
                        Some(paths)
                    }
                },
            })
            .collect();
        let overlaps = group_policy::overlaps(&paths);
        reply(&GroupComparison {
            tag: Default::default(),
            group_id: group.group_id.clone(),
            summary: group.summary.clone(),
            runs,
            overlaps,
            compared_at: now_ms(),
        })
    }
}
