//! Conversation controls: steering (F035), rewind (F039), compaction (F040)
//! and snoozing (F046).
//!
//! Steer, compact and rewind are effect commands. Each records its receipt in
//! the profile database, in the same transaction that checks the Conversation
//! may take it, before anything reaches the provider or the workspace; a
//! refusal rolls the receipt back. The runtime keys each native call by the
//! operation ID, so a retry after a lost reply asks the same run for its
//! stored answer instead of calling the provider again. A retry that finds a
//! different run can prove nothing and settles as unknown. A refusal the
//! provider itself sent settles as refused; any other failure stays
//! unconfirmed.
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
    ConversationRewindHistory, ConversationRewindPreview, ConversationRewindPreviewRequest,
    ConversationRewindRequest, ConversationSnoozeList, ConversationSnoozeListRequest,
    ConversationSnoozeReply, ConversationSnoozeRequest, ConversationSteerRequest,
    ConversationUnsnoozeRequest, RewindScope,
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
        history: None,
    }
}

/// Names the history a Conversation rewind would remove: every removed
/// message's identity, sequence, status and text, under the history epoch.
/// A turn that grew, a new message or another rewind changes the name.
fn history_state_token(conversation_id: &str, epoch: u64, removed: &[Message]) -> String {
    use sha2::{Digest, Sha256};
    let items: Vec<Value> = removed
        .iter()
        .map(|message| {
            json!([
                message.id,
                message.sequence,
                message.status,
                format!("{:x}", Sha256::digest(message.text.as_bytes())),
                message.native_message,
            ])
        })
        .collect();
    let canonical = receipts::canonical_json(
        &json!({"conversation": conversation_id, "epoch": epoch, "removed": items}),
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

/// What removing `removed` from a history of `total` messages means.
fn history_summary(
    conversation_id: &str,
    epoch: u64,
    first: &Message,
    turn: &str,
    removed: &[Message],
    total: u64,
) -> ConversationRewindHistory {
    // A provider with no turn IDs starts a turn at each prompt.
    let turns: std::collections::BTreeSet<&str> = removed
        .iter()
        .filter_map(
            |message| match (&message.turn_id, &message.native_message) {
                (Some(turn), _) => Some(turn.as_str()),
                (None, Some(native)) if message.role == "user" => Some(native.message_id.as_str()),
                _ => None,
            },
        )
        .collect();
    ConversationRewindHistory {
        before_message_id: first.id.clone(),
        turn_id: turn.to_owned(),
        native_message: first.native_message.clone(),
        removed_messages: removed.len() as u64,
        removed_turns: turns.len() as u64,
        kept_messages: total.saturating_sub(removed.len() as u64),
        state_token: history_state_token(conversation_id, epoch, removed),
        history_epoch: epoch,
        native_session: None,
        previous_native_session: None,
    }
}

/// The preview of removing `before` and every later message, and the
/// sequence removal starts at. `before` must be the user message that
/// started its turn, so the provider can return to the turn before it.
fn history_preview(
    d: &Data,
    conversation_id: &str,
    before: &str,
) -> Result<(ConversationRewindHistory, i64)> {
    let first = d
        .store
        .message(before)?
        .filter(|message| message.conversation_id == conversation_id)
        .with_context(|| format!("Message {before} is not in this Conversation"))?;
    ensure!(
        first.role == "user",
        "Choose the user message that started a turn"
    );
    let all = d.store.messages_from(conversation_id, 0)?;
    // The boundary is the provider's turn. A provider that reports no turn IDs
    // (Claude) is rewound at the prompt's own native message, which only a
    // prompt carries; each prompt starts its own turn there.
    let turn = match (&first.turn_id, &first.native_message) {
        (Some(turn), _) => {
            ensure!(
                !all.iter().any(|message| message.sequence < first.sequence
                    && message.turn_id.as_deref() == Some(turn.as_str())),
                "Choose the user message that started a turn"
            );
            turn.clone()
        }
        (None, Some(native)) => native.message_id.clone(),
        (None, None) => bail!("Choose the user message that started a turn"),
    };
    let removed: Vec<Message> = all
        .iter()
        .filter(|message| message.sequence >= first.sequence)
        .cloned()
        .collect();
    let epoch = d.store.history_epoch(conversation_id)?;
    Ok((
        history_summary(
            conversation_id,
            epoch,
            &first,
            &turn,
            &removed,
            all.len() as u64,
        ),
        first.sequence,
    ))
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

/// The provider's refusal when `error` proves a control took no effect.
///
/// Only a runtime error receipt (`Rejected`) whose typed cause is a reply
/// the provider itself sent is proof. A transport failure, a lost reply or a
/// receipt with no typed cause cannot show the provider never acted, so it
/// stays uncertain.
fn definite_refusal(error: &anyhow::Error) -> Option<String> {
    use ade_core::error::Failure;
    error.downcast_ref::<crate::runtime::Rejected>()?;
    match error.downcast_ref::<Failure>()? {
        failure @ (Failure::Rejected
        | Failure::Authentication
        | Failure::RateLimit
        | Failure::UsageLimit
        | Failure::SessionUnavailable) => Some(failure.to_string()),
        // These also describe a closed or failed transport.
        Failure::ProcessExited
        | Failure::Disconnected
        | Failure::InvalidData
        | Failure::SaveFailed
        | Failure::OutcomeUnknown
        | Failure::ResourceLimit
        | Failure::Unavailable => None,
    }
}

fn refused(
    operation_id: &str,
    conversation_id: &str,
    control: ConversationControl,
    reason: String,
) -> ConversationControlReply {
    ConversationControlReply {
        reason: Some(reason),
        ..control_reply(
            operation_id,
            conversation_id,
            control,
            ControlOutcome::Refused,
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
    /// The operations the provider's worker declares, or why none are known.
    declared: Result<Vec<ade_core::contract::providers::ProviderWorkerOperation>, String>,
}

impl Live {
    fn facts(&self) -> Facts<'_> {
        let c = &self.conversation;
        Facts {
            status: &c.status,
            active_turn: c.active_turn_id.as_deref(),
            connected: self.rpc.is_some(),
            declared: self.declared.as_deref().map_err(String::as_str),
        }
    }
}

impl Sessions {
    fn live(&self, d: &Data, id: &str) -> Result<Live> {
        let conversation = d.store.conversation(id)?;
        // An Agent whose stop is in flight takes no controls.
        let agent = d.agents.get(id).filter(|agent| !agent.stopping);
        Ok(Live {
            declared: self.declared_operations(d, &conversation.provider),
            conversation,
            run: agent.map(|a| a.run_id.clone()),
            rpc: agent.and_then(|a| a.rpc.clone()),
        })
    }
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
        // A provider plugin's controls come from its worker's declaration; make sure the
        // current artifact has handshaken (cached per artifact, outside the session lock).
        self.discover_plugin_providers();
        match request["op"].as_str().unwrap_or("") {
            "conversation.controls" => {
                let query: ConversationControlsRequest = decode(request)?;
                let d = self.data.lock().unwrap();
                let live = self.live(&d, non_empty("conversation_id", &query.conversation_id)?)?;
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
            let live = self.live(&d, &steer.conversation_id)?;
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
                let live = self.live(d, &steer.conversation_id)?;
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
            let live = self.live(&d, &steer.conversation_id)?;
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
        let turn = match rpc.steer(&thread, &steer.turn_id, &steer.operation_id, &prompt) {
            Ok(turn) => turn,
            Err(error) => {
                let Some(reason) = definite_refusal(&error) else {
                    return Err(not_confirmed(error));
                };
                return self.settle_control(&refused(
                    &steer.operation_id,
                    &steer.conversation_id,
                    control,
                    reason,
                ));
            }
        };
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
            let live = self.live(&d, &compact.conversation_id)?;
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
                let live = self.live(d, &compact.conversation_id)?;
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
            let live = self.live(&d, &compact.conversation_id)?;
            (
                live.rpc.context("The Agent is no longer connected")?,
                live.conversation
                    .provider_thread_id
                    .context("The provider session is unknown")?,
            )
        };
        if let Err(error) = rpc.compact(&thread, &compact.operation_id) {
            let Some(reason) = definite_refusal(&error) else {
                return Err(not_confirmed(error));
            };
            return self.settle_control(&refused(
                &compact.operation_id,
                &compact.conversation_id,
                control,
                reason,
            ));
        }
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
        let live = self.live(&d, conversation_id)?;
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
        let history = match (preview.scope, decided.available) {
            (RewindScope::Conversation, true) => {
                let before = preview
                    .before_message_id
                    .as_deref()
                    .context("Missing before_message_id")?;
                let d = self.data.lock().unwrap();
                Some(history_preview(&d, &preview.conversation_id, before)?.0)
            }
            _ => None,
        };
        reply(&ConversationRewindPreview {
            tag: Default::default(),
            conversation_id: preview.conversation_id,
            scope: preview.scope,
            availability: decided,
            files,
            history,
        })
    }

    fn rewind(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let rewind: ConversationRewindRequest = decode(request)?;
        check_operation_id(&rewind.operation_id)?;
        let (conversation, decided) =
            self.rewind_availability(&rewind.conversation_id, rewind.scope)?;
        if rewind.scope == RewindScope::Conversation {
            if !decided.available {
                // Nothing is attempted, so no receipt is recorded.
                return reply(&unavailable(
                    &rewind.operation_id,
                    &rewind.conversation_id,
                    decided,
                ));
            }
            return self.rewind_conversation(request, &rewind, &conversation);
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
                let live = self.live(d, &rewind.conversation_id)?;
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
        // E2E crash point: the restore's receipt has settled, this one has not.
        receipts::e2e_pause("conversation.rewind.files.settled");
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

    /// Conversation rewind (F039). The receipt is dispatched, under the run,
    /// before the provider is asked; the provider's acknowledgement, the
    /// removal of ADE's messages from the rewound turn on, the new history
    /// epoch and the settled receipt then commit together. A retry on the same
    /// run asks the runtime, which answers from its own receipt; a retry on
    /// another run cannot prove what the provider did and settles as unknown.
    fn rewind_conversation(
        self: &Arc<Self>,
        request: &Value,
        rewind: &ConversationRewindRequest,
        conversation: &Conversation,
    ) -> Result<Value> {
        let before = rewind
            .before_message_id
            .as_deref()
            .context("Missing before_message_id")?;
        let expected = rewind
            .expected_state
            .as_deref()
            .context("Missing expected_state")?;
        self.ensure_workspace_bound(&conversation.workspace_id)?;
        let control = ConversationControl::RewindConversation;
        let current = {
            let d = self.data.lock().unwrap();
            self.live(&d, &rewind.conversation_id)?
        };
        let admitted = self.admit_control(
            &rewind.operation_id,
            &rewind.conversation_id,
            control,
            request,
            current.run.as_deref(),
            |d| {
                let live = self.live(d, &rewind.conversation_id)?;
                let decided = availability::decide(&live.facts(), control);
                if !decided.available {
                    return Ok(Err(unavailable(
                        &rewind.operation_id,
                        &rewind.conversation_id,
                        decided,
                    )));
                }
                let (preview, _) = history_preview(d, &rewind.conversation_id, before)?;
                ensure!(
                    preview.state_token == expected,
                    "The Conversation history changed since the preview; preview the rewind again"
                );
                Ok(Ok(json!({"run": live.run, "turn": preview.turn_id})))
            },
        )?;
        if let Admitted::Reply(done) = admitted {
            return reply(&done);
        }
        let (rpc, thread, turn, native_message) = {
            let d = self.data.lock().unwrap();
            let live = self.live(&d, &rewind.conversation_id)?;
            let (preview, _) = history_preview(&d, &rewind.conversation_id, before)?;
            let thread = live
                .conversation
                .provider_thread_id
                .context("The provider session is unknown")?;
            // ADE keeps the prompt's first locator; a forked session holds it
            // under the same ID through its aliases, so address the current one.
            let native_message = preview.native_message.map(|mut native| {
                native.session = thread.clone();
                native
            });
            (
                live.rpc.context("The Agent is no longer connected")?,
                thread,
                preview.turn_id,
                native_message,
            )
        };
        let forked = match rpc.rewind(
            &thread,
            &turn,
            &rewind.operation_id,
            native_message.as_ref(),
        ) {
            Ok(forked) => forked.filter(|forked| *forked != thread),
            Err(error) => {
                let Some(reason) = definite_refusal(&error) else {
                    return Err(not_confirmed(error));
                };
                return self.settle_control(&refused(
                    &rewind.operation_id,
                    &rewind.conversation_id,
                    control,
                    reason,
                ));
            }
        };
        let mut d = self.data.lock().unwrap();
        let (preview, sequence) = history_preview(&d, &rewind.conversation_id, before)?;
        let mut done = control_reply(
            &rewind.operation_id,
            &rewind.conversation_id,
            control,
            ControlOutcome::Acknowledged,
        );
        let mut settled = None;
        // A forking rewind moves the Conversation to the fork in the same
        // transaction that removes the messages and settles the receipt.
        let moved = forked.as_deref().map(|forked| (thread.as_str(), forked));
        d.store.rewind_history(
            &rewind.conversation_id,
            sequence,
            moved,
            |tx, removed, epoch| {
                done.history = Some(ConversationRewindHistory {
                    removed_messages: removed,
                    history_epoch: epoch,
                    native_session: forked.clone(),
                    previous_native_session: forked.as_ref().map(|_| thread.clone()),
                    ..preview.clone()
                });
                let value = serde_json::to_value(&done)?;
                receipts::settle(
                    tx,
                    &rewind.operation_id,
                    Status::Settled,
                    Some(&value),
                    now_ms(),
                )?;
                settled = Some(value);
                Ok(())
            },
        )?;
        let mut reloaded = d.store.conversation(&rewind.conversation_id)?;
        reloaded.updated_at = now_ms();
        d.store.commit_conversation(&reloaded, &[], &[])?;
        let reloaded = self.presented(&d, &reloaded)?;
        self.publish(
            &mut d,
            json!({"type":"conversation_reload","conversation":reloaded}),
        );
        settled.context("Rewind settled without a reply")
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

    /// The runtime's error receipt, as `Supervisor::agent` returns it.
    fn receipt_error(failure: ade_core::error::Failure) -> anyhow::Error {
        anyhow::Error::new(failure).context(crate::runtime::Rejected(failure.to_string()))
    }

    #[test]
    fn a_provider_refusal_settles_as_refused_and_a_retry_reads_it() {
        use ade_core::error::Failure;
        // `turn/steer` refused because the turn ended before the call arrived.
        let reason = definite_refusal(&receipt_error(Failure::Rejected))
            .expect("a provider refusal is proof");
        let reply = refused("op_1", "conversation_1", ConversationControl::Steer, reason);
        assert_eq!(reply.outcome, ControlOutcome::Refused);
        // The settled receipt answers the retry instead of asking the run again.
        let stored = serde_json::to_value(&reply).unwrap();
        assert_eq!(
            replay(
                &receipt(Status::Settled, Some(stored.clone())),
                Some("run_1")
            ),
            Replay::Stored(stored)
        );
        for failure in [
            Failure::Authentication,
            Failure::RateLimit,
            Failure::UsageLimit,
            Failure::SessionUnavailable,
        ] {
            assert!(definite_refusal(&receipt_error(failure)).is_some());
        }
    }

    #[test]
    fn an_uncertain_control_failure_is_never_settled_as_refused() {
        use ade_core::error::Failure;
        for failure in [
            Failure::OutcomeUnknown,
            Failure::Disconnected,
            Failure::ProcessExited,
            Failure::InvalidData,
            Failure::Unavailable,
            Failure::SaveFailed,
        ] {
            assert_eq!(definite_refusal(&receipt_error(failure)), None);
        }
        // An error that never came from a runtime receipt.
        assert_eq!(
            definite_refusal(&anyhow::Error::new(Failure::Rejected)),
            None
        );
        // An error receipt without a typed cause proves nothing.
        assert_eq!(
            definite_refusal(&crate::runtime::Rejected("Missing steered turn".into()).into()),
            None
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
