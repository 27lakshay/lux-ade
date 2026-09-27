//! Pure lifecycle decisions: branch and directory naming, configuration
//! limits, hook verdicts, tree phases and cleanup eligibility. Nothing here
//! touches Git, the filesystem or the database.
use ade_core::contract::worktrees::{
    CleanupBlocker, CleanupOutcome, HookVerdict, SetupState, WorktreeOperationStatus, WorktreePhase,
};
use ade_core::worktrees::{Config, Hook};
use anyhow::{Result, bail, ensure};

/// At most this many hooks per phase.
pub const MAX_HOOKS: usize = 8;
/// At most this many trees per cleanup.
pub const MAX_CLEANUP_PATHS: usize = 32;
/// Generated names stop searching after this many candidates.
const MAX_GENERATED: usize = 999;

/// A tree's resolved names, recorded before Git or any hook runs.
#[derive(Debug, PartialEq, Eq)]
pub struct Named {
    pub branch: String,
    /// The directory name inside the configured parent directory.
    pub directory: String,
}

/// What a `worktree.create` request asked for.
pub struct Naming<'a> {
    /// The primary checkout's directory name.
    pub repository: &'a str,
    pub prefix: Option<&'a str>,
    pub name: Option<&'a str>,
    pub branch: Option<&'a str>,
}

/// Reduces a free-form name to a branch component: letters, digits, `.`,
/// `_`, `-` and `/`; other runs become one `-`. `None` when nothing remains.
pub fn slug(name: &str) -> Option<String> {
    let mut out = String::new();
    for c in name.chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/');
        let c = if keep { c } else { '-' };
        // Collapse separators and the sequences Git refuses in ref names.
        if matches!(c, '-' | '/' | '.') && out.ends_with(c) {
            continue;
        }
        out.push(c);
    }
    let out = out
        .split('/')
        .map(|part| part.trim_matches(|c| matches!(c, '-' | '.')))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let out = out.trim_end_matches(".lock").to_owned();
    (!out.is_empty()).then_some(out)
}

/// The directory name for a branch: the repository's directory name, `-`,
/// then the branch with `/` replaced by `-`.
pub fn directory_name(repository: &str, branch: &str) -> String {
    format!("{repository}-{}", branch.replace('/', "-"))
}

/// Case-folded, since a case-insensitive volume stores `Feature` and
/// `feature` as the same loose ref.
fn fold(name: &str) -> String {
    name.to_lowercase()
}

/// Resolves the branch and directory of a new tree. An explicit name or
/// branch that collides is refused; only a generated name moves on to the
/// next free number. `branch_taken` and `directory_taken` report existing
/// branches and paths.
pub fn resolve_name(
    request: &Naming,
    branches: &[String],
    directory_taken: impl Fn(&str) -> bool,
) -> Result<Named> {
    let taken: std::collections::HashSet<String> = branches.iter().map(|b| fold(b)).collect();
    let branch_taken = |branch: &str| taken.contains(&fold(branch));
    let prefix = request.prefix.unwrap_or("");
    let explicit = match (request.name, request.branch) {
        (Some(_), Some(_)) => bail!("Name a workspace or a branch, not both"),
        (None, Some(branch)) => Some(branch.to_owned()),
        (Some(name), None) => Some(format!(
            "{prefix}{}",
            slug(name).ok_or_else(|| anyhow::anyhow!("Workspace name has no usable characters"))?
        )),
        (None, None) => None,
    };
    if let Some(branch) = explicit {
        ensure!(
            !branch.is_empty() && !branch.starts_with('-') && !branch.contains(char::is_whitespace),
            "Invalid branch name"
        );
        ensure!(!branch_taken(&branch), "Branch {branch} already exists");
        let directory = directory_name(request.repository, &branch);
        ensure!(
            !directory_taken(&directory),
            "Worktree directory {directory} already exists"
        );
        return Ok(Named { branch, directory });
    }
    for n in 1..=MAX_GENERATED {
        let branch = format!("{prefix}wt-{n}");
        let directory = directory_name(request.repository, &branch);
        if !branch_taken(&branch) && !directory_taken(&directory) {
            return Ok(Named { branch, directory });
        }
    }
    bail!("No free generated worktree name; name the workspace explicitly")
}

