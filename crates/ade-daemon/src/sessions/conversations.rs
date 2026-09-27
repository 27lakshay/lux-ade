//! Conversation, draft, queue, attachment, agent and window operations.
use super::*;
use ade_core::contract::conversations::{
    Ack, AgentAnswerRequest, AgentSendRequest, ConversationGetRequest, ConversationSnapshot,
};

impl Sessions {
    pub(super) fn conversation_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let string = required_str(request);
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
                ensure!(
                    request.get("review_anchor").is_none()
                        || request.get("review_feedback").is_none(),
                    "Choose one review payload"
                );
                if let Some(feedback) = request.get("review_feedback") {
                    crate::review::feedback_anchors(feedback)?;
                }
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
                let intent = persistence_result(
                    data.store.prepare_send_intent(
                        string("conversation_id")?,
                        string("window_id")?,
                        string("request_id")?,
                        &draft,
                        request["text"].as_str().context("Missing prompt text")?,
                        request
                            .get("review_anchor")
                            .or(request.get("review_feedback")),
                    ),
                )?;
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
                let conversation = string("conversation_id")?;
                let key = string("request_id")?;
                let text = request["text"].as_str().context("Missing prompt text")?;
                let anchor = request.get("review_anchor");
                let feedback = request.get("review_feedback");
                ensure!(
                    anchor.is_some() != feedback.is_some(),
                    "Provide one review payload"
                );
                let anchors = if let Some(feedback) = feedback {
                    crate::review::feedback_anchors(feedback)?
                } else {
                    vec![anchor.context("Missing review anchor")?]
                };
                let attachments = serde_json::from_value::<Vec<crate::model::Attachment>>(
                    request.get("attachments").cloned().unwrap_or(json!([])),
                )?;
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
                    return Ok(json!({"type":"ack"}));
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
}
