//! Pure usage decisions: turning native provider reports into per-turn
//! figures, merging reports into a turn, and aggregating turns. Nothing here
//! touches SQLite. A figure a provider did not report stays `None` through
//! every step; aggregates count such turns instead of treating them as zero.
//!
//! Portions adapted from t3code `apps/server/src/provider/Layers/CodexAdapter.ts`
//! (Codex per-turn token deltas) and `claudeUsageLimits.ts` (units of Claude's
//! `rate_limit_event`), MIT, © 2026 T3 Tools Inc.
use ade_core::contract::usage::{
    CostBasis, UsageGroup, UsageGroupBy, UsageMeasure, UsageScope, UsageTokens,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// One turn's figures, stored as JSON on the turn's record.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Figures {
    pub tokens: UsageTokens,
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<CostBasis>,
    pub scope: Option<UsageScope>,
    #[serde(default)]
    pub models: Vec<String>,
    pub note: Option<String>,
}

/// A provider's running totals, kept between reports so the next report can
/// be turned into a per-turn delta. `stream` names the counter's lifetime; a
/// total from another stream is never subtracted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Baseline {
    pub stream: String,
    pub tokens: UsageTokens,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merge {
    /// The report covers the whole turn so far.
    Replace,
    /// The report covers one more model call in the turn.
    Add,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnReport {
    pub figures: Figures,
    pub merge: Merge,
    pub baseline: Option<Baseline>,
}

/// One rate-limit window from a report. Fields the report left out are `None`.
#[derive(Clone, Debug, PartialEq)]
pub struct LimitReport {
    pub limit_id: String,
    pub used_percent: Option<f64>,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<i64>,
    pub status: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decoded {
    Turn(Box<TurnReport>),
    Limits(Vec<LimitReport>),
    /// The report carried no usable figure. The turn stays unreported.
    Nothing,
}

/// Decodes one native report. `prior` is the baseline stored for this
/// conversation and `source`; `run` is the runtime run that delivered it.
pub fn decode(
    provider: &str,
    source: &str,
    report: &Value,
    run: &str,
    prior: Option<&Baseline>,
) -> Result<Decoded> {
    match (provider, source) {
        ("codex", "thread/tokenUsage/updated") => {
            codex_turn(report, run, prior).map(|t| Decoded::Turn(Box::new(t)))
        }
        ("codex", "account/rateLimits/updated") => Ok(Decoded::Limits(codex_limits(report)?)),
        ("claude", "result") => claude_turn(report, prior),
        ("claude", "rate_limit_event") => Ok(Decoded::Limits(claude_limits(report)?)),
        ("omp", "message_end") => omp_call(report),
        _ => bail!("Unknown usage source {source} for {provider}"),
    }
}

fn count(value: &Value, key: &str) -> Result<Option<u64>> {
    match &value[key] {
        Value::Null => Ok(None),
        v => v
            .as_u64()
            .map(Some)
            .with_context(|| format!("Usage field {key} is not a non-negative integer")),
    }
}

fn required(value: &Value, key: &str) -> Result<u64> {
    count(value, key)?.with_context(|| format!("Usage field {key} is missing"))
}

fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a?.checked_add(b?)
}

fn sub(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a?.checked_sub(b?)
}

fn add_tokens(a: &UsageTokens, b: &UsageTokens) -> UsageTokens {
    UsageTokens {
        input: add(a.input, b.input),
        cached_input: add(a.cached_input, b.cached_input),
        cache_write: add(a.cache_write, b.cache_write),
        output: add(a.output, b.output),
        reasoning: add(a.reasoning, b.reasoning),
    }
}

fn fields(t: &UsageTokens) -> [Option<u64>; 5] {
    [
        t.input,
        t.cached_input,
        t.cache_write,
        t.output,
        t.reasoning,
    ]
}

/// `current - prior` when no figure both report went down; `None` when the
/// counter was reset.
fn delta(current: &UsageTokens, prior: &UsageTokens) -> Option<UsageTokens> {
    let down = fields(current)
        .iter()
        .zip(fields(prior))
        .any(|(c, p)| matches!((c, p), (Some(c), Some(p)) if c < &p));
    (!down).then(|| UsageTokens {
        input: sub(current.input, prior.input),
        cached_input: sub(current.cached_input, prior.cached_input),
        cache_write: sub(current.cache_write, prior.cache_write),
        output: sub(current.output, prior.output),
        reasoning: sub(current.reasoning, prior.reasoning),
    })
}

/// Codex's `TokenUsageBreakdown`. `inputTokens` already includes cached and
/// cache-write tokens, which matches ADE's `input`.
fn codex_breakdown(value: &Value) -> Result<UsageTokens> {
    ensure!(value.is_object(), "Codex token breakdown is missing");
    Ok(UsageTokens {
        input: Some(required(value, "inputTokens")?),
        cached_input: Some(required(value, "cachedInputTokens")?),
        cache_write: count(value, "cacheWriteInputTokens")?,
        output: Some(required(value, "outputTokens")?),
        reasoning: Some(required(value, "reasoningOutputTokens")?),
    })
}

/// Codex reports the thread's running `total` and `last`, the newest model
/// response. Within one run the growth of `total` is the new usage; without a
/// baseline from the same run, or after the total went down, `last` is.
fn codex_turn(report: &Value, run: &str, prior: Option<&Baseline>) -> Result<TurnReport> {
    let total = codex_breakdown(&report["total"])?;
    let last = codex_breakdown(&report["last"])?;
    let tokens = prior
        .filter(|b| b.stream == run)
        .and_then(|b| delta(&total, &b.tokens))
        .unwrap_or(last);
    Ok(TurnReport {
        figures: Figures {
            tokens,
            scope: Some(UsageScope::MainAgent),
            ..Figures::default()
        },
        merge: Merge::Add,
        baseline: Some(Baseline {
            stream: run.into(),
            tokens: total,
            cost_usd: None,
        }),
    })
}

fn percent(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 100.0))
}

