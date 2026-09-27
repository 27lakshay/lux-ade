//! Durable activity and notification delivery bookkeeping (F114, F117).
//!
//! Activity is recorded inside the transaction that commits the event it
//! describes, under a unique source key, so replaying an event never records a
//! second entry. Delivery rows are keyed by activity and channel: one client
//! claims a delivery, then reports what the OS said. A claim that was never
//! reported stays `claimed`: the notification may or may not have appeared, so
//! nobody delivers it again. A claim for activity that the profile's
//! preferences or a snooze exclude records a `suppressed` delivery with the
//! reason instead, so no client presents it later either. The tables live in
//! the profile state database and are created idempotently before first use.
use super::*;
use ade_core::contract::activity::{
    Activity, ActivityKind, ActivityList, ActivityListRequest, ActivityMark, ActivityState,
    ActivityTarget, DeliveryChannel, DeliveryOutcome, DeliveryStatus, NotificationDelivery,
    NotificationDeliveryClaimRequest, NotificationDeliveryReportRequest, NotificationPreferences,
};
use anyhow::bail;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_by_state ON activity(state, sequence);
CREATE TABLE IF NOT EXISTS notification_deliveries(activity_id TEXT NOT NULL REFERENCES activity(id), channel TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(activity_id, channel));
CREATE TABLE IF NOT EXISTS notification_preferences(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
";

/// The largest `activity.list` or `notification.delivery.list` page.
pub const LIST_MAX: u32 = 200;
const LIST_DEFAULT: u32 = 50;
const MARK_MAX: usize = 100;
const DETAIL_LIMIT: usize = 500;
const CLIENT_LIMIT: usize = 128;
const BUSY_TURN: &[&str] = &["running", "waiting"];

/// Creates the activity tables if they are missing. Cheap when they exist.
pub(super) fn ensure(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// Activity the daemon is about to record, before it has an ID or sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Recorded {
    /// Unique per real-world event; a second record with the same key is dropped.
    pub source_key: String,
    pub kind: ActivityKind,
    pub target: ActivityTarget,
    pub title: String,
    pub detail: Option<String>,
}

fn bounded(text: &str) -> String {
    match text.char_indices().nth(DETAIL_LIMIT) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

fn target(conversation: &Conversation, turn: Option<String>) -> ActivityTarget {
    ActivityTarget {
        workspace_id: conversation.workspace_id.clone(),
        conversation_id: conversation.id.clone(),
        request_id: None,
        turn_id: turn,
    }
}

/// The turn a status change ends: the provider turn, else the submission.
fn ending_turn(prior: &Conversation) -> Option<String> {
    prior
        .active_turn_id
        .clone()
        .or_else(|| prior.runtime_submission.clone())
}

fn turn_key(conversation: &Conversation, turn: &Option<String>, kind: &str, at: i64) -> String {
    match turn {
        Some(turn) => format!("turn:{}:{turn}:{kind}", conversation.id),
        None => format!("conversation:{}:{kind}:{at}", conversation.id),
    }
}

/// The activity a Conversation status change records, if any. A turn the
/// user was cancelling does not notify on completion or interruption; any
/// move into `error` does.
pub(crate) fn turn_activity(prior: &Conversation, next: &Conversation) -> Option<Recorded> {
    if prior.status == next.status {
        return None;
    }
    let had_turn = BUSY_TURN.contains(&prior.status.as_str())
        || prior.status == "starting" && prior.runtime_submission.is_some();
    let (kind, name) = match next.status.as_str() {
        "ready" if had_turn => (ActivityKind::TurnCompleted, "completed"),
        // A submission that never started was not confirmed delivered.
        "interrupted" if prior.status == "starting" && had_turn => {
            (ActivityKind::OperationUnknown, "unknown")
        }
        "interrupted" if had_turn => (ActivityKind::TurnInterrupted, "interrupted"),
        "error" => (ActivityKind::TurnFailed, "failed"),
        _ => return None,
    };
    let turn = ending_turn(prior);
    Some(Recorded {
        source_key: turn_key(next, &turn, name, next.updated_at),
        kind,
        target: target(next, turn),
        title: next.title.clone(),
        detail: next.error.as_deref().map(bounded),
    })
}

/// The activity a daemon restart records for a turn it lost.
pub(crate) fn unknown_turn(prior: &Conversation, next: &Conversation) -> Recorded {
    let turn = ending_turn(prior);
    Recorded {
        source_key: turn_key(next, &turn, "unknown", prior.updated_at),
        kind: ActivityKind::OperationUnknown,
        target: target(next, turn),
        title: next.title.clone(),
        detail: next.error.as_deref().map(bounded),
    }
}

/// The activity for a status change that lost the run: its provider stop was
/// not confirmed, or the runtime is gone. A turn in flight then has an unknown
/// outcome, exactly as when a daemon restart finds it busy, so every ordering
/// of a runtime crash records the same `operation_unknown` under the turn's key.
pub(crate) fn lost_turn_activity(prior: &Conversation, next: &Conversation) -> Option<Recorded> {
    (BUSY.contains(&prior.status.as_str()) && prior.status != next.status)
        .then(|| unknown_turn(prior, next))
}

/// The activity a newly recorded pending request records.
pub(crate) fn request_activity(
    conversation: &Conversation,
    request: &PendingRequest,
) -> Option<Recorded> {
    if request.status != "pending" {
        return None;
    }
    let kind = if request.method.to_ascii_lowercase().contains("approval") {
        ActivityKind::ApprovalRequested
    } else {
        ActivityKind::QuestionRequested
    };
    Some(Recorded {
        source_key: format!("request:{}", request.id),
        kind,
        target: ActivityTarget {
            request_id: Some(request.id.clone()),
            ..target(
                conversation,
                request.params["turnId"].as_str().map(str::to_owned),
            )
        },
        title: conversation.title.clone(),
        detail: Some(bounded(&request.method)),
    })
}

/// The state an activity moves to. Read never undoes a dismissal.
pub(crate) fn next_state(current: ActivityState, mark: ActivityMark) -> ActivityState {
    match (current, mark) {
        (ActivityState::Dismissed, _) | (_, ActivityMark::Dismissed) => ActivityState::Dismissed,
        _ => ActivityState::Read,
    }
}

/// Whether `client` may present this delivery. Only an unclaimed delivery, or
/// the same client's own unreported claim, is granted.
pub(crate) fn claim_granted(existing: Option<&NotificationDelivery>, client: &str) -> bool {
    existing.is_none_or(|d| d.status == DeliveryStatus::Claimed && d.client_id == client)
}

/// Why a delivery of `kind` must not be presented, if it must not. Turning
/// the desktop off wins over a muted kind, which wins over a snooze.
pub(crate) fn suppression(
    preferences: &NotificationPreferences,
    kind: ActivityKind,
    snoozed: bool,
) -> Option<&'static str> {
    if !preferences.desktop {
        Some("desktop_disabled")
    } else if preferences.muted_kinds.contains(&kind) {
        Some("kind_muted")
    } else if snoozed {
        Some("conversation_snoozed")
    } else {
        None
    }
}

/// The preferences a profile that never set them has: everything notifies.
fn default_preferences() -> NotificationPreferences {
    NotificationPreferences {
        tag: Default::default(),
        desktop: true,
        muted_kinds: Vec::new(),
        updated_at: None,
    }
}

fn preferences(db: &Connection) -> Result<NotificationPreferences> {
    db.query_row(
        "SELECT data FROM notification_preferences WHERE id=1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(decode)
    .transpose()
    .map(|stored| stored.unwrap_or_else(default_preferences))
}

/// The status a report moves a delivery to, or `None` when it repeats the
/// recorded outcome. Only the claim holder reports, and an outcome is final.
pub(crate) fn reported_status(
    existing: Option<&NotificationDelivery>,
    client: &str,
    outcome: DeliveryOutcome,
) -> Result<Option<DeliveryStatus>> {
    let existing = existing.context("Claim this notification delivery before reporting it")?;
    ensure!(
        existing.client_id == client,
        "Another client holds this notification delivery"
    );
    let status = match outcome {
        DeliveryOutcome::Shown => DeliveryStatus::Shown,
        DeliveryOutcome::Failed => DeliveryStatus::Failed,
        DeliveryOutcome::Suppressed => DeliveryStatus::Suppressed,
    };
    match existing.status {
        DeliveryStatus::Claimed => Ok(Some(status)),
        recorded if recorded == status => Ok(None),
        recorded => bail!(
            "Notification delivery was already recorded as {}",
            status_name(recorded)
        ),
    }
}

fn state_name(state: ActivityState) -> &'static str {
    match state {
        ActivityState::Unread => "unread",
        ActivityState::Read => "read",
        ActivityState::Dismissed => "dismissed",
    }
}

fn status_name(status: DeliveryStatus) -> &'static str {
    match status {
        DeliveryStatus::Claimed => "claimed",
        DeliveryStatus::Shown => "shown",
        DeliveryStatus::Failed => "failed",
        DeliveryStatus::Suppressed => "suppressed",
    }
}

