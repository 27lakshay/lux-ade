use ade_runtime::model::{WorkspaceRecord, new_id};
use ade_runtime::terminal_ownership::{self as ownership, Decision, Intent, Viewport, Viewports};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{
    Arc, Mutex,
    mpsc::{self, SyncSender},
};
use std::time::{Duration, Instant};
#[path = "../../protocol.rs"]
mod protocol;
#[path = "../../terminal_state.rs"]
mod terminal_state;
use terminal_state::TerminalState;

const SCROLLBACK: usize = 256 * 1024;
const XTERM_REPLAY_LIMIT: usize = 4 * 1024 * 1024;
const CONVERSATION: usize = 64 * 1024;
const MAX_REQUEST: u64 = 128 * 1024;

/// Live frames one attachment may have queued before it is resynchronized:
/// at most this many bytes and this many frames (architecture section 6).
const VIEWER_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const VIEWER_QUEUE_FRAMES: usize = 1024;

/// One line for an attachment's writer thread.
enum Out {
    /// A reply or snapshot; not counted against the live-frame budget.
    Line(String),
    /// A broadcast frame, counted in [`Outbox::queued`] until written.
    Live(String),
    /// Wakes the writer so it can resynchronize a lagging attachment.
    Wake,
}

/// The live-frame budget one attachment shares with its writer thread.
///
/// A viewer that falls a whole budget behind is not closed. Broadcasts stop
/// queueing for it, and once its writer has drained every queued frame it
/// sends a fresh snapshot and live output resumes after it, in order.
#[derive(Default)]
struct Outbox {
    queued: AtomicUsize,
    lagging: AtomicBool,
}

impl Outbox {
    /// Queue one live frame, or mark the attachment lagging when the frame
    /// would exceed its budget. `false` means the writer is gone.
    fn offer(&self, tx: &SyncSender<Out>, line: &str) -> bool {
        if self.lagging.load(Ordering::Acquire) {
            return true;
        }
        let len = line.len();
        if self.queued.load(Ordering::Acquire) + len > VIEWER_QUEUE_BYTES {
            return self.lag(tx);
        }
        self.queued.fetch_add(len, Ordering::AcqRel);
        match tx.try_send(Out::Live(line.to_string())) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) => {
                self.queued.fetch_sub(len, Ordering::AcqRel);
                self.lag(tx)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    }
    fn lag(&self, tx: &SyncSender<Out>) -> bool {
        self.lagging.store(true, Ordering::Release);
        // A full queue wakes the writer anyway; an empty one needs the nudge.
        !matches!(
            tx.try_send(Out::Wake),
            Err(mpsc::TrySendError::Disconnected(_))
        )
    }
    /// The writer has drained every live frame queued before the lag.
    fn needs_resync(&self) -> bool {
        self.lagging.load(Ordering::Acquire) && self.queued.load(Ordering::Acquire) == 0
    }
}

/// The snapshot an attachment asked for when it subscribed; a resync sends
/// the same kind again.
#[derive(Clone, Copy)]
enum SnapshotKind {
    XtermReplay,
    Binary { base64: bool },
    Plain { terminal: bool },
}

struct Subscriber {
    tx: SyncSender<Out>,
    terminal: bool,
    disconnect: Option<UnixStream>,
    outbox: Arc<Outbox>,
    kind: SnapshotKind,
}

enum ReplayEvent {
    Output { offset: u64, bytes: Vec<u8> },
    Resize { offset: u64, cols: u16, rows: u16 },
}

impl ReplayEvent {
    fn value(&self) -> Value {
        match self {
            Self::Output { offset, bytes } => {
                use base64::Engine as _;
                json!({"type":"output","offset":offset,
                    "bytes_base64":base64::engine::general_purpose::STANDARD.encode(bytes)})
            }
            Self::Resize { offset, cols, rows } => {
                json!({"type":"resize","offset":offset,"cols":cols,"rows":rows})
            }
        }
    }
}

struct State {
    started: Instant,
    terminal: VecDeque<u8>,
    xterm_replay: Vec<ReplayEvent>,
    xterm_replay_bytes: usize,
    xterm_replay_complete: bool,
    screen: TerminalState,
    conversation: String,
    streaming: bool,
    clients: HashMap<u64, Subscriber>,
    next_client: u64,
    bytes: u64,
    events: u64,
    viewports: Viewports,
    pixel_size: (u16, u16),
    reply_tx: Option<SyncSender<Vec<u8>>>,
    reply_dropped_bytes: u64,
    shell_pid: Option<u32>,
    shell_running: bool,
    exit_status: Option<Value>,
    workspace_id: String,
    terminal_id: String,
    run_id: String,
    transfer_id: Option<String>,
    session_subscribers: Arc<AtomicUsize>,
    durable_log_error: Option<String>,
    /// Set by `terminal.stop`. A stopped shell's exit is settled by the
    /// verdict on its process tree, not by the shell's own status.
    stop_requested: bool,
    /// Fresh snapshots sent to attachments that fell a whole budget behind.
    viewer_resyncs: u64,
    /// The tree's tracked descendants as last observed, as (PID, start
    /// stamp). Reported in the metrics so the daemon records them with the
    /// attempt and keeps an escaped descendant attributed after a runtime
    /// crash (R006).
    descendants: Vec<(i32, u64)>,
    /// The window title the program last set, for the terminal's record.
    titles: ade_runtime::foreground::TitleScanner,
}

