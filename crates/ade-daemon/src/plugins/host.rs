//! Backend plugin host processes and their supervisor (F057, decision D05).
//!
//! A host is `node packages/plugin-host/src/host.mjs`, one process per
//! activation generation of one plugin, started lazily on first demand. The
//! daemon speaks JSON-RPC 2.0 to it over stdio (`activate`, `deactivate`,
//! `invoke`, `health`). Each host runs in its own process group, so a kill
//! also reaches the descendants that stayed in the group.
//!
//! Supervision state lives in `supervision.rs`. Here every lock is held only
//! for bookkeeping or for one bounded host call (activation, or the
//! deactivation before a restart); an invocation runs without any lock, so a
//! slow or hung plugin never blocks the registry or another plugin.
//!
//! A newer generation never cuts off an older host's calls. The older host
//! is handed to a drain thread that waits for its open calls within a bound,
//! then runs its `deactivate` and kills its process group (F060).
//!
//! A host call's outcome is classified by what can be proven: a refusal
//! before plugin code ran, a handler failure, a result, or unknown (the host
//! exited, timed out or broke protocol while the call was open).
use super::dev::{self, DrainStep};
use super::supervision::{ExitOutcome, HostKey, Phase, StartDecision, Supervision};
use ade_core::contract::hooks::HookVerdict;
use ade_core::contract::plugins::{PluginHostState, PluginHostStatus};
use ade_core::model::now_ms;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(15);
pub const INVOKE_TIMEOUT: Duration = Duration::from_secs(60);
const DEACTIVATE_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the exit path waits for the stdout reader to deliver responses
/// the host wrote before it exited.
const READER_DRAIN: Duration = Duration::from_secs(2);
/// Open calls per host; more are refused before they are sent.
const MAX_PENDING: usize = 32;
/// The largest frame the host may send.
const MAX_FRAME_BYTES: u64 = 4 * 1024 * 1024;
const LOG_LINES: usize = 200;
const LOG_LINE_BYTES: usize = 2048;

/// JSON-RPC codes from `packages/plugin-host/src/protocol.mjs` that mean the
/// request was refused before any plugin command code ran.
const REFUSED_CODES: [i64; 9] = [
    -32700, -32600, -32601, -32602, -32001, -32002, -32003, -32004, -32005,
];
/// The command handler ran and threw.
const COMMAND_FAILED: i64 = -32010;

/// Everything a host needs to activate one generation of one plugin. It is
/// fixed for the generation: an enabled plugin's artifact cannot be replaced.
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub plugin_id: String,
    pub generation: u64,
    pub artifact_path: String,
    pub entry: String,
    pub commands: Vec<String>,
    /// The lifecycle events the manifest subscribes to (F058).
    pub hooks: Vec<String>,
    pub settings: Map<String, Value>,
}

/// Why a host call produced no result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallError {
    /// Refused before plugin code ran, or never delivered.
    NotRun(String),
    /// The handler ran and threw.
    Failed(String),
    /// No proof either way.
    Unknown(String),
}

/// Classifies one JSON-RPC response frame.
pub fn classify(frame: &Value) -> Result<Value, CallError> {
    if let Some(error) = frame.get("error") {
        let message = error["message"]
            .as_str()
            .unwrap_or("Plugin host returned an error")
            .to_owned();
        return match error["code"].as_i64() {
            Some(COMMAND_FAILED) => Err(CallError::Failed(message)),
            Some(code) if REFUSED_CODES.contains(&code) => Err(CallError::NotRun(message)),
            _ => Err(CallError::Unknown(format!(
                "Plugin host returned an unrecognized error: {message}"
            ))),
        };
    }
    match frame.get("result") {
        Some(result) => Ok(result.clone()),
        None => Err(CallError::Unknown(
            "Plugin host response has neither result nor error".into(),
        )),
    }
}

type Reply = Result<Value, CallError>;

/// What one `hook` call proves about a lifecycle hook delivery (F058). Only a
/// refusal before plugin code ran proves the handler never started; a lost
/// answer is unknown, never retried on its own.
pub fn hook_verdict(called: &Reply) -> HookVerdict {
    match called {
        Ok(_) => HookVerdict::Delivered,
        Err(CallError::Failed(error)) => HookVerdict::Failed {
            error: error.clone(),
        },
        Err(CallError::NotRun(reason)) => HookVerdict::NotStarted {
            reason: reason.clone(),
        },
        Err(CallError::Unknown(detail)) => HookVerdict::Unknown {
            detail: detail.clone(),
        },
    }
}

