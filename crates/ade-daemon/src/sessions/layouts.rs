//! `window.*` and `layout.*`: windows and their layouts, stored by
//! `store::layouts`, and their `window_changed`, `layout_changed` and
//! `layout_removed` feed frames.
use super::*;
use crate::store::layouts::{LayoutChange, WindowChange, WorkspaceRemoval};
use ade_core::contract::layout::{
    LayoutApplied, LayoutApplyRequest, LayoutGetRequest, LayoutRecord, LayoutReply, Window,
    WindowAck, WindowCloseRequest, WindowCreateRequest, WindowList, WindowListRequest,
    WindowReopenRequest, WindowSetBoundsRequest, WindowSetViewStateRequest,
    WindowShowWorkspaceRequest, WindowState,
};

pub(super) fn handles(op: &str) -> bool {
    op.starts_with("window.") || op.starts_with("layout.")
}

impl Sessions {
    pub(super) fn layout_command(&self, request: &Value) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        match request["op"].as_str().unwrap_or("") {
            "window.list" => {
                let WindowListRequest {} = decode(request)?;
                reply(&WindowList {
                    tag: Default::default(),
                    windows: d.store.windows()?,
                })
            }
            "window.create" => {
                let create: WindowCreateRequest = decode(request)?;
                let change = persistence_result(d.store.create_window(
                    &create.window_id,
                    &create.workspace_id,
                    create.bounds,
                ))?;
                self.window_reply(&mut d, change)
            }
            "window.close" => {
                let close: WindowCloseRequest = decode(request)?;
                let change = persistence_result(
                    d.store
                        .set_window_state(&close.window_id, WindowState::Closed),
                )?;
                self.window_reply(&mut d, change)
            }
            "window.reopen" => {
                let reopen: WindowReopenRequest = decode(request)?;
                let change = persistence_result(
                    d.store
                        .set_window_state(&reopen.window_id, WindowState::Open),
                )?;
                self.window_reply(&mut d, change)
            }
            "window.set_bounds" => {
                let set: WindowSetBoundsRequest = decode(request)?;
                let change =
                    persistence_result(d.store.set_window_bounds(&set.window_id, set.bounds))?;
                self.window_reply(&mut d, change)
            }
            "window.show_workspace" => {
                let show: WindowShowWorkspaceRequest = decode(request)?;
                let change = persistence_result(
                    d.store.show_workspace(&show.window_id, &show.workspace_id),
                )?;
                self.window_reply(&mut d, change)
            }
            "window.set_view_state" => {
                let set: WindowSetViewStateRequest = decode(request)?;
                let change = persistence_result(
                    d.store
                        .set_window_view(&set.window_id, &set.collapsed_projects),
                )?;
                self.window_reply(&mut d, change)
            }
            "layout.get" => {
                let get: LayoutGetRequest = decode(request)?;
                reply(&LayoutReply {
                    tag: Default::default(),
                    layout: d
                        .store
                        .layout(&get.window_id, get.workspace_id.as_deref())?,
                })
            }
            "layout.apply" => {
                let apply: LayoutApplyRequest = decode(request)?;
                let change = persistence_result(d.store.apply_layout(
                    &apply.window_id,
                    apply.workspace_id.as_deref(),
                    &apply.action,
                    apply.expected_revision,
                ))?;
                self.layout_reply(&mut d, change)
            }
            _ => bail!("Unknown session operation"),
        }
    }

    /// For `tab.close` and `pane.close`: the shell terminals, running or
    /// not, whose last tab across every window's layouts `action` removes.
    pub fn closing_shells(
        &self,
        window_id: &str,
        workspace_id: Option<&str>,
        action: &ade_core::contract::layout::LayoutAction,
    ) -> Result<Vec<String>> {
        self.data
            .lock()
            .unwrap()
            .store
            .closing_shells(window_id, workspace_id, action)
    }

    fn window_reply(&self, d: &mut Data, change: WindowChange) -> Result<Value> {
        if change.changed {
            self.windows_changed(d, std::slice::from_ref(&change.window));
        }
        reply(&WindowAck {
            tag: Default::default(),
            window: change.window,
        })
    }

    fn layout_reply(&self, d: &mut Data, change: LayoutChange) -> Result<Value> {
        if change.stored {
            self.layouts_changed(d, std::slice::from_ref(&change.layout));
        }
        reply(&LayoutApplied {
            tag: Default::default(),
            layout: change.layout,
            changed: change.changed,
        })
    }

    pub(super) fn windows_changed(&self, d: &mut Data, windows: &[Window]) {
        for window in windows {
            self.publish(d, json!({"type": "window_changed", "window": window}));
        }
    }

    /// Publishes each layout that changed, as `store::layouts::remove_target`
    /// returns them.
    pub(super) fn layouts_changed(&self, d: &mut Data, layouts: &[LayoutRecord]) {
        for layout in layouts {
            self.publish(d, json!({"type": "layout_changed", "layout": layout}));
        }
    }

    pub(super) fn workspace_layouts_removed(&self, d: &mut Data, removal: &WorkspaceRemoval) {
        for (window_id, workspace_id) in &removal.layouts {
            self.publish(
                d,
                json!({"type": "layout_removed", "window_id": window_id, "workspace_id": workspace_id}),
            );
        }
        self.windows_changed(d, &removal.windows);
        self.layouts_changed(d, &removal.shown);
    }
}
