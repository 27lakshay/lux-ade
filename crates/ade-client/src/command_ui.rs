use super::*;
use crate::commands::{Bindings, COMMANDS};
use gpui_kit::component::input::InputEvent;

fn read_bindings(
    executor: &BackgroundExecutor,
    read: impl FnOnce() -> Result<Bindings, String> + Send + 'static,
) -> Task<Result<Bindings, String>> {
    executor.spawn(async move { read() })
}

struct CommandPanel {
    parent: AnyWindowHandle,
    workspace: WeakEntity<Workspace>,
    _link: terminal::NativeChildWindow,
    query: Entity<InputState>,
    focus: FocusHandle,
    selected: usize,
    scroll: ScrollHandle,
    settings: bool,
    fields: Vec<Entity<InputState>>,
    bindings: Bindings,
    error: String,
    error_is_validation: bool,
    diagnostics: ui::DiagnosticDisclosure,
    notice: String,
    saving: bool,
    loading: bool,
    _load: Task<()>,
    _input: Subscription,
}
impl CommandPanel {
    fn save_shortcuts(&mut self, cx: &mut Context<Self>) {
        if self.saving || self.loading {
            return;
        }
        let bindings = Bindings(
            COMMANDS
                .iter()
                .enumerate()
                .map(|(i, c)| (c.id.to_owned(), self.fields[i].read(cx).value().to_string()))
                .collect(),
        );
        if let Err(error) = bindings.validate() {
            self.error = error;
            self.error_is_validation = true;
            self.notice.clear();
            cx.notify();
            return;
        }
        let Some(permit) = crate::commands::SavePermit::acquire() else {
            self.error = "Another window is saving shortcuts. Try again when it finishes.".into();
            self.error_is_validation = true;
            cx.notify();
            return;
        };
        self.saving = true;
        self.error.clear();
        self.error_is_validation = false;
        self.notice = "Saving…".into();
        let shared = self
            .workspace
            .upgrade()
            .map(|workspace| workspace.read(cx).shared.clone());
        let write = cx.background_executor().spawn(async move {
            let result = bindings.save();
            (bindings, result)
        });
        // A settings write is an admitted mutation. Closing this panel must not
        // cancel it or leave the saved bindings unapplied in the native menu.
        cx.spawn(async move |this, cx| {
            let (bindings, result) = write.await;
            cx.update(|_| {
                if result.is_ok() {
                    crate::commands::BINDING_APPLY_ORDER.apply_saved(|| {
                        crate::command_bridge::Bridge::configure(&bindings);
                    });
                }
            });
            let visible = this.update(cx, |this, cx| {
                this.saving = false;
                match &result {
                    Ok(()) => {
                        this.bindings = bindings;
                        this.error.clear();
                        this.notice = "Saved".into();
                    }
                    Err(error) => {
                        this.notice.clear();
                        this.error = error.clone();
                        this.error_is_validation = false;
                    }
                }
                cx.notify();
            });
            if visible.is_err()
                && let (Some(shared), Err(error)) = (shared, result)
            {
                shared.data.lock().unwrap().error = format!("Shortcuts were not saved: {error}");
                shared.notify();
            }
            drop(permit);
        })
        .detach();
        cx.notify();
    }
    fn matches(&self, cx: &App) -> Vec<usize> {
        let q = self.query.read(cx).value().to_lowercase();
        COMMANDS
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                q.split_whitespace().all(|word| {
                    format!("{} {} {}", c.group, c.title, c.id)
                        .to_lowercase()
                        .contains(word)
                })
            })
            .map(|(i, _)| i)
            .collect()
    }
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let weak = self.workspace.clone();
        window.remove_window();
        let _ = self.parent.update(cx, move |_, window, cx| {
            let _ = weak.update(cx, |this, cx| this.focus_pane(this.last_focus, window, cx));
        });
    }
    fn execute(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let id = COMMANDS[index].id;
        let weak = self.workspace.clone();
        window.remove_window();
        let _ = self.parent.update(cx, move |_, window, cx| {
            let _ = weak.update(cx, |this, cx| this.run_command(id, window, cx));
        });
    }
}
impl Render for CommandPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        let matches = self.matches(cx);
        let mut list = v_flex()
            .id("command-results")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .gap_1();
        if self.settings {
            for (index, c) in COMMANDS.iter().enumerate() {
                list = list.child(
                    h_flex()
                        .gap_3()
                        .py_1()
                        .child(div().flex_1().child(ui::field_label(c.title)))
                        .child(
                            div().w(px(180.)).child(
                                Input::new(&self.fields[index])
                                    .small()
                                    .disabled(self.saving || self.loading)
                                    .aria_label(c.title),
                            ),
                        ),
                );
            }
        } else {
            for (row, index) in matches.iter().enumerate() {
                let index = *index;
                let c = COMMANDS[index];
                let shortcut = self.bindings.effective(&c);
                list = list.child(
                    ui::button(SharedString::from(c.id))
                        .w_full()
                        .label(c.title)
                        .selected(row == self.selected)
                        .child(div().flex_1())
                        .when(!shortcut.is_empty(), |row| {
                            row.child(ui::shortcut(shortcut))
                        })
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.execute(index, window, cx)),
                        ),
                );
            }
            if matches.is_empty() {
                list = list.child(
                    div()
                        .p_4()
                        .text_color(rgb(ui::MUTED))
                        .child("No matching commands"),
                );
            }
        }
        v_flex().id("command-panel").track_focus(&self.focus).size_full().p_5().gap_3().bg(rgb(ui::CANVAS)).text_color(rgb(ui::TEXT))
            .on_key_down(cx.listener(|this,event:&KeyDownEvent,window,cx|{
                match event.keystroke.key.as_str(){
                    "escape"=>this.dismiss(window,cx),
                    "down" if !this.settings=>{this.selected=(this.selected+1).min(this.matches(cx).len().saturating_sub(1));this.scroll.scroll_to_item(this.selected);cx.notify();},
                    "up" if !this.settings=>{this.selected=this.selected.saturating_sub(1);this.scroll.scroll_to_item(this.selected);cx.notify();},_=>{}
                }
            }))
            .child(ui::panel_title(if self.settings{"Keyboard shortcuts"}else{"Commands"}))
            .when(!self.settings,|el|el.child(Input::new(&self.query).aria_label("Search commands")))
            .when(self.settings,|el|el.child(div().text_xs().text_color(rgb(ui::MUTED)).child("Use cmd+shift+p syntax. Leave blank to disable. Editing and shell keys stay reserved.")))
            .child(list)
            .when(!self.error.is_empty(), |el| {
                if self.error_is_validation {
                    el.child(ui::validation_card("Shortcut needs attention", self.error.clone()))
                } else {
                    let details = self.error.clone();
                    let expanded = self.diagnostics.is_expanded(&details);
                    el.child(ui::diagnostic_error_card(
                        "shortcut-error", "Shortcuts could not be loaded or saved",
                        "lux-ade could not read or save shortcuts. Check access to the settings file, then retry.",
                        details.clone(), expanded,
                        ui::button("shortcut-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                }
            })
            .when(!self.notice.is_empty(), |el| el.child(div().text_sm().text_color(rgb(ui::MUTED)).child(self.notice.clone())))
            .child(ui::panel_footer().child(div().flex_1())
                .when(self.settings,|el|el.child(ui::button("reset-shortcuts").disabled(self.saving || self.loading).label("Restore defaults").on_click(cx.listener(|this,_,window,cx|{
                    for (index,c) in COMMANDS.iter().enumerate(){this.fields[index].update(cx,|input,cx|input.set_value(c.shortcut,window,cx));}this.error.clear();this.notice="Defaults loaded. Save to apply.".into();cx.notify();
                }))))
                .when(self.settings,|el|el.child(ui::button("save-shortcuts").primary().disabled(self.saving || self.loading).label(if self.saving { "Saving…" } else { "Save shortcuts" }).on_click(cx.listener(|this,_,_,cx|this.save_shortcuts(cx)))))
                .child(ui::button("close-commands").label("Close").on_click(cx.listener(|this,_,window,cx|this.dismiss(window,cx)))))
    }
}
pub fn open(
    workspace: WeakEntity<Workspace>,
    parent: &mut Window,
    settings: bool,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let parent_id = Window::window_handle(parent);
    let raw = HasWindowHandle::window_handle(parent)?;
    let RawWindowHandle::AppKit(native_parent) = raw.as_raw() else {
        anyhow::bail!("macOS required")
    };
    let bindings = Bindings::default();
    let handle = gpui_kit::open_window(
        WindowOptions {
            kind: WindowKind::PopUp,
            focus: true,
            show: true,
            window_bounds: Some(WindowBounds::centered(size(px(680.), px(560.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title(if settings {
                "lux-ade — Keyboard shortcuts"
            } else {
                "lux-ade — Commands"
            });
            let raw = HasWindowHandle::window_handle(window).unwrap();
            let RawWindowHandle::AppKit(native_child) = raw.as_raw() else {
                unreachable!()
            };
            let link = unsafe {
                terminal::NativeChildWindow::attach(
                    native_parent.ns_view.as_ptr(),
                    native_child.ns_view.as_ptr(),
                )
            }
            .unwrap();
            cx.new(|cx| {
                let query =
                    cx.new(|cx| InputState::new(window, cx).placeholder("Search commands…"));
                let fields = COMMANDS
                    .iter()
                    .map(|c| {
                        cx.new(|cx| {
                            InputState::new(window, cx).default_value(bindings.effective(c))
                        })
                    })
                    .collect();
                let subscription = cx.subscribe_in(
                    &query,
                    window,
                    |this: &mut CommandPanel, _, event, window, cx| match event {
                        InputEvent::Change => {
                            this.selected = 0;
                            this.scroll.scroll_to_item(0);
                            cx.notify();
                        }
                        InputEvent::PressEnter { .. } => {
                            if let Some(index) = this.matches(cx).get(this.selected).copied() {
                                this.execute(index, window, cx);
                            }
                        }
                        _ => {}
                    },
                );
                let focus = cx.focus_handle();
                focus.focus(window, cx);
                if !settings {
                    query.read(cx).focus_handle(cx).focus(window, cx);
                }
                let read = read_bindings(cx.background_executor(), Bindings::load);
                let load = cx.spawn(async move |this, cx| {
                    let result = read.await;
                    let _ = this.update_in(cx, |this: &mut CommandPanel, window, cx| {
                        this.loading = false;
                        this.notice.clear();
                        match result {
                            Ok(bindings) => {
                                for (index, command) in COMMANDS.iter().enumerate() {
                                    this.fields[index].update(cx, |input, cx| {
                                        input.set_value(bindings.effective(command), window, cx)
                                    });
                                }
                                this.bindings = bindings;
                            }
                            Err(error) => {
                                this.error = error;
                                this.error_is_validation = false;
                            }
                        }
                        cx.notify();
                    });
                });
                CommandPanel {
                    parent: parent_id,
                    workspace,
                    _link: link,
                    query,
                    focus,
                    selected: 0,
                    scroll: ScrollHandle::new(),
                    settings,
                    fields,
                    bindings,
                    error: String::new(),
                    error_is_validation: false,
                    diagnostics: Default::default(),
                    notice: "Loading shortcuts…".into(),
                    saving: false,
                    loading: true,
                    _load: load,
                    _input: subscription,
                }
            })
        },
    )?
    .0;
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use std::{
        prelude::v1::test,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    #[gpui::test]
    async fn shortcut_read_is_deferred_and_reports_failure(cx: &mut TestAppContext) {
        let called = Arc::new(AtomicBool::new(false));
        let worker_called = called.clone();
        let read = read_bindings(&cx.background_executor, move || {
            worker_called.store(true, Ordering::SeqCst);
            Err("unreadable shortcuts".into())
        });
        assert!(
            !called.load(Ordering::SeqCst),
            "opening the panel must not read inline"
        );
        assert_eq!(read.await.err().as_deref(), Some("unreadable shortcuts"));
        assert!(called.load(Ordering::SeqCst));
    }
}
