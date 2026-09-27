//! Usage analytics and provider-reported limits (F049, F030).
//!
//! The daemon records the token, cost and rate-limit figures that providers
//! report in their protocol events, one record per turn, with provenance.
//! A figure the provider did not report is `null`, never zero, and every
//! aggregate states how many turns it could not count. Costs are the agent's
//! own estimates from list prices, never a billing statement.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<UsageSummaryRequest, UsageSummary>("usage.summary", Tier::Query),
        OperationSpec::new::<UsageTurnsRequest, UsageTurns>("usage.turns", Tier::Query),
        OperationSpec::new::<UsageLimitsRequest, UsageLimits>("usage.limits", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// The dimension `usage.summary` groups turns by.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UsageGroupBy {
    Conversation,
    Workspace,
    Provider,
    /// A null key groups turns that ran on the provider's own login rather
    /// than a managed account.
    Account,
    /// The calendar day the turn was first observed, shifted by
    /// `utc_offset_minutes`, as `YYYY-MM-DD`.
    Day,
}

/// Which agents a turn's figures cover.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UsageScope {
    /// Only the conversation's own agent; subagent and helper calls are excluded.
    MainAgent,
    /// The agent and every subagent or internal call the provider counted.
    AllAgents,
}

/// Where a cost figure came from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CostBasis {
    /// The agent priced its own calls from list prices. Not a billing statement.
    AgentEstimate,
}

/// Token counts for one turn. `input` counts every prompt token, including
/// tokens read from or written to the prompt cache; `cached_input` and
/// `cache_write` are parts of it. `reasoning` is part of `output`. A null
/// field was not reported by the provider.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageTokens {
    pub input: Option<u64>,
    pub cached_input: Option<u64>,
    pub cache_write: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
}

/// Shared filters for usage queries. Times are milliseconds since the Unix
/// epoch and apply to when the daemon first observed each turn.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct UsageFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Inclusive lower bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    /// Exclusive upper bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

/// `usage.summary`: aggregate recorded turns by one dimension.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageSummaryRequest {
    pub group_by: UsageGroupBy,
    #[serde(flatten)]
    pub filter: UsageFilter,
    /// Shifts day boundaries for `group_by: day`, from -840 to 840; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utc_offset_minutes: Option<i32>,
}

/// `usage.turns`: one page of per-turn records, most recently observed first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageTurnsRequest {
    #[serde(flatten)]
    pub filter: UsageFilter,
    /// The `next_cursor` of the previous page for the same filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, 1 to 100; the daemon uses 50 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `usage.limits`: the latest rate-limit windows each provider reported.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageLimitsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

wire_tag!(UsageSummaryTag, "usage_summary");
wire_tag!(UsageTurnsTag, "usage_turns");
wire_tag!(UsageLimitsTag, "usage_limits");

/// A token total over a group of turns.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageMeasure {
    /// The sum over turns that reported this figure; null when none did.
    pub value: Option<u64>,
    pub reported_turns: u64,
    /// Turns in the group that did not report this figure. The value is
    /// complete only when this is 0.
    pub unreported_turns: u64,
}

/// A cost total over a group of turns.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
pub struct UsageCostMeasure {
    /// US dollars summed over turns that reported a cost; null when none did.
    // A plain JSON number: the bundle does not strip schemars' `double` format.
    #[schemars(with = "Option<serde_json::Number>")]
    pub value_usd: Option<f64>,
    pub basis: Vec<CostBasis>,
    pub reported_turns: u64,
    pub unreported_turns: u64,
}

/// Aggregated figures for one group.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
pub struct UsageGroup {
    /// The group's ID or day. Null in the `total` row, and for turns without
    /// a managed account when grouping by account.
    pub key: Option<String>,
    pub turns: u64,
    /// Turns still running, whose figures may grow.
    pub open_turns: u64,
    /// Turns for which the provider reported nothing at all.
    pub unreported_turns: u64,
    pub input: UsageMeasure,
    pub cached_input: UsageMeasure,
    pub cache_write: UsageMeasure,
    pub output: UsageMeasure,
    pub reasoning: UsageMeasure,
    pub cost: UsageCostMeasure,
    /// The scopes the counted figures cover. More than one means the group
    /// mixes figures that include subagents with figures that do not.
    pub scopes: Vec<UsageScope>,
}

/// Whether the daemon could record every report it received since it started.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct UsageRecording {
    /// Event batches whose usage could not be saved since the daemon started.
    /// Their turns are missing from every figure.
    pub dropped_batches: u64,
    pub last_error: Option<String>,
}

/// The `usage.summary` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageSummary {
    #[serde(rename = "type")]
    pub tag: UsageSummaryTag,
    pub group_by: UsageGroupBy,
    pub groups: Vec<UsageGroup>,
    pub total: UsageGroup,
    pub recording: UsageRecording,
}

/// One turn's recorded usage and its provenance.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct UsageTurn {
    pub conversation_id: String,
    pub turn_id: String,
    pub workspace_id: String,
    pub provider: String,
    /// The managed account the turn ran on; null for the provider's own login.
    pub account_id: Option<String>,
    /// When the daemon first observed the turn, in milliseconds since the Unix epoch.
    pub observed_at: i64,
    pub updated_at: i64,
    pub finished: bool,
    /// False when the provider reported nothing for this turn.
    pub reported: bool,
    pub tokens: UsageTokens,
    // A plain JSON number: the bundle does not strip schemars' `double` format.
    #[schemars(with = "Option<serde_json::Number>")]
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<CostBasis>,
    pub scope: Option<UsageScope>,
    pub models: Vec<String>,
    /// The native event the figures came from, such as `thread/tokenUsage/updated`.
    pub source: Option<String>,
    /// Why a figure is partial or unavailable, when the daemon knows.
    pub note: Option<String>,
}

