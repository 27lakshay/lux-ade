//! Scheduler and lifecycle intervals. Only an explicit debug daemon opt-in
//! selects the fixed acceptance preset; release daemons refuse that control.
use std::{sync::OnceLock, time::Duration};

const CONTROL: &str = "ADE_E2E_TIMING_POLICY";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub receipt_first_delay_ms: i64,
    pub receipt_tick: Duration,
    pub plugin_activate: Duration,
    pub plugin_deactivate: Duration,
    pub plugin_drain_ms: i64,
}

pub const PRODUCTION: Policy = Policy {
    receipt_first_delay_ms: crate::retention::PRUNE_FIRST_DELAY_MS,
    receipt_tick: Duration::from_secs(30),
    plugin_activate: Duration::from_secs(15),
    plugin_deactivate: Duration::from_secs(5),
    plugin_drain_ms: crate::plugins::dev::DRAIN_GRACE_MS,
};

const ACCEPTANCE: Policy = Policy {
    receipt_first_delay_ms: 5_000,
    receipt_tick: Duration::from_millis(100),
    plugin_activate: Duration::from_secs(5),
    plugin_deactivate: Duration::from_secs(1),
    plugin_drain_ms: 2_000,
};

static SELECTED: OnceLock<Policy> = OnceLock::new();

fn select(value: Option<&str>, debug: bool) -> anyhow::Result<Policy> {
    match value {
        None => Ok(PRODUCTION),
        Some(_) if !debug => anyhow::bail!("{CONTROL} is forbidden in a release daemon"),
        Some("short") => Ok(ACCEPTANCE),
        Some(_) => anyhow::bail!("{CONTROL} must be short when explicitly enabled"),
    }
}

/// Validate before opening stores or acquiring runtime ownership.
pub fn init() -> anyhow::Result<()> {
    let value = std::env::var_os(CONTROL);
    let policy = select(
        value.as_ref().map(|value| value.to_str().unwrap_or("")),
        cfg!(debug_assertions),
    )?;
    SELECTED
        .set(policy)
        .map_err(|_| anyhow::anyhow!("Timing policy already initialized"))
}

pub fn policy() -> Policy {
    SELECTED.get().copied().unwrap_or(PRODUCTION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_defaults_and_release_refusal() {
        assert_eq!(select(None, true).unwrap(), PRODUCTION);
        assert_eq!(select(None, false).unwrap(), PRODUCTION);
        assert_eq!(PRODUCTION.receipt_first_delay_ms, 60_000);
        assert_eq!(PRODUCTION.receipt_tick, Duration::from_secs(30));
        assert_eq!(PRODUCTION.plugin_activate, Duration::from_secs(15));
        assert_eq!(PRODUCTION.plugin_deactivate, Duration::from_secs(5));
        assert_eq!(PRODUCTION.plugin_drain_ms, 15_000);
        for value in ["short", "", "0", "arbitrary"] {
            assert!(select(Some(value), false).is_err());
        }
    }

    #[test]
    fn debug_opt_in_is_fixed_and_bounded() {
        let selected = select(Some("short"), true).unwrap();
        assert_eq!(selected, ACCEPTANCE);
        for value in ["", "0", "-1", "arbitrary"] {
            assert!(select(Some(value), true).is_err());
        }
        assert!(selected.receipt_first_delay_ms > 0);
        assert!(selected.receipt_first_delay_ms < PRODUCTION.receipt_first_delay_ms);
        assert!(selected.receipt_tick > Duration::ZERO);
        assert!(selected.receipt_tick < PRODUCTION.receipt_tick);
        assert!(selected.plugin_activate > Duration::ZERO);
        assert!(selected.plugin_activate < PRODUCTION.plugin_activate);
        assert!(selected.plugin_deactivate > Duration::ZERO);
        assert!(selected.plugin_deactivate < PRODUCTION.plugin_deactivate);
        assert!(selected.plugin_drain_ms > 0);
        assert!(selected.plugin_drain_ms < PRODUCTION.plugin_drain_ms);
    }
}
