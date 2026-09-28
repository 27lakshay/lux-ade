//! Windows and layouts (F008, F011): which workspace each window shows, and
//! each window's panes and tabs for each workspace. The daemon owns them, so
//! the CLI, the SDK and any UI read and change the same layouts; a UI draws
//! them and turns gestures into commands.
//!
//! A tab names what it shows with a [`TabTarget`]; its title comes from the
//! target's own record. The operations arrive with the daemon authority work
//! (`.scratch/daemon-authority/issues/02-lane-windows-layouts.md`).
use super::{FrameSpec, OperationSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// What a tab shows. Records are named by ID; a file or diff by its path
/// inside the layout's workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabTarget {
    Conversation {
        id: String,
    },
    Terminal {
        id: String,
    },
    Browser {
        id: String,
    },
    File {
        path: String,
    },
    Diff {
        path: String,
        staged: bool,
    },
    /// A conversation not started yet: the composer for a new one.
    NewConversation,
}
