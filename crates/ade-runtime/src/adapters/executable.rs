//! Custom executable adapter: a plain CLI agent, prompt in and text out.
//!
//! Each turn launches the configured executable once in its own process
//! group. The prompt goes to standard input or the final argument, and
//! standard output streams back as one assistant message. Standard error is
//! drained and never shown, because it may hold secrets.
//!
//! The capabilities are the honest minimum: `streaming` and `cancel`. There
//! is no resume, no approval, no question and no attachment. A turn ends only
//! after the whole process tree is proven stopped.
use crate::{
    descendants::{Policy, Shutdown, Verdict},
    model::PendingRequest,
    provider::{Config, Connected, Event, Item, Provider},
};
use ade_core::contract::providers::adapters::{AdapterDefinition, PromptInput};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::{
    io::{Read, Write},
    process::{Child, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc,
    },
    time::Duration,
};

/// The capabilities every custom executable has.
pub const CAPABILITIES: &[&str] = &["streaming", "cancel"];
/// Output beyond this ends the turn; it matches the daemon's message bound.
const OUTPUT_LIMIT: usize = 1024 * 1024;
/// A prompt passed as an argument must fit comfortably under `ARG_MAX`.
const ARGUMENT_LIMIT: usize = 128 * 1024;

/// Why ADE ended a turn before the process exited on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Interruption {
    None = 0,
    Cancelled = 1,
    TimedOut = 2,
    Overflowed = 3,
}

impl Interruption {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Cancelled,
            2 => Self::TimedOut,
            3 => Self::Overflowed,
            _ => Self::None,
        }
    }
}

/// How a process ended, as far as ADE could prove.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    Signal(i32),
    Unknown,
}

/// Decides a turn's status and error from what was observed. A tree that was
/// not proven stopped is a failure whatever the exit code said.
pub fn settle(
    interruption: Interruption,
    exit: Exit,
    tree_stopped: bool,
    timeout_seconds: u32,
) -> (&'static str, Option<String>) {
    if !tree_stopped {
        return (
            "failed",
            Some(
                "The agent's process tree was not confirmed stopped; ownership remains reserved"
                    .into(),
            ),
        );
    }
    match (interruption, exit) {
        (Interruption::Cancelled, _) => ("interrupted", None),
        (Interruption::TimedOut, _) => (
            "failed",
            Some(format!(
                "The agent did not finish within {timeout_seconds} seconds and was stopped"
            )),
        ),
        (Interruption::Overflowed, _) => (
            "failed",
            Some("The agent's output exceeded 1 MiB and it was stopped".into()),
        ),
        (Interruption::None, Exit::Code(0)) => ("completed", None),
        (Interruption::None, Exit::Code(code)) => (
            "failed",
            Some(format!("The agent exited with status {code}")),
        ),
        (Interruption::None, Exit::Signal(signal)) => (
            "failed",
            Some(format!("The agent was stopped by signal {signal}")),
        ),
        (Interruption::None, Exit::Unknown) => (
            "failed",
            Some("The agent's exit status could not be read".into()),
        ),
    }
}

/// Decodes a byte stream as UTF-8 across read boundaries. Invalid bytes
/// become U+FFFD; an incomplete trailing sequence waits for the next read.
#[derive(Default)]
pub struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &self.carry;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&rest[..valid]).expect("validated prefix"));
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + len..];
                        }
                        None => {
                            rest = &rest[valid..];
                            break;
                        }
                    }
                }
            }
        }
        self.carry = rest.to_vec();
        out
    }

    pub fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        tail
    }
}

struct Owned {
    child: Child,
    shutdown: Shutdown,
}

struct Active {
    turn: String,
    process: Mutex<Owned>,
    interruption: AtomicU8,
    /// Set once the tree's verdict is known and the turn's events were sent.
    settled: Mutex<Option<bool>>,
    settled_changed: Condvar,
}

