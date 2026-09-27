//! `checkpoint.*` operations (F070). Git work runs without the session lock;
//! receipts live in the profile database and take the lock briefly.
//!
//! Effect commands check everything they can before they record a receipt, so
//! a refusal leaves no receipt. Once a receipt is dispatched its record names
//! the ref the effect will write. A receipt left open by an earlier daemon
//! process is reconciled from Git on replay; a restore that may have written
//! files becomes unknown and never runs again.
use super::*;
use crate::checkpoints::{self as cp, Claim, Decision, Layout, Metadata, RestoreFacts, decide};
use crate::receipts::{self, Admission, Status};
use ade_core::contract::checkpoints::{
    CheckpointCreateRequest, CheckpointCreated, CheckpointDeleteRequest, CheckpointDeleted,
    CheckpointKind, CheckpointList, CheckpointListRequest, CheckpointRestoreOutcome,
    CheckpointRestorePreview, CheckpointRestorePreviewRequest, CheckpointRestoreRequest,
    CheckpointRestored, CheckpointSummary,
};
use ade_core::model::now_ms;
use rusqlite::{Connection, Transaction, TransactionBehavior};

fn operation_id(value: &str) -> Result<&str> {
    ensure!(
        !value.is_empty() && value.len() <= 512,
        "Missing or invalid operation_id"
    );
    Ok(value)
}

impl Sessions {
    fn checkpoint_db<T>(
        &self,
        effect: bool,
        step: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let d = self.data.lock().unwrap();
        ensure!(!(effect && d.draining), "Application daemon is restarting");
        receipts::ensure(&d.store.connection)?;
        step(&d.store.connection)
    }

