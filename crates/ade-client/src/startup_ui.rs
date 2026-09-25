//! A responsive first window while the daemon projection arrives.
use super::*;

pub(crate) fn workspace_is_restorable(root: &str) -> bool {
    std::env::var_os("ADE_ROOT").is_some() || !is_bundle_resources(root)
}
fn is_bundle_resources(root: &str) -> bool {
    let path = std::path::Path::new(root);
    path.file_name().is_some_and(|name| name == "Resources")
        && path
            .parent()
            .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "Contents"))
}
pub(crate) fn has_workspace(catalog: &ade_core::model::Catalogue) -> bool {
    catalog
        .workspaces
        .iter()
        .any(|workspace| workspace_is_restorable(&workspace.root))
}

struct Startup {
    shared: Shared,
    windows: usize,
    temporary: bool,
    choosing: bool,
    diagnostics: ui::DiagnosticDisclosure,
    _updates: Task<()>,
    picker: Option<Task<()>>,
}
impl Startup {
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        if self.choosing {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open workspace folder".into()),
        });
        self.receive_folder_paths(
            async move {
                paths
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string())
            },
            cx,
        );
    }
    fn receive_folder_paths(
        &mut self,
        paths: impl std::future::Future<Output = Result<Option<Vec<std::path::PathBuf>>, String>>
        + 'static,
        cx: &mut Context<Self>,
    ) {
        self.choosing = true;
        self.picker = Some(cx.spawn(async move |this, cx| {
            let result = paths.await;
            let request = this.update(cx, |this, cx| {
                this.choosing = false;
                let request = match result {
                    Ok(Some(paths)) => paths.first().map(|path| {
                        this.choosing = true;
                        client_state::command(this.shared.clone(), json!({"op":"workspace.open","path":path}))
                    }),
                    Ok(None) => None,
                    _ => {
                        this.shared.data.lock().unwrap().error = "Could not open the folder picker. Try again.".into();
                        None
                    }
                };
                cx.notify();
                request
            }).ok().flatten();
            if let Some(request) = request {
                let result = request.recv().await;
                let _ = this.update(cx, |this, cx| {
                    this.choosing = false;
                    if !matches!(result, Ok(Ok(_))) {
                        this.shared.data.lock().unwrap().error = "Could not open this folder. Check that it still exists and you can access it, then try again.".into();
                    }
                    cx.notify();
                });
            }
        }));
        cx.notify();
    }
}
impl Render for Startup {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snapshot = self.shared.data.lock().unwrap();
        let (error, title, summary) = if snapshot.error.is_empty() {
            (
                &snapshot.connection_error,
                "Connection needs attention",
                "lux-ade could not connect to its local daemon. Open Connection options to retry.",
            )
        } else {
            (
                &snapshot.error,
                "Action could not complete",
                "lux-ade could not finish the last action. Check the current state and try again, or open Connection options.",
            )
        };
        if error.is_empty() {
            self.diagnostics.clear();
        }
        let choose = snapshot.connected && !has_workspace(&snapshot.catalog);
        v_flex()
            .size_full()
            .p_6()
            .gap_4()
            .justify_center()
            .bg(rgb(ui::CANVAS))
            .text_color(rgb(ui::TEXT))
            .child(ui::panel_title(if choose {
                "Welcome to lux-ade"
            } else {
                "Opening your workspace"
            }))
            .child(ui::description(if choose {
                "Choose a folder to open your first workspace."
            } else {
                "Connecting to lux-ade. Your saved windows will appear when ready."
            }))
            .when(choose, |el| {
                el.child(
                    ui::button("startup-choose-folder")
                        .label(if self.choosing {
                            "Opening…"
                        } else {
                            "Choose folder"
                        })
                        .disabled(self.choosing)
                        .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                )
            })
            .when(!error.is_empty(), |el| {
                let details = error.clone();
                let expanded = self.diagnostics.is_expanded(&details);
                el.child(ui::diagnostic_error_card(
                    "startup-error",
                    title,
                    summary,
                    details.clone(),
                    expanded,
                    ui::button("startup-diagnostics-toggle")
                        .debug_selector(|| "startup-diagnostics-toggle".into())
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
            })
            .child(
                ui::button("startup-recovery")
                    .label("Connection options")
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Err(error) = recovery_ui::open(this.shared.clone(), cx) {
                            this.shared.data.lock().unwrap().error = error.to_string();
                            cx.notify();
                        }
                    })),
            )
    }
}

