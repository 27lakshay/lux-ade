//! Prompt context capture (F033) and attachment plans (F032).
//!
//! A capture reads or accepts one selection, bounds it with the pure core in
//! `ade_core::prompt_context`, and records a node and its document in one
//! transaction. A repeated request ID returns the recorded node; the source is
//! never read twice for one ID.
use super::*;
use crate::store::context_nodes::sha256;
use ade_core::contract::context::{
    ContextCaptureRequest, ContextGetRequest, ContextKind, ContextNode, ContextNodeReply,
    ContextOrigin, ContextPlan, ContextPlanRequest, ContextProvenance, ContextSource,
};
use ade_core::contract::files::{FilePreview, PreviewKind};
use ade_core::contract::review::ReviewDiff;
use ade_core::prompt_context::{
    self as core, BODY_LIMIT, Bounded, CLIENT_TEXT_LIMIT, Keep, LINE_LIMIT,
};

/// What a capture produced before it is recorded.
struct Captured {
    kind: ContextKind,
    origin: ContextOrigin,
    provenance: ContextProvenance,
    /// A text capture's attachment name and document.
    document: Option<(String, String)>,
    /// A browser capture's existing attachments and their digests.
    existing: Vec<(Attachment, String)>,
    body: Option<Bounded>,
    truncated: bool,
}

fn text_capture(
    kind: ContextKind,
    origin: ContextOrigin,
    provenance: ContextProvenance,
    title: &str,
    name: String,
    facts: &[(&str, String)],
    body: Bounded,
) -> Captured {
    let document = core::render(title, facts, &body);
    Captured {
        kind,
        origin,
        provenance,
        document: Some((core::attachment_name(&name), document)),
        existing: Vec::new(),
        truncated: body.truncated(),
        body: Some(body),
    }
}

fn client_text(text: &str) -> Result<String> {
    ensure!(
        text.len() <= CLIENT_TEXT_LIMIT,
        "Captured text exceeds 1 MiB; select less"
    );
    let plain = core::plain_text(text);
    ensure!(!plain.trim().is_empty(), "The selection is empty");
    Ok(plain)
}