fn channel_name(channel: DeliveryChannel) -> &'static str {
    match channel {
        DeliveryChannel::Desktop => "desktop",
    }
}

/// The key that makes one real-world event one activity. A turn whose outcome
/// is unknown is one event, whichever path noticed it: the daemon's restart
/// recovery and the runtime's attempt reconciliation both report the same
/// lost turn, so both use the turn's own key.
pub(crate) fn source_key(recorded: &Recorded) -> String {
    match (&recorded.kind, &recorded.target.turn_id) {
        (ActivityKind::OperationUnknown, Some(turn)) => {
            format!("turn:{}:{turn}:unknown", recorded.target.conversation_id)
        }
        _ => recorded.source_key.clone(),
    }
}

/// Records activity in the caller's transaction. A repeated source key keeps
/// the first record.
pub(super) fn record(tx: &Connection, recorded: Recorded, now: i64) -> Result<()> {
    let key = source_key(&recorded);
    let activity = Activity {
        id: new_id("activity"),
        sequence: 0,
        kind: recorded.kind,
        state: ActivityState::Unread,
        target: recorded.target,
        title: recorded.title,
        detail: recorded.detail,
        created_at: now,
        read_at: None,
        dismissed_at: None,
    };
    tx.execute(
        "INSERT INTO activity(id,source_key,state,data) VALUES(?1,?2,'unread',?3) ON CONFLICT(source_key) DO NOTHING",
        params![activity.id, key, encode(&activity)?],
    )?;
    Ok(())
}

