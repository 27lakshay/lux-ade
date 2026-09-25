//! Window chrome and navigation. Content and native surfaces belong to the dock.
use super::*;
pub struct Shell {
    record: WindowRecord,
    workspace: WorkspaceRecord,
    shared: Shared,
    persist: bool,
    dock: Entity<dock_ui::DockHost>,
    controller: Entity<Workspace>,
    sender: async_channel::Sender<String>,
    _bridge: command_bridge::Bridge,
    _commands: Task<()>,
    _routed: Task<()>,
    _events: Subscription,
    _controller: Subscription,
    _model: Subscription,
    _bounds: Subscription,
    _updates: Task<()>,
    _save: Option<Task<()>>,
    layouts: HashMap<String, Value>,
    sidebar_sizes: Entity<ResizableState>,
    sidebar_fit: Option<(i32, i32)>,
    show_folder: bool,
    show_setup: bool,
    closing: bool,
    close_error: String,
    close_diagnostics: ui::DiagnosticDisclosure,
}
impl Shell {
    pub fn new(
        record: WindowRecord,
        workspace: WorkspaceRecord,
        persist: bool,
        shared: Shared,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe_window_activation(window, |_, window, cx| {
            ui::refresh_motion_preference(window, cx)
        })
        .detach();
        let layouts: HashMap<String, Value> = record
            .dock_layout
            .as_ref()
            .and_then(|layout| layout.get("workspaces"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let mut control_record = record.clone();
        control_record.conversation_id = None;
        let controller = cx.new(|cx| {
            Workspace::new(
                control_record,
                workspace.clone(),
                false,
                true,
                shared.clone(),
                window,
                cx,
            )
        });
        let model_input = controller.read(cx).provider_model.clone();
        let config_controller = controller.clone();
        let model_subscription = cx.subscribe(&model_input, move |_, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                config_controller.update(cx, |_, cx| cx.notify());
            }
        });
        let dock = cx.new(|cx| {
            dock_ui::DockHost::new(shared.clone(), workspace.clone(), &record, window, cx)
        });
        let (sender, receiver) = async_channel::bounded::<String>(64);
        controller.update(cx, |v, _| v.shell_commands = Some(sender.clone()));
        dock.update(cx, |v, cx| v.set_command_sender(sender.clone(), cx));
        let events = Self::watch_dock(&dock, window, cx);
        let control = cx.observe_in(&controller, window, |this, _, window, cx| {
            let control = this.controller.read(cx);
            let workspace = control.workspace.clone();
            let selected = control.record.conversation_id.clone();
            let config = (
                control.new_provider.clone(),
                control.new_config.clone(),
                control.provider_model.read(cx).value().to_string(),
            );
            this.dock.update(cx, |dock, cx| {
                dock.set_new_chat_config(config.0, config.1, config.2, cx)
            });
            if workspace.id != this.workspace.id {
                this.switch_workspace(workspace, window, cx);
            }
            if let Some(id) = selected {
                this.dock
                    .update(cx, |dock, cx| dock.select_conversation(id, window, cx));
                this.controller
                    .update(cx, |v, _| v.record.conversation_id = None);
            }
            cx.notify();
        });
        let raw = window.window_handle().expect("native window");
        let RawWindowHandle::AppKit(native) = raw.as_raw() else {
            unreachable!()
        };
        let (bridge, commands) = command_bridge::Bridge::new(native.ns_view.as_ptr());
        let command_task = cx.spawn(async move |this, cx| {
            while let Ok(event) = commands.recv().await {
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
                if let Some(command) = crate::commands::COMMANDS.get(index)
                    && this
                        .update_in(cx, |this, window, cx| {
                            this.run_command(command.id, window, cx)
                        })
                        .is_err()
                {
                    break;
                }
            }
        });
        let routed = cx.spawn(async move |this, cx| {
            while let Ok(command) = receiver.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.run_command(&command, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let receiver = shared.subscribe();
        let updates = cx.spawn(async move |this, cx| {
            while receiver.recv().await.is_ok() {
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });
        let bounds = cx.observe_window_bounds(window, |this, window, cx| {
            let b = window.bounds();
            let viewport = window.viewport_size();
            this.record.x = b.origin.x.as_f32();
            this.record.y = b.origin.y.as_f32();
            this.record.width = viewport.width.as_f32();
            this.record.height = viewport.height.as_f32();
            this.save(cx);
        });
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, cx| {
                if !this.persist {
                    return true;
                }
                this.request_close(cx);
                false
            })
            .unwrap_or(true)
        });
        Self {
            record,
            workspace,
            shared,
            persist,
            dock,
            controller,
            sender,
            _bridge: bridge,
            _commands: command_task,
            _routed: routed,
            _events: events,
            _controller: control,
            _model: model_subscription,
            _bounds: bounds,
            _updates: updates,
            _save: None,
            layouts,
            sidebar_sizes: cx.new(|_| ResizableState::default()),
            sidebar_fit: None,
            show_folder: false,
            show_setup: false,
            closing: false,
            close_error: String::new(),
            close_diagnostics: Default::default(),
        }
    }
    fn request_close(&mut self, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.close_error.clear();
        let drafts = match self
            .dock
            .update(cx, |dock, cx| dock.drafts_for_close(true, cx))
        {
            Ok(drafts) => drafts,
            Err(error) => {
                self.close_error = error;
                cx.notify();
                return;
            }
        };
        client_state::retry_unsaved_drafts(&self.shared, &self.record.id);
        self._save = None;
        let record = json!(self.record);
        command(
            self.shared.clone(),
            json!({"op":"window.save","window":record}),
        );
        let fence = client_state::flush_layout();
        let shared = self.shared.clone();
        let id = self.record.id.clone();
        self.closing = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = match client_state::confirmed_before(
                fence,
                cx.background_executor().timer(Duration::from_secs(30)),
                "Save confirmation timed out. Keep this window open and check its current state before retrying close.",
            ).await {
                Ok(()) => client_state::confirmed_before(
                    command(shared, json!({"op":"window.close","window_id":id})),
                    cx.background_executor().timer(Duration::from_secs(30)),
                    "Close confirmation timed out. Keep this window open and check its current state before retrying close.",
                ).await.map(|_| ()),
                Err(error) => Err(error),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                this.closing = false;
                let current = this
                    .dock
                    .update(cx, |dock, cx| dock.drafts_for_close(false, cx));
                let unchanged = current.as_ref().is_ok_and(|current| current == &drafts)
                    && json!(this.record) == record;
                match complete_window_close(result, unchanged, window) {
                    CloseDisposition::Close => {}
                    CloseDisposition::Retry => this.request_close(cx),
                    CloseDisposition::KeepOpen(error) => {
                        this.close_error = error;
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }
    fn watch_dock(
        dock: &Entity<dock_ui::DockHost>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe_in(dock, window, |this, dock, event, _, cx| {
            let dock_ui::HostEvent::LayoutChanged(layout) = event;
            this.layouts
                .insert(this.workspace.id.clone(), layout.clone());
            let mut saved = layout.clone();
            saved["workspaces"] = json!(this.layouts);
            this.record.dock_layout = Some(saved);
            this.record.conversation_id = dock.read(cx).active_conversation(cx);
            this.save(cx);
            cx.notify();
        })
    }
    fn save(&mut self, cx: &mut Context<Self>) {
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
    fn switch_workspace(
        &mut self,
        workspace: WorkspaceRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.workspace = workspace.clone();
        self.record.workspace_id = workspace.id.clone();
        self.record.conversation_id = None;
        self.record.dock_layout = self.layouts.get(&workspace.id).cloned();
        self.dock = cx.new(|cx| {
            dock_ui::DockHost::new(
                self.shared.clone(),
                workspace.clone(),
                &self.record,
                window,
                cx,
            )
        });
        self.dock
            .update(cx, |v, cx| v.set_command_sender(self.sender.clone(), cx));
        self._events = Self::watch_dock(&self.dock, window, cx);
        self.controller.update(cx, |v, _| {
            v.workspace = workspace;
            v.record.workspace_id = v.workspace.id.clone();
            v.record.conversation_id = None;
        });
        window.set_window_title(&format!("lux-ade — {}", self.workspace.name));
        self.save(cx);
        cx.notify();
    }
    fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            "sidebar.toggle" => {
                self.record.panes.sidebar_visible = !self.record.panes.sidebar_visible
            }
            "sidebar.grow" | "sidebar.shrink" => {
                self.record.panes.sidebar_width = (self.record.panes.sidebar_width
                    + if id.ends_with("grow") { 24. } else { -24. })
                .clamp(200., 360.)
            }
            "workspace.open" | "focus.sidebar" => {
                self.record.panes.sidebar_visible = true;
                self.show_folder = true;
                self.controller
                    .read(cx)
                    .folder
                    .read(cx)
                    .focus_handle(cx)
                    .focus(window, cx);
            }
            "window.new" => {
                let mut record = self.record.clone();
                record.id = new_id("window");
                record.dock_layout = None;
                record.conversation_id = None;
                record.x += 35.;
                record.y += 35.;
                crate::bootstrap::open_workspace(
                    true,
                    self.shared.clone(),
                    Some(record),
                    self.persist,
                    cx,
                );
            }
            "conversation.new" => self
                .controller
                .update(cx, |v, cx| v.run_command(id, window, cx)),
            "layout.reset" => {
                self.record.panes = Default::default();
                self.layouts.remove(&self.workspace.id);
                self.switch_workspace(self.workspace.clone(), window, cx);
            }
            _ => {
                let handled = self.dock.update(cx, |v, cx| v.command(id, window, cx));
                if !handled
                    && ![
                        "tab.",
                        "pane.",
                        "terminal.",
                        "browser.",
                        "focus.next",
                        "focus.previous",
                    ]
                    .iter()
                    .any(|prefix| id.starts_with(prefix))
                {
                    let target = self
                        .dock
                        .read(cx)
                        .active_chat(cx)
                        .unwrap_or_else(|| self.controller.clone());
                    target.update(cx, |v, cx| v.run_command(id, window, cx));
                }
            }
        }
        self.save(cx);
        cx.notify();
    }
}
impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let s = self.shared.data.lock().unwrap().clone();
        if self.close_error.is_empty() {
            self.close_diagnostics.clear();
        }
        let selected = self.dock.read(cx).active_conversation(cx);
        let control = self.controller.read(cx);
        let folder = control.folder.clone();
        let model = control.provider_model.clone();
        let provider = control.new_provider.clone();
        let pending = control.pending;
        let config = control.new_config.clone();
        let mut sidebar = v_flex()
            .id("ade-sidebar")
            .w_full()
            .h_full()
            .flex_shrink_0()
            .bg(rgb(ui::SIDEBAR))
            .px_3()
            .pb_2()
            .gap_1()
            .child(
                TitleBar::new()
                    .bg(rgb(ui::SIDEBAR))
                    .border_0()
                    .child(
                        div()
                            .text_size(px(ui::tokens::COMPACT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .child("lux-ade"),
                    )
                    .child(div().flex_1())
                    .child(
                        ui::icon_button("hide-sidebar", Glyph::PanelLeft, "Hide sidebar").on_click(
                            cx.listener(|this, _, window, cx| {
                                this.run_command("sidebar.toggle", window, cx)
                            }),
                        ),
                    ),
            )
            .child(
                ui::sidebar_row("new-conversation", "New Conversation", false)
                    .icon(Glyph::Plus)
                    .disabled(pending || !s.connected)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.run_command("conversation.new", window, cx)
                    })),
            )
            .child(
                ui::sidebar_row("search-commands", "Search commands", false)
                    .icon(Glyph::Search)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.run_command("palette", window, cx)),
                    ),
            )
            .child(
                ui::sidebar_row("open-folder-toggle", "Open folder", false)
                    .icon(Glyph::FolderOpen)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_folder = !this.show_folder;
                        cx.notify();
                    })),
            );
        if self.show_folder {
            sidebar = sidebar
                .child(
                    Input::new(&folder)
                        .small()
                        .aria_label("Project folder path"),
                )
                .child(
                    ui::button("open-folder")
                        .label("Open folder")
                        .disabled(pending || !s.connected)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.controller.update(cx, |v, cx| {
                                let root = v.folder.read(cx).value().to_string();
                                v.request(
                                    json!({"op":"workspace.open","path":root}),
                                    true,
                                    false,
                                    cx,
                                );
                            });
                        })),
                );
        }
        let mut navigation = v_flex()
            .id("sidebar-navigation")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .gap_1()
            .mt_4()
            .child(ui::sidebar_section("Projects"));
        for workspace in s.catalog.workspaces.clone() {
            navigation = navigation.child(
                ui::sidebar_row(
                    SharedString::from(format!("project-{}", workspace.id)),
                    workspace.name.clone(),
                    workspace.id == self.workspace.id,
                )
                .icon(Glyph::Folder)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.switch_workspace(workspace.clone(), window, cx)
                })),
            );
        }
        navigation = navigation.child(div().mt_5().child(ui::sidebar_section("Recents")));
        let mut recents: Vec<_> = s
            .catalog
            .conversations
            .iter()
            .filter(|c| c.workspace_id == self.workspace.id)
            .collect();
        recents.sort_by_key(|c| std::cmp::Reverse(c.updated_at));
        for conversation in recents {
            let id = conversation.id.clone();
            navigation = navigation.child(
                ui::sidebar_row(
                    SharedString::from(format!("conversation-{id}")),
                    conversation.title.clone(),
                    selected.as_ref() == Some(&id),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.dock.update(cx, |dock, cx| {
                        dock.select_conversation(id.clone(), window, cx)
                    })
                })),
            );
        }
        sidebar = sidebar.child(navigation);
        if self.show_setup {
            for p in s.providers.clone() {
                sidebar = sidebar.child(
                    ui::sidebar_row(
                        SharedString::from(format!("provider-{}", p.id)),
                        p.name.clone(),
                        provider == p.id,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.controller.update(cx, |v, cx| {
                            v.new_provider = p.id.clone();
                            v.new_config = Default::default();
                            if let Some(mode) = p.permission_modes.first() {
                                v.new_config.permission_mode = mode.clone();
                            }
                            cx.notify();
                        })
                    })),
                );
            }
            sidebar = sidebar.child(
                Input::new(&model)
                    .small()
                    .aria_label("Model for new Conversations"),
            );
            if let Some(selected_provider) = s.providers.iter().find(|p| p.id == provider) {
                let modes = selected_provider.permission_modes.clone();
                sidebar = sidebar.child(
                    ui::button("permission-mode")
                        .label(format!("Mode: {}", config.permission_mode))
                        .disabled(pending || modes.is_empty())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.controller.update(cx, |v, cx| {
                                if !modes.is_empty() {
                                    let next = modes
                                        .iter()
                                        .position(|m| m == &v.new_config.permission_mode)
                                        .map_or(0, |i| (i + 1) % modes.len());
                                    v.new_config.permission_mode = modes[next].clone();
                                    cx.notify();
                                }
                            });
                        })),
                );
                for source in selected_provider.setting_sources.clone() {
                    sidebar = sidebar.child(
                        ui::sidebar_row(
                            SharedString::from(format!("settings-{source}")),
                            format!("Load {source} settings"),
                            config.setting_sources.contains(&source),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.controller.update(cx, |v, cx| {
                                if v.new_config.setting_sources.contains(&source) {
                                    v.new_config.setting_sources.retain(|s| s != &source);
                                } else {
                                    v.new_config.setting_sources.push(source.clone());
                                }
                                cx.notify();
                            })
                        })),
                    );
                }
            }
        }
        sidebar =
            sidebar
                .child(
                    ui::sidebar_row(
                        "provider-settings",
                        format!("New chats · {provider}"),
                        self.show_setup,
                    )
                    .icon(Glyph::Settings2)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_setup = !this.show_setup;
                        cx.notify();
                    })),
                )
                .child(
                    h_flex().gap_1().children(
                        [
                            ("changes", Glyph::GitBranch, "Changes"),
                            ("worktrees", Glyph::Folder, "Worktrees"),
                            ("services", Glyph::Terminal, "Services"),
                            ("runtime", Glyph::Activity, "Runtime"),
                        ]
                        .into_iter()
                        .map(|(id, icon, label)| {
                            ui::icon_button(id, icon, label).on_click(cx.listener(
                                move |this, _, window, cx| this.run_command(id, window, cx),
                            ))
                        }),
                    ),
                );
        let content = v_flex()
            .size_full()
            .min_w_0()
            .when(!self.record.panes.sidebar_visible, |el| {
                el.child(TitleBar::new().bg(rgb(ui::CANVAS)).child(
                    ui::icon_button("show-sidebar", Glyph::PanelLeft, "Show sidebar").on_click(
                        cx.listener(|this, _, window, cx| {
                            this.run_command("sidebar.toggle", window, cx)
                        }),
                    ),
                ))
            })
            .when(!s.connected, |el| {
                el.child(
                    div()
                        .px_4()
                        .py_2()
                        .text_color(rgb(ui::DANGER))
                        .child("Connecting to lux-ade…"),
                )
            })
            .when(s.connected && !s.error.is_empty(), |el| {
                el.child(h_flex().px_4().py_2().gap_3().items_center()
                    .child(div().flex_1().text_color(rgb(ui::DANGER))
                        .child("lux-ade could not finish the last action. Check the current state before retrying."))
                    .child(ui::button("open-runtime-from-error")
                        .label("View details")
                        .on_click(cx.listener(|this, _, window, cx| this.run_command("runtime", window, cx)))))
            })
            .when(s.command_overflow, |root| {
                root.child(ui::command_overflow_notice(self.shared.clone()))
            })
            .when(self.closing, |root| {
                root.child(
                    div()
                        .px_4()
                        .py_2()
                        .child(ui::description("Saving before closing…")),
                )
            })
            .when(!self.close_error.is_empty(), |root| {
                let details = self.close_error.clone();
                let expanded = self.close_diagnostics.is_expanded(&details);
                root.child(
                    v_flex()
                        .p_3()
                        .gap_2()
                        .child(ui::field_label(
                            "Window kept open — changes could not be saved",
                        ))
                        .child(ui::diagnostic_error_card(
                            "window-close-error",
                            "Save needs attention",
                            "lux-ade kept this window open because its changes could not be saved. Check storage access, then retry.",
                            details.clone(),
                            expanded,
                            ui::button("window-close-diagnostics-toggle")
                                .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.close_diagnostics.toggle(&details);
                                    cx.notify();
                                })),
                        ))
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    ui::primary_button("retry-close-save", "Retry save and close")
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.request_close(cx)),
                                        ),
                                )
                                .child(
                                    ui::button("cancel-close-save")
                                        .label("Keep working")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.close_error.clear();
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
            })
            .child(div().flex_1().min_h_0().child(self.dock.clone()));
        let layout = if self.record.panes.sidebar_visible {
            let side = self.record.panes.sidebar_width.clamp(200., 360.);
            let width = window.viewport_size().width.as_f32();
            let key = (width.round() as i32, side.round() as i32);
            if self.sidebar_fit != Some(key) {
                if self.sidebar_sizes.update(cx, |state, cx| {
                    state.set_sizes(&[px(side), px((width - side).max(360.))], cx)
                }) {
                    self.sidebar_fit = Some(key);
                } else {
                    let owner = cx.entity();
                    cx.defer(move |cx| owner.update(cx, |_, cx| cx.notify()));
                }
            }
            h_resizable("shell-columns")
                .with_state(&self.sidebar_sizes)
                .on_resize(cx.listener(|this, state: &Entity<ResizableState>, _, cx| {
                    if let Some(width) = state.read(cx).sizes().first() {
                        this.record.panes.sidebar_width = width.as_f32().clamp(200., 360.);
                        this.save(cx);
                    }
                }))
                .child(
                    resizable_panel()
                        .size(px(side))
                        .size_range(px(200.)..px(360.))
                        .flex_none()
                        .child(ui::motion::sidebar_enter(sidebar)),
                )
                .child(
                    resizable_panel()
                        .size_range(px(360.)..Pixels::MAX)
                        .child(content),
                )
                .into_any_element()
        } else {
            self.sidebar_fit = None;
            content.into_any_element()
        };
        div()
            .size_full()
            .bg(rgb(ui::CANVAS))
            .text_color(rgb(ui::TEXT))
            .text_size(px(ui::tokens::COMPACT_PX))
            .child(layout)
    }
}

