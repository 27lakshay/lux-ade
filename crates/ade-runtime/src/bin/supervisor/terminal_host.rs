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

struct Subscriber {
    tx: SyncSender<String>,
    terminal: bool,
    disconnect: Option<UnixStream>,
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
}

impl State {
    fn metrics(&self) -> Value {
        let mut metrics = json!({"pid":std::process::id(),"uptime_ms":self.started.elapsed().as_millis() as u64,
            "clients":self.clients.len()+self.session_subscribers.load(Ordering::Relaxed),
            "workspace_id":self.workspace_id,"terminal_id":self.terminal_id,"run_id":self.run_id,"transfer_id":self.transfer_id,"terminal_bytes":self.bytes,"events":self.events,
            "reply_dropped_bytes":self.reply_dropped_bytes,"pixel_size":self.pixel_size,"scrollback_bytes":self.terminal.len(),"resize_owner":self.viewports.owner(),
            "shell_pid":self.shell_pid,"shell_running":self.shell_running,
            "durable_log_error":self.durable_log_error});
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
        // A slow client reconnects from a snapshot; it cannot stall the PTY producer.
        let terminal = event["type"] == "terminal" || event["type"] == "terminal_resize";
        self.clients.retain(|_, client| {
            if terminal && !client.terminal {
                return true;
            }
            if client.tx.try_send(line.clone()).is_ok() {
                return true;
            }
            if let Some(socket) = &client.disconnect {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            false
        });
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
                // A full queue evicts the client on the next broadcast.
                let _ = client.tx.try_send(frame.to_string());
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
    let (tx, rx) = mpsc::sync_channel::<String>(64);
    let mut writer_stream = stream.try_clone()?;
    std::thread::spawn(move || {
        while let Ok(line) = rx.recv() {
            if writeln!(writer_stream, "{line}").is_err() {
                break;
            }
        }
        let _ = writer_stream.shutdown(std::net::Shutdown::Both);
    });
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
                        let snapshot =
                            if terminal && request["snapshot_format"] == "xterm-replay-v1" {
                                s.xterm_snapshot()
                            } else if terminal && request["snapshot_format"] == "binary" {
                                match s.binary_snapshot(request["snapshot_encoding"] == "base64") {
                                    Ok(snapshot) => snapshot,
                                    Err(error) => {
                                        let _ = tx.try_send(
                                            json!({"type":"error","message":error}).to_string(),
                                        );
                                        // No live output can follow a failed restore.
                                        continue;
                                    }
                                }
                            } else {
                                s.snapshot_for(terminal, false)
                            };
                        let mut snapshot = snapshot;
                        snapshot["run_id"] = json!(s.run_id);
                        snapshot["attachment"] = json!(id);
                        let _ = tx.try_send(snapshot.to_string());
                        s.clients.insert(
                            id,
                            Subscriber {
                                tx: tx.clone(),
                                terminal,
                                disconnect: Some(stream.try_clone()?),
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
fn record_exit(s: &mut State, status: &portable_pty::ExitStatus) {
    s.exit_status = Some(match status.signal() {
        Some(signal) => json!({"kind":"signaled","signal":signal}),
        None if status.success() => {
            json!({"kind":"success","code":status.exit_code()})
        }
        None => json!({"kind":"failure","code":status.exit_code()}),
    });
    s.shell_running = false;
}
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
    // group are still known when the program stops.
    let tree: Option<Tree> = launch.and(child.process_id()).map(|pid| {
        let mut shutdown = ade_runtime::descendants::Shutdown::new(pid);
        shutdown.track();
        Arc::new(Mutex::new(shutdown))
    });
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
        let descendants = reader_tree.as_ref().map(|tree| {
            let mut shutdown = tree.lock().unwrap_or_else(|poison| poison.into_inner());
            shutdown.stop(&ade_runtime::descendants::Policy::default(), &mut || {
                let mut s = terminal_state.lock().unwrap();
                match child.try_wait()? {
                    Some(status) => {
                        record_exit(&mut s, &status);
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
                    record_exit(&mut s, &status);
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
        if let Some(verdict) = &descendants
            && let Some(Value::Object(outcome)) = s.exit_status.as_mut()
        {
            // Additive: the child's own status stays as it was reported.
            outcome.insert(
                "descendants".into(),
                json!({"verdict":verdict.code(),"detail":verdict.detail()}),
            );
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
        let state = self.state.lock().unwrap();
        if state.shell_running {
            if state.transfer_id.is_some() {
                // Observe the tree before signalling so descendants outside
                // the group are killed too. The reader thread then proves the
                // tree stopped; when it already holds the tree it is doing so.
                if let Some(tree) = &self.tree
                    && let Ok(mut shutdown) = tree.try_lock()
                {
                    shutdown.kill_now();
                } else if self.tree.is_none()
                    && let Some(pid) = state.shell_pid
                {
                    let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                    if result != 0
                        && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                    {
                        return Err(std::io::Error::last_os_error().into());
                    }
                }
            } else {
                self.killer.lock().unwrap().kill()?;
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
    fn history_is_bounded_and_slow_subscriber_is_removed() {
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
        };
        let (tx, _rx) = mpsc::sync_channel(1);
        state.clients.insert(
            1,
            Subscriber {
                tx,
                terminal: true,
                disconnect: None,
            },
        );
        state.append_terminal(&vec![b'a'; SCROLLBACK + 10]);
        state.append_terminal(b"end");
        assert_eq!(state.terminal.len(), SCROLLBACK);
        assert!(state.clients.is_empty());
        assert_eq!(state.bytes, (SCROLLBACK + 13) as u64);
        assert!(
            state.snapshot()["terminal"]
                .as_str()
                .unwrap()
                .ends_with("end")
        );
    }
}
