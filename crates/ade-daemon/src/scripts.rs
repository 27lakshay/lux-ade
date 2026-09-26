//! Workspace package scripts run as supervised PTYs and retain bounded output in
//! the runtime's existing service spool. The public run ID is also the runtime
//! terminal key, so a daemon handoff can inspect and stop the same process.
use ade_core::{
    model::{WorkspaceRecord, new_id},
    scripts::{self, Script, run_name},
    terminal_launch::Launch,
};
use ade_runtime::runtime::Supervisor;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn terminal<'a>(catalogue: &'a Value, workspace_id: &str, run_id: &str) -> Result<&'a Value> {
    catalogue["terminals"]
        .as_array()
        .context("Invalid terminal catalogue")?
        .iter()
        .find(|item| {
            item["workspace"]["id"] == workspace_id && item["workspace"]["terminal_id"] == run_id
        })
        .context("Script run is unavailable")
}

fn run_state(terminal: &Value, run_id: &str) -> Value {
    json!({"run_id":run_id,"name":run_name(run_id).unwrap_or(""),
        "state":if terminal["metrics"]["shell_running"] == true {"running"} else {"exited"},
        "metrics":terminal["metrics"]})
}

pub fn command(
    workspace: WorkspaceRecord,
    runtime: &Supervisor,
    subscribers: usize,
    request: &Value,
    register: &impl Fn(&str) -> Result<()>,
    retire: &impl Fn(&str) -> Result<()>,
) -> Result<Value> {
    let root = Path::new(&workspace.root);
    match request["op"].as_str().unwrap_or("") {
        "script.list" => {
            let scripts = scripts::discover(root)?;
            Ok(json!({"type":"scripts","workspace_id":workspace.id,"scripts":scripts}))
        }
        "script.runs" => {
            let catalogue = runtime.command(json!({"op":"terminal.list"}))?;
            let runs = catalogue["terminals"]
                .as_array()
                .context("Invalid terminal catalogue")?
                .iter()
                .filter_map(|terminal| {
                    let run_id = terminal["workspace"]["terminal_id"].as_str()?;
                    (terminal["workspace"]["id"] == workspace.id
                        && workspace.extra_terminals.iter().any(|id| id == run_id)
                        && run_name(run_id).is_ok())
                    .then(|| run_state(terminal, run_id))
                })
                .collect::<Vec<_>>();
            Ok(json!({"type":"script_runs","workspace_id":workspace.id,"runs":runs}))
        }
        "script.start" => {
            let name = request["name"].as_str().context("Missing script name")?;
            ensure!(scripts::valid_name(name), "Invalid script name");
            let configured: Script = scripts::discover(root)?
                .into_iter()
                .find(|script| script.name == name)
                .context("Workspace script is not configured")?;
            let run_id = format!(
                "script_{}_{}",
                configured.name,
                new_id("run").trim_start_matches("run_")
            );
            let transfer_id = new_id("transfer");
            let (program, env) = match std::env::var("ADE_PNPM_BIN") {
                Ok(program) => {
                    let parent = Path::new(&program)
                        .parent()
                        .context("Bundled pnpm executable has no parent directory")?;
                    ensure!(
                        parent.is_absolute(),
                        "Bundled pnpm executable must be absolute"
                    );
                    let previous = std::env::var_os("PATH").unwrap_or_default();
                    let path = std::env::join_paths(
                        std::iter::once(parent.to_path_buf()).chain(
                            std::env::split_paths(&previous)
                                .filter(|path| !path.as_os_str().is_empty()),
                        ),
                    )?
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Script PATH is not valid UTF-8"))?;
                    let mut env = std::collections::BTreeMap::new();
                    env.insert("PATH".to_owned(), path);
                    (program, env)
                }
                Err(std::env::VarError::NotPresent) => ("pnpm".into(), Default::default()),
                Err(error) => return Err(error.into()),
            };
            let launch = Launch {
                transfer_id: transfer_id.clone(),
                program,
                args: vec!["run".into(), configured.name],
                env,
                cwd: None,
            };
            let mut workspace = workspace;
            workspace.terminal_id = run_id.clone();
            register(&run_id)?;
            let result = match runtime.command(json!({"op":"terminal.launch","workspace":workspace,
                "terminal_key":run_id,"launch":launch,"session_subscribers":subscribers}))
            {
                Ok(result) => result,
                Err(error) => {
                    // A failed response is not proof the runtime did not admit
                    // the launch. Preserve any observed run for recovery.
                    let observed_absent = runtime
                        .command(json!({"op":"terminal.list"}))
                        .ok()
                        .and_then(|catalogue| catalogue["terminals"].as_array().cloned())
                        .is_some_and(|items| {
                            items.iter().all(|item| {
                                item["workspace"]["id"] != workspace.id
                                    || item["workspace"]["terminal_id"] != run_id
                            })
                        });
                    if !observed_absent {
                        return Err(error);
                    }
                    retire(&run_id)?;
                    return Err(error);
                }
            };
            ensure!(
                result["metrics"]["transfer_id"] == transfer_id,
                "Script launch returned another transfer identity"
            );
            Ok(json!({"type":"script_run","run_id":run_id,"name":name,
                "workspace_id":workspace.id,
                "state":if result["metrics"]["shell_running"] == true {"running"} else {"exited"},
                "metrics":result["metrics"]}))
        }
        "script.inspect" => {
            let run_id = request["run_id"]
                .as_str()
                .context("Missing script run ID")?;
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let limit = request["tail_bytes"].as_u64().unwrap_or(8192);
            ensure!(
                (1..=32768).contains(&limit),
                "Tail limit must be 1 to 32768 bytes"
            );
            let catalogue = runtime.command(json!({"op":"terminal.list"}))?;
            let item = terminal(&catalogue, &workspace.id, run_id)?;
            let mut result = run_state(item, run_id);
            let transfer_id = item["metrics"]["transfer_id"]
                .as_str()
                .context("Script transfer identity is unavailable")?;
            let tail = runtime.command(json!({"op":"terminal.tail","workspace_id":workspace.id,
                "terminal_id":run_id,"limit_bytes":limit}))?;
            ensure!(
                tail["transfer_id"] == transfer_id,
                "Script run changed during inspection"
            );
            result["output"] = tail;
            result["durable_output"] = ade_runtime::service_logs::tail(
                runtime.data_directory(),
                &workspace.id,
                run_id,
                transfer_id,
                limit as usize,
            );
            result["type"] = json!("script_run");
            result["workspace_id"] = json!(workspace.id);
            Ok(result)
        }
        "script.stop" => {
            let run_id = request["run_id"]
                .as_str()
                .context("Missing script run ID")?;
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let catalogue = runtime.command(json!({"op":"terminal.list"}))?;
            let item = terminal(&catalogue, &workspace.id, run_id)?;
            let transfer_id = item["metrics"]["transfer_id"]
                .as_str()
                .context("Script transfer identity is unavailable")?
                .to_owned();
            if item["metrics"]["shell_running"] == true {
                runtime.command(json!({"op":"terminal.stop","workspace_id":workspace.id,
                    "terminal_id":run_id}))?;
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let catalogue = runtime.command(json!({"op":"terminal.list"}))?;
                let item = terminal(&catalogue, &workspace.id, run_id)?;
                ensure!(
                    item["metrics"]["transfer_id"] == transfer_id,
                    "Script run changed during stop"
                );
                if item["metrics"]["shell_running"] == false {
                    return Ok(json!({"type":"script_run","workspace_id":workspace.id,
                        "run_id":run_id,"name":run_name(run_id)?,"state":"exited",
                        "metrics":item["metrics"]}));
                }
                if Instant::now() >= deadline {
                    bail!("Script has not exited; retry stop to confirm cleanup");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        "script.retire" => {
            let run_id = request["run_id"]
                .as_str()
                .context("Missing script run ID")?;
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let catalogue = runtime.command(json!({"op":"terminal.list"}))?;
            let item = catalogue["terminals"]
                .as_array()
                .context("Invalid terminal catalogue")?
                .iter()
                .find(|item| {
                    item["workspace"]["id"] == workspace.id
                        && item["workspace"]["terminal_id"] == run_id
                });
            if let Some(item) = item {
                ensure!(
                    item["metrics"]["shell_running"] == false,
                    "Stop the script before retiring its run"
                );
                // The runtime owns the PTY and spool. Keep the durable handle
                // until that owner confirms cleanup. A later retry or daemon
                // restore can finish the metadata removal after a crash.
                runtime.command(json!({"op":"terminal.retire","workspace_id":workspace.id,
                    "terminal_id":run_id}))?;
                pause_retirement_for_e2e(run_id)?;
            }
            retire(run_id)?;
            Ok(json!({"type":"ack","workspace_id":workspace.id,"run_id":run_id}))
        }
        _ => bail!("Unknown script operation"),
    }
}

fn pause_retirement_for_e2e(run_id: &str) -> Result<()> {
    let Ok(marker) = std::env::var("ADE_E2E_SCRIPT_RETIRE_GATE") else {
        return Ok(());
    };
    let marker = Path::new(&marker);
    ensure!(marker.is_absolute(), "Invalid script retire gate path");
    std::fs::write(marker, run_id)?;
    let release = marker.with_extension("release");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
