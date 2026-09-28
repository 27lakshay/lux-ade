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
    /// A Conversation is handed to a terminal.
    ConversationInTerminal,
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
}
