use super::*;

pub use ade_core::contract::conversations::SendIntent;

pub(super) fn send_intent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendIntent> {
    Ok(SendIntent {
        request_id: row.get(0)?,
        conversation_id: row.get(1)?,
        window_id: row.get(2)?,
        draft_revision: row.get(3)?,
        draft_text: row.get(4)?,
        text: row.get(5)?,
        attachments: attachment_row(row, 6)?,
        state: row.get(7)?,
    })
}

pub(super) fn draft_from(db: &Connection, conversation: &str, window: &str) -> Result<Draft> {
    live_conversation(db, conversation)?;
    check_id(window)?;
    let mut draft: Draft = db.query_row("SELECT text,revision,attachments FROM drafts WHERE conversation_id=?1 AND window_id=?2",
        params![conversation,window], |row| Ok(Draft { text: row.get(0)?, revision: row.get(1)?,
            attachments: attachment_row(row, 2)?, context_nodes: Vec::new() })).optional()?.unwrap_or_default();
    if draft.revision > 0 {
        draft.context_nodes =
            super::drafts::draft_context(db, conversation, window, draft.revision)?;
    }
    Ok(draft)
}

impl Store {
    pub fn send_intent(&self, conversation: &str, window: &str) -> Result<Option<SendIntent>> {
        self.conversation(conversation)?;
        check_id(window)?;
        self.connection.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state FROM send_intents WHERE conversation_id=?1 AND window_id=?2 AND state IN ('pending','rejected')",
            params![conversation, window],
            send_intent_row,
        ).optional().map_err(Into::into)
    }
    /// A request ID prepared by a draft owner cannot be repurposed by another
    /// caller, even if the owner later aborts that send.
    pub fn guard_send_intent(
        &self,
        conversation: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<()> {
        let intent: Option<SendIntent> = self.connection.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?;
        if let Some(intent) = intent {
            self.ensure_send_intent_unheld(request_id)?;
            ensure!(
                intent.conversation_id == conversation
                    && intent.text == text
                    && intent.attachments == attachments,
                "Send intent ID was already used for a different prompt or conversation"
            );
            ensure!(intent.state != "aborted", "Send intent was aborted");
            ensure!(
                intent.state != "rejected",
                "Send intent was rejected before admission; abort it before preparing another prompt"
            );
            if intent.state == "completed" {
                ensure!(
                    message_by_id(&self.connection, request_id)?.is_some(),
                    "Completed send intent has no accepted message"
                );
            }
        }
        Ok(())
    }
    fn ensure_send_intent_unheld(&self, request_id: &str) -> Result<()> {
        let held: Option<i64> = self
            .connection
            .query_row(
                "SELECT restore_hold FROM send_intents WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .optional()?;
        if held == Some(1) {
            return Err(ade_core::error::RestoredSendHeld.into());
        }
        Ok(())
    }
    /// Persist the exact payload and request ID before the caller dispatches it.
    pub fn prepare_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
        draft: &Draft,
        text: &str,
    ) -> Result<SendIntent> {
        check_id(request_id)?;
        check_id(window)?;
        check_text(&draft.text)?;
        check_text(text)?;
        ensure!(
            !text.trim().is_empty() || !draft.attachments.is_empty(),
            "Prompt is empty"
        );
        validate_attachments(&self.connection, conversation, &draft.attachments)?;
        let tx = self.transaction()?;
        if let Some(existing) = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()? {
            ensure!(existing.conversation_id == conversation && existing.window_id == window
                && existing.draft_revision == draft.revision && existing.draft_text == draft.text
                && existing.text == text
                && existing.attachments == draft.attachments,
                "Send intent ID was already used for a different prompt or owner");
            return Ok(existing);
        }
        ensure!(
            message_by_id(&tx, request_id)?.is_none(),
            "Send intent ID was already accepted as a message"
        );
        let saved = draft_from(&tx, conversation, window)?;
        ensure!(
            saved.text == draft.text
                && saved.revision == draft.revision
                && saved.attachments == draft.attachments
                && saved.revision > 0,
            "Draft changed before prompt admission"
        );
        ensure!(tx.query_row(
            "SELECT 1 FROM send_intents WHERE conversation_id=?1 AND window_id=?2 AND state IN ('pending','rejected')",
            params![conversation,window], |_| Ok(()),
        ).optional()?.is_none(), "Resolve the pending send before preparing another prompt");
        tx.execute("INSERT INTO send_intents(request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending')",
            params![request_id,conversation,window,draft.revision,draft.text,text,encode(&draft.attachments)?])?;
        tx.commit()?;
        Ok(SendIntent {
            request_id: request_id.into(),
            conversation_id: conversation.into(),
            window_id: window.into(),
            draft_revision: draft.revision,
            draft_text: draft.text.clone(),
            text: text.into(),
            attachments: draft.attachments.clone(),
            state: "pending".into(),
        })
    }
    /// An acknowledged user message and draft clear settle together. A missing
    /// message leaves the intent pending, even if the caller received no reply.
    pub fn complete_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
    ) -> Result<Draft> {
        check_id(request_id)?;
        check_id(window)?;
        self.ensure_send_intent_unheld(request_id)?;
        let tx = self.transaction()?;
        let intent: SendIntent = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?.context("Unknown send intent")?;
        ensure!(
            intent.conversation_id == conversation && intent.window_id == window,
            "Send intent ID belongs to another owner"
        );
        if intent.state == "completed" {
            return Ok(Draft {
                context_nodes: Vec::new(),
                text: String::new(),
                revision: intent
                    .draft_revision
                    .checked_add(1)
                    .context("Draft revision exhausted")?,
                attachments: vec![],
            });
        }
        let message = message_by_id(&tx, request_id)?
            .context("Prompt has not been accepted; retry delivery")?;
        ensure!(
            message.conversation_id == conversation
                && message.role == "user"
                && message.text == intent.text
                && message.attachments == intent.attachments,
            "Accepted prompt conflicts with send intent"
        );
        let saved = draft_from(&tx, conversation, window)?;
        ensure!(
            saved.revision == intent.draft_revision
                && saved.text == intent.draft_text
                && saved.attachments == intent.attachments,
            "Draft changed while send was pending; resolve the conflict"
        );
        let next = saved
            .revision
            .checked_add(1)
            .context("Draft revision exhausted")?;
        tx.execute("UPDATE drafts SET revision=?3,text='',attachments='[]' WHERE conversation_id=?1 AND window_id=?2",
            params![conversation,window,next])?;
        // The sent draft stays recallable; it settles with the clear.
        super::drafts::record_history(
            &tx,
            conversation,
            window,
            ade_core::contract::conversations::DraftHistoryKind::Sent,
            &saved,
            &format!("send:{request_id}"),
        )?;
        tx.execute(
            "UPDATE send_intents SET state='completed' WHERE request_id=?1",
            [request_id],
        )?;
        tx.commit()?;
        Ok(Draft {
            context_nodes: Vec::new(),
            text: String::new(),
            revision: next,
            attachments: vec![],
        })
    }
    /// Only the daemon's own rejected pre-admission send can unlock this intent.
    pub fn reject_send_intent(
        &self,
        conversation: &str,
        request_id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<()> {
        let tx = self.transaction()?;
        if message_by_id(&tx, request_id)?.is_none() {
            let encoded = encode(&attachments)?;
            tx.execute("UPDATE send_intents SET state='rejected' WHERE request_id=?1 AND conversation_id=?2 AND text=?3 AND attachments=?4 AND state='pending' AND restore_hold=0",
                params![request_id,conversation,text,encoded])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn abort_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
    ) -> Result<Draft> {
        check_id(request_id)?;
        self.ensure_send_intent_unheld(request_id)?;
        let tx = self.transaction()?;
        let intent: SendIntent = tx.query_row(
            "SELECT request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state FROM send_intents WHERE request_id=?1",
            [request_id], send_intent_row,
        ).optional()?.context("Unknown send intent")?;
        ensure!(
            intent.conversation_id == conversation && intent.window_id == window,
            "Send intent ID belongs to another owner"
        );
        ensure!(
            intent.state == "rejected" || intent.state == "aborted",
            "Send outcome is not a confirmed pre-admission rejection"
        );
        ensure!(
            message_by_id(&tx, request_id)?.is_none(),
            "Prompt was accepted; reconcile the send"
        );
        if intent.state == "rejected" {
            tx.execute(
                "UPDATE send_intents SET state='aborted' WHERE request_id=?1",
                [request_id],
            )?;
        }
        let draft = draft_from(&tx, conversation, window)?;
        tx.commit()?;
        Ok(draft)
    }
    pub fn draft(&self, conversation: &str, window: &str) -> Result<Draft> {
        draft_from(&self.connection, conversation, window)
    }
    /// Called under the Sessions store lock, including the revision comparison.
    pub fn resolve_draft(
        &self,
        conversation: &str,
        window: &str,
        draft: &Draft,
        expected: i64,
    ) -> Result<Draft> {
        let saved = self.draft(conversation, window)?;
        if saved.revision != expected {
            return Ok(saved);
        }
        self.save_draft(conversation, window, draft)
    }
    pub fn save_draft(&self, conversation: &str, window: &str, draft: &Draft) -> Result<Draft> {
        self.conversation(conversation)?;
        check_id(window)?;
        check_text(&draft.text)?;
        validate_attachments(&self.connection, conversation, &draft.attachments)?;
        super::drafts::check_context_nodes(&draft.context_nodes)?;
        ensure!(draft.revision > 0, "Invalid draft revision");
        ensure!(
            self.send_intent(conversation, window)?.is_none(),
            "Resolve the pending send before editing this draft"
        );
        // Each window owns a separate draft. Older asynchronous writes cannot
        // overwrite newer text, including a clear after successful submission.
        let tx = self.transaction()?;
        let previous = draft_from(&tx, conversation, window)?;
        let written = tx.execute("INSERT INTO drafts(conversation_id,window_id,revision,text,attachments) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(conversation_id,window_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachments=excluded.attachments WHERE excluded.revision>drafts.revision",params![conversation,window,draft.revision,draft.text,encode(&draft.attachments)?])?;
        if written == 1 {
            super::drafts::write_draft_context(
                &tx,
                conversation,
                window,
                draft.revision,
                &draft.context_nodes,
            )?;
        }
        // A save that clears a non-empty draft keeps it recallable.
        if written == 1 && super::drafts::discarded_by(&previous, draft) {
            super::drafts::record_history(
                &tx,
                conversation,
                window,
                ade_core::contract::conversations::DraftHistoryKind::Discarded,
                &previous,
                &format!("draft:{}", previous.revision),
            )?;
        }
        let saved = draft_from(&tx, conversation, window)?;
        tx.commit()?;
        Ok(saved)
    }
}
