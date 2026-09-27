//! The plugin lifecycle hook outbox (F058).
//!
//! When a hookable event commits, [`enqueue`] writes one delivery per
//! subscribed plugin in the same transaction, in the database that owns the
//! event. The profile state database holds the outbox the dispatcher reads.
//! The worktree lifecycle database stages its deliveries in the same tables,
//! and [`relay`] moves them into the outbox: a staged row is deleted only after
//! the outbox holds it, and the effect ID keeps a repeated relay from adding
//! a second delivery.
//!
//! Subscriptions come from the manifests of live plugin activations. The
//! daemon mirrors them into each event database with
//! [`replace_subscriptions`], so enqueueing needs no second database.
//!
//! The dispatcher claims a delivery durably (`dispatching`) before it hands it
//! to the plugin host, and records the host's verdict afterwards. A claim
//! still open when the daemon starts has an unknown outcome and is never sent
//! again on its own. [`decide`] holds the state machine.
mod decide;

use crate::receipts::{self, Admission, Status as ReceiptStatus};
use ade_core::contract::activity::{ActivityKind, ActivityTarget};
use ade_core::contract::hooks::{
    HookDelivery, HookDeliveryAbandonRequest, HookDeliveryInspectRequest, HookDeliveryList,
    HookDeliveryListRequest, HookDeliveryReply, HookDeliveryRetryRequest, HookDeliveryStatus,
    HookDispatch, HookEvent, HookHostStatus, HookSubscription, HookSubscriptionList,
    HookSubscriptionListRequest, HookVerdict, LIST_MAX,
};
use ade_core::model::WorkspaceRecord;
use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS hook_subscriptions(plugin_id TEXT NOT NULL, event TEXT NOT NULL,
  activation_generation INTEGER NOT NULL, PRIMARY KEY(plugin_id, event));
CREATE TABLE IF NOT EXISTS hook_deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT NOT NULL UNIQUE, plugin_id TEXT NOT NULL, status TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS hook_deliveries_by_status ON hook_deliveries(status, next_attempt_at, sequence);
";

const LIST_DEFAULT: u32 = 50;
/// Settled deliveries older than this are pruned; failed and unknown ones stay
/// until an operator retries or abandons them.
const KEEP_SETTLED_MS: i64 = receipts::RETENTION_MS;
const PRUNE_INTERVAL_MS: i64 = 60 * 60 * 1000;
/// Most deliveries one dispatcher pass sends, relays or moves.
pub const PASS_LIMIT: usize = 64;
const LOST_AT_RESTART: &str = "The daemon stopped while this delivery was in flight; the plugin may or may not have applied it";

/// Creates the hook tables if they are missing. Cheap when they exist, and
/// safe inside a caller's transaction.
pub fn ensure(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// A committed lifecycle event, before it fans out to subscribers.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub kind: HookEvent,
    /// Unique per real-world event. A second enqueue with the same key adds nothing.
    pub source_key: String,
    pub payload: Value,
}

impl Event {
    /// A settled turn, from the activity the same commit records. Only turn
    /// endings qualify; approvals and questions are not lifecycle hooks.
    pub fn turn_settled(
        source_key: &str,
        kind: ActivityKind,
        target: &ActivityTarget,
        provider: &str,
    ) -> Option<Self> {
        let outcome = match kind {
            ActivityKind::TurnCompleted => "completed",
            ActivityKind::TurnInterrupted => "interrupted",
            ActivityKind::TurnFailed => "failed",
            ActivityKind::OperationUnknown => "unknown",
            ActivityKind::ApprovalRequested
            | ActivityKind::QuestionRequested
            | ActivityKind::SnoozeEnded
            | ActivityKind::AccountSwitched => return None,
        };
        Some(Self {
            kind: HookEvent::TurnSettled,
            source_key: source_key.to_owned(),
            payload: json!({"conversation_id": target.conversation_id,
                "workspace_id": target.workspace_id, "turn_id": target.turn_id,
                "outcome": outcome, "provider": provider}),
        })
    }

    pub fn workspace_created(workspace: &WorkspaceRecord) -> Self {
        Self {
            kind: HookEvent::WorkspaceCreated,
            source_key: format!("workspace:{}:created", workspace.id),
            payload: json!({"workspace_id": workspace.id, "root": workspace.root,
                "repository_id": workspace.repository_id}),
        }
    }

