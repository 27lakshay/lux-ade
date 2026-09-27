//! Setup and teardown hooks. Each hook runs under the lifecycle supervisor,
//! which keeps the repository lock if the daemon dies and refuses to start
//! when the tree was replaced since ADE checked it. Output is bounded.
use super::policy::{hook_verdict, output_tail};
use super::{capture, identity, neutral};
use ade_core::contract::worktrees::{HookPhase, HookVerdict, WorktreeHookRun};
use ade_core::worktrees::Hook;
use std::{fs::File, path::Path, process::Command};

/// Each stream keeps its last 64 KiB.
const OUTPUT_CAP: usize = 64 * 1024;

/// Where and for whom hooks run.
pub(super) struct HookContext<'a> {
    pub worker: &'a Path,
    pub tree: &'a Path,
    pub branch: Option<&'a str>,
    pub root: &'a str,
    pub operation_id: &'a str,
    pub lock: &'a File,
}

/// Runs `hooks` in order and stops at the first that does not succeed.
pub(super) fn run_hooks(
    hooks: &[Hook],
    phase: HookPhase,
    cx: &HookContext,
) -> Vec<WorktreeHookRun> {
    let mut runs = Vec::with_capacity(hooks.len());
    for hook in hooks {
        let run = run_hook(hook, phase, cx);
        let succeeded = run.verdict == HookVerdict::Succeeded;
        runs.push(run);
        if !succeeded {
            break;
        }
    }
    runs
}

/// The verdict of the last hook that ran; `None` when none ran.
pub(super) fn last_verdict(runs: &[WorktreeHookRun]) -> Option<HookVerdict> {
    runs.last().map(|run| run.verdict)
}

fn run_hook(hook: &Hook, phase: HookPhase, cx: &HookContext) -> WorktreeHookRun {
    let mut run = WorktreeHookRun {
        name: hook.name.clone(),
        phase,
        verdict: HookVerdict::Failed,
        exit_code: None,
        elapsed_ms: 0,
        output: None,
        truncated: false,
    };
    let Some(tree) = cx.tree.to_str() else {
        run.output = Some("Worktree path is not UTF-8".into());
        return run;
    };
    let (device, inode) = match identity(tree) {
        Ok(found) => found,
        Err(error) => {
            run.output = Some(format!("Worktree is unavailable: {error}"));
            return run;
        }
    };
    let mut command = Command::new(cx.worker);
    command.arg("--worktree-worker").args(&hook.command);
    neutral(&mut command);
    command
        .current_dir(cx.tree)
        .env("ADE_EXPECT_CWD_DEV", device)
        .env("ADE_EXPECT_CWD_INO", inode)
        .env(
            "ADE_HOOK_PHASE",
            match phase {
                HookPhase::Setup => "setup",
                HookPhase::Teardown => "teardown",
            },
        )
        .env("ADE_WORKTREE_PATH", tree)
        .env("ADE_WORKTREE_BRANCH", cx.branch.unwrap_or(""))
        .env("ADE_REPOSITORY_ROOT", cx.root)
        .env("ADE_OPERATION_ID", cx.operation_id);
    match capture(
        command,
        hook.timeout_seconds,
        Some(cx.lock),
        None,
        OUTPUT_CAP,
        true,
    ) {
        Ok(captured) => {
            run.verdict = hook_verdict(captured.code, captured.timed_out, captured.pipes_closed);
            run.exit_code = captured.code;
            run.elapsed_ms = captured.elapsed_ms;
            let (stdout, out_cut) = output_tail(&captured.stdout, OUTPUT_CAP);
            let (stderr, err_cut) = output_tail(&captured.stderr, OUTPUT_CAP);
            run.truncated = captured.truncated || out_cut || err_cut;
            run.output = Some(stdout + &stderr);
        }
        // The supervisor never started, so the hook had no effect.
        Err(error) => run.output = Some(format!("Hook could not start: {error}")),
    }
    run
}
