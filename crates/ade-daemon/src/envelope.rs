//! The effect-command envelope for commands whose handlers keep no receipt of
//! their own (architecture section 4; R001 and R002).
//!
//! Most effect commands write their receipt in the transaction that changes
//! their state. The commands in [`OPERATIONS`] change state in several places
//! (the runtime, a provider, a proxy registry), so no single transaction can
//! hold both. The envelope records their lifecycle around the handler instead,
//! in the `operations` table of its own store beside the profile database
//! (`receipts::envelope_store`), which retention and diagnostics read with the
//! other receipt stores:
//!
//! 1. **accepted**: committed before anything else happens.
//! 2. **dispatched**: committed just before the handler runs.
//! 3. **settled**: the handler's reply or error, committed after it returns.
//!
//! A retry with the same ID and payload returns the settled reply or error
//! unchanged. The same ID with another payload is a conflict. A receipt that
//! an earlier daemon left open is never run again. When the daemon opens, it
//! settles every such receipt, so diagnostics list the unknown ones at once:
//!
//! - still **accepted**: the command never reached its handler, so it settles
//!   as "not applied";
//! - **dispatched**: the handler may have acted. The caller's observer checks
//!   the current state; when it proves the effect, the receipt settles with
//!   that reply, and otherwise it becomes **unknown**. Each later retry of an
//!   unknown receipt observes again, so it settles once the state proves it.

use crate::receipts::{self, Admission, Receipt, Status};
use anyhow::Result;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

/// The effect commands the envelope records.
pub const OPERATIONS: [&str; 22] = [
    "conversation.create",
    "queue.pause",
    "agent.cancel",
    "agent.resume",
    "agent.disconnect",
    "account.create",
    "terminal.restart",
    "terminal.stop",
    "terminal.retire",
    "service.start",
    "service.stop",
    "service.remove",
    "service.proxy.remap",
    "service.proxy.retire",
    "service.proxy.recovery.retry",
    "service.proxy.recovery.reset",
    "worktree.adopt",
    "script.start",
    "script.stop",
    "script.retire",
    "runtime.prepare_restart",
    "workspace.remove",
];

/// Commands that stop existing work. When the receipt store refuses writes
/// (a full disk), they still run, unrecorded: stopping must stay available
/// (architecture section 4, "Reserve capacity for cancellation").
const STOPS: [&str; 4] = [
    "agent.cancel",
    "terminal.stop",
    "service.stop",
    "script.stop",
];

/// The longest operation ID the envelope accepts, in bytes.
pub const MAX_ID_BYTES: usize = 256;

/// Whether the envelope records `op`.
pub fn covers(op: &str) -> bool {
    OPERATIONS.contains(&op)
}

/// What a retry of an admitted operation returns.
#[derive(Clone, Debug, PartialEq)]
pub enum Replay {
    /// The recorded reply or error frame.
    Recorded(Value),
    /// A recorded unknown outcome: observe again, else return this frame.
    Unresolved(Value),
    /// The first attempt is still running in this daemon.
    InProgress,
    /// An earlier daemon stopped before the handler ran; nothing changed.
    NotApplied,
    /// An earlier daemon stopped while the handler ran; observe before deciding.
    Interrupted,
}

/// Decides what a retry returns from the stored receipt. `running` says whether
/// this daemon is running the first attempt now. Pure: no I/O.
pub fn replay(receipt: &Receipt, running: bool) -> Replay {
    match receipt.status {
        Status::Settled => Replay::Recorded(recorded(receipt)),
        Status::Unknown => Replay::Unresolved(recorded(receipt)),
        _ if running => Replay::InProgress,
        Status::Accepted => Replay::NotApplied,
        Status::Dispatched | Status::Acknowledged => Replay::Interrupted,
    }
}

fn recorded(receipt: &Receipt) -> Value {
    receipt.result.clone().map(frame).unwrap_or_else(|| {
        error(
            "outcome_unknown",
            "The recorded outcome of this operation is missing",
        )
    })
}

/// The stored form of a handler outcome.
pub fn record(outcome: &Result<Value, Value>) -> Value {
    match outcome {
        Ok(reply) => json!({"reply": reply}),
        Err(error) => json!({"error": error}),
    }
}

/// The frame a stored outcome replays as.
fn frame(stored: Value) -> Value {
    match stored {
        Value::Object(mut map) => map
            .remove("reply")
            .or_else(|| map.remove("error"))
            .unwrap_or(Value::Object(map)),
        other => other,
    }
}

