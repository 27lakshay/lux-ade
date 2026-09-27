//! Agent sends, resumes, provider event handling, cancellation and answers.
use super::*;

pub(super) struct SendAdmission<'a> {
    pub(super) review_anchor: Option<&'a Value>,
    pub(super) review_feedback: Option<&'a Value>,
    pub(super) prelease: Option<crate::worktrees::Lease>,
}
impl SendAdmission<'_> {
    pub(super) fn ordinary() -> Self {
        Self {
            review_anchor: None,
            review_feedback: None,
            prelease: None,
        }
    }
}
pub(super) struct Agent {
    pub(super) run_id: String,
    pub(super) rpc: Option<Arc<dyn Provider>>,
    pub(super) submission: Option<String>,
    pub(super) account_generation: Option<u64>,
    /// A stop is in flight outside the session lock. The stopper owns the
    /// outcome; no new work is admitted to this Agent meanwhile.
    pub(super) stopping: bool,
    pub(super) _lease: crate::worktrees::Lease,
}

/// Storage refused to record a batch of provider events because the volume
/// or the database is full. The batch is retried; the Agent is not failed.
#[derive(Debug)]
pub(super) struct StorageFull;
impl std::fmt::Display for StorageFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("database or disk is full")
    }
}
impl std::error::Error for StorageFull {}

/// Whether SQLite refused a write because the volume or database is full.
fn storage_full(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == rusqlite::ErrorCode::DiskFull
        )
    })
}

/// A stopping Agent's run and its provider handle, if one was attached.
pub(super) type Stopping = (String, Option<Arc<dyn Provider>>);

/// How a failed Agent is recorded once its provider stop has returned.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct FailedAgent {
    pub(super) status: &'static str,
    /// Why the worktree lease stays held; `None` releases it.
    pub(super) hold: Option<String>,
}

/// Why `agent.cancel` must not act, if anything. Only a Conversation with a
/// turn in flight can be cancelled. A caller that names the turn it saw gets
/// a refusal once another turn, or none, is active: the cancel was meant for
/// a predecessor and must not stop its successor.
pub(super) fn cancel_refusal(
    status: &str,
    active_turn: Option<&str>,
    expected_turn: Option<&str>,
) -> Option<String> {
    let in_flight = matches!(status, "starting" | "running" | "waiting" | "cancelling");
    match expected_turn {
        Some(turn) if !in_flight || active_turn != Some(turn) => Some(format!(
            "Turn {turn} is no longer active; nothing was cancelled"
        )),
        None if !in_flight => Some("Agent has no active turn".into()),
        _ => None,
    }
}

/// Decides a failed Agent's record from its stop. `stop` is `None` when no
/// provider was attached. Only a confirmed stop releases the worktree lease;
/// an unconfirmed one keeps it and marks the attempt interrupted, because the
/// provider may still be running.
pub(super) fn failed_agent(stop: Option<Result<(), String>>) -> FailedAgent {
    match stop {
        None | Some(Ok(())) => FailedAgent {
            status: "error",
            hold: None,
        },
        Some(Err(error)) => FailedAgent {
            status: "interrupted",
            hold: Some(format!(
                "the provider was not confirmed stopped ({error}); ADE keeps its workspace leased until the runtime confirms it has stopped"
            )),
        },
    }
}

