//! Conversation, draft, queue, attachment, agent and window operations.
use super::*;
use ade_core::contract::agents::{
    AgentCancelRequest, AgentChildTranscriptRequest, AgentDisconnectRequest, AgentResumeRequest,
    AgentTerminateRequest, ChildTranscriptPage,
};
use ade_core::contract::conversations::{
    Ack, AgentAnswerRequest, AgentSendRequest, AttachmentImportRequest, AttachmentInspectRequest,
    AttachmentInspection, AttachmentPutRequest, AttachmentReclaim, AttachmentReclaimApplyRequest,
    AttachmentReclaimPreviewReply, AttachmentReclaimPreviewRequest, AttachmentReply,
    ConversationCreateRequest, ConversationCreated, ConversationGetRequest,
    ConversationMarkSeenRequest, ConversationSnapshot, DraftGetRequest, DraftReply,
    DraftSaveRequest, DraftSendAbortRequest, DraftSendAcknowledgeRequest, DraftSendCompleteRequest,
    DraftSendGetRequest, DraftSendListRequest, DraftSendPrepareRequest, PendingSendList,
    QueueCancelRequest, QueueEnqueueRequest, QueuePauseRequest, SendAcknowledged,
    SendIntentPrepared, SendIntentState,
};

/// Why `agent.disconnect` must refuse a Conversation, if it must.
///
/// An imported conversation stays read-only: marking it "disconnected" would
/// let a later send start a fresh native session under imported history.
fn disconnect_refusal(status: &str) -> Option<String> {
    if status == crate::history::import::IMPORTED_STATUS {
        return Some(format!(
            "This conversation is an imported native session and is read-only: {}",
            crate::history::import::RESUME_UNAVAILABLE
        ));
    }
    if matches!(status, "starting" | "running" | "waiting" | "cancelling") {
        return Some("Cancel the active turn before disconnecting".into());
    }
    None
}

/// Checks a field before decoding, so it keeps its established error message.
fn field<'a, T>(
    request: &'a Value,
    key: &str,
    read: fn(&'a Value) -> Option<T>,
    message: &str,
) -> Result<()> {
    read(&request[key]).map(drop).context(message.to_owned())
}

/// The reply budget of one `conversation.export` page.
const EXPORT_PAGE_BYTES: usize = 4 * 1024 * 1024;

impl Sessions {
    /// `agent.disconnect`: stops the Conversation's Agent, if one runs, and
    /// marks it disconnected. `workspace.remove` uses it for idle Agents.
    pub(super) fn disconnect(&self, id: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        let c = d.store.conversation(id)?;
        if let Some(refusal) = disconnect_refusal(&c.status) {
            bail!(refusal);
        }
        // The provider stop can take a full shutdown escalation, so it
        // runs without the session lock.
        if let Some((run, rpc)) = Self::begin_stop(&mut d, id)? {
            drop(d);
            self.finish_stop(id, &run, rpc)?;
            d = self.data.lock().unwrap();
            if Self::owns(&d, id, &run) {
                d.agents.remove(id);
            }
        }
        let mut c = d.store.conversation(id)?;
        c.status = "disconnected".into();
        c.updated_at = now_ms();
        d.store.commit_conversation(&c, &[], &[])?;
        self.changed(&mut d, &c, &[])?;
        Ok(())
    }
    fn attach(&self, conversation: &str, id: &str, name: &str, bytes: &[u8]) -> Result<Value> {
        let attachment = self.data.lock().unwrap().store.attach(
            non_empty("conversation_id", conversation)?,
            non_empty("request_id", id)?,
            name,
            bytes,
        )?;
        reply(&AttachmentReply {
            tag: Default::default(),
            attachment,
        })
    }