fn seconds_to_ms(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .filter(|s| *s > 0)
        .and_then(|s| s.checked_mul(1000))
}

fn string(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Codex's sparse `RateLimitSnapshot`: a null window leaves the stored one alone.
fn codex_limits(report: &Value) -> Result<Vec<LimitReport>> {
    ensure!(report.is_object(), "Codex rate-limit snapshot is missing");
    let limit = string(&report["limitId"]).unwrap_or_else(|| "codex".into());
    let mut windows = Vec::new();
    for position in ["primary", "secondary"] {
        let window = &report[position];
        if !window.is_object() {
            continue;
        }
        windows.push(LimitReport {
            limit_id: format!("{limit}:{position}"),
            used_percent: percent(window["usedPercent"].as_f64()),
            window_minutes: window["windowDurationMins"].as_u64(),
            resets_at: seconds_to_ms(&window["resetsAt"]),
            status: string(&report["rateLimitReachedType"]),
            plan: string(&report["planType"]),
        });
    }
    Ok(windows)
}

/// Claude's `SDKRateLimitInfo`: `utilization` is a 0–1 fraction and
/// `resetsAt` is in epoch seconds. The window name states its length.
fn claude_limits(report: &Value) -> Result<Vec<LimitReport>> {
    ensure!(report.is_object(), "Claude rate-limit info is missing");
    let limit_id = string(&report["rateLimitType"]).unwrap_or_else(|| "unspecified".into());
    let window_minutes = match limit_id.as_str() {
        "five_hour" => Some(300),
        id if id.starts_with("seven_day") => Some(7 * 24 * 60),
        _ => None,
    };
    Ok(vec![LimitReport {
        used_percent: percent(report["utilization"].as_f64().map(|u| u * 100.0)),
        window_minutes,
        resets_at: seconds_to_ms(&report["resetsAt"]),
        status: string(&report["status"]),
        plan: None,
        limit_id,
    }])
}

/// Sums Claude's per-model cumulative `modelUsage`. `None` when absent.
fn claude_cumulative(report: &Value) -> Result<Option<(UsageTokens, Vec<String>, bool)>> {
    let Some(models) = report["modelUsage"].as_object() else {
        return Ok(None);
    };
    if models.is_empty() {
        return Ok(None);
    }
    let mut total = UsageTokens {
        input: Some(0),
        cached_input: Some(0),
        cache_write: Some(0),
        output: Some(0),
        reasoning: Some(0),
    };
    let mut unpriced = false;
    for usage in models.values() {
        let read = required(usage, "cacheReadInputTokens")?;
        let write = required(usage, "cacheCreationInputTokens")?;
        let input = required(usage, "inputTokens")?
            .checked_add(read)
            .and_then(|v| v.checked_add(write));
        total = add_tokens(
            &total,
            &UsageTokens {
                input,
                cached_input: Some(read),
                cache_write: Some(write),
                output: Some(required(usage, "outputTokens")?),
                // Only recorded by newer CLI versions; absent means unknown.
                reasoning: count(usage, "thinkingTokens")?,
            },
        );
        unpriced |= usage["costBasis"].as_str() == Some("unknown");
    }
    Ok(Some((total, models.keys().cloned().collect(), unpriced)))
}

/// Claude's `result`. `modelUsage` and `total_cost_usd` are cumulative for one
/// `query()` call, so a turn's share is the difference from the previous
/// result of the same query. The first result of a fresh query is the turn
/// itself. Otherwise (a resumed session, or a total that went down after
/// `/clear`) only the per-turn main-loop `usage` is attributable, and cost is not.
fn claude_turn(report: &Value, prior: Option<&Baseline>) -> Result<Decoded> {
    let stream = report["query_id"]
        .as_str()
        .context("Claude result has no query ID")?;
    let cost = report["total_cost_usd"]
        .as_f64()
        .filter(|c| c.is_finite() && *c >= 0.0);
    let Some((cumulative, models, unpriced)) = claude_cumulative(report)? else {
        return claude_main_loop(report, None, "The SDK reported no per-model totals");
    };
    let baseline = Baseline {
        stream: stream.into(),
        tokens: cumulative,
        cost_usd: cost,
    };
    let same = prior.filter(|b| b.stream == stream);
    let attributed = match same {
        Some(prior) => delta(&cumulative, &prior.tokens).map(|tokens| {
            let cost = match (cost, prior.cost_usd) {
                (Some(now), Some(before)) if now >= before => Some(now - before),
                _ => None,
            };
            (tokens, cost)
        }),
        None if report["fresh"] == true && report["result_index"] == 0 => Some((cumulative, cost)),
        None => None,
    };
    let Some((tokens, cost)) = attributed else {
        let reason = if same.is_some() {
            "The SDK's running totals went down, so only this turn's main-agent tokens are known"
        } else {
            "The SDK's running totals include turns before this one, so only this turn's main-agent tokens are known"
        };
        return claude_main_loop(report, Some(baseline), reason);
    };
    let (cost, note) = if unpriced {
        (
            None,
            Some(
                "Claude Code had no price for a model, so its cost is a guess and is omitted"
                    .into(),
            ),
        )
    } else {
        (cost, None)
    };
    Ok(Decoded::Turn(Box::new(TurnReport {
        figures: Figures {
            tokens,
            cost_basis: cost.map(|_| CostBasis::AgentEstimate),
            cost_usd: cost,
            scope: Some(UsageScope::AllAgents),
            models,
            note,
        },
        merge: Merge::Replace,
        baseline: Some(baseline),
    })))
}

/// Claude's per-turn `usage` covers the main agent loop only.
fn claude_main_loop(report: &Value, baseline: Option<Baseline>, reason: &str) -> Result<Decoded> {
    let usage = &report["usage"];
    if !usage.is_object() {
        return Ok(Decoded::Nothing);
    }
    let read = count(usage, "cache_read_input_tokens")?;
    let write = count(usage, "cache_creation_input_tokens")?;
    let input = add(add(count(usage, "input_tokens")?, read), write);
    Ok(Decoded::Turn(Box::new(TurnReport {
        figures: Figures {
            tokens: UsageTokens {
                input,
                cached_input: read,
                cache_write: write,
                output: count(usage, "output_tokens")?,
                reasoning: None,
            },
            scope: Some(UsageScope::MainAgent),
            note: Some(format!("{reason}; cost is unavailable")),
            ..Figures::default()
        },
        merge: Merge::Replace,
        baseline,
    })))
}

/// One Oh My Pi model call. Its cost is priced by Oh My Pi's model catalog; a
/// zero cost for a call that used tokens means the model had no price.
fn omp_call(report: &Value) -> Result<Decoded> {
    let usage = &report["usage"];
    if !usage.is_object() {
        return Ok(Decoded::Nothing);
    }
    let read = required(usage, "cacheRead")?;
    let write = required(usage, "cacheWrite")?;
    let tokens = UsageTokens {
        input: required(usage, "input")?
            .checked_add(read)
            .and_then(|v| v.checked_add(write)),
        cached_input: Some(read),
        cache_write: Some(write),
        output: Some(required(usage, "output")?),
        reasoning: count(usage, "reasoningTokens")?,
    };
    let used = fields(&tokens).iter().flatten().any(|v| *v > 0);
    let cost = usage["cost"]["total"]
        .as_f64()
        .filter(|c| c.is_finite() && *c >= 0.0)
        .filter(|c| *c > 0.0 || !used);
    let note = (cost.is_none() && used)
        .then(|| "Oh My Pi reported no price for this model, so cost is unavailable".to_owned());
    Ok(Decoded::Turn(Box::new(TurnReport {
        figures: Figures {
            tokens,
            cost_basis: cost.map(|_| CostBasis::AgentEstimate),
            cost_usd: cost,
            scope: Some(UsageScope::MainAgent),
            models: string(&report["model"]).into_iter().collect(),
            note,
        },
        merge: Merge::Add,
        baseline: None,
    })))
}

/// Merges a report into a turn's stored figures. `reports` is how many
/// reports the turn already has; with none, the report is taken as is. Any
/// figure missing from one added report makes the turn's figure unavailable
/// rather than an undercount.
pub fn merge(existing: Option<&Figures>, reports: u64, report: &TurnReport) -> Figures {
    let new = &report.figures;
    let Some(old) = existing.filter(|_| reports > 0 && report.merge == Merge::Add) else {
        return new.clone();
    };
    let mut models = old.models.clone();
    for model in &new.models {
        if !models.contains(model) {
            models.push(model.clone());
        }
    }
    let cost = match (old.cost_usd, new.cost_usd) {
        (Some(a), Some(b)) => Some(a + b),
        _ => None,
    };
    Figures {
        tokens: add_tokens(&old.tokens, &new.tokens),
        cost_basis: cost.and(new.cost_basis.or(old.cost_basis)),
        cost_usd: cost,
        scope: if old.scope == new.scope {
            new.scope
        } else {
            None
        },
        models,
        note: new.note.clone().or_else(|| old.note.clone()),
    }
}

/// The part of a turn record that aggregation reads.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnRow {
    pub conversation_id: String,
    pub workspace_id: String,
    pub provider: String,
    pub account_id: Option<String>,
    pub observed_at: i64,
    pub finished: bool,
    /// `None` when the provider reported nothing for the turn.
    pub figures: Option<Figures>,
}

