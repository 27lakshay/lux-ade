//! Chat presentation: stable transcript rows, queued prompts, and draft assets.
//! Provider state and request admission remain with Workspace and the daemon.
use super::*;

/// Uses the parser's code payload, never a reconstructed Markdown substring.
/// Block-scoped IDs keep feedback independent across multiple fences.
fn code_actions(
    block: &gpui_kit::base::text::CodeBlock,
    window: &mut Window,
    cx: &mut App,
) -> Button {
    let code = block.code();
    let copied = window.use_keyed_state("copied-code", cx, |_, _| None::<SharedString>);
    let is_copied = copied.read(cx).as_ref() == Some(&code);
    ui::button("copy-code")
        .label(if is_copied { "Copied" } else { "Copy code" })
        .icon(if is_copied { Glyph::Check } else { Glyph::Copy })
        .accessibility_label("Copy code block")
        .tooltip("Copy this code block without Markdown fences")
        .debug_selector(|| "chat-copy-code".into())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            cx.write_to_clipboard(ClipboardItem::new_string(code.to_string()));
            copied.update(cx, |value, cx| {
                *value = Some(code.clone());
                cx.notify();
            });
            window.refresh();
        })
}

pub(super) fn markdown(
    id: impl Into<ElementId>,
    source: impl Into<SharedString>,
) -> gpui_kit::component::text::TextView {
    gpui_kit::component::text::TextView::markdown(id, source)
        .style(
            gpui_kit::component::text::TextViewStyle::default()
                .code_block(StyleRefinement::default().pt(px(40.))),
        )
        .code_block_actions(code_actions)
}

impl Workspace {
    pub(super) fn message_row(
        &self,
        m: &model::Message,
        child_capable: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if matches!(&m.content, Some(ade_core::transcript::Content::Tool { .. })) {
            let id = m.id.clone();
            let expanded = self.expanded_tools.contains(&id);
            let toggle = ui::button(SharedString::from(format!("tool-toggle-{id}"))).on_click(
                cx.listener(move |this, _, _, cx| {
                    if !this.expanded_tools.remove(&id) {
                        this.expanded_tools.insert(id.clone());
                    }
                    cx.notify();
                }),
            );
            return ui::chat_column()
                .pb_3()
                .child(crate::tool_ui::card(m, expanded, toggle))
                .into_any_element();
        }
        let mut row = ui::chat_message(m.role == "user")
            .id(SharedString::from(format!("message-row-{}", m.id)))
            .when(
                m.role != "user" && (m.kind != "text" || !matches!(m.role.as_str(), "assistant")),
                |row| {
                    row.child(
                        div()
                            .text_size(px(ui::tokens::LABEL_PX))
                            .text_color(rgb(ui::MUTED))
                            .child(ui::message_heading(&m.role, &m.kind, &m.status)),
                    )
                },
            )
            .children(m.attachments.iter().map(|a| {
                div()
                    .text_size(px(ui::tokens::LABEL_PX))
                    .text_color(rgb(ui::MUTED))
                    .child(format!(
                        "Attachment: {} · {} KiB",
                        a.name,
                        a.size.div_ceil(1024)
                    ))
            }))
            .child(markdown(
                SharedString::from(format!("message-{}", m.id)),
                m.content
                    .as_ref()
                    .map(|content| content.display_text())
                    .unwrap_or_else(|| m.text.clone()),
            ));
        if child_capable
            && let Some(ade_core::transcript::Content::Subagents { agents, .. }) = &m.content
        {
            for child in agents {
                let selector = json!({"op":"agent.child_transcript","conversation_id":m.conversation_id,"message_id":m.id,"child_id":child.id,"offset":0});
                row = row.child(
                    ui::button(SharedString::from(format!(
                        "read-child-{}-{}",
                        m.id, child.id
                    )))
                    .label(format!(
                        "Read {}",
                        child.name.as_deref().unwrap_or(&child.id)
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.child_back.clear();
                        this.read_child(selector.clone(), cx);
                    })),
                );
            }
        }
        ui::chat_column().pb_5().child(row).into_any_element()
    }
    pub(super) fn render_prompt_queue(
        &self,
        view: &client_state::View,
        conversation: Option<&model::Conversation>,
        connected: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut queue = v_flex()
            .id("prompt-queue")
            .gap_1()
            .max_h(px(160.))
            .overflow_y_scroll();
        if let Some(c) = conversation
            && (!view.queued.is_empty() || c.queue_paused)
        {
            let paused = c.queue_paused;
            queue = queue.child(h_flex().gap_2()
                    .child(format!("{} queued{}",view.queued.len(),if paused {" · paused"} else {""}))
                    .child(ui::button("queue-pause").label(if paused {"Resume queue"} else {"Pause queue"})
                        .disabled(!connected || self.pending || c.terminal_owner.is_some())
                        .on_click(cx.listener(move |this,_,_,cx| this.request(json!({"op":"queue.pause","conversation_id":this.record.conversation_id,"paused":!paused}),false,false,cx)))));
        }
        for prompt in &view.queued {
            let id = prompt.id.clone();
            queue=queue.child(h_flex().gap_2()
                .child(div().flex_1().truncate().child(format!("{}{}",prompt.text.chars().take(160).collect::<String>(),if prompt.attachments.is_empty(){String::new()}else{format!(" · {} attachment(s)",prompt.attachments.len())})))
                .child(ui::button(SharedString::from(format!("cancel-queued-{id}"))).label("Remove").accessibility_label(format!("Remove queued prompt: {}", prompt.text.chars().take(80).collect::<String>()))
                    .disabled(!connected || self.pending)
                    .on_click(cx.listener(move |this,_,_,cx| this.request(json!({"op":"queue.cancel","conversation_id":this.record.conversation_id,"request_id":id}),false,false,cx)))));
        }
        queue.into_any_element()
    }
    pub(super) fn render_draft_attachments(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut draft_attachments = v_flex()
            .id("draft-attachments")
            .max_h(px(72.))
            .overflow_y_scroll()
            .gap_1();
        if let Some(draft) = self
            .record
            .conversation_id
            .as_ref()
            .and_then(|id| self.drafts.get(id))
        {
            for attachment in &draft.attachments {
                let id = attachment.id.clone();
                draft_attachments = draft_attachments.child(
                    h_flex()
                        .gap_2()
                        .child(div().flex_1().truncate().child(format!(
                            "{} · {} KiB",
                            attachment.name,
                            attachment.size.div_ceil(1024)
                        )))
                        .child(
                            ui::button(SharedString::from(format!("remove-attachment-{id}")))
                                .label("Remove attachment")
                                .accessibility_label(format!(
                                    "Remove attachment {}",
                                    attachment.name
                                ))
                                .disabled(self.pending || self.draft_load.blocked())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.remove_attachment(&id, cx)
                                })),
                        ),
                );
            }
        }
        draft_attachments.into_any_element()
    }
}

