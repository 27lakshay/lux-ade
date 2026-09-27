//! Conversation deletion (`conversation.delete`).
//!
//! An effect command whose receipt commits in the transaction that deletes
//! the Conversation and writes its tombstone, so there is no window in which
//! the deletion happened but its receipt is missing, or the reverse. A retry
//! with the same operation ID returns the recorded reply; a refusal (a turn
//! is running, a terminal owns the Conversation) rolls the receipt back.
//!
//! The tombstone is what keeps a deleted Conversation deleted: every store
//! read or write that names it is refused with `conversation_deleted`, and
//! every listing leaves it out. A late snapshot, page, search result, feed
//! position or provider event from before the deletion therefore cannot
//! bring it back (architecture section 6).
use super::*;
use crate::receipts::{self, Admission, Status};
use ade_core::contract::conversations::{
    ConversationDeleteRequest, ConversationDeleted, ConversationDeletedTag,
};
use ade_core::model::now_ms;
use rusqlite::{Transaction, TransactionBehavior};

const OP: &str = "conversation.delete";
const OPERATION_ID_LIMIT: usize = 500;

impl Sessions {
    pub(super) fn delete_conversation(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let delete: ConversationDeleteRequest = decode(request)?;
        let operation_id = delete.operation_id.as_str();
        ensure!(
            !operation_id.is_empty() && operation_id.len() <= OPERATION_ID_LIMIT,
            "Missing or invalid operation_id"
        );
        let id = non_empty("conversation_id", &delete.conversation_id)?;
        self.stop_idle_agent(operation_id, id)?;
        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        receipts::ensure(&d.store.connection)?;
        let tx = Transaction::new_unchecked(&d.store.connection, TransactionBehavior::Immediate)?;
        let now = now_ms();
        match receipts::begin(&tx, operation_id, OP, request, None, now)? {
            Admission::New => {}
            Admission::Replay(receipt) => {
                return receipts::recorded_reply(&receipt).with_context(|| {
                    format!("Operation {operation_id} has no recorded deletion; inspect the Conversation list before retrying")
                });
            }
            Admission::Conflict => {
                bail!("Operation ID {operation_id} was already used for a different request")
            }
            Admission::Expired => {
                bail!(
                    "Operation ID {operation_id} is past receipt retention; it will not run again"
                )
            }
        }
        // An Agent that connected after the stop above holds a live session.
        ensure!(
            !d.agents.contains_key(id),
            "The Conversation's Agent reconnected; retry the deletion"
        );
        let deleted = crate::store::delete_conversation(&tx, id, operation_id, now)?;
        let reply = ConversationDeleted {
            tag: ConversationDeletedTag::Tag,
            operation_id: operation_id.to_owned(),
            conversation_id: id.to_owned(),
            workspace_id: deleted.conversation.workspace_id.clone(),
            deleted_at: now,
            removed: deleted.removed,
            attachments_left_for_retention: deleted.attachments_left,
        };
        let value = serde_json::to_value(&reply)?;
        receipts::settle(
            &tx,
            operation_id,
            Status::Settled,
            Some(&json!({ "reply": value })),
            now,
        )?;
        tx.commit()?;
        // Views of the Conversation drop it; the catalog no longer lists it.
        self.publish(
            &mut d,
            json!({"type": "conversation_deleted", "conversation_id": id,
                "workspace_id": reply.workspace_id, "deleted_at": now}),
        );
        self.catalog_changed(&mut d)?;
        Ok(value)
    }

    /// Stops the Conversation's Agent when it is connected but idle, before
    /// the deletion is admitted. A running turn is refused instead. Nothing
    /// is stopped for a retry of a recorded deletion.
    fn stop_idle_agent(&self, operation_id: &str, id: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        let recorded: bool = d.store.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE id=?1)",
            [operation_id],
            |row| row.get(0),
        )?;
        if recorded || !d.agents.contains_key(id) {
            return Ok(());
        }
        let conversation = d.store.conversation(id)?;
        ensure!(
            !matches!(
                conversation.status.as_str(),
                "starting" | "running" | "waiting" | "cancelling"
            ) && conversation.active_turn_id.is_none(),
            "Cancel the active turn before deleting this Conversation"
        );
        if let Some((run, rpc)) = Self::begin_stop(&mut d, id)? {
            drop(d);
            self.finish_stop(id, &run, rpc)?;
            let mut d = self.data.lock().unwrap();
            if Self::owns(&d, id, &run) {
                d.agents.remove(id);
            }
        }
        Ok(())
    }
}
