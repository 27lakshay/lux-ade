//! lux-ade presentation vocabulary. GPUI Kit owns control behavior and focus.
use gpui_kit::{
    component::{button::*, *},
    prelude::FluentBuilder,
    *,
};
pub const CANVAS: u32 = 0x17181b;
pub const SIDEBAR: u32 = 0x24262a;
pub const SURFACE: u32 = 0x222429;
pub const HOVER: u32 = 0x303339;
pub const ELEVATED: u32 = 0x393d44;
pub const COMPOSER: u32 = 0x282b30;
pub const BORDER: u32 = 0x393c42;
pub const TEXT: u32 = 0xf2f0eb;
pub const MUTED: u32 = 0xb6b7ba;
pub const ACCENT: u32 = 0xf2f0eb;
pub const SUCCESS: u32 = 0xb0d1bd;
pub const DANGER: u32 = 0xecaaa3;

/// Shared dimensions and finite motion policy used by production components.
pub mod tokens {
    /// Secondary metadata and recovery hints; never primary chat content.
    pub const CAPTION_PX: f32 = 11.;
    /// Compact field/group labels and supporting controls.
    pub const LABEL_PX: f32 = 12.;
    /// Dense workspace chrome, including tabs and sidebar rows.
    pub const COMPACT_PX: f32 = 13.;
    pub const INTERFACE_PX: f32 = 14.;
    pub const CODE_PX: f32 = 13.;
    pub const READING_WIDTH: f32 = 760.;
    pub const USER_MESSAGE_WIDTH: f32 = 560.;
    pub const RADIUS: f32 = 8.;
    pub const CARD_RADIUS: f32 = 12.;
    pub const COMPOSER_RADIUS: f32 = 20.;
    pub const MICRO_MS: u64 = 120;
    pub const REVEAL_MS: u64 = 180;
    pub const LAYOUT_MS: u64 = 220;
}

pub fn refresh_motion_preference(window: &mut Window, cx: &mut App) {
    if window.is_window_active() {
        gpui_kit::base::apply_system_reduce_motion(cx);
        window.refresh();
    }
}

