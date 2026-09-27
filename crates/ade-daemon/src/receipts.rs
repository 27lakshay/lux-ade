//! Effect-command receipts shared by every daemon database.
//!
//! Each SQLite database that owns effect state carries its own `operations`
//! table. A handler calls [`begin`] and [`settle`] on the same transaction that
//! writes the state change, so the receipt and the change commit together.
//! The daemon computes the payload fingerprint; clients never send one.

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Receipts older than this answer a reused ID with [`Admission::Expired`].
pub const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The payload field that carries the caller-supplied operation ID.
pub const OPERATION_ID_FIELD: &str = "operation_id";

const EXPIRED: &str = "expired";

/// The daemon stores besides the profile database that carry an `operations`
/// table, by the paths `Sessions::open` derives from the profile database.
/// Retention and diagnostics both read this list, so they agree on which
/// stores hold effect receipts.
pub fn side_stores(sessions: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        (
            "lifecycle",
            sessions
                .with_extension("worktrees")
                .join("lifecycle.sqlite3"),
        ),
        ("review", sessions.with_extension("review.sqlite3")),
        ("plugins", sessions.with_extension("plugins.sqlite3")),
    ]
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, op TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, caller TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";

/// Operation states from the architecture's command lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Accepted,
    Dispatched,
    Acknowledged,
    Settled,
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Dispatched => "dispatched",
            Self::Acknowledged => "acknowledged",
            Self::Settled => "settled",
            Self::Unknown => "unknown",
        }
    }

    /// Whether a receipt may move from `self` to `next`. States only move
    /// forward; any open state may become unknown after a crash, unknown only
    /// resolves to settled, and settled is final.
    pub fn may_become(self, next: Self) -> bool {
        match (self, next) {
            (Self::Settled, _) => false,
            (Self::Unknown, next) => next == Self::Settled,
            (_, Self::Unknown) => true,
            (current, next) => next.rank() > current.rank(),
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Accepted => 0,
            Self::Dispatched => 1,
            Self::Acknowledged => 2,
            Self::Settled => 3,
            Self::Unknown => 4,
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "accepted" => Self::Accepted,
            "dispatched" => Self::Dispatched,
            "acknowledged" => Self::Acknowledged,
            "settled" => Self::Settled,
            "unknown" => Self::Unknown,
            other => bail!("Unknown operation status {other}"),
        })
    }
}

/// What a stored receipt says about an earlier admission of the same ID.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub status: Status,
    pub result: Option<Value>,
}

/// The outcome of admitting an effect command.
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    /// First sight of this ID; a receipt in `accepted` now exists.
    New,
    /// Same ID and payload as before; return the stored result or state.
    Replay(Receipt),
    /// Same ID with a different operation or payload.
    Conflict,
    /// The receipt is past retention; the command must not run again.
    Expired,
}

/// Creates the `operations` table if it is missing. `state.sqlite` gets it
/// through migration 17; the review and lifecycle databases call this when
/// they open.
pub fn ensure(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// Canonical JSON: object keys sorted recursively, no insignificant whitespace.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(item, out);
            }
            out.push('}');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// Lowercase hex SHA-256 of the canonical payload, with the top-level