pub(super) fn e2e_answer_exit(point: &str) {
    if std::env::var("ADE_E2E_ANSWER_FAILPOINT").as_deref() == Ok(point) {
        std::process::exit(94);
    }
}
impl Sessions {
    pub(super) fn dispatch_queued(self: &Arc<Self>) -> Result<()> {
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
                // A provider session without a connected Agent must be
                // resumed explicitly first; its queue waits for that resume
                // instead of pausing on the refusal.
                if !d.agents.contains_key(&head.conversation_id)
                    && d.store
                        .conversation(&head.conversation_id)?
                        .provider_thread_id
                        .is_some()
                {
                    continue;
                }
            }
            if let Err(error) = self.send(
                &head.conversation_id,
                &head.id,
                &head.text,
                &head.attachments,
                true,
                SendAdmission::ordinary(),
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
                if crate::store::QUEUE_DISPATCH_STATUSES.contains(&c.status.as_str())
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
    pub(super) fn send(
        self: &Arc<Self>,
        id: &str,
        key: &str,
        text: &str,
        attachments: &[crate::model::Attachment],
        queued: bool,
        admission: SendAdmission<'_>,
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
        let mut lease = admission.prelease;
        let (c, run, rpc, prompt) = loop {
            // A new Agent's lease runs git, so it is taken before the session
            // lock. A connected Agent already holds one.
            if lease.is_none() {
                let root = {
                    let d = self.data.lock().unwrap();
                    if d.agents.contains_key(id) {
                        None
                    } else {
                        Some(d.store.workspace(&workspace_id)?.root)
                    }
                };
                if let Some(root) = root {
                    lease = Some(self.worktrees.agent_lease(&root)?);
                }
            }
            let mut d = self.data.lock().unwrap();
            ensure!(
                !d.draining,
                "Application daemon is restarting; prompt remains queued"
            );
            Self::ensure_lease_resolved(&d, &super::leases::LeaseKey::Agent(id.to_owned()))?;
            Self::ensure_not_stopping(&d, id)?;
            d.store.guard_send_intent(
                id,
                key,
                text,
                attachments,
                admission.review_anchor.or(admission.review_feedback),
            )?;
            let current = d.store.conversation(id)?;
            Self::ensure_not_imported(&current)?;
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
                        && m.attachments == attachments
                        && m.review_feedback.as_ref() == admission.review_feedback),
                    "Resume this Conversation before sending another prompt"
                );
            }
            let workspace = d.store.workspace(&d.store.conversation(id)?.workspace_id)?;
            d.store.ensure_workspace_bound(&workspace.id)?;
            if lease.is_none() && !d.agents.contains_key(id) {
                // The Agent disconnected after the lease check; take one and admit again.
                continue;
            }
            let prompt = d.store.prompt(id, text, attachments)?;
            let prompt = d.store.with_switch_context(id, key, prompt)?;
            ade_core::prompt_context::admit(&current.provider, &prompt)?;
            let mut begin = d.store.begin_content_turn_with_feedback(
                id,
                key,
                text,
                attachments,
                queued,
                admission.review_feedback,
            )?;
            if begin.duplicate {
                return Ok(());
            }
            let run = d.agents.entry(id.into()).or_insert_with(|| Agent {
                run_id: new_id("run"),
                rpc: None,
                submission: None,
                account_generation: None,
                stopping: false,
                _lease: lease.take().expect("a new Agent's lease was taken above"),
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
            break result;
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
                            && !d.agents[&c.id].stopping
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
                if let Err(error) = d.store.mark_switch_context_delivered(&c.id, &key) {
                    eprintln!("Account switch context: {error:#}");
                }
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
    pub(super) fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let clear_view = {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(id)?;
            Self::ensure_not_imported(&c)?;
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
        let mut lease = None;
        let run = loop {
            // A new Agent's lease runs git, so it is taken before the session
            // lock. A connected Agent already holds one.
            if lease.is_none() {
                let root = {
                    let d = self.data.lock().unwrap();
                    if d.agents.contains_key(id) {
                        None
                    } else {
                        let c = d.store.conversation(id)?;
                        Some(d.store.workspace(&c.workspace_id)?.root)
                    }
                };
                if let Some(root) = root {
                    lease = Some(self.worktrees.agent_lease(&root)?);
                }
            }
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
            Self::ensure_lease_resolved(&d, &super::leases::LeaseKey::Agent(id.to_owned()))?;
            Self::ensure_not_stopping(&d, id)?;
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
            let Some(lease) = lease.take() else {
                // The Agent disconnected after the lease check; take one and admit again.
                continue;
            };
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
                    stopping: false,
                    _lease: lease,
                },
            );
            self.changed(&mut d, &c, &[])?;
            break run;
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
    pub(super) fn owns(d: &Data, id: &str, run: &str) -> bool {
        d.agents.get(id).is_some_and(|a| a.run_id == run)
    }
    /// Refuses work for an Agent whose stop is in flight.
    pub(super) fn ensure_not_stopping(d: &Data, id: &str) -> Result<()> {
        ensure!(
            !d.agents.get(id).is_some_and(|agent| agent.stopping),
            "The Agent is stopping; retry once it has stopped"
        );
        Ok(())
    }
    /// Marks a connected Agent stopping and returns what its stop needs, so
    /// the stop runs after the caller releases the session lock.
    pub(super) fn begin_stop(d: &mut Data, id: &str) -> Result<Option<Stopping>> {
        Self::ensure_not_stopping(d, id)?;
        Ok(d.agents.get_mut(id).map(|agent| {
            agent.stopping = true;
            (agent.run_id.clone(), agent.rpc.clone())
        }))
    }
    /// Stops an Agent marked by [`Self::begin_stop`]; call it without the
    /// session lock. A failed stop leaves the Agent attached as it was.
    pub(super) fn finish_stop(
        &self,
        id: &str,
        run: &str,
        rpc: Option<Arc<dyn Provider>>,
    ) -> Result<()> {
        let result = rpc.map_or(Ok(()), |rpc| rpc.stop_confirmed());
        if result.is_err() {
            let mut d = self.data.lock().unwrap();
            if let Some(agent) = d.agents.get_mut(id)
                && agent.run_id == run
            {
                agent.stopping = false;
            }
        }
        result
    }
    pub(super) fn connect_agent(
        self: &Arc<Self>,
        id: &str,
        run: &str,
    ) -> Result<Arc<dyn Provider>> {
        self.attach_agent(id, run, false)
    }
    pub(super) fn attach_agent(
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
        // A recovered run already runs what it launched with; the runtime
        // never reads the spec again.
        let (worker, adapter) = if restore {
            (None, None)
        } else {
            self.launch_pins(&c)?
        };
        // The profile MCP catalog resolved for this workspace and provider
        // (F131), read at each launch so a resume sees the current catalog.
        let mcp_servers = if restore {
            None
        } else {
            super::mcp::launch_servers(&self.data.lock().unwrap().store, &w, &c.provider)?
        };
        let rpc = Remote::new(
            self.runtime.clone(),
            Spec {
                conversation: id.into(),
                run: run.into(),
                provider: c.provider.clone(),
                root: w.root,
                account,
                worker,
                adapter,
                mcp_servers,
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
            let mut waiting_for_storage = false;
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
                    if error.is::<StorageFull>() {
                        // Keep the Agent, so its turn can still be stopped
                        // (R004). The batch was not acknowledged: the
                        // runtime serves it again, and it is ingested once
                        // storage accepts writes.
                        if !waiting_for_storage {
                            eprintln!("Agent events wait for storage: {error}");
                            waiting_for_storage = true;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        continue;
                    }
                    hub.fail(&event_id, &event_run, error.to_string());
                    break;
                }
                waiting_for_storage = false;
                cursor = next;
                // Retrying an acknowledgement is safe; a failed socket never advances
                // the cursor without committing the corresponding projection first.
                acknowledge = Some(cursor);
            }
        });
        Ok(rpc)
    }
    pub(super) fn runtime_connection(&self, id: &str, run: &str, unavailable: bool) {
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
    pub(super) fn fail(&self, id: &str, run: &str, error: String) {
        self.fail_if(id, run, error, None);
    }
    pub(super) fn fail_if(&self, id: &str, run: &str, error: String, submission: Option<&str>) {
        let runtime_gone = self.runtime.gone();
        let error = if runtime_gone {
            "Runtime supervisor exited. Restart lux-ade, then resume this Conversation. No prompt was resent.".into()
        } else {
            error
        };
        let mut d = self.data.lock().unwrap();
        if !Self::owns(&d, id, run)
            || d.agents[id].stopping
            || submission.is_some_and(|key| d.agents[id].submission.as_deref() != Some(key))
        {
            return;
        }
        let outcome = match d.agents[id].rpc.clone() {
            // No provider is attached yet: remove the Agent in this same lock
            // hold, so a concurrent attach sees it gone and stops its own run.
            None => failed_agent(None),
            // Stop the provider without the lock: a stop can take a full
            // shutdown escalation. The stopping flag fences the gap.
            Some(rpc) => {
                d.agents.get_mut(id).unwrap().stopping = true;
                drop(d);
                let stop = rpc.stop_confirmed().map_err(|error| format!("{error:#}"));
                d = self.data.lock().unwrap();
                if !Self::owns(&d, id, run) {
                    return;
                }
                failed_agent(Some(stop))
            }
        };
        let result = (|| -> Result<()> {
            let agent = d.agents.remove(id).unwrap();
            let current = d.store.conversation(id).ok();
            if let Some(reason) = &outcome.hold {
                // The provider may still run in the worktree: keep its lease
                // until the runtime reports the run gone.
                let workspace_id = current
                    .as_ref()
                    .map(|c| c.workspace_id.clone())
                    .unwrap_or_default();
                let root = d
                    .store
                    .workspace(&workspace_id)
                    .map(|w| w.root)
                    .unwrap_or_default();
                let key = super::leases::LeaseKey::Agent(id.to_owned());
                eprintln!("Session lease unresolved: {key:?}: {reason}");
                d.unresolved.insert(
                    key.clone(),
                    super::leases::Unresolved {
                        claim: super::leases::Claim {
                            key,
                            workspace_id,
                            root,
                            holder: super::leases::Holder::Agent {
                                run: Some(run.to_owned()),
                                provider: current
                                    .as_ref()
                                    .map(|c| c.provider.clone())
                                    .unwrap_or_default(),
                                account: current.as_ref().and_then(|c| c.account_id.clone()),
                            },
                        },
                        reason: reason.clone(),
                        lease: Some(agent._lease),
                    },
                );
            }
            let mut c = current.context("Missing Conversation")?;
            c.status = outcome.status.into();
            c.queue_paused = true;
            c.error = Some(match &outcome.hold {
                Some(reason) => format!("{error}. {reason}"),
                None => error,
            });
            c.active_turn_id = None;
            c.updated_at = now_ms();
            let mut requests = d.store.pending(id)?;
            for p in &mut requests {
                p.status = "interrupted".into();
            }
            // Without a confirmed stop, or with the runtime gone, nothing
            // proves how a turn in flight ended: its outcome is unknown.
            if runtime_gone || outcome.hold.is_some() {
                d.store.commit_lost_run(&c, &requests)?;
            } else {
                d.store.commit_conversation(&c, &[], &requests)?;
            }
            self.changed(&mut d, &c, &[])
        })();
        if let Err(error) = result {
            eprintln!("Could not persist Agent failure: {error}");
        }
    }
    pub(super) fn events(&self, id: &str, run: &str, batch: Vec<Envelope>) -> Result<()> {
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
        let mut usage = Vec::new();
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
                        answer_fingerprint: None,
                        answer_dispatched: false,
                        answer_attempt: 0,
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
                    usage.push((
                        envelope.sequence,
                        crate::usage::Observed::Finished { turn: turn.clone() },
                    ));
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
                            review_feedback: None,
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
                    // One message past 1 MiB is cut with a marker, never
                    // a reason to fail the Conversation.
                    let m = messages.get_mut(&mid).unwrap();
                    crate::transcript::append_bounded(&mut m.text, &text);
                    if let Some(crate::transcript::Content::Tool { output, .. }) = &mut m.content {
                        crate::transcript::append_bounded(
                            output.get_or_insert_with(String::new),
                            &text,
                        );
                    }
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
                Event::Usage {
                    session,
                    turn,
                    source,
                    report,
                } => {
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    usage.push((
                        envelope.sequence,
                        crate::usage::Observed::Report {
                            turn,
                            source,
                            report,
                        },
                    ));
                }
            }
        }
        // Usage commits first with its own replay cursor, so a crash before
        // the conversation commit cannot count a report twice.
        self.usage.record(
            &crate::usage::Context {
                conversation_id: id,
                workspace_id: &c.workspace_id,
                provider: &c.provider,
                account_id: c.account_id.as_deref(),
            },
            run,
            &usage,
        );
        if changed {
            c.updated_at = now_ms();
            let messages: Vec<_> = order
                .into_iter()
                .filter_map(|id| messages.remove(&id))
                .collect();
            let requests: Vec<_> = requests.into_values().collect();
            let committed = d.store.commit_conversation(&c, &messages, &requests);
            if committed.as_ref().is_err_and(storage_full) {
                return Err(StorageFull.into());
            }
            persistence_result(committed)?;
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
    /// Cancels the active turn. With `expected_turn`, only while that turn is
    /// still the active one: a late or retried cancel never stops a successor.
    ///
    /// Stopping existing work must not depend on storage: when the
    /// cancellation cannot be recorded, the provider is still asked to stop
    /// the turn, and the reply reports that the state was not recorded.
    pub(super) fn cancel(self: &Arc<Self>, id: &str, expected_turn: Option<&str>) -> Result<()> {
        let (run, rpc, thread, turn, submission, unrecorded) = {
            let mut d = self.data.lock().unwrap();
            let mut c = d.store.conversation(id)?;
            if let Some(refusal) =
                cancel_refusal(&c.status, c.active_turn_id.as_deref(), expected_turn)
            {
                bail!(refusal);
            }
            let a = d
                .agents
                .get(id)
                .ok_or_else(|| anyhow!("Agent is not connected"))?;
            let run = a.run_id.clone();
            let rpc = a.rpc.clone();
            let submission = a.submission.clone();
            let thread = c.provider_thread_id.clone();
            let turn = c.active_turn_id.clone();
            c.status = "cancelling".into();
            c.queue_paused = true;
            let unrecorded = match d.store.commit_conversation(&c, &[], &[]) {
                Ok(()) => {
                    self.changed(&mut d, &c, &[])?;
                    None
                }
                Err(error) => Some(error),
            };
            (run, rpc, thread, turn, submission, unrecorded)
        };
        if let (Some(rpc), Some(thread), Some(turn)) = (rpc, thread, turn) {
            let hub = self.clone();
            let id = id.to_owned();
            std::thread::spawn(move || {
                if let Err(error) = rpc.cancel(&thread, &turn) {
                    // A late failure belongs to the cancelled submission only;
                    // a successor turn in the same run must not be failed.
                    hub.fail_if(&id, &run, error.to_string(), submission.as_deref());
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
        if let Some(error) = unrecorded {
            bail!(
                "ADE asked the provider to stop this turn but could not record the cancellation ({error:#}); the Conversation updates once storage accepts writes again"
            );
        }
        Ok(())
    }
    pub(super) fn answer(
        &self,
        id: &str,
        request_id: &str,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        let mut payload = json!({"decision":decision,"answers":answers.unwrap_or(&Value::Null)});
        payload.sort_all_objects();
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&payload)?));
        let (rpc, native, native_resolved) = {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(id)?;
            let mut p = d
                .store
                .interaction(id, request_id)?
                .ok_or_else(|| anyhow!("Request is stale or already answered"))?;
            if let Some(prior) = &p.answer_fingerprint {
                ensure!(
                    prior == &fingerprint,
                    "Answer conflicts with the recorded decision"
                );
            }
            if p.answer_dispatched {
                return Ok(());
            }
            ensure!(
                matches!(p.status.as_str(), "pending" | "responding" | "resolved")
                    && (p.status != "resolved" || p.answer_fingerprint.is_some()),
                "Request ended before answer delivery was confirmed; its outcome is unknown"
            );
            ensure!(
                Self::owns(&d, id, &p.run_id),
                "Request belongs to a previous Agent run"
            );
            let native_resolved = p.status == "resolved";
            if !native_resolved {
                ensure!(
                    p.params["threadId"].as_str() == c.provider_thread_id.as_deref()
                        && p.params["turnId"].as_str() == c.active_turn_id.as_deref(),
                    "Request no longer belongs to the active turn"
                );
            }
            let rpc = d.agents[id]
                .rpc
                .as_ref()
                .ok_or_else(|| anyhow!("Agent is unavailable"))?
                .clone();
            if !native_resolved {
                rpc.validate_answer(&p, decision, answers)?;
            }
            if p.status == "pending" {
                p.answer_fingerprint = Some(fingerprint.clone());
                p.status = "responding".into();
                d.store.commit_conversation(&c, &[], &[p.clone()])?;
            }
            // The runtime fingerprints the whole command. Preserve one exact
            // native request across daemon retries even as local state advances.
            p.status = "pending".into();
            p.answer_dispatched = false;
            (rpc, p, native_resolved)
        };
        if native_resolved {
            let agents: ade_core::contract::agents::AgentList =
                serde_json::from_value(self.runtime.agent(AgentOp::List)?)?;
            let key = native.answer_command_key();
            let present = agents
                .agents
                .iter()
                .any(|item| item.spec.run == native.run_id && item.commands.contains(&key));
            ensure!(
                present,
                "Native request ended without a recorded answer receipt; outcome is unknown"
            );
        }
        e2e_answer_exit("before_delivery");
        // An uncertain daemon/runtime reply leaves the durable intent intact.
        // The runtime receipt admits this exact answer only once.
        if let Err(error) = rpc.answer(&native, decision, answers) {
            if native_resolved
                && error
                    .downcast_ref::<crate::agent_runtime::AnswerNotSent>()
                    .is_some()
            {
                bail!(
                    "Native request ended before ADE delivered this answer; inspect the provider turn"
                );
            }
            if error
                .downcast_ref::<crate::agent_runtime::AnswerNotSent>()
                .is_some()
            {
                e2e_answer_exit("after_not_sent_receipt");
                let mut d = self.data.lock().unwrap();
                let mut c = d.store.conversation(id)?;
                let mut p = d
                    .store
                    .interaction(id, request_id)?
                    .ok_or_else(|| anyhow!("Answer request disappeared before native delivery"))?;
                ensure!(
                    p.answer_fingerprint.as_deref() == Some(fingerprint.as_str()),
                    "Answer intent changed before retry"
                );
                if p.answer_attempt == native.answer_attempt
                    && p.status == "responding"
                    && Self::owns(&d, id, &p.run_id)
                {
                    ensure!(
                        p.answer_attempt < 32,
                        "Answer retry limit reached; inspect the provider request"
                    );
                    p.answer_attempt += 1;
                    p.status = "pending".into();
                    c.error = Some(error.to_string());
                    c.updated_at = now_ms();
                    d.store.commit_conversation(&c, &[], &[p])?;
                    e2e_answer_exit("after_attempt_advance");
                    self.changed(&mut d, &c, &[])?;
                }
            }
            return Err(error);
        }
        e2e_answer_exit("after_delivery");
        let mut d = self.data.lock().unwrap();
        let mut c = d.store.conversation(id)?;
        let mut p = d
            .store
            .interaction(id, request_id)?
            .ok_or_else(|| anyhow!("Answer request disappeared after delivery"))?;
        ensure!(
            p.answer_fingerprint.as_deref() == Some(fingerprint.as_str()),
            "Answer intent changed after delivery"
        );
        p.answer_dispatched = true;
        if p.status == "responding" {
            p.status = "resolved".into();
        }
        if c.status == "waiting" && !d.store.pending(id)?.iter().any(|r| r.id != p.id) {
            c.status = "running".into();
        }
        if c.error.as_deref() == Some(&crate::agent_runtime::AnswerNotSent.to_string()) {
            c.error = None;
        }
        c.updated_at = now_ms();
        d.store.commit_conversation(&c, &[], &[p])?;
        self.changed(&mut d, &c, &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconfirmed_stop_keeps_the_lease_and_marks_the_attempt_interrupted() {
        // The runtime answered `Unconfirmed`, or its socket was refused
        // because the supervisor exited while the provider group lives on.
        for error in [
            "Provider shutdown was not confirmed",
            "Connection refused (os error 61)",
        ] {
            let failed = failed_agent(Some(Err(error.into())));
            assert_eq!(failed.status, "interrupted");
            assert!(failed.hold.is_some_and(|reason| reason.contains(error)));
        }
    }

    #[test]
    fn a_cancel_naming_an_earlier_turn_never_stops_its_successor() {
        // Unfenced: any turn in flight is cancelled.
        assert_eq!(cancel_refusal("running", Some("turn-b"), None), None);
        assert_eq!(cancel_refusal("starting", None, None), None);
        assert!(cancel_refusal("idle", None, None).is_some());
        // Fenced to the turn the caller saw.
        assert_eq!(
            cancel_refusal("running", Some("turn-a"), Some("turn-a")),
            None
        );
        assert_eq!(
            cancel_refusal("cancelling", Some("turn-a"), Some("turn-a")),
            None
        );
        for (status, active) in [
            ("running", Some("turn-b")),
            ("starting", None),
            ("interrupted", None),
            ("idle", None),
        ] {
            let refusal = cancel_refusal(status, active, Some("turn-a"));
            assert!(
                refusal.is_some_and(|reason| reason.contains("no longer active")),
                "{status}"
            );
        }
    }

    #[test]
    fn only_a_confirmed_stop_releases_the_lease() {
        let released = FailedAgent {
            status: "error",
            hold: None,
        };
        assert_eq!(failed_agent(Some(Ok(()))), released);
        // No provider was attached to this Agent.
        assert_eq!(failed_agent(None), released);
    }
}