/// The largest offset any time zone uses, in minutes.
pub const MAX_UTC_OFFSET_MINUTES: i32 = 14 * 60;

/// The calendar day, `YYYY-MM-DD`, of `ms` shifted by `offset_minutes`.
pub fn day_key(ms: i64, offset_minutes: i32) -> String {
    let local = ms + i64::from(offset_minutes) * 60_000;
    let days = local.div_euclid(86_400_000);
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn key(row: &TurnRow, by: UsageGroupBy, offset_minutes: i32) -> Option<String> {
    match by {
        UsageGroupBy::Conversation => Some(row.conversation_id.clone()),
        UsageGroupBy::Workspace => Some(row.workspace_id.clone()),
        UsageGroupBy::Provider => Some(row.provider.clone()),
        UsageGroupBy::Account => row.account_id.clone(),
        UsageGroupBy::Day => Some(day_key(row.observed_at, offset_minutes)),
    }
}

fn count_into(measure: &mut UsageMeasure, value: Option<u64>) {
    match value {
        Some(v) => {
            measure.value = Some(measure.value.unwrap_or(0).saturating_add(v));
            measure.reported_turns += 1;
        }
        None => measure.unreported_turns += 1,
    }
}

fn add_row(group: &mut UsageGroup, row: &TurnRow) {
    group.turns += 1;
    group.open_turns += u64::from(!row.finished);
    let empty = Figures::default();
    let figures = row.figures.as_ref().unwrap_or(&empty);
    group.unreported_turns += u64::from(row.figures.is_none());
    let t = &figures.tokens;
    count_into(&mut group.input, t.input);
    count_into(&mut group.cached_input, t.cached_input);
    count_into(&mut group.cache_write, t.cache_write);
    count_into(&mut group.output, t.output);
    count_into(&mut group.reasoning, t.reasoning);
    match figures.cost_usd {
        Some(cost) => {
            group.cost.value_usd = Some(group.cost.value_usd.unwrap_or(0.0) + cost);
            group.cost.reported_turns += 1;
            if let Some(basis) = figures.cost_basis
                && !group.cost.basis.contains(&basis)
            {
                group.cost.basis.push(basis);
            }
        }
        None => group.cost.unreported_turns += 1,
    }
    if let Some(scope) = figures.scope
        && !group.scopes.contains(&scope)
    {
        group.scopes.push(scope);
    }
}

/// Groups turns by `by` in ascending key order (a null key first) and
/// returns the groups with their overall total.
pub fn aggregate(
    rows: &[TurnRow],
    by: UsageGroupBy,
    offset_minutes: i32,
) -> (Vec<UsageGroup>, UsageGroup) {
    let mut groups: BTreeMap<Option<String>, UsageGroup> = BTreeMap::new();
    let mut total = UsageGroup::default();
    for row in rows {
        let key = key(row, by, offset_minutes);
        add_row(
            groups.entry(key.clone()).or_insert_with(|| UsageGroup {
                key,
                ..UsageGroup::default()
            }),
            row,
        );
        add_row(&mut total, row);
    }
    (groups.into_values().collect(), total)
}

/// A `usage.turns` cursor: the last record's observation time and row ID.
pub fn encode_cursor(observed_at: i64, rowid: i64) -> String {
    format!("{observed_at}.{rowid}")
}

pub fn decode_cursor(cursor: &str) -> Result<(i64, i64)> {
    let (at, row) = cursor.split_once('.').context("Invalid usage cursor")?;
    Ok((
        at.parse().context("Invalid usage cursor")?,
        row.parse().context("Invalid usage cursor")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tokens(input: u64, cached: u64, output: u64, reasoning: u64) -> UsageTokens {
        UsageTokens {
            input: Some(input),
            cached_input: Some(cached),
            cache_write: None,
            output: Some(output),
            reasoning: Some(reasoning),
        }
    }

    fn codex(total: (u64, u64, u64, u64), last: (u64, u64, u64, u64)) -> Value {
        let b = |(i, c, o, r): (u64, u64, u64, u64)| {
            json!({"totalTokens": i + o, "inputTokens": i, "cachedInputTokens": c,
                "outputTokens": o, "reasoningOutputTokens": r})
        };
        json!({"total": b(total), "last": b(last), "modelContextWindow": 200_000})
    }

    fn turn(decoded: Decoded) -> TurnReport {
        match decoded {
            Decoded::Turn(report) => *report,
            other => panic!("expected a turn report, got {other:?}"),
        }
    }

    #[test]
    fn codex_turns_use_growth_of_the_running_total_within_one_run() {
        let first = turn(
            decode(
                "codex",
                "thread/tokenUsage/updated",
                &codex((100, 10, 20, 5), (100, 10, 20, 5)),
                "run-1",
                None,
            )
            .unwrap(),
        );
        assert_eq!(first.figures.tokens, tokens(100, 10, 20, 5));
        assert_eq!(first.merge, Merge::Add);
        let baseline = first.baseline.clone().unwrap();
        let second = turn(
            decode(
                "codex",
                "thread/tokenUsage/updated",
                &codex((250, 40, 50, 9), (140, 30, 25, 4)),
                "run-1",
                Some(&baseline),
            )
            .unwrap(),
        );
        // The total grew by more than `last`: an update was missed, and the
        // growth still counts it.
        assert_eq!(second.figures.tokens, tokens(150, 30, 30, 4));
        let merged = merge(Some(&first.figures), 1, &second);
        assert_eq!(merged.tokens, tokens(250, 40, 50, 9));
        assert_eq!(merged.scope, Some(UsageScope::MainAgent));
        assert_eq!(merged.cost_usd, None, "Codex reports no cost");
    }

    #[test]
    fn codex_falls_back_to_last_after_a_reset_or_in_a_new_run() {
        let baseline = Baseline {
            stream: "run-1".into(),
            tokens: tokens(500, 0, 100, 0),
            cost_usd: None,
        };
        let reset = turn(
            decode(
                "codex",
                "thread/tokenUsage/updated",
                &codex((30, 0, 5, 0), (30, 0, 5, 0)),
                "run-1",
                Some(&baseline),
            )
            .unwrap(),
        );
        assert_eq!(reset.figures.tokens, tokens(30, 0, 5, 0));
        let resumed = turn(
            decode(
                "codex",
                "thread/tokenUsage/updated",
                &codex((900, 0, 150, 0), (20, 0, 4, 0)),
                "run-2",
                Some(&baseline),
            )
            .unwrap(),
        );
        assert_eq!(resumed.figures.tokens, tokens(20, 0, 4, 0));
        assert_eq!(resumed.baseline.unwrap().stream, "run-2");
    }

    #[test]
    fn malformed_codex_usage_is_rejected_not_zeroed() {
        let mut report = codex((1, 0, 1, 0), (1, 0, 1, 0));
        report["last"]["outputTokens"] = json!(-3);
        assert!(decode("codex", "thread/tokenUsage/updated", &report, "r", None).is_err());
        report["last"] = Value::Null;
        assert!(decode("codex", "thread/tokenUsage/updated", &report, "r", None).is_err());
        assert!(decode("codex", "thread/other", &json!({}), "r", None).is_err());
    }

    fn claude(model_usage: Value, cost: Value, fresh: bool, index: u64) -> Value {
        json!({"usage": {"input_tokens": 3, "output_tokens": 7, "cache_read_input_tokens": 11,
                "cache_creation_input_tokens": 2},
            "modelUsage": model_usage, "total_cost_usd": cost, "is_error": false,
            "query_id": "q1", "fresh": fresh, "result_index": index})
    }

    fn model(input: u64, output: u64, read: u64, write: u64, cost: f64) -> Value {
        json!({"inputTokens": input, "outputTokens": output, "cacheReadInputTokens": read,
            "cacheCreationInputTokens": write, "webSearchRequests": 0, "costUSD": cost,
            "contextWindow": 200_000, "maxOutputTokens": 32_000})
    }

    #[test]
    fn claude_differences_cumulative_totals_within_one_query() {
        let first = turn(
            decode(
                "claude",
                "result",
                &claude(
                    json!({"opus": model(10, 5, 100, 20, 0.5)}),
                    json!(0.5),
                    true,
                    0,
                ),
                "run",
                None,
            )
            .unwrap(),
        );
        assert_eq!(
            first.figures.tokens,
            UsageTokens {
                input: Some(130),
                cached_input: Some(100),
                cache_write: Some(20),
                output: Some(5),
                reasoning: None,
            }
        );
        assert_eq!(first.figures.cost_usd, Some(0.5));
        assert_eq!(first.figures.cost_basis, Some(CostBasis::AgentEstimate));
        assert_eq!(first.figures.scope, Some(UsageScope::AllAgents));
        assert_eq!(first.merge, Merge::Replace);
        let baseline = first.baseline.unwrap();
        let second = turn(
            decode(
                "claude",
                "result",
                &claude(
                    json!({"opus": model(15, 9, 150, 20, 0.7), "haiku": model(1, 1, 0, 0, 0.05)}),
                    json!(0.75),
                    true,
                    1,
                ),
                "run",
                Some(&baseline),
            )
            .unwrap(),
        );
        assert_eq!(second.figures.tokens.input, Some(56));
        assert_eq!(second.figures.tokens.output, Some(5));
        assert!((second.figures.cost_usd.unwrap() - 0.25).abs() < 1e-9);
        assert_eq!(second.figures.models.len(), 2);
    }

    #[test]
    fn claude_resumed_or_reset_totals_fall_back_to_main_loop_without_cost() {
        let resumed = turn(
            decode(
                "claude",
                "result",
                &claude(
                    json!({"opus": model(900, 50, 0, 0, 9.0)}),
                    json!(9.0),
                    false,
                    0,
                ),
                "run",
                None,
            )
            .unwrap(),
        );
        assert_eq!(resumed.figures.scope, Some(UsageScope::MainAgent));
        assert_eq!(resumed.figures.cost_usd, None);
        assert_eq!(resumed.figures.tokens.input, Some(16));
        assert_eq!(resumed.figures.tokens.reasoning, None);
        assert!(
            resumed
                .figures
                .note
                .as_deref()
                .unwrap()
                .contains("before this one")
        );
        // The stored baseline still advances, so the next turn is attributable.
        assert_eq!(resumed.baseline.unwrap().tokens.input, Some(900));

        let prior = Baseline {
            stream: "q1".into(),
            tokens: tokens(1000, 0, 100, 0),
            cost_usd: Some(3.0),
        };
        let cleared = turn(
            decode(
                "claude",
                "result",
                &claude(
                    json!({"opus": model(10, 5, 0, 0, 0.1)}),
                    json!(0.1),
                    true,
                    4,
                ),
                "run",
                Some(&prior),
            )
            .unwrap(),
        );
        assert_eq!(cleared.figures.cost_usd, None);
        assert!(
            cleared
                .figures
                .note
                .as_deref()
                .unwrap()
                .contains("went down")
        );
    }

    #[test]
    fn claude_unpriced_models_and_missing_totals_are_marked_unavailable() {
        let mut unknown = model(10, 5, 0, 0, 0.3);
        unknown["costBasis"] = json!("unknown");
        let report = turn(
            decode(
                "claude",
                "result",
                &claude(json!({"x": unknown}), json!(0.3), true, 0),
                "run",
                None,
            )
            .unwrap(),
        );
        assert_eq!(report.figures.cost_usd, None);
        assert_eq!(report.figures.cost_basis, None);
        assert_eq!(report.figures.tokens.input, Some(10));

        let bare = json!({"usage": null, "modelUsage": null, "total_cost_usd": null,
            "query_id": "q", "fresh": true, "result_index": 0});
        assert_eq!(
            decode("claude", "result", &bare, "run", None).unwrap(),
            Decoded::Nothing
        );
    }

    #[test]
    fn omp_calls_add_up_and_a_missing_figure_poisons_the_turn_total() {
        let call = |reasoning: Value, cost: f64| {
            json!({"model": "gpt-5", "usage": {"input": 10, "output": 4, "cacheRead": 6,
                "cacheWrite": 0, "totalTokens": 20, "reasoningTokens": reasoning,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost}}})
        };
        let first = turn(decode("omp", "message_end", &call(json!(2), 0.01), "r", None).unwrap());
        assert_eq!(first.figures.tokens.input, Some(16));
        let second =
            turn(decode("omp", "message_end", &call(Value::Null, 0.0), "r", None).unwrap());
        assert_eq!(
            second.figures.cost_usd, None,
            "zero cost with tokens is unpriced"
        );
        assert!(second.figures.note.is_some());
        let merged = merge(Some(&first.figures), 1, &second);
        assert_eq!(merged.tokens.input, Some(32));
        assert_eq!(merged.tokens.output, Some(8));
        assert_eq!(merged.tokens.reasoning, None);
        assert_eq!(merged.cost_usd, None);
        assert_eq!(merged.cost_basis, None);
        assert_eq!(merged.models, vec!["gpt-5".to_owned()]);
        // A report on a turn with no earlier report is taken as is.
        assert_eq!(merge(Some(&Figures::default()), 0, &first), first.figures);
        assert_eq!(
            decode("omp", "message_end", &json!({"usage": null}), "r", None).unwrap(),
            Decoded::Nothing
        );
    }

    #[test]
    fn limits_keep_provider_units_and_omit_what_was_not_reported() {
        let Decoded::Limits(codex) = decode(
            "codex",
            "account/rateLimits/updated",
            &json!({"limitId": null, "planType": "pro",
                "primary": {"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1_700_000_000},
                "secondary": null}),
            "r",
            None,
        )
        .unwrap() else {
            panic!("limits");
        };
        assert_eq!(
            codex,
            vec![LimitReport {
                limit_id: "codex:primary".into(),
                used_percent: Some(42.0),
                window_minutes: Some(300),
                resets_at: Some(1_700_000_000_000),
                status: None,
                plan: Some("pro".into()),
            }]
        );
        let Decoded::Limits(claude) = decode(
            "claude",
            "rate_limit_event",
            &json!({"status": "allowed_warning", "rateLimitType": "seven_day",
                "utilization": 0.85, "resetsAt": 1_700_000_000}),
            "r",
            None,
        )
        .unwrap() else {
            panic!("limits");
        };
        assert!((claude[0].used_percent.unwrap() - 85.0).abs() < 1e-9);
        assert_eq!(claude[0].window_minutes, Some(10_080));
        let Decoded::Limits(bare) = decode(
            "claude",
            "rate_limit_event",
            &json!({"status": "rejected"}),
            "r",
            None,
        )
        .unwrap() else {
            panic!("limits");
        };
        assert_eq!(bare[0].used_percent, None);
        assert_eq!(bare[0].resets_at, None);
        assert_eq!(bare[0].window_minutes, None);
    }

    fn row(provider: &str, account: Option<&str>, at: i64, figures: Option<Figures>) -> TurnRow {
        TurnRow {
            conversation_id: "c".into(),
            workspace_id: "w".into(),
            provider: provider.into(),
            account_id: account.map(str::to_owned),
            observed_at: at,
            finished: true,
            figures,
        }
    }

    #[test]
    fn aggregates_count_unreported_turns_instead_of_zeroing_them() {
        let codex = Figures {
            tokens: tokens(100, 10, 20, 5),
            scope: Some(UsageScope::MainAgent),
            ..Figures::default()
        };
        let claude = Figures {
            tokens: UsageTokens {
                input: Some(50),
                cached_input: Some(0),
                cache_write: Some(4),
                output: Some(8),
                reasoning: None,
            },
            cost_usd: Some(0.2),
            cost_basis: Some(CostBasis::AgentEstimate),
            scope: Some(UsageScope::AllAgents),
            ..Figures::default()
        };
        let mut open = row("codex", Some("a1"), 1, Some(codex.clone()));
        open.finished = false;
        let rows = vec![
            open,
            row("codex", Some("a1"), 2, Some(codex)),
            row("claude", None, 3, Some(claude)),
            row("plugin:ade.opencode", None, 4, None),
        ];
        let (groups, total) = aggregate(&rows, UsageGroupBy::Provider, 0);
        let keys: Vec<_> = groups.iter().map(|g| g.key.clone().unwrap()).collect();
        assert_eq!(keys, ["claude", "codex", "plugin:ade.opencode"]);
        let plugin = &groups[2];
        assert_eq!(plugin.unreported_turns, 1);
        assert_eq!(plugin.input.value, None);
        assert_eq!(plugin.input.unreported_turns, 1);
        assert_eq!(plugin.cost.value_usd, None);
        assert_eq!(total.turns, 4);
        assert_eq!(total.open_turns, 1);
        assert_eq!(total.unreported_turns, 1);
        assert_eq!(
            total.input,
            UsageMeasure {
                value: Some(250),
                reported_turns: 3,
                unreported_turns: 1
            }
        );
        assert_eq!(total.cache_write.value, Some(4));
        assert_eq!(total.cache_write.unreported_turns, 3);
        assert_eq!(total.reasoning.value, Some(10));
        assert_eq!(total.cost.value_usd, Some(0.2));
        assert_eq!(total.cost.reported_turns, 1);
        assert_eq!(total.cost.unreported_turns, 3);
        assert_eq!(total.cost.basis, vec![CostBasis::AgentEstimate]);
        assert_eq!(total.scopes.len(), 2);

        let (accounts, _) = aggregate(&rows, UsageGroupBy::Account, 0);
        assert_eq!(accounts[0].key, None);
        assert_eq!(accounts[0].turns, 2);
        assert_eq!(accounts[1].key.as_deref(), Some("a1"));
        let (none, empty) = aggregate(&[], UsageGroupBy::Day, 0);
        assert!(none.is_empty());
        assert_eq!(empty.input.value, None);
    }

    #[test]
    fn days_follow_the_requested_offset() {
        // 2023-11-14T22:13:20Z
        let at = 1_700_000_000_000;
        assert_eq!(day_key(at, 0), "2023-11-14");
        assert_eq!(day_key(at, 120), "2023-11-15");
        assert_eq!(day_key(0, -1), "1969-12-31");
        assert_eq!(day_key(951_782_400_000, 0), "2000-02-29");
        let rows = [
            row("codex", None, at, None),
            row("codex", None, at + 3_600_000, None),
        ];
        let (groups, _) = aggregate(&rows, UsageGroupBy::Day, 60);
        let keys: Vec<_> = groups.iter().map(|g| g.key.clone().unwrap()).collect();
        assert_eq!(keys, ["2023-11-14", "2023-11-15"]);
    }

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        assert_eq!(decode_cursor(&encode_cursor(-5, 9)).unwrap(), (-5, 9));
        assert!(decode_cursor("x").is_err());
        assert!(decode_cursor("1.y").is_err());
    }
}
