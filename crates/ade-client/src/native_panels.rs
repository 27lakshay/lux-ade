//! Independent native views. Their lifetime owns attachments, never shell sessions.
use super::*;
#[cfg(target_os = "macos")]
use wry::WebViewExtMacOS;

pub struct BrowserPanel {
    view: Option<Entity<WebView>>,
    address: Entity<InputState>,
    focus: FocusHandle,
    active: bool,
    error: String,
    diagnostics: ui::DiagnosticDisclosure,
    url: String,
    _input: Subscription,
    _navigation: Task<()>,
}
impl BrowserPanel {
    fn create_view(
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Option<Entity<WebView>>, String, Task<()>) {
        let (tx, rx) = crate::browser_navigation::channel();
        let native = (|| -> anyhow::Result<wry::WebView> {
            let handle = window.window_handle()?;
            Ok(wry::WebViewBuilder::new()
                .with_html(include_str!("../../../assets/browser-start.html"))
                .with_accept_first_mouse(true)
                .with_navigation_handler(move |url| {
                    if url != "about:blank" {
                        tx.publish(url);
                    }
                    true
                })
                .build_as_child(&handle)?)
        })();
        let (view, error) = match native {
            Ok(native) => (
                Some(cx.new(|cx| WebView::new(native, window, cx))),
                String::new(),
            ),
            Err(error) => (None, error.to_string()),
        };
        let navigation = cx.spawn(async move |this, cx| {
            while let Ok(url) = rx.recv().await {
                if this
                    .update_in(cx, |this: &mut Self, window, cx| {
                        this.url = url.clone();
                        this.address
                            .update(cx, |input, cx| input.set_value(url, window, cx));
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        (view, error, navigation)
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let address = cx.new(|cx| InputState::new(window, cx).placeholder("Enter an address"));
        let input = cx.subscribe_in(&address, window, |this: &mut Self, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.navigate(cx);
            }
        });
        let (view, error, navigation) = Self::create_view(window, cx);
        Self {
            view,
            address,
            focus: cx.focus_handle(),
            active: true,
            error,
            diagnostics: Default::default(),
            url: String::new(),
            _input: input,
            _navigation: navigation,
        }
    }

    fn retry_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.view.is_some() {
            return;
        }
        let (view, error, navigation) = Self::create_view(window, cx);
        self.view = view;
        self.error = error;
        self._navigation = navigation;
        cx.notify();
    }
    pub fn is_focused(&self, cx: &App) -> bool {
        if !self.active {
            return false;
        }
        #[cfg(target_os = "macos")]
        if let Some(view) = &self.view {
            let native = view.read(cx).raw().webview();
            return unsafe {
                terminal::native_view_is_focused(std::ptr::from_ref(&*native).cast())
            };
        }
        false
    }
    pub fn focus_address(&self, window: &mut Window, cx: &mut App) {
        if let Ok(handle) = window.window_handle()
            && let RawWindowHandle::AppKit(handle) = handle.as_raw()
        {
            unsafe {
                crate::command_bridge::ade_focus_parent(handle.ns_view.as_ptr());
            }
        }
        self.address.read(cx).focus_handle(cx).focus(window, cx);
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn load_url(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.address
            .update(cx, |input, cx| input.set_value(url, window, cx));
        self.navigate(cx);
    }
    fn navigate(&mut self, cx: &mut Context<Self>) {
        let raw = self.address.read(cx).value().trim().to_owned();
        if raw.is_empty() {
            return;
        }
        let url = if raw.contains("://") || raw.starts_with("about:") {
            raw
        } else if raw.starts_with("localhost")
            || raw.starts_with("127.0.0.1")
            || raw.starts_with("[::1]")
        {
            format!("http://{raw}")
        } else {
            format!("https://{raw}")
        };
        if let Some(view) = &self.view {
            let result = view.update(cx, |view, _| view.raw().load_url(&url));
            self.error = result.err().map(|e| e.to_string()).unwrap_or_default();
            if self.error.is_empty() {
                self.url = url;
            }
            cx.notify();
        }
    }
    fn script(&mut self, script: &str, cx: &mut Context<Self>) {
        if let Some(view) = &self.view {
            self.error = view
                .update(cx, |view, _| view.raw().evaluate_script(script))
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            cx.notify();
        }
    }
    pub fn set_active(&mut self, active: bool, _window: &mut Window, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if let Some(view) = &self.view {
            view.update(cx, |view, _| if active { view.show() } else { view.hide() });
        }
        cx.notify();
    }
}
impl Focusable for BrowserPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Render for BrowserPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        #[cfg(target_os = "macos")]
        if let Some(view) = &self.view
            && let Ok(handle) = window.window_handle()
            && let RawWindowHandle::AppKit(parent) = handle.as_raw()
        {
            let native = view.read(cx).raw().webview();
            // The render window and retained Wry view keep both pointers alive.
            unsafe {
                terminal::register_accessible_child(
                    parent.ns_view.as_ptr(),
                    std::ptr::from_ref(&*native).cast(),
                );
            }
        }
        v_flex()
            .size_full()
            .min_h_0()
            .track_focus(&self.focus)
            .bg(rgb(ui::CANVAS))
            .child(
                h_flex()
                    .flex_shrink_0()
                    .p_2()
                    .gap_1()
                    .border_b_1()
                    .border_color(rgb(ui::BORDER))
                    .child(
                        ui::icon_button("back", Glyph::ArrowLeft, "Back")
                            .disabled(self.view.is_none())
                            .on_click(
                                cx.listener(|this, _, _, cx| this.script("history.back()", cx)),
                            ),
                    )
                    .child(
                        ui::icon_button("forward", Glyph::ArrowRight, "Forward")
                            .disabled(self.view.is_none())
                            .on_click(
                                cx.listener(|this, _, _, cx| this.script("history.forward()", cx)),
                            ),
                    )
                    .child(
                        ui::icon_button("reload", Glyph::RotateCw, "Reload")
                            .disabled(self.view.is_none())
                            .on_click(
                                cx.listener(|this, _, _, cx| this.script("location.reload()", cx)),
                            ),
                    )
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.address)
                                .small()
                                .aria_label("Browser address"),
                        ),
                    )
                    .child(
                        ui::button("go")
                            .label("Go")
                            .disabled(self.view.is_none())
                            .on_click(cx.listener(|this, _, _, cx| this.navigate(cx))),
                    ),
            )
            .when(!self.error.is_empty(), |el| {
                let details = self.error.clone();
                let expanded = self.diagnostics.is_expanded(&details);
                el.child(ui::diagnostic_error_card(
                    "browser-error",
                    "Browser needs attention",
                    if self.view.is_some() {
                        "The browser action could not finish. Check the address and try again."
                    } else {
                        "lux-ade could not open the embedded browser. Retry opening the view."
                    },
                    details.clone(),
                    expanded,
                    ui::button("browser-diagnostics-toggle")
                        .label(if expanded {
                            "Hide diagnostics"
                        } else {
                            "Show diagnostics"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ))
                .when(self.view.is_none(), |el| {
                    el.child(
                        ui::button("retry-browser-view")
                            .label("Retry opening browser")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.retry_create(window, cx)),
                            ),
                    )
                })
            })
            .when(self.active, |el| {
                el.when_some(self.view.clone(), |el, view| {
                    el.child(div().flex_1().min_h_0().child(view))
                })
            })
    }
}

