//! Conversation, draft, queue, attachment, agent and window operations.
use super::*;
use ade_core::contract::agents::{
    AgentCancelRequest, AgentChildTranscriptRequest, AgentDisconnectRequest, AgentResumeRequest,
    AgentSendReviewRequest, ChildTranscriptPage,
};
use ade_core::contract::conversations::{
    Ack, AgentAnswerRequest, AgentSendRequest, AttachmentImportRequest, AttachmentInspectRequest,
    AttachmentInspection, AttachmentPutRequest, AttachmentReclaim, AttachmentReclaimApplyRequest,
    AttachmentReclaimPreviewReply, AttachmentReclaimPreviewRequest, AttachmentReply,
    ConversationCreateRequest, ConversationCreated, ConversationGetRequest, ConversationSnapshot,
    DraftGetRequest, DraftReply, DraftSaveRequest, DraftSendAbortRequest,
    DraftSendAcknowledgeRequest, DraftSendCompleteRequest, DraftSendGetRequest,
    DraftSendListRequest, DraftSendPrepareRequest, PendingSendList, QueueCancelRequest,
    QueueEnqueueRequest, QueuePauseRequest, SendAcknowledged, SendIntentPrepared, SendIntentState,
    WindowCloseRequest, WindowSaveRequest,
};

