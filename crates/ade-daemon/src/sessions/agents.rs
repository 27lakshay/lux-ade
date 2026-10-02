//! Agent sends, resumes, provider event handling, cancellation and answers.
use super::*;

fn submission_message(
    store: &crate::store::Store,
    request: Option<&str>,
    update: impl FnOnce(&mut ade_core::contract::conversations::SubmissionDelivery),
) -> Result<Option<Message>> {
    let Some(request) = request else {
        return Ok(None);
    };
    let Some(mut message) = store.message(request)? else {
        return Ok(None);
    };
    if message.role != "user" {
        return Ok(None);
    }
    let delivery = message.delivery.get_or_insert_with(|| {
        ade_core::contract::conversations::SubmissionDelivery::admitted(request)
    });
    update(delivery);
    Ok(Some(message))
}

pub(super) struct Agent {
    pub(super) run_id: String,
    pub(super) rpc: Option<Arc<dyn Provider>>,
    pub(super) submission: Option<String>,
    pub(super) account_generation: Option<u64>,
    /// A stop is in flight outside the session lock. The stopper owns the
    /// outcome; no new work is admitted to this Agent meanwhile.
    pub(super) stopping: bool,
    /// The models and dependent settings the open provider session listed;
    /// they belong to this run and go with it.
    pub(super) native_choices: Option<ade_core::provider::NativeChoices>,
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

/// Whether a turn that ended with `status` pauses the prompt queue. An
/// interrupted or failed turn pauses it, unless the person resumed the queue
/// while that very submission was still ending: that newer wake is kept.
pub(super) fn pauses_queue(status: &str, resumed_during: Option<&str>, identity: &str) -> bool {
    status != "ready" && resumed_during != Some(identity)
}

fn resolved_request_matches(
    metadata: Option<&ade_core::requests::RequestMetadata>,
    session: &str,
    request_id: &serde_json::Value,
) -> bool {
    metadata.is_some_and(|metadata| {
        metadata.native_session_id.as_deref() == Some(session)
            && &metadata.native_request_id == request_id
    })
}
fn event_targets_current_submission(
    conversation: &ade_core::model::Conversation,
    session: &str,
    submission: Option<&str>,
    turn: Option<&str>,
) -> bool {
    if session.is_empty() || conversation.provider_thread_id.as_deref() != Some(session) {
        return false;
    }
    match submission {
        Some(submission) => conversation.runtime_submission.as_deref() == Some(submission),
        None => turn.is_some_and(|turn| conversation.active_turn_id.as_deref() == Some(turn)),
    }
}

/// Whether a provider event that names `turn` belongs to a turn other than
/// the active one: a cancelled or finished turn whose stream arrives late. An
/// event that names no turn cannot be fenced and is not stale by this test.
pub(super) fn another_turn(active: Option<&str>, turn: Option<&str>) -> bool {
    turn.is_some_and(|turn| active != Some(turn))
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

/// How long `agent.cancel` waits for the provider's acknowledgement.
pub(super) const STOP_ACK_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);

/// How long an acknowledged Stop waits for terminal evidence before it is
/// reported unresolved. `ADE_E2E_STOP_SETTLE_MS` shortens it for tests.
pub(super) fn stop_settle_window() -> std::time::Duration {
    std::env::var("ADE_E2E_STOP_SETTLE_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map_or(
            std::time::Duration::from_secs(30),
            std::time::Duration::from_millis,
        )
}

/// An unresolved Stop leaves the turn in flight: the Conversation shows it
/// running again, so Stop can be retried and a restart is not held.
fn resume_unresolved(c: &mut Conversation) {
    if c.status == "cancelling"
        && c.stop
            .as_ref()
            .is_some_and(|stop| stop.outcome == ade_core::contract::agents::StopOutcome::Unresolved)
    {
        c.status = "running".into();
    }
}

/// Work the provider says can still run after its interruption, in plain words.
pub(super) fn remaining_work(
    evidence: &ade_core::contract::providers::ProviderCancelEvidence,
) -> Option<String> {
    match evidence.queued_work_count {
        Some(1) => Some("1 queued input can still run after this stop".into()),
        Some(n) if n > 1 => Some(format!("{n} queued inputs can still run after this stop")),
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
/// The request ID of the newest prompt whose native outcome is unknown, when
/// no Agent is connected: reopening its session may continue that work.
pub(super) fn interrupted_prompt(d: &Data, id: &str) -> Result<Option<String>> {
    if d.agents.contains_key(id) {
        return Ok(None);
    }
    let newest = d
        .store
        .messages(id, None, 32)?
        .into_iter()
        .rev()
        .find_map(|message| message.delivery);
    Ok(newest
        .filter(|delivery| {
            delivery.native_outcome
                == ade_core::contract::conversations::SubmissionNativeOutcome::Unknown
        })
        .map(|delivery| delivery.request_id))
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
            // Review feedback queued by `review.feedback.send` stays with its message.
            let feedback = self
                .data
                .lock()
                .unwrap()
                .store
                .queued_review_feedback(&head.id)?;
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
                feedback.as_ref(),
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
        review_feedback: Option<&Value>,
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
        let mut lease = None;
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
            d.store.guard_send_intent(id, key, text, attachments)?;
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
                        && m.review_feedback.as_ref() == review_feedback),
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
                review_feedback,
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
                native_choices: None,
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
                    let mut d = hub.data.lock().unwrap();
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
                    if let Some(delivery) = &mut message.delivery {
                        delivery.dispatch =
                            ade_core::contract::conversations::SubmissionDispatch::Dispatched;
                    }
                    if message.provider_item_id.is_none() {
                        message.provider_item_id = rpc.prepare_submission();
                    }
                    d.store
                        .commit_conversation(&current, &[message.clone()], &[])?;
                    hub.changed(&mut d, &current, &[message.clone()])?;
                    message.provider_item_id
                };
                let receipt =
                    rpc.send_evidence(&thread, &run, &key, message_id.as_deref(), &prompt)?;
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
                if current.status == "starting" && receipt.admitted {
                    current.status = "running".into();
                    current.active_turn_id = receipt.turn.clone();
                    current.updated_at = now_ms();
                    d.store.commit_conversation(&current, &[], &[])?;
                    hub.changed(&mut d, &current, &[])?;
                }
                if let Some(message) = submission_message(&d.store, Some(&key), |delivery| {
                    delivery.admitted = receipt.admitted;
                    delivery.dispatch = receipt.dispatch;
                    delivery.native_outcome = receipt.native_outcome;
                    delivery.native_turn_id = receipt.turn.clone();
                    if receipt.native_outcome
                        == ade_core::contract::conversations::SubmissionNativeOutcome::Accepted
                    {
                        delivery.error = None;
                        delivery.recovery = None;
                    }
                    if delivery.terminal.as_ref().is_some_and(|terminal| {
                        receipt.turn.as_deref().is_some_and(|turn| {
                            terminal
                                .turn_id
                                .as_deref()
                                .is_some_and(|native| native != turn)
                        })
                    }) {
                        delivery.terminal = None;
                    } else if let Some(terminal) = &mut delivery.terminal
                        && let Some(turn) = receipt.turn.as_deref()
                        && terminal.turn_id.as_deref() == Some(turn)
                    {
                        terminal.correlated = true;
                    }
                })? {
                    d.store
                        .commit_conversation(&current, std::slice::from_ref(&message), &[])?;
                    hub.changed(&mut d, &current, &[message])?;
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
        {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(id)?;
            Self::ensure_not_imported(&c)?;
            Self::ensure_account_current(
                &d,
                &c,
                d.agents.get(id).and_then(|agent| agent.account_generation),
            )?;
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
                    native_choices: None,
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
                    ensure!(account.state != "disabled", crate::store::ACCOUNT_DISABLED);
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
                    if !matches!(c.provider.as_str(), "claude" | "codex" | "omp") {
                        ensure!(
                            account.worker_identity.is_some(),
                            "{} account identity is not pinned",
                            c.provider
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
                        worker_identity: account.worker_identity,
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
            // A plugin's wiring comes from its worker's handshake; gather it outside the lock.
            self.discover_plugin_providers();
            let d = self.data.lock().unwrap();
            let wired = self.mcp_wired(&d, &c.provider);
            super::mcp::launch_servers(&d.store, &w, &c.provider, wired)?
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
                        && current.omp_identity == expected.omp_identity
                        && current.worker_identity == expected.worker_identity,
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
            // A rewind the runtime performed but this daemon has not settled
            // leaves the Conversation on the session the fork left; the
            // rewind's retry moves it (F039).
            let unsettled_rewind = restore
                && connected.rewound_from.is_some()
                && current.provider_thread_id == connected.rewound_from;
            ensure!(
                unsettled_rewind
                    || current
                        .provider_thread_id
                        .as_ref()
                        .is_none_or(|id| id == &connected.session),
                "Runtime provider identity changed"
            );
            let needs_history = !restore || current.provider_thread_id.is_none();
            if !unsettled_rewind {
                current.provider_thread_id = Some(connected.session);
            }
            current.native_settings = connected.native_settings;
            // A report beyond ADE's bounds is not used; settings then say discovery is unavailable.
            d.agents.get_mut(id).unwrap().native_choices = connected
                .native_choices
                .filter(|choices| choices.validate().is_ok());
            // A new provider session reports its own background work.
            current.background = None;
            current.execution = Some(ade_core::contract::agents::ConversationExecution {
                source_attempt_id: run.to_owned(),
                account_context: current.account_context,
                account_id: current.account_id.clone(),
                account_generation: rpc.spec.account.as_ref().map(|account| account.generation),
                native_session: current.provider_thread_id.clone().unwrap_or_default(),
                settings_revision: current.settings_revision,
                reattached: restore,
                opened_at_ms: now_ms(),
            });
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
            let current = self.presented(&d, &current)?;
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
    /// Fails the run and stops its provider. Returns the provider stop's
    /// result: `None` when nothing was attached or the run was not this one.
    pub(super) fn fail_if(
        &self,
        id: &str,
        run: &str,
        error: String,
        submission: Option<&str>,
    ) -> Option<Result<(), String>> {
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
            return None;
        }
        let mut stopped = None;
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
                    return Some(stop);
                }
                stopped = Some(stop.clone());
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
            // The provider can no longer report: its background work is unknown.
            if let Some(background) = c.background.as_mut() {
                background.active = None;
                background.source = "provider_exited".into();
                background.observed_at_ms = now_ms();
            }
            c.error = Some(match &outcome.hold {
                Some(reason) => format!("{error}. {reason}"),
                None => error,
            });
            c.active_turn_id = None;
            c.updated_at = now_ms();
            // A Stop of this attempt settles on the process evidence.
            if let Some(stop) = c.stop.as_mut().filter(|stop| {
                stop.source_attempt_id == run
                    && stop.outcome != ade_core::contract::agents::StopOutcome::Confirmed
            }) {
                match &stopped {
                    Some(Ok(())) => stop.confirm(
                        ade_core::contract::agents::StopConfirmation::ProcessExit,
                        None,
                        now_ms(),
                    ),
                    Some(Err(error)) => stop.unresolve(format!(
                        "The runtime could not confirm the provider process exited: {error}"
                    )),
                    None => {
                        stop.outcome = ade_core::contract::agents::StopOutcome::Confirmed;
                        stop.reason = Some("No provider process had started".into());
                        stop.escalation = None;
                        stop.settled_at_ms = Some(now_ms());
                    }
                }
            }
            let mut requests = d.store.pending(id)?;
            for p in &mut requests {
                p.status = "interrupted".into();
            }
            let delivery =
                submission_message(&d.store, c.runtime_submission.as_deref(), |delivery| {
                    let failure = ade_core::error::Failure::provider(
                        &serde_json::json!({"message": c.error}),
                        ade_core::error::Failure::OutcomeUnknown,
                    );
                    delivery.error = Some(failure);
                    delivery.recovery = Some(failure.recovery());
                    if delivery.native_outcome
                        != ade_core::contract::conversations::SubmissionNativeOutcome::Accepted
                    {
                        delivery.native_outcome = match failure {
                            ade_core::error::Failure::Rejected
                            | ade_core::error::Failure::Authentication
                            | ade_core::error::Failure::RateLimit
                            | ade_core::error::Failure::UsageLimit
                            | ade_core::error::Failure::SessionUnavailable => {
                                ade_core::contract::conversations::SubmissionNativeOutcome::Rejected
                            }
                            _ => {
                                ade_core::contract::conversations::SubmissionNativeOutcome::Unknown
                            }
                        };
                    }
                })?
                .into_iter()
                .collect::<Vec<_>>();
            // Without a confirmed stop, or with the runtime gone, nothing
            // proves how a turn in flight ended: its outcome is unknown.
            if runtime_gone || outcome.hold.is_some() {
                d.store.commit_lost_run(&c, &delivery, &requests)?;
            } else {
                d.store.commit_conversation(&c, &delivery, &requests)?;
            }
            self.changed(&mut d, &c, &delivery)
        })();
        if let Err(error) = result {
            eprintln!("Could not persist Agent failure: {error}");
        }
        stopped
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
            // Native notifications may precede the send receipt. Retain turn identity,
            // but claim request correlation only after Submitted proves it.
            let delivery_event = match &envelope.event {
                Event::Submitted { submission, .. }
                    if c.runtime_submission.as_ref() == Some(submission) =>
                {
                    Some(submission.as_str())
                }
                Event::Finished {
                    session,
                    submission,
                    turn,
                    ..
                } if event_targets_current_submission(
                    &c,
                    session,
                    submission.as_deref(),
                    turn.as_deref(),
                ) =>
                {
                    c.runtime_submission.as_deref()
                }
                _ => None,
            };
            if let Some(request) = delivery_event {
                let message = messages.get(request).cloned().or(d.store.message(request)?);
                if let Some(mut message) = message
                    && let Some(delivery) = &mut message.delivery
                {
                    match &envelope.event {
                        Event::Submitted {
                            turn,
                            admitted,
                            dispatch,
                            native_outcome,
                            ..
                        } => {
                            delivery.admitted = *admitted;
                            delivery.dispatch = dispatch.unwrap_or(
                                ade_core::contract::conversations::SubmissionDispatch::Pending,
                            );
                            delivery.native_outcome = native_outcome.unwrap_or(
                                ade_core::contract::conversations::SubmissionNativeOutcome::Pending,
                            );
                            delivery.native_turn_id = turn.clone();
                            delivery.recovery = None;
                            if delivery.terminal.as_ref().is_some_and(|terminal| {
                                terminal.turn_id.is_some() && terminal.turn_id != *turn
                            }) {
                                delivery.terminal = None;
                            } else if let Some(terminal) = &mut delivery.terminal {
                                terminal.correlated = true;
                            }
                        }
                        // Another native turn ending after this prompt's own turn, such
                        // as a compaction, is not this prompt's terminal.
                        Event::Finished {
                            turn: Some(turn), ..
                        } if delivery
                            .native_turn_id
                            .as_ref()
                            .is_some_and(|own| own != turn) => {}
                        Event::Finished {
                            turn,
                            status,
                            error,
                            native_terminal,
                            interrupt_requested,
                            ..
                        } => {
                            delivery.terminal =
                                Some(ade_core::contract::conversations::SubmissionTerminal {
                                    turn_id: turn.clone(),
                                    status: status.clone(),
                                    correlated: true,
                                    native_terminal: native_terminal.clone(),
                                    interrupt_requested: *interrupt_requested,
                                    error: error.as_ref().map(|error| {
                                        ade_core::error::Failure::provider(
                                            &serde_json::json!({"message": error}),
                                            ade_core::error::Failure::Rejected,
                                        )
                                    }),
                                });
                        }
                        _ => unreachable!(),
                    }
                    if !messages.contains_key(&message.id) {
                        order.push(message.id.clone());
                    }
                    messages.insert(message.id.clone(), message);
                }
            }
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
                Event::Submitted {
                    submission,
                    turn,
                    admitted,
                    ..
                } => {
                    // Native events can precede the send reply: a turn that already
                    // finished, or is being cancelled, keeps its state.
                    if c.runtime_submission.as_deref() == Some(&submission) && admitted {
                        if c.status == "starting" {
                            c.status = "running".into();
                            c.active_turn_id = turn;
                        } else if matches!(c.status.as_str(), "running" | "waiting" | "cancelling")
                            && c.active_turn_id.is_none()
                        {
                            c.active_turn_id = turn;
                        }
                    }
                }
                Event::Exited { error } => {
                    exit_error = Some(error);
                    break;
                }
                Event::Request {
                    session,
                    submission,
                    turn,
                    id: rpc_id,
                    method,
                    params,
                    supported,
                    metadata,
                } => {
                    let rpc = d.agents[id]
                        .rpc
                        .as_ref()
                        .ok_or_else(|| anyhow!("Missing Agent runtime"))?;
                    if Some(session.as_str()) != c.provider_thread_id.as_deref()
                        || submission
                            .as_deref()
                            .is_some_and(|s| c.runtime_submission.as_deref() != Some(s))
                        || turn
                            .as_deref()
                            .is_some_and(|t| c.active_turn_id.as_deref() != Some(t))
                    {
                        // Refusing a stale request is best effort: its failure says
                        // nothing about the current turn and must not fail it.
                        if let Err(error) =
                            rpc.reject(rpc_id, "Request does not belong to this Conversation")
                        {
                            eprintln!("Could not refuse a stale provider request: {error:#}");
                        }
                        continue;
                    }
                    let source_attempt_id = (submission.is_some() || turn.is_some())
                        .then(|| c.runtime_run.clone())
                        .flatten();
                    let metadata =
                        metadata.unwrap_or_else(|| ade_core::requests::RequestMetadata {
                            schema_version: 1,
                            summary: "Agent request requires attention".into(),
                            schema: ade_core::requests::RequestSchema::Unsupported {
                                reason: format!("No answer schema is available for {method}"),
                            },
                            blocking: None,
                            created_at_ms: None,
                            expires_at_ms: None,
                            native_revision: None,
                            native_session_id: None,
                            native_turn_id: None,
                            native_request_id: serde_json::Value::Null,
                            native_item_id: None,
                            native_callback_id: None,
                        });
                    let metadata = if !supported {
                        match metadata.schema {
                            ade_core::requests::RequestSchema::Unsupported { .. } => metadata,
                            _ => ade_core::requests::RequestMetadata {
                                schema: ade_core::requests::RequestSchema::Unsupported {
                                    reason: "The provider cannot answer this request safely".into(),
                                },
                                ..metadata
                            },
                        }
                    } else {
                        metadata
                    };
                    let p = PendingRequest {
                        id: new_id("request"),
                        conversation_id: id.into(),
                        run_id: run.into(),
                        source_attempt_id,
                        rpc_id,
                        method,
                        params,
                        status: "pending".into(),
                        answer_fingerprint: None,
                        answer_dispatched: false,
                        answer_attempt: 0,
                        revision: 1,
                        metadata: Some(metadata),
                        resolution: Default::default(),
                        response_delivery: Default::default(),
                        response_operation_id: None,
                    };
                    requests.insert(p.id.clone(), p);
                    c.status = "waiting".into();
                    changed = true;
                }
                Event::Started {
                    session,
                    submission,
                    turn,
                } => {
                    if (!session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref())
                        || submission
                            .as_ref()
                            .is_some_and(|s| c.runtime_submission.as_ref() != Some(s))
                    {
                        continue;
                    }
                    c.active_turn_id = turn;
                    // A Stop requested before the native start stays in progress.
                    if c.status != "cancelling" {
                        c.status = "running".into();
                    }
                    c.error = None;
                    changed = true;
                }
                Event::Finished {
                    session,
                    submission,
                    turn,
                    status,
                    error,
                    native_terminal: _,
                    interrupt_requested: _,
                } => {
                    if !event_targets_current_submission(
                        &c,
                        &session,
                        submission.as_deref(),
                        turn.as_deref(),
                    ) {
                        continue;
                    }
                    c.status = match status.as_str() {
                        "failed" => "error",
                        "interrupted" | "cancelled" => "interrupted",
                        _ => "ready",
                    }
                    .into();
                    c.error = error;
                    let identity = submission
                        .as_deref()
                        .or(turn.as_deref())
                        .expect("the event identity fence requires one identity");
                    if pauses_queue(&c.status, c.queue_resumed_during.as_deref(), identity) {
                        c.queue_paused = true;
                    }
                    c.queue_resumed_during = None;
                    c.active_turn_id = None;
                    // Native terminal evidence settles a Stop of this exact submission.
                    let finished_submission = c.runtime_submission.clone();
                    if let Some(stop) = c.stop.as_mut().filter(|stop| {
                        stop.source_attempt_id == run
                            && Some(&stop.submission_id) == finished_submission.as_ref()
                            && stop.outcome == ade_core::contract::agents::StopOutcome::Requested
                    }) {
                        stop.confirm(
                            ade_core::contract::agents::StopConfirmation::NativeTerminal,
                            Some(status.clone()),
                            now_ms(),
                        );
                    }
                    // A provider that names no turn (Claude) has its usage keyed
                    // by the submission the turn ran.
                    if let Some(turn) = turn.clone().or_else(|| finished_submission.clone()) {
                        usage.push((envelope.sequence, crate::usage::Observed::Finished { turn }));
                    }
                    for r in requests.values_mut() {
                        let request_session = r
                            .metadata
                            .as_ref()
                            .and_then(|metadata| metadata.native_session_id.as_deref())
                            .or_else(|| r.params["threadId"].as_str());
                        let request_turn = r
                            .metadata
                            .as_ref()
                            .and_then(|metadata| metadata.native_turn_id.as_deref())
                            .or_else(|| r.params["turnId"].as_str());
                        let same_work = submission.as_deref().map_or_else(
                            || {
                                turn.as_deref()
                                    .is_some_and(|turn| request_turn == Some(turn))
                            },
                            |submission| c.runtime_submission.as_deref() == Some(submission),
                        );
                        if r.run_id == run
                            && request_session == Some(session.as_str())
                            && same_work
                            && matches!(r.status.as_str(), "pending" | "responding")
                        {
                            // A terminal turn makes the request non-actionable, but an ACK only
                            // proves delivery. Keep resolution outstanding without native closure evidence.
                            r.status = "withdrawn".into();
                            if r.response_delivery
                                != ade_core::requests::ResponseDelivery::Acknowledged
                            {
                                r.resolution = ade_core::requests::RequestResolution::Withdrawn;
                            }
                        }
                    }
                    changed = true;
                }
                Event::Item {
                    session,
                    submission,
                    item,
                } => {
                    if submission
                        .as_ref()
                        .is_some_and(|submission| c.runtime_submission.as_ref() != Some(submission))
                    {
                        continue;
                    }
                    if !session.is_empty()
                        && Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    let mut item = item;
                    if item.role != "user" {
                        item.client_id = None;
                        // Output no submission owns is the native session's own
                        // work; it is kept as session-attributed, never a prompt.
                        if submission.is_none()
                            && !matches!(
                                c.status.as_str(),
                                "starting"
                                    | "running"
                                    | "responding"
                                    | "streaming"
                                    | "waiting"
                                    | "cancelling"
                            )
                        {
                            c.autonomous_output_at_ms = Some(now_ms());
                        }
                    }
                    let mut m = item.message(id);
                    if m.role == "user" {
                        let previous = messages.get(&m.id).cloned().or(d.store.message(&m.id)?);
                        if let Some(previous) = previous {
                            m.delivery = previous.delivery;
                        }
                    }
                    if !messages.contains_key(&m.id) {
                        order.push(m.id.clone());
                    }
                    messages.insert(m.id.clone(), m);
                    changed = true;
                }
                Event::Delta {
                    session,
                    submission,
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
                    let correlated = (submission.as_deref() == c.runtime_submission.as_deref()
                        && submission.is_some())
                        || turn
                            .as_deref()
                            .is_some_and(|turn| c.active_turn_id.as_deref() == Some(turn));
                    if !correlated {
                        continue;
                    }
                    let mid = format!("{id}:{item}");
                    if !messages.contains_key(&mid) {
                        let m = d.store.message(&mid)?.unwrap_or_else(|| Message {
                            content: None,
                            review_feedback: None,
                            delivery: None,
                            attachments: vec![],
                            id: mid.clone(),
                            conversation_id: id.into(),
                            role,
                            kind,
                            text: String::new(),
                            status: "streaming".into(),
                            turn_id: turn,
                            provider_item_id: Some(item),
                            native_message: None,
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
                Event::Resolved {
                    session,
                    submission,
                    id: request_id,
                    resolution,
                } => {
                    if session.is_empty()
                        || c.provider_thread_id.as_deref() != Some(session.as_str())
                        || submission.as_ref().is_some_and(|submission| {
                            c.runtime_submission.as_ref() != Some(submission)
                        })
                    {
                        continue;
                    }
                    let resolution = resolution.unwrap_or_default();
                    for r in requests.values_mut() {
                        if r.run_id == run
                            && resolved_request_matches(r.metadata.as_ref(), &session, &request_id)
                            && matches!(r.status.as_str(), "pending" | "responding")
                        {
                            r.status =
                                if resolution == ade_core::requests::RequestResolution::Withdrawn {
                                    "withdrawn"
                                } else {
                                    "resolved"
                                }
                                .into();
                            r.resolution = resolution.clone();
                            if matches!(
                                r.response_delivery,
                                ade_core::requests::ResponseDelivery::Admitted
                                    | ade_core::requests::ResponseDelivery::Dispatched
                            ) {
                                r.response_delivery = ade_core::requests::ResponseDelivery::Unknown;
                            }
                            changed = true;
                        }
                    }
                    if c.status == "waiting" && !requests.values().any(|r| r.status == "pending") {
                        c.status = "running".into();
                    }
                }
                Event::Error { error, turn } => {
                    // R003: a late error of a cancelled or finished turn
                    // never lands on the turn that runs now.
                    if another_turn(c.active_turn_id.as_deref(), turn.as_deref()) {
                        continue;
                    }
                    c.error = Some(error);
                    changed = true;
                }
                Event::Background {
                    session,
                    active,
                    running,
                    source,
                } => {
                    if session.is_empty()
                        || Some(session.as_str()) != c.provider_thread_id.as_deref()
                    {
                        continue;
                    }
                    c.background = Some(ade_core::model::BackgroundActivity {
                        source_attempt_id: run.into(),
                        active,
                        running,
                        source,
                        observed_at_ms: now_ms(),
                    });
                }
                Event::Settings { session, settings } => {
                    if Some(session.as_str()) != c.provider_thread_id.as_deref() {
                        continue;
                    }
                    // The newest report wins for each value it names; a value
                    // it leaves out keeps what the session reported before.
                    let mut reported = c.native_settings.clone().unwrap_or_default();
                    let bounded = |value: Option<String>| {
                        value.filter(|v| !v.is_empty() && v.len() <= 256 && !v.contains('\0'))
                    };
                    for (slot, value) in [
                        (&mut reported.model, settings.model),
                        (&mut reported.reasoning_effort, settings.reasoning_effort),
                        (&mut reported.permission_mode, settings.permission_mode),
                    ] {
                        if let Some(value) = bounded(value) {
                            *slot = Some(value);
                        }
                    }
                    if c.native_settings.as_ref() != Some(&reported) {
                        c.native_settings = Some(reported);
                        changed = true;
                    }
                }
                Event::Usage {
                    session,
                    turn,
                    submission,
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
                            turn: turn.or(submission),
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
    /// The reply waits at most [`STOP_ACK_WINDOW`] for the provider's
    /// acknowledgement, so a slow or wedged provider never holds the caller.
    /// The Conversation's `stop` record carries the operation on to its
    /// confirmed or unresolved outcome. A refused cancellation leaves the
    /// work running and offers termination; it never kills the provider.
    ///
    /// Stopping existing work must not depend on storage: when the
    /// cancellation cannot be recorded, the provider is still asked to stop
    /// the turn, and the reply reports that the state was not recorded.
    pub(super) fn cancel(
        self: &Arc<Self>,
        operation_id: &str,
        id: &str,
        source_attempt_id: &str,
        submission_id: &str,
        expected_turn: Option<&str>,
    ) -> Result<ade_core::contract::agents::AgentCancelOutcome> {
        use ade_core::contract::agents::{
            AgentCancelOutcome, AgentCancelOutcomeTag, ConversationStop, StopDelivery, StopOutcome,
        };
        let (run, rpc, thread, turn, submission, unrecorded) = {
            let mut d = self.data.lock().unwrap();
            let mut c = d.store.conversation(id)?;
            if let Some(refusal) =
                cancel_refusal(&c.status, c.active_turn_id.as_deref(), expected_turn)
            {
                bail!(refusal);
            }
            ensure!(
                c.runtime_run.as_deref() == Some(source_attempt_id),
                "Cancellation targets a different source attempt"
            );
            ensure!(
                c.runtime_submission.as_deref() == Some(submission_id),
                "Cancellation targets a different submission"
            );
            let a = d
                .agents
                .get(id)
                .ok_or_else(|| anyhow!("Agent is not connected"))?;
            ensure!(
                a.run_id == source_attempt_id && a.submission.as_deref() == Some(submission_id),
                "Cancellation target is no longer active"
            );
            let run = a.run_id.clone();
            let rpc = a.rpc.clone();
            let submission = a
                .submission
                .clone()
                .ok_or_else(|| anyhow!("Cancellation target has no active submission"))?;
            let thread = c.provider_thread_id.clone();
            let turn = c.active_turn_id.clone();
            c.status = "cancelling".into();
            c.queue_paused = true;
            c.stop = Some(ConversationStop {
                operation_id: operation_id.into(),
                source_attempt_id: run.clone(),
                submission_id: submission.clone(),
                turn_id: turn.clone(),
                requested_at_ms: now_ms(),
                delivery: StopDelivery::Pending,
                outcome: StopOutcome::Requested,
                confirmation: None,
                native_status: None,
                evidence: None,
                reason: None,
                escalation: None,
                settled_at_ms: None,
            });
            let unrecorded = match d.store.commit_conversation(&c, &[], &[]) {
                Ok(()) => {
                    self.changed(&mut d, &c, &[])?;
                    None
                }
                Err(error) => Some(error),
            };
            (run, rpc, thread, turn, submission, unrecorded)
        };
        let reply = if let (Some(rpc), Some(thread)) = (rpc, thread) {
            let (sent, received) = std::sync::mpsc::channel();
            let sessions = Arc::clone(self);
            let (id_, operation, run_, submission_, turn_) = (
                id.to_owned(),
                operation_id.to_owned(),
                run.clone(),
                submission.clone(),
                turn.clone(),
            );
            // The provider call runs on its own thread: its reply settles the
            // stop record whenever it arrives, while the caller waits only
            // for the bounded acknowledgement window.
            std::thread::spawn(move || {
                let result = rpc
                    .cancel_target(&thread, &run_, &submission_, turn_.as_deref())
                    .map_err(|error| format!("{error:#}"));
                sessions.record_stop_reply(&id_, &operation, &result);
                let _ = sent.send(result);
            });
            let sessions = Arc::clone(self);
            let (id_, operation) = (id.to_owned(), operation_id.to_owned());
            std::thread::spawn(move || {
                std::thread::sleep(stop_settle_window());
                sessions.expire_stop(&id_, &operation);
            });
            match received.recv_timeout(STOP_ACK_WINDOW) {
                Ok(Ok(evidence)) => (StopDelivery::Acknowledged, Some(evidence)),
                Ok(Err(error)) => {
                    if unrecorded.is_none() {
                        bail!(
                            "The provider refused the cancellation ({error}); the turn may still be running. Terminate the provider process to stop it"
                        );
                    }
                    (StopDelivery::Refused, None)
                }
                Err(_) => (StopDelivery::Pending, None),
            }
        } else {
            self.fail(
                id,
                &run,
                "Cancelled while the Agent was starting; resume the Conversation to continue."
                    .into(),
            );
            (StopDelivery::Unknown, None)
        };
        if let Some(error) = unrecorded {
            bail!(
                "ADE asked the provider to stop this turn but could not record the cancellation ({error:#}); the Conversation updates once storage accepts writes again"
            );
        }
        Ok(AgentCancelOutcome {
            tag: AgentCancelOutcomeTag::AgentCancelOutcome,
            operation_id: operation_id.into(),
            conversation_id: id.into(),
            source_attempt_id: run,
            submission_id: submission,
            turn_id: turn,
            delivery: reply.0,
            evidence: reply.1,
        })
    }
    /// Records the provider's reply to the cancellation `operation`, unless a
    /// later Stop replaced it. Queued native input that can still run, or a
    /// provider that could not interrupt, leaves the Stop unresolved.
    fn record_stop_reply(
        &self,
        id: &str,
        operation: &str,
        result: &std::result::Result<ade_core::contract::providers::ProviderCancelEvidence, String>,
    ) {
        use ade_core::contract::agents::{StopDelivery, StopOutcome};
        use ade_core::contract::providers::ProviderCancelTermination;
        self.update_stop(id, operation, |c| {
            let stop = c.stop.as_mut().unwrap();
            match result {
                Ok(evidence) => {
                    stop.delivery = StopDelivery::Acknowledged;
                    stop.evidence = Some(evidence.clone());
                    if let Some(reason) = remaining_work(evidence) {
                        stop.unresolve(reason);
                    } else if stop.outcome == StopOutcome::Requested {
                        if !evidence.interruption_requested {
                            stop.unresolve("The provider could not interrupt this work".into());
                        } else if evidence.termination == ProviderCancelTermination::Confirmed {
                            stop.confirm(
                                ade_core::contract::agents::StopConfirmation::NativeTerminal,
                                None,
                                now_ms(),
                            );
                        }
                    }
                }
                Err(error) => {
                    stop.delivery = StopDelivery::Refused;
                    if stop.outcome == StopOutcome::Requested {
                        stop.unresolve(format!("The provider refused the cancellation: {error}"));
                    }
                }
            }
            resume_unresolved(c);
        });
    }
    /// Marks the Stop `operation` unresolved when no terminal evidence
    /// arrived within the settlement window.
    pub(super) fn expire_stop(&self, id: &str, operation: &str) {
        use ade_core::contract::agents::StopOutcome;
        self.update_stop(id, operation, |c| {
            let stop = c.stop.as_mut().unwrap();
            if stop.outcome == StopOutcome::Requested {
                stop.unresolve(format!(
                    "The provider did not report the turn ending within {} seconds",
                    stop_settle_window().as_secs_f32()
                ));
            }
            resume_unresolved(c);
        });
    }
    /// Applies `change` to the Conversation while its `stop` is still `operation`.
    fn update_stop(&self, id: &str, operation: &str, change: impl FnOnce(&mut Conversation)) {
        let mut d = self.data.lock().unwrap();
        let Ok(mut c) = d.store.conversation(id) else {
            return;
        };
        if c.stop
            .as_ref()
            .is_none_or(|stop| stop.operation_id != operation)
        {
            return;
        }
        let before = c.clone();
        change(&mut c);
        if serde_json::to_value(&before).ok() == serde_json::to_value(&c).ok() {
            return;
        }
        c.updated_at = now_ms();
        match d.store.commit_conversation(&c, &[], &[]) {
            Ok(()) => {
                if let Err(error) = self.changed(&mut d, &c, &[]) {
                    eprintln!("Could not publish the Stop outcome: {error:#}");
                }
            }
            Err(error) => eprintln!("Could not record the Stop outcome: {error:#}"),
        }
    }
    /// `agent.terminate`: ends the provider process the runtime owns for
    /// `source_attempt_id`, whether or not a turn runs. The runtime's
    /// confirmation of the exit is the evidence; work the provider started
    /// outside that process is not covered.
    pub(super) fn terminate(
        self: &Arc<Self>,
        operation_id: &str,
        id: &str,
        source_attempt_id: &str,
    ) -> Result<ade_core::contract::agents::AgentTerminateOutcome> {
        {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(id)?;
            ensure!(
                c.runtime_run.as_deref() == Some(source_attempt_id),
                "Termination targets a different source attempt; nothing was stopped"
            );
            let a = d
                .agents
                .get(id)
                .ok_or_else(|| anyhow!("No provider process runs for this attempt"))?;
            ensure!(
                a.run_id == source_attempt_id,
                "Termination targets a different source attempt; nothing was stopped"
            );
            ensure!(!a.stopping, "The provider process is already stopping");
        }
        let stopped = self.fail_if(
            id,
            source_attempt_id,
            "Stopped by terminating the provider process".into(),
            None,
        );
        let background = {
            let d = self.data.lock().unwrap();
            d.store.conversation(id).ok().and_then(|c| {
                c.stop
                    .and_then(|stop| stop.evidence)
                    .and_then(|evidence| evidence.background_work_remaining)
            })
        };
        let process_exited = matches!(stopped, Some(Ok(())));
        let mut limits = Vec::new();
        if !process_exited {
            limits.push(match stopped {
                Some(Err(error)) => {
                    format!("The runtime could not confirm the provider process exited: {error}")
                }
                _ => "The provider process was already gone or was being stopped elsewhere".into(),
            });
        }
        if background != Some(false) {
            limits.push(
                "Child or background processes the provider started may survive the provider process"
                    .into(),
            );
        }
        Ok(ade_core::contract::agents::AgentTerminateOutcome {
            tag: Default::default(),
            operation_id: operation_id.into(),
            conversation_id: id.into(),
            source_attempt_id: source_attempt_id.into(),
            process_exited,
            limits,
        })
    }
    pub(super) fn answer_typed(
        &self,
        request: &ade_core::requests::AgentAnswerRequest,
    ) -> Result<ade_core::contract::conversations::AgentAnswerOutcome> {
        use ade_core::requests::{PendingRequest as PublicPending, ResponseDelivery};
        let mut payload = serde_json::to_value(&request.answer)?;
        payload.sort_all_objects();
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&payload)?));
        let (rpc, native) = {
            let d = self.data.lock().unwrap();
            let c = d.store.conversation(&request.conversation_id)?;
            let mut p = d
                .store
                .interaction(&request.conversation_id, &request.request_id)?
                .ok_or_else(|| anyhow!("Request is stale or no longer available"))?;
            ensure!(
                p.source_attempt_id == request.source_attempt_id,
                "Request belongs to a different source attempt"
            );
            ensure!(
                p.revision == request.request_revision,
                "Request revision is stale"
            );
            let metadata = p
                .metadata
                .clone()
                .ok_or_else(|| anyhow!("Request has no safe typed answer schema"))?;
            let public = PublicPending {
                id: p.id.clone(),
                conversation_id: p.conversation_id.clone(),
                source_attempt_id: p.source_attempt_id.clone(),
                revision: p.revision,
                metadata,
                resolution: p.resolution.clone(),
                response_delivery: p.response_delivery.clone(),
                response_operation_id: p.response_operation_id.clone(),
            };
            public.metadata.validate_not_expired()?;
            let dispatch_now = p.response_operation_id.is_none();
            if let Some(operation) = &p.response_operation_id {
                ensure!(
                    operation == &request.operation_id,
                    "Request already has a different answer operation"
                );
                ensure!(
                    p.answer_fingerprint.as_deref() == Some(fingerprint.as_str()),
                    "Answer conflicts with the recorded answer"
                );
            } else {
                ensure!(
                    p.resolution == ade_core::requests::RequestResolution::Outstanding,
                    "Request is no longer outstanding"
                );
                ensure!(
                    matches!(p.status.as_str(), "pending" | "responding"),
                    "Request is no longer actionable"
                );
                let native = p
                    .metadata
                    .as_ref()
                    .ok_or_else(|| anyhow!("Request has no native provenance"))?;
                ensure!(
                    native.native_session_id.as_deref() == c.provider_thread_id.as_deref(),
                    "Request belongs to another native session"
                );
                if p.source_attempt_id.is_some() {
                    ensure!(
                        native.native_turn_id.as_deref() == c.active_turn_id.as_deref(),
                        "Request belongs to another native turn"
                    );
                }
                public.validate_answer(request)?;
                p.response_operation_id = Some(request.operation_id.clone());
                p.answer_fingerprint = Some(fingerprint.clone());
                p.response_delivery = ResponseDelivery::Dispatched;
                p.status = "responding".into();
                d.store.commit_conversation(&c, &[], &[p.clone()])?;
            }
            if p.response_delivery == ResponseDelivery::Acknowledged
                || p.resolution != ade_core::requests::RequestResolution::Outstanding
            {
                return Ok(ade_core::contract::conversations::AgentAnswerOutcome {
                    tag: Default::default(),
                    operation_id: request.operation_id.clone(),
                    request_id: p.id,
                    source_attempt_id: p.source_attempt_id,
                    request_revision: p.revision,
                    response_delivery: p.response_delivery,
                    resolution: p.resolution,
                    error: None,
                });
            }
            if !dispatch_now
                && matches!(
                    p.response_delivery,
                    ResponseDelivery::Admitted
                        | ResponseDelivery::Dispatched
                        | ResponseDelivery::Unknown
                )
            {
                if p.response_delivery != ResponseDelivery::Unknown {
                    p.response_delivery = ResponseDelivery::Unknown;
                    d.store.commit_conversation(&c, &[], &[p.clone()])?;
                }
                return Ok(ade_core::contract::conversations::AgentAnswerOutcome {
                    tag: Default::default(),
                    operation_id: request.operation_id.clone(),
                    request_id: p.id,
                    source_attempt_id: p.source_attempt_id,
                    request_revision: p.revision,
                    response_delivery: ResponseDelivery::Unknown,
                    resolution: p.resolution,
                    error: None,
                });
            }
            if p.response_delivery == ResponseDelivery::NotSent {
                p.response_delivery = ResponseDelivery::Dispatched;
                d.store.commit_conversation(&c, &[], &[p.clone()])?;
            }
            ensure!(
                Self::owns(&d, &request.conversation_id, &p.run_id),
                "Request belongs to a previous Agent run"
            );
            let rpc = d
                .agents
                .get(&request.conversation_id)
                .and_then(|a| a.rpc.clone())
                .ok_or_else(|| anyhow!("Agent is unavailable"))?;
            (rpc, p)
        };
        e2e_answer_exit("before_delivery");
        let result = rpc.answer_native(&native, &request.operation_id, &request.answer);
        if result.is_ok() {
            e2e_answer_exit("after_delivery");
        }
        let mut d = self.data.lock().unwrap();
        let c = d.store.conversation(&request.conversation_id)?;
        let mut p = d
            .store
            .interaction(&request.conversation_id, &request.request_id)?
            .ok_or_else(|| anyhow!("Request disappeared after answer dispatch"))?;
        ensure!(
            p.response_operation_id.as_deref() == Some(&request.operation_id),
            "Answer operation changed during dispatch"
        );
        let not_sent = result.as_ref().err().is_some_and(|error| {
            error
                .downcast_ref::<crate::agent_runtime::AnswerNotSent>()
                .is_some()
        });
        if not_sent {
            ensure!(
                p.answer_attempt < 32,
                "Answer retry limit reached; inspect the provider request"
            );
            p.answer_attempt += 1;
            p.response_delivery = ResponseDelivery::NotSent;
        } else {
            p.response_delivery = if result.is_ok() {
                ResponseDelivery::Acknowledged
            } else {
                ResponseDelivery::Unknown
            };
        }
        d.store.commit_conversation(&c, &[], &[p.clone()])?;
        self.changed(&mut d, &c, &[])?;
        let error = result.err().map(|e| e.to_string());
        Ok(ade_core::contract::conversations::AgentAnswerOutcome {
            tag: Default::default(),
            operation_id: request.operation_id.clone(),
            request_id: p.id,
            source_attempt_id: p.source_attempt_id,
            request_revision: p.revision,
            response_delivery: p.response_delivery,
            resolution: p.resolution,
            error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_withdrawal_uses_native_request_id_not_local_responder_id() {
        let metadata = ade_core::requests::RequestMetadata {
            schema_version: 1,
            summary: "fixture".into(),
            schema: ade_core::requests::RequestSchema::Unsupported {
                reason: "fixture".into(),
            },
            blocking: None,
            created_at_ms: None,
            expires_at_ms: None,
            native_revision: None,
            native_session_id: Some("session-a".into()),
            native_turn_id: None,
            native_request_id: serde_json::json!("native-control-a"),
            native_item_id: None,
            native_callback_id: Some(serde_json::json!("local-responder-a")),
        };
        assert!(resolved_request_matches(
            Some(&metadata),
            "session-a",
            &serde_json::json!("native-control-a")
        ));
        assert!(!resolved_request_matches(
            Some(&metadata),
            "session-b",
            &serde_json::json!("native-control-a")
        ));
        assert!(!resolved_request_matches(
            Some(&metadata),
            "session-a",
            &serde_json::json!("local-responder-a")
        ));
    }
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
    fn a_wake_received_while_the_cancelled_turn_ends_is_kept() {
        // Cancelled, then the person resumed the queue before the turn ended.
        assert!(!pauses_queue("interrupted", Some("turn-a"), "turn-a"));
        // No resume, or a resume during another turn: the interruption pauses.
        assert!(pauses_queue("interrupted", None, "turn-a"));
        assert!(pauses_queue("error", Some("turn-old"), "turn-a"));
        // A completed turn never pauses the queue.
        assert!(!pauses_queue("ready", None, "turn-a"));
        assert!(!pauses_queue(
            "interrupted",
            Some("submission-a"),
            "submission-a"
        ));
        assert!(pauses_queue(
            "interrupted",
            Some("submission-old"),
            "submission-a"
        ));
    }

    #[test]
    fn a_late_event_of_another_turn_is_fenced_from_the_active_one() {
        // The successor runs; the cancelled turn's late error is stale.
        assert!(another_turn(Some("turn-b"), Some("turn-a")));
        // Nothing runs any more: a late error of the finished turn is stale too.
        assert!(another_turn(None, Some("turn-a")));
        // The active turn's own error, and an error that names no turn, apply.
        assert!(!another_turn(Some("turn-b"), Some("turn-b")));
        assert!(!another_turn(Some("turn-b"), None));
        assert!(!another_turn(None, None));
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
