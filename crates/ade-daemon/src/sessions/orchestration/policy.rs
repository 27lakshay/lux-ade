//! Pure orchestration rules: caller attribution, the explicit account and
//! workspace choices, delegation limits and wait resolution. Nothing here
//! reads the store or the clock; the handlers pass observations in.
//!
//! The bounded wait follows Herdr's `src/api/wait.rs` (studied, not copied):
//! answer at once when the condition already holds, and time out otherwise.
use ade_core::contract::orchestration::{
    AccountChoice, Caller, Outcome, PendingPhase, RequestKind, WaitState,
};
use ade_core::contract::worktrees::WorktreeOperationStatus;
use anyhow::{Result, bail, ensure};

/// A child of a child of a child of a child is the deepest delegation.
pub const MAX_DEPTH: u32 = 4;
/// Children one Conversation may delegate in total.
pub const MAX_CHILDREN: usize = 32;
/// The longest wait a caller may ask for: one day.
pub const MAX_WAIT_MS: u64 = 86_400_000;
const TEXT_LIMIT: usize = 64 * 1024;
const TITLE_LIMIT: usize = 256;
const ID_LIMIT: usize = 256;
/// Child statuses from which the prompt queue submits, now or when the turn ends.
const QUEUE_MOVES: &[&str] = &[
    "idle",
    "ready",
    "starting",
    "running",
    "waiting",
    "cancelling",
];

/// Rejects an empty or oversized caller-owned identifier.
pub fn check_id(field: &str, value: &str) -> Result<()> {
    ensure!(!value.is_empty(), "Missing {field}");
    ensure!(value.len() <= ID_LIMIT, "{field} exceeds {ID_LIMIT} bytes");
    Ok(())
}

/// A task or message: non-blank text of at most 64 KiB.
pub fn check_text(text: &str) -> Result<()> {
    ensure!(!text.trim().is_empty(), "Message text is empty");
    ensure!(text.len() <= TEXT_LIMIT, "Message text exceeds 64 KiB");
    Ok(())
}

/// The recorded attribution: `user`, or `agent:<conversation ID>`.
pub fn attribution(caller: &Caller) -> Result<String> {
    Ok(match caller {
        Caller::User => "user".into(),
        Caller::Agent { conversation_id } => {
            check_id("caller conversation_id", conversation_id)?;
            format!("agent:{conversation_id}")
        }
    })
}

/// An Agent may delegate only as itself. The user may delegate for any parent.
pub fn authorize_delegation(caller: &Caller, parent: &str) -> Result<String> {
    if let Caller::Agent { conversation_id } = caller {
        ensure!(
            conversation_id == parent,
            "An Agent can delegate only from its own Conversation"
        );
    }
    attribution(caller)
}

/// Only the child's parent Agent, or the user, may message a delegated child.
pub fn authorize_message(caller: &Caller, parent: &str) -> Result<String> {
    if let Caller::Agent { conversation_id } = caller {
        ensure!(
            conversation_id == parent,
            "Only the parent Conversation can message this child"
        );
    }
    attribution(caller)
}

/// Only the child's own Agent, or the user, may message the child's parent.
pub fn authorize_parent_message(caller: &Caller, child: &str) -> Result<String> {
    if let Caller::Agent { conversation_id } = caller {
        ensure!(
            conversation_id == child,
            "Only the child Conversation can message its parent"
        );
    }
    attribution(caller)
}

/// The prompt a parent receives: a line naming the sending child, then the text.
pub fn parent_prompt(child: &str, text: &str) -> String {
    format!("Message from delegated child {child}:\n\n{text}")
}

/// Whether a provider request asks for an approval or answers to questions,
/// by the same rule activity uses.
pub fn request_kind(method: &str) -> RequestKind {
    if method.to_ascii_lowercase().contains("approval") {
        RequestKind::Approval
    } else {
        RequestKind::Question
    }
}

/// The child's account. `Inherit` needs the parent's provider, because an
/// account belongs to one provider.
pub fn resolve_account(
    choice: &AccountChoice,
    provider: &str,
    parent_provider: &str,
    parent_account: Option<&str>,
) -> Result<Option<String>> {
    Ok(match choice {
        AccountChoice::Inherit => {
            ensure!(
                provider == parent_provider,
                "Inheriting the parent's account needs the parent's provider ({parent_provider})"
            );
            parent_account.map(str::to_owned)
        }
        AccountChoice::Managed { account_id } => {
            check_id("account_id", account_id)?;
            Some(account_id.clone())
        }
        AccountChoice::Ambient => None,
    })
}