/// Configuration limits `worktree.configure` enforces before storing.
pub fn validate_config(config: &Config) -> Result<()> {
    ensure!(
        (5..=300).contains(&config.timeout_seconds),
        "Timeout must be 5–300 seconds"
    );
    if let Some(prefix) = &config.branch_prefix {
        ensure!(
            prefix.len() <= 64
                && !prefix.starts_with(['-', '/', '.'])
                && !prefix.contains("..")
                && prefix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/')),
            "Branch prefix may use letters, digits, '.', '_', '-' and '/', at most 64 bytes"
        );
    }
    if let Some(base) = &config.default_base {
        ensure!(
            !base.is_empty() && base.len() <= 256 && !base.starts_with('-') && !base.contains('\0'),
            "Invalid default base"
        );
    }
    for (phase, hooks) in [("setup", &config.setup), ("teardown", &config.teardown)] {
        ensure!(
            hooks.len() <= MAX_HOOKS,
            "At most {MAX_HOOKS} {phase} hooks are allowed"
        );
        for hook in hooks {
            validate_hook(hook)?;
        }
    }
    Ok(())
}

fn validate_hook(hook: &Hook) -> Result<()> {
    ensure!(
        !hook.name.is_empty() && hook.name.len() <= 64 && !hook.name.contains(char::is_control),
        "Hook names must be 1–64 printable characters"
    );
    ensure!(
        !hook.command.is_empty()
            && hook.command.len() <= 64
            && !hook.command[0].is_empty()
            && hook
                .command
                .iter()
                .all(|arg| arg.len() <= 4096 && !arg.contains('\0')),
        "Hook {} needs a command of 1–64 arguments without NUL bytes",
        hook.name
    );
    ensure!(
        (1..=3600).contains(&hook.timeout_seconds),
        "Hook {} timeout must be 1–3600 seconds",
        hook.name
    );
    Ok(())
}

/// How a hook ended. Pipes still open after the process exited mean some
/// descendant kept them, so its effect is not known to be finished.
pub fn hook_verdict(exit_code: Option<i32>, timed_out: bool, pipes_closed: bool) -> HookVerdict {
    if timed_out {
        HookVerdict::TimedOut
    } else if !pipes_closed || exit_code.is_none() {
        HookVerdict::Unknown
    } else if exit_code == Some(0) {
        HookVerdict::Succeeded
    } else {
        HookVerdict::Failed
    }
}

/// Whether a hook run leaves work that may still be running.
pub fn hook_uncertain(verdict: HookVerdict) -> bool {
    matches!(verdict, HookVerdict::TimedOut | HookVerdict::Unknown)
}

/// The phase a run of setup hooks leaves. Hooks run in order and stop at the
/// first that does not succeed, so the last verdict decides.
pub fn after_setup(last: Option<HookVerdict>) -> WorktreePhase {
    match last {
        None | Some(HookVerdict::Succeeded) => WorktreePhase::Ready,
        Some(HookVerdict::Failed | HookVerdict::TimedOut) => WorktreePhase::SetupFailed,
        Some(HookVerdict::Unknown) => WorktreePhase::SetupInterrupted,
    }
}

/// The phase a failed run of teardown hooks leaves; `None` when every hook
/// succeeded and removal may proceed.
pub fn after_teardown(last: Option<HookVerdict>) -> Option<WorktreePhase> {
    match last {
        None | Some(HookVerdict::Succeeded) => None,
        Some(HookVerdict::Failed | HookVerdict::TimedOut) => Some(WorktreePhase::TeardownFailed),
        Some(HookVerdict::Unknown) => Some(WorktreePhase::TeardownInterrupted),
    }
}

/// A phase recorded as in progress when the daemon stopped did not finish.
pub fn on_restart(phase: WorktreePhase) -> WorktreePhase {
    match phase {
        WorktreePhase::Creating | WorktreePhase::SettingUp => WorktreePhase::SetupInterrupted,
        WorktreePhase::TearingDown => WorktreePhase::TeardownInterrupted,
        other => other,
    }
}

