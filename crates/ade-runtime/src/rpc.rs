//! Bounded, owned JSON-lines subprocess transport shared by provider adapters.
use ade_core::error::{Failure, TransportError};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    os::fd::AsRawFd,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

pub enum WireEvent {
    Notification(String, Value),
    Request(Value, String, Value),
    Exited(String),
}

type Reply = std::result::Result<Value, Failure>;
/// The owned child and the shutdown state of its process tree, under one lock
/// so the group is never signalled after its leader was reaped.
struct Owned {
    child: Child,
    shutdown: crate::descendants::Shutdown,
}
/// How often the provider's tree is observed while it runs. It is shorter
/// than the daemon's 2-second record, so a descendant that leaves the group
/// and loses its parent between two daemon records is still seen here first.
const TRACK_INTERVAL: Duration = Duration::from_millis(200);

pub struct Rpc {
    child: Mutex<Owned>,
    /// The tree's tracked descendants as last observed. Kept apart from
    /// `child` so a reader never waits on a stop that holds that lock.
    descendants: Mutex<Vec<crate::descendants::Identity>>,
    pid: u32,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Reply>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    framing: Framing,
}
/// How outgoing messages are framed. Owned bridges take bare messages;
/// external JSON-RPC 2.0 peers such as ACP agents require the version member.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Bare,
    JsonRpc2,
}
impl Rpc {
    pub fn pid(&self) -> u32 {
        self.pid
    }
    /// The processes tracked in the provider's tree other than the provider,
    /// as last observed, including those that left its process group (R006).
    pub fn descendants(&self) -> Vec<crate::descendants::Identity> {
        self.descendants
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
    /// Observe the tree once without signalling it and publish what is
    /// tracked. It never waits for the tree lock, which a stop holds while
    /// proving shutdown, and stops once the transport closed or the leader
    /// was reaped: its group ID may then belong to another process.
    fn track(&self) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(mut owned) = self.child.try_lock() else {
            return true;
        };
        if owned.shutdown.leader_reaped() {
            return false;
        }
        owned.shutdown.track();
        let descendants = owned.shutdown.descendants();
        drop(owned);
        *self
            .descendants
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = descendants;
        true
    }
    pub fn spawn(
        command: Command,
        events: mpsc::SyncSender<crate::provider::Event>,
        decode: fn(WireEvent) -> Result<Option<crate::provider::Event>>,
    ) -> Result<Arc<Self>> {
        Self::spawn_with(command, events, Framing::Bare, decode)
    }
    /// Like [`Rpc::spawn`], with a stateful decoder and a chosen framing.
    pub fn spawn_with(
        command: Command,
        events: mpsc::SyncSender<crate::provider::Event>,
        framing: Framing,
        decode: impl Fn(WireEvent) -> Result<Option<crate::provider::Event>> + Send + 'static,
    ) -> Result<Arc<Self>> {
        Self::spawn_with_limit(command, events, framing, decode, 16 * 1024 * 1024)
    }
    pub(crate) fn spawn_with_limit(
        mut command: Command,
        events: mpsc::SyncSender<crate::provider::Event>,
        framing: Framing,
        decode: impl Fn(WireEvent) -> Result<Option<crate::provider::Event>> + Send + 'static,
        max_frame_bytes: u64,
    ) -> Result<Arc<Self>> {
        use std::os::unix::process::CommandExt;
        let mut child = command
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Could not launch provider; check its installation")?;
        let input = child
            .stdin
            .take()
            .context("Provider stdin pipe was not created")?;
        // A wedged child must not stall request callers while its stdin pipe is full.
        let fd = input.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::last_os_error().into());
            }
        }
        let output = child
            .stdout
            .take()
            .context("Provider stdout pipe was not created")?;
        let errors = child
            .stderr
            .take()
            .context("Provider stderr pipe was not created")?;
        let pid = child.id();
        // Always drain stderr; retain no tokens, credentials, or unbounded logs.
        std::thread::spawn(move || {
            let summary = crate::diagnostics::drain_stderr(errors);
            tracing::info!(target: "ade", event = "provider_stderr_drained", pid, bytes = summary.bytes, newline_count = summary.newline_count, read_failed = summary.read_failed);
        });
        let this = Arc::new(Self {
            child: Mutex::new(Owned {
                child,
                shutdown: crate::descendants::Shutdown::new(pid),
            }),
            descendants: Mutex::new(Vec::new()),
            pid,
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            framing,
        });
        let weak = Arc::downgrade(&this);
        std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                let mut reader = BufReader::new(output);
                loop {
                    let mut line = String::new();
                    let n = reader.by_ref().take(max_frame_bytes).read_line(&mut line)?;
                    ensure!(n != 0, TransportError::Disconnected);
                    ensure!(line.ends_with('\n'), TransportError::MessageTooLarge);
                    ensure!(
                        ade_core::json_budget::within_budget(
                            line.as_bytes(),
                            max_frame_bytes as usize
                        ),
                        TransportError::MessageTooLarge
                    );
                    let message: Value =
                        serde_json::from_str(&line).map_err(|_| TransportError::InvalidMessage)?;
                    let Some(this) = weak.upgrade() else {
                        return Ok(());
                    };
                    if let Some(method) = message["method"].as_str() {
                        let event = if let Some(id) = message.get("id") {
                            WireEvent::Request(id.clone(), method.into(), message["params"].clone())
                        } else {
                            WireEvent::Notification(method.into(), message["params"].clone())
                        };
                        if let Some(event) = decode(event)? {
                            // Block while the run's journal drains this bounded
                            // queue: backpressure reaches the provider's pipe,
                            // and the journal alone decides overflow (an output
                            // failure, never a forced exit). It fails only once
                            // the run stopped draining.
                            events
                                .send(event)
                                .map_err(|_| TransportError::Disconnected)?;
                        }
                    } else if let Some(id) = message.get("id")
                        && let Some(reply) = this
                            .pending
                            .lock()
                            .map_err(|_| TransportError::StateUnavailable)?
                            .remove(&id.to_string())
                    {
                        let value = if let Some(error) = message.get("error") {
                            Err(Failure::provider(error, Failure::Rejected))
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = reply.send(value);
                    }
                }
            })();
            if let Some(this) = weak.upgrade() {
                this.closed.store(true, Ordering::SeqCst);
                let failure_code = result
                    .as_ref()
                    .err()
                    .and_then(|error| error.downcast_ref::<TransportError>())
                    .map(|error| error.code())
                    .unwrap_or("provider_transport_failed");
                tracing::warn!(target: "ade", event = "provider_connection_closed", pid = this.pid, code = failure_code);
                let failure = result
                    .as_ref()
                    .err()
                    .and_then(|error| error.downcast_ref::<TransportError>())
                    .copied()
                    .map(Failure::from)
                    .unwrap_or(Failure::Disconnected);
                for (_, reply) in this
                    .pending
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .drain()
                {
                    let _ = reply.try_send(Err(failure));
                }
                // Direct-child exit is not proof the tree stopped; say so when unproven.
                let error = match this.stop_confirmed() {
                    Ok(()) => failure.to_string(),
                    Err(stop) => format!("{failure}. {stop}"),
                };
                // Blocking only after pending RPCs have been released; no lost lifecycle event.
                let _ = events.send(crate::provider::Event::Exited { error });
            }
        });
        // Track the tree from the start and while it runs, so a descendant
        // that later leaves the group and loses its parent stays known.
        this.track();
        let tracked = Arc::downgrade(&this);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(TRACK_INTERVAL);
                let Some(this) = tracked.upgrade() else {
                    return;
                };
                if !this.track() {
                    return;
                }
            }
        });
        tracing::info!(target: "ade", event = "provider_started", pid);
        Ok(this)
    }
    /// True once the transport is closed; no further reply can arrive.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    fn write(&self, mut value: Value) -> Result<()> {
        if self.framing == Framing::JsonRpc2 {
            value["jsonrpc"] = json!("2.0");
        }
        ensure!(
            !self.closed.load(Ordering::SeqCst),
            TransportError::Disconnected
        );
        let mut input = self
            .input
            .lock()
            .map_err(|_| TransportError::StateUnavailable)?;
        let bytes = format!("{value}\n").into_bytes();
        let mut offset = 0;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while offset < bytes.len() {
            match input.write(&bytes[offset..]) {
                Ok(0) => {
                    self.stop();
                    bail!(TransportError::Disconnected);
                }
                Ok(n) => offset += n,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        self.stop();
                        bail!(TransportError::WriteTimeout);
                    }
                    let mut poll = libc::pollfd {
                        fd: input.as_raw_fd(),
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    unsafe {
                        libc::poll(&mut poll, 1, 50);
                    }
                }
                Err(error) => {
                    self.stop();
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, Some(Duration::from_secs(45)))
    }
    /// A request whose reply may take as long as the peer's work. With no
    /// limit the caller waits until the reply or the end of the transport.
    pub fn request_within(
        &self,
        method: &str,
        params: Value,
        limit: Option<Duration>,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| TransportError::StateUnavailable)?
            .insert(id.to_string(), tx);
        if let Err(error) = self.write(json!({"id":id,"method":method,"params":params})) {
            self.pending
                .lock()
                .map_err(|_| TransportError::StateUnavailable)?
                .remove(&id.to_string());
            return Err(error);
        }
        let result = match limit {
            Some(limit) => rx.recv_timeout(limit),
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        self.pending
            .lock()
            .map_err(|_| TransportError::StateUnavailable)?
            .remove(&id.to_string());
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(failure)) => Err(failure.into()),
            Err(_) => {
                self.stop();
                bail!(TransportError::OutcomeUnknown);
            }
        }
    }
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(json!({"method":method,"params":params}))
    }
    pub fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write(json!({"id":id,"result":result}))
    }
    pub fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.write(json!({"id":id,"error":{"code":-32601,"message":message}}))
    }
    pub fn stop(&self) {
        let _ = self.stop_confirmed();
    }
    /// Confirm the owned provider process has exited before releasing its session.
    /// Cleanup callers may ignore failure; ownership transfers must propagate it.
    pub fn stop_confirmed(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        for (_, reply) in self
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .drain()
        {
            let _ = reply.try_send(Err(Failure::Disconnected));
        }
        let mut owned = self
            .child
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Owned { child, shutdown } = &mut *owned;
        // Direct-child exit is not proof of shutdown. Signal the whole tree
        // (TERM, then KILL after a grace period) and require positive evidence
        // that every observed process has exited. Only the tree's verdict step
        // reaps the child, so the group ID stays reserved while it is signalled
        // and is never signalled again after reaping.
        let verdict = shutdown.stop(&crate::descendants::Policy::default(), &mut || {
            child.try_wait().map(|status| status.is_some())
        });
        match verdict {
            crate::descendants::Verdict::Exited => Ok(()),
            verdict => {
                tracing::warn!(target: "ade", event = "provider_shutdown_unconfirmed", pid = self.pid, verdict = verdict.code());
                Err(crate::descendants::Unconfirmed(verdict).into())
            }
        }
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.stop_confirmed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_response_is_typed_without_retaining_raw_error_payload() {
        let (tx, _rx) = mpsc::sync_channel(8);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read request; printf '%s\\n' '{\"id\":1,\"error\":{\"status\":401,\"message\":\"Bearer secret\"}}'; read request"]);
        let rpc = Rpc::spawn(command, tx, |_| Ok(None)).unwrap();
        let error = rpc.request("open", json!({})).unwrap_err();
        assert_eq!(
            error.downcast_ref::<Failure>(),
            Some(&Failure::Authentication)
        );
        assert!(!error.to_string().contains("secret"));
        rpc.stop_confirmed().unwrap();
    }
    #[test]
    fn invalid_provider_json_releases_waiters_and_reports_safe_failure() {
        let (tx, rx) = mpsc::sync_channel(8);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read request; printf 'secret-not-json\\n'"]);
        let rpc = Rpc::spawn(command, tx, |_| Ok(None)).unwrap();
        let error = rpc.request("test", json!({})).unwrap_err().to_string();
        assert!(error.contains("invalid JSON"), "{error}");
        assert!(!error.contains("secret"));
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            crate::provider::Event::Exited { .. }
        ));
        assert!(rpc.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn poisoned_pending_state_fails_requests_but_cleanup_still_reaps() {
        let (tx, _rx) = mpsc::sync_channel(8);
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let rpc = Rpc::spawn(command, tx, |_| Ok(None)).unwrap();
        let other = rpc.clone();
        let _ = std::thread::spawn(move || {
            let _guard = other.pending.lock().unwrap();
            panic!("simulated state failure");
        })
        .join();
        let error = rpc.request("test", json!({})).unwrap_err();
        assert_eq!(
            error.downcast_ref::<TransportError>(),
            Some(&TransportError::StateUnavailable)
        );
        rpc.stop_confirmed().unwrap();
    }

    #[test]
    fn stop_reaps_provider_before_returning_and_is_repeatable() {
        let (tx, _rx) = mpsc::sync_channel(8);
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let rpc = Rpc::spawn(command, tx, |_| Ok(None)).unwrap();
        let pid = rpc.pid() as i32;
        rpc.stop();
        // A kill signal alone leaves a live child or zombie. Neither releases
        // ownership: the process must have exited and been reaped already.
        let mut status = 0;
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        assert_eq!(result, -1, "stop returned before reaping its provider");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        rpc.stop();
    }
}
