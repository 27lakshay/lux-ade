//! Tool event presentation. Disclosure is view state; provider data stays unchanged.
use crate::{chat_ui, ui};
use ade_core::{model::Message, transcript::Content};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{assets::IconName, component::button::Button, *};

const PREVIEW_BYTES: usize = 16 * 1024;

fn preview(text: &str) -> (&str, bool) {
    let mut end = text.len().min(PREVIEW_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], end < text.len())
}

// A provider's output is literal data, including any Markdown-looking content.
fn literal(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{fence}\n{text}\n{fence}")
}

fn detail(id: SharedString, label: &'static str, text: String) -> AnyElement {
    let (shown, truncated) = preview(&text);
    let body = literal(shown);
    let copy_label = format!("Copy {}", label.to_lowercase());
    v_flex()
        .min_w_0()
        .gap_1()
        .child(
            h_flex().justify_between().child(label).child(
                ui::button((ElementId::from(id.clone()), "copy"))
                    .label(copy_label)
                    .icon(IconName::Copy)
                    .debug_selector(move || format!("tool-copy-{}", label.to_lowercase()))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                    }),
            ),
        )
        .when(truncated, |view| {
            view.child(
                div()
                    .text_color(rgb(ui::MUTED))
                    .child("Preview limited to 16 KiB. Copy includes the complete value."),
            )
        })
        .child(
            div()
                .id((ElementId::from(id.clone()), "scroll"))
                .max_h(px(280.))
                .overflow_y_scroll()
                .child(
                    // Copy is above the preview so its payload is never truncated.
                    gpui_kit::component::text::TextView::markdown(id, body).selectable(true),
                ),
        )
        .into_any_element()
}

pub fn card(message: &Message, expanded: bool, toggle: Button) -> AnyElement {
    let Some(Content::Tool {
        name,
        input,
        output,
        is_error,
        ..
    }) = &message.content
    else {
        return chat_ui::markdown(
            SharedString::from(format!("tool-fallback-{}", message.id)),
            message.text.clone(),
        )
        .into_any_element();
    };
    let failed = *is_error || message.status == "failed";
    let state = if failed {
        "Failed"
    } else {
        match message.status.as_str() {
            "streaming" | "running" => "Running",
            "pending" => "Pending",
            "interrupted" => "Interrupted",
            "cancelled" | "canceled" => "Cancelled",
            "completed" | "complete" | "done" => "Completed",
            _ => "Tool activity",
        }
    };
    let mut card = v_flex()
        .w_full()
        .min_w_0()
        .gap_2()
        .rounded_md()
        .border_1()
        .border_color(rgb(ui::BORDER))
        .p_2()
        .child(
            h_flex()
                .gap_2()
                .min_w_0()
                .child(
                    toggle
                        .icon(if expanded {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .label(name.clone())
                        .toggled(expanded)
                        .max_w(relative(0.75))
                        .accessibility_label(format!(
                            "{} tool details for {name}",
                            if expanded { "Hide" } else { "Show" }
                        ))
                        .tooltip(name.clone())
                        .debug_selector(|| "tool-disclosure".into()),
                )
                .child(div().flex_1())
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(if failed { ui::DANGER } else { ui::MUTED }))
                        .child(state),
                ),
        );
    if let Some(summary) = input.as_ref().and_then(|input| {
        ["command", "file_path", "path", "query", "description"]
            .into_iter()
            .find_map(|key| input.get(key).and_then(serde_json::Value::as_str))
    }) {
        card = card.child(
            div()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(rgb(ui::MUTED))
                .child(summary.chars().take(160).collect::<String>()),
        );
    }
    if failed
        && !expanded
        && let Some(output) = output.as_ref().filter(|s| !s.is_empty())
    {
        card = card.child(
            div()
                .truncate()
                .text_sm()
                .text_color(rgb(ui::DANGER))
                .child(
                    output
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .chars()
                        .take(160)
                        .collect::<String>(),
                ),
        );
    }
    if expanded {
        let mut details = v_flex()
            .gap_3()
            .min_w_0()
            .debug_selector(|| "tool-details".into());
        if let Some(input) = input {
            details = details.child(detail(
                format!("tool-input-{}", message.id).into(),
                "Input",
                serde_json::to_string_pretty(input).unwrap_or_default(),
            ));
        }
        details = details.child(match output {
            Some(output) if !output.is_empty() => detail(
                format!("tool-output-{}", message.id).into(),
                "Output",
                output.clone(),
            ),
            _ => div()
                .text_color(rgb(ui::MUTED))
                .child(if state == "Running" || state == "Pending" {
                    "Waiting for output…"
                } else {
                    "No output returned."
                })
                .into_any_element(),
        });
        card = card.child(details);
    }
    card.children(message.attachments.iter().map(|attachment| {
        div().text_sm().text_color(rgb(ui::MUTED)).child(format!(
            "Attachment: {} · {} KiB",
            attachment.name,
            attachment.size.div_ceil(1024)
        ))
    }))
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    #[test]
    fn output_preview_preserves_unicode_and_literal_fences() {
        let text = format!("{}é```\n# output", "x".repeat(PREVIEW_BYTES - 1));
        let (shown, clipped) = preview(&text);
        assert!(clipped);
        assert_eq!(shown.len(), PREVIEW_BYTES - 1);
        assert_eq!(literal("```\n# output"), "````\n```\n# output\n````");
    }

    struct Harness {
        message: Message,
        expanded: bool,
    }
    impl Render for Harness {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div().w(px(700.)).child(card(
                &self.message,
                self.expanded,
                ui::button("toggle").on_click(cx.listener(|this, _, _, cx| {
                    this.expanded = !this.expanded;
                    cx.notify();
                })),
            ))
        }
    }
    #[gpui::test]
    fn disclosure_and_copy_use_actual_full_output(cx: &mut TestAppContext) {
        let output = format!("{}é\n```\ncomplete", "x".repeat(PREVIEW_BYTES));
        let expected = output.clone();
        let (_, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);ui::install(cx);
            Harness {
                message: serde_json::from_value(serde_json::json!({
                    "id":"tool-a", "conversation_id":"chat-a", "role":"assistant", "kind":"tool", "text":"", "status":"completed", "sequence":1,
                    "content":{"type":"tool","call_id":"a","name":"Read","input":null,"output":output,"is_error":false}
                })).unwrap(), expanded:false,
            }
        });
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(cx.debug_bounds("tool-details").is_none());
        let bounds = cx.debug_bounds("tool-disclosure").unwrap();
        cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(cx.debug_bounds("tool-details").is_some());
        let bounds = cx.debug_bounds("tool-copy-output").unwrap();
        cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(expected)
        );
    }
}