/// An error frame with a stable code.
pub fn error(code: &str, message: &str) -> Value {
    json!({"type": "error", "code": code, "message": message})
}

fn conflict(id: &str) -> Value {
    error(
        "conflict",
        &format!("Operation ID {id} was already used for a different request"),
    )
}

fn not_applied(id: &str) -> Value {
    error(
        "not_applied",
        &format!(
            "Operation {id} was interrupted before it ran; nothing changed. It will not run again; send it under a new operation ID"
        ),
    )
}

fn unknown(id: &str) -> Value {
    json!({"type": "error", "code": "outcome_unknown", "recovery": "inspect_before_retry",
        "message": format!("The outcome of operation {id} is unknown: the daemon stopped while it ran. It will not run again; inspect the current state before sending it under a new operation ID")})
}

fn in_progress(id: &str) -> Value {
    error(
        "in_progress",
        &format!("Operation {id} is still running; retry under the same ID to read its outcome"),
    )
}

/// The canonical payload the fingerprint covers: the request without its
/// operation ID (removed by the fingerprint) and without the per-attempt
/// diagnostic correlation ID.
pub fn payload(request: &Value) -> Value {
    let mut payload = request.clone();
    if let Some(map) = payload.as_object_mut() {
        map.remove("diagnostic_id");
    }
    payload
}

/// The operation ID a request names, or why it cannot be used.
pub fn operation_id(request: &Value) -> Result<&str, Value> {
    match request.get(receipts::OPERATION_ID_FIELD) {
        None => Err(error("invalid_request", "Missing operation_id")),
        Some(Value::String(id)) if !id.is_empty() && id.len() <= MAX_ID_BYTES => Ok(id),
        Some(_) => Err(error(
            "invalid_request",
            "Invalid operation_id: use 1 to 256 bytes of text",
        )),
    }
}

/// The receipt journal for [`OPERATIONS`], on its own connection to the
/// profile database.
pub struct Envelope {
    connection: Mutex<Connection>,
    /// Operation IDs this daemon admitted and has not settled.
    running: Mutex<HashSet<String>>,
}

impl Envelope {
    pub fn open(database: &Path) -> Result<Self> {
        let connection = Connection::open(database)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        // An accepted receipt must survive power loss before the handler acts.
        connection.pragma_update(None, "synchronous", "FULL")?;
        receipts::ensure(&connection)?;
        let envelope = Self::with(connection);
        envelope.recover()?;
        Ok(envelope)
    }

