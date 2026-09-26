//! Workspace tab groups. Dock owns geometry; each retained panel owns its content.
use crate::{Workspace, client_state::Shared, native_panels, ui};
use ade_core::model::{WindowRecord, WorkspaceRecord, new_id};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    assets::IconName as Glyph,
    component::{
        button::*,
        dock::*,
        input::{Input, InputState},
        menu::{PopupMenu, PopupMenuItem},
        *,
    },
    *,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

const MAX_PANELS: usize = 64;
#[derive(Clone, Serialize, Deserialize)]
struct ContentRecord {
    id: String,
    kind: String,
    #[serde(default)]
    content_id: Option<String>,
    #[serde(default)]
    reopen_anchor: Option<String>,
    #[serde(default)]
    reopen_index: Option<usize>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    color: Option<u32>,
}
impl ContentRecord {
    fn empty() -> Self {
        Self {
            id: new_id("pane"),
            kind: "empty".into(),
            content_id: None,
            reopen_anchor: None,
            reopen_index: None,
            title: None,
            pinned: false,
            color: None,
        }
    }
}
pub enum HostEvent {
    LayoutChanged(Value),
}
impl EventEmitter<HostEvent> for DockHost {}
pub struct DockHost {
    window_id: String,
    shared: Shared,
    workspace: WorkspaceRecord,
    area: Entity<DockArea>,
    _skin: Rc<DockSkin>,
    panels: HashMap<String, Entity<ContentPanel>>,
    active: Option<String>,
    closed: Vec<ContentRecord>,
    recent: Vec<String>,
    notice: String,
    overlays: HashSet<String>,
    commands: Option<async_channel::Sender<String>>,
    new_chat: Option<(String, ade_core::provider::Config, String)>,
    _events: Subscription,
}
impl DockHost {
    pub fn new(
        shared: Shared,
        workspace: WorkspaceRecord,
        record: &WindowRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (area, skin) = DockSkin::dock_area("ade-content-dock", Some(1), window, cx);
        skin.set_close_button_visible(true, cx);
        let events = cx.subscribe_in(&area, window, |this, _, event: &DockEvent, window, cx| {
            if matches!(event, DockEvent::LayoutChanged) {
                this.reconcile_visibility(window, cx);
                this.changed(cx);
            }
        });
        let mut this = Self {
            window_id: record.id.clone(),
            shared,
            workspace,
            area,
            _skin: skin,
            panels: HashMap::new(),
            active: None,
            closed: vec![],
            recent: vec![],
            notice: String::new(),
            overlays: HashSet::new(),
            commands: None,
            new_chat: None,
            _events: events,
        };
        let saved = record.dock_layout.as_ref();
        let parsed = saved.and_then(|value| {
            serde_json::from_value::<DockAreaState>(value.get("dock").unwrap_or(value).clone()).ok()
        });
        let mut layout = if let Some(saved) = parsed {
            this.restore(&saved.center, 0, cx)
        } else {
            if saved.is_some() {
                this.notice =
                    "The saved pane layout could not be restored. Start from this empty pane."
                        .into();
            }
            let mut content = ContentRecord::empty();
            // Legacy browser/terminal visibility is deliberately not migrated.
            if saved.is_none()
                && let Some(id) = &record.conversation_id
            {
                content.kind = "chat".into();
                content.content_id = Some(id.clone());
            }
            let panel = this.create(content, cx);
            DockLayout::tabs().panel_view(panel_handle(panel), cx)
        };
        if this.panels.is_empty() {
            this.notice="The saved pane layout was empty or exceeded the supported depth. Start from this launcher.".into();
            let panel = this.create(ContentRecord::empty(), cx);
            layout = DockLayout::tabs().panel_view(panel_handle(panel), cx);
        }
        this.area
            .update(cx, |area, cx| area.set_center(layout, window, cx));
        if let Some(saved) = saved {
            this.active = saved["active_panel"]
                .as_str()
                .filter(|id| this.panels.contains_key(*id))
                .map(str::to_owned);
            this.recent = saved["recent"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|id| this.panels.contains_key(*id))
                .take(MAX_PANELS)
                .map(str::to_owned)
                .collect();
            this.closed = saved["closed"]
                .as_array()
                .into_iter()
                .flatten()
                .take(MAX_PANELS)
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
        }
        this
    }
    fn create(
        &mut self,
        mut record: ContentRecord,
        cx: &mut Context<Self>,
    ) -> Entity<ContentPanel> {
        if self.panels.contains_key(&record.id) {
            record.id = new_id("pane");
        }
        if !matches!(
            record.kind.as_str(),
            "empty" | "chat" | "browser" | "terminal"
        ) || (record.kind == "chat" && record.content_id.is_none())
        {
            record.kind = "empty".into();
            record.content_id = None;
            self.notice = "An unavailable pane was replaced with the launcher.".into();
        }
        let id = record.id.clone();
        let owner = cx.weak_entity();
        let shared = self.shared.clone();
        let workspace = self.workspace.clone();
        let panel = cx.new(|cx| ContentPanel {
            window_id: self.window_id.clone(),
            record,
            owner,
            shared,
            workspace,
            body: Body::Unloaded,
            rename: None,
            overlay_hidden: false,
            commands: self.commands.clone(),
            new_chat: self.new_chat.clone(),
            content_updates: None,
            feedback: ui::motion::PaneFeedback::default(),
            focus: cx.focus_handle(),
            group: None,
        });
        if self.active.is_none() {
            self.active = Some(id.clone());
        }
        self.panels.insert(id, panel.clone());
        panel
    }
    fn restore(&mut self, saved: &PanelState, depth: usize, cx: &mut Context<Self>) -> DockLayout {
        if depth >= 32 || self.panels.len() >= MAX_PANELS {
            self.notice =
                "The saved layout exceeded the pane limit; extra panes were skipped.".into();
            return DockLayout::tabs();
        }
        match &saved.info {
            PanelInfo::Stack { sizes, axis } => {
                let mut layout = if *axis == 0 {
                    DockLayout::h_split()
                } else {
                    DockLayout::v_split()
                };
                for (index, child) in saved.children.iter().take(MAX_PANELS).enumerate() {
                    if self.panels.len() >= MAX_PANELS {
                        break;
                    }
                    layout = layout.child(
                        self.restore(child, depth + 1, cx),
                        sizes
                            .get(index)
                            .copied()
                            .filter(|s| s.as_f32().is_finite() && *s > px(0.)),
                    );
                }
                layout
            }
            PanelInfo::Tabs { active_index } => {
                let mut layout = DockLayout::tabs();
                for child in saved.children.iter().take(MAX_PANELS) {
                    if self.panels.len() >= MAX_PANELS {
                        break;
                    }
                    let record = match &child.info {
                        PanelInfo::Panel(value) => serde_json::from_value(value.clone()).ok(),
                        _ => None,
                    }
                    .unwrap_or_else(ContentRecord::empty);
                    let panel = self.create(record, cx);
                    layout = layout.panel_view(panel_handle(panel), cx);
                }
                if saved.children.is_empty() {
                    let panel = self.create(ContentRecord::empty(), cx);
                    layout = layout.panel_view(panel_handle(panel), cx);
                }
                layout.active_index((*active_index).min(saved.children.len().saturating_sub(1)))
            }
            PanelInfo::Panel(value) => {
                let record = serde_json::from_value(value.clone()).unwrap_or_else(|_| {
                    self.notice = "An unreadable pane was replaced with the launcher.".into();
                    ContentRecord::empty()
                });
                let panel = self.create(record, cx);
                DockLayout::tabs().panel_view(panel_handle(panel), cx)
            }
        }
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = &self.active {
            self.recent
                .retain(|old| old != id && self.panels.contains_key(old));
            self.recent.push(id.clone());
            if self.recent.len() > MAX_PANELS {
                self.recent.remove(0);
            }
        }
        let dock = self.area.read(cx).dump(cx);
        cx.emit(HostEvent::LayoutChanged(
            json!({"dock":dock,"active_panel":self.active,"closed":self.closed,"recent":self.recent}),
        ));
        cx.notify();
    }
    fn active_panel(&self) -> Option<Entity<ContentPanel>> {
        self.active
            .as_ref()
            .and_then(|id| self.panels.get(id))
            .cloned()
    }
    fn active_node(&self, cx: &App) -> Option<NodeId> {
        let panel = self.active_panel()?;
        self.area
            .read(cx)
            .layout(DockPlacement::Center)?
            .find_panel_node(PanelId::from(panel.entity_id()))
    }
    fn focused_native(&self, cx: &App) -> Option<Entity<ContentPanel>> {
        self.panels
            .values()
            .find(|p| match &p.read(cx).body {
                Body::Browser(b) => b.read(cx).is_focused(cx),
                Body::Terminal(t) => t.read(cx).is_focused(cx),
                _ => false,
            })
            .cloned()
    }
    pub fn active_conversation(&self, cx: &App) -> Option<String> {
        if self.focused_native(cx).is_some() {
            return None;
        }
        let panel = self.active_panel()?;
        let panel = panel.read(cx);
        match &panel.body {
            Body::Chat(chat) => chat.read(cx).record.conversation_id.clone(),
            _ => (panel.record.kind == "chat")
                .then(|| panel.record.content_id.clone())
                .flatten(),
        }
    }
    pub fn active_chat(&self, cx: &App) -> Option<Entity<Workspace>> {
        if self.focused_native(cx).is_some() {
            return None;
        }
        match &self.active_panel()?.read(cx).body {
            Body::Chat(chat) => Some(chat.clone()),
            _ => None,
        }
    }
    pub fn set_new_chat_config(
        &mut self,
        provider: String,
        config: ade_core::provider::Config,
        model: String,
        cx: &mut Context<Self>,
    ) {
        self.new_chat = Some((provider, config, model));
        for panel in self.panels.values() {
            panel.update(cx, |panel, _| panel.new_chat = self.new_chat.clone());
        }
    }
    /// Capture all retained drafts, including inactive tabs. Retrying a failed
    /// close re-enqueues them even when their editor text has not changed.
    pub fn drafts_for_close(&self, save: bool, cx: &mut Context<Self>) -> Result<Value, String> {
        if crate::client_state::has_draft_actions(&self.shared, &self.window_id) {
            return Err(
                "Wait for pending attachment imports or prompt submissions, then retry closing."
                    .into(),
            );
        }
        let mut drafts = std::collections::BTreeMap::new();
        for panel in self.panels.values() {
            let chat = match &panel.read(cx).body {
                Body::Chat(chat) => Some(chat.clone()),
                _ => None,
            };
            if let Some(chat) = chat {
                let snapshot = chat.update(cx, |chat, cx| {
                    if chat.pending || chat.draft_load.blocked() {
                        return Err("Wait for the current draft or Agent action to finish, then retry closing.".to_owned());
                    }
                    if let Some(id) = chat.record.conversation_id.clone() {
                        let text = chat.composer.read(cx).value().to_string();
                        chat.save_draft_text(&id, text);
                    }
                    if save {
                        for id in chat.drafts.keys() {
                            chat.persist_draft(id);
                        }
                    }
                    Ok(json!(chat.drafts))
                })?;
                drafts.insert(panel.read(cx).record.id.clone(), snapshot);
            }
        }
        Ok(json!(drafts))
    }
    pub fn set_command_sender(
        &mut self,
        sender: async_channel::Sender<String>,
        cx: &mut Context<Self>,
    ) {
        self.commands = Some(sender.clone());
        for panel in self.panels.values() {
            panel.update(cx, |panel, cx| {
                panel.commands = Some(sender.clone());
                if let Body::Chat(chat) = &panel.body {
                    chat.update(cx, |chat, _| chat.shell_commands = Some(sender.clone()));
                }
            });
        }
    }
    pub fn open_kind(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(kind, "empty" | "chat" | "terminal" | "browser") {
            return;
        }
        if kind == "empty" {
            self.new_tab(window, cx);
            return;
        }
        if !self
            .active_panel()
            .is_some_and(|panel| panel.read(cx).record.kind == "empty")
        {
            self.new_tab(window, cx);
        }
        if let Some(panel) = self.active_panel() {
            if panel.read(cx).record.kind != "empty" {
                return;
            }
            panel.update(cx, |panel, cx| {
                panel.launch(kind, window, cx);
                panel.on_focus_requested(window, cx);
            });
        }
        self.changed(cx);
    }
    pub fn select_terminal(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self
            .panels
            .values()
            .find(|p| {
                let p = p.read(cx);
                match &p.body {
                    Body::Terminal(t) => t.read(cx).terminal_id() == Some(id.as_str()),
                    _ => p.record.kind == "terminal" && p.record.content_id.as_ref() == Some(&id),
                }
            })
            .cloned();
        if let Some(panel) = panel {
            self.active = Some(panel.read(cx).record.id.clone());
            self.area.update(cx, |area, cx| {
                area.select_panel(PanelId::from(panel.entity_id()), window, cx)
            });
        } else {
            if self.panels.len() >= MAX_PANELS {
                return;
            }
            let mut record = ContentRecord::empty();
            record.kind = "terminal".into();
            record.content_id = Some(id);
            self.insert(record, None, window, cx);
            if let Some(panel) = self.active_panel() {
                panel.update(cx, |p, cx| p.launch("terminal", window, cx));
            }
        }
        self.changed(cx);
    }
    pub fn cycle_tab(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self
            .active_panel()
            .and_then(|p| p.read(cx).group.as_ref().and_then(WeakEntity::upgrade))
        else {
            return;
        };
        let count = group.read(cx).panels().len();
        if count == 0 {
            return;
        }
        let next =
            (group.read(cx).active_ix() as isize + delta).rem_euclid(count as isize) as usize;
        group.update(cx, |group, cx| group.select_tab(next, window, cx));
    }
    pub fn move_tab(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.active_panel() else {
            return;
        };
        let Some(group) = panel.read(cx).group.as_ref().and_then(WeakEntity::upgrade) else {
            return;
        };
        let group = group.read(cx);
        let count = group.panels().len();
        if count < 2 {
            return;
        }
        let ix = (group.active_ix() as isize + delta).clamp(0, count as isize - 1) as usize;
        let target = InsertTarget::Tabs {
            node: group.node(),
            ix: Some(ix),
            activate: true,
        };
        self.area.update(cx, |area, cx| {
            area.move_panel(PanelId::from(panel.entity_id()), target, window, cx)
        });
    }
    pub fn focus_cycle(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.active_node(cx);
        let area = self.area.read(cx);
        let Some(tree) = area.layout(DockPlacement::Center) else {
            return;
        };
        let groups: Vec<_> = tree
            .node_ids()
            .into_iter()
            .filter_map(|id| {
                let node = tree.find_node(id)?;
                if let PaneRef::Tabs { panels, active_ix } = node.kind() {
                    panels.get(active_ix).copied().map(|panel| (id, panel))
                } else {
                    None
                }
            })
            .collect();
        if groups.is_empty() {
            return;
        }
        let index = groups
            .iter()
            .position(|(id, _)| Some(*id) == current)
            .unwrap_or(0);
        let target = groups[(index as isize + delta).rem_euclid(groups.len() as isize) as usize].1;
        let panel = self
            .panels
            .values()
            .find(|panel| PanelId::from(panel.entity_id()) == target)
            .cloned();
        if let Some(panel) = panel {
            self.active = Some(panel.read(cx).record.id.clone());
            panel.update(cx, |p, cx| p.on_focus_requested(window, cx));
            self.changed(cx);
        }
    }
    pub fn command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if let Some(panel) = self.focused_native(cx) {
            self.active = Some(panel.read(cx).record.id.clone());
        }
        if let Some(id) = id.strip_prefix("terminal.open:") {
            self.select_terminal(id.into(), window, cx);
            return true;
        }
        match id {
            "tab.pin" => self.tab_action("pin", window, cx),
            "tab.rename" => self.tab_action("rename", window, cx),
            "tab.close-others" => self.tab_action("close-others", window, cx),
            "tab.close-left" => self.tab_action("close-left", window, cx),
            "tab.close-right" => self.tab_action("close-right", window, cx),
            "pane.split-left" => self.split(Placement::Left, window, cx),
            "pane.split-up" => self.split(Placement::Top, window, cx),
            "pane.move-left" => self.move_to_split(Placement::Left, window, cx),
            "pane.move-right" => self.move_to_split(Placement::Right, window, cx),
            "pane.move-up" => self.move_to_split(Placement::Top, window, cx),
            "pane.move-down" => self.move_to_split(Placement::Bottom, window, cx),
            "tab.new" => self.new_tab(window, cx),
            "tab.close" => self.close_active(window, cx),
            "tab.reopen" => self.reopen_closed(window, cx),
            "tab.next" => self.cycle_tab(1, window, cx),
            "tab.previous" => self.cycle_tab(-1, window, cx),
            "tab.left" => self.move_tab(-1, window, cx),
            "tab.right" => self.move_tab(1, window, cx),
            "pane.split-right" => self.split_right(window, cx),
            "pane.split-down" => self.split_down(window, cx),
            "pane.zoom" => self.toggle_zoom(window, cx),
            "focus.next" => self.focus_cycle(1, window, cx),
            "focus.previous" => self.focus_cycle(-1, window, cx),
            "terminal.new" => {
                self.new_tab(window, cx);
                self.open_kind("terminal", window, cx);
            }
            "browser.new" => {
                self.new_tab(window, cx);
                self.open_kind("browser", window, cx);
            }
            "terminal.toggle" | "browser.toggle" | "focus.terminal" | "focus.browser" => {
                let kind = if id.contains("terminal") {
                    "terminal"
                } else {
                    "browser"
                };
                let found = self
                    .panels
                    .values()
                    .find(|p| p.read(cx).record.kind == kind)
                    .cloned();
                if let Some(panel) = found {
                    self.active = Some(panel.read(cx).record.id.clone());
                    self.area.update(cx, |area, cx| {
                        area.select_panel(PanelId::from(panel.entity_id()), window, cx)
                    });
                    panel.update(cx, |panel, cx| {
                        if matches!(panel.body, Body::Unloaded) {
                            panel.launch(kind, window, cx);
                        }
                        panel.on_focus_requested(window, cx);
                    });
                    self.changed(cx);
                } else {
                    self.open_kind(kind, window, cx);
                }
            }
            "terminal.close" | "browser.close" => {
                let kind = if id.starts_with("terminal") {
                    "terminal"
                } else {
                    "browser"
                };
                if self
                    .active_panel()
                    .is_some_and(|p| p.read(cx).record.kind == kind)
                {
                    self.close_active(window, cx);
                }
            }
            "terminal.reopen" | "browser.reopen" => {
                if self.panels.len() >= MAX_PANELS {
                    return true;
                }
                let kind = if id.starts_with("terminal") {
                    "terminal"
                } else {
                    "browser"
                };
                if let Some(index) = self.closed.iter().rposition(|p| p.kind == kind) {
                    let record = self.closed.remove(index);
                    self.insert(record, None, window, cx);
                    if kind == "browser"
                        && let Some(panel) = self.active_panel()
                    {
                        panel.update(cx, |p, cx| {
                            p.launch("browser", window, cx);
                            p.on_focus_requested(window, cx);
                        });
                    }
                }
            }
            "terminal.stop" | "terminal.restart" | "terminal.retire" => {
                let panel = self.active_panel();
                let terminal = panel.as_ref().and_then(|p| {
                    let p = p.read(cx);
                    match &p.body {
                        Body::Terminal(t) => t.read(cx).terminal_id().map(str::to_owned),
                        _ => None,
                    }
                });
                if let Some(terminal) = terminal {
                    crate::client_state::command(
                        self.shared.clone(),
                        json!({"op":id,"workspace_id":self.workspace.id,"terminal_id":terminal}),
                    );
                }
            }
            "browser.grow" | "browser.shrink" | "terminal.grow" | "terminal.shrink" => {
                self.notice = "Drag the divider beside this pane to resize it.".into();
                cx.notify();
            }
            _ => return false,
        }
        true
    }
    pub fn new_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.insert(ContentRecord::empty(), None, window, cx);
    }
    pub fn split(&mut self, placement: Placement, window: &mut Window, cx: &mut Context<Self>) {
        self.insert(ContentRecord::empty(), Some(placement), window, cx);
    }
    pub fn split_right(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.split(Placement::Right, window, cx);
    }
    pub fn split_down(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.split(Placement::Bottom, window, cx);
    }
    fn insert(
        &mut self,
        record: ContentRecord,
        split: Option<Placement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.panels.len() >= MAX_PANELS {
            self.notice = "Close a pane before opening another (64 pane limit).".into();
            cx.notify();
            return;
        }
        let target = record
            .reopen_anchor
            .as_ref()
            .and_then(|id| self.panels.get(id))
            .and_then(|panel| {
                self.area
                    .read(cx)
                    .layout(DockPlacement::Center)?
                    .find_panel_node(PanelId::from(panel.entity_id()))
            })
            .or_else(|| self.active_node(cx));
        let reopen_index = record.reopen_index;
        let panel = self.create(record, cx);
        let id = PanelId::from(panel.entity_id());
        self.active = Some(panel.read(cx).record.id.clone());
        self.area.update(cx, |area, cx| {
            area.add_panel_view(
                panel_handle(panel.clone()),
                DockPlacement::Center,
                None,
                window,
                cx,
            );
            if let Some(node) = target {
                let target = match split {
                    Some(placement) => InsertTarget::Split {
                        node,
                        placement,
                        size: None,
                    },
                    None => InsertTarget::Tabs {
                        node,
                        ix: reopen_index,
                        activate: true,
                    },
                };
                area.move_panel(id, target, window, cx);
            }
            area.select_panel(id, window, cx);
        });
        self.changed(cx);
    }
    pub fn select_conversation(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self
            .panels
            .values()
            .find(|p| {
                p.read(cx).record.content_id.as_ref() == Some(&id)
                    && p.read(cx).record.kind == "chat"
            })
            .cloned()
        {
            self.active = Some(panel.read(cx).record.id.clone());
            self.area.update(cx, |area, cx| {
                area.select_panel(PanelId::from(panel.entity_id()), window, cx)
            });
        } else if self
            .active_panel()
            .is_some_and(|p| p.read(cx).record.kind == "empty")
        {
            let panel = self.active_panel().unwrap();
            panel.update(cx, |panel, cx| {
                panel.record.kind = "chat".into();
                panel.record.content_id = Some(id);
                panel.body = Body::Unloaded;
                cx.notify();
            });
        } else {
            let mut record = ContentRecord::empty();
            record.kind = "chat".into();
            record.content_id = Some(id);
            self.insert(record, None, window, cx);
        }
        self.changed(cx);
    }
    fn tab_action(&mut self, action: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.active_panel() else {
            return;
        };
        match action {
            "pin" => panel.update(cx, |p, cx| {
                p.record.pinned = !p.record.pinned;
                cx.notify();
            }),
            "rename" => panel.update(cx, |p, cx| {
                let value = p.label(cx);
                let input = cx.new(|cx| InputState::new(window, cx).default_value(value));
                input.read(cx).focus_handle(cx).focus(window, cx);
                p.rename = Some(input);
                cx.notify();
            }),
            "close-others" | "close-left" | "close-right" => {
                let Some(group) = panel.read(cx).group.as_ref().and_then(WeakEntity::upgrade)
                else {
                    return;
                };
                let ids: Vec<_> = group
                    .read(cx)
                    .panels()
                    .iter()
                    .map(|p| p.view().entity_id())
                    .collect();
                let Some(at) = ids.iter().position(|id| *id == panel.entity_id()) else {
                    return;
                };
                let closing: Vec<_> = ids
                    .iter()
                    .enumerate()
                    .filter(|(ix, _)| match action {
                        "close-left" => *ix < at,
                        "close-right" => *ix > at,
                        _ => *ix != at,
                    })
                    .filter_map(|(_, id)| {
                        self.panels
                            .values()
                            .find(|p| p.entity_id() == *id && !p.read(cx).record.pinned)
                            .cloned()
                    })
                    .collect();
                for other in closing {
                    self.area
                        .update(cx, |area, cx| area.remove_panel(other, window, cx));
                }
            }
            _ if action.starts_with("color:") => panel.update(cx, |p, cx| {
                p.record.color = u32::from_str_radix(&action[6..], 16)
                    .ok()
                    .filter(|v| *v <= 0xffffff);
                cx.notify();
            }),
            _ => {}
        }
        self.changed(cx);
    }
    fn move_to_split(&mut self, placement: Placement, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.active_panel() else {
            return;
        };
        let Some(group) = panel.read(cx).group.as_ref().and_then(WeakEntity::upgrade) else {
            return;
        };
        let node = group.read(cx).node();
        if group.read(cx).panels().len() == 1 {
            if self.panels.len() >= MAX_PANELS {
                return;
            }
            self.new_tab(window, cx);
        }
        self.active = Some(panel.read(cx).record.id.clone());
        self.area.update(cx, |area, cx| {
            area.move_panel(
                PanelId::from(panel.entity_id()),
                InsertTarget::Split {
                    node,
                    placement,
                    size: None,
                },
                window,
                cx,
            );
        });
        self.changed(cx);
    }
    pub fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.active_panel() else {
            return;
        };
        if panel.read(cx).record.pinned {
            return;
        }
        if self.panels.len() == 1 {
            let closed = panel.read(cx).saved_record(cx);
            if closed.kind != "empty" {
                self.closed.push(closed);
            }
            if self.closed.len() > MAX_PANELS {
                self.closed.remove(0);
            }
            panel.update(cx, |p, cx| {
                p.hide(window, cx);
                p.record.kind = "empty".into();
                p.record.content_id = None;
                p.record.title = None;
                p.record.color = None;
                p.body = Body::Unloaded;
                cx.notify();
            });
            self.changed(cx);
        } else {
            self.area
                .update(cx, |area, cx| area.remove_panel(panel, window, cx));
        }
    }
    pub fn reopen_closed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panels.len() >= MAX_PANELS {
            return;
        }
        if let Some(record) = self.closed.pop() {
            let browser = record.kind == "browser";
            self.insert(record, None, window, cx);
            if browser && let Some(panel) = self.active_panel() {
                panel.update(cx, |p, cx| {
                    p.launch("browser", window, cx);
                    p.on_focus_requested(window, cx);
                });
            }
        }
    }
    pub fn toggle_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let node = self.active_node(cx);
        self.area.update(cx, |area, cx| {
            if area.is_zoomed() {
                area.set_zoomed_out(window, cx);
            } else if let Some(node) = node {
                area.set_zoomed_in(node, window, cx);
            }
        });
    }
    fn reconcile_visibility(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let area = self.area.read(cx);
        let mut visible = HashSet::new();
        if let Some(tree) = area.layout(DockPlacement::Center) {
            for id in tree.node_ids() {
                if area.zoomed_group().is_some_and(|zoom| zoom != id) {
                    continue;
                }
                if let Some(node) = tree.find_node(id)
                    && let PaneRef::Tabs { panels, active_ix } = node.kind()
                    && let Some(panel) = panels.get(active_ix)
                {
                    visible.insert(*panel);
                }
            }
        }
        let mut positions = Vec::new();
        if let Some(tree) = area.layout(DockPlacement::Center) {
            for node in tree
                .node_ids()
                .into_iter()
                .filter_map(|id| tree.find_node(id))
            {
                if let PaneRef::Tabs { panels, .. } = node.kind() {
                    for (index, id) in panels.iter().enumerate() {
                        let entity = self
                            .panels
                            .values()
                            .find(|p| PanelId::from(p.entity_id()) == *id)
                            .cloned();
                        let anchor = panels
                            .iter()
                            .find(|other| *other != id)
                            .and_then(|other| {
                                self.panels
                                    .values()
                                    .find(|p| PanelId::from(p.entity_id()) == *other)
                            })
                            .map(|p| p.read(cx).record.id.clone());
                        if let Some(entity) = entity {
                            positions.push((entity, anchor, index));
                        }
                    }
                }
            }
        }
        for (panel, anchor, index) in positions {
            panel.update(cx, |p, _| {
                p.record.reopen_anchor = anchor;
                p.record.reopen_index = Some(index);
            });
        }
        for panel in self.panels.values() {
            if !visible.contains(&PanelId::from(panel.entity_id())) {
                panel.update(cx, |p, cx| p.hide(window, cx));
            }
        }
    }
}
impl Render for DockHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.reconcile_visibility(window, cx);
        v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .when(!self.notice.is_empty(), |el| {
                el.child(ui::description(self.notice.clone()))
            })
            .child(self.area.clone())
    }
}
enum Body {
    Unloaded,
    Chat(Entity<Workspace>),
    Browser(Entity<native_panels::BrowserPanel>),
    Terminal(Entity<native_panels::TerminalPanel>),
}
struct ContentPanel {
    window_id: String,
    record: ContentRecord,
    owner: WeakEntity<DockHost>,
    shared: Shared,
    workspace: WorkspaceRecord,
    body: Body,
    rename: Option<Entity<InputState>>,
    overlay_hidden: bool,
    commands: Option<async_channel::Sender<String>>,
    new_chat: Option<(String, ade_core::provider::Config, String)>,
    content_updates: Option<Subscription>,
    feedback: ui::motion::PaneFeedback,
    focus: FocusHandle,
    group: Option<WeakEntity<TabGroup>>,
}
impl EventEmitter<PanelEvent> for ContentPanel {}
impl Focusable for ContentPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        match &self.body {
            Body::Chat(chat) => chat.read(cx).focus_handle(cx),
            _ => self.focus.clone(),
        }
    }
}
impl ContentPanel {
    fn chat_record(&self) -> WindowRecord {
        WindowRecord {
            id: self.window_id.clone(),
            workspace_id: self.workspace.id.clone(),
            conversation_id: self.record.content_id.clone(),
            dock_layout: None,
            panes: Default::default(),
            tabs: Default::default(),
            focused_pane: 5,
            browser_url: String::new(),
            x: 0.,
            y: 0.,
            width: 1220.,
            height: 800.,
        }
    }
    fn label(&self, cx: &App) -> SharedString {
        if let Some(title) = &self.record.title {
            return title.clone().into();
        }
        match self.record.kind.as_str() {
            "chat" => self
                .shared
                .data
                .lock()
                .unwrap()
                .catalog
                .conversations
                .iter()
                .find(|c| Some(&c.id) == self.record.content_id.as_ref())
                .map(|c| c.title.clone())
                .unwrap_or_else(|| "Conversation".into())
                .into(),
            "browser" => {
                let url = match &self.body {
                    Body::Browser(panel) => panel.read(cx).url().to_owned(),
                    _ => self.record.content_id.clone().unwrap_or_default(),
                };
                if url.is_empty() {
                    "Browser".into()
                } else {
                    url.split_once("://")
                        .map_or(url.as_str(), |(_, rest)| rest)
                        .split('/')
                        .next()
                        .unwrap_or("Browser")
                        .to_owned()
                        .into()
                }
            }
            "terminal" => "Terminal".into(),
            _ => "New tab".into(),
        }
    }
    fn saved_record(&self, cx: &App) -> ContentRecord {
        let mut record = self.record.clone();
        match &self.body {
            Body::Chat(chat) => record.content_id = chat.read(cx).record.conversation_id.clone(),
            Body::Browser(panel) => record.content_id = Some(panel.read(cx).url().to_owned()),
            Body::Terminal(panel) => {
                record.content_id = panel.read(cx).terminal_id().map(str::to_owned)
            }
            _ => {}
        }
        record
    }
    fn hide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.body {
            Body::Browser(p) => p.update(cx, |p, cx| p.set_active(false, window, cx)),
            Body::Terminal(p) => p.update(cx, |p, cx| p.set_active(false, window, cx)),
            _ => {}
        }
    }
    fn launch(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.hide(window, cx);
        self.content_updates = None;
        if self.record.kind != kind {
            self.record.content_id = None;
        }
        self.record.kind = kind.into();
        match kind {
            "browser" => {
                let panel = cx.new(|cx| native_panels::BrowserPanel::new(window, cx));
                if let Some(url) = self.record.content_id.clone() {
                    panel.update(cx, |p, cx| p.load_url(&url, window, cx));
                }
                self.body = Body::Browser(panel);
            }
            "terminal" => {
                self.body = Body::Terminal(cx.new(|cx| {
                    native_panels::TerminalPanel::new(
                        self.workspace.clone(),
                        self.record.content_id.clone(),
                        window,
                        cx,
                    )
                }))
            }
            "chat" => {
                let chat = crate::create_chat_panel(
                    self.shared.clone(),
                    self.workspace.clone(),
                    self.chat_record(),
                    window,
                    cx,
                );
                if self.record.content_id.is_none()
                    && let Some((provider, config, model)) = self.new_chat.clone()
                {
                    chat.update(cx, |chat, cx| {
                        chat.new_provider = provider;
                        chat.new_config = config;
                        chat.provider_model
                            .update(cx, |input, cx| input.set_value(model, window, cx));
                    });
                }
                if let Some(sender) = self.commands.clone() {
                    chat.update(cx, |chat, _| chat.shell_commands = Some(sender));
                }
                self.content_updates = Some(cx.observe(&chat, |this, chat, cx| {
                    let id = chat.read(cx).record.conversation_id.clone();
                    if this.record.content_id != id {
                        this.record.content_id = id;
                        let owner = this.owner.clone();
                        cx.defer(move |cx| {
                            let _ = owner.update(cx, |host, cx| host.changed(cx));
                        });
                    }
                }));
                self.body = Body::Chat(chat);
            }
            _ => {}
        }
        let id = self.record.id.clone();
        let owner = self.owner.clone();
        cx.defer(move |cx| {
            let _ = owner.update(cx, |host, cx| {
                host.active = Some(id);
                host.changed(cx);
            });
        });
        cx.notify();
    }
}
impl BasePanel for ContentPanel {
    fn on_focus_requested(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Only an explicit focus request may instantiate a saved terminal.
        if matches!(self.body, Body::Unloaded)
            && self.record.kind == "terminal"
            && self.record.content_id.is_some()
        {
            self.launch("terminal", window, cx);
        }
        match &self.body {
            Body::Terminal(panel) => panel.update(cx, |p, cx| p.request_focus(window, cx)),
            Body::Browser(panel) => panel.update(cx, |p, cx| p.focus_address(window, cx)),
            Body::Chat(panel) => panel.read(cx).focus_handle(cx).focus(window, cx),
            Body::Unloaded => self.focus.focus(window, cx),
        }
    }

