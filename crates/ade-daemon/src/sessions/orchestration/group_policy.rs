//! Pure rules for parallel run groups (F105): run admission, the group's
//! aggregate status, workspace sharing, path overlaps and the committed-file
//! list. Nothing here reads the store, Git or the clock.
use super::policy;
use ade_core::contract::orchestration::{
    CommittedFile, GroupState, GroupSummary, Outcome, PathOverlap, RunSpec, WaitState,
    WorkspaceChoice,
};
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const MIN_RUNS: usize = 2;
pub const MAX_RUNS: usize = 8;
/// Committed files one run reports before the list is cut.
pub const MAX_COMMITTED_FILES: usize = 2000;

/// A group needs 2 to 8 runs, each with a provider, and no two
/// `new_worktree` runs may name the same workspace.
pub fn check_runs(runs: &[RunSpec]) -> Result<()> {
    ensure!(
        (MIN_RUNS..=MAX_RUNS).contains(&runs.len()),
        "A parallel group needs {MIN_RUNS} to {MAX_RUNS} runs"
    );
    let mut worktrees = BTreeSet::new();
    for run in runs {
        policy::check_id("provider", &run.provider)?;
        if let WorkspaceChoice::NewWorktree { workspace_id, .. } = &run.workspace {
            policy::check_id("workspace_id", workspace_id)?;
            ensure!(
                worktrees.insert(workspace_id.as_str()),
                "Two runs name the same new worktree workspace ({workspace_id})"
            );
        }
    }
    Ok(())
}

/// The child link's operation ID for run `index` of a group.
pub fn run_operation_id(group_id: &str, index: usize) -> String {
    format!("{group_id}/{index}")
}

/// Counts runs by state and names the group's state. Only evidence counts:
/// an unknown or unavailable run never makes a group `completed`, and an
/// empty group is `ended`, not `completed`.
pub fn summarize<'a>(states: impl IntoIterator<Item = &'a WaitState>) -> GroupSummary {
    let mut summary = GroupSummary {
        state: GroupState::Ended,
        runs: 0,
        pending: 0,
        needs_input: 0,
        blocked: 0,
        completed: 0,
        failed: 0,
        interrupted: 0,
        unknown: 0,
        unavailable: 0,
    };
    for state in states {
        summary.runs += 1;
        let count = match state {
            WaitState::Pending { .. } | WaitState::TimedOut { .. } => &mut summary.pending,
            WaitState::NeedsInput { .. } => &mut summary.needs_input,
            WaitState::Blocked { .. } => &mut summary.blocked,
            WaitState::Unavailable { .. } => &mut summary.unavailable,
            WaitState::Settled { outcome, .. } => match outcome {
                Outcome::Completed => &mut summary.completed,
                Outcome::Failed => &mut summary.failed,
                Outcome::Interrupted => &mut summary.interrupted,
                Outcome::Unknown => &mut summary.unknown,
            },
        };
        *count += 1;
    }
    summary.state = if summary.needs_input + summary.blocked > 0 {
        GroupState::NeedsAttention
    } else if summary.pending > 0 {
        GroupState::Running
    } else if summary.runs > 0 && summary.completed == summary.runs {
        GroupState::Completed
    } else {
        GroupState::Ended
    };
    summary
}

/// For each run, whether its workspace is the parent's or another run's.
pub fn shared_workspaces(parent_workspace: &str, workspaces: &[&str]) -> Vec<bool> {
    let mut uses: HashMap<&str, usize> = HashMap::new();
    for workspace in workspaces {
        *uses.entry(workspace).or_default() += 1;
    }
    workspaces
        .iter()
        .map(|workspace| *workspace == parent_workspace || uses[workspace] > 1)
        .collect()
}

/// One run's changed paths, or `None` when they could not be read.
pub struct RunPaths<'a> {
    pub index: u32,
    pub workspace_id: &'a str,
    pub paths: Option<Vec<&'a str>>,
}

/// Paths changed in more than one workspace, sorted by path. Runs that share
/// a workspace count as one place, but each is listed. A run whose changes
/// could not be read contributes nothing.
pub fn overlaps(runs: &[RunPaths]) -> Vec<PathOverlap> {
    let mut by_path: BTreeMap<&str, (BTreeSet<&str>, BTreeSet<u32>)> = BTreeMap::new();
    for run in runs {
        for path in run.paths.iter().flatten() {
            let entry = by_path.entry(path).or_default();
            entry.0.insert(run.workspace_id);
            entry.1.insert(run.index);
        }
    }
    // A shared workspace's paths belong to every run in it.
    let mut by_workspace: HashMap<&str, BTreeSet<u32>> = HashMap::new();
    for run in runs.iter().filter(|run| run.paths.is_some()) {
        by_workspace
            .entry(run.workspace_id)
            .or_default()
            .insert(run.index);
    }
    by_path
        .into_iter()
        .filter(|(_, (workspaces, _))| workspaces.len() > 1)
        .map(|(path, (workspaces, mut indexes))| {
            for workspace in workspaces {
                indexes.extend(&by_workspace[workspace]);
            }
            PathOverlap {
                path: path.to_owned(),
                runs: indexes.into_iter().collect(),
            }
        })
        .collect()
}

