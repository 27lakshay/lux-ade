//! Durable runtime incarnations, the process identities of the attempts each
//! one owned, and the reconciliation reports written after a runtime restart
//! (R005, R006). The tables live in the profile state database and are created
//! idempotently before use. See `sessions/recovery.rs` for the classifier.
use super::*;
use activity::Recorded;
use ade_core::contract::activity::{ActivityKind, ActivityTarget};
use ade_core::contract::daemon::RecoveryReport;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runtime_incarnations(instance TEXT PRIMARY KEY, pid INTEGER NOT NULL, started INTEGER, first_seen_at INTEGER NOT NULL, reconciled_at INTEGER);
CREATE TABLE IF NOT EXISTS runtime_attempt_records(instance TEXT NOT NULL, key TEXT NOT NULL, attempt TEXT, pid INTEGER NOT NULL, started INTEGER NOT NULL, leader INTEGER NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY(instance, key));
CREATE TABLE IF NOT EXISTS runtime_attempt_descendants(instance TEXT NOT NULL, key TEXT NOT NULL, pid INTEGER NOT NULL, started INTEGER NOT NULL, PRIMARY KEY(instance, key, pid));
CREATE TABLE IF NOT EXISTS runtime_recovery_reports(id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL, open INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runtime_recovery_reports_by_time ON runtime_recovery_reports(detected_at);
";

/// Closed reports kept for inspection; open ones are never pruned.
const CLOSED_REPORTS_KEPT: i64 = 20;
/// Attempt records kept per incarnation.
pub const ATTEMPT_RECORDS_MAX: usize = 4096;
/// Descendants kept per attempt record.
pub const ATTEMPT_DESCENDANTS_MAX: usize = 256;

fn ensure_tables(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// One runtime incarnation the daemon owned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeIncarnation {
    pub instance: String,
    pub pid: u32,
    /// The runtime process start stamp, when it could be read.
    pub started: Option<u64>,
}

/// The process identity of one attempt, recorded while its runtime lived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRecord {
    pub instance: String,
    /// The attempt key, as in a recovery report.
    pub key: String,
    /// The run ID or terminal transfer ID.
    pub attempt: Option<String>,
    pub pid: u32,
    pub started: u64,
    pub leader: bool,
    /// Descendants seen under the process, as (PID, start stamp), including
    /// those that left its group.
    pub descendants: Vec<(u32, u64)>,
}

/// An activity record for one attempt that did not settle.
pub struct RecoveryNotice {
    pub source_key: String,
    pub workspace_id: String,
    /// Empty when the attempt is not a Conversation's.
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub title: String,
    pub detail: String,
}

