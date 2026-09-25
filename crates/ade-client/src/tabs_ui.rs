use super::*;
use ade_core::model::{BrowserTab, TerminalTab};

pub(crate) struct BrowserView {
    view: Entity<WebView>,
    _updates: Task<()>,
}
#[derive(Default, Clone)]
struct BrowserUpdate {
    url: Option<String>,
    title: Option<String>,
}
fn publish_navigation(sender: &crate::browser_navigation::Sender<BrowserUpdate>, url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    sender.update(|pending| {
        *pending = Some(BrowserUpdate {
            url: Some(url),
            title: None,
        });
    });
}
fn publish_title(sender: &crate::browser_navigation::Sender<BrowserUpdate>, title: String) {
    let title: String = title.chars().filter(|c| !c.is_control()).take(64).collect();
    if title.trim().is_empty() {
        return;
    }
    sender.update(|pending| pending.get_or_insert_with(Default::default).title = Some(title));
}

impl Workspace {
    fn reveal_tab(&self, browser: bool) {
        let index = if browser {
            self.record
                .tabs
                .browsers
                .iter()
                .position(|t| Some(&t.id) == self.record.tabs.active_browser.as_ref())
        } else {
            self.record
                .tabs
                .terminals
                .iter()
                .filter(|t| t.workspace_id == self.workspace.id)
                .position(|t| Some(&t.id) == self.record.tabs.active_terminal.as_ref())
        };
        if let Some(index) = index {
            if browser {
                &self.browser_tabs_scroll
            } else {
                &self.terminal_tabs_scroll
            }
            .scroll_to_item(index);
        }
    }