/// The open calls of one host. Once `closed`, no call can be added.
#[derive(Default)]
struct Pending {
    calls: HashMap<u64, mpsc::Sender<Reply>>,
    closed: Option<String>,
}

struct Shared {
    pending: Mutex<Pending>,
    /// True once the waiter has reaped the process; no signal after that, so
    /// a reused PID is never signaled.
    reaped: Mutex<bool>,
    pid: u32,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Shared {
    fn kill(&self) {
        let reaped = self.reaped.lock().unwrap();
        if !*reaped {
            // SAFETY: the process group is led by our unreaped child, so its
            // ID cannot have been reused.
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
    }

    fn close(&self, reason: &str) {
        let mut pending = self.pending.lock().unwrap();
        pending.closed.get_or_insert_with(|| reason.to_owned());
        for (_, sender) in pending.calls.drain() {
            let _ = sender.send(Err(CallError::Unknown(format!(
                "Plugin host {reason} while the call was open"
            ))));
        }
    }
}

/// One running host process.
pub struct HostProcess {
    pub key: HostKey,
    pub started_at: i64,
    shared: Arc<Shared>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicU64,
}

impl HostProcess {
    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    /// Sends one request and waits for its response. A timeout returns
    /// `Unknown`; the caller decides whether to kill the host.
    pub fn call(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if let Some(reason) = &pending.closed {
                return Err(CallError::NotRun(format!("Plugin host {reason}")));
            }
            if pending.calls.len() >= MAX_PENDING {
                return Err(CallError::NotRun(format!(
                    "Plugin host already has {MAX_PENDING} open calls"
                )));
            }
            pending.calls.insert(id, sender);
        }
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut line = frame.to_string();
        line.push('\n');
        let written = match self.stdin.lock().unwrap().as_mut() {
            Some(stdin) => stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.flush()),
            None => Err(std::io::Error::other("stdin is closed")),
        };
        if let Err(error) = written {
            // A write fails only when the host's end of the pipe is closed,
            // so it cannot have read this request.
            self.shared.pending.lock().unwrap().calls.remove(&id);
            return Err(CallError::NotRun(format!(
                "Plugin host did not accept the request: {error}"
            )));
        }
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                self.shared.pending.lock().unwrap().calls.remove(&id);
                Err(CallError::Unknown(format!(
                    "Plugin host did not answer {method} within {} s",
                    timeout.as_secs()
                )))
            }
        }
    }

    pub fn kill(&self) {
        self.shared.kill();
    }

    fn is_closed(&self) -> bool {
        self.shared.pending.lock().unwrap().closed.is_some()
    }

    fn open_calls(&self) -> usize {
        self.shared.pending.lock().unwrap().calls.len()
    }
}

fn push_log(logs: &Mutex<VecDeque<String>>, line: String) {
    let mut logs = logs.lock().unwrap();
    if logs.len() == LOG_LINES {
        logs.pop_front();
    }
    logs.push_back(line);
}

fn truncate(mut line: String) -> String {
    if line.len() > LOG_LINE_BYTES {
        let mut end = LOG_LINE_BYTES;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        line.truncate(end);
        line.push('…');
    }
    line
}

/// The Node executable and host script. `ADE_NODE_BIN` and `ADE_PLUGIN_HOST`
/// override them, as `ADE_NODE_BIN` does for provider bridges.
fn program() -> Result<(String, std::path::PathBuf), String> {
    let node = std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into());
    let script = std::env::var_os("ADE_PLUGIN_HOST")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| ade_platform::resources::resource("packages/plugin-host/src/host.mjs"));
    if !script.is_file() {
        return Err(format!(
            "Plugin host script {} is missing",
            script.display()
        ));
    }
    Ok((node, script))
}