    /// Settles the receipts an earlier daemon left open: still accepted
    /// means the handler never ran ("not applied"); dispatched means it may
    /// have acted ("unknown"). Nothing runs again. Returns how many changed.
    pub fn recover(&self) -> Result<usize> {
        let connection = self.connection.lock().unwrap();
        let open: Vec<(String, String)> = {
            let marks = vec!["?"; OPERATIONS.len()].join(",");
            let mut statement = connection.prepare(&format!(
                "SELECT id,status FROM operations WHERE status IN ('accepted','dispatched','acknowledged') AND op IN ({marks})"
            ))?;
            statement
                .query_map(rusqlite::params_from_iter(OPERATIONS), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?
        };
        for (id, status) in &open {
            let (status, frame) = match Status::parse(status)? {
                Status::Accepted => (Status::Settled, not_applied(id)),
                _ => (Status::Unknown, unknown(id)),
            };
            receipts::settle(
                &connection,
                id,
                status,
                Some(&json!({"error": frame})),
                now_ms(),
            )?;
        }
        Ok(open.len())
    }

    pub fn with(connection: Connection) -> Self {
        Self {
            connection: Mutex::new(connection),
            running: Mutex::new(HashSet::new()),
        }
    }

    /// Runs `handler` once for this operation ID and returns its reply or
    /// error frame, or the frame an earlier attempt recorded. `observe` reads
    /// the current state after an interrupted attempt: `Some(reply)` when the
    /// state proves the effect, which the receipt then records.
    pub fn run(
        &self,
        op: &str,
        request: &Value,
        handler: impl FnOnce() -> Result<Value, Value>,
        observe: impl FnOnce() -> Option<Value>,
    ) -> Value {
        let id = match operation_id(request) {
            Ok(id) => id.to_owned(),
            Err(frame) => return frame,
        };
        let payload = payload(request);
        let admitted = self.admit(&id, op, &payload);
        let admission = match admitted {
            Ok(admission) => admission,
            Err(storage) if STOPS.contains(&op) => {
                tracing::warn!(target: "ade", op, "Running a stop without a receipt: {storage:#}");
                return handler().unwrap_or_else(|frame| frame);
            }
            Err(storage) => {
                return error(
                    "unavailable",
                    &format!("Could not record operation {id}; nothing ran: {storage:#}"),
                );
            }
        };
        match admission {
            Admission::New => {}
            Admission::Conflict => return conflict(&id),
            Admission::Expired => {
                return error(
                    "conflict",
                    &format!("Operation ID {id} has expired; it will not run again"),
                );
            }
            Admission::Replay(receipt) => {
                let running = self.running.lock().unwrap().contains(&id);
                return match replay(&receipt, running) {
                    Replay::Recorded(frame) => frame,
                    Replay::Unresolved(frame) => match observe() {
                        Some(reply) => {
                            self.finish(&id, Status::Settled, &json!({"reply": reply}));
                            reply
                        }
                        None => frame,
                    },
                    Replay::InProgress => in_progress(&id),
                    Replay::NotApplied => {
                        let frame = not_applied(&id);
                        self.finish(&id, Status::Settled, &json!({"error": frame}));
                        frame
                    }
                    Replay::Interrupted => match observe() {
                        Some(reply) => {
                            self.finish(&id, Status::Settled, &json!({"reply": reply}));
                            reply
                        }
                        None => {
                            let frame = unknown(&id);
                            self.finish(&id, Status::Unknown, &json!({"error": frame}));
                            frame
                        }
                    },
                };
            }
        }
        pause("admitted");
        if let Err(storage) = self.dispatch(&id) {
            if !STOPS.contains(&op) {
                // The receipt stays accepted, so a retry reads "not applied".
                self.running.lock().unwrap().remove(&id);
                return error(
                    "unavailable",
                    &format!("Could not record operation {id}; nothing ran: {storage:#}"),
                );
            }
            tracing::warn!(target: "ade", op, "Running a stop past an unrecorded dispatch: {storage:#}");
        }
        pause("dispatched");
        let outcome = handler();
        pause("ran");
        self.finish(&id, Status::Settled, &record(&outcome));
        outcome.unwrap_or_else(|frame| frame)
    }

    fn admit(&self, id: &str, op: &str, payload: &Value) -> Result<Admission> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let admission = receipts::begin(&tx, id, op, payload, None, now_ms())?;
        if admission == Admission::New {
            // Marked before the commit, under the connection lock, so a
            // concurrent retry never reads an admitted receipt as abandoned.
            self.running.lock().unwrap().insert(id.to_owned());
            if let Err(error) = tx.commit() {
                self.running.lock().unwrap().remove(id);
                return Err(error.into());
            }
        }
        Ok(admission)
    }

    fn dispatch(&self, id: &str) -> Result<()> {
        let connection = self.connection.lock().unwrap();
        receipts::settle(&connection, id, Status::Dispatched, None, now_ms())
    }