impl State {
    fn metrics(&self) -> Value {
        let mut metrics = json!({"pid":std::process::id(),"uptime_ms":self.started.elapsed().as_millis() as u64,
            "clients":self.clients.len()+self.session_subscribers.load(Ordering::Relaxed),
            "workspace_id":self.workspace_id,"terminal_id":self.terminal_id,"run_id":self.run_id,"transfer_id":self.transfer_id,"terminal_bytes":self.bytes,"events":self.events,
            "reply_dropped_bytes":self.reply_dropped_bytes,"viewer_resyncs":self.viewer_resyncs,
            "viewer_queue_limit_bytes":VIEWER_QUEUE_BYTES,"pixel_size":self.pixel_size,"scrollback_bytes":self.terminal.len(),"resize_owner":self.viewports.owner(),
            "shell_pid":self.shell_pid,"shell_running":self.shell_running,
            "durable_log_error":self.durable_log_error,
            "descendants":self.descendants.iter().map(|&(pid, started)| json!({"pid":pid,"started":started})).collect::<Vec<_>>()});
        if let Some(outcome) = &self.exit_status {
            metrics["exit_status"] = outcome.clone();
        }
        metrics
    }
    fn snapshot(&self) -> Value {
        self.snapshot_for(true, true)
    }
    fn binary_snapshot(&self, compact: bool) -> Result<Value, String> {
        let bytes = self.screen.binary_snapshot()?;
        protocol::check_snapshot_size(bytes.len())?;
        let mut event = json!({"type":"snapshot", "conversation":self.conversation,
            "streaming":self.streaming,"metrics":self.metrics(),
            "response_owner":"daemon-v1",
            "terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d",
            "terminal_recovery":{"scope":"both-screens-history-continuation",
                "history_limit_bytes":4*1024*1024,"continuation_limit_bytes":1024*1024}});
        if compact {
            use base64::Engine as _;
            event["terminal_snapshot_base64"] =
                json!(base64::engine::general_purpose::STANDARD.encode(&bytes));
        } else {
            // Older viewers did not negotiate a compact byte representation.
            event["terminal_snapshot_bytes"] = json!(bytes);
        }
        Ok(event)
    }
    fn xterm_snapshot(&self) -> Value {
        json!({"type":"snapshot","conversation":self.conversation,
            "streaming":self.streaming,"metrics":self.metrics(),
            "response_owner":"daemon-v1",
            "terminal_snapshot_format":"xterm-replay-v1",
            "terminal_recovery":{"complete":self.xterm_replay_complete,
                "reason":if self.xterm_replay_complete { Value::Null } else { json!("replay_limit_exceeded") },
                "initial_cols":100,"initial_rows":30,
                "through_offset":self.bytes,
                "limit_bytes":XTERM_REPLAY_LIMIT,
                "events":self.xterm_replay.iter().map(ReplayEvent::value).collect::<Vec<_>>()}})
    }
    fn record_replay(&mut self, event: ReplayEvent, size: usize) {
        if !self.xterm_replay_complete {
            return;
        }
        if self.xterm_replay_bytes.saturating_add(size) > XTERM_REPLAY_LIMIT {
            self.xterm_replay_complete = false;
            self.xterm_replay.clear();
            self.xterm_replay_bytes = 0;
            return;
        }
        self.xterm_replay_bytes += size;
        self.xterm_replay.push(event);
    }
    fn snapshot_for(&self, terminal: bool, raw: bool) -> Value {
        let mut event = json!({"type":"snapshot","conversation":self.conversation,
            "streaming":self.streaming,"metrics":self.metrics()});
        if !terminal {
            return event;
        }
        if raw {
            let bytes: Vec<u8> = self.terminal.iter().copied().collect();
            event["terminal"] = json!(String::from_utf8_lossy(&bytes));
            event["terminal_bytes"] = json!(bytes);
        }
        let info = self.screen.info();
        let (screen, screen_error) = match self.screen.snapshot() {
            Ok(bytes) => (Some(bytes), None),
            Err(error) => (None, Some(error)),
        };
        event["terminal_screen_bytes"] = json!(screen);
        event["terminal_screen_error"] = json!(screen_error);
        event["terminal_recovery"] = json!({"parser":"libghostty-vt","scope":"active-screen",
                "cols":info[0],"rows":info[1],"cursor_col":info[2],"cursor_row":info[3],
                "alternate_screen":info[4] != 0,"cursor_visible":info[5] != 0,"parser_ground":info[6] != 0});
        event
    }
    fn broadcast(&mut self, event: Value) {
        self.events += 1;
        let line = event.to_string();
        // A slow client is resynchronized from a fresh snapshot; it cannot
        // stall the PTY producer. Only a client whose writer is gone is dropped.
        let terminal = event["type"] == "terminal" || event["type"] == "terminal_resize";
        self.clients.retain(|_, client| {
            if terminal && !client.terminal {
                return true;
            }
            if client.outbox.offer(&client.tx, &line) {
                return true;
            }
            if let Some(socket) = &client.disconnect {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            false
        });
    }
    /// The snapshot an attachment of this kind starts from.
    fn attachment_snapshot(&self, kind: SnapshotKind, id: u64) -> Result<Value, String> {
        let mut snapshot = match kind {
            SnapshotKind::XtermReplay => self.xterm_snapshot(),
            SnapshotKind::Binary { base64 } => self.binary_snapshot(base64)?,
            SnapshotKind::Plain { terminal } => self.snapshot_for(terminal, false),
        };
        snapshot["run_id"] = json!(self.run_id);
        snapshot["attachment"] = json!(id);
        Ok(snapshot)
    }
    /// A fresh snapshot for a lagging attachment whose queue has drained.
    /// It is built and the lag cleared under the state lock, so the next
    /// broadcast frame follows the snapshot with no gap. `None` when the
    /// attachment is gone or not lagging.
    fn resync(&mut self, id: u64) -> Option<Result<Value, String>> {
        let client = self.clients.get(&id)?;
        if !client.outbox.needs_resync() {
            return None;
        }
        let (kind, outbox) = (client.kind, client.outbox.clone());
        let snapshot = self.attachment_snapshot(kind, id).map(|mut snapshot| {
            snapshot["resync"] = json!(true);
            snapshot
        });
        outbox.lagging.store(false, Ordering::Release);
        self.viewer_resyncs += 1;
        Some(snapshot)
    }
    fn flush_replies(&mut self) {
        let bytes = self.screen.take_replies();
        if bytes.is_empty() {
            return;
        }
        if let Some(sender) = &self.reply_tx
            && let Err(error) = sender.try_send(bytes)
        {
            let (bytes, message) = match error {
                mpsc::TrySendError::Full(bytes) => {
                    (bytes, "PTY reply queue full; terminal replies dropped")
                }
                mpsc::TrySendError::Disconnected(bytes) => (
                    bytes,
                    "PTY response writer stopped; terminal replies dropped",
                ),
            };
            let first = self.reply_dropped_bytes == 0;
            self.reply_dropped_bytes += bytes.len() as u64;
            if first {
                eprintln!("{message}");
                self.broadcast(json!({"type":"warning","message":message}));
            }
        }
    }

    fn append_terminal(&mut self, data: &[u8]) {
        self.screen.write(data);
        self.titles.feed(data);
        self.flush_replies();
        let offset = self.bytes;
        self.bytes += data.len() as u64;
        if self.xterm_replay_complete {
            self.record_replay(
                ReplayEvent::Output {
                    offset,
                    bytes: data.to_vec(),
                },
                data.len(),
            );
        }
        self.terminal.extend(data);
        if self.terminal.len() > SCROLLBACK {
            self.terminal.drain(..self.terminal.len() - SCROLLBACK);
        }
        self.broadcast(
            json!({"type":"terminal","data":String::from_utf8_lossy(data),"bytes":data,
                "offset":offset,"run_id":self.run_id}),
        );
    }
}

type Shared = Arc<Mutex<State>>;

/// An attachment's queue as its request loop sees it: replies go in as
/// uncounted lines.
struct Reply(SyncSender<Out>);

impl Reply {
    fn try_send(&self, line: String) -> Result<(), mpsc::TrySendError<Out>> {
        self.0.try_send(Out::Line(line))
    }
}

fn start_simulation(state: Shared, prompt: String) -> Result<(), &'static str> {
    {
        let mut s = state.lock().unwrap();
        if s.streaming {
            return Err("A simulated response is already running");
        }
        s.streaming = true;
        s.conversation = format!(
            "You: {}\n\nPrototype Agent (simulated):\n",
            prompt.chars().take(2000).collect::<String>()
        );
        let event = json!({"type":"conversation","text":s.conversation,"streaming":true});
        s.broadcast(event);
    }
    std::thread::spawn(move || {
        let paragraphs = [
            "The daemon owns this conversation and the shell. Close a client window and reconnect: the processes remain alive. ",
            "This stream is a simulated workload, not a connected AI provider. It exercises independent windows, bounded history, and reconnect behavior. ",
            "The terminal below is a real persistent PTY. Commands, shell variables, and running programs survive client disconnection. ",
            "Each window observes shared state. Only the terminal viewer that claims resize ownership can change the shell dimensions. ",
        ];
        for word in paragraphs.iter().flat_map(|p| p.split_whitespace()) {
            std::thread::sleep(Duration::from_millis(40));
            let mut s = state.lock().unwrap();
            if s.conversation.len() + word.len() + 1 < CONVERSATION {
                s.conversation.push_str(word);
                s.conversation.push(' ');
            }
            let event = json!({"type":"conversation","text":s.conversation,"streaming":true});
            s.broadcast(event);
        }
        let mut s = state.lock().unwrap();
        s.conversation
            .push_str("\n\nSimulation complete. The shell remains available.");
        s.streaming = false;
        let event = json!({"type":"conversation","text":s.conversation,"streaming":false});
        s.broadcast(event);
    });
    Ok(())
}

