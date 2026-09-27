//! Workspace checkpoint contracts (F070, workspaces spec rule 7).
//!
//! A checkpoint records a workspace's Git working tree and index as Git
//! objects under a private ref, `refs/ade/checkpoints/<workspace>/<id>`. It
//! never touches the user's branch, index or stash, and it is not a process
//! snapshot. Each checkpoint discloses what it covers.
//!
//! Restore is previewed first. The preview returns a `state_token` that pins
//! the current working tree, index, HEAD and checkpoint; `checkpoint.restore`
//! refuses when any of them changed since. Restore also refuses to overwrite
//! ignored files, and it requires `confirm_overwrite` before it replaces
//! uncommitted work. Before it writes anything it saves the current state as a
//! safety checkpoint, so no uncommitted work is lost silently.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<CheckpointCreateRequest, CheckpointCreated>(
            "checkpoint.create",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<CheckpointListRequest, CheckpointList>("checkpoint.list", Tier::Query),
        OperationSpec::new::<CheckpointRestorePreviewRequest, CheckpointRestorePreview>(
            "checkpoint.restore.preview",
            Tier::Query,
        ),
        OperationSpec::new::<CheckpointRestoreRequest, CheckpointRestored>(
            "checkpoint.restore",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<CheckpointDeleteRequest, CheckpointDeleted>(
            "checkpoint.delete",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `checkpoint.create`: record the workspace's working tree and index.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CheckpointCreateRequest {
    pub operation_id: String,
    pub workspace_id: String,
    /// A short note shown in lists; at most 200 characters on one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `checkpoint.list`: the workspace's checkpoints, newest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CheckpointListRequest {
    pub workspace_id: String,
}

/// `checkpoint.restore.preview`: what a restore would change, and whether it may run.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CheckpointRestorePreviewRequest {
    pub workspace_id: String,
    pub checkpoint_id: String,
}

/// `checkpoint.restore`: make the working tree and index match a checkpoint.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CheckpointRestoreRequest {
    pub operation_id: String,
    pub workspace_id: String,
    pub checkpoint_id: String,
    /// The `state_token` from `checkpoint.restore.preview`. Restore refuses when
    /// the workspace or the checkpoint changed since that preview.
    pub expected_state: String,
    /// Required when the preview listed `uncommitted_overwritten` paths.
    #[serde(default)]
    pub confirm_overwrite: bool,
}

/// `checkpoint.delete`: remove a checkpoint's ref. Its objects become
/// unreachable and Git's own garbage collection reclaims them later.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CheckpointDeleteRequest {
    pub operation_id: String,
    pub workspace_id: String,
    pub checkpoint_id: String,
    /// The checkpoint's `commit`; delete refuses when the ref points elsewhere.
    pub expected_commit: String,
}

wire_tag!(CheckpointCreatedTag, "checkpoint_created");
wire_tag!(CheckpointListTag, "checkpoints");
wire_tag!(CheckpointRestorePreviewTag, "checkpoint_restore_preview");
wire_tag!(CheckpointRestoredTag, "checkpoint_restored");
wire_tag!(CheckpointDeletedTag, "checkpoint_deleted");

/// Why a checkpoint exists.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointKind {
    /// Requested through `checkpoint.create`.
    Manual,
    /// Saved automatically by `checkpoint.restore` before it changed anything.
    Safety,
}

/// What a checkpoint holds and what it leaves out.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointCoverage {
    /// Files in the working-tree snapshot, including symbolic links. Binary
    /// files are stored byte for byte.
    pub files: u64,
    /// Untracked, non-ignored files included in the snapshot.
    pub untracked_files: u64,
    pub symlinks: u64,
    /// Submodules and nested repositories, recorded by commit only; their
    /// contents are not captured.
    pub submodules: u64,
    /// Ignored entries left out. An ignored directory counts once.
    pub ignored_entries: u64,
    /// The categories this checkpoint never covers.
    pub not_covered: Vec<String>,
}