/// Agent admission reads the phase: only `ready` admits.
pub fn readiness(phase: WorktreePhase) -> SetupState {
    match phase {
        WorktreePhase::Ready => SetupState::Ready,
        WorktreePhase::Creating | WorktreePhase::SettingUp | WorktreePhase::TearingDown => {
            SetupState::Preparing
        }
        WorktreePhase::SetupFailed | WorktreePhase::TeardownFailed => SetupState::Failed,
        WorktreePhase::SetupInterrupted | WorktreePhase::TeardownInterrupted => {
            SetupState::Interrupted
        }
    }
}

/// `worktree.setup` recovers a tree that is not ready. It never runs on a
/// ready tree, where Agents may be working, nor on one whose phase says work
/// is still in progress. A tree with no phase (adopted, or created before
/// phases were recorded) may be set up.
pub fn may_setup(phase: Option<WorktreePhase>) -> Result<()> {
    match phase {
        Some(WorktreePhase::Ready) => bail!("Worktree setup already succeeded"),
        Some(WorktreePhase::Creating | WorktreePhase::SettingUp | WorktreePhase::TearingDown) => {
            bail!("Worktree lifecycle work is in progress; wait for it to settle")
        }
        _ => Ok(()),
    }
}

/// ADE's removal authority over a tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    /// ADE created or adopted it and the marker matches.
    Verified,
    /// A record exists but the marker no longer matches.
    Changed,
    None,
}

/// What the host registry says about a tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claims {
    Free,
    /// An active claim of any profile, including this profile's own use.
    Held,
    /// A quarantined claim.
    Uncertain,
    /// The registry is blocked and cannot say.
    Unavailable,
}

/// Everything cleanup eligibility depends on, gathered by the caller.
#[derive(Clone, Copy, Debug)]
pub struct TreeFacts {
    pub primary: bool,
    pub listed: bool,
    pub authority: Authority,
    pub locked: bool,
    pub prunable: bool,
    /// `None` when Git status could not be read.
    pub dirty: Option<bool>,
    /// This profile holds an execution lease inside the tree.
    pub leased: bool,
    /// Another lifecycle operation runs in the repository.
    pub busy: bool,
    pub claims: Claims,
    pub phase: Option<WorktreePhase>,
}

/// Every reason a tree must be kept. Dirty, locked, active and uncertain
/// trees stay protected whatever ADE's authority (architecture section 5).
/// An empty list is the only eligible answer.
pub fn cleanup_blockers(facts: &TreeFacts) -> Vec<CleanupBlocker> {
    let mut blockers = Vec::new();
    let mut add = |condition: bool, blocker| {
        if condition {
            blockers.push(blocker);
        }
    };
    add(facts.primary, CleanupBlocker::PrimaryCheckout);
    add(!facts.listed, CleanupBlocker::NotListed);
    add(facts.authority == Authority::None, CleanupBlocker::External);
    add(
        facts.authority == Authority::Changed,
        CleanupBlocker::AuthorityChanged,
    );
    add(facts.locked, CleanupBlocker::Locked);
    add(facts.prunable, CleanupBlocker::Unavailable);
    add(facts.dirty == Some(true), CleanupBlocker::Dirty);
    add(facts.dirty.is_none(), CleanupBlocker::StatusUnknown);
    add(facts.leased, CleanupBlocker::ActiveWork);
    add(facts.busy, CleanupBlocker::LifecycleRunning);
    add(facts.claims == Claims::Held, CleanupBlocker::ClaimHeld);
    add(
        facts.claims == Claims::Uncertain,
        CleanupBlocker::ClaimUncertain,
    );
    add(
        facts.claims == Claims::Unavailable,
        CleanupBlocker::RegistryUnavailable,
    );
    match facts.phase {
        Some(
            WorktreePhase::Creating
            | WorktreePhase::SettingUp
            | WorktreePhase::SetupFailed
            | WorktreePhase::SetupInterrupted,
        ) => add(true, CleanupBlocker::SetupIncomplete),
        Some(
            WorktreePhase::TearingDown
            | WorktreePhase::TeardownFailed
            | WorktreePhase::TeardownInterrupted,
        ) => add(true, CleanupBlocker::TeardownIncomplete),
        Some(WorktreePhase::Ready) | None => {}
    }
    blockers
}