/// Why `agent.disconnect` must refuse a Conversation, if it must.
///
/// An imported conversation stays read-only: marking it "disconnected" would
/// let a later send start a fresh native session under imported history.
fn disconnect_refusal(status: &str, terminal_owned: bool) -> Option<String> {
    if status == crate::history::import::IMPORTED_STATUS {
        return Some(format!(
            "This conversation is an imported native session and is read-only: {}",
            crate::history::import::RESUME_UNAVAILABLE
        ));
    }
    if terminal_owned {
        return Some("Return this Conversation from its terminal before disconnecting".into());
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

impl Sessions {
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
    fn queue_change(
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
                            },
                        )
                    }
                };
                let provider = provider.as_str();
                // Adapters and plugin providers are validated through the
                // provider registry, not the static catalogue.
                let registered = self.registered_descriptor(provider)?;
                let mut d = self.data.lock().unwrap();
                let conversation = match &registered {
                    None => d.store.create_with_account(
                        workspace,
                        title,
                        provider,
                        provider_config,
                        create.account_id.as_deref(),
                    )?,
                    Some(descriptor) => {
                        ensure!(
                            create.account_id.is_none(),
                            "{provider} uses the agent's own login; ADE manages no accounts for it"
                        );
                        d.store
                            .create_registered(workspace, title, descriptor, provider_config)?
                    }
                };
                self.pin_new(&conversation)?;
                self.catalog_changed(&mut d)?;
                reply(&ConversationCreated {
                    tag: Default::default(),
                    conversation,
                })
            }
            "conversation.get" => {
                let get: ConversationGetRequest = decode(request)?;
                let id = non_empty("conversation_id", &get.conversation_id)?;
                let limit = get.limit.unwrap_or(50) as usize;
                let d = self.data.lock().unwrap();
                reply(&ConversationSnapshot {
                    tag: Default::default(),
                    conversation: d.store.conversation(id)?,
                    messages: d.store.messages(id, get.before, limit)?,
                    requests: d.store.pending(id)?,
                    queued: d.store.queued(id)?,
                    boot_id: self.boot_id.clone(),
                    revision: d.revision,
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
                ensure!(
                    request.get("review_anchor").is_none()
                        || request.get("review_feedback").is_none(),
                    "Choose one review payload"
                );
                if let Some(feedback) = request.get("review_feedback") {
                    crate::review::feedback_anchors(feedback)?;
                }
                field(request, "draft_text", Value::as_str, "Missing draft text")?;
                field(request, "revision", Value::as_i64, "Missing draft revision")?;
                field(request, "text", Value::as_str, "Missing prompt text")?;
                let prepare: DraftSendPrepareRequest = decode(request)?;
                let draft = crate::model::Draft {
                    text: prepare.draft_text,
                    revision: prepare.revision,
                    attachments: prepare.attachments,
                    context_nodes: Vec::new(),
                };
                let data = self.data.lock().unwrap();
                let intent = persistence_result(
                    data.store.prepare_send_intent(
                        non_empty("conversation_id", &prepare.conversation_id)?,
                        non_empty("window_id", &prepare.window_id)?,
                        non_empty("request_id", &prepare.request_id)?,
                        &draft,
                        &prepare.text,
                        prepare
                            .review_anchor
                            .as_ref()
                            .or(prepare.review_feedback.as_ref()),
                    ),
                )?;
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
                if let Err(error) = self.send(
                    conversation,
                    key,
                    text,
                    attachments,
                    false,
                    SendAdmission::ordinary(),
                ) {
                    let data = self.data.lock().unwrap();
                    let _ = data
                        .store
                        .reject_send_intent(conversation, key, text, attachments);
                    return Err(error);
                }
                reply(&Ack::default())
            }
            "agent.send_review" => {
                // Keep the prompt-specific wording for a missing text field.
                request["text"].as_str().context("Missing prompt text")?;
                let review: AgentSendReviewRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &review.conversation_id)?;
                let key = non_empty("request_id", &review.request_id)?;
                let text = review.text.as_str();
                let anchor = review.review_anchor.as_ref();
                let feedback = review.review_feedback.as_ref();
                ensure!(
                    anchor.is_some() != feedback.is_some(),
                    "Provide one review payload"
                );
                let anchors = if let Some(feedback) = feedback {
                    crate::review::feedback_anchors(feedback)?
                } else {
                    vec![anchor.context("Missing review anchor")?]
                };
                let attachments = review.attachments;
                ensure!(
                    attachments.is_empty(),
                    "Review feedback cannot include attachments"
                );
                let (workspace, binding, common_binding) =
                    {
                        let data = self.data.lock().unwrap();
                        data.store.guard_send_intent(
                            conversation,
                            key,
                            text,
                            &attachments,
                            anchor.or(feedback),
                        )?;
                        let current = data.store.conversation(conversation)?;
                        let workspace = data.store.workspace(&current.workspace_id)?;
                        ensure!(
                            anchors.iter().all(|anchor| anchor["workspace_id"].as_str()
                                == Some(workspace.id.as_str())),
                            "Review feedback targets a different workspace"
                        );
                        let binding = data.store.workspace_binding_identity(&workspace.id)?;
                        let common_binding = workspace
                            .repository_id
                            .as_deref()
                            .map(|id| data.store.repository_binding_identity(id))
                            .transpose()?;
                        (workspace, binding, common_binding)
                    };
                let accepted = self.data.lock().unwrap().store.message(key)?;
                if accepted.is_some_and(|m| {
                    m.conversation_id == conversation
                        && m.role == "user"
                        && m.text == text
                        && m.attachments == attachments
                        && m.review_feedback.as_ref() == feedback
                }) {
                    self.send(
                        conversation,
                        key,
                        text,
                        &attachments,
                        false,
                        SendAdmission {
                            review_anchor: anchor,
                            review_feedback: feedback,
                            prelease: None,
                        },
                    )?;
                    return reply(&Ack::default());
                }
                let lease = {
                    let mut attempts = 0;
                    loop {
                        match self.worktrees.agent_lease(&workspace.root) {
                            Ok(lease) => break lease,
                            Err(error)
                                if attempts < 10
                                    && error.to_string()
                                        == "Worktree setup/lifecycle operation is in progress" =>
                            {
                                attempts += 1;
                                std::thread::sleep(std::time::Duration::from_millis(20));
                            }
                            Err(error) => return Err(error),
                        }
                    }
                };
                let result = self.review.validate_anchors_then(
                    &workspace.root,
                    binding,
                    common_binding,
                    &anchors,
                    || {
                        self.send(
                            conversation,
                            key,
                            text,
                            &attachments,
                            false,
                            SendAdmission {
                                review_anchor: anchor,
                                review_feedback: feedback,
                                prelease: Some(lease),
                            },
                        )
                    },
                );
                if let Err(error) = result {
                    let data = self.data.lock().unwrap();
                    let _ = data
                        .store
                        .reject_send_intent(conversation, key, text, &attachments);
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
                let id = non_empty("conversation_id", &disconnect.conversation_id)?;
                let mut d = self.data.lock().unwrap();
                let c = d.store.conversation(id)?;
                if let Some(refusal) = disconnect_refusal(&c.status, c.terminal_owner.is_some()) {
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
                reply(&Ack::default())
            }
            "agent.resume" => {
                let resume: AgentResumeRequest = decode(request)?;
                self.resume(non_empty("conversation_id", &resume.conversation_id)?)?;
                reply(&Ack::default())
            }
            "agent.cancel" => {
                let cancel: AgentCancelRequest = decode(request)?;
                self.cancel(
                    non_empty("conversation_id", &cancel.conversation_id)?,
                    cancel.turn_id.as_deref(),
                )?;
                reply(&Ack::default())
            }
            "agent.answer" => {
                let answer: AgentAnswerRequest = decode(request)?;
                self.answer(
                    non_empty("conversation_id", &answer.conversation_id)?,
                    non_empty("request_id", &answer.request_id)?,
                    non_empty("decision", &answer.decision)?,
                    answer.answers.as_ref(),
                )?;
                reply(&Ack::default())
            }
            "window.save" => {
                let save: WindowSaveRequest = decode(request)?;
                let window: WindowRecord = serde_json::from_value(save.window)?;
                let d = self.data.lock().unwrap();
                persistence_result(d.store.save_window(&window))?;
                // Layout acknowledgements do not refresh all other windows.
                reply(&Ack::default())
            }
            "window.close" => {
                let close: WindowCloseRequest = decode(request)?;
                let window = non_empty("window_id", &close.window_id)?;
                self.data.lock().unwrap().store.close_window(window)?;
                reply(&Ack::default())
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
        let refusal = disconnect_refusal(crate::history::import::IMPORTED_STATUS, false);
        assert!(refusal.is_some_and(|reason| reason.contains("read-only")));
    }

    #[test]
    fn disconnect_keeps_its_terminal_and_active_turn_refusals() {
        assert!(disconnect_refusal("ready", true).is_some());
        for busy in ["starting", "running", "waiting", "cancelling"] {
            assert!(disconnect_refusal(busy, false).is_some());
        }
        for idle in ["idle", "ready", "error", "interrupted", "disconnected"] {
            assert_eq!(disconnect_refusal(idle, false), None);
        }
    }
}
