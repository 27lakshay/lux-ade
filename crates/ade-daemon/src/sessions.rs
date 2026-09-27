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
    store::{Store, probe_catalog_bindings},
};
use ade_core::runtime_protocol::{AgentOp, terminal::Command as TerminalCommand};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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

mod accounts;
mod activity;
mod agents;
mod checkpoints;
mod conversations;
mod devices;
mod imports;
mod inspection;
mod leases;
mod mcp;
mod orchestration;
mod remote;
mod retention;
mod services;
mod skills;
mod terminals;
mod workspaces;

use agents::{Agent, SendAdmission};
pub use inspection::{FEED_QUEUE_CAPACITY, SessionInspection};
use services::{HealthAttempt, HealthSample};
use workspaces::selected_binding;

/// Reads a required, non-empty string field from a session request.
fn required_str<'a>(request: &'a Value) -> impl Fn(&str) -> Result<&'a str> + 'a {
    move |key: &str| {
        request[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("Missing {key}"))
    }
}

/// Decodes a session request into its typed contract in `ade_core::contract`.
/// An absent field keeps the `Missing <field>` wording of [`required_str`].
fn decode<T: serde::de::DeserializeOwned>(request: &Value) -> Result<T> {
    T::deserialize(request).map_err(|error| {
        let text = error.to_string();
        match text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next())
        {
            Some(field) => anyhow!("Missing {field}"),
            None => anyhow!("Invalid request: {text}"),
        }
    })
}

/// Rejects an empty identifier, as [`required_str`] does.
fn non_empty<'a>(field: &str, value: &'a str) -> Result<&'a str> {
    ensure!(!value.is_empty(), "Missing {field}");
    Ok(value)
}

/// Serializes a typed contract reply.
fn reply<T: serde::Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

