//! Pure workspace rules shared by the daemon and its contracts: the display
//! name a person gives a workspace, the name the catalog shows for a Git
//! repository, and what can block `workspace.remove`.
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The longest display name `workspace.rename` accepts, in characters.
pub const MAX_NAME_CHARS: usize = 100;

/// Why a workspace display name was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidName {
    #[error("Workspace name is empty")]
    Empty,
    #[error("Workspace name is longer than 100 characters")]
    TooLong,
    #[error("Workspace name contains a control character")]
    ControlCharacter,
}

/// The display name to store for `input`: trimmed, 1 to 100 characters and
/// free of control characters such as line breaks.
pub fn display_name(input: &str) -> Result<String, InvalidName> {
    let name = input.trim();
    if name.is_empty() {
        return Err(InvalidName::Empty);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(InvalidName::TooLong);
    }
    if name.chars().any(char::is_control) {
        return Err(InvalidName::ControlCharacter);
    }
    Ok(name.to_owned())
}

/// The name the catalog shows for a repository whose Git common directory is
/// `common`: the folder a person checked the repository out into.
///
/// - `/src/app/.git` (an ordinary checkout, and the common directory of every
///   linked worktree made from it) is `app`.
/// - A hidden common directory such as `/src/app/.bare`, the layout that keeps
///   a bare repository beside its worktrees, is also `app`.
/// - A bare repository such as `/src/app.git` is `app`.
/// - Any other directory keeps its own name.
pub fn project_name(common: &str) -> String {
    let path = Path::new(common);
    let Some(own) = path.file_name().and_then(|name| name.to_str()) else {
        return common.to_owned();
    };
    if own.starts_with('.') {
        if let Some(parent) = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        {
            return parent.to_owned();
        }
        return own.to_owned();
    }
    match own.strip_suffix(".git") {
        Some(stem) if !stem.is_empty() => stem.to_owned(),
        _ => own.to_owned(),
    }
}

/// What keeps `workspace.remove` from running, as its `workspace_remove_blocked`
/// error lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveBlockerKind {
    /// A Conversation turn is starting, running, waiting or cancelling.
    ConversationRunning,
    /// A service is running or starting.
    ServiceRunning,
    /// A package script run is still running.
    ScriptRunning,
    /// The daemon's own default workspace: attachments that name no
    /// workspace open their terminal there.
    DefaultWorkspace,
}

/// One thing that blocks removal: its kind, the ID of the Conversation,
/// service, script run or workspace, and a label a person recognises.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveBlocker {
    pub kind: RemoveBlockerKind,
    pub id: String,
    pub label: String,
}

/// What keeps `workspace.delete_worktree` from running: a `workspace.remove`
/// blocker, a `worktree.cleanup.plan` blocker of the tree, or a workspace that
/// is no linked worktree at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeleteBlockerKind {
    Workspace(RemoveBlockerKind),
    Tree(crate::contract::worktrees::CleanupBlocker),
    Kind(NotDeletable),
}

/// A workspace `workspace.delete_worktree` never deletes, whatever its state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotDeletable {
    /// A plain folder: there is no worktree to delete.
    NotAWorktree,
}

/// One thing that blocks deleting a worktree, in the shape of
/// [`RemoveBlocker`]: the ID is the Conversation, service, script run or
/// workspace for a workspace blocker, and the tree's path for a tree blocker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteBlocker {
    pub kind: DeleteBlockerKind,
    pub id: String,
    pub label: String,
}

impl From<RemoveBlocker> for DeleteBlocker {
    fn from(blocker: RemoveBlocker) -> Self {
        Self {
            kind: DeleteBlockerKind::Workspace(blocker.kind),
            id: blocker.id,
            label: blocker.label,
        }
    }
}

impl DeleteBlocker {
    /// A tree blocker from `worktree.cleanup.plan`, labelled for a person.
    pub fn tree(blocker: crate::contract::worktrees::CleanupBlocker, path: &str) -> Self {
        use crate::contract::worktrees::CleanupBlocker as Tree;
        let label = match blocker {
            Tree::PrimaryCheckout => "It is the project's main checkout",
            Tree::External => "ADE did not create this worktree",
            Tree::AuthorityChanged => "Its ADE ownership marker has changed",
            Tree::Locked => "Git has locked it",
            Tree::Unavailable | Tree::NotListed => "Git no longer lists it",
            Tree::Dirty => "It has uncommitted or untracked files",
            Tree::StatusUnknown => "Git could not read its status",
            Tree::ActiveWork => "A terminal, Agent, service or script uses it",
            Tree::ClaimHeld => "Another process is using it",
            Tree::ClaimUncertain => "Another process may be using it",
            Tree::RegistryUnavailable => "ADE cannot confirm nothing else is using it",
            Tree::LifecycleRunning => "Another worktree operation is running in this project",
            Tree::SetupIncomplete => "Its setup did not finish",
            Tree::TeardownIncomplete => "Its teardown did not finish",
        };
        Self {
            kind: DeleteBlockerKind::Tree(blocker),
            id: path.to_owned(),
            label: label.to_owned(),
        }
    }
}