/// One checkpoint as Git records it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointSummary {
    pub checkpoint_id: String,
    pub workspace_id: String,
    pub kind: CheckpointKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The private ref that keeps the checkpoint.
    pub ref_name: String,
    /// The checkpoint commit.
    pub commit: String,
    /// The tree of the working-tree snapshot.
    pub worktree_tree: String,
    /// The tree of the index snapshot.
    pub index_tree: String,
    /// HEAD when the checkpoint was made; absent on an unborn branch.
    pub head: Option<String>,
    /// The branch HEAD named; absent when detached or unborn.
    pub branch: Option<String>,
    pub created_at: i64,
    pub coverage: CheckpointCoverage,
}

/// A checkpoint ref that ADE cannot read as a checkpoint.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointProblem {
    pub ref_name: String,
    pub problem: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointCreated {
    #[serde(rename = "type")]
    pub tag: CheckpointCreatedTag,
    pub checkpoint: CheckpointSummary,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointList {
    #[serde(rename = "type")]
    pub tag: CheckpointListTag,
    pub workspace_id: String,
    /// Newest first.
    pub checkpoints: Vec<CheckpointSummary>,
    /// Refs under the workspace's namespace that do not parse as checkpoints.
    pub problems: Vec<CheckpointProblem>,
}

/// How restoring one path changes it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointChangeKind {
    Added,
    Modified,
    Deleted,
    /// The file type or mode changes, such as a file becoming a symbolic link.
    TypeChanged,
}

/// Which snapshot a change belongs to.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointArea {
    Worktree,
    Index,
}

/// One path a restore changes, relative to the workspace root.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointPathChange {
    pub path: String,
    pub area: CheckpointArea,
    pub kind: CheckpointChangeKind,
}

/// Whether a restore may run now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointRestoreVerdict {
    /// The workspace already matches the checkpoint.
    Unchanged,
    /// Restore may run with this preview's `state_token`.
    Ready,
    /// Restore replaces uncommitted work; it needs `confirm_overwrite`.
    NeedsConfirmation,
    /// Restore refuses; `blocked_reasons` says why.
    Blocked,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointRestorePreview {
    #[serde(rename = "type")]
    pub tag: CheckpointRestorePreviewTag,
    pub checkpoint: CheckpointSummary,
    pub verdict: CheckpointRestoreVerdict,
    /// Pass as `expected_state` to `checkpoint.restore`.
    pub state_token: String,
    pub changes: Vec<CheckpointPathChange>,
    /// Changed paths whose current content differs from HEAD. The safety
    /// checkpoint keeps them.
    pub uncommitted_overwritten: Vec<String>,
    /// Paths the checkpoint would write over ignored or excluded files on disk.
    /// Restore refuses while any exist, because no checkpoint covers them.
    pub ignored_overwritten: Vec<String>,
    /// HEAD moved since the checkpoint. Restore keeps the current HEAD.
    pub head_changed: bool,
    pub blocked_reasons: Vec<String>,
}