pub fn install(cx: &mut App) {
    Theme::update(cx, |theme| {
        theme.font_family = ".SystemUIFont".into();
        theme.font_size = px(tokens::INTERFACE_PX);
        theme.mono_font_size = px(tokens::CODE_PX);
        theme.radius = px(tokens::RADIUS);
        theme.radius_lg = px(tokens::CARD_RADIUS);
        theme.motion.duration_fast = std::time::Duration::from_millis(tokens::MICRO_MS);
        theme.motion.duration_normal = std::time::Duration::from_millis(tokens::REVEAL_MS);
        theme.motion.duration_slow = std::time::Duration::from_millis(tokens::LAYOUT_MS);
        let c = &mut theme.colors;
        c.background = rgb(CANVAS).into();
        c.foreground = rgb(TEXT).into();
        c.border = rgb(BORDER).into();
        c.input = rgb(BORDER).into();
        c.muted = rgb(SURFACE).into();
        c.muted_foreground = rgb(MUTED).into();
        c.accent = rgb(HOVER).into();
        c.accent_foreground = rgb(TEXT).into();
        c.selection = rgb(0x454545).into();
        c.ring = rgb(ACCENT).into();
        c.caret = rgb(ACCENT).into();
        c.primary = rgb(ACCENT).into();
        c.primary_hover = rgb(0xffffff).into();
        c.primary_active = rgb(0xd0d0d0).into();
        c.primary_foreground = rgb(CANVAS).into();
        c.button_primary = c.primary;
        c.button_primary_hover = c.primary_hover;
        c.button_primary_active = c.primary_active;
        c.button_primary_foreground = c.primary_foreground;
        c.button = rgb(SURFACE).into();
        c.button_hover = rgb(HOVER).into();
        c.button_active = rgb(ELEVATED).into();
        c.button_foreground = rgb(TEXT).into();
        c.secondary = c.button;
        c.secondary_hover = c.button_hover;
        c.secondary_active = c.button_active;
        c.secondary_foreground = c.button_foreground;
        c.sidebar = rgb(SIDEBAR).into();
        c.sidebar_foreground = rgb(TEXT).into();
        c.sidebar_border = c.border;
        c.sidebar_accent = rgb(ELEVATED).into();
        c.sidebar_accent_foreground = c.foreground;
        c.sidebar_primary = c.primary;
        c.sidebar_primary_foreground = c.primary_foreground;
        c.popover = rgb(SURFACE).into();
        c.popover_foreground = c.foreground;
        c.title_bar = rgb(SIDEBAR).into();
        c.title_bar_border = c.border;
        c.list = c.background;
        c.list_head = rgb(SURFACE).into();
        c.list_hover = rgb(HOVER).into();
        c.list_active = rgb(ELEVATED).into();
        c.list_active_border = c.border;
        c.tab = rgb(CANVAS).into();
        c.tab_bar = c.tab;
        c.tab_bar_segmented = rgb(SURFACE).into();
        c.tab_active = rgb(SURFACE).into();
        c.tab_foreground = c.muted_foreground;
        c.tab_active_foreground = c.foreground;
        c.danger = rgb(DANGER).into();
        c.danger_hover = rgb(0xedb4af).into();
        c.danger_active = rgb(0xcc8983).into();
        c.danger_foreground = c.background;
        c.button_danger = c.danger;
        c.button_danger_hover = c.danger_hover;
        c.button_danger_active = c.danger_active;
        c.button_danger_foreground = c.danger_foreground;
        c.success = rgb(SUCCESS).into();
        c.success_hover = rgb(0xb9d4c2).into();
        c.success_active = rgb(0x8faf9b).into();
        c.success_foreground = c.background;
        c.button_success = c.success;
        c.button_success_hover = c.success_hover;
        c.button_success_active = c.success_active;
        c.button_success_foreground = c.success_foreground;
        c.warning = rgb(0xe7b979).into();
        c.warning_hover = rgb(0xf0c991).into();
        c.warning_active = rgb(0xcba064).into();
        c.warning_foreground = c.primary_foreground;
        c.button_warning = c.warning;
        c.button_warning_hover = c.warning_hover;
        c.button_warning_active = c.warning_active;
        c.button_warning_foreground = c.warning_foreground;
        c.info = rgb(0xa6bfd8).into();
        c.info_hover = rgb(0xb8cde2).into();
        c.info_active = rgb(0x91abc5).into();
        c.info_foreground = c.background;
        c.button_info = c.info;
        c.button_info_hover = c.info_hover;
        c.button_info_active = c.info_active;
        c.button_info_foreground = c.info_foreground;
        c.progress_bar = c.primary;
        c.skeleton = rgb(HOVER).into();
    });
}
pub fn button(id: impl Into<ElementId>) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .rounded_md()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
}
/// Repeated row actions keep compact visible labels and identify their target
/// independently for assistive technology and pointer tooltips.
pub fn row_action(
    id: impl Into<ElementId>,
    label: &'static str,
    target: impl AsRef<str>,
) -> Button {
    let accessible = format!("{} {}", label.trim_end_matches('…'), target.as_ref());
    button(id)
        .label(label)
        .accessibility_label(accessible.clone())
        .tooltip(accessible)
}
/// A neutral, high-contrast primary action.
pub fn primary_button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    button(id).primary().label(label)
}
pub fn icon_button(
    id: impl Into<ElementId>,
    icon: gpui_kit::assets::IconName,
    label: impl Into<SharedString>,
) -> Button {
    let label = label.into();
    button(id)
        .icon(icon)
        .compact()
        .tooltip(label.clone())
        .accessibility_label(label)
}
pub fn nav_row(
    id: impl Into<ElementId>,
    icon: gpui_kit::assets::IconName,
    label: impl Into<SharedString>,
    selected: bool,
) -> Button {
    button(id)
        .icon(icon)
        .label(label)
        .selected(selected)
        .w_full()
        .justify_start()
        .h_8()
        .px_3()
        .child(div().flex_1())
}
/// Chat content shares one reading width with the composer.
pub fn chat_column() -> Div {
    v_flex()
        .w_full()
        .min_w_0()
        .max_w(px(tokens::READING_WIDTH))
        .mx_auto()
}
/// The caller provides message content and retains its stable message ID.
/// User rows align to the right; assistant content stays on the canvas.
pub fn chat_message(user: bool) -> Div {
    let row = v_flex()
        .min_w_0()
        .flex_shrink_0()
        .gap_2()
        .text_size(px(tokens::INTERFACE_PX));
    if user {
        row.max_w(px(tokens::USER_MESSAGE_WIDTH))
            .ml_auto()
            .px_4()
            .py_3()
            .rounded(px(18.))
            .bg(rgb(COMPOSER))
    } else {
        row.w_full()
    }
}
pub fn composer_frame() -> Div {
    v_flex()
        .w_full()
        .min_w_0()
        .gap_2()
        .p_3()
        .bg(rgb(COMPOSER))
        .rounded(px(tokens::COMPOSER_RADIUS))
}
pub fn sidebar_section(label: impl Into<SharedString>) -> Div {
    div()
        .px_2()
        .pt_4()
        .pb_1()
        .text_size(px(tokens::LABEL_PX))
        .text_color(rgb(MUTED))
        .child(label.into())
}
pub fn sidebar_row(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
) -> Button {
    button(id)
        .label(label)
        .selected(selected)
        .w_full()
        .h_8()
        .px_2()
        .text_size(px(tokens::COMPACT_PX))
        .font_weight(FontWeight::NORMAL)
        .when(selected, |row| row.bg(rgb(ELEVATED)))
        .child(div().flex_1())
}
pub fn pane_header(icon: gpui_kit::assets::IconName, title: impl Into<SharedString>) -> Div {
    h_flex()
        .h_12()
        .flex_shrink_0()
        .px_4()
        .gap_2()
        .border_b_1()
        .border_color(rgb(BORDER))
        .child(Icon::new(icon).size_4().text_color(rgb(MUTED)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(title.into()),
        )
}
pub fn card() -> Div {
    v_flex()
        .min_w_0()
        .p_4()
        .gap_3()
        .bg(rgb(SURFACE))
        .border_1()
        .border_color(rgb(BORDER))
        .rounded_lg()
}
pub fn inset_card() -> Div {
    v_flex()
        .min_w_0()
        .p_3()
        .gap_2()
        .bg(rgb(CANVAS))
        .border_1()
        .border_color(rgb(BORDER))
        .rounded_md()
}
pub fn panel_title(title: impl Into<SharedString>) -> Div {
    div()
        .text_xl()
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(TEXT))
        .child(title.into())
}
pub fn panel_footer() -> Div {
    h_flex()
        .flex_wrap()
        .gap_2()
        .pt_3()
        .mt_2()
        .border_t_1()
        .border_color(rgb(BORDER))
}
pub fn field_label(label: impl Into<SharedString>) -> Div {
    div()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(TEXT))
        .child(label.into())
}
pub fn description(text: impl Into<SharedString>) -> Div {
    div().text_sm().text_color(rgb(MUTED)).child(text.into())
}
pub fn chip(label: impl Into<SharedString>) -> Div {
    h_flex()
        .flex_shrink_0()
        .px_2()
        .py_1()
        .gap_1()
        .rounded_md()
        .bg(rgb(HOVER))
        .text_xs()
        .text_color(rgb(MUTED))
        .child(label.into())
}
pub fn shortcut(label: impl Into<SharedString>) -> Div {
    let label: SharedString = label.into();
    let label: SharedString = label
        .split('+')
        .map(|part| match part {
            "cmd" => "⌘".to_owned(),
            "ctrl" => "⌃".to_owned(),
            "alt" => "⌥".to_owned(),
            "shift" => "⇧".to_owned(),
            key if key.len() == 1 => key.to_uppercase(),
            key => key.to_owned(),
        })
        .collect::<String>()
        .into();
    div()
        .flex_shrink_0()
        .px_1()
        .rounded_sm()
        .border_1()
        .border_color(rgb(BORDER))
        .text_xs()
        .text_color(rgb(MUTED))
        .child(label)
}
pub fn divider() -> Div {
    div().h_px().w_full().flex_shrink_0().bg(rgb(BORDER))
}
pub fn empty_state(
    icon: gpui_kit::assets::IconName,
    title: impl Into<SharedString>,
    details: impl Into<SharedString>,
) -> Div {
    v_flex()
        .min_w_0()
        .max_w_96()
        .gap_3()
        .p_6()
        .child(
            div()
                .size_10()
                .rounded_lg()
                .border_1()
                .border_color(rgb(BORDER))
                .flex()
                .items_center()
                .justify_center()
                .child(Icon::new(icon).size_5().text_color(rgb(ACCENT))),
        )
        .child(
            div()
                .text_xl()
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(TEXT))
                .child(title.into()),
        )
        .child(description(details))
}

