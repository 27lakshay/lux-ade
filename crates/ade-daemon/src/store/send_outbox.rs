//! The daemon side of the send outbox: list a window's unresolved sends across
//! Conversations, and settle one once its outcome was shown. Settling uses the
//! same complete and abort transitions as `draft.send.complete` and
//! `draft.send.abort`; it never dispatches a prompt.
use super::*;

use ade_core::contract::conversations::{PendingSend, SendOutcome, SendResolution};

/// The largest `draft.send.list` page.
pub const SEND_LIST_MAX: u64 = 200;
/// The page size when a caller sends none.
pub const SEND_LIST_DEFAULT: u64 = 50;

/// What the daemon's records say about a send intent. `accepted` means a user
/// message with the intent's request ID exists; `held` means a restored
/// backup set `restore_hold`. Settled intents are not listed.
pub fn classify(state: &str, accepted: bool, held: bool) -> Result<Option<SendOutcome>> {
    Ok(match state {
        "completed" | "aborted" => None,
        "pending" | "rejected" if held => Some(SendOutcome::Held),
        "pending" if accepted => Some(SendOutcome::Accepted),
        "pending" => Some(SendOutcome::Prepared),
        "rejected" if accepted => Some(SendOutcome::Conflict),
        "rejected" => Some(SendOutcome::Rejected),
        other => anyhow::bail!("Unknown send intent state {other}"),
    })
}

/// How `draft.send.acknowledge` settles an intent. A settled intent returns
/// its settlement again, so a retry after a lost reply converges. Everything
/// the daemon cannot prove is refused: a prompt that was never accepted needs
/// delivery, not acknowledgement, and a held or conflicting one needs
/// reconciliation.
pub fn acknowledgement(state: &str, accepted: bool, held: bool) -> Result<SendResolution> {
    match state {
        "completed" => return Ok(SendResolution::Completed),
        "aborted" => return Ok(SendResolution::Aborted),
        _ => {}
    }
    match classify(state, accepted, held)? {
        Some(SendOutcome::Accepted) => Ok(SendResolution::Completed),
        Some(SendOutcome::Rejected) => Ok(SendResolution::Aborted),
        Some(SendOutcome::Held) => Err(ade_core::error::RestoredSendHeld.into()),
        Some(SendOutcome::Prepared) => {
            anyhow::bail!("Prompt has not been accepted; retry delivery with the same request ID")
        }
        Some(SendOutcome::Conflict) | None => {
            anyhow::bail!("Accepted prompt conflicts with send intent")
        }
    }
}

/// Checks a page size, applying the default.
pub fn send_list_limit(limit: Option<u64>) -> Result<u64> {
    let limit = limit.unwrap_or(SEND_LIST_DEFAULT);
    ensure!(
        (1..=SEND_LIST_MAX).contains(&limit),
        "Send list limit must be 1 to {SEND_LIST_MAX}"
    );
    Ok(limit)
}

const INTENT_COLUMNS: &str = "request_id,conversation_id,window_id,draft_revision,draft_text,text,attachments,state,review_anchor,restore_hold";