/// How a restore ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointRestoreOutcome {
    /// Nothing needed to change.
    Unchanged,
    /// The working tree and index were written and verified against the checkpoint.
    Restored,
    /// Some writes happened but the result does not match the checkpoint;
    /// `problems` says what. The safety checkpoint holds the prior state.
    Partial,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointRestored {
    #[serde(rename = "type")]
    pub tag: CheckpointRestoredTag,
    pub checkpoint_id: String,
    pub outcome: CheckpointRestoreOutcome,
    /// The state saved before any write; absent when nothing changed.
    pub safety_checkpoint: Option<CheckpointSummary>,
    pub changes: Vec<CheckpointPathChange>,
    /// Whether a fresh snapshot after the restore matched the checkpoint.
    pub verified: bool,
    pub problems: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CheckpointDeleted {
    #[serde(rename = "type")]
    pub tag: CheckpointDeletedTag,
    pub checkpoint_id: String,
    pub ref_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn spec(op: &str) -> Value {
        bundle()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone()
    }

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let name = spec(op)["request"].as_str().unwrap().to_owned();
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let name = spec(op)["response"].as_str().unwrap().to_owned();
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn summary() -> Value {
        json!({"checkpoint_id": "cp_1", "workspace_id": "workspace_1", "kind": "manual",
            "label": "before refactor", "ref_name": "refs/ade/checkpoints/workspace_1/cp_1",
            "commit": "c1", "worktree_tree": "t1", "index_tree": "t2", "head": "h1",
            "branch": "main", "created_at": 7,
            "coverage": {"files": 3, "untracked_files": 1, "symlinks": 0, "submodules": 0,
                "ignored_entries": 2, "not_covered": ["ignored files"]}})
    }

    #[test]
    fn tiers_are_declared() {
        for (op, tier) in [
            ("checkpoint.create", "effect_command"),
            ("checkpoint.list", "query"),
            ("checkpoint.restore.preview", "query"),
            ("checkpoint.restore", "effect_command"),
            ("checkpoint.delete", "effect_command"),
        ] {
            assert_eq!(spec(op)["tier"], tier, "{op}");
        }
    }

    #[test]
    fn requests_round_trip_and_reject_unknown_fields() {
        request::<CheckpointCreateRequest>(
            "checkpoint.create",
            json!({"op": "checkpoint.create", "operation_id": "o", "workspace_id": "w", "label": "x"}),
        );
        request::<CheckpointListRequest>(
            "checkpoint.list",
            json!({"op": "checkpoint.list", "workspace_id": "w"}),
        );
        request::<CheckpointRestorePreviewRequest>(
            "checkpoint.restore.preview",
            json!({"op": "checkpoint.restore.preview", "workspace_id": "w", "checkpoint_id": "c"}),
        );
        request::<CheckpointRestoreRequest>(
            "checkpoint.restore",
            json!({"op": "checkpoint.restore", "operation_id": "o", "workspace_id": "w",
                "checkpoint_id": "c", "expected_state": "s", "confirm_overwrite": true}),
        );
        request::<CheckpointDeleteRequest>(
            "checkpoint.delete",
            json!({"op": "checkpoint.delete", "operation_id": "o", "workspace_id": "w",
                "checkpoint_id": "c", "expected_commit": "c1"}),
        );
        let name = spec("checkpoint.restore")["request"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!valid(
            &name,
            &json!({"op": "checkpoint.restore", "operation_id": "o", "workspace_id": "w",
                "checkpoint_id": "c", "expected_state": "s", "force": true})
        ));
        assert!(!valid(
            &name,
            &json!({"op": "checkpoint.restore", "operation_id": "o", "workspace_id": "w",
                "checkpoint_id": "c"})
        ));
    }

    #[test]
    fn responses_round_trip() {
        response::<CheckpointCreated>(
            "checkpoint.create",
            json!({"type": "checkpoint_created", "checkpoint": summary()}),
        );
        response::<CheckpointList>(
            "checkpoint.list",
            json!({"type": "checkpoints", "workspace_id": "workspace_1", "checkpoints": [summary()],
                "problems": [{"ref_name": "refs/ade/checkpoints/workspace_1/x", "problem": "bad"}]}),
        );
        response::<CheckpointRestorePreview>(
            "checkpoint.restore.preview",
            json!({"type": "checkpoint_restore_preview", "checkpoint": summary(),
                "verdict": "needs_confirmation", "state_token": "s",
                "changes": [{"path": "a.txt", "area": "worktree", "kind": "modified"}],
                "uncommitted_overwritten": ["a.txt"], "ignored_overwritten": [],
                "head_changed": false, "blocked_reasons": []}),
        );
        response::<CheckpointRestored>(
            "checkpoint.restore",
            json!({"type": "checkpoint_restored", "checkpoint_id": "cp_1", "outcome": "restored",
                "safety_checkpoint": summary(), "changes": [], "verified": true, "problems": []}),
        );
        response::<CheckpointDeleted>(
            "checkpoint.delete",
            json!({"type": "checkpoint_deleted", "checkpoint_id": "cp_1",
                "ref_name": "refs/ade/checkpoints/workspace_1/cp_1"}),
        );
    }
}