struct Data {
    draining: bool,
    store: Store,
    agents: HashMap<String, Agent>,
    terminal_leases: HashMap<String, crate::worktrees::Lease>,
    /// Leases a restart could not resolve; they refuse conflicting admission.
    unresolved: HashMap<leases::LeaseKey, leases::Unresolved>,
    stopping_services: HashSet<(String, String)>,
    health_samples: HashMap<(String, String), HealthSample>,
    health_attempts: HashMap<(String, String), HealthAttempt>,
    active_health_samples: usize,
    subscribers: HashMap<String, mpsc::SyncSender<Value>>,
    revision: u64,
    /// The last activity sequence published as a feed frame.
    activity_published: Option<u64>,
}
pub struct Sessions {
    pub review: Arc<crate::review::Review>,
    history: Arc<crate::history::History>,
    usage: Arc<crate::usage::Usage>,
    pub worktrees: Arc<crate::worktrees::Worktrees>,
    /// The plugin registry, or why it could not open. Its failure never blocks the core.
    plugins: std::result::Result<crate::plugins::Plugins, String>,
    files: crate::files::Files,
    data: Mutex<Data>,
    pub subscribers: Arc<AtomicUsize>,
    pub boot_id: String,
    runtime: Arc<Supervisor>,
    queue_wake: mpsc::SyncSender<()>,
    counters: inspection::Counters,
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
        let plugins = crate::plugins::Plugins::open(
            &path.with_extension("plugins.sqlite3"),
            &path.with_extension("plugins"),
        )
        .map_err(|error| format!("{error:#}"));
        let history = crate::history::History::open(path)?;
        let usage = crate::usage::Usage::open(path)?;
        let sessions = Arc::new(Self {
            history,
            usage,
            runtime,
            queue_wake,
            counters: inspection::Counters::default(),
            worktrees,
            review,
            plugins,
            files: crate::files::Files::new(),
            data: Mutex::new(Data {
                draining: false,
                store,
                agents: HashMap::new(),
                terminal_leases: HashMap::new(),
                unresolved: HashMap::new(),
                stopping_services: HashSet::new(),
                health_samples: HashMap::new(),
                health_attempts: HashMap::new(),
                active_health_samples: 0,
                subscribers: HashMap::new(),
                revision: 0,
                activity_published: None,
            }),
            subscribers: Arc::new(AtomicUsize::new(0)),
            boot_id: new_id("boot"),
        });
        sessions.restore()?;
        sessions.start_activity_feed()?;
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
                if let Err(error) = hub.reconcile_unresolved() {
                    eprintln!("Session lease reconciliation: {error}");
                }
                if let Err(error) = hub.sample_due_service_health() {
                    eprintln!("Service health monitor: {error}");
                }
                if let Err(error) = hub.flush_activity(&mut hub.data.lock().unwrap()) {
                    eprintln!("Activity feed: {error}");
                }
            }
        });
        sessions.start_retention_schedule();
        sessions.wake_queue();
        Ok(sessions)
    }
    fn release_exited_script_leases(&self) -> Result<()> {
        let catalogue = self.runtime.command(TerminalCommand::List)?;
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
        self.wake_queue();
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
        // Reconcile every persisted lease against the runtime before any
        // admission: script runs (durable workspace terminal membership),
        // service reservations and Agent runs. See `leases::decide`.
        let terminals = leases::observe_terminals(&self.runtime.command(TerminalCommand::List)?)?;
        let agent_records = leases::observe_agents(&self.runtime.agent(AgentOp::List)?)?;
        let mut live = HashSet::new();
        let mut runs = Vec::new();
        {
            let mut d = self.data.lock().unwrap();
            let catalog = d.store.catalog()?;
            let mut claims = Vec::new();
            for workspace in &catalog.workspaces {
                if d.store.ensure_workspace_bound(&workspace.id).is_err() {
                    continue;
                }
                for run_id in workspace
                    .extra_terminals
                    .iter()
                    .filter(|id| ade_core::scripts::run_name(id).is_ok())
                {
                    claims.push(leases::Claim {
                        key: leases::LeaseKey::Script {
                            workspace_id: workspace.id.clone(),
                            run_id: run_id.clone(),
                        },
                        workspace_id: workspace.id.clone(),
                        root: workspace.root.clone(),
                        holder: leases::Holder::Terminal {
                            terminal_id: run_id.clone(),
                            transfer_id: None,
                            runtime_instance: None,
                        },
                    });
                }
                for service in d.store.services(&workspace.id)? {
                    if let Some(owner) = service.terminal_owner {
                        claims.push(leases::Claim {
                            key: leases::LeaseKey::Service {
                                workspace_id: workspace.id.clone(),
                                name: service.name.clone(),
                            },
                            workspace_id: workspace.id.clone(),
                            root: workspace.root.clone(),
                            holder: leases::Holder::Terminal {
                                terminal_id: owner.terminal_id,
                                transfer_id: Some(owner.transfer_id),
                                runtime_instance: Some(owner.runtime_instance),
                            },
                        });
                    }
                }
            }
            // A Conversation handed to a terminal holds that terminal's lease;
            // its runtime Agent, if any, is covered by it.
            let mut records = HashMap::new();
            let mut observed_agents = Vec::new();
            for (agent, spec, commands) in agent_records {
                if let Ok(c) = d.store.conversation(&agent.conversation_id) {
                    let w = d.store.workspace(&c.workspace_id)?;
                    d.store.ensure_workspace_bound(&w.id)?;
                    if c.terminal_owner.is_some() {
                        continue;
                    }
                }
                records.insert(agent.conversation_id.clone(), (spec, commands));
                observed_agents.push(agent);
            }
            for c in &catalog.conversations {
                if d.store.ensure_workspace_bound(&c.workspace_id).is_err() {
                    continue;
                }
                let w = d.store.workspace(&c.workspace_id)?;
                if c.terminal_owner.is_some() {
                    d.terminal_leases
                        .insert(c.id.clone(), self.worktrees.lease(&w.root)?);
                    continue;
                }
                if c.runtime_run.is_some() || records.contains_key(&c.id) {
                    claims.push(leases::Claim {
                        key: leases::LeaseKey::Agent(c.id.clone()),
                        workspace_id: w.id.clone(),
                        root: w.root.clone(),
                        holder: leases::Holder::Agent {
                            run: c.runtime_run.clone(),
                            provider: c.provider.clone(),
                            account: c.account_id.clone(),
                        },
                    });
                }
            }
            let observed = leases::Observation {
                runtime_instance: self.runtime.instance.clone(),
                terminals,
                agents: Some(observed_agents),
            };
            let mut uncertain_agents = Vec::new();
            for (claim, verdict) in leases::reconcile(&claims, &observed) {
                use leases::{Holder, LeaseKey, Release, Verdict};
                match (&claim.key, &claim.holder, verdict) {
                    (_, _, Verdict::Uncertain(reason)) => {
                        if let LeaseKey::Agent(id) = &claim.key {
                            uncertain_agents.push((id.clone(), reason.clone()));
                        }
                        self.hold_unresolved(&mut d, claim, reason);
                    }
                    (LeaseKey::Script { run_id, .. }, _, Verdict::Live) => {
                        d.terminal_leases
                            .insert(run_id.clone(), self.worktrees.lease(&claim.root)?);
                    }
                    (LeaseKey::Script { .. }, _, Verdict::Released(Release::Exited)) => {}
                    (
                        LeaseKey::Script {
                            workspace_id,
                            run_id,
                        },
                        _,
                        Verdict::Released(Release::Absent),
                    ) => d.store.retire_script_run(workspace_id, run_id)?,
                    // The durable service reservation keeps its worktree lease
                    // until service.stop releases it, whether or not it runs.
                    (LeaseKey::Service { .. }, Holder::Terminal { terminal_id, .. }, _) => {
                        d.terminal_leases
                            .insert(terminal_id.clone(), self.worktrees.lease(&claim.root)?);
                    }
                    (LeaseKey::Agent(id), _, Verdict::Live) => {
                        let (spec, commands) =
                            records.remove(id).context("Invalid Agent catalogue")?;
                        let c = d.store.conversation(id)?;
                        let lease = self.worktrees.lease(&claim.root)?;
                        live.insert(id.clone());
                        d.agents.insert(
                            id.clone(),
                            Agent {
                                run_id: spec.run.clone(),
                                rpc: None,
                                submission: c.runtime_submission.clone(),
                                account_generation: spec
                                    .account
                                    .as_ref()
                                    .map(|account| account.generation),
                                _lease: lease,
                            },
                        );
                        runs.push((spec, commands));
                    }
                    // recover_except marks a Conversation whose run is gone interrupted.
                    (LeaseKey::Agent(_), _, Verdict::Released(_)) => {}
                    (LeaseKey::Service { .. }, Holder::Agent { .. }, _) => {
                        bail!("Invalid service lease")
                    }
                }
            }
            d.store.recover_except(&live)?;
            for (id, reason) in uncertain_agents {
                let Ok(mut c) = d.store.conversation(&id) else {
                    continue;
                };
                c.queue_paused = true;
                c.error = Some(format!(
                    "Execution ownership is unresolved after a daemon restart: {reason}. ADE will not start another run until the runtime run stops."
                ));
                d.store.commit_conversation(&c, &[], &[])?;
            }
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
                                .contains(&json!(p.answer_command_key()))
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
    fn publish(&self, d: &mut Data, mut event: Value) {
        d.revision += 1;
        event["revision"] = json!(d.revision);
        event["boot_id"] = json!(self.boot_id);
        d.subscribers
            .retain(|_, tx| self.deliver(tx, event.clone()));
        self.subscribers
            .store(d.subscribers.len(), Ordering::Relaxed);
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
        if let Err(error) = self.flush_activity(d) {
            eprintln!("Activity feed: {error}");
        }
        let _ = self.queue_wake.try_send(());
        self.wake_queue();
        Ok(())
    }
    pub fn subscribe(&self) -> Result<(String, mpsc::Receiver<Value>)> {
        let (tx, rx) = mpsc::sync_channel(128);
        let id = new_id("subscriber");
        for _ in 0..3 {
            let (catalog, revision) = self.live_catalog()?;
            let mut d = self.data.lock().unwrap();
            if d.revision != revision {
                continue;
            }
            tx.send(reply(&ade_core::contract::workspaces::CatalogFrame {
                tag: Default::default(),
                catalog,
                providers: provider::descriptors().to_vec(),
                boot_id: self.boot_id.clone(),
                revision,
            })?)?;
            d.subscribers.insert(id.clone(), tx);
            self.subscribers
                .store(d.subscribers.len(), Ordering::Relaxed);
            return Ok((id, rx));
        }
        Err(anyhow!("Catalog changed during subscription; retry"))
    }
    pub fn unsubscribe(&self, id: &str) {
        let mut d = self.data.lock().unwrap();
        d.subscribers.remove(id);
        self.subscribers
            .store(d.subscribers.len(), Ordering::Relaxed);
    }
    pub fn command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let string = required_str(request);
        let op = request["op"].as_str().unwrap_or("");
        if op.starts_with("plugin.") {
            return match &self.plugins {
                Ok(plugins) => plugins.command(request),
                Err(error) => Err(anyhow!("Plugin registry is unavailable: {error}")),
            };
        }
        if op.starts_with("worktree.")
            && op != "worktree.operation"
            && op != "worktree.rebind"
            && op != "worktree.rebind.list"
            && self.data.lock().unwrap().store.has_pending_rebind()?
        {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if op.starts_with("skill.") {
            return self.skill_command(request);
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
        if op.starts_with("history.import.") {
            return self.history_import_command(request);
        }
        if op.starts_with("history.") {
            return self.history.command(request);
        }
        if op.starts_with("usage.") {
            return self.usage.command(request);
        }
        if op == "review.feedback.search" {
            let data = self.data.lock().unwrap();
            return crate::review::feedback_search(&data.store, request);
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
                Self::ensure_scripts_resolved(&d, &workspace.id)?;
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
                self.settle_unresolved(
                    &mut d,
                    &leases::LeaseKey::Script {
                        workspace_id: workspace.id.clone(),
                        run_id: run_id.to_owned(),
                    },
                );
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
            "service.start"
            | "service.stop"
            | "service.health.sample"
            | "service.inspect"
            | "listener.list"
            | "service.list"
            | "service.configure"
            | "service.remove" => self.service_command(request),
            "provider.list" | "account.list" | "account.create" | "account.inspect"
            | "account.verify" | "account.disable" => self.account_command(request),
            "catalog.get"
            | "workspace.rebind.list"
            | "repository.rebind.list"
            | "workspace.open"
            | "repository.rebind"
            | "workspace.rebind" => self.workspace_command(request),
            "terminal.create" | "terminal.operation" => self.terminal_command(request),
            "resources.inspect" | "resources.claim.resolve" | "resources.registry.accept" => {
                self.worktrees.resources_command(request)
            }
            "activity.list"
            | "activity.mark"
            | "notification.delivery.claim"
            | "notification.delivery.report"
            | "notification.delivery.list" => self.activity_command(request),
            op if op.starts_with("mcp.") => self.mcp_command(request),
            op if op.starts_with("checkpoint.") => self.checkpoint_command(request),
            op if op.starts_with("remote.") => self.remote_command(request),
            "attachment.inspect"
            | "attachment.reclaim.preview"
            | "attachment.reclaim.apply"
            | "attachment.import"
            | "attachment.put"
            | "conversation.create"
            | "conversation.get"
            | "agent.child_transcript"
            | "draft.get"
            | "draft.save"
            | "draft.send.get"
            | "draft.send.prepare"
            | "draft.send.complete"
            | "draft.send.abort"
            | "draft.send.list"
            | "draft.send.acknowledge"
            | "agent.send"
            | "agent.send_review"
            | "queue.enqueue"
            | "queue.cancel"
            | "queue.pause"
            | "agent.disconnect"
            | "agent.resume"
            | "agent.cancel"
            | "agent.answer"
            | "window.save"
            | "window.close" => self.conversation_command(request),
            op if op.starts_with("orchestration.") => self.orchestration_command(request),
            op if op.starts_with("retention.") => self.retention_command(request),
            op if op.starts_with("device.") => self.device_command(request),
            _ => bail!("Unknown session operation"),
        }
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
