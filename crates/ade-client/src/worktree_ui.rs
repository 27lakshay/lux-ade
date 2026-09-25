//! General-purpose lifecycle UI. Worktrunk configuration belongs to the repository.
use crate::client_state::{self, Shared};
use ade_core::{
    model::{WindowRecord, new_id},
    worktrees::Config,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    component::{
        button::*,
        input::{Input, InputState},
        *,
    },
    *,
};
use serde_json::{Value, json};
use std::time::Duration;
struct Manager {
    shared: Shared,
    repository: Entity<InputState>,
    target: Entity<InputState>,
    base: Entity<InputState>,
    template: Entity<InputState>,
    user_config: Entity<InputState>,
    project_config: Entity<InputState>,
    hooks: bool,
    state: Value,
    pending: bool,
    error: String,
    diagnostics: crate::ui::DiagnosticDisclosure,
    job_diagnostics: crate::ui::DiagnosticDisclosure,
    confirm: Option<String>,
    _poll: Task<()>,
    read_request: Option<client_state::ReadRequest>,
    response_task: Option<Task<()>>,
    open_task: Option<Task<()>>,
    opening: bool,
}
impl Manager {
    fn new(shared: Shared, path: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let repository = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Repository directory")
                .default_value(path)
        });
        let target =
            cx.new(|cx| InputState::new(window, cx).placeholder("Branch, ref or worktree path"));
        let base = cx.new(|cx| InputState::new(window, cx).placeholder("Base ref (optional)"));
        let template = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Worktree path template (Worktrunk default if empty)")
        });
        let user_config = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("User configuration file (optional absolute path)")
        });
        let project_config = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Project configuration override (optional absolute path)")
        });
        let poll=cx.spawn(async move|this,cx|{loop{cx.background_executor().timer(Duration::from_secs(1)).await;if this.update(cx,|this,cx|{if !this.pending&&this.state["busy"]==true{this.request(json!({"op":"worktree.get","repository_id":this.state["repository"]["id"]}),false,cx);}}).is_err(){break;}}});
        Self {
            shared,
            repository,
            target,
            base,
            template,
            user_config,
            project_config,
            hooks: false,
            state: Value::Null,
            pending: false,
            error: String::new(),
            diagnostics: Default::default(),
            job_diagnostics: Default::default(),
            confirm: None,
            _poll: poll,
            read_request: None,
            response_task: None,
            open_task: None,
            opening: false,
        }
    }
    fn request(&mut self, value: Value, load_config: bool, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error.clear();
        cx.notify();
        let load_repository = value["op"] == "worktree.repository";
        let rx = if client_state::is_disposable_read(&value) {
            let (handle, rx) = client_state::disposable_read(value);
            self.read_request = Some(handle);
            rx
        } else {
            client_state::background_request(value.to_string().len(), move || {
                client_state::rpc(&value).map_err(|error| error.to_string())
            })
        };
        self.receive_request(rx, load_config, load_repository, cx);
    }
    fn receive_request(
        &mut self,
        rx: async_channel::Receiver<Result<Value, String>>,
        load_config: bool,
        load_repository: bool,
        cx: &mut Context<Self>,
    ) {
        self.response_task = Some(cx.spawn(async move |this, cx| {
            let result = client_state::response_result(rx.recv().await);
            let _ = this.update_in(cx, |this, window, cx| {
                this.read_request = None;
                this.pending = false;
                match result {
                    Ok(state) => {
                        if load_config
                            && let Ok(config) = serde_json::from_value::<Config>(
                                state["repository"]["config"].clone(),
                            )
                        {
                            this.hooks = config.hooks;
                            for (input, value) in [
                                (&this.template, config.path_template),
                                (&this.user_config, config.user_config),
                                (&this.project_config, config.project_config),
                            ] {
                                input.update(cx, |input, cx| {
                                    input.set_value(value.unwrap_or_default(), window, cx)
                                });
                            }
                        }
                        this.state = state;
                        if load_repository {
                            this.operation(json!({"op":"worktree.refresh"}), cx);
                        }
                    }
                    Err(error) => this.error = error,
                }
                cx.notify();
            });
        }));
    }
    fn operation(&mut self, mut request: Value, cx: &mut Context<Self>) {
        request["repository_id"] = self.state["repository"]["id"].clone();
        request["request_id"] = json!(new_id("worktree-operation"));
        self.confirm = None;
        self.request(request, false, cx);
    }
    fn open_workspace(&mut self, path: String, cx: &mut Context<Self>) {
        if self.opening {
            return;
        }
        self.opening = true;
        self.error.clear();
        cx.notify();
        let shared = self.shared.clone();
        let projection = shared.clone();
        let receiver = client_state::background_request(path.len(), move || {
            (|| -> anyhow::Result<Value> {
                let response = client_state::rpc(&json!({"op":"workspace.open","path":path}))?;
                projection.ingest(client_state::rpc(&json!({"op":"catalog.get"}))?);
                Ok(response)
            })()
            .map_err(|error| error.to_string())
        });
        self.receive_open(receiver, shared, cx);
    }
    fn receive_open(
        &mut self,
        receiver: async_channel::Receiver<Result<Value, String>>,
        shared: Shared,
        cx: &mut Context<Self>,
    ) {
        self.open_task = Some(cx.spawn(async move |this, cx| {
            let result = client_state::response_result(receiver.recv().await);
            let _ = this.update(cx, |this, cx| {
                this.opening = false;
                match result {
                    Ok(result) => {
                        if let Some(id) = result["workspace"]["id"].as_str() {
                            let record = WindowRecord {
                                dock_layout: None,
                                panes: Default::default(),
                                tabs: Default::default(),
                                focused_pane: 5,
                                id: new_id("window"),
                                workspace_id: id.into(),
                                conversation_id: None,
                                browser_url: String::new(),
                                x: 100.,
                                y: 100.,
                                width: 1220.,
                                height: 800.,
                            };
                            crate::bootstrap::open_workspace(true, shared, Some(record), true, cx);
                        }
                    }
                    Err(error) => this.error = error,
                }
                cx.notify();
            });
        }));
    }
}
impl Render for Manager {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        if self.state["operations"]
            .as_array()
            .and_then(|operations| operations.first())
            .and_then(|job| job["error"].as_str())
            .is_none()
        {
            self.job_diagnostics.clear();
        }
        let busy = self.pending || self.state["busy"] == true;
        let ready = self.state["repository"]["id"].is_string();
        let mut trees = v_flex().gap_2();
        for item in self.state["worktrees"].as_array().into_iter().flatten() {
            let Some(path) = item["path"].as_str() else {
                continue;
            };
            let path = path.to_owned();
            let open_path = path.clone();
            let remove_path = path.clone();
            let name = item["branch"].as_str().unwrap_or("Detached HEAD");
            let setup = item["setup_state"].as_str().unwrap_or("ready");
            let retry_target = item["branch"].as_str().unwrap_or(&path).to_owned();
            let owned = item["ade_owned"] == true;
            trees = trees.child(
                h_flex()
                    .gap_2()
                    .p_2()
                    .border_b_1()
                    .border_color(rgb(crate::ui::BORDER))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(format!(
                                "{name} · {} · {setup}",
                                if owned { "lux-ade-managed" } else { "External" }
                            ))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(crate::ui::MUTED))
                                    .child(path.clone()),
                            ),
                    )
                    .when(setup == "failed" || setup == "interrupted", |row| {
                        row.child(
                            crate::ui::row_action(
                                SharedString::from(format!("retry-{path}")),
                                "Retry setup",
                                &path,
                            )
                            .disabled(busy)
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.operation(
                                        json!({"op":"worktree.switch","target":retry_target}),
                                        cx,
                                    )
                                },
                            )),
                        )
                    })
                    .child(
                        crate::ui::row_action(
                            SharedString::from(format!("open-{path}")),
                            "Open",
                            &path,
                        )
                        .disabled(busy || self.opening)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_workspace(open_path.clone(), cx)
                        })),
                    )
                    .child(
                        crate::ui::row_action(
                            SharedString::from(format!("remove-{path}")),
                            "Remove…",
                            &path,
                        )
                        .disabled(busy || !owned)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.confirm = Some(remove_path.clone());
                            cx.notify();
                        })),
                    ),
            );
        }
        let mut body=v_flex().gap_3().p_5().text_sm().text_color(rgb(crate::ui::TEXT)).bg(rgb(crate::ui::CANVAS)).size_full()
            .child(crate::ui::panel_title("Worktrees"))
            .child(crate::ui::section("Create checkouts, open existing branches, and manage their lifecycle."))
            .child(h_flex().gap_2().child(div().flex_1().child(Input::new(&self.repository).aria_label("Repository path"))).child(crate::ui::button("repository").label("Load repository").disabled(busy).on_click(cx.listener(|this,_,_,cx|{this.state=Value::Null;this.confirm=None;this.request(json!({"op":"worktree.repository","path":this.repository.read(cx).value().to_string()}),true,cx);}))))
            .child(h_flex().gap_2().child(div().flex_1().child(Input::new(&self.target).aria_label("Branch name"))).child(div().w(px(220.)).child(Input::new(&self.base).aria_label("Base branch"))))
            .child(h_flex().gap_2()
                .child(crate::ui::button("create").primary().label("Create branch + worktree").disabled(busy||!ready).on_click(cx.listener(|this,_,_,cx|{let mut request=json!({"op":"worktree.switch","target":this.target.read(cx).value().to_string(),"create":true});let base=this.base.read(cx).value().to_string();if !base.is_empty(){request["base"]=json!(base);}this.operation(request,cx);})))
                .child(crate::ui::button("checkout").label("Check out existing branch").disabled(busy||!ready).on_click(cx.listener(|this,_,_,cx|this.operation(json!({"op":"worktree.switch","target":this.target.read(cx).value().to_string()}),cx))))
                .child(crate::ui::button("refresh").label(if busy{"Working…"}else{"Refresh"}).disabled(busy||!ready).on_click(cx.listener(|this,_,_,cx|this.operation(json!({"op":"worktree.refresh"}),cx)))))
            .child(crate::ui::section("Repository settings"))
            .child(v_flex().gap_1().child(crate::ui::field_label("Worktree path template")).child(Input::new(&self.template).aria_label("Worktree path template")))
            .child(v_flex().gap_1().child(crate::ui::field_label("User configuration path")).child(Input::new(&self.user_config).aria_label("User configuration path")))
            .child(v_flex().gap_1().child(crate::ui::field_label("Project configuration path")).child(Input::new(&self.project_config).aria_label("Project configuration path")))
            .child(h_flex().gap_2().child(crate::ui::button("hooks").label(if self.hooks{"Hooks: enabled"}else{"Hooks: disabled"}).disabled(busy).on_click(cx.listener(|this,_,_,cx|{this.hooks= !this.hooks;cx.notify();})))
                .child(crate::ui::button("save-config").label("Save settings").disabled(busy||!ready).on_click(cx.listener(|this,_,_,cx|{
                    let optional=|input:&Entity<InputState>|{let value=input.read(cx).value().to_string();if value.trim().is_empty(){None}else{Some(value)}};
                    let config=Config{user_config:optional(&this.user_config),project_config:optional(&this.project_config),path_template:optional(&this.template),hooks:this.hooks,timeout_seconds:this.state["repository"]["config"]["timeout_seconds"].as_u64().unwrap_or(60)};
                    this.request(json!({"op":"worktree.configure","repository_id":this.state["repository"]["id"],"config":config}),true,cx);
                }))))
            .child(div().text_xs().text_color(rgb(crate::ui::MUTED)).child("Enabling hooks permits user/Git hooks and already-approved project hooks. Worktrunk still requires approval for untrusted project commands."));
        if let Some(path) = self.confirm.clone() {
            let keep = path.clone();
            let merged = path.clone();
            body=body.child(v_flex().gap_2().p_2().border_1().border_color(rgb(crate::ui::ACCENT)).child(format!("Remove {path}? Dirty worktrees and active lux-ade runtimes are protected."))
            .child(h_flex().gap_2().child(crate::ui::button("keep-branch").label("Remove, keep branch").disabled(busy).on_click(cx.listener(move|this,_,_,cx|this.operation(json!({"op":"worktree.remove","path":keep,"delete_branch":"keep"}),cx))))
                .child(crate::ui::button("delete-merged").label("Remove, delete if merged").disabled(busy).on_click(cx.listener(move|this,_,_,cx|this.operation(json!({"op":"worktree.remove","path":merged,"delete_branch":"merged"}),cx))))
                .child(crate::ui::button("cancel-remove").label("Cancel").on_click(cx.listener(|this,_,_,cx|{this.confirm=None;cx.notify();})))));
        }
        if !self.error.is_empty() {
            let details = self.error.clone();
            let expanded = self.diagnostics.is_expanded(&details);
            body = body.child(crate::ui::diagnostic_error_card(
                "request-error",
                "Worktree operation failed",
                "lux-ade could not finish the worktree operation. Check the repository state and requested settings before retrying.",
                details.clone(),
                expanded,
                crate::ui::button("worktree-diagnostics-toggle")
                    .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.diagnostics.toggle(&details);
                        cx.notify();
                    })),
            ));
        }
        if let Some(job) = self.state["operations"].as_array().and_then(|a| a.first()) {
            body = body.child(div().child(format!(
                "{} · {}",
                match job["request"]["op"].as_str() {
                    Some("worktree.switch") => "Checkout",
                    Some("worktree.remove") => "Removal",
                    Some("worktree.refresh") => "Refresh",
                    _ => "Operation",
                },
                job["status"].as_str().unwrap_or("")
            )));
            if let Some(error) = job["error"].as_str() {
                let details = error.to_owned();
                let expanded = self.job_diagnostics.is_expanded(&details);
                body = body.child(crate::ui::diagnostic_error_card(
                    "operation-error",
                    "Worktree operation needs attention",
                    "The worktree operation stopped. Check the recovery guidance and repository state before retrying; lux-ade will not replay it automatically.",
                    details.clone(),
                    expanded,
                    crate::ui::button("worktree-job-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.job_diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ));
            }
            if let Some(recovery) = job["recovery"].as_str() {
                let guidance = match recovery {
                    "inspect_repository_before_retry" => Some(
                        "Refresh the repository and inspect Git history before retrying. This operation will not run again automatically.",
                    ),
                    "inspect_repository" => Some(
                        "Refresh the repository, then check its status and configured hooks before retrying.",
                    ),
                    "check_lifecycle_tools" => Some(
                        "Check Git and Worktrunk installation and executable permissions, then refresh.",
                    ),
                    _ => None,
                };
                if let Some(guidance) = guidance {
                    body = body.child(crate::ui::description(guidance)).child(
                        crate::ui::button("recover-lifecycle-refresh")
                            .label("Refresh repository")
                            .disabled(busy || !ready)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.operation(json!({"op":"worktree.refresh"}), cx)
                            })),
                    );
                }
            }
            if job["status"] == "succeeded" && job["request"]["op"] == "worktree.remove" {
                body = body
                    .child(match job["result"]["branch_outcome"].as_str(){Some("deleted")=>"Worktree and branch removed.",Some("not_attempted")=>"Worktree removed; branch retained.",Some("retained_unmerged")=>"Worktree removed; unmerged branch retained.",Some("retained_checked_out")=>"Worktree removed; branch retained because another checkout uses it.",Some("retained_raced")=>"Worktree removed; branch retained because it changed during removal.",Some("retained_failed")=>"Worktree removed; branch deletion failed.",_=>"Worktree removed; branch outcome is unavailable. Inspect the operation receipt."});
            }
        }
        body.child(
            div()
                .id("worktree-list")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(trees),
        )
    }
}
pub fn open(shared: Shared, path: String, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    Ok(gpui_kit::open_window(
        WindowOptions {
            focus: true,
            show: true,
            window_min_size: Some(size(px(850.), px(760.))),
            window_bounds: Some(WindowBounds::centered(size(px(1000.), px(850.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Worktrees");
            cx.new(|cx| Manager::new(shared, path, window, cx))
        },
    )?
    .0)
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;

    #[gpui::test]
    fn duplicate_open_preserves_pending_reply_and_failure_releases_busy(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let state = shared.clone();
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            crate::ui::install(cx);
            Manager::new(state, "/tmp".into(), window, cx)
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.opening = true;
            view.receive_open(rx, shared, cx);
            view.open_workspace(String::new(), cx);
        });
        visual.run_until_parked();
        assert!(
            !tx.is_closed(),
            "duplicate Open replaced the admitted response"
        );
        view.read_with(visual, |view, _| assert!(view.opening));
        drop(tx);
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert!(!view.opening);
            assert!(view.error.contains("without a response"));
        });
    }

    #[gpui::test]
    fn closing_worktrees_releases_both_response_waiters(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let state = shared.clone();
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            crate::ui::install(cx);
            Manager::new(state, "/tmp".into(), window, cx)
        });
        let (request_tx, request_rx) = async_channel::bounded(1);
        let (open_tx, open_rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_request(request_rx, false, false, cx);
            view.receive_open(open_rx, shared, cx);
        });
        visual.run_until_parked();
        assert!(!request_tx.is_closed());
        assert!(!open_tx.is_closed());
        visual.update(|window, _| window.remove_window());
        let weak = view.downgrade();
        drop(view);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(weak.upgrade().is_none());
        assert!(
            request_tx.is_closed(),
            "closed Worktrees retains its operation response waiter"
        );
        assert!(
            open_tx.is_closed(),
            "closed Worktrees retains its workspace-open response waiter"
        );
    }
}
