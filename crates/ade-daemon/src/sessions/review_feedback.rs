//! `review.feedback.send`: the daemon builds the review prompt a client used
//! to build itself (`ade_core::review_prompt`), checks every anchor against
//! the workspace's current status and diff, and queues the prompt on the
//! Conversation with its feedback, so the delivered message keeps it. The
//! queued prompt's ID is the operation ID; the receipt records the reply.
use super::*;
use crate::receipts::{self, Admission, Status};
use ade_core::contract::review::{
    ReviewAnchor, ReviewFeedback, ReviewFeedbackQueued, ReviewFeedbackSendRequest,
};

const OP: &str = "review.feedback.send";
/// The most anchors one prompt carries, as in `ade-review-feedback-v1`.
const MAX_ANCHORS: usize = 16;
/// One anchor keeps the desktop's 64 KiB note; a batch 4 KiB per note.
const MAX_NOTE: usize = 64 * 1024;
const MAX_BATCH_NOTE: usize = 4096;
/// The longest prompt the queue holds (`Store::enqueue_content`).
const MAX_PROMPT: usize = 64 * 1024;

fn note_fits(note: &str, limit: usize) -> Result<()> {
    ensure!(
        !note.trim().is_empty() && note.len() <= limit,
        "A review note must be 1 to {limit} bytes"
    );
    Ok(())
}

/// The anchors, the feedback the message keeps and the prompt, from either
/// request shape. Checks shape and bounds only; freshness comes later.
fn prepared(
    send: &ReviewFeedbackSendRequest,
    workspace_id: &str,
) -> Result<(Vec<ReviewAnchor>, ReviewFeedback, String)> {
    let (anchors, feedback, text) = match (&send.feedback, send.anchors.is_empty(), &send.note) {
        (Some(feedback), true, None) => {
            ensure!(
                (1..=MAX_ANCHORS).contains(&feedback.notes.len()),
                "Review feedback needs 1 to {MAX_ANCHORS} notes"
            );
            ensure!(
                feedback.workspace_id == workspace_id,
                "Review feedback targets a different workspace"
            );
            for note in &feedback.notes {
                note_fits(&note.note, MAX_BATCH_NOTE)?;
            }
            (
                feedback
                    .notes
                    .iter()
                    .map(|note| note.anchor.clone())
                    .collect(),
                feedback.clone(),
                ade_core::review_prompt::from_feedback(feedback),
            )
        }
        (None, false, Some(note)) => {
            ensure!(
                send.anchors.len() <= MAX_ANCHORS,
                "Review feedback needs 1 to {MAX_ANCHORS} anchors"
            );
            let limit = if send.anchors.len() == 1 {
                MAX_NOTE
            } else {
                MAX_BATCH_NOTE
            };
            note_fits(note, limit)?;
            (
                send.anchors.clone(),
                ade_core::review_prompt::feedback(workspace_id, &send.anchors, note),
                ade_core::review_prompt::from_anchors(workspace_id, &send.anchors, note),
            )
        }
        _ => bail!("Send anchors with one note, or feedback with a note per anchor"),
    };
    ensure!(
        anchors
            .iter()
            .all(|anchor| anchor.workspace_id == workspace_id),
        "Review feedback targets a different workspace"
    );
    for anchor in &anchors {
        ensure!(
            anchor.hunk.starts_with("@@ ") && anchor.hunk.len() <= 512,
            "Invalid review hunk"
        );
        ensure!(anchor.line > 0, "Invalid review line");
        ensure!(anchor.text.len() <= 8192, "Invalid review line text");
    }
    Ok((anchors, feedback, text))
}

impl Sessions {
    pub(super) fn review_feedback_send(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let send: ReviewFeedbackSendRequest = decode(request)?;
        let id = non_empty("operation_id", &send.operation_id)?;
        ensure!(
            id.len() <= crate::envelope::MAX_ID_BYTES,
            "Invalid operation_id: use 1 to 256 bytes of text"
        );
        let payload = crate::envelope::payload(request);
        if let Some(known) = self.recorded_feedback(id, &payload)? {
            return Ok(known);
        }
        let conversation = non_empty("conversation_id", &send.conversation_id)?;
        let (binding, common_binding, queued, workspace) = {
            let d = self.data.lock().unwrap();
            let current = d.store.conversation(conversation)?;
            Self::ensure_not_imported(&current)?;
            d.store.ensure_workspace_bound(&current.workspace_id)?;
            let workspace = d.store.workspace(&current.workspace_id)?;
            let common_binding = workspace
                .repository_id
                .as_deref()
                .map(|repository| d.store.repository_binding_identity(repository))
                .transpose()?;
            (
                d.store.workspace_binding_identity(&workspace.id)?,
                common_binding,
                d.store.queue_entry(id)?.is_some(),
                workspace,
            )
        };
        let (anchors, feedback, text) = prepared(&send, &workspace.id)?;
        // The queue holds prompts up to 64 KiB; say so in review terms.
        ensure!(
            text.len() <= MAX_PROMPT,
            ade_core::error::ReviewPromptTooLong(text.len())
        );
        // A prompt already queued under this ID was checked when it was; a
        // retry after a lost receipt only records it.
        if !queued {
            if let Some(window) = &send.window_id {
                let draft = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .draft(conversation, non_empty("window_id", window)?)?;
                ensure!(
                    draft.text.is_empty() && draft.attachments.is_empty(),
                    ade_core::error::DraftNotEmpty
                );
            }
            let anchors: Vec<Value> = anchors
                .iter()
                .map(serde_json::to_value)
                .collect::<serde_json::Result<_>>()?;
            let anchors: Vec<&Value> = anchors.iter().collect();
            self.review.validate_anchors_then(
                &workspace.root,
                binding,
                common_binding,
                &anchors,
                || Ok(()),
            )?;
        }
        let feedback = serde_json::to_value(&feedback)?;
        self.queue_change(conversation, |d, c| {
            d.store.enqueue_content(&c.id, id, &text, &[])?;
            d.store.set_queued_review_feedback(id, &feedback)?;
            Ok(())
        })?;
        let reply = reply(&ReviewFeedbackQueued {
            tag: Default::default(),
            conversation_id: conversation.to_owned(),
            queued_prompt_id: id.to_owned(),
            text,
        })?;
        let d = self.data.lock().unwrap();
        let tx = crate::store::begin_write(&d.store.connection)?;
        let now = now_ms();
        if receipts::begin(&tx, id, OP, &payload, None, now)? == Admission::New {
            receipts::settle(
                &tx,
                id,
                Status::Settled,
                Some(&json!({"reply": reply})),
                now,
            )?;
            tx.commit()?;
        }
        Ok(reply)
    }

    /// The reply recorded for `id`, or the refusal for a reused ID; `None`
    /// for an ID not seen before. Records nothing.
    fn recorded_feedback(&self, id: &str, payload: &Value) -> Result<Option<Value>> {
        let d = self.data.lock().unwrap();
        let tx = crate::store::begin_write(&d.store.connection)?;
        Ok(
            match receipts::begin(&tx, id, OP, payload, None, now_ms())? {
                Admission::New => None,
                Admission::Replay(receipt) => Some(
                    receipts::recorded_reply(&receipt)
                        .context("The review feedback's recorded reply is missing")?,
                ),
                Admission::Conflict => Some(crate::envelope::error(
                    "conflict",
                    &format!("Operation ID {id} was already used for a different request"),
                )),
                Admission::Expired => Some(crate::envelope::error(
                    "expired",
                    &format!(
                        "Operation ID {id} is past its 30-day receipt retention; use a new operation ID"
                    ),
                )),
            },
        )
    }
}