    fn closable(&self, _: &App) -> bool {
        !self.record.pinned
    }
    fn panel_name(&self) -> &'static str {
        "ade.content"
    }
    fn on_added_to(&mut self, group: WeakEntity<TabGroup>, _: &mut Window, _: &mut Context<Self>) {
        self.group = Some(group);
    }
    fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !active {
            self.hide(window, cx);
        } else {
            let id = self.record.id.clone();
            let owner = self.owner.clone();
            cx.defer(move |cx| {
                let _ = owner.update(cx, |host, cx| {
                    host.active = Some(id);
                    host.changed(cx);
                });
            });
        }
    }
    fn on_removed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hide(window, cx);
        let record = self.saved_record(cx);
        let owner = self.owner.clone();
        let group = self.group.clone();
        window.defer(cx, move |window, cx| {
            let _ = owner.update(cx, |host, cx| {
                let siblings: Vec<_> = group
                    .as_ref()
                    .and_then(WeakEntity::upgrade)
                    .map(|group| {
                        group
                            .read(cx)
                            .panels()
                            .iter()
                            .map(|p| p.view().entity_id())
                            .collect()
                    })
                    .unwrap_or_default();
                let mut visits = host.recent.iter().rev().filter(|id| {
                    *id == &record.id
                        || host
                            .panels
                            .get(*id)
                            .is_some_and(|p| siblings.contains(&p.entity_id()))
                });
                let closing_was_active = visits.next() == Some(&record.id);
                let next = closing_was_active
                    .then(|| visits.next().cloned())
                    .flatten()
                    .and_then(|id| host.panels.get(&id).cloned());
                host.panels.remove(&record.id);
                host.overlays.remove(&record.id);
                for panel in host.panels.values() {
                    panel.update(cx, |p, cx| {
                        p.overlay_hidden = !host.overlays.is_empty();
                        cx.notify();
                    });
                }
                if let Some(next) = next {
                    host.active = Some(next.read(cx).record.id.clone());
                    host.area.update(cx, |area, cx| {
                        area.select_panel(PanelId::from(next.entity_id()), window, cx)
                    });
                }
                host.closed.push(record.clone());
                if host.closed.len() > MAX_PANELS {
                    host.closed.remove(0);
                }
                if host.active.as_ref() == Some(&record.id) {
                    host.active = host.panels.keys().next().cloned();
                }
                host.changed(cx);
            });
        });
    }
    fn dump(&self, cx: &App) -> PanelState {
        let record = self.saved_record(cx);
        PanelState {
            panel_name: self.panel_name().into(),
            children: vec![],
            info: PanelInfo::Panel(serde_json::to_value(record).unwrap()),
        }
    }
}
impl Panel for ContentPanel {
    fn set_overlay_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        let owner = self.owner.clone();
        let id = self.record.id.clone();
        window.defer(cx, move |window, cx| {
            let _ = owner.update(cx, |host, cx| {
                if open {
                    host.overlays.insert(id);
                } else {
                    host.overlays.remove(&id);
                }
                let hidden = !host.overlays.is_empty();
                for panel in host.panels.values() {
                    panel.update(cx, |panel, cx| {
                        panel.overlay_hidden = hidden;
                        if hidden {
                            panel.hide(window, cx);
                        }
                        cx.notify();
                    });
                }
                cx.notify();
            });
        });
    }

    fn tab_aria_label(&self, cx: &App) -> Option<SharedString> {
        Some(self.label(cx))
    }
    fn title(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let icon = match self.record.kind.as_str() {
            "chat" => Glyph::MessageSquare,
            "browser" => Glyph::Globe,
            "terminal" => Glyph::Terminal,
            _ => Glyph::Plus,
        };
        h_flex()
            .opacity(self.feedback.opacity(window, cx))
            .gap_2()
            .when_some(self.record.color, |row, color| row.text_color(rgb(color)))
            .when(self.record.pinned, |row| {
                row.child(Icon::new(Glyph::Pin).size_3())
            })
            .child(Icon::new(icon).size_3())
            .child(div().max_w(px(180.)).truncate().child(self.label(cx)))
    }
    fn inner_padding(&self, _: &App) -> bool {
        false
    }
    fn dropdown_menu(
        &mut self,
        mut menu: PopupMenu,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> PopupMenu {
        let actions = [
            (
                if self.record.pinned {
                    "Unpin tab"
                } else {
                    "Pin tab"
                },
                "pin",
            ),
            ("Rename tab", "rename"),
            ("Close other tabs", "close-others"),
            ("Close tabs to the left", "close-left"),
            ("Close tabs to the right", "close-right"),
            ("Default color", "color:"),
            ("Champagne", "color:d8c49e"),
            ("Sage", "color:94b59b"),
            ("Blue", "color:91b7d8"),
            ("Rose", "color:d69baa"),
            ("Move tab to left split", "move-left"),
            ("Move tab to right split", "move-right"),
            ("Move tab to upper split", "move-up"),
            ("Move tab to lower split", "move-down"),
        ];
        for (label, action) in actions {
            let owner = self.owner.clone();
            let id = self.record.id.clone();
            menu = menu.item(PopupMenuItem::new(label).on_click(move |_, window, cx| {
                let _ = owner.update(cx, |host, cx| {
                    host.active = Some(id.clone());
                    if let Some(panel) = host.active_panel() {
                        host.area.update(cx, |area, cx| {
                            area.select_panel(PanelId::from(panel.entity_id()), window, cx)
                        });
                    }
                    match action {
                        "move-left" => host.move_to_split(Placement::Left, window, cx),
                        "move-right" => host.move_to_split(Placement::Right, window, cx),
                        "move-up" => host.move_to_split(Placement::Top, window, cx),
                        "move-down" => host.move_to_split(Placement::Bottom, window, cx),
                        _ => host.tab_action(action, window, cx),
                    }
                });
            }));
        }
        menu
    }
    fn toolbar_buttons(&mut self, _: &mut Window, _cx: &mut Context<Self>) -> Option<Vec<Button>> {
        let owner = self.owner.clone();
        let id = self.record.id.clone();
        let button = move |name: &'static str, icon, label: &'static str, action: u8| {
            let owner = owner.clone();
            let id = id.clone();
            ui::icon_button(name, icon, label).on_click(move |event, window, cx| {
                let _ = owner.update(cx, |host, cx| {
                    host.active = Some(id.clone());
                    if let Some(panel) = host.active_panel() {
                        host.area.update(cx, |area, cx| {
                            area.select_panel(PanelId::from(panel.entity_id()), window, cx)
                        });
                    }
                    match action {
                        0 => host.new_tab(window, cx),
                        1 => host.split_right(window, cx),
                        2 => host.split_down(window, cx),
                        3 => host.close_active(window, cx),
                        _ => host.reopen_closed(window, cx),
                    }
                    if action == 0
                        && let Some(panel) = host.active_panel()
                    {
                        panel.update(cx, |panel, cx| {
                            panel.feedback.begin(
                                !matches!(event, ClickEvent::Keyboard(_)),
                                cx.reduce_motion(),
                            );
                            cx.notify();
                        });
                    }
                });
            })
        };
        Some(vec![
            button("new-pane-tab", Glyph::Plus, "New tab", 0),
            button("split-pane-right", Glyph::PanelLeft, "Split right", 1),
            button("split-pane-down", Glyph::PanelsTopLeft, "Split below", 2),
            button("reopen-pane", Glyph::RotateCcw, "Reopen closed tab", 4),
            button("close-pane-tab", Glyph::X, "Close tab", 3).disabled(self.record.pinned),
        ])
    }
}
impl Render for ContentPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if matches!(self.body, Body::Unloaded)
            && (self.record.kind == "chat"
                || (self.record.kind == "terminal" && self.record.content_id.is_some()))
        {
            let kind = self.record.kind.clone();
            self.launch(&kind, window, cx);
        }
        let content = match &self.body {
            Body::Chat(chat) => chat.clone().into_any_element(),
            Body::Browser(panel) => {
                panel.update(cx, |p, cx| {
                    p.set_active(!self.overlay_hidden && !cx.has_active_drag(), window, cx)
                });
                panel.clone().into_any_element()
            }
            Body::Terminal(panel) => {
                panel.update(cx, |p, cx| {
                    p.set_active(!self.overlay_hidden && !cx.has_active_drag(), window, cx)
                });
                panel.clone().into_any_element()
            }
            Body::Unloaded => {
                let resume = self.record.kind == "browser" || self.record.kind == "terminal";
                v_flex()
                    .size_full()
                    .justify_center()
                    .items_center()
                    .gap_3()
                    .p_5()
                    .child(ui::panel_title(if resume {
                        "Resume this pane"
                    } else {
                        "Start something here"
                    }))
                    .child(ui::description("Choose what this pane should open."))
                    .children(
                        [
                            ("chat", Glyph::MessageSquare, "Conversation"),
                            ("terminal", Glyph::Terminal, "Terminal"),
                            ("browser", Glyph::Globe, "Browser"),
                        ]
                        .into_iter()
                        .map(|(kind, icon, label)| {
                            ui::button(kind)
                                .outline()
                                .w(px(220.))
                                .icon(icon)
                                .label(label)
                                .child(div().flex_1())
                                .on_click(cx.listener(move |this, event, window, cx| {
                                    this.feedback.begin(
                                        !matches!(event, ClickEvent::Keyboard(_)),
                                        cx.reduce_motion(),
                                    );
                                    this.launch(kind, window, cx);
                                    this.on_focus_requested(window, cx);
                                }))
                        }),
                    )
                    .into_any_element()
            }
        };
        let owner = self.owner.clone();
        let id = self.record.id.clone();
        v_flex()
            .size_full()
            .when_some(self.rename.clone(), |root, input| {
                root.child(
                    h_flex()
                        .gap_2()
                        .p_2()
                        .child(ui::field_label("Tab name"))
                        .child(Input::new(&input))
                        .child(
                            ui::button("save-tab-name")
                                .label("Save")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    let value = this
                                        .rename
                                        .take()
                                        .map(|input| {
                                            input
                                                .read(cx)
                                                .value()
                                                .trim()
                                                .chars()
                                                .take(256)
                                                .collect::<String>()
                                        })
                                        .unwrap_or_default();
                                    this.record.title = (!value.is_empty()).then_some(value);
                                    let owner = this.owner.clone();
                                    cx.defer(move |cx| {
                                        let _ = owner.update(cx, |host, cx| host.changed(cx));
                                    });
                                    cx.notify();
                                })),
                        )
                        .child(ui::button("cancel-tab-name").label("Cancel").on_click(
                            cx.listener(|this, _, _, cx| {
                                this.rename = None;
                                cx.notify();
                            }),
                        )),
                )
            })
            .track_focus(&self.focus)
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                let _ = owner.update(cx, |host, cx| {
                    if host.active.as_ref() != Some(&id) {
                        host.active = Some(id.clone());
                        host.changed(cx);
                    }
                });
            })
            .child(div().flex_1().min_h_0().w_full().child(content))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    use std::sync::Arc;
    fn records() -> (WorkspaceRecord, WindowRecord) {
        let workspace = WorkspaceRecord {
            id: "test-workspace".into(),
            name: "Test".into(),
            root: "/tmp".into(),
            repository_id: None,
            terminal_id: "test-terminal".into(),
            extra_terminals: vec![],
            needs_rebind: false,
            worktree_lifecycle_needs_rebind: false,
        };
        let window = WindowRecord {
            id: "test-window".into(),
            workspace_id: workspace.id.clone(),
            conversation_id: None,
            browser_url: String::new(),
            x: 0.,
            y: 0.,
            width: 1000.,
            height: 700.,
            tabs: Default::default(),
            panes: Default::default(),
            focused_pane: 2,
            dock_layout: None,
        };
        (workspace, window)
    }
    #[gpui::test]
    fn draft_response_uses_owning_window_after_previous_window_closes(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (chat, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Workspace::new(record, workspace, false, true, shared, window, cx)
        });
        visual.run_until_parked();
        visual.update(|window, cx| {
            window.draw(cx).clear(cx);
        });
        struct Destination;
        impl Render for Destination {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
            }
        }
        let destination = visual.update(|window, cx| {
            let next = cx
                .open_window(Default::default(), |_, cx| cx.new(|_| Destination))
                .unwrap();
            window.remove_window();
            next
        });
        let (tx, rx) = async_channel::bounded(1);
        destination
            .update(visual, |_, window, cx| {
                chat.update(cx, |chat, cx| {
                    chat.record.conversation_id = Some("initial-chat".into());
                    chat.draft_generation += 1;
                    chat.draft_load = crate::draft_ui::LoadState::Loading;
                    chat.receive_draft(
                        rx,
                        "initial-chat".into(),
                        chat.draft_generation,
                        window,
                        cx,
                    );
                });
            })
            .unwrap();
        tx.try_send(Ok(
            json!({"draft":{"revision":0,"text":"","attachments":[]}}),
        ))
        .unwrap();
        visual.run_until_parked();
        chat.read_with(visual, |chat, _| {
            assert!(
                !chat.draft_load.blocked(),
                "valid initial draft completion must not be silently dropped"
            )
        });
        // A cached draft or empty selection needs no transport, but must still
        // release the prior load's completion receiver.
        for empty_selection in [false, true] {
            let (obsolete_tx, obsolete_rx) = async_channel::bounded(1);
            destination
                .update(visual, |_, window, cx| {
                    chat.update(cx, |chat, cx| {
                        chat.receive_draft(
                            obsolete_rx,
                            "initial-chat".into(),
                            chat.draft_generation,
                            window,
                            cx,
                        );
                        chat.record.conversation_id = if empty_selection {
                            None
                        } else {
                            Some("initial-chat".into())
                        };
                        chat.load_draft(window, cx);
                        chat.record.conversation_id = Some("initial-chat".into());
                    });
                })
                .unwrap();
            visual.run_until_parked();
            assert!(
                obsolete_tx.is_closed(),
                "local draft restoration keeps an obsolete load waiter"
            );
        }
        let (stale_tx, stale_rx) = async_channel::bounded(1);
        destination
            .update(visual, |_, window, cx| {
                chat.update(cx, |chat, cx| {
                    chat.receive_draft_resolution(
                        stale_rx,
                        "initial-chat".into(),
                        chat.draft_generation,
                        window,
                        cx,
                    );
                    chat.draft_generation += 1;
                })
            })
            .unwrap();
        stale_tx
            .try_send(Ok(
                json!({"draft":{"revision":4,"text":"stale text","attachments":[]}}),
            ))
            .unwrap();
        visual.run_until_parked();
        chat.read_with(visual, |chat, cx| {
            assert!(
                !chat.pending,
                "completion releases its existing action after selection changes"
            );
            assert_eq!(chat.composer.read(cx).value().as_ref(), "");
        });
        let (current_tx, current_rx) = async_channel::bounded(1);
        destination
            .update(visual, |_, window, cx| {
                chat.update(cx, |chat, cx| {
                    chat.receive_draft_resolution(
                        current_rx,
                        "initial-chat".into(),
                        chat.draft_generation,
                        window,
                        cx,
                    );
                })
            })
            .unwrap();
        current_tx
            .try_send(Ok(
                json!({"draft":{"revision":5,"text":"resolved text","attachments":[]}}),
            ))
            .unwrap();
        visual.run_until_parked();
        chat.read_with(visual, |chat, cx| {
            assert!(!chat.pending);
            assert_eq!(chat.composer.read(cx).value().as_ref(), "resolved text");
        });
        let (late_tx, late_rx) = async_channel::bounded(1);
        let (resolution_tx, resolution_rx) = async_channel::bounded(1);
        destination
            .update(visual, |_, window, cx| {
                chat.update(cx, |chat, cx| {
                    chat.receive_draft(
                        late_rx,
                        "initial-chat".into(),
                        chat.draft_generation,
                        window,
                        cx,
                    );
                    chat.receive_draft_resolution(
                        resolution_rx,
                        "initial-chat".into(),
                        chat.draft_generation,
                        window,
                        cx,
                    );
                })
            })
            .unwrap();
        let weak = chat.downgrade();
        destination
            .update(visual, |_, window, _| window.remove_window())
            .unwrap();
        drop(chat);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(
            weak.upgrade().is_none(),
            "pending draft responses must not retain disposed editors"
        );
        assert!(
            late_tx.is_closed(),
            "disposed editor retains its draft-load waiter"
        );
        assert!(
            resolution_tx.is_closed(),
            "disposed editor retains its draft-resolution waiter"
        );
        let _ = late_tx.try_send(Ok(
            json!({"draft":{"revision":6,"text":"late","attachments":[]}}),
        ));
        visual.run_until_parked();
    }

    #[gpui::test]
    fn admitted_attachment_survives_pane_close_and_guards_window_close(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let state = shared.clone();
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        let (tx, rx) = async_channel::bounded(1);
        let weak = host.update_in(cx, |host, window, cx| {
            let panel = host.active_panel().unwrap();
            let (record, workspace, shared) = panel.read_with(cx, |panel, _| {
                (
                    panel.chat_record(),
                    panel.workspace.clone(),
                    panel.shared.clone(),
                )
            });
            let chat =
                cx.new(|cx| Workspace::new(record, workspace, false, true, shared, window, cx));
            chat.update(cx, |chat, cx| {
                chat.draft_load = crate::draft_ui::LoadState::Ready;
                chat.record.conversation_id = Some("import-origin".into());
                chat.drafts.insert(
                    "import-origin".into(),
                    ade_core::model::Draft {
                        text: "latest editor text".into(),
                        revision: 4,
                        attachments: vec![],
                    },
                );
                chat.receive_attachment_import(
                    "import-origin".into(),
                    async move { rx.recv().await.unwrap() },
                    cx,
                );
                // Selection can change while an admitted mutation is running.
                chat.record.conversation_id = Some("new-selection".into());
            });
            let weak = chat.downgrade();
            panel.update(cx, |panel, _| panel.body = Body::Chat(chat));
            host.close_active(window, cx);
            assert!(matches!(panel.read(cx).body, Body::Unloaded));
            assert!(
                host.drafts_for_close(true, cx)
                    .unwrap_err()
                    .contains("attachment import")
            );
            weak
        });
        cx.run_until_parked();
        assert!(
            weak.upgrade().is_some(),
            "the admitted import retains its original editor"
        );
        tx.try_send((
            vec![ade_core::model::Attachment {
                id: "imported-file".into(),
                name: "notes.txt".into(),
                media_type: "text/plain".into(),
                size: 10,
            }],
            None,
        ))
        .unwrap();
        cx.run_until_parked();
        assert!(
            weak.upgrade().is_none(),
            "completion releases the closed editor"
        );
        host.update(cx, |host, cx| {
            host.drafts_for_close(true, cx).unwrap();
        });
        let saved = crate::client_state::retry_payloads_for_test(&state, &record.id);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["conversation_id"], "import-origin");
        assert_eq!(saved[0]["text"], "latest editor text");
        assert_eq!(saved[0]["revision"], 5);
        assert_eq!(saved[0]["attachments"][0]["id"], "imported-file");
    }

    #[gpui::test]
    fn close_capture_does_not_submit_untouched_revision_zero_draft(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let state = shared.clone();
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        host.update_in(cx, |host, window, cx| {
            let panel = host.active_panel().unwrap();
            let (record, workspace, shared) = panel.read_with(cx, |panel, _| {
                (
                    panel.chat_record(),
                    panel.workspace.clone(),
                    panel.shared.clone(),
                )
            });
            let chat =
                cx.new(|cx| Workspace::new(record, workspace, false, true, shared, window, cx));
            chat.update(cx, |chat, _| {
                chat.record.conversation_id = Some("fresh-conversation".into());
                chat.drafts
                    .insert("fresh-conversation".into(), Default::default());
                chat.draft_load = crate::draft_ui::LoadState::Ready;
            });
            panel.update(cx, |panel, _| panel.body = Body::Chat(chat));
            let snapshot = host.drafts_for_close(true, cx).unwrap();
            assert!(snapshot.to_string().contains("fresh-conversation"));
        });
        assert!(
            crate::client_state::retry_payloads_for_test(&state, &record.id).is_empty(),
            "the real close capture path must not enqueue a pristine revision-zero draft"
        );
        let pending = json!({"op":"draft.save","window_id":record.id,
            "conversation_id":"fresh-conversation","revision":3,"text":"retained conflict","attachments":[]});
        crate::client_state::retain_draft_for_test(&state, pending.clone());
        host.update(cx, |host, cx| {
            host.drafts_for_close(true, cx).unwrap();
        });
        assert_eq!(
            crate::client_state::retry_payloads_for_test(&state, &record.id),
            vec![pending],
            "skipping a pristine draft must not acknowledge unrelated retained text or conflicts"
        );
    }

    #[gpui::test]
    fn chat_constructor_keeps_shell_draft_owner_across_teardown(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let expected_window = record.id.clone();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let state = shared.clone();
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        let constructed = host.update(cx, |host, cx| {
            let panel = host.active_panel().unwrap();
            panel.update(cx, |panel, _| {
                panel.record.content_id = Some("conversation".into());
                panel.chat_record()
            })
        });
        assert_eq!(constructed.id, expected_window);
        let payload = json!({"op":"draft.save", "window_id":constructed.id,
            "conversation_id":constructed.conversation_id, "revision":8,"text":"retained editor text","attachments":[]});
        crate::client_state::retain_draft_for_test(&state, payload.clone());
        host.update_in(cx, |host, window, cx| host.close_active(window, cx));
        assert_eq!(
            crate::client_state::retry_payloads_for_test(&state, &expected_window),
            vec![payload]
        );
        host.update_in(cx, |host, window, cx| host.reopen_closed(window, cx));
        let reopened = host.read_with(cx, |host, cx| {
            host.active_panel().unwrap().read(cx).chat_record()
        });
        assert_eq!(reopened.id, expected_window);
        let retained = crate::client_state::unsaved_draft(&state, &reopened.id, "conversation");
        let restored = crate::client_state::restored_draft(Default::default(), None, retained);
        assert_eq!(restored.text, "retained editor text");
        assert_eq!(restored.revision, 8);
        // A delayed daemon response cannot replace this newer editor state.
        assert_eq!(
            crate::client_state::restored_draft(Default::default(), Some(&restored), None).text,
            restored.text
        );
    }
    #[gpui::test]
    fn generated_dock_operations_preserve_owned_panel_tree(cx: &mut TestAppContext) {
        use proptest::{
            prelude::*,
            test_runner::{Config, TestRunner},
        };
        use std::cell::RefCell;
        let context = RefCell::new(cx);
        let mut runner = TestRunner::new(Config {
            cases: 48,
            max_shrink_iters: 2048,
            ..Config::default()
        });
        runner.run(&proptest::collection::vec(0u8..7, 1..48), |operations| {
            let mut context = context.borrow_mut();
            let (workspace, record) = records();
            let shared = Arc::new(crate::client_state::ClientState::default());
            let (host, cx) = context.add_window_view(|window, cx| {
                gpui_kit::init(cx);
                ui::install(cx);
                DockHost::new(shared, workspace, &record, window, cx)
            });
            cx.run_until_parked();
            for (step, operation) in operations.iter().enumerate() {
                host.update_in(cx, |host, window, cx| match operation {
                    0 => host.new_tab(window, cx),
                    1 => host.split_right(window, cx),
                    2 => host.split_down(window, cx),
                    3 => host.close_active(window, cx),
                    4 => host.reopen_closed(window, cx),
                    5 => host.toggle_zoom(window, cx),
                    _ => host.focus_cycle(1, window, cx),
                });
                cx.run_until_parked();
                let (mut live, mut leaves, active_valid, bounded) = host.read_with(cx, |host, cx| {
                    fn collect(node: &PanelState, ids: &mut Vec<String>) {
                        if let PanelInfo::Panel(record) = &node.info
                            && let Some(id) = record["id"].as_str() { ids.push(id.to_owned()); }
                        for child in &node.children { collect(child, ids); }
                    }
                    let mut leaves = Vec::new();
                    collect(&host.area.read(cx).dump(cx).center, &mut leaves);
                    (host.panels.keys().cloned().collect::<Vec<_>>(), leaves,
                     host.active.as_ref().is_none_or(|id| host.panels.contains_key(id)),
                     !host.panels.is_empty() && host.panels.len() <= MAX_PANELS && host.closed.len() <= MAX_PANELS)
                });
                live.sort(); leaves.sort();
                prop_assert_eq!(&live, &leaves, "step {} operation {}: every live panel occurs exactly once in saved layout", step, operation);
                prop_assert!(active_valid, "step {} operation {}: active points to a live panel", step, operation);
                prop_assert!(bounded, "step {} operation {}: bounded nonempty ownership", step, operation);
            }
            cx.update(|window, _| window.remove_window());
            Ok(())
        }).unwrap();
    }

    #[gpui::test]
    fn closing_active_tab_returns_to_previous_visited_tab_in_group(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        cx.run_until_parked();
        let first = host.read_with(cx, |host, _| host.active_panel().unwrap());
        host.update_in(cx, |host, window, cx| host.new_tab(window, cx));
        cx.run_until_parked();
        host.update_in(cx, |host, window, cx| host.new_tab(window, cx));
        cx.run_until_parked();
        let third = host.read_with(cx, |host, _| host.active_panel().unwrap());
        for panel in [&first, &third] {
            host.update_in(cx, |host, window, cx| {
                host.area.update(cx, |area, cx| {
                    area.select_panel(PanelId::from(panel.entity_id()), window, cx)
                })
            });
            cx.run_until_parked();
        }
        host.update_in(cx, |host, window, cx| host.close_active(window, cx));
        cx.run_until_parked();
        assert_eq!(
            host.read_with(cx, |host, _| host.active_panel().unwrap()),
            first
        );
    }
    #[gpui::test]
    fn pinned_tabs_survive_bulk_close_and_existing_tab_split(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        cx.run_until_parked();
        host.update_in(cx, |host, window, cx| {
            host.tab_action("pin", window, cx);
            let pinned = host.active_panel().unwrap();
            host.close_active(window, cx);
            assert_eq!(host.panels.len(), 1);
            host.new_tab(window, cx);
            host.new_tab(window, cx);
            host.tab_action("close-others", window, cx);
            assert!(host.panels.values().any(|p| p == &pinned));
        });
        cx.run_until_parked();
        host.update_in(cx, |host, window, cx| {
            assert_eq!(host.panels.len(), 2);
            let panel = host.active_panel().unwrap();
            for placement in [
                Placement::Left,
                Placement::Right,
                Placement::Top,
                Placement::Bottom,
            ] {
                host.move_to_split(placement, window, cx);
                assert_eq!(host.active_panel().unwrap(), panel);
            }
            panel.update(cx, |p, _| {
                p.record.title = Some("My pane".into());
                p.record.color = Some(0x94b59b);
            });
            assert_eq!(panel.read(cx).label(cx).as_ref(), "My pane");
            assert_eq!(
                panel.read(cx).tab_name(cx),
                None,
                "custom icon/color title must render"
            );
            assert_eq!(
                panel.read(cx).tab_aria_label(cx).unwrap().as_ref(),
                "My pane"
            );
            let saved = panel.read(cx).saved_record(cx);
            assert_eq!(saved.color, Some(0x94b59b));
        });
    }
    #[gpui::test]
    fn rendered_pointer_drag_splits_a_tab_without_recreating_panels(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        host.update_in(cx, |host, window, cx| host.new_tab(window, cx));
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let before_nodes = host.read_with(cx, |host, cx| {
            host.area
                .read(cx)
                .layout(DockPlacement::Center)
                .unwrap()
                .node_ids()
                .len()
        });
        let mut entities = host.read_with(cx, |host, _| {
            host.panels
                .values()
                .map(|panel| panel.entity_id())
                .collect::<Vec<_>>()
        });
        entities.sort();
        let viewport = cx.update(|window, _| window.viewport_size());
        let source = point(px(32.), px(16.));
        let destination = point(viewport.width - px(40.), viewport.height / 2.);
        cx.simulate_mouse_down(source, MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_move(
            source + point(px(14.), px(4.)),
            MouseButton::Left,
            Modifiers::none(),
        );
        cx.run_until_parked();
        cx.simulate_mouse_move(destination, MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        cx.simulate_mouse_up(destination, MouseButton::Left, Modifiers::none());
        cx.run_until_parked();
        host.read_with(cx, |host, cx| {
            assert!(
                host.area
                    .read(cx)
                    .layout(DockPlacement::Center)
                    .unwrap()
                    .node_ids()
                    .len()
                    > before_nodes,
                "pointer drop splits the group; tab selection alone is insufficient"
            );
            let mut after = host
                .panels
                .values()
                .map(|panel| panel.entity_id())
                .collect::<Vec<_>>();
            after.sort();
            assert_eq!(
                after, entities,
                "drag retains both existing content entities"
            );
        });
    }
    #[gpui::test]
    fn rendered_tabs_split_close_reopen_keep_independent_entities(cx: &mut TestAppContext) {
        let (workspace, record) = records();
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        cx.run_until_parked();
        let first = host.read_with(cx, |h, _| h.active_panel().unwrap().entity_id());
        host.update_in(cx, |h, window, cx| h.new_tab(window, cx));
        cx.run_until_parked();
        assert_eq!(host.read_with(cx, |h, _| h.panels.len()), 2);
        host.update_in(cx, |h, window, cx| h.split_right(window, cx));
        cx.run_until_parked();
        assert_eq!(host.read_with(cx, |h, _| h.panels.len()), 3);
        host.update_in(cx, |h, window, cx| h.toggle_zoom(window, cx));
        cx.run_until_parked();
        assert!(host.read_with(cx, |h, cx| h.area.read(cx).is_zoomed()));
        host.update_in(cx, |h, window, cx| h.toggle_zoom(window, cx));
        cx.run_until_parked();
        assert!(!host.read_with(cx, |h, cx| h.area.read(cx).is_zoomed()));
        host.read_with(cx, |h, cx| {
            assert!(h.panels.values().any(|p| p.entity_id() == first));
            assert_eq!(
                h.area
                    .read(cx)
                    .layout(DockPlacement::Center)
                    .unwrap()
                    .node_ids()
                    .len(),
                3
            );
            assert!(
                h.panels
                    .values()
                    .all(|p| matches!(p.read(cx).body, Body::Unloaded))
            );
        });
        host.update_in(cx, |h, window, cx| h.close_active(window, cx));
        cx.run_until_parked();
        assert_eq!(host.read_with(cx, |h, _| h.panels.len()), 2);
        host.update_in(cx, |h, window, cx| h.reopen_closed(window, cx));
        cx.run_until_parked();
        assert_eq!(host.read_with(cx, |h, _| h.panels.len()), 3);
        for _ in 0..3 {
            host.update_in(cx, |h, window, cx| h.close_active(window, cx));
            cx.run_until_parked();
        }
        host.read_with(cx, |h, cx| {
            assert_eq!(h.panels.len(), 1);
            assert_eq!(h.active_panel().unwrap().read(cx).record.kind, "empty");
        });
    }
    #[gpui::test]
    fn restored_browser_is_unloaded_and_unknown_content_has_launcher(cx: &mut TestAppContext) {
        let (workspace, mut record) = records();
        let browser = ContentRecord {
            kind: "browser".into(),
            content_id: Some("https://example.com".into()),
            ..ContentRecord::empty()
        };
        let unknown = ContentRecord {
            kind: "unknown".into(),
            ..ContentRecord::empty()
        };
        record.dock_layout = Some(
            json!({"dock":{"version":1,"center":{"panel_name":"TabPanel","info":{"tabs":{"active_index":0}},"children":[{"panel_name":"ade.content","children":[],"info":{"panel":browser}},{"panel_name":"ade.content","children":[],"info":{"panel":unknown}}]}}}),
        );
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        cx.run_until_parked();
        host.read_with(cx, |h, cx| {
            assert_eq!(h.panels.len(), 2);
            assert!(
                h.panels
                    .values()
                    .all(|p| matches!(p.read(cx).body, Body::Unloaded))
            );
            assert!(
                h.panels
                    .values()
                    .any(|p| p.read(cx).record.kind == "browser")
            );
            assert!(!h.notice.is_empty());
        });
    }
    #[gpui::test]
    fn empty_persisted_split_recovers_to_one_launcher(cx: &mut TestAppContext) {
        let (workspace, mut record) = records();
        record.dock_layout = Some(
            json!({"dock":{"version":1,"center":{"panel_name":"SplitPanel","children":[],"info":{"stack":{"axis":0,"sizes":[]}}}}}),
        );
        let shared = Arc::new(crate::client_state::ClientState::default());
        let (host, cx) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            DockHost::new(shared, workspace, &record, window, cx)
        });
        cx.run_until_parked();
        host.read_with(cx, |h, cx| {
            assert_eq!(h.panels.len(), 1);
            assert_eq!(h.active_panel().unwrap().read(cx).record.kind, "empty");
            assert!(!h.notice.is_empty());
        });
    }
}
