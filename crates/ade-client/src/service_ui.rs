//! Workspace service controls. Status refreshes never replace an in-progress edit.
use crate::{
    Workspace,
    client_state::{self, Shared},
};
use ade_core::{
    model::WorkspaceRecord,
    services::{Config, Service},
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    component::{
        button::*,
        input::{Input, InputState, Textarea, TextareaState},
        *,
    },
    *,
};
use serde_json::{Value, json};
use std::time::Duration;

enum EitherResponse {
    Read(async_channel::Receiver<Result<Value, String>>),
    Mutation(async_channel::Receiver<Result<(Value, Value), String>>),
}
struct Manager {
    parent: AnyWindowHandle,
    owner: WeakEntity<Workspace>,
    workspace: WorkspaceRecord,
    shared: Shared,
    name: Entity<InputState>,
    program: Entity<InputState>,
    cwd: Entity<InputState>,
    ports: Entity<InputState>,
    args: Entity<TextareaState>,
    env: Entity<TextareaState>,
    selected: Option<Service>,
    baseline: Vec<String>,
    snapshot: Value,
    busy: bool,
    refreshing: bool,
    generation: u64,
    error: String,
    error_is_validation: bool,
    diagnostics: crate::ui::DiagnosticDisclosure,
    notice: String,
    _poll: Task<()>,
    read_request: Option<client_state::ReadRequest>,
    response_task: Option<Task<()>>,
}
impl Manager {
    fn values(&self, cx: &App) -> Vec<String> {
        vec![
            self.name.read(cx).value().to_string(),
            self.program.read(cx).value().to_string(),
            self.cwd.read(cx).value().to_string(),
            self.ports.read(cx).value().to_string(),
            self.args.read(cx).value().to_string(),
            self.env.read(cx).value().to_string(),
        ]
    }
    fn dirty(&self, cx: &App) -> bool {
        self.values(cx) != self.baseline
    }
    fn load(&mut self, service: Option<Service>, window: &mut Window, cx: &mut Context<Self>) {
        let config = service
            .as_ref()
            .map(|s| s.config.clone())
            .unwrap_or(Config {
                program: String::new(),
                args: vec![],
                env: Default::default(),
                cwd: ".".into(),
                ports: vec![],
                health: None,
            });
        for (field, value) in [
            (
                &self.name,
                service.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
            ),
            (&self.program, config.program),
            (&self.cwd, config.cwd),
            (&self.ports, config.ports.join(", ")),
        ] {
            field.update(cx, |input, cx| input.set_value(value, window, cx));
        }
        self.args.update(cx, |input, cx| {
            input.set_value(
                serde_json::to_string_pretty(&config.args).unwrap(),
                window,
                cx,
            )
        });
        self.env.update(cx, |input, cx| {
            input.set_value(
                serde_json::to_string_pretty(&config.env).unwrap(),
                window,
                cx,
            )
        });
        self.selected = service;
        self.baseline = self.values(cx);
        self.error.clear();
        self.error_is_validation = false;
        self.notice.clear();
        cx.notify();
    }
    fn choose(&mut self, service: Option<Service>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty(cx) {
            self.error = "Save your edits or use Discard edits before switching services.".into();
            self.error_is_validation = true;
            cx.notify();
            return;
        }
        self.load(service, window, cx);
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        let result = (|| -> anyhow::Result<Config> {
            let config=Config {program:self.program.read(cx).value().to_string(),cwd:self.cwd.read(cx).value().to_string(),
                args:serde_json::from_str(self.args.read(cx).value().as_ref()).map_err(|_|anyhow::anyhow!("Arguments must be a JSON array of strings, for example [\"dev\", \"--host\"]."))?,
                env:serde_json::from_str(self.env.read(cx).value().as_ref()).map_err(|_|anyhow::anyhow!("Environment must be a JSON object of string values, for example {{\"NODE_ENV\":\"development\"}}."))?,
                ports:self.ports.read(cx).value().split(',').map(str::trim).filter(|s|!s.is_empty()).map(String::from).collect(),
                health:self.selected.as_ref().and_then(|service|service.config.health.clone())};
            config.validate()?;
            Ok(config)
        })();
        match result {
            Ok(config)=>self.request(json!({"op":"service.configure","workspace_id":self.workspace.id,"name":self.name.read(cx).value(),"revision":self.selected.as_ref().map_or(0,|s|s.revision),"config":config}),cx),
            Err(error)=>{self.error=error.to_string();self.error_is_validation=true;cx.notify();}
        }
    }
    fn request(&mut self, request: Value, cx: &mut Context<Self>) {
        let refresh = request["op"] == "service.list";
        if self.busy || (refresh && self.refreshing) {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.refreshing = refresh;
        self.busy = !refresh;
        if !refresh {
            self.error.clear();
            self.error_is_validation = false;
            self.notice = "Working…".into();
        }
        let op = request["op"].as_str().unwrap_or("").to_owned();
        let workspace = self.workspace.id.clone();
        let shared = self.shared.clone();
        let rx = if refresh {
            let (handle, rx) = client_state::disposable_read(request);
            self.read_request = Some(handle);
            // Map the lightweight response in the GPUI async task below.
            EitherResponse::Read(rx)
        } else {
            // Superseding a refresh cancels its socket; generation checks prevent
            // its completion from changing this mutation's UI state.
            self.read_request = None;
            EitherResponse::Mutation(client_state::background_request(
                request.to_string().len(),
                move || {
                    (|| -> anyhow::Result<(Value, Value)> {
                        let response = client_state::rpc(&request)?;
                        shared.ingest(client_state::rpc(&json!({"op":"catalog.get"}))?);
                        let snapshot = client_state::rpc(
                            &json!({"op":"service.list","workspace_id":workspace}),
                        )?;
                        Ok((response, snapshot))
                    })()
                    .map_err(|error| error.to_string())
                },
            ))
        };
        self.receive_request(rx, op, refresh, generation, cx);
        cx.notify();
    }
    fn receive_request(
        &mut self,
        rx: EitherResponse,
        op: String,
        refresh: bool,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        self.response_task = Some(cx.spawn(async move |this, cx| {
            let response = match rx {
                EitherResponse::Read(rx) => rx
                    .recv()
                    .await
                    .map(|result| result.map(|value| (value.clone(), value))),
                EitherResponse::Mutation(rx) => rx.recv().await,
            };
            let result = client_state::response_result(response);
            let _ = this.update_in(cx, |this, window, cx| {
                if this.generation != generation {
                    return;
                }
                this.read_request = None;
                this.busy = false;
                this.refreshing = false;
                match result {
                    Ok((response, snapshot)) => {
                        this.snapshot = snapshot;
                        if op == "service.configure" {
                            if let Ok(service) = serde_json::from_value(response["service"].clone())
                            {
                                this.load(Some(service), window, cx);
                            }
                            this.notice = "Service saved.".into();
                        } else if op == "service.remove" {
                            this.load(None, window, cx);
                            this.notice = "Service removed.".into();
                        } else if !refresh {
                            this.notice = if op == "service.start" {
                                "Service started. Open output to follow it."
                            } else {
                                "Service stopped. Its output is still available."
                            }
                            .into();
                        }
                    }
                    Err(error) => {
                        this.error = error;
                        this.error_is_validation = false;
                        this.notice.clear();
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn output(&mut self, service: Service, cx: &mut Context<Self>) {
        let Some(id) = service.terminal_id else {
            return;
        };
        let owner = self.owner.clone();
        let workspace = self.workspace.id.clone();
        let result = self.parent.update(cx, move |_, window, cx| {
            owner.update(cx, |this, cx| {
                anyhow::ensure!(
                    this.workspace.id == workspace,
                    "Switch the workspace window back to this folder before opening output"
                );
                this.show_service_terminal(&id, &service.name, window, cx)?;
                window.activate_window();
                Ok(())
            })?
        });
        if let Err(error) = result.and_then(|r| r) {
            self.error = error.to_string();
            self.error_is_validation = true;
            cx.notify();
        }
    }
}
impl Render for Manager {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.error.is_empty() {
            self.diagnostics.clear();
        }
        let services: Vec<Service> =
            serde_json::from_value(self.snapshot["services"].clone()).unwrap_or_default();
        let mut list = v_flex().gap_2();
        if services.is_empty() {
            list = list.child(div().text_color(rgb(crate::ui::MUTED)).child(
                if self.snapshot["services"].is_array() {
                    "No services yet. Add a command for this workspace."
                } else if !self.error.is_empty() {
                    "Could not load services. Use Refresh to try again."
                } else if self.refreshing {
                    "Loading services…"
                } else {
                    "Services are unavailable. Use Refresh to try again."
                },
            ));
        }
        for service in services {
            let name = service.name.clone();
            let edit = service.clone();
            let output = service.clone();
            let state = self.snapshot["states"][&name]["state"]
                .as_str()
                .unwrap_or("unavailable")
                .to_owned();
            let owned = service.terminal_owner.is_some();
            let start_name = name.clone();
            let stop_name = name.clone();
            let selected = self.selected.as_ref().is_some_and(|s| s.name == name);
            list=list.child(v_flex().gap_2().p_3().bg(rgb(if selected{crate::ui::SURFACE}else{crate::ui::CANVAS})).border_b_1().border_color(rgb(crate::ui::BORDER))
                .child(h_flex().justify_between().child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone())).child(div().text_xs().text_color(rgb(if state=="running"{crate::ui::SUCCESS}else{crate::ui::MUTED})).child(state)))
                .child(div().text_xs().text_color(rgb(crate::ui::MUTED)).child(service.config.program.clone()))
                .child(div().text_xs().child(service.ports.iter().map(|(k,v)|format!("{k} {v}")).collect::<Vec<_>>().join(" · ")))
                .child(h_flex().gap_1()
                    .child(crate::ui::row_action(SharedString::from(format!("start-{name}")), "Start", &name).disabled(self.busy||owned).on_click(cx.listener(move|this,_,_,cx|this.request(json!({"op":"service.start","workspace_id":this.workspace.id,"name":start_name}),cx))))
                    .child(crate::ui::row_action(SharedString::from(format!("stop-{name}")), "Stop", &name).disabled(self.busy||!owned).on_click(cx.listener(move|this,_,_,cx|this.request(json!({"op":"service.stop","workspace_id":this.workspace.id,"name":stop_name}),cx))))
                    .child(crate::ui::row_action(SharedString::from(format!("output-{name}")), "Output", &name).disabled(self.busy||service.terminal_id.is_none()).on_click(cx.listener(move|this,_,_,cx|this.output(output.clone(),cx))))
                    .child(crate::ui::row_action(SharedString::from(format!("edit-{name}")), "Edit", &name).disabled(self.busy).on_click(cx.listener(move|this,_,window,cx|this.choose(Some(edit.clone()),window,cx))))));
        }
        let selected = self.selected.clone();
        let owned = selected.as_ref().is_some_and(|s| {
            self.snapshot["services"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| v["name"] == s.name && !v["terminal_owner"].is_null())
        });
        let disabled = self.busy || owned;
        let field = |label: &'static str, input: &Entity<InputState>, disabled: bool| {
            v_flex()
                .gap_1()
                .child(crate::ui::field_label(label))
                .child(Input::new(input).aria_label(label).disabled(disabled))
        };
        let mut form=v_flex().gap_3()
            .child(crate::ui::section(if selected.is_some(){"Service configuration"}else{"New service"}))
            .child(field("Name",&self.name,disabled||selected.is_some()))
            .child(field("Executable",&self.program,disabled))
            .child(field("Directory relative to workspace",&self.cwd,disabled))
            .child(v_flex().gap_1().child(crate::ui::field_label("Arguments · JSON array")).child(Textarea::new(&self.args).h(px(90.)).aria_label("Service arguments").disabled(disabled)))
            .child(v_flex().gap_1().child(crate::ui::field_label("Environment · JSON object")).child(Textarea::new(&self.env).h(px(100.)).aria_label("Service environment").disabled(disabled)))
            .child(field("Port variables · comma separated",&self.ports,disabled))
            .child(div().text_xs().text_color(rgb(crate::ui::MUTED)).child("Each port variable receives a stable port. Arguments are passed literally; use a shell executable when you need shell syntax."))
            .child(h_flex().gap_2()
                .child(crate::ui::button("save-service").primary().label("Save service").disabled(disabled).on_click(cx.listener(|this,_,_,cx|this.save(cx))))
                .child(crate::ui::button("discard-service").label("Discard edits").disabled(self.busy).on_click(cx.listener(|this,_,window,cx|{
                    let latest=this.selected.as_ref().and_then(|s|this.snapshot["services"].as_array()?.iter().find(|v|v["name"]==s.name)).and_then(|v|serde_json::from_value(v.clone()).ok());
                    this.load(latest,window,cx);
                })))
                .child(crate::ui::button("remove-service").label("Remove").disabled(disabled||selected.is_none()).on_click(cx.listener(move|this,_,_,cx|{
                    if let Some(s)=&selected {this.request(json!({"op":"service.remove","workspace_id":this.workspace.id,"name":s.name,"revision":s.revision}),cx);}
                }))));
        if owned {
            form = form.child(
                div()
                    .text_sm()
                    .text_color(rgb(crate::ui::MUTED))
                    .child("Stop this service before changing its configuration."),
            );
        }
        v_flex().size_full().bg(rgb(crate::ui::CANVAS)).text_color(rgb(crate::ui::TEXT)).p_5().gap_3()
            .child(h_flex().justify_between().child(v_flex().child(crate::ui::panel_title("Services")).child(div().text_sm().text_color(rgb(crate::ui::MUTED)).child(self.workspace.root.clone())))
                .child(h_flex().gap_2().child(crate::ui::button("new-service").label("New service").disabled(self.busy).on_click(cx.listener(|this,_,window,cx|this.choose(None,window,cx))))
                    .child(crate::ui::button("refresh-services").label("Refresh").disabled(self.busy||self.refreshing).on_click(cx.listener(|this,_,_,cx|this.request(json!({"op":"service.list","workspace_id":this.workspace.id}),cx))))))
            .when(!self.error.is_empty(), |el| {
                if self.error_is_validation {
                    el.child(crate::ui::validation_card("Service needs attention", self.error.clone()))
                } else {
                    let details = self.error.clone();
                    let expanded = self.diagnostics.is_expanded(&details);
                    el.child(crate::ui::diagnostic_error_card(
                        "service-error", "Service operation failed",
                        "lux-ade could not finish the service operation. Check the service and workspace state before retrying.",
                        details.clone(), expanded,
                        crate::ui::button("service-diagnostics-toggle")
                            .label(if expanded { "Hide diagnostics" } else { "Show diagnostics" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.diagnostics.toggle(&details);
                                cx.notify();
                            })),
                    ))
                }
            })
            .child(div().text_sm().text_color(rgb(crate::ui::MUTED)).child(self.notice.clone()))
            .child(h_flex().flex_1().min_h_0().gap_5().items_start()
                .child(div().id("service-list").w(px(300.)).h_full().pr_3().border_r_1().border_color(rgb(crate::ui::BORDER)).overflow_y_scroll().child(list))
                .child(div().id("service-form").flex_1().h_full().overflow_y_scroll().child(form)))
    }
}
pub fn open(
    shared: Shared,
    workspace: WorkspaceRecord,
    owner: WeakEntity<Workspace>,
    parent: &mut Window,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let parent = Window::window_handle(parent);
    Ok(gpui_kit::open_window(WindowOptions {focus:true,show:true,window_min_size:Some(size(px(1000.),px(780.))),window_bounds:Some(WindowBounds::centered(size(px(1080.),px(860.)),cx)),..Default::default()},cx,|window,cx|{
        window.set_window_title("lux-ade — Services");
        cx.new(|cx|{
            let name=cx.new(|cx|InputState::new(window,cx).placeholder("web"));
            let program=cx.new(|cx|InputState::new(window,cx).placeholder("pnpm"));
            let cwd=cx.new(|cx|InputState::new(window,cx));let ports=cx.new(|cx|InputState::new(window,cx).placeholder("PORT, API_PORT"));
            let args=cx.new(|cx|TextareaState::new(window,cx));let env=cx.new(|cx|TextareaState::new(window,cx));
            let poll=cx.spawn(async move|this,cx|loop{
                cx.background_executor().timer(Duration::from_secs(2)).await;
                if this.update_in(cx,|this:&mut Manager,window,cx|{if window.is_visible(){this.request(json!({"op":"service.list","workspace_id":this.workspace.id}),cx);}}).is_err(){break;}
            });
            let mut manager=Manager {parent,owner,workspace,shared,name,program,cwd,ports,args,env,selected:None,baseline:vec![],snapshot:Value::Null,busy:false,refreshing:false,generation:0,error:String::new(),error_is_validation:false,diagnostics:Default::default(),notice:String::new(),_poll:poll,read_request:None,response_task:None};
            manager.load(None,window,cx);
            manager.request(json!({"op":"service.list","workspace_id":manager.workspace.id}),cx);
            manager
        })
    })?.0)
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    use gpui_kit as gpui;
    use std::prelude::v1::test;

    #[gpui::test]
    fn closing_services_releases_pending_response(cx: &mut TestAppContext) {
        let shared = std::sync::Arc::new(client_state::ClientState::default());
        let (view, visual) = cx.add_window_view(|window, cx| {
            gpui_kit::init(cx);
            crate::ui::install(cx);
            let workspace = WorkspaceRecord { id: "services".into(), name: "Services".into(), root: "/tmp".into(), repository_id: None, terminal_id: "terminal".into(), extra_terminals: vec![] };
            let record = serde_json::from_value(json!({"id":"services-window","workspace_id":"services","conversation_id":null,"browser_url":"","x":0.,"y":0.,"width":1000.,"height":800.})).unwrap();
            let owner = cx.new(|cx| Workspace::new(record, workspace.clone(), false, true, shared.clone(), window, cx));
            Manager {
                parent: window.window_handle(), owner: owner.downgrade(), workspace, shared,
                name: cx.new(|cx| InputState::new(window, cx)),
                program: cx.new(|cx| InputState::new(window, cx)),
                cwd: cx.new(|cx| InputState::new(window, cx)),
                ports: cx.new(|cx| InputState::new(window, cx)),
                args: cx.new(|cx| TextareaState::new(window, cx)),
                env: cx.new(|cx| TextareaState::new(window, cx)),
                selected: None, baseline: vec![], snapshot: Value::Null,
                busy: false, refreshing: true, generation: 1, error: String::new(), error_is_validation: false, diagnostics: Default::default(), notice: String::new(),
                _poll: Task::ready(()), read_request: None, response_task: None,
            }
        });
        let (tx, rx) = async_channel::bounded(1);
        view.update(visual, |view, cx| {
            view.receive_request(EitherResponse::Read(rx), "service.list".into(), true, 1, cx);
        });
        visual.run_until_parked();
        assert!(!tx.is_closed());
        visual.update(|window, _| window.remove_window());
        let weak = view.downgrade();
        drop(view);
        visual.cx.update(|_| {});
        visual.run_until_parked();
        assert!(weak.upgrade().is_none());
        assert!(
            tx.is_closed(),
            "closed Services retains its response waiter"
        );
    }
}