    pub(crate) fn select_terminal_tab(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self
            .record
            .tabs
            .terminals
            .iter()
            .find(|t| t.id == id)
            .cloned()
        else {
            return;
        };
        let workspace = self
            .shared
            .data
            .lock()
            .unwrap()
            .catalog
            .workspaces
            .iter()
            .find(|w| w.id == tab.workspace_id)
            .cloned();
        let Some(workspace) = workspace else { return };
        match make_terminal(window, &workspace, Some(&tab.id)) {
            Ok(terminal) => {
                self.terminal.set_visible(false);
                self.terminal = terminal;
                self._terminal_updates =
                    Self::watch_terminal(workspace.id, Some(tab.id.clone()), cx);
                self.record.tabs.active_terminal = Some(tab.id);
                self.record.panes.terminal_visible = true;
                self.terminal_error.clear();
                self.focus_pane(3, window, cx);
                self.reveal_tab(false);
                self.save(cx);
                cx.notify();
            }
            Err(error) => {
                self.shared.data.lock().unwrap().error = error.to_string();
                cx.notify();
            }
        }
    }
    pub(crate) fn show_service_terminal(
        &mut self,
        id: &str,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<()> {
        if self.embedded {
            let sender = self
                .shell_commands
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Workspace shell is unavailable."))?;
            sender
                .try_send(format!("terminal.open:{id}"))
                .map_err(|_| anyhow::anyhow!("Workspace shell is unavailable."))?;
            return Ok(());
        }
        if !self.record.tabs.terminals.iter().any(|t| t.id == id) {
            anyhow::ensure!(
                self.record.tabs.terminals.len() < 64,
                "Close a terminal tab before opening service output"
            );
            self.record.tabs.closed_terminals.retain(|t| t.id != id);
            self.record.tabs.terminals.push(TerminalTab {
                id: id.into(),
                workspace_id: self.workspace.id.clone(),
                title: format!("Service · {name}"),
            });
        }
        self.select_terminal_tab(id, window, cx);
        self.save(cx);
        Ok(())
    }
    pub(crate) fn new_terminal_tab(&mut self, cx: &mut Context<Self>) {
        self.open_terminal_command(
            json!({"op":"terminal.create","workspace_id":self.workspace.id}),
            cx,
        );
    }
    fn open_terminal_command(&mut self, request: Value, cx: &mut Context<Self>) {
        if self.pending || self.record.tabs.terminals.len() >= 64 {
            return;
        }
        self.pending = true;
        let workspace_id = self.workspace.id.clone();
        let rx = command(self.shared.clone(), request);
        self.receive_terminal(rx, workspace_id, cx);
    }
    pub(super) fn receive_terminal(
        &mut self,
        rx: async_channel::Receiver<Result<Value, String>>,
        workspace_id: String,
        cx: &mut Context<Self>,
    ) {
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = client_state::response_result(rx.recv().await);
            let _ = this.update_in(cx, |this, window, cx| {
                this.pending = false;
                if let Err(error) = &result {
                    this.shared.data.lock().unwrap().error = error.clone();
                }
                if let Ok(value) = result
                    && let Some(id) = value["terminal_id"].as_str()
                {
                    let title = format!(
                        "Terminal {}",
                        this.record.tabs.terminals.len()
                            + this.record.tabs.closed_terminals.len()
                            + 1
                    );
                    if !this.record.tabs.terminals.iter().any(|tab| tab.id == id) {
                        this.record.tabs.closed_terminals.retain(|tab| tab.id != id);
                        this.record.tabs.terminals.push(TerminalTab {
                            id: id.into(),
                            workspace_id: workspace_id.clone(),
                            title,
                        });
                    }
                    if this.workspace.id == workspace_id {
                        this.select_terminal_tab(id, window, cx);
                    }
                    this.save(cx);
                }
                cx.notify();
            });
        }));
    }
    fn watch_browser(
        id: String,
        receiver: crate::browser_navigation::Receiver<BrowserUpdate>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            while let Ok(update) = receiver.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        let Some(tab) = this
                            .record
                            .tabs
                            .browsers
                            .iter_mut()
                            .chain(this.record.tabs.closed_browsers.iter_mut())
                            .find(|tab| tab.id == id)
                        else {
                            return;
                        };
                        if let Some(url) = update.url {
                            tab.title = url
                                .split('/')
                                .nth(2)
                                .unwrap_or("Page")
                                .chars()
                                .take(128)
                                .collect();
                            tab.url = url.clone();
                            if this.record.tabs.active_browser.as_ref() == Some(&id) {
                                this.record.browser_url = url.clone();
                                this.address
                                    .update(cx, |input, cx| input.set_value(url, window, cx));
                            }
                        }
                        if let Some(title) = update.title {
                            tab.title = title;
                        }
                        this.save(cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
    }
    pub(crate) fn select_browser_tab(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self
            .record
            .tabs
            .browsers
            .iter()
            .find(|t| t.id == id)
            .cloned()
        else {
            return;
        };
        if let Some(browser) = &self.browser {
            browser.update(cx, |browser, _| browser.hide());
        }
        let browser = self
            .browser_views
            .entry(tab.id.clone())
            .or_insert_with(|| {
                let handle = window.window_handle().expect("native window");
                let (tx, rx) = crate::browser_navigation::channel();
                let title_tx = tx.clone();
                let updates = Self::watch_browser(tab.id.clone(), rx, cx);
                let native = wry::WebViewBuilder::new()
                    .with_html(include_str!("../../../assets/browser-start.html"))
                    .with_accept_first_mouse(true)
                    .with_document_title_changed_handler(move |title| {
                        publish_title(&title_tx, title);
                    })
                    .with_navigation_handler(move |url| {
                        publish_navigation(&tx, url);
                        true
                    })
                    .build_as_child(&handle)
                    .expect("embedded browser");
                let view = cx.new(|cx| WebView::new(native, window, cx));
                if !tab.url.is_empty() {
                    view.update(cx, |b, _| b.load_url(&tab.url));
                }
                BrowserView {
                    view,
                    _updates: updates,
                }
            })
            .view
            .clone();
        self.browser = Some(browser);
        self.record.tabs.active_browser = Some(tab.id);
        self.record.browser_url = tab.url.clone();
        self.address
            .update(cx, |input, cx| input.set_value(tab.url, window, cx));
        self.record.panes.browser_visible = true;
        self.focus_pane(4, window, cx);
        self.reveal_tab(true);
        self.save(cx);
        cx.notify();
    }
    pub(crate) fn new_browser_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.record.tabs.browsers.len() >= 32 {
            return;
        }
        let id = new_id("browser");
        self.record.tabs.browsers.push(BrowserTab {
            id: id.clone(),
            title: "New page".into(),
            url: String::new(),
        });
        self.select_browser_tab(&id, window, cx);
        cx.defer_in(window, |this, window, cx| {
            unsafe { crate::command_bridge::ade_focus_parent(this.native_parent) };
            this.address.read(cx).focus_handle(cx).focus(window, cx);
        });
    }
    pub(crate) fn close_tab(&mut self, browser: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.last_tab_browser = browser;
        if browser {
            let Some(index) = self
                .record
                .tabs
                .browsers
                .iter()
                .position(|t| Some(&t.id) == self.record.tabs.active_browser.as_ref())
            else {
                return;
            };
            let tab = self.record.tabs.browsers.remove(index);
            if let Some(browser) = self.browser.take() {
                browser.update(cx, |b, _| b.hide());
            }
            self.record.tabs.closed_browsers.push(tab);
            if self.record.tabs.closed_browsers.len() > 16 {
                let old = self.record.tabs.closed_browsers.remove(0);
                self.browser_views.remove(&old.id);
            }
            self.record.tabs.active_browser = None;
            if let Some(next) = self
                .record
                .tabs
                .browsers
                .get(index.min(self.record.tabs.browsers.len().saturating_sub(1)))
                .cloned()
            {
                self.select_browser_tab(&next.id, window, cx);
            }
        } else {
            let Some(index) = self
                .record
                .tabs
                .terminals
                .iter()
                .position(|t| Some(&t.id) == self.record.tabs.active_terminal.as_ref())
            else {
                return;
            };
            let tab = self.record.tabs.terminals.remove(index);
            self.record.tabs.closed_terminals.push(tab);
            if self.record.tabs.closed_terminals.len() > 32 {
                self.record.tabs.closed_terminals.remove(0);
            }
            self.record.tabs.active_terminal = None;
            self.terminal.detach();
            self._terminal_updates = Self::watch_terminal(self.workspace.id.clone(), None, cx);
            if let Some(next) = self
                .record
                .tabs
                .terminals
                .iter()
                .rfind(|t| t.workspace_id == self.workspace.id)
                .cloned()
            {
                self.select_terminal_tab(&next.id, window, cx);
            }
        }
        self.save(cx);
        cx.notify();
    }
    pub(crate) fn reopen_tab(
        &mut self,
        browser: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if browser {
            if self.record.tabs.browsers.len() >= 32 {
                return;
            }
            if let Some(tab) = self.record.tabs.closed_browsers.pop() {
                let id = tab.id.clone();
                self.record.tabs.browsers.push(tab);
                self.select_browser_tab(&id, window, cx);
            }
        } else if self.record.tabs.terminals.len() < 64
            && let Some(index) = self
                .record
                .tabs
                .closed_terminals
                .iter()
                .rposition(|t| t.workspace_id == self.workspace.id)
        {
            let tab = self.record.tabs.closed_terminals.remove(index);
            let id = tab.id.clone();
            self.record.tabs.terminals.push(tab);
            self.select_terminal_tab(&id, window, cx);
        }
    }
    pub(crate) fn move_tab(&mut self, browser: bool, delta: isize, cx: &mut Context<Self>) {
        if browser {
            let tabs = &mut self.record.tabs.browsers;
            if let Some(i) = tabs
                .iter()
                .position(|t| Some(&t.id) == self.record.tabs.active_browser.as_ref())
            {
                let j = (i as isize + delta).clamp(0, tabs.len() as isize - 1) as usize;
                tabs.swap(i, j);
            }
        } else {
            let indices: Vec<_> = self
                .record
                .tabs
                .terminals
                .iter()
                .enumerate()
                .filter(|(_, t)| t.workspace_id == self.workspace.id)
                .map(|(i, _)| i)
                .collect();
            if let Some(i) = indices.iter().position(|i| {
                Some(&self.record.tabs.terminals[*i].id)
                    == self.record.tabs.active_terminal.as_ref()
            }) {
                let j = (i as isize + delta).clamp(0, indices.len() as isize - 1) as usize;
                self.record.tabs.terminals.swap(indices[i], indices[j]);
            }
        }
        self.reveal_tab(browser);
        self.save(cx);
        cx.notify();
    }
}
impl Workspace {
    pub(crate) fn tabs_bar(&self, browser: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs: Vec<(String, String)> = if browser {
            self.record
                .tabs
                .browsers
                .iter()
                .map(|t| (t.id.clone(), t.title.clone()))
                .collect()
        } else {
            self.record
                .tabs
                .terminals
                .iter()
                .filter(|t| t.workspace_id == self.workspace.id)
                .map(|t| (t.id.clone(), t.title.clone()))
                .collect()
        };
        let active = if browser {
            &self.record.tabs.active_browser
        } else {
            &self.record.tabs.active_terminal
        };
        let mut bar = h_flex()
            .id(if browser {
                "browser-tabs"
            } else {
                "terminal-tabs"
            })
            .h(px(36.))
            .flex_shrink_0()
            .gap_1()
            .px_2()
            .overflow_x_scroll()
            .track_scroll(if browser {
                &self.browser_tabs_scroll
            } else {
                &self.terminal_tabs_scroll
            });
        for (id, title) in tabs {
            let selected = active.as_ref() == Some(&id);
            bar = bar.child(
                ui::button(SharedString::from(format!("tab-{id}")))
                    .label(title.clone())
                    .accessibility_label(title.clone())
                    .tooltip(title)
                    .w(px(144.))
                    .h_7()
                    .flex_shrink_0()
                    .selected(selected)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.last_focus = if browser { 4 } else { 3 };
                        if browser {
                            this.select_browser_tab(&id, window, cx)
                        } else {
                            this.select_terminal_tab(&id, window, cx)
                        }
                    })),
            );
        }
        bar.child(div().flex_1())
    }
    pub(crate) fn tab_controls(&self, browser: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let mut row = h_flex().gap_1();
        for (suffix, glyph, label) in [
            ("new", Glyph::Plus, "New tab"),
            ("reopen", Glyph::RotateCcw, "Reopen closed tab"),
            ("close", Glyph::X, "Close tab"),
        ] {
            let command = format!(
                "{}.{}",
                if browser { "browser" } else { "terminal" },
                suffix
            );
            let enabled = match (browser, suffix) {
                (true, "new") => self.record.tabs.browsers.len() < 32,
                (false, "new") => !self.pending && self.record.tabs.terminals.len() < 64,
                (true, "reopen") => {
                    !self.record.tabs.closed_browsers.is_empty()
                        && self.record.tabs.browsers.len() < 32
                }
                (false, "reopen") => {
                    self.record.tabs.terminals.len() < 64
                        && self
                            .record
                            .tabs
                            .closed_terminals
                            .iter()
                            .any(|tab| tab.workspace_id == self.workspace.id)
                }
                (true, "close") => self.record.tabs.active_browser.is_some(),
                (false, "close") => self.record.tabs.active_terminal.is_some(),
                _ => true,
            };
            row = row.child(
                ui::button(SharedString::from(command.clone()))
                    .icon(glyph)
                    .compact()
                    .disabled(!enabled)
                    .accessibility_label(if !browser && suffix == "close" {
                        "Close terminal view; shell keeps running"
                    } else {
                        label
                    })
                    .tooltip(if !browser && suffix == "close" {
                        "Close view. Shell keeps running; use exit in the shell to stop it."
                    } else {
                        label
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.run_command(&command, window, cx)
                    })),
            );
        }
        row
    }
}

