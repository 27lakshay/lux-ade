//! Conversation controls: steering (F035), rewind (F039), compaction (F040)
//! and snoozing (F046).
//!
//! Steer, compact and rewind are effect commands. Each records its receipt in
//! the profile database, in the same transaction that checks the Conversation
//! may take it, before anything reaches the provider or the workspace; a
//! refusal rolls the receipt back. The runtime keys each native call by the
//! operation ID, so a retry after a lost reply asks the same run for its
//! stored answer instead of calling the provider again. A retry that finds a
//! different run can prove nothing and settles as unknown.
//!
//! File rewind delegates to the checkpoint restore under a derived operation
//! ID, whose own receipt and reconciliation make a retry safe.
use super::*;
use crate::receipts::{self, Admission, Receipt, Status};
use ade_core::contract::checkpoints::{
    CheckpointRestoreOutcome, CheckpointRestorePreview, CheckpointRestored,
};
use ade_core::contract::conversations::{
    ControlAvailability, ControlOutcome, ConversationCompactRequest, ConversationControl,
    ConversationControlReply, ConversationControls, ConversationControlsRequest,
    ConversationRewindPreview, ConversationRewindPreviewRequest, ConversationRewindRequest,
    ConversationSnoozeList, ConversationSnoozeListRequest, ConversationSnoozeReply,
    ConversationSnoozeRequest, ConversationSteerRequest, ConversationUnsnoozeRequest, RewindScope,
};
use ade_core::model::now_ms;
use rusqlite::{Transaction, TransactionBehavior};

mod availability;
use availability::Facts;

/// Longest caller operation ID; file rewind appends a suffix to it.
const OPERATION_ID_LIMIT: usize = 500;
const STEER_TEXT_LIMIT: usize = 1024 * 1024;

/// What a replayed receipt allows.
#[derive(Debug, PartialEq)]
enum Replay {
    /// Return the stored reply.
    Stored(Value),
    /// Ask the same run again under the same key; it answers from its receipt.
    Ask,
    /// Nothing can prove the outcome.
    Unknown,
}

/// Decides a replay from the stored receipt and the run connected now.
fn replay(receipt: &Receipt, run: Option<&str>) -> Replay {
    let result = receipt.result.as_ref();
    match receipt.status {
        Status::Settled | Status::Acknowledged => match result {
            Some(reply) if reply["type"] == "conversation_control" => Replay::Stored(reply.clone()),
            _ => Replay::Unknown,
        },
        Status::Unknown => Replay::Unknown,
        Status::Accepted | Status::Dispatched => {
            let dispatched = result.and_then(|record| record["run"].as_str());
            if dispatched.is_some() && dispatched == run {
                Replay::Ask
            } else {
                Replay::Unknown
            }
        }
    }
}

/// The reply a checkpoint restore becomes.
fn restore_outcome(outcome: CheckpointRestoreOutcome) -> ControlOutcome {
    match outcome {
        CheckpointRestoreOutcome::Restored => ControlOutcome::Restored,
        CheckpointRestoreOutcome::Unchanged => ControlOutcome::Unchanged,
        CheckpointRestoreOutcome::Partial => ControlOutcome::Partial,
    }
}

fn check_operation_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty() && id.len() <= OPERATION_ID_LIMIT,
        "Missing or invalid operation_id"
    );
    Ok(())
}

fn control_reply(
    operation_id: &str,
    conversation_id: &str,
    control: ConversationControl,
    outcome: ControlOutcome,
) -> ConversationControlReply {
    ConversationControlReply {
        tag: Default::default(),
        operation_id: operation_id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        control,
        outcome,
        reason: None,
        turn_id: None,
        files: None,
    }
}

fn unavailable(
    operation_id: &str,
    conversation_id: &str,
    availability: ControlAvailability,
) -> ConversationControlReply {
    ConversationControlReply {
        reason: availability.reason,
        ..control_reply(
            operation_id,
            conversation_id,
            availability.control,
            ControlOutcome::Unavailable,
        )
    }
}

