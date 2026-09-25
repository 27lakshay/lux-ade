//! Workspace composition and layout. Feature controls live in their owning modules.
use crate::*;

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact_chrome = window.viewport_size().width < px(1100.);
        let s = self.shared.data.lock().unwrap().clone();
        if self.terminal_error.is_empty() {
            self.terminal_diagnostics.clear();
        }
        if s.connected && !s.catalog.workspaces.is_empty() {
            let known = |tab: &model::TerminalTab| {
                s.catalog.workspaces.iter().any(|w| {
                    w.id == tab.workspace_id
                        && (w.terminal_id == tab.id || w.extra_terminals.contains(&tab.id))
                })
            };
            self.record.tabs.terminals.retain(known);
            self.record.tabs.closed_terminals.retain(known);
            if self
                .record
                .tabs
                .active_terminal
                .as_ref()
                .is_some_and(|id| !self.record.tabs.terminals.iter().any(|tab| &tab.id == id))
            {
                self.record.tabs.active_terminal = None;
                self.terminal.detach();
                self._terminal_updates = Self::watch_terminal(self.workspace.id.clone(), None, cx);
            }
            if let Some(workspace) = s
                .catalog
                .workspaces
                .iter()
                .find(|w| w.id == self.workspace.id)
            {
                self.workspace = workspace.clone();
            }
        }
        if s.connected
            && self.record.tabs.active_terminal.is_some()
            && (self.terminal.exited() || self.terminal_boot != s.boot)
            && let Ok(terminal) = make_terminal(
                window,
                &self.workspace,
                self.record.tabs.active_terminal.as_deref(),
            )
        {
            self.terminal = terminal;
            self.terminal_boot = s.boot.clone();
            self._terminal_updates = Self::watch_terminal(
                self.workspace.id.clone(),
                self.record.tabs.active_terminal.clone(),
                cx,
            );
        }
        let terminal = self.terminal.clone();
        let panes = self.record.panes.clone();
        let viewport = window.viewport_size();
        let (fitted_sidebar, fitted_browser) = fit_workspace_panes(
            viewport.width.as_f32(),
            panes.sidebar_visible.then_some(panes.sidebar_width),
            panes.browser_visible.then_some(panes.browser_width),
        );
        let center_width = viewport.width.as_f32() - fitted_sidebar - fitted_browser;
        let horizontal_key = (
            viewport.width.as_f32().round() as i32,
            panes.sidebar_visible,
            panes.browser_visible,
            self.layout_generation,
        );
        if !self.embedded && self.horizontal_fit != Some(horizontal_key) {
            let mut sizes = Vec::new();
            if panes.sidebar_visible {
                sizes.push(px(fitted_sidebar));
            }
            sizes.push(px(center_width));
            if panes.browser_visible {
                sizes.push(px(fitted_browser));
            }
            if self
                .horizontal_panes
                .update(cx, |state, cx| state.set_sizes(&sizes, cx))
            {
                self.horizontal_fit = Some(horizontal_key);
            } else {
                // A newly visible slot is initialized by the group during render.
                // Apply geometry on its next frame without recreating its entity.
                let owner = cx.entity();
                cx.defer(move |cx| owner.update(cx, |_, cx| cx.notify()));
            }
        }
        let available_height = (viewport.height.as_f32() - 72.).max(440.);
        let fitted_terminal = if panes.terminal_visible {
            panes.terminal_height.min(available_height - 320.).max(120.)
        } else {
            0.
        };
        let vertical_key = (
            available_height.round() as i32,
            panes.terminal_visible,
            self.layout_generation,
        );
        if !self.embedded && self.vertical_fit != Some(vertical_key) {
            let mut sizes = vec![px(available_height - fitted_terminal)];
            if panes.terminal_visible {
                sizes.push(px(fitted_terminal));
            }
            if self
                .vertical_panes
                .update(cx, |state, cx| state.set_sizes(&sizes, cx))
            {
                self.vertical_fit = Some(vertical_key);
            } else {
                let owner = cx.entity();
                cx.defer(move |cx| owner.update(cx, |_, cx| cx.notify()));
            }
        }
        let compact_header = center_width < 560.;
        self.terminal
            .set_visible(panes.terminal_visible && self.record.tabs.active_terminal.is_some());
        if let Some(browser) = &self.browser
            && browser.read(cx).visible()
                != (panes.browser_visible && self.record.tabs.active_browser.is_some())
        {
            browser.update(cx, |browser, _| {
                if panes.browser_visible && self.record.tabs.active_browser.is_some() {
                    browser.show();
                } else {
                    browser.hide();
                }
            });
        }
        let conversation_pane = self.render_conversation(&s, compact_header, window, cx);
        if self.embedded {
            return conversation_pane;
        }
        let sidebar = self.render_workspace_sidebar(&s, window, cx);
        let terminal_pane = v_flex()
            .size_full()
            .border_t_1()
            .border_color(rgb(ui::BORDER))
            .child(
                h_flex()
                    .h(px(32.))
                    .flex_shrink_0()
                    .px_2()
                    .gap_2()
                    .bg(rgb(ui::SIDEBAR))
                    .child(ui::pane_title(Glyph::Terminal, "Terminal"))
                    .child(div().flex_1())
                    .child(self.tab_controls(false, cx)),
            )
            .child(self.tabs_bar(false, cx))
            .when(!self.terminal_error.is_empty(), |el| {
                let details = self.terminal_error.clone();
                let expanded = self.terminal_diagnostics.is_expanded(&details);
                el.child(ui::diagnostic_error_card(
                    "terminal-connection-error",
                    "Terminal reconnecting",
                    "lux-ade is reconnecting to this terminal. Its shell keeps running. If the connection does not recover, open Connection options.",
                    details.clone(),
                    expanded,
                    ui::button("terminal-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.terminal_diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ))
            })
            .when(self.record.tabs.active_terminal.is_none(), |el| {
                el.child(
                    div()
                        .p_3()
                        .text_sm()
                        .text_color(rgb(ui::MUTED))
                        .child("No terminal views. Open a new tab or reopen a closed view."),
                )
            })
            .child(
                div().flex_1().min_h_0().child(
                    canvas(
                        move |bounds, window, _| {
                            terminal.set_bounds(
                                bounds.origin.x.as_f32() as f64,
                                bounds.origin.y.as_f32() as f64,
                                bounds.size.width.as_f32() as f64,
                                bounds.size.height.as_f32() as f64,
                                window.scale_factor() as f64,
                            );
                        },
                        |_, _, _, _| {},
                    )
                    .size_full(),
                ),
            );
        let browser_pane = v_flex()
            .size_full()
            .min_h_0()
            .border_l_1()
            .border_color(rgb(ui::BORDER))
            .child(
                ui::pane_header(Glyph::Globe, "Browser")
                    .h(px(36.))
                    .px_3()
                    .child(self.tab_controls(true, cx)),
            )
            .child(self.tabs_bar(true, cx))
            .child(
                h_flex()
                    .px_3()
                    .pb_3()
                    .gap_2()
                    .flex_shrink_0()
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.address)
                                .small()
                                .aria_label("Browser address")
                                .disabled(self.record.tabs.active_browser.is_none()),
                        ),
                    )
                    .child(
                        ui::button("navigate")
                            .disabled(self.record.tabs.active_browser.is_none())
                            .icon(Glyph::ArrowRight)
                            .label("Go")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let url = this.address.read(cx).value().to_string();
                                if url.starts_with("https://") || url.starts_with("http://") {
                                    if let Some(browser) = &this.browser {
                                        browser.update(cx, |b, _| b.load_url(&url));
                                    }
                                    this.record.browser_url = url.clone();
                                    if let Some(tab) =
                                        this.record.tabs.browsers.iter_mut().find(|t| {
                                            Some(&t.id) == this.record.tabs.active_browser.as_ref()
                                        })
                                    {
                                        tab.url = url;
                                    }
                                    this.save(cx);
                                } else {
                                    this.shared.data.lock().unwrap().error =
                                        "Enter a browser address starting with http:// or https://"
                                            .into();
                                    cx.notify();
                                }
                            })),
                    ),
            )
            .when_some(self.browser.clone(), |el, browser| {
                el.child(div().flex_1().min_h_0().child(browser))
            });
        v_flex()
            .size_full()
            .bg(rgb(ui::CANVAS))
            .text_color(rgb(ui::TEXT))
            .text_size(px(ui::tokens::COMPACT_PX))
            .child(
                h_flex()
                    .h(px(44.))
                    .flex_shrink_0()
                    .px_4()
                    .gap_3()
                    .border_b_1()
                    .border_color(rgb(ui::BORDER))
                    .child(
                        Icon::new(Glyph::Folder)
                            .size(px(15.))
                            .text_color(rgb(ui::MUTED)),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .max_w(px(if compact_chrome { 180. } else { 260. }))
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .child(self.workspace.name.clone()),
                    )
                    .child(div().flex_1())
                    .child(
                        ui::button("commands")
                            .icon(Glyph::Search)
                            .when(!compact_chrome, |button| button.label("Commands"))
                            .tooltip("Commands")
                            .accessibility_label("Commands")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("palette", window, cx)
                            })),
                    )
                    .child(
                        ui::button("changes")
                            .icon(Glyph::GitCompareArrows)
                            .when(!compact_chrome, |button| button.label("Changes"))
                            .tooltip("Changes")
                            .accessibility_label("Changes")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("changes", window, cx)
                            })),
                    )
                    .child(
                        ui::button("worktrees")
                            .icon(Glyph::GitBranch)
                            .when(!compact_chrome, |button| button.label("Worktrees"))
                            .tooltip("Worktrees")
                            .accessibility_label("Worktrees")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("worktrees", window, cx)
                            })),
                    )
                    .child(
                        ui::button("new")
                            .icon(Glyph::PanelsTopLeft)
                            .when(!compact_chrome, |button| button.label("New window"))
                            .tooltip("New window")
                            .accessibility_label("New window")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("window.new", window, cx)
                            })),
                    )
                    .child(
                        ui::button("runtime-controls")
                            .icon(Glyph::Settings2)
                            .when(!compact_chrome, |button| button.label("Runtime"))
                            .tooltip("Runtime")
                            .accessibility_label("Runtime")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("runtime", window, cx)
                            })),
                    ),
            )
            .child(
                div().flex_1().min_h_0().child(
                    h_resizable(SharedString::from(format!(
                        "workspace-panes-{}-{}-{}",
                        panes.sidebar_visible, panes.browser_visible, self.layout_generation
                    )))
                    .with_state(&self.horizontal_panes)
                    .on_resize(cx.listener(
                        move |this,
                              state: &Entity<gpui_kit::component::resizable::ResizableState>,
                              _,
                              cx| {
                            let sizes = state.read(cx).sizes();
                            if this.record.panes.sidebar_visible
                                && let Some(size) = sizes.first()
                                && (size.as_f32() - fitted_sidebar).abs() > 0.5
                            {
                                this.record.panes.sidebar_width = size.as_f32().clamp(180., 360.);
                            }
                            if this.record.panes.browser_visible
                                && let Some(size) = sizes.last()
                                && (size.as_f32() - fitted_browser).abs() > 0.5
                            {
                                this.record.panes.browser_width = size.as_f32().clamp(240., 600.);
                            }
                            this.save(cx);
                        },
                    ))
                    .when(panes.sidebar_visible, |group| {
                        group.child(
                            resizable_panel()
                                .size(px(fitted_sidebar))
                                .size_range(px(180.)..px(360.))
                                .flex_none()
                                .child(sidebar),
                        )
                    })
                    .child(
                        resizable_panel().size_range(px(360.)..Pixels::MAX).child(
                            v_resizable(SharedString::from(format!(
                                "conversation-panes-{}-{}",
                                panes.terminal_visible, self.layout_generation
                            )))
                            .with_state(&self.vertical_panes)
                            .on_resize(cx.listener(
                                move |this,
                                      state: &Entity<
                                    gpui_kit::component::resizable::ResizableState,
                                >,
                                      _,
                                      cx| {
                                    if this.record.panes.terminal_visible {
                                        if let Some(size) = state.read(cx).sizes().last()
                                            && (size.as_f32() - fitted_terminal).abs() > 0.5
                                        {
                                            this.record.panes.terminal_height =
                                                size.as_f32().clamp(120., 600.);
                                        }
                                        this.save(cx);
                                    }
                                },
                            ))
                            .child(
                                resizable_panel()
                                    .size_range(px(320.)..Pixels::MAX)
                                    .child(conversation_pane),
                            )
                            .when(panes.terminal_visible, |group| {
                                group.child(
                                    resizable_panel()
                                        .size(px(fitted_terminal))
                                        .size_range(px(120.)..px(600.))
                                        .flex_none()
                                        .child(terminal_pane),
                                )
                            }),
                        ),
                    )
                    .when(panes.browser_visible, |group| {
                        group.child(
                            resizable_panel()
                                .size(px(fitted_browser))
                                .size_range(px(240.)..px(600.))
                                .flex_none()
                                .child(browser_pane),
                        )
                    }),
                ),
            )
            .child(
                h_flex()
                    .h(px(28.))
                    .flex_shrink_0()
                    .px_4()
                    .gap_3()
                    .bg(rgb(ui::SIDEBAR))
                    .border_t_1()
                    .border_color(rgb(ui::BORDER))
                    .child(
                        ui::icon_button("toggle-sidebar", Glyph::PanelLeft, "Sidebar")
                            .selected(panes.sidebar_visible)
                            .tooltip("Show or hide sidebar")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("sidebar.toggle", window, cx)
                            })),
                    )
                    .child(
                        ui::icon_button("toggle-terminal", Glyph::Terminal, "Terminal")
                            .selected(panes.terminal_visible)
                            .tooltip("Show or hide terminal; shell keeps running")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("terminal.toggle", window, cx)
                            })),
                    )
                    .child(
                        ui::icon_button("toggle-browser", Glyph::Globe, "Browser")
                            .selected(panes.browser_visible)
                            .tooltip("Show or hide browser; page stays loaded")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_command("browser.toggle", window, cx)
                            })),
                    )
                    .child(ui::status(
                        recovery_ui::label(s.connected),
                        recovery_ui::healthy(s.connected),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(ui::tokens::CAPTION_PX))
                            .text_color(rgb(ui::MUTED))
                            .child(if self.terminal_error.is_empty() {
                                self.workspace.root.clone()
                            } else {
                                "Terminal reconnecting…".into()
                            }),
                    ),
            )
            .into_any_element()
    }
}