    /// A service run moving to `starting` or `stopped`. `run_id` names one run.
    pub fn service_state(workspace_id: &str, service: &str, state: &str, run_id: &str) -> Self {
        Self {
            kind: HookEvent::ServiceStateChanged,
            source_key: format!("service:{run_id}:{state}"),
            payload: json!({"workspace_id": workspace_id, "service": service,
                "state": state, "run_id": run_id}),
        }
    }

    /// A succeeded worktree lifecycle operation, when it is a create or remove.
    pub fn worktree(
        op: &str,
        operation_id: &str,
        repository_id: &str,
        path: Option<&str>,
    ) -> Option<Self> {
        let (kind, name) = match op {
            "worktree.create" => (HookEvent::WorktreeCreated, "created"),
            "worktree.remove" => (HookEvent::WorktreeRemoved, "removed"),
            _ => return None,
        };
        Some(Self {
            kind,
            source_key: format!("worktree:{operation_id}:{name}"),
            payload: json!({"operation_id": operation_id, "repository_id": repository_id,
                "path": path}),
        })
    }
}

/// The effect ID of one plugin's delivery of one event. Deterministic, so a
/// relayed or repeated enqueue names the same effect.
fn effect_id(plugin_id: &str, event: HookEvent, source_key: &str) -> String {
    let digest = Sha256::digest(format!("{plugin_id}\n{}\n{source_key}", event.as_str()));
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("hookfx_{hex}")
}

