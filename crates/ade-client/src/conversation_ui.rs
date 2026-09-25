//! Conversation presentation: history viewport, requests, queue, composer, and status.
//! Entities and focus handles remain owned by Workspace across renders.
use crate::*;

impl Workspace {
    pub(super) fn render_conversation(
        &mut self,
        s: &client_state::Snapshot,
        compact_header: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if s.save_error.is_empty() {
            self.save_diagnostics.clear();
        }
        if s.error.is_empty() {
            self.action_diagnostics.clear();
        }
        if self.history_error.is_none() {
            self.history_diagnostics.clear();
        }
        if self
            .child_reader
            .as_ref()
            .is_none_or(|(_, page)| page["error"].is_null())
        {
            self.child_diagnostics.clear();
        }
        let conversation = self
            .record
            .conversation_id
            .as_ref()
            .and_then(|id| s.catalog.conversations.iter().find(|c| &c.id == id))
            .cloned();
        if conversation
            .as_ref()
            .and_then(|c| c.error.as_ref())
            .is_none()
        {
            self.provider_diagnostics.clear();
        }
        let mut view = self
            .record
            .conversation_id
            .as_ref()
            .and_then(|id| s.views.get(id))
            .cloned()
            .unwrap_or_default();
        if let Some((id, messages)) = &self.history_page
            && self.record.conversation_id.as_ref() == Some(id)
        {
            std::sync::Arc::make_mut(&mut view).messages = messages.clone();
        }
        if bench::enabled()
            && let Some(stamp) = view
                .messages
                .iter()
                .rev()
                .find_map(|m| bench::agent_marker(&m.text))
            && stamp > self.bench_marker
        {
            self.bench_marker = stamp;
            bench::latency("provider_to_ui_render_us", stamp);
            window.on_next_frame(move |_, _| bench::latency("provider_to_gpui_frame_us", stamp));
        }
        // Normal transcripts keep a bounded viewport for rich-text layout. While
        // answering requests, one outer viewport makes every form field reachable.
        let request_form_visible = !view.requests.is_empty();
        let request_key = view.requests.first().map(|request| request.id.clone());
        if self.request_scroll_key != request_key {
            self.request_scroll.set_offset(point(px(0.), px(0.)));
            self.request_scroll_key = request_key;
        }
        let virtual_transcript =
            !request_form_visible && self.child_reader.is_none() && !view.messages.is_empty();
        self.transcript_list
            .sync(self.record.conversation_id.as_deref(), &view);
        let mut transcript = ui::chat_column()
            .id("conversation")
            .when(request_form_visible, |el| el.flex_shrink_0())
            .when(!request_form_visible, |el| {
                el.flex_1()
                    .when(virtual_transcript, |el| el.overflow_hidden())
                    .when(!virtual_transcript, |el| {
                        el.overflow_y_scroll()
                            .track_scroll(&self.conversation_scroll)
                    })
                    .track_focus(&self.conversation_focus)
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        let delta = match event.keystroke.key.as_str() {
                            "down" => -40.,
                            "up" => 40.,
                            "pagedown" => -240.,
                            "pageup" => 240.,
                            _ => return,
                        };
                        if this.child_reader.is_none() {
                            this.transcript_list.state.scroll_by(px(-delta));
                        } else {
                            let offset = this.conversation_scroll.offset();
                            this.conversation_scroll
                                .set_offset(point(offset.x, offset.y + px(delta)));
                        }
                        cx.notify();
                    }))
            })
            .min_h(px(100.))
            .w_full()
            .px_1()
            .py_4()
            .gap_5()
            .bg(rgb(ui::CANVAS));
        if let Some((selector, page)) = &self.child_reader {
            let mut reader = v_flex()
                .gap_2()
                .p_3()
                .border_1()
                .border_color(rgb(ui::MUTED));
            reader = reader.child(
                h_flex()
                    .gap_2()
                    .child(format!(
                        "Child {} · read only",
                        selector["child_id"].as_str().unwrap_or_default()
                    ))
                    .child(
                        ui::button("close-child")
                            .label("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.close_child();
                                cx.notify();
                            })),
                    ),
            );
            if page["loading"].as_bool() == Some(true) {
                reader = reader.child("Loading child transcript…");
            }
            if let Some(error) = page["error"].as_str() {
                let retry = selector.clone();
                let details = error.to_owned();
                let expanded = self.child_diagnostics.is_expanded(&details);
                reader = reader
                    .child(ui::diagnostic_error_card(
                        "child-read-error",
                        "Could not load child transcript",
                        "lux-ade could not load this child transcript. Check the connection, then retry loading.",
                        details.clone(),
                        expanded,
                        ui::button("child-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.child_diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                    .child(
                        ui::button("retry-child-read")
                            .label("Retry loading transcript")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.read_child(retry.clone(), cx)
                            })),
                    );
            }
            if let Some(items) = page["items"].as_array() {
                if items.is_empty() {
                    reader = reader.child("No messages in this page.");
                }
                if !self.child_back.is_empty() {
                    reader = reader.child(
                        ui::button("child-previous")
                            .label("Previous page")
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(previous) = this.child_back.pop() {
                                    this.read_child(previous, cx);
                                }
                            })),
                    );
                }
                if page["next_offset"].is_u64() || page["next_cursor"].is_string() {
                    let previous = selector.clone();
                    let mut next = selector.clone();
                    next["offset"] = page["next_offset"].as_u64().map_or(json!(0), |n| json!(n));
                    next["cursor"] = page.get("next_cursor").cloned().unwrap_or(Value::Null);
                    reader = reader.child(ui::button("child-next").label("Next page").on_click(
                        cx.listener(move |this, _, _, cx| {
                            if this.child_back.len() >= 128 {
                                this.child_back.remove(0);
                            }
                            this.child_back.push(previous.clone());
                            this.read_child(next.clone(), cx);
                        }),
                    ));
                }
            }
            if let Some(items) = page["items"].as_array() {
                let mut body = v_flex()
                    .id("child-reader-body")
                    .max_h(px(240.))
                    .overflow_y_scroll()
                    .gap_2();
                for (index, item) in items.iter().enumerate() {
                    body = body
                        .child(
                            div()
                                .text_color(rgb(ui::MUTED))
                                .child(item["role"].as_str().unwrap_or("message").to_owned()),
                        )
                        .child(chat_ui::markdown(
                            SharedString::from(format!("child-text-{index}")),
                            item["text"].as_str().unwrap_or_default().to_owned(),
                        ));
                }
                reader = reader.child(body);
            }
            transcript = transcript.child(reader);
        }
        if view.messages.is_empty() {
            transcript=transcript.child(v_flex().flex_1().justify_center().py_6().gap_3().max_w(px(480.)).mx_auto()
                .child(div().text_size(px(22.)).font_weight(FontWeight::MEDIUM).child(if conversation.is_some() {"What shall we work on?"} else {"A focused place to build."}))
                .child(div().max_w(px(420.)).text_size(px(ui::tokens::INTERFACE_PX)).text_color(rgb(ui::MUTED)).child(if conversation.is_some() {"Describe the task below. Your Agent works in this workspace, with approvals kept in view."} else {"Create a Conversation to begin. Your terminal and browser are ready beside you."})));
        }
        let child_capable = conversation.as_ref().is_some_and(|c| {
            s.providers.iter().any(|p| {
                p.id == c.provider && p.capabilities.iter().any(|cap| cap == "child_transcript")
            })
        });
        if virtual_transcript {
            let messages = view.clone();
            let owner = cx.weak_entity();
            transcript = transcript.gap_0().child(
                div()
                    .id("virtual-message-list")
                    .size_full()
                    .child(
                        gpui_kit::list(self.transcript_list.state.clone(), move |ix, _, cx| {
                            owner
                                .update(cx, |this, cx| {
                                    this.message_row(&messages.messages[ix], child_capable, cx)
                                })
                                .unwrap_or_else(|_| div().into_any_element())
                        })
                        .size_full(),
                    )
                    .vertical_scrollbar(&self.transcript_list.state),
            );
        } else {
            for m in &view.messages {
                transcript = transcript
                    .gap_0()
                    .child(self.message_row(m, child_capable, cx));
            }
        }
        let approval = self.render_requests(&view.requests, s.connected, window, cx);
        let id = self.record.conversation_id.clone();
        let before = view.messages.first().map(|m| m.sequence);
        let controls = h_flex()
            .flex_wrap()
            .gap_2()
            .child(
                ui::button("older")
                    .label(if self.history_request.is_some() {
                        "Loading history…"
                    } else {
                        "Earlier messages"
                    })
                    .disabled(
                        self.history_request.is_some()
                            || id.is_none()
                            || before.is_none_or(|n| n <= 1),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(before) = before {
                            this.transcript_list
                                .state
                                .set_follow_mode(FollowMode::Normal);
                            this.earlier_messages(before, cx);
                        }
                    })),
            )
            .child(ui::button("latest").label("Latest").on_click(cx.listener(
                |this, _, window, cx| {
                    this.conversation_focus.focus(window, cx);
                    this.reset_history();
                    this.transcript_list.state.set_follow_mode(FollowMode::Tail);
                    cx.notify();
                    if let Some(id) = &this.record.conversation_id {
                        command(
                            this.shared.clone(),
                            json!({"op":"conversation.get","conversation_id":id}),
                        );
                    }
                },
            )));
        let title = conversation
            .as_ref()
            .map(|c| c.title.clone())
            .unwrap_or_else(|| "New Conversation".into());
        let queue = self.render_prompt_queue(&view, conversation.as_ref(), s.connected, cx);
        // Keep requests visible above the composer while the transcript can
        // scroll independently. Long question forms scroll within this area.
        let conversation_content = v_flex()
            .id("conversation-content")
            .when(request_form_visible, |el| {
                el.track_focus(&self.conversation_focus)
                    .track_scroll(&self.conversation_scroll)
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        let delta = match event.keystroke.key.as_str() {
                            "down" => -40.,
                            "up" => 40.,
                            "pagedown" => -240.,
                            "pageup" => 240.,
                            _ => return,
                        };
                        let offset = this.conversation_scroll.offset();
                        this.conversation_scroll
                            .set_offset(point(offset.x, offset.y + px(delta)));
                        cx.notify();
                    }))
            })
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .when(
                !view.messages.is_empty()
                    && (before.is_some_and(|n| n > 1)
                        || self.history_page.is_some()
                        || self.history_error.is_some()
                        || !self.transcript_list.state.is_following_tail()),
                |el| el.child(div().px_4().flex_shrink_0().child(controls)),
            )
            .when_some(self.history_error.clone(), |el, (before, error)| {
                let expanded = self.history_diagnostics.is_expanded(&error);
                el.child(ui::diagnostic_error_card(
                    "history-read-error",
                    "Could not load earlier messages",
                    "lux-ade could not load earlier messages. Check the connection, then retry loading.",
                    error.clone(),
                    expanded,
                    ui::button("history-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.history_diagnostics.toggle(&error);
                            cx.notify();
                        })),
                ))
                .child(
                    ui::button("retry-history-read")
                        .debug_selector(|| "retry-history-read".into())
                        .label("Retry loading history")
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.earlier_messages(before, cx)),
                        ),
                )
            })
            .child(transcript)
            .child(div().px_4().flex_shrink_0().child(queue))
            .when(
                conversation
                    .as_ref()
                    .and_then(|c| c.error.as_ref())
                    .is_some(),
                |el| {
                    let details = conversation
                        .as_ref()
                        .and_then(|c| c.error.clone())
                        .unwrap_or_default();
                    let expanded = self.provider_diagnostics.is_expanded(&details);
                    let summary = if conversation.as_ref().is_some_and(|c| {
                        matches!(c.status.as_str(), "error" | "interrupted" | "disconnected")
                    }) {
                        "The Agent stopped before this conversation finished. Your draft is preserved. Retry connection to continue; lux-ade will not resend the last prompt."
                    } else {
                        "An Agent action needs attention. Review the diagnostics before continuing."
                    };
                    el.child(ui::provider_attention_card(
                        details.clone(),
                        summary,
                        expanded,
                        ui::button("provider-diagnostics-toggle")
                            .debug_selector(|| "provider-diagnostics-toggle".into())
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.provider_diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                },
            )
            .when(!s.save_error.is_empty(), |el| {
                let details = s.save_error.clone();
                let expanded = self.save_diagnostics.is_expanded(&details);
                el.child(ui::diagnostic_error_card(
                    "save-error-details",
                    "Changes could not be saved",
                    "lux-ade could not save the last change. Keep this window open and check the current state before retrying.",
                    details.clone(),
                    expanded,
                    ui::button("save-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.save_diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ))
            })
            .when(!self.embedded && s.command_overflow, |el| {
                el.child(ui::command_overflow_notice(self.shared.clone()))
            })
            .when(!s.error.is_empty(), |el| {
                let details = s.error.clone();
                let expanded = self.action_diagnostics.is_expanded(&details);
                el.child(ui::diagnostic_error_card(
                    "action-error-details",
                    "Action could not complete",
                    "lux-ade could not finish the action. Check the current state before trying again.",
                    details.clone(),
                    expanded,
                    ui::button("action-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.action_diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ))
            })
            .when(request_form_visible, |el| {
                el.vertical_scrollbar(&self.conversation_scroll)
            });
        let composer = self.render_composer(
            conversation.as_ref(),
            s.connected,
            !view.queued.is_empty(),
            cx,
        );
        let gui_body = v_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .px_3()
            .child(conversation_content)
            .when(request_form_visible, |el| {
                el.child(
                    div()
                        .id("conversation-requests")
                        .flex_shrink_0()
                        .max_h(px(280.))
                        .overflow_y_scroll()
                        .track_scroll(&self.request_scroll)
                        .vertical_scrollbar(&self.request_scroll)
                        .px_4()
                        .py_2()
                        .child(approval),
                )
            })
            .child(composer);
        let conversation_pane = v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .child(
                ui::pane_header(Glyph::MessageSquare, title)
                    .h(px(42.))
                    .when(!view.requests.is_empty(), |el| {
                        el.child(
                            ui::button("review-request")
                                .icon(Glyph::MessageSquare)
                                .when(!compact_header, |button| button.label("Review request"))
                                .tooltip("Review Agent request")
                                .accessibility_label("Review Agent request")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.request_scroll.set_offset(point(px(0.), px(0.)));
                                    cx.notify();
                                })),
                        )
                        .child(
                            ui::button("request-actions")
                                .icon(Glyph::ArrowDown)
                                .when(!compact_header, |button| button.label("Actions"))
                                .tooltip("Jump to request actions")
                                .accessibility_label("Jump to request actions")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.request_scroll.scroll_to_bottom();
                                    cx.notify();
                                })),
                        )
                    })
                    .when(!compact_header, |el| {
                        el.child(ui::conversation_indicator(
                            conversation.as_ref().map(|c| c.status.as_str()),
                            s.connected,
                        ))
                    })
                    .when(compact_header, |el| {
                        let (label, color) = ui::conversation_status(
                            conversation.as_ref().map(|c| c.status.as_str()),
                            s.connected,
                        );
                        el.child(
                            ui::button("conversation-status")
                                .compact()
                                .tooltip(label)
                                .accessibility_label(label)
                                .child(div().size(px(6.)).rounded_full().bg(rgb(color))),
                        )
                    }),
            )
            .child(gui_body);
        conversation_pane.into_any_element()
    }
}