impl Store {
    /// One window's unresolved sends across Conversations, ordered by
    /// Conversation ID, with the cursor for the next page. There is at most
    /// one unresolved send per Conversation and window.
    pub fn pending_sends(
        &self,
        window: &str,
        after: Option<&str>,
        limit: u64,
    ) -> Result<(Vec<PendingSend>, Option<String>)> {
        check_id(window)?;
        if let Some(after) = after {
            check_id(after)?;
        }
        // One read snapshot, so the intents and their messages agree.
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Deferred)?;
        let rows = tx
            .prepare(&format!(
                "SELECT {INTENT_COLUMNS} FROM send_intents WHERE window_id=?1 AND state IN ('pending','rejected') AND conversation_id>?2 ORDER BY conversation_id LIMIT ?3"
            ))?
            .query_map(
                params![window, after.unwrap_or(""), limit as i64 + 1],
                |row| Ok((send_intent_row(row)?, row.get::<_, i64>(9)? != 0)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() as u64 > limit;
        let mut sends = Vec::with_capacity(rows.len());
        for (intent, held) in rows.into_iter().take(limit as usize) {
            let accepted = message_by_id(&tx, &intent.request_id)?.is_some();
            let outcome = classify(&intent.state, accepted, held)?
                .context("Settled send intent was listed as unresolved")?;
            sends.push(PendingSend { intent, outcome });
        }
        let next = more
            .then(|| sends.last().map(|send| send.intent.conversation_id.clone()))
            .flatten();
        tx.commit()?;
        Ok((sends, next))
    }

    /// Settles one send the only way the daemon's evidence allows, and returns
    /// the window's draft afterwards. Call it under the Sessions store lock.
    pub fn acknowledge_send_intent(
        &self,
        conversation: &str,
        window: &str,
        request_id: &str,
    ) -> Result<(SendResolution, Draft)> {
        check_id(request_id)?;
        check_id(window)?;
        let (intent, held) = self
            .connection
            .query_row(
                &format!("SELECT {INTENT_COLUMNS} FROM send_intents WHERE request_id=?1"),
                [request_id],
                |row| Ok((send_intent_row(row)?, row.get::<_, i64>(9)? != 0)),
            )
            .optional()?
            .context("Unknown send intent")?;
        ensure!(
            intent.conversation_id == conversation && intent.window_id == window,
            "Send intent ID belongs to another owner"
        );
        let accepted = message_by_id(&self.connection, request_id)?.is_some();
        let resolution = acknowledgement(&intent.state, accepted, held)?;
        let draft = match (resolution, intent.state.as_str()) {
            // Already settled: report the window's draft as it is now.
            (SendResolution::Completed, "completed") => self.draft(conversation, window)?,
            (SendResolution::Completed, _) => {
                self.complete_send_intent(conversation, window, request_id)?
            }
            (SendResolution::Aborted, _) => {
                self.abort_send_intent(conversation, window, request_id)?
            }
        };
        Ok((resolution, draft))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_intents_are_not_listed() {
        for accepted in [false, true] {
            for held in [false, true] {
                assert_eq!(classify("completed", accepted, held).unwrap(), None);
                assert_eq!(classify("aborted", accepted, held).unwrap(), None);
            }
        }
    }

    #[test]
    fn unresolved_intents_classify_by_evidence() {
        use SendOutcome::*;
        assert_eq!(classify("pending", false, false).unwrap(), Some(Prepared));
        assert_eq!(classify("pending", true, false).unwrap(), Some(Accepted));
        assert_eq!(classify("rejected", false, false).unwrap(), Some(Rejected));
        assert_eq!(classify("rejected", true, false).unwrap(), Some(Conflict));
        for state in ["pending", "rejected"] {
            for accepted in [false, true] {
                assert_eq!(classify(state, accepted, true).unwrap(), Some(Held));
            }
        }
        assert!(classify("dispatched", false, false).is_err());
    }

    #[test]
    fn acknowledgement_settles_only_what_the_daemon_can_prove() {
        use SendResolution::*;
        assert_eq!(acknowledgement("pending", true, false).unwrap(), Completed);
        assert_eq!(acknowledgement("rejected", false, false).unwrap(), Aborted);
        let never_accepted = acknowledgement("pending", false, false).unwrap_err();
        assert!(never_accepted.to_string().contains("retry delivery"));
        assert!(acknowledgement("rejected", true, false).is_err());
        for state in ["pending", "rejected"] {
            for accepted in [false, true] {
                let held = acknowledgement(state, accepted, true).unwrap_err();
                assert!(
                    held.downcast_ref::<ade_core::error::RestoredSendHeld>()
                        .is_some()
                );
            }
        }
        assert!(acknowledgement("unknown", false, false).is_err());
    }

    #[test]
    fn repeated_acknowledgement_converges() {
        use SendResolution::*;
        for held in [false, true] {
            assert_eq!(acknowledgement("completed", true, held).unwrap(), Completed);
            assert_eq!(acknowledgement("aborted", false, held).unwrap(), Aborted);
        }
    }

    #[test]
    fn page_size_is_bounded() {
        assert_eq!(send_list_limit(None).unwrap(), SEND_LIST_DEFAULT);
        assert_eq!(send_list_limit(Some(1)).unwrap(), 1);
        assert_eq!(send_list_limit(Some(SEND_LIST_MAX)).unwrap(), SEND_LIST_MAX);
        assert!(send_list_limit(Some(0)).is_err());
        assert!(send_list_limit(Some(SEND_LIST_MAX + 1)).is_err());
    }
}