/// A child on an adapter or plugin provider runs on the agent's own login,
/// so it may carry no managed account, inherited or chosen.
pub fn registered_account(provider: &str, registered: bool, account: Option<&str>) -> Result<()> {
    ensure!(
        !registered || account.is_none(),
        "{provider} uses the agent's own login; ADE manages no accounts for it"
    );
    Ok(())
}

/// The new child's depth, if the parent may delegate another child.
pub fn child_depth(parent_depth: u32, existing_children: usize) -> Result<u32> {
    ensure!(
        parent_depth < MAX_DEPTH,
        "Delegation depth limit of {MAX_DEPTH} reached"
    );
    ensure!(
        existing_children < MAX_CHILDREN,
        "Limit of {MAX_CHILDREN} children per Conversation reached"
    );
    Ok(parent_depth + 1)
}

/// The caller's title, or the task's first line cut to 45 characters.
pub fn child_title(title: Option<&str>, task: &str) -> Result<String> {
    if let Some(title) = title {
        ensure!(
            !title.trim().is_empty() && title.len() <= TITLE_LIMIT,
            "Title must be 1 to {TITLE_LIMIT} bytes"
        );
        return Ok(title.to_owned());
    }
    let line = task
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    Ok(line.trim().chars().take(45).collect())
}

/// What the lifecycle ledger says about the worktree a child will use.
pub struct WorktreeEvidence<'a> {
    pub status: WorktreeOperationStatus,
    pub op: Option<&'a str>,
    pub create: bool,
    /// The canonical path the operation made, if it recorded one.
    pub path: Option<&'a str>,
    /// The canonical root of the workspace the caller named.
    pub workspace_root: &'a str,
    pub workspace_id: &'a str,
    pub parent_workspace_id: &'a str,
}

/// A `new_worktree` choice holds only for a succeeded `worktree.switch` that
/// created a tree, opened as the named workspace, apart from the parent's.
pub fn verify_new_worktree(evidence: &WorktreeEvidence) -> Result<()> {
    ensure!(
        evidence.workspace_id != evidence.parent_workspace_id,
        "A new worktree must be a different workspace from the parent's"
    );
    ensure!(
        evidence.op == Some("worktree.switch") && evidence.create,
        "The worktree operation did not create a new worktree"
    );
    match evidence.status {
        WorktreeOperationStatus::Succeeded => {}
        WorktreeOperationStatus::Running => bail!("The worktree operation is still running"),
        _ => bail!("The worktree operation did not succeed; inspect it before delegating"),
    }
    ensure!(
        evidence.path == Some(evidence.workspace_root),
        "The workspace is not the worktree that operation created"
    );
    Ok(())
}

/// The absolute deadline of a wait. A repeat carries the first reply's deadline.
pub fn deadline(now: i64, timeout_ms: Option<u64>, deadline_ms: Option<i64>) -> Result<i64> {
    if let Some(deadline) = deadline_ms {
        ensure!(deadline >= 0, "Invalid wait deadline");
        ensure!(
            deadline <= now.saturating_add(MAX_WAIT_MS as i64),
            "Wait deadline is more than one day away"
        );
        return Ok(deadline);
    }
    let timeout = timeout_ms.unwrap_or(0);
    ensure!(
        timeout <= MAX_WAIT_MS,
        "Wait timeout exceeds {MAX_WAIT_MS} ms"
    );
    Ok(now.saturating_add(timeout as i64))
}

/// Where the awaited message is in the child's durable queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    /// Queued and not yet submitted.
    Queued,
    /// Removed from the queue before submission.
    Cancelled,
    /// Recorded as a user message in the child Conversation.
    Submitted,
    /// Neither queued nor recorded.
    Missing,
}

/// The child Conversation's state, as the store holds it.
pub struct ChildView<'a> {
    pub status: &'a str,
    /// The message whose turn the Conversation last began.
    pub current_submission: Option<&'a str>,
    pub queue_paused: bool,
    pub error: Option<&'a str>,
    /// Provider requests still awaiting an answer.
    pub pending_requests: Vec<String>,
}

