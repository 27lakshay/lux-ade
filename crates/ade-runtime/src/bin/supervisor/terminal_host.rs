use ade_runtime::model::{WorkspaceRecord, new_id};
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
const CONVERSATION: usize = 64 * 1024;
const MAX_REQUEST: u64 = 128 * 1024;

struct Subscriber {
    tx: SyncSender<String>,
    terminal: bool,
    disconnect: Option<UnixStream>,
}

#[derive(Clone, Copy)]
struct Controller {
    cols: u16,
    rows: u16,
    width: u16,
    height: u16,
    claim: u64,
    registered: u64,
}

struct State {
    started: Instant,
    terminal: VecDeque<u8>,
    screen: TerminalState,
    conversation: String,
    streaming: bool,
    clients: HashMap<u64, Subscriber>,
    next_client: u64,
    bytes: u64,
    events: u64,
    owner: Option<u64>,
    controllers: HashMap<u64, Controller>,
    next_claim: u64,
    pixel_size: (u16, u16),
    reply_tx: Option<SyncSender<Vec<u8>>>,
    reply_dropped_bytes: u64,
    shell_pid: Option<u32>,
    shell_running: bool,
    workspace_id: String,
    terminal_id: String,
    run_id: String,
    transfer_id: Option<String>,
    session_subscribers: Arc<AtomicUsize>,
}

