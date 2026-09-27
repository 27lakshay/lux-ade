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
    pub(super) _lease: crate::worktrees::Lease,
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
        let (c, run, rpc, prompt) = {
            let mut d = self.data.lock().unwrap();
            ensure!(
                !d.draining,
                "Application daemon is restarting; prompt remains queued"
            );
            Self::ensure_lease_resolved(&d, &super::leases::LeaseKey::Agent(id.to_owned()))?;
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
            let lease = if let Some(lease) = admission.prelease {
                lease
            } else {
                self.worktrees.agent_lease(&workspace.root)?
            };
            let prompt = d.store.prompt(id, text, attachments)?;
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
            Self::ensure_lease_resolved(&d, &super::leases::LeaseKey::Agent(id.to_owned()))?;
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
    pub(super) fn owns(d: &Data, id: &str, run: &str) -> bool {
        d.agents.get(id).is_some_and(|a| a.run_id == run)
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
        let rpc = Remote::new(
            self.runtime.clone(),
            Spec {
                conversation: id.into(),
                run: run.into(),
                provider: c.provider.clone(),
                root: w.root,
                account,
                worker: None,
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
    pub(super) fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
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
