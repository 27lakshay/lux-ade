//! Conversation selection, history, and daemon actions.
//! Responses retain the existing selection checks and draft persistence semantics.
use crate::*;

struct RequestCompletion {
    submitted_conversation: Option<String>,
    select: bool,
    clear_prompt: bool,
    selection: (u64, String, Option<String>),
}

impl Workspace {
    pub(super) fn select_conversation(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.record.conversation_id.as_ref() != Some(&id) {
            self.expanded_tools.clear();
            self.provider_diagnostics.clear();
            self.save_diagnostics.clear();
            self.action_diagnostics.clear();
        }
        self.close_child();
        if !self.draft_load.blocked()
            && let Some(previous) = self.record.conversation_id.clone()
        {
            self.save_draft_text(&previous, self.composer.read(cx).value().to_string());
        }
        self.reset_history();
        self.record.conversation_id = Some(id.clone());
        self.load_draft(window, cx);
        self.submission = None;
        self.answers.clear();
        command(
            self.shared.clone(),
            json!({"op":"conversation.get","conversation_id":id}),
        );
        self.save(cx);
        cx.notify();
    }
    pub(super) fn reset_history(&mut self) {
        self.history_diagnostics.clear();
        self.history_generation += 1;
        self.history_request = None;
        self.history_task = None;
        self.history_error = None;
        self.history_page = None;
    }
    pub(super) fn close_child(&mut self) {
        self.child_diagnostics.clear();
        self.child_generation += 1;
        self.child_request = None;
        self.child_task = None;
        self.child_reader = None;
        self.child_back.clear();
    }
    pub(super) fn earlier_messages(&mut self, before: i64, cx: &mut Context<Self>) {
        let Some(id) = self.record.conversation_id.clone() else {
            return;
        };
        self.history_generation += 1;
        self.history_error = None;
        let (request, response) = client_state::disposable_read(
            json!({"op":"conversation.get","conversation_id":id,"before":before}),
        );
        self.history_request = Some(request);
        self.receive_history(response, id, before, self.history_generation, cx);
        cx.notify();
    }
    fn receive_history(
        &mut self,
        response: async_channel::Receiver<Result<Value, String>>,
        id: String,
        before: i64,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        // History conversion can be large. Keep it off the UI executor, and do
        // not ingest an older page into the shared latest-Conversation projection.
        let decoded = cx.background_spawn(async move {
            let mut value = response.recv().await.map_err(|_| {
                "History connection closed. Retry loading earlier messages.".to_string()
            })??;
            serde_json::from_value::<Vec<model::Message>>(value["messages"].take()).map_err(|_| {
                "lux-ade returned an invalid history page. Retry loading earlier messages."
                    .to_string()
            })
        });
        self.history_task = Some(cx.spawn(async move |this, cx| {
            let result = decoded.await;
            let _ = this.update(cx, |this, cx| {
                if this.history_generation != generation
                    || this.record.conversation_id.as_ref() != Some(&id)
                {
                    return;
                }
                this.history_request = None;
                match result {
                    Ok(messages) => {
                        this.history_page = Some((id, messages));
                        this.history_error = None;
                    }
                    Err(error) => this.history_error = Some((before, error)),
                }
                cx.notify();
            });
        }));
    }
    pub(super) fn read_child(&mut self, selector: Value, cx: &mut Context<Self>) {
        if self.child_reader.as_ref().is_none_or(|(previous, _)| {
            ["conversation_id", "child_id", "message_id"]
                .iter()
                .any(|key| previous[key] != selector[key])
        }) {
            self.child_back.clear();
        }
        self.conversation_scroll.set_offset(point(px(0.), px(0.)));
        self.child_generation += 1;
        let generation = self.child_generation;
        self.child_reader = Some((selector.clone(), json!({"loading":true})));
        let (request, receiver) = client_state::disposable_read(selector.clone());
        self.child_request = Some(request);
        cx.notify();
        self.receive_child(receiver, selector, generation, cx);
    }
    fn receive_child(
        &mut self,
        receiver: async_channel::Receiver<Result<Value, String>>,
        selector: Value,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        self.child_task = Some(cx.spawn(async move |this, cx| {
            let result = match receiver.recv().await {
                Ok(Ok(value)) if value["items"].is_array() => value,
                Ok(Ok(_)) => {
                    json!({"error":"lux-ade returned an invalid child transcript. Retry loading it."})
                }
                Ok(Err(error)) => json!({"error":error}),
                Err(_) => json!({"error":"Child transcript connection closed"}),
            };
            let _ = this.update(cx, |this, cx| {
                if this.child_generation == generation
                    && this.record.conversation_id.as_deref()
                        == selector["conversation_id"].as_str()
                {
                    this.child_request = None;
                    this.child_reader = Some((selector, result));
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn request(
        &mut self,
        value: Value,
        select: bool,
        clear_prompt: bool,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        cx.notify();
        let completion = RequestCompletion {
            submitted_conversation: value["conversation_id"].as_str().map(str::to_owned),
            select,
            clear_prompt,
            selection: (
                self.draft_generation,
                self.record.workspace_id.clone(),
                self.record.conversation_id.clone(),
            ),
        };
        let receiver = command(self.shared.clone(), value);
        self.receive_request(receiver, completion, cx);
    }
    fn receive_request(
        &mut self,
        receiver: async_channel::Receiver<Result<Value, String>>,
        completion: RequestCompletion,
        cx: &mut Context<Self>,
    ) {
        let RequestCompletion {
            submitted_conversation,
            select,
            clear_prompt,
            selection,
        } = completion;
        let submitted_draft = submitted_conversation
            .as_ref()
            .and_then(|id| self.drafts.get(id))
            .cloned();
        // Accepted prompt acknowledgements must clear their durable draft even
        // after the disposable pane disappears. Other requests keep weak ownership.
        let retained_editor = clear_prompt.then(|| cx.entity());
        let draft_action =
            clear_prompt.then(|| client_state::begin_draft_action(&self.shared, &self.record.id));
        let task = cx.spawn(async move |this, cx| {
            let result = receiver.recv().await.unwrap_or_else(|_| Err(
                "lux-ade could not confirm the request result. Refresh the workspace before retrying.".into()));
            // Release pending and admit persistence without depending on a live
            // native window or GPUI's render-derived window association.
            let cleared = this.update(cx, |this, cx| {
                this.pending = false;
                let mut cleared = false;
                if result.is_ok() && clear_prompt {
                    this.submission = None;
                    if let (Some(id), Some(submitted)) = (&submitted_conversation, &submitted_draft)
                        && let Some(draft) = this.drafts.get_mut(id)
                        && draft.revision == submitted.revision
                        && draft.text == submitted.text
                        && draft.attachments == submitted.attachments
                    {
                        draft.text.clear();
                        draft.attachments.clear();
                        draft.revision += 1;
                        this.persist_draft(id);
                        cleared = true;
                    }
                }
                if let Err(error) = &result {
                    this.shared.data.lock().unwrap().error = error.clone();
                }
                cx.notify();
                cleared
            }).unwrap_or(false);
            if let Ok(response) = result {
                let _ = this.update_in(cx, |this, window, cx| {
                    if cleared && this.record.conversation_id == submitted_conversation {
                        this.composer.update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    if select && this.draft_generation == selection.0
                        && this.record.workspace_id == selection.1
                        && this.record.conversation_id == selection.2 {
                        if let Some(id) = response["conversation"]["id"].as_str() {
                            this.select_conversation(id.into(), window, cx);
                        }
                        if let Ok(workspace) = serde_json::from_value::<WorkspaceRecord>(response["workspace"].clone()) {
                            this.select_workspace(workspace, window, cx);
                        }
                    }
                    cx.notify();
                });
            }
            drop(retained_editor);
            drop(draft_action);
        });
        if clear_prompt {
            task.detach();
        } else {
            self.action_task = Some(task);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    #[gpui::test]
    fn ordinary_action_waiter_closes_with_editor(cx: &mut TestAppContext) {
        for terminal in [false, true] {
            let shared = std::sync::Arc::new(client_state::ClientState::default());
            let record: WindowRecord = serde_json::from_value(json!({"id":"action-window","workspace_id":"action-workspace","conversation_id":null,"browser_url":"","x":0.,"y":0.,"width":1000.,"height":700.})).unwrap();
            let workspace = WorkspaceRecord {
                id: "action-workspace".into(),
                name: "Action".into(),
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
                view.pending = true;
                if terminal {
                    view.receive_terminal(rx, view.workspace.id.clone(), cx);
                } else {
                    view.receive_request(
                        rx,
                        RequestCompletion {
                            submitted_conversation: None,
                            select: true,
                            clear_prompt: false,
                            selection: (
                                view.draft_generation,
                                view.record.workspace_id.clone(),
                                view.record.conversation_id.clone(),
                            ),
                        },
                        cx,
                    );
                }
            });
            visual.run_until_parked();
            assert!(!tx.is_closed());
            visual.update(|window, _| window.remove_window());
            let weak = view.downgrade();
            drop(view);
            visual.cx.update(|_| {});
            visual.run_until_parked();
            assert!(weak.upgrade().is_none());
            assert!(
                tx.is_closed(),
                "disposed editor keeps ordinary action waiter; terminal={terminal}"
            );
        }
    }

    #[gpui::test]
    fn transcript_waiters_release_on_reset_and_window_close(cx: &mut TestAppContext) {
        for close_window in [false, true] {
            let shared = std::sync::Arc::new(client_state::ClientState::default());
            let record: WindowRecord = serde_json::from_value(json!({
                "id":"reader-window", "workspace_id":"reader-workspace", "conversation_id":null,
                "browser_url":"", "x":0., "y":0., "width":1000., "height":700.
            }))
            .unwrap();
            let workspace = WorkspaceRecord {
                id: "reader-workspace".into(),
                name: "Reader".into(),
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
            let (history_tx, history_rx) = async_channel::bounded(1);
            let (child_tx, child_rx) = async_channel::bounded(1);
            view.update(visual, |view, cx| {
                view.receive_history(history_rx, "reader".into(), 5, view.history_generation, cx);
                view.receive_child(
                    child_rx,
                    json!({"conversation_id":"reader"}),
                    view.child_generation,
                    cx,
                );
            });
            visual.run_until_parked();
            assert!(!history_tx.is_closed());
            assert!(!child_tx.is_closed());
            if close_window {
                visual.update(|window, _| window.remove_window());
                let weak = view.downgrade();
                drop(view);
                visual.cx.update(|_| {});
                assert!(weak.upgrade().is_none());
            } else {
                view.update(visual, |view, _| {
                    view.reset_history();
                    view.close_child();
                });
            }
            visual.run_until_parked();
            assert!(
                history_tx.is_closed(),
                "obsolete history keeps its response waiter; close={close_window}"
            );
            assert!(
                child_tx.is_closed(),
                "obsolete child transcript keeps its response waiter; close={close_window}"
            );
        }
    }

    #[gpui::test]
    fn history_failure_retry_and_stale_completion_preserve_visible_page(cx: &mut TestAppContext) {
        // Retry dispatches a real bounded-pool request. GPUI's deterministic
        // scheduler must permit that external worker to wake its receiver.
        cx.dispatcher.allow_parking();
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let record: WindowRecord = serde_json::from_value(json!({
            "id":"history-window", "workspace_id":"history-workspace", "conversation_id":null,
            "browser_url":"", "x":0., "y":0., "width":1000., "height":700.
        }))
        .unwrap();
        let workspace = WorkspaceRecord {
            id: "history-workspace".into(),
            name: "History".into(),
            root: "/tmp".into(),
            repository_id: None,
            terminal_id: "terminal".into(),
            extra_terminals: vec![],
        };
        let message = |text: &str| json!({"id":"message", "conversation_id":"history", "role":"assistant", "kind":"text", "text":text, "status":"completed", "sequence":5});
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Workspace::new(record, workspace, false, true, shared, window, cx)
        });
        visual.run_until_parked();
        view.update(visual, |view, _| {
            view.record.conversation_id = Some("history".into());
            view.history_page = Some((
                "history".into(),
                vec![serde_json::from_value(message("existing page")).unwrap()],
            ));
        });
        for response in [
            None,
            Some(Ok(json!({"messages":null}))),
            Some(Err("History service unavailable".into())),
        ] {
            let (tx, rx) = async_channel::bounded(1);
            view.update(visual, |view, cx| {
                view.history_generation += 1;
                view.receive_history(rx, "history".into(), 5, view.history_generation, cx);
            });
            visual.run_until_parked();
            // Real request workers publish off the UI thread. Park the receiver
            // first so this covers a worker waking an already waiting task.
            std::thread::spawn(move || {
                if let Some(response) = response {
                    tx.try_send(response).unwrap();
                }
                drop(tx);
            })
            .join()
            .unwrap();
            visual.run_until_parked();
            view.read_with(visual, |view, _| {
                assert_eq!(
                    view.history_page.as_ref().unwrap().1[0].text,
                    "existing page"
                );
                assert_eq!(view.history_error.as_ref().unwrap().0, 5);
                assert!(view.history_request.is_none());
            });
        }
        visual.update(|window, cx| window.draw(cx).clear(cx));
        let before_retry = view.read_with(visual, |view, _| view.history_generation);
        let bounds = visual
            .debug_bounds("retry-history-read")
            .expect("history failure exposes retry");
        visual.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        visual.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        view.read_with(visual, |view, _| {
            assert!(view.history_generation > before_retry)
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.reset_history();
            view.receive_history(rx, "history".into(), 5, view.history_generation, cx);
        });
        tx.try_send(Ok(json!({"messages":[message("recovered page")]})))
            .unwrap();
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert!(view.history_error.is_none());
            assert_eq!(
                view.history_page.as_ref().unwrap().1[0].text,
                "recovered page"
            );
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_history(rx, "history".into(), 5, view.history_generation, cx);
            // Keep the completion alive to exercise the generation guard itself.
            view.history_generation += 1;
            view.history_page = None;
        });
        tx.try_send(Err("stale error".into())).unwrap();
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert!(view.history_error.is_none());
            assert!(view.history_page.is_none());
        });
    }

    #[gpui::test]
    fn prompt_completion_after_disposal_respects_result_and_draft_revision(
        cx: &mut TestAppContext,
    ) {
        for (accepted, edited, expected) in [
            (true, false, ""),
            (false, false, "already sent"),
            (true, true, "newer draft"),
        ] {
            let shared = std::sync::Arc::new(client_state::ClientState::default());
            let state = shared.clone();
            let record: WindowRecord = serde_json::from_value(json!({
                "id":"send-window", "workspace_id":"send-workspace", "conversation_id":null,
                "browser_url":"", "x":0., "y":0., "width":1000., "height":700.,
                "focused_pane":2
            }))
            .unwrap();
            let workspace = WorkspaceRecord {
                id: "send-workspace".into(),
                name: "Send".into(),
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
            visual.run_until_parked();
            let (tx, rx) = async_channel::bounded(1);
            view.update_in(visual, |view, window, cx| {
                view.pending = true;
                view.record.conversation_id = Some("sent-conversation".into());
                view.drafts.insert(
                    "sent-conversation".into(),
                    model::Draft {
                        text: "already sent".into(),
                        revision: 3,
                        attachments: vec![],
                    },
                );
                view.persist_draft("sent-conversation");
                view.receive_request(
                    rx,
                    RequestCompletion {
                        submitted_conversation: Some("sent-conversation".into()),
                        select: false,
                        clear_prompt: true,
                        selection: (
                            view.draft_generation,
                            view.record.workspace_id.clone(),
                            view.record.conversation_id.clone(),
                        ),
                    },
                    cx,
                );
                if edited {
                    view.save_draft_text("sent-conversation", "newer draft".into());
                }
                window.remove_window();
            });
            let weak = view.downgrade();
            drop(view);
            visual.run_until_parked();
            assert!(
                weak.upgrade().is_some(),
                "acknowledgement retains its original editor"
            );
            assert!(client_state::has_draft_actions(&state, "send-window"));
            tx.try_send(if accepted {
                Ok(json!({"type":"queued"}))
            } else {
                Err("Submission rejected".into())
            })
            .unwrap();
            visual.run_until_parked();
            assert!(
                weak.upgrade().is_none(),
                "completed submission releases its disposed editor"
            );
            assert!(!client_state::has_draft_actions(&state, "send-window"));
            let saves = client_state::retry_payloads_for_test(&state, "send-window");
            assert_eq!(
                saves.len(),
                1,
                "accepted prompt must admit its draft clear even without a window"
            );
            assert_eq!(saves[0]["conversation_id"], "sent-conversation");
            assert_eq!(saves[0]["text"], expected);
            assert_eq!(saves[0]["revision"], if accepted || edited { 4 } else { 3 });
        }
    }

    #[gpui::test]
    fn late_create_does_not_steal_new_selection_and_closed_reply_releases_pending(
        cx: &mut TestAppContext,
    ) {
        let workspace = |id: &str| WorkspaceRecord {
            id: id.into(),
            name: id.into(),
            root: "/tmp".into(),
            repository_id: None,
            terminal_id: "terminal".into(),
            extra_terminals: vec![],
        };
        let record = WindowRecord {
            id: "window".into(),
            workspace_id: "initial".into(),
            conversation_id: None,
            browser_url: String::new(),
            x: 0.,
            y: 0.,
            width: 1000.,
            height: 700.,
            tabs: Default::default(),
            panes: Default::default(),
            focused_pane: 2,
            dock_layout: None,
        };
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Workspace::new(
                record,
                workspace("initial"),
                false,
                true,
                shared,
                window,
                cx,
            )
        });
        visual.run_until_parked();
        let (tx, rx) = async_channel::bounded(1);
        view.update_in(visual, |view, window, cx| {
            view.pending = true;
            let completion = RequestCompletion {
                submitted_conversation: None,
                select: true,
                clear_prompt: false,
                selection: (
                    view.draft_generation,
                    view.record.workspace_id.clone(),
                    view.record.conversation_id.clone(),
                ),
            };
            view.receive_request(rx, completion, cx);
            view.select_workspace(workspace("chosen-later"), window, cx);
        });
        tx.try_send(Ok(json!({"workspace":workspace("late-created")})))
            .unwrap();
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert_eq!(
                view.workspace.id, "chosen-later",
                "late success must preserve the user's new selection"
            );
            assert!(!view.pending);
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.pending = true;
            let completion = RequestCompletion {
                submitted_conversation: None,
                select: false,
                clear_prompt: false,
                selection: (
                    view.draft_generation,
                    view.record.workspace_id.clone(),
                    view.record.conversation_id.clone(),
                ),
            };
            view.receive_request(rx, completion, cx);
        });
        drop(tx);
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert!(
                !view.pending,
                "closed response channel must not leave the editor locked"
            );
            assert!(!view.shared.data.lock().unwrap().error.is_empty());
        });
    }
}