/// Resolves one wait observation. Returns the state and whether the wait is
/// done; only an unexpired `pending` is not done. A missing child is
/// unavailable, never settled, and an outcome without evidence is `unknown`.
pub fn resolve_wait(
    message_id: &str,
    progress: Progress,
    child: Option<&ChildView>,
    now: i64,
    deadline: i64,
) -> (WaitState, bool) {
    let Some(child) = child else {
        return (
            WaitState::Unavailable {
                reason: "The child Conversation no longer exists".into(),
            },
            true,
        );
    };
    let state = observe(message_id, progress, child);
    match state {
        WaitState::Pending { phase } if now >= deadline => (WaitState::TimedOut { phase }, true),
        WaitState::Pending { .. } => (state, false),
        _ => (state, true),
    }
}

fn observe(message_id: &str, progress: Progress, child: &ChildView) -> WaitState {
    let blocked = |reason: &str| WaitState::Blocked {
        reason: reason.into(),
    };
    match progress {
        Progress::Cancelled => blocked("The queued message was cancelled before submission"),
        Progress::Missing => blocked("The message is neither queued nor recorded"),
        Progress::Queued if child.queue_paused => WaitState::Blocked {
            reason: child
                .error
                .unwrap_or("The child's prompt queue is paused")
                .into(),
        },
        // The queue submits only to an idle or ready Conversation, and a busy
        // one returns there when its turn ends. A stopped Conversation holds
        // its queue until someone resumes it.
        Progress::Queued if !QUEUE_MOVES.contains(&child.status) => WaitState::Blocked {
            reason: format!(
                "The child Conversation is {}; resume it to deliver queued messages",
                child.status
            ),
        },
        Progress::Queued => WaitState::Pending {
            phase: PendingPhase::Queued,
        },
        Progress::Submitted if child.current_submission != Some(message_id) => WaitState::Settled {
            outcome: Outcome::Unknown,
            error: Some("A later turn replaced this turn's record".into()),
        },
        Progress::Submitted => submitted(child),
    }
}

