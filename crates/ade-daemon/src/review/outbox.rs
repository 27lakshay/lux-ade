//! The daemon side of the Git outbox: list a workspace's Git mutations that
//! still need the person, and record that the person saw an interrupted one.
//! Acknowledgements live beside the receipts in the review database. A receipt
//! keeps its `unknown` status after acknowledgement, because the Git step's
//! outcome is still unproven, and its ID still never runs again.
use super::*;
use ade_core::contract::review::{
    ReviewOperationAcknowledged, ReviewOperationEntry, ReviewOperationList,
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS operation_acknowledgements(id TEXT PRIMARY KEY, acknowledged_at INTEGER NOT NULL);";

/// The most operations one `review.operation.list` reply carries.
const LIST_MAX: usize = 100;

/// Creates the acknowledgement table if it is missing.
pub(super) fn ensure(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA)?;
    Ok(())
}

/// Whether `review.operation.list` shows an operation. Running and
/// unacknowledged interrupted operations always show; settled ones never do.
pub fn listed(status: GitOperationStatus, acknowledged: bool, include_acknowledged: bool) -> bool {
    match status {
        GitOperationStatus::Running => true,
        GitOperationStatus::Interrupted => !acknowledged || include_acknowledged,
        GitOperationStatus::Succeeded | GitOperationStatus::Failed => false,
    }
}

/// What `review.operation.acknowledge` does with an operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Acknowledgement {
    /// Record a new acknowledgement now.
    Record,
    /// Already acknowledged at this time; return it unchanged.
    Recorded(i64),
}

/// Only an interrupted operation is acknowledged. A running one still has an
/// outcome coming, and a settled one has nothing for the person to confirm.
pub fn acknowledgement(
    status: GitOperationStatus,
    acknowledged_at: Option<i64>,
) -> Result<Acknowledgement> {
    match (status, acknowledged_at) {
        (GitOperationStatus::Interrupted, None) => Ok(Acknowledgement::Record),
        (GitOperationStatus::Interrupted, Some(at)) => Ok(Acknowledgement::Recorded(at)),
        (GitOperationStatus::Running, _) => {
            bail!("Git operation is still running; wait for its result")
        }
        (GitOperationStatus::Succeeded | GitOperationStatus::Failed, _) => {
            bail!("Only an interrupted Git operation needs acknowledgement")
        }
    }
}

impl Review {
    /// Running and interrupted Git mutations for one worktree root, newest first.
    pub(super) fn list_operations(
        &self,
        root: &str,
        include_acknowledged: bool,
    ) -> Result<ReviewOperationList> {
        let db = self.db.lock().unwrap();
        let rows = db
            .prepare(
                "SELECT o.result, a.acknowledged_at FROM operations o LEFT JOIN operation_acknowledgements a ON a.id=o.id WHERE o.status IN ('accepted','dispatched','acknowledged','unknown') AND o.result IS NOT NULL AND json_extract(o.result,'$.root')=?1 AND (a.id IS NULL OR ?2) ORDER BY o.created_at DESC, o.id LIMIT ?3",
            )?
            .query_map(
                rusqlite::params![root, include_acknowledged, LIST_MAX as i64 + 1],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let truncated = rows.len() > LIST_MAX;
        let mut operations = Vec::with_capacity(rows.len().min(LIST_MAX));
        for (result, acknowledged_at) in rows.into_iter().take(LIST_MAX) {
            // A receipt that does not decode fails the list rather than hiding it.
            let receipt: GitReceipt =
                serde_json::from_str(&result).context("Stored Git receipt is invalid")?;
            ensure!(
                receipt.root == root,
                "Operation belongs to another workspace"
            );
            if listed(
                receipt.operation.status,
                acknowledged_at.is_some(),
                include_acknowledged,
            ) {
                operations.push(ReviewOperationEntry {
                    operation: receipt.operation,
                    acknowledged_at,
                });
            }
        }
        Ok(ReviewOperationList {
            tag: Default::default(),
            operations,
            truncated,
        })
    }

    /// Records, once, that the person saw an interrupted Git mutation.
    pub(super) fn acknowledge_operation(
        &self,
        root: &str,
        id: &str,
    ) -> Result<ReviewOperationAcknowledged> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let receipt = Self::stored(&tx, id)?.context("Unknown review operation")?;
        ensure!(
            receipt.root == root,
            "Operation belongs to another workspace"
        );
        let existing: Option<i64> = tx
            .query_row(
                "SELECT acknowledged_at FROM operation_acknowledgements WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let acknowledged_at = match acknowledgement(receipt.operation.status, existing)? {
            Acknowledgement::Recorded(at) => at,
            Acknowledgement::Record => {
                let now = now_ms();
                tx.execute(
                    "INSERT INTO operation_acknowledgements(id,acknowledged_at) VALUES(?1,?2)",
                    rusqlite::params![id, now],
                )?;
                now
            }
        };
        tx.commit()?;
        Ok(ReviewOperationAcknowledged {
            tag: Default::default(),
            operation: receipt.operation,
            acknowledged_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use GitOperationStatus::*;

    #[test]
    fn running_and_unacknowledged_interrupted_operations_are_listed() {
        for include in [false, true] {
            assert!(listed(Running, false, include));
            assert!(listed(Interrupted, false, include));
            assert!(!listed(Succeeded, false, include));
            assert!(!listed(Failed, false, include));
        }
    }

    #[test]
    fn acknowledged_operations_are_listed_only_on_request() {
        assert!(!listed(Interrupted, true, false));
        assert!(listed(Interrupted, true, true));
        assert!(!listed(Succeeded, true, true));
    }

    #[test]
    fn only_interrupted_operations_are_acknowledged() {
        assert_eq!(
            acknowledgement(Interrupted, None).unwrap(),
            Acknowledgement::Record
        );
        let running = acknowledgement(Running, None).unwrap_err();
        assert!(running.to_string().contains("still running"));
        assert!(acknowledgement(Succeeded, None).is_err());
        assert!(acknowledgement(Failed, None).is_err());
    }

    #[test]
    fn repeated_acknowledgement_keeps_the_first_time() {
        assert_eq!(
            acknowledgement(Interrupted, Some(7)).unwrap(),
            Acknowledgement::Recorded(7)
        );
    }
}
