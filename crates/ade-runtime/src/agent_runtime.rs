//! Process ownership and acknowledged event replay. No application database access.
//! Command receipts live for a run; replacing the application cannot replay side effects.
use crate::{
    model::PendingRequest,
    provider::{self, Config, Connected, Event, Provider},
    runtime,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

const LIMIT: usize = 32 * 1024 * 1024;
pub const FRAME: u64 = 17 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct Spec {
    pub conversation: String,
    pub run: String,
    pub provider: String,
    pub root: String,
    #[serde(default)]
    pub account: Option<ade_core::model::AccountExecution>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub sequence: u64,
    pub event: Event,
}
struct Journal {
    events: VecDeque<(Envelope, usize)>,
    next: u64,
    acknowledged: u64,
    bytes: usize,
    closed: bool,
}
struct Receipt {
    fingerprint: [u8; 32],
    result: Mutex<Option<Value>>,
    ready: Condvar,
}
impl Receipt {
    fn wait(&self) -> Result<Value> {
        let result = self.result.lock().unwrap();
        let (result, _) = self
            .ready
            .wait_timeout_while(result, Duration::from_secs(50), |v| v.is_none())
            .unwrap();
        result
            .clone()
            .context("Agent operation is still pending; reconnect without resending it")
    }
}
pub struct Admission {
    request: Value,
    receipt: Option<Arc<Receipt>>,
    deliver: bool,
}
pub struct Run {
    pub spec: Spec,
    adapter: Arc<dyn Provider>,
    journal: Mutex<Journal>,
    changed: Condvar,
    receipts: Mutex<HashMap<String, Arc<Receipt>>>,
    receipt_bytes: AtomicUsize,
}
impl Run {
    pub fn spawn(spec: Spec) -> Result<Arc<Self>> {
        let (tx, rx) = mpsc::sync_channel(256);
        let adapter = provider::spawn(&spec.provider, &spec.root, spec.account.as_ref(), tx)?;
        let run = Arc::new(Self {
            spec,
            adapter,
            journal: Mutex::new(Journal {
                events: VecDeque::new(),
                next: 1,
                acknowledged: 0,
                bytes: 0,
                closed: false,
            }),
            changed: Condvar::new(),
            receipts: Mutex::new(HashMap::new()),
            receipt_bytes: AtomicUsize::new(0),
        });
        let weak = Arc::downgrade(&run);
        std::thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                let Some(run) = weak.upgrade() else { break };
                if !run.append(event) {
                    run.adapter.stop();
                    break;
                }
            }
        });
        Ok(run)
    }
    fn append(&self, event: Event) -> bool {
        let mut journal = self.journal.lock().unwrap();
        if journal.closed {
            return false;
        }
        let bytes = serde_json::to_vec(&event).map(|v| v.len()).unwrap_or(LIMIT);
        let (event, bytes, healthy) = if bytes >= FRAME as usize - 65536
            || journal.bytes + bytes > LIMIT
        {
            (Event::Exited { error: "Agent event replay buffer exhausted while the daemon was unavailable; resume explicitly".into() }, 256, false)
        } else {
            (event, bytes, true)
        };
        let sequence = journal.next;
        journal.next += 1;
        journal.bytes += bytes;
        journal.closed = matches!(event, Event::Exited { .. });
        journal
            .events
            .push_back((Envelope { sequence, event }, bytes));
        self.changed.notify_all();
        healthy
    }
    pub fn events(&self, after: u64) -> Result<Value> {
        let mut journal = self.journal.lock().unwrap();
        ensure!(
            after >= journal.acknowledged && after < journal.next,
            "Agent event cursor is outside the retained journal"
        );
        if after + 1 == journal.next && !journal.closed {
            journal = self
                .changed
                .wait_timeout(journal, Duration::from_secs(1))
                .unwrap()
                .0;
        }
        if !journal.closed && journal.next > after + 1 {
            // Coalesce token bursts before one durable application transaction.
            drop(journal);
            std::thread::sleep(Duration::from_millis(20));
            journal = self.journal.lock().unwrap();
        }
        let mut size = 0;
        let events: Vec<_> = journal
            .events
            .iter()
            .filter(|(e, _)| e.sequence > after)
            .take(128)
            .take_while(|(_, bytes)| {
                size += bytes;
                size < FRAME as usize - 65536
            })
            .map(|(e, _)| e.clone())
            .collect();
        Ok(json!({"type":"events","events":events,"closed":journal.closed}))
    }
    pub fn acknowledge(&self, cursor: u64) -> Result<Value> {
        let mut journal = self.journal.lock().unwrap();
        ensure!(
            cursor < journal.next,
            "Cannot acknowledge an unpublished event"
        );
        while journal
            .events
            .front()
            .is_some_and(|(e, _)| e.sequence <= cursor)
        {
            let (_, bytes) = journal.events.pop_front().unwrap();
            journal.bytes -= bytes;
        }
        journal.acknowledged = journal.acknowledged.max(cursor);
        Ok(json!({"type":"ack"}))
    }
    pub fn describe(&self) -> Value {
        let receipts = self.receipts.lock().unwrap();
        json!({"spec":self.spec,"pid":self.adapter.pid(),"commands":receipts.keys().collect::<Vec<_>>()})
    }
    pub fn connected(&self) -> Result<Value> {
        let receipt = self
            .receipts
            .lock()
            .unwrap()
            .get("open")
            .cloned()
            .context("Agent startup was not admitted before daemon loss; resume explicitly")?;
        receipt.wait()
    }
    /// Must run while the supervisor still holds its owner-admission lock.
    pub fn admit(&self, request: &Value) -> Result<Admission> {
        let method = request["method"].as_str().context("Missing Agent method")?;
        if method == "validate" || method == "child_transcript" {
            return Ok(Admission {
                request: request.clone(),
                receipt: None,
                deliver: true,
            });
        }
        let key = request["key"]
            .as_str()
            .context("Missing command identity")?;
        // Keep exact-payload retry protection without retaining image bodies
        // for the entire Agent lifetime. Key ordering is not part of identity.
        let fingerprint: [u8; 32] = {
            let mut canonical = request.clone();
            canonical.sort_all_objects();
            let mut digest = Sha256::new();
            serde_json::to_writer(&mut digest, &canonical)?;
            digest.finalize().into()
        };
        let mut receipts = self.receipts.lock().unwrap();
        if let Some(receipt) = receipts.get(key) {
            ensure!(
                receipt.fingerprint == fingerprint,
                "Agent command identity reused with different content"
            );
            return Ok(Admission {
                request: json!({"method":method}),
                receipt: Some(receipt.clone()),
                deliver: false,
            });
        }
        let bytes = std::mem::size_of::<Receipt>() + key.len();
        ensure!(
            receipts.len() < 4096 && self.receipt_bytes.load(Ordering::Relaxed) + bytes <= LIMIT,
            "Agent command receipt limit reached; disconnect and resume before continuing"
        );
        self.receipt_bytes.fetch_add(bytes, Ordering::Relaxed);
        let receipt = Arc::new(Receipt {
            fingerprint,
            result: Mutex::new(None),
            ready: Condvar::new(),
        });
        receipts.insert(key.into(), receipt.clone());
        Ok(Admission {
            request: request.clone(),
            receipt: Some(receipt),
            deliver: true,
        })
    }
    #[cfg(test)]
    fn execute(&self, request: &Value) -> Result<Value> {
        self.perform(self.admit(request)?)
    }
    pub fn perform(&self, admission: Admission) -> Result<Value> {
        let request = &admission.request;
        let method = request["method"].as_str().context("Missing Agent method")?;

        if method == "child_transcript" {
            return self.adapter.child_transcript(
                request["session"].as_str().context("Missing session")?,
                request["child"].as_str().context("Missing child")?,
                request["offset"].as_u64().context("Missing offset")?,
                request["cursor"].as_str(),
            );
        }
        if method == "validate" {
            let p: PendingRequest = serde_json::from_value(request["request"].clone())?;
            ensure!(
                p.run_id == self.spec.run && p.conversation_id == self.spec.conversation,
                "Interaction belongs to another Agent run"
            );
            self.adapter.validate_answer(
                &p,
                request["decision"].as_str().context("Missing decision")?,
                request.get("answers").filter(|v| !v.is_null()),
            )?;
            return Ok(json!({"type":"ack"}));
        }
        let receipt = admission.receipt.context("Missing command receipt")?;
        if !admission.deliver {
            return receipt.wait();
        }
        // Reserve before delivery; independent operations can finish out of order.
        let mut result = (|| -> Result<Value> {
            let string = |key: &str| request[key].as_str().with_context(|| format!("Missing {key}"));
            match method {
                "open" => Ok(json!({"type":"connected","connected":self.adapter.open(request["resume"].as_str(), &serde_json::from_value(request["config"].clone())?)?})),
                "send" => {
                    let turn = self.adapter.send(string("session")?, string("submission")?, request["message_id"].as_str(), &serde_json::from_value(request.get("prompt").cloned().unwrap_or_else(||json!({"text":request["text"]})))?)?;
                    self.append(Event::Submitted { submission: string("submission")?.into(), turn: turn.clone() });
                    Ok(json!({"type":"sent","turn":turn}))
                }
                "cancel" => { self.adapter.cancel(string("session")?, string("turn")?)?; Ok(json!({"type":"ack"})) }
                "answer" => {
                    let p: PendingRequest = serde_json::from_value(request["request"].clone())?;
                    ensure!(p.run_id == self.spec.run && p.conversation_id == self.spec.conversation, "Interaction belongs to another Agent run");
                    self.adapter.answer(&p, string("decision")?, request.get("answers").filter(|v| !v.is_null()))?;
                    self.append(Event::Resolved { id: p.rpc_id });
                    Ok(json!({"type":"ack"}))
                }
                "reject" => { self.adapter.reject(request["id"].clone(), string("message")?)?; Ok(json!({"type":"ack"})) }
                _ => bail!("Unknown Agent method"),
            }
        })().unwrap_or_else(ade_core::error::error_envelope);
        let result_bytes = serde_json::to_vec(&result)?.len();
        let previous = self
            .receipt_bytes
            .fetch_add(result_bytes, Ordering::Relaxed);
        if result_bytes >= FRAME as usize || previous + result_bytes > LIMIT {
            self.receipt_bytes
                .fetch_sub(result_bytes, Ordering::Relaxed);
            result = json!({"type":"error","message":"Agent receipt storage limit reached; outcome retained as failed, never replay automatically"});
        }
        if result["type"] == "error" {
            self.append(Event::OperationFailed {
                submission: request["submission"].as_str().map(str::to_owned),
                error: result["message"]
                    .as_str()
                    .unwrap_or("Provider operation failed")
                    .into(),
            });
        }
        *receipt.result.lock().unwrap() = Some(result.clone());
        receipt.ready.notify_all();
        Ok(result)
    }
    pub fn stop(&self) {
        let _ = self.stop_confirmed();
    }
    pub fn stop_confirmed(&self) -> Result<()> {
        self.adapter.stop_confirmed()?;
        self.append(Event::Exited {
            error: "Agent disconnected".into(),
        });
        Ok(())
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        self.adapter.stop();
    }
}