impl Sessions {
    pub(super) fn context_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "context.capture" => self.context_capture(decode(request)?),
            "context.get" => {
                let get: ContextGetRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &get.conversation_id)?;
                let id = non_empty("node_id", &get.node_id)?;
                let d = self.data.lock().unwrap();
                let (_, node) = d
                    .store
                    .context_node(conversation, id)?
                    .context("No context node has this ID in this Conversation")?;
                self.context_reply(&d.store, node)
            }
            "context.plan" => {
                let plan: ContextPlanRequest = decode(request)?;
                let conversation = non_empty("conversation_id", &plan.conversation_id)?;
                let d = self.data.lock().unwrap();
                let provider = d.store.conversation(conversation)?.provider;
                // Loading the prompt checks every attachment is live and ours.
                let prompt = d
                    .store
                    .prompt(conversation, &plan.text, &plan.attachments)?;
                let planned = core::plan(&provider, &prompt);
                reply(&ContextPlan {
                    tag: Default::default(),
                    admissible: planned.rejections.is_empty(),
                    support: planned.support,
                    parts: planned.parts,
                    rejections: planned.rejections,
                })
            }
            _ => bail!("Unknown context operation"),
        }
    }

    fn context_reply(&self, store: &Store, node: ContextNode) -> Result<Value> {
        let mut available = true;
        for attachment in &node.attachments {
            available &= store
                .attachment_bytes(&node.conversation_id, &attachment.id)?
                .is_some();
        }
        reply(&ContextNodeReply {
            tag: Default::default(),
            node,
            available,
        })
    }

    fn context_capture(self: &Arc<Self>, capture: ContextCaptureRequest) -> Result<Value> {
        let conversation = non_empty("conversation_id", &capture.conversation_id)?.to_owned();
        let id = non_empty("request_id", &capture.request_id)?.to_owned();
        let fingerprint = sha256(&serde_json::to_vec(&capture.source)?);
        let workspace_id = {
            let d = self.data.lock().unwrap();
            if let Some((prior, node)) = d.store.context_node(&conversation, &id)? {
                ensure!(
                    prior == fingerprint,
                    "Context request ID was already used for a different capture"
                );
                return self.context_reply(&d.store, node);
            }
            d.store.conversation(&conversation)?.workspace_id
        };
        let same_workspace = |source: &str| {
            ensure!(
                source == workspace_id,
                "Capture context from this Conversation's workspace"
            );
            Ok(())
        };
        let captured = match &capture.source {
            ContextSource::FileRange {
                workspace_id: source,
                path,
                start_line,
                end_line,
            } => {
                same_workspace(source)?;
                self.capture_file(source, path, *start_line, *end_line)?
            }
            ContextSource::DiffHunk {
                workspace_id: source,
                path,
                staged,
                token,
                hunk,
            } => {
                same_workspace(source)?;
                self.capture_hunk(source, path, *staged, token, *hunk)?
            }
            ContextSource::TerminalOutput {
                workspace_id: source,
                terminal_id,
                text,
                first_row,
            } => {
                same_workspace(source)?;
                let workspace = self.data.lock().unwrap().store.workspace(source)?;
                ensure!(
                    workspace.terminal_id == *terminal_id
                        || workspace.extra_terminals.contains(terminal_id),
                    "The workspace has no terminal with this ID"
                );
                let body = core::bound(&client_text(text)?, BODY_LIMIT, Keep::Tail);
                let mut facts = vec![("Terminal", terminal_id.clone())];
                if let Some(row) = first_row {
                    facts.push(("First row", row.to_string()));
                }
                facts.push(("Origin", "selected in the terminal by the client".into()));
                text_capture(
                    ContextKind::TerminalOutput,
                    ContextOrigin::ClientSupplied,
                    ContextProvenance {
                        workspace_id: Some(source.clone()),
                        terminal_id: Some(terminal_id.clone()),
                        start_line: *first_row,
                        ..Default::default()
                    },
                    "terminal output",
                    format!("terminal {terminal_id}"),
                    &facts,
                    body,
                )
            }
            ContextSource::ServiceLog {
                workspace_id: source,
                service,
                text,
                lines,
            } => {
                same_workspace(source)?;
                ensure!(
                    (1..=LINE_LIMIT).contains(lines),
                    "Capture 1 to {LINE_LIMIT} log lines"
                );
                ensure!(
                    self.data
                        .lock()
                        .unwrap()
                        .store
                        .service_configured(source, service)?,
                    "The workspace has no service with this name"
                );
                let tail = core::tail_lines(&client_text(text)?, *lines);
                let bounded = core::bound(&tail.text, BODY_LIMIT, Keep::Tail);
                let body = Bounded {
                    omitted_bytes: bounded.omitted_bytes + tail.omitted_bytes,
                    omitted_lines: bounded.omitted_lines + tail.omitted_lines,
                    text: bounded.text,
                };
                text_capture(
                    ContextKind::ServiceLog,
                    ContextOrigin::ClientSupplied,
                    ContextProvenance {
                        workspace_id: Some(source.clone()),
                        service: Some(service.clone()),
                        ..Default::default()
                    },
                    "service log",
                    format!("service {service} log"),
                    &[
                        ("Service", service.clone()),
                        ("Requested lines", lines.to_string()),
                        (
                            "Origin",
                            "the service terminal's output, read by the client".into(),
                        ),
                    ],
                    body,
                )
            }
            ContextSource::BrowserCapture { capture_id } => {
                self.capture_browser(&conversation, capture_id)?
            }
        };
        let Captured {
            kind,
            origin,
            provenance,
            document,
            existing,
            body,
            truncated,
        } = captured;
        let node = ContextNode {
            id: id.clone(),
            conversation_id: conversation.clone(),
            kind,
            origin,
            provenance,
            attachments: existing.iter().map(|(a, _)| a.clone()).collect(),
            sha256: existing.into_iter().map(|(_, digest)| digest).collect(),
            truncated,
            omitted_bytes: body.as_ref().map_or(0, |b| b.omitted_bytes),
            omitted_lines: body.as_ref().map_or(0, |b| b.omitted_lines),
            captured_at: now_ms(),
        };
        let d = self.data.lock().unwrap();
        let node = d.store.record_context_node(
            &node,
            &fingerprint,
            document
                .as_ref()
                .map(|(name, text)| (name.as_str(), text.as_bytes())),
        )?;
        self.context_reply(&d.store, node)
    }

    fn capture_file(
        &self,
        workspace_id: &str,
        path: &str,
        start: u64,
        end: u64,
    ) -> Result<Captured> {
        let (workspace, binding) = {
            let data = self.data.lock().unwrap();
            data.store.ensure_workspace_bound(workspace_id)?;
            (
                data.store.workspace(workspace_id)?,
                data.store.workspace_binding_identity(workspace_id)?,
            )
        };
        let preview: FilePreview = serde_json::from_value(self.files.command(
            workspace_id,
            &workspace.root,
            binding,
            &json!({"op": "file.preview", "workspace_id": workspace_id, "path": path}),
        )?)?;
        ensure!(
            preview.kind == PreviewKind::Text,
            "Capture a line range only from a UTF-8 text file"
        );
        let text = preview.text.unwrap_or_default();
        let selection = core::select_lines(&text, start, end)?;
        // A read cut at 256 KiB may end mid-line; that last line is not whole.
        ensure!(
            !preview.truncated || selection.end_line < selection.total_lines,
            "The range reaches past the first 256 KiB of the file, which is all ADE reads"
        );
        let body = core::bound(&selection.text, BODY_LIMIT, Keep::Head);
        let lines = format!("{}-{}", selection.start_line, selection.end_line);
        let total = (!preview.truncated).then_some(selection.total_lines);
        let mut facts = vec![("Path", path.to_owned()), ("Lines", lines.clone())];
        if let Some(total) = total {
            facts.push(("File lines", total.to_string()));
        }
        Ok(text_capture(
            ContextKind::FileRange,
            ContextOrigin::DaemonRead,
            ContextProvenance {
                workspace_id: Some(workspace_id.into()),
                path: Some(path.into()),
                start_line: Some(selection.start_line),
                end_line: Some(selection.end_line),
                total_lines: total,
                ..Default::default()
            },
            "file range",
            format!("{path} L{lines}"),
            &facts,
            body,
        ))
    }

    fn capture_hunk(
        &self,
        workspace_id: &str,
        path: &str,
        staged: bool,
        token: &str,
        hunk: u64,
    ) -> Result<Captured> {
        let (workspace, binding, common_binding) = {
            let data = self.data.lock().unwrap();
            data.store.ensure_workspace_bound(workspace_id)?;
            let workspace = data.store.workspace(workspace_id)?;
            let common_binding = workspace
                .repository_id
                .as_deref()
                .map(|repository_id| data.store.repository_binding_identity(repository_id))
                .transpose()?;
            (
                workspace,
                data.store.workspace_binding_identity(workspace_id)?,
                common_binding,
            )
        };
        let diff: ReviewDiff = serde_json::from_value(self.review.command(
            &workspace.root,
            binding,
            common_binding,
            &json!({"op": "review.diff", "workspace_id": workspace_id, "path": path,
                "staged": staged}),
        )?)?;
        ensure!(
            diff.token == token,
            "The diff changed since it was read; read it again and choose the hunk"
        );
        let text = diff
            .hunks
            .get(usize::try_from(hunk)?)
            .context("The diff has no hunk with this index")?;
        let body = core::bound(&format!("{}{}", diff.header, text), BODY_LIMIT, Keep::Head);
        let side = if staged { "staged" } else { "unstaged" };
        Ok(text_capture(
            ContextKind::DiffHunk,
            ContextOrigin::DaemonRead,
            ContextProvenance {
                workspace_id: Some(workspace_id.into()),
                path: Some(path.into()),
                staged: Some(staged),
                diff_token: Some(token.into()),
                hunk: Some(hunk),
                ..Default::default()
            },
            "diff hunk",
            format!("{path} {side} hunk {}", hunk + 1),
            &[
                ("Path", path.to_owned()),
                ("Side", side.into()),
                ("Hunk", format!("{} of {}", hunk + 1, diff.hunks.len())),
            ],
            body,
        ))
    }

    fn capture_browser(&self, conversation: &str, capture_id: &str) -> Result<Captured> {
        let capture_id = non_empty("capture_id", capture_id)?;
        let d = self.data.lock().unwrap();
        let (context, bytes) = d
            .store
            .attachment_bytes(conversation, capture_id)?
            .context("This Conversation has no finished browser capture with this ID")?;
        let document: Value = serde_json::from_slice(&bytes)
            .ok()
            .filter(|document: &Value| {
                document["format"] == "ade-design-context-v1"
                    && document["capture_id"] == capture_id
            })
            .context("The attachment is not a browser context capture")?;
        let mut existing = Vec::new();
        let shot_id = format!("{capture_id}-screenshot");
        if document["screenshot"]["attachment_id"] == shot_id.as_str() {
            let (shot, bytes) = d
                .store
                .attachment_bytes(conversation, &shot_id)?
                .context("The capture's screenshot attachment is unavailable")?;
            existing.push((shot, sha256(&bytes)));
        }
        existing.push((context, sha256(&bytes)));
        let text = |key: &str| document[key].as_str().map(str::to_owned);
        Ok(Captured {
            kind: ContextKind::BrowserCapture,
            origin: ContextOrigin::BrowserOwner,
            provenance: ContextProvenance {
                capture_id: Some(capture_id.into()),
                url: text("url"),
                title: text("title"),
                ..Default::default()
            },
            document: None,
            existing,
            body: None,
            // The capture names the parts its bounds cut.
            truncated: document["truncated"]
                .as_array()
                .is_some_and(|parts| !parts.is_empty()),
        })
    }
}
