//! Durable Conversation snoozes (F046, conversations spec decision 7).
//!
//! A snooze defers attention only. It never stops, starts or schedules agent
//! work. Each row names a wake time; when that time passes the daemon deletes
//! the row and records one `snooze_ended` activity in the same transaction, so
//! a wake is never lost across a restart and never recorded twice. The table
//! lives in the profile state database and is created idempotently before use.
use super::*;
use activity::Recorded;
use ade_core::contract::activity::{ActivityKind, ActivityTarget};
use ade_core::contract::conversations::ConversationSnooze;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS conversation_snoozes(conversation_id TEXT PRIMARY KEY, until INTEGER NOT NULL, snoozed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS conversation_snoozes_by_until ON conversation_snoozes(until);
";

/// The latest wake time a snooze may choose.
pub const MAX_AHEAD_MS: i64 = 366 * 24 * 60 * 60 * 1000;
/// The longest the wake loop sleeps before it looks again, so a new or
/// changed snooze wakes at most this late.
pub const MAX_WAIT_MS: i64 = 1_000;
/// Snoozes woken per transaction.
const WAKE_BATCH: u32 = 100;
const LIST_DEFAULT: u32 = 100;
const LIST_MAX: u32 = 500;

fn ensure_table(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// Accepts a wake time only in the future and at most [`MAX_AHEAD_MS`] away.
pub(crate) fn check_until(now: i64, until: i64) -> Result<()> {
    ensure!(until > now, "Snooze time must be in the future");
    ensure!(
        until - now <= MAX_AHEAD_MS,
        "Snooze time must be at most 366 days ahead"
    );
    Ok(())
}

/// The snooze a request leaves. Repeating the stored wake time converges on
/// the stored snooze; a different time replaces it.
pub(crate) fn next_snooze(
    existing: Option<&ConversationSnooze>,
    conversation_id: &str,
    until: i64,
    now: i64,
) -> ConversationSnooze {
    match existing {
        Some(snooze) if snooze.until == until => snooze.clone(),
        _ => ConversationSnooze {
            conversation_id: conversation_id.to_owned(),
            until,
            snoozed_at: now,
        },
    }
}

/// How long the wake loop may sleep, given the earliest stored wake time.
pub(crate) fn wait_ms(earliest: Option<i64>, now: i64) -> i64 {
    earliest.map_or(MAX_WAIT_MS, |until| (until - now).clamp(0, MAX_WAIT_MS))
}

/// The activity a due snooze records. The key names the snooze itself, so a
/// replayed wake records nothing new.
pub(crate) fn wake_activity(conversation: &Conversation, snooze: &ConversationSnooze) -> Recorded {
    Recorded {
        source_key: format!(
            "snooze:{}:{}:{}",
            snooze.conversation_id, snooze.snoozed_at, snooze.until
        ),
        kind: ActivityKind::SnoozeEnded,
        target: ActivityTarget {
            workspace_id: conversation.workspace_id.clone(),
            conversation_id: conversation.id.clone(),
            request_id: None,
            turn_id: None,
        },
        title: conversation.title.clone(),
        detail: None,
    }
}

fn read_snooze(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSnooze> {
    Ok(ConversationSnooze {
        conversation_id: row.get(0)?,
        until: row.get(1)?,
        snoozed_at: row.get(2)?,
    })
}

fn stored(db: &Connection, conversation_id: &str) -> Result<Option<ConversationSnooze>> {
    Ok(db
        .query_row(
            "SELECT conversation_id,until,snoozed_at FROM conversation_snoozes WHERE conversation_id=?1",
            [conversation_id],
            read_snooze,
        )
        .optional()?)
}

impl Store {
    /// Snoozes a Conversation until `until`.
    pub fn snooze(
        &self,
        conversation_id: &str,
        until: i64,
        now: i64,
    ) -> Result<ConversationSnooze> {
        check_id(conversation_id)?;
        check_until(now, until)?;
        ensure_table(&self.connection)?;
        let tx = self.transaction()?;
        live_conversation(&tx, conversation_id)?;
        let snooze = next_snooze(
            stored(&tx, conversation_id)?.as_ref(),
            conversation_id,
            until,
            now,
        );
        tx.execute(
            "INSERT INTO conversation_snoozes(conversation_id,until,snoozed_at) VALUES(?1,?2,?3) ON CONFLICT(conversation_id) DO UPDATE SET until=excluded.until,snoozed_at=excluded.snoozed_at",
            params![snooze.conversation_id, snooze.until, snooze.snoozed_at],
        )?;
        tx.commit()?;
        Ok(snooze)
    }

    /// Ends a snooze without recording a wake. Ending none converges.
    pub fn unsnooze(&self, conversation_id: &str) -> Result<()> {
        check_id(conversation_id)?;
        ensure_table(&self.connection)?;
        self.connection.execute(
            "DELETE FROM conversation_snoozes WHERE conversation_id=?1",
            [conversation_id],
        )?;
        Ok(())
    }

    pub fn snooze_of(&self, conversation_id: &str) -> Result<Option<ConversationSnooze>> {
        ensure_table(&self.connection)?;
        stored(&self.connection, conversation_id)
    }

    /// Active snoozes, soonest wake first.
    pub fn snoozes(&self, limit: Option<u32>) -> Result<Vec<ConversationSnooze>> {
        let limit = limit.unwrap_or(LIST_DEFAULT);
        ensure!(
            (1..=LIST_MAX).contains(&limit),
            "Limit must be between 1 and {LIST_MAX}"
        );
        ensure_table(&self.connection)?;
        let mut statement = self.connection.prepare(
            "SELECT conversation_id,until,snoozed_at FROM conversation_snoozes ORDER BY until,conversation_id LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], read_snooze)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// How long the wake loop may sleep after `now`.
    pub fn snooze_wait_ms(&self, now: i64) -> Result<i64> {
        ensure_table(&self.connection)?;
        let earliest: Option<i64> = self.connection.query_row(
            "SELECT min(until) FROM conversation_snoozes",
            [],
            |row| row.get(0),
        )?;
        Ok(wait_ms(earliest, now))
    }

    /// Ends every snooze whose wake time has passed and records its activity
    /// in the same transaction. A snooze of a removed Conversation ends
    /// without activity. Returns how many snoozes ended.
    pub fn wake_due_snoozes(&self, now: i64) -> Result<usize> {
        ensure_table(&self.connection)?;
        activity::ensure(&self.connection)?;
        let mut woken = 0;
        loop {
            let tx = self.transaction()?;
            let due: Vec<ConversationSnooze> = {
                let mut statement = tx.prepare(
                    "SELECT conversation_id,until,snoozed_at FROM conversation_snoozes WHERE until<=?1 ORDER BY until LIMIT ?2",
                )?;
                let rows = statement.query_map(params![now, WAKE_BATCH], read_snooze)?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for snooze in &due {
                let conversation: Option<String> = tx
                    .query_row(
                        "SELECT data FROM conversations WHERE id=?1",
                        [&snooze.conversation_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(conversation) = conversation {
                    let conversation: Conversation = decode(conversation)?;
                    activity::record(&tx, wake_activity(&conversation, snooze), now)?;
                }
                tx.execute(
                    "DELETE FROM conversation_snoozes WHERE conversation_id=?1 AND until=?2",
                    params![snooze.conversation_id, snooze.until],
                )?;
            }
            tx.commit()?;
            woken += due.len();
            if due.len() < WAKE_BATCH as usize {
                return Ok(woken);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn snooze(until: i64, snoozed_at: i64) -> ConversationSnooze {
        ConversationSnooze {
            conversation_id: "conversation_1".into(),
            until,
            snoozed_at,
        }
    }

    #[test]
    fn wake_time_must_be_future_and_bounded() {
        assert!(check_until(100, 101).is_ok());
        assert!(check_until(100, 100).is_err());
        assert!(check_until(100, 50).is_err());
        assert!(check_until(0, MAX_AHEAD_MS).is_ok());
        assert!(check_until(0, MAX_AHEAD_MS + 1).is_err());
        assert!(check_until(0, 367 * DAY).is_err());
    }

    #[test]
    fn repeating_a_wake_time_converges_and_a_new_one_replaces_it() {
        let first = next_snooze(None, "conversation_1", 500, 10);
        assert_eq!(first, snooze(500, 10));
        assert_eq!(next_snooze(Some(&first), "conversation_1", 500, 20), first);
        assert_eq!(
            next_snooze(Some(&first), "conversation_1", 900, 30),
            snooze(900, 30)
        );
    }

    #[test]
    fn wake_loop_wait_is_bounded_and_never_negative() {
        assert_eq!(wait_ms(None, 0), MAX_WAIT_MS);
        assert_eq!(wait_ms(Some(1_000), 700), 300);
        assert_eq!(wait_ms(Some(100), 400), 0);
        assert_eq!(wait_ms(Some(10 * MAX_WAIT_MS), 0), MAX_WAIT_MS);
    }

    #[test]
    fn each_snooze_has_one_wake_key() {
        let conversation: Conversation = serde_json::from_value(serde_json::json!({
            "id": "conversation_1", "workspace_id": "workspace_1", "title": "Fix login",
            "provider": "codex", "provider_thread_id": null, "status": "running",
            "active_turn_id": "turn_1", "error": null, "updated_at": 1, "account_context": "ambient",
            "queue_paused": false, "runtime_cursor": 0, "provider_config": {}, "attention": "idle", "unread": false,
        }))
        .unwrap();
        let recorded = wake_activity(&conversation, &snooze(500, 10));
        assert_eq!(recorded.kind, ActivityKind::SnoozeEnded);
        assert_eq!(recorded.source_key, "snooze:conversation_1:10:500");
        assert_eq!(recorded.target.workspace_id, "workspace_1");
        assert_eq!(recorded.title, "Fix login");
        // Waking never names or touches the running turn.
        assert_eq!(recorded.target.turn_id, None);
        assert_ne!(
            wake_activity(&conversation, &snooze(500, 11)).source_key,
            recorded.source_key
        );
    }
}
