//! Durable account switches and their pending context transfers (F026).
//!
//! `account.switch` is an effect command. Its receipt, the conversation's new
//! account, the switch record and its activity commit in one transaction of
//! the profile state database. The table is created here idempotently.
//!
//! A new-native-session switch stores a bounded transcript excerpt. The next
//! send prefixes it to the prompt and names that submission; the excerpt is
//! marked delivered only after the provider acknowledges that turn. A send
//! whose outcome is unknown leaves it pending, so the excerpt may reach the
//! new native session twice. That repeats context, never a user prompt.
use super::*;
use crate::receipts::{self, Admission, Status};
use ade_core::contract::accounts::{AccountSwitch, ContextTransfer};
use ade_core::contract::activity::{ActivityKind, ActivityTarget};
use anyhow::bail;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS account_switches(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, transfer TEXT NOT NULL, offered_submission TEXT, excerpt TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS account_switches_by_conversation ON account_switches(conversation_id, transfer, sequence);
";

pub(crate) const OP: &str = "account.switch";

fn ensure_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    receipts::ensure(connection)?;
    Ok(())
}

fn transfer_name(transfer: ContextTransfer) -> &'static str {
    match transfer {
        ContextTransfer::None => "none",
        ContextTransfer::Pending => "pending",
        ContextTransfer::Delivered => "delivered",
        ContextTransfer::Superseded => "superseded",
    }
}

/// Moves every pending transfer of `conversation` selected by `filter` to
/// `next`, keeping the stored record in step with the indexed column.
fn move_transfers(
    tx: &Connection,
    conversation: &str,
    submission: Option<&str>,
    next: ContextTransfer,
) -> Result<usize> {
    let mut statement = tx.prepare(
        "SELECT id,data FROM account_switches WHERE conversation_id=?1 AND transfer='pending' AND (?2 IS NULL OR offered_submission=?2)",
    )?;
    let rows = statement
        .query_map(params![conversation, submission], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, data) in &rows {
        let mut record: AccountSwitch = decode(data.clone())?;
        record.context_transfer = next;
        tx.execute(
            "UPDATE account_switches SET transfer=?2,data=?3 WHERE id=?1",
            params![id, transfer_name(next), encode(&record)?],
        )?;
    }
    Ok(rows.len())
}

/// What a switch writes, computed by the session handler under its lock.
pub struct SwitchCommit<'a> {
    pub operation_id: &'a str,
    pub payload: &'a Value,
    /// The conversation as it must still be stored; any change refuses.
    pub prior: &'a Conversation,
    /// The conversation with its new account and native session.
    pub next: &'a Conversation,
    pub record: &'a AccountSwitch,
    pub excerpt: Option<&'a str>,
    pub account_name: &'a str,
    pub now: i64,
}