    /// Applies one queue change under the store lock and publishes the Conversation.
    pub(super) fn queue_change(
        &self,
        conversation: &str,
        change: impl FnOnce(&mut Data, &mut Conversation) -> Result<()>,
    ) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        let id = non_empty("conversation_id", conversation)?;
        let mut c = d.store.conversation(id)?;
        change(&mut d, &mut c)?;
        self.changed(&mut d, &c, &[])?;
        reply(&Ack::default())
    }

    pub(super) fn conversation_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "attachment.inspect" => {
                let inspect: AttachmentInspectRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &inspect.conversation_id)?;
                let id = non_empty("attachment_id", &inspect.attachment_id)?;
                let (attachment, sha256) = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .attachment_inspect(conversation, id)?;
                reply(&AttachmentInspection {
                    tag: Default::default(),
                    attachment,
                    sha256,
                })
            }
            "attachment.reclaim.preview" => {
                let inspect: AttachmentReclaimPreviewRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &inspect.conversation_id)?;
                let id = non_empty("attachment_id", &inspect.attachment_id)?;
                let preview = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .attachment_reclaim_preview(conversation, id)?;
                reply(&AttachmentReclaimPreviewReply {
                    tag: Default::default(),
                    preview,
                    scope: Default::default(),
                    automatic_gc_eligible: false,
                    client_held_uploads: Default::default(),
                    filesystem_reclaimed_bytes: 0,
                })
            }
            "attachment.reclaim.apply" => {
                let apply: AttachmentReclaimApplyRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &apply.conversation_id)?;
                let id = non_empty("attachment_id", &apply.attachment_id)?;
                let generation = non_empty("expected_generation", &apply.expected_generation)?;
                let (attachment, reclaimed) = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .attachment_reclaim_apply(conversation, id, generation)?;
                reply(&AttachmentReclaim {
                    tag: Default::default(),
                    attachment,
                    reclaimed_payload_bytes: reclaimed,
                    filesystem_reclaimed_bytes: 0,
                    scope: Default::default(),
                })
            }
            "attachment.import" => {
                use std::io::Read;
                use std::os::unix::fs::OpenOptionsExt;
                let import: AttachmentImportRequest = decode(request)?;
                let path = std::path::Path::new(non_empty("path", &import.path)?);
                let file = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(path)?;
                ensure!(file.metadata()?.is_file(), "Attach a regular file");
                let mut bytes = Vec::new();
                file.take(crate::prompt::ATTACHMENT_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)?;
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .context("Invalid file name")?;
                self.attach(&import.conversation_id, &import.request_id, name, &bytes)
            }
            "attachment.put" => {
                use base64::Engine;
                let put: AttachmentPutRequest = decode(request)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(non_empty("data", &put.data)?)?;
                let name = non_empty("name", &put.name)?;
                self.attach(&put.conversation_id, &put.request_id, name, &bytes)
            }
            "conversation.create" => {
                if let Some(value) = request.get("account_id") {
                    value.as_str().context("Invalid account ID")?;
                }
                let create: ConversationCreateRequest = decode(request)?;
                let title = create.title.as_deref().unwrap_or("New Conversation");
                ensure!(title.len() <= 256, "Title is too long");
                let workspace = non_empty("workspace_id", &create.workspace_id)?;
                let (provider, provider_config) = match create.preset.as_deref() {
                    None => (
                        create.provider.clone().unwrap_or_else(|| "codex".into()),
                        serde_json::from_value(
                            create.provider_config.unwrap_or_else(|| json!({})),
                        )?,
                    ),
                    Some(name) => {
                        ensure!(
                            create.provider_config.is_none(),
                            "Pass either a preset or provider settings, not both"
                        );
                        let preset = self
                            .presets
                            .get(name)?
                            .ok_or_else(|| anyhow!("No preset is named {}", name.trim()))?;
                        let checked = crate::capabilities::core::check(
                            preset,
                            &crate::capabilities::records(),
                        );
                        let settings =
                            crate::capabilities::core::apply(&checked, create.provider.as_deref())?;
                        (
                            settings.provider.clone(),
                            crate::provider::Config {
                                model: settings.model.clone(),
                                permission_mode: settings.permission_mode.clone(),
                                setting_sources: vec![],
                                // A preset's reasoning level was dropped here before.
                                reasoning_effort: settings.reasoning.clone(),
                            },
                        )
                    }
                };
                let provider = provider.as_str();
                // Adapters and plugin providers are validated through the
                // provider registry, not the static catalogue.
                let registered = self.registered_descriptor(provider)?;
                if registered.is_some() && create.account_id.is_some() {
                    self.ensure_managed_accounts(provider)?;
                }
                let mut d = self.data.lock().unwrap();
                let conversation = match &registered {
                    None => d.store.create_with_account(
                        workspace,
                        title,
                        provider,
                        provider_config,
                        create.account_id.as_deref(),
                    )?,
                    Some(descriptor) => d.store.create_registered(
                        workspace,
                        title,
                        descriptor,
                        provider_config,
                        create.account_id.as_deref(),
                    )?,
                };
                self.pin_new(&conversation)?;
                self.catalog_changed(&mut d)?;
                reply(&ConversationCreated {
                    tag: Default::default(),
                    conversation: self.presented(&d, &conversation)?,
                })
            }
            "conversation.mark_seen" => {
                let seen: ConversationMarkSeenRequest = decode(request)?;
                let id = non_empty("conversation_id", &seen.conversation_id)?;
                let mut d = self.data.lock().unwrap();
                let current = d.store.conversation(id)?;
                // A time past the last change counts as the last change, so a
                // change the client has not shown stays unread.
                let through = seen.through.map(|through| through.min(current.updated_at));
                if d.store.mark_seen(id, through)? {
                    self.changed(&mut d, &current, &[])?;
                }
                reply(&Ack::default())
            }
            "conversation.history" => self.native_history_query(request),
            "conversation.export" => {
                use ade_core::contract::conversations::{
                    ConversationExport, ConversationExportRequest, ExportContinuity,
                    ExportedAttachment, ExportedMessage,
                };
                let export: ConversationExportRequest = decode(request)?;
                let id = non_empty("conversation_id", &export.conversation_id)?;
                let limit = export.limit.unwrap_or(32) as usize;
                ensure!(
                    (1..=32).contains(&limit),
                    ade_core::error::Failure::ResourceLimit
                );
                let provider = self.data.lock().unwrap().store.conversation(id)?.provider;
                let provider_available = self
                    .provider_descriptors()
                    .iter()
                    .any(|descriptor| descriptor.id == provider);
                let d = self.data.lock().unwrap();
                let conversation = self.presented(&d, &d.store.conversation(id)?)?;
                let (page, mut more) =
                    d.store
                        .messages_after(id, export.after_sequence.unwrap_or(i64::MIN), limit)?;
                let mut messages: Vec<ExportedMessage> = Vec::with_capacity(page.len());
                // A page holds as many whole messages as fit the reply budget, at least one.
                let mut used = ade_core::json_budget::Usage { bytes: 2, nodes: 1 };
                for message in page {
                    let attachments = message
                        .attachments
                        .iter()
                        .map(|attachment| ExportedAttachment {
                            state: d
                                .store
                                .attachment_reclaim_preview(id, &attachment.id)
                                .map_or_else(|_| "missing".into(), |preview| preview.state),
                            attachment: attachment.clone(),
                        })
                        .collect();
                    let entry = ExportedMessage {
                        message,
                        attachments,
                    };
                    let size = ade_core::json_budget::encoded_usage(&entry, EXPORT_PAGE_BYTES)?
                        .context(ade_core::error::Failure::ResourceLimit)?;
                    if !used.fits_with(size, EXPORT_PAGE_BYTES) {
                        ensure!(
                            !messages.is_empty(),
                            ade_core::error::Failure::ResourceLimit
                        );
                        more = true;
                        break;
                    }
                    used.add(size);
                    messages.push(entry);
                }
                let native_session = conversation.provider_thread_id.clone();
                let imported = Self::ensure_not_imported(&conversation).is_err();
                let native_resume_possible =
                    provider_available && native_session.is_some() && !imported;
                reply(&ConversationExport {
                    tag: Default::default(),
                    boot_id: self.boot_id.clone(),
                    revision: d.revision,
                    history_epoch: d.store.history_epoch(id)?,
                    continuity: ExportContinuity {
                        provider_available,
                        reason: match (provider_available, &native_session) {
                            _ if imported => format!(
                                "Imported native history is read-only: {}",
                                crate::history::import::RESUME_UNAVAILABLE
                            ),
                            (false, _) => format!(
                                "Provider {} is not installed in this profile; the history stays readable, and nothing can continue it natively",
                                conversation.provider
                            ),
                            (true, None) => "No native session was recorded; a resume starts a new one".into(),
                            (true, Some(_)) => "The provider is installed; resuming reopens the recorded native session".into(),
                        },
                        native_session,
                        native_resume_possible,
                    },
                    next_after_sequence: more
                        .then(|| messages.last().map(|m: &ExportedMessage| m.message.sequence))
                        .flatten(),
                    messages,
                    conversation,
                    not_included: vec![
                        "Provider-native history ADE never retained".into(),
                        "Private reasoning the provider did not expose".into(),
                    ],
                })
            }
            "conversation.get" => {
                let get: ConversationGetRequest = decode(request)?;
                let id = non_empty("conversation_id", &get.conversation_id)?;
                let limit = get.limit.unwrap_or(32) as usize;
                ensure!(limit <= 32, ade_core::error::Failure::ResourceLimit);
                let d = self.data.lock().unwrap();
                let conversation = d.store.conversation(id)?;
                let history_epoch = d.store.history_epoch(id)?;
                // A page older than the caller's first read belongs to the
                // history it read; after a rewind that history is gone.
                if let (Some(_), Some(seen)) = (get.before, get.history_epoch) {
                    ensure!(
                        seen == history_epoch,
                        "History changed since that page was read: a rewind replaced it (epoch {seen}, now {history_epoch}). Reload from the newest page"
                    );
                }
                reply(&ConversationSnapshot {
                    tag: Default::default(),
                    conversation: self.presented(&d, &conversation)?,
                    messages: d.store.messages(id, get.before, limit)?,
                    requests: d
                        .store
                        .pending(id)?
                        .into_iter()
                        .map(super::project_pending_request)
                        .collect(),
                    queued: d.store.queued(id)?,
                    boot_id: self.boot_id.clone(),
                    revision: d.revision,
                    history_epoch,
                })
            }
            "agent.child_transcript" => {
                let page: AgentChildTranscriptRequest = decode(request)?;
                let id = non_empty("conversation_id", &page.conversation_id)?;
                let child = non_empty("child_id", &page.child_id)?;
                let offset = page.offset.unwrap_or(0);
                ensure!(offset <= 100_000, "Child transcript offset is too large");
                let cursor = page.cursor.as_deref();
                ensure!(
                    cursor.is_none_or(|c| !c.is_empty() && c.len() <= 4096),
                    "Invalid child transcript cursor"
                );
                let (rpc, session) = {
                    let d = self.data.lock().unwrap();
                    let c = d.store.conversation(id)?;
                    let message = d
                        .store
                        .message(non_empty("message_id", &page.message_id)?)?
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
                let page: ChildTranscriptPage =
                    serde_json::from_value(rpc.child_transcript(&session, child, offset, cursor)?)
                        .context("Provider returned an invalid child transcript page")?;
                reply(&page)
            }
            "draft.get" => {
                let get: DraftGetRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &get.conversation_id)?;
                let window = non_empty("window_id", &get.window_id)?;
                reply(&DraftReply {
                    tag: Default::default(),
                    draft: self
                        .data
                        .lock()
                        .unwrap()
                        .store
                        .draft(conversation, window)?,
                })
            }
            "draft.save" => {
                field(request, "text", Value::as_str, "Missing draft text")?;
                field(request, "revision", Value::as_i64, "Missing draft revision")?;
                let save: DraftSaveRequest = decode(request)?;
                let draft = crate::model::Draft {
                    attachments: save.attachments,
                    context_nodes: save.context_nodes,
                    text: save.text,
                    revision: save.revision,
                };
                let data = self.data.lock().unwrap();
                let conversation = non_empty("conversation_id", &save.conversation_id)?;
                let window = non_empty("window_id", &save.window_id)?;
                // Explicit conflict resolution must not overwrite a third writer
                // that saved after the user reviewed the conflicting draft.
                let saved = if let Some(expected) = save.expected_revision {
                    data.store
                        .resolve_draft(conversation, window, &draft, expected)
                } else {
                    data.store.save_draft(conversation, window, &draft)
                };
                reply(&DraftReply {
                    tag: Default::default(),
                    draft: persistence_result(saved)?,
                })
            }
            "draft.send.get" => {
                let get: DraftSendGetRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &get.conversation_id)?;
                let window = non_empty("window_id", &get.window_id)?;
                let data = self.data.lock().unwrap();
                reply(&SendIntentState {
                    tag: Default::default(),
                    intent: data.store.send_intent(conversation, window)?,
                    restored_from_backup: data.store.restored_from_backup()?,
                })
            }
            "draft.send.prepare" => {
                field(request, "draft_text", Value::as_str, "Missing draft text")?;
                field(request, "revision", Value::as_i64, "Missing draft revision")?;
                field(request, "text", Value::as_str, "Missing prompt text")?;
                let prepare: DraftSendPrepareRequest = decode(request)?;
                let draft = crate::model::Draft {
                    text: prepare.draft_text,
                    revision: prepare.revision,
                    attachments: prepare.attachments,
                    context_nodes: prepare.context_nodes,
                };
                let data = self.data.lock().unwrap();
                let intent = persistence_result(data.store.prepare_send_intent(
                    non_empty("conversation_id", &prepare.conversation_id)?,
                    non_empty("window_id", &prepare.window_id)?,
                    non_empty("request_id", &prepare.request_id)?,
                    &draft,
                    &prepare.text,
                ))?;
                reply(&SendIntentPrepared {
                    tag: Default::default(),
                    intent,
                })
            }
            "draft.send.complete" => {
                let complete: DraftSendCompleteRequest = decode(request)?;
                let data = self.data.lock().unwrap();
                let draft = persistence_result(data.store.complete_send_intent(
                    non_empty("conversation_id", &complete.conversation_id)?,
                    non_empty("window_id", &complete.window_id)?,
                    non_empty("request_id", &complete.request_id)?,
                ))?;
                reply(&DraftReply {
                    tag: Default::default(),
                    draft,
                })
            }
            "draft.send.abort" => {
                let abort: DraftSendAbortRequest = decode(request)?;
                let data = self.data.lock().unwrap();
                let draft = persistence_result(data.store.abort_send_intent(
                    non_empty("conversation_id", &abort.conversation_id)?,
                    non_empty("window_id", &abort.window_id)?,
                    non_empty("request_id", &abort.request_id)?,
                ))?;
                reply(&DraftReply {
                    tag: Default::default(),
                    draft,
                })
            }
            "draft.send.list" => {
                let list: DraftSendListRequest = decode(request)?;
                let window = non_empty("window_id", &list.window_id)?;
                let limit = crate::store::send_list_limit(list.limit)?;
                let data = self.data.lock().unwrap();
                let (sends, next_cursor) = persistence_result(data.store.pending_sends(
                    window,
                    list.after.as_deref(),
                    limit,
                ))?;
                reply(&PendingSendList {
                    tag: Default::default(),
                    sends,
                    restored_from_backup: data.store.restored_from_backup()?,
                    next_cursor,
                })
            }
            "draft.send.acknowledge" => {
                let acknowledge: DraftSendAcknowledgeRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &acknowledge.conversation_id)?;
                let window = non_empty("window_id", &acknowledge.window_id)?;
                let id = non_empty("request_id", &acknowledge.request_id)?;
                let data = self.data.lock().unwrap();
                let (resolution, draft) = persistence_result(data.store.acknowledge_send_intent(
                    conversation,
                    window,
                    id,
                ))?;
                reply(&SendAcknowledged {
                    tag: Default::default(),
                    request_id: id.to_owned(),
                    conversation_id: conversation.to_owned(),
                    resolution,
                    draft,
                })
            }
            "agent.send" => {
                let send: AgentSendRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &send.conversation_id)?;
                let key = non_empty("request_id", &send.request_id)?;
                let text = send.text.as_str();
                let attachments = send.attachments.as_slice();
                if let Err(error) = self.send(conversation, key, text, attachments, false, None) {
                    let data = self.data.lock().unwrap();
                    let _ = data
                        .store
                        .reject_send_intent(conversation, key, text, attachments);
                    return Err(error);
                }
                reply(&Ack::default())
            }
            "queue.enqueue" => {
                field(request, "text", Value::as_str, "Missing prompt text")?;
                let enqueue: QueueEnqueueRequest = decode(request)?;
                self.queue_change(&enqueue.conversation_id, |d, c| {
                    Self::ensure_not_imported(c)?;
                    if !enqueue.attachments.is_empty() {
                        let prompt = d.store.prompt(&c.id, &enqueue.text, &enqueue.attachments)?;
                        ade_core::prompt_context::admit(&c.provider, &prompt)?;
                    }
                    d.store.enqueue_content(
                        &c.id,
                        non_empty("request_id", &enqueue.request_id)?,
                        &enqueue.text,
                        &enqueue.attachments,
                    )?;
                    Ok(())
                })
            }
            "queue.cancel" => {
                let cancel: QueueCancelRequest = decode(request)?;
                self.queue_change(&cancel.conversation_id, |d, c| {
                    d.store
                        .cancel_queued(&c.id, non_empty("request_id", &cancel.request_id)?)
                })
            }
            "queue.pause" => {
                field(request, "paused", Value::as_bool, "Missing paused flag")?;
                let pause: QueuePauseRequest = decode(request)?;
                self.queue_change(&pause.conversation_id, |d, c| {
                    c.queue_paused = pause.paused;
                    c.queue_resumed_during = if pause.paused {
                        None
                    } else {
                        c.active_turn_id
                            .clone()
                            .or_else(|| c.runtime_submission.clone())
                    };
                    if c.error
                        .as_deref()
                        .is_some_and(|message| message.starts_with("Prompt queue paused:"))
                    {
                        c.error = None;
                    }
                    if !c.queue_paused
                        && c.provider_thread_id.is_none()
                        && !d.agents.contains_key(&c.id)
                        && matches!(c.status.as_str(), "error" | "interrupted" | "disconnected")
                    {
                        c.status = "idle".into();
                    }
                    d.store.commit_conversation(c, &[], &[])
                })
            }
            "agent.disconnect" => {
                let disconnect: AgentDisconnectRequest = decode(request)?;
                self.disconnect(non_empty("conversation_id", &disconnect.conversation_id)?)?;
                reply(&Ack::default())
            }
            "agent.resume" => {
                let resume: AgentResumeRequest = decode(request)?;
                let id = non_empty("conversation_id", &resume.conversation_id)?;
                if !resume.continue_interrupted {
                    let d = self.data.lock().unwrap();
                    if let Some(request_id) = super::agents::interrupted_prompt(&d, id)? {
                        bail!(
                            "The outcome of prompt {request_id} is unknown. Resuming reopens its native session, which may continue that work; resume with continue_interrupted to accept that. ADE never resends the prompt"
                        );
                    }
                }
                self.resume(id)?;
                reply(&Ack::default())
            }
            "agent.cancel" => {
                let cancel: AgentCancelRequest = decode(request)?;
                let outcome = self.cancel(
                    &cancel.operation_id,
                    non_empty("conversation_id", &cancel.conversation_id)?,
                    non_empty("source_attempt_id", &cancel.source_attempt_id)?,
                    non_empty("submission_id", &cancel.submission_id)?,
                    cancel.turn_id.as_deref(),
                )?;
                reply(&outcome)
            }
            "agent.terminate" => {
                let terminate: AgentTerminateRequest = decode(request)?;
                let outcome = self.terminate(
                    &terminate.operation_id,
                    non_empty("conversation_id", &terminate.conversation_id)?,
                    non_empty("source_attempt_id", &terminate.source_attempt_id)?,
                )?;
                reply(&outcome)
            }
            "agent.answer" => {
                let answer: AgentAnswerRequest = decode(request)?;
                let outcome = self.answer_typed(&answer)?;
                reply(&outcome)
            }
            _ => bail!("Unknown session operation"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_imported_conversation_is_never_disconnected_into_a_sendable_one() {
        let refusal = disconnect_refusal(crate::history::import::IMPORTED_STATUS);
        assert!(refusal.is_some_and(|reason| reason.contains("read-only")));
    }

    #[test]
    fn disconnect_keeps_its_active_turn_refusals() {
        for busy in ["starting", "running", "waiting", "cancelling"] {
            assert!(disconnect_refusal(busy).is_some());
        }
        for idle in ["idle", "ready", "error", "interrupted", "disconnected"] {
            assert_eq!(disconnect_refusal(idle), None);
        }
    }
}
