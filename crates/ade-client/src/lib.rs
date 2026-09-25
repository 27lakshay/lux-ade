mod attachment_ui;
mod bench;
mod bootstrap;
mod browser_navigation;
mod chat_ui;
mod command_bridge;
mod command_ui;
mod commands;
mod composer_ui;
mod conversation_controller;
mod conversation_ui;
mod dock_ui;
mod draft_controller;
mod draft_ui;
mod native_panels;
mod shell_ui;
mod startup_ui;
mod tabs_ui;
mod tool_ui;
mod transcript_list;
mod ui;
mod workspace_commands;
mod workspace_sidebar;
mod workspace_ui;
use ade_core::model;
use gpui_kit::assets::IconName as Glyph;
mod protocol;
use ade_platform::terminal;
mod terminal_stream;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    component::{
        button::*,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        resizable::{ResizableState, h_resizable, resizable_panel, v_resizable},
        *,
    },
    *,
};
use gpui_wry::WebView;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::{Value, json};
use std::{rc::Rc, time::Duration};
mod client_state;
mod recovery_ui;
mod request_ui;
mod review_ui;
mod service_ui;
mod worktree_ui;
use ade_core::model::{WindowRecord, WorkspaceRecord, new_id};
use client_state::{Shared, command, socket};
use std::collections::HashMap;
/// Fit requested side panes while reserving the Conversation's minimum width.
/// Preferences are inputs only; a temporary narrow window never rewrites them.
fn fit_workspace_panes(width: f32, sidebar: Option<f32>, browser: Option<f32>) -> (f32, f32) {
    let left = sidebar.map_or(0., |value| value.clamp(180., 360.));
    let right = browser.map_or(0., |value| value.clamp(240., 600.));
    let left_min = if sidebar.is_some() { 180. } else { 0. };
    let right_min = if browser.is_some() { 240. } else { 0. };
    let budget = (width - 360.).max(left_min + right_min);
    let extra = left + right - left_min - right_min;
    let fraction = if extra > 0. {
        ((budget - left_min - right_min) / extra).clamp(0., 1.)
    } else {
        0.
    };
    (
        left_min + (left - left_min) * fraction,
        right_min + (right - right_min) * fraction,
    )
}