impl Active {
    fn interrupt(&self, why: Interruption) {
        let _ = self.interruption.compare_exchange(
            Interruption::None as u8,
            why as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        let mut owned = self.process.lock().unwrap_or_else(|p| p.into_inner());
        // Once the leader is reaped its group ID may be reused; never signal it.
        if !owned.shutdown.leader_reaped() {
            owned.shutdown.kill_now();
        }
    }

    fn wait_settled(&self, limit: Duration) -> Option<bool> {
        let settled = self.settled.lock().unwrap_or_else(|p| p.into_inner());
        let (settled, _) = self
            .settled_changed
            .wait_timeout_while(settled, limit, |s| s.is_none())
            .unwrap_or_else(|p| p.into_inner());
        *settled
    }
}

pub struct Adapter {
    definition: AdapterDefinition,
    cwd: String,
    events: mpsc::SyncSender<Event>,
    session: Mutex<Option<String>>,
    active: Arc<Mutex<Option<Arc<Active>>>>,
    /// Set when stopped, or when a tree could not be proven stopped.
    closed: Arc<AtomicBool>,
    exited: AtomicBool,
}

impl Adapter {
    pub fn spawn(
        definition: &AdapterDefinition,
        cwd: &str,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        ensure!(
            definition.executable.is_some(),
            "Custom executable adapter has no executable settings"
        );
        super::check_executable(&definition.command)?;
        Ok(Arc::new(Self {
            definition: definition.clone(),
            cwd: cwd.into(),
            events,
            session: Mutex::new(None),
            active: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            exited: AtomicBool::new(false),
        }))
    }

    fn settings(&self) -> &ade_core::contract::providers::adapters::ExecutableSettings {
        self.definition
            .executable
            .as_ref()
            .expect("checked at spawn")
    }

    fn launch(&self, session: &str, turn: &str, text: &str) -> Result<Arc<Active>> {
        use std::os::unix::process::CommandExt;
        let settings = self.settings();
        let mut command = super::command(&self.definition, &self.cwd);
        if settings.prompt_input == PromptInput::Argument {
            command.arg(text);
        }
        let mut child = command
            .process_group(0)
            .stdin(if settings.prompt_input == PromptInput::Stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Could not launch the custom executable; check its path and permissions")?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .context("Agent stdout pipe was not created")?;
        let stderr = child
            .stderr
            .take()
            .context("Agent stderr pipe was not created")?;
        let active = Arc::new(Active {
            turn: turn.into(),
            process: Mutex::new(Owned {
                child,
                shutdown: Shutdown::new(pid),
            }),
            interruption: AtomicU8::new(Interruption::None as u8),
            settled: Mutex::new(None),
            settled_changed: Condvar::new(),
        });
        if let Err(error) = self.events.try_send(Event::Started {
            session: session.into(),
            submission: None,
            turn: Some(turn.into()),
        }) {
            active.interrupt(Interruption::Cancelled);
            let _ = self.finish_tree(&active);
            bail!("Agent event queue is unavailable: {error}");
        }
        std::thread::spawn(move || {
            let summary = crate::diagnostics::drain_stderr(stderr);
            tracing::info!(target: "ade", event = "custom_agent_stderr_drained", pid, bytes = summary.bytes);
        });
        if let Some(mut stdin) = stdin {
            let prompt = text.as_bytes().to_vec();
            // A child that never reads its input must not stall the turn.
            std::thread::spawn(move || {
                let _ = stdin.write_all(&prompt);
            });
        }
        let reader = {
            let active = active.clone();
            let events = self.events.clone();
            let session = session.to_owned();
            let item = format!("{turn}:output");
            let turn = turn.to_owned();
            std::thread::spawn(move || {
                read_output(stdout, &active, &events, &session, &turn, &item)
            })
        };
        let (done, done_rx) = mpsc::channel::<()>();
        {
            let active = active.clone();
            let timeout = Duration::from_secs(u64::from(settings.timeout_seconds));
            std::thread::spawn(move || {
                if done_rx.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                    active.interrupt(Interruption::TimedOut);
                }
            });
        }
        {
            let active = active.clone();
            let slot = self.active.clone();
            let closed = self.closed.clone();
            let events = self.events.clone();
            let session = session.to_owned();
            let timeout_seconds = settings.timeout_seconds;
            std::thread::spawn(move || {
                wait_leader(pid);
                let (stopped, exit) = Self::stop_tree(&active);
                drop(done);
                let text = reader.join().unwrap_or_default();
                let interruption =
                    Interruption::from_u8(active.interruption.load(Ordering::SeqCst));
                let (status, error) = settle(interruption, exit, stopped, timeout_seconds);
                if !text.is_empty() {
                    let _ = events.send(Event::Item {
                        session: session.clone(),
                        submission: None,
                        item: Item {
                            content: None,
                            id: format!("{}:output", active.turn),
                            native_message: None,
                            client_id: None,
                            turn: Some(active.turn.clone()),
                            role: "assistant".into(),
                            kind: "text".into(),
                            text,
                            status: if status == "completed" {
                                "completed"
                            } else {
                                "failed"
                            }
                            .into(),
                        },
                    });
                }
                let _ = events.send(Event::Finished {
                    session,
                    submission: None,
                    turn: Some(active.turn.clone()),
                    status: status.into(),
                    error,
                    native_terminal: None,
                    interrupt_requested: false,
                });
                if !stopped {
                    closed.store(true, Ordering::SeqCst);
                }
                let mut slot = slot.lock().unwrap_or_else(|p| p.into_inner());
                if slot.as_ref().is_some_and(|a| Arc::ptr_eq(a, &active)) {
                    *slot = None;
                }
                drop(slot);
                *active.settled.lock().unwrap_or_else(|p| p.into_inner()) = Some(stopped);
                active.settled_changed.notify_all();
            });
        }
        Ok(active)
    }