#[derive(Debug, PartialEq)]
enum CloseDisposition {
    Close,
    Retry,
    KeepOpen(String),
}
fn close_disposition(saved: Result<(), String>, unchanged: bool) -> CloseDisposition {
    match saved {
        Err(error) => CloseDisposition::KeepOpen(error),
        Ok(()) if !unchanged => CloseDisposition::Retry,
        Ok(()) => CloseDisposition::Close,
    }
}
fn complete_window_close(
    saved: Result<(), String>,
    unchanged: bool,
    window: &mut Window,
) -> CloseDisposition {
    let outcome = close_disposition(saved, unchanged);
    if outcome == CloseDisposition::Close {
        window.remove_window();
    }
    outcome
}
#[cfg(test)]
mod close_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    struct DraftWindow {
        editor: Entity<InputState>,
    }
    impl Render for DraftWindow {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(Input::new(&self.editor))
        }
    }
    #[gpui::test]
    fn failed_close_keeps_original_window_and_draft(cx: &mut TestAppContext) {
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            let editor = cx.new(|cx| InputState::new(window, cx));
            editor.update(cx, |editor, cx| {
                editor.set_value("unsaved original draft", window, cx)
            });
            DraftWindow { editor }
        });
        visual.run_until_parked();
        let original = visual.windows();
        visual.update(|window, _| {
            assert_eq!(
                complete_window_close(Err("disk full".into()), true, window),
                CloseDisposition::KeepOpen("disk full".into())
            );
        });
        assert_eq!(visual.windows(), original);
        visual.update(|_, cx| {
            assert_eq!(
                view.read(cx).editor.read(cx).value().as_ref(),
                "unsaved original draft"
            );
        });
        visual.update(|window, _| {
            assert_eq!(
                complete_window_close(Ok(()), false, window),
                CloseDisposition::Retry
            );
        });
        assert_eq!(visual.windows(), original);
        visual.update(|window, _| {
            assert_eq!(
                complete_window_close(Ok(()), true, window),
                CloseDisposition::Close
            );
        });
        assert!(visual.windows().is_empty());
    }
    #[test]
    fn failed_save_never_authorizes_close_even_with_unchanged_draft() {
        for unchanged in [false, true] {
            assert_eq!(
                close_disposition(Err("disk full".into()), unchanged),
                CloseDisposition::KeepOpen("disk full".into())
            );
        }
    }
    #[test]
    fn editing_during_save_requires_another_successful_fence() {
        assert_eq!(close_disposition(Ok(()), false), CloseDisposition::Retry);
        assert_eq!(close_disposition(Ok(()), true), CloseDisposition::Close);
    }
}
