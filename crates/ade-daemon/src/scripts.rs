//! Workspace package scripts run as supervised PTYs and retain bounded output in
//! the runtime's existing service spool. The public run ID is also the runtime
//! terminal key, so a daemon handoff can inspect and stop the same process.
use ade_core::runtime_protocol::terminal::Command as TerminalCommand;
use ade_core::{
    contract::scripts::{
        OutputCoverage, OutputCoverageReason, OutputCoverageStatus, ScriptInspectRequest,
        ScriptInspection, ScriptList, ScriptListRequest, ScriptRetireRequest, ScriptRetired,
        ScriptRun, ScriptRunState, ScriptRunStatus, ScriptRuns, ScriptRunsRequest,
        ScriptStartRequest, ScriptStopRequest,
    },
    model::{WorkspaceRecord, new_id},
    scripts::{self, Script, run_name},
    terminal_launch::Launch,
};
use ade_runtime::runtime::Supervisor;
use anyhow::{Context, Result, anyhow, bail, ensure};
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

/// Deserializes a request into its contract type. A missing field reports the
/// handler's existing message for it; other shape errors name the request.
pub(crate) fn decode<T: serde::de::DeserializeOwned>(
    request: &Value,
    missing: &[(&str, &str)],
) -> Result<T> {
    T::deserialize(request).map_err(|error| {
        let text = error.to_string();
        let field = text
            .strip_prefix("missing field `")
            .and_then(|rest| rest.split('`').next());
        match field {
            Some(field) => match missing.iter().find(|(name, _)| *name == field) {
                Some((_, message)) => anyhow!("{message}"),
                None => anyhow!("Missing {field}"),
            },
            None => anyhow!("Invalid request: {text}"),
        }
    })
}

const MISSING_RUN_ID: &[(&str, &str)] = &[("run_id", "Missing script run ID")];

fn run_state(terminal: &Value, run_id: &str) -> ScriptRunState {
    let metrics = &terminal["metrics"];
    let state = match metrics["exit_status"]["kind"].as_str() {
        Some("success" | "failure" | "signaled") => ScriptRunStatus::Exited,
        Some("unknown") => ScriptRunStatus::Unknown,
        _ if metrics["shell_running"] == true => ScriptRunStatus::Running,
        _ => ScriptRunStatus::Unknown,
    };
    ScriptRunState {
        run_id: run_id.to_owned(),
        name: run_name(run_id).unwrap_or("").to_owned(),
        state,
        metrics: metrics.clone(),
        exit_status: metrics.get("exit_status").cloned(),
    }
}

/// Whether `script.stop` can answer: the run was reaped or its exit is unknown,
/// and the runtime has finished verifying the process tree. [`run_state`]
/// then reports only a proven exit as exited.
fn stop_settled(metrics: &Value) -> bool {
    (metrics["shell_running"] == false || metrics["exit_status"]["kind"] == "unknown")
        && metrics["exit_status"]["verifying"] != true
}

fn script_run(workspace_id: &str, run: ScriptRunState, toolchain: Option<Value>) -> Result<Value> {
    Ok(serde_json::to_value(ScriptRun {
        tag: Default::default(),
        workspace_id: workspace_id.to_owned(),
        run,
        toolchain,
    })?)
}