/// `operation_id` field removed.
pub fn fingerprint(payload: &Value) -> String {
    let canonical = match payload {
        Value::Object(map) if map.contains_key(OPERATION_ID_FIELD) => {
            let mut map = map.clone();
            map.remove(OPERATION_ID_FIELD);
            canonical_json(&Value::Object(map))
        }
        other => canonical_json(other),
    };
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Admits an effect command. Call it inside the transaction that will write
/// the state change; on [`Admission::New`] the `accepted` receipt is part of it.
pub fn begin(
    connection: &Connection,
    operation_id: &str,
    op: &str,
    payload: &Value,
    caller: Option<&str>,
    now: i64,
) -> Result<Admission> {
    ensure!(!operation_id.is_empty(), "Operation ID is empty");
    let fingerprint = fingerprint(payload);
    let stored = connection
        .query_row(
            "SELECT op,fingerprint,status,result,created_at FROM operations WHERE id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((stored_op, stored_fingerprint, status, result, created_at)) = stored else {
        connection.execute(
            "INSERT INTO operations(id,op,fingerprint,status,result,caller,created_at,updated_at) VALUES(?1,?2,?3,?4,NULL,?5,?6,?6)",
            params![operation_id, op, fingerprint, Status::Accepted.as_str(), caller, now],
        )?;
        return Ok(Admission::New);
    };
    if status == EXPIRED || now.saturating_sub(created_at) > RETENTION_MS {
        return Ok(Admission::Expired);
    }
    if stored_op != op || stored_fingerprint != fingerprint {
        return Ok(Admission::Conflict);
    }
    let result = result
        .map(|text| serde_json::from_str(&text))
        .transpose()
        .context("Stored operation result is not JSON")?;
    Ok(Admission::Replay(Receipt {
        status: Status::parse(&status)?,
        result,
    }))
}

/// Records a new state, and optionally the result, for an admitted operation.
pub fn settle(
    connection: &Connection,
    operation_id: &str,
    status: Status,
    result: Option<&Value>,
    now: i64,
) -> Result<()> {
    let current: Option<String> = connection
        .query_row(
            "SELECT status FROM operations WHERE id=?1 AND status!=?2",
            params![operation_id, EXPIRED],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current) = current else {
        bail!("No live receipt for operation {operation_id}");
    };
    let current = Status::parse(&current)?;
    ensure!(
        current.may_become(status),
        "Operation {operation_id} cannot move from {} to {}",
        current.as_str(),
        status.as_str()
    );
    // A transition without a result keeps the one already stored.
    let result = result.map(Value::to_string);
    connection.execute(
        "UPDATE operations SET status=?2,result=COALESCE(?3,result),updated_at=?4 WHERE id=?1",
        params![operation_id, status.as_str(), result, now],
    )?;
    Ok(())
}

/// Drops the body of receipts past retention. Each keeps an expired marker so
/// a reused ID still returns [`Admission::Expired`]. Returns how many expired.
pub fn prune(connection: &Connection, now: i64) -> Result<usize> {
    Ok(connection.execute(
        "UPDATE operations SET status=?1,result=NULL,caller=NULL,updated_at=?2 WHERE status!=?1 AND created_at<?3",
        params![EXPIRED, now, now.saturating_sub(RETENTION_MS)],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        ensure(&connection).unwrap();
        ensure(&connection).unwrap();
        connection
    }

    #[test]
    fn canonical_json_sorts_keys_recursively_without_whitespace() {
        let value: Value = serde_json::from_str(
            r#"{ "b": [ {"z": 1, "a": "x y"} , null ], "a": {"d": true, "c": 1.5} }"#,
        )
        .unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"c":1.5,"d":true},"b":[{"a":"x y","z":1},null]}"#
        );
        assert_eq!(canonical_json(&json!("q\"\n")), r#""q\"\n""#);
    }

    #[test]
    fn fingerprint_ignores_key_order_whitespace_and_operation_id() {
        let a: Value =
            serde_json::from_str(r#"{"operation_id":"one","target":{"b":2,"a":1},"text":"hi"}"#)
                .unwrap();
        let b: Value =
            serde_json::from_str(r#"{ "text" : "hi", "target" : { "a" : 1, "b" : 2 } }"#).unwrap();
        let c = json!({"operation_id": "two", "text": "hi", "target": {"a": 1, "b": 3}});
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
        assert_eq!(
            fingerprint(&json!({})),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn admission_returns_new_replay_conflict_and_expired() {
        let mut connection = database();
        let payload = json!({"operation_id": "op-1", "text": "hello"});
        let tx = connection.transaction().unwrap();
        assert_eq!(
            begin(&tx, "op-1", "prompt.send", &payload, Some("cli"), 10).unwrap(),
            Admission::New
        );
        tx.commit().unwrap();

        let replay = begin(&connection, "op-1", "prompt.send", &payload, None, 20).unwrap();
        assert_eq!(
            replay,
            Admission::Replay(Receipt {
                status: Status::Accepted,
                result: None
            })
        );

        settle(
            &connection,
            "op-1",
            Status::Settled,
            Some(&json!({"ok": 1})),
            30,
        )
        .unwrap();
        assert_eq!(
            begin(&connection, "op-1", "prompt.send", &payload, None, 40).unwrap(),
            Admission::Replay(Receipt {
                status: Status::Settled,
                result: Some(json!({"ok": 1}))
            })
        );

        let changed = json!({"operation_id": "op-1", "text": "other"});
        assert_eq!(
            begin(&connection, "op-1", "prompt.send", &changed, None, 50).unwrap(),
            Admission::Conflict
        );
        assert_eq!(
            begin(&connection, "op-1", "git.commit", &payload, None, 50).unwrap(),
            Admission::Conflict
        );

        let late = 10 + RETENTION_MS + 1;
        assert_eq!(
            begin(&connection, "op-1", "prompt.send", &payload, None, late).unwrap(),
            Admission::Expired
        );
        assert_eq!(prune(&connection, late).unwrap(), 1);
        assert_eq!(prune(&connection, late).unwrap(), 0);
        assert_eq!(
            begin(&connection, "op-1", "prompt.send", &payload, None, late).unwrap(),
            Admission::Expired
        );
        assert!(settle(&connection, "op-1", Status::Settled, None, late).is_err());
    }

    #[test]
    fn rolled_back_admission_leaves_no_receipt() {
        let mut connection = database();
        let payload = json!({"x": 1});
        let tx = connection.transaction().unwrap();
        assert_eq!(
            begin(&tx, "op-2", "worktree.remove", &payload, None, 1).unwrap(),
            Admission::New
        );
        drop(tx);
        assert_eq!(
            begin(&connection, "op-2", "worktree.remove", &payload, None, 2).unwrap(),
            Admission::New
        );
    }

    #[test]
    fn status_round_trips() {
        for status in [
            Status::Accepted,
            Status::Dispatched,
            Status::Acknowledged,
            Status::Settled,
            Status::Unknown,
        ] {
            assert_eq!(Status::parse(status.as_str()).unwrap(), status);
        }
        assert!(Status::parse(EXPIRED).is_err());
    }

    #[test]
    fn transitions_only_move_forward_and_settled_is_final() {
        use Status::*;
        assert!(Accepted.may_become(Dispatched));
        assert!(Accepted.may_become(Settled));
        assert!(Dispatched.may_become(Unknown));
        assert!(Unknown.may_become(Settled));
        assert!(!Unknown.may_become(Dispatched));
        assert!(!Dispatched.may_become(Accepted));
        assert!(!Settled.may_become(Unknown));
        assert!(!Settled.may_become(Settled));
    }

    #[test]
    fn settle_rejects_backward_moves_and_keeps_stored_results() {
        let connection = database();
        let payload = json!({"operation_id": "op-1", "text": "hi"});
        begin(&connection, "op-1", "agent.send", &payload, None, 0).unwrap();
        settle(
            &connection,
            "op-1",
            Status::Settled,
            Some(&json!({"ok": true})),
            1,
        )
        .unwrap();
        assert!(settle(&connection, "op-1", Status::Accepted, None, 2).is_err());
        let stored: String = connection
            .query_row("SELECT result FROM operations WHERE id='op-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, r#"{"ok":true}"#);
    }
}
