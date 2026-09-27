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
mod agents;
mod conversations;
mod services;
mod terminals;
mod workspaces;

use agents::{Agent, SendAdmission};
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
            .retain(|_, tx| tx.try_send(event.clone()).is_ok());
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
        let _ = self.queue_wake.try_send(());
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
            tx.send(json!({"type":"catalog","catalog":catalog,"providers":provider::descriptors(),"boot_id":self.boot_id,"revision":revision}))?;
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
        if op == "review.feedback.search" {
            let limit = request
                .get("limit")
                .map(|value| value.as_u64().context("Invalid review search limit"))
                .transpose()?
                .unwrap_or(20);
            ensure!(
                (1..=50).contains(&limit),
                "Review search limit must be 1 to 50"
            );
            let data = self.data.lock().unwrap();
            let (results, next_cursor) = data.store.search_review_feedback(
                string("workspace_id")?,
                request
                    .get("path")
                    .map(|value| value.as_str().context("Invalid review path query"))
                    .transpose()?,
                request
                    .get("query")
                    .map(|value| value.as_str().context("Invalid review note query"))
                    .transpose()?,
                request
                    .get("before")
                    .map(|value| value.as_i64().context("Invalid review search cursor"))
                    .transpose()?,
                limit as usize,
            )?;
            return Ok(
                json!({"type":"review_feedback_search","results":results,"next_cursor":next_cursor}),
            );
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
