//! Daemon-owned durable Conversations attached to supervisor-owned Agent processes.
//! Identity follows Paseo; interrupted execution follows opencode's write-ahead
//! claim; provider protocol handling follows T3 Code. Windows never author process state.
use crate::listeners;
use crate::services::{Service, ServiceExt};
use crate::{
    agent_runtime::{Envelope, Remote, Spec},
    model::*,
    provider::{self, Event, Provider},
    runtime::Supervisor,
    store::Store,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::unix::fs::MetadataExt,
    path::Path,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};

struct HealthCheck {
    port_variable: String,
    path: String,
    timeout: std::time::Duration,
}
impl From<&ade_core::services::HealthPolicy> for HealthCheck {
    fn from(policy: &ade_core::services::HealthPolicy) -> Self {
        Self {
            port_variable: policy.port_variable.clone(),
            path: policy.path.clone(),
            timeout: std::time::Duration::from_millis(policy.timeout_ms),
        }
    }
}

impl HealthCheck {
    fn parse(value: &Value) -> Result<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        let fields = value.as_object().context("Invalid HTTP health check")?;
        ensure!(
            fields
                .keys()
                .all(|key| matches!(key.as_str(), "port_variable" | "path" | "timeout_ms")),
            "Unknown HTTP health check field"
        );
        let port_variable = fields
            .get("port_variable")
            .and_then(Value::as_str)
            .context("Missing HTTP health port variable")?;
        ensure!(
            !port_variable.is_empty() && port_variable.len() <= 64,
            "Invalid HTTP health port variable"
        );
        let path = fields
            .get("path")
            .and_then(Value::as_str)
            .context("Missing HTTP health path")?;
        ensure!(
            path.starts_with('/')
                && path.len() <= 1024
                && path
                    .bytes()
                    .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'#'),
            "HTTP health path must be a visible ASCII path of at most 1024 bytes"
        );
        let timeout_ms = fields
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .context("Missing HTTP health timeout")?;
        ensure!(
            (50..=2000).contains(&timeout_ms),
            "HTTP health timeout must be 50 to 2000 ms"
        );
        Ok(Some(Self {
            port_variable: port_variable.to_owned(),
            path: path.to_owned(),
            timeout: std::time::Duration::from_millis(timeout_ms),
        }))
    }

    fn probe(&self, port: u16) -> Value {
        // This deadline bounds the HTTP socket exchange. Runtime inspection and
        // listener discovery are separate parts of the service.inspect request.
        let deadline = std::time::Instant::now() + self.timeout;
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let result = (|| -> std::io::Result<u16> {
            let mut stream = TcpStream::connect_timeout(&address, self.timeout)?;
            let request = format!(
                "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                self.path
            );
            let mut pending = request.as_bytes();
            while !pending.is_empty() {
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .ok_or(std::io::ErrorKind::TimedOut)?;
                stream.set_write_timeout(Some(remaining))?;
                let written = stream.write(pending)?;
                if written == 0 {
                    return Err(std::io::ErrorKind::WriteZero.into());
                }
                pending = &pending[written..];
            }
            let mut line = Vec::new();
            loop {
                if line.len() >= 1024 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "HTTP status line exceeds 1024 bytes",
                    ));
                }
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .ok_or(std::io::ErrorKind::TimedOut)?;
                stream.set_read_timeout(Some(remaining))?;
                let mut byte = [0];
                if stream.read(&mut byte)? == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            let line = std::str::from_utf8(&line).map_err(|_| std::io::ErrorKind::InvalidData)?;
            let mut parts = line.trim_end().split(' ');
            let version = parts.next().unwrap_or("");
            let status = parts.next().unwrap_or("");
            if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
                || status.len() != 3
                || !status.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            status
                .parse()
                .map_err(|_| std::io::ErrorKind::InvalidData.into())
        })();
        match result {
            Ok(status) => {
                json!({"state":if (200..300).contains(&status) {"healthy"} else {"unhealthy"},
                "basis":"http_status","status_code":status})
            }
            Err(error) => {
                json!({"state":if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) {"timeout"} else {"error"},
                "basis":"http_probe","error":error.to_string()})
            }
        }
    }
}