pub fn open(
    shared: Shared,
    windows: usize,
    temporary: bool,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let (handle, _) = gpui_kit::open_window(
        WindowOptions {
            focus: true,
            show: true,
            window_bounds: Some(WindowBounds::centered(size(px(640.), px(360.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Opening workspace");
            cx.new(|cx| {
                let receiver = shared.subscribe();
                let updates = cx.spawn(async move |this, cx| {
                    loop {
                        // Read before waiting so a catalogue delivered during construction
                        // cannot be missed. This task belongs to the loading window.
                        let finished = this
                            .update_in(cx, |this: &mut Startup, window, cx| {
                                let ready =
                                    has_workspace(&this.shared.data.lock().unwrap().catalog);
                                if ready {
                                    crate::bootstrap::launch_windows(
                                        this.shared.clone(),
                                        this.windows,
                                        this.temporary,
                                        cx,
                                    );
                                    window.remove_window();
                                } else {
                                    cx.notify();
                                }
                                ready
                            })
                            .unwrap_or(true);
                        if finished || receiver.recv().await.is_err() {
                            break;
                        }
                    }
                });
                Startup {
                    shared,
                    windows,
                    temporary,
                    choosing: false,
                    diagnostics: Default::default(),
                    _updates: updates,
                    picker: None,
                }
            })
        },
    )?;
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    use std::sync::Arc;

    #[gpui::test]
    fn startup_hides_connection_diagnostics_until_requested(cx: &mut TestAppContext) {
        let shared = Arc::new(client_state::ClientState::default());
        let details = "daemon: {\"code\":\"socket_closed\"}".to_owned();
        shared.data.lock().unwrap().connection_error = details.clone();
        let (_, visual) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Startup {
                shared,
                windows: 1,
                temporary: true,
                choosing: false,
                diagnostics: Default::default(),
                _updates: Task::ready(()),
                picker: None,
            }
        });
        visual.run_until_parked();
        visual.update(|window, cx| window.draw(cx).clear(cx));
        assert!(visual.debug_bounds("startup-error-summary").is_some());
        assert!(visual.debug_bounds("startup-error-copy").is_none());
        let toggle = visual.debug_bounds("startup-diagnostics-toggle").unwrap();
        visual.simulate_mouse_down(toggle.center(), MouseButton::Left, Modifiers::none());
        visual.simulate_mouse_up(toggle.center(), MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
        visual.update(|window, cx| window.draw(cx).clear(cx));
        let copy = visual.debug_bounds("startup-error-copy").unwrap();
        visual.simulate_mouse_down(copy.center(), MouseButton::Left, Modifiers::none());
        visual.simulate_mouse_up(copy.center(), MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
        assert_eq!(
            visual.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some(details)
        );
    }

    #[gpui::test]
    fn closing_startup_releases_picker_waiter(cx: &mut TestAppContext) {
        let (view, visual) = cx.add_window_view(|_, cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            Startup {
                shared: Arc::new(client_state::ClientState::default()),
                windows: 1,
                temporary: true,
                choosing: false,
                diagnostics: Default::default(),
                _updates: Task::ready(()),
                picker: None,
            }
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_folder_paths(async move { rx.recv().await.unwrap() }, cx)
        });
        visual.run_until_parked();
        assert!(!tx.is_closed());
        visual.update(|window, _| window.remove_window());
        drop(view);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(tx.is_closed(), "closed startup retains its picker waiter");
    }

    #[test]
    fn installed_bundle_is_not_a_default_workspace() {
        assert!(is_bundle_resources(
            "/Applications/lux-ade.app/Contents/Resources"
        ));
        assert!(!is_bundle_resources("/Users/example/project"));
        assert!(!has_workspace(
            &serde_json::from_value(json!({
                "workspaces":[], "conversations":[], "windows":[]
            }))
            .unwrap()
        ));
    }

    #[gpui::test]
    fn loading_window_does_not_keep_projection_after_close(cx: &mut TestAppContext) {
        let shared = Arc::new(client_state::ClientState::default());
        let weak = Arc::downgrade(&shared);
        let handle = cx.update(|cx| {
            gpui_kit::init(cx);
            ui::install(cx);
            open(shared.clone(), 1, true, cx).unwrap()
        });
        cx.run_until_parked();
        assert_eq!(cx.update(|cx| cx.windows().len()), 1);
        drop(shared);
        assert!(weak.upgrade().is_some());
        handle
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
        assert!(
            weak.upgrade().is_none(),
            "closing loading window must cancel its subscription task"
        );
    }
}
