use crate::*;
use base64::Engine;

impl Workspace {
    pub(crate) fn persist_draft(&self, id: &str) {
        if let Some(draft) = self.drafts.get(id) {
            // revision zero is the daemon's unsaved default, not a mutation.
            // Positive-revision empty drafts still save intentional text clears.
            if draft.revision == 0 && draft.text.is_empty() && draft.attachments.is_empty() {
                return;
            }
            command(
                self.shared.clone(),
                json!({"op":"draft.save","conversation_id":id,"window_id":self.record.id,"text":draft.text,"revision":draft.revision,"attachments":draft.attachments}),
            );
        }
    }
    fn import_attachments(&mut self, id: String, requests: Vec<Value>, cx: &mut Context<Self>) {
        if self.pending || self.draft_load.blocked() || requests.is_empty() {
            return;
        }
        if requests.len() > ade_core::prompt::ATTACHMENT_COUNT {
            self.shared.data.lock().unwrap().error = "Attach up to eight files at a time".into();
            cx.notify();
            return;
        }
        self.pending = true;
        let shared = self.shared.clone();
        let conversation = id.clone();
        let result = async move {
            let mut imported = Vec::new();
            let mut error = None;
            for mut request in requests {
                request["conversation_id"] = json!(conversation);
                request["request_id"] = json!(new_id("attachment"));
                match command(shared.clone(), request).recv().await {
                    Ok(Ok(value)) => match serde_json::from_value::<model::Attachment>(
                        value["attachment"].clone(),
                    ) {
                        Ok(attachment) => imported.push(attachment),
                        Err(e) => {
                            error = Some(e.to_string());
                            break;
                        }
                    },
                    Ok(Err(e)) => {
                        error = Some(e);
                        break;
                    }
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                }
            }
            (imported, error)
        };
        self.receive_attachment_import(id, result, cx);
        cx.notify();
    }
    pub(super) fn receive_attachment_import(
        &mut self,
        id: String,
        result: impl std::future::Future<Output = (Vec<model::Attachment>, Option<String>)> + 'static,
        cx: &mut Context<Self>,
    ) {
        // Admitted mutations outlive disposable panes. The window close fence must
        // also wait for their draft.save admission, including after pane removal.
        let owner = cx.entity();
        let guard = client_state::begin_draft_action(&self.shared, &self.record.id);
        self.pending = true;
        cx.spawn(async move |_, cx| {
            let (imported, mut error) = result.await;
            owner.update(cx, |this, cx| {
                this.pending = false;
                let draft = this.drafts.entry(id.clone()).or_default();
                let bytes: usize = draft
                    .attachments
                    .iter()
                    .chain(&imported)
                    .map(|a| a.size)
                    .sum();
                if draft.attachments.len() + imported.len() > ade_core::prompt::ATTACHMENT_COUNT
                    || bytes > ade_core::prompt::ATTACHMENT_LIMIT
                {
                    error =
                        Some("A prompt can contain up to eight attachments totalling 8 MiB".into());
                } else if !imported.is_empty() {
                    draft.attachments.extend(imported);
                    draft.revision += 1;
                    this.persist_draft(&id);
                    this.submission = None;
                }
                if let Some(error) = error {
                    this.shared.data.lock().unwrap().error = error;
                }
                cx.notify();
            });
            drop(guard);
        })
        .detach();
        cx.notify();
    }
    pub(crate) fn choose_attachments(&mut self, cx: &mut Context<Self>) {
        if self.pending || self.draft_load.blocked() {
            return;
        }
        let Some(id) = self.record.conversation_id.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach images or text files".into()),
        });
        self.receive_attachment_paths(
            id,
            async move {
                paths
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string())
            },
            cx,
        );
    }
    fn receive_attachment_paths(
        &mut self,
        id: String,
        paths: impl std::future::Future<Output = Result<Option<Vec<std::path::PathBuf>>, String>>
        + 'static,
        cx: &mut Context<Self>,
    ) {
        self.pending = true;
        self.attachment_picker = Some(cx.spawn(async move |this, cx| {
            let result = paths.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                match result {
                    Ok(Some(paths)) => this.import_attachments(
                        id,
                        paths
                            .iter()
                            .map(|p| json!({"op":"attachment.import","path":p}))
                            .collect(),
                        cx,
                    ),
                    Ok(None) => {}
                    Err(error) => this.shared.data.lock().unwrap().error = error.to_string(),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(crate) fn paste_attachments(
        &mut self,
        item: &ClipboardItem,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(id) = self.record.conversation_id.clone() else {
            return false;
        };
        let mut requests = Vec::new();
        for entry in &item.entries {
            match entry {
                ClipboardEntry::Image(image) => {
                    if let Err(error) = ade_core::prompt::media_type(&image.bytes) {
                        self.shared.data.lock().unwrap().error = error.to_string();
                        cx.notify();
                        return true;
                    }
                    requests.push(json!({"op":"attachment.put","name":"Pasted image","data":base64::engine::general_purpose::STANDARD.encode(&image.bytes)}));
                }
                ClipboardEntry::ExternalPaths(paths) => requests.extend(
                    paths
                        .0
                        .iter()
                        .map(|p| json!({"op":"attachment.import","path":p})),
                ),
                _ => {}
            }
        }
        if requests.is_empty() {
            return false;
        }
        self.import_attachments(id, requests, cx);
        true
    }
    pub(crate) fn remove_attachment(&mut self, attachment: &str, cx: &mut Context<Self>) {
        if self.pending || self.draft_load.blocked() {
            return;
        }
        if let Some(id) = self.record.conversation_id.clone()
            && let Some(draft) = self.drafts.get_mut(&id)
        {
            draft.attachments.retain(|a| a.id != attachment);
            draft.revision += 1;
            self.persist_draft(&id);
            self.submission = None;
        }
        cx.notify();
    }
    pub(crate) fn submit_prompt(&mut self, cx: &mut Context<Self>) {
        if self.pending || self.draft_load.blocked() {
            return;
        }
        let Some(id) = self.record.conversation_id.clone() else {
            return;
        };
        let text = self.composer.read(cx).value().to_string();
        let attachments = self
            .drafts
            .get(&id)
            .map(|d| d.attachments.clone())
            .unwrap_or_default();
        if text.trim().is_empty() && attachments.is_empty() {
            return;
        }
        self.save_draft_text(&id, text.clone());
        let identity = json!({"text":text,"attachments":attachments}).to_string();
        let key = match &self.submission {
            Some((key, old)) if old == &identity => key.clone(),
            _ => new_id("submission"),
        };
        self.submission = Some((key.clone(), identity));
        self.request(json!({"op":"queue.enqueue","conversation_id":id,"request_id":key,"text":text,"attachments":attachments}),false,true,cx);
    }
}

#[cfg(test)]
mod picker_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;

    #[gpui::test]
    fn closing_editor_releases_picker_waiter(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let record: WindowRecord = serde_json::from_value(json!({"id":"picker-window","workspace_id":"picker-workspace","conversation_id":null,"browser_url":"","x":0.,"y":0.,"width":1000.,"height":700.})).unwrap();
        let workspace = WorkspaceRecord {
            id: "picker-workspace".into(),
            name: "Picker".into(),
            root: "/tmp".into(),
            repository_id: None,
            terminal_id: "terminal".into(),
            extra_terminals: vec![],
        };
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Workspace::new(record, workspace, false, true, shared, window, cx)
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_attachment_paths(
                "conversation".into(),
                async move { rx.recv().await.unwrap() },
                cx,
            )
        });
        visual.run_until_parked();
        assert!(!tx.is_closed());
        visual.update(|window, _| window.remove_window());
        drop(view);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(tx.is_closed(), "closed editor retains its picker waiter");
    }
}