/// Finite native motion. The framework synchronizes and stops frames when the
/// system requests reduced motion; callers keep IDs stable across visibility changes.
pub mod motion {
    use super::*;
    use gpui_kit::base::motion::{Presence, PresenceSample, Transition, TransitionId};
    /// One-shot feedback for lightweight pane chrome; never wraps native surfaces.
    #[derive(Default)]
    pub struct PaneFeedback(Option<std::time::Instant>);
    impl PaneFeedback {
        pub fn begin(&mut self, pointer: bool, reduce_motion: bool) {
            self.0 = (pointer && !reduce_motion).then(std::time::Instant::now);
        }
        pub fn opacity(&mut self, window: &mut Window, cx: &App) -> f32 {
            self.sample(std::time::Instant::now(), cx.reduce_motion(), || {
                window.request_animation_frame()
            })
        }
        fn sample(
            &mut self,
            now: std::time::Instant,
            reduce_motion: bool,
            frame: impl FnOnce(),
        ) -> f32 {
            let Some(started) = self.0 else {
                return 1.;
            };
            let elapsed = now.saturating_duration_since(started);
            if reduce_motion || elapsed >= std::time::Duration::from_millis(tokens::MICRO_MS) {
                self.0 = None;
                return 1.;
            }
            frame();
            let progress = elapsed.as_secs_f32() / (tokens::MICRO_MS as f32 / 1000.);
            1. - 0.25 * (1. - progress).powi(3)
        }
    }
    /// Entrance only: geometry and hit targets settle immediately. The native
    /// animation element jumps to its final value under Reduce Motion.
    pub fn sidebar_enter(content: impl IntoElement + Styled + 'static) -> impl IntoElement {
        content.with_animation(
            "ade-sidebar-enter",
            Animation::new(std::time::Duration::from_millis(tokens::REVEAL_MS)),
            |content, progress| content.opacity(0.75 + progress * 0.25),
        )
    }

