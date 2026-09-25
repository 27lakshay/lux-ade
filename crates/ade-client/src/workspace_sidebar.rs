//! Standalone Workspace navigation and Agent setup. Docked chat uses the Shell sidebar.
use crate::*;

impl Workspace {
    pub(super) fn render_workspace_sidebar(
        &mut self,
        s: &client_state::Snapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let setup_presence = ui::motion::reveal("agent-setup-reveal", self.show_setup, window, cx);
        let mut sidebar = v_flex()
            .id("workspace-sidebar")
            .overflow_y_scroll()
            .size_full()
            .flex_shrink_0()
            .bg(rgb(ui::SIDEBAR))
            .p_3()
            .gap_2()
            .border_r_1()
            .border_color(rgb(ui::BORDER))
            .child(
                h_flex()
                    .h(px(42.))
                    .px_2()
                    .gap_2()
                    .child(
                        div()
                            .text_size(px(20.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("ade"),
                    )
                    .child(div().flex_1()),
            )
            .child(div().px_2().mt_2().child(ui::section("Workspaces")))
            .child(
                ui::button("toggle-open-folder")
                    .icon(Glyph::FolderOpen)
                    .label(if self.show_folder {
                        "Hide folder field"
                    } else {
                        "Open a folder…"
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_folder = !this.show_folder;
                        if this.show_folder {
                            this.folder.read(cx).focus_handle(cx).focus(window, cx);
                        }
                        cx.notify();
                    })),
            );
        if self.show_folder {
            sidebar = sidebar.child(
                v_flex()
                    .gap_2()
                    .child(ui::field_label("Project folder path"))
                    .child(
                        Input::new(&self.folder)
                            .small()
                            .aria_label("Project folder path"),
                    )
                    .child(
                        ui::button("open-folder")
                            .label("Open folder")
                            .disabled(self.pending || !s.connected)
                            .on_click(cx.listener(|this, _, _, cx| {
                                let path = this.folder.read(cx).value().to_string();
                                this.request(
                                    json!({"op":"workspace.open","path":path}),
                                    true,
                                    false,
                                    cx,
                                );
                            })),
                    ),
            );
        }
        for w in &s.catalog.workspaces {
            let w = w.clone();
            sidebar = sidebar.child(
                ui::nav_row(
                    SharedString::from(format!("workspace-{}", w.id)),
                    Glyph::Folder,
                    w.name.clone(),
                    w.id == self.workspace.id,
                )
                .child(div().flex_1())
                .disabled(self.pending)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.select_workspace(w.clone(), window, cx)
                })),
            );
        }
        sidebar = sidebar
            .child(
                div()
                    .px_2()
                    .mt_5()
                    .mb_1()
                    .child(ui::section("Conversations")),
            )
            .child(
                ui::button("agent-setup")
                    .label(if self.show_setup {
                        "Hide Agent setup"
                    } else {
                        "Agent setup"
                    })
                    .icon(Glyph::Settings2)
                    .w_full()
                    .justify_start()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_setup = !this.show_setup;
                        cx.notify();
                    })),
            );
        let providers = s.providers.clone();
        let selected_provider = providers
            .iter()
            .find(|p| p.id == self.new_provider)
            .cloned();
        let modes = selected_provider
            .as_ref()
            .map(|p| p.permission_modes.clone())
            .unwrap_or_default();
        let mut setup = v_flex()
            .gap_2()
            .child(
                ui::button("new-provider")
                    .label(format!(
                        "Provider: {}",
                        selected_provider
                            .as_ref()
                            .map(|p| p.name.as_str())
                            .unwrap_or("Unavailable")
                    ))
                    .disabled(self.pending || providers.is_empty())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if providers.is_empty() {
                            return;
                        }
                        let next = providers
                            .iter()
                            .position(|p| p.id == this.new_provider)
                            .map_or(0, |i| (i + 1) % providers.len());
                        this.new_provider = providers[next].id.clone();
                        this.new_config = Default::default();
                        if let Some(mode) = providers[next].permission_modes.first() {
                            this.new_config.permission_mode = mode.clone();
                        }
                        cx.notify();
                    })),
            )
            .child(Input::new(&self.provider_model))
            .child(
                ui::button("permission-mode")
                    .label(format!("Mode: {}", self.new_config.permission_mode))
                    .disabled(self.pending || modes.is_empty())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if modes.is_empty() {
                            return;
                        }
                        let next = (modes
                            .iter()
                            .position(|m| *m == this.new_config.permission_mode)
                            .unwrap_or(0)
                            + 1)
                            % modes.len();
                        this.new_config.permission_mode = modes[next].clone();
                        cx.notify();
                    })),
            );
        if let Some(provider) = &selected_provider {
            if !provider.setting_sources.is_empty() {
                setup = setup.child(ui::section("Load settings:"));
            }
            for source in provider.setting_sources.clone() {
                setup = setup.child(
                    ui::button(SharedString::from(format!("settings-{source}")))
                        .label(format!(
                            "{}: {}",
                            source,
                            if self.new_config.setting_sources.contains(&source) {
                                "on"
                            } else {
                                "off"
                            }
                        ))
                        .disabled(self.pending)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.new_config.setting_sources.contains(&source) {
                                this.new_config.setting_sources.retain(|s| s != &source);
                            } else {
                                this.new_config.setting_sources.push(source.clone());
                            }
                            cx.notify();
                        })),
                );
            }
        }
        if setup_presence.should_render() {
            sidebar = sidebar.child(gpui_kit::base::motion::MotionReveal::new(
                "agent-setup-height",
                setup_presence.progress,
                ui::inset_card()
                    .opacity(setup_presence.progress)
                    .child(setup)
                    .into_any_element(),
            ));
        }
        sidebar = sidebar.child(
            ui::button("create-conversation")
                .primary()
                .icon(Glyph::Plus)
                .label("New Conversation")
                .disabled(self.pending || !s.connected || selected_provider.is_none())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.run_command("conversation.new", window, cx)
                })),
        );
        for c in s
            .catalog
            .conversations
            .iter()
            .filter(|c| c.workspace_id == self.workspace.id)
        {
            let id = c.id.clone();
            sidebar = sidebar.child(
                ui::nav_row(
                    SharedString::from(format!("conversation-{id}")),
                    Glyph::MessageSquare,
                    c.title.clone(),
                    self.record.conversation_id.as_deref() == Some(c.id.as_str()),
                )
                .child(div().flex_1())
                .tooltip(format!("{} · {}", c.title, c.status))
                .disabled(self.pending)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.select_conversation(id.clone(), window, cx)
                })),
            );
        }
        sidebar.into_any_element()
    }
}