pub struct TerminalPanel {
    workspace: WorkspaceRecord,
    terminal_id: Option<String>,
    surface: Option<Rc<terminal::Terminal>>,
    focus: FocusHandle,
    active: bool,
    starting: bool,
    focus_requested: bool,
    error: String,
    diagnostics: ui::DiagnosticDisclosure,
    _stream: Option<Task<()>>,
    _creation: Option<Task<()>>,
}
impl TerminalPanel {
    /// Creating this entity is the explicit terminal-open action. Blank panes must not call it.
    pub fn new(
        workspace: WorkspaceRecord,
        terminal_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut panel = Self {
            workspace,
            terminal_id,
            surface: None,
            focus: cx.focus_handle(),
            active: true,
            starting: false,
            focus_requested: false,
            error: String::new(),
            diagnostics: Default::default(),
            _stream: None,
            _creation: None,
        };
        panel.start(window, cx);
        panel
    }
    pub fn is_focused(&self, _cx: &App) -> bool {
        self.active
            && self
                .surface
                .as_ref()
                .is_some_and(|surface| surface.is_focused())
    }
    pub fn terminal_id(&self) -> Option<&str> {
        self.terminal_id.as_deref()
    }

    pub fn set_active(&mut self, active: bool, _window: &mut Window, cx: &mut Context<Self>) {
        self.active = active;
        if let Some(surface) = &self.surface {
            surface.set_visible(active && !self.starting && self.error.is_empty());
        }
        cx.notify();
    }
    /// Queue focus only for an explicit tab/launcher/keyboard action.
    pub fn request_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(handle) = window.window_handle()
            && let RawWindowHandle::AppKit(handle) = handle.as_raw()
        {
            unsafe {
                crate::command_bridge::ade_focus_parent(handle.ns_view.as_ptr());
            }
        }
        self.focus.focus(window, cx);
        self.focus_requested = true;
        if !self.starting {
            self.finish_focus_request(window, cx);
        }
    }
    fn finish_focus_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus_requested {
            return;
        }
        self.focus_requested = false;
        let panel = cx.weak_entity();
        window.on_next_frame(move |window, cx| {
            let _ = panel.update(cx, |this, _cx| {
                let native_free =
                    window
                        .window_handle()
                        .ok()
                        .is_some_and(|handle| match handle.as_raw() {
                            RawWindowHandle::AppKit(handle) => unsafe {
                                crate::command_bridge::ade_focus_kind(handle.ns_view.as_ptr()) == 0
                            },
                            _ => false,
                        });
                if this.active
                    && !this.starting
                    && this.error.is_empty()
                    && this.focus.is_focused(window)
                    && native_free
                {
                    this.focus_terminal();
                }
            });
        });
    }
    pub fn focus_terminal(&self) {
        if self.active
            && let Some(surface) = &self.surface
        {
            surface.focus();
        }
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.starting {
            return;
        }
        self.error.clear();
        self._stream = None;
        if let Some(surface) = self.surface.take() {
            surface.detach();
        }
        if self.terminal_id.is_some() {
            self.attach(window, cx);
            return;
        }
        self.starting = true;
        let request = json!({"op":"terminal.create","workspace_id":self.workspace.id});
        // Creation is an admitted mutation. Pane disposal drops its reply, not
        // the supervisor-owned terminal or an already admitted operation.
        let rx = client_state::background_request(request.to_string().len(), move || {
            client_state::rpc(&request).map_err(|error| error.to_string())
        });
        self._creation = Some(cx.spawn(async move |this, cx| {
            let result = client_state::response_result(rx.recv().await);
            let _ = this.update_in(cx, |this: &mut Self, window, cx| {
                this.starting = false;
                match result {
                    Ok(value) => match value["terminal_id"].as_str() {
                        Some(id) => {
                            this.terminal_id = Some(id.into());
                            this.attach(window, cx);
                        }
                        None => this.error = "The terminal service returned no session ID.".into(),
                    },
                    Err(error) => this.error = error,
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn attach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match make_terminal(window, &self.workspace, self.terminal_id.as_deref()) {
            Ok(surface) => {
                surface.set_visible(false);
                self.surface = Some(surface);
            }
            Err(error) => {
                self.error = error.to_string();
                cx.notify();
                return;
            }
        }
        self.starting = true;
        let workspace = self.workspace.id.clone();
        let terminal_id = self.terminal_id.clone();
        self._stream = Some(cx.spawn(async move |this, cx| {
            let stream = terminal_stream::Stream::connect_terminal(
                socket(),
                Some(&workspace),
                terminal_id.as_deref(),
            );
            while let Ok(event) = stream.events.recv().await {
                let keep = this.update_in(cx, |this: &mut Self, window, cx| {
                    let Some(surface) = &this.surface else {
                        return false;
                    };
                    let restored = matches!(&event, terminal_stream::Event::Restore(_));
                    let started = std::time::Instant::now();
                    let result = match event {
                        terminal_stream::Event::Restore(bytes) => {
                            bench::sample("snapshot_bytes", bytes.len() as u64);
                            let result = surface.restore(&bytes);
                            bench::elapsed("restore_us", started);
                            if result.is_ok() {
                                bench::restored();
                            }
                            result
                        }
                        terminal_stream::Event::Output(bytes) => {
                            let result = surface.feed(&bytes);
                            bench::elapsed("feed_us", started);
                            bench::output(&bytes);
                            result
                        }
                        terminal_stream::Event::Resize(cols, rows) => {
                            let result = surface.resize_grid(cols, rows);
                            bench::elapsed("resize_us", started);
                            result
                        }
                        terminal_stream::Event::Failed(error) => Err(anyhow::anyhow!(error)),
                    };
                    if let Err(error) = result {
                        bench::sample("terminal_errors", 1);
                        this.starting = false;
                        this.error = error.to_string();
                        surface.set_visible(false);
                        cx.notify();
                        return false;
                    }
                    if restored {
                        this.starting = false;
                        this.error.clear();
                        this.finish_focus_request(window, cx);
                        cx.notify();
                    }
                    true
                });
                if !matches!(keep, Ok(true)) {
                    return;
                }
            }
        }));
    }
}
impl Drop for TerminalPanel {
    fn drop(&mut self) {
        if let Some(surface) = &self.surface {
            surface.detach();
        }
    }
}
impl Focusable for TerminalPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Render for TerminalPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        let mut body = v_flex()
            .size_full()
            .min_h_0()
            .track_focus(&self.focus)
            .bg(rgb(ui::CANVAS));
        if !self.error.is_empty() {
            let details = self.error.clone();
            let expanded = self.diagnostics.is_expanded(&details);
            body = body.child(
                v_flex()
                    .p_4()
                    .gap_2()
                    .child(ui::diagnostic_error_card(
                        "terminal-error",
                        "Terminal needs attention",
                        if self.terminal_id.is_some() {
                            "lux-ade could not attach to this terminal. Retry connection; its shell remains available."
                        } else {
                            "lux-ade could not start a terminal. Retry when the connection is available."
                        },
                        details.clone(),
                        expanded,
                        ui::button("terminal-panel-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                    .child(
                        h_flex().child(
                            ui::button("retry-terminal")
                                .label("Retry connection")
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.start(window, cx)),
                                ),
                        ),
                    ),
            );
        } else if self.starting {
            body = body.child(
                div()
                    .p_4()
                    .text_sm()
                    .text_color(rgb(ui::MUTED))
                    .child("Starting terminal…"),
            );
        } else if self.active
            && let Some(surface) = self.surface.clone()
        {
            body = body.child(
                canvas(
                    move |bounds, window, _| {
                        surface.set_bounds(
                            bounds.origin.x.as_f32() as f64,
                            bounds.origin.y.as_f32() as f64,
                            bounds.size.width.as_f32() as f64,
                            bounds.size.height.as_f32() as f64,
                            window.scale_factor() as f64,
                        );
                        surface.set_visible(true);
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            );
        }
        body
    }
}