/// Starts a host process. `on_exit` runs once, on a waiter thread, after the
/// process has exited and every open call has been failed.
fn spawn(
    spec: &LaunchSpec,
    key: HostKey,
    logs: Arc<Mutex<VecDeque<String>>>,
    on_exit: impl FnOnce(HostKey, String) + Send + 'static,
) -> Result<Arc<HostProcess>, String> {
    let (node, script) = program()?;
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(&spec.artifact_path)
        .env("ADE_PLUGIN_ID", &spec.plugin_id)
        .env("ADE_PLUGIN_GENERATION", spec.generation.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child: Child = command
        .spawn()
        .map_err(|error| format!("Could not start plugin host with {node}: {error}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Shared {
        pending: Mutex::new(Pending::default()),
        reaped: Mutex::new(false),
        pid,
        logs: logs.clone(),
    });
    push_log(
        &logs,
        format!(
            "[ade] host started: generation {} attempt {} pid {pid}",
            key.generation, key.attempt
        ),
    );

    if let Some(stderr) = stderr {
        let logs = logs.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match (&mut reader)
                    .take(LOG_LINE_BYTES as u64 * 4)
                    .read_until(b'\n', &mut buffer)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buffer).trim_end().to_owned();
                        if !text.is_empty() {
                            push_log(&logs, truncate(text));
                        }
                    }
                }
            }
        });
    }

    let (reader_done, reader_finished) = mpsc::channel::<()>();
    if let Some(stdout) = stdout {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                let read = (&mut reader)
                    .take(MAX_FRAME_BYTES + 1)
                    .read_until(b'\n', &mut buffer);
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(_)
                        if buffer.last() != Some(&b'\n')
                            && buffer.len() as u64 > MAX_FRAME_BYTES =>
                    {
                        push_log(
                            &shared.logs,
                            "[ade] host sent an oversized frame; killing it".into(),
                        );
                        shared.kill();
                        break;
                    }
                    Ok(_) => {}
                }
                let frame: Value = match serde_json::from_slice(&buffer) {
                    Ok(frame) => frame,
                    Err(_) => {
                        push_log(
                            &shared.logs,
                            "[ade] host wrote a non-JSON frame; killing it".into(),
                        );
                        shared.kill();
                        break;
                    }
                };
                let Some(id) = frame["id"].as_u64() else {
                    continue;
                };
                let sender = shared.pending.lock().unwrap().calls.remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(classify(&frame));
                }
            }
            let _ = reader_done.send(());
        });
    } else {
        drop(reader_done);
    }

    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            wait_without_reaping(pid);
            let status = {
                let mut reaped = shared.reaped.lock().unwrap();
                // Sweep descendants left in the group while the leader's PID
                // is still reserved by its zombie.
                // SAFETY: the leader is unreaped, so the group ID is ours.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                let status = child.wait();
                *reaped = true;
                status
            };
            let _ = reader_finished.recv_timeout(READER_DRAIN);
            let detail = match status {
                Ok(status) => format!("exited ({status})"),
                Err(error) => format!("exited (status unavailable: {error})"),
            };
            shared.close(&detail);
            push_log(&shared.logs, format!("[ade] host {detail}"));
            on_exit(key, detail);
        });
    }

    Ok(Arc::new(HostProcess {
        key,
        started_at: now_ms(),
        shared,
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(1),
    }))
}

/// Blocks until `pid` has exited, leaving it unreaped.
fn wait_without_reaping(pid: u32) {
    loop {
        // SAFETY: `info` is a plain C struct that waitid fills in.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
        {
            return;
        }
    }
}