    /// Records the outcome. A failure leaves the receipt open, so a later
    /// retry reports it unknown rather than running it again.
    fn finish(&self, id: &str, status: Status, result: &Value) {
        let settled = {
            let connection = self.connection.lock().unwrap();
            receipts::settle(&connection, id, status, Some(result), now_ms())
        };
        if let Err(error) = settled {
            tracing::warn!(target: "ade", "Could not record the outcome of operation {id}: {error:#}");
        }
        self.running.lock().unwrap().remove(id);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// E2E only: holds the command at `point` while `<dir>/<point>` exists, so a
/// test can kill the daemon there. The arm file is consumed; the daemon then
/// writes `<point>.reached` and waits for `<point>.release`.
fn pause(point: &str) {
    if !cfg!(debug_assertions)
        || std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() != Ok("1")
    {
        return;
    }
    let Some(directory) = std::env::var_os("ADE_E2E_ENVELOPE_PAUSE_DIR") else {
        return;
    };
    let directory = Path::new(&directory);
    if std::fs::remove_file(directory.join(point)).is_err() {
        return;
    }
    let _ = std::fs::write(directory.join(format!("{point}.reached")), b"");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while !directory.join(format!("{point}.release")).exists()
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> Envelope {
        let connection = Connection::open_in_memory().unwrap();
        receipts::ensure(&connection).unwrap();
        Envelope::with(connection)
    }

    fn request(id: &str, name: &str) -> Value {
        json!({"op": "service.stop", "operation_id": id, "workspace_id": "w", "name": name})
    }

    fn receipt(status: Status, result: Option<Value>) -> Receipt {
        Receipt { status, result }
    }

    #[test]
    fn a_retry_replays_the_recorded_reply_or_error_and_runs_nothing() {
        let envelope = envelope();
        let runs = std::cell::Cell::new(0);
        let run = |request: &Value, outcome: Result<Value, Value>| {
            envelope.run(
                "service.stop",
                request,
                || {
                    runs.set(runs.get() + 1);
                    outcome
                },
                || None,
            )
        };
        let first = run(&request("a", "web"), Ok(json!({"type": "service", "n": 1})));
        assert_eq!(first, json!({"type": "service", "n": 1}));
        assert_eq!(run(&request("a", "web"), Ok(json!({"n": 2}))), first);
        let refused = run(&request("b", "web"), Err(error("daemon", "No service")));
        assert_eq!(run(&request("b", "web"), Ok(json!({}))), refused);
        // A per-attempt diagnostic ID is not part of the payload.
        let mut traced = request("a", "web");
        traced["diagnostic_id"] = json!("trace-2");
        assert_eq!(run(&traced, Ok(json!({}))), first);
        assert_eq!(runs.get(), 2);
    }

    #[test]
    fn another_payload_or_operation_under_the_same_id_conflicts() {
        let envelope = envelope();
        envelope.run(
            "service.stop",
            &request("a", "web"),
            || Ok(json!({})),
            || None,
        );
        let changed = envelope.run(
            "service.stop",
            &request("a", "api"),
            || panic!("ran"),
            || None,
        );
        assert_eq!(changed["code"], "conflict");
        let other_op = envelope.run(
            "service.start",
            &request("a", "web"),
            || panic!("ran"),
            || None,
        );
        assert_eq!(other_op["code"], "conflict");
    }

    #[test]
    fn a_request_without_a_usable_operation_id_never_runs() {
        let envelope = envelope();
        for request in [
            json!({"op": "agent.cancel", "conversation_id": "c"}),
            json!({"op": "agent.cancel", "operation_id": "", "conversation_id": "c"}),
            json!({"op": "agent.cancel", "operation_id": 7, "conversation_id": "c"}),
            json!({"op": "agent.cancel", "operation_id": "x".repeat(257), "conversation_id": "c"}),
        ] {
            let frame = envelope.run("agent.cancel", &request, || panic!("ran"), || None);
            assert_eq!(frame["code"], "invalid_request", "{request}");
        }
    }

    #[test]
    fn an_open_receipt_replays_by_the_step_it_reached() {
        // This daemon is running the first attempt: the retry waits.
        assert_eq!(
            replay(&receipt(Status::Accepted, None), true),
            Replay::InProgress
        );
        assert_eq!(
            replay(&receipt(Status::Dispatched, None), true),
            Replay::InProgress
        );
        // An earlier daemon stopped before or during the handler.
        assert_eq!(
            replay(&receipt(Status::Accepted, None), false),
            Replay::NotApplied
        );
        assert_eq!(
            replay(&receipt(Status::Dispatched, None), false),
            Replay::Interrupted
        );
        // Settled and unknown outcomes replay as recorded, even while running.
        let ack = json!({"type": "ack"});
        assert_eq!(
            replay(
                &receipt(Status::Settled, Some(record(&Ok(ack.clone())))),
                true
            ),
            Replay::Recorded(ack)
        );
        let lost = unknown("x");
        assert_eq!(
            replay(
                &receipt(Status::Unknown, Some(json!({"error": lost.clone()}))),
                false
            ),
            Replay::Unresolved(lost)
        );
    }

    fn abandon(envelope: &Envelope, id: &str, dispatched: bool) {
        // What an earlier daemon leaves behind when it dies mid-command.
        let payload = payload(&request(id, "web"));
        assert_eq!(
            envelope.admit(id, "service.stop", &payload).unwrap(),
            Admission::New
        );
        if dispatched {
            envelope.dispatch(id).unwrap();
        }
        envelope.running.lock().unwrap().clear();
    }

    #[test]
    fn an_interrupted_operation_is_never_run_again() {
        let envelope = envelope();
        abandon(&envelope, "early", false);
        let frame = envelope.run(
            "service.stop",
            &request("early", "web"),
            || panic!("ran"),
            || panic!("observed"),
        );
        assert_eq!(frame["code"], "not_applied");
        assert_eq!(
            envelope.run(
                "service.stop",
                &request("early", "web"),
                || panic!("ran"),
                || None
            ),
            frame
        );

        abandon(&envelope, "late", true);
        let frame = envelope.run(
            "service.stop",
            &request("late", "web"),
            || panic!("ran"),
            || None,
        );
        assert_eq!(frame["code"], "outcome_unknown");
        assert_eq!(
            envelope.run(
                "service.stop",
                &request("late", "web"),
                || panic!("ran"),
                || None
            ),
            frame,
            "an unknown stays unknown until the state proves it"
        );
        // Reconciliation: a later retry whose observation proves the effect settles it.
        let observed = json!({"type": "service"});
        assert_eq!(
            envelope.run(
                "service.stop",
                &request("late", "web"),
                || panic!("ran"),
                || Some(observed.clone())
            ),
            observed
        );
        assert_eq!(
            envelope.run(
                "service.stop",
                &request("late", "web"),
                || panic!("ran"),
                || panic!("observed a settled receipt")
            ),
            observed
        );
    }

    #[test]
    fn an_interrupted_operation_whose_effect_is_observed_settles_with_it() {
        let envelope = envelope();
        abandon(&envelope, "late", true);
        let observed = json!({"type": "service", "status": "stopped"});
        let frame = envelope.run(
            "service.stop",
            &request("late", "web"),
            || panic!("ran"),
            || Some(observed.clone()),
        );
        assert_eq!(frame, observed);
        assert_eq!(
            envelope.run(
                "service.stop",
                &request("late", "web"),
                || panic!("ran"),
                || None
            ),
            observed
        );
    }

    #[test]
    fn opening_settles_what_an_earlier_daemon_left_open_and_nothing_else() {
        let path =
            std::env::temp_dir().join(format!("ade-envelope-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let earlier = Envelope::open(&path).unwrap();
            abandon(&earlier, "early", false);
            abandon(&earlier, "late", true);
            earlier.run(
                "service.stop",
                &request("done", "web"),
                || Ok(json!({"type": "service"})),
                || None,
            );
            // Another domain's open receipt in the same table is not the envelope's to settle.
            let connection = earlier.connection.lock().unwrap();
            receipts::begin(
                &connection,
                "steer",
                "conversation.steer",
                &json!({}),
                None,
                now_ms(),
            )
            .unwrap();
        }
        let next = Envelope::open(&path).unwrap();
        let status = |id: &str| {
            next.connection
                .lock()
                .unwrap()
                .query_row("SELECT status FROM operations WHERE id=?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap()
        };
        assert_eq!(status("early"), "settled");
        assert_eq!(status("late"), "unknown");
        assert_eq!(status("done"), "settled");
        assert_eq!(status("steer"), "accepted");
        let replay = |id: &str| {
            next.run(
                "service.stop",
                &request(id, "web"),
                || panic!("ran"),
                || None,
            )
        };
        assert_eq!(replay("early")["code"], "not_applied");
        assert_eq!(replay("late")["code"], "outcome_unknown");
        assert_eq!(replay("done"), json!({"type": "service"}));
        assert_eq!(next.recover().unwrap(), 0);
        drop(next);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_stop_still_runs_when_its_receipt_cannot_be_written() {
        let connection = Connection::open_in_memory().unwrap();
        receipts::ensure(&connection).unwrap();
        connection.execute_batch("PRAGMA query_only=ON;").unwrap();
        let envelope = Envelope::with(connection);
        let stopped = envelope.run(
            "agent.cancel",
            &json!({"operation_id": "c", "conversation_id": "x"}),
            || Ok(json!({"type": "ack"})),
            || None,
        );
        assert_eq!(stopped, json!({"type": "ack"}));
        let refused = envelope.run(
            "agent.resume",
            &json!({"operation_id": "r", "conversation_id": "x"}),
            || panic!("ran"),
            || None,
        );
        assert_eq!(refused["code"], "unavailable");
    }

    #[test]
    fn the_covered_operations_are_distinct() {
        let unique: HashSet<_> = OPERATIONS.iter().collect();
        assert_eq!(unique.len(), OPERATIONS.len());
        assert!(STOPS.iter().all(|op| covers(op)));
    }
}