    /// Stops what remains of the tree and reaps the leader.
    fn stop_tree(active: &Active) -> (bool, Exit) {
        let mut owned = active.process.lock().unwrap_or_else(|p| p.into_inner());
        let Owned { child, shutdown } = &mut *owned;
        let verdict = shutdown.stop(&Policy::default(), &mut || {
            child.try_wait().map(|status| status.is_some())
        });
        let exit = match child.try_wait() {
            Ok(Some(status)) => {
                use std::os::unix::process::ExitStatusExt;
                match (status.code(), status.signal()) {
                    (Some(code), _) => Exit::Code(code),
                    (None, Some(signal)) => Exit::Signal(signal),
                    _ => Exit::Unknown,
                }
            }
            _ => Exit::Unknown,
        };
        (verdict == Verdict::Exited, exit)
    }

    fn finish_tree(&self, active: &Active) -> bool {
        Self::stop_tree(active).0
    }

    fn current(&self) -> Option<Arc<Active>> {
        self.active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// Blocks until the leader has exited, without reaping it, so its group ID
/// stays reserved for the tree shutdown that follows.
fn wait_leader(pid: u32) {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            // Already reaped or not our child: the tree shutdown decides.
            return;
        }
    }
}

fn read_output(
    mut stdout: impl Read,
    active: &Active,
    events: &mpsc::SyncSender<Event>,
    session: &str,
    turn: &str,
    item: &str,
) -> String {
    let mut decoder = Utf8Stream::default();
    let mut text = String::new();
    let mut buffer = [0u8; 8192];
    let mut overflowed = false;
    loop {
        let read = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if overflowed {
            continue;
        }
        let chunk = decoder.push(&buffer[..read]);
        if text.len() + chunk.len() > OUTPUT_LIMIT {
            overflowed = true;
            active.interrupt(Interruption::Overflowed);
            continue;
        }
        if chunk.is_empty() {
            continue;
        }
        text.push_str(&chunk);
        // A full queue drops the live delta only; the completed item carries all text.
        let _ = events.try_send(Event::Delta {
            session: session.into(),
            submission: None,
            turn: Some(turn.into()),
            id: item.into(),
            role: "assistant".into(),
            kind: "text".into(),
            text: chunk,
        });
    }
    if !overflowed {
        let tail = decoder.finish();
        if text.len() + tail.len() <= OUTPUT_LIMIT {
            text.push_str(&tail);
        }
    }
    text
}

impl Provider for Adapter {
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        ensure!(
            resume.is_none(),
            "This custom executable cannot resume sessions; its adapter declares no resume capability"
        );
        super::ensure_default_config(config)?;
        let mut session = self.session.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            session.is_none(),
            "The custom executable session is already open"
        );
        let id = format!("exec-{}", uuid::Uuid::new_v4());
        *session = Some(id.clone());
        Ok(Connected {
            session: id,
            history: vec![],
            rewound_from: None,
        })
    }
    fn send(
        &self,
        session: &str,
        _submission: &str,
        _message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        ensure!(
            !self.closed.load(Ordering::SeqCst),
            "The custom executable adapter is stopped"
        );
        ensure!(
            self.session
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_deref()
                == Some(session),
            "Unknown custom executable session"
        );
        ensure!(
            prompt.attachments.is_empty(),
            "This custom executable accepts text prompts only"
        );
        ensure!(
            !prompt.text.contains('\0'),
            "Prompt contains a NUL character"
        );
        if self.settings().prompt_input == PromptInput::Argument {
            ensure!(
                prompt.text.len() <= ARGUMENT_LIMIT,
                "Prompt is too long to pass as an argument; configure stdin input"
            );
        }
        let mut slot = self.active.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            slot.is_none(),
            "A turn is already running for this custom executable"
        );
        let turn = format!("turn-{}", uuid::Uuid::new_v4());
        let active = self.launch(session, &turn, &prompt.text)?;
        *slot = Some(active);
        Ok(turn)
    }
    fn cancel(&self, _session: &str, turn: &str) -> Result<()> {
        let active = self
            .current()
            .filter(|active| active.turn == turn)
            .context("That turn is not running")?;
        active.interrupt(Interruption::Cancelled);
        Ok(())
    }
    fn validate_answer(&self, _: &PendingRequest, _: &str, _: Option<&Value>) -> Result<()> {
        bail!("This custom executable has no approvals or questions")
    }
    fn answer(&self, _: &PendingRequest, _: &str, _: Option<&Value>) -> Result<()> {
        bail!("This custom executable has no approvals or questions")
    }
    fn reject(&self, _: Value, _: &str) -> Result<()> {
        // The adapter never raises requests, so there is nothing to refuse.
        Ok(())
    }
    fn stop(&self) {
        let _ = self.stop_confirmed();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        let result = match self.current() {
            Some(active) => {
                active.interrupt(Interruption::Cancelled);
                match active.wait_settled(Duration::from_secs(15)) {
                    Some(true) => Ok(()),
                    _ => Err(anyhow::anyhow!(
                        "The custom executable's process tree was not confirmed stopped; ownership remains reserved"
                    )),
                }
            }
            None => Ok(()),
        };
        if result.is_ok() && !self.exited.swap(true, Ordering::SeqCst) {
            let _ = self.events.send(Event::Exited {
                error: ade_core::error::Failure::ProcessExited.to_string(),
            });
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settle_reports_only_what_was_proven() {
        assert_eq!(
            settle(Interruption::None, Exit::Code(0), true, 5),
            ("completed", None)
        );
        assert_eq!(
            settle(Interruption::Cancelled, Exit::Signal(9), true, 5).0,
            "interrupted"
        );
        let (status, error) = settle(Interruption::None, Exit::Code(3), true, 5);
        assert_eq!(
            (status, error.as_deref()),
            ("failed", Some("The agent exited with status 3"))
        );
        assert!(
            settle(Interruption::TimedOut, Exit::Signal(9), true, 5)
                .1
                .unwrap()
                .contains("5 seconds")
        );
        assert_eq!(
            settle(Interruption::Overflowed, Exit::Code(0), true, 5).0,
            "failed"
        );
        assert_eq!(
            settle(Interruption::None, Exit::Unknown, true, 5).0,
            "failed"
        );
        // An exit code of 0 is not success when the tree was not proven stopped.
        assert_eq!(
            settle(Interruption::None, Exit::Code(0), false, 5).0,
            "failed"
        );
        assert_eq!(
            settle(Interruption::Cancelled, Exit::Code(0), false, 5).0,
            "failed"
        );
    }

    #[test]
    fn utf8_stream_joins_split_characters_and_replaces_invalid_bytes() {
        let mut stream = Utf8Stream::default();
        let snowman = "\u{2603}".as_bytes();
        assert_eq!(stream.push(&[b'a', snowman[0]]), "a");
        assert_eq!(stream.push(&snowman[1..]), "\u{2603}");
        assert_eq!(stream.push(&[0xff, b'b']), "\u{FFFD}b");
        assert_eq!(stream.push(&[snowman[0], snowman[1]]), "");
        assert_eq!(stream.finish(), "\u{FFFD}");
        assert_eq!(stream.finish(), "");
    }
}
