//! Draft lifecycle for a Workspace editor: save, restore, and explicit conflict resolution.
//! Keeps generation and loading guards beside the asynchronous work they protect.
use crate::{Workspace, client_state, draft_ui};
use ade_core::model;
use client_state::command;
use gpui_kit::{Context, Window};
use serde_json::json;

impl Workspace {
    pub(super) fn save_draft_text(&mut self, id: &str, text: String) {
        let draft = self.drafts.entry(id.into()).or_default();
        if draft.text == text {
            return;
        }
        draft.text = text;
        draft.revision += 1;
        self.persist_draft(id);
    }
    pub(super) fn load_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.draft_generation += 1;
        self.draft_task = None;
        self.draft_load = draft_ui::LoadState::Loading;
        let Some(id) = self.record.conversation_id.clone() else {
            self.composer
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.draft_load = draft_ui::LoadState::Ready;
            return;
        };
        if let Some(draft) = client_state::unsaved_draft(&self.shared, &self.record.id, &id) {
            let draft = client_state::restored_draft(draft, self.drafts.get(&id), None);
            self.drafts.insert(id.clone(), draft);
        }
        if let Some(draft) = self.drafts.get(&id) {
            self.composer.update(cx, |input, cx| {
                input.set_value(draft.text.clone(), window, cx)
            });
            self.draft_load = draft_ui::LoadState::Ready;
            return;
        }
        self.composer
            .update(cx, |input, cx| input.set_value("", window, cx));
        let generation = self.draft_generation;
        let receiver = command(
            self.shared.clone(),
            json!({"op":"draft.get","conversation_id":id,"window_id":self.record.id}),
        );
        self.receive_draft(receiver, id, generation, window, cx);
    }
    pub(super) fn receive_draft(
        &mut self,
        receiver: async_channel::Receiver<Result<serde_json::Value, String>>,
        id: String,
        generation: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let owner_window = window.window_handle();
        self.draft_task = Some(cx.spawn(async move |this, cx| {
            let response = receiver
                .recv()
                .await
                .map_err(|error| error.to_string())
                .and_then(|response| response);
            let _ = owner_window.update(cx, |_, window, cx| {
                this.update(cx, |this, cx| {
                    if this.draft_generation == generation
                        && this.record.conversation_id.as_ref() == Some(&id)
                    {
                        if let Some(draft) = this.draft_load.finish(response) {
                            this.draft_load = draft_ui::LoadState::Loading;
                            let draft = client_state::restored_draft(
                                draft,
                                this.drafts.get(&id),
                                client_state::unsaved_draft(&this.shared, &this.record.id, &id),
                            );
                            this.composer.update(cx, |input, cx| {
                                input.set_value(draft.text.clone(), window, cx)
                            });
                            this.drafts.insert(id, draft);
                            this.draft_load = draft_ui::LoadState::Ready;
                        }
                        cx.notify();
                    }
                })
            });
        }));
    }
    pub(super) fn resolve_draft_conflict(
        &mut self,
        keep_local: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.record.conversation_id.clone() else {
            return;
        };
        let local = keep_local.then(|| {
            let mut draft = self.drafts.get(&id).cloned().unwrap_or_default();
            draft.text = self.composer.read(cx).value().to_string();
            draft
        });
        self.resolve_draft_choice(local, window, cx);
    }
    pub(super) fn resolve_draft_choice(
        &mut self,
        local: Option<model::Draft>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.record.conversation_id.clone() else {
            return;
        };
        let response = client_state::resolve_draft(&self.shared, &self.record.id, &id, local);
        self.receive_draft_resolution(response, id, self.draft_generation, window, cx);
    }
    pub(super) fn receive_draft_resolution(
        &mut self,
        response: async_channel::Receiver<Result<serde_json::Value, String>>,
        id: String,
        generation: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let owner_window = window.window_handle();
        self.pending = true;
        cx.notify();
        self.draft_resolution_task = Some(cx.spawn(async move |this, cx| {
            let response = response
                .recv()
                .await
                .map_err(|error| error.to_string())
                .and_then(|response| response);
            let _ = owner_window.update(cx, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.pending = false;
                    if this.draft_generation == generation
                        && this.record.conversation_id.as_ref() == Some(&id)
                    {
                        let mut result = draft_ui::LoadState::Loading;
                        if let Some(draft) = result.finish(response) {
                            this.draft_load = draft_ui::LoadState::Loading;
                            this.composer.update(cx, |input, cx| {
                                input.set_value(draft.text.clone(), window, cx)
                            });
                            this.drafts.insert(id, draft);
                            this.draft_load = draft_ui::LoadState::Ready;
                        } else if let Some(error) = result.error() {
                            this.shared.data.lock().unwrap().error = error.to_owned();
                        }
                    }
                    cx.notify();
                })
            });
        }));
    }
}