struct SlotState {
    spec: Option<LaunchSpec>,
    supervision: Supervision,
    process: Option<Arc<HostProcess>>,
    /// An older generation's host that `adopt` retired; the caller drains it.
    superseded: Option<Arc<HostProcess>>,
    last_error: Option<String>,
    /// Every generation up to this one was disabled; none may start again.
    retired_through: u64,
    logs: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
struct Slot {
    state: Mutex<Option<SlotState>>,
}

/// Supervises every plugin's backend host.
pub struct Hosts {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    /// Superseded hosts still draining, by plugin ID and generation.
    draining: Mutex<HashSet<(String, u64)>>,
    this: Weak<Hosts>,
}

impl Hosts {
    pub fn new() -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            slots: Mutex::new(HashMap::new()),
            draining: Mutex::new(HashSet::new()),
            this: this.clone(),
        })
    }

    /// Retires the host of `generation`, if it is the slot's generation, and
    /// drains it in the background. Every generation up to it is fenced, so
    /// a late invocation for it cannot start a host again. Returns whether a
    /// running host was handed to the drain.
    pub fn supersede(&self, plugin_id: &str, generation: u64) -> bool {
        let slot = self.slot(plugin_id);
        let process = {
            let mut guard = slot.state.lock().unwrap();
            let state = guard.get_or_insert_with(|| empty(0));
            state.retired_through = state.retired_through.max(generation);
            if state.supervision.generation == generation {
                retire(state)
            } else {
                None
            }
        };
        match process {
            Some(process) => {
                self.drain(plugin_id, process);
                true
            }
            None => false,
        }
    }

    /// The plugin's generations whose hosts are still draining.
    pub fn draining(&self, plugin_id: &str) -> HashSet<u64> {
        self.draining
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id == plugin_id)
            .map(|(_, generation)| *generation)
            .collect()
    }

    /// Lets a superseded host finish its open calls for at most
    /// [`dev::DRAIN_GRACE_MS`], then runs the plugin's `deactivate` with its
    /// own bound and stops the process group. It runs on its own thread and
    /// takes no slot lock, so the new generation starts at once. A call cut
    /// off by the grace limit settles as unknown in its caller.
    fn drain(&self, plugin_id: &str, process: Arc<HostProcess>) {
        let key = (plugin_id.to_owned(), process.key.generation);
        self.draining.lock().unwrap().insert(key.clone());
        push_log(
            &process.shared.logs,
            format!(
                "[ade] generation {} superseded; draining {} open call(s)",
                process.key.generation,
                process.open_calls()
            ),
        );
        let this = self.this.clone();
        std::thread::spawn(move || {
            let started = now_ms();
            loop {
                match dev::drain_step(
                    process.open_calls(),
                    process.is_closed(),
                    started,
                    now_ms(),
                    dev::DRAIN_GRACE_MS,
                ) {
                    DrainStep::Wait => std::thread::sleep(Duration::from_millis(50)),
                    DrainStep::Deactivate { forced } => {
                        if forced {
                            push_log(
                                &process.shared.logs,
                                format!(
                                    "[ade] generation {} drain grace ended with {} open call(s); their outcome is unknown",
                                    process.key.generation,
                                    process.open_calls()
                                ),
                            );
                        }
                        let _ = process.call(
                            "deactivate",
                            json!({"generation": process.key.generation}),
                            DEACTIVATE_TIMEOUT,
                        );
                        process.kill();
                        break;
                    }
                    DrainStep::Exited => {
                        process.kill();
                        break;
                    }
                }
            }
            if let Some(hosts) = this.upgrade() {
                hosts.draining.lock().unwrap().remove(&key);
            }
        });
    }

    fn slot(&self, plugin_id: &str) -> Arc<Slot> {
        self.slots
            .lock()
            .unwrap()
            .entry(plugin_id.to_owned())
            .or_default()
            .clone()
    }

    /// Returns the running host for `spec`'s generation, starting it if the
    /// supervision allows. The error says why no host is available; nothing
    /// was sent to plugin code.
    pub fn ensure(&self, spec: &LaunchSpec) -> Result<Arc<HostProcess>, String> {
        let slot = self.slot(&spec.plugin_id);
        let mut guard = slot.state.lock().unwrap();
        let state = adopt(&mut guard, spec)?;
        if let Some(old) = state.superseded.take() {
            self.drain(&spec.plugin_id, old);
        }
        match state.supervision.decide_start(now_ms()) {
            StartDecision::AlreadyRunning(_) => match &state.process {
                Some(process) if !process.is_closed() => Ok(process.clone()),
                _ => Err(format!(
                    "Plugin {} backend host is exiting; retry shortly",
                    spec.plugin_id
                )),
            },
            StartDecision::Wait { retry_at } => Err(format!(
                "Plugin {} backend host crashed {} time(s); it restarts in {} ms. Last error: {}",
                spec.plugin_id,
                state.supervision.crashes,
                (retry_at - now_ms()).max(0),
                state.last_error.as_deref().unwrap_or("none")
            )),
            StartDecision::Errored => Err(format!(
                "Plugin {} backend host crashed {} times and stays stopped; run `ade plugin host restart {}`. Last error: {}",
                spec.plugin_id,
                state.supervision.crashes,
                spec.plugin_id,
                state.last_error.as_deref().unwrap_or("none")
            )),
            StartDecision::Start(key) => self.start(state, key),
        }
    }

    /// Starts attempt `key` and activates it, holding the slot lock for at
    /// most the activation timeout. A failed start counts as a crash.
    fn start(&self, state: &mut SlotState, key: HostKey) -> Result<Arc<HostProcess>, String> {
        let spec = state.spec.clone().ok_or("Plugin host has no launch spec")?;
        let now = now_ms();
        let this = self.this.clone();
        let plugin_id = spec.plugin_id.clone();
        let spawned = spawn(&spec, key, state.logs.clone(), move |key, detail| {
            if let Some(hosts) = this.upgrade() {
                hosts.exited(&plugin_id, key, detail);
            }
        });
        state.supervision.started(key, now);
        let process = match spawned {
            Ok(process) => process,
            Err(error) => return Err(self.fail_start(state, key, error)),
        };
        let activated = process.call(
            "activate",
            json!({
                "plugin_id": spec.plugin_id,
                "generation": spec.generation,
                "artifact_path": spec.artifact_path,
                "entry": spec.entry,
                "commands": spec.commands,
                "hooks": spec.hooks,
                "settings": spec.settings,
            }),
            ACTIVATE_TIMEOUT,
        );
        if let Err(error) = activated {
            process.kill();
            let message = match error {
                CallError::NotRun(message)
                | CallError::Failed(message)
                | CallError::Unknown(message) => message,
            };
            return Err(self.fail_start(state, key, message));
        }
        state.process = Some(process.clone());
        state.last_error = None;
        Ok(process)
    }

    fn fail_start(&self, state: &mut SlotState, key: HostKey, error: String) -> String {
        state.process = None;
        state.last_error = Some(error.clone());
        push_log(&state.logs, format!("[ade] host start failed: {error}"));
        let outcome = state.supervision.exited(key, now_ms(), false);
        self.schedule(&state.spec, outcome);
        format!(
            "Plugin backend host failed to start: {error}{}",
            match outcome {
                ExitOutcome::Errored { .. } => "; it stays stopped until restarted",
                _ => "",
            }
        )
    }

    /// Called on the waiter thread when a host exits. Only the running
    /// attempt's exit changes supervision; a late exit from a retired attempt
    /// or an older generation is ignored.
    fn exited(&self, plugin_id: &str, key: HostKey, detail: String) {
        let slot = self.slot(plugin_id);
        let mut guard = slot.state.lock().unwrap();
        let Some(state) = guard.as_mut() else {
            return;
        };
        if state.supervision.generation != key.generation {
            return;
        }
        let outcome = state.supervision.exited(key, now_ms(), false);
        if outcome == ExitOutcome::Ignored {
            return;
        }
        if state.process.as_ref().is_some_and(|p| p.key == key) {
            state.process = None;
        }
        tracing::warn!(target: "ade", event = "plugin_host_crashed", attempt = key.attempt);
        state.last_error = Some(format!("Backend host {detail}"));
        self.schedule(&state.spec, outcome);
    }

    fn schedule(&self, spec: &Option<LaunchSpec>, outcome: ExitOutcome) {
        let (Some(spec), ExitOutcome::Restart { retry_at, .. }) = (spec, outcome) else {
            return;
        };
        let this = self.this.clone();
        let plugin_id = spec.plugin_id.clone();
        let generation = spec.generation;
        std::thread::spawn(move || {
            let delay = (retry_at - now_ms()).max(0) as u64;
            std::thread::sleep(Duration::from_millis(delay));
            if let Some(hosts) = this.upgrade() {
                hosts.retry(&plugin_id, generation, retry_at);
            }
        });
    }

    /// A scheduled restart. It does nothing if anything changed since the
    /// crash that scheduled it.
    fn retry(&self, plugin_id: &str, generation: u64, retry_at: i64) {
        let slot = self.slot(plugin_id);
        let mut guard = slot.state.lock().unwrap();
        let Some(state) = guard.as_mut() else {
            return;
        };
        if state.supervision.generation != generation
            || generation <= state.retired_through
            || !state.supervision.restart_due(retry_at, now_ms())
        {
            return;
        }
        if let StartDecision::Start(key) = state.supervision.decide_start(now_ms())
            && let Err(error) = self.start(state, key)
        {
            tracing::warn!(target: "ade", event = "plugin_host_restart_failed", error = %error);
        }
    }

    /// Stops the host and retires every generation up to `through`, so a
    /// late invocation for a disabled activation cannot start it again. The
    /// plugin's `deactivate` runs with a bounded wait, outside the slot lock.
    /// A newer generation's host, started after the disable that chose
    /// `through`, is current and keeps running.
    pub fn stop(&self, plugin_id: &str, through: u64) {
        let slot = self.slot(plugin_id);
        let process = fence(&mut slot.state.lock().unwrap(), through);
        if let Some(process) = process {
            let _ = process.call(
                "deactivate",
                json!({"generation": process.key.generation}),
                DEACTIVATE_TIMEOUT,
            );
            process.kill();
        }
    }

    /// Stores `spec` for the next start of its generation's host, as after a
    /// setting change. A running host keeps its activation until restarted.
    pub fn refresh(&self, spec: &LaunchSpec) {
        let slot = self.slot(&spec.plugin_id);
        refresh(&mut slot.state.lock().unwrap(), spec);
    }

    /// Clears the crash count, stops any running host after a bounded
    /// deactivation, and starts a fresh attempt.
    /// Only a refusal before any host was touched is `NotApplied`.
    pub fn restart(&self, spec: &LaunchSpec) -> Result<(), RestartError> {
        let slot = self.slot(&spec.plugin_id);
        let mut guard = slot.state.lock().unwrap();
        let state = adopt(&mut guard, spec).map_err(RestartError::NotApplied)?;
        if let Some(old) = state.superseded.take() {
            self.drain(&spec.plugin_id, old);
        }
        state.supervision.reset();
        let stopped = retire(state);
        if let Some(process) = &stopped {
            let _ = process.call(
                "deactivate",
                json!({"generation": process.key.generation}),
                DEACTIVATE_TIMEOUT,
            );
            process.kill();
        }
        let started = match state.supervision.decide_start(now_ms()) {
            StartDecision::Start(key) => self.start(state, key).map(|_| ()),
            other => Err(format!("Plugin host could not restart: {other:?}")),
        };
        started.map_err(|error| RestartError::failed(stopped.is_some(), error))
    }

    /// Kills the host that ran attempt `key`, as after an invocation timeout.
    /// Its exit then counts as a crash.
    pub fn kill(&self, plugin_id: &str, key: HostKey) {
        let slot = self.slot(plugin_id);
        let guard = slot.state.lock().unwrap();
        if let Some(process) = guard.as_ref().and_then(|state| state.process.as_ref())
            && process.key == key
        {
            process.kill();
        }
    }

    /// The supervisor's view of one plugin's host. It probes a running host's
    /// health with a short timeout and never starts one.
    pub fn status(
        &self,
        plugin_id: &str,
        has_backend: bool,
        live_generation: Option<u64>,
    ) -> PluginHostStatus {
        let slot = self.slot(plugin_id);
        let (mut status, process) = {
            let guard = slot.state.lock().unwrap();
            let current = guard
                .as_ref()
                .filter(|state| Some(state.supervision.generation) == live_generation);
            let logs = guard
                .as_ref()
                .map(|state| state.logs.lock().unwrap().iter().cloned().collect())
                .unwrap_or_default();
            let state = if !has_backend {
                PluginHostState::NoBackend
            } else if live_generation.is_none() {
                PluginHostState::Inactive
            } else {
                match current.map(|state| &state.supervision.phase) {
                    None | Some(Phase::Idle) => PluginHostState::Idle,
                    Some(Phase::Running { .. }) => PluginHostState::Running,
                    Some(Phase::Backoff { .. }) => PluginHostState::Backoff,
                    Some(Phase::Errored) => PluginHostState::Errored,
                    Some(Phase::Stopped) => PluginHostState::Stopped,
                }
            };
            let process = current.and_then(|state| state.process.clone());
            let status = PluginHostStatus {
                plugin_id: plugin_id.to_owned(),
                state,
                generation: live_generation,
                attempt: current.map_or(0, |state| state.supervision.attempt),
                pid: process.as_ref().map(|p| p.pid()),
                started_at: process.as_ref().map(|p| p.started_at),
                crashes: current.map_or(0, |state| state.supervision.crashes),
                retry_at: match current.map(|state| &state.supervision.phase) {
                    Some(Phase::Backoff { retry_at }) => Some(*retry_at),
                    _ => None,
                },
                last_error: guard.as_ref().and_then(|state| state.last_error.clone()),
                responsive: None,
                registered: Vec::new(),
                log_tail: logs,
            };
            (status, process)
        };
        if let Some(process) = process {
            match process.call("health", json!({}), HEALTH_TIMEOUT) {
                Ok(health) => {
                    status.responsive = Some(true);
                    status.registered = health["registered"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                Err(_) => status.responsive = Some(false),
            }
        }
        status
    }
}

impl Drop for Hosts {
    fn drop(&mut self) {
        for slot in self.slots.lock().unwrap().values() {
            if let Some(process) = slot
                .state
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|state| state.process.as_ref())
            {
                process.kill();
            }
        }
    }
}