/// The `usage.turns` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageTurns {
    #[serde(rename = "type")]
    pub tag: UsageTurnsTag,
    pub turns: Vec<UsageTurn>,
    /// Null when no more records remain.
    pub next_cursor: Option<String>,
    pub recording: UsageRecording,
}

/// One rate-limit window as the provider last reported it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct UsageLimitWindow {
    pub provider: String,
    /// Null for the provider's own login.
    pub account_id: Option<String>,
    /// The provider's name for the window, such as `five_hour` or `codex:primary`.
    pub limit_id: String,
    /// 0 to 100. Null when the latest report did not include it.
    // A plain JSON number: the bundle does not strip schemars' `double` format.
    #[schemars(with = "Option<serde_json::Number>")]
    pub used_percent: Option<f64>,
    pub window_minutes: Option<u64>,
    /// Milliseconds since the Unix epoch.
    pub resets_at: Option<i64>,
    /// The provider's own status word, such as `allowed_warning` or `rejected`.
    pub status: Option<String>,
    pub plan: Option<String>,
    /// When the daemon received this report. Limits are only as fresh as the
    /// provider's last report; no probe runs between turns.
    pub observed_at: i64,
    pub source: String,
    /// True when `resets_at` has passed, so `used_percent` is out of date.
    pub reset_since_observed: bool,
}

/// The `usage.limits` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct UsageLimits {
    #[serde(rename = "type")]
    pub tag: UsageLimitsTag,
    pub windows: Vec<UsageLimitWindow>,
    pub recording: UsageRecording,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
        )
    }

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn measure(value: Option<u64>, reported: u64, unreported: u64) -> Value {
        json!({"value": value, "reported_turns": reported, "unreported_turns": unreported})
    }

    fn group(key: Option<&str>) -> Value {
        json!({"key": key, "turns": 3, "open_turns": 1, "unreported_turns": 1,
            "input": measure(Some(120), 2, 1), "cached_input": measure(Some(40), 2, 1),
            "cache_write": measure(None, 0, 3), "output": measure(Some(30), 2, 1),
            "reasoning": measure(Some(5), 1, 2),
            "cost": {"value_usd": 0.25, "basis": ["agent_estimate"], "reported_turns": 1,
                "unreported_turns": 2},
            "scopes": ["main_agent", "all_agents"]})
    }

    fn recording() -> Value {
        json!({"dropped_batches": 0, "last_error": null})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<UsageSummaryRequest>(
            "usage.summary",
            json!({"op": "usage.summary", "group_by": "provider"}),
        );
        request::<UsageSummaryRequest>(
            "usage.summary",
            json!({"op": "usage.summary", "group_by": "day", "workspace_id": "w",
                "provider": "codex", "account_id": "a", "conversation_id": "c",
                "since": 1_700_000_000_000_i64, "until": 1_700_100_000_000_i64,
                "utc_offset_minutes": -300}),
        );
        request::<UsageTurnsRequest>("usage.turns", json!({"op": "usage.turns"}));
        request::<UsageTurnsRequest>(
            "usage.turns",
            json!({"op": "usage.turns", "provider": "claude", "cursor": "1.2", "limit": 10}),
        );
        request::<UsageLimitsRequest>("usage.limits", json!({"op": "usage.limits"}));
        request::<UsageLimitsRequest>(
            "usage.limits",
            json!({"op": "usage.limits", "provider": "codex", "account_id": "a"}),
        );
        let (name, _) = names("usage.summary");
        assert!(!valid(&name, &json!({"op": "usage.summary"})));
        assert!(!valid(
            &name,
            &json!({"op": "usage.summary", "group_by": "model"})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "usage.summary", "group_by": "day", "extra": 1})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<UsageSummary>(
            "usage.summary",
            json!({"type": "usage_summary", "group_by": "account",
                "groups": [group(Some("account-1")), group(None)], "total": group(None),
                "recording": recording()}),
        );
        response::<UsageTurns>(
            "usage.turns",
            json!({"type": "usage_turns", "turns": [{
                "conversation_id": "c", "turn_id": "t", "workspace_id": "w",
                "provider": "codex", "account_id": null, "observed_at": 1, "updated_at": 2,
                "finished": true, "reported": true,
                "tokens": {"input": 10, "cached_input": 4, "cache_write": null, "output": 3,
                    "reasoning": 1},
                "cost_usd": null, "cost_basis": null, "scope": "main_agent", "models": [],
                "source": "thread/tokenUsage/updated", "note": null,
            }], "next_cursor": null, "recording": recording()}),
        );
        response::<UsageLimits>(
            "usage.limits",
            json!({"type": "usage_limits", "windows": [{
                "provider": "claude", "account_id": "a", "limit_id": "five_hour",
                "used_percent": 42.0, "window_minutes": 300, "resets_at": 1_700_000_000_000_i64,
                "status": "allowed", "plan": null, "observed_at": 1, "source": "rate_limit_event",
                "reset_since_observed": false,
            }], "recording": {"dropped_batches": 2, "last_error": "disk full"}}),
        );
    }
}