fn read_activity(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, String)> {
    Ok((row.get(0)?, row.get(1)?))
}

fn activity_rows(
    db: &Connection,
    query: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<Activity>> {
    let mut statement = db.prepare(query)?;
    let rows = statement.query_map(values, read_activity)?;
    rows.map(|row| {
        let (sequence, data) = row?;
        let mut activity: Activity = decode(data)?;
        activity.sequence = u64::try_from(sequence).context("Invalid activity sequence")?;
        Ok(activity)
    })
    .collect()
}

fn one_activity(db: &Connection, id: &str) -> Result<Option<Activity>> {
    Ok(
        activity_rows(db, "SELECT sequence,data FROM activity WHERE id=?1", [id])?
            .into_iter()
            .next(),
    )
}

fn delivery(
    db: &Connection,
    activity_id: &str,
    channel: DeliveryChannel,
) -> Result<Option<NotificationDelivery>> {
    db.query_row(
        "SELECT data FROM notification_deliveries WHERE activity_id=?1 AND channel=?2",
        params![activity_id, channel_name(channel)],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(decode)
    .transpose()
}

fn write_delivery(db: &Connection, delivery: &NotificationDelivery) -> Result<()> {
    db.execute(
        "INSERT INTO notification_deliveries(activity_id,channel,status,updated_at,data) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(activity_id,channel) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,data=excluded.data",
        params![
            delivery.activity_id,
            channel_name(delivery.channel),
            status_name(delivery.status),
            delivery.updated_at,
            encode(delivery)?
        ],
    )?;
    Ok(())
}

fn page_size(limit: Option<u32>) -> Result<u32> {
    let limit = limit.unwrap_or(LIST_DEFAULT);
    ensure!(
        (1..=LIST_MAX).contains(&limit),
        "limit must be between 1 and {LIST_MAX}"
    );
    Ok(limit)
}

fn check_client(client: &str) -> Result<()> {
    ensure!(
        !client.is_empty()
            && client.len() <= CLIENT_LIMIT
            && client
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid client_id"
    );
    Ok(())
}

fn cursor(value: Option<u64>) -> Result<Option<i64>> {
    value
        .map(|v| i64::try_from(v).context("Invalid activity cursor"))
        .transpose()
}

impl Store {
    /// A page of activity. `after` reads oldest first; otherwise newest first.
    pub fn activity_list(&self, request: &ActivityListRequest) -> Result<ActivityList> {
        ensure(&self.connection)?;
        ensure!(
            request.after.is_none() || request.before.is_none(),
            "Pass after or before, not both"
        );
        let limit = page_size(request.limit)?;
        let filter = match (
            request.unread_only == Some(true),
            request.include_dismissed == Some(true),
        ) {
            (true, _) => " AND state='unread'",
            (false, true) => "",
            (false, false) => " AND state<>'dismissed'",
        };
        let (bound, order, position) = match (cursor(request.after)?, cursor(request.before)?) {
            (Some(after), _) => ("sequence>?1", "ASC", after),
            (None, Some(before)) => ("sequence<?1", "DESC", before),
            (None, None) => ("sequence<?1", "DESC", i64::MAX),
        };
        let query = format!(
            "SELECT sequence,data FROM activity WHERE {bound}{filter} ORDER BY sequence {order} LIMIT ?2"
        );
        let mut activities = activity_rows(&self.connection, &query, params![position, limit + 1])?;
        let next_cursor = if activities.len() > limit as usize {
            activities.truncate(limit as usize);
            activities.last().map(|a| a.sequence)
        } else {
            None
        };
        Ok(ActivityList {
            tag: Default::default(),
            activities,
            next_cursor,
            latest_sequence: self.latest_activity_sequence()?,
        })
    }

    /// The largest recorded sequence, or 0.
    pub fn latest_activity_sequence(&self) -> Result<u64> {
        ensure(&self.connection)?;
        let latest: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM activity",
            [],
            |r| r.get(0),
        )?;
        u64::try_from(latest).context("Invalid activity sequence")
    }

    /// Activity recorded after `sequence`, oldest first, for feed frames.
    pub fn activity_since(&self, sequence: u64, limit: u32) -> Result<Vec<Activity>> {
        ensure(&self.connection)?;
        activity_rows(
            &self.connection,
            "SELECT sequence,data FROM activity WHERE sequence>?1 ORDER BY sequence ASC LIMIT ?2",
            params![cursor(Some(sequence))?, limit],
        )
    }

    /// Marks activity read or dismissed. Returns every named activity and
    /// whether its state changed, in request order. Unknown IDs fail the call.
    pub fn activity_mark(
        &self,
        ids: &[String],
        mark: ActivityMark,
    ) -> Result<Vec<(Activity, bool)>> {
        ensure!(
            (1..=MARK_MAX).contains(&ids.len()),
            "activity_ids must name 1 to {MARK_MAX} activities"
        );
        ensure(&self.connection)?;
        let tx = self.transaction()?;
        let now = now_ms();
        let mut marked = Vec::with_capacity(ids.len());
        for id in ids {
            check_id(id)?;
            let mut activity =
                one_activity(&tx, id)?.with_context(|| format!("Unknown activity ID: {id}"))?;
            let state = next_state(activity.state, mark);
            let changed = state != activity.state;
            if changed {
                if activity.read_at.is_none() {
                    activity.read_at = Some(now);
                }
                if state == ActivityState::Dismissed {
                    activity.dismissed_at = Some(now);
                }
                activity.state = state;
                let sequence = activity.sequence;
                activity.sequence = 0;
                tx.execute(
                    "UPDATE activity SET state=?2,data=?3 WHERE id=?1",
                    params![id, state_name(state), encode(&activity)?],
                )?;
                activity.sequence = sequence;
            }
            marked.push((activity, changed));
        }
        tx.commit()?;
        Ok(marked)
    }

    /// Reserves one activity's delivery on one channel for `client_id`.
    pub fn claim_delivery(
        &self,
        request: &NotificationDeliveryClaimRequest,
    ) -> Result<(bool, NotificationDelivery)> {
        check_id(&request.activity_id)?;
        check_client(&request.client_id)?;
        ensure(&self.connection)?;
        let snooze = match one_activity(&self.connection, &request.activity_id)? {
            Some(activity) => self.snooze_of(&activity.target.conversation_id)?,
            None => None,
        };
        let snoozed = |now: i64| snooze.as_ref().is_some_and(|snooze| snooze.until > now);
        let tx = self.transaction()?;
        let activity = one_activity(&tx, &request.activity_id)?
            .with_context(|| format!("Unknown activity ID: {}", request.activity_id))?;
        let existing = delivery(&tx, &request.activity_id, request.channel)?;
        if !claim_granted(existing.as_ref(), &request.client_id) {
            return Ok((false, existing.context("Delivery claim is missing")?));
        }
        let claimed = match existing {
            Some(existing) => existing,
            None => {
                let now = now_ms();
                let reason = suppression(&preferences(&tx)?, activity.kind, snoozed(now));
                if let Some(reason) = reason {
                    let suppressed = NotificationDelivery {
                        activity_id: request.activity_id.clone(),
                        channel: request.channel,
                        status: DeliveryStatus::Suppressed,
                        client_id: request.client_id.clone(),
                        reason: Some(reason.to_owned()),
                        claimed_at: now,
                        updated_at: now,
                    };
                    write_delivery(&tx, &suppressed)?;
                    tx.commit()?;
                    return Ok((false, suppressed));
                }
                let claimed = NotificationDelivery {
                    activity_id: request.activity_id.clone(),
                    channel: request.channel,
                    status: DeliveryStatus::Claimed,
                    client_id: request.client_id.clone(),
                    reason: None,
                    claimed_at: now,
                    updated_at: now,
                };
                write_delivery(&tx, &claimed)?;
                claimed
            }
        };
        tx.commit()?;
        Ok((true, claimed))
    }

    /// Records the claim holder's outcome.
    pub fn report_delivery(
        &self,
        request: &NotificationDeliveryReportRequest,
    ) -> Result<NotificationDelivery> {
        check_id(&request.activity_id)?;
        check_client(&request.client_id)?;
        let reason = request
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty());
        if let Some(reason) = reason {
            ensure!(
                reason.chars().count() <= DETAIL_LIMIT && !reason.chars().any(char::is_control),
                "reason must be up to {DETAIL_LIMIT} characters on one line"
            );
        }
        ensure!(
            request.outcome == DeliveryOutcome::Shown || reason.is_some(),
            "A failed or suppressed delivery needs a reason"
        );
        ensure(&self.connection)?;
        let tx = self.transaction()?;
        let existing = delivery(&tx, &request.activity_id, request.channel)?;
        let Some(status) = reported_status(existing.as_ref(), &request.client_id, request.outcome)?
        else {
            return existing.context("Delivery is missing");
        };
        let mut updated = existing.context("Delivery is missing")?;
        updated.status = status;
        updated.reason = reason.map(str::to_owned);
        updated.updated_at = now_ms();
        write_delivery(&tx, &updated)?;
        tx.commit()?;
        Ok(updated)
    }

    /// The profile's notification preferences, or the defaults.
    pub fn notification_preferences(&self) -> Result<NotificationPreferences> {
        ensure(&self.connection)?;
        preferences(&self.connection)
    }

    /// Replaces the profile's notification preferences. Setting what is
    /// stored again keeps its time.
    pub fn set_notification_preferences(
        &self,
        desktop: bool,
        muted_kinds: &[ActivityKind],
    ) -> Result<NotificationPreferences> {
        let mut muted = Vec::with_capacity(muted_kinds.len());
        for kind in muted_kinds {
            if !muted.contains(kind) {
                muted.push(*kind);
            }
        }
        ensure(&self.connection)?;
        let tx = self.transaction()?;
        let current = preferences(&tx)?;
        if current.updated_at.is_some()
            && current.desktop == desktop
            && current.muted_kinds == muted
        {
            return Ok(current);
        }
        let next = NotificationPreferences {
            tag: Default::default(),
            desktop,
            muted_kinds: muted,
            updated_at: Some(now_ms()),
        };
        tx.execute(
            "INSERT INTO notification_preferences(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            [encode(&next)?],
        )?;
        tx.commit()?;
        Ok(next)
    }

    /// Deliveries newest first, optionally in one status.
    pub fn deliveries(
        &self,
        status: Option<DeliveryStatus>,
        limit: Option<u32>,
    ) -> Result<Vec<NotificationDelivery>> {
        let limit = page_size(limit)?;
        ensure(&self.connection)?;
        let mut statement = self.connection.prepare(
            "SELECT data FROM notification_deliveries WHERE ?1 IS NULL OR status=?1 ORDER BY updated_at DESC LIMIT ?2",
        )?;
        statement
            .query_map(params![status.map(status_name), limit], |r| {
                r.get::<_, String>(0)
            })?
            .map(|row| decode(row?))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(status: &str) -> Conversation {
        serde_json::from_value(json!({
            "id": "c", "workspace_id": "w", "title": "Fix build", "provider": "codex",
            "provider_thread_id": "thread", "status": status, "active_turn_id": "turn",
            "error": null, "updated_at": 7,
        }))
        .unwrap()
    }

    fn after(prior: &Conversation, status: &str, error: Option<&str>) -> Conversation {
        let mut next = prior.clone();
        next.status = status.into();
        next.active_turn_id = None;
        next.error = error.map(str::to_owned);
        next.updated_at = 9;
        next
    }

    fn request(method: &str, status: &str) -> PendingRequest {
        serde_json::from_value(
            json!({"id":"request_1","conversation_id":"c","run_id":"run",
            "rpc_id":1,"method":method,"params":{"turnId":"turn"},"status":status}),
        )
        .unwrap()
    }

    #[test]
    fn a_finished_turn_records_one_keyed_activity() {
        let running = conversation("running");
        let done = turn_activity(&running, &after(&running, "ready", None)).unwrap();
        assert_eq!(done.kind, ActivityKind::TurnCompleted);
        assert_eq!(done.source_key, "turn:c:turn:completed");
        assert_eq!(done.target.turn_id.as_deref(), Some("turn"));
        let failed =
            turn_activity(&running, &after(&running, "error", Some("Agent exited"))).unwrap();
        assert_eq!(failed.kind, ActivityKind::TurnFailed);
        assert_eq!(failed.detail.as_deref(), Some("Agent exited"));
        let waiting = conversation("waiting");
        assert_eq!(
            turn_activity(&waiting, &after(&waiting, "interrupted", None))
                .unwrap()
                .kind,
            ActivityKind::TurnInterrupted
        );
    }

    #[test]
    fn connecting_cancelling_and_unchanged_status_record_nothing() {
        let mut starting = conversation("starting");
        starting.active_turn_id = None;
        assert_eq!(
            turn_activity(&starting, &after(&starting, "ready", None)),
            None
        );
        let cancelling = conversation("cancelling");
        assert_eq!(
            turn_activity(&cancelling, &after(&cancelling, "ready", None)),
            None
        );
        assert_eq!(
            turn_activity(&cancelling, &after(&cancelling, "interrupted", None)),
            None
        );
        let running = conversation("running");
        assert_eq!(turn_activity(&running, &running.clone()), None);
        let failed = conversation("error");
        assert_eq!(turn_activity(&failed, &after(&failed, "error", None)), None);
    }

    #[test]
    fn a_failure_without_a_turn_is_keyed_by_time() {
        let mut ready = conversation("ready");
        ready.active_turn_id = None;
        let failed = turn_activity(&ready, &after(&ready, "error", Some("gone"))).unwrap();
        assert_eq!(failed.source_key, "conversation:c:failed:9");
        assert_eq!(failed.target.turn_id, None);
    }

    #[test]
    fn a_lost_turn_is_unknown() {
        let running = conversation("running");
        let lost = unknown_turn(&running, &after(&running, "interrupted", Some("restart")));
        assert_eq!(lost.kind, ActivityKind::OperationUnknown);
        assert_eq!(lost.source_key, "turn:c:turn:unknown");
        let mut starting = conversation("starting");
        starting.active_turn_id = None;
        starting.runtime_submission = Some("submission".into());
        let unconfirmed = turn_activity(&starting, &after(&starting, "interrupted", None)).unwrap();
        assert_eq!(unconfirmed.kind, ActivityKind::OperationUnknown);
        assert_eq!(unconfirmed.source_key, "turn:c:submission:unknown");
    }

    #[test]
    fn a_turn_lost_with_its_run_is_unknown_whatever_noticed_it() {
        for status in ["running", "waiting", "cancelling"] {
            let busy = conversation(status);
            let failed = after(&busy, "interrupted", Some("Runtime supervisor exited"));
            let lost = lost_turn_activity(&busy, &failed).unwrap();
            let restarted = unknown_turn(&busy, &after(&busy, "interrupted", Some("restart")));
            assert_eq!(lost.kind, ActivityKind::OperationUnknown);
            assert_eq!(source_key(&lost), source_key(&restarted));
        }
        let mut ready = conversation("ready");
        ready.active_turn_id = None;
        assert_eq!(
            lost_turn_activity(&ready, &after(&ready, "interrupted", None)),
            None
        );
    }

    #[test]
    fn every_report_of_one_lost_turn_shares_its_key() {
        let running = conversation("running");
        let lost = unknown_turn(&running, &after(&running, "interrupted", Some("restart")));
        // Runtime reconciliation reports the same turn under its own report key.
        let reconciled = Recorded {
            source_key: "runtime-recovery:report_1:agent:c".into(),
            ..lost.clone()
        };
        assert_eq!(source_key(&reconciled), source_key(&lost));
        // Without a turn, and for other kinds, the recorded key stands.
        let mut untargeted = reconciled.clone();
        untargeted.target.turn_id = None;
        assert_eq!(source_key(&untargeted), "runtime-recovery:report_1:agent:c");
        let completed = turn_activity(&running, &after(&running, "ready", None)).unwrap();
        assert_eq!(source_key(&completed), "turn:c:turn:completed");
    }

    #[test]
    fn pending_requests_record_approval_or_question() {
        let c = conversation("waiting");
        let approval = request_activity(
            &c,
            &request("item/commandExecution/requestApproval", "pending"),
        )
        .unwrap();
        assert_eq!(approval.kind, ActivityKind::ApprovalRequested);
        assert_eq!(approval.source_key, "request:request_1");
        assert_eq!(approval.target.request_id.as_deref(), Some("request_1"));
        let question =
            request_activity(&c, &request("item/tool/requestUserInput", "pending")).unwrap();
        assert_eq!(question.kind, ActivityKind::QuestionRequested);
        assert_eq!(
            request_activity(&c, &request("claude/questions", "resolved")),
            None
        );
    }

    #[test]
    fn details_are_bounded_on_a_character_boundary() {
        let long = "é".repeat(DETAIL_LIMIT + 10);
        let text = bounded(&long);
        assert_eq!(text.chars().count(), DETAIL_LIMIT + 1);
        assert!(text.ends_with('…'));
        assert_eq!(bounded("short"), "short");
    }

    #[test]
    fn read_state_only_moves_forward() {
        use ActivityMark as M;
        use ActivityState as S;
        assert_eq!(next_state(S::Unread, M::Read), S::Read);
        assert_eq!(next_state(S::Read, M::Read), S::Read);
        assert_eq!(next_state(S::Unread, M::Dismissed), S::Dismissed);
        assert_eq!(next_state(S::Read, M::Dismissed), S::Dismissed);
        assert_eq!(next_state(S::Dismissed, M::Read), S::Dismissed);
    }

    fn delivery(status: DeliveryStatus, client: &str) -> NotificationDelivery {
        NotificationDelivery {
            activity_id: "activity_1".into(),
            channel: DeliveryChannel::Desktop,
            status,
            client_id: client.into(),
            reason: None,
            claimed_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn only_an_unclaimed_delivery_or_the_holders_retry_is_granted() {
        assert!(claim_granted(None, "a"));
        let claimed = delivery(DeliveryStatus::Claimed, "a");
        assert!(claim_granted(Some(&claimed), "a"));
        assert!(!claim_granted(Some(&claimed), "b"));
        for status in [
            DeliveryStatus::Shown,
            DeliveryStatus::Failed,
            DeliveryStatus::Suppressed,
        ] {
            assert!(!claim_granted(Some(&delivery(status, "a")), "a"));
        }
    }

    #[test]
    fn preferences_and_snoozes_suppress_in_a_fixed_order() {
        let mut preferences = default_preferences();
        assert_eq!(
            suppression(&preferences, ActivityKind::TurnCompleted, false),
            None
        );
        assert_eq!(
            suppression(&preferences, ActivityKind::TurnCompleted, true),
            Some("conversation_snoozed")
        );
        preferences.muted_kinds = vec![ActivityKind::TurnCompleted];
        assert_eq!(
            suppression(&preferences, ActivityKind::TurnCompleted, true),
            Some("kind_muted")
        );
        assert_eq!(
            suppression(&preferences, ActivityKind::TurnFailed, false),
            None
        );
        preferences.desktop = false;
        assert_eq!(
            suppression(&preferences, ActivityKind::TurnFailed, false),
            Some("desktop_disabled")
        );
    }

    #[test]
    fn reports_come_from_the_holder_and_are_final() {
        let claimed = delivery(DeliveryStatus::Claimed, "a");
        assert!(reported_status(None, "a", DeliveryOutcome::Shown).is_err());
        assert!(reported_status(Some(&claimed), "b", DeliveryOutcome::Shown).is_err());
        assert_eq!(
            reported_status(Some(&claimed), "a", DeliveryOutcome::Failed).unwrap(),
            Some(DeliveryStatus::Failed)
        );
        let shown = delivery(DeliveryStatus::Shown, "a");
        assert_eq!(
            reported_status(Some(&shown), "a", DeliveryOutcome::Shown).unwrap(),
            None
        );
        assert!(reported_status(Some(&shown), "a", DeliveryOutcome::Failed).is_err());
    }
}