fn apply_size(
    state: &mut State,
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    geometry: Viewport,
) -> Result<(), String> {
    let Viewport {
        cols,
        rows,
        width,
        height,
    } = geometry;
    if state.screen.info()[..2] == [cols, rows] && state.pixel_size == (width, height) {
        return Ok(());
    }
    master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: width,
            pixel_height: height,
        })
        .map_err(|e| e.to_string())?;
    state.screen.resize_pixels(cols, rows, width, height)?;
    state.pixel_size = (width, height);
    state.flush_replies();
    // Resize-driven reports are handled by the same sole daemon response path.
    let offset = state.bytes;
    state.record_replay(ReplayEvent::Resize { offset, cols, rows }, 8);
    let run_id = state.run_id.clone();
    state.broadcast(
        json!({"type":"terminal_resize","cols":cols,"rows":rows,"offset":offset,"run_id":run_id}),
    );
    Ok(())
}

/// Tells the previous and next viewport owners that ownership moved, then
/// applies the decided geometry.
fn settle(
    state: &mut State,
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    decision: Decision,
) -> Result<(), String> {
    if let Some((previous, next)) = decision.transfer {
        for (attachment, owner) in [(previous, false), (next, true)] {
            if let Some(attachment) = attachment
                && let Some(client) = state.clients.get(&attachment)
            {
                let frame = json!({"type":"viewport","owner":owner,"attachment":attachment,
                    "run_id":state.run_id});
                // A full queue drops the notice; the resync snapshot's
                // metrics name the owner.
                let _ = client.tx.try_send(Out::Line(frame.to_string()));
            }
        }
    }
    match decision.apply {
        Some(viewport) => apply_size(state, master, viewport),
        None => Ok(()),
    }
}

fn refusal(error: ownership::Refusal, run_id: &str) -> String {
    json!({"type":"error","code":error.code(),"message":error.message(),"run_id":run_id})
        .to_string()
}

