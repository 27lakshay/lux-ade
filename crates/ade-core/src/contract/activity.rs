//! Activity feed and notification delivery contracts (F114, F117).
//!
//! Activity is durable application state in the profile database. The daemon
//! writes each record in the same transaction as the event it records, under a
//! unique source key, so a replayed event never records a second entry.
//! Notification presentation belongs to a client: a client claims a delivery
//! for one activity and channel, then reports what the OS said. A claim whose
//! outcome was never reported stays `claimed` and is never delivered again.
//! The daemon applies the profile's notification preferences and snoozed
//! attention when a client claims: an activity they exclude is recorded as a
//! `suppressed` delivery whose reason is `desktop_disabled`, `kind_muted` or
//! `conversation_snoozed`, and no client presents it.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ActivityListRequest, ActivityList>("activity.list", Tier::Query),
        // Read and dismissed only move forward; a repeat converges.
        OperationSpec::new::<ActivityMarkRequest, ActivityMarked>(
            "activity.mark",
            Tier::IdempotentCommand,
        ),
        // At most one client holds a delivery; the holder's repeat converges.
        OperationSpec::new::<NotificationDeliveryClaimRequest, NotificationDeliveryClaim>(
            "notification.delivery.claim",
            Tier::IdempotentCommand,
        ),
        // Records the holder's outcome once; the same outcome again converges.
        OperationSpec::new::<NotificationDeliveryReportRequest, NotificationDeliveryReply>(
            "notification.delivery.report",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<NotificationDeliveryListRequest, NotificationDeliveries>(
            "notification.delivery.list",
            Tier::Query,
        ),
        OperationSpec::new::<NotificationPreferencesGetRequest, NotificationPreferences>(
            "notification.preferences.get",
            Tier::Query,
        ),
        // Replaces the profile's preferences; the same preferences again converge.
        OperationSpec::new::<NotificationPreferencesSetRequest, NotificationPreferences>(
            "notification.preferences.set",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<ActivityChanged>("activity_changed")]
}

/// What an activity records.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    /// A turn finished normally.
    TurnCompleted,
    /// A turn or its Agent failed.
    TurnFailed,
    /// The provider interrupted a turn the user did not cancel.
    TurnInterrupted,
    /// An Agent asked for an approval.
    ApprovalRequested,
    /// An Agent asked the user a question.
    QuestionRequested,
    /// The daemon lost a running turn; its outcome is unknown.
    OperationUnknown,
    /// A snoozed Conversation reached its wake time (F046).
    SnoozeEnded,
    /// A conversation moved to another account for future turns (F026).
    AccountSwitched,
}

/// The read state of an activity. It only moves forward.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
    Unread,
    Read,
    Dismissed,
}

/// The resource an activity points at. Its fields stay readable after the
/// resource is removed; navigation must check that it still exists.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ActivityTarget {
    pub workspace_id: String,
    pub conversation_id: String,
    /// The pending request, for approval and question activity.
    pub request_id: Option<String>,
    /// The turn, when the daemon knew it.
    pub turn_id: Option<String>,
}

/// One durable activity record.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    /// Stable identity; notification deliveries are keyed by it.
    pub id: String,
    /// Monotonic position in the profile's feed; the list cursor.
    pub sequence: u64,
    pub kind: ActivityKind,
    pub state: ActivityState,
    pub target: ActivityTarget,
    /// The Conversation title when the activity was recorded.
    pub title: String,
    /// A bounded detail such as the recorded error or request method.
    pub detail: Option<String>,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub dismissed_at: Option<i64>,
}

/// `activity.list`: newest first, or oldest first after a cursor.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ActivityListRequest {
    /// Return activity with a larger sequence, oldest first, to catch up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    /// Return activity with a smaller sequence, newest first, to page back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    /// 1 to 200; defaults to 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Only unread activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread_only: Option<bool>,
    /// Include dismissed activity; excluded by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_dismissed: Option<bool>,
}

/// The mark an `activity.mark` request applies.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityMark {
    Read,
    Dismissed,
}

/// `activity.mark`: mark 1 to 100 activities read or dismissed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ActivityMarkRequest {
    pub activity_ids: Vec<String>,
    pub mark: ActivityMark,
}

/// Where a notification is presented. Push is a later channel.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryChannel {
    Desktop,
}

/// Where one activity's delivery on one channel stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// A client holds the delivery and has not reported; the outcome is unknown.
    Claimed,
    /// The OS reported that it showed the notification.
    Shown,
    /// The OS refused, failed or is unsupported; `reason` says why.
    Failed,
    /// The client deliberately did not present it; `reason` says why.
    Suppressed,
}

/// The outcome a claim holder reports.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryOutcome {
    Shown,
    Failed,
    Suppressed,
}

/// Delivery bookkeeping for one activity on one channel.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct NotificationDelivery {
    pub activity_id: String,
    pub channel: DeliveryChannel,
    pub status: DeliveryStatus,
    /// The client that claimed the delivery.
    pub client_id: String,
    /// Why a delivery failed or was suppressed.
    pub reason: Option<String>,
    pub claimed_at: i64,
    pub updated_at: i64,
}

/// `notification.delivery.claim`: reserve one activity's delivery.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationDeliveryClaimRequest {
    pub activity_id: String,
    pub channel: DeliveryChannel,
    /// Unique per client process; 1 to 128 characters.
    pub client_id: String,
}

