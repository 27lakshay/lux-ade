//! Stable owner of PTYs, parser state and provider processes. This process never
//! opens the application database or executes worktree lifecycle requests.
use super::{service_proxy, terminal_host};
use ade_runtime::{
    model::{WorkspaceRecord, now_ms},
    runtime::{self, PROTOCOL, read_frame, write_frame},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::BufReader,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct Terminal {
    workspace: WorkspaceRecord,
    launch: Option<ade_runtime::terminal_launch::Launch>,
    runtime: Arc<terminal_host::Runtime>,
}
struct Owner {
    token: String,
    draining: bool,
    streams: HashMap<String, (String, UnixStream, Arc<AtomicBool>)>,
}
struct Handoff {
    ticket: String,
    expires: i64,
}
struct State {
    owner: Option<Owner>,
    handoff: Option<Handoff>,
    terminals: HashMap<String, Terminal>,
    agents: HashMap<String, Arc<ade_runtime::agent_runtime::Run>>,
}
struct Host {
    data: Mutex<State>,
    proxies: service_proxy::Manager,
    directory: PathBuf,
    instance: String,
    stop: AtomicBool,
}
impl Host {
    fn hello(&self) -> Value {
        json!({"type":"hello","runtime_protocol":PROTOCOL,"build_id":std::env::var("ADE_RUNTIME_BUILD_ID").ok(),"pid":std::process::id(),"instance_id":self.instance,"data_directory":self.directory})
    }
    fn release(&self, token: &str) {
        let mut data = self.data.lock().unwrap();
        if data
            .owner
            .as_ref()
            .is_some_and(|owner| owner.token == token)
        {
            let owner = data.owner.take().unwrap();
            // Fence every old connection, including streams blocked in an input read.
            for (_, stream, admitted) in owner.streams.values() {
                admitted.store(false, Ordering::Release);
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
    fn command(&self, token: &str, request: &Value) -> Result<Value> {
        let mut data = self.data.lock().unwrap();
        ensure!(
            data.owner.as_ref().is_some_and(|o| o.token == token),
            "Runtime owner changed"
        );
        match request["op"].as_str().unwrap_or("") {
            "proxy.ensure" => self.proxies.ensure(
                request["workspace_id"]
                    .as_str()
                    .context("Missing workspace ID")?,
                request["service_name"]
                    .as_str()
                    .context("Missing service name")?,
                request["port_variable"]
                    .as_str()
                    .context("Missing port variable")?,
                request["service_identity"]
                    .as_str()
                    .context("Missing service identity")?,
                u16::try_from(
                    request["target_port"]
                        .as_u64()
                        .context("Missing target port")?,
                )?,
                request["remap"] == true,
                request["expected_route_identity"].as_str().unwrap_or(""),
                u16::try_from(request["expected_route_port"].as_u64().unwrap_or(0))?,
                std::path::Path::new(
                    request["daemon_socket"]
                        .as_str()
                        .context("Missing daemon socket")?,
                ),
            ),
            "proxy.inspect" => self.proxies.inspect(
                request["workspace_id"]
                    .as_str()
                    .context("Missing workspace ID")?,
                request["service_name"]
                    .as_str()
                    .context("Missing service name")?,
                request["port_variable"]
                    .as_str()
                    .context("Missing port variable")?,
            ),
            "proxy.retire" => self.proxies.retire(
                request["workspace_id"]
                    .as_str()
                    .context("Missing workspace ID")?,
                request["service_name"]
                    .as_str()
                    .context("Missing service name")?,
                request["port_variable"]
                    .as_str()
                    .context("Missing port variable")?,
                request["expected_route_id"]
                    .as_str()
                    .context("Missing expected route ID")?,
                request["expected_service_identity"]
                    .as_str()
                    .context("Missing expected service identity")?,
                u16::try_from(
                    request["expected_target_port"]
                        .as_u64()
                        .context("Missing expected target port")?,
                )?,
                u16::try_from(
                    request["expected_proxy_port"]
                        .as_u64()
                        .context("Missing expected proxy port")?,
                )?,
            ),
            "proxy.recovery.inspect" => Ok(self.proxies.recovery_inspect()),
            "proxy.recovery.retry" => self.proxies.recovery_retry(
                request["workspace_id"]
                    .as_str()
                    .context("Missing workspace ID")?,
                request["service_name"]
                    .as_str()
                    .context("Missing service name")?,
                request["port_variable"]
                    .as_str()
                    .context("Missing port variable")?,
                request["expected_route_id"]
                    .as_str()
                    .context("Missing expected route ID")?,
                request["expected_service_identity"]
                    .as_str()
                    .context("Missing expected service identity")?,
                u16::try_from(
                    request["expected_target_port"]
                        .as_u64()
                        .context("Missing expected target port")?,
                )?,
                u16::try_from(
                    request["expected_proxy_port"]
                        .as_u64()
                        .context("Missing expected proxy port")?,
                )?,
                std::path::Path::new(
                    request["daemon_socket"]
                        .as_str()
                        .context("Missing daemon socket")?,
                ),
            ),
            "proxy.recovery.reset" => self.proxies.recovery_reset(
                request["expected_registry_sha256"]
                    .as_str()
                    .context("Missing expected registry SHA-256")?,
            ),
            "terminal.list" => Ok(
                json!({"type":"terminals","terminals":data.terminals.values().map(|t|json!({"workspace":t.workspace,"metrics":t.runtime.metrics()})).collect::<Vec<_>>()}),
            ),
            "terminal.tail" => {
                let workspace = request["workspace_id"]
                    .as_str()
                    .context("Missing workspace_id")?;
                let terminal_id = request["terminal_id"]
                    .as_str()
                    .context("Missing terminal_id")?;
                let limit = request["limit_bytes"]
                    .as_u64()
                    .context("Missing tail limit")?;
                ensure!(
                    (1..=32768).contains(&limit),
                    "Tail limit must be 1 to 32768 bytes"
                );
                let terminal = data
                    .terminals
                    .values()
                    .find(|terminal| {
                        terminal.workspace.id == workspace
                            && terminal.workspace.terminal_id == terminal_id
                    })
                    .context("Service terminal is unavailable")?;
                Ok(terminal.runtime.tail(limit as usize))
            }
            "terminal.stop" | "terminal.retire" => {
                ensure!(
                    !data.owner.as_ref().unwrap().draining,
                    "Runtime handoff is in progress"
                );
                let key = data
                    .terminals
                    .iter()
                    .find(|(_, terminal)| {
                        request["workspace_id"] == terminal.workspace.id
                            && request["terminal_id"] == terminal.workspace.terminal_id
                    })
                    .map(|(key, _)| key.clone());
                if let Some(key) = key {
                    let terminal = &data.terminals[&key];
                    if request["op"] == "terminal.stop" {
                        terminal.runtime.stop()?;
                    } else {
                        ensure!(
                            terminal.runtime.metrics()["shell_running"] != true,
                            "Stop the shell before retiring its terminal"
                        );
                        for (id, stream, admitted) in data.owner.as_ref().unwrap().streams.values()
                        {
                            if id == &key {
                                admitted.store(false, Ordering::Release);
                                let _ = stream.shutdown(std::net::Shutdown::Both);
                            }
                        }
                        data.terminals.remove(&key);
                    }
                }
                if request["op"] == "terminal.retire" {
                    let workspace = request["workspace_id"]
                        .as_str()
                        .context("Missing workspace_id")?;
                    let terminal = request["terminal_id"]
                        .as_str()
                        .context("Missing terminal_id")?;
                    ade_runtime::service_logs::remove(&self.directory, workspace, terminal)?;
                }
                Ok(json!({"type":"ack"}))
            }
            "terminal.ensure" | "terminal.restart" | "terminal.launch" => {
                ensure!(
                    !data.owner.as_ref().unwrap().draining,
                    "Runtime handoff is in progress"
                );
                let workspace: WorkspaceRecord =
                    serde_json::from_value(request["workspace"].clone())?;
                let launch = if request["op"] == "terminal.launch" {
                    let launch: ade_runtime::terminal_launch::Launch =
                        serde_json::from_value(request["launch"].clone())?;
                    launch.validate()?;
                    Some(launch)
                } else {
                    None
                };
                let key = request["terminal_key"]
                    .as_str()
                    .unwrap_or(&workspace.id)
                    .to_owned();
                if request["op"] == "terminal.restart" {
                    if let Some(terminal) = data.terminals.get(&key) {
                        ensure!(
                            terminal.launch.is_none(),
                            "Return this Conversation from its terminal before restarting"
                        );
                        ensure!(
                            terminal.runtime.metrics()["shell_running"] != true,
                            "Exit the current shell before starting a new one"
                        );
                    }
                    data.terminals.remove(&key);
                    for (id, stream, admitted) in data.owner.as_ref().unwrap().streams.values() {
                        if id == &key {
                            admitted.store(false, Ordering::Release);
                            let _ = stream.shutdown(std::net::Shutdown::Both);
                        }
                    }
                }
                if let Some(terminal) = data.terminals.get(&key) {
                    ensure!(
                        launch.is_none() || terminal.launch == launch,
                        "Terminal transfer identity changed"
                    );
                    ensure!(
                        terminal.workspace.root == workspace.root
                            && terminal.workspace.terminal_id == workspace.terminal_id,
                        "Terminal identity does not match the durable workspace"
                    );
                    terminal.runtime.set_session_subscribers(
                        request["session_subscribers"].as_u64().unwrap_or(0) as usize,
                    );
                    return Ok(json!({"type":"ack","metrics":terminal.runtime.metrics()}));
                }
                ensure!(
                    request["existing_only"] != true,
                    "Managed terminal is unavailable; start its service or return its Conversation to the GUI"
                );
                ensure!(
                    data.terminals.len() < 64,
                    "Limit of 64 workspace terminals reached"
                );
                ensure!(
                    std::path::Path::new(&workspace.root).is_dir(),
                    "Workspace directory is unavailable"
                );
                let terminal = Terminal {
                    runtime: Arc::new(terminal_host::spawn_runtime(
                        &workspace,
                        launch.as_ref(),
                        &self.directory,
                    )?),
                    launch,
                    workspace,
                };
                let metrics = terminal.runtime.metrics();
                data.terminals.insert(key, terminal);
                Ok(json!({"type":"ack","metrics":metrics}))
            }
            "owner.check" => {
                ensure!(
                    !data.owner.as_ref().unwrap().draining,
                    "Runtime handoff is still in progress"
                );
                Ok(json!({"type":"ack"}))
            }
            "owner.prepare" => {
                data.owner.as_mut().unwrap().draining = true;
                let handoff = data.handoff.get_or_insert_with(|| Handoff {
                    ticket: uuid::Uuid::new_v4().to_string(),
                    expires: now_ms() + 30_000,
                });
                ensure!(
                    handoff.expires > now_ms(),
                    "Handoff expired; abort it before retrying"
                );
                Ok(
                    json!({"type":"handoff","instance_id":self.instance,"ticket":handoff.ticket,"expires_at":handoff.expires}),
                )
            }
            "owner.abort" => {
                data.handoff = None;
                data.owner.as_mut().unwrap().draining = false;
                Ok(json!({"type":"ack"}))
            }
            _ => anyhow::bail!("Unknown runtime control operation"),
        }
    }
}
struct OwnerGuard {
    host: Arc<Host>,
    token: String,
}
impl Drop for OwnerGuard {
    fn drop(&mut self) {
        self.host.release(&self.token);
    }
}
struct StreamGuard {
    host: Arc<Host>,
    token: String,
    id: String,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        let mut data = self.host.data.lock().unwrap();
        if let Some(owner) = data.owner.as_mut().filter(|o| o.token == self.token) {
            owner.streams.remove(&self.id);
        }
    }
}
fn agent_command(host: &Host, request: &Value) -> Result<Value> {
    use ade_runtime::agent_runtime::{Run, Spec};
    let op = request["op"].as_str().unwrap_or("");
    let (run, admission) = {
        let mut data = host.data.lock().unwrap();
        let owner = data.owner.as_ref().context("No runtime owner")?;
        if request["token"] != owner.token || owner.draining {
            return Err(runtime::OwnerFenced.into());
        }
        if op == "agent.account_inspect" {
            let account: ade_core::model::AccountExecution =
                serde_json::from_value(request["account"].clone())?;
            drop(data);
            let inspection = if account.provider == "codex" {
                ade_runtime::provider::codex_probe::inspect(&account)
            } else {
                ade_runtime::provider::account_probe::inspect(&account)
            };
            return Ok(serde_json::to_value(inspection)?);
        }
        if op == "agent.list" {
            let agents: Vec<_> = data.agents.values().cloned().collect();
            drop(data);
            return Ok(
                json!({"type":"agents","agents":agents.iter().map(|r| r.describe()).collect::<Vec<_>>()}),
            );
        }
        if op == "agent.create" {
            let spec: Spec = serde_json::from_value(request["spec"].clone())?;
            ensure!(
                !spec.run.is_empty() && !spec.conversation.is_empty(),
                "Missing Agent identity"
            );
            if let Some(run) = data.agents.get(&spec.run) {
                ensure!(
                    serde_json::to_value(&run.spec)? == request["spec"],
                    "Agent identity changed"
                );
            } else {
                ensure!(
                    data.agents.len() < 16,
                    "Limit of 16 connected Agents reached"
                );
                ensure!(
                    !data
                        .agents
                        .values()
                        .any(|r| r.spec.conversation == spec.conversation),
                    "Conversation already has a live Agent"
                );
                let run = Run::spawn(spec)?;
                if ade_core::diagnostics::valid_run_id(&run.spec.run) {
                    let run_id = run.spec.run.as_str();
                    let pid = run.describe()["pid"].as_u64().unwrap_or(0);
                    tracing::info!(target: "ade", event = "agent_run_started", run_id, pid);
                }
                data.agents.insert(run.spec.run.clone(), run);
            }
            return Ok(json!({"type":"ack"}));
        }
        let id = request["run"].as_str().context("Missing Agent run")?;
        let run = data.agents.get(id).context("Unknown Agent run")?.clone();
        let admission = if op == "agent.command" {
            Some(run.admit(&request["command"])?)
        } else {
            None
        };
        (run, admission)
    };
    // Accepted operations belong to the runtime and finish even if their caller dies.
    match op {
        "agent.command" => run.perform(admission.context("Missing admitted command")?),
        "agent.connected" => run.connected(),
        "agent.events" => run.events(request["after"].as_u64().context("Missing cursor")?),
        "agent.ack" => run.acknowledge(request["cursor"].as_u64().context("Missing cursor")?),
        "agent.stop" => {
            // Keep the reservation while shutdown is pending or uncertain.
            run.stop_confirmed()?;
            let mut data = host.data.lock().unwrap();
            if data
                .agents
                .get(&run.spec.run)
                .is_some_and(|current| Arc::ptr_eq(current, &run))
            {
                data.agents.remove(&run.spec.run);
            }
            Ok(json!({"type":"ack"}))
        }
        _ => anyhow::bail!("Unknown Agent operation"),
    }
}
fn connection(mut stream: UnixStream, host: Arc<Host>) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let request = ade_runtime::agent_runtime::read(&mut reader)?;
    if request["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("agent."))
    {
        let value = agent_command(&host, &request)
            .unwrap_or_else(|e| json!({"type":"error","code":if e.is::<runtime::OwnerFenced>() { Some("owner_fenced") } else { None },"message":e.to_string()}));
        return ade_runtime::agent_runtime::write(&mut stream, &value);
    }
    ensure!(
        request.to_string().len() < runtime::MAX_CONTROL as usize,
        "Runtime control frame too large"
    );
    match request["op"].as_str().unwrap_or("") {
        "hello" => write_frame(&mut stream, &host.hello()),
        "runtime.stop" => {
            let data = host.data.lock().unwrap();
            ensure!(
                request["instance_id"] == host.instance,
                "Runtime identity changed"
            );
            ensure!(
                data.owner.is_none(),
                "Disconnect the application daemon before stopping its runtime"
            );
            ensure!(
                request["stop_active"] == true
                    || (data.agents.is_empty()
                        && !data
                            .terminals
                            .values()
                            .any(|t| t.runtime.metrics()["shell_running"] == true)),
                "Runtime still owns live terminals; explicit stop_active is required"
            );
            host.stop.store(true, Ordering::Release);
            let result = write_frame(&mut stream, &json!({"type":"ack"}));
            let _ = UnixStream::connect(runtime::socket_path(&host.directory));
            result
        }
        "owner.claim" => {
            ensure!(
                request["runtime_protocol"] == PROTOCOL,
                "Incompatible runtime protocol"
            );
            ensure!(
                request["instance_id"] == host.instance,
                "Runtime identity changed"
            );
            let token = request["token"]
                .as_str()
                .filter(|s| s.len() == 36)
                .context("Invalid owner token")?
                .to_owned();
            {
                let mut data = host.data.lock().unwrap();
                ensure!(!host.stop.load(Ordering::Acquire), "Runtime is stopping");
                ensure!(
                    data.owner.is_none(),
                    "Another application daemon owns this runtime"
                );
                if let Some(handoff) = &data.handoff
                    && handoff.expires > now_ms()
                {
                    ensure!(
                        request["ticket"].as_str() == Some(&handoff.ticket),
                        "A valid handoff ticket is required"
                    );
                }
                data.handoff = None;
                data.owner = Some(Owner {
                    token: token.clone(),
                    draining: false,
                    streams: HashMap::new(),
                });
            }
            let _guard = OwnerGuard {
                host: host.clone(),
                token: token.clone(),
            };
            write_frame(&mut stream, &json!({"type":"ack"}))?;
            // Ownership lives with this socket, not a PID (which can be reused).
            reader.get_mut().set_read_timeout(None)?;
            loop {
                let request = read_frame(&mut reader)?;
                let value = host
                    .command(&token, &request)
                    .unwrap_or_else(|e| json!({"type":"error","message":e.to_string()}));
                write_frame(&mut stream, &value)?;
            }
        }
        "terminal.connect" => {
            let token = request["token"]
                .as_str()
                .context("Missing owner token")?
                .to_owned();
            let id = uuid::Uuid::new_v4().to_string();
            let admitted = Arc::new(AtomicBool::new(true));
            let terminal = {
                let mut data = host.data.lock().unwrap();
                let owner = data
                    .owner
                    .as_mut()
                    .context("No application daemon owns this runtime")?;
                ensure!(
                    owner.token == token && !owner.draining,
                    "Terminal connection belongs to a stale or draining owner"
                );
                ensure!(owner.streams.len() < 256, "Too many terminal connections");
                let workspace = request["workspace_id"]
                    .as_str()
                    .context("Missing workspace ID")?;
                let terminal = data
                    .terminals
                    .get(workspace)
                    .context("Unknown terminal")?
                    .runtime
                    .clone();
                data.owner.as_mut().unwrap().streams.insert(
                    id.clone(),
                    (workspace.to_owned(), stream.try_clone()?, admitted.clone()),
                );
                terminal
            };
            let _guard = StreamGuard { host, token, id };
            write_frame(&mut stream, &json!({"type":"ack"}))?;
            reader.get_mut().set_read_timeout(None)?;
            let first = read_frame(&mut reader)?.to_string() + "\n";
            terminal.serve(stream, reader, first, admitted)?;
            Ok(())
        }
        _ => anyhow::bail!("Unknown runtime operation"),
    }
}
pub(super) fn serve(directory: PathBuf) -> Result<()> {
    let _lock = runtime::lock(&directory, "runtime.lock")?;
    let socket = runtime::socket_path(&directory);
    let (listener, _socket) = runtime::SocketGuard::bind(&socket)?;
    let host = Arc::new(Host {
        data: Mutex::new(State {
            owner: None,
            handoff: None,
            terminals: HashMap::new(),
            agents: HashMap::new(),
        }),
        proxies: service_proxy::Manager::open(&directory)?,
        directory,
        instance: uuid::Uuid::new_v4().to_string(),
        stop: AtomicBool::new(false),
    });
    eprintln!(
        "lux-ade runtime {} listening at {}",
        std::process::id(),
        socket.display()
    );
    while !host.stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if host.stop.load(Ordering::Acquire) {
                    break;
                }
                let host = host.clone();
                std::thread::spawn(move || {
                    let mut error_stream = stream.try_clone().ok();
                    if let Err(error) = connection(stream, host)
                        && let Some(stream) = error_stream.as_mut()
                    {
                        let _ = write_frame(
                            stream,
                            &json!({"type":"error","message":error.to_string()}),
                        );
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(e.into()),
        }
    }
    for run in host.data.lock().unwrap().agents.values() {
        run.stop();
    }
    host.proxies.shutdown();
    Ok(())
}