fn handle_client(
    mut stream: UnixStream,
    mut reader: BufReader<UnixStream>,
    first: String,
    state: Shared,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    input: Arc<Mutex<Box<dyn Write + Send>>>,
    admitted: Arc<AtomicBool>,
) -> io::Result<()> {
    if let Err(error) = stream.set_write_timeout(Some(Duration::from_secs(2))) {
        // Darwin rejects socket options after a fire-and-forget peer closes;
        // its already-buffered request still needs to be processed.
        if !matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOTCONN)) {
            return Err(error);
        }
    }
    let mut first = Some(first);
    let id = {
        let mut s = state.lock().unwrap();
        s.next_client += 1;
        s.next_client
    };
    let (tx, rx) = mpsc::sync_channel::<Out>(VIEWER_QUEUE_FRAMES);
    let outbox = Arc::new(Outbox::default());
    let mut writer_stream = stream.try_clone()?;
    let writer_state = state.clone();
    let writer_outbox = outbox.clone();
    std::thread::spawn(move || {
        while let Ok(out) = rx.recv() {
            let written = match out {
                Out::Line(line) => writeln!(writer_stream, "{line}"),
                Out::Live(line) => {
                    let written = writeln!(writer_stream, "{line}");
                    writer_outbox.queued.fetch_sub(line.len(), Ordering::AcqRel);
                    written
                }
                Out::Wake => Ok(()),
            };
            if written.is_err() {
                // The 2 s write timeout: a viewer that reads nothing is closed.
                break;
            }
            if !writer_outbox.needs_resync() {
                continue;
            }
            let resync = writer_state.lock().unwrap().resync(id);
            match resync {
                None => {}
                Some(Ok(snapshot)) => {
                    if writeln!(writer_stream, "{snapshot}").is_err() {
                        break;
                    }
                }
                Some(Err(error)) => {
                    // No live output can follow a failed restore.
                    let _ = writeln!(writer_stream, "{}", json!({"type":"error","message":error}));
                    break;
                }
            }
        }
        let _ = writer_stream.shutdown(std::net::Shutdown::Both);
    });
    let tx = Reply(tx);
    let mut subscribed = false;
    let outcome = (|| -> io::Result<()> {
        loop {
            let mut line = String::new();
            let read = if let Some(initial) = first.take() {
                line = initial;
                line.len()
            } else {
                reader.by_ref().take(MAX_REQUEST).read_line(&mut line)?
            };
            if read == 0 {
                break;
            }
            if !line.ends_with('\n') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Request too large",
                ));
            }
            let request: Value = match serde_json::from_str(&line) {
                Ok(request) => request,
                Err(error) => {
                    let _ = tx
                        .try_send(json!({"type":"error","message":error.to_string()}).to_string());
                    continue;
                }
            };
            if !admitted.load(Ordering::Acquire) {
                break;
            }
            if let Some(workspace) = request["workspace_id"].as_str()
                && workspace != state.lock().unwrap().workspace_id
            {
                let _ = tx.try_send(json!({"type":"error","message":"A terminal connection cannot switch workspaces"}).to_string());
                continue;
            }
            let result: Result<Option<Value>, String> = match request["op"].as_str().unwrap_or("") {
                "snapshot" | "status" => Ok(Some(state.lock().unwrap().snapshot())),
                "snapshot_binary" => state
                    .lock()
                    .unwrap()
                    .binary_snapshot(request["snapshot_encoding"] == "base64")
                    .map(Some),
                "hello" => Ok(Some(
                    json!({"type":"hello", "session_protocol":"ade-sessions-v1","worktree_protocol":"ade-worktrees-v1","review_protocol":"ade-review-v1", "response_owner":"daemon-v1", "terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d", "terminal_snapshot_formats":["ghostty-snapshot-v1-herdr-9c96f7d","xterm-replay-v1"]}),
                )),
                "ping" => Ok(Some(
                    json!({"type":"metrics","metrics":state.lock().unwrap().metrics()}),
                )),
                "subscribe" => {
                    let mut s = state.lock().unwrap();
                    if let Err(error) = ownership::fence(&s.run_id, &request) {
                        // A caller that expects an earlier incarnation must not
                        // mistake this one's output for its own.
                        let _ = tx.try_send(refusal(error, &s.run_id));
                        continue;
                    }
                    if !subscribed {
                        // Snapshot and registration share a lock so no output falls in between.
                        let terminal = request["terminal"].as_bool().unwrap_or(true);
                        let kind = if terminal && request["snapshot_format"] == "xterm-replay-v1" {
                            SnapshotKind::XtermReplay
                        } else if terminal && request["snapshot_format"] == "binary" {
                            SnapshotKind::Binary {
                                base64: request["snapshot_encoding"] == "base64",
                            }
                        } else {
                            SnapshotKind::Plain { terminal }
                        };
                        let snapshot = match s.attachment_snapshot(kind, id) {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                let _ = tx
                                    .try_send(json!({"type":"error","message":error}).to_string());
                                // No live output can follow a failed restore.
                                continue;
                            }
                        };
                        // The snapshot is not counted against the live-frame
                        // budget, so a large one cannot cost the attachment
                        // the frames that follow it.
                        let _ = tx.try_send(snapshot.to_string());
                        s.clients.insert(
                            id,
                            Subscriber {
                                tx: tx.0.clone(),
                                terminal,
                                disconnect: Some(stream.try_clone()?),
                                outbox: outbox.clone(),
                                kind,
                            },
                        );
                        subscribed = true;
                    }
                    Ok(None)
                }
                "input" => {
                    let bytes = if let Some(array) = request["bytes"].as_array() {
                        array
                            .iter()
                            .filter_map(|v| v.as_u64().filter(|v| *v < 256).map(|v| v as u8))
                            .collect::<Vec<_>>()
                    } else {
                        request["data"].as_str().unwrap_or("").as_bytes().to_vec()
                    };
                    {
                        let mut s = state.lock().unwrap();
                        if let Err(error) =
                            ownership::fence_effect(&s.run_id, s.shell_running, &request)
                        {
                            let _ = tx.try_send(refusal(error, &s.run_id));
                            continue;
                        }
                        let decision = s.viewports.input(id);
                        if let Err(error) = settle(&mut s, &master, decision) {
                            let _ =
                                tx.try_send(json!({"type":"error","message":error}).to_string());
                            continue;
                        }
                    }
                    let mut writer = input.lock().unwrap();
                    writer
                        .write_all(&bytes)
                        .and_then(|_| writer.flush())
                        .map(|_| None)
                        .map_err(|e| e.to_string())
                }
                "resize" => {
                    let cols = request["cols"].as_u64().unwrap_or(100).clamp(2, 1000) as u16;
                    let rows = request["rows"].as_u64().unwrap_or(30).clamp(2, 1000) as u16;
                    let mut s = state.lock().unwrap();
                    if let Err(error) =
                        ownership::fence_effect(&s.run_id, s.shell_running, &request)
                    {
                        let _ = tx.try_send(refusal(error, &s.run_id));
                        continue;
                    }
                    let geometry = Viewport {
                        cols,
                        rows,
                        width: request["width_px"]
                            .as_u64()
                            .unwrap_or(0)
                            .min(u16::MAX as u64) as u16,
                        height: request["height_px"]
                            .as_u64()
                            .unwrap_or(0)
                            .min(u16::MAX as u64) as u16,
                    };
                    let decision = s
                        .viewports
                        .resize(id, geometry, Intent::from_request(&request));
                    settle(&mut s, &master, decision).map(|_| None)
                }
                "detach" => {
                    let mut s = state.lock().unwrap();
                    if let Err(error) = ownership::fence(&s.run_id, &request) {
                        let _ = tx.try_send(refusal(error, &s.run_id));
                        continue;
                    }
                    s.clients.remove(&id);
                    let decision = s.viewports.detach(id);
                    if let Err(error) = settle(&mut s, &master, decision) {
                        s.broadcast(json!({"type":"error","message":error}));
                    }
                    let _ = tx.try_send(
                        json!({"type":"detached","attachment":id,"run_id":s.run_id}).to_string(),
                    );
                    break;
                }

                "simulate" => start_simulation(
                    state.clone(),
                    request["prompt"]
                        .as_str()
                        .unwrap_or("Demonstrate the separate daemon")
                        .to_string(),
                )
                .map(|_| Some(json!({"type":"ack","op":"simulate"})))
                .map_err(String::from),
                _ => Err("Unknown operation".into()),
            };
            let event = match result {
                Ok(event) => event,
                Err(message) => Some(json!({"type":"error","message":message})),
            };
            if let Some(event) = event
                && tx.try_send(event.to_string()).is_err()
            {
                break;
            }
        }
        Ok(())
    })();
    {
        let mut s = state.lock().unwrap();
        s.clients.remove(&id);
        let decision = s.viewports.detach(id);
        if let Err(error) = settle(&mut s, &master, decision) {
            s.broadcast(json!({"type":"error","message":error}));
        }
    }
    drop(tx);
    let _ = stream.flush();
    outcome
}