pub fn read(reader: &mut BufReader<UnixStream>) -> Result<Value> {
    let mut line = String::new();
    reader.by_ref().take(FRAME).read_line(&mut line)?;
    ensure!(
        line.ends_with('\n'),
        "Agent runtime disconnected or frame exceeded limit"
    );
    Ok(serde_json::from_str(&line)?)
}
pub fn write(stream: &mut UnixStream, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() < FRAME as usize,
        "Agent runtime frame exceeds limit"
    );
    stream.write_all(&bytes)?;
    stream.write_all(b"\n")?;
    Ok(())
}

pub struct Remote {
    runtime: Arc<runtime::Supervisor>,
    pub spec: Spec,
}
impl Remote {
    pub fn new(runtime: Arc<runtime::Supervisor>, spec: Spec) -> Arc<Self> {
        Arc::new(Self { runtime, spec })
    }
    fn call(&self, method: &str, key: String, mut args: Value) -> Result<Value> {
        args["method"] = json!(method);
        args["key"] = json!(key);
        self.runtime
            .agent(json!({"op":"agent.command","run":self.spec.run,"command":args}))
    }
    pub fn events(&self, after: u64) -> Result<Vec<Envelope>> {
        let result = self
            .runtime
            .agent(json!({"op":"agent.events","run":self.spec.run,"after":after}))?;
        Ok(serde_json::from_value(result["events"].clone())?)
    }
    pub fn acknowledge(&self, cursor: u64) -> Result<()> {
        self.runtime
            .agent(json!({"op":"agent.ack","run":self.spec.run,"cursor":cursor}))?;
        Ok(())
    }
    pub fn connected(&self) -> Result<Connected> {
        let result = self
            .runtime
            .agent(json!({"op":"agent.connected","run":self.spec.run}))?;
        Ok(serde_json::from_value(result["connected"].clone())?)
    }
    pub fn create(&self) -> Result<()> {
        self.runtime
            .agent(json!({"op":"agent.create","spec":self.spec}))?;
        Ok(())
    }
}
impl Provider for Remote {
    fn child_transcript(
        &self,
        session: &str,
        child: &str,
        offset: u64,
        cursor: Option<&str>,
    ) -> Result<Value> {
        self.call(
            "child_transcript",
            String::new(),
            json!({"session":session,"child":child,"offset":offset,"cursor":cursor}),
        )
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        let result = self.call(
            "open",
            "open".into(),
            json!({"resume":resume,"config":config}),
        )?;
        Ok(serde_json::from_value(result["connected"].clone())?)
    }
    fn send(
        &self,
        session: &str,
        submission: &str,
        message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        Ok(self.call(
            "send",
            format!("send:{submission}"),
            json!({"session":session,"submission":submission,"message_id":message_id,"prompt":prompt}),
        )?["turn"]
            .as_str()
            .context("Missing turn")?
            .into())
    }
    fn prepare_submission(&self) -> Option<String> {
        match self.spec.provider.as_str() {
            "claude" | "omp" => Some(uuid::Uuid::new_v4().to_string()),
            "opencode" => Some(format!("msg_{}", uuid::Uuid::new_v4())),
            _ => None,
        }
    }
    fn cancel(&self, session: &str, turn: &str) -> Result<()> {
        self.call(
            "cancel",
            format!("cancel:{turn}"),
            json!({"session":session,"turn":turn}),
        )?;
        Ok(())
    }
    fn validate_answer(
        &self,
        p: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        self.call(
            "validate",
            String::new(),
            json!({"request":p,"decision":decision,"answers":answers}),
        )?;
        Ok(())
    }
    fn answer(&self, p: &PendingRequest, decision: &str, answers: Option<&Value>) -> Result<()> {
        self.call(
            "answer",
            format!("answer:{}", p.id),
            json!({"request":p,"decision":decision,"answers":answers}),
        )?;
        Ok(())
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.call(
            "reject",
            format!("reject:{id}"),
            json!({"id":id,"message":message}),
        )?;
        Ok(())
    }
    fn stop(&self) {
        let _ = self.stop_confirmed();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.runtime
            .agent(json!({"op":"agent.stop","run":self.spec.run}))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        sends: AtomicUsize,
        gate: (Mutex<bool>, Condvar),
    }
    impl Provider for Fake {
        fn open(&self, _: Option<&str>, _: &Config) -> Result<Connected> {
            Ok(Connected {
                session: "session".into(),
                history: vec![],
            })
        }
        fn send(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
            _: &crate::prompt::Prompt,
        ) -> Result<String> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            let done = self.gate.0.lock().unwrap();
            let _guard = self
                .gate
                .1
                .wait_timeout_while(done, Duration::from_secs(3), |v| !*v)
                .unwrap();
            Ok("turn".into())
        }
        fn cancel(&self, _: &str, _: &str) -> Result<()> {
            *self.gate.0.lock().unwrap() = true;
            self.gate.1.notify_all();
            Ok(())
        }
        fn validate_answer(&self, _: &PendingRequest, _: &str, _: Option<&Value>) -> Result<()> {
            Ok(())
        }
        fn answer(&self, _: &PendingRequest, _: &str, _: Option<&Value>) -> Result<()> {
            Ok(())
        }
        fn reject(&self, _: Value, _: &str) -> Result<()> {
            Ok(())
        }
        fn stop(&self) {}
    }
    fn fixture() -> (Arc<Run>, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        (
            Arc::new(Run {
                spec: Spec {
                    conversation: "c".into(),
                    run: "r".into(),
                    provider: "codex".into(),
                    root: "/tmp".into(),
                    account: None,
                },
                adapter: fake.clone(),
                journal: Mutex::new(Journal {
                    events: VecDeque::new(),
                    next: 1,
                    acknowledged: 0,
                    bytes: 0,
                    closed: false,
                }),
                changed: Condvar::new(),
                receipts: Mutex::new(HashMap::new()),
                receipt_bytes: AtomicUsize::new(0),
            }),
            fake,
        )
    }
    #[test]
    fn unconfirmed_shutdown_does_not_publish_a_false_exit() {
        let (run, _) = fixture();
        assert!(run.stop_confirmed().is_err());
        let journal = run.journal.lock().unwrap();
        assert!(!journal.closed);
        assert!(journal.events.is_empty());
    }
    #[test]
    fn lost_reply_retry_runs_once_and_cancel_does_not_wait_for_send_reply() {
        let (run, fake) = fixture();
        let send = json!({"method":"send","key":"send:1","submission":"1","session":"session","text":"hello"});
        let admitted = run.admit(&send).unwrap();
        assert!(
            run.describe()["commands"]
                .as_array()
                .unwrap()
                .contains(&json!("send:1"))
        );
        assert_eq!(fake.sends.load(Ordering::SeqCst), 0);
        let first = {
            let run = run.clone();
            std::thread::spawn(move || run.perform(admitted).unwrap())
        };
        while fake.sends.load(Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        let retry = {
            let run = run.clone();
            let send = send.clone();
            std::thread::spawn(move || run.execute(&send).unwrap())
        };
        let before = std::time::Instant::now();
        assert_eq!(
            run.execute(
                &json!({"method":"cancel","key":"cancel:turn","session":"session","turn":"turn"})
            )
            .unwrap()["type"],
            "ack"
        );
        assert!(before.elapsed() < Duration::from_secs(1));
        assert_eq!(first.join().unwrap(), retry.join().unwrap());
        assert_eq!(fake.sends.load(Ordering::SeqCst), 1);
        let mut changed = send;
        changed["text"] = json!("different");
        assert!(run.execute(&changed).is_err());
    }
    #[test]
    fn completed_attachment_commands_do_not_retain_attachment_bytes() {
        let (run, fake) = fixture();
        *fake.gate.0.lock().unwrap() = true;
        let payload = "A".repeat(8 * 1024 * 1024);
        for index in 0..6 {
            let request = json!({"method":"send","key":format!("send:{index}"),"submission":index.to_string(),"session":"session","prompt":{"text":"Image","attachments":[{"attachment":{"id":format!("image-{index}"),"name":"image.png","media_type":"image/png","size":6*1024*1024},"data":payload}]}});
            let result = run
                .execute(&request)
                .expect("Completed image requests must release their payloads");
            assert_eq!(result["type"], "sent");
            assert_eq!(run.execute(&request).unwrap(), result);
            let mut reordered = request.clone();
            reordered.sort_all_objects();
            assert_eq!(run.execute(&reordered).unwrap(), result);
            let mut changed = request.clone();
            changed["prompt"]["attachments"][0]["data"] = json!("different bytes");
            assert!(run.execute(&changed).is_err());
        }
        assert_eq!(fake.sends.load(Ordering::SeqCst), 6);
        assert!(run.receipt_bytes.load(Ordering::Relaxed) < 64 * 1024);
    }
    #[test]
    fn replay_retains_unacknowledged_events_and_rejects_cursor_gaps() {
        let (run, _) = fixture();
        run.append(Event::Resolved { id: json!("first") });
        run.append(Event::Resolved {
            id: json!("second"),
        });
        let first = run.events(0).unwrap();
        assert_eq!(first, run.events(0).unwrap()); // caller lost the response
        assert!(run.acknowledge(3).is_err());
        run.acknowledge(1).unwrap();
        assert!(run.events(0).is_err());
        assert_eq!(run.events(1).unwrap()["events"][0]["event"]["id"], "second");
    }
    #[test]
    fn overflow_preserves_earlier_events_and_reports_failure() {
        let (run, _) = fixture();
        for _ in 0..2 {
            assert!(run.append(Event::Error {
                error: "x".repeat(12 * 1024 * 1024)
            }));
        }
        assert!(!run.append(Event::Error {
            error: "x".repeat(12 * 1024 * 1024)
        }));
        let journal = run.journal.lock().unwrap();
        assert_eq!(journal.events.len(), 3);
        assert_eq!(journal.events[0].0.sequence, 1);
        assert!(matches!(journal.events[2].0.event, Event::Exited { .. }));
        assert!(journal.closed);
    }
}
