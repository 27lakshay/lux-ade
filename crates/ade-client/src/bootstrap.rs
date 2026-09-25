//! Application startup, window restoration, and final shutdown coordination.
//! Chat state and rendering stay in Workspace; this module owns app lifetime.
use crate::client_state::{Shared, connect};
use crate::{
    bench, client_state, command_bridge, commands, open_overlay, recovery_ui, shell_ui, startup_ui,
    ui,
};
use ade_core::model::{WindowRecord, new_id};
use gpui_kit::component::{Theme, ThemeMode, TitleBar};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, WindowBounds, WindowOptions, point, px, size,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct FinalWindowFlush {
    generation: u64,
    running: bool,
}
impl FinalWindowFlush {
    fn schedule(&mut self) -> Option<u64> {
        self.generation = self.generation.wrapping_add(1);
        if self.running {
            None
        } else {
            self.running = true;
            Some(self.generation)
        }
    }
    fn finish(&mut self, generation: u64) -> Option<u64> {
        if self.generation != generation {
            Some(self.generation)
        } else {
            self.running = false;
            None
        }
    }
}

struct StartupBindingsTask {
    _task: gpui_kit::Task<()>,
}
impl gpui_kit::Global for StartupBindingsTask {}
fn load_startup_bindings(shared: &Shared, cx: &mut App) {
    let ticket = commands::BINDING_APPLY_ORDER.ticket();
    let read = cx
        .background_executor()
        .spawn(async { commands::Bindings::load() });
    finish_startup_read(shared, ticket, read, cx);
}
fn finish_startup_read(
    shared: &Shared,
    ticket: u64,
    read: gpui_kit::Task<Result<commands::Bindings, String>>,
    cx: &mut App,
) {
    let shared = std::sync::Arc::downgrade(shared);
    let task = cx.spawn(async move |cx| {
        let result = read.await;
        cx.update(|_| {
            commands::BINDING_APPLY_ORDER.apply_startup(ticket, || match result {
                Ok(bindings) => command_bridge::Bridge::configure(&bindings),
                Err(error) => {
                    if let Some(shared) = shared.upgrade() {
                        shared.data.lock().unwrap().error = format!("Keybindings: {error}");
                        shared.notify();
                    }
                }
            });
        });
    });
    cx.set_global(StartupBindingsTask { _task: task });
}