fn empty(generation: u64) -> SlotState {
    SlotState {
        spec: None,
        supervision: Supervision::new(generation),
        process: None,
        superseded: None,
        last_error: None,
        retired_through: 0,
        logs: Arc::new(Mutex::new(VecDeque::new())),
    }
}

/// Points the slot at `spec`'s generation. A newer generation replaces the
/// supervision and retires the old host; a retired or older one is refused.
fn adopt<'a>(
    guard: &'a mut Option<SlotState>,
    spec: &LaunchSpec,
) -> Result<&'a mut SlotState, String> {
    let state = guard.get_or_insert_with(|| empty(spec.generation));
    if spec.generation <= state.retired_through || spec.generation < state.supervision.generation {
        return Err(format!(
            "Plugin {} activation {} is no longer current",
            spec.plugin_id, spec.generation
        ));
    }
    if spec.generation != state.supervision.generation {
        // The caller drains the older host instead of cutting its calls off.
        if let Some(old) = retire(state) {
            state.superseded = Some(old);
        }
        state.supervision = Supervision::new(spec.generation);
        state.last_error = None;
    }
    // Always keep the newest spec for the current generation: its settings
    // may have changed since the running host activated, and the next start
    // (explicit or after a crash) must activate with them.
    state.spec = Some(spec.clone());
    Ok(state)
}