impl State {
    fn metrics(&self) -> Value {
        json!({"pid":std::process::id(),"uptime_ms":self.started.elapsed().as_millis() as u64,
            "clients":self.clients.len()+self.session_subscribers.load(Ordering::Relaxed),
            "workspace_id":self.workspace_id,"terminal_id":self.terminal_id,"run_id":self.run_id,"transfer_id":self.transfer_id,"terminal_bytes":self.bytes,"events":self.events,
            "reply_dropped_bytes":self.reply_dropped_bytes,"pixel_size":self.pixel_size,"scrollback_bytes":self.terminal.len(),"resize_owner":self.owner,
            "shell_pid":self.shell_pid,"shell_running":self.shell_running})
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
        self.bytes += data.len() as u64;
        self.terminal.extend(data);
        if self.terminal.len() > SCROLLBACK {
            self.terminal.drain(..self.terminal.len() - SCROLLBACK);
        }
        self.broadcast(
            json!({"type":"terminal","data":String::from_utf8_lossy(data),"bytes":data,
                "offset":self.bytes - data.len() as u64}),
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
    geometry: Controller,
) -> Result<(), String> {
    let Controller {
        cols,
        rows,
        width,
        height,
        ..
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
    state.broadcast(json!({"type":"terminal_resize","cols":cols,"rows":rows,"offset":offset}));
    Ok(())
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
                    json!({"type":"hello", "session_protocol":"ade-sessions-v1","worktree_protocol":"ade-worktrees-v1","review_protocol":"ade-review-v1", "response_owner":"daemon-v1", "terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d"}),
                )),
                "ping" => Ok(Some(
                    json!({"type":"metrics","metrics":state.lock().unwrap().metrics()}),
                )),
                "subscribe" => {
                    let mut s = state.lock().unwrap();
                    if !subscribed {
                        // Snapshot and registration share a lock so no output falls in between.
                        let terminal = request["terminal"].as_bool().unwrap_or(true);
                        let snapshot = if terminal && request["snapshot_format"] == "binary" {
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
                        if let Some(controller) = s.controllers.get(&id).copied() {
                            s.next_claim += 1;
                            let rank = s.next_claim;
                            s.controllers.get_mut(&id).unwrap().claim = rank;
                            s.owner = Some(id);
                            if let Err(error) = apply_size(&mut s, &master, controller) {
                                let _ = tx
                                    .try_send(json!({"type":"error","message":error}).to_string());
                                continue;
                            }
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
                    let claim = request["claim"].as_bool().unwrap_or(false) || s.owner.is_none();
                    if claim {
                        s.next_claim += 1;
                        s.owner = Some(id);
                    }
                    let rank = if claim {
                        s.next_claim
                    } else {
                        s.controllers.get(&id).map(|c| c.claim).unwrap_or(0)
                    };
                    let registered = if let Some(c) = s.controllers.get(&id) {
                        c.registered
                    } else {
                        s.next_claim += 1;
                        s.next_claim
                    };
                    let geometry = Controller {
                        registered,
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
                        claim: rank,
                    };
                    s.controllers.insert(id, geometry);
                    if s.owner == Some(id) {
                        apply_size(&mut s, &master, geometry).map(|_| None)
                    } else {
                        Ok(None)
                    }
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
        s.controllers.remove(&id);
        if s.owner == Some(id) {
            s.owner = s
                .controllers
                .iter()
                .max_by_key(|(_, c)| (c.claim, c.registered))
                .map(|(id, _)| *id);
            if let Some(owner) = s.owner {
                let controller = s.controllers[&owner];
                if let Err(error) = apply_size(&mut s, &master, controller) {
                    s.broadcast(json!({"type":"error","message":error}));
                }
            }
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
}
pub fn spawn_runtime(
    workspace: &WorkspaceRecord,
    launch: Option<&ade_runtime::terminal_launch::Launch>,
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
    drop(pair.slave);
    let mut output = pair.master.try_clone_reader()?;
    let input = Arc::new(Mutex::new(pair.master.take_writer()?));
    let master = Arc::new(Mutex::new(pair.master));
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
        screen: TerminalState::new(100, 30).map_err(anyhow::Error::msg)?,
        conversation: String::new(),
        streaming: false,
        clients: HashMap::new(),
        next_client: 0,
        bytes: 0,
        events: 0,
        owner: None,
        controllers: HashMap::new(),
        next_claim: 0,
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
    }));
    let terminal_state = state.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match output.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => terminal_state.lock().unwrap().append_terminal(&buffer[..n]),
            }
        }
        // A terminal-owned agent may have a private server in its process
        // group. End it before releasing ownership, while the child PID is
        // still reserved by the OS (we have not reaped it yet).
        {
            let s = terminal_state.lock().unwrap();
            if s.transfer_id.is_some()
                && let Some(pid) = s.shell_pid
            {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        loop {
            let mut s = terminal_state.lock().unwrap();
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Reap and update the state under the same lock as stop(),
                    // so a later stop never signals a reused process ID.
                    s.shell_running = false;
                    let message = if s.transfer_id.is_some() {
                        "The process has exited. Its terminal output remains available."
                    } else {
                        "The shell has exited. Use New shell to start another."
                    };
                    s.broadcast(json!({"type":"error","message":message}));
                    break;
                }
                Err(error) => {
                    s.broadcast(json!({"type":"error","message":format!("Could not confirm terminal exit: {error}")}));
                    break;
                }
                Ok(None) => {}
            }
            drop(s);
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let metric_state = state.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let mut s = metric_state.lock().unwrap();
            if !s.shell_running {
                break;
            }
            if !s.clients.is_empty() {
                let event = json!({"type":"metrics","metrics":s.metrics()});
                s.broadcast(event);
            }
        }
    });

    Ok(Runtime {
        state,
        master,
        input,
        killer,
    })
}

impl Runtime {
    pub fn stop(&self) -> anyhow::Result<()> {
        let state = self.state.lock().unwrap();
        if state.shell_running {
            if state.transfer_id.is_some() {
                if let Some(pid) = state.shell_pid {
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
            screen: TerminalState::new(80, 24).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            owner: None,
            controllers: HashMap::new(),
            next_claim: 0,
            pixel_size: (0, 0),
            reply_tx: Some(tx),
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
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
            screen: TerminalState::new(100, 30).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            owner: None,
            controllers: HashMap::new(),
            next_claim: 0,
            pixel_size: (0, 0),
            reply_tx: None,
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
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
            screen: TerminalState::new(100, 30).unwrap(),
            conversation: String::new(),
            streaming: false,
            clients: HashMap::new(),
            next_client: 0,
            bytes: 0,
            events: 0,
            owner: None,
            controllers: HashMap::new(),
            next_claim: 0,
            pixel_size: (0, 0),
            reply_tx: None,
            reply_dropped_bytes: 0,
            shell_pid: None,
            shell_running: true,
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