#[cfg(test)]
mod browser_update_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    #[gpui::test]
    fn browser_updates_target_their_tab_and_stop_with_the_owner(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let record: WindowRecord = serde_json::from_value(json!({
            "id":"browser-window","workspace_id":"workspace","conversation_id":null,
            "browser_url":"","x":0.,"y":0.,"width":1000.,"height":700.
        }))
        .unwrap();
        let workspace = WorkspaceRecord {
            id: "workspace".into(),
            name: "Browser".into(),
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
        let (a, ar) = crate::browser_navigation::channel();
        let (b, br) = crate::browser_navigation::channel();
        let (at, bt) = view.update(visual, |view, cx| {
            view.record.tabs.browsers = ["a", "b"]
                .map(|id| BrowserTab {
                    id: id.into(),
                    title: "New page".into(),
                    url: String::new(),
                })
                .to_vec();
            view.record.tabs.active_browser = Some("a".into());
            (
                Workspace::watch_browser("a".into(), ar, cx),
                Workspace::watch_browser("b".into(), br, cx),
            )
        });
        publish_navigation(&a, "https://a.test/final".into());
        publish_title(&a, "A final".into());
        publish_navigation(&b, "https://b.test/final".into());
        publish_title(&b, "B final".into());
        visual.run_until_parked();
        view.read_with(visual, |view, cx| {
            assert_eq!(view.record.tabs.browsers[0].title, "A final");
            assert_eq!(view.record.tabs.browsers[1].title, "B final");
            assert_eq!(view.record.browser_url, "https://a.test/final");
            assert_eq!(
                view.address.read(cx).value().as_str(),
                "https://a.test/final"
            );
        });
        drop(bt);
        visual.run_until_parked();
        publish_navigation(&b, "https://b.test/obsolete".into());
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert_eq!(view.record.tabs.browsers[1].url, "https://b.test/final")
        });
        drop(at);
    }
    fn drain(receiver: crate::browser_navigation::Receiver<BrowserUpdate>) -> BrowserUpdate {
        let mut latest = None;
        loop {
            let mut read = std::pin::pin!(receiver.recv());
            match std::future::Future::poll(
                read.as_mut(),
                &mut std::task::Context::from_waker(std::task::Waker::noop()),
            ) {
                std::task::Poll::Ready(Ok(value)) => latest = Some(value),
                std::task::Poll::Ready(Err(_)) => return latest.unwrap(),
                std::task::Poll::Pending => panic!("producer must be closed"),
            }
        }
    }
    #[test]
    fn browser_bursts_preserve_both_fields_and_isolate_views() {
        let (a, ar) = crate::browser_navigation::channel();
        let (b, br) = crate::browser_navigation::channel();
        for index in 0..100 {
            publish_navigation(&a, format!("https://a.test/{index}"));
            publish_title(&a, format!("Page A {index}"));
            publish_navigation(&b, format!("https://b.test/{index}"));
            publish_title(&b, format!("Page B {index}"));
        }
        drop(a);
        drop(b);
        let a = drain(ar);
        let b = drain(br);
        assert_eq!(a.url.as_deref(), Some("https://a.test/99"));
        assert_eq!(a.title.as_deref(), Some("Page A 99"));
        assert_eq!(b.url.as_deref(), Some("https://b.test/99"));
        assert_eq!(b.title.as_deref(), Some("Page B 99"));
    }
    #[test]
    fn navigation_invalidates_old_title_without_losing_url_to_ignored_events() {
        let (sender, receiver) = crate::browser_navigation::channel();
        publish_title(&sender, "Previous page".into());
        publish_navigation(&sender, "https://new.test/".into());
        publish_navigation(&sender, "about:blank".into());
        publish_title(&sender, "\n\t".into());
        drop(sender);
        let update = drain(receiver);
        assert_eq!(update.url.as_deref(), Some("https://new.test/"));
        assert!(update.title.is_none());
    }
}
