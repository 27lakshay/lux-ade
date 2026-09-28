//! Stable owner of PTYs, parser state and provider processes. This process never
//! opens the application database or executes worktree lifecycle requests.
use super::{service_proxy, terminal_host};
use ade_core::runtime_protocol::{
    self as protocol, AgentOp, AgentRequest, Connect, Control, Owner as OwnerCommand, Proxy,
    terminal::{self, Command as TerminalCommand},
};
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
    /// Agents reserved by `agent.create` whose launch is still running.
    starting: HashMap<String, Starting>,
}
struct Starting {
    conversation: String,
    spec: Value,
}
struct Host {
    data: Mutex<State>,
    proxies: service_proxy::Manager,
    directory: PathBuf,
    instance: String,
    stop: AtomicBool,
}
impl Host {
    fn hello(&self) -> Result<Value> {
        let directory = self
            .directory
            .to_str()
            .context("Runtime data directory is not UTF-8")?;
        Ok(serde_json::to_value(protocol::Hello {
            tag: Default::default(),
            runtime_protocol: PROTOCOL.into(),
            build_id: std::env::var("ADE_RUNTIME_BUILD_ID").ok(),
            pid: std::process::id(),
            instance_id: self.instance.clone(),
            data_directory: directory.into(),
        })?)
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
        // The state lock is held for the whole command, as before typing.
        let mut data = self.data.lock().unwrap();
        ensure!(
            data.owner.as_ref().is_some_and(|o| o.token == token),
            "Runtime owner changed"
        );
        match protocol::decode::<Control>(request).map_err(anyhow::Error::msg)? {
            Control::Proxy(command) => self.proxy(command),
            Control::Terminal(command) => self.terminal(&mut data, command),
            Control::Owner(OwnerCommand::Check) => {
                ensure!(
                    !data.owner.as_ref().unwrap().draining,
                    "Runtime handoff is still in progress"
                );
                Ok(json!({"type":"ack"}))
            }
            Control::Owner(OwnerCommand::Prepare) => {
                data.owner.as_mut().unwrap().draining = true;
                let handoff = data.handoff.get_or_insert_with(|| Handoff {
                    ticket: uuid::Uuid::new_v4().to_string(),
                    expires: now_ms() + 30_000,
                });
                ensure!(
                    handoff.expires > now_ms(),
                    "Handoff expired; abort it before retrying"
                );
                Ok(serde_json::to_value(protocol::Handoff {
                    tag: Default::default(),
                    instance_id: self.instance.clone(),
                    ticket: handoff.ticket.clone(),
                    expires_at: handoff.expires,
                })?)
            }
            Control::Owner(OwnerCommand::Abort) => {
                data.handoff = None;
                data.owner.as_mut().unwrap().draining = false;
                Ok(json!({"type":"ack"}))
            }
        }
    }
    fn proxy(&self, command: Proxy) -> Result<Value> {
        match command {
            Proxy::Ensure(ensure) => self.proxies.ensure(
                &ensure.target.workspace_id,
                &ensure.target.service_name,
                &ensure.target.port_variable,
                &ensure.service_identity,
                ensure.target_port,
                ensure.remap,
                &ensure.expected_route_identity,
                ensure.expected_route_port,
                std::path::Path::new(&ensure.daemon_socket),
            ),
            Proxy::Inspect(target) => self.proxies.inspect(
                &target.workspace_id,
                &target.service_name,
                &target.port_variable,
            ),
            Proxy::Retire(route) => self.proxies.retire(
                &route.target.workspace_id,
                &route.target.service_name,
                &route.target.port_variable,
                &route.expected_route_id,
                &route.expected_service_identity,
                route.expected_target_port,
                route.expected_proxy_port,
            ),
            Proxy::RecoveryInspect => Ok(self.proxies.recovery_inspect()),
            Proxy::RecoveryRetry(retry) => self.proxies.recovery_retry(
                &retry.route.target.workspace_id,
                &retry.route.target.service_name,
                &retry.route.target.port_variable,
                &retry.route.expected_route_id,
                &retry.route.expected_service_identity,
                retry.route.expected_target_port,
                retry.route.expected_proxy_port,
                std::path::Path::new(&retry.daemon_socket),
            ),
            Proxy::RecoveryReset {
                expected_registry_sha256,
            } => self.proxies.recovery_reset(&expected_registry_sha256),
        }
    }
    fn terminal(&self, data: &mut State, command: TerminalCommand) -> Result<Value> {
        match command {
            TerminalCommand::List => Ok(
                json!({"type":"terminals","terminals":data.terminals.values().map(|t|json!({"workspace":t.workspace,"metrics":t.runtime.metrics(),"activity":t.runtime.activity()})).collect::<Vec<_>>()}),
            ),
            TerminalCommand::Tail {
                workspace_id,
                terminal_id,
                limit_bytes,
            } => {
                ensure!(
                    (1..=32768).contains(&limit_bytes),
                    "Tail limit must be 1 to 32768 bytes"
                );
                let terminal = data
                    .terminals
                    .values()
                    .find(|terminal| {
                        terminal.workspace.id == workspace_id
                            && terminal.workspace.terminal_id == terminal_id
                    })
                    .context("Service terminal is unavailable")?;
                Ok(terminal.runtime.tail(limit_bytes as usize))
            }
            TerminalCommand::Stop {
                workspace_id,
                terminal_id,
                if_idle,
            } => self.stop_terminal(data, &workspace_id, &terminal_id, false, if_idle),
            TerminalCommand::Retire {
                workspace_id,
                terminal_id,
            } => self.stop_terminal(data, &workspace_id, &terminal_id, true, false),
            TerminalCommand::Ensure(ensure) => self.start_terminal(data, ensure, None, false),
            TerminalCommand::Restart(ensure) => self.start_terminal(data, ensure, None, true),
            TerminalCommand::Launch {
                workspace,
                terminal_key,
                launch,
                session_subscribers,
            } => {
                launch.validate()?;
                let ensure = terminal::Ensure {
                    workspace,
                    terminal_key,
                    existing_only: false,
                    session_subscribers,
                };
                self.start_terminal(data, ensure, Some(launch), false)
            }
        }
    }
    /// `terminal.stop` stops the shell; `terminal.retire` removes a stopped
    /// terminal and its service log.
    fn stop_terminal(
        &self,
        data: &mut State,
        workspace_id: &str,
        terminal_id: &str,
        retire: bool,
        if_idle: bool,
    ) -> Result<Value> {
        ensure!(
            !data.owner.as_ref().unwrap().draining,
            "Runtime handoff is in progress"
        );
        let key = data
            .terminals
            .iter()
            .find(|(_, terminal)| {
                terminal.workspace.id == workspace_id
                    && terminal.workspace.terminal_id == terminal_id
            })
            .map(|(key, _)| key.clone());
        if let Some(key) = key {
            let terminal = &data.terminals[&key];
            if !retire {
                terminal.runtime.stop(if_idle)?;
            } else {
                ensure!(
                    terminal.runtime.metrics()["shell_running"] != true,
                    "Stop the shell before retiring its terminal"
                );
                for (id, stream, admitted) in data.owner.as_ref().unwrap().streams.values() {
                    if id == &key {
                        admitted.store(false, Ordering::Release);
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                }
                data.terminals.remove(&key);
            }
        }
        if retire {
            ade_runtime::service_logs::remove(&self.directory, workspace_id, terminal_id)?;
        }
        Ok(json!({"type":"ack"}))
    }
    /// `terminal.ensure`, `terminal.restart` and `terminal.launch`.
    fn start_terminal(
        &self,
        data: &mut State,
        ensure: terminal::Ensure,
        launch: Option<ade_runtime::terminal_launch::Launch>,
        restart: bool,
    ) -> Result<Value> {
        ensure!(
            !data.owner.as_ref().unwrap().draining,
            "Runtime handoff is in progress"
        );
        let terminal::Ensure {
            workspace,
            terminal_key,
            existing_only,
            session_subscribers,
        } = ensure;
        let key = terminal_key.unwrap_or_else(|| workspace.id.clone());
        if restart {
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
            terminal
                .runtime
                .set_session_subscribers(session_subscribers);
            return Ok(json!({"type":"ack","metrics":terminal.runtime.metrics()}));
        }
        ensure!(
            !existing_only,
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
/// Frees an Agent reservation whose launch unwound without settling it.
struct StartingGuard<'a> {
    host: &'a Host,
    run: Option<String>,
}
impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        if let Some(run) = self.run.take() {
            self.host.data.lock().unwrap().starting.remove(&run);
        }
    }
}
/// One live or starting Agent, as `agent.create` admission sees it.
struct AgentSlot {
    run: String,
    conversation: String,
    spec: Value,
    starting: bool,
}
#[derive(Debug, PartialEq, Eq)]
enum CreateAdmission {
    /// The same Agent already runs.
    Existing,
    /// The same Agent is being launched by another request; wait for it.
    Starting,
    /// Reserve the run and launch it.
    Spawn,
}
fn agent_slots(data: &State) -> Result<Vec<AgentSlot>> {
    let mut slots = Vec::new();
    for run in data.agents.values() {
        slots.push(AgentSlot {
            run: run.spec.run.clone(),
            conversation: run.spec.conversation.clone(),
            spec: serde_json::to_value(&run.spec)?,
            starting: false,
        });
    }
    for (run, starting) in &data.starting {
        slots.push(AgentSlot {
            run: run.clone(),
            conversation: starting.conversation.clone(),
            spec: starting.spec.clone(),
            starting: true,
        });
    }
    Ok(slots)
}
/// Decides an `agent.create`. A starting Agent counts like a live one, so the
/// limit and the one-Agent-per-Conversation rule hold while launches run
/// outside the state lock.
fn admit_create(
    raw: &Value,
    run: &str,
    conversation: &str,
    slots: &[AgentSlot],
) -> Result<CreateAdmission> {
    if let Some(slot) = slots.iter().find(|slot| slot.run == run) {
        ensure!(slot.spec == *raw, "Agent identity changed");
        return Ok(if slot.starting {
            CreateAdmission::Starting
        } else {
            CreateAdmission::Existing
        });
    }
    ensure!(slots.len() < 16, "Limit of 16 connected Agents reached");
    ensure!(
        !slots.iter().any(|slot| slot.conversation == conversation),
        "Conversation already has a live Agent"
    );
    Ok(CreateAdmission::Spawn)
}
fn agent_command(host: &Host, request: &Value) -> Result<Value> {
    use ade_core::contract::agents::{AgentAccountInspection, AgentList, AgentRun};
    use ade_runtime::agent_runtime::{Run, Spec};
    let AgentRequest { token, op } = protocol::decode(request).map_err(anyhow::Error::msg)?;
    let (run, admission) = {
        let mut data = host.data.lock().unwrap();
        let owner = data.owner.as_ref().context("No runtime owner")?;
        if token != owner.token || owner.draining {
            return Err(runtime::OwnerFenced.into());
        }
        match &op {
            AgentOp::AccountInspect { account } => {
                let account: ade_core::model::AccountExecution =
                    serde_json::from_value(account.clone())?;
                drop(data);
                let inspection = if account.provider == "omp" {
                    ade_runtime::provider::omp_probe::inspect(&account)
                } else if account.provider == "codex" {
                    ade_runtime::provider::codex_probe::inspect(&account)
                } else {
                    ade_runtime::provider::account_probe::inspect(&account)
                };
                return Ok(serde_json::to_value(AgentAccountInspection {
                    state: inspection.state,
                    reason: inspection.reason,
                    version: inspection.version,
                    identity: inspection.identity,
                })?);
            }
            AgentOp::List => {
                let agents: Vec<_> = data.agents.values().cloned().collect();
                drop(data);
                let agents = agents
                    .iter()
                    .map(|r| serde_json::from_value::<AgentRun>(r.describe()))
                    .collect::<Result<_, _>>()?;
                return Ok(serde_json::to_value(AgentList {
                    tag: Default::default(),
                    agents,
                })?);
            }
            AgentOp::Create { spec: raw } => {
                let spec: Spec = serde_json::from_value(raw.clone())?;
                ensure!(
                    !spec.run.is_empty() && !spec.conversation.is_empty(),
                    "Missing Agent identity"
                );
                // Admit under the lock, but launch without it: a provider
                // launch probes the CLI for seconds, and every owner command
                // waits on this lock.
                loop {
                    let slots = agent_slots(&data)?;
                    match admit_create(raw, &spec.run, &spec.conversation, &slots)? {
                        CreateAdmission::Existing => return Ok(json!({"type":"ack"})),
                        CreateAdmission::Spawn => break,
                        CreateAdmission::Starting => {
                            drop(data);
                            std::thread::sleep(Duration::from_millis(25));
                            data = host.data.lock().unwrap();
                            let owner = data.owner.as_ref().context("No runtime owner")?;
                            if token != owner.token || owner.draining {
                                return Err(runtime::OwnerFenced.into());
                            }
                        }
                    }
                }
                data.starting.insert(
                    spec.run.clone(),
                    Starting {
                        conversation: spec.conversation.clone(),
                        spec: serde_json::to_value(&spec)?,
                    },
                );
                drop(data);
                let mut reservation = StartingGuard {
                    host,
                    run: Some(spec.run.clone()),
                };
                let launched = Run::spawn(spec);
                let mut data = host.data.lock().unwrap();
                if let Some(id) = reservation.run.take() {
                    data.starting.remove(&id);
                }
                let run = launched?;
                if host.stop.load(Ordering::Acquire) {
                    drop(data);
                    run.stop();
                    anyhow::bail!("Runtime stopped while the Agent was starting");
                }
                if ade_core::diagnostics::valid_run_id(&run.spec.run) {
                    let run_id = run.spec.run.as_str();
                    let pid = run.describe()["pid"].as_u64().unwrap_or(0);
                    tracing::info!(target: "ade", event = "agent_run_started", run_id, pid);
                }
                data.agents.insert(run.spec.run.clone(), run);
                return Ok(json!({"type":"ack"}));
            }
            _ => (),
        }
        let id = op.run().context("Missing Agent run")?;
        let run = data.agents.get(id).context("Unknown Agent run")?.clone();
        let admission = if let AgentOp::Command { command, .. } = &op {
            Some(run.admit(command)?)
        } else {
            None
        };
        (run, admission)
    };
    // Accepted operations belong to the runtime and finish even if their caller dies.
    match op {
        AgentOp::Command { .. } => run.perform(admission.context("Missing admitted command")?),
        AgentOp::Connected { .. } => run.connected(),
        AgentOp::Events { after, .. } => run.events(after),
        AgentOp::Ack { cursor, .. } => run.acknowledge(cursor),
        AgentOp::Stop { .. } => {
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
        AgentOp::AccountInspect { .. } | AgentOp::List | AgentOp::Create { .. } => {
            unreachable!("answered above")
        }
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
        let value = agent_command(&host, &request).unwrap_or_else(|e| {
            let fenced = e.is::<runtime::OwnerFenced>();
            serde_json::to_value(protocol::AgentError {
                tag: Default::default(),
                code: fenced.then(|| protocol::OWNER_FENCED.to_owned()),
                message: e.to_string(),
            })
            .expect("agent errors serialize")
        });
        return ade_runtime::agent_runtime::write(&mut stream, &value);
    }
    ensure!(
        request.to_string().len() < runtime::MAX_CONTROL as usize,
        "Runtime control frame too large"
    );
    match protocol::decode::<Connect>(&request).map_err(anyhow::Error::msg)? {
        Connect::Hello => write_frame(&mut stream, &host.hello()?),
        Connect::Stop(stop) => {
            let data = host.data.lock().unwrap();
            ensure!(
                stop.instance_id == host.instance,
                "Runtime identity changed"
            );
            ensure!(
                data.owner.is_none(),
                "Disconnect the application daemon before stopping its runtime"
            );
            ensure!(
                stop.stop_active
                    || (data.agents.is_empty()
                        && data.starting.is_empty()
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
        Connect::Claim(claim) => {
            ensure!(
                claim.runtime_protocol == PROTOCOL,
                "Incompatible runtime protocol"
            );
            ensure!(
                claim.instance_id == host.instance,
                "Runtime identity changed"
            );
            ensure!(claim.token.len() == 36, "Invalid owner token");
            let token = claim.token;
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
                        claim.ticket.as_deref() == Some(handoff.ticket.as_str()),
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
                let value = host.command(&token, &request).unwrap_or_else(|e| {
                    serde_json::to_value(protocol::Error::new(e.to_string()))
                        .expect("errors serialize")
                });
                write_frame(&mut stream, &value)?;
            }
        }
        Connect::TerminalConnect(connect) => {
            let token = connect.token;
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
                let workspace = connect.workspace_id.as_str();
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
            starting: HashMap::new(),
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
                // Owner tokens fence daemons; the peer check keeps other users out (F083).
                if let Err(error) =
                    runtime::authenticate_peer(&stream, "ADE_E2E_RUNTIME_PEER_UID_FILE")
                {
                    runtime::refuse_peer(
                        stream,
                        serde_json::to_value(protocol::Error::new(error.to_string()))
                            .expect("errors serialize"),
                    );
                    continue;
                }
                let host = host.clone();
                std::thread::spawn(move || {
                    let mut error_stream = stream.try_clone().ok();
                    if let Err(error) = connection(stream, host)
                        && let Some(stream) = error_stream.as_mut()
                    {
                        let _ = write_frame(
                            stream,
                            &serde_json::to_value(protocol::Error::new(error.to_string()))
                                .expect("errors serialize"),
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

#[cfg(test)]
mod tests {
    use super::*;
    fn slot(run: &str, conversation: &str, starting: bool) -> AgentSlot {
        AgentSlot {
            run: run.into(),
            conversation: conversation.into(),
            spec: json!({"run": run, "conversation": conversation}),
            starting,
        }
    }
    #[test]
    fn a_starting_agent_blocks_duplicates_but_not_unrelated_creates() {
        // One Conversation's launch is probing its CLI outside the lock.
        let slots = [slot("run-a", "conversation-a", true)];
        // A second queued Conversation is admitted at once, not after the probe.
        let other = json!({"run": "run-b", "conversation": "conversation-b"});
        assert_eq!(
            admit_create(&other, "run-b", "conversation-b", &slots).unwrap(),
            CreateAdmission::Spawn
        );
        // A retry of the same create waits for the launch instead of spawning twice.
        let same = json!({"run": "run-a", "conversation": "conversation-a"});
        assert_eq!(
            admit_create(&same, "run-a", "conversation-a", &slots).unwrap(),
            CreateAdmission::Starting
        );
        // A second run for the starting Conversation is refused.
        let rival = json!({"run": "run-c", "conversation": "conversation-a"});
        assert!(admit_create(&rival, "run-c", "conversation-a", &slots).is_err());
        // A changed spec for the same run is refused.
        let changed = json!({"run": "run-a", "conversation": "conversation-z"});
        assert!(admit_create(&changed, "run-a", "conversation-z", &slots).is_err());
    }
    #[test]
    fn starting_agents_count_toward_the_limit() {
        let slots: Vec<_> = (0..16)
            .map(|i| slot(&format!("run-{i}"), &format!("c-{i}"), i % 2 == 0))
            .collect();
        let next = json!({"run": "run-16", "conversation": "c-16"});
        assert!(admit_create(&next, "run-16", "c-16", &slots).is_err());
        let live = [slot("run-a", "conversation-a", false)];
        let same = json!({"run": "run-a", "conversation": "conversation-a"});
        assert_eq!(
            admit_create(&same, "run-a", "conversation-a", &live).unwrap(),
            CreateAdmission::Existing
        );
    }
}
