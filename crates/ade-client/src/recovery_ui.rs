//! Local build/recovery controls. Blocking controller work never runs on the UI thread.
use crate::client_state::{self, Shared};
use gpui_kit::{
    component::{button::*, *},
    prelude::FluentBuilder,
    *,
};
use serde_json::Value;
use std::{
    os::unix::process::CommandExt,
    process::Command,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

#[derive(Default, Clone)]
struct State {
    info: Value,
    busy: bool,
    error: String,
    notice: String,
}
struct Controller {
    state: Mutex<State>,
    tx: mpsc::SyncSender<&'static str>,
}
static RELOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
struct ReloadPermit;
impl ReloadPermit {
    fn acquire() -> Option<Self> {
        RELOAD_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
    fn active() -> bool {
        RELOAD_ACTIVE.load(Ordering::Acquire)
    }
}
impl Drop for ReloadPermit {
    fn drop(&mut self) {
        RELOAD_ACTIVE.store(false, Ordering::Release);
    }
}

static CONTROLLER: OnceLock<Controller> = OnceLock::new();
fn publish(shared: &Shared) {
    shared.data.lock().unwrap().recovery_revision += 1;
    shared.notify();
}
fn invoke(action: &str) -> anyhow::Result<Value> {
    let mut command = Command::new("python3");
    command
        .arg(ade_platform::resources::resource("scripts/runtime.py"))
        .arg(action)
        .env("ADE_SOCKET", client_state::resolved_socket()?);
    if action == "replace-supervisor" {
        command.arg("--stop-active");
    }
    let timeout = Duration::from_secs(if action == "status" { 20 } else { 60 });
    let result = ade_platform::process::run(&mut command, timeout, 256 * 1024)?;
    anyhow::ensure!(
        result.status.success(),
        "lux-ade controller failed. Check runtime status before retrying; running work was left with its supervisor"
    );
    Ok(serde_json::from_slice(&result.stdout)?)
}
pub fn start(shared: Shared) {
    let (tx, rx) = mpsc::sync_channel(1);
    if CONTROLLER
        .set(Controller {
            state: Mutex::new(State::default()),
            tx,
        })
        .is_err()
    {
        return;
    }
    let weak = std::sync::Arc::downgrade(&shared);
    std::thread::spawn(move || {
        let mut action = "status";
        loop {
            let Some(shared) = weak.upgrade() else {
                return;
            };
            let controller = CONTROLLER.get().unwrap();
            controller.state.lock().unwrap().busy = true;
            publish(&shared);
            let result = invoke(action);
            let refreshed = if result.is_ok() && action != "status" {
                invoke("status")
            } else {
                result
                    .as_ref()
                    .map(Clone::clone)
                    .map_err(|e| anyhow::anyhow!(e.to_string()))
            };
            {
                let mut state = controller.state.lock().unwrap();
                state.busy = false;
                match result {
                    Ok(_) => {
                        if action != "status" {
                            state.error.clear();
                            state.notice =
                                "Action completed. Views reconnect automatically.".into();
                        }
                        match refreshed {
                            Ok(info) => {
                                state.info = info;
                                if action == "status"
                                    && state.notice == "Checking installed builds…"
                                {
                                    state.notice = "Build check complete.".into();
                                }
                            }
                            Err(error) => state.error = error.to_string(),
                        }
                    }
                    Err(error) => {
                        state.error = error.to_string();
                        state.info = Value::Null;
                    }
                }
            }
            publish(&shared);
            drop(shared);
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            action = loop {
                if weak.strong_count() == 0 {
                    return;
                }
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(action) => break action,
                    Err(mpsc::RecvTimeoutError::Timeout)
                        if std::time::Instant::now() < deadline =>
                    {
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break "status",
                    Err(_) => return,
                }
            };
        }
    });
}
impl Controller {
    fn request(&self, action: &'static str) {
        let mut state = self.state.lock().unwrap();
        if state.busy {
            return;
        }
        state.busy = true;
        state.error.clear();
        state.notice = match action {
            "status" => "Checking installed builds…",
            "start" => "Starting or reconnecting to the daemon…",
            "restart" => "Restarting daemon; running work stays with the supervisor…",
            _ => "Replacing supervisor; ending live shells and Agents…",
        }
        .into();
        match self.tx.try_send(action) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                state.error = "A recovery request is already waiting. Wait for it to finish before trying again.".into();
                state.notice.clear();
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                state.busy = false;
                state.error =
                    "The recovery controller stopped. Reopen lux-ade to restore recovery controls."
                        .into();
                state.notice.clear();
            }
        }
    }
}
fn request(action: &'static str, shared: &Shared) {
    if let Some(controller) = CONTROLLER.get() {
        controller.request(action);
        publish(shared);
    }
}
pub fn label(connected: bool) -> String {
    let Some(controller) = CONTROLLER.get() else {
        return if connected {
            "Connected"
        } else {
            "Reconnecting…"
        }
        .into();
    };
    let state = controller.state.lock().unwrap();
    if state.busy {
        "Checking / recovering…"
    } else if !state.error.is_empty() {
        "Recovery needs attention"
    } else if !connected {
        "Reconnecting…"
    } else if state.info["daemon_update"] == true || state.info["supervisor_update"] == true {
        "Update available"
    } else {
        "Connected"
    }
    .into()
}
pub fn healthy(connected: bool) -> bool {
    CONTROLLER.get().map_or(connected, |controller| {
        recovery_healthy(connected, &controller.state.lock().unwrap())
    })
}
fn recovery_healthy(connected: bool, state: &State) -> bool {
    connected
        && !state.busy
        && state.error.is_empty()
        && state.info["daemon_update"] != true
        && state.info["supervisor_update"] != true
}
fn build_label(info: &Value, field: &str) -> &'static str {
    match info[field].as_bool() {
        Some(true) => "Update available",
        Some(false) => "Matches local build",
        None => "Build unknown — check unavailable",
    }
}
struct Recovery {
    shared: Shared,
    confirm: bool,
    recovery_diagnostics: crate::ui::DiagnosticDisclosure,
    client_diagnostics: crate::ui::DiagnosticDisclosure,
    connection_diagnostics: crate::ui::DiagnosticDisclosure,
    _updates: Task<()>,
}
impl Render for Recovery {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = CONTROLLER
            .get()
            .map(|c| c.state.lock().unwrap().clone())
            .unwrap_or_default();
        let snapshot = self.shared.data.lock().unwrap().clone();
        if state.error.is_empty() {
            self.recovery_diagnostics.clear();
        }
        if snapshot.error.is_empty() {
            self.client_diagnostics.clear();
        }
        if snapshot.connection_error.is_empty() {
            self.connection_diagnostics.clear();
        }
        let connected = snapshot.connected;
        let busy = state.busy;
        let daemon = &state.info["daemon"];
        let activity = format!(
            "{} connected Agents · {} workspace terminals · {} Git operations",
            daemon["connected_agents"].as_u64().unwrap_or(0),
            daemon["terminals"].as_array().map_or(0, Vec::len),
            daemon["active_git_operations"].as_u64().unwrap_or(0)
        );
        let recovery_healthy = recovery_healthy(connected, &state);
        div().id("runtime-scroll").size_full().overflow_y_scroll()
            .bg(rgb(crate::ui::CANVAS)).text_color(rgb(crate::ui::TEXT)).text_sm()
            .child(v_flex().w_full().min_w_0().p_5().gap_4()
                .child(crate::ui::panel_title("Runtime and recovery"))
                .child(h_flex().flex_wrap().gap_3()
                    .child(crate::ui::status(label(connected), recovery_healthy))
                    .child(crate::ui::chip(if connected { "Daemon connected" } else { "Daemon disconnected" })))
                .child(crate::ui::card()
                    .child(crate::ui::field_label("Local builds"))
                    .child(crate::ui::description("Compare this instance with builds on this Mac."))
                    .child(h_flex().flex_wrap().gap_4()
                        .child(v_flex().gap_1().child(crate::ui::section("Daemon"))
                            .child(build_label(&state.info, "daemon_update")))
                        .child(v_flex().gap_1().child(crate::ui::section("Supervisor"))
                            .child(build_label(&state.info, "supervisor_update"))))
                    .child(crate::ui::description(if daemon.is_object() { activity } else { "Runtime activity unavailable".into() }))
                    .child(h_flex().flex_wrap().gap_2()
                        .child(crate::ui::primary_button("retry-runtime", "Retry connection").disabled(busy)
                            .tooltip("Start the daemon or reconnect to it")
                            .on_click(cx.listener(|this,_,_,_| request("start", &this.shared))))
                        .child(crate::ui::button("check-builds").secondary().outline().label("Check builds").disabled(busy)
                            .on_click(cx.listener(|this,_,_,_| request("status", &this.shared))))))
                .when(!state.error.is_empty(), |el| {
                    let details = state.error.clone();
                    let expanded = self.recovery_diagnostics.is_expanded(&details);
                    el.child(crate::ui::diagnostic_error_card(
                        "runtime-recovery-error", "Recovery needs attention",
                        "The recovery action could not finish. Check the current status before retrying.",
                        details.clone(), expanded,
                        crate::ui::button("runtime-recovery-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.recovery_diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                })
                .when(!snapshot.error.is_empty(), |el| {
                    let details = snapshot.error.clone();
                    let expanded = self.client_diagnostics.is_expanded(&details);
                    el.child(crate::ui::diagnostic_error_card(
                        "runtime-client-error", "Changes need attention",
                        "lux-ade could not finish the last action. Check the current state before retrying.",
                        details.clone(), expanded,
                        crate::ui::button("runtime-client-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.client_diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                })
                .when(!snapshot.connection_error.is_empty(), |el| {
                    let details = snapshot.connection_error.clone();
                    let expanded = self.connection_diagnostics.is_expanded(&details);
                    el.child(crate::ui::diagnostic_error_card(
                        "runtime-connection-error", "Connection",
                        "lux-ade cannot reach the local daemon. Check its status, then retry connection.",
                        details.clone(), expanded,
                        crate::ui::button("runtime-connection-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.connection_diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                })
                .child(v_flex().gap_2()
                    .child(crate::ui::field_label("Client"))
                    .child(crate::ui::description("Restore saved windows and drafts, then reconnect. Shells and Agents keep running."))
                    .child(h_flex().child(crate::ui::button("reload-client").secondary().outline().label("Reload client")
                        .disabled(busy || !connected || ReloadPermit::active()).on_click(cx.listener(|this,_,_,cx| {
                let Some(permit) = ReloadPermit::acquire() else { return; };
                let shared = this.shared.clone();
                publish(&shared);
                let flushed = client_state::flush_layout();
                cx.spawn(async move |_, cx| {
                    let result = client_state::confirmed_before(
                        flushed,
                        cx.background_executor().timer(Duration::from_secs(30)),
                        "Save confirmation timed out. Client was not reloaded; check current state before retrying.",
                    ).await;
                    if let Err(error) = result {
                        shared.data.lock().unwrap().error = error;
                        drop(permit);
                        publish(&shared);
                        return;
                    }
                    let error = cx.update(|_| {
                        // Replace this process in place: spawning before quitting can race
                        // LaunchServices and leave two clients with different environments.
                        match (std::env::current_exe(), client_state::resolved_socket()) {
                            (Ok(exe), Ok(endpoint)) => Command::new(exe).env("ADE_SOCKET", endpoint).exec(),
                            (Err(error), _) => error,
                            (_, Err(error)) => std::io::Error::other(error.to_string()),
                        }
                    });
                    drop(permit);
                    if let Some(controller) = CONTROLLER.get() {controller.state.lock().unwrap().error = error.to_string();}
                    publish(&shared);
                }).detach();
            })))))
                .child(crate::ui::divider())
                .child(v_flex().gap_2()
                    .child(crate::ui::field_label("Daemon"))
                    .child(crate::ui::description("Apply the local daemon build. Shells and Agents keep running; active Git operations may block restart."))
                    .child(h_flex().child(crate::ui::button("restart-daemon").secondary().outline().label("Restart daemon").disabled(busy)
                        .on_click(cx.listener(|this,_,_,_| request("restart", &this.shared))))))
                .child(crate::ui::divider())
                .child(v_flex().gap_2()
                    .child(crate::ui::field_label("Supervisor"))
                    .child(crate::ui::description("Apply the local supervisor build and end live shells and Agents. Saved Conversations and window layouts remain."))
                    .child(h_flex().flex_wrap().gap_2()
                        .child(crate::ui::button("replace-supervisor").secondary().outline()
                            .when(self.confirm, |button| button.danger())
                            .label(if self.confirm { "End live work and replace" } else { "Replace supervisor…" }).disabled(busy)
                            .on_click(cx.listener(|this,_,_,cx| {
                                if this.confirm {this.confirm=false;request("replace-supervisor", &this.shared);} else {this.confirm=true;} cx.notify();
                            })))
                        .when(self.confirm, |el| el.child(crate::ui::button("cancel-replace").label("Cancel replacement").disabled(busy)
                            .on_click(cx.listener(|this,_,_,cx| {this.confirm=false;cx.notify();}))))))
                .when(!state.notice.is_empty(), |el| el.child(div().text_color(rgb(crate::ui::ACCENT)).child(state.notice)))
                .child(crate::ui::panel_footer()
                    .child(crate::ui::description("Check builds refreshes diagnostics."))
                    .child(div().flex_1())
                    .child(crate::ui::button("close-runtime").secondary().outline().label("Close").on_click(|_,window,_|window.remove_window()))))
    }
}
pub fn open(shared: Shared, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    let (handle, _) = gpui_kit::open_window(
        WindowOptions {
            focus: true,
            show: true,
            window_bounds: Some(WindowBounds::centered(size(px(760.), px(780.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Runtime and recovery");
            cx.new(|cx| {
                let receiver = shared.subscribe();
                let updates = cx.spawn(async move |this, cx| {
                    while receiver.recv().await.is_ok() {
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            break;
                        }
                    }
                });
                Recovery {
                    shared,
                    confirm: false,
                    recovery_diagnostics: Default::default(),
                    client_diagnostics: Default::default(),
                    connection_diagnostics: Default::default(),
                    _updates: updates,
                }
            })
        },
    )?;
    Ok(handle)
}
#[cfg(test)]
mod tests {
    #[test]
    fn stopped_controller_does_not_leave_recovery_busy() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let controller = super::Controller {
            state: std::sync::Mutex::new(Default::default()),
            tx,
        };
        drop(rx);
        controller.request("restart");
        let state = controller.state.lock().unwrap();
        assert!(!state.busy, "failed admission leaves recovery stuck busy");
        assert!(state.error.contains("Reopen lux-ade"));
        assert!(state.notice.is_empty());
    }

    #[test]
    fn recovery_admission_never_replaces_or_accumulates_waiting_actions() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let controller = super::Controller {
            state: std::sync::Mutex::new(Default::default()),
            tx,
        };
        controller.request("status");
        controller.request("replace-supervisor");
        assert_eq!(rx.try_recv().unwrap(), "status");
        assert!(matches!(
            rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        // A poll may finish after a UI request was queued. Admission must also
        // handle that brief mismatch between the visible flag and queue state.
        controller.state.lock().unwrap().busy = false;
        controller.tx.try_send("restart").unwrap();
        controller.request("replace-supervisor");
        let state = controller.state.lock().unwrap();
        assert!(state.busy);
        assert!(state.error.contains("already waiting"));
        assert!(state.notice.is_empty());
        drop(state);
        assert_eq!(rx.try_recv().unwrap(), "restart");
        assert!(matches!(
            rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
    }
    #[test]
    fn connected_daemon_does_not_hide_recovery_attention() {
        let mut state = super::State::default();
        assert!(super::recovery_healthy(true, &state));
        state.error = "Build check failed".into();
        assert!(!super::recovery_healthy(true, &state));
        state.error.clear();
        state.info = serde_json::json!({"supervisor_update": true});
        assert!(!super::recovery_healthy(true, &state));
        state.info = serde_json::json!({});
        state.busy = true;
        assert!(!super::recovery_healthy(true, &state));
        state.busy = false;
        assert!(!super::recovery_healthy(false, &state));
    }
    #[test]
    fn missing_build_identity_is_not_reported_as_current() {
        assert!(super::build_label(&serde_json::json!({}), "daemon_update").contains("unknown"));
        assert_eq!(
            super::build_label(&serde_json::json!({"daemon_update":true}), "daemon_update"),
            "Update available"
        );
    }
}

#[cfg(test)]
mod reload_admission_tests {
    use super::*;
    use std::prelude::v1::test;
    #[test]
    fn duplicate_reload_is_not_admitted_while_first_is_pending() {
        let first = ReloadPermit::acquire().expect("first reload admitted");
        assert!(ReloadPermit::active(), "admitted reload must report busy");
        assert!(
            ReloadPermit::acquire().is_none(),
            "second reload overtook pending flush"
        );
        drop(first);
        assert!(
            !ReloadPermit::active(),
            "failed or completed reload must release admission"
        );
        assert!(
            ReloadPermit::acquire().is_some(),
            "later retry should be accepted"
        );
    }
}
