//! Plugin lifecycle hook contracts (F058).
//!
//! A plugin lists the lifecycle events it wants in its manifest
//! (`contributes.hooks`). When such an event commits, the daemon writes one
//! delivery per subscribed plugin in the same transaction. A dispatcher later
//! hands each delivery to the plugin host with a stable `effect_id`. The
//! plugin must treat that ID as the idempotency key of whatever it does.
//!
//! There is no exactly-once guarantee. A delivery whose outcome was lost
//! becomes `unknown` and is never sent again on its own; only an explicit
//! `hook.delivery.retry` that acknowledges the unknown outcome sends it again,
//! with the same effect ID. Hooks run after commit only: v1 has no
//! synchronous pre-admission hooks.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<HookSubscriptionListRequest, HookSubscriptionList>(
            "hook.subscription.list",
            Tier::Query,
        ),
        OperationSpec::new::<HookDeliveryListRequest, HookDeliveryList>(
            "hook.delivery.list",
            Tier::Query,
        ),
        OperationSpec::new::<HookDeliveryInspectRequest, HookDeliveryReply>(
            "hook.delivery.inspect",
            Tier::Query,
        ),
        // Sending a delivery again is an external effect: the receipt makes a
        // repeated retry with the same operation ID return the first result
        // instead of queueing another send.
        OperationSpec::new::<HookDeliveryRetryRequest, HookDeliveryReply>(
            "hook.delivery.retry",
            Tier::EffectCommand,
        ),
        // Abandoning converges: an abandoned delivery stays abandoned.
        OperationSpec::new::<HookDeliveryAbandonRequest, HookDeliveryReply>(
            "hook.delivery.abandon",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// The largest `hook.delivery.list` page.
pub const LIST_MAX: u32 = 200;

/// A lifecycle event a plugin can subscribe to. Every event fires after the
/// state change it describes has committed.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
pub enum HookEvent {
    /// A Conversation turn ended: completed, interrupted, failed, or lost
    /// across a daemon restart (`outcome: unknown`).
    #[serde(rename = "turn.settled")]
    TurnSettled,
    /// The daemon recorded a new workspace.
    #[serde(rename = "workspace.created")]
    WorkspaceCreated,
    /// A worktree lifecycle `create` succeeded.
    #[serde(rename = "worktree.created")]
    WorktreeCreated,
    /// A worktree lifecycle `remove` succeeded.
    #[serde(rename = "worktree.removed")]
    WorktreeRemoved,
    /// A workspace service run was reserved (`starting`) or released (`stopped`).
    #[serde(rename = "service.state_changed")]
    ServiceStateChanged,
}

impl HookEvent {
    pub const ALL: [HookEvent; 5] = [
        HookEvent::TurnSettled,
        HookEvent::WorkspaceCreated,
        HookEvent::WorktreeCreated,
        HookEvent::WorktreeRemoved,
        HookEvent::ServiceStateChanged,
    ];

    /// The wire name, as the manifest spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            HookEvent::TurnSettled => "turn.settled",
            HookEvent::WorkspaceCreated => "workspace.created",
            HookEvent::WorktreeCreated => "worktree.created",
            HookEvent::WorktreeRemoved => "worktree.removed",
            HookEvent::ServiceStateChanged => "service.state_changed",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|event| event.as_str() == name)
    }
}

/// Where a delivery is in its lifecycle.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum HookDeliveryStatus {
    /// Committed and never sent, because no plugin host is available. It is
    /// sent when a host becomes available.
    AwaitingHost,
    /// Ready to send at `next_attempt_at`. It has never reached the plugin's
    /// handler, so sending it is safe.
    Queued,
    /// Durably claimed and handed to the plugin host; no answer yet.
    Dispatching,
    /// The plugin host reported that the handler completed.
    Delivered,
    /// The handler ran and reported an error. Only an explicit retry sends it again.
    Failed,
    /// The delivery was sent but its outcome was lost, for example across a
    /// daemon restart. The effect may or may not have happened. It is never
    /// sent again without an explicit retry that acknowledges this.
    Unknown,
    /// An operator gave up on it. It is never sent again.
    Abandoned,
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// `hook.subscription.list`: the active subscriptions the outbox uses.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookSubscriptionListRequest {}

/// `hook.delivery.list`: deliveries in commit order, oldest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct HookDeliveryListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<HookDeliveryStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    /// Return deliveries after this sequence; the previous page's `next_after`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    /// 1 to 200; 50 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `hook.delivery.inspect`: one delivery by its effect ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookDeliveryInspectRequest {
    pub effect_id: String,
}