pub(crate) fn open_workspace(
    focus: bool,
    shared: Shared,
    record: Option<WindowRecord>,
    persist: bool,
    cx: &mut App,
) -> AnyWindowHandle {
    let catalog = shared.data.lock().unwrap().catalog.clone();
    let record = record.unwrap_or_else(|| WindowRecord {
        dock_layout: None,
        panes: Default::default(),
        tabs: Default::default(),
        focused_pane: 5,
        id: new_id("window"),
        workspace_id: catalog
            .workspaces
            .iter()
            .find(|workspace| startup_ui::workspace_is_restorable(&workspace.root))
            .expect("Daemon has a default workspace")
            .id
            .clone(),
        conversation_id: None,
        browser_url: String::new(),
        x: 105.,
        y: 100.,
        width: 1220.,
        height: 800.,
    });
    let workspace = catalog
        .workspaces
        .iter()
        .find(|w| w.id == record.workspace_id)
        .expect("Window workspace exists")
        .clone();
    gpui_kit::open_window(
        WindowOptions {
            focus,
            show: true,
            window_min_size: Some(size(px(1000.), px(700.))),
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(record.x), px(record.y)),
                size(px(record.width), px(record.height)),
            ))),
            ..TitleBar::window_options()
        },
        cx,
        |window, cx| {
            window.set_window_title(&format!("lux-ade — {}", workspace.name));
            cx.new(|cx| shell_ui::Shell::new(record, workspace, persist, shared, window, cx))
        },
    )
    .expect("open workspace")
    .0
}
pub(crate) fn launch_windows(shared: Shared, windows: usize, temporary: bool, cx: &mut App) {
    let catalog = shared.data.lock().unwrap().catalog.clone();
    let restored: Vec<_> = catalog
        .windows
        .into_iter()
        .filter(|window| {
            catalog.workspaces.iter().any(|workspace| {
                workspace.id == window.workspace_id
                    && startup_ui::workspace_is_restorable(&workspace.root)
            })
        })
        .collect();
    let records: Vec<Option<WindowRecord>> =
        if temporary && std::env::var_os("ADE_BENCH_RESTORE_WINDOWS").is_none() {
            (0..windows).map(|_| None).collect()
        } else if restored.is_empty() {
            vec![None]
        } else {
            restored.into_iter().take(10).map(Some).collect()
        };
    let mut handles = records
        .into_iter()
        .enumerate()
        .map(|(i, r)| open_workspace(i == 0, shared.clone(), r, !temporary, cx));
    let first = handles.next().unwrap();
    let others: Vec<_> = handles.collect();
    cx.activate(true);
    first
        .update(cx, |_, window, _| window.activate_window())
        .ok();
    if bench::enabled() {
        cx.spawn(async move |cx| {
            loop {
                let start = std::time::Instant::now();
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                cx.update(|_| {
                    bench::sample(
                        "ui_timer_lateness_us",
                        start.elapsed().as_micros().saturating_sub(100_000) as u64,
                    )
                });
            }
        })
        .detach();
        cx.activate(true);
        first
            .update(cx, |_, window, _| window.activate_window())
            .ok();
        if let Ok(control) = std::env::var("ADE_BENCH_CONTROL") {
            cx.spawn(async move |cx| {
                let mut wide = false;
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(500))
                        .await;
                    if std::fs::read_to_string(&control).ok().as_deref() == Some("resize") {
                        wide = !wide;
                        let started = std::time::Instant::now();
                        if first
                            .update(cx, |_, window, _| {
                                window.resize(size(
                                    px(if wide { 1180. } else { 1260. }),
                                    px(if wide { 760. } else { 820. }),
                                ));
                                window.on_next_frame(move |_, _| {
                                    bench::elapsed("resize_to_gpui_frame_us", started)
                                });
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            })
            .detach();
        }
    }
    if std::env::args().any(|arg| arg == "--ui-smoke") {
        let second = *others.first().expect("ui smoke needs two windows");
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(500))
                .await;
            let panel = first
                .update(cx, |_, window, cx| open_overlay(window, cx))
                .expect("parent exists")
                .expect("panel opens");
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;
            first
                .update(cx, |_, window, _| window.remove_window())
                .expect("close parent");
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            let count = cx.update(|cx| cx.windows().len());
            assert_eq!(
                count, 1,
                "closing parent must dispose child panel and leave sibling"
            );
            assert!(
                panel.update(cx, |_, _, _| ()).is_err(),
                "panel registry entry must be gone"
            );
            eprintln!("UI_SMOKE_PASS: parent and child close; sibling survives");
            second
                .update(cx, |_, window, _| window.remove_window())
                .expect("close sibling");
        })
        .detach();
    }
}