fn unknown_reply(
    operation_id: &str,
    conversation_id: &str,
    control: ConversationControl,
) -> ConversationControlReply {
    ConversationControlReply {
        reason: Some(
            "ADE cannot confirm whether this operation took effect, and it will not run it again. Inspect the Conversation and workspace."
                .into(),
        ),
        ..control_reply(
            operation_id,
            conversation_id,
            control,
            ControlOutcome::Unknown,
        )
    }
}

fn not_confirmed(error: anyhow::Error) -> anyhow::Error {
    anyhow!(
        "{error:#}. The outcome was not confirmed; retry with the same operation_id to read it, never with a new one"
    )
}

/// What admission decided for an effect command.
enum Admitted {
    /// Deliver the effect; the receipt is dispatched.
    Deliver,
    /// Reply without delivering anything.
    Reply(Box<ConversationControlReply>),
}

/// The live facts about a Conversation, read under the session lock.
struct Live {
    conversation: Conversation,
    run: Option<String>,
    rpc: Option<Arc<dyn Provider>>,
}

impl Live {
    fn facts(&self) -> Facts<'_> {
        let c = &self.conversation;
        Facts {
            provider: &c.provider,
            status: &c.status,
            active_turn: c.active_turn_id.as_deref(),
            connected: self.rpc.is_some(),
            terminal_owned: c.terminal_owner.is_some(),
        }
    }
}

fn live(d: &Data, id: &str) -> Result<Live> {
    let conversation = d.store.conversation(id)?;
    let agent = d.agents.get(id);
    Ok(Live {
        conversation,
        run: agent.map(|a| a.run_id.clone()),
        rpc: agent.and_then(|a| a.rpc.clone()),
    })
}

/// Whether `op` is one of this module's operations.
pub(super) fn handles(op: &str) -> bool {
    matches!(
        op,
        "conversation.controls"
            | "conversation.steer"
            | "conversation.compact"
            | "conversation.rewind.preview"
            | "conversation.rewind"
            | "conversation.snooze"
            | "conversation.unsnooze"
            | "conversation.snooze.list"
    )
}