fn make_terminal(
    window: &mut Window,
    workspace: &WorkspaceRecord,
    terminal_id: Option<&str>,
) -> anyhow::Result<Rc<terminal::Terminal>> {
    if terminal_id.is_none() {
        return Ok(Rc::new(terminal::Terminal::detached()));
    }
    let handle = window.window_handle()?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        anyhow::bail!("macOS required")
    };
    let attach = std::env::current_exe()?.with_file_name("ade-attach");
    let mut command = format!(
        "/usr/bin/env ADE_SOCKET='{}' '{}' --input-only --workspace '{}'",
        socket().replace('\'', "'\\''"),
        attach.display().to_string().replace('\'', "'\\''"),
        workspace.id
    );
    if let Some(id) = terminal_id {
        command.push_str(&format!(" --terminal '{}'", id.replace('\'', "'\\''")));
    }
    Ok(Rc::new(unsafe {
        terminal::Terminal::new(
            appkit.ns_view.as_ptr(),
            &command,
            if std::path::Path::new(&workspace.root).is_dir() {
                &workspace.root
            } else {
                "/"
            },
        )
    }?))
}
struct Workspace {
    embedded: bool,
    shell_commands: Option<async_channel::Sender<String>>,
    record: WindowRecord,
    workspace: WorkspaceRecord,
    persist: bool,
    composer: Entity<TextareaState>,
    drafts: HashMap<String, model::Draft>,
    expanded_tools: std::collections::HashSet<String>,
    provider_diagnostics: ui::DiagnosticDisclosure,
    save_diagnostics: ui::DiagnosticDisclosure,
    action_diagnostics: ui::DiagnosticDisclosure,
    draft_load: draft_ui::LoadState,
    draft_diagnostics: ui::DiagnosticDisclosure,
    draft_generation: u64,
    draft_task: Option<Task<()>>,
    draft_resolution_task: Option<Task<()>>,
    attachment_picker: Option<Task<()>>,
    action_task: Option<Task<()>>,
    _composer_changes: Subscription,
    provider_model: Entity<InputState>,
    new_provider: String,
    new_config: ade_core::provider::Config,
    folder: Entity<InputState>,
    answers: HashMap<String, Entity<InputState>>,
    answer_choices: HashMap<String, Vec<String>>,
    answer_changes: HashMap<String, Subscription>,
    pending: bool,
    submission: Option<(String, String)>,
    _save: Option<Task<()>>,
    _bounds: Subscription,
    shared: Shared,
    browser: Option<Entity<WebView>>,
    address: Entity<InputState>,
    terminal: Rc<terminal::Terminal>,
    revision: client_state::UiRevision,
    bench_marker: u64,
    _updates: Task<()>,
    _terminal_updates: Task<()>,
    terminal_error: String,
    terminal_diagnostics: ui::DiagnosticDisclosure,
    terminal_boot: String,
    show_setup: bool,
    show_folder: bool,
    native_parent: *mut std::ffi::c_void,
    _command_bridge: Option<command_bridge::Bridge>,
    _commands: Task<()>,
    conversation_focus: FocusHandle,
    conversation_scroll: ScrollHandle,
    request_scroll: ScrollHandle,
    request_scroll_key: Option<String>,
    transcript_list: transcript_list::TranscriptList,
    history_page: Option<(String, Vec<model::Message>)>,
    history_generation: u64,
    history_request: Option<client_state::ReadRequest>,
    history_task: Option<Task<()>>,
    history_error: Option<(i64, String)>,
    history_diagnostics: ui::DiagnosticDisclosure,
    child_reader: Option<(Value, Value)>,
    child_diagnostics: ui::DiagnosticDisclosure,
    child_generation: u64,
    child_request: Option<client_state::ReadRequest>,
    child_task: Option<Task<()>>,
    child_back: Vec<Value>,
    terminal_tabs_scroll: ScrollHandle,
    browser_tabs_scroll: ScrollHandle,
    last_focus: u32,
    last_tab_browser: bool,
    layout_generation: u64,
    horizontal_panes: Entity<ResizableState>,
    vertical_panes: Entity<ResizableState>,
    horizontal_fit: Option<(i32, bool, bool, u64)>,
    vertical_fit: Option<(i32, bool, u64)>,
    browser_views: HashMap<String, tabs_ui::BrowserView>,
}
impl Workspace {
    fn watch_terminal(
        workspace_id: String,
        terminal_id: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            if terminal_id.is_none() {
                return;
            }
            loop {
                let stream = terminal_stream::Stream::connect_terminal(
                    socket(),
                    Some(&workspace_id),
                    terminal_id.as_deref(),
                );
                while let Ok(event) = stream.events.recv().await {
                    let result = this.update(cx, |this, cx| {
                        if this.record.tabs.active_terminal != terminal_id {
                            return Ok(());
                        }
                        let started = std::time::Instant::now();
                        let result = match event {
                            terminal_stream::Event::Restore(bytes) => {
                                bench::sample("snapshot_bytes", bytes.len() as u64);
                                let result = this.terminal.restore(&bytes);
                                bench::elapsed("restore_us", started);
                                bench::restored();
                                result
                            }
                            terminal_stream::Event::Output(bytes) => {
                                let result = this.terminal.feed(&bytes);
                                bench::elapsed("feed_us", started);
                                bench::output(&bytes);
                                result
                            }
                            terminal_stream::Event::Resize(cols, rows) => {
                                let result = this.terminal.resize_grid(cols, rows);
                                bench::elapsed("resize_us", started);
                                result
                            }
                            terminal_stream::Event::Failed(error) => Err(anyhow::anyhow!(error)),
                        };
                        let error = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .unwrap_or_default();
                        if !error.is_empty() {
                            bench::sample("terminal_errors", 1);
                        }
                        if error != this.terminal_error {
                            this.terminal_error = error;
                            cx.notify();
                        }
                        result
                    });
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => break,
                        Err(_) => return,
                    }
                }
                drop(stream);
                cx.background_executor().timer(Duration::from_secs(1)).await;
            }
        })
    }
    fn new(
        mut record: WindowRecord,
        workspace: WorkspaceRecord,
        persist: bool,
        embedded: bool,
        shared: Shared,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if embedded {
            record.tabs = model::Tabs::default();
            record.panes.terminal_visible = false;
            record.panes.browser_visible = false;
        } else if !record.tabs.initialized {
            record.tabs.initialized = true;
            record.tabs.terminals.push(model::TerminalTab {
                id: workspace.terminal_id.clone(),
                workspace_id: workspace.id.clone(),
                title: "Terminal 1".into(),
            });
            record.tabs.active_terminal = Some(workspace.terminal_id.clone());
        }
        let browser: Option<Entity<WebView>> = None;
        let terminal = if embedded {
            Rc::new(terminal::Terminal::detached())
        } else {
            make_terminal(window, &workspace, record.tabs.active_terminal.as_deref())
                .expect("native Ghostty terminal")
        };
        let address = cx.new(|cx| InputState::new(window, cx).placeholder("https://example.com"));
        let composer =
            cx.new(|cx| TextareaState::new(window, cx).placeholder("Message your Agent…"));
        let composer_changes = cx.subscribe(&composer, |this, composer, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) && !this.draft_load.blocked() {
                if let Some(id) = this.record.conversation_id.clone() {
                    this.save_draft_text(&id, composer.read(cx).value().to_string());
                }
                cx.notify();
            }
        });
        let provider_model =
            cx.new(|cx| InputState::new(window, cx).placeholder("Model (provider default)"));
        let folder = cx.new(|cx| InputState::new(window, cx).placeholder("/path/to/project"));
        let bounds = cx.observe_window_bounds(window, |this, window, cx| {
            let b = window.bounds();
            let content = window.viewport_size();
            this.record.x = b.origin.x.as_f32();
            this.record.y = b.origin.y.as_f32();
            this.record.width = content.width.as_f32().max(1000.);
            this.record.height = content.height.as_f32().max(700.);
            this.save(cx);
        });
        let close_shared = shared.clone();
        let close_id = record.id.clone();
        let weak = cx.weak_entity();
        if !embedded {
            window.on_window_should_close(cx, move |_, cx| {
                if persist {
                    let _ = weak.update(cx, |this, cx| {
                        this._save = None;
                        command(
                            this.shared.clone(),
                            json!({"op":"window.save","window":this.record}),
                        );
                        cx.notify();
                    });
                    command(
                        close_shared.clone(),
                        json!({"op":"window.close","window_id":close_id}),
                    );
                }
                true
            });
        }
        if let Some(id) = &record.conversation_id {
            command(
                shared.clone(),
                json!({"op":"conversation.get","conversation_id":id}),
            );
        }
        if persist {
            command(shared.clone(), json!({"op":"window.save","window":record}));
        }
        let receiver = shared.subscribe();
        let updates = cx.spawn(async move |this, cx| {
            while receiver.recv().await.is_ok() {
                if this
                    .update(cx, |this, cx| {
                        let revision = this
                            .shared
                            .data
                            .lock()
                            .unwrap()
                            .ui_revision(this.record.conversation_id.as_deref());
                        if revision != this.revision {
                            this.revision = revision;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let native_parent =
            match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
                Ok(RawWindowHandle::AppKit(native)) => native.ns_view.as_ptr(),
                _ if embedded => std::ptr::null_mut(),
                _ => panic!("native window unavailable"),
            };
        let (command_bridge, command_rx) = if embedded {
            let (_tx, rx) = command_bridge::event_channel();
            (None, rx)
        } else {
            let (bridge, rx) = command_bridge::Bridge::new(native_parent);
            (Some(bridge), rx)
        };
        let commands = cx.spawn(async move |this, cx| {
            while let Ok(event) = command_rx.recv().await {
                let index = match event {
                    command_bridge::Event::Command(index) => index,
                    command_bridge::Event::Overflow => {
                        let _ = this.update(cx, |this, cx| {
                            this.shared.data.lock().unwrap().command_overflow = true;
                            this.shared.notify();
                            cx.notify();
                        });
                        continue;
                    }
                };
                let Some(command) = crate::commands::COMMANDS.get(index) else {
                    continue;
                };
                if this
                    .update_in(cx, |this, window, cx| {
                        this.run_command(command.id, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let terminal_boot = shared.data.lock().unwrap().boot.clone();
        if !embedded {
            cx.defer_in(window, |this, window, cx| {
                this.focus_pane(this.last_focus, window, cx);
            });
        }
        let mut view = Self {
            embedded,
            shell_commands: None,
            terminal_boot,
            native_parent,
            _command_bridge: command_bridge,
            _commands: commands,
            conversation_focus: cx.focus_handle(),
            conversation_scroll: ScrollHandle::new(),
            request_scroll: ScrollHandle::new(),
            request_scroll_key: None,
            transcript_list: transcript_list::TranscriptList::new(),
            history_page: None,
            child_reader: None,
            child_diagnostics: Default::default(),
            child_generation: 0,
            child_request: None,
            child_task: None,
            child_back: Vec::new(),
            history_generation: 0,
            history_request: None,
            history_task: None,
            history_error: None,
            history_diagnostics: Default::default(),
            terminal_tabs_scroll: ScrollHandle::new(),
            browser_tabs_scroll: ScrollHandle::new(),
            last_focus: record.focused_pane,
            last_tab_browser: record.focused_pane == 4,
            layout_generation: 0,
            horizontal_panes: cx.new(|_| ResizableState::default()),
            vertical_panes: cx.new(|_| ResizableState::default()),
            horizontal_fit: None,
            vertical_fit: None,
            browser_views: HashMap::new(),
            show_setup: false,
            show_folder: false,
            _terminal_updates: Self::watch_terminal(
                workspace.id.clone(),
                record.tabs.active_terminal.clone(),
                cx,
            ),
            record,
            workspace,
            persist,
            composer,
            drafts: HashMap::new(),
            expanded_tools: Default::default(),
            provider_diagnostics: Default::default(),
            save_diagnostics: Default::default(),
            action_diagnostics: Default::default(),
            draft_load: draft_ui::LoadState::Loading,
            draft_diagnostics: Default::default(),
            draft_generation: 0,
            draft_task: None,
            draft_resolution_task: None,
            attachment_picker: None,
            action_task: None,
            _composer_changes: composer_changes,
            provider_model,
            new_provider: "codex".into(),
            new_config: ade_core::provider::Config::default(),
            folder,
            answers: HashMap::new(),
            answer_choices: HashMap::new(),
            answer_changes: HashMap::new(),
            pending: false,
            submission: None,
            _save: None,
            _bounds: bounds,
            shared,
            browser,
            address,
            terminal,
            revision: client_state::UiRevision::default(),
            bench_marker: 0,
            _updates: updates,

            terminal_error: String::new(),
            terminal_diagnostics: Default::default(),
        };
        // Loading is part of initialization, not deferred focus/render work.
        // Its response is bound to this actual window, including before first paint.
        view.load_draft(window, cx);
        view
    }
}
impl Workspace {
    fn save(&mut self, cx: &mut Context<Self>) {
        self.record.focused_pane = self.last_focus;
        if !self.persist {
            return;
        }
        let shared = self.shared.clone();
        let record = self.record.clone();
        self._save = Some(cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            command(shared, json!({"op":"window.save","window":record}));
        }));
    }
    fn select_workspace(
        &mut self,
        w: WorkspaceRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_child();
        self.reset_history();
        if !self.draft_load.blocked()
            && let Some(previous) = self.record.conversation_id.clone()
        {
            self.save_draft_text(&previous, self.composer.read(cx).value().to_string());
        }
        if self.embedded {
            self.workspace = w;
            self.record.workspace_id = self.workspace.id.clone();
            self.record.conversation_id = None;
            self.load_draft(window, cx);
            self.submission = None;
            self.answers.clear();
            self.terminal_error.clear();
            self.save(cx);
            cx.notify();
            return;
        }
        let terminal_id = self
            .record
            .tabs
            .terminals
            .iter()
            .find(|t| t.workspace_id == w.id)
            .map(|t| t.id.clone())
            .unwrap_or_else(|| w.terminal_id.clone());
        match make_terminal(window, &w, Some(&terminal_id)) {
            Ok(terminal) => {
                self.terminal = terminal;
                self._terminal_updates =
                    Self::watch_terminal(w.id.clone(), Some(terminal_id.clone()), cx);
                if !self
                    .record
                    .tabs
                    .terminals
                    .iter()
                    .any(|t| t.workspace_id == w.id)
                {
                    self.record
                        .tabs
                        .closed_terminals
                        .retain(|tab| tab.id != w.terminal_id);
                    self.record.tabs.terminals.push(model::TerminalTab {
                        id: w.terminal_id.clone(),
                        workspace_id: w.id.clone(),
                        title: "Terminal 1".into(),
                    });
                }
                self.record.tabs.active_terminal = Some(terminal_id);
                self.workspace = w;
                self.record.workspace_id = self.workspace.id.clone();
                self.record.conversation_id = None;
                self.load_draft(window, cx);
                self.submission = None;
                self.answers.clear();
                self.terminal_error.clear();
                self.save(cx);
                cx.notify();
            }
            Err(error) => {
                self.shared.data.lock().unwrap().error = error.to_string();
                cx.notify();
            }
        }
    }
}
struct Overlay {
    _link: terminal::NativeChildWindow,
    input: Entity<InputState>,
}
impl Render for Overlay {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        v_flex().size_full().p_6().gap_4().bg(rgb(ui::CANVAS)).text_color(rgb(ui::TEXT))
            .child("Native overlay")
            .child("The browser and terminal stay visible and running underneath this GPUI child panel.")
            .child(Input::new(&self.input))
            .child(ui::button("close-panel").label("Close overlay").on_click(|_, window, _| window.remove_window()))
    }
}
fn open_overlay(parent: &mut Window, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    let handle = parent.window_handle()?;
    let RawWindowHandle::AppKit(parent) = handle.as_raw() else {
        anyhow::bail!("macOS required")
    };
    let (handle, _) = gpui_kit::open_window(
        WindowOptions {
            kind: WindowKind::PopUp,
            focus: true,
            show: true,
            window_bounds: Some(WindowBounds::centered(size(px(920.), px(270.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Native overlay");
            let child_handle = window.window_handle().expect("native popup");
            let RawWindowHandle::AppKit(child) = child_handle.as_raw() else {
                unreachable!()
            };
            let link = unsafe {
                terminal::NativeChildWindow::attach(parent.ns_view.as_ptr(), child.ns_view.as_ptr())
            }
            .expect("attach native child panel");
            let input =
                cx.new(|cx| InputState::new(window, cx).placeholder("Test focus in the overlay"));
            cx.new(|_| Overlay { _link: link, input })
        },
    )?;
    Ok(handle)
}
impl Focusable for Workspace {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.composer.read(cx).focus_handle(cx)
    }
}
fn create_chat_panel(
    shared: Shared,
    workspace: WorkspaceRecord,
    record: WindowRecord,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Workspace> {
    let create = record.conversation_id.is_none();
    let panel = cx.new(|cx| Workspace::new(record, workspace, false, true, shared, window, cx));
    if create {
        panel.update(cx, |_, cx| {
            cx.defer_in(window, |this, window, cx| {
                this.run_command("conversation.new", window, cx)
            })
        });
    }
    panel
}
/// Run the native lux-ade desktop client.
pub fn run() {
    bootstrap::run();
}

#[cfg(test)]
mod pane_fit_tests {
    use super::fit_workspace_panes;
    #[test]
    fn normal_preferences_remain_exact() {
        assert_eq!(
            fit_workspace_panes(1220., Some(224.), Some(300.)),
            (224., 300.)
        );
    }
    #[test]
    fn extreme_preferences_fit_and_restore_without_mutation() {
        let requested = (Some(360.), Some(600.));
        let (left, right) = fit_workspace_panes(1000., requested.0, requested.1);
        assert!(left >= 180. && right >= 240.);
        assert!((left + right - 640.).abs() < 0.01);
        assert_eq!(
            fit_workspace_panes(1600., requested.0, requested.1),
            (360., 600.)
        );
    }
    #[test]
    fn hidden_panes_release_their_budget() {
        assert_eq!(fit_workspace_panes(1000., None, Some(600.)), (0., 600.));
        assert_eq!(fit_workspace_panes(1000., Some(360.), None), (360., 0.));
        assert_eq!(fit_workspace_panes(1000., None, None), (0., 0.));
        assert_eq!(
            fit_workspace_panes(780., Some(360.), Some(600.)),
            (180., 240.)
        );
    }
}