/// Replaces the stored spec when `spec` belongs to the slot's current,
/// unretired generation, so the next start activates with its settings. It
/// never creates a slot, changes supervision, or touches a running host.
fn refresh(guard: &mut Option<SlotState>, spec: &LaunchSpec) -> bool {
    match guard.as_mut() {
        Some(state)
            if state.supervision.generation == spec.generation
                && spec.generation > state.retired_through
                && state.spec.is_some() =>
        {
            state.spec = Some(spec.clone());
            true
        }
        _ => false,
    }
}

/// Why `Hosts::restart` did not leave a fresh host running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestartError {
    /// Refused before any host was stopped or started; nothing changed.
    NotApplied(String),
    /// A start was attempted and failed. A running host may have been
    /// stopped first, and the failed start counts as a crash.
    Failed(String),
}

impl RestartError {
    fn failed(stopped_running: bool, error: String) -> Self {
        Self::Failed(if stopped_running {
            format!("The previous backend host was stopped, but the new one did not start: {error}")
        } else {
            error
        })
    }
}

/// Retires every generation up to `through` and takes the running process
/// only when it belongs to one of them. A newer generation is current: it
/// was activated after the disable that chose `through`, so it is left alone.
fn fence(guard: &mut Option<SlotState>, through: u64) -> Option<Arc<HostProcess>> {
    let state = guard.get_or_insert_with(|| empty(0));
    state.retired_through = state.retired_through.max(through);
    if state.supervision.generation <= through {
        retire(state)
    } else {
        None
    }
}