impl Sessions {
    pub(super) fn control_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "conversation.controls" => {
                let query: ConversationControlsRequest = decode(request)?;
                let d = self.data.lock().unwrap();
                let live = live(&d, non_empty("conversation_id", &query.conversation_id)?)?;
                let facts = live.facts();
                reply(&ConversationControls {
                    tag: Default::default(),
                    conversation_id: query.conversation_id.clone(),
                    provider: live.conversation.provider.clone(),
                    controls: availability::ALL
                        .iter()
                        .map(|control| availability::decide(&facts, *control))
                        .collect(),
                    snooze: d.store.snooze_of(&query.conversation_id)?,
                })
            }
            "conversation.steer" => self.steer(request),
            "conversation.compact" => self.compact(request),
            "conversation.rewind.preview" => self.rewind_preview(request),
            "conversation.rewind" => self.rewind(request),
            "conversation.snooze" => {
                let snooze: ConversationSnoozeRequest = decode(request)?;
                let stored = persistence_result(self.data.lock().unwrap().store.snooze(
                    &snooze.conversation_id,
                    snooze.until,
                    now_ms(),
                ))?;
                reply(&ConversationSnoozeReply {
                    tag: Default::default(),
                    conversation_id: snooze.conversation_id,
                    snooze: Some(stored),
                })
            }
            "conversation.unsnooze" => {
                let unsnooze: ConversationUnsnoozeRequest = decode(request)?;
                let d = self.data.lock().unwrap();
                d.store.conversation(&unsnooze.conversation_id)?;
                persistence_result(d.store.unsnooze(&unsnooze.conversation_id))?;
                reply(&ConversationSnoozeReply {
                    tag: Default::default(),
                    conversation_id: unsnooze.conversation_id,
                    snooze: None,
                })
            }
            "conversation.snooze.list" => {
                let list: ConversationSnoozeListRequest = decode(request)?;
                reply(&ConversationSnoozeList {
                    tag: Default::default(),
                    snoozes: self.data.lock().unwrap().store.snoozes(list.limit)?,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }

    /// Admits an effect command. `check` runs only for a new operation, in
    /// the receipt's transaction; its refusal rolls the receipt back. `record`
    /// is what a replay needs to reconcile.
    fn admit_control(
        &self,
        operation_id: &str,
        conversation_id: &str,
        control: ConversationControl,
        request: &Value,
        run: Option<&str>,
        check: impl FnOnce(&Data) -> Result<std::result::Result<Value, ConversationControlReply>>,
    ) -> Result<Admitted> {
        let op = request["op"].as_str().unwrap_or("");
        let d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        receipts::ensure(&d.store.connection)?;
        let tx = Transaction::new_unchecked(&d.store.connection, TransactionBehavior::Immediate)?;
        let now = now_ms();
        match receipts::begin(&tx, operation_id, op, request, None, now)? {
            Admission::New => match check(&d)? {
                Err(refused) => Ok(Admitted::Reply(Box::new(refused))),
                Ok(record) => {
                    receipts::settle(&tx, operation_id, Status::Dispatched, Some(&record), now)?;
                    tx.commit()?;
                    Ok(Admitted::Deliver)
                }
            },
            Admission::Replay(receipt) => match replay(&receipt, run) {
                Replay::Stored(stored) => {
                    Ok(Admitted::Reply(Box::new(serde_json::from_value(stored)?)))
                }
                Replay::Ask => Ok(Admitted::Deliver),
                Replay::Unknown => {
                    if receipt.status != Status::Unknown {
                        receipts::settle(&tx, operation_id, Status::Unknown, None, now)?;
                        tx.commit()?;
                    }
                    Ok(Admitted::Reply(Box::new(unknown_reply(
                        operation_id,
                        conversation_id,
                        control,
                    ))))
                }
            },
            Admission::Conflict => {
                bail!("Operation ID {operation_id} was already used for a different request")
            }
            Admission::Expired => {
                bail!(
                    "Operation ID {operation_id} is past receipt retention; it will not run again"
                )
            }
        }
    }

    fn settle_control(&self, reply_value: &ConversationControlReply) -> Result<Value> {
        let value = serde_json::to_value(reply_value)?;
        let d = self.data.lock().unwrap();
        receipts::settle(
            &d.store.connection,
            &reply_value.operation_id,
            Status::Settled,
            Some(&value),
            now_ms(),
        )?;
        Ok(value)
    }

    fn steer(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let steer: ConversationSteerRequest = decode(request)?;
        check_operation_id(&steer.operation_id)?;
        non_empty("turn_id", &steer.turn_id)?;
        ensure!(!steer.text.trim().is_empty(), "Missing text");
        ensure!(steer.text.len() <= STEER_TEXT_LIMIT, "Text exceeds 1 MiB");
        let (workspace_id, current) = {
            let d = self.data.lock().unwrap();
            let live = live(&d, &steer.conversation_id)?;
            (live.conversation.workspace_id.clone(), live)
        };
        self.ensure_workspace_bound(&workspace_id)?;
        let control = ConversationControl::Steer;
        let admitted = self.admit_control(
            &steer.operation_id,
            &steer.conversation_id,
            control,
            request,
            current.run.as_deref(),
            |d| {
                let live = live(d, &steer.conversation_id)?;
                let decided = availability::decide(&live.facts(), control);
                if !decided.available {
                    return Ok(Err(unavailable(
                        &steer.operation_id,
                        &steer.conversation_id,
                        decided,
                    )));
                }
                ensure!(
                    live.conversation.active_turn_id.as_deref() == Some(steer.turn_id.as_str()),
                    "Turn {} is no longer the running turn; nothing was steered",
                    steer.turn_id
                );
                Ok(Ok(json!({"run": live.run, "turn": steer.turn_id})))
            },
        )?;
        if let Admitted::Reply(done) = admitted {
            return reply(&done);
        }
        let (rpc, thread) = {
            let d = self.data.lock().unwrap();
            let live = live(&d, &steer.conversation_id)?;
            (
                live.rpc.context("The Agent is no longer connected")?,
                live.conversation
                    .provider_thread_id
                    .context("The provider session is unknown")?,
            )
        };
        let prompt = ade_core::prompt::Prompt {
            text: steer.text.clone(),
            attachments: vec![],
        };
        let turn = rpc
            .steer(&thread, &steer.turn_id, &steer.operation_id, &prompt)
            .map_err(not_confirmed)?;
        self.settle_control(&ConversationControlReply {
            turn_id: Some(turn),
            ..control_reply(
                &steer.operation_id,
                &steer.conversation_id,
                control,
                ControlOutcome::Acknowledged,
            )
        })
    }

    fn compact(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let compact: ConversationCompactRequest = decode(request)?;
        check_operation_id(&compact.operation_id)?;
        let (workspace_id, current) = {
            let d = self.data.lock().unwrap();
            let live = live(&d, &compact.conversation_id)?;
            (live.conversation.workspace_id.clone(), live)
        };
        self.ensure_workspace_bound(&workspace_id)?;
        let control = ConversationControl::Compact;
        let admitted = self.admit_control(
            &compact.operation_id,
            &compact.conversation_id,
            control,
            request,
            current.run.as_deref(),
            |d| {
                let live = live(d, &compact.conversation_id)?;
                let decided = availability::decide(&live.facts(), control);
                if !decided.available {
                    return Ok(Err(unavailable(
                        &compact.operation_id,
                        &compact.conversation_id,
                        decided,
                    )));
                }
                Ok(Ok(json!({"run": live.run})))
            },
        )?;
        if let Admitted::Reply(done) = admitted {
            return reply(&done);
        }
        let (rpc, thread) = {
            let d = self.data.lock().unwrap();
            let live = live(&d, &compact.conversation_id)?;
            (
                live.rpc.context("The Agent is no longer connected")?,
                live.conversation
                    .provider_thread_id
                    .context("The provider session is unknown")?,
            )
        };
        rpc.compact(&thread, &compact.operation_id)
            .map_err(not_confirmed)?;
        self.settle_control(&control_reply(
            &compact.operation_id,
            &compact.conversation_id,
            control,
            ControlOutcome::Acknowledged,
        ))
    }

    fn rewind_availability(
        &self,
        conversation_id: &str,
        scope: RewindScope,
    ) -> Result<(Conversation, ControlAvailability)> {
        let d = self.data.lock().unwrap();
        let live = live(&d, conversation_id)?;
        let control = match scope {
            RewindScope::Conversation => ConversationControl::RewindConversation,
            RewindScope::Files => ConversationControl::RewindFiles,
        };
        let decided = availability::decide(&live.facts(), control);
        Ok((live.conversation, decided))
    }

    fn rewind_preview(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let preview: ConversationRewindPreviewRequest = decode(request)?;
        let (conversation, decided) =
            self.rewind_availability(&preview.conversation_id, preview.scope)?;
        let files = match (preview.scope, decided.available) {
            (RewindScope::Files, true) => {
                let checkpoint = preview
                    .checkpoint_id
                    .as_deref()
                    .context("Missing checkpoint_id")?;
                self.ensure_workspace_bound(&conversation.workspace_id)?;
                let restore = self.checkpoint_command(&json!({
                    "op": "checkpoint.restore.preview",
                    "workspace_id": conversation.workspace_id,
                    "checkpoint_id": checkpoint,
                }))?;
                Some(serde_json::from_value::<CheckpointRestorePreview>(restore)?)
            }
            _ => None,
        };
        reply(&ConversationRewindPreview {
            tag: Default::default(),
            conversation_id: preview.conversation_id,
            scope: preview.scope,
            availability: decided,
            files,
        })
    }

    fn rewind(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let rewind: ConversationRewindRequest = decode(request)?;
        check_operation_id(&rewind.operation_id)?;
        let (conversation, decided) =
            self.rewind_availability(&rewind.conversation_id, rewind.scope)?;
        if rewind.scope == RewindScope::Conversation {
            // No adapter rewinds history yet, so no receipt is ever recorded.
            ensure!(!decided.available, "Conversation rewind has no handler");
            return reply(&unavailable(
                &rewind.operation_id,
                &rewind.conversation_id,
                decided,
            ));
        }
        let checkpoint = rewind
            .checkpoint_id
            .as_deref()
            .context("Missing checkpoint_id")?;
        let expected = rewind
            .expected_state
            .as_deref()
            .context("Missing expected_state")?;
        self.ensure_workspace_bound(&conversation.workspace_id)?;
        let inner = format!("{}:files", rewind.operation_id);
        let control = ConversationControl::RewindFiles;
        let admitted = self.admit_control(
            &rewind.operation_id,
            &rewind.conversation_id,
            control,
            request,
            // The checkpoint receipt, not a run, reconciles file rewind.
            Some(&inner),
            |d| {
                let live = live(d, &rewind.conversation_id)?;
                let decided = availability::decide(&live.facts(), control);
                if !decided.available {
                    return Ok(Err(unavailable(
                        &rewind.operation_id,
                        &rewind.conversation_id,
                        decided,
                    )));
                }
                Ok(Ok(json!({"run": inner})))
            },
        )?;
        if let Admitted::Reply(done) = admitted {
            return reply(&done);
        }
        let restored = self
            .checkpoint_command(&json!({
                "op": "checkpoint.restore",
                "operation_id": inner,
                "workspace_id": conversation.workspace_id,
                "checkpoint_id": checkpoint,
                "expected_state": expected,
                "confirm_overwrite": rewind.confirm_overwrite,
            }))
            .map_err(not_confirmed)?;
        let restored: CheckpointRestored = serde_json::from_value(restored)?;
        self.settle_control(&ConversationControlReply {
            reason: (!restored.problems.is_empty()).then(|| restored.problems.join("; ")),
            files: Some(restored.clone()),
            ..control_reply(
                &rewind.operation_id,
                &rewind.conversation_id,
                control,
                restore_outcome(restored.outcome),
            )
        })
    }

    /// Wakes due snoozes now and then about once a second, so a snooze that
    /// fell due while ADE was closed wakes on the next start.
    pub(super) fn start_snooze_wake(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                let wait = {
                    let mut d = hub.data.lock().unwrap();
                    let now = now_ms();
                    match d.store.wake_due_snoozes(now) {
                        Ok(0) => {}
                        Ok(_) => {
                            if let Err(error) = hub.flush_activity(&mut d) {
                                eprintln!("Activity feed: {error}");
                            }
                        }
                        Err(error) => eprintln!("Snooze wake: {error}"),
                    }
                    d.store.snooze_wait_ms(now).unwrap_or(1_000)
                };
                drop(hub);
                std::thread::sleep(std::time::Duration::from_millis(wait.max(50) as u64));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(status: Status, result: Option<Value>) -> Receipt {
        Receipt { status, result }
    }

    #[test]
    fn a_dispatched_control_is_asked_again_only_on_the_same_run() {
        let dispatched = receipt(Status::Dispatched, Some(json!({"run": "run_1"})));
        assert_eq!(replay(&dispatched, Some("run_1")), Replay::Ask);
        assert_eq!(replay(&dispatched, Some("run_2")), Replay::Unknown);
        assert_eq!(replay(&dispatched, None), Replay::Unknown);
        let unrecorded = receipt(Status::Dispatched, Some(json!({"run": null})));
        assert_eq!(replay(&unrecorded, None), Replay::Unknown);
        assert_eq!(
            replay(&receipt(Status::Accepted, None), Some("run_1")),
            Replay::Unknown
        );
    }

    #[test]
    fn settled_controls_return_their_stored_reply_and_unknown_stays_unknown() {
        let stored = json!({"type": "conversation_control", "outcome": "acknowledged"});
        assert_eq!(
            replay(
                &receipt(Status::Settled, Some(stored.clone())),
                Some("run_2")
            ),
            Replay::Stored(stored)
        );
        assert_eq!(
            replay(
                &receipt(Status::Settled, Some(json!({"run": "run_1"}))),
                Some("run_1")
            ),
            Replay::Unknown
        );
        assert_eq!(
            replay(
                &receipt(Status::Unknown, Some(json!({"run": "run_1"}))),
                Some("run_1")
            ),
            Replay::Unknown
        );
    }

    #[test]
    fn restore_outcomes_map_without_claiming_more() {
        assert_eq!(
            restore_outcome(CheckpointRestoreOutcome::Partial),
            ControlOutcome::Partial
        );
        assert_eq!(
            restore_outcome(CheckpointRestoreOutcome::Unchanged),
            ControlOutcome::Unchanged
        );
        assert_eq!(
            restore_outcome(CheckpointRestoreOutcome::Restored),
            ControlOutcome::Restored
        );
    }
}