/// `notification.delivery.report`: record what happened to a claimed delivery.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationDeliveryReportRequest {
    pub activity_id: String,
    pub channel: DeliveryChannel,
    pub client_id: String,
    pub outcome: DeliveryOutcome,
    /// Required for failed and suppressed; up to 500 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `notification.delivery.list`: newest deliveries first, to inspect failures.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct NotificationDeliveryListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DeliveryStatus>,
    /// 1 to 200; defaults to 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `notification.preferences.get`: the profile's notification preferences.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct NotificationPreferencesGetRequest {}

/// `notification.preferences.set`: replace the profile's notification preferences.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationPreferencesSetRequest {
    /// Whether any activity notifies on the desktop.
    pub desktop: bool,
    /// Activity kinds that never notify; repeats are ignored.
    pub muted_kinds: Vec<ActivityKind>,
}

wire_tag!(ActivityListTag, "activity_list");
wire_tag!(ActivityMarkedTag, "activity_marked");
wire_tag!(ActivityChangedTag, "activity_changed");
wire_tag!(DeliveryClaimTag, "notification_delivery_claim");
wire_tag!(DeliveryTag, "notification_delivery");
wire_tag!(DeliveriesTag, "notification_deliveries");
wire_tag!(PreferencesTag, "notification_preferences");

/// The `activity.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ActivityList {
    #[serde(rename = "type")]
    pub tag: ActivityListTag,
    pub activities: Vec<Activity>,
    /// Pass as `after` or `before` (matching the request) for the next page;
    /// null when this page is the last.
    pub next_cursor: Option<u64>,
    /// The largest sequence the profile has recorded; 0 when none.
    pub latest_sequence: u64,
}

/// The `activity.mark` reply: every named activity in its current state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ActivityMarked {
    #[serde(rename = "type")]
    pub tag: ActivityMarkedTag,
    pub activities: Vec<Activity>,
}

/// The `notification.delivery.claim` reply. `granted` is false when another
/// client or an earlier outcome already holds the delivery, or when the
/// profile's preferences or a snooze suppressed it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationDeliveryClaim {
    #[serde(rename = "type")]
    pub tag: DeliveryClaimTag,
    pub granted: bool,
    pub delivery: NotificationDelivery,
}

/// The `notification.delivery.report` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationDeliveryReply {
    #[serde(rename = "type")]
    pub tag: DeliveryTag,
    pub delivery: NotificationDelivery,
}

/// The `notification.delivery.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct NotificationDeliveries {
    #[serde(rename = "type")]
    pub tag: DeliveriesTag,
    pub deliveries: Vec<NotificationDelivery>,
}

/// The profile's notification preferences. A profile that never set them
/// notifies desktop for every activity kind.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct NotificationPreferences {
    #[serde(rename = "type")]
    pub tag: PreferencesTag,
    pub desktop: bool,
    /// In the order they were set, without repeats.
    pub muted_kinds: Vec<ActivityKind>,
    /// When the preferences were last set; null for the defaults.
    pub updated_at: Option<i64>,
}

/// A `session.subscribe` frame: an activity was recorded or changed state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ActivityChanged {
    #[serde(rename = "type")]
    pub tag: ActivityChangedTag,
    pub activity: Activity,
    pub boot_id: String,
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: Value) {
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    fn activity() -> Value {
        json!({"id":"activity_1","sequence":3,"kind":"approval_requested","state":"unread",
            "target":{"workspace_id":"w","conversation_id":"c","request_id":"r","turn_id":"t"},
            "title":"Fix build","detail":"item/commandExecution/requestApproval",
            "created_at":5,"read_at":null,"dismissed_at":null})
    }

    #[test]
    fn replies_and_frames_keep_their_wire_shape() {
        round_trip::<ActivityList>(json!({"type":"activity_list","activities":[activity()],
            "next_cursor":null,"latest_sequence":3}));
        round_trip::<ActivityMarked>(json!({"type":"activity_marked","activities":[activity()]}));
        round_trip::<ActivityChanged>(json!({"type":"activity_changed","activity":activity(),
            "boot_id":"b","revision":9}));
        let delivery = json!({"activity_id":"activity_1","channel":"desktop","status":"failed",
            "client_id":"desktop_1","reason":"permission_denied","claimed_at":1,"updated_at":2});
        round_trip::<NotificationDeliveryClaim>(
            json!({"type":"notification_delivery_claim","granted":false,"delivery":delivery}),
        );
        round_trip::<NotificationDeliveries>(
            json!({"type":"notification_deliveries","deliveries":[delivery]}),
        );
        round_trip::<NotificationPreferences>(json!({"type":"notification_preferences",
            "desktop":true,"muted_kinds":["turn_completed"],"updated_at":null}));
        round_trip::<NotificationPreferencesSetRequest>(
            json!({"desktop":false,"muted_kinds":["account_switched","snooze_ended"]}),
        );
    }

    #[test]
    fn list_request_fields_are_optional() {
        let bare: ActivityListRequest = serde_json::from_value(json!({})).unwrap();
        assert!(bare.after.is_none() && bare.before.is_none() && bare.limit.is_none());
        round_trip::<ActivityListRequest>(json!({"after":4,"limit":10,"unread_only":true}));
    }
}