    /// Keep the slot mounted while `should_render()` is true; use progress for
    /// opacity or MotionReveal. Never use this around the streaming transcript.
    pub fn reveal(
        id: impl Into<TransitionId>,
        visible: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> PresenceSample {
        let tokens = &cx.theme().motion;
        let policy = Transition::new(if visible {
            tokens.duration_normal
        } else {
            tokens.duration_fast
        })
        .easing(if visible {
            tokens.easing_enter.clone()
        } else {
            tokens.easing_exit.clone()
        });
        Presence::new(id, visible)
            .transition(policy)
            .sample(window, cx)
    }
    #[cfg(test)]
    mod pane_feedback_tests {
        use super::*;
        use std::prelude::v1::test;
        #[test]
        fn keyboard_and_reduced_motion_never_schedule_frames() {
            for (pointer, reduced) in [(false, false), (false, true), (true, true)] {
                let mut feedback = PaneFeedback::default();
                feedback.begin(pointer, reduced);
                assert_eq!(
                    feedback.sample(std::time::Instant::now(), reduced, || panic!(
                        "unexpected animation"
                    )),
                    1.
                );
            }
        }
        #[test]
        fn pointer_feedback_settles_and_reduced_motion_interrupts() {
            let start = std::time::Instant::now();
            let mut feedback = PaneFeedback(Some(start));
            assert_eq!(feedback.sample(start, false, || {}), 0.75);
            let middle =
                feedback.sample(start + std::time::Duration::from_millis(60), false, || {});
            assert!(middle > 0.75 && middle < 1.);
            assert_eq!(
                feedback.sample(start, true, || panic!("unexpected frame")),
                1.
            );
            assert!(feedback.0.is_none());
            feedback.0 = Some(start);
            assert_eq!(
                feedback.sample(
                    start + std::time::Duration::from_millis(tokens::MICRO_MS),
                    false,
                    || panic!("animation must stop")
                ),
                1.
            );
            assert!(feedback.0.is_none());
        }
    }
}

pub fn section(title: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(tokens::LABEL_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(MUTED))
        .child(title.into())
}
pub fn pane_title(icon: gpui_kit::assets::IconName, title: &'static str) -> Div {
    h_flex()
        .gap_2()
        .text_size(px(tokens::LABEL_PX))
        .font_weight(FontWeight::MEDIUM)
        .child(Icon::new(icon).size(px(14.)).text_color(rgb(MUTED)))
        .child(title)
}
pub fn status(label: impl Into<SharedString>, healthy: bool) -> Div {
    h_flex()
        .gap_2()
        .text_size(px(tokens::CAPTION_PX))
        .text_color(rgb(MUTED))
        .child(
            div()
                .size(px(5.))
                .rounded_full()
                .bg(rgb(if healthy { SUCCESS } else { ACCENT })),
        )
        .child(label.into())
}

/// Provider lifecycle and daemon connectivity are separate: a healthy transport
/// must never turn a failed or disconnected provider's indicator green.
pub fn conversation_status(state: Option<&str>, connected: bool) -> (&'static str, u32) {
    if !connected {
        return ("Reconnecting…", ACCENT);
    }
    match state {
        None => ("No Conversation", MUTED),
        Some("idle") => ("Ready to start", MUTED),
        Some("ready") => ("Ready", SUCCESS),
        Some("starting") => ("Starting…", ACCENT),
        Some("running") => ("Working…", ACCENT),
        Some("waiting") => ("Needs your response", ACCENT),
        Some("cancelling") => ("Stopping…", ACCENT),
        Some("error") => ("Needs attention", DANGER),
        Some("interrupted") => ("Interrupted", ACCENT),
        Some("disconnected") => ("Disconnected", MUTED),
        Some(_) => ("Status unavailable", MUTED),
    }
}
pub fn conversation_indicator(state: Option<&str>, connected: bool) -> Div {
    let (label, color) = conversation_status(state, connected);
    h_flex()
        .gap_2()
        .text_size(px(tokens::CAPTION_PX))
        .text_color(rgb(MUTED))
        .child(div().size(px(5.)).rounded_full().bg(rgb(color)))
        .child(label)
}

/// Bound rich-text layout while preserving the exact complete text for copying.
const DIAGNOSTIC_PREVIEW_BYTES: usize = 8192;
fn diagnostic_preview(details: &str) -> (String, bool) {
    let mut end = details.len().min(DIAGNOSTIC_PREVIEW_BYTES);
    while !details.is_char_boundary(end) {
        end -= 1;
    }
    let preview = &details[..end];
    // Literal fenced text: provider output must not become links or HTML.
    let longest = preview.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    (
        format!("{fence}text\n{preview}\n{fence}"),
        end < details.len(),
    )
}

/// Selectable literal preview with an explicit limit and complete-payload copy.
pub fn text_details(
    id: impl Into<SharedString>,
    details: String,
    copy_label: impl Into<SharedString>,
) -> Div {
    let id = id.into();
    let label = copy_label.into();
    let selector = format!("{id}-copy");
    let (preview, truncated) = diagnostic_preview(&details);
    v_flex()
        .gap_1()
        .min_w_0()
        .child(
            h_flex().justify_end().child(
                button(SharedString::from(selector.clone()))
                    .label(label.clone())
                    .accessibility_label(label)
                    .debug_selector(move || selector.clone())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        cx.write_to_clipboard(ClipboardItem::new_string(details.clone()));
                    }),
            ),
        )
        .when(truncated, |card| {
            card.child(description(
                "Preview truncated to 8 KiB. The copy button includes the complete text.",
            ))
        })
        .child(
            div()
                .id(id.clone())
                .max_h(px(88.))
                .overflow_y_scroll()
                .text_size(px(tokens::LABEL_PX))
                .text_color(rgb(MUTED))
                .child(gpui_kit::component::text::TextView::markdown(
                    SharedString::from(format!("{id}-text")),
                    preview,
                )),
        )
}