/// Parses `git diff --name-status -z --no-renames` output. Returns the files,
/// cut at `limit`, and whether more were present. Malformed output is an
/// error, never a shorter list.
pub fn parse_name_status(raw: &str, limit: usize) -> Result<(Vec<CommittedFile>, bool)> {
    let mut fields = raw.split('\0');
    let mut files = Vec::new();
    let mut truncated = false;
    while let Some(code) = fields.next() {
        if code.is_empty() {
            ensure!(
                fields.all(str::is_empty),
                "Git returned an invalid file list"
            );
            break;
        }
        ensure!(
            code.len() == 1 && code.chars().all(|c| c.is_ascii_uppercase()),
            "Git returned an invalid file status"
        );
        let path = fields
            .next()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Git returned an invalid file list"))?;
        if files.len() == limit {
            truncated = true;
            continue;
        }
        files.push(CommittedFile {
            path: path.to_owned(),
            code: code.to_owned(),
        });
    }
    Ok((files, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::orchestration::{AccountChoice, PendingPhase};

    fn run(provider: &str, workspace: WorkspaceChoice) -> RunSpec {
        RunSpec {
            provider: provider.into(),
            account: AccountChoice::Ambient,
            workspace,
            provider_config: None,
        }
    }

    fn worktree(id: &str) -> WorkspaceChoice {
        WorkspaceChoice::NewWorktree {
            workspace_id: id.into(),
            repository_id: "r".into(),
            worktree_operation_id: format!("op-{id}"),
        }
    }

    fn settled(outcome: Outcome) -> WaitState {
        WaitState::Settled {
            outcome,
            error: None,
        }
    }

    #[test]
    fn runs_need_a_bounded_count_and_distinct_worktrees() {
        assert!(check_runs(&[run("codex", worktree("a"))]).is_err());
        assert!(check_runs(&vec![run("codex", WorkspaceChoice::Same); 9]).is_err());
        check_runs(&[run("codex", worktree("a")), run("claude", worktree("b"))]).unwrap();
        // Sharing is explicit: two runs may both choose the parent's workspace.
        check_runs(&[
            run("codex", WorkspaceChoice::Same),
            run("claude", WorkspaceChoice::Same),
        ])
        .unwrap();
        let error = check_runs(&[run("codex", worktree("a")), run("claude", worktree("a"))])
            .unwrap_err()
            .to_string();
        assert!(error.contains("same new worktree"), "{error}");
        assert!(check_runs(&[run("", worktree("a")), run("claude", worktree("b"))]).is_err());
    }

    #[test]
    fn summary_needs_evidence_for_completed() {
        let all = summarize(&[settled(Outcome::Completed), settled(Outcome::Completed)]);
        assert_eq!(all.state, GroupState::Completed);
        assert_eq!((all.runs, all.completed), (2, 2));

        let unknown = summarize(&[settled(Outcome::Completed), settled(Outcome::Unknown)]);
        assert_eq!(unknown.state, GroupState::Ended);
        assert_eq!(unknown.unknown, 1);

        let gone = summarize(&[
            settled(Outcome::Completed),
            WaitState::Unavailable {
                reason: "gone".into(),
            },
        ]);
        assert_eq!(gone.state, GroupState::Ended);
        assert_eq!(gone.unavailable, 1);

        assert_eq!(summarize(std::iter::empty()).state, GroupState::Ended);
    }

    #[test]
    fn summary_puts_attention_before_running() {
        let pending = WaitState::Pending {
            phase: PendingPhase::Running,
        };
        let timed_out = WaitState::TimedOut {
            phase: PendingPhase::Queued,
        };
        let running = summarize(&[pending.clone(), timed_out, settled(Outcome::Failed)]);
        assert_eq!(running.state, GroupState::Running);
        assert_eq!((running.pending, running.failed), (2, 1));

        let blocked = WaitState::Blocked {
            reason: "paused".into(),
        };
        let asking = WaitState::NeedsInput {
            request_ids: vec!["q".into()],
        };
        let attention = summarize(&[pending, blocked, asking]);
        assert_eq!(attention.state, GroupState::NeedsAttention);
        assert_eq!((attention.blocked, attention.needs_input), (1, 1));
    }

    #[test]
    fn shared_means_the_parents_or_another_runs_workspace() {
        assert_eq!(
            shared_workspaces("p", &["a", "b", "b", "p"]),
            vec![false, true, true, true]
        );
    }

    #[test]
    fn overlaps_count_workspaces_not_runs() {
        let runs = [
            RunPaths {
                index: 0,
                workspace_id: "a",
                paths: Some(vec!["x.rs", "only-a.rs"]),
            },
            RunPaths {
                index: 1,
                workspace_id: "b",
                paths: Some(vec!["x.rs", "y.rs"]),
            },
            // Shares b's workspace; its own read listed nothing extra.
            RunPaths {
                index: 2,
                workspace_id: "b",
                paths: Some(vec!["y.rs"]),
            },
            RunPaths {
                index: 3,
                workspace_id: "c",
                paths: None,
            },
        ];
        assert_eq!(
            overlaps(&runs),
            vec![PathOverlap {
                path: "x.rs".into(),
                runs: vec![0, 1, 2],
            }]
        );
    }

    #[test]
    fn name_status_parses_literal_paths_and_cuts_at_the_limit() {
        let raw = "M\0src/a b.rs\0A\0new\nline\0D\0gone\0";
        let (files, truncated) = parse_name_status(raw, 10).unwrap();
        assert!(!truncated);
        assert_eq!(
            files,
            vec![
                CommittedFile {
                    path: "src/a b.rs".into(),
                    code: "M".into()
                },
                CommittedFile {
                    path: "new\nline".into(),
                    code: "A".into()
                },
                CommittedFile {
                    path: "gone".into(),
                    code: "D".into()
                },
            ]
        );
        let (files, truncated) = parse_name_status(raw, 2).unwrap();
        assert_eq!((files.len(), truncated), (2, true));
        assert_eq!(parse_name_status("", 10).unwrap(), (vec![], false));
        assert!(parse_name_status("M\0", 10).is_err());
        assert!(parse_name_status("R100\0a\0b\0", 10).is_err());
        assert!(parse_name_status("M\0a\0\0junk", 10).is_err());
    }
}