struct Agent {
    run_id: String,
    rpc: Option<Arc<dyn Provider>>,
    submission: Option<String>,
    account_generation: Option<u64>,
    _lease: crate::worktrees::Lease,
}
struct HealthSample {
    result: Value,
    revision: i64,
    transfer_id: String,
    sampled_at_ms: i64,
    sampled_at: std::time::Instant,
    started_at: std::time::Instant,
}
struct HealthAttempt {
    revision: i64,
    transfer_id: String,
    attempted_at: std::time::Instant,
}
#[derive(Clone)]
struct PeerTarget {
    variable: String,
    port_variable: String,
    service: Service,
}
struct Data {
    draining: bool,
    store: Store,
    agents: HashMap<String, Agent>,
    terminal_leases: HashMap<String, crate::worktrees::Lease>,
    stopping_services: HashSet<(String, String)>,
    health_samples: HashMap<(String, String), HealthSample>,
    health_attempts: HashMap<(String, String), HealthAttempt>,
    active_health_samples: usize,
    subscribers: HashMap<String, mpsc::SyncSender<Value>>,
    revision: u64,
}
struct ServiceStopGuard<'a> {
    sessions: &'a Sessions,
    key: (String, String),
}
impl Drop for ServiceStopGuard<'_> {
    fn drop(&mut self) {
        self.sessions
            .data
            .lock()
            .unwrap()
            .stopping_services
            .remove(&self.key);
    }
}
struct HealthSampleGuard<'a>(&'a Sessions);
impl Drop for HealthSampleGuard<'_> {
    fn drop(&mut self) {
        self.0.data.lock().unwrap().active_health_samples -= 1;
    }
}
pub struct Sessions {
    pub review: Arc<crate::review::Review>,
    pub worktrees: Arc<crate::worktrees::Worktrees>,
    files: crate::files::Files,
    data: Mutex<Data>,
    pub subscribers: Arc<AtomicUsize>,
    pub boot_id: String,
    runtime: Arc<Supervisor>,
    queue_wake: mpsc::SyncSender<()>,
}
#[derive(PartialEq, Eq)]
struct SelectedBinding {
    root: String,
    common: Option<String>,
    root_identity: (u64, u64),
    common_identity: Option<(u64, u64)>,
}
fn e2e_rebind_exit(point: &str) {
    if std::env::var("ADE_E2E_REBIND_FAILPOINT").as_deref() == Ok(point) {
        std::process::exit(93);
    }
}
fn selected_binding(path: &str, require_git: bool) -> Result<SelectedBinding> {
    let root = std::fs::canonicalize(path).context("Selected directory is unavailable")?;
    ensure!(root.is_dir(), "Selected path must be a directory");
    let metadata = std::fs::metadata(&root)?;
    let root_text = root.to_str().context("Selected path must be UTF-8")?;
    let common = crate::worktrees::git(
        root_text,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .ok()
    .and_then(|value| std::fs::canonicalize(value).ok());
    let common_metadata = common.as_ref().map(std::fs::metadata).transpose()?;
    if require_git {
        ensure!(
            common.is_some(),
            "Selected directory must belong to a Git repository"
        );
    }
    let verified = std::fs::canonicalize(path)?;
    let after = std::fs::metadata(&verified)?;
    ensure!(
        verified == root && after.dev() == metadata.dev() && after.ino() == metadata.ino(),
        "Selected directory changed during rebind"
    );
    if let Some(expected) = &common {
        let current = crate::worktrees::git(
            root_text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        ensure!(
            std::fs::canonicalize(current)? == *expected,
            "Git common directory changed during rebind"
        );
        let current_metadata = std::fs::metadata(expected)?;
        let original = common_metadata
            .as_ref()
            .context("Git common directory is unavailable")?;
        ensure!(
            current_metadata.dev() == original.dev() && current_metadata.ino() == original.ino(),
            "Git common directory changed during rebind"
        );
    }
    Ok(SelectedBinding {
        root: root_text.into(),
        common: common.map(|value| value.to_string_lossy().into_owned()),
        root_identity: (metadata.dev(), metadata.ino()),
        common_identity: common_metadata.map(|value| (value.dev(), value.ino())),
    })
}
impl Sessions {
    /// A bounded join key for local diagnostics; never expose the Conversation contents.
    pub fn diagnostic_run(&self, id: &str) -> Option<String> {
        let data = self.data.lock().ok()?;
        let run = data.store.conversation(id).ok()?.runtime_run?;
        ade_core::diagnostics::valid_run_id(&run).then_some(run)
    }
    pub fn open(path: &Path, runtime: Arc<Supervisor>) -> Result<Arc<Self>> {
        let store = Store::open(path)?;
        let (queue_wake, queue_rx) = mpsc::sync_channel(1);

        let worktrees = crate::worktrees::Worktrees::open(&path.with_extension("worktrees"))?;
        // The final rebind and this marker live in separate SQLite stores.
        // If the daemon died after the last binding commit, reconcile only
        // after both owners independently verify every saved physical path.
        if !worktrees.has_pending_rebind()? && !store.has_unbound_records()? {
            store.release_restore_fence()?;
        }
        let review =
            crate::review::Review::open(&path.with_extension("review.sqlite3"), worktrees.clone())?;
        let sessions = Arc::new(Self {
            runtime,
            queue_wake,
            worktrees,
            review,
            files: crate::files::Files::new(),
            data: Mutex::new(Data {
                draining: false,
                store,
                agents: HashMap::new(),
                terminal_leases: HashMap::new(),
                stopping_services: HashSet::new(),
                health_samples: HashMap::new(),
                health_attempts: HashMap::new(),
                active_health_samples: 0,
                subscribers: HashMap::new(),
                revision: 0,
            }),
            subscribers: Arc::new(AtomicUsize::new(0)),
            boot_id: new_id("boot"),
        });
        sessions.restore()?;
        let weak = Arc::downgrade(&sessions);
        std::thread::spawn(move || {
            loop {
                if let Err(mpsc::RecvTimeoutError::Disconnected) =
                    queue_rx.recv_timeout(std::time::Duration::from_secs(30))
                {
                    break;
                }
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = hub.dispatch_queued() {
                    eprintln!("Prompt queue: {error}");
                }
            }
        });
        let weak = Arc::downgrade(&sessions);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = hub.release_exited_script_leases() {
                    eprintln!("Script lease monitor: {error}");
                }
                if let Err(error) = hub.sample_due_service_health() {
                    eprintln!("Service health monitor: {error}");
                }
            }
        });
        let _ = sessions.queue_wake.try_send(());
        Ok(sessions)
    }
    fn dispatch_queued(self: &Arc<Self>) -> Result<()> {
        let heads = {
            let d = self.data.lock().unwrap();
            if d.draining {
                return Ok(());
            }
            d.store.queue_heads()?
        };
        for head in heads {
            {
                let d = self.data.lock().unwrap();
                if !d.agents.contains_key(&head.conversation_id) && d.agents.len() >= 16 {
                    continue;
                }
            }
            if let Err(error) = self.send(
                &head.conversation_id,
                &head.id,
                &head.text,
                &head.attachments,
                true,
            ) {
                let mut d = self.data.lock().unwrap();
                if d.draining {
                    return Ok(());
                }
                if !d.agents.contains_key(&head.conversation_id) && d.agents.len() >= 16 {
                    continue;
                }
                let mut c = d.store.conversation(&head.conversation_id)?;
                let current = d.store.queued(&c.id)?;
                if matches!(c.status.as_str(), "idle" | "ready")
                    && !c.queue_paused
                    && current
                        .first()
                        .is_some_and(|item| item.id == head.id && item.text == head.text)
                {
                    c.queue_paused = true;
                    c.error = Some(format!("Prompt queue paused: {error}"));
                    d.store.commit_conversation(&c, &[], &[])?;
                    self.changed(&mut d, &c, &[])?;
                }
            }
        }
        Ok(())
    }
    fn release_exited_script_leases(&self) -> Result<()> {
        let catalogue = self.runtime.command(json!({"op":"terminal.list"}))?;
        let exited = catalogue["terminals"]
            .as_array()
            .context("Invalid terminal catalogue")?
            .iter()
            .filter(|item| item["metrics"]["shell_running"] == false)
            .filter_map(|item| item["workspace"]["terminal_id"].as_str())
            .collect::<HashSet<_>>();
        self.data.lock().unwrap().terminal_leases.retain(|id, _| {
            ade_core::scripts::run_name(id).is_err() || !exited.contains(id.as_str())
        });
        Ok(())
    }
    pub fn prepare_restart(&self) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        for id in d.agents.keys() {
            let c = d.store.conversation(id)?;
            ensure!(
                !matches!(c.status.as_str(), "starting" | "cancelling")
                    && !d
                        .store
                        .pending(id)?
                        .iter()
                        .any(|request| request.status == "responding"),
                "An Agent command is still being admitted; retry shortly"
            );
        }
        d.draining = true;
        Ok(())
    }
    pub fn abort_restart(&self) {
        self.data.lock().unwrap().draining = false;
        let _ = self.queue_wake.try_send(());
    }
    fn restore(self: &Arc<Self>) -> Result<()> {
        // Retire only identity-checked terminal attachments from older builds.
        // Ordinary shell terminals and services are independent of Conversations.
        let conversations = self.data.lock().unwrap().store.catalog()?.conversations;
        for c in conversations {
            if self.ensure_workspace_bound(&c.workspace_id).is_err() {
                continue;
            }
            if c.view_terminal.is_some() || c.terminal_owner.is_some() {
                self.clear_view_terminal(&c.id)?;
            }
        }
        // Script runs use durable workspace terminal membership as their
        // handoff lease. Reconcile a launch that died before runtime admission.
        let terminals = self.runtime.command(json!({"op":"terminal.list"}))?;
        let terminals = terminals["terminals"]
            .as_array()
            .context("Invalid terminal catalogue")?;
        {
            let mut d = self.data.lock().unwrap();
            for workspace in d.store.catalog()?.workspaces {
                if d.store.ensure_workspace_bound(&workspace.id).is_err() {
                    continue;
                }
                for run_id in workspace
                    .extra_terminals
                    .iter()
                    .filter(|id| ade_core::scripts::run_name(id).is_ok())
                {
                    let runtime = terminals.iter().find(|item| {
                        item["workspace"]["id"] == workspace.id
                            && item["workspace"]["terminal_id"] == *run_id
                    });
                    match runtime {
                        Some(item) => {
                            ensure!(
                                item["workspace"]["root"] == workspace.root
                                    && item["metrics"]["transfer_id"].as_str().is_some(),
                                "Runtime script does not match its durable workspace"
                            );
                            if item["metrics"]["shell_running"] == true {
                                d.terminal_leases
                                    .insert(run_id.clone(), self.worktrees.lease(&workspace.root)?);
                            }
                        }
                        None => d.store.retire_script_run(&workspace.id, run_id)?,
                    }
                }
            }
        }
        let response = self.runtime.agent(json!({"op":"agent.list"}))?;
        let mut live = std::collections::HashSet::new();
        let mut runs = Vec::new();
        {
            let mut d = self.data.lock().unwrap();
            for w in d.store.catalog()?.workspaces {
                if d.store.ensure_workspace_bound(&w.id).is_err() {
                    continue;
                }
                for service in d.store.services(&w.id)? {
                    if let Some(owner) = service.terminal_owner {
                        d.terminal_leases
                            .insert(owner.terminal_id, self.worktrees.lease(&w.root)?);
                    }
                }
            }
            for c in d.store.catalog()?.conversations {
                if d.store.ensure_workspace_bound(&c.workspace_id).is_err() {
                    continue;
                }
                if c.terminal_owner.is_some() {
                    let w = d.store.workspace(&c.workspace_id)?;
                    d.terminal_leases
                        .insert(c.id, self.worktrees.lease(&w.root)?);
                }
            }
            for record in response["agents"]
                .as_array()
                .context("Invalid Agent catalogue")?
            {
                let spec: Spec = serde_json::from_value(record["spec"].clone())?;
                let c = d.store.conversation(&spec.conversation)?;
                let w = d.store.workspace(&c.workspace_id)?;
                d.store.ensure_workspace_bound(&w.id)?;
                ensure!(
                    c.runtime_run.as_deref() == Some(&spec.run)
                        && c.provider == spec.provider
                        && c.account_id.as_deref()
                            == spec.account.as_ref().map(|account| account.id.as_str())
                        && w.root == spec.root,
                    "Runtime Agent does not match its durable Conversation; preserve the runtime for recovery"
                );
                if c.terminal_owner.is_some() {
                    continue;
                }
                let lease = self.worktrees.lease(&w.root)?;
                live.insert(c.id.clone());
                d.agents.insert(
                    c.id.clone(),
                    Agent {
                        run_id: spec.run.clone(),
                        rpc: None,
                        submission: c.runtime_submission.clone(),
                        account_generation: spec.account.as_ref().map(|account| account.generation),
                        _lease: lease,
                    },
                );
                runs.push((spec, record["commands"].clone()));
            }
            d.store.recover_except(&live)?;
        }
        for (spec, commands) in runs {
            let result = self.attach_agent(&spec.conversation, &spec.run, true);
            match result {
                Ok(_) => {
                    let d = self.data.lock().unwrap();
                    let mut c = d.store.conversation(&spec.conversation)?;
                    // A durable intent alone is not proof that the runtime admitted a send.
                    if c.status == "starting"
                        && c.active_turn_id.is_none()
                        && c.runtime_submission.as_ref().is_some_and(|s| {
                            !commands
                                .as_array()
                                .unwrap()
                                .contains(&json!(format!("send:{s}")))
                        })
                    {
                        c.status = "interrupted".into();
                        // Reconnecting must not silently skip this unconfirmed
                        // instruction and dispatch the next queued prompt.
                        c.queue_paused = true;
                        c.error = Some("Daemon stopped before prompt delivery was confirmed. The prompt was not resent; review it before continuing the queue.".into());
                    }
                    if c.status == "starting" && c.runtime_submission.is_none() {
                        c.status = "ready".into();
                    }
                    if c.status == "cancelling"
                        && c.active_turn_id.as_ref().is_some_and(|t| {
                            !commands
                                .as_array()
                                .unwrap()
                                .contains(&json!(format!("cancel:{t}")))
                        })
                    {
                        c.status = "running".into();
                        c.error = Some("Cancellation was not delivered before daemon loss; cancel again if needed.".into());
                    }
                    let mut requests = d.store.pending(&c.id)?;
                    for p in &mut requests {
                        if p.status == "responding"
                            && !commands
                                .as_array()
                                .unwrap()
                                .contains(&json!(format!("answer:{}", p.id)))
                        {
                            p.status = "pending".into();
                        }
                    }
                    d.store.commit_conversation(&c, &[], &requests)?;
                }
                Err(e) => self.fail(&spec.conversation, &spec.run, e.to_string()),
            }
        }
        Ok(())
    }
    pub fn connected_agents(&self) -> usize {
        self.data.lock().unwrap().agents.len()
    }
    pub fn workspace(&self, id: &str) -> Result<WorkspaceRecord> {
        self.data.lock().unwrap().store.workspace(id)
    }
    pub fn ensure_workspace_bound(&self, id: &str) -> Result<()> {
        self.data.lock().unwrap().store.ensure_workspace_bound(id)
    }
    pub fn has_pending_rebind(&self) -> Result<bool> {
        if self.worktrees.has_pending_rebind()? {
            return Ok(true);
        }
        self.data.lock().unwrap().store.has_pending_rebind()
    }
    fn release_restore_fence_if_bound(&self) -> Result<()> {
        if self.worktrees.has_pending_rebind()? {
            return Ok(());
        }
        let d = self.data.lock().unwrap();
        if !d.store.has_unbound_records()? {
            d.store.release_restore_fence()?;
        }
        Ok(())
    }
    pub fn terminal_reserved(&self, terminal: &str) -> Result<bool> {
        self.data.lock().unwrap().store.terminal_reserved(terminal)
    }
    pub fn retire_terminal(&self, workspace: &str, terminal: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.store.terminal_reserved(terminal)?,
            "Remove its service, or return the Conversation to the GUI before retiring this terminal"
        );
        d.store.retire_terminal(workspace, terminal)?;
        self.catalog_changed(&mut d)
    }
    pub fn open_workspace(&self, path: &str) -> Result<WorkspaceRecord> {
        let root = std::fs::canonicalize(path).context("Workspace directory is unavailable")?;
        ensure!(root.is_dir(), "Workspace must be a directory");
        let root = root
            .to_str()
            .ok_or_else(|| anyhow!("Workspace path must be UTF-8"))?;
        // A Git common directory identifies one repository across its worktrees.
        // No worktree is created, moved, pruned, or removed by this operation.
        let pending_rebind = self.data.lock().unwrap().store.has_pending_rebind()?;
        let repo = if pending_rebind {
            None
        } else {
            Command::new("git")
                .args([
                    "-C",
                    root,
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_owned())
        };
        let mut d = self.data.lock().unwrap();
        let w = d.store.workspace_open(root, repo.as_deref())?;
        self.catalog_changed(&mut d)?;
        Ok(w)
    }
    fn publish(&self, d: &mut Data, mut event: Value) {
        d.revision += 1;
        event["revision"] = json!(d.revision);
        event["boot_id"] = json!(self.boot_id);
        d.subscribers
            .retain(|_, tx| tx.try_send(event.clone()).is_ok());
        self.subscribers
            .store(d.subscribers.len(), Ordering::Relaxed);
    }
    fn catalog_changed(&self, d: &mut Data) -> Result<()> {
        let catalog = d.store.catalog()?;
        self.publish(
            d,
            json!({"type":"catalog","catalog":catalog,"providers":provider::descriptors()}),
        );
        Ok(())
    }
    fn changed(&self, d: &mut Data, c: &Conversation, messages: &[Message]) -> Result<()> {
        let requests: Vec<_> = d
            .store
            .pending(&c.id)?
            .into_iter()
            .filter(|r| r.status == "pending")
            .collect();
        crate::bench::agent_messages("provider_to_durable_us", messages);
        let queued = d.store.queued(&c.id)?;
        self.publish(d,json!({"type":"conversation_changed","conversation":c,"messages":messages,"requests":requests,"queued":queued}));
        let _ = self.queue_wake.try_send(());
        Ok(())
    }
    pub fn subscribe(&self) -> Result<(String, mpsc::Receiver<Value>)> {
        let (tx, rx) = mpsc::sync_channel(128);
        let id = new_id("subscriber");
        let mut d = self.data.lock().unwrap();
        tx.send(json!({"type":"catalog","catalog":d.store.catalog()?,"providers":provider::descriptors(),"boot_id":self.boot_id,"revision":d.revision}))?;
        d.subscribers.insert(id.clone(), tx);
        self.subscribers
            .store(d.subscribers.len(), Ordering::Relaxed);
        Ok((id, rx))
    }
    pub fn unsubscribe(&self, id: &str) {
        let mut d = self.data.lock().unwrap();
        d.subscribers.remove(id);
        self.subscribers
            .store(d.subscribers.len(), Ordering::Relaxed);
    }
    pub fn command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let string = |key: &str| {
            request[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("Missing {key}"))
        };
        let op = request["op"].as_str().unwrap_or("");
        if op.starts_with("worktree.")
            && op != "worktree.operation"
            && op != "worktree.rebind"
            && op != "worktree.rebind.list"
            && self.data.lock().unwrap().store.has_pending_rebind()?
        {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if op.starts_with("review.")
            || op.starts_with("file.")
            || op.starts_with("script.")
            || op.starts_with("service.")
            || op == "terminal.create"
        {
            self.ensure_workspace_bound(string("workspace_id")?)?;
        }
        if op.starts_with("agent.") && op != "agent.disconnect"
            || matches!(
                op,
                "attachment.import" | "draft.send.prepare" | "queue.enqueue"
            )
            || op == "queue.pause" && request["paused"] == false
        {
            let conversation = self
                .data
                .lock()
                .unwrap()
                .store
                .conversation(string("conversation_id")?)?;
            self.ensure_workspace_bound(&conversation.workspace_id)?;
        }
        if request["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("worktree."))
        {
            if op == "worktree.rebind" {
                let selected = selected_binding(string("path")?, true)?;
                let d = self.data.lock().unwrap();
                d.store.reject_source_path(&selected.root)?;
                d.store.reject_source_path(
                    selected
                        .common
                        .as_deref()
                        .context("Git common directory is unavailable")?,
                )?;
            }
            let response = self.worktrees.command(request)?;
            if op == "worktree.rebind" {
                self.release_restore_fence_if_bound()?;
            }
            return Ok(response);
        }
        if request["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("review."))
        {
            let (workspace, binding, common_binding) = {
                let data = self.data.lock().unwrap();
                let id = string("workspace_id")?;
                data.store.ensure_workspace_bound(id)?;
                let workspace = data.store.workspace(id)?;
                let common_binding = workspace
                    .repository_id
                    .as_deref()
                    .map(|repository_id| data.store.repository_binding_identity(repository_id))
                    .transpose()?;
                (
                    workspace,
                    data.store.workspace_binding_identity(id)?,
                    common_binding,
                )
            };
            return self
                .review
                .command(&workspace.root, binding, common_binding, request);
        }
        if op.starts_with("file.") {
            let id = string("workspace_id")?;
            let (workspace, binding) = {
                let data = self.data.lock().unwrap();
                data.store.ensure_workspace_bound(id)?;
                (
                    data.store.workspace(id)?,
                    data.store.workspace_binding_identity(id)?,
                )
            };
            return self.files.command(id, &workspace.root, binding, request);
        }
        if request["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("script."))
        {
            if matches!(
                request["op"].as_str(),
                Some("script.start" | "script.stop" | "script.retire")
            ) {
                ensure!(
                    !self.data.lock().unwrap().draining,
                    "Application daemon is restarting"
                );
            }
            let workspace = self.workspace(string("workspace_id")?)?;
            let register = |run_id: &str| -> Result<()> {
                self.ensure_workspace_bound(&workspace.id)?;
                let lease = self.worktrees.agent_lease(&workspace.root)?;
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                d.store.ensure_workspace_bound(&workspace.id)?;
                d.store.register_script_run(&workspace.id, run_id)?;
                d.terminal_leases.insert(run_id.to_owned(), lease);
                Ok(())
            };
            let retire = |run_id: &str| -> Result<()> {
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                d.store.retire_script_run(&workspace.id, run_id)?;
                d.terminal_leases.remove(run_id);
                Ok(())
            };
            return crate::scripts::command(
                workspace.clone(),
                &self.runtime,
                self.subscribers.load(Ordering::Relaxed),
                request,
                &register,
                &retire,
            );
        }
        match request["op"].as_str().unwrap_or("") {
            "attachment.inspect" => {
                let (attachment, sha256) = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .attachment_inspect(string("conversation_id")?, string("attachment_id")?)?;
                Ok(json!({"type":"attachment_inspection","attachment":attachment,"sha256":sha256}))
            }
            "attachment.reclaim.preview" => {
                let preview = self.data.lock().unwrap().store.attachment_reclaim_preview(
                    string("conversation_id")?,
                    string("attachment_id")?,
                )?;
                Ok(
                    json!({"type":"attachment_reclaim_preview","preview":preview,
                    "scope":"explicit_single_attachment","automatic_gc_eligible":false,
                    "client_held_uploads":"not_enumerated","filesystem_reclaimed_bytes":0}),
                )
            }
            "attachment.reclaim.apply" => {
                let (attachment, reclaimed) =
                    self.data.lock().unwrap().store.attachment_reclaim_apply(
                        string("conversation_id")?,
                        string("attachment_id")?,
                        string("expected_generation")?,
                    )?;
                Ok(json!({"type":"attachment_reclaim","attachment":attachment,
                    "reclaimed_payload_bytes":reclaimed,"filesystem_reclaimed_bytes":0,
                    "scope":"explicit_single_attachment"}))
            }
            "attachment.import" | "attachment.put" => {
                use base64::Engine;
                use std::io::Read;
                let (name, bytes) = if request["op"] == "attachment.import" {
                    use std::os::unix::fs::OpenOptionsExt;
                    let path = std::path::Path::new(string("path")?);
                    let file = std::fs::OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(path)?;
                    ensure!(file.metadata()?.is_file(), "Attach a regular file");
                    let mut bytes = Vec::new();
                    file.take(crate::prompt::ATTACHMENT_LIMIT as u64 + 1)
                        .read_to_end(&mut bytes)?;
                    (
                        path.file_name()
                            .and_then(|n| n.to_str())
                            .context("Invalid file name")?
                            .to_owned(),
                        bytes,
                    )
                } else {
                    let bytes =
                        base64::engine::general_purpose::STANDARD.decode(string("data")?)?;
                    (string("name")?.to_owned(), bytes)
                };
                let attachment = self.data.lock().unwrap().store.attach(
                    string("conversation_id")?,
                    string("request_id")?,
                    &name,
                    &bytes,
                )?;
                Ok(json!({"type":"attachment","attachment":attachment}))
            }
            "service.start" => self.start_service(string("workspace_id")?, string("name")?),
            "service.stop" => self.stop_service(string("workspace_id")?, string("name")?),
            "service.health.sample" => {
                self.sample_service_health(string("workspace_id")?, string("name")?)
            }
            "service.inspect" => {
                let health_check = HealthCheck::parse(&request["health_check"])?;
                let limit = if request["tail_bytes"].is_null() {
                    8192
                } else {
                    request["tail_bytes"]
                        .as_u64()
                        .context("Invalid tail limit")?
                };
                ensure!(
                    (1..=32768).contains(&limit),
                    "Tail limit must be 1 to 32768 bytes"
                );
                self.inspect_service(
                    string("workspace_id")?,
                    string("name")?,
                    limit,
                    health_check.as_ref(),
                )
            }
            "listener.list" => self.list_listeners(),
            "service.list" => {
                let services = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .services(string("workspace_id")?)?;
                let terminals = self.runtime.command(json!({"op":"terminal.list"}))?;
                let terminals = terminals["terminals"]
                    .as_array()
                    .context("Invalid terminal catalogue")?;
                let states = services
                    .iter()
                    .map(|service| {
                        let terminal = service.terminal_id.as_ref().and_then(|id| {
                            terminals
                                .iter()
                                .find(|t| t["workspace"]["terminal_id"] == *id)
                        });
                        let state = match &service.terminal_owner {
                            None => "stopped",
                            Some(owner) if owner.runtime_instance != self.runtime.instance => {
                                "unavailable"
                            }
                            Some(owner) => match terminal {
                                Some(t) if t["metrics"]["transfer_id"] == owner.transfer_id => {
                                    if t["metrics"]["shell_running"] == true {
                                        "running"
                                    } else {
                                        "exited"
                                    }
                                }
                                _ => "unavailable",
                            },
                        };
                        (
                            service.name.clone(),
                            json!({"state":state,"metrics":terminal.map(|t| t["metrics"].clone())}),
                        )
                    })
                    .collect::<serde_json::Map<String, Value>>();
                Ok(json!({"type":"services","services":services,"states":states}))
            }
            "service.configure" => {
                let config = serde_json::from_value(request["config"].clone())?;
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                let service = d.store.configure_service(
                    string("workspace_id")?,
                    string("name")?,
                    request["revision"]
                        .as_i64()
                        .context("Missing service revision")?,
                    config,
                )?;
                d.health_samples
                    .remove(&(service.workspace_id.clone(), service.name.clone()));
                d.health_attempts
                    .remove(&(service.workspace_id.clone(), service.name.clone()));
                Ok(json!({"type":"service", "service":service}))
            }
            "service.remove" => {
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                let workspace = string("workspace_id")?;
                let name = string("name")?;
                let revision = request["revision"]
                    .as_i64()
                    .context("Missing service revision")?;
                if let Some(service) = d
                    .store
                    .services(workspace)?
                    .into_iter()
                    .find(|s| s.name == name)
                {
                    ensure!(
                        service.terminal_owner.is_none(),
                        "Stop the service before removing it"
                    );
                    ensure!(
                        service.revision == revision,
                        "Service changed; reload before removing"
                    );
                    if let Some(terminal) = service.terminal_id {
                        self.runtime.command(json!({"op":"terminal.retire","workspace_id":workspace,"terminal_id":terminal}))?;
                    }
                }
                d.store.remove_service(workspace, name, revision)?;
                d.health_samples
                    .remove(&(workspace.to_owned(), name.to_owned()));
                d.health_attempts
                    .remove(&(workspace.to_owned(), name.to_owned()));
                self.catalog_changed(&mut d)?;
                Ok(json!({"type":"ack"}))
            }
            "provider.list" => Ok(provider::catalogue()),
            "account.list" => Ok(
                json!({"type":"accounts","accounts":self.data.lock().unwrap().store.accounts()?}),
            ),
            "account.create" => {
                let d = self.data.lock().unwrap();
                let account = d
                    .store
                    .create_account(string("provider")?, string("name")?)?;
                Ok(json!({"type":"ack","account":account}))
            }
            "account.inspect" | "account.verify" => {
                let id = string("account_id")?;
                let account = self.data.lock().unwrap().store.account(id)?;
                ensure!(
                    matches!(account.provider.as_str(), "claude" | "codex" | "omp"),
                    "Managed account inspection is unavailable for this provider"
                );
                let expected_generation = if request["op"] == "account.verify" {
                    Some(
                        request["expected_generation"]
                            .as_u64()
                            .context("Missing expected account generation")?,
                    )
                } else {
                    None
                };
                let expected_identity: Option<Value> = if request["op"] == "account.verify" {
                    Some(request.get("expected_identity").cloned().with_context(|| {
                        let provider = match account.provider.as_str() {
                            "claude" => "Claude",
                            "codex" => "Codex",
                            _ => "Oh My Pi",
                        };
                        format!("Missing inspected {provider} identity")
                    })?)
                } else {
                    None
                };
                let context = ade_core::model::AccountExecution {
                    id: account.id.clone(),
                    provider: account.provider.clone(),
                    native_home: account.native_home.clone(),
                    generation: account.generation,
                    claude_identity: account.claude_identity.clone(),
                    codex_identity: account.codex_identity.clone(),
                    omp_identity: account.omp_identity.clone(),
                };
                let inspection: provider::account_probe::Inspection = serde_json::from_value(
                    self.runtime
                        .agent(json!({"op":"agent.account_inspect","account":context}))?,
                )?;
                if let Some(generation) = expected_generation {
                    ensure!(
                        inspection.state == "ready",
                        "{} account is not ready: {}",
                        account.provider,
                        inspection.reason
                    );
                    let identity = inspection
                        .identity
                        .context("Account identity is unavailable")?;
                    ensure!(
                        expected_identity.as_ref() == Some(&identity),
                        "Account identity changed since inspection; inspect again"
                    );
                    let d = self.data.lock().unwrap();
                    let updated = if account.provider == "claude" {
                        d.store.verify_claude_account(
                            id,
                            generation,
                            serde_json::from_value(identity)
                                .context("Invalid inspected Claude identity")?,
                        )?
                    } else if account.provider == "codex" {
                        d.store.verify_codex_account(
                            id,
                            generation,
                            serde_json::from_value(identity)
                                .context("Invalid inspected Codex identity")?,
                        )?
                    } else {
                        d.store.verify_omp_account(
                            id,
                            generation,
                            serde_json::from_value(identity)
                                .context("Invalid inspected Oh My Pi identity")?,
                        )?
                    };
                    Ok(json!({"type":"ack","account":updated}))
                } else {
                    let current = self.data.lock().unwrap().store.account(id)?;
                    ensure!(
                        current.generation == account.generation,
                        "Account changed during inspection; retry"
                    );
                    Ok(
                        json!({"type":"account_inspection","account_id":id,"generation":account.generation,"inspection":inspection}),
                    )
                }
            }
            "account.disable" => {
                let account = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .disable_account(string("account_id")?)?;
                Ok(json!({"type":"ack","account":account,"native_logout":false}))
            }
            "catalog.get" => Ok(
                json!({"type":"catalog","catalog":self.data.lock().unwrap().store.catalog()?,"providers":provider::descriptors(),"boot_id":self.boot_id}),
            ),
            "workspace.rebind.list" => {
                let workspaces = self.data.lock().unwrap().store.rebind_workspaces()?;
                Ok(json!({"type":"workspace_rebind_catalog","workspaces":workspaces}))
            }
            "repository.rebind.list" => {
                let repositories = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .rebind_repositories()?
                    .into_iter()
                    .map(|(id, root, needs_rebind, rebindable)| {
                        json!({"id":id,"root":root,"needs_rebind":needs_rebind,"rebindable":rebindable})
                    })
                    .collect::<Vec<_>>();
                Ok(json!({"type":"repository_rebind_catalog","repositories":repositories}))
            }
            "workspace.open" => {
                Ok(json!({"type":"ack","workspace":self.open_workspace(string("path")?)?}))
            }
            "repository.rebind" => {
                ensure!(
                    !self.worktrees.has_pending_rebind()?,
                    "Rebind restored Worktrunk repositories first"
                );
                let selected = string("path")?;
                let binding = selected_binding(selected, true)?;
                let common = binding
                    .common
                    .as_deref()
                    .context("Git common directory is unavailable")?;
                let common_identity = binding
                    .common_identity
                    .context("Git common directory is unavailable")?;
                let repository_id = string("repository_id")?;
                let saved = self.data.lock().unwrap().store.repository(repository_id)?;
                let source_identity = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .repository_source_identity(repository_id)?;
                ensure!(
                    !self
                        .data
                        .lock()
                        .unwrap()
                        .store
                        .repository_bound(repository_id)?,
                    "Repository is already bound"
                );
                self.worktrees
                    .validate_core_binding(&saved.root, source_identity, common)?;
                let mut d = self.data.lock().unwrap();
                let checked = selected_binding(selected, true)?;
                ensure!(
                    binding == checked,
                    "Selected repository changed during rebind"
                );
                ensure!(
                    d.store.repository(repository_id)?.root == saved.root,
                    "Repository binding changed during rebind"
                );
                let repository =
                    d.store
                        .rebind_repository(repository_id, common, common_identity)?;
                self.catalog_changed(&mut d)?;
                drop(d);
                self.release_restore_fence_if_bound()?;
                Ok(json!({"type":"ack","repository":repository}))
            }
            "workspace.rebind" => {
                ensure!(
                    !self.worktrees.has_pending_rebind()?,
                    "Rebind restored Worktrunk repositories first"
                );
                let selected = string("path")?;
                let binding = selected_binding(selected, false)?;
                let mut d = self.data.lock().unwrap();
                let checked = selected_binding(selected, false)?;
                ensure!(
                    binding == checked,
                    "Selected workspace changed during rebind"
                );
                e2e_rebind_exit("before_workspace_commit");
                let workspace = d.store.rebind_workspace(
                    string("workspace_id")?,
                    &binding.root,
                    binding.common.as_deref(),
                    binding.root_identity,
                )?;
                e2e_rebind_exit("after_workspace_commit");
                self.catalog_changed(&mut d)?;
                drop(d);
                self.release_restore_fence_if_bound()?;
                Ok(json!({"type":"ack","workspace":workspace}))
            }
            "terminal.create" => {
                let mut d = self.data.lock().unwrap();
                let terminal = d.store.create_terminal(string("workspace_id")?)?;
                self.catalog_changed(&mut d)?;
                Ok(json!({"type":"ack", "terminal_id":terminal}))
            }
            "conversation.create" => {
                let mut d = self.data.lock().unwrap();
                let title = request["title"].as_str().unwrap_or("New Conversation");
                ensure!(title.len() <= 256, "Title is too long");
                let account_id = match request.get("account_id") {
                    None => None,
                    Some(value) => Some(value.as_str().context("Invalid account ID")?),
                };
                let c = d.store.create_with_account(
                    string("workspace_id")?,
                    title,
                    request["provider"].as_str().unwrap_or("codex"),
                    serde_json::from_value(
                        request
                            .get("provider_config")
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                    )?,
                    account_id,
                )?;
                self.catalog_changed(&mut d)?;
                Ok(json!({"type":"ack","conversation":c}))
            }
            "conversation.get" => {
                let d = self.data.lock().unwrap();
                let id = string("conversation_id")?;
                Ok(
                    json!({"type":"conversation_snapshot","conversation":d.store.conversation(id)?,"messages":d.store.messages(id,request["before"].as_i64(),request["limit"].as_u64().unwrap_or(50) as usize)?,"requests":d.store.pending(id)?,"queued":d.store.queued(id)?,"boot_id":self.boot_id,"revision":d.revision}),
                )
            }
            "agent.child_transcript" => {
                let id = string("conversation_id")?;
                let child = string("child_id")?;
                let offset = request["offset"].as_u64().unwrap_or(0);
                ensure!(offset <= 100_000, "Child transcript offset is too large");
                let cursor = request["cursor"].as_str();
                ensure!(
                    cursor.is_none_or(|c| !c.is_empty() && c.len() <= 4096),
                    "Invalid child transcript cursor"
                );
                let (rpc, session) = {
                    let d = self.data.lock().unwrap();
                    let c = d.store.conversation(id)?;
                    let message = d
                        .store
                        .message(string("message_id")?)?
                        .context("Child record is unavailable")?;
                    ensure!(
                        message.conversation_id == id,
                        "Child record belongs to another Conversation"
                    );
                    ensure!(
                        matches!(&message.content, Some(crate::transcript::Content::Subagents { agents, .. }) if agents.iter().any(|a| a.id == child)),
                        "Child is not in this record"
                    );
                    let agent = d
                        .agents
                        .get(id)
                        .context("Connect the parent Agent before reading its child transcript")?;
                    (
                        agent
                            .rpc
                            .clone()
                            .context("Parent Agent is still connecting")?,
                        c.provider_thread_id
                            .context("Parent session is unavailable")?,
                    )
                };
                rpc.child_transcript(&session, child, offset, cursor)
            }
            "draft.get" => Ok(
                json!({"type":"draft","draft":self.data.lock().unwrap().store.draft(string("conversation_id")?,string("window_id")?)?}),
            ),
            "draft.save" => {
                let draft = crate::model::Draft {
                    attachments: serde_json::from_value(
                        request.get("attachments").cloned().unwrap_or(json!([])),
                    )?,
                    text: request["text"]
                        .as_str()
                        .context("Missing draft text")?
                        .into(),
                    revision: request["revision"]
                        .as_i64()
                        .context("Missing draft revision")?,
                };
                let data = self.data.lock().unwrap();
                let conversation = string("conversation_id")?;
                let window = string("window_id")?;
                // Explicit conflict resolution must not overwrite a third writer
                // that saved after the user reviewed the conflicting draft.
                let saved = if let Some(expected) = request["expected_revision"].as_i64() {
                    data.store
                        .resolve_draft(conversation, window, &draft, expected)
                } else {
                    data.store.save_draft(conversation, window, &draft)
                };
                Ok(json!({"type":"draft","draft":persistence_result(saved)?}))
            }
            "draft.send.get" => {
                let data = self.data.lock().unwrap();
                Ok(json!({"type":"send_intent","intent":data.store.send_intent(
                    string("conversation_id")?, string("window_id")?)?,
                    "restored_from_backup":data.store.restored_from_backup()?}))
            }
            "draft.send.prepare" => {
                let draft = crate::model::Draft {
                    text: request["draft_text"]
                        .as_str()
                        .context("Missing draft text")?
                        .into(),
                    revision: request["revision"]
                        .as_i64()
                        .context("Missing draft revision")?,
                    attachments: serde_json::from_value(
                        request.get("attachments").cloned().unwrap_or(json!([])),
                    )?,
                };
                let data = self.data.lock().unwrap();
                let intent = persistence_result(data.store.prepare_send_intent(
                    string("conversation_id")?,
                    string("window_id")?,
                    string("request_id")?,
                    &draft,
                    request["text"].as_str().context("Missing prompt text")?,
                ))?;
                Ok(json!({"type":"send_intent","intent":intent}))
            }
            "draft.send.complete" => {
                let data = self.data.lock().unwrap();
                let draft = persistence_result(data.store.complete_send_intent(
                    string("conversation_id")?,
                    string("window_id")?,
                    string("request_id")?,
                ))?;
                Ok(json!({"type":"draft","draft":draft}))
            }
            "draft.send.abort" => {
                let data = self.data.lock().unwrap();
                let draft = persistence_result(data.store.abort_send_intent(
                    string("conversation_id")?,
                    string("window_id")?,
                    string("request_id")?,
                ))?;
                Ok(json!({"type":"draft","draft":draft}))
            }
            "agent.send" => {
                let conversation = string("conversation_id")?;
                let key = string("request_id")?;
                let text = request["text"].as_str().context("Missing prompt text")?;
                let attachments = serde_json::from_value::<Vec<crate::model::Attachment>>(
                    request.get("attachments").cloned().unwrap_or(json!([])),
                )?;
                if let Err(error) = self.send(conversation, key, text, &attachments, false) {
                    let data = self.data.lock().unwrap();
                    let _ = data
                        .store
                        .reject_send_intent(conversation, key, text, &attachments);
                    return Err(error);
                }
                Ok(json!({"type":"ack"}))
            }
            "queue.enqueue" | "queue.cancel" | "queue.pause" => {
                let mut d = self.data.lock().unwrap();
                let id = string("conversation_id")?;
                let mut c = d.store.conversation(id)?;
                match request["op"].as_str().unwrap() {
                    "queue.enqueue" => d.store.enqueue_content(
                        id,
                        string("request_id")?,
                        request["text"].as_str().context("Missing prompt text")?,
                        &serde_json::from_value::<Vec<crate::model::Attachment>>(
                            request.get("attachments").cloned().unwrap_or(json!([])),
                        )?,
                    )?,
                    "queue.cancel" => d.store.cancel_queued(id, string("request_id")?)?,
                    _ => {
                        c.queue_paused =
                            request["paused"].as_bool().context("Missing paused flag")?;
                        ensure!(
                            c.queue_paused || c.terminal_owner.is_none(),
                            "Return this Conversation from its terminal before unpausing"
                        );
                        if c.error
                            .as_deref()
                            .is_some_and(|message| message.starts_with("Prompt queue paused:"))
                        {
                            c.error = None;
                        }
                        if !c.queue_paused
                            && c.provider_thread_id.is_none()
                            && !d.agents.contains_key(id)
                            && matches!(c.status.as_str(), "error" | "interrupted" | "disconnected")
                        {
                            c.status = "idle".into();
                        }
                        d.store.commit_conversation(&c, &[], &[])?;
                    }
                }
                self.changed(&mut d, &c, &[])?;
                Ok(json!({"type":"ack"}))
            }
            "agent.disconnect" => {
                let id = string("conversation_id")?;
                let mut d = self.data.lock().unwrap();
                let mut c = d.store.conversation(id)?;
                ensure!(
                    c.terminal_owner.is_none(),
                    "Return this Conversation from its terminal before disconnecting"
                );
                ensure!(
                    !matches!(
                        c.status.as_str(),
                        "starting" | "running" | "waiting" | "cancelling"
                    ),
                    "Cancel the active turn before disconnecting"
                );
                if let Some(rpc) = d.agents.get(id).and_then(|agent| agent.rpc.as_ref()) {
                    rpc.stop_confirmed()?;
                }
                d.agents.remove(id);
                c.status = "disconnected".into();
                c.updated_at = now_ms();
                d.store.commit_conversation(&c, &[], &[])?;
                self.changed(&mut d, &c, &[])?;
                Ok(json!({"type":"ack"}))
            }
            "agent.resume" => {
                self.resume(string("conversation_id")?)?;
                Ok(json!({"type":"ack"}))
            }
            "agent.cancel" => {
                self.cancel(string("conversation_id")?)?;
                Ok(json!({"type":"ack"}))
            }
            "agent.answer" => {
                self.answer(
                    string("conversation_id")?,
                    string("request_id")?,
                    string("decision")?,
                    request.get("answers"),
                )?;
                Ok(json!({"type":"ack"}))
            }
            "window.save" => {
                let window: WindowRecord = serde_json::from_value(request["window"].clone())?;
                let d = self.data.lock().unwrap();
                persistence_result(d.store.save_window(&window))?;
                // Layout acknowledgements do not refresh all other windows.
                Ok(json!({"type":"ack"}))
            }
            "window.close" => {
                self.data
                    .lock()
                    .unwrap()
                    .store
                    .close_window(string("window_id")?)?;
                Ok(json!({"type":"ack"}))
            }
            _ => bail!("Unknown session operation"),
        }
    }
    fn clear_view_terminal(&self, id: &str) -> Result<()> {
        let c = self.data.lock().unwrap().store.conversation(id)?;
        let Some(owner) = c.view_terminal.clone().or(c.terminal_owner.clone()) else {
            return Ok(());
        };
        if owner.runtime_instance == self.runtime.instance {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut stopped = false;
            loop {
                let state = self.runtime.command(json!({"op":"terminal.list"}))?;
                let terminal = state["terminals"]
                    .as_array()
                    .context("Invalid terminal catalogue")?
                    .iter()
                    .find(|t| t["workspace"]["terminal_id"] == owner.terminal_id);
                let Some(terminal) = terminal else { break };
                ensure!(
                    terminal["metrics"]["transfer_id"] == owner.transfer_id,
                    "Terminal view ownership changed"
                );
                if terminal["metrics"]["shell_running"] == false {
                    self.runtime.command(json!({"op":"terminal.retire","workspace_id":c.workspace_id,"terminal_id":owner.terminal_id}))?;
                    break;
                }
                if !stopped {
                    self.runtime.command(json!({"op":"terminal.stop","workspace_id":c.workspace_id,"terminal_id":owner.terminal_id}))?;
                    stopped = true;
                }
                ensure!(
                    std::time::Instant::now() < deadline,
                    "Terminal view is still stopping; retry resume"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let mut d = self.data.lock().unwrap();
        let mut current = d.store.conversation(id)?;
        ensure!(
            current
                .view_terminal
                .as_ref()
                .or(current.terminal_owner.as_ref())
                == Some(&owner),
            "Terminal view changed during recovery"
        );
        current.view_terminal = None;
        if current.terminal_owner.take().is_some() {
            current.status = "disconnected".into();
            current.runtime_run = None;
            current.runtime_submission = None;
            current.runtime_cursor = 0;
            current.error = None;
        }
        d.store.commit_conversation(&current, &[], &[])?;
        d.store
            .retire_terminal(&c.workspace_id, &owner.terminal_id)?;
        self.catalog_changed(&mut d)?;
        self.changed(&mut d, &current, &[])?;
        Ok(())
    }
    fn monitored_health(
        d: &Data,
        service: &ade_core::services::Service,
        execution_state: &str,
    ) -> Value {
        let Some(policy) = &service.config.health else {
            return json!({"state":"disabled"});
        };
        let Some(owner) = &service.terminal_owner else {
            return json!({"state":"not_running"});
        };
        if execution_state != "running" {
            return json!({"state":"unknown","basis":"execution_unavailable"});
        }
        if d.stopping_services
            .contains(&(service.workspace_id.clone(), service.name.clone()))
        {
            return json!({"state":"unknown","basis":"service_stopping"});
        }
        let Some(sample) = d
            .health_samples
            .get(&(service.workspace_id.clone(), service.name.clone()))
        else {
            return json!({"state":"unknown","basis":"no_sample"});
        };
        if sample.revision != service.revision || sample.transfer_id != owner.transfer_id {
            return json!({"state":"unknown","basis":"run_changed"});
        }
        let age = sample.sampled_at.elapsed();
        let interval = std::time::Duration::from_millis(policy.interval_ms);
        let schedule_delay_ms = age.saturating_sub(interval).as_millis() as u64;
        let freshness = std::time::Duration::from_millis(policy.interval_ms.saturating_mul(2));
        if age > freshness {
            return json!({"state":"stale","basis":"sampling_delayed",
                "last_result":sample.result,"sampled_at_ms":sample.sampled_at_ms,
                "schedule_delay_ms":schedule_delay_ms});
        }
        let mut result = sample.result.clone();
        result["sampled_at_ms"] = json!(sample.sampled_at_ms);
        result["fresh_until_ms"] = json!(sample.sampled_at_ms + freshness.as_millis() as i64);
        result["schedule_delay_ms"] = json!(schedule_delay_ms);
        result
    }

    fn sample_service_health(self: &Arc<Self>, workspace: &str, name: &str) -> Result<Value> {
        self.ensure_workspace_bound(workspace)?;
        let started_at = std::time::Instant::now();
        let service = {
            let mut d = self.data.lock().unwrap();
            let service = d.store.service(workspace, name)?;
            ensure!(
                service.config.health.is_some(),
                "Service has no configured HTTP health policy"
            );
            ensure!(
                d.active_health_samples < 4,
                "Too many HTTP health samples in progress"
            );
            d.active_health_samples += 1;
            if let Some(owner) = &service.terminal_owner {
                d.health_attempts.insert(
                    (workspace.to_owned(), name.to_owned()),
                    HealthAttempt {
                        revision: service.revision,
                        transfer_id: owner.transfer_id.clone(),
                        attempted_at: std::time::Instant::now(),
                    },
                );
            }
            service
        };
        let _sample_guard = HealthSampleGuard(self);
        let policy = service.config.health.as_ref().unwrap();
        let inspection =
            self.inspect_service(workspace, name, 1, Some(&HealthCheck::from(policy)))?;
        let result = inspection["health"].clone();
        let mut d = self.data.lock().unwrap();
        let current = d.store.service(workspace, name)?;
        if current != service
            || d.stopping_services
                .contains(&(workspace.to_owned(), name.to_owned()))
        {
            return Ok(json!({"type":"service_health_sample",
                "health_monitor":{"state":"unknown","basis":"identity_changed"}}));
        }
        if let Some(owner) = &service.terminal_owner
            && inspection["execution_state"] == "running"
        {
            let key = (workspace.to_owned(), name.to_owned());
            let superseded = d.health_samples.get(&key).is_some_and(|prior| {
                prior.revision == service.revision
                    && prior.transfer_id == owner.transfer_id
                    && prior.started_at > started_at
            });
            if !superseded {
                d.health_samples.insert(
                    key,
                    HealthSample {
                        result,
                        revision: service.revision,
                        transfer_id: owner.transfer_id.clone(),
                        sampled_at_ms: now_ms(),
                        sampled_at: std::time::Instant::now(),
                        started_at,
                    },
                );
            }
        }
        Ok(
            json!({"type":"service_health_sample","health_monitor":Self::monitored_health(
            &d, &current, inspection["execution_state"].as_str().unwrap_or("unavailable"))}),
        )
    }

    fn sample_due_service_health(self: &Arc<Self>) -> Result<()> {
        let due = {
            let d = self.data.lock().unwrap();
            if d.draining {
                return Ok(());
            }
            let mut selected: Option<(String, String, Option<std::time::Instant>)> = None;
            for service in d.store.all_services_for_health()? {
                if d.store
                    .ensure_workspace_bound(&service.workspace_id)
                    .is_err()
                {
                    continue;
                }
                let Some(policy) = &service.config.health else {
                    continue;
                };
                let Some(owner) = &service.terminal_owner else {
                    continue;
                };
                if d.stopping_services
                    .contains(&(service.workspace_id.clone(), service.name.clone()))
                {
                    continue;
                }
                let last = d
                    .health_attempts
                    .get(&(service.workspace_id.clone(), service.name.clone()))
                    .filter(|attempt| {
                        attempt.revision == service.revision
                            && attempt.transfer_id == owner.transfer_id
                    })
                    .map(|attempt| attempt.attempted_at);
                if last.is_some_and(|at| {
                    at.elapsed() < std::time::Duration::from_millis(policy.interval_ms)
                }) {
                    continue;
                }
                if selected
                    .as_ref()
                    .is_none_or(|(_, _, previous)| last < *previous)
                {
                    selected = Some((service.workspace_id, service.name, last));
                }
            }
            selected.map(|(workspace, name, _)| (workspace, name))
        };
        if let Some((workspace, name)) = due {
            // A concurrent stop or edit can invalidate this candidate; sampling fences it again.
            let _ = self.sample_service_health(&workspace, &name);
        }
        Ok(())
    }

    fn inspect_service(
        self: &Arc<Self>,
        workspace: &str,
        name: &str,
        limit: u64,
        health_check: Option<&HealthCheck>,
    ) -> Result<Value> {
        let (service, peer_targets, mut peer_error) = {
            let d = self.data.lock().unwrap();
            let service = d.store.service(workspace, name)?;
            let (targets, error) = match Self::peer_targets(&d, &service) {
                Ok(targets) => (targets, None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            };
            (service, targets, error)
        };
        let mut current_peer_endpoints = if peer_error.is_none() {
            match self.resolve_peer_targets(&peer_targets) {
                Ok(endpoints) => endpoints,
                Err(error) => {
                    peer_error = Some(error.to_string());
                    BTreeMap::new()
                }
            }
        } else {
            BTreeMap::new()
        };
        if let Some(check) = health_check {
            ensure!(
                service
                    .config
                    .ports
                    .iter()
                    .any(|variable| variable == &check.port_variable)
                    && service.ports.contains_key(&check.port_variable),
                "HTTP health port variable is not configured for this service"
            );
        }
        let (state, execution_error, durable_capture_error) = match self
            .command(&json!({"op":"service.list","workspace_id":workspace}))
        {
            Ok(listed) => {
                let metrics = &listed["states"][name]["metrics"];
                (
                    listed["states"][name]["state"]
                        .as_str()
                        .unwrap_or("unavailable")
                        .to_owned(),
                    None,
                    if service.last_run_transfer_id.as_deref() == metrics["transfer_id"].as_str() {
                        metrics["durable_log_error"].as_str().map(str::to_owned)
                    } else {
                        None
                    },
                )
            }
            Err(error) => ("unavailable".to_owned(), Some(error.to_string()), None),
        };
        let observations = if state == "running" {
            Some(self.list_listeners())
        } else {
            None
        };
        let (readiness_state, observation_error) = match &observations {
            None => (
                if state == "stopped" {
                    "stopped"
                } else if state == "exited" {
                    "exited"
                } else {
                    "unknown"
                },
                None,
            ),
            Some(Ok(inventory)) => {
                let assignments = inventory["assignments"]
                    .as_array()
                    .context("Invalid listener inventory")?;
                let ports = assignments
                    .iter()
                    .filter(|item| {
                        item["workspace_id"] == workspace && item["service_name"] == name
                    })
                    .filter_map(|item| item["observation"].as_str())
                    .collect::<Vec<_>>();
                let readiness = match state.as_str() {
                    "running" if ports.is_empty() => "unknown_no_port_check",
                    "running"
                        if ports
                            .iter()
                            .any(|item| *item == "observed_other" || *item == "contested") =>
                    {
                        "port_conflict"
                    }
                    "running" if ports.iter().all(|item| *item == "verified_managed") => {
                        "tcp_listening"
                    }
                    "running" => "not_observed",
                    _ => "unknown",
                };
                (readiness, None)
            }
            Some(Err(error)) => ("observation_unavailable", Some(error.to_string())),
        };
        let mut health = health_check.map(|check| {
            let result = if state != "running" {
                json!({"state":"not_running","basis":"execution_state"})
            } else if observations.as_ref().is_none_or(Result::is_err) {
                json!({"state":"unknown","basis":"listener_observation_unavailable"})
            } else {
                let assignment = observations
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|inventory| inventory["assignments"].as_array())
                    .and_then(|assignments| {
                        assignments.iter().find(|item| {
                            item["workspace_id"] == workspace
                                && item["service_name"] == name
                                && item["variable"] == check.port_variable
                        })
                    });
                if assignment.is_none_or(|item| item["observation"] != "verified_managed") {
                    json!({"state":"unknown","basis":"managed_listener_unverified"})
                } else {
                    check.probe(service.ports[&check.port_variable])
                }
            };
            let mut result = result;
            result["port_variable"] = json!(check.port_variable);
            result["path"] = json!(check.path);
            result
        });
        let logs = if let Some(terminal_id) = &service.terminal_id {
            match self
                .runtime
                .command(json!({"op":"terminal.tail","workspace_id":workspace,
                "terminal_id":terminal_id,"limit_bytes":limit}))
            {
                Ok(tail)
                    if service
                        .terminal_owner
                        .as_ref()
                        .is_none_or(|owner| tail["transfer_id"] == owner.transfer_id) =>
                {
                    let mut tail = tail;
                    tail["available"] = json!(true);
                    tail
                }
                _ => json!({"available":false,"reason":"runtime_terminal_unavailable"}),
            }
        } else {
            json!({"available":false,"reason":"not_started"})
        };
        let mut durable_logs = match (&service.terminal_id, &service.last_run_transfer_id) {
            (Some(terminal_id), Some(transfer_id)) => ade_runtime::service_logs::tail(
                self.runtime.data_directory(),
                workspace,
                terminal_id,
                transfer_id,
                limit as usize,
            ),
            (None, _) => json!({"available":false,"reason":"not_started"}),
            (_, None) => json!({"available":false,"reason":"run_identity_unrecorded"}),
        };
        if let Some(error) = durable_capture_error {
            durable_logs["capture_error"] = json!(error);
        }
        let still_running = if state == "running" && health_check.is_some() {
            self.command(&json!({"op":"service.list","workspace_id":workspace}))
                .ok()
                .is_some_and(|listed| listed["states"][name]["state"] == "running")
        } else {
            false
        };
        // A listener can close or be replaced while the HTTP request is in flight.
        // Only retain a probe result when the same managed assignment remains verified.
        let still_managed = health_check.is_none_or(|check| {
            if !health.as_ref().is_some_and(|result| {
                result["basis"] == "http_status" || result["basis"] == "http_probe"
            }) {
                return true;
            }
            self.list_listeners().ok().is_some_and(|inventory| {
                inventory["assignments"]
                    .as_array()
                    .is_some_and(|assignments| {
                        assignments.iter().any(|item| {
                            item["workspace_id"] == workspace
                                && item["service_name"] == name
                                && item["variable"] == check.port_variable
                                && item["port"] == service.ports[&check.port_variable]
                                && item["observation"] == "verified_managed"
                        })
                    })
            })
        });
        let d = self.data.lock().unwrap();
        let current = d.store.service(workspace, name)?;
        if current != service {
            let mut result = json!({"type":"service_inspection","service":current,
                "execution_state":"unavailable","execution_error":"Service changed during inspection; refresh",
                "readiness":{"state":"unknown","basis":"identity_changed",
                    "application_ready":"unverified","observation_error":"Service changed during inspection; refresh"},
                "logs":{"available":false,"reason":"service_changed_during_inspection"},
                "durable_logs":{"available":false,"reason":"service_changed_during_inspection"},
                "effective_peers":{},"peer_error":"Service changed during inspection; refresh"});
            if health_check.is_some() {
                result["health"] = json!({"state":"unknown","basis":"identity_changed"});
            }
            result["health_monitor"] = json!({"state":"unknown","basis":"identity_changed"});
            return Ok(result);
        }
        if peer_targets.iter().any(|target| {
            d.stopping_services
                .contains(&(workspace.to_owned(), target.service.name.clone()))
                || d.store
                    .service(workspace, &target.service.name)
                    .ok()
                    .as_ref()
                    != Some(&target.service)
        }) {
            current_peer_endpoints.clear();
            peer_error = Some("Peer service changed during inspection; refresh".into());
        }
        let effective_peers = if state == "running" && service.terminal_owner.is_some() {
            service.launch_peers.clone()
        } else {
            BTreeMap::new()
        };
        if service.terminal_owner.is_some()
            && peer_error.is_none()
            && current_peer_endpoints != effective_peers
        {
            peer_error = Some("Peer endpoint changed since launch; restart this service".into());
        }
        if state == "running" && health_check.is_some() {
            let stopping = d
                .stopping_services
                .contains(&(workspace.to_owned(), name.to_owned()));
            if stopping || !still_running {
                health = Some(json!({"state":"unknown","basis":"execution_changed"}));
            } else if !still_managed {
                health = Some(json!({"state":"unknown","basis":"managed_listener_changed"}));
            }
        }
        let mut result = json!({"type":"service_inspection","service":service,"execution_state":state,
            "execution_error":execution_error,
            "readiness":{"state":readiness_state,"basis":if state == "running" {"direct_process_tcp_listener"} else {"execution_state"},
                "application_ready":"unverified","observation_error":observation_error},
            "logs":logs,"durable_logs":durable_logs,
            "effective_peers":effective_peers,"current_peer_endpoints":current_peer_endpoints,
            "peer_error":peer_error});
        if let Some(health) = health {
            result["health"] = health;
        }
        result["health_monitor"] = Self::monitored_health(&d, &service, &state);
        Ok(result)
    }

    fn list_listeners(&self) -> Result<Value> {
        let services = {
            let d = self.data.lock().unwrap();
            let workspaces = d.store.catalog()?.workspaces;
            let mut services = Vec::new();
            for workspace in workspaces {
                services.extend(d.store.services(&workspace.id)?);
                ensure!(
                    services.len() <= 512,
                    "Too many service assignments to inspect"
                );
            }
            services
        };
        let before = self.runtime.command(json!({"op":"terminal.list"}))?;
        let observed = listeners::observe()?;
        let after = self.runtime.command(json!({"op":"terminal.list"}))?;
        let terminal_metrics = |snapshot: &Value, terminal_id: &str| -> Option<Value> {
            snapshot["terminals"]
                .as_array()?
                .iter()
                .find(|item| item["workspace"]["terminal_id"] == terminal_id)
                .map(|item| item["metrics"].clone())
        };
        let mut managed = HashMap::<u32, (String, String)>::new();
        for service in &services {
            let (Some(owner), Some(terminal_id)) = (&service.terminal_owner, &service.terminal_id)
            else {
                continue;
            };
            if owner.runtime_instance != self.runtime.instance {
                continue;
            }
            let (Some(first), Some(last)) = (
                terminal_metrics(&before, terminal_id),
                terminal_metrics(&after, terminal_id),
            ) else {
                continue;
            };
            let pid = first["shell_pid"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok());
            if first["shell_running"] != true
                || last["shell_running"] != true
                || first["transfer_id"] != owner.transfer_id
                || last["transfer_id"] != owner.transfer_id
                || first["shell_pid"] != last["shell_pid"]
                || first["run_id"] != last["run_id"]
                || first["run_id"].as_str().is_none_or(str::is_empty)
            {
                continue;
            }
            if let Some(pid) = pid {
                // A shared PID would make attribution ambiguous; direct service
                // processes should each have a distinct identity.
                managed
                    .entry(pid)
                    .and_modify(|entry| entry.0.clear())
                    .or_insert_with(|| (service.workspace_id.clone(), service.name.clone()));
            }
        }
        managed.retain(|_, (workspace, _)| !workspace.is_empty());
        let listener_rows = observed.iter().map(|listener| {
            let owner = managed.get(&listener.pid);
            json!({"protocol":"tcp","address":listener.address,"port":listener.port,
                "family":match listener.family { listeners::IpFamily::V4 => "ipv4", listeners::IpFamily::V6 => "ipv6" },
                "pid":listener.pid,"ownership":if owner.is_some(){"managed_service"}else{"unknown"},
                "workspace_id":owner.map(|value| &value.0),"service_name":owner.map(|value| &value.1)})
        }).collect::<Vec<_>>();
        let assignments = services
            .iter()
            .flat_map(|service| {
                service.ports.iter().map(|(variable, port)| {
                    let mut own = false;
                    let mut other = false;
                    for listener in observed.iter().filter(|item| item.port == *port) {
                        if managed.get(&listener.pid)
                            == Some(&(service.workspace_id.clone(), service.name.clone()))
                        {
                            own = true;
                        } else {
                            other = true;
                        }
                    }
                    let observation = match (own, other) {
                        (true, false) => "verified_managed",
                        (true, true) => "contested",
                        (false, true) => "observed_other",
                        (false, false) => "unobserved",
                    };
                    json!({"workspace_id":service.workspace_id,"service_name":service.name,
                    "variable":variable,"port":port,"observation":observation})
                })
            })
            .collect::<Vec<_>>();
        Ok(
            json!({"type":"listeners","scope":"local_host","coverage":"partial",
            "listeners":listener_rows,"assignments":assignments}),
        )
    }

    fn peer_targets(d: &Data, service: &Service) -> Result<Vec<PeerTarget>> {
        service
            .config
            .peers
            .iter()
            .map(|(variable, peer)| {
                let target = d
                    .store
                    .service(&service.workspace_id, &peer.service)
                    .with_context(|| format!("Peer service {} is unavailable", peer.service))?;
                ensure!(
                    target.ports.contains_key(&peer.port_variable),
                    "Peer service {} has no {} port",
                    peer.service,
                    peer.port_variable
                );
                ensure!(
                    !d.stopping_services
                        .contains(&(service.workspace_id.clone(), peer.service.clone())),
                    "Peer service {} is stopping",
                    peer.service
                );
                Ok(PeerTarget {
                    variable: variable.clone(),
                    port_variable: peer.port_variable.clone(),
                    service: target,
                })
            })
            .collect()
    }

    fn resolve_peer_targets(&self, targets: &[PeerTarget]) -> Result<BTreeMap<String, String>> {
        if targets.is_empty() {
            return Ok(BTreeMap::new());
        }
        let terminals = self.runtime.command(json!({"op":"terminal.list"}))?;
        let terminals = terminals["terminals"]
            .as_array()
            .context("Peer terminal catalogue is unavailable")?;
        let listeners = listeners::observe().context("Peer listener observation is unavailable")?;
        let reachable = |entry: &listeners::Listener, family: listeners::IpFamily| {
            entry.family == family
                && match family {
                    listeners::IpFamily::V4 => {
                        matches!(entry.address.as_str(), "127.0.0.1" | "0.0.0.0" | "*")
                    }
                    listeners::IpFamily::V6 => {
                        matches!(entry.address.as_str(), "::1" | "::" | "*")
                    }
                }
        };
        let mut resolved = BTreeMap::new();
        for target in targets {
            let peer = &target.service;
            let port = peer.ports[&target.port_variable];
            let owner = peer
                .terminal_owner
                .as_ref()
                .with_context(|| format!("Peer service {} is stopped", peer.name))?;
            ensure!(
                owner.runtime_instance == self.runtime.instance,
                "Peer service {} belongs to an unavailable runtime",
                peer.name
            );
            let terminal = terminals
                .iter()
                .find(|entry| entry["workspace"]["terminal_id"] == owner.terminal_id)
                .with_context(|| format!("Peer service {} has no live terminal", peer.name))?;
            let metrics = &terminal["metrics"];
            ensure!(
                metrics["shell_running"] == true
                    && metrics["transfer_id"] == owner.transfer_id
                    && metrics["shell_pid"].as_u64().is_some(),
                "Peer service {} execution identity is unavailable",
                peer.name
            );
            let pid = u32::try_from(metrics["shell_pid"].as_u64().unwrap())?;
            let address = [
                (listeners::IpFamily::V4, "127.0.0.1"),
                (listeners::IpFamily::V6, "[::1]"),
            ]
            .into_iter()
            .find_map(|(family, address)| {
                let own = listeners.iter().any(|entry| {
                    entry.pid == pid && entry.port == port && reachable(entry, family)
                });
                let other = listeners.iter().any(|entry| {
                    entry.pid != pid && entry.port == port && reachable(entry, family)
                });
                (own && !other).then_some(address)
            })
            .with_context(|| {
                format!(
                    "Peer service {} does not own a verified loopback listener on {}",
                    peer.name, target.port_variable
                )
            })?;
            resolved.insert(target.variable.clone(), format!("http://{address}:{port}"));
        }
        Ok(resolved)
    }

    fn start_service(&self, workspace: &str, name: &str) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        ensure!(!d.draining, "Application daemon is restarting");
        d.store.ensure_workspace_bound(workspace)?;
        let mut w = d.store.workspace(workspace)?;
        let before = d.store.service(workspace, name)?;
        if let Some(owner) = &before.terminal_owner {
            ensure!(
                owner.runtime_instance == self.runtime.instance,
                "Service supervisor was replaced; stop the service before starting a new run"
            );
            let state = self.runtime.command(json!({"op":"terminal.list"}))?;
            let terminal = state["terminals"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item["workspace"]["terminal_id"] == owner.terminal_id)
                })
                .context("Service terminal is unavailable; stop the prior run before restarting")?;
            ensure!(
                terminal["metrics"]["transfer_id"] == owner.transfer_id,
                "Service terminal ownership changed"
            );
            ensure!(
                terminal["metrics"]["shell_running"] == true,
                "Service exited; stop the prior run before restarting"
            );
            return Ok(
                json!({"type":"service","service":before,"terminal_id":owner.terminal_id,
                "metrics":terminal["metrics"],"effective_peers":before.launch_peers}),
            );
        }
        let targets = Self::peer_targets(&d, &before)?;
        let peer_endpoints = self.resolve_peer_targets(&targets)?;
        let lease = self.worktrees.agent_lease(&w.root)?;
        if before.terminal_owner.is_none() {
            before.config.directory(&w.root)?;
            before.check_ports()?;
            if let Some(terminal) = &before.terminal_id {
                self.runtime.command(
                    json!({"op":"terminal.retire","workspace_id":workspace,"terminal_id":terminal}),
                )?;
            }
        }
        let service =
            d.store
                .reserve_service(workspace, name, &self.runtime.instance, &peer_endpoints)?;
        d.health_samples
            .remove(&(workspace.to_owned(), name.to_owned()));
        d.health_attempts
            .remove(&(workspace.to_owned(), name.to_owned()));
        let owner = service.terminal_owner.as_ref().unwrap().clone();
        ensure!(
            owner.runtime_instance == self.runtime.instance,
            "Service supervisor was replaced; stop the service before starting a new run"
        );
        d.terminal_leases.insert(owner.terminal_id.clone(), lease);
        self.catalog_changed(&mut d)?;
        let launch = service.launch(&w.root, &peer_endpoints)?;
        w.terminal_id = owner.terminal_id.clone();
        let result = self.runtime.command(json!({"op":"terminal.launch","workspace":w,"terminal_key":owner.terminal_id,"launch":launch,"session_subscribers":self.subscribers.load(Ordering::Relaxed)}))?;
        ensure!(
            result["metrics"]["transfer_id"] == owner.transfer_id,
            "Service launch returned another transfer identity"
        );
        self.publish(
            &mut d,
            json!({"type":"service_changed","service":service,"metrics":result["metrics"]}),
        );
        Ok(
            json!({"type":"service","service":service,"terminal_id":owner.terminal_id,
                "metrics":result["metrics"],"effective_peers":peer_endpoints}),
        )
    }
    fn stop_service(&self, workspace: &str, name: &str) -> Result<Value> {
        let owner = {
            let mut d = self.data.lock().unwrap();
            ensure!(!d.draining, "Application daemon is restarting");
            let service = d.store.service(workspace, name)?;
            let Some(owner) = service.terminal_owner else {
                return Ok(json!({"type":"service","service":service}));
            };
            ensure!(
                d.stopping_services
                    .insert((workspace.to_owned(), name.to_owned())),
                "Service stop is already in progress"
            );
            owner
        };
        let _stop_guard = ServiceStopGuard {
            sessions: self,
            key: (workspace.to_owned(), name.to_owned()),
        };
        // Do not hold the application state lock while waiting for process reap.
        // The durable reservation fences editing, removal and replacement runs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut sent = false;
        loop {
            let state = self.runtime.command(json!({"op":"terminal.list"}))?;
            let terminal = state["terminals"]
                .as_array()
                .context("Invalid terminal catalogue")?
                .iter()
                .find(|t| t["workspace"]["terminal_id"] == owner.terminal_id);
            let Some(terminal) = terminal else {
                break;
            };
            ensure!(
                owner.runtime_instance == self.runtime.instance
                    && terminal["metrics"]["transfer_id"] == owner.transfer_id,
                "Service terminal ownership changed"
            );
            if terminal["metrics"]["shell_running"] == false {
                break;
            }
            if !sent {
                self.runtime.command(json!({"op":"terminal.stop","workspace_id":workspace,"terminal_id":owner.terminal_id}))?;
                sent = true;
            }
            ensure!(
                std::time::Instant::now() < deadline,
                "Service has not exited; retry stop to confirm cleanup"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.draining,
            "Application daemon is restarting; retry service stop"
        );
        let current = d.store.service(workspace, name)?;
        if current.terminal_owner.is_none() {
            return Ok(json!({"type":"service","service":current}));
        }
        let service = d.store.release_service(workspace, name, &owner)?;
        d.health_samples
            .remove(&(workspace.to_owned(), name.to_owned()));
        d.health_attempts
            .remove(&(workspace.to_owned(), name.to_owned()));
        d.terminal_leases.remove(&owner.terminal_id);
        self.publish(&mut d, json!({"type":"service_changed","service":service}));
        Ok(json!({"type":"service","service":service}))
    }
    fn send(
        self: &Arc<Self>,
        id: &str,
        key: &str,
        text: &str,
        attachments: &[crate::model::Attachment],
        queued: bool,
    ) -> Result<()> {
        ensure!(text.len() <= 64 * 1024, "Prompt exceeds 64 KiB");
        let workspace_id = self
            .data
            .lock()
            .unwrap()
            .store
            .conversation(id)?
            .workspace_id;
        self.ensure_workspace_bound(&workspace_id)?;
        let (c, run, rpc, prompt) = {
            let mut d = self.data.lock().unwrap();
            ensure!(
                !d.draining,
                "Application daemon is restarting; prompt remains queued"
            );
            d.store.guard_send_intent(id, key, text, attachments)?;
            let current = d.store.conversation(id)?;
            Self::ensure_account_current(
                &d,
                &current,
                d.agents.get(id).and_then(|agent| agent.account_generation),
            )?;
            ensure!(
                d.agents.contains_key(id) || d.agents.len() < 16,
                "Limit of 16 connected Agents reached"
            );
            // Reconcile the provider history before accepting any new prompt after reconnect.
            // An idempotent retry of an already accepted submission still succeeds.
            if !d.agents.contains_key(id) && d.store.conversation(id)?.provider_thread_id.is_some()
            {
                let existing = d.store.message(key)?;
                ensure!(
                    existing.is_some_and(|m| m.conversation_id == id
                        && m.role == "user"
                        && m.text == text
                        && m.attachments == attachments),
                    "Resume this Conversation before sending another prompt"
                );
            }
            let workspace = d.store.workspace(&d.store.conversation(id)?.workspace_id)?;
            d.store.ensure_workspace_bound(&workspace.id)?;
            let lease = self.worktrees.agent_lease(&workspace.root)?;
            let prompt = d.store.prompt(id, text, attachments)?;
            let mut begin = d
                .store
                .begin_content_turn(id, key, text, attachments, queued)?;
            if begin.duplicate {
                return Ok(());
            }
            let run = d.agents.entry(id.into()).or_insert_with(|| Agent {
                run_id: new_id("run"),
                rpc: None,
                submission: None,
                account_generation: None,
                _lease: lease,
            });
            run.submission = Some(key.into());
            begin.conversation.runtime_run = Some(run.run_id.clone());
            begin.conversation.runtime_submission = Some(key.into());
            if run.rpc.is_none() {
                begin.conversation.runtime_cursor = 0;
            }
            let result = (
                begin.conversation.clone(),
                run.run_id.clone(),
                run.rpc.clone(),
                prompt,
            );
            d.store.commit_conversation(&begin.conversation, &[], &[])?;
            self.changed(&mut d, &begin.conversation, &[begin.message])?;
            result
        };
        let hub = self.clone();
        let key = key.to_owned();
        std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                let rpc = match rpc {
                    Some(rpc) => rpc,
                    None => hub.connect_agent(&c.id, &run)?,
                };
                {
                    let d = hub.data.lock().unwrap();
                    ensure!(Self::owns(&d, &c.id, &run), "Agent was cancelled");
                }
                let thread = hub
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .conversation(&c.id)?
                    .provider_thread_id
                    .ok_or_else(|| anyhow!("Missing provider Conversation"))?;
                let message_id = {
                    let d = hub.data.lock().unwrap();
                    ensure!(
                        Self::owns(&d, &c.id, &run)
                            && d.agents[&c.id].submission.as_deref() == Some(&key),
                        "Agent submission was cancelled"
                    );
                    let current = d.store.conversation(&c.id)?;
                    Self::ensure_account_current(&d, &current, d.agents[&c.id].account_generation)?;
                    let mut message = d
                        .store
                        .message(&key)?
                        .ok_or_else(|| anyhow!("Missing submission"))?;
                    if message.provider_item_id.is_none() {
                        message.provider_item_id = rpc.prepare_submission();
                        let current = d.store.conversation(&c.id)?;
                        d.store
                            .commit_conversation(&current, &[message.clone()], &[])?;
                    }
                    message.provider_item_id
                };
                let turn = rpc.send(&thread, &key, message_id.as_deref(), &prompt)?;
                let mut d = hub.data.lock().unwrap();
                if !Self::owns(&d, &c.id, &run)
                    || d.agents[&c.id].submission.as_deref() != Some(&key)
                {
                    return Ok(());
                }
                let mut current = d.store.conversation(&c.id)?;
                // Notification may arrive before the RPC response. Never regress a completed turn.
                if current.status == "starting" {
                    current.status = "running".into();
                    current.active_turn_id = Some(turn);
                    current.updated_at = now_ms();
                    d.store.commit_conversation(&current, &[], &[])?;
                    hub.changed(&mut d, &current, &[])?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                hub.fail_if(&c.id, &run, error.to_string(), Some(&key));
            }
        });
        Ok(())
    }
    fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let clear_view = {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(id)?;
            Self::ensure_account_current(
                &d,
                &c,
                d.agents.get(id).and_then(|agent| agent.account_generation),
            )?;
            !d.agents.contains_key(id) && c.view_terminal.is_some()
        };
        if clear_view {
            self.clear_view_terminal(id)?;
        }
        let run = {
            let mut d = self.data.lock().unwrap();
            let mut c = d.store.conversation(id)?;
            Self::ensure_account_current(
                &d,
                &c,
                d.agents.get(id).and_then(|agent| agent.account_generation),
            )?;
            ensure!(
                c.terminal_owner.is_none(),
                "Return this Conversation from its terminal before resuming"
            );
            if let Some(agent) = d.agents.get(id) {
                ensure!(
                    agent.rpc.is_some()
                        && !matches!(
                            c.status.as_str(),
                            "starting" | "running" | "waiting" | "cancelling"
                        ),
                    "Agent already has an active operation"
                );
                c.status = "ready".into();
                c.error = None;
                c.updated_at = now_ms();
                d.store.commit_conversation(&c, &[], &[])?;
                self.changed(&mut d, &c, &[])?;
                return Ok(());
            }
            ensure!(d.agents.len() < 16, "Limit of 16 connected Agents reached");
            let workspace = d.store.workspace(&c.workspace_id)?;
            d.store.ensure_workspace_bound(&workspace.id)?;
            let lease = self.worktrees.agent_lease(&workspace.root)?;
            c.status = "starting".into();
            c.error = None;
            c.updated_at = now_ms();
            let run = new_id("run");
            c.runtime_run = Some(run.clone());
            c.runtime_cursor = 0;
            c.runtime_submission = None;
            d.store.commit_conversation(&c, &[], &[])?;
            d.agents.insert(
                id.into(),
                Agent {
                    run_id: run.clone(),
                    rpc: None,
                    submission: None,
                    account_generation: None,
                    _lease: lease,
                },
            );
            self.changed(&mut d, &c, &[])?;
            run
        };
        let hub = self.clone();
        let id = id.to_owned();
        std::thread::spawn(move || match hub.connect_agent(&id, &run) {
            Ok(_) => {
                let result = (|| -> Result<()> {
                    let mut d = hub.data.lock().unwrap();
                    if !Self::owns(&d, &id, &run) {
                        return Ok(());
                    }
                    let mut c = d.store.conversation(&id)?;
                    if c.status == "starting" {
                        c.status = "ready".into();
                    }
                    c.updated_at = now_ms();
                    d.store.commit_conversation(&c, &[], &[])?;
                    hub.changed(&mut d, &c, &[])
                })();
                if let Err(error) = result {
                    hub.fail(&id, &run, error.to_string());
                }
            }
            Err(error) => hub.fail(&id, &run, error.to_string()),
        });
        Ok(())
    }
    fn owns(d: &Data, id: &str, run: &str) -> bool {
        d.agents.get(id).is_some_and(|a| a.run_id == run)
    }
    fn ensure_account_current(
        d: &Data,
        conversation: &Conversation,
        expected_generation: Option<u64>,
    ) -> Result<()> {
        let Some(id) = conversation.account_id.as_deref() else {
            return Ok(());
        };
        let account = d.store.account(id)?;
        ensure!(
            account.provider == conversation.provider && account.state == "verified",
            "Conversation account is not verified"
        );
        ensure!(
            expected_generation.is_none_or(|generation| generation == account.generation),
            "Conversation account changed since the Agent connected"
        );
        Ok(())
    }
    fn connect_agent(self: &Arc<Self>, id: &str, run: &str) -> Result<Arc<dyn Provider>> {
        self.attach_agent(id, run, false)
    }
    fn attach_agent(
        self: &Arc<Self>,
        id: &str,
        run: &str,
        restore: bool,
    ) -> Result<Arc<dyn Provider>> {
        let (c, w, account) = {
            let d = self.data.lock().unwrap();
            ensure!(Self::owns(&d, id, run), "Agent was cancelled");
            let c = d.store.conversation(id)?;
            let w = d.store.workspace(&c.workspace_id)?;
            let account = c
                .account_id
                .as_deref()
                .map(|account_id| {
                    let account = d.store.account(account_id)?;
                    ensure!(
                        account.provider == c.provider,
                        "Conversation account belongs to another provider"
                    );
                    ensure!(
                        account.state == "verified",
                        "Conversation account is not verified"
                    );
                    if c.provider == "claude" {
                        ensure!(
                            c.provider_config.setting_sources.is_empty(),
                            "Managed Claude conversations cannot load settings sources"
                        );
                        ensure!(
                            account.claude_identity.is_some(),
                            "Claude account identity is not pinned"
                        );
                    }
                    if c.provider == "codex" {
                        ensure!(
                            account.codex_identity.is_some(),
                            "Codex account identity is not pinned"
                        );
                    }
                    if c.provider == "omp" {
                        ensure!(
                            account.omp_identity.is_some(),
                            "Oh My Pi account identity is not pinned"
                        );
                    }
                    Ok::<_, anyhow::Error>(ade_core::model::AccountExecution {
                        id: account.id,
                        provider: account.provider,
                        native_home: account.native_home,
                        generation: account.generation,
                        claude_identity: account.claude_identity,
                        codex_identity: account.codex_identity,
                        omp_identity: account.omp_identity,
                    })
                })
                .transpose()?;
            (c, w, account)
        };
        ensure!(
            Path::new(&w.root).is_dir(),
            "Workspace directory is unavailable: {}",
            w.root
        );
        let rpc = Remote::new(
            self.runtime.clone(),
            Spec {
                conversation: id.into(),
                run: run.into(),
                provider: c.provider.clone(),
                root: w.root,
                account,
            },
        );
        if !restore {
            rpc.create()?;
        }
        let pre_open = (|| -> Result<()> {
            let mut d = self.data.lock().unwrap();
            ensure!(Self::owns(&d, id, run), "Agent was cancelled");
            if restore {
                ensure!(
                    d.agents[id].account_generation
                        == rpc.spec.account.as_ref().map(|account| account.generation),
                    "Account changed before runtime Agent recovery"
                );
            }
            if let Some(expected) = &rpc.spec.account {
                let current = d.store.account(&expected.id)?;
                ensure!(
                    current.state == "verified"
                        && current.generation == expected.generation
                        && current.provider == expected.provider
                        && current.claude_identity == expected.claude_identity
                        && current.codex_identity == expected.codex_identity
                        && current.omp_identity == expected.omp_identity,
                    "Account changed before provider session opened"
                );
            }
            let agent = d.agents.get_mut(id).unwrap();
            agent.account_generation = rpc.spec.account.as_ref().map(|account| account.generation);
            agent.rpc = Some(rpc.clone());
            Ok(())
        })();
        if let Err(error) = pre_open {
            rpc.stop();
            return Err(error);
        }
        let connected = if restore {
            rpc.connected()?
        } else {
            rpc.open(c.provider_thread_id.as_deref(), &c.provider_config)?
        };
        {
            let mut d = self.data.lock().unwrap();
            ensure!(Self::owns(&d, id, run), "Agent was cancelled");
            let mut current = d.store.conversation(id)?;
            ensure!(
                current
                    .provider_thread_id
                    .as_ref()
                    .is_none_or(|id| id == &connected.session),
                "Runtime provider identity changed"
            );
            let needs_history = !restore || current.provider_thread_id.is_none();
            current.provider_thread_id = Some(connected.session);
            current.error = None;
            current.updated_at = now_ms();
            let messages: Vec<_> = if needs_history {
                connected
                    .history
                    .iter()
                    .map(|item| item.message(id))
                    .collect()
            } else {
                vec![]
            };
            d.store.commit_conversation(&current, &messages, &[])?;
            self.publish(
                &mut d,
                json!({"type":"conversation_reload","conversation":current}),
            );
        }
        let hub = Arc::downgrade(self);
        let event_id = id.to_owned();
        let event_run = run.to_owned();
        let remote = rpc.clone();
        std::thread::spawn(move || {
            let mut cursor = c.runtime_cursor;
            let mut acknowledge = None;
            loop {
                let Some(hub) = hub.upgrade() else { break };
                if !Self::owns(&hub.data.lock().unwrap(), &event_id, &event_run) {
                    break;
                }
                let result = (|| -> Result<Vec<Envelope>> {
                    if let Some(cursor) = acknowledge {
                        remote.acknowledge(cursor)?;
                        acknowledge = None;
                    }
                    remote.events(cursor)
                })();
                let batch = match result {
                    Ok(batch) => {
                        hub.runtime_connection(&event_id, &event_run, false);
                        batch
                    }
                    Err(error) => {
                        if hub.runtime.draining() {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            continue;
                        }
                        if hub.runtime.gone() {
                            hub.fail(&event_id, &event_run, "Runtime supervisor exited. Restart lux-ade, then resume this Conversation. No prompt was resent.".into());
                            break;
                        }
                        if error.downcast_ref::<crate::runtime::Rejected>().is_some() {
                            hub.fail(&event_id, &event_run, error.to_string());
                            break;
                        }
                        hub.runtime_connection(&event_id, &event_run, true);
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        continue;
                    }
                };
                if batch.is_empty() {
                    continue;
                }
                let next = batch.last().unwrap().sequence;
                if let Err(error) = hub.events(&event_id, &event_run, batch) {
                    hub.fail(&event_id, &event_run, error.to_string());
                    break;
                }
                cursor = next;
                // Retrying an acknowledgement is safe; a failed socket never advances
                // the cursor without committing the corresponding projection first.
                acknowledge = Some(cursor);
            }
        });
        Ok(rpc)
    }
    fn runtime_connection(&self, id: &str, run: &str, unavailable: bool) {
        const NOTICE: &str = "Runtime connection unavailable; reconnecting without resending work.";
        let result = (|| -> Result<()> {
            let mut d = self.data.lock().unwrap();
            if !Self::owns(&d, id, run) {
                return Ok(());
            }
            let mut c = d.store.conversation(id)?;
            if unavailable && c.error.is_none() {
                c.error = Some(NOTICE.into());
            } else if !unavailable && c.error.as_deref() == Some(NOTICE) {
                c.error = None;
            } else {
                return Ok(());
            }
            d.store.commit_conversation(&c, &[], &[])?;
            self.changed(&mut d, &c, &[])
        })();
        if let Err(error) = result {
            eprintln!("Could not persist runtime connection state: {error}");
        }
    }
    fn fail(&self, id: &str, run: &str, error: String) {
        self.fail_if(id, run, error, None);
    }
    fn fail_if(&self, id: &str, run: &str, error: String, submission: Option<&str>) {
        let error = if self.runtime.gone() {
            "Runtime supervisor exited. Restart lux-ade, then resume this Conversation. No prompt was resent.".into()
        } else {
            error
        };
        let result = (|| -> Result<()> {
            let mut d = self.data.lock().unwrap();
            if !Self::owns(&d, id, run)
                || submission.is_some_and(|key| d.agents[id].submission.as_deref() != Some(key))
            {
                return Ok(());
            }
            let agent = d.agents.remove(id).unwrap();
            if let Some(rpc) = agent.rpc {
                rpc.stop();
            }
            let mut c = d.store.conversation(id)?;
            c.status = "error".into();
            c.queue_paused = true;
            c.error = Some(error);
            c.active_turn_id = None;
            c.updated_at = now_ms();
            let mut requests = d.store.pending(id)?;
            for p in &mut requests {
                p.status = "interrupted".into();
            }
            d.store.commit_conversation(&c, &[], &requests)?;
            self.changed(&mut d, &c, &[])
        })();
        if let Err(error) = result {
            eprintln!("Could not persist Agent failure: {error}");
        }
    }
    fn events(&self, id: &str, run: &str, batch: Vec<Envelope>) -> Result<()> {
        let lock_started = std::time::Instant::now();
        let mut d = self.data.lock().unwrap();
        crate::bench::elapsed("event_lock_wait_us", lock_started);
        if !Self::owns(&d, id, run) {
            return Ok(());
        }
        let mut c = d.store.conversation(id)?;
        let mut changed = false;
        let mut order = Vec::new();
        let mut exit_error = None;
        let mut messages: HashMap<String, Message> = HashMap::new();
        let mut requests: HashMap<String, PendingRequest> = d
            .store
            .pending(id)?
            .into_iter()
            .map(|p| (p.id.clone(), p))
            .collect();
        for envelope in batch {
            if envelope.sequence <= c.runtime_cursor {
                continue;
            }
            ensure!(
                envelope.sequence == c.runtime_cursor + 1,
                "Agent event journal has a gap"
            );
            c.runtime_cursor = envelope.sequence;
            changed = true;
            match envelope.event {
                Event::OperationFailed { submission, error } => {
                    if submission
                        .as_ref()
                        .is_none_or(|s| c.runtime_submission.as_ref() == Some(s))
                    {
                        exit_error = Some(error);
                        break;
                    }
                }
                Event::Submitted { submission, turn } => {
                    if c.runtime_submission.as_deref() == Some(&submission)
                        && c.status == "starting"
                    {
                        c.status = "running".into();
                        c.active_turn_id = Some(turn);
                    }
                }
                Event::Exited { error } => {
                    exit_error = Some(error);
                    break;
                }
                Event::Request {
                    session,
                    turn,
                    id: rpc_id,
                    method,
                    mut params,
                    supported,
                } => {
                    let rpc = d.agents[id]
                        .rpc
                        .as_ref()
                        .ok_or_else(|| anyhow!("Missing Agent runtime"))?;
                    if !supported {
                        rpc.reject(rpc_id, &format!("lux-ade does not support {method}"))?;
                        c.error =
                            Some(format!("Agent requested unsupported interaction: {method}"));
                        changed = true;
                        continue;
                    }
                    if Some(session.as_str()) != c.provider_thread_id.as_deref()
                        || Some(turn.as_str()) != c.active_turn_id.as_deref()
                    {
                        rpc.reject(rpc_id, "Request does not belong to this Conversation")?;
                        continue;
                    }
                    params["threadId"] = json!(session);
                    params["turnId"] = json!(turn);
                    let p = PendingRequest {
                        id: new_id("request"),
                        conversation_id: id.into(),
                        run_id: run.into(),
                        rpc_id,
                        method,
                        params,
                        status: "pending".into(),
                    };
                    requests.insert(p.id.clone(), p);
                    c.status = "waiting".into();
                    changed = true;
                }
                Event::Started { session, turn } => {
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    c.active_turn_id = Some(turn);
                    c.status = "running".into();
                    c.error = None;
                    changed = true;
                }
                Event::Finished {
                    session,
                    turn,
                    status,
                    error,
                } => {
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    if c.active_turn_id.is_some() && c.active_turn_id.as_deref() != Some(&turn) {
                        continue;
                    }
                    c.status = match status.as_str() {
                        "failed" => "error",
                        "interrupted" => "interrupted",
                        _ => "ready",
                    }
                    .into();
                    c.error = error;
                    if c.status != "ready" {
                        c.queue_paused = true;
                    }
                    c.active_turn_id = None;
                    for r in requests.values_mut() {
                        if matches!(r.status.as_str(), "pending" | "responding")
                            && r.params["turnId"] == turn
                        {
                            r.status = "resolved".into();
                        }
                    }
                    changed = true;
                }
                Event::Item { session, item } => {
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    let m = item.message(id);
                    if !messages.contains_key(&m.id) {
                        order.push(m.id.clone());
                    }
                    messages.insert(m.id.clone(), m);
                    changed = true;
                }
                Event::Delta {
                    session,
                    turn,
                    id: item,
                    role,
                    kind,
                    text,
                } => {
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    let mid = format!("{id}:{item}");
                    if !messages.contains_key(&mid) {
                        let m = d.store.message(&mid)?.unwrap_or_else(|| Message {
                            content: None,
                            attachments: vec![],
                            id: mid.clone(),
                            conversation_id: id.into(),
                            role,
                            kind,
                            text: String::new(),
                            status: "streaming".into(),
                            turn_id: turn,
                            provider_item_id: Some(item),
                            sequence: 0,
                        });
                        order.push(mid.clone());
                        messages.insert(mid.clone(), m);
                    }
                    let m = messages.get_mut(&mid).unwrap();
                    m.text.push_str(&text);
                    if let Some(crate::transcript::Content::Tool { output, .. }) = &mut m.content {
                        output.get_or_insert_with(String::new).push_str(&text);
                    }
                    ensure!(m.text.len() <= 1024 * 1024, "Agent message exceeds 1 MiB");
                    changed = true;
                }
                Event::Resolved { id: request_id } => {
                    for r in requests.values_mut() {
                        if r.rpc_id == request_id {
                            r.status = "resolved".into();
                            changed = true;
                        }
                    }
                    if c.status == "waiting" && !requests.values().any(|r| r.status == "pending") {
                        c.status = "running".into();
                    }
                }
                Event::Error { error } => {
                    c.error = Some(error);
                    changed = true;
                }
            }
        }
        if changed {
            c.updated_at = now_ms();
            let messages: Vec<_> = order
                .into_iter()
                .filter_map(|id| messages.remove(&id))
                .collect();
            let requests: Vec<_> = requests.into_values().collect();
            persistence_result(d.store.commit_conversation(&c, &messages, &requests))?;
            let saved: Vec<_> = messages
                .iter()
                .filter_map(|m| d.store.message(&m.id).ok().flatten())
                .collect();
            self.changed(&mut d, &c, &saved)?;
        }
        drop(d);
        if let Some(error) = exit_error {
            self.fail(id, run, error);
        }
        Ok(())
    }
    fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
        let (run, rpc, thread, turn) = {
            let mut d = self.data.lock().unwrap();
            let mut c = d.store.conversation(id)?;
            ensure!(
                matches!(
                    c.status.as_str(),
                    "starting" | "running" | "waiting" | "cancelling"
                ),
                "Agent has no active turn"
            );
            let a = d
                .agents
                .get(id)
                .ok_or_else(|| anyhow!("Agent is not connected"))?;
            let run = a.run_id.clone();
            let rpc = a.rpc.clone();
            let thread = c.provider_thread_id.clone();
            let turn = c.active_turn_id.clone();
            c.status = "cancelling".into();
            c.queue_paused = true;
            d.store.commit_conversation(&c, &[], &[])?;
            self.changed(&mut d, &c, &[])?;
            (run, rpc, thread, turn)
        };
        if let (Some(rpc), Some(thread), Some(turn)) = (rpc, thread, turn) {
            let hub = self.clone();
            let id = id.to_owned();
            std::thread::spawn(move || {
                if let Err(error) = rpc.cancel(&thread, &turn) {
                    hub.fail(&id, &run, error.to_string());
                }
            });
        } else {
            self.fail(
                id,
                &run,
                "Cancelled while the Agent was starting; resume the Conversation to continue."
                    .into(),
            );
        }
        Ok(())
    }
    fn answer(
        &self,
        id: &str,
        request_id: &str,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        let d = self.data.lock().unwrap();
        let mut c = d.store.conversation(id)?;
        let mut p = d
            .store
            .pending(id)?
            .into_iter()
            .find(|p| p.id == request_id && p.status == "pending")
            .ok_or_else(|| anyhow!("Request is stale or already answered"))?;
        ensure!(
            Self::owns(&d, id, &p.run_id),
            "Request belongs to a previous Agent run"
        );
        ensure!(
            p.params["threadId"].as_str() == c.provider_thread_id.as_deref()
                && p.params["turnId"].as_str() == c.active_turn_id.as_deref(),
            "Request no longer belongs to the active turn"
        );
        let rpc = d.agents[id]
            .rpc
            .as_ref()
            .ok_or_else(|| anyhow!("Agent is unavailable"))?
            .clone();

        rpc.validate_answer(&p, decision, answers)?;
        p.status = "responding".into();
        d.store.commit_conversation(&c, &[], &[p.clone()])?;
        drop(d);
        if let Err(error) = rpc.answer(&p, decision, answers) {
            self.fail(id, &p.run_id, error.to_string());
            return Err(error);
        }
        let mut d = self.data.lock().unwrap();
        ensure!(
            Self::owns(&d, id, &p.run_id),
            "Agent disconnected while answering"
        );
        c = d.store.conversation(id)?;
        p.status = "resolved".into();
        if c.status == "waiting" && !d.store.pending(id)?.iter().any(|r| r.id != p.id) {
            c.status = "running".into();
        }
        c.updated_at = now_ms();
        d.store.commit_conversation(&c, &[], &[p])?;
        self.changed(&mut d, &c, &[])?;
        Ok(())
    }
}