/// `hook.delivery.retry`: queue a failed or unknown delivery to be sent again
/// with the same effect ID. A delivered, abandoned or pending delivery is refused.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookDeliveryRetryRequest {
    pub operation_id: String,
    pub effect_id: String,
    /// Required to retry an `unknown` delivery: the caller accepts that the
    /// plugin may see the same effect twice.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub acknowledge_unknown: bool,
}

/// `hook.delivery.abandon`: stop a delivery that is not in flight.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookDeliveryAbandonRequest {
    pub effect_id: String,
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

wire_tag!(HookSubscriptionsTag, "hook_subscriptions");
wire_tag!(HookDeliveriesTag, "hook_deliveries");
wire_tag!(HookDeliveryTag, "hook_delivery");

/// One plugin's subscription to one event, from its live activation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct HookSubscription {
    pub plugin_id: String,
    pub event: HookEvent,
    /// The activation generation that declared it.
    pub activation_generation: u64,
}

/// The `hook.subscription.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookSubscriptionList {
    #[serde(rename = "type")]
    pub tag: HookSubscriptionsTag,
    pub subscriptions: Vec<HookSubscription>,
}

/// Whether a plugin host can take deliveries now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct HookHostStatus {
    pub available: bool,
    /// Why deliveries are waiting, when the host is unavailable.
    pub detail: Option<String>,
}

/// One hook delivery.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct HookDelivery {
    /// Stable for the life of the delivery and across retries. The plugin
    /// receives it with every send.
    pub effect_id: String,
    /// Commit order in the outbox.
    pub sequence: u64,
    pub plugin_id: String,
    pub event: HookEvent,
    /// The plugin's activation generation when the event committed.
    pub activation_generation: u64,
    /// The event's facts, as the plugin receives them.
    #[schemars(with = "Value")]
    pub payload: Value,
    pub status: HookDeliveryStatus,
    /// How many times it was handed to a plugin host.
    pub attempts: u32,
    pub created_at: i64,
    pub updated_at: i64,
    /// The earliest time the dispatcher sends a queued delivery.
    pub next_attempt_at: i64,
    /// The last error the host or the daemon recorded.
    pub error: Option<String>,
}

/// The `hook.delivery.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookDeliveryList {
    #[serde(rename = "type")]
    pub tag: HookDeliveriesTag,
    pub deliveries: Vec<HookDelivery>,
    /// Pass as `after` for the next page; null on the last page.
    pub next_after: Option<u64>,
    pub host: HookHostStatus,
}

/// The `hook.delivery.inspect`, `hook.delivery.retry` and `hook.delivery.abandon` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HookDeliveryReply {
    #[serde(rename = "type")]
    pub tag: HookDeliveryTag,
    pub delivery: HookDelivery,
}

// ---------------------------------------------------------------------------
// Plugin host protocol
// ---------------------------------------------------------------------------

/// What the daemon hands a plugin host for one send. Not a daemon operation:
/// the backend plugin host receives it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct HookDispatch {
    pub effect_id: String,
    pub plugin_id: String,
    pub event: HookEvent,
    #[schemars(with = "Value")]
    pub payload: Value,
    /// 1 on the first send; higher after an explicit retry.
    pub attempt: u32,
}

/// What a plugin host answers for one send.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum HookVerdict {
    /// The handler completed.
    Delivered,
    /// The host proves the handler never started, for example because the
    /// plugin is not active. The delivery may be sent again later.
    NotStarted { reason: String },
    /// The handler ran and reported an error.
    Failed { error: String },
    /// The host cannot say what happened.
    Unknown { detail: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_names_match_their_serde_form() {
        for event in HookEvent::ALL {
            assert_eq!(serde_json::to_value(event).unwrap(), json!(event.as_str()));
            assert_eq!(HookEvent::parse(event.as_str()), Some(event));
        }
        assert!(serde_json::from_value::<HookEvent>(json!("turn.started")).is_err());
    }

    #[test]
    fn operations_declare_their_tiers() {
        let tiers: Vec<_> = operations()
            .iter()
            .map(|spec| (spec.name, spec.tier))
            .collect();
        assert_eq!(
            tiers,
            [
                ("hook.subscription.list", Tier::Query),
                ("hook.delivery.list", Tier::Query),
                ("hook.delivery.inspect", Tier::Query),
                ("hook.delivery.retry", Tier::EffectCommand),
                ("hook.delivery.abandon", Tier::IdempotentCommand),
            ]
        );
    }

    #[test]
    fn verdicts_are_tagged_by_outcome() {
        let verdict: HookVerdict =
            serde_json::from_value(json!({"outcome": "failed", "error": "boom"})).unwrap();
        assert_eq!(
            verdict,
            HookVerdict::Failed {
                error: "boom".into()
            }
        );
    }
}