pub(crate) fn run() {
    let logs = ade_platform::resources::logs();
    if let Some(destination) = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "--export-diagnostics")
        .map(|pair| pair[1].clone())
    {
        match ade_platform::diagnostics::export(&logs, std::path::Path::new(&destination)) {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("Diagnostic export failed: {error}");
                std::process::exit(1);
            }
        }
    }
    let _diagnostics_guard = ade_platform::diagnostics::init(&logs, "client")
        .map_err(|error| {
            eprintln!("Local diagnostics unavailable: {error}");
        })
        .ok();

    if std::env::var("ADE_UI_SHOWCASE").ok().as_deref() == Some("1") {
        gpui_kit::application()
            .with_assets(gpui_kit::assets::AllAssets)
            .run(|cx| {
                gpui_kit::init(cx);
                Theme::change(ThemeMode::Dark, None, cx);
                ui::install(cx);
                ui::launch_showcase(cx);
            });
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    let windows = args
        .windows(2)
        .find(|a| a[0] == "--windows")
        .and_then(|a| a[1].parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 10);
    if bench::enabled() {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                bench::flush();
            }
        });
    }
    let shared = connect();
    client_state::start_local_daemon(shared.clone());
    if !bench::enabled() {
        recovery_ui::start(shared.clone());
    }
    let unavailable = !startup_ui::has_workspace(&shared.data.lock().unwrap().catalog);
    let temporary = args.iter().any(|a| a == "--windows" || a == "--ui-smoke") || bench::enabled();
    gpui_kit::application()
        .with_assets(gpui_kit::assets::AllAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            Theme::change(ThemeMode::Dark, None, cx);
            ui::install(cx);
            command_bridge::install_edit_menu(cx);
            command_bridge::Bridge::configure(&commands::Bindings::default());
            load_startup_bindings(&shared, cx);
            let close_shared = shared.clone();
            let final_flush = Arc::new(Mutex::new(FinalWindowFlush::default()));
            cx.on_window_closed(move |cx, _| {
                if !cx.windows().is_empty() {
                    return;
                }
                let Some(mut generation) = final_flush.lock().unwrap().schedule() else {
                    return;
                };
                let final_flush = final_flush.clone();
                let shared = close_shared.clone();
                cx.spawn(async move |cx| {
                    loop {
                        let flushed = client_state::flush_layout();
                        let result = client_state::confirmed_before(
                            flushed,
                            cx.background_executor().timer(Duration::from_secs(30)),
                            "Save confirmation timed out. Check current state before closing lux-ade.",
                        )
                        .await;
                        if let Some(newer) = final_flush.lock().unwrap().finish(generation) {
                            generation = newer;
                            continue;
                        }
                        cx.update(|cx| {
                            if cx.windows().is_empty() {
                                match result {
                                    Ok(()) => cx.quit(),
                                    Err(error) => {
                                        shared.data.lock().unwrap().error = error;
                                        if let Err(error) = recovery_ui::open(shared, cx) {
                                            eprintln!("Unable to show save failure: {error}");
                                        }
                                    }
                                }
                            }
                        });
                        break;
                    }
                })
                .detach();
            })
            .detach();
            if unavailable {
                if let Err(error) = startup_ui::open(shared.clone(), windows, temporary, cx) {
                    eprintln!("Unable to open lux-ade: {error}");
                    cx.quit();
                }
                cx.activate(true);
                return;
            }
            launch_windows(shared.clone(), windows, temporary, cx);
        });
}

#[cfg(test)]
mod final_window_flush_tests {
    use super::*;
    use std::prelude::v1::test;
    #[test]
    fn newer_final_close_requires_a_new_fence_without_another_worker() {
        let mut state = FinalWindowFlush::default();
        let first = state.schedule().expect("first final close starts worker");
        assert!(
            state.schedule().is_none(),
            "second final close spawned another waiter"
        );
        let second = state
            .finish(first)
            .expect("newer close requires another fence");
        assert_ne!(first, second);
        assert!(state.finish(second).is_none());
        assert!(
            state.schedule().is_some(),
            "settled worker releases admission"
        );
    }
}

#[cfg(test)]
mod startup_binding_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;
    #[gpui::test]
    fn app_owner_drop_cancels_startup_completion(cx: &mut gpui::TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let (send, receive) = async_channel::bounded(1);
        let read = cx
            .background_executor
            .spawn(async move { receive.recv().await.unwrap() });
        cx.update(|cx| {
            finish_startup_read(&shared, commands::BINDING_APPLY_ORDER.ticket(), read, cx)
        });
        cx.run_until_parked();
        cx.update(|cx| drop(cx.remove_global::<StartupBindingsTask>()));
        cx.run_until_parked();
        assert!(send.try_send(Err("late read failure".into())).is_err());
        assert!(shared.data.lock().unwrap().error.is_empty());
    }
}