fn error_frame(title: &'static str, control: Option<Button>) -> Div {
    v_flex()
        .mx_4()
        .mb_2()
        .p_3()
        .gap_1()
        .flex_shrink_0()
        .bg(rgb(SURFACE))
        .border_1()
        .border_color(rgb(BORDER))
        .rounded(px(tokens::RADIUS))
        .child(
            h_flex()
                .justify_between()
                .items_center()
                .child(
                    div()
                        .text_size(px(tokens::LABEL_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(rgb(DANGER))
                        .child(title),
                )
                .when_some(control, |header, control| header.child(control)),
        )
}

pub fn error_card(id: &'static str, title: &'static str, details: String) -> Div {
    error_frame(title, None).child(text_details(
        id,
        details,
        format!("Copy {title} diagnostics"),
    ))
}

pub fn validation_card(title: &'static str, message: String) -> Div {
    error_frame(title, None).child(
        div()
            .text_size(px(tokens::LABEL_PX))
            .text_color(rgb(TEXT))
            .child(message),
    )
}

#[derive(Default)]
pub struct DiagnosticDisclosure {
    details: Option<String>,
}

impl DiagnosticDisclosure {
    pub fn is_expanded(&self, details: &str) -> bool {
        self.details.as_deref() == Some(details)
    }

    pub fn toggle(&mut self, details: &str) {
        self.details = if self.is_expanded(details) {
            None
        } else {
            Some(details.to_owned())
        };
    }

    pub fn clear(&mut self) {
        self.details = None;
    }
}

pub fn diagnostic_error_card(
    id: &'static str,
    title: &'static str,
    summary: &'static str,
    details: String,
    expanded: bool,
    toggle: Button,
) -> Div {
    error_frame(title, Some(toggle))
        .child(
            div()
                .debug_selector(move || format!("{id}-summary"))
                .text_size(px(tokens::LABEL_PX))
                .text_color(rgb(TEXT))
                .child(summary),
        )
        .when(expanded, |card| {
            card.child(text_details(
                id,
                details,
                format!("Copy {title} diagnostics"),
            ))
        })
}

pub fn provider_attention_card(
    details: String,
    summary: &'static str,
    expanded: bool,
    toggle: Button,
) -> Div {
    diagnostic_error_card(
        "provider-error-details",
        "Agent needs attention",
        summary,
        details,
        expanded,
        toggle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::prelude::v1::test;

    #[test]
    fn provider_failure_is_not_masked_by_connected_daemon() {
        assert_eq!(
            conversation_status(Some("error"), true),
            ("Needs attention", DANGER)
        );
        assert_eq!(
            conversation_status(Some("disconnected"), true),
            ("Disconnected", MUTED)
        );
        assert_eq!(conversation_status(Some("ready"), true), ("Ready", SUCCESS));
        assert_eq!(
            conversation_status(Some("ready"), false),
            ("Reconnecting…", ACCENT)
        );
        assert_ne!(conversation_status(Some("interrupted"), true).1, SUCCESS);
        assert_ne!(conversation_status(Some("future-state"), true).1, SUCCESS);
    }

    #[test]
    fn enabled_text_tokens_keep_readable_contrast() {
        fn luminance(rgb: u32) -> f64 {
            let channel = |shift: u32| {
                let value = ((rgb >> shift) & 255u32) as f64 / 255.;
                if value <= 0.04045 {
                    value / 12.92
                } else {
                    ((value + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }
        for foreground in [TEXT, MUTED, DANGER, SUCCESS] {
            for background in [CANVAS, SIDEBAR, SURFACE, COMPOSER, HOVER, ELEVATED] {
                let contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
                assert!(
                    contrast >= 4.5,
                    "{foreground:x} on {background:x}: {contrast}"
                );
            }
        }
    }
}

pub fn message_heading(role: &str, kind: &str, state: &str) -> String {
    let speaker = match role {
        "user" => "You",
        "assistant" => "Agent",
        "tool" => "Tool",
        "system" => "System",
        _ => role,
    };
    let activity = match kind {
        "text" | "message" | "userMessage" | "agentMessage" => "",
        "commandExecution" => "Command",
        "fileChange" => "File changes",
        "reasoning" => "Thinking",
        "plan" => "Plan",
        _ => kind,
    };
    let mut label = if activity.is_empty() {
        speaker.to_owned()
    } else {
        format!("{speaker} · {activity}")
    };
    match state {
        "interrupted" => label.push_str(" · interrupted"),
        "failed" | "error" => label.push_str(" · failed"),
        "streaming" => label.push_str(" · in progress"),
        _ => {}
    }
    label
}

pub fn is_question_method(method: &str) -> bool {
    matches!(
        method,
        "item/tool/requestUserInput" | "claude/questions" | "opencode/questions" | "omp/questions"
    )
}
pub fn approval_decisions(method: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match method {
        "opencode/recover" => Some(&[("accept", "Resume"), ("decline", "Cancel prompt")]),
        "omp/recover" => Some(&[("accept", "Mark interrupted")]),
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "claude/toolApproval"
        | "opencode/toolApproval"
        | "omp/toolApproval" => Some(&[("accept", "Allow once"), ("decline", "Deny")]),
        _ => None,
    }
}
/// Selected labels remain separate from the editable answer so labels containing
/// commas are never parsed as multiple choices. Manual edits replace the selection.
pub fn select_answer(
    choices: &mut Vec<String>,
    current: &str,
    label: &str,
    multiple: bool,
) -> String {
    if !multiple || choices.join(", ") != current {
        choices.clear();
    }
    if let Some(index) = choices.iter().position(|value| value == label) {
        choices.remove(index);
    } else {
        choices.push(label.to_owned());
    }
    choices.join(", ")
}
#[cfg(test)]
mod form_tests {
    use super::{approval_decisions, is_question_method, select_answer};
    #[test]
    fn unknown_requests_never_receive_an_allow_button() {
        assert!(approval_decisions("futureProvider/approveEverything").is_none());
        assert!(!is_question_method("futureProvider/questions"));
        assert!(approval_decisions("claude/toolApproval").is_some());
        assert!(is_question_method("item/tool/requestUserInput"));
    }
    #[test]
    fn option_selection_preserves_labels_and_manual_edits() {
        let mut choices = Vec::new();
        let first = select_answer(&mut choices, "", "One, two", true);
        let both = select_answer(&mut choices, &first, "Three", true);
        assert_eq!(choices, ["One, two", "Three"]);
        assert_eq!(
            select_answer(&mut choices, &both, "One, two", true),
            "Three"
        );
        assert_eq!(
            select_answer(&mut choices, "Manually edited", "Four", true),
            "Four"
        );
        assert_eq!(select_answer(&mut choices, "Four", "Five", false), "Five");
    }
}

/// Native specimen for development/visual verification. Kept outside production
/// navigation; input and motion state are scoped to this window.
pub fn showcase(window: &mut Window, cx: &mut App) -> AnyElement {
    use gpui_kit::assets::IconName as Glyph;
    use gpui_kit::component::input::{Input, InputState};
    let field = window.use_keyed_state("ade-specimen-field", cx, |window, cx| {
        InputState::new(window, cx).placeholder("Name your workspace")
    });
    let visible = window.use_keyed_state("ade-specimen-details", cx, |_, _| false);
    let showing = *visible.read(cx);
    let presence = motion::reveal("ade-specimen-presence", showing, window, cx);
    let toggle = visible.clone();
    use gpui_kit::component::{
        menu::{DropdownMenu, PopupMenuItem},
        tab::{Tab, TabBar},
    };
    let selected = window.use_keyed_state("ade-specimen-state", cx, |_, _| 0usize);
    let selected_index = *selected.read(cx);
    let tabs_state = selected.clone();
    let menu_state = selected.clone();
    let scenarios = card().child(panel_title("Session states"))
        .child(TabBar::new("specimen-states").selected_index(selected_index)
            .child(Tab::new().label("Ready"))
            .child(Tab::new().label("Working"))
            .child(Tab::new().label("Disconnected"))
            .child(Tab::new().label("Failed"))
            .on_click(move |index, window, cx| {
                tabs_state.update(cx, |value, cx| { *value = *index; cx.notify(); });
                window.refresh();
            }))
        .child(conversation_indicator(Some(["ready", "running", "disconnected", "error"][selected_index]), true))
        .when(selected_index == 3, |card| card.child(error_card("specimen-error", "Agent needs attention", "The provider stopped before replying. Your draft is preserved. Retry connection before sending again.".into())))
        .child(composer_frame()
            .child(description(if selected_index == 1 { "You can prepare the next prompt while the Agent works." } else { "Describe what you want to build…" }))
            .child(h_flex().gap_2().child(button("specimen-attach").icon(Glyph::Plus).tooltip("Attach files").accessibility_label("Attach files"))
                .child(div().flex_1())
                .child(primary_button("specimen-send", if selected_index == 1 { "Queue prompt" } else { "Send" }).disabled(selected_index >= 2))))
        .child(h_flex().flex_wrap().gap_2()
            .child(button("specimen-menu").secondary().outline().label("State menu")
                .dropdown_menu(move |menu, _, _| {
                    let ready = menu_state.clone();
                    let failed = menu_state.clone();
                    menu.item(PopupMenuItem::new("Ready").on_click(move |_, window, cx| { ready.update(cx, |v,cx| {*v=0;cx.notify();});window.refresh(); }))
                        .item(PopupMenuItem::new("Failed").on_click(move |_, window, cx| { failed.update(cx, |v,cx| {*v=3;cx.notify();});window.refresh(); }))
                }))
            .child(button("specimen-dialog").secondary().outline().label("Preview confirmation")
                .on_click(|_, window, cx| window.open_dialog(cx, |dialog, _, _| dialog
                    .title("Discard this preview draft?")
                    .content(|content, _, _| content.child("This is a component preview. No workspace data will change."))
                    .on_ok(|_,_,_| true).on_cancel(|_,_,_| true)))));
    let controls = card()
        .child(panel_title("Controls"))
        .child(description(
            "One clear primary action. Quiet controls for everything around it.",
        ))
        .child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(primary_button("specimen-primary", "Create workspace"))
                .child(
                    button("specimen-secondary")
                        .secondary()
                        .outline()
                        .label("Browse"),
                )
                .child(button("specimen-quiet").label("Cancel"))
                .child(
                    button("specimen-disabled")
                        .label("Unavailable")
                        .disabled(true),
                )
                .child(icon_button("specimen-icon", Glyph::Plus, "Add workspace")),
        )
        .child(divider())
        .child(field_label("Workspace name"))
        .child(Input::new(&field).aria_label("Specimen workspace name"))
        .child(description(
            "A short, recognizable name. You can change it later.",
        ))
        .child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(chip("Codex"))
                .child(chip("Local"))
                .child(shortcut("⌘ K"))
                .child(status("Connected", true)),
        );
    let navigation = card()
        .child(panel_title("Navigation"))
        .child(nav_row(
            "specimen-nav-selected",
            Glyph::Folder,
            "lux-ade workspace",
            true,
        ))
        .child(nav_row(
            "specimen-nav-idle",
            Glyph::MessageSquare,
            "Explore an idea",
            false,
        ))
        .child(nav_row(
            "specimen-nav-terminal",
            Glyph::Terminal,
            "Terminal",
            false,
        ))
        .child(panel_footer().child(description("Selection stays distinct from hover.")));
    let mut disclosure = card()
        .child(
            h_flex()
                .gap_3()
                .child(panel_title("Purposeful motion"))
                .child(div().flex_1())
                .child(
                    button("specimen-disclosure")
                        .label(if showing {
                            "Hide details"
                        } else {
                            "Show details"
                        })
                        .on_click(move |_, window, cx| {
                            toggle.update(cx, |value, cx| {
                                *value = !*value;
                                cx.notify();
                            });
                            window.refresh();
                        }),
                ),
        )
        .child(description(if cx.reduce_motion() {
            "Reduce Motion is enabled. Details appear immediately."
        } else {
            "A short reveal explains where details belong. Motion settles completely."
        }));
    if presence.should_render() {
        disclosure = disclosure.child(
            inset_card()
                .opacity(presence.progress)
                .child(field_label("Workspace details"))
                .child(description(
                    "Local workspace · Rust · 3 connected providers",
                )),
        );
    }
    v_flex()
        .size_full()
        .bg(rgb(CANVAS))
        .text_color(rgb(TEXT))
        .child(pane_header(Glyph::Bot, "lux-ade · Component studio").child(chip("Native GPUI")))
        .child(
            v_flex()
                .id("ade-specimen-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p_6()
                .gap_5()
                .child(
                    v_flex()
                        .gap_2()
                        .child(section("The workspace, considered"))
                        .child(
                            div()
                                .text_3xl()
                                .font_weight(FontWeight::MEDIUM)
                                .child("Space to do your best work."),
                        )
                        .child(description(
                            "A neutral chat canvas, familiar sidebar, and clear action states.",
                        )),
                )
                .child(controls.flex_shrink_0())
                .child(navigation.flex_shrink_0())
                .child(scenarios.flex_shrink_0())
                .child(disclosure.flex_shrink_0())
                .child(
                    card()
                        .flex_shrink_0()
                        .child(pane_title(Glyph::Terminal, "Code & commands"))
                        .child(
                            div()
                                .font_family(cx.theme().mono_font_family.clone())
                                .text_sm()
                                .text_color(rgb(MUTED))
                                .child("cargo test --locked\nAll checks passed."),
                        ),
                )
                .child(card().flex_shrink_0().child(empty_state(
                    Glyph::MessageSquare,
                    "Begin with an idea",
                    "Describe what you want to build. Your workspace is ready when you are.",
                ))),
        )
        .into_any_element()
}

struct Showcase;
impl Render for Showcase {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        showcase(window, cx)
    }
}

/// Standalone development gallery; call after GPUI initialization and install.
/// It owns no daemon connection and closes the process with its final window.
pub fn launch_showcase(cx: &mut App) {
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
    gpui_kit::open_window(
        WindowOptions {
            focus: true,
            show: true,
            window_bounds: Some(WindowBounds::centered(size(px(1060.), px(820.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Component studio");
            cx.new(|cx| {
                cx.observe_window_activation(window, |_, window, cx| {
                    refresh_motion_preference(window, cx)
                })
                .detach();
                Showcase
            })
        },
    )
    .expect("component studio window");
}

#[cfg(test)]
mod motion_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;

    struct RevealProbe {
        visible: bool,
        progress: f32,
        rendered: bool,
    }
    impl Render for RevealProbe {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let sample = motion::reveal("test-reveal", self.visible, window, cx);
            self.progress = sample.progress;
            self.rendered = sample.should_render();
            div()
        }
    }
    #[gpui::test]
    fn reduce_motion_finishes_an_interrupted_reveal(cx: &mut TestAppContext) {
        let (probe, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            cx.set_reduce_motion(false);
            RevealProbe {
                visible: false,
                progress: 0.,
                rendered: false,
            }
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.progress), 0.);
        probe.update(cx, |probe, cx| {
            probe.visible = true;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(probe.read_with(cx, |probe, _| probe.rendered));
        cx.update(|window, cx| {
            cx.set_reduce_motion(true);
            window.refresh();
            window.draw(cx).clear(cx);
        });
        assert_eq!(probe.read_with(cx, |probe, _| probe.progress), 1.);
        probe.update(cx, |probe, cx| {
            probe.visible = false;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.progress), 0.);
        assert!(!probe.read_with(cx, |probe, _| probe.rendered));
    }
}

#[cfg(test)]
mod row_action_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    struct Actions {
        activated: usize,
    }
    impl Render for Actions {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            v_flex()
                .child(
                    row_action("enabled-row", "Start", "web server")
                        .debug_selector(|| "enabled-row".into())
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.activated += 1;
                            cx.notify();
                        })),
                )
                .child(
                    row_action("disabled-row", "Start", "database")
                        .disabled(true)
                        .debug_selector(|| "disabled-row".into())
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.activated += 100;
                            cx.notify();
                        })),
                )
        }
    }
    #[gpui::test]
    fn contextual_actions_keep_disabled_behavior(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            Actions { activated: 0 }
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        for target in ["disabled-row", "enabled-row"] {
            let bounds = cx.debug_bounds(target).unwrap();
            cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
            cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
            cx.run_until_parked();
        }
        view.read_with(cx, |view, _| assert_eq!(view.activated, 1));
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    #[test]
    fn new_failure_starts_with_diagnostics_hidden() {
        let mut disclosure = DiagnosticDisclosure::default();
        assert!(!disclosure.is_expanded("first failure"));
        disclosure.toggle("first failure");
        assert!(disclosure.is_expanded("first failure"));
        assert!(!disclosure.is_expanded("second failure"));
        disclosure.toggle("second failure");
        assert!(disclosure.is_expanded("second failure"));
        assert!(!disclosure.is_expanded("first failure"));
        disclosure.clear();
        assert!(!disclosure.is_expanded("second failure"));
        disclosure.toggle("second failure");
        assert!(disclosure.is_expanded("second failure"));
        disclosure.clear();
        assert!(!disclosure.is_expanded("second failure"));
    }
    struct Diagnostics {
        text: String,
    }
    impl Render for Diagnostics {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            error_card("diagnostic-test", "Request failed", self.text.clone())
        }
    }
    struct ProviderAttention {
        expanded: bool,
        details: String,
    }
    struct ActionFailure {
        expanded: bool,
        details: String,
    }
    impl Render for ActionFailure {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            diagnostic_error_card(
                "action-failure-test",
                "Action could not complete",
                "lux-ade could not finish the action. Check the current state before retrying.",
                self.details.clone(),
                self.expanded,
                button("action-diagnostics-toggle")
                    .debug_selector(|| "action-diagnostics-toggle".into())
                    .label(if self.expanded {
                        "Hide diagnostics"
                    } else {
                        "Show diagnostics"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.expanded = !this.expanded;
                        cx.notify();
                    })),
            )
        }
    }
    impl Render for ProviderAttention {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            provider_attention_card(
                self.details.clone(),
                "The Agent stopped. Your draft is preserved.",
                self.expanded,
                button("provider-diagnostics-toggle")
                    .debug_selector(|| "provider-diagnostics-toggle".into())
                    .label(if self.expanded {
                        "Hide diagnostics"
                    } else {
                        "Show diagnostics"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.expanded = !this.expanded;
                        cx.notify();
                    })),
            )
        }
    }
    #[test]
    fn diagnostic_preview_is_bounded_utf8_and_literal() {
        let details = format!("```html\n<script>test</script>\n```\n{}", "é".repeat(9000));
        let (preview, truncated) = diagnostic_preview(&details);
        assert!(truncated);
        assert!(preview.starts_with("````text\n"));
        assert!(preview.len() < DIAGNOSTIC_PREVIEW_BYTES + 32);
        assert!(preview.contains("<script>test</script>"));
    }
    #[gpui::test]
    fn copy_diagnostics_keeps_complete_unmodified_payload(cx: &mut TestAppContext) {
        let text = format!("error\r\n```\n{}\nEND\n", "héllo ".repeat(3000));
        let expected = text.clone();
        let (_, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            Diagnostics { text }
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx
            .debug_bounds("diagnostic-test-copy")
            .expect("copy control remains visible");
        cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(expected)
        );
    }
    #[gpui::test]
    fn provider_error_hides_raw_details_until_requested_and_copies_them(cx: &mut TestAppContext) {
        let details = "open: {\"message\":\"Oh My Pi output closed\"}".to_owned();
        let expected = details.clone();
        let (_, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            ProviderAttention {
                expanded: false,
                details,
            }
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("provider-error-details-summary").is_some());
        assert!(cx.debug_bounds("provider-error-details-copy").is_none());
        let toggle = cx.debug_bounds("provider-diagnostics-toggle").unwrap();
        cx.simulate_mouse_down(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let copy = cx.debug_bounds("provider-error-details-copy").unwrap();
        cx.simulate_mouse_down(copy.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(copy.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(expected)
        );
    }
    #[gpui::test]
    fn action_failure_hides_raw_details_until_requested_and_copies_them(cx: &mut TestAppContext) {
        let details = "{\"code\":\"daemon_closed\",\"private_path\":\"/tmp/example\"}".to_owned();
        let expected = details.clone();
        let (_, cx) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            ActionFailure {
                expanded: false,
                details,
            }
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("action-failure-test-summary").is_some());
        assert!(cx.debug_bounds("action-failure-test-copy").is_none());
        let toggle = cx.debug_bounds("action-diagnostics-toggle").unwrap();
        cx.simulate_mouse_down(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(toggle.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let copy = cx.debug_bounds("action-failure-test-copy").unwrap();
        cx.simulate_mouse_down(copy.center(), MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(copy.center(), MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(expected)
        );
    }
}

/// Input overload is independent of operation failures and lasts until dismissed.
pub(crate) fn command_overflow_notice(shared: crate::client_state::Shared) -> impl IntoElement {
    h_flex().px_4().py_2().gap_3().items_center()
        .child(div().flex_1().text_sm().text_color(rgb(DANGER)).child(
            "Some menu or keyboard commands were not accepted because lux-ade was busy. Check the current state before trying again."
        ))
        .child(button("dismiss-command-overflow").debug_selector(|| "dismiss-command-overflow".into()).label("Dismiss").on_click(move |_, _, _| {
            shared.data.lock().unwrap().command_overflow = false;
            shared.notify();
        }))
}

#[cfg(test)]
mod command_notice_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    struct Notice(crate::client_state::Shared);
    impl Render for Notice {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            command_overflow_notice(self.0.clone())
        }
    }
    #[gpui::test]
    fn dismissing_input_overflow_preserves_operation_failures(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(crate::client_state::ClientState::default());
        {
            let mut state = shared.data.lock().unwrap();
            state.command_overflow = true;
            state.error = "Action failed".into();
            state.save_error = "Draft unsaved".into();
        }
        let before = shared.data.lock().unwrap().ui_revision(None);
        let (_, visual) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            install(cx);
            Notice(shared.clone())
        });
        visual.run_until_parked();
        visual.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = visual.debug_bounds("dismiss-command-overflow").unwrap();
        visual.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::none());
        visual.simulate_mouse_up(bounds.center(), MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
        let state = shared.data.lock().unwrap();
        assert!(!state.command_overflow);
        assert_eq!(state.error, "Action failed");
        assert_eq!(state.save_error, "Draft unsaved");
        assert_ne!(before, state.ui_revision(None));
    }
}