fn stamp(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

impl Store {
    /// Whether the daemon has owned this runtime incarnation before.
    pub fn runtime_incarnation_known(&self, instance: &str) -> Result<bool> {
        ensure_tables(&self.connection)?;
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM runtime_incarnations WHERE instance=?1",
                [instance],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Incarnations other than `current` that no report has reconciled.
    pub fn unreconciled_incarnations(&self, current: &str) -> Result<Vec<RuntimeIncarnation>> {
        ensure_tables(&self.connection)?;
        let mut statement = self.connection.prepare(
            "SELECT instance,pid,started FROM runtime_incarnations WHERE instance<>?1 AND reconciled_at IS NULL ORDER BY first_seen_at",
        )?;
        statement
            .query_map([current], |row| {
                Ok(RuntimeIncarnation {
                    instance: row.get(0)?,
                    pid: row.get(1)?,
                    started: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                })
            })?
            .map(|row| Ok(row?))
            .collect()
    }

    /// Reads incarnations by name, whether reconciled or not.
    pub fn runtime_incarnations(&self, instances: &[String]) -> Result<Vec<RuntimeIncarnation>> {
        ensure_tables(&self.connection)?;
        let mut found = Vec::new();
        for instance in instances {
            if let Some(incarnation) = self
                .connection
                .query_row(
                    "SELECT instance,pid,started FROM runtime_incarnations WHERE instance=?1",
                    [instance],
                    |row| {
                        Ok(RuntimeIncarnation {
                            instance: row.get(0)?,
                            pid: row.get(1)?,
                            started: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                        })
                    },
                )
                .optional()?
            {
                found.push(incarnation);
            }
        }
        Ok(found)
    }

    /// Records the incarnation the daemon now owns. The first record wins.
    pub fn record_runtime_incarnation(&self, incarnation: &RuntimeIncarnation) -> Result<()> {
        ensure_tables(&self.connection)?;
        self.connection.execute(
            "INSERT INTO runtime_incarnations(instance,pid,started,first_seen_at) VALUES(?1,?2,?3,?4) ON CONFLICT(instance) DO NOTHING",
            params![
                incarnation.instance,
                incarnation.pid,
                incarnation.started.map(stamp),
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// Replaces the attempt records of one incarnation with what it runs now.
    pub fn replace_attempt_records(&self, instance: &str, records: &[AttemptRecord]) -> Result<()> {
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        tx.execute(
            "DELETE FROM runtime_attempt_records WHERE instance=?1",
            [instance],
        )?;
        tx.execute(
            "DELETE FROM runtime_attempt_descendants WHERE instance=?1",
            [instance],
        )?;
        let now = now_ms();
        for record in records.iter().take(ATTEMPT_RECORDS_MAX) {
            for (pid, started) in record.descendants.iter().take(ATTEMPT_DESCENDANTS_MAX) {
                tx.execute(
                    "INSERT OR REPLACE INTO runtime_attempt_descendants(instance,key,pid,started) VALUES(?1,?2,?3,?4)",
                    params![instance, record.key, pid, stamp(*started)],
                )?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO runtime_attempt_records(instance,key,attempt,pid,started,leader,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    instance,
                    record.key,
                    record.attempt,
                    record.pid,
                    stamp(record.started),
                    record.leader,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Adds descendants found after a restart to one attempt record, up to
    /// [`ATTEMPT_DESCENDANTS_MAX`] per record. Known ones are kept as they are.
    pub fn add_attempt_descendants(
        &self,
        instance: &str,
        key: &str,
        descendants: &[(u32, u64)],
    ) -> Result<()> {
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let mut kept: i64 = tx.query_row(
            "SELECT COUNT(*) FROM runtime_attempt_descendants WHERE instance=?1 AND key=?2",
            params![instance, key],
            |row| row.get(0),
        )?;
        for (pid, started) in descendants {
            if kept >= ATTEMPT_DESCENDANTS_MAX as i64 {
                break;
            }
            kept += tx.execute(
                "INSERT OR IGNORE INTO runtime_attempt_descendants(instance,key,pid,started) VALUES(?1,?2,?3,?4)",
                params![instance, key, pid, stamp(*started)],
            )? as i64;
        }
        tx.commit()?;
        Ok(())
    }

    /// The attempt records of these incarnations.
    pub fn attempt_records(&self, instances: &[String]) -> Result<Vec<AttemptRecord>> {
        ensure_tables(&self.connection)?;
        let mut statement = self.connection.prepare(
            "SELECT instance,key,attempt,pid,started,leader FROM runtime_attempt_records WHERE instance=?1 ORDER BY key",
        )?;
        let mut records = Vec::new();
        for instance in instances {
            for record in statement.query_map([instance], |row| {
                Ok(AttemptRecord {
                    instance: row.get(0)?,
                    key: row.get(1)?,
                    attempt: row.get(2)?,
                    pid: row.get(3)?,
                    started: row.get::<_, i64>(4)? as u64,
                    leader: row.get(5)?,
                    descendants: Vec::new(),
                })
            })? {
                records.push(record?);
            }
        }
        let mut descendants = self.connection.prepare(
            "SELECT pid,started FROM runtime_attempt_descendants WHERE instance=?1 AND key=?2 ORDER BY pid",
        )?;
        for record in &mut records {
            for descendant in descendants
                .query_map(params![record.instance, record.key], |row| {
                    Ok((row.get::<_, u32>(0)?, row.get::<_, i64>(1)? as u64))
                })?
            {
                record.descendants.push(descendant?);
            }
        }
        Ok(records)
    }

    /// Commits a new report, marks its incarnations reconciled and records
    /// its activity, in one transaction.
    pub fn save_recovery_report(
        &self,
        report: &RecoveryReport,
        notices: Vec<RecoveryNotice>,
    ) -> Result<()> {
        ensure_tables(&self.connection)?;
        activity::ensure(&self.connection)?;
        let tx = self.transaction()?;
        tx.execute(
            "INSERT INTO runtime_recovery_reports(id,detected_at,open,data) VALUES(?1,?2,?3,?4)",
            params![report.id, report.detected_at, report.open, encode(report)?],
        )?;
        for instance in &report.previous_instances {
            tx.execute(
                "UPDATE runtime_incarnations SET reconciled_at=?2 WHERE instance=?1",
                params![instance, report.detected_at],
            )?;
        }
        for notice in notices {
            activity::record(
                &tx,
                Recorded {
                    source_key: notice.source_key,
                    kind: ActivityKind::OperationUnknown,
                    target: ActivityTarget {
                        workspace_id: notice.workspace_id,
                        conversation_id: notice.conversation_id,
                        request_id: None,
                        turn_id: notice.turn_id,
                    },
                    title: notice.title,
                    detail: Some(notice.detail),
                },
                report.detected_at,
            )?;
        }
        if report.open == 0 {
            forget_incarnations(&tx, &report.previous_instances)?;
        }
        prune_reports(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Rewrites a report after an attempt was resolved. Once nothing is open,
    /// its incarnations and their attempt records are no longer needed.
    pub fn update_recovery_report(&self, report: &RecoveryReport) -> Result<()> {
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let changed = tx.execute(
            "UPDATE runtime_recovery_reports SET open=?2,data=?3 WHERE id=?1",
            params![report.id, report.open, encode(report)?],
        )?;
        ensure!(changed == 1, "Unknown recovery report: {}", report.id);
        if report.open == 0 {
            forget_incarnations(&tx, &report.previous_instances)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn recovery_report(&self, id: &str) -> Result<RecoveryReport> {
        ensure_tables(&self.connection)?;
        one(&self.connection, "runtime_recovery_reports", id)
    }

    /// Reports newest first.
    pub fn recovery_reports(&self, open_only: bool) -> Result<Vec<RecoveryReport>> {
        ensure_tables(&self.connection)?;
        all(
            &self.connection,
            if open_only {
                "SELECT data FROM runtime_recovery_reports WHERE open>0 ORDER BY detected_at DESC, id DESC"
            } else {
                "SELECT data FROM runtime_recovery_reports ORDER BY detected_at DESC, id DESC"
            },
        )
    }
}

fn forget_incarnations(tx: &Connection, instances: &[String]) -> Result<()> {
    for instance in instances {
        tx.execute(
            "DELETE FROM runtime_attempt_records WHERE instance=?1",
            [instance],
        )?;
        tx.execute(
            "DELETE FROM runtime_attempt_descendants WHERE instance=?1",
            [instance],
        )?;
        tx.execute(
            "DELETE FROM runtime_incarnations WHERE instance=?1 AND reconciled_at IS NOT NULL",
            [instance],
        )?;
    }
    Ok(())
}

fn prune_reports(tx: &Connection) -> Result<()> {
    tx.execute(
        "DELETE FROM runtime_recovery_reports WHERE open=0 AND id NOT IN (SELECT id FROM runtime_recovery_reports WHERE open=0 ORDER BY detected_at DESC, id DESC LIMIT ?1)",
        [CLOSED_REPORTS_KEPT],
    )?;
    Ok(())
}
