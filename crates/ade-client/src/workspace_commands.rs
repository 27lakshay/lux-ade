use super::*;
impl Workspace {
    pub(crate) fn focus_pane(&mut self, pane: u32, window: &mut Window, cx: &mut Context<Self>) {
        if pane == 3 || pane == 4 {
            self.last_tab_browser = pane == 4;
        }
        let pane = if (pane == 3 && self.record.tabs.active_terminal.is_none())
            || (pane == 4 && self.record.tabs.active_browser.is_none())
        {
            5
        } else {
            pane
        };
        unsafe { crate::command_bridge::ade_focus_parent(self.native_parent) };
        match pane {
            1 => {
                self.record.panes.sidebar_visible = true;
                self.folder.read(cx).focus_handle(cx).focus(window, cx);
            }
            2 => self.conversation_focus.focus(window, cx),
            3 => {
                window.blur(cx);
                self.record.panes.terminal_visible = true;
                if self.record.tabs.active_terminal.is_some() {
                    self.terminal.set_visible(true);
                    cx.defer_in(window, |this, _, _| {
                        if this.last_focus == 3 {
                            this.terminal.focus();
                        }
                    });
                }
            }
            4 => {
                window.blur(cx);
                self.record.panes.browser_visible = true;
                if self.record.tabs.active_browser.is_some() {
                    if let Some(browser) = &self.browser {
                        browser.update(cx, |b, _| b.show());
                    }
                    cx.defer_in(window, |this, _, cx| {
                        if this.last_focus == 4
                            && let Some(browser) = &this.browser
                        {
                            browser.update(cx, |b, _| {
                                let _ = b.raw().focus();
                            });
                        }
                    });
                }
            }
            _ => self.composer.read(cx).focus_handle(cx).focus(window, cx),
        }
        self.last_focus = pane;
        self.save(cx);
        cx.notify();
    }
    pub(crate) fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        // Dock-owned commands must not materialize legacy sibling native panes.
        let shell_owned = [
            "pane.",
            "tab.",
            "browser.",
            "terminal.",
            "sidebar.",
            "window.",
            "layout.",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
            || matches!(
                id,
                "workspace.open"
                    | "focus.sidebar"
                    | "focus.terminal"
                    | "focus.browser"
                    | "focus.next"
                    | "focus.previous"
            );
        if shell_owned && let Some(sender) = &self.shell_commands {
            if sender.try_send(id.to_owned()).is_err() {
                self.shared.data.lock().unwrap().error = "Workspace shell is unavailable.".into();
                cx.notify();
            }
            return;
        }
        let native = unsafe { crate::command_bridge::ade_focus_kind(self.native_parent) };
        if native != 0 {
            self.last_focus = native;
        } else if self.folder.read(cx).focus_handle(cx).is_focused(window) {
            self.last_focus = 1;
        } else if self.composer.read(cx).focus_handle(cx).is_focused(window) {
            self.last_focus = 5;
        } else if self.conversation_focus.is_focused(window) {
            self.last_focus = 2;
        }
        if native == 3 || native == 4 {
            self.last_tab_browser = native == 4;
        } else if self.address.read(cx).focus_handle(cx).is_focused(window) {
            self.last_tab_browser = true;
        }
        let browser = self.last_tab_browser;
        match id {
            "palette"|"shortcuts"=>{if let Err(error)=crate::command_ui::open(cx.weak_entity(),window,id=="shortcuts",cx){self.shared.data.lock().unwrap().error=error.to_string();}},
            "workspace.open"|"focus.sidebar"=>self.focus_pane(1,window,cx),
            "focus.conversation"=>self.focus_pane(2,window,cx),
            "focus.composer"=>self.focus_pane(5,window,cx),
            "focus.terminal"=>self.focus_pane(3,window,cx),
            "focus.browser"=>self.focus_pane(4,window,cx),
            "focus.next"|"focus.previous"=>{
                let panes=[1,2,5,3,4];let i=panes.iter().position(|p|*p==self.last_focus).unwrap_or(0);
                let next=if id=="focus.next"{(i+1)%panes.len()}else{(i+panes.len()-1)%panes.len()};self.focus_pane(panes[next],window,cx);
            },
            "sidebar.toggle"=>{self.record.panes.sidebar_visible= !self.record.panes.sidebar_visible;if self.record.panes.sidebar_visible{self.focus_pane(1,window,cx)}else{self.focus_pane(5,window,cx)}},
            "terminal.toggle"=>{self.record.panes.terminal_visible= !self.record.panes.terminal_visible;if self.record.panes.terminal_visible{self.focus_pane(3,window,cx)}else{self.terminal.set_visible(false);self.focus_pane(5,window,cx)}},
            "browser.toggle"=>{self.record.panes.browser_visible= !self.record.panes.browser_visible;if self.record.panes.browser_visible{self.focus_pane(4,window,cx)}else{if let Some(browser)=&self.browser{browser.update(cx,|b,_|b.hide());}self.focus_pane(5,window,cx)}},
            "terminal.new"=>self.new_terminal_tab(cx),
            "browser.new"=>{self.last_focus=4;self.new_browser_tab(window,cx)},
            "terminal.close"=>self.close_tab(false,window,cx),"browser.close"=>self.close_tab(true,window,cx),
            "terminal.reopen"=>self.reopen_tab(false,window,cx),"browser.reopen"=>self.reopen_tab(true,window,cx),
            "tab.close"=>self.close_tab(browser,window,cx),"tab.reopen"=>self.reopen_tab(browser,window,cx),
            "tab.left"=>self.move_tab(browser,-1,cx),"tab.right"=>self.move_tab(browser,1,cx),
            "tab.next"|"tab.previous"=>{
                let (ids,active):(Vec<_>,_)=if browser{(self.record.tabs.browsers.iter().map(|t|t.id.clone()).collect(),self.record.tabs.active_browser.clone())}else{(self.record.tabs.terminals.iter().filter(|t|t.workspace_id==self.workspace.id).map(|t|t.id.clone()).collect(),self.record.tabs.active_terminal.clone())};
                if !ids.is_empty(){let i=ids.iter().position(|id|Some(id)==active.as_ref()).unwrap_or(0);let next=if id=="tab.next"{(i+1)%ids.len()}else{(i+ids.len()-1)%ids.len()};if browser{self.select_browser_tab(&ids[next],window,cx)}else{self.select_terminal_tab(&ids[next],window,cx)}}
            },
            "terminal.restart"=>self.request(json!({"op":"terminal.restart","workspace_id":self.workspace.id,"terminal_id":self.record.tabs.active_terminal}),false,false,cx),
            "terminal.stop" | "terminal.retire" => self.request(json!({"op":id,"workspace_id":self.workspace.id,"terminal_id":self.record.tabs.active_terminal}),false,false,cx),
            "window.new"=>{let mut record=self.record.clone();record.id=new_id("window");record.x+=35.;record.y+=35.;crate::bootstrap::open_workspace(true,self.shared.clone(),Some(record),self.persist,cx);},
            "conversation.new"=>{let mut config=self.new_config.clone();let model=self.provider_model.read(cx).value().to_string();config.model=if model.trim().is_empty(){None}else{Some(model.trim().into())};self.request(json!({"op":"conversation.create","workspace_id":self.workspace.id,"provider":self.new_provider,"provider_config":config}),true,false,cx);},
            "changes"=>{if let Err(error)=review_ui::open(self.workspace.id.clone(),self.workspace.root.clone(),cx){self.shared.data.lock().unwrap().error=error.to_string();}},
            "worktrees"=>{if let Err(error)=worktree_ui::open(self.shared.clone(),self.workspace.root.clone(),cx){self.shared.data.lock().unwrap().error=error.to_string();}},
            "services"=>{if let Err(error)=crate::service_ui::open(self.shared.clone(),self.workspace.clone(),cx.weak_entity(),window,cx){self.shared.data.lock().unwrap().error=error.to_string();}},
            "runtime"=>{if let Err(error)=recovery_ui::open(self.shared.clone(),cx){self.shared.data.lock().unwrap().error=error.to_string();}},
            "layout.reset"=>{self.record.panes=Default::default();self.layout_generation+=1;},
            "sidebar.grow"|"sidebar.shrink"=>{let delta=if id.ends_with("grow"){24.}else{-24.};self.record.panes.sidebar_width=(self.record.panes.sidebar_width+delta).clamp(180.,360.);self.layout_generation+=1;},
            "browser.grow"|"browser.shrink"=>{let delta=if id.ends_with("grow"){24.}else{-24.};self.record.panes.browser_width=(self.record.panes.browser_width+delta).clamp(240.,600.);self.layout_generation+=1;},
            "terminal.grow"|"terminal.shrink"=>{let delta=if id.ends_with("grow"){24.}else{-24.};self.record.panes.terminal_height=(self.record.panes.terminal_height+delta).clamp(120.,600.);self.layout_generation+=1;},
            _=>{}
        }
        self.save(cx);
        cx.notify();
    }
}
