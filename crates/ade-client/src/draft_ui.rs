//! Draft loading fails closed, with a visible retry rather than an empty draft.
use crate::{model, ui};
use gpui_kit::{component::button::Button, *};
use serde_json::Value;

#[derive(Default, Debug)]
pub(crate) enum LoadState {
    #[default]
    Loading,
    Ready,
    Failed(String),
}
impl LoadState {
    pub fn blocked(&self) -> bool {
        !matches!(self, Self::Ready)
    }
    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Failed(error) => Some(error),
            _ => None,
        }
    }
    pub fn finish(&mut self, response: Result<Value, String>) -> Option<model::Draft> {
        match response.and_then(|value| {
            serde_json::from_value(value["draft"].clone())
                .map_err(|error| format!("lux-ade returned an invalid draft: {error}"))
        }) {
            Ok(draft) => {
                *self = Self::Ready;
                Some(draft)
            }
            Err(error) => {
                *self = Self::Failed(error);
                None
            }
        }
    }
}
pub(crate) fn failure(error: String, expanded: bool, toggle: Button, retry: Button) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(ui::diagnostic_error_card(
            "draft-load-error",
            "Draft could not load",
            "lux-ade could not load the saved draft. Your current text is retained. Retry loading before editing or sending.",
            error,
            expanded,
            toggle,
        ))
        .child(div().child(retry))
}
pub(crate) fn retry_button() -> Button {
    ui::button("retry-draft-load")
        .label("Retry loading draft")
        .accessibility_label("Retry loading draft")
        .debug_selector(|| "retry-draft-load".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use gpui_kit::prelude::FluentBuilder;
    use std::prelude::v1::test;
    #[test]
    fn failed_and_malformed_responses_leave_loading_without_becoming_empty() {
        for response in [
            Err("connection lost".into()),
            Ok(serde_json::json!({"draft":null})),
        ] {
            let mut state = LoadState::Loading;
            assert!(state.finish(response).is_none());
            assert!(matches!(state, LoadState::Failed(_)));
            assert!(state.blocked());
            let draft = state
                .finish(Ok(
                    serde_json::json!({"draft":{"text":"saved text","revision":4}}),
                ))
                .unwrap();
            assert_eq!(draft.text, "saved text");
            assert!(!state.blocked());
        }
    }
    struct FailedDraft {
        state: LoadState,
        text: String,
        expanded: bool,
    }
    impl Render for FailedDraft {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .child(self.text.clone())
                .when_some(self.state.error(), |el, error| {
                    el.child(failure(
                        error.to_owned(),
                        self.expanded,
                        ui::button("draft-diagnostics-toggle")
                            .debug_selector(|| "draft-diagnostics-toggle".into())
                            .label(if self.expanded {
                                "Hide diagnostics"
                            } else {
                                "Show diagnostics"
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.expanded = !this.expanded;
                                cx.notify();
                            })),
                        retry_button().on_click(cx.listener(|this, _, _, cx| {
                            this.state = LoadState::Loading;
                            if let Some(draft) = this.state.finish(Ok(
                                serde_json::json!({"draft":{"text":"restored draft","revision":7}}),
                            )) {
                                this.text = draft.text;
                            }
                            cx.notify();
                        })),
                    ))
                })
        }
    }
    #[gpui::test]
    fn failed_response_exposes_working_retry_without_erasing_text(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            let mut state = LoadState::Loading;
            assert!(state.finish(Err("offline".into())).is_none());
            FailedDraft {
                state,
                text: "local text stays".into(),
                expanded: false,
            }
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |view, _| assert_eq!(view.text, "local text stays"));
        assert!(cx.debug_bounds("draft-load-error-summary").is_some());
        assert!(cx.debug_bounds("draft-load-error-copy").is_none());
        let toggle = cx.debug_bounds("draft-diagnostics-toggle").unwrap();
        cx.simulate_mouse_down(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let copy = cx.debug_bounds("draft-load-error-copy").unwrap();
        cx.simulate_mouse_down(copy.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(copy.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some("offline".into())
        );
        let bounds = cx.debug_bounds("retry-draft-load").expect("visible retry");
        cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(view.text, "restored draft");
            assert!(!view.state.blocked());
        });
    }
}