fn submitted(child: &ChildView) -> WaitState {
    let pending = |phase| WaitState::Pending { phase };
    let settled = |outcome| WaitState::Settled {
        outcome,
        error: child.error.map(str::to_owned),
    };
    match child.status {
        "idle" | "starting" => pending(PendingPhase::Starting),
        "running" => pending(PendingPhase::Running),
        "cancelling" => pending(PendingPhase::Cancelling),
        "waiting" if child.pending_requests.is_empty() => pending(PendingPhase::Running),
        "waiting" => WaitState::NeedsInput {
            request_ids: child.pending_requests.clone(),
        },
        "ready" => settled(Outcome::Completed),
        "error" => settled(Outcome::Failed),
        "interrupted" => settled(Outcome::Interrupted),
        other => WaitState::Settled {
            outcome: Outcome::Unknown,
            error: Some(format!("The child Conversation is {other}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> Caller {
        Caller::Agent {
            conversation_id: id.into(),
        }
    }

    fn view(status: &str) -> ChildView<'_> {
        ChildView {
            status,
            current_submission: Some("m1"),
            queue_paused: false,
            error: None,
            pending_requests: Vec::new(),
        }
    }

    /// A delegated child on a plugin provider takes no managed account; a
    /// bundled child may.
    #[test]
    fn a_registered_child_carries_no_account() {
        assert!(registered_account("plugin:a.b", true, None).is_ok());
        assert!(registered_account("plugin:a.b", true, Some("acct")).is_err());
        assert!(registered_account("claude", false, Some("acct")).is_ok());
    }

    #[test]
    fn agents_act_only_as_themselves_and_are_attributed() {
        assert_eq!(authorize_delegation(&Caller::User, "p").unwrap(), "user");
        assert_eq!(authorize_delegation(&agent("p"), "p").unwrap(), "agent:p");
        assert!(authorize_delegation(&agent("other"), "p").is_err());
        assert!(authorize_delegation(&agent(""), "").is_err());
        assert_eq!(authorize_message(&agent("p"), "p").unwrap(), "agent:p");
        assert!(authorize_message(&agent("child"), "p").is_err());
        assert_eq!(authorize_message(&Caller::User, "p").unwrap(), "user");
        // A message to the parent comes from the child itself or the user.
        assert_eq!(
            authorize_parent_message(&agent("child"), "child").unwrap(),
            "agent:child"
        );
        assert!(authorize_parent_message(&agent("p"), "child").is_err());
        assert!(authorize_parent_message(&agent("sibling"), "child").is_err());
        assert_eq!(
            authorize_parent_message(&Caller::User, "child").unwrap(),
            "user"
        );
    }

    #[test]
    fn a_parent_sees_who_sent_a_message_and_what_a_request_asks() {
        assert_eq!(
            parent_prompt("c2", "done"),
            "Message from delegated child c2:\n\ndone"
        );
        assert_eq!(
            request_kind("item/commandExecution/requestApproval"),
            RequestKind::Approval
        );
        assert_eq!(
            request_kind("item/tool/requestUserInput"),
            RequestKind::Question
        );
    }

    #[test]
    fn account_choice_is_explicit_and_inherit_needs_the_same_provider() {
        let inherit = AccountChoice::Inherit;
        assert_eq!(
            resolve_account(&inherit, "codex", "codex", Some("a")).unwrap(),
            Some("a".into())
        );
        assert_eq!(
            resolve_account(&inherit, "codex", "codex", None).unwrap(),
            None
        );
        assert!(resolve_account(&inherit, "claude", "codex", Some("a")).is_err());
        let managed = AccountChoice::Managed {
            account_id: "b".into(),
        };
        assert_eq!(
            resolve_account(&managed, "claude", "codex", Some("a")).unwrap(),
            Some("b".into())
        );
        assert_eq!(
            resolve_account(&AccountChoice::Ambient, "claude", "codex", Some("a")).unwrap(),
            None
        );
    }

    #[test]
    fn delegation_is_bounded_in_depth_and_fan_out() {
        assert_eq!(child_depth(0, 0).unwrap(), 1);
        assert_eq!(
            child_depth(MAX_DEPTH - 1, MAX_CHILDREN - 1).unwrap(),
            MAX_DEPTH
        );
        assert!(child_depth(MAX_DEPTH, 0).is_err());
        assert!(child_depth(0, MAX_CHILDREN).is_err());
    }

    #[test]
    fn titles_and_texts_are_bounded() {
        assert_eq!(
            child_title(None, "\n  Fix the build  \nthen").unwrap(),
            "Fix the build"
        );
        assert_eq!(child_title(Some("Mine"), "task").unwrap(), "Mine");
        assert!(child_title(Some(" "), "task").is_err());
        assert!(child_title(Some(&"x".repeat(257)), "task").is_err());
        assert!(check_text(" \n").is_err());
        assert!(check_text(&"x".repeat(64 * 1024 + 1)).is_err());
        assert!(check_id("operation_id", "").is_err());
        assert!(check_id("operation_id", &"x".repeat(257)).is_err());
    }

    #[test]
    fn a_new_worktree_needs_a_succeeded_create_that_matches_the_workspace() {
        let good = WorktreeEvidence {
            status: WorktreeOperationStatus::Succeeded,
            op: Some("worktree.switch"),
            create: true,
            path: Some("/r/tree"),
            workspace_root: "/r/tree",
            workspace_id: "w2",
            parent_workspace_id: "w1",
        };
        verify_new_worktree(&good).unwrap();
        for bad in [
            WorktreeEvidence {
                status: WorktreeOperationStatus::Running,
                ..good
            },
            WorktreeEvidence {
                status: WorktreeOperationStatus::Interrupted,
                ..good
            },
            WorktreeEvidence {
                create: false,
                ..good
            },
            WorktreeEvidence {
                op: Some("worktree.remove"),
                ..good
            },
            WorktreeEvidence {
                path: Some("/r/other"),
                ..good
            },
            WorktreeEvidence { path: None, ..good },
            WorktreeEvidence {
                parent_workspace_id: "w2",
                ..good
            },
        ] {
            assert!(verify_new_worktree(&bad).is_err());
        }
    }

    #[test]
    fn deadlines_come_from_the_first_timeout_and_are_bounded() {
        assert_eq!(deadline(100, None, None).unwrap(), 100);
        assert_eq!(deadline(100, Some(50), None).unwrap(), 150);
        assert_eq!(deadline(100, Some(50), Some(120)).unwrap(), 120);
        assert!(deadline(100, Some(MAX_WAIT_MS + 1), None).is_err());
        assert!(deadline(100, None, Some(-1)).is_err());
        assert!(deadline(0, None, Some(MAX_WAIT_MS as i64 + 1)).is_err());
    }

    #[test]
    fn a_submitted_turn_settles_only_on_evidence() {
        let settled =
            |status: &str| resolve_wait("m1", Progress::Submitted, Some(&view(status)), 0, 10);
        assert_eq!(
            settled("ready"),
            (
                WaitState::Settled {
                    outcome: Outcome::Completed,
                    error: None
                },
                true
            )
        );
        let mut failed = view("error");
        failed.error = Some("boom");
        assert_eq!(
            resolve_wait("m1", Progress::Submitted, Some(&failed), 0, 10),
            (
                WaitState::Settled {
                    outcome: Outcome::Failed,
                    error: Some("boom".into())
                },
                true
            )
        );
        assert_eq!(
            settled("interrupted").0,
            WaitState::Settled {
                outcome: Outcome::Interrupted,
                error: None
            }
        );
        assert!(matches!(
            settled("disconnected").0,
            WaitState::Settled {
                outcome: Outcome::Unknown,
                ..
            }
        ));
        for (status, phase) in [
            ("starting", PendingPhase::Starting),
            ("running", PendingPhase::Running),
            ("cancelling", PendingPhase::Cancelling),
            ("waiting", PendingPhase::Running),
        ] {
            assert_eq!(settled(status), (WaitState::Pending { phase }, false));
        }
    }

    #[test]
    fn a_replaced_turn_is_never_reported_as_completed() {
        let mut later = view("ready");
        later.current_submission = Some("m2");
        assert!(matches!(
            resolve_wait("m1", Progress::Submitted, Some(&later), 0, 10).0,
            WaitState::Settled {
                outcome: Outcome::Unknown,
                ..
            }
        ));
    }

    #[test]
    fn questions_return_to_the_caller() {
        let mut asking = view("waiting");
        asking.pending_requests = vec!["q1".into()];
        assert_eq!(
            resolve_wait("m1", Progress::Submitted, Some(&asking), 0, 10),
            (
                WaitState::NeedsInput {
                    request_ids: vec!["q1".into()]
                },
                true
            )
        );
    }

    #[test]
    fn queued_messages_wait_unless_the_queue_cannot_move() {
        let idle = view("ready");
        assert_eq!(
            resolve_wait("m9", Progress::Queued, Some(&idle), 0, 10),
            (
                WaitState::Pending {
                    phase: PendingPhase::Queued
                },
                false
            )
        );
        let mut paused = view("error");
        paused.queue_paused = true;
        paused.error = Some("Prompt queue paused: no login");
        assert_eq!(
            resolve_wait("m9", Progress::Queued, Some(&paused), 0, 10).0,
            WaitState::Blocked {
                reason: "Prompt queue paused: no login".into()
            }
        );
        for busy in ["running", "waiting", "cancelling"] {
            assert!(!resolve_wait("m9", Progress::Queued, Some(&view(busy)), 0, 10).1);
        }
        // An unpaused queue on a stopped child still needs a resume to move.
        for stopped in ["error", "interrupted", "disconnected"] {
            assert!(matches!(
                resolve_wait("m9", Progress::Queued, Some(&view(stopped)), 0, 10),
                (WaitState::Blocked { .. }, true)
            ));
        }
        assert!(matches!(
            resolve_wait("m9", Progress::Cancelled, Some(&idle), 0, 10).0,
            WaitState::Blocked { .. }
        ));
        assert!(matches!(
            resolve_wait("m9", Progress::Missing, Some(&idle), 0, 10).0,
            WaitState::Blocked { .. }
        ));
    }

    #[test]
    fn pending_times_out_at_the_deadline_and_a_missing_child_is_unavailable() {
        assert_eq!(
            resolve_wait("m1", Progress::Submitted, Some(&view("running")), 10, 10),
            (
                WaitState::TimedOut {
                    phase: PendingPhase::Running
                },
                true
            )
        );
        // An answer already available is returned even after the deadline.
        assert!(resolve_wait("m1", Progress::Submitted, Some(&view("ready")), 99, 10).1);
        assert!(matches!(
            resolve_wait("m1", Progress::Submitted, None, 0, 10),
            (WaitState::Unavailable { .. }, true)
        ));
    }
}
