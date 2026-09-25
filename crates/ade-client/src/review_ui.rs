//! Disposable native review projection. All Git access stays in the daemon.
use crate::client_state;
use ade_core::model::new_id;
use gpui_kit::{
    component::{
        button::*,
        input::{Input, InputState},
        *,
    },
    *,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct Changes {
    workspace: String,
    root: String,
    message: Entity<InputState>,
    state: Value,
    diff: Value,
    selected: Option<String>,
    staged: bool,
    page: usize,
    hunk: usize,
    lines: Arc<Vec<String>>,
    pending: bool,
    background_refresh: bool,
    queued: Option<Value>,
    job: Option<String>,
    error: String,
    diagnostics: crate::ui::DiagnosticDisclosure,
    notice: String,
    _poll: Task<()>,
    read_request: Option<client_state::ReadRequest>,
    response_task: Option<Task<()>>,
}
impl Changes {
    fn new(workspace: String, root: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let message =
            cx.new(|cx| InputState::new(window, cx).placeholder("Describe the staged changes"));
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                if this
                    .update(cx, |this, cx| {
                        if !this.pending {
                            if let Some(id) = this.job.clone() {
                                this.request(json!({"op":"review.operation","request_id":id}), cx);
                            } else {
                                this.refresh(false, cx);
                            }
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let mut view = Self {
            workspace,
            root,
            message,
            state: Value::Null,
            diff: Value::Null,
            selected: None,
            staged: false,
            page: 0,
            hunk: 0,
            lines: Arc::new(Vec::new()),
            pending: false,
            background_refresh: false,
            queued: None,
            job: None,
            error: String::new(),
            diagnostics: Default::default(),
            notice: String::new(),
            _poll: poll,
            read_request: None,
            response_task: None,
        };
        view.refresh(true, cx);
        view
    }
    fn refresh(&mut self, force: bool, cx: &mut Context<Self>) {
        self.request(json!({"op":"review.status","force":force}), cx);
    }
    fn select(&mut self, path: String, cx: &mut Context<Self>) {
        if (self.pending && !self.background_refresh) || self.job.is_some() {
            return;
        }
        self.selected = Some(path.clone());
        self.diff = Value::Null;
        self.lines = Arc::new(Vec::new());
        self.hunk = 0;
        self.error.clear();
        self.request(
            json!({"op":"review.diff","path":path,"staged":self.staged}),
            cx,
        );
    }
    fn set_lines(&mut self) {
        let text = self.diff["hunks"]
            .as_array()
            .and_then(|h| h.get(self.hunk))
            .and_then(Value::as_str)
            .unwrap_or_else(|| self.diff["header"].as_str().unwrap_or(""));
        self.lines = Arc::new(text.lines().map(str::to_owned).collect());
    }
    fn mutate(&mut self, mut value: Value, cx: &mut Context<Self>) {
        if (self.pending && !self.background_refresh) || self.job.is_some() {
            return;
        }
        let id = new_id("review-operation");
        value["request_id"] = json!(id);
        self.job = Some(id);
        self.error.clear();
        self.notice = "Applying Git operation…".into();
        self.request(value, cx);
    }
    fn request(&mut self, mut value: Value, cx: &mut Context<Self>) {
        if self.pending {
            if self.background_refresh {
                self.queued = Some(value);
                self.background_refresh = false;
                cx.notify();
            }
            return;
        }
        self.background_refresh = value["op"] == "review.status" && !self.state.is_null();
        self.pending = true;
        value["workspace_id"] = json!(self.workspace);
        let kind = value["op"].as_str().unwrap().to_owned();
        let rx = if client_state::is_disposable_read(&value) {
            let (handle, rx) = client_state::disposable_read(value);
            self.read_request = Some(handle);
            rx
        } else {
            client_state::background_request(value.to_string().len(), move || {
                client_state::rpc(&value).map_err(|error| error.to_string())
            })
        };
        cx.notify();
        self.receive_request(rx, kind, cx);
    }
    fn receive_request(
        &mut self,
        rx: async_channel::Receiver<Result<Value, String>>,
        kind: String,
        cx: &mut Context<Self>,
    ) {
        self.response_task = Some(cx.spawn(async move |this, cx| {
            let result = client_state::response_result(rx.recv().await);
            let _ = this.update_in(cx, |this, window, cx| {
                this.read_request = None;
                this.pending = false;
                this.background_refresh = false;
                cx.notify();
                // A click during a background refresh takes precedence over
                // that older projection. Dispatch it once the read releases Git.
                if let Some(queued) = this.queued.take() {
                    this.request(queued, cx);
                    return;
                }
                match result {
                    Err(e) => {
                        if kind == "review.operation" && e.contains("Unknown review operation") {
                            this.job = None;
                            this.notice.clear();
                            if !this.error.is_empty() {
                                cx.notify();
                                return;
                            }
                        }
                        this.error = e;
                        cx.notify();
                    }
                    Ok(value) => match value["type"].as_str() {
                        Some("review_status") => {
                            if this.error.starts_with("Repository is busy")
                                || this.error.starts_with("A Git or Worktrunk command")
                            {
                                this.error.clear();
                                cx.notify();
                            }
                            if this.state["revision"] != value["revision"] {
                                this.state = value;
                                cx.notify();
                                if let Some(path) = this.selected.clone() {
                                    let still_changed =
                                        this.state["files"].as_array().into_iter().flatten().any(
                                            |f| {
                                                f["path"] == path
                                                    && f[if this.staged {
                                                        "staged"
                                                    } else {
                                                        "unstaged"
                                                    }] == true
                                            },
                                        );
                                    if still_changed {
                                        this.select(path, cx);
                                    } else {
                                        this.selected = None;
                                        this.diff = Value::Null;
                                        this.lines = Arc::new(Vec::new());
                                    }
                                }
                            }
                        }
                        Some("review_diff") => {
                            this.diff = value;
                            this.hunk = 0;
                            this.set_lines();
                            cx.notify();
                        }
                        Some("review_operation") => {
                            let op = &value["operation"];
                            if op["status"] != "running" {
                                this.job = None;
                                if op["status"] == "succeeded" {
                                    this.error.clear();
                                    this.notice = if op["op"] == "review.commit" {
                                        this.message.update(cx, |input, cx| {
                                            input.set_value("", window, cx)
                                        });
                                        format!(
                                            "Committed {}",
                                            op["result"]["head"].as_str().unwrap_or("")
                                        )
                                    } else {
                                        "Staging area updated.".into()
                                    };
                                } else {
                                    this.notice.clear();
                                    this.error = op["error"]
                                        .as_str()
                                        .unwrap_or("Git operation did not complete")
                                        .into();
                                }
                                this.refresh(true, cx);
                            }
                            cx.notify();
                        }
                        _ => {}
                    },
                }
            });
        }));
    }
}
impl Render for Changes {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        let busy = (self.pending && !self.background_refresh) || self.job.is_some();
        let files: Vec<&Value> = self.state["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f[if self.staged { "staged" } else { "unstaged" }] == true)
            .collect();
        let staged_count = self.state["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["staged"] == true)
            .count();
        let unstaged_count = self.state["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["unstaged"] == true)
            .count();
        let conflicts = self.state["conflicts"].as_u64().unwrap_or(0);
        let pages = files.len().max(1).div_ceil(40);
        self.page = self.page.min(pages - 1);
        let mut file_list = v_flex().gap_1();
        for file in files.iter().skip(self.page * 40).take(40) {
            let path = file["path"].as_str().unwrap().to_owned();
            let selected = self.selected.as_deref() == Some(&path);
            let label = format!(
                "{}  {}{}",
                file["code"].as_str().unwrap_or(""),
                path,
                if file["conflict"] == true {
                    " · Conflict"
                } else {
                    ""
                }
            );
            file_list = file_list.child(
                crate::ui::button(SharedString::from(format!("file-{path}")))
                    .accessibility_label(label.clone())
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_left()
                            .text_ellipsis()
                            .child(label),
                    )
                    .w_full()
                    .selected(selected)
                    .disabled(busy)
                    .on_click(cx.listener(move |this, _, _, cx| this.select(path.clone(), cx))),
            );
        }
        if files.is_empty() {
            file_list = file_list.child(div().p_3().child(if self.state.is_null() {
                if !self.error.is_empty() {
                    "Could not load changes. Use Refresh to try again."
                } else if self.pending {
                    "Loading changes…"
                } else {
                    "Changes are unavailable. Use Refresh to try again."
                }
            } else if self.staged {
                "No staged changes"
            } else {
                "No unstaged changes"
            }));
        }
        let left = v_flex()
            .w(px(280.))
            .min_w(px(240.))
            .pr_3()
            .border_r_1()
            .border_color(rgb(crate::ui::BORDER))
            .h_full()
            .gap_2()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        crate::ui::button("unstaged")
                            .label(format!("Unstaged ({unstaged_count})"))
                            .selected(!self.staged)
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.staged = false;
                                this.selected = None;
                                this.diff = Value::Null;
                                this.lines = Arc::new(Vec::new());
                                this.page = 0;
                                cx.notify();
                            })),
                    )
                    .child(
                        crate::ui::button("staged")
                            .label(format!("Staged ({staged_count})"))
                            .selected(self.staged)
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.staged = true;
                                this.selected = None;
                                this.diff = Value::Null;
                                this.lines = Arc::new(Vec::new());
                                this.page = 0;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .id("changed-files")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(file_list),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        crate::ui::button("files-prev")
                            .label("Previous files")
                            .disabled(busy || self.page == 0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page -= 1;
                                cx.notify();
                            })),
                    )
                    .child(format!("{}/{}", self.page + 1, pages))
                    .child(
                        crate::ui::button("files-next")
                            .label("Next files")
                            .disabled(busy || self.page + 1 >= pages)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page += 1;
                                cx.notify();
                            })),
                    ),
            );
        let mut right = v_flex().flex_1().min_w_0().h_full().gap_2();
        if let Some(path) = self.selected.clone() {
            let conflict = self.state["files"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|f| f["path"] == path && f["conflict"] == true);
            right=right.child(div().text_base().child(path.clone()))
                .child(h_flex().gap_2().child(if self.staged{"HEAD → staging area"}else{"Staging area → working files"})
                    .child(crate::ui::button("file-action").label(if self.staged{"Unstage file"}else if conflict{"Mark resolved (stage file)"}else{"Stage file"})
                        .disabled(busy).on_click(cx.listener(move|this,_,_,cx|this.mutate(json!({"op":if this.staged{"review.unstage"}else{"review.stage"},"path":path,"revision":this.state["revision"]}),cx)))));
            if conflict {
                right=right.child(div().text_color(rgb(crate::ui::ACCENT)).child("Conflict: edit the working file to resolve it, then mark it resolved. Commit is blocked while conflicts remain."));
            }
            let hunks = self.diff["hunks"].as_array().map_or(0, Vec::len);
            if hunks > 0 {
                right=right.child(h_flex().gap_2()
                    .child(crate::ui::button("hunk-prev").label("Previous hunk").disabled(busy||self.hunk==0).on_click(cx.listener(|this,_,_,cx|{this.hunk-=1;this.set_lines();cx.notify();})))
                    .child(format!("Hunk {} of {hunks}",self.hunk+1))
                    .child(crate::ui::button("hunk-next").label("Next hunk").disabled(busy||self.hunk+1>=hunks).on_click(cx.listener(|this,_,_,cx|{this.hunk+=1;this.set_lines();cx.notify();})))
                    .child(crate::ui::button("hunk-action").label(if self.staged{"Unstage hunk"}else{"Stage hunk"}).disabled(busy||self.diff["hunk_actions"]!=true)
                        .on_click(cx.listener(|this,_,_,cx|this.mutate(json!({"op":"review.hunk","path":this.selected,"staged":this.staged,"token":this.diff["token"],"hunk":this.hunk}),cx)))));
            }
            if self.diff["binary"] == true {
                right = right.child("Binary file · use the whole-file action.");
            } else if !self.diff.is_null() && self.diff["hunk_actions"] != true && !conflict {
                right = right
                    .child("Mode, submodule or special-file change · use the whole-file action.");
            }
            let lines = self.lines.clone();
            right = right.child(
                uniform_list(
                    SharedString::from(format!("diff-{}-{}", self.diff["token"], self.hunk)),
                    lines.len(),
                    move |range, _, _| {
                        range
                            .map(|i| {
                                let line = &lines[i];
                                let color = if line.starts_with('+') {
                                    rgb(crate::ui::SUCCESS)
                                } else if line.starts_with('-') {
                                    rgb(crate::ui::DANGER)
                                } else if line.starts_with("@@") {
                                    rgb(crate::ui::ACCENT)
                                } else {
                                    rgb(crate::ui::TEXT)
                                };
                                div()
                                    .h(px(22.))
                                    .px_2()
                                    .text_sm()
                                    .font_family("Menlo")
                                    .text_color(color)
                                    .whitespace_nowrap()
                                    .child(if line.chars().take(4001).count() > 4000 {
                                        format!(
                                            "{} … [line display limited to 4,000 characters]",
                                            line.chars().take(4000).collect::<String>()
                                        )
                                    } else {
                                        line.clone()
                                    })
                            })
                            .collect::<Vec<_>>()
                    },
                )
                .with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained)
                .flex_1()
                .min_h_0(),
            );
        } else {
            right=right.child(div().p_4().text_color(rgb(crate::ui::MUTED)).child("Select a file to review its diff. Files load individually; working files stay intact when you stage or unstage."));
        }
        let mut body = v_flex()
            .size_full()
            .p_5()
            .gap_3()
            .bg(rgb(crate::ui::CANVAS))
            .text_color(rgb(crate::ui::TEXT))
            .text_sm()
            .child(
                h_flex()
                    .gap_3()
                    .child(crate::ui::panel_title("Changes"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_color(rgb(crate::ui::MUTED))
                            .child(format!(
                                "{} · {}",
                                self.state["branch"].as_str().unwrap_or(""),
                                self.root
                            )),
                    )
                    .child(
                        crate::ui::button("new-review-window")
                            .label("New review window")
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Err(error) =
                                    open(this.workspace.clone(), this.root.clone(), cx)
                                {
                                    this.error = error.to_string();
                                    cx.notify();
                                }
                            })),
                    )
                    .child(
                        crate::ui::button("review-refresh")
                            .label(if busy { "Working…" } else { "Refresh" })
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.error.clear();
                                this.refresh(true, cx);
                            })),
                    ),
            )
            .child(h_flex().flex_1().min_h_0().gap_4().child(left).child(right));
        if conflicts > 0 {
            body = body.child(div().text_color(rgb(crate::ui::ACCENT)).child(format!(
                "{conflicts} conflicting file(s). Resolve them before committing."
            )));
        }
        if !self.error.is_empty() {
            if self.error == "Enter a commit message." {
                body = body.child(crate::ui::validation_card(
                    "Commit message required",
                    self.error.clone(),
                ));
            } else {
                let details = self.error.clone();
                let expanded = self.diagnostics.is_expanded(&details);
                body = body.child(crate::ui::diagnostic_error_card(
                    "review-error",
                    "Review failed",
                    "lux-ade could not finish the review action. Check the staged files and repository state before retrying.",
                    details.clone(),
                    expanded,
                    crate::ui::button("review-diagnostics-toggle")
                        .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.diagnostics.toggle(&details);
                            cx.notify();
                        })),
                ));
            }
        }
        if !self.notice.is_empty() {
            body = body.child(div().child(self.notice.clone()));
        }
        body.child(div().child("Commit message"))
            .child(h_flex().gap_2().child(div().flex_1().child(Input::new(&self.message).aria_label("Commit message").disabled(self.job.is_some())))
                .child(crate::ui::button("commit-staged").primary().label(format!("Commit {staged_count} staged file(s)")).disabled(busy||staged_count==0||conflicts>0)
                    .on_click(cx.listener(|this,_,_,cx|{let message=this.message.read(cx).value().to_string();if message.trim().is_empty(){this.error="Enter a commit message.".into();cx.notify();return;}this.mutate(json!({"op":"review.commit","message":message,"index_token":this.state["index_token"]}),cx);}))))
            .child(div().text_xs().text_color(rgb(crate::ui::MUTED)).child("Commit uses Git’s configured identity, signing and hooks. It includes staged changes only."))
    }
}
pub fn open(workspace: String, root: String, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    Ok(gpui_kit::open_window(
        WindowOptions {
            focus: true,
            show: true,
            window_min_size: Some(size(px(1000.), px(650.))),
            window_bounds: Some(WindowBounds::centered(size(px(1250.), px(800.)), cx)),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("lux-ade — Changes");
            cx.new(|cx| Changes::new(workspace, root, window, cx))
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
    fn closed_review_response_releases_pending_and_preserves_projection(cx: &mut TestAppContext) {
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            crate::ui::install(cx);
            Changes {
                workspace: "workspace".into(),
                root: "/tmp".into(),
                message: cx.new(|cx| InputState::new(window, cx)),
                state: Value::Null,
                diff: Value::Null,
                selected: None,
                staged: false,
                page: 0,
                hunk: 0,
                lines: Arc::new(Vec::new()),
                pending: false,
                background_refresh: false,
                queued: None,
                job: None,
                error: String::new(),
                diagnostics: Default::default(),
                notice: String::new(),
                _poll: Task::ready(()),
                read_request: None,
                response_task: None,
            }
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.state = json!({"revision":42,"files":[]});
            view.pending = true;
            view.background_refresh = true;
            view.receive_request(rx, "review.status".into(), cx);
        });
        drop(tx);
        visual.run_until_parked();
        view.read_with(visual, |view, _| {
            assert!(!view.pending, "lost response leaves review stuck working");
            assert!(!view.background_refresh);
            assert_eq!(view.state["revision"], 42);
            assert!(view.error.contains("without a response"));
        });
    }
    #[gpui::test]
    fn closing_review_releases_pending_response(cx: &mut TestAppContext) {
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            crate::ui::install(cx);
            Changes {
                workspace: "workspace".into(),
                root: "/tmp".into(),
                message: cx.new(|cx| InputState::new(window, cx)),
                state: Value::Null,
                diff: Value::Null,
                selected: None,
                staged: false,
                page: 0,
                hunk: 0,
                lines: Arc::new(Vec::new()),
                pending: false,
                background_refresh: false,
                queued: None,
                job: None,
                error: String::new(),
                diagnostics: Default::default(),
                notice: String::new(),
                _poll: Task::ready(()),
                read_request: None,
                response_task: None,
            }
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_request(rx, "review.status".into(), cx);
        });
        visual.run_until_parked();
        assert!(!tx.is_closed());
        visual.update(|window, _| window.remove_window());
        let weak = view.downgrade();
        drop(view);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(weak.upgrade().is_none(), "review entity still retained");
        assert!(tx.is_closed(), "closed review retains its response waiter");
    }
}