/// Writes one delivery per subscriber of `event`, in the caller's
/// transaction. Returns how many were new.
pub fn enqueue(tx: &Connection, event: &Event, now: i64) -> Result<usize> {
    ensure(tx)?;
    let subscribers: Vec<(String, i64)> = tx
        .prepare(
            "SELECT plugin_id,activation_generation FROM hook_subscriptions WHERE event=?1 ORDER BY plugin_id",
        )?
        .query_map([event.kind.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut added = 0;
    for (plugin_id, generation) in subscribers {
        let delivery = HookDelivery {
            effect_id: effect_id(&plugin_id, event.kind, &event.source_key),
            sequence: 0,
            plugin_id,
            event: event.kind,
            activation_generation: u64::try_from(generation)?,
            payload: event.payload.clone(),
            status: HookDeliveryStatus::Queued,
            attempts: 0,
            created_at: now,
            updated_at: now,
            next_attempt_at: now,
            error: None,
        };
        added += insert(tx, &delivery)?;
    }
    Ok(added)
}

fn insert(tx: &Connection, delivery: &HookDelivery) -> Result<usize> {
    Ok(tx.execute(
        "INSERT INTO hook_deliveries(effect_id,plugin_id,status,next_attempt_at,updated_at,data) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(effect_id) DO NOTHING",
        params![
            delivery.effect_id,
            delivery.plugin_id,
            decide::name(delivery.status),
            delivery.next_attempt_at,
            delivery.updated_at,
            serde_json::to_string(delivery)?
        ],
    )?)
}

// ---------------------------------------------------------------------------
// Subscriptions and relay
// ---------------------------------------------------------------------------

/// Replaces the subscription mirror in one event database.
pub fn replace_subscriptions(
    connection: &Connection,
    subscriptions: &[HookSubscription],
) -> Result<()> {
    ensure(connection)?;
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM hook_subscriptions", [])?;
    for subscription in subscriptions {
        tx.execute(
            "INSERT INTO hook_subscriptions(plugin_id,event,activation_generation) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,event) DO UPDATE SET activation_generation=excluded.activation_generation",
            params![
                subscription.plugin_id,
                subscription.event.as_str(),
                i64::try_from(subscription.activation_generation)?
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn subscriptions(connection: &Connection) -> Result<Vec<HookSubscription>> {
    ensure(connection)?;
    connection
        .prepare("SELECT plugin_id,event,activation_generation FROM hook_subscriptions ORDER BY plugin_id,event")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?
        .map(|row| {
            let (plugin_id, event, generation) = row?;
            Ok(HookSubscription {
                plugin_id,
                event: HookEvent::parse(&event).with_context(|| format!("Unknown hook event {event}"))?,
                activation_generation: u64::try_from(generation)?,
            })
        })
        .collect()
}

/// Deliveries staged in a secondary event database, oldest first.
pub fn staged(connection: &Connection) -> Result<Vec<HookDelivery>> {
    ensure(connection)?;
    rows(
        connection,
        "SELECT sequence,status,next_attempt_at,updated_at,data FROM hook_deliveries ORDER BY sequence LIMIT ?1",
        params![PASS_LIMIT as i64],
    )
}

/// Deletes staged deliveries the outbox now holds.
pub fn forget_staged(connection: &Connection, effect_ids: &[String]) -> Result<()> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    for id in effect_ids {
        tx.execute("DELETE FROM hook_deliveries WHERE effect_id=?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}

/// Adds staged deliveries to the outbox. A delivery the outbox already holds
/// is left alone, so a relay repeated after a crash adds nothing.
pub fn relay(outbox: &Connection, staged: &[HookDelivery]) -> Result<Vec<String>> {
    ensure(outbox)?;
    let tx = Transaction::new_unchecked(outbox, TransactionBehavior::Immediate)?;
    for delivery in staged {
        ensure!(
            delivery.status == HookDeliveryStatus::Queued && delivery.attempts == 0,
            "Staged hook delivery {} was already sent",
            delivery.effect_id
        );
        insert(&tx, delivery)?;
    }
    tx.commit()?;
    Ok(staged.iter().map(|d| d.effect_id.clone()).collect())
}

// ---------------------------------------------------------------------------
// Reading and writing deliveries
// ---------------------------------------------------------------------------

fn parse<T: DeserializeOwned>(text: &str) -> Result<T> {
    Ok(serde_json::from_value(Value::String(text.to_owned()))?)
}

fn rows(
    connection: &Connection,
    query: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<HookDelivery>> {
    let mut statement = connection.prepare(query)?;
    let rows = statement.query_map(values, |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (sequence, status, next_attempt_at, updated_at, data) = row?;
        let mut delivery: HookDelivery = serde_json::from_str(&data)?;
        // The columns are authoritative; the JSON carries the rest.
        delivery.sequence = u64::try_from(sequence)?;
        delivery.status = parse(&status)?;
        delivery.next_attempt_at = next_attempt_at;
        delivery.updated_at = updated_at;
        Ok(delivery)
    })
    .collect()
}

const COLUMNS: &str = "SELECT sequence,status,next_attempt_at,updated_at,data FROM hook_deliveries";

fn load(connection: &Connection, effect_id: &str) -> Result<HookDelivery> {
    rows(
        connection,
        &format!("{COLUMNS} WHERE effect_id=?1"),
        [effect_id],
    )?
    .into_iter()
    .next()
    .with_context(|| format!("Unknown hook delivery {effect_id}"))
}

fn write(tx: &Connection, delivery: &HookDelivery) -> Result<()> {
    let changed = tx.execute(
        "UPDATE hook_deliveries SET status=?2,next_attempt_at=?3,updated_at=?4,data=?5 WHERE effect_id=?1",
        params![
            delivery.effect_id,
            decide::name(delivery.status),
            delivery.next_attempt_at,
            delivery.updated_at,
            serde_json::to_string(delivery)?
        ],
    )?;
    ensure!(
        changed == 1,
        "Hook delivery {} disappeared",
        delivery.effect_id
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/// The plugin host side of delivery. The backend plugin host implements it.
pub trait HookHost: Send + Sync {
    fn status(&self) -> HookHostStatus;
    /// Runs the plugin's handler for one delivery and reports what happened.
    /// It must answer `unknown` when it cannot tell whether the handler ran.
    fn deliver(&self, dispatch: &HookDispatch) -> HookVerdict;
}

/// Used while the plugin registry is unavailable: every delivery waits in
/// `awaiting_host`.
pub struct NoHost;

impl HookHost for NoHost {
    fn status(&self) -> HookHostStatus {
        HookHostStatus {
            available: false,
            detail: Some(
                "The plugin registry is unavailable; deliveries wait until it opens".into(),
            ),
        }
    }

    fn deliver(&self, _: &HookDispatch) -> HookVerdict {
        HookVerdict::NotStarted {
            reason: "No backend plugin host is available".into(),
        }
    }
}

/// The plugin host and the dispatcher's own bookkeeping.
pub struct Dispatcher {
    pub host: Box<dyn HookHost>,
    last_prune: AtomicI64,
    /// Set when mirroring subscriptions failed; the next pass tries again.
    stale: AtomicBool,
}

impl Default for Dispatcher {
    fn default() -> Self {
        Self {
            host: Box::new(NoHost),
            last_prune: AtomicI64::new(i64::MIN),
            stale: AtomicBool::new(false),
        }
    }
}

impl Dispatcher {
    pub fn new(host: Box<dyn HookHost>) -> Self {
        Self {
            host,
            ..Self::default()
        }
    }

    pub fn mark_stale(&self) {
        self.stale.store(true, Ordering::Relaxed);
    }

    pub fn take_stale(&self) -> bool {
        self.stale.swap(false, Ordering::Relaxed)
    }

    /// Whether settled deliveries are due for pruning; records the attempt.
    pub fn prune_due(&self, now: i64) -> bool {
        let last = self.last_prune.load(Ordering::Relaxed);
        now.saturating_sub(last) >= PRUNE_INTERVAL_MS
            && self
                .last_prune
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
    }
}

/// Runs once when the outbox opens, before any dispatch: every claim still
/// open has an unknown outcome. Returns how many were marked.
pub fn recover(connection: &Connection, now: i64) -> Result<usize> {
    ensure(connection)?;
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let open = rows(&tx, &format!("{COLUMNS} WHERE status='dispatching'"), [])?;
    for mut delivery in open.iter().cloned() {
        if let Some(next) = decide::recover(delivery.status) {
            delivery.status = next;
            delivery.error = Some(LOST_AT_RESTART.into());
            delivery.updated_at = now;
            write(&tx, &delivery)?;
        }
    }
    tx.commit()?;
    Ok(open.len())
}

/// Deletes delivered and abandoned deliveries past retention.
pub fn prune(connection: &Connection, now: i64) -> Result<usize> {
    ensure(connection)?;
    Ok(connection.execute(
        "DELETE FROM hook_deliveries WHERE status IN ('delivered','abandoned') AND updated_at<?1",
        [now.saturating_sub(KEEP_SETTLED_MS)],
    )?)
}

/// Moves never-sent deliveries between `queued` and `awaiting_host` to match
/// the host. Returns how many moved.
/// Whether any delivery matches `filter`, read without a write lock.
fn any(connection: &Connection, filter: &str, values: impl rusqlite::Params) -> Result<bool> {
    Ok(connection.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM hook_deliveries WHERE {filter})"),
        values,
        |row| row.get(0),
    )?)
}

pub fn follow_host(connection: &Connection, host: &HookHostStatus, now: i64) -> Result<usize> {
    ensure(connection)?;
    let from = if host.available {
        "awaiting_host"
    } else {
        "queued"
    };
    // Most passes have nothing to move; do not take the write lock for them.
    if !any(connection, "status=?1", params![from])? {
        return Ok(0);
    }
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let waiting = rows(
        &tx,
        &format!("{COLUMNS} WHERE status=?1 ORDER BY sequence LIMIT ?2"),
        params![from, PASS_LIMIT as i64],
    )?;
    let mut moved = 0;
    for mut delivery in waiting {
        if let Some(next) = decide::on_host(delivery.status, host.available) {
            delivery.status = next;
            delivery.error = if host.available {
                None
            } else {
                host.detail.clone()
            };
            delivery.updated_at = now;
            write(&tx, &delivery)?;
            moved += 1;
        }
    }
    tx.commit()?;
    Ok(moved)
}

/// Durably claims the oldest due delivery. The claim commits before the send,
/// so a crash during the send leaves `dispatching`, which [`recover`] marks unknown.
pub fn claim(connection: &Connection, now: i64) -> Result<Option<HookDispatch>> {
    ensure(connection)?;
    if !any(
        connection,
        "status='queued' AND next_attempt_at<=?1",
        params![now],
    )? {
        return Ok(None);
    }
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let Some(mut delivery) = rows(
        &tx,
        &format!(
            "{COLUMNS} WHERE status='queued' AND next_attempt_at<=?1 ORDER BY sequence LIMIT 1"
        ),
        [now],
    )?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    ensure!(
        decide::claimable(delivery.status),
        "Hook delivery is not claimable"
    );
    delivery.status = HookDeliveryStatus::Dispatching;
    delivery.attempts = delivery.attempts.saturating_add(1);
    delivery.updated_at = now;
    write(&tx, &delivery)?;
    tx.commit()?;
    Ok(Some(HookDispatch {
        effect_id: delivery.effect_id,
        plugin_id: delivery.plugin_id,
        event: delivery.event,
        payload: delivery.payload,
        attempt: delivery.attempts,
    }))
}

/// Records the host's verdict for a claimed delivery.
pub fn settle(
    connection: &Connection,
    effect_id: &str,
    verdict: &HookVerdict,
    now: i64,
) -> Result<HookDelivery> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let mut delivery = load(&tx, effect_id)?;
    let settlement =
        decide::settle(delivery.status, verdict, delivery.attempts).map_err(|e| anyhow!(e))?;
    delivery.status = settlement.status;
    delivery.error = settlement.error;
    delivery.updated_at = now;
    if let Some(wait) = settlement.retry_after_ms {
        delivery.next_attempt_at = now.saturating_add(wait);
    }
    write(&tx, &delivery)?;
    tx.commit()?;
    Ok(delivery)
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

fn decode<T: DeserializeOwned>(request: &Value) -> Result<T> {
    let mut body = request.clone();
    if let Some(map) = body.as_object_mut() {
        map.remove("op");
        map.remove("diagnostic_id");
    }
    T::deserialize(&body).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => anyhow!("Missing {field}"),
            None => anyhow!("Invalid request: {text}"),
        }
    })
}

fn reply(delivery: HookDelivery) -> Result<Value> {
    Ok(serde_json::to_value(HookDeliveryReply {
        tag: Default::default(),
        delivery,
    })?)
}

/// Handles one `hook.*` operation against the outbox database.
pub fn command(
    connection: &Connection,
    host: HookHostStatus,
    request: &Value,
    now: i64,
) -> Result<Value> {
    ensure(connection)?;
    match request["op"].as_str().unwrap_or("") {
        "hook.subscription.list" => {
            let _: HookSubscriptionListRequest = decode(request)?;
            Ok(serde_json::to_value(HookSubscriptionList {
                tag: Default::default(),
                subscriptions: subscriptions(connection)?,
            })?)
        }
        "hook.delivery.list" => list(connection, host, decode(request)?),
        "hook.delivery.inspect" => {
            let request: HookDeliveryInspectRequest = decode(request)?;
            reply(load(connection, &request.effect_id)?)
        }
        "hook.delivery.retry" => retry(connection, decode(request)?, now),
        "hook.delivery.abandon" => abandon(connection, decode(request)?, now),
        _ => bail!("Unknown hook operation"),
    }
}

fn list(
    connection: &Connection,
    host: HookHostStatus,
    request: HookDeliveryListRequest,
) -> Result<Value> {
    let limit = request.limit.unwrap_or(LIST_DEFAULT);
    ensure!(
        (1..=LIST_MAX).contains(&limit),
        "Hook delivery list limit must be 1 to {LIST_MAX}"
    );
    let after = i64::try_from(request.after.unwrap_or(0))?;
    let mut deliveries = rows(
        connection,
        &format!(
            "{COLUMNS} WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR plugin_id=?2) AND sequence>?3 ORDER BY sequence LIMIT ?4"
        ),
        params![
            request.status.map(decide::name),
            request.plugin_id,
            after,
            i64::from(limit) + 1
        ],
    )?;
    let next_after = if deliveries.len() > limit as usize {
        deliveries.truncate(limit as usize);
        deliveries.last().map(|d| d.sequence)
    } else {
        None
    };
    Ok(serde_json::to_value(HookDeliveryList {
        tag: Default::default(),
        deliveries,
        next_after,
        host,
    })?)
}

/// Queues a failed or unknown delivery again. The receipt, the state change
/// and the refusal, if any, commit together, so a repeat of the same
/// operation ID returns the first answer and never queues a second send.
fn retry(connection: &Connection, request: HookDeliveryRetryRequest, now: i64) -> Result<Value> {
    const OP: &str = "hook.delivery.retry";
    let operation_id = request.operation_id.as_str();
    ensure!(
        !operation_id.is_empty() && operation_id.len() <= 256,
        "operation_id must be 1 to 256 bytes"
    );
    receipts::ensure(connection)?;
    let payload = serde_json::to_value(&request)?;
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    match receipts::begin(&tx, operation_id, OP, &payload, Some("hook"), now)? {
        Admission::New => {}
        Admission::Replay(receipt) => {
            return match (receipt.status, receipt.result) {
                (ReceiptStatus::Settled, Some(result)) => Ok(result),
                // Admission and settlement share one transaction; anything
                // else means the receipt was written by something else.
                _ => {
                    bail!("Operation {operation_id} has no recorded outcome; inspect the delivery")
                }
            };
        }
        Admission::Conflict => {
            bail!("Operation ID {operation_id} was already used for a different request")
        }
        Admission::Expired => {
            bail!("Operation ID {operation_id} is past its receipt retention; use a new ID")
        }
    }
    let outcome = (|| -> Result<Value> {
        let mut delivery = load(&tx, &request.effect_id)?;
        delivery.status =
            decide::retry(delivery.status, request.acknowledge_unknown).map_err(|e| anyhow!(e))?;
        delivery.next_attempt_at = now;
        delivery.updated_at = now;
        write(&tx, &delivery)?;
        reply(delivery)
    })();
    let result = match outcome {
        Ok(value) => value,
        Err(error) => ade_core::error::error_envelope(error),
    };
    receipts::settle(
        &tx,
        operation_id,
        ReceiptStatus::Settled,
        Some(&result),
        now,
    )?;
    tx.commit()?;
    Ok(result)
}

fn abandon(
    connection: &Connection,
    request: HookDeliveryAbandonRequest,
    now: i64,
) -> Result<Value> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let mut delivery = load(&tx, &request.effect_id)?;
    if let Some(next) = decide::abandon(delivery.status).map_err(|e| anyhow!(e))? {
        delivery.status = next;
        delivery.updated_at = now;
        write(&tx, &delivery)?;
    }
    tx.commit()?;
    reply(delivery)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ActivityTarget {
        ActivityTarget {
            workspace_id: "workspace_1".into(),
            conversation_id: "conversation_1".into(),
            request_id: None,
            turn_id: Some("turn_1".into()),
        }
    }

    #[test]
    fn effect_ids_are_stable_per_plugin_event_and_source() {
        let a = effect_id("acme.notes", HookEvent::TurnSettled, "turn:c:t:completed");
        assert_eq!(
            a,
            effect_id("acme.notes", HookEvent::TurnSettled, "turn:c:t:completed")
        );
        assert!(a.starts_with("hookfx_") && a.len() == 39);
        assert_ne!(
            a,
            effect_id("acme.other", HookEvent::TurnSettled, "turn:c:t:completed")
        );
        assert_ne!(
            a,
            effect_id("acme.notes", HookEvent::TurnSettled, "turn:c:t:failed")
        );
        assert_ne!(
            a,
            effect_id(
                "acme.notes",
                HookEvent::WorkspaceCreated,
                "turn:c:t:completed"
            )
        );
    }

    #[test]
    fn only_turn_endings_are_turn_hooks() {
        let event =
            Event::turn_settled("key", ActivityKind::OperationUnknown, &target(), "codex").unwrap();
        assert_eq!(event.kind, HookEvent::TurnSettled);
        assert_eq!(event.payload["outcome"], "unknown");
        assert_eq!(event.payload["turn_id"], "turn_1");
        for kind in [
            ActivityKind::ApprovalRequested,
            ActivityKind::QuestionRequested,
        ] {
            assert!(Event::turn_settled("key", kind, &target(), "codex").is_none());
        }
    }

    #[test]
    fn only_create_and_remove_are_tree_lifecycle_hooks() {
        let removed = Event::worktree("worktree.remove", "op_1", "repo_1", Some("/w")).unwrap();
        assert_eq!(removed.kind, HookEvent::WorktreeRemoved);
        assert_eq!(removed.source_key, "worktree:op_1:removed");
        assert!(Event::worktree("worktree.switch", "op_1", "repo_1", None).is_none());
        assert!(Event::worktree("worktree.cleanup", "op_1", "repo_1", None).is_none());
    }

    #[test]
    fn service_runs_key_each_state_separately() {
        let starting = Event::service_state("w", "web", "starting", "service-run_1");
        let stopped = Event::service_state("w", "web", "stopped", "service-run_1");
        assert_ne!(starting.source_key, stopped.source_key);
        assert_eq!(stopped.payload["state"], "stopped");
    }
}