/// Preserve actionable validation errors, but never expose raw database errors
/// (which may contain SQL values or paths) as a persistence failure.
fn persistence_result<T>(result: anyhow::Result<T>) -> anyhow::Result<T> {
    result.map_err(|error| {
        if error.downcast_ref::<rusqlite::Error>().is_some() {
            tracing::error!(target: "ade", event = "persistence_failed", code = "save_failed");
            ade_core::error::Failure::SaveFailed.into()
        } else {
            error
        }
    })
}
#[cfg(test)]
mod failure_tests {
    use super::*;
    #[test]
    fn readonly_database_failure_is_safe_and_not_reported_as_success() {
        let database = rusqlite::Connection::open_in_memory().unwrap();
        database
            .execute_batch("CREATE TABLE private_data (text TEXT); PRAGMA query_only=ON;")
            .unwrap();
        let result = database
            .execute("INSERT INTO private_data VALUES (?1)", ["secret prompt"])
            .map_err(anyhow::Error::from);
        let error = persistence_result(result).unwrap_err();
        assert_eq!(
            error.downcast_ref::<ade_core::error::Failure>(),
            Some(&ade_core::error::Failure::SaveFailed)
        );
        assert!(!error.to_string().contains("secret"));
        let rows: i64 = database
            .query_row("SELECT count(*) FROM private_data", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
    #[test]
    fn persistence_validation_errors_remain_actionable() {
        let error =
            persistence_result::<()>(Err(anyhow::anyhow!("Invalid draft revision"))).unwrap_err();
        assert_eq!(error.to_string(), "Invalid draft revision");
    }
}