fn output_coverage(metrics: &Value, durable: &Value) -> OutputCoverage {
    use OutputCoverageReason::*;
    use OutputCoverageStatus::*;
    let produced = metrics["terminal_bytes"].as_u64();
    let returned_start = durable["start_offset"].as_u64();
    let captured_through = durable["through_offset"].as_u64();
    let (status, reason) = if metrics["durable_log_error"].as_str().is_some() {
        (Incomplete, Some(CaptureError))
    } else if durable["available"] != true {
        (Incomplete, Some(DurableOutputUnavailable))
    } else if durable["retention_overflow"] == true {
        (Incomplete, Some(RetentionOverflow))
    } else if durable["segment_gap"] == true {
        (Incomplete, Some(SegmentGap))
    } else if metrics["shell_running"] == true {
        (Pending, Some(ProcessRunning))
    } else if !matches!(
        metrics["exit_status"]["kind"].as_str(),
        Some("success" | "failure" | "signaled")
    ) {
        (Incomplete, Some(ExitUnknown))
    } else if produced.is_none() || captured_through != produced {
        (Incomplete, Some(CaptureGap))
    } else if durable["truncated"] == true || returned_start != Some(0) {
        (Incomplete, Some(TailLimited))
    } else {
        (Complete, None)
    };
    OutputCoverage {
        status,
        reason,
        produced_bytes: produced,
        captured_through_offset: captured_through,
        returned_start_offset: returned_start,
    }
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
            let _: ScriptListRequest = decode(request, &[])?;
            Ok(serde_json::to_value(ScriptList {
                tag: Default::default(),
                workspace_id: workspace.id,
                scripts: scripts::discover(root)?,
            })?)
        }
        "script.runs" => {
            let _: ScriptRunsRequest = decode(request, &[])?;
            let catalogue = runtime.command(TerminalCommand::List)?;
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
            Ok(serde_json::to_value(ScriptRuns {
                tag: Default::default(),
                workspace_id: workspace.id,
                runs,
            })?)
        }
        "script.start" => {
            let start: ScriptStartRequest = decode(request, &[("name", "Missing script name")])?;
            let name = start.name.as_str();
            ensure!(scripts::valid_name(name), "Invalid script name");
            let configured: Script = scripts::discover(root)?
                .into_iter()
                .find(|script| script.name() == name)
                .context("Workspace script is not configured")?;
            let run_id = format!(
                "script_{}_{}",
                configured.name(),
                new_id("run").trim_start_matches("run_")
            );
            let transfer_id = new_id("transfer");
            let (program, args, cwd, env, toolchain) = match configured {
                Script::PackageJson { name, .. } => {
                    let selected = crate::toolchain::select(root, None)?;
                    (
                        selected.program,
                        vec!["run".into(), name],
                        None,
                        selected.env,
                        Some(selected.description),
                    )
                }
                Script::AdeRecipe {
                    program, args, cwd, ..
                } => {
                    if ["node", "npm", "pnpm", "yarn", "bun"].contains(&program.as_str()) {
                        let selected = crate::toolchain::select(&root.join(&cwd), Some(&program))?;
                        (
                            selected.program,
                            args,
                            Some(cwd),
                            selected.env,
                            Some(selected.description),
                        )
                    } else {
                        (program, args, Some(cwd), Default::default(), None)
                    }
                }
            };
            let launch = Launch {
                transfer_id: transfer_id.clone(),
                program,
                args,
                env,
                cwd,
            };
            let mut workspace = workspace;
            workspace.terminal_id = run_id.clone();
            register(&run_id)?;
            let result = match runtime.command(TerminalCommand::Launch {
                workspace: workspace.clone(),
                terminal_key: Some(run_id.clone()),
                launch,
                session_subscribers: subscribers,
            }) {
                Ok(result) => result,
                Err(error) => {
                    // A failed response is not proof the runtime did not admit
                    // the launch. Preserve any observed run for recovery.
                    let observed_absent = runtime
                        .command(TerminalCommand::List)
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
            let run = run_state(&json!({"metrics":result["metrics"]}), &run_id);
            script_run(&workspace.id, run, toolchain)
        }
        "script.inspect" => {
            let inspect: ScriptInspectRequest = decode(request, MISSING_RUN_ID)?;
            let run_id = inspect.run_id.as_str();
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let limit = inspect.tail_bytes.unwrap_or(8192);
            ensure!(
                (1..=32768).contains(&limit),
                "Tail limit must be 1 to 32768 bytes"
            );
            let catalogue = runtime.command(TerminalCommand::List)?;
            let item = terminal(&catalogue, &workspace.id, run_id)?;
            let run = run_state(item, run_id);
            let transfer_id = item["metrics"]["transfer_id"]
                .as_str()
                .context("Script transfer identity is unavailable")?;
            let tail = runtime.command(TerminalCommand::Tail {
                workspace_id: workspace.id.clone(),
                terminal_id: run_id.to_string(),
                limit_bytes: limit,
            })?;
            ensure!(
                tail["transfer_id"] == transfer_id,
                "Script run changed during inspection"
            );
            let durable = ade_runtime::service_logs::tail(
                runtime.data_directory(),
                &workspace.id,
                run_id,
                transfer_id,
                limit as usize,
            );
            Ok(serde_json::to_value(ScriptInspection {
                tag: Default::default(),
                workspace_id: workspace.id.clone(),
                run,
                output: tail,
                output_coverage: output_coverage(&item["metrics"], &durable),
                durable_output: durable,
            })?)
        }
        "script.stop" => {
            let stop: ScriptStopRequest = decode(request, MISSING_RUN_ID)?;
            let run_id = stop.run_id.as_str();
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let catalogue = runtime.command(TerminalCommand::List)?;
            let item = terminal(&catalogue, &workspace.id, run_id)?;
            let transfer_id = item["metrics"]["transfer_id"]
                .as_str()
                .context("Script transfer identity is unavailable")?
                .to_owned();
            if item["metrics"]["exit_status"]["kind"] == "unknown" && stop_settled(&item["metrics"])
            {
                return script_run(&workspace.id, run_state(item, run_id), None);
            }
            if item["metrics"]["shell_running"] == true {
                runtime.command(TerminalCommand::Stop {
                    workspace_id: workspace.id.clone(),
                    terminal_id: run_id.to_string(),
                })?;
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let catalogue = runtime.command(TerminalCommand::List)?;
                let item = terminal(&catalogue, &workspace.id, run_id)?;
                ensure!(
                    item["metrics"]["transfer_id"] == transfer_id,
                    "Script run changed during stop"
                );
                if stop_settled(&item["metrics"]) {
                    return script_run(&workspace.id, run_state(item, run_id), None);
                }
                if Instant::now() >= deadline {
                    bail!("Script has not exited; retry stop to confirm cleanup");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        "script.retire" => {
            let retire_request: ScriptRetireRequest = decode(request, MISSING_RUN_ID)?;
            let run_id = retire_request.run_id.as_str();
            run_name(run_id)?;
            ensure!(
                workspace.extra_terminals.iter().any(|id| id == run_id),
                "Script run is unavailable"
            );
            let catalogue = runtime.command(TerminalCommand::List)?;
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
                runtime.command(TerminalCommand::Retire {
                    workspace_id: workspace.id.clone(),
                    terminal_id: run_id.to_string(),
                })?;
                pause_retirement_for_e2e(run_id)?;
            }
            retire(run_id)?;
            Ok(serde_json::to_value(ScriptRetired {
                tag: Default::default(),
                workspace_id: workspace.id,
                run_id: run_id.to_owned(),
            })?)
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

#[cfg(test)]
mod stop_tests {
    use super::*;
    #[test]
    fn a_stop_with_a_live_tree_answers_unknown_not_exited() {
        let verifying = json!({"metrics": {"shell_running": false, "exit_status":
            {"kind": "unknown", "verifying": true, "child": {"kind": "signaled", "signal": 9}}}});
        assert!(!stop_settled(&verifying["metrics"]));
        let live = json!({"metrics": {"shell_running": false, "exit_status":
            {"kind": "unknown", "child": {"kind": "signaled", "signal": 9},
             "descendants": {"verdict": "live"}}}});
        assert!(stop_settled(&live["metrics"]));
        assert!(matches!(
            run_state(&live, "script:build:1").state,
            ScriptRunStatus::Unknown
        ));
        let exited = json!({"metrics": {"shell_running": false, "exit_status":
            {"kind": "signaled", "signal": 15, "descendants": {"verdict": "exited"}}}});
        assert!(stop_settled(&exited["metrics"]));
        assert!(matches!(
            run_state(&exited, "script:build:1").state,
            ScriptRunStatus::Exited
        ));
        assert!(!stop_settled(&json!({"shell_running": true})));
    }
}