type Master = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type Input = Arc<Mutex<Box<dyn Write + Send>>>;
pub struct Runtime {
    state: Shared,
    master: Master,
    input: Input,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    /// Descendant tracking for terminal-owned programs; absent for shells.
    tree: Option<Tree>,
}
type Tree = Arc<Mutex<ade_runtime::descendants::Shutdown>>;
/// Record a reaped terminal child under the state lock, so a later stop never
/// signals a reused process ID.
///
/// With a tracked tree the child's exit proves nothing about its descendants,
/// so the status stays `unknown` (`verifying`) until [`settle_exit`] applies
/// the tree's verdict.
fn record_exit(s: &mut State, status: &portable_pty::ExitStatus, tracked: bool) {
    let child = match status.signal() {
        Some(signal) => json!({"kind":"signaled","signal":signal}),
        None if status.success() => {
            json!({"kind":"success","code":status.exit_code()})
        }
        None => json!({"kind":"failure","code":status.exit_code()}),
    };
    s.exit_status = Some(if tracked {
        json!({"kind":"unknown","verifying":true,
            "reason":"Confirming that the process tree stopped","child":child})
    } else {
        child
    });
    s.shell_running = false;
}
/// The exit status to report once the tree's shutdown verdict is known. Only an
/// `exited` verdict reports the child's own status; a live or unverifiable
/// tree reports `unknown`, so nothing releases ownership without proof.
fn settle_exit(
    recorded: Option<Value>,
    verdict: &ade_runtime::descendants::Verdict,
) -> Option<Value> {
    let mut recorded = recorded?;
    let descendants = json!({"verdict":verdict.code(),"detail":verdict.detail()});
    let child = if recorded["verifying"] == true {
        recorded["child"].take()
    } else {
        recorded
    };
    let mut outcome =
        if child["kind"] == "unknown" || *verdict == ade_runtime::descendants::Verdict::Exited {
            child
        } else {
            json!({"kind":"unknown","child":child,"reason":format!(
                "The process exited, but its process tree was not confirmed stopped: {}",
                verdict.detail()
            )})
        };
    if let Value::Object(fields) = &mut outcome {
        fields.insert("descendants".into(), descendants);
    }
    Some(outcome)
}
/// Whether a terminal's exit is settled by its process tree's verdict. A
/// launched program always is. A shell is only after `terminal.stop`: a stop
/// is proven by an empty tree, while a shell the user exits keeps its jobs.
fn verifies_tree(launched: bool, stop_requested: bool) -> bool {
    launched || stop_requested
}
/// The tracked descendants of a tree, as (PID, start stamp).
fn identities(shutdown: &ade_runtime::descendants::Shutdown) -> Vec<(i32, u64)> {
    shutdown
        .descendants()
        .into_iter()
        .map(|identity| (identity.pid, identity.started))
        .collect()
}
/// How long a stopped shell has to exit after its hang-up before its whole
/// tree is killed.
const SHELL_STOP_GRACE: Duration = Duration::from_secs(2);
pub fn spawn_runtime(
    workspace: &WorkspaceRecord,
    launch: Option<&ade_runtime::terminal_launch::Launch>,
    data_directory: &std::path::Path,
) -> anyhow::Result<Runtime> {
    let pair = native_pty_system().openpty(PtySize {
        rows: 30,
        cols: 100,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = if let Some(launch) = launch {
        launch.validate()?;
        let mut command = CommandBuilder::new(&launch.program);
        command.args(&launch.args);
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        command
    } else {
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command
    };
    let root = std::path::Path::new(&workspace.root).canonicalize()?;
    let directory = if let Some(cwd) = launch.and_then(|l| l.cwd.as_ref()) {
        let directory = root.join(cwd).canonicalize()?;
        anyhow::ensure!(
            directory.starts_with(&root) && directory.is_dir(),
            "Terminal directory escapes its workspace"
        );
        directory
    } else {
        root
    };
    command.cwd(directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("ADE_PROTOTYPE", "1");
    let mut child = pair.slave.spawn_command(command)?;
    let killer = Mutex::new(child.clone_killer());
    // portable-pty starts the child in its own session, so its PID is the
    // group ID. Track the tree from the start so descendants that leave the
    // group are still known when the program stops. Shells are tracked too:
    // a stopped shell's background jobs are part of what the stop must end.
    let launched = launch.is_some();
    let tree: Option<Tree> = child.process_id().map(|pid| {
        let mut shutdown = ade_runtime::descendants::Shutdown::new(pid);
        shutdown.track();
        Arc::new(Mutex::new(shutdown))
    });
    let initial_descendants = tree
        .as_ref()
        .map(|tree| identities(&tree.lock().unwrap()))
        .unwrap_or_default();
    drop(pair.slave);
    let mut output = pair.master.try_clone_reader()?;
    let input = Arc::new(Mutex::new(pair.master.take_writer()?));
    let master = Arc::new(Mutex::new(pair.master));
    let (mut durable_log, durable_log_error) = if let Some(launch) = launch {
        match ade_runtime::service_logs::Writer::open(
            data_directory,
            &workspace.id,
            &workspace.terminal_id,
            &launch.transfer_id,
        ) {
            Ok(writer) => (Some(writer), None),
            Err(error) => (None, Some(error.to_string())),
        }
    } else {
        (None, None)
    };
    let (reply_tx, reply_rx) = mpsc::sync_channel::<Vec<u8>>(64);
    let reply_input = input.clone();
    std::thread::spawn(move || {
        while let Ok(bytes) = reply_rx.recv() {
            let mut writer = reply_input.lock().unwrap();
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let state = Arc::new(Mutex::new(State {
        started: Instant::now(),
        terminal: VecDeque::new(),
        xterm_replay: Vec::new(),
        xterm_replay_bytes: 0,
        xterm_replay_complete: true,
        screen: TerminalState::new(100, 30).map_err(anyhow::Error::msg)?,
        conversation: String::new(),
        streaming: false,
        clients: HashMap::new(),
        next_client: 0,
        bytes: 0,
        events: 0,
        viewports: Viewports::default(),
        pixel_size: (0, 0),
        reply_tx: Some(reply_tx),
        workspace_id: workspace.id.clone(),
        terminal_id: workspace.terminal_id.clone(),
        run_id: new_id("terminal-run"),
        transfer_id: launch.map(|l| l.transfer_id.clone()),
        session_subscribers: Arc::new(AtomicUsize::new(0)),
        reply_dropped_bytes: 0,
        shell_pid: child.process_id(),
        shell_running: true,
        exit_status: None,
        durable_log_error,
        stop_requested: false,
        viewer_resyncs: 0,
        descendants: initial_descendants,
        titles: Default::default(),
    }));
    let terminal_state = state.clone();
    let reader_tree = tree.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match output.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(writer) = durable_log.as_mut()
                        && let Err(error) = writer.append(&buffer[..n])
                    {
                        durable_log = None;
                        terminal_state.lock().unwrap().durable_log_error = Some(error.to_string());
                    }
                    terminal_state.lock().unwrap().append_terminal(&buffer[..n]);
                }
            }
        }
        // A terminal-owned program may have a private server in its process
        // group, or descendants that left it. The direct child's exit proves
        // nothing about them: signal the tracked tree (TERM, then KILL) and
        // require evidence that it has stopped. The tree reaps the child only
        // after the group is empty, so the group ID stays ours while signalled.
        // Lock order is tree, then state; stop() only try-locks the tree.
        // A shell that exits on its own keeps its plain exit status; one that
        // was stopped is proven by the same verdict as a program.
        let verify = verifies_tree(launched, terminal_state.lock().unwrap().stop_requested);
        let descendants = reader_tree.as_ref().filter(|_| verify).map(|tree| {
            let mut shutdown = tree.lock().unwrap_or_else(|poison| poison.into_inner());
            shutdown.stop(&ade_runtime::descendants::Policy::default(), &mut || {
                let mut s = terminal_state.lock().unwrap();
                match child.try_wait()? {
                    Some(status) => {
                        record_exit(&mut s, &status, true);
                        Ok(true)
                    }
                    None => Ok(false),
                }
            })
        });
        let exited = loop {
            let mut s = terminal_state.lock().unwrap();
            if !s.shell_running {
                break true;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Reap and update the state under the same lock as stop(),
                    // so a later stop never signals a reused process ID.
                    record_exit(&mut s, &status, descendants.is_some());
                    break true;
                }
                Err(error) => {
                    s.exit_status = Some(json!({"kind":"unknown","reason":error.to_string()}));
                    s.broadcast(json!({"type":"error","message":format!("Could not confirm terminal exit: {error}")}));
                    break false;
                }
                Ok(None) => {}
            }
            drop(s);
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut s = terminal_state.lock().unwrap();
        if let Some(verdict) = &descendants {
            s.exit_status = settle_exit(s.exit_status.take(), verdict);
        }
        if exited {
            let message = match &descendants {
                Some(ade_runtime::descendants::Verdict::Exited) => {
                    "The process has exited. Its terminal output remains available.".to_owned()
                }
                Some(verdict) => format!(
                    "The process has exited, but its process tree was not confirmed stopped: {}. Some of its processes may still be running.",
                    verdict.detail()
                ),
                None => "The shell has exited. Use New shell to start another.".to_owned(),
            };
            s.broadcast(json!({"type":"error","message":message}));
        }
    });
    let metric_state = state.clone();
    let metric_tree = tree.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            {
                let mut s = metric_state.lock().unwrap();
                if !s.shell_running {
                    break;
                }
                if !s.clients.is_empty() {
                    let event = json!({"type":"metrics","metrics":s.metrics()});
                    s.broadcast(event);
                }
            }
            // Keep the tracked tree current while the program runs. Never wait
            // for the tree lock: the reader holds it while proving shutdown.
            if let Some(tree) = &metric_tree
                && let Ok(mut shutdown) = tree.try_lock()
            {
                shutdown.track();
                let descendants = identities(&shutdown);
                drop(shutdown);
                metric_state.lock().unwrap().descendants = descendants;
            }
        }
    });

    Ok(Runtime {
        state,
        master,
        input,
        killer,
        tree,
    })
}