/// The attention a Conversation asks for, from its status and whether a
/// question or approval is open.
///
/// An open request, or the `waiting` or `pending` status, needs the person.
/// Otherwise `starting`, `running`, `responding`, `streaming` and
/// `cancelling` are running; `error`, `unavailable` and `disconnected` are
/// errors; anything else is idle.
pub fn attention(status: &str, open_request: bool) -> crate::model::Attention {
    use crate::model::Attention;
    if open_request || matches!(status, "waiting" | "pending") {
        Attention::NeedsYou
    } else if matches!(
        status,
        "running" | "responding" | "streaming" | "starting" | "cancelling"
    ) {
        Attention::Running
    } else if matches!(status, "error" | "unavailable" | "disconnected") {
        Attention::Error
    } else {
        Attention::Idle
    }
}

/// The branch a Git `HEAD` file names: `ref: refs/heads/<branch>`. A
/// detached `HEAD` (a commit ID) or any other content names none.
pub fn head_branch(head: &str) -> Option<String> {
    let branch = head
        .trim_end_matches(['\r', '\n'])
        .strip_prefix("ref: refs/heads/")?;
    (!branch.is_empty() && !branch.contains(['\n', '\0'])).then(|| branch.to_owned())
}

/// A plain folder project's name: the folder's own name.
pub fn folder_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(root)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_trimmed_and_bounded() {
        assert_eq!(display_name("  Payments API \t").unwrap(), "Payments API");
        assert_eq!(display_name("   "), Err(InvalidName::Empty));
        assert_eq!(display_name(""), Err(InvalidName::Empty));
        let limit = "é".repeat(MAX_NAME_CHARS);
        assert_eq!(display_name(&limit).unwrap(), limit);
        assert_eq!(
            display_name(&format!("{limit}x")),
            Err(InvalidName::TooLong)
        );
        assert_eq!(
            display_name("two\nlines"),
            Err(InvalidName::ControlCharacter)
        );
    }

    #[test]
    fn project_names_come_from_the_checkout_folder() {
        assert_eq!(project_name("/src/app/.git"), "app");
        assert_eq!(project_name("/src/app/.bare"), "app");
        assert_eq!(project_name("/src/app.git"), "app");
        assert_eq!(project_name("/src/plain"), "plain");
        assert_eq!(project_name("/.git"), ".git");
        assert_eq!(project_name("/"), "/");
    }

    #[test]
    fn blockers_have_a_stable_wire_form() {
        let blocker = RemoveBlocker {
            kind: RemoveBlockerKind::ConversationRunning,
            id: "conversation_1".into(),
            label: "Fix the build".into(),
        };
        assert_eq!(
            serde_json::to_value(&blocker).unwrap(),
            serde_json::json!({"kind": "conversation_running", "id": "conversation_1",
                "label": "Fix the build"})
        );
    }

    #[test]
    fn delete_blockers_share_the_remove_blocker_shape() {
        use crate::contract::worktrees::CleanupBlocker;
        let workspace = DeleteBlocker::from(RemoveBlocker {
            kind: RemoveBlockerKind::ServiceRunning,
            id: "web".into(),
            label: "Service web".into(),
        });
        let tree = DeleteBlocker::tree(CleanupBlocker::Dirty, "/src/app-feature");
        let folder = DeleteBlocker {
            kind: DeleteBlockerKind::Kind(NotDeletable::NotAWorktree),
            id: "workspace_1".into(),
            label: "A plain folder".into(),
        };
        let wire = serde_json::to_value([&workspace, &tree, &folder]).unwrap();
        assert_eq!(wire[0]["kind"], "service_running");
        assert_eq!(wire[1]["kind"], "dirty");
        assert_eq!(wire[1]["id"], "/src/app-feature");
        assert_eq!(wire[2]["kind"], "not_a_worktree");
        let back: Vec<DeleteBlocker> = serde_json::from_value(wire).unwrap();
        assert_eq!(back, vec![workspace, tree, folder]);
    }

    #[test]
    fn attention_follows_status_and_open_requests() {
        use crate::model::Attention;
        for status in [
            "running",
            "responding",
            "streaming",
            "starting",
            "cancelling",
        ] {
            assert_eq!(attention(status, false), Attention::Running, "{status}");
        }
        for status in ["waiting", "pending"] {
            assert_eq!(attention(status, false), Attention::NeedsYou, "{status}");
        }
        for status in ["error", "unavailable", "disconnected"] {
            assert_eq!(attention(status, false), Attention::Error, "{status}");
        }
        for status in ["idle", "ready", "interrupted", "imported"] {
            assert_eq!(attention(status, false), Attention::Idle, "{status}");
        }
        // An open question or approval needs the person whatever the status says.
        assert_eq!(attention("running", true), Attention::NeedsYou);
        assert_eq!(attention("idle", true), Attention::NeedsYou);
    }

    #[test]
    fn a_head_file_names_a_branch_only_when_attached() {
        assert_eq!(
            head_branch("ref: refs/heads/main\n").as_deref(),
            Some("main")
        );
        assert_eq!(
            head_branch("ref: refs/heads/ade/feature-x").as_deref(),
            Some("ade/feature-x")
        );
        assert_eq!(
            head_branch("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"),
            None
        );
        assert_eq!(head_branch("ref: refs/remotes/origin/main\n"), None);
        assert_eq!(head_branch("ref: refs/heads/\n"), None);
        assert_eq!(head_branch(""), None);
    }

    #[test]
    fn a_folder_project_takes_the_folder_name() {
        assert_eq!(folder_name("/src/notes"), "notes");
        assert_eq!(folder_name("/"), "/");
    }
}