/// A cleanup's ledger status from its trees: success only when every tree
/// was archived, partial when some were.
pub fn cleanup_status(outcomes: &[CleanupOutcome]) -> WorktreeOperationStatus {
    let archived = outcomes
        .iter()
        .filter(|outcome| **outcome == CleanupOutcome::Archived)
        .count();
    if !outcomes.is_empty() && archived == outcomes.len() {
        WorktreeOperationStatus::Succeeded
    } else if archived > 0 {
        WorktreeOperationStatus::Partial
    } else {
        WorktreeOperationStatus::Failed
    }
}

/// Keeps the tail of a hook's output within `cap` bytes, on a UTF-8
/// boundary. Returns the kept text and whether anything was dropped.
pub fn output_tail(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let mut start = bytes.len() - cap;
    // Skip UTF-8 continuation bytes so the kept text starts on a character.
    while start < bytes.len() && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start += 1;
    }
    (String::from_utf8_lossy(&bytes[start..]).into_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naming<'a>(name: Option<&'a str>, branch: Option<&'a str>) -> Naming<'a> {
        Naming {
            repository: "app",
            prefix: Some("ade/"),
            name,
            branch,
        }
    }

    #[test]
    fn slug_keeps_ref_safe_characters_and_collapses_the_rest() {
        assert_eq!(slug("Fix login bug!").as_deref(), Some("Fix-login-bug"));
        assert_eq!(slug("feat//ui..x").as_deref(), Some("feat/ui.x"));
        assert_eq!(slug("-.lead/.trail-").as_deref(), Some("lead/trail"));
        assert_eq!(slug("branch.lock").as_deref(), Some("branch"));
        assert_eq!(slug("日本"), None);
        assert_eq!(slug("   "), None);
    }

    #[test]
    fn names_take_the_prefix_and_branches_do_not() {
        let named = resolve_name(&naming(Some("Login page"), None), &[], |_| false).unwrap();
        assert_eq!(
            named,
            Named {
                branch: "ade/Login-page".into(),
                directory: "app-ade-Login-page".into()
            }
        );
        let named = resolve_name(&naming(None, Some("feature/x")), &[], |_| false).unwrap();
        assert_eq!(named.branch, "feature/x");
        assert_eq!(named.directory, "app-feature-x");
    }

    #[test]
    fn explicit_collisions_are_refused_including_case_variants() {
        let branches = vec!["ade/Login".to_owned()];
        let error = resolve_name(&naming(Some("login"), None), &branches, |_| false).unwrap_err();
        assert!(error.to_string().contains("already exists"));
        let error =
            resolve_name(&naming(None, Some("free")), &[], |dir| dir == "app-free").unwrap_err();
        assert!(error.to_string().contains("directory"));
        assert!(resolve_name(&naming(Some("a"), Some("b")), &[], |_| false).is_err());
        assert!(resolve_name(&naming(None, Some("-x")), &[], |_| false).is_err());
        assert!(resolve_name(&naming(Some("!!!"), None), &[], |_| false).is_err());
    }

    #[test]
    fn generated_names_skip_taken_branches_and_directories() {
        let branches = vec!["ade/wt-1".to_owned()];
        let named =
            resolve_name(&naming(None, None), &branches, |dir| dir == "app-ade-wt-2").unwrap();
        assert_eq!(named.branch, "ade/wt-3");
        let everything = resolve_name(&naming(None, None), &[], |_| true);
        assert!(everything.is_err());
    }

    #[test]
    fn configuration_limits() {
        let mut config = Config::default();
        validate_config(&config).unwrap();
        config.branch_prefix = Some("ade/".into());
        config.setup = vec![Hook {
            name: "install".into(),
            command: vec!["pnpm".into(), "install".into()],
            timeout_seconds: 300,
        }];
        validate_config(&config).unwrap();
        for prefix in ["-x", "a b", "a..b", "/a"] {
            config.branch_prefix = Some(prefix.into());
            assert!(validate_config(&config).is_err(), "{prefix} accepted");
        }
        config.branch_prefix = None;
        config.setup[0].command = vec![];
        assert!(validate_config(&config).is_err());
        config.setup[0].command = vec!["true".into()];
        config.setup[0].timeout_seconds = 0;
        assert!(validate_config(&config).is_err());
        config.setup[0].timeout_seconds = 1;
        config.teardown = vec![config.setup[0].clone(); MAX_HOOKS + 1];
        assert!(validate_config(&config).is_err());
        config.teardown.clear();
        config.timeout_seconds = 4;
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn hook_verdicts_never_call_an_open_pipe_finished() {
        assert_eq!(hook_verdict(Some(0), false, true), HookVerdict::Succeeded);
        assert_eq!(hook_verdict(Some(2), false, true), HookVerdict::Failed);
        assert_eq!(hook_verdict(Some(0), false, false), HookVerdict::Unknown);
        assert_eq!(hook_verdict(None, false, true), HookVerdict::Unknown);
        assert_eq!(hook_verdict(None, true, true), HookVerdict::TimedOut);
        assert!(hook_uncertain(HookVerdict::TimedOut));
        assert!(!hook_uncertain(HookVerdict::Failed));
    }

    #[test]
    fn a_failed_hook_never_leaves_a_ready_tree() {
        assert_eq!(after_setup(None), WorktreePhase::Ready);
        assert_eq!(
            after_setup(Some(HookVerdict::Succeeded)),
            WorktreePhase::Ready
        );
        assert_eq!(
            after_setup(Some(HookVerdict::Failed)),
            WorktreePhase::SetupFailed
        );
        assert_eq!(
            after_setup(Some(HookVerdict::TimedOut)),
            WorktreePhase::SetupFailed
        );
        assert_eq!(
            after_setup(Some(HookVerdict::Unknown)),
            WorktreePhase::SetupInterrupted
        );
        assert_eq!(after_teardown(Some(HookVerdict::Succeeded)), None);
        assert_eq!(
            after_teardown(Some(HookVerdict::Failed)),
            Some(WorktreePhase::TeardownFailed)
        );
        assert_eq!(
            after_teardown(Some(HookVerdict::Unknown)),
            Some(WorktreePhase::TeardownInterrupted)
        );
    }

    #[test]
    fn restart_marks_in_progress_phases_interrupted_and_only_ready_admits() {
        assert_eq!(
            on_restart(WorktreePhase::Creating),
            WorktreePhase::SetupInterrupted
        );
        assert_eq!(
            on_restart(WorktreePhase::SettingUp),
            WorktreePhase::SetupInterrupted
        );
        assert_eq!(
            on_restart(WorktreePhase::TearingDown),
            WorktreePhase::TeardownInterrupted
        );
        assert_eq!(on_restart(WorktreePhase::Ready), WorktreePhase::Ready);
        for phase in [
            WorktreePhase::Creating,
            WorktreePhase::SettingUp,
            WorktreePhase::SetupFailed,
            WorktreePhase::SetupInterrupted,
            WorktreePhase::TearingDown,
            WorktreePhase::TeardownFailed,
            WorktreePhase::TeardownInterrupted,
        ] {
            assert_ne!(readiness(phase), SetupState::Ready, "{phase:?}");
        }
        assert_eq!(readiness(WorktreePhase::Ready), SetupState::Ready);
        assert!(may_setup(Some(WorktreePhase::SetupFailed)).is_ok());
        assert!(may_setup(Some(WorktreePhase::TeardownFailed)).is_ok());
        assert!(may_setup(None).is_ok());
        assert!(may_setup(Some(WorktreePhase::Ready)).is_err());
        assert!(may_setup(Some(WorktreePhase::SettingUp)).is_err());
    }

    fn clean() -> TreeFacts {
        TreeFacts {
            primary: false,
            listed: true,
            authority: Authority::Verified,
            locked: false,
            prunable: false,
            dirty: Some(false),
            leased: false,
            busy: false,
            claims: Claims::Free,
            phase: Some(WorktreePhase::Ready),
        }
    }

    #[test]
    fn only_a_clean_idle_owned_tree_is_eligible() {
        assert!(cleanup_blockers(&clean()).is_empty());
        assert!(
            cleanup_blockers(&TreeFacts {
                phase: None,
                ..clean()
            })
            .is_empty()
        );
        let cases = [
            (
                TreeFacts {
                    primary: true,
                    ..clean()
                },
                CleanupBlocker::PrimaryCheckout,
            ),
            (
                TreeFacts {
                    listed: false,
                    ..clean()
                },
                CleanupBlocker::NotListed,
            ),
            (
                TreeFacts {
                    authority: Authority::None,
                    ..clean()
                },
                CleanupBlocker::External,
            ),
            (
                TreeFacts {
                    authority: Authority::Changed,
                    ..clean()
                },
                CleanupBlocker::AuthorityChanged,
            ),
            (
                TreeFacts {
                    locked: true,
                    ..clean()
                },
                CleanupBlocker::Locked,
            ),
            (
                TreeFacts {
                    prunable: true,
                    ..clean()
                },
                CleanupBlocker::Unavailable,
            ),
            (
                TreeFacts {
                    dirty: Some(true),
                    ..clean()
                },
                CleanupBlocker::Dirty,
            ),
            (
                TreeFacts {
                    dirty: None,
                    ..clean()
                },
                CleanupBlocker::StatusUnknown,
            ),
            (
                TreeFacts {
                    leased: true,
                    ..clean()
                },
                CleanupBlocker::ActiveWork,
            ),
            (
                TreeFacts {
                    busy: true,
                    ..clean()
                },
                CleanupBlocker::LifecycleRunning,
            ),
            (
                TreeFacts {
                    claims: Claims::Held,
                    ..clean()
                },
                CleanupBlocker::ClaimHeld,
            ),
            (
                TreeFacts {
                    claims: Claims::Uncertain,
                    ..clean()
                },
                CleanupBlocker::ClaimUncertain,
            ),
            (
                TreeFacts {
                    claims: Claims::Unavailable,
                    ..clean()
                },
                CleanupBlocker::RegistryUnavailable,
            ),
            (
                TreeFacts {
                    phase: Some(WorktreePhase::SetupFailed),
                    ..clean()
                },
                CleanupBlocker::SetupIncomplete,
            ),
            (
                TreeFacts {
                    phase: Some(WorktreePhase::TeardownInterrupted),
                    ..clean()
                },
                CleanupBlocker::TeardownIncomplete,
            ),
        ];
        for (facts, expected) in cases {
            assert_eq!(cleanup_blockers(&facts), vec![expected], "{facts:?}");
        }
    }

    #[test]
    fn cleanup_succeeds_only_when_every_tree_is_archived() {
        use CleanupOutcome::*;
        assert_eq!(
            cleanup_status(&[Archived, Archived]),
            WorktreeOperationStatus::Succeeded
        );
        assert_eq!(
            cleanup_status(&[Archived, Skipped]),
            WorktreeOperationStatus::Partial
        );
        assert_eq!(
            cleanup_status(&[Unknown, Failed]),
            WorktreeOperationStatus::Failed
        );
        assert_eq!(cleanup_status(&[]), WorktreeOperationStatus::Failed);
    }

    #[test]
    fn output_tail_keeps_the_end_on_a_character_boundary() {
        assert_eq!(output_tail(b"short", 16), ("short".into(), false));
        let (kept, truncated) = output_tail("aé".as_bytes(), 1);
        assert!(truncated);
        assert_eq!(kept, "");
        let (kept, truncated) = output_tail(b"0123456789", 4);
        assert_eq!((kept.as_str(), truncated), ("6789", true));
    }
}