    /// Looks an operation ID up without recording anything.
    fn checkpoint_peek(&self, id: &str, op: &str, request: &Value) -> Result<Admission> {
        self.checkpoint_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            receipts::begin(&tx, id, op, request, None, now_ms())
        })
    }

    /// Records a dispatched receipt carrying `record`, the facts reconciliation needs.
    fn checkpoint_dispatch(
        &self,
        id: &str,
        op: &str,
        request: &Value,
        record: &Value,
    ) -> Result<Admission> {
        self.checkpoint_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let admission = receipts::begin(&tx, id, op, request, None, now_ms())?;
            if admission == Admission::New {
                receipts::settle(&tx, id, Status::Dispatched, Some(record), now_ms())?;
                tx.commit()?;
            }
            Ok(admission)
        })
    }

    fn checkpoint_settle(&self, id: &str, status: Status, result: &Value) -> Result<()> {
        self.checkpoint_db(false, |db| {
            receipts::settle(db, id, status, Some(result), now_ms())
        })
    }

    /// Settles an effect and returns its outcome. If the receipt cannot be
    /// saved, the caller learns that, not the outcome it could not record.
    fn checkpoint_finish(&self, id: &str, result: Result<Value>) -> Result<Value> {
        self.checkpoint_settle(id, Status::Settled, &cp::outcome(&result))
            .with_context(|| {
                format!(
                    "Operation {id} ran but its outcome was not recorded; retry with the same operation ID to reconcile it"
                )
            })?;
        result
    }

    /// Answers a known operation ID. The caller holds the ID's claim, so an
    /// open receipt belongs to an earlier daemon process.
    fn checkpoint_replay(&self, layout: &Layout, id: &str, admission: Admission) -> Result<Value> {
        let receipt = match admission {
            Admission::New => bail!("Operation {id} was not admitted"),
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
            }
            Admission::Replay(receipt) => receipt,
        };
        let record = receipt.result.unwrap_or(Value::Null);
        match receipt.status {
            Status::Settled => cp::replay_outcome(Some(record)),
            Status::Unknown => Err(unknown(id, &record)),
            Status::Accepted | Status::Dispatched | Status::Acknowledged => {
                self.checkpoint_reconcile(layout, id, &record)
            }
        }
    }

    fn checkpoint_reconcile(&self, layout: &Layout, id: &str, record: &Value) -> Result<Value> {
        let text = |key: &str| record[key].as_str().unwrap_or_default().to_owned();
        match record["op"].as_str() {
            Some("checkpoint.create") => {
                let reference = text("ref_name");
                let result = if cp::exists(layout, &reference)? {
                    cp::read(layout, &reference).and_then(|checkpoint| {
                        reply(&CheckpointCreated {
                            tag: Default::default(),
                            checkpoint,
                        })
                    })
                } else {
                    Err(anyhow!(
                        "Checkpoint creation was interrupted before its ref was written; nothing was recorded"
                    ))
                };
                self.checkpoint_finish(id, result)
            }
            Some("checkpoint.delete") => {
                let reference = text("ref_name");
                let result = if cp::exists(layout, &reference)? {
                    Err(anyhow!(
                        "Checkpoint deletion was interrupted before the ref was removed; nothing changed"
                    ))
                } else {
                    reply(&CheckpointDeleted {
                        tag: Default::default(),
                        checkpoint_id: text("checkpoint_id"),
                        ref_name: reference,
                    })
                };
                self.checkpoint_finish(id, result)
            }
            Some("checkpoint.restore") if record["phase"] == "dispatched" => {
                // Files are written only after the phase moves to writing.
                let safety = text("safety_ref");
                let kept = if !safety.is_empty() && cp::exists(layout, &safety)? {
                    format!(
                        " Safety checkpoint {} was kept.",
                        text("safety_checkpoint_id")
                    )
                } else {
                    String::new()
                };
                self.checkpoint_finish(
                    id,
                    Err(anyhow!(
                        "Restore was interrupted before it changed the workspace.{kept}"
                    )),
                )
            }
            _ => {
                self.checkpoint_settle(id, Status::Unknown, record)?;
                Err(unknown(id, record))
            }
        }
    }

    fn checkpoint_root(&self, workspace_id: &str) -> Result<String> {
        non_empty("workspace_id", workspace_id)?;
        ensure!(
            cp::decide::valid_component(workspace_id),
            "Invalid workspace_id"
        );
        self.ensure_workspace_bound(workspace_id)?;
        Ok(self.workspace(workspace_id)?.root)
    }

    fn checkpoint_find(
        layout: &Layout,
        workspace_id: &str,
        checkpoint_id: &str,
    ) -> Result<CheckpointSummary> {
        let reference = cp::decide::ref_name(workspace_id, checkpoint_id)?;
        ensure!(
            cp::exists(layout, &reference)?,
            "Checkpoint {checkpoint_id} does not exist in this workspace"
        );
        cp::read(layout, &reference)
    }

    pub(super) fn checkpoint_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let op = request["op"].as_str().unwrap_or("");
        match op {
            "checkpoint.list" => {
                let list: CheckpointListRequest = decode(request)?;
                let layout = Layout::open(&self.checkpoint_root(&list.workspace_id)?)?;
                let (checkpoints, problems) = cp::list(&layout, &list.workspace_id)?;
                reply(&CheckpointList {
                    tag: Default::default(),
                    workspace_id: list.workspace_id,
                    checkpoints,
                    problems,
                })
            }
            "checkpoint.restore.preview" => {
                let preview: CheckpointRestorePreviewRequest = decode(request)?;
                non_empty("checkpoint_id", &preview.checkpoint_id)?;
                let layout = Layout::open(&self.checkpoint_root(&preview.workspace_id)?)?;
                let checkpoint =
                    Self::checkpoint_find(&layout, &preview.workspace_id, &preview.checkpoint_id)?;
                let blockers = layout.blockers(true)?;
                let snapshot = cp::snapshot(&layout).map_err(|error| {
                    if blockers.is_empty() {
                        error
                    } else {
                        anyhow!("Restore is blocked: {}", blockers.join("; "))
                    }
                })?;
                let plan = cp::plan(&layout, &snapshot, &checkpoint)?;
                let decision = decide(&RestoreFacts {
                    blockers: &blockers,
                    expected_state: None,
                    current_state: &plan.state_token,
                    changes: &plan.changes,
                    uncommitted_overwritten: &plan.uncommitted_overwritten,
                    ignored_overwritten: &plan.ignored_overwritten,
                    confirm_overwrite: false,
                });
                reply(&CheckpointRestorePreview {
                    tag: Default::default(),
                    checkpoint,
                    verdict: decision.verdict(),
                    state_token: plan.state_token,
                    changes: plan.changes,
                    uncommitted_overwritten: plan.uncommitted_overwritten,
                    ignored_overwritten: plan.ignored_overwritten,
                    head_changed: plan.head_changed,
                    blocked_reasons: match decision {
                        Decision::Blocked(reasons) => reasons,
                        _ => Vec::new(),
                    },
                })
            }
            "checkpoint.create" => self.checkpoint_create(request),
            "checkpoint.restore" => self.checkpoint_restore(request),
            "checkpoint.delete" => self.checkpoint_delete(request),
            _ => bail!("Unknown checkpoint operation"),
        }
    }

    fn checkpoint_create(self: &Arc<Self>, request: &Value) -> Result<Value> {
        const OP: &str = "checkpoint.create";
        let create: CheckpointCreateRequest = decode(request)?;
        let id = operation_id(&create.operation_id)?;
        if let Some(label) = &create.label {
            ensure!(
                cp::decide::valid_label(label),
                "label must be one line of at most 200 characters"
            );
        }
        let root = self.checkpoint_root(&create.workspace_id)?;
        let _lease = self.worktrees.lease(&root)?;
        let _claim = Claim::acquire(&create.workspace_id, id)?;
        let layout = Layout::open(&root)?;
        let admission = self.checkpoint_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.checkpoint_replay(&layout, id, admission);
        }
        let blockers = layout.blockers(false)?;
        ensure!(
            blockers.is_empty(),
            "Checkpoint refused: {}",
            blockers.join("; ")
        );
        let snapshot = cp::snapshot(&layout)?;
        let coverage = cp::coverage(&layout, &snapshot)?;
        let checkpoint_id = new_id("checkpoint");
        let reference = cp::decide::ref_name(&create.workspace_id, &checkpoint_id)?;
        let record = json!({"op": OP, "checkpoint_id": checkpoint_id, "ref_name": reference});
        let admission = self.checkpoint_dispatch(id, OP, request, &record)?;
        if admission != Admission::New {
            return self.checkpoint_replay(&layout, id, admission);
        }
        let metadata = Metadata {
            checkpoint_id,
            workspace_id: create.workspace_id,
            kind: CheckpointKind::Manual,
            label: create.label,
            head: snapshot.head.clone(),
            branch: snapshot.branch.clone(),
            created_at: now_ms(),
            coverage,
        };
        let result = cp::write(&layout, &snapshot, &metadata).and_then(|checkpoint| {
            reply(&CheckpointCreated {
                tag: Default::default(),
                checkpoint,
            })
        });
        self.checkpoint_finish(id, result)
    }

    fn checkpoint_restore(self: &Arc<Self>, request: &Value) -> Result<Value> {
        const OP: &str = "checkpoint.restore";
        let restore: CheckpointRestoreRequest = decode(request)?;
        let id = operation_id(&restore.operation_id)?;
        non_empty("checkpoint_id", &restore.checkpoint_id)?;
        non_empty("expected_state", &restore.expected_state)?;
        let workspace_id = restore.workspace_id.as_str();
        let root = self.checkpoint_root(workspace_id)?;
        let _lease = self.worktrees.lease(&root)?;
        let _claim = Claim::acquire(workspace_id, id)?;
        let layout = Layout::open(&root)?;
        let admission = self.checkpoint_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.checkpoint_replay(&layout, id, admission);
        }
        let checkpoint = Self::checkpoint_find(&layout, workspace_id, &restore.checkpoint_id)?;
        let blockers = layout.blockers(true)?;
        ensure!(
            blockers.is_empty(),
            "Restore refused: {}",
            blockers.join("; ")
        );
        let snapshot = cp::snapshot(&layout)?;
        let plan = cp::plan(&layout, &snapshot, &checkpoint)?;
        let decision = decide(&RestoreFacts {
            blockers: &blockers,
            expected_state: Some(&restore.expected_state),
            current_state: &plan.state_token,
            changes: &plan.changes,
            uncommitted_overwritten: &plan.uncommitted_overwritten,
            ignored_overwritten: &plan.ignored_overwritten,
            confirm_overwrite: restore.confirm_overwrite,
        });
        let restored = |outcome, safety_checkpoint, verified, problems| {
            reply(&CheckpointRestored {
                tag: Default::default(),
                checkpoint_id: checkpoint.checkpoint_id.clone(),
                outcome,
                safety_checkpoint,
                changes: plan.changes.clone(),
                verified,
                problems,
            })
        };
        match decision {
            Decision::Blocked(reasons) => bail!("Restore refused: {}", reasons.join("; ")),
            Decision::NeedsConfirmation => bail!(
                "Restore would replace uncommitted work in {} path(s), such as {}. Pass confirm_overwrite to proceed; ADE saves a safety checkpoint of the current state first",
                plan.uncommitted_overwritten.len(),
                plan.uncommitted_overwritten[0]
            ),
            Decision::Unchanged => {
                let record = json!({"op": OP, "phase": "unchanged"});
                let admission = self.checkpoint_dispatch(id, OP, request, &record)?;
                if admission != Admission::New {
                    return self.checkpoint_replay(&layout, id, admission);
                }
                let result = restored(CheckpointRestoreOutcome::Unchanged, None, true, Vec::new());
                self.checkpoint_finish(id, result)
            }
            Decision::Proceed => {
                let coverage = cp::coverage(&layout, &snapshot)?;
                let safety_id = new_id("checkpoint");
                let safety_ref = cp::decide::ref_name(workspace_id, &safety_id)?;
                let mut record = json!({"op": OP, "phase": "dispatched",
                    "safety_checkpoint_id": safety_id, "safety_ref": safety_ref});
                let admission = self.checkpoint_dispatch(id, OP, request, &record)?;
                if admission != Admission::New {
                    return self.checkpoint_replay(&layout, id, admission);
                }
                let metadata = Metadata {
                    checkpoint_id: safety_id.clone(),
                    workspace_id: workspace_id.to_owned(),
                    kind: CheckpointKind::Safety,
                    label: Some(format!("Before restoring {}", checkpoint.checkpoint_id)),
                    head: snapshot.head.clone(),
                    branch: snapshot.branch.clone(),
                    created_at: now_ms(),
                    coverage,
                };
                let safety = match cp::write(&layout, &snapshot, &metadata) {
                    Ok(safety) => safety,
                    Err(error) => {
                        return self.checkpoint_finish(
                            id,
                            Err(error.context(
                                "Restore stopped before changing the workspace: the safety checkpoint could not be saved",
                            )),
                        );
                    }
                };
                record["phase"] = json!("writing");
                self.checkpoint_settle(id, Status::Acknowledged, &record)
                    .context("Restore stopped before changing the workspace")?;
                // E2E crash points on either side of the file writes, while
                // the receipt says the workspace may be changing.
                receipts::e2e_pause("checkpoint.restore.writing");
                let result = match cp::restore(&layout, &snapshot, &checkpoint) {
                    Ok(applied) => restored(
                        if applied.verified {
                            CheckpointRestoreOutcome::Restored
                        } else {
                            CheckpointRestoreOutcome::Partial
                        },
                        Some(safety),
                        applied.verified,
                        applied.problems,
                    ),
                    Err(error) => Err(error.context(format!(
                        "Restore failed; safety checkpoint {safety_id} was kept"
                    ))),
                };
                receipts::e2e_pause("checkpoint.restore.written");
                self.checkpoint_finish(id, result)
            }
        }
    }

    fn checkpoint_delete(self: &Arc<Self>, request: &Value) -> Result<Value> {
        const OP: &str = "checkpoint.delete";
        let delete: CheckpointDeleteRequest = decode(request)?;
        let id = operation_id(&delete.operation_id)?;
        non_empty("checkpoint_id", &delete.checkpoint_id)?;
        non_empty("expected_commit", &delete.expected_commit)?;
        let root = self.checkpoint_root(&delete.workspace_id)?;
        let _lease = self.worktrees.lease(&root)?;
        let _claim = Claim::acquire(&delete.workspace_id, id)?;
        let layout = Layout::open(&root)?;
        let admission = self.checkpoint_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.checkpoint_replay(&layout, id, admission);
        }
        let checkpoint =
            Self::checkpoint_find(&layout, &delete.workspace_id, &delete.checkpoint_id)?;
        ensure!(
            checkpoint.commit == delete.expected_commit,
            "Checkpoint {} points at another commit; list checkpoints again",
            delete.checkpoint_id
        );
        let record = json!({"op": OP, "checkpoint_id": checkpoint.checkpoint_id,
            "ref_name": checkpoint.ref_name});
        let admission = self.checkpoint_dispatch(id, OP, request, &record)?;
        if admission != Admission::New {
            return self.checkpoint_replay(&layout, id, admission);
        }
        let result = cp::delete(&layout, &checkpoint.ref_name, &checkpoint.commit).and_then(|()| {
            reply(&CheckpointDeleted {
                tag: Default::default(),
                checkpoint_id: checkpoint.checkpoint_id.clone(),
                ref_name: checkpoint.ref_name.clone(),
            })
        });
        self.checkpoint_finish(id, result)
    }
}

fn unknown(id: &str, record: &Value) -> anyhow::Error {
    let safety = record["safety_checkpoint_id"]
        .as_str()
        .map(|safety| format!(" The state before it is kept in safety checkpoint {safety}."))
        .unwrap_or_default();
    anyhow!(
        "Operation {id} was interrupted while it was changing the workspace; its outcome is unknown and it will not run again.{safety}"
    )
}