#[cfg(test)]
mod code_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    struct CodePreview;
    impl Render for CodePreview {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(markdown(
                "code-copy-test",
                "Before\n\n```python\ndef greet():\n    return \"héllo\"\n```\n\nAfter",
            ))
        }
    }
    struct SelectionPreview;
    impl Render for SelectionPreview {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(
                div()
                    .w(px(400.))
                    .debug_selector(|| "chat-selection-preview".into())
                    .child(markdown(
                        "chat-selection-test",
                        "Select this answer reliably.",
                    )),
            )
        }
    }
    #[gpui::test]
    fn chat_markdown_selection_copies_exact_text(cx: &mut TestAppContext) {
        let (_, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            let view = cx.new(|_| SelectionPreview);
            gpui_kit::base::Root::new(view, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx.debug_bounds("chat-selection-preview").unwrap();
        let start = bounds.origin + point(px(3.), px(12.));
        let end = start + point(px(210.), px(0.));
        cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::none());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let selected = cx.update(gpui_kit::base::TextSelection::selected_text);
        assert!(
            selected.contains("Select this answer"),
            "selected: {selected:?}"
        );
        assert!(
            !selected.ends_with('\n'),
            "a drag ending within a line must not select its structural newline: {selected:?}"
        );
        cx.simulate_keystrokes("cmd-c");
        let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(copied.as_deref(), Some(selected.as_str()));
    }
    struct WhitespaceSelectionPreview;
    impl Render for WhitespaceSelectionPreview {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .w(px(400.))
                .debug_selector(|| "whitespace-selection-preview".into())
                .child(markdown("whitespace-selection-test", "\u{a0}\u{a0}\u{a0}"))
        }
    }
    #[gpui::test]
    fn chat_markdown_copies_whitespace_only_selection(cx: &mut TestAppContext) {
        let (_, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            let view = cx.new(|_| WhitespaceSelectionPreview);
            gpui_kit::base::Root::new(view, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx.debug_bounds("whitespace-selection-preview").unwrap();
        let point = bounds.origin + point(px(4.), px(12.));
        cx.simulate_mouse_down(point, MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(point, MouseButton::Left, Modifiers::none());
        cx.simulate_keystrokes("cmd-a");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let selected = cx.update(gpui_kit::base::TextSelection::selected_text);
        assert!(!selected.is_empty(), "whitespace selection was discarded");
        assert!(selected.trim().is_empty(), "selected: {selected:?}");
        cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into())));
        cx.simulate_keystrokes("cmd-c");
        let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(copied.as_deref(), Some(selected.as_str()));
    }
    #[gpui::test]
    fn code_action_copies_only_parsed_payload(cx: &mut TestAppContext) {
        let (_, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            CodePreview
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx
            .debug_bounds("chat-copy-code")
            .expect("parsed code fence exposes copy action");
        cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        let text = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(text.as_deref(), Some("def greet():\n    return \"héllo\""));
    }
    #[test]
    fn bundled_languages_have_real_grammars() {
        use gpui_kit::base::input::Rope;
        use gpui_kit::component::highlighter::{
            HighlightTheme, LanguageRegistry, SyntaxHighlighter,
        };
        for (language, source) in [
            ("python", "def greet(): return 42"),
            ("rust", "fn main() { let x = 42; }"),
            ("javascript", "const x = 42;"),
            ("typescript", "const x: number = 42;"),
            ("tsx", "const el = <div/>;"),
            ("bash", "echo \"hello\""),
            ("json", "{\"value\":42}"),
        ] {
            assert!(
                LanguageRegistry::singleton().language(language).is_some(),
                "missing grammar: {language}"
            );
            let mut highlighter = SyntaxHighlighter::new(language);
            assert!(highlighter.update(None, &Rope::from_str(source), None));
            let styles =
                highlighter.styles(&(0..source.len()), HighlightTheme::default_dark().as_ref());
            assert!(
                styles.iter().any(|(_, style)| style.color.is_some()),
                "no syntax colors for {language}"
            );
        }
    }
}