/// Marks the running attempt as stopped on purpose and takes its process.
fn retire(state: &mut SlotState) -> Option<Arc<HostProcess>> {
    if let Phase::Running { key, .. } = state.supervision.phase {
        state.supervision.exited(key, now_ms(), true);
    }
    state.process.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_verdicts_retry_only_what_never_started() {
        let reply = |frame: Value| hook_verdict(&classify(&frame));
        assert_eq!(
            reply(json!({"id": 1, "result": {"delivered": true}})),
            HookVerdict::Delivered
        );
        // No handler for the event: refused before plugin code ran.
        assert!(matches!(
            reply(json!({"id": 1, "error": {"code": -32005, "message": "none"}})),
            HookVerdict::NotStarted { .. }
        ));
        assert!(matches!(
            reply(json!({"id": 1, "error": {"code": -32010, "message": "boom"}})),
            HookVerdict::Failed { .. }
        ));
        assert!(matches!(
            reply(json!({"id": 1, "error": {"code": -1, "message": "odd"}})),
            HookVerdict::Unknown { .. }
        ));
        assert!(matches!(
            hook_verdict(&Err(CallError::Unknown("exited".into()))),
            HookVerdict::Unknown { .. }
        ));
    }

    #[test]
    fn classifies_responses_by_what_they_prove() {
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "id": 1, "result": {"value": 2}})),
            Ok(json!({"value": 2}))
        );
        assert_eq!(
            classify(&json!({"id": 1, "error": {"code": -32010, "message": "boom"}})),
            Err(CallError::Failed("boom".into()))
        );
        for code in REFUSED_CODES {
            assert!(matches!(
                classify(&json!({"id": 1, "error": {"code": code, "message": "no"}})),
                Err(CallError::NotRun(_))
            ));
        }
        assert!(matches!(
            classify(&json!({"id": 1, "error": {"code": -1, "message": "?"}})),
            Err(CallError::Unknown(_))
        ));
        assert!(matches!(
            classify(&json!({"id": 1})),
            Err(CallError::Unknown(_))
        ));
    }

    fn spec(generation: u64) -> LaunchSpec {
        LaunchSpec {
            plugin_id: "a.b".into(),
            generation,
            artifact_path: "/a".into(),
            entry: "b.mjs".into(),
            commands: Vec::new(),
            hooks: Vec::new(),
            settings: Map::new(),
        }
    }

    #[test]
    fn adopting_fences_retired_and_older_generations() {
        let mut slot = None;
        assert_eq!(
            adopt(&mut slot, &spec(2)).unwrap().supervision.generation,
            2
        );
        assert!(adopt(&mut slot, &spec(1)).is_err());
        let state = adopt(&mut slot, &spec(3)).unwrap();
        assert_eq!(state.supervision.generation, 3);
        state.retired_through = 3;
        assert!(adopt(&mut slot, &spec(3)).is_err());
        assert_eq!(
            adopt(&mut slot, &spec(4)).unwrap().supervision.generation,
            4
        );
    }

    fn with_setting(generation: u64, value: i64) -> LaunchSpec {
        let mut spec = spec(generation);
        spec.settings.insert("foo".into(), json!(value));
        spec
    }

    /// Setting foo=2 then restarting generation N must activate with foo=2,
    /// not the spec stored when foo was 1.
    #[test]
    fn adopting_the_same_generation_takes_its_new_settings() {
        let mut slot = None;
        adopt(&mut slot, &with_setting(5, 1)).unwrap();
        slot.as_mut().unwrap().supervision.crashes = 2;
        let state = adopt(&mut slot, &with_setting(5, 2)).unwrap();
        assert_eq!(state.spec.as_ref().unwrap().settings["foo"], json!(2));
        assert_eq!(state.supervision.generation, 5);
        assert_eq!(state.supervision.crashes, 2, "supervision is kept");
    }

    /// A setting change reaches crash restarts, which never call adopt.
    #[test]
    fn refreshing_updates_only_the_current_generation() {
        let mut slot = None;
        assert!(
            !refresh(&mut slot, &with_setting(5, 2)),
            "no slot is created"
        );
        assert!(slot.is_none());
        adopt(&mut slot, &with_setting(5, 1)).unwrap();
        assert!(!refresh(&mut slot, &with_setting(4, 3)));
        assert!(!refresh(&mut slot, &with_setting(6, 3)));
        assert!(refresh(&mut slot, &with_setting(5, 2)));
        assert_eq!(
            slot.as_ref().unwrap().spec.as_ref().unwrap().settings["foo"],
            json!(2)
        );
        slot.as_mut().unwrap().retired_through = 5;
        assert!(!refresh(&mut slot, &with_setting(5, 9)));
    }

    /// Disable chose `through = 1`, but before its stop reached the slot an
    /// enable activated generation 2 and an invocation started its host. The
    /// stop fences generation 1 and leaves generation 2 running.
    #[test]
    fn stopping_through_an_older_generation_spares_a_newer_host() {
        let mut slot = None;
        let state = adopt(&mut slot, &spec(2)).unwrap();
        let key = HostKey {
            generation: 2,
            attempt: 1,
        };
        assert!(state.supervision.started(key, 10));
        fence(&mut slot, 1);
        let state = slot.as_ref().unwrap();
        assert_eq!(state.retired_through, 1);
        assert!(matches!(state.supervision.phase, Phase::Running { key: k, .. } if k == key));

        fence(&mut slot, 2);
        let state = slot.as_ref().unwrap();
        assert_eq!(state.retired_through, 2);
        assert_eq!(state.supervision.phase, Phase::Stopped);
    }

    /// A restart that reached a start attempt and failed is `Failed`, never
    /// `NotApplied`; only a stale activation is refused before anything
    /// changes. The artifact directory does not exist, so no process starts.
    #[test]
    fn restart_reports_a_failed_start_as_failed() {
        let hosts = Hosts::new();
        let mut missing = spec(3);
        missing.artifact_path = "/nonexistent/ade-plugin-artifact".into();
        assert!(matches!(
            hosts.restart(&missing),
            Err(RestartError::Failed(_))
        ));
        assert!(matches!(
            hosts.restart(&spec(2)),
            Err(RestartError::NotApplied(_))
        ));
        assert_eq!(
            RestartError::failed(true, "boom".into()),
            RestartError::Failed(
                "The previous backend host was stopped, but the new one did not start: boom".into()
            )
        );
    }
}