impl Store {
    /// Checks an `account.switch` operation ID without recording anything.
    /// Returns the stored reply for a settled retry, and `None` for a new ID.
    pub fn account_switch_admission(
        &self,
        operation_id: &str,
        payload: &Value,
        now: i64,
    ) -> Result<Option<Value>> {
        ensure_schema(&self.connection)?;
        let tx = self.transaction()?;
        let admission = receipts::begin(&tx, operation_id, OP, payload, None, now)?;
        // Dropping the transaction rolls back the probe's `accepted` receipt.
        drop(tx);
        match admission {
            Admission::New => Ok(None),
            Admission::Replay(receipt) => {
                ensure!(
                    receipt.status == Status::Settled,
                    "Operation {operation_id} did not settle"
                );
                Ok(Some(
                    receipt
                        .result
                        .context("Settled operation has no stored result")?,
                ))
            }
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
            }
        }
    }

    /// Commits a switch, its receipt and its activity together, and returns
    /// the reply stored with the receipt.
    pub fn commit_account_switch(&self, commit: SwitchCommit<'_>, reply: &Value) -> Result<()> {
        ensure_schema(&self.connection)?;
        activity::ensure(&self.connection)?;
        check_id(commit.operation_id)?;
        let tx = self.transaction()?;
        ensure!(
            receipts::begin(
                &tx,
                commit.operation_id,
                OP,
                commit.payload,
                None,
                commit.now
            )? == Admission::New,
            "Operation {} was admitted concurrently",
            commit.operation_id
        );
        let stored: Conversation = live_conversation(&tx, &commit.prior.id)?;
        ensure!(
            encode(&stored)? == encode(commit.prior)?,
            "Conversation changed during the account switch; preview it again"
        );
        let (prior, next) = (commit.prior, commit.next);
        ensure!(
            next.id == prior.id
                && next.workspace_id == prior.workspace_id
                && next.provider == prior.provider
                && next.account_id.as_deref() == Some(commit.record.to_account_id.as_str())
                && next.account_context == crate::model::AccountContext::Managed,
            "Invalid account switch"
        );
        let account: Account = one(&tx, "accounts", &commit.record.to_account_id)?;
        ensure!(
            account.generation == commit.record.to_generation && account.state == "verified",
            "Account changed during the switch; preview it again"
        );
        check_text(&next.title)?;
        tx.execute(
            "UPDATE conversations SET data=?2 WHERE id=?1",
            params![next.id, encode(next)?],
        )?;
        // The new switch transfers the whole transcript excerpt again.
        move_transfers(&tx, &next.id, None, ContextTransfer::Superseded)?;
        tx.execute(
            "INSERT INTO account_switches(id,conversation_id,transfer,offered_submission,excerpt,data) VALUES(?1,?2,?3,NULL,?4,?5)",
            params![
                commit.record.id,
                next.id,
                transfer_name(commit.record.context_transfer),
                commit.excerpt,
                encode(commit.record)?
            ],
        )?;
        activity::record(
            &tx,
            activity::Recorded {
                source_key: format!("account_switch:{}", commit.record.id),
                kind: ActivityKind::AccountSwitched,
                target: ActivityTarget {
                    workspace_id: next.workspace_id.clone(),
                    conversation_id: next.id.clone(),
                    request_id: None,
                    turn_id: None,
                },
                title: next.title.clone(),
                detail: Some(format!(
                    "Switched to account {}. {}",
                    commit.account_name, commit.record.disclosure
                )),
            },
            commit.now,
        )?;
        receipts::settle(
            &tx,
            commit.operation_id,
            Status::Settled,
            Some(reply),
            commit.now,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Every switch recorded for a conversation, oldest first.
    pub fn account_switches(&self, conversation: &str) -> Result<Vec<AccountSwitch>> {
        ensure_schema(&self.connection)?;
        self.conversation(conversation)?;
        let mut statement = self.connection.prepare(
            "SELECT data FROM account_switches WHERE conversation_id=?1 ORDER BY sequence",
        )?;
        statement
            .query_map([conversation], |row| row.get::<_, String>(0))?
            .map(|row| decode(row?))
            .collect()
    }

    /// Prefixes the pending switch excerpt, if any, to a prompt for
    /// `submission`, and records that this submission carries it.
    pub fn with_switch_context(
        &self,
        conversation: &str,
        submission: &str,
        mut prompt: crate::prompt::Prompt,
    ) -> Result<crate::prompt::Prompt> {
        ensure_schema(&self.connection)?;
        let pending: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT id,excerpt FROM account_switches WHERE conversation_id=?1 AND transfer='pending' ORDER BY sequence DESC LIMIT 1",
                [conversation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((id, excerpt)) = pending else {
            return Ok(prompt);
        };
        self.connection.execute(
            "UPDATE account_switches SET offered_submission=?2 WHERE id=?1",
            params![id, submission],
        )?;
        prompt.text = crate::account_switch::compose(&excerpt, &prompt.text);
        Ok(prompt)
    }

    /// Marks the excerpt `submission` carried as delivered, after the
    /// provider acknowledged that turn.
    pub fn mark_switch_context_delivered(
        &self,
        conversation: &str,
        submission: &str,
    ) -> Result<()> {
        ensure_schema(&self.connection)?;
        let tx = self.transaction()?;
        move_transfers(
            &tx,
            conversation,
            Some(submission),
            ContextTransfer::Delivered,
        )?;
        tx.commit()?;
        Ok(())
    }
}
