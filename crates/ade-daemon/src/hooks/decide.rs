//! The hook delivery state machine, as pure functions.
//!
//! ```text
//! awaiting_host <-> queued -> dispatching -> delivered
//!                     ^           |  |  \--> failed  --(retry)--> queued
//!                     |           |  \-----> unknown --(retry + acknowledge)--> queued
//!                     +-----------+ not started (backoff)
//! queued | awaiting_host | failed | unknown --(abandon)--> abandoned
//! ```
//!
//! Only a delivery that provably never reached the handler is sent again
//! without an operator: `queued`, `awaiting_host`, and a `not_started`
//! verdict. A lost outcome becomes `unknown` and waits for a person.
use ade_core::contract::hooks::{HookDeliveryStatus as Status, HookVerdict};

/// The longest wait between sends of a delivery the host did not start.
pub const MAX_BACKOFF_MS: i64 = 5 * 60 * 1000;

/// The wait before sending again after `attempts` sends the host did not start.
pub fn backoff_ms(attempts: u32) -> i64 {
    (1000_i64 << attempts.min(12)).min(MAX_BACKOFF_MS)
}

pub fn name(status: Status) -> &'static str {
    match status {
        Status::AwaitingHost => "awaiting_host",
        Status::Queued => "queued",
        Status::Dispatching => "dispatching",
        Status::Delivered => "delivered",
        Status::Failed => "failed",
        Status::Unknown => "unknown",
        Status::Abandoned => "abandoned",
    }
}

/// How host availability moves a delivery that was never sent.
pub fn on_host(status: Status, available: bool) -> Option<Status> {
    match (status, available) {
        (Status::Queued, false) => Some(Status::AwaitingHost),
        (Status::AwaitingHost, true) => Some(Status::Queued),
        _ => None,
    }
}

/// Whether the dispatcher may claim the delivery for a send.
pub fn claimable(status: Status) -> bool {
    status == Status::Queued
}

/// Where a host verdict moves a claimed delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub status: Status,
    pub error: Option<String>,
    /// For a delivery sent back to `queued`: how long to wait first.
    pub retry_after_ms: Option<i64>,
}

/// Applies a host verdict. Only a claimed (`dispatching`) delivery takes one;
/// any other status means the verdict is stale and is refused.
pub fn settle(status: Status, verdict: &HookVerdict, attempts: u32) -> Result<Settlement, String> {
    if status != Status::Dispatching {
        return Err(format!(
            "A {} delivery cannot take a host verdict",
            name(status)
        ));
    }
    Ok(match verdict {
        HookVerdict::Delivered => Settlement {
            status: Status::Delivered,
            error: None,
            retry_after_ms: None,
        },
        HookVerdict::NotStarted { reason } => Settlement {
            status: Status::Queued,
            error: Some(reason.clone()),
            retry_after_ms: Some(backoff_ms(attempts)),
        },
        HookVerdict::Failed { error } => Settlement {
            status: Status::Failed,
            error: Some(error.clone()),
            retry_after_ms: None,
        },
        HookVerdict::Unknown { detail } => Settlement {
            status: Status::Unknown,
            error: Some(detail.clone()),
            retry_after_ms: None,
        },
    })
}

/// Where a daemon start moves a delivery. A send in flight when the daemon
/// stopped has an unknown outcome.
pub fn recover(status: Status) -> Option<Status> {
    (status == Status::Dispatching).then_some(Status::Unknown)
}

/// Where an explicit retry moves a delivery, or why it is refused.
pub fn retry(status: Status, acknowledge_unknown: bool) -> Result<Status, String> {
    match status {
        Status::Failed => Ok(Status::Queued),
        Status::Unknown if acknowledge_unknown => Ok(Status::Queued),
        Status::Unknown => Err(
            "The outcome of this delivery is unknown: the plugin may already \
             have applied it. Retry with acknowledge_unknown to send it again with the same \
             effect ID"
                .into(),
        ),
        Status::Delivered => Err("This delivery was already delivered".into()),
        Status::Abandoned => Err("This delivery was abandoned".into()),
        Status::Queued | Status::AwaitingHost | Status::Dispatching => Err(format!(
            "This delivery is still {}; it needs no retry",
            name(status)
        )),
    }
}

