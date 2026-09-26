use ade_daemon::{
    runtime::{self, Supervisor},
    sessions::Sessions,
    worktrees::Lease,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
fn error_response(error: impl Into<anyhow::Error>) -> Value {
    ade_core::error::error_envelope(error.into())
}
const MAX_REQUEST: u64 = 12 * 1024 * 1024;
struct ProbeBudget {
    active: Mutex<usize>,
    available: Condvar,
}
struct ProbePermit<'a>(&'a ProbeBudget);
impl ProbeBudget {
    fn acquire(&self) -> ProbePermit<'_> {
        let mut active = self.active.lock().unwrap();
        while *active >= 4 {
            active = self.available.wait(active).unwrap();
        }
        *active += 1;
        ProbePermit(self)
    }
}
impl Drop for ProbePermit<'_> {
    fn drop(&mut self) {
        let mut active = self.0.active.lock().unwrap();
        *active -= 1;
        self.0.available.notify_one();
    }
}
struct Host {
    socket: PathBuf,
    sessions: Arc<Sessions>,
    runtime: Arc<Supervisor>,
    default_workspace: String,
    leases: Mutex<HashMap<String, Lease>>,
    proxy_probe: ProbeBudget,
    admission: RwLock<()>,
    stopping: AtomicBool,
}
impl Host {
    fn proxy_service(&self, request: &Value) -> anyhow::Result<(String, String, String, Value)> {
        let workspace = request["workspace_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing workspace_id"))?;
        let name = request["name"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing service name"))?;
        let variable = request["port_variable"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing port variable"))?;
        let listed = self
            .sessions
            .command(&json!({"op":"service.list","workspace_id":workspace}))?;
        let service = listed["services"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .ok_or_else(|| anyhow::anyhow!("Unknown managed service"))?;
        anyhow::ensure!(
            service["ports"][variable].as_u64().is_some(),
            "Service has no configured port variable"
        );
        Ok((
            workspace.to_owned(),
            name.to_owned(),
            variable.to_owned(),
            listed,
        ))
    }

    fn proxy_ensure(&self, request: &Value) -> anyhow::Result<Value> {
        let (workspace, name, variable, listed) = self.proxy_service(request)?;
        let service = listed["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap();
        let identity = service["identity"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Service identity unavailable"))?;
        let target_port = service["ports"][&variable].as_u64().unwrap();
        let remap = request["op"] == "service.proxy.remap";
        let expected_route_identity = if remap {
            anyhow::ensure!(
                request["expected_service_identity"] == identity,
                "Service identity changed; inspect it again"
            );
            anyhow::ensure!(
                request["expected_target_port"] == target_port,
                "Service target port changed; inspect it again"
            );
            request["expected_route_identity"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Missing expected route identity"))?
        } else {
            ""
        };
        let expected_route_port = if remap {
            request["expected_route_port"]
                .as_u64()
                .filter(|port| (1..=65535).contains(port))
                .ok_or_else(|| anyhow::anyhow!("Missing expected route port"))?
        } else {
            0
        };
        self.runtime
            .command(json!({"op":"proxy.ensure","workspace_id":workspace,
            "service_name":name,"port_variable":variable,"service_identity":identity,
            "target_port":target_port,"remap":remap,
            "expected_route_identity":expected_route_identity,
            "expected_route_port":expected_route_port,
            "daemon_socket":self.socket}))
    }

    fn proxy_inspect(&self, request: &Value) -> anyhow::Result<Value> {
        let workspace = request["workspace_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing workspace_id"))?;
        let name = request["name"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing service name"))?;
        let variable = request["port_variable"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing port variable"))?;
        self.runtime
            .command(json!({"op":"proxy.inspect","workspace_id":workspace,
            "service_name":name,"port_variable":variable}))
    }

    fn proxy_retire(&self, request: &Value) -> anyhow::Result<Value> {
        let workspace = request["workspace_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing workspace_id"))?;
        let name = request["name"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing service name"))?;
        let variable = request["port_variable"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing port variable"))?;
        let route_id = request["expected_route_id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Missing expected route ID"))?;
        let identity = request["expected_service_identity"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Missing expected service identity"))?;
        let target_port = request["expected_target_port"]
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .ok_or_else(|| anyhow::anyhow!("Missing expected target port"))?;
        let proxy_port = request["expected_proxy_port"]
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .ok_or_else(|| anyhow::anyhow!("Missing expected proxy port"))?;
        self.runtime
            .command(json!({"op":"proxy.retire","workspace_id":workspace,
            "service_name":name,"port_variable":variable,"expected_route_id":route_id,
            "expected_service_identity":identity,"expected_target_port":target_port,
            "expected_proxy_port":proxy_port}))
    }

    fn proxy_target(&self, request: &Value) -> anyhow::Result<Value> {
        let (workspace, name, variable, listed) = self.proxy_service(request)?;
        anyhow::ensure!(
            listed["states"][&name]["state"] == "running",
            "Managed service is unavailable"
        );
        let service = listed["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap();
        let port = service["ports"][&variable].as_u64().unwrap();
        anyhow::ensure!(
            request["expected_port"] == port && request["service_identity"] == service["identity"],
            "Stable service proxy target changed; explicitly remap it"
        );
        let transfer = listed["states"][&name]["metrics"]["transfer_id"].clone();
        let pid = listed["states"][&name]["metrics"]["shell_pid"].clone();
        anyhow::ensure!(
            transfer.is_string() && pid.is_number(),
            "Service process identity unavailable"
        );
        let host = request["connected_host"]
            .as_str()
            .filter(|host| matches!(*host, "127.0.0.1" | "::1"))
            .ok_or_else(|| anyhow::anyhow!("Invalid connected proxy host"))?;
        let family = if host == "127.0.0.1" { "ipv4" } else { "ipv6" };
        // This observation happens after the proxy has connected but before it
        // forwards any request bytes. Bound concurrent lsof probes;
        // never reuse a positive result after the listener may have changed.
        let _probe = self.proxy_probe.acquire();
        let inventory = self.sessions.command(&json!({"op":"listener.list"}))?;
        let rows = inventory["listeners"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Listener inventory is unavailable"))?;
        let covers_loopback = |address: &str| match family {
            "ipv4" => matches!(address, "127.0.0.1" | "0.0.0.0" | "*"),
            _ => matches!(address, "::1" | "::" | "*"),
        };
        let own = rows.iter().any(|row| {
            row["family"] == family
                && row["port"] == port
                && row["pid"] == pid
                && row["workspace_id"] == workspace
                && row["service_name"] == name
                && row["address"].as_str().is_some_and(covers_loopback)
        });
        let contested = rows.iter().any(|row| {
            row["family"] == family
                && row["port"] == port
                && row["pid"] != pid
                && row["address"].as_str().is_some_and(covers_loopback)
        });
        anyhow::ensure!(
            own && !contested,
            "Service has no verified loopback listener"
        );
        drop(_probe);
        let current = self
            .sessions
            .command(&json!({"op":"service.list","workspace_id":workspace}))?;
        anyhow::ensure!(
            current["states"][&name]["state"] == "running"
                && current["states"][&name]["metrics"]["transfer_id"] == transfer
                && current["states"][&name]["metrics"]["shell_pid"] == pid
                && current["services"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| {
                        item["name"] == name
                            && item["identity"] == service["identity"]
                            && item["ports"][&variable] == port
                    })),
            "Managed service changed during proxy resolution"
        );
        Ok(
            json!({"type":"service_proxy_target","host":host,"port":port,
            "transfer_id":transfer,"pid":pid}),
        )
    }

    fn refresh_leases(&self) -> anyhow::Result<()> {
        let mut leases = self.leases.lock().unwrap();
        let state = self.runtime.command(json!({"op":"terminal.list"}))?;
        let mut live = HashSet::new();
        for terminal in state["terminals"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid terminal catalogue"))?
        {
            if terminal["metrics"]["shell_running"] != true {
                let workspace: ade_daemon::model::WorkspaceRecord =
                    serde_json::from_value(terminal["workspace"].clone())?;
                let stored = self.sessions.workspace(&workspace.id)?;
                if stored.terminal_id != workspace.terminal_id
                    && !stored.extra_terminals.contains(&workspace.terminal_id)
                {
                    self.runtime.command(json!({"op":"terminal.retire","workspace_id":workspace.id,"terminal_id":workspace.terminal_id}))?;
                }
                continue;
            }
            let workspace: ade_daemon::model::WorkspaceRecord =
                serde_json::from_value(terminal["workspace"].clone())?;
            let stored = self.sessions.workspace(&workspace.id)?;
            anyhow::ensure!(
                stored.root == workspace.root
                    && (stored.terminal_id == workspace.terminal_id
                        || stored.extra_terminals.contains(&workspace.terminal_id)),
                "Runtime terminal does not match durable workspace"
            );
            live.insert(workspace.id.clone());
            if let std::collections::hash_map::Entry::Vacant(e) = leases.entry(workspace.id) {
                e.insert(self.sessions.worktrees.lease(&workspace.root)?);
            }
        }
        leases.retain(|id, _| live.contains(id));
        Ok(())
    }
    fn ensure_terminal(
        &self,
        id: &str,
        terminal_id: Option<&str>,
        restart: bool,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!id.is_empty(), "Choose a workspace folder first");
        let mut leases = self.leases.lock().unwrap();
        let mut workspace = self.sessions.workspace(id)?;
        let key = if let Some(terminal) = terminal_id {
            anyhow::ensure!(
                terminal == workspace.terminal_id
                    || workspace.extra_terminals.iter().any(|id| id == terminal),
                "Unknown workspace terminal"
            );
            if terminal == workspace.terminal_id {
                workspace.id.clone()
            } else {
                terminal.to_owned()
            }
        } else {
            workspace.id.clone()
        };
        if let Some(terminal) = terminal_id {
            workspace.terminal_id = terminal.into();
        }
        let reserved = self.sessions.terminal_reserved(&workspace.terminal_id)?;
        anyhow::ensure!(
            !restart || !reserved,
            "Use service.start for a service terminal, or return the Conversation to the GUI"
        );
        // Acquire the worktree lease before allowing a shell to start.
        let lease = if !leases.contains_key(id) {
            Some(self.sessions.worktrees.lease(&workspace.root)?)
        } else {
            None
        };
        let result=self.runtime.command(json!({"op":if restart {"terminal.restart"}else{"terminal.ensure"},"workspace":workspace,"terminal_key":key,"existing_only":reserved,"session_subscribers":self.sessions.subscribers.load(Ordering::Relaxed)}))?;
        if result["metrics"]["shell_running"] == true
            && let Some(lease) = lease
        {
            leases.insert(id.to_owned(), lease);
        } // refresh_leases retires a lease only after every shell in the workspace exits.
        Ok(())
    }
    fn status(&self) -> anyhow::Result<Value> {
        let terminals = self.runtime.command(json!({"op":"terminal.list"}))?;
        let mut agents = self.runtime.agent(json!({"op":"agent.list"}))?;
        if let Some(runs) = agents["agents"].as_array_mut() {
            for run in runs {
                run.as_object_mut().unwrap().remove("commands");
            }
        }
        Ok(
            json!({"type":"runtime_status","application_protocol":runtime::APPLICATION_PROTOCOL,"runtime_protocol":runtime::PROTOCOL,
            "boot_id":self.sessions.boot_id,"pid":std::process::id(),"runtime_pid":self.runtime.pid,"runtime_instance":self.runtime.instance,
            "runtime_socket":self.runtime.socket,"connected_agents":self.sessions.connected_agents(),"active_git_operations":self.sessions.worktrees.active_operations(),
            "stopping":self.stopping.load(Ordering::Acquire),"terminals":terminals["terminals"],"agents":agents["agents"]}),
        )
    }
    fn terminal_lifecycle(&self, request: &Value) -> anyhow::Result<Value> {
        let _leases = self.leases.lock().unwrap();
        let workspace = request["workspace_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing workspace_id"))?;
        let terminal = request["terminal_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing terminal_id"))?;
        let stored = self.sessions.workspace(workspace)?;
        if request["op"] == "terminal.stop" {
            anyhow::ensure!(
                stored.terminal_id == terminal
                    || stored.extra_terminals.iter().any(|id| id == terminal),
                "Unknown workspace terminal"
            );
            return self.runtime.command(request.clone());
        }
        anyhow::ensure!(
            !self.sessions.terminal_reserved(terminal)?,
            "Remove its service, or return the Conversation to the GUI before retiring this terminal"
        );
        let state = self.runtime.command(json!({"op":"terminal.list"}))?;
        if let Some(entry) = state["terminals"].as_array().and_then(|items| {
            items.iter().find(|entry| {
                entry["workspace"]["id"] == workspace
                    && entry["workspace"]["terminal_id"] == terminal
            })
        }) {
            anyhow::ensure!(
                entry["metrics"]["shell_running"] != true,
                "Stop the shell before retiring its terminal"
            );
        }
        // Commit retirement before releasing runtime storage. If the daemon
        // dies between these steps, refresh_leases reaps the exited orphan.
        self.sessions.retire_terminal(workspace, terminal)?;
        self.runtime.command(request.clone())
    }
    fn prepare_restart(&self, request: &Value) -> anyhow::Result<Value> {
        let _gate = self
            .admission
            .try_write()
            .map_err(|_| anyhow::anyhow!("A command is still being admitted; retry shortly"))?;
        anyhow::ensure!(
            request["boot_id"] == self.sessions.boot_id,
            "Application daemon changed; inspect runtime.status again"
        );
        anyhow::ensure!(
            !self.stopping.load(Ordering::Acquire),
            "Application daemon is already restarting"
        );
        anyhow::ensure!(
            self.sessions.worktrees.active_operations() == 0,
            "Git or worktree operations are still running; retry after completion"
        );
        self.sessions.prepare_restart()?;
        if let Err(error) = self.runtime.prepare_handoff() {
            self.sessions.abort_restart();
            return Err(error);
        }
        self.stopping.store(true, Ordering::Release);
        Ok(
            json!({"type":"ack","boot_id":self.sessions.boot_id,"runtime_instance":self.runtime.instance}),
        )
    }
}
fn read_request(reader: &mut BufReader<UnixStream>) -> io::Result<Option<String>> {
    let mut line = String::new();
    let count = reader.by_ref().take(MAX_REQUEST).read_line(&mut line)?;
    if count == 0 {
        return Ok(None);
    }
    if !line.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Request too large",
        ));
    }
    Ok(Some(line))
}
fn handle_connection(mut stream: UnixStream, host: Arc<Host>) -> anyhow::Result<()> {
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .or_else(|error| {
            if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOTCONN)) {
                Ok(())
            } else {
                Err(error)
            }
        })?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(mut first) = read_request(&mut reader)? else {
        return Ok(());
    };
    loop {
        let request: Value = match serde_json::from_str(&first) {
            Ok(request) => request,
            Err(error) => {
                writeln!(stream, "{}", error_response(error))?;
                let Some(next) = read_request(&mut reader)? else {
                    return Ok(());
                };
                first = next;
                continue;
            }
        };
        let op = request["op"].as_str().unwrap_or("");
        let diagnostic_id = request["diagnostic_id"]
            .as_str()
            .filter(|id| ade_core::diagnostics::valid_id(id));
        let operation_family = ade_core::diagnostics::operation_family(op);
        let started = Instant::now();
        if let Some(diagnostic_id) = diagnostic_id {
            tracing::info!(target: "ade", event = "rpc_started", diagnostic_id, operation_family);
        }
        if first.len() > 128 * 1024 && op != "attachment.put" {
            writeln!(
                stream,
                "{}",
                json!({"type":"error","message":"Request exceeds 128 KiB"})
            )?;
            if let Some(diagnostic_id) = diagnostic_id {
                tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
            return Ok(());
        }
        if op == "runtime.prepare_restart" {
            let outcome = host.prepare_restart(&request);
            let event = outcome.unwrap_or_else(error_response);
            let result = writeln!(stream, "{event}");
            if let Some(diagnostic_id) = diagnostic_id {
                let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if event["type"] == "error" || result.is_err() {
                    tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
                } else {
                    tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
                }
            }
            if host.stopping.load(Ordering::Acquire) {
                let _ = UnixStream::connect(&host.socket);
            }
            result?;
            return Ok(());
        }
        if op == "runtime.status" {
            let event = host.status()?;
            writeln!(stream, "{event}")?;
            if let Some(diagnostic_id) = diagnostic_id {
                tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
            return Ok(());
        }
        let admission = host.admission.read().unwrap();
        anyhow::ensure!(
            !host.stopping.load(Ordering::Acquire),
            "Application daemon is restarting; reconnect"
        );
        if op == "session.subscribe" {
            let (id, rx) = host.sessions.subscribe()?;
            let sessions = host.sessions.clone();
            let reader_id = id.clone();
            // Dedicated event streams accept no commands. EOF removes the bounded
            // subscription even when no subsequent state change produces a write.
            std::thread::spawn(move || {
                let mut byte = [0];
                let _ = reader.read(&mut byte);
                sessions.unsubscribe(&reader_id);
            });
            drop(admission);
            while let Ok(event) = rx.recv() {
                if writeln!(stream, "{event}").is_err() {
                    break;
                }
            }
            host.sessions.unsubscribe(&id);
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return Ok(());
        }
        if op == "hello" || op.contains('.') {
            let event = if op == "hello" {
                json!({"type":"hello","build_id":std::env::var("ADE_BUILD_ID").ok(),"application_protocol":runtime::APPLICATION_PROTOCOL,"runtime_protocol":runtime::PROTOCOL,"runtime_instance":host.runtime.instance,"runtime_pid":host.runtime.pid,"runtime_socket":host.runtime.socket,"pid":std::process::id(),"session_protocol":"ade-sessions-v1","worktree_protocol":"ade-worktrees-v1","review_protocol":"ade-review-v1","response_owner":"daemon-v1","terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d","terminal_snapshot_formats":["ghostty-snapshot-v1-herdr-9c96f7d","xterm-replay-v1"],"boot_id":host.sessions.boot_id})
            } else {
                if op == "worktree.remove" {
                    host.refresh_leases()?;
                }
                match if op == "service.proxy.ensure" || op == "service.proxy.remap" {
                    host.proxy_ensure(&request)
                } else if op == "service.proxy.inspect" {
                    host.proxy_inspect(&request)
                } else if op == "service.proxy.retire" {
                    host.proxy_retire(&request)
                } else if op == "service.proxy.target" {
                    host.proxy_target(&request)
                } else if op == "terminal.stop" || op == "terminal.retire" {
                    host.terminal_lifecycle(&request)
                } else if op == "terminal.restart" {
                    host.ensure_terminal(
                        request["workspace_id"]
                            .as_str()
                            .unwrap_or(&host.default_workspace),
                        request["terminal_id"].as_str(),
                        true,
                    )
                    .map(|()| json!({"type":"ack"}))
                } else {
                    host.sessions.command(&request)
                } {
                    Ok(value) => value,
                    Err(error) => error_response(error),
                }
            };
            let write_result = writeln!(stream, "{event}");
            if let Some(diagnostic_id) = diagnostic_id {
                if let Some(run_id) = request["conversation_id"]
                    .as_str()
                    .and_then(|id| host.sessions.diagnostic_run(id))
                {
                    tracing::info!(target: "ade", event = "rpc_run", diagnostic_id, run_id);
                }
                let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if event["type"] == "error" || write_result.is_err() {
                    tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
                } else {
                    tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
                }
            }
            write_result?;
            drop(admission);
            let Some(next) = read_request(&mut reader)? else {
                return Ok(());
            };
            first = next;
            continue;
        }
        let id = request["workspace_id"]
            .as_str()
            .unwrap_or(&host.default_workspace);
        if let Err(error) = host.ensure_terminal(id, request["terminal_id"].as_str(), false) {
            writeln!(stream, "{}", error_response(error))?;
            return Ok(());
        }
        let workspace = host.sessions.workspace(id)?;
        let key = request["terminal_id"]
            .as_str()
            .filter(|t| *t != workspace.terminal_id)
            .unwrap_or(id);
        let mut upstream = host.runtime.terminal(key)?;
        upstream.write_all(first.as_bytes())?;
        drop(admission);
        // Copy bytes without parsing terminal output a second time. Both directions
        // are bounded by Unix socket buffers; slow viewers are evicted upstream.
        let mut input = upstream.try_clone()?;
        std::thread::spawn(move || {
            let _ = io::copy(&mut reader, &mut input);
            let _ = input.shutdown(std::net::Shutdown::Write);
        });
        let result = io::copy(&mut upstream, &mut stream);
        let _ = upstream.shutdown(std::net::Shutdown::Both);
        let _ = stream.shutdown(std::net::Shutdown::Both);
        result?;
        return Ok(());
    }
}
pub(super) fn serve(socket: String, directory: PathBuf) -> anyhow::Result<()> {
    // Lock the original directory before recovery or supervisor ownership changes.
    let _writer = runtime::lock(&directory, "writer.lock")?;
    let directory = std::fs::canonicalize(directory)?;
    anyhow::ensure!(
        UnixStream::connect(&socket).is_err(),
        "A daemon is already listening at {socket}"
    );
    let runtime = Arc::new(Supervisor::connect(&directory)?);
    let sessions = Sessions::open(&directory.join("sessions.sqlite"), runtime.clone())?;
    for name in [
        "sessions.sqlite",
        "sessions.sqlite-wal",
        "sessions.sqlite-shm",
    ] {
        let path = directory.join(name);
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    // Installed launches restore the catalogue, or wait for workspace.open.
    // They must never turn the app bundle or Finder's cwd into an editable project.
    let selection = std::env::var_os("ADE_ROOT").is_none()
        && std::env::var("ADE_WORKSPACE_SELECTION").as_deref() == Ok("1");
    let default_workspace = if selection {
        let catalog = sessions.command(&json!({"op":"catalog.get"}))?;
        catalog["catalog"]["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|workspace| {
                let path = Path::new(workspace["root"].as_str().unwrap_or_default());
                !(path.file_name().is_some_and(|name| name == "Resources")
                    && path.parent().is_some_and(|parent| {
                        parent.file_name().is_some_and(|name| name == "Contents")
                    }))
            })
            .and_then(|workspace| workspace["id"].as_str())
            .unwrap_or_default()
            .to_owned()
    } else {
        let root = std::env::var("ADE_ROOT")
            .unwrap_or(std::env::current_dir()?.to_string_lossy().into_owned());
        sessions.open_workspace(&root)?.id
    };

    let host = Arc::new(Host {
        socket: PathBuf::from(&socket),
        sessions,
        runtime,
        default_workspace,
        leases: Mutex::new(HashMap::new()),
        proxy_probe: ProbeBudget {
            active: Mutex::new(0),
            available: Condvar::new(),
        },
        admission: RwLock::new(()),
        stopping: AtomicBool::new(false),
    });
    host.refresh_leases()?;
    if !selection {
        host.ensure_terminal(&host.default_workspace, None, false)?;
    }
    let (listener, _socket) = runtime::SocketGuard::bind(Path::new(&socket))?;
    eprintln!(
        "lux-ade daemon {} listening at {socket}; runtime {}; durable state {}",
        std::process::id(),
        host.runtime.pid,
        directory.display()
    );
    while !host.stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if host.stopping.load(Ordering::Acquire) {
                    break;
                }
                let host = host.clone();
                std::thread::spawn(move || {
                    let mut errors = stream.try_clone().ok();
                    if let Err(error) = handle_connection(stream, host)
                        && let Some(stream) = errors.as_mut()
                    {
                        let _ = writeln!(stream, "{}", error_response(error));
                    }
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(e.into()),
        }
    }
    // Returning ends remaining observer threads. No provider or Git worker may be
    // live in this process at this point; the supervisor retains providers and shells.
    Ok(())
}

#[cfg(test)]
mod error_envelope_tests {
    use super::*;
    #[test]
    fn classified_errors_have_stable_recovery_and_drop_sensitive_context() {
        let error = anyhow::Error::new(ade_core::error::Failure::Authentication)
            .context("provider payload secret");
        let response = error_response(error);
        assert_eq!(response["code"], "authentication");
        assert_eq!(response["recovery"], "sign_in");
        assert!(!response.to_string().contains("secret"));
        let response = error_response(ade_core::error::TransportError::OutcomeUnknown);
        assert_eq!(response["code"], "outcome_unknown");
        assert_eq!(response["recovery"], "reconnect_and_reconcile");
    }
    #[test]
    fn unclassified_validation_errors_preserve_compatible_shape() {
        assert_eq!(
            error_response(anyhow::anyhow!("Invalid draft revision")),
            json!({"type":"error","message":"Invalid draft revision"})
        );
    }
}
