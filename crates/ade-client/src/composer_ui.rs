//! Composer rendering and editing/recovery controls for one Conversation.
//! Rendering does not submit mutations; controls call the existing controllers.
use crate::*;

impl Workspace {
    pub(super) fn render_composer(
        &mut self,
        conversation: Option<&model::Conversation>,
        connected: bool,
        has_queued: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let busy = conversation.as_ref().is_some_and(|c| {
            matches!(
                c.status.as_str(),
                "starting" | "running" | "waiting" | "cancelling"
            )
        });
        let provider = conversation
            .as_ref()
            .map(|c| c.provider.clone())
            .unwrap_or_else(|| self.new_provider.clone());
        let model_label = conversation
            .as_ref()
            .and_then(|c| c.provider_config.model.as_deref())
            .unwrap_or("Default model");
        let draft_attachments = self.render_draft_attachments(cx);
        let has_prompt = !self.composer.read(cx).value().trim().is_empty()
            || self
                .record
                .conversation_id
                .as_ref()
                .and_then(|id| self.drafts.get(id))
                .is_some_and(|draft| !draft.attachments.is_empty());
        let draft_conflict = self
            .record
            .conversation_id
            .as_ref()
            .and_then(|id| client_state::draft_conflict(&self.shared, &self.record.id, id));
        let send_disabled_reason = if !connected {
            Some("Waiting for lux-ade to reconnect")
        } else if draft_conflict.is_some() {
            Some("Choose which draft to keep before sending")
        } else if self.pending {
            Some("Saving your current action…")
        } else if self.draft_load.error().is_some() {
            Some("Retry loading the draft before editing or sending")
        } else if self.draft_load.blocked() {
            Some("Loading this Conversation’s draft…")
        } else if conversation.is_none() {
            Some("Create or select a Conversation to send a message")
        } else if !has_prompt {
            Some("Write a message or attach a file")
        } else {
            None
        };
        let editor_locked = self.pending || self.draft_load.blocked() || conversation.is_none();
        let paste_target = cx.weak_entity();
        let draft_error = self.draft_load.error().map(str::to_owned);
        if draft_error.is_none() {
            self.draft_diagnostics.clear();
        }
        ui::composer_frame().max_w(px(ui::tokens::READING_WIDTH)).mx_auto().mb_4().flex_shrink_0()
             .child(Textarea::new(&self.composer).h(px(52.)).appearance(false).disabled(editor_locked).aria_label("Message to Agent").on_paste(move |item,_,cx|paste_target.update(cx,|this,cx|this.paste_attachments(item,cx)).unwrap_or(false)))
             .when_some(draft_error, |el, error| {
                 let expanded = self.draft_diagnostics.is_expanded(&error);
                 el.child(draft_ui::failure(
                     error.clone(), expanded,
                     ui::button("draft-diagnostics-toggle")
                         .debug_selector(|| "draft-diagnostics-toggle".into())
                         .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                         .on_click(cx.listener(move |this, _, _, cx| {
                             this.draft_diagnostics.toggle(&error);
                             cx.notify();
                         })),
                     draft_ui::retry_button().on_click(cx.listener(|this,_,window,cx| {
                         this.load_draft(window,cx);
                         cx.notify();
                     })),
                 ))
             })
             .when_some(draft_conflict.as_ref(), |el, conflict| el.child(
                 v_flex().gap_1()
                    .child(ui::field_label("This Conversation has two drafts"))
                    .child(ui::description(format!("Your text is retained. The saved draft is revision {}. Keeping this draft replaces that saved version; loading it replaces this editor.", conflict.saved.revision)))
                    .child(v_flex().id("other-drafts").max_h(px(80.)).overflow_y_scroll().children(conflict.alternatives.iter().enumerate().map(|(index, draft)| {
                        let choice = draft.clone();
                        h_flex().flex_wrap().gap_2()
                            .child(ui::description(format!("Other draft: {}", draft.text.chars().take(100).collect::<String>())))
                            .child(ui::button(("keep-other-draft", index)).label("Keep other draft").disabled(self.pending).on_click(cx.listener(move |this,_,window,cx|this.resolve_draft_choice(Some(choice.clone()),window,cx))))
                    })))
                    .child(h_flex().flex_wrap().gap_2()
                        .child(ui::button("keep-local-draft").label("Keep this draft").disabled(self.pending).on_click(cx.listener(|this,_,window,cx|this.resolve_draft_conflict(true,window,cx))))
                        .child(ui::button("load-saved-draft").label("Load saved draft").disabled(self.pending).on_click(cx.listener(|this,_,window,cx|this.resolve_draft_conflict(false,window,cx)))))
             ))
             .child(draft_attachments)
             .when(!connected, |el|el.child(div().text_size(px(ui::tokens::CAPTION_PX)).text_color(rgb(ui::ACCENT)).child(if editor_locked { "Reconnecting to lux-ade. Sending resumes when connected." } else { "Reconnecting to lux-ade. You can keep editing; sending resumes when connected." })))
             .when(connected && conversation.as_ref().is_some_and(|c| matches!(c.status.as_str(), "error" | "interrupted" | "disconnected")), |el|el.child(div().text_size(px(ui::tokens::CAPTION_PX)).text_color(rgb(ui::MUTED)).child("Retry connection restores the Agent connection. It does not resend your previous prompt.")))
             .when(connected && send_disabled_reason.is_some() && (editor_locked), |el| el.child(ui::description(send_disabled_reason.unwrap())))
             .child(h_flex().flex_wrap().gap_2()
              .child(ui::icon_button("attach-files", Glyph::Plus, "Attach files").disabled(self.pending || self.draft_load.blocked() || conversation.is_none()).on_click(cx.listener(|this,_,_,cx|this.choose_attachments(cx))))
              .child(Icon::new(Glyph::Bot).size(px(14.)).text_color(rgb(ui::MUTED)))
              .child(div().min_w_0().text_size(px(ui::tokens::LABEL_PX)).text_color(rgb(ui::MUTED)).child(format!("{provider} · {model_label}")))
              .child(div().flex_1())
              .when(busy,|el|el.child(ui::button("cancel").label("Cancel turn").disabled(!connected||self.pending).on_click(cx.listener(|this,_,_,cx|this.request(json!({"op":"agent.cancel","conversation_id":this.record.conversation_id}),false,false,cx)))))
              .when(conversation.as_ref().is_some_and(|c|c.terminal_owner.is_none() && matches!(c.status.as_str(), "error" | "interrupted" | "disconnected"))&&!busy,|el|el.child(ui::button("resume").label("Retry connection").disabled(!connected||self.pending).on_click(cx.listener(|this,_,_,cx|this.request(json!({"op":"agent.resume","conversation_id":this.record.conversation_id}),false,false,cx)))))
              .when(!self.embedded && conversation.as_ref().is_some_and(|c|c.terminal_owner.is_none() && c.status!="disconnected")&&!busy,|el|el.child(ui::button("disconnect-agent").label("Disconnect").disabled(!connected||self.pending).on_click(cx.listener(|this,_,_,cx|this.request(json!({"op":"agent.disconnect","conversation_id":this.record.conversation_id}),false,false,cx)))))
              .child(ui::icon_button("send", Glyph::ArrowUp, if self.pending {"Saving…"} else if busy || has_queued || conversation.as_ref().is_some_and(|c| c.queue_paused) {"Queue prompt"} else {"Send message"}).primary().rounded_full().w(px(32.)).h(px(32.)).disabled(send_disabled_reason.is_some()).tooltip(send_disabled_reason.unwrap_or("Send message")).on_click(cx.listener(|this,_,_,cx|{this.submit_prompt(cx);})))).into_any_element()
    }
}