/// Where abandoning moves a delivery: `None` when it is already abandoned.
pub fn abandon(status: Status) -> Result<Option<Status>, String> {
    match status {
        Status::Abandoned => Ok(None),
        Status::Queued | Status::AwaitingHost | Status::Failed | Status::Unknown => {
            Ok(Some(Status::Abandoned))
        }
        Status::Dispatching => {
            Err("This delivery is in flight; inspect it again after the host answers".into())
        }
        Status::Delivered => Err("This delivery was already delivered".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Status; 7] = [
        Status::AwaitingHost,
        Status::Queued,
        Status::Dispatching,
        Status::Delivered,
        Status::Failed,
        Status::Unknown,
        Status::Abandoned,
    ];

    #[test]
    fn names_match_the_wire_form() {
        for status in ALL {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(name(status))
            );
        }
    }

    #[test]
    fn only_unsent_deliveries_follow_host_availability() {
        assert_eq!(on_host(Status::Queued, false), Some(Status::AwaitingHost));
        assert_eq!(on_host(Status::AwaitingHost, true), Some(Status::Queued));
        for status in ALL {
            if !matches!(status, Status::Queued | Status::AwaitingHost) {
                assert_eq!(on_host(status, false), None, "{status:?}");
                assert_eq!(on_host(status, true), None, "{status:?}");
            }
        }
        assert_eq!(
            ALL.into_iter()
                .filter(|s| claimable(*s))
                .collect::<Vec<_>>(),
            [Status::Queued]
        );
    }

    #[test]
    fn verdicts_settle_only_a_claimed_delivery() {
        let failed = HookVerdict::Failed {
            error: "boom".into(),
        };
        assert_eq!(
            settle(Status::Dispatching, &HookVerdict::Delivered, 1)
                .unwrap()
                .status,
            Status::Delivered
        );
        assert_eq!(
            settle(Status::Dispatching, &failed, 1).unwrap(),
            Settlement {
                status: Status::Failed,
                error: Some("boom".into()),
                retry_after_ms: None
            }
        );
        let lost = HookVerdict::Unknown {
            detail: "timeout".into(),
        };
        assert_eq!(
            settle(Status::Dispatching, &lost, 1).unwrap().status,
            Status::Unknown
        );
        let not_started = HookVerdict::NotStarted {
            reason: "inactive".into(),
        };
        assert_eq!(
            settle(Status::Dispatching, &not_started, 3).unwrap(),
            Settlement {
                status: Status::Queued,
                error: Some("inactive".into()),
                retry_after_ms: Some(8000)
            }
        );
        for status in ALL.into_iter().filter(|s| *s != Status::Dispatching) {
            assert!(
                settle(status, &HookVerdict::Delivered, 1).is_err(),
                "{status:?}"
            );
        }
    }

    #[test]
    fn a_send_in_flight_at_restart_becomes_unknown_and_nothing_else_moves() {
        assert_eq!(recover(Status::Dispatching), Some(Status::Unknown));
        for status in ALL.into_iter().filter(|s| *s != Status::Dispatching) {
            assert_eq!(recover(status), None, "{status:?}");
        }
    }

    #[test]
    fn unknown_outcomes_never_resend_without_acknowledgement() {
        assert_eq!(retry(Status::Failed, false), Ok(Status::Queued));
        assert!(
            retry(Status::Unknown, false)
                .unwrap_err()
                .contains("acknowledge_unknown")
        );
        assert_eq!(retry(Status::Unknown, true), Ok(Status::Queued));
        for status in [
            Status::Delivered,
            Status::Abandoned,
            Status::Queued,
            Status::AwaitingHost,
            Status::Dispatching,
        ] {
            assert!(retry(status, true).is_err(), "{status:?}");
        }
        // Nothing the dispatcher does on its own leaves unknown or failed.
        for status in [Status::Unknown, Status::Failed] {
            assert!(!claimable(status));
            assert_eq!(on_host(status, true), None);
            assert_eq!(recover(status), None);
        }
    }

    #[test]
    fn abandon_converges_and_never_touches_a_send_in_flight() {
        assert_eq!(abandon(Status::Abandoned), Ok(None));
        for status in [
            Status::Queued,
            Status::AwaitingHost,
            Status::Failed,
            Status::Unknown,
        ] {
            assert_eq!(abandon(status), Ok(Some(Status::Abandoned)), "{status:?}");
        }
        assert!(abandon(Status::Dispatching).is_err());
        assert!(abandon(Status::Delivered).is_err());
    }

    #[test]
    fn backoff_doubles_to_a_ceiling() {
        assert_eq!(backoff_ms(0), 1000);
        assert_eq!(backoff_ms(1), 2000);
        assert_eq!(backoff_ms(8), 256_000);
        assert_eq!(backoff_ms(9), MAX_BACKOFF_MS);
        assert_eq!(backoff_ms(u32::MAX), MAX_BACKOFF_MS);
    }
}
