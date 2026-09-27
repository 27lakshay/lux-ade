//! Setup and teardown hooks. Each hook runs under the lifecycle supervisor,
//! which keeps the repository lock if the daemon dies and refuses to start
//! when the tree was replaced since ADE checked it. Output is bounded.
//!
//! While a hook runs, its status streams into [`LiveHooks`], which
//! `worktree.operation` reads (F067). The live record is memory only: it ends
//! with the hook, and a daemon restart reports the operation as interrupted.
use super::policy::{hook_verdict, output_tail};
use super::{Tap, capture, identity, neutral};
use crate::model::now_ms;
use ade_core::contract::worktrees::{
    HookPhase, HookVerdict, WorktreeHookProgress, WorktreeHookRun,
};
use ade_core::worktrees::Hook;
use std::{
    collections::HashMap,
    fs::File,
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    time::Instant,
};

/// Each stream keeps its last 64 KiB.
const OUTPUT_CAP: usize = 64 * 1024;
/// A running hook shows its last 16 KiB of combined output.
const LIVE_CAP: usize = 16 * 1024;

/// The hook each running operation is executing, keyed by operation ID.
#[derive(Default)]
pub(super) struct LiveHooks(Mutex<HashMap<String, Arc<Mutex<LiveHook>>>>);

impl LiveHooks {
    /// The running hook of `operation_id`, if any.
    pub(super) fn progress(&self, operation_id: &str) -> Option<WorktreeHookProgress> {
        let live = self.0.lock().unwrap().get(operation_id).cloned()?;
        let live = live.lock().unwrap();
        Some(live.progress())
    }
    fn start(&self, operation_id: &str, live: LiveHook) -> Arc<Mutex<LiveHook>> {
        let live = Arc::new(Mutex::new(live));
        self.0
            .lock()
            .unwrap()
            .insert(operation_id.to_owned(), live.clone());
        live
    }
    fn finish(&self, operation_id: &str) {
        self.0.lock().unwrap().remove(operation_id);
    }
}

/// What is known about a hook while it runs.
struct LiveHook {
    name: String,
    phase: HookPhase,
    path: String,
    index: u32,
    total: u32,
    started_at: i64,
    started: Instant,
    output: BoundedTail,
    completed: Vec<WorktreeHookRun>,
}

impl LiveHook {
    fn progress(&self) -> WorktreeHookProgress {
        let (output, cut) = output_tail(&self.output.bytes, LIVE_CAP);
        WorktreeHookProgress {
            name: self.name.clone(),
            phase: self.phase,
            path: self.path.clone(),
            index: self.index,
            total: self.total,
            started_at: self.started_at,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            output,
            truncated: self.output.truncated || cut,
            completed: self.completed.clone(),
        }
    }
}

/// The last `cap` bytes of a stream, trimmed in batches so appending costs
/// linear time. It holds at most twice `cap` between trims.
struct BoundedTail {
    bytes: Vec<u8>,
    cap: usize,
    truncated: bool,
}

impl BoundedTail {
    fn new(cap: usize) -> Self {
        Self {
            bytes: Vec::new(),
            cap,
            truncated: false,
        }
    }
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > self.cap * 2 {
            self.bytes.drain(..self.bytes.len() - self.cap);
            self.truncated = true;
        }
    }
}

/// Where and for whom hooks run.
pub(super) struct HookContext<'a> {
    pub worker: &'a Path,
    pub tree: &'a Path,
    pub branch: Option<&'a str>,
    pub root: &'a str,
    pub operation_id: &'a str,
    pub lock: &'a File,
    pub live: &'a LiveHooks,
}

/// Runs `hooks` in order and stops at the first that does not succeed.
pub(super) fn run_hooks(
    hooks: &[Hook],
    phase: HookPhase,
    cx: &HookContext,
) -> Vec<WorktreeHookRun> {
    let mut runs: Vec<WorktreeHookRun> = Vec::with_capacity(hooks.len());
    for (index, hook) in hooks.iter().enumerate() {
        let live = cx.live.start(
            cx.operation_id,
            LiveHook {
                name: hook.name.clone(),
                phase,
                path: cx.tree.to_string_lossy().into_owned(),
                index: index as u32,
                total: hooks.len() as u32,
                started_at: now_ms(),
                started: Instant::now(),
                output: BoundedTail::new(LIVE_CAP),
                completed: runs
                    .iter()
                    .map(|run| WorktreeHookRun {
                        output: None,
                        ..run.clone()
                    })
                    .collect(),
            },
        );
        let tap: Tap = Arc::new(move |chunk: &[u8]| live.lock().unwrap().output.push(chunk));
        let run = run_hook(hook, phase, cx, tap);
        let succeeded = run.verdict == HookVerdict::Succeeded;
        runs.push(run);
        if !succeeded {
            break;
        }
    }
    cx.live.finish(cx.operation_id);
    runs
}

/// The verdict of the last hook that ran; `None` when none ran.
pub(super) fn last_verdict(runs: &[WorktreeHookRun]) -> Option<HookVerdict> {
    runs.last().map(|run| run.verdict)
}

fn run_hook(hook: &Hook, phase: HookPhase, cx: &HookContext, tap: Tap) -> WorktreeHookRun {
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
        Some(tap),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_output_keeps_only_a_bounded_tail() {
        let mut tail = BoundedTail::new(8);
        tail.push(b"0123");
        assert_eq!(
            (tail.bytes.as_slice(), tail.truncated),
            (&b"0123"[..], false)
        );
        for _ in 0..1000 {
            tail.push(b"abcdefgh");
        }
        tail.push(b"END");
        assert!(tail.bytes.len() <= 16);
        assert!(tail.truncated);
        let (shown, cut) = output_tail(&tail.bytes, 8);
        assert_eq!(shown, "defghEND");
        assert!(cut);
    }
}