impl Runtime {
    pub fn tail(&self, limit: usize) -> Value {
        use base64::Engine as _;
        let state = self.state.lock().unwrap();
        let retained_start = state.bytes.saturating_sub(state.terminal.len() as u64);
        let start = state.bytes.saturating_sub(limit as u64).max(retained_start);
        let skip = (start - retained_start) as usize;
        let bytes = state
            .terminal
            .iter()
            .skip(skip)
            .copied()
            .collect::<Vec<_>>();
        json!({"type":"terminal_tail","run_id":state.run_id,"transfer_id":state.transfer_id,
            "start_offset":start,"through_offset":state.bytes,
            "retained_start_offset":retained_start,"truncated":start > 0,
            "retention_overflow":retained_start > 0,"coverage":"captured_bytes_only",
            "bytes_base64":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.shell_running && state.transfer_id.is_none() {
            // A shell: hang up so it can exit cleanly, then prove the tree.
            // The reader settles the exit by the tree's verdict; a shell that
            // outlives the grace period has its whole tree killed.
            let first = !state.stop_requested;
            state.stop_requested = true;
            // Observe the tree before the hang-up, so jobs the shell started
            // are still known after they are reparented. A busy tree is being
            // observed by the metrics thread already.
            if let Some(tree) = &self.tree
                && let Ok(mut shutdown) = tree.try_lock()
            {
                shutdown.track();
            }
            self.killer.lock().unwrap().kill()?;
            if first && let Some(tree) = self.tree.clone() {
                let state = self.state.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(SHELL_STOP_GRACE);
                    let shell_pid = {
                        let s = state.lock().unwrap();
                        if !s.shell_running {
                            return;
                        }
                        s.shell_pid
                    };
                    match tree.try_lock() {
                        Ok(mut shutdown) => shutdown.kill_now(),
                        // The reader is already proving the tree stopped.
                        Err(_) => {
                            if let Some(pid) = shell_pid {
                                let s = state.lock().unwrap();
                                if s.shell_running {
                                    // SAFETY: plain syscall; the shell is unreaped, so its group ID is ours.
                                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                                }
                            }
                        }
                    }
                });
            }
            return Ok(());
        }
        if state.shell_running {
            state.stop_requested = true;
            // A launched program: observe the tree before signalling so
            // descendants outside the group are killed too. The reader thread
            // then proves the tree stopped. When the tree is busy (the metrics
            // thread is tracking it, or the reader is already proving
            // shutdown), still signal the group so a stop is never dropped.
            let signalled = match &self.tree {
                Some(tree) => match tree.try_lock() {
                    Ok(mut shutdown) => {
                        shutdown.kill_now();
                        true
                    }
                    Err(_) => false,
                },
                None => false,
            };
            if !signalled && let Some(pid) = state.shell_pid {
                let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                if result != 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
        Ok(())
    }
    pub fn set_session_subscribers(&self, count: usize) {
        self.state
            .lock()
            .unwrap()
            .session_subscribers
            .store(count, Ordering::Relaxed);
    }
    pub fn metrics(&self) -> Value {
        self.state.lock().unwrap().metrics()
    }
    /// What runs in the terminal now, for its record: whether another
    /// process group holds the PTY's foreground (`tcgetpgrp` on the master)
    /// and that group leader's name. See `ade_runtime::foreground`.
    pub fn activity(&self) -> ade_core::runtime_protocol::terminal::Activity {
        use ade_runtime::foreground::{busy, process_name};
        let (running, pid, title, stop_requested) = {
            let state = self.state.lock().unwrap();
            (
                state.shell_running,
                state.shell_pid.map(|pid| pid as i32),
                state.titles.title().map(str::to_owned),
                state.stop_requested,
            )
        };
        let mut activity = ade_core::runtime_protocol::terminal::Activity {
            title,
            stop_requested,
            ..Default::default()
        };
        if running {
            let group = self.master.lock().unwrap().process_group_leader();
            activity.busy = busy(pid, group);
            activity.program = pid.and_then(process_name);
            activity.foreground = group.filter(|_| activity.busy).and_then(process_name);
        }
        activity
    }
    pub fn serve(
        &self,
        stream: UnixStream,
        reader: BufReader<UnixStream>,
        first: String,
        admitted: Arc<AtomicBool>,
    ) -> io::Result<()> {
        handle_client(
            stream,
            reader,
            first,
            self.state.clone(),
            self.master.clone(),
            self.input.clone(),
            admitted,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_an_exited_tree_reports_the_child_status() {
        use ade_runtime::descendants::Verdict;
        let verifying = || {
            Some(json!({"kind":"unknown","verifying":true,"reason":"r",
                "child":{"kind":"signaled","signal":9}}))
        };
        // A descendant survived SIGKILL: the stop must not read as an exit.
        let live = settle_exit(verifying(), &Verdict::Live { pids: vec![42] }).unwrap();
        assert_eq!(live["kind"], "unknown");
        assert_eq!(live["child"]["kind"], "signaled");
        assert_eq!(live["descendants"]["verdict"], "live");
        assert!(live.get("verifying").is_none());
        // The process table could not be read.
        let unverifiable = settle_exit(
            verifying(),
            &Verdict::Unverifiable {
                reason: "proc_listpids failed".into(),
            },
        )
        .unwrap();
        assert_eq!(unverifiable["kind"], "unknown");
        assert_eq!(unverifiable["descendants"]["verdict"], "unverifiable");
        // Proven exit keeps the child's own status.
        let exited = settle_exit(verifying(), &Verdict::Exited).unwrap();
        assert_eq!(exited["kind"], "signaled");
        assert_eq!(exited["signal"], 9);
        assert_eq!(exited["descendants"]["verdict"], "exited");
        // A status recorded without the verifying marker is still downgraded.
        let plain = settle_exit(
            Some(json!({"kind":"success","code":0})),
            &Verdict::Live { pids: vec![7] },
        )
        .unwrap();
        assert_eq!(plain["kind"], "unknown");
        // An already unknown exit stays unknown with its own reason.
        let unknown = settle_exit(
            Some(json!({"kind":"unknown","reason":"wait failed"})),
            &Verdict::Exited,
        )
        .unwrap();
        assert_eq!(unknown["kind"], "unknown");
        assert_eq!(unknown["reason"], "wait failed");
    }
    #[test]
    fn a_stopped_shell_is_settled_by_its_tree_but_an_exited_one_is_not() {
        // A launched program is always proven by its tree.
        assert!(verifies_tree(true, false));
        assert!(verifies_tree(true, true));
        // terminal.stop on a shell: only an empty tree proves the stop.
        assert!(verifies_tree(false, true));
        // A shell the user exits keeps its own status and its jobs.
        assert!(!verifies_tree(false, false));
    }
    #[test]
    fn reply_backpressure_does_not_block_output() {
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(vec![0]).unwrap();
        let mut state = State {
            workspace_id: String::new(),
            terminal_id: String::new(),
            run_id: String::new(),
            transfer_id: None,
            session_subscribers: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
            terminal: VecDeque::new(),
            xterm_replay: Vec::new(),
            xterm_replay_bytes: 0,
            xterm_replay_complete: true,
            screen: TerminalState::new(80, 24).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            viewports: Viewports::default(),
            pixel_size: (0, 0),
            reply_tx: Some(tx),
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
            exit_status: None,
            durable_log_error: None,
            stop_requested: false,
            viewer_resyncs: 0,
            descendants: Vec::new(),
            titles: Default::default(),
        };
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            rx.recv().unwrap();
        });
        let start = Instant::now();
        state.append_terminal(b"\x1b[6n");
        let elapsed = start.elapsed();
        assert!(state.reply_dropped_bytes > 0);
        release.join().unwrap();
        assert!(
            elapsed < Duration::from_millis(200),
            "reply queue blocked output for {elapsed:?}"
        );
    }
    #[test]
    fn active_screen_survives_discarded_raw_history() {
        let mut state = State {
            workspace_id: String::new(),
            terminal_id: String::new(),
            run_id: String::new(),
            transfer_id: None,
            session_subscribers: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
            terminal: VecDeque::new(),
            xterm_replay: Vec::new(),
            xterm_replay_bytes: 0,
            xterm_replay_complete: true,
            screen: TerminalState::new(100, 30).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            viewports: Viewports::default(),
            pixel_size: (0, 0),
            reply_tx: None,
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
            exit_status: None,
            durable_log_error: None,
            stop_requested: false,
            viewer_resyncs: 0,
            descendants: Vec::new(),
            titles: Default::default(),
        };
        state.append_terminal(b"\x1b[2J\x1b[HPINNED BEFORE RAW RING");
        let repaint = b"\x1b[2;1Hupdated row, pinned row remains".repeat(10000);
        state.append_terminal(&repaint);
        let snapshot = state.snapshot();
        let gui = state.snapshot_for(false, false);
        assert!(gui.get("terminal").is_none());
        assert!(gui.get("terminal_bytes").is_none());
        assert!(gui.get("terminal_screen_bytes").is_none());
        assert!(gui.get("terminal_recovery").is_none());
        let terminal = state.snapshot_for(true, false);
        assert!(terminal.get("terminal_bytes").is_none());
        assert!(terminal.get("terminal_screen_bytes").is_some());
        assert!(
            !snapshot["terminal"]
                .as_str()
                .unwrap()
                .contains("PINNED BEFORE RAW RING")
        );
        let bytes: Vec<u8> = snapshot["terminal_screen_bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect();
        assert!(String::from_utf8_lossy(&bytes).contains("PINNED BEFORE RAW RING"));
        assert_eq!(state.screen.info()[2], 31);
        assert_eq!(state.screen.info()[3], 1);
    }
    #[test]
    fn history_is_bounded_and_a_slow_subscriber_is_resynchronized_not_removed() {
        let mut state = State {
            workspace_id: String::new(),
            terminal_id: String::new(),
            run_id: String::new(),
            transfer_id: None,
            session_subscribers: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
            terminal: VecDeque::new(),
            xterm_replay: Vec::new(),
            xterm_replay_bytes: 0,
            xterm_replay_complete: true,
            screen: TerminalState::new(100, 30).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            viewports: Viewports::default(),
            pixel_size: (0, 0),
            reply_tx: None,
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
            exit_status: None,
            durable_log_error: None,
            stop_requested: false,
            viewer_resyncs: 0,
            descendants: Vec::new(),
            titles: Default::default(),
        };
        let (tx, rx) = mpsc::sync_channel(1);
        let outbox = Arc::new(Outbox::default());
        state.clients.insert(
            1,
            Subscriber {
                tx,
                terminal: true,
                disconnect: None,
                outbox: outbox.clone(),
                kind: SnapshotKind::XtermReplay,
            },
        );
        state.append_terminal(&vec![b'a'; SCROLLBACK + 10]);
        state.append_terminal(b"end");
        assert_eq!(state.terminal.len(), SCROLLBACK);
        // The queue filled: the viewer is kept, marked lagging, and gets no
        // more live frames until its queue drains.
        assert_eq!(state.clients.len(), 1);
        assert!(outbox.lagging.load(Ordering::Acquire));
        assert_eq!(state.bytes, (SCROLLBACK + 13) as u64);
        // Nothing is resent while a frame queued before the lag is unwritten.
        assert!(state.resync(1).is_none());
        let Ok(Out::Live(line)) = rx.try_recv() else {
            panic!("the first frame stays queued");
        };
        outbox.queued.fetch_sub(line.len(), Ordering::AcqRel);
        assert!(rx.try_recv().is_err());
        // Drained: a fresh snapshot through the latest offset, then live again.
        let snapshot = state.resync(1).unwrap().unwrap();
        assert_eq!(snapshot["resync"], true);
        assert_eq!(snapshot["attachment"], 1);
        assert_eq!(
            snapshot["terminal_recovery"]["through_offset"],
            (SCROLLBACK + 13) as u64
        );
        assert!(!outbox.lagging.load(Ordering::Acquire));
        assert_eq!(state.viewer_resyncs, 1);
        state.append_terminal(b"next");
        let Ok(Out::Live(line)) = rx.try_recv() else {
            panic!("live output resumes after the snapshot");
        };
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["offset"], (SCROLLBACK + 13) as u64);
        // Only a viewer whose writer is gone is removed.
        drop(rx);
        outbox.queued.store(0, Ordering::Release);
        state.append_terminal(b"gone");
        assert!(state.clients.is_empty());
        assert!(
            state.snapshot()["terminal"]
                .as_str()
                .unwrap()
                .ends_with("endnextgone")
        );
    }
}
