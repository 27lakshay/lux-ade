//! Usage analytics and provider-reported limits (F049, F030).
//!
//! The Sessions event loop hands each batch's usage reports and turn
//! completions to [`Usage::record`], before it commits the batch's
//! conversation state. One transaction applies the reports and advances a
//! per-conversation cursor of runtime event sequences, so a batch replayed
//! after a crash between the two commits is skipped rather than counted
//! twice. Tables live in `sessions.sqlite`, created here idempotently.
//!
//! Recording never fails a conversation. A batch that cannot be saved is
//! counted and reported by every query, because its turns are missing from
//! every figure.
use ade_core::contract::usage::*;
use anyhow::{Context as _, Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

mod core;
use self::core::{Baseline, Decoded, Figures, TurnRow};

/// `usage.summary` refuses rather than aggregate more turns than this.
const MAX_SUMMARY_TURNS: usize = 200_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS usage_turns(conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT, run_id TEXT NOT NULL, observed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished INTEGER NOT NULL CHECK(finished IN (0,1)), reports INTEGER NOT NULL, figures TEXT, source TEXT, PRIMARY KEY(conversation_id,turn_id));
CREATE INDEX IF NOT EXISTS usage_turns_observed ON usage_turns(observed_at);
CREATE TABLE IF NOT EXISTS usage_baselines(conversation_id TEXT NOT NULL, source TEXT NOT NULL, baseline TEXT NOT NULL, PRIMARY KEY(conversation_id,source));
CREATE TABLE IF NOT EXISTS usage_cursor(conversation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_limits(provider TEXT NOT NULL, account_key TEXT NOT NULL, limit_id TEXT NOT NULL, account_id TEXT, used_percent REAL, window_minutes INTEGER, resets_at INTEGER, status TEXT, plan TEXT, observed_at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY(provider,account_key,limit_id));
";

/// The conversation a batch of reports belongs to, captured when recorded.
pub struct Context<'a> {
    pub conversation_id: &'a str,
    pub workspace_id: &'a str,
    pub provider: &'a str,
    pub account_id: Option<&'a str>,
}

/// One usage-relevant runtime event, with its runtime event sequence.
pub enum Observed {
    Report {
        turn: Option<String>,
        source: String,
        report: Value,
    },
    Finished {
        turn: String,
    },
}

pub struct Usage {
    db: Mutex<Connection>,
    recording: Mutex<UsageRecording>,
}

impl Usage {
    /// Opens usage state inside the profile database at `path`, which
    /// [`crate::store::Store::open`] has already migrated.
    pub fn open(path: &Path) -> Result<Arc<Self>> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        tx.commit()?;
        Ok(Arc::new(Self {
            db: Mutex::new(db),
            recording: Mutex::new(UsageRecording::default()),
        }))
    }

    /// Records one batch. Failure is logged and counted, never raised.
    pub fn record(&self, context: &Context, run: &str, batch: &[(u64, Observed)]) {
        if batch.is_empty() {
            return;
        }
        if let Err(error) = self.try_record(context, run, batch) {
            tracing::error!(target: "ade", event = "usage_record_failed", error = %error);
            let mut recording = self.recording.lock().unwrap();
            recording.dropped_batches += 1;
            recording.last_error = Some("Usage could not be saved; some turns are missing".into());
        }
    }

    fn try_record(&self, context: &Context, run: &str, batch: &[(u64, Observed)]) -> Result<()> {
        let db = self.db.lock().unwrap();
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        let applied: Option<(String, i64)> = tx
            .query_row(
                "SELECT run_id,sequence FROM usage_cursor WHERE conversation_id=?1",
                [context.conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let now = ade_core::model::now_ms();
        let mut last = None;
        for (sequence, observed) in batch {
            let sequence = i64::try_from(*sequence)?;
            if applied
                .as_ref()
                .is_some_and(|(r, s)| r == run && sequence <= *s)
            {
                continue;
            }
            last = Some(sequence);
            match observed {
                Observed::Finished { turn } => {
                    tx.execute(
                        "INSERT INTO usage_turns(conversation_id,turn_id,workspace_id,provider,account_id,run_id,observed_at,updated_at,finished,reports,figures,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,1,0,NULL,NULL) ON CONFLICT(conversation_id,turn_id) DO UPDATE SET finished=1,updated_at=?7",
                        params![context.conversation_id, turn, context.workspace_id, context.provider, context.account_id, run, now],
                    )?;
                }
                Observed::Report {
                    turn,
                    source,
                    report,
                } => apply(&tx, context, run, now, turn.as_deref(), source, report)?,
            }
        }
        if let Some(sequence) = last {
            tx.execute(
                "INSERT INTO usage_cursor(conversation_id,run_id,sequence) VALUES(?1,?2,?3) ON CONFLICT(conversation_id) DO UPDATE SET run_id=?2,sequence=?3",
                params![context.conversation_id, run, sequence],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn command(&self, request: &Value) -> Result<Value> {
        let op = request["op"].as_str().unwrap_or("");
        let result = match op {
            "usage.summary" => self.summary(decode(request)?),
            "usage.turns" => self.turns(decode(request)?),
            "usage.limits" => self.limits(decode(request)?),
            _ => Err(anyhow!("Unknown usage operation")),
        };
        result.map_err(|error| {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                tracing::error!(target: "ade", event = "usage_read_failed", error = %error);
                anyhow!("Usage is unavailable; retry")
            } else {
                error
            }
        })
    }

    fn recording(&self) -> UsageRecording {
        self.recording.lock().unwrap().clone()
    }

    fn summary(&self, request: UsageSummaryRequest) -> Result<Value> {
        let offset = request.utc_offset_minutes.unwrap_or(0);
        ensure!(
            offset.abs() <= core::MAX_UTC_OFFSET_MINUTES,
            "utc_offset_minutes must be from -840 to 840"
        );
        check_range(&request.filter)?;
        let db = self.db.lock().unwrap();
        let f = &request.filter;
        let mut statement = db.prepare(&format!(
            "SELECT conversation_id,workspace_id,provider,account_id,observed_at,finished,figures FROM usage_turns WHERE {FILTER} LIMIT ?7"
        ))?;
        let rows = statement
            .query_map(
                params![
                    f.workspace_id,
                    f.provider,
                    f.account_id,
                    f.conversation_id,
                    f.since,
                    f.until,
                    MAX_SUMMARY_TURNS as i64 + 1
                ],
                |row| {
                    Ok((
                        TurnRow {
                            conversation_id: row.get(0)?,
                            workspace_id: row.get(1)?,
                            provider: row.get(2)?,
                            account_id: row.get(3)?,
                            observed_at: row.get(4)?,
                            finished: row.get(5)?,
                            figures: None,
                        },
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )?
            .map(|row| {
                let (mut row, figures) = row?;
                row.figures = figures.as_deref().map(parse_figures).transpose()?;
                Ok(row)
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            rows.len() <= MAX_SUMMARY_TURNS,
            "More than {MAX_SUMMARY_TURNS} turns match; narrow the time range or filters"
        );
        let (groups, total) = core::aggregate(&rows, request.group_by, offset);
        reply(&UsageSummary {
            tag: Default::default(),
            group_by: request.group_by,
            groups,
            total,
            recording: self.recording(),
        })
    }

    fn turns(&self, request: UsageTurnsRequest) -> Result<Value> {
        check_range(&request.filter)?;
        let limit = request.limit.unwrap_or(50);
        ensure!((1..=100).contains(&limit), "limit must be from 1 to 100");
        let cursor = request
            .cursor
            .as_deref()
            .map(core::decode_cursor)
            .transpose()?;
        let db = self.db.lock().unwrap();
        let f = &request.filter;
        let mut statement = db.prepare(&format!(
            "SELECT rowid,conversation_id,turn_id,workspace_id,provider,account_id,observed_at,updated_at,finished,figures,source FROM usage_turns WHERE {FILTER} AND (?7 IS NULL OR observed_at<?7 OR (observed_at=?7 AND rowid<?8)) ORDER BY observed_at DESC, rowid DESC LIMIT ?9"
        ))?;
        let mut rows = statement
            .query_map(
                params![
                    f.workspace_id,
                    f.provider,
                    f.account_id,
                    f.conversation_id,
                    f.since,
                    f.until,
                    cursor.map(|c| c.0),
                    cursor.map(|c| c.1),
                    limit as i64 + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        UsageTurn {
                            conversation_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            workspace_id: row.get(3)?,
                            provider: row.get(4)?,
                            account_id: row.get(5)?,
                            observed_at: row.get(6)?,
                            updated_at: row.get(7)?,
                            finished: row.get(8)?,
                            reported: false,
                            tokens: UsageTokens::default(),
                            cost_usd: None,
                            cost_basis: None,
                            scope: None,
                            models: vec![],
                            source: row.get(10)?,
                            note: None,
                        },
                        row.get::<_, Option<String>>(9)?,
                    ))
                },
            )?
            .map(|row| {
                let (rowid, mut turn, figures) = row?;
                if let Some(figures) = figures.as_deref().map(parse_figures).transpose()? {
                    turn.reported = true;
                    turn.tokens = figures.tokens;
                    turn.cost_usd = figures.cost_usd;
                    turn.cost_basis = figures.cost_basis;
                    turn.scope = figures.scope;
                    turn.models = figures.models;
                    turn.note = figures.note;
                }
                Ok((rowid, turn))
            })
            .collect::<Result<Vec<_>>>()?;
        let more = rows.len() as u64 > limit;
        rows.truncate(limit as usize);
        let next_cursor = more
            .then(|| rows.last())
            .flatten()
            .map(|(rowid, turn)| core::encode_cursor(turn.observed_at, *rowid));
        reply(&UsageTurns {
            tag: Default::default(),
            turns: rows.into_iter().map(|(_, turn)| turn).collect(),
            next_cursor,
            recording: self.recording(),
        })
    }

    fn limits(&self, request: UsageLimitsRequest) -> Result<Value> {
        let now = ade_core::model::now_ms();
        let db = self.db.lock().unwrap();
        let windows = db
            .prepare("SELECT provider,account_id,limit_id,used_percent,window_minutes,resets_at,status,plan,observed_at,source FROM usage_limits WHERE (?1 IS NULL OR provider=?1) AND (?2 IS NULL OR account_id=?2) ORDER BY provider,account_key,limit_id")?
            .query_map(params![request.provider, request.account_id], |row| {
                let resets_at: Option<i64> = row.get(5)?;
                Ok(UsageLimitWindow {
                    provider: row.get(0)?,
                    account_id: row.get(1)?,
                    limit_id: row.get(2)?,
                    used_percent: row.get(3)?,
                    window_minutes: row.get::<_, Option<i64>>(4)?.and_then(|m| u64::try_from(m).ok()),
                    resets_at,
                    status: row.get(6)?,
                    plan: row.get(7)?,
                    observed_at: row.get(8)?,
                    source: row.get(9)?,
                    reset_since_observed: resets_at.is_some_and(|at| at <= now),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        reply(&UsageLimits {
            tag: Default::default(),
            windows,
            recording: self.recording(),
        })
    }
}

const FILTER: &str = "(?1 IS NULL OR workspace_id=?1) AND (?2 IS NULL OR provider=?2) AND (?3 IS NULL OR account_id=?3) AND (?4 IS NULL OR conversation_id=?4) AND (?5 IS NULL OR observed_at>=?5) AND (?6 IS NULL OR observed_at<?6)";

fn check_range(filter: &UsageFilter) -> Result<()> {
    if let (Some(since), Some(until)) = (filter.since, filter.until) {
        ensure!(since < until, "since must be earlier than until");
    }
    Ok(())
}

fn parse_figures(text: &str) -> Result<Figures> {
    serde_json::from_str(text).context("A usage record is unreadable")
}

/// Applies one report inside the batch transaction.
fn apply(
    tx: &Transaction,
    context: &Context,
    run: &str,
    now: i64,
    turn: Option<&str>,
    source: &str,
    report: &Value,
) -> Result<()> {
    let prior: Option<Baseline> = tx
        .query_row(
            "SELECT baseline FROM usage_baselines WHERE conversation_id=?1 AND source=?2",
            params![context.conversation_id, source],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|text| serde_json::from_str(&text).ok());
    let decoded = match core::decode(context.provider, source, report, run, prior.as_ref()) {
        Ok(decoded) => decoded,
        Err(error) => {
            // A report ADE cannot read leaves its turn unreported; it is
            // never guessed at.
            tracing::warn!(target: "ade", event = "usage_report_unreadable", provider = context.provider, source, error = %error);
            return Ok(());
        }
    };
    match decoded {
        Decoded::Nothing => {}
        Decoded::Limits(windows) => {
            for window in windows {
                tx.execute(
                    "INSERT INTO usage_limits(provider,account_key,limit_id,account_id,used_percent,window_minutes,resets_at,status,plan,observed_at,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(provider,account_key,limit_id) DO UPDATE SET used_percent=excluded.used_percent,window_minutes=excluded.window_minutes,resets_at=excluded.resets_at,status=excluded.status,plan=COALESCE(excluded.plan,usage_limits.plan),observed_at=excluded.observed_at,source=excluded.source",
                    params![
                        context.provider,
                        context.account_id.unwrap_or(""),
                        window.limit_id,
                        context.account_id,
                        window.used_percent,
                        window.window_minutes.map(|m| m as i64),
                        window.resets_at,
                        window.status,
                        window.plan,
                        now,
                        source
                    ],
                )?;
            }
        }
        Decoded::Turn(report) => {
            if let Some(baseline) = &report.baseline {
                tx.execute(
                    "INSERT INTO usage_baselines(conversation_id,source,baseline) VALUES(?1,?2,?3) ON CONFLICT(conversation_id,source) DO UPDATE SET baseline=?3",
                    params![context.conversation_id, source, serde_json::to_string(baseline)?],
                )?;
            }
            let Some(turn) = turn.filter(|t| !t.is_empty()) else {
                tracing::warn!(target: "ade", event = "usage_report_without_turn", provider = context.provider, source);
                return Ok(());
            };
            let existing: Option<(Option<String>, i64)> = tx
                .query_row(
                    "SELECT figures,reports FROM usage_turns WHERE conversation_id=?1 AND turn_id=?2",
                    params![context.conversation_id, turn],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (figures, reports) = match existing {
                Some((figures, reports)) => (
                    figures.as_deref().map(parse_figures).transpose()?,
                    u64::try_from(reports).unwrap_or(0),
                ),
                None => (None, 0),
            };
            let merged = core::merge(figures.as_ref(), reports, report.as_ref());
            let text = serde_json::to_string(&merged)?;
            tx.execute(
                    "INSERT INTO usage_turns(conversation_id,turn_id,workspace_id,provider,account_id,run_id,observed_at,updated_at,finished,reports,figures,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,0,1,?8,?9) ON CONFLICT(conversation_id,turn_id) DO UPDATE SET figures=?8,reports=usage_turns.reports+1,source=?9,updated_at=?7",
                    params![context.conversation_id, turn, context.workspace_id, context.provider, context.account_id, run, now, text, source],
                )?;
        }
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(request: &Value) -> Result<T> {
    T::deserialize(request).map_err(|error| anyhow!("Invalid request: {error}"))
}

fn reply<T: serde::Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}
