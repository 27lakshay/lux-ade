//! Workspace, repository binding and catalog contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::{Catalogue, Repository, WorkspaceRecord};
use crate::provider::Descriptor;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<CatalogGetRequest, CatalogFrame>("catalog.get", Tier::Query),
        // Opening a known root returns its existing workspace record.
        OperationSpec::new::<WorkspaceOpenRequest, WorkspaceAck>(
            "workspace.open",
            Tier::IdempotentCommand,
        ),
        // Renaming sets only the name ADE shows; a repeat leaves the same name.
        OperationSpec::new::<WorkspaceRenameRequest, WorkspaceAck>(
            "workspace.rename",
            Tier::IdempotentCommand,
        ),
        // "Remove from ADE" stops the workspace's terminals and disconnects
        // its idle Agents: it ends processes, like `terminal.stop`, and it
        // spans the runtime and the profile database, so no one transaction
        // can hold both. It is therefore an effect command recorded by the
        // daemon's envelope (`crates/ade-daemon/src/envelope.rs`, receipts in
        // `receipts.rs`). A repeat under a new operation ID converges: the
        // workspace stays removed and any terminal still running is stopped.
        OperationSpec::new::<WorkspaceRemoveRequest, WorkspaceRemoved>(
            "workspace.remove",
            Tier::EffectCommand,
        ),
        // Creating a worktree runs Git and setup hooks, then opens a
        // workspace: several steps across the lifecycle and profile stores.
        // The receipt and the operation's durable state live in the profile
        // database; each step is recovered after a crash.
        OperationSpec::new::<WorkspaceCreateWorktreeRequest, WorkspaceWorktreeOperation>(
            "workspace.create_worktree",
            Tier::EffectCommand,
        ),
        // Deleting a worktree removes the workspace from ADE, then removes the
        // tree through the lifecycle; the same durable state recovers it.
        OperationSpec::new::<WorkspaceDeleteWorktreeRequest, WorkspaceWorktreeOperation>(
            "workspace.delete_worktree",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorkspaceRebindListRequest, WorkspaceRebindCatalog>(
            "workspace.rebind.list",
            Tier::Query,
        ),
        // Rebinding changes only ADE's saved binding; a repeat is rejected
        // because the target is already bound, leaving the same state.
        OperationSpec::new::<WorkspaceRebindRequest, WorkspaceAck>(
            "workspace.rebind",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<RepositoryRebindListRequest, RepositoryRebindCatalog>(
            "repository.rebind.list",
            Tier::Query,
        ),
        OperationSpec::new::<RepositoryRebindRequest, RepositoryAck>(
            "repository.rebind",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<CatalogFrame>("catalog")]
}

/// `catalog.get`: read the profile's workspaces, conversations and windows.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct CatalogGetRequest {}

wire_tag!(CatalogTag, "catalog");

/// The `catalog.get` reply and the `catalog` feed frame.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CatalogFrame {
    #[serde(rename = "type")]
    pub tag: CatalogTag,
    pub catalog: Catalogue,
    pub providers: Vec<Descriptor>,
    pub boot_id: String,
    pub revision: u64,
}

/// `workspace.open`: register a folder, or return the workspace already at it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceOpenRequest {
    /// The folder to open; the daemon canonicalizes it.
    pub path: String,
}

/// `workspace.rename`: change the name ADE shows for a workspace. The folder,
/// its path and any Git branch are unchanged.
///
/// The daemon trims `name` and refuses an empty name, one longer than 100
/// characters or one with a control character (`invalid_workspace_name`). An
/// unknown ID is `workspace_not_found`; a removed workspace is
/// `workspace_removed`. The new name persists and a `catalog` frame follows.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRenameRequest {
    pub workspace_id: String,
    pub name: String,
}

/// `workspace.remove` ("Remove from ADE"): hide a workspace from the catalog
/// without touching its files.
///
/// - Refused with `workspace_remove_blocked` while a Conversation turn runs, a
///   Conversation is handed to a terminal, a service runs, a script run is
///   still running, or the workspace is the daemon's default. The error frame
///   carries `blockers`: `[{kind, id, label}]`, where `kind` is
///   `conversation_running`, `conversation_in_terminal`, `service_running`,
///   `script_running` or `default_workspace`.
/// - Otherwise it disconnects the workspace's idle Agents, records the
///   removal, stops every terminal (primary, extra and exited script runs)
///   and retires all but service terminals, so no process or worktree lease
///   remains. A later `worktree.remove` of the folder sees no `active_work`.
/// - The record stays, so Conversations keep their workspace. They leave the
///   catalog with it. `workspace.open` on the same folder restores the same
///   workspace ID and its Conversations.
/// - Removing a removed workspace succeeds and changes nothing. An unknown ID
///   is `workspace_not_found`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRemoveRequest {
    /// The caller's operation ID. A retry with the same ID and payload returns
    /// the recorded outcome; the same ID with another payload is a conflict.
    pub operation_id: String,
    pub workspace_id: String,
}

/// `workspace.create_worktree`: create a linked worktree of a repository
/// project and open it as a workspace named `name`.
///
/// The daemon creates the branch and tree through the worktree lifecycle
/// (`worktree.create` with the project's naming defaults, setup hooks
/// included), then opens the tree as a workspace, renames it to `name` and
/// marks it ADE-owned. The reply carries the operation's state at once; the
/// workspace appears in the catalog when it is ready. The lifecycle step's
/// progress is readable with `worktree.operation` under the project ID and
/// this operation ID. A retry with the same ID and payload returns the
/// current state. While another operation holds the repository, the
/// creation waits, `running`, and starts after it.
///
/// Refused before anything is recorded: an unknown project
/// (`project_not_found`), a plain folder project (`project_not_repository`),
/// an invalid name (`invalid_workspace_name`), or an operation ID the
/// worktree lifecycle already used for a command of its own (`conflict`).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceCreateWorktreeRequest {
    /// The caller's operation ID.
    pub operation_id: String,
    /// A repository project; a pre-unification lifecycle repository ID is
    /// accepted as an alias.
    pub project_id: String,
    /// The name ADE shows; the branch is the project's branch prefix plus
    /// its slug. Trimmed, 1 to 100 characters, no control characters.
    pub name: String,
    /// Start point; the project's configured default base, then `HEAD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// `workspace.delete_worktree`: remove a linked worktree's workspace from
/// ADE, then remove the tree.
///
/// Before changing anything the daemon checks the workspace's
/// `workspace.remove` blockers and the tree's `worktree.cleanup.plan`
/// blockers (except `active_work`, `setup_incomplete` and
/// `teardown_incomplete`, which the removal itself resolves), and refuses with
/// `worktree_delete_blocked` and `blockers: [{kind, id, label}]`. A primary
/// checkout is refused with `primary_checkout`, a plain folder with
/// `not_a_worktree`. A workspace already removed from ADE is accepted.
///
/// While another operation holds the repository, the deletion waits before
/// removing anything; it then checks the blockers again, so a tree that
/// became dirty meanwhile fails the operation with `worktree_delete_blocked`
/// and the workspace untouched. If the tree cannot be removed after the
/// workspace was, the workspace is restored, but without its previous
/// layouts and terminals; the failed state's `error` says so, or says the
/// restore failed too. A crash between the two steps is recovered when the
/// daemon starts again.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceDeleteWorktreeRequest {
    /// The caller's operation ID.
    pub operation_id: String,
    pub workspace_id: String,
    /// What happens to the tree's branch; `keep` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_branch: Option<super::worktrees::BranchPolicy>,
}

/// Which workspace worktree operation a state describes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWorktreeKind {
    CreateWorktree,
    DeleteWorktree,
}

/// Where a workspace worktree operation stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWorktreeStatus {
    Running,
    Succeeded,
    /// See `error` and `code`. A failed creation opens no workspace; a failed
    /// deletion keeps the tree and restores its workspace.
    Failed,
}

/// The `workspace.create_worktree` and `workspace.delete_worktree` reply:
/// the operation's current state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct WorkspaceWorktreeOperation {
    #[serde(rename = "type")]
    pub tag: WorkspaceWorktreeOperationTag,
    pub operation_id: String,
    pub kind: WorkspaceWorktreeKind,
    pub status: WorkspaceWorktreeStatus,
    pub project_id: String,
    /// The new workspace once created, or the workspace being deleted.
    pub workspace_id: Option<String>,
    /// The tree's path once the lifecycle names it.
    pub worktree_path: Option<String>,
    pub error: Option<String>,
    pub code: Option<String>,
}

/// `workspace.rebind.list`: restored workspaces and whether each needs a path.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct WorkspaceRebindListRequest {}

/// `workspace.rebind`: bind a restored workspace to a verified directory.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRebindRequest {
    pub workspace_id: String,
    pub path: String,
}

/// `repository.rebind.list`: restored repositories and whether each needs a path.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct RepositoryRebindListRequest {}

/// `repository.rebind`: bind a restored Git repository to a verified checkout.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryRebindRequest {
    pub repository_id: String,
    pub path: String,
}

wire_tag!(WorkspaceAckTag, "ack");
wire_tag!(WorkspaceRemovedTag, "workspace_removed");
wire_tag!(
    WorkspaceWorktreeOperationTag,
    "workspace_worktree_operation"
);
wire_tag!(WorkspaceRebindCatalogTag, "workspace_rebind_catalog");
wire_tag!(RepositoryRebindCatalogTag, "repository_rebind_catalog");

/// The `workspace.open`, `workspace.rename` and `workspace.rebind` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceAck {
    #[serde(rename = "type")]
    pub tag: WorkspaceAckTag,
    pub workspace: WorkspaceRecord,
}

/// The `workspace.remove` reply: the workspace is removed and none of its
/// terminals runs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRemoved {
    #[serde(rename = "type")]
    pub tag: WorkspaceRemovedTag,
    pub workspace_id: String,
}

/// The `repository.rebind` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryAck {
    #[serde(rename = "type")]
    pub tag: WorkspaceAckTag,
    pub repository: RepositoryRecord,
}

/// A saved repository as the daemon stores it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryRecord {
    pub id: String,
    /// The Git common directory.
    pub root: String,
    pub needs_rebind: bool,
    pub worktree_lifecycle_needs_rebind: bool,
}

impl From<Repository> for RepositoryRecord {
    fn from(repository: Repository) -> Self {
        Self {
            id: repository.id,
            root: repository.root,
            needs_rebind: repository.needs_rebind,
            worktree_lifecycle_needs_rebind: repository.worktree_lifecycle_needs_rebind,
        }
    }
}

/// The `workspace.rebind.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRebindCatalog {
    #[serde(rename = "type")]
    pub tag: WorkspaceRebindCatalogTag,
    pub workspaces: Vec<WorkspaceRebindEntry>,
}

/// One restored workspace. `rebindable` says a saved physical identity exists.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceRebindEntry {
    pub id: String,
    pub root: String,
    pub name: String,
    pub needs_rebind: bool,
    pub rebindable: bool,
}

/// The `repository.rebind.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryRebindCatalog {
    #[serde(rename = "type")]
    pub tag: RepositoryRebindCatalogTag,
    pub repositories: Vec<RepositoryRebindEntry>,
}

/// One restored repository. `rebindable` says a saved physical identity exists.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryRebindEntry {
    pub id: String,
    pub root: String,
    pub needs_rebind: bool,
    pub rebindable: bool,
}

#[cfg(test)]
mod tests {
    //! Schema round trips for the workspace binding contracts.
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String, Value) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
            spec["tier"].clone(),
        )
    }

    fn validator(name: &str) -> jsonschema::Validator {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).expect("generated schema compiles")
    }

    fn assert_valid(name: &str, value: &Value) {
        let errors: Vec<_> = validator(name)
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _, _) = names(op);
        let mut line = wire.clone();
        line["op"] = json!(op);
        assert_valid(&name, &line);
        let decoded: T = serde_json::from_value(line).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name, _) = names(op);
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(encoded, wire);
        assert_valid(&name, &encoded);
    }

    fn workspace() -> Value {
        json!({
            "id": "workspace_1", "repository_id": null,
            "root": "/tmp/project", "name": "project",
            "needs_rebind": false, "worktree_lifecycle_needs_rebind": false,
            "project_id": "project_1", "kind": "folder", "branch": null,
            "default": false, "ade_owned": false,
        })
    }

    #[test]
    fn tiers_are_declared() {
        for (op, tier) in [
            ("workspace.open", "idempotent_command"),
            ("workspace.rebind", "idempotent_command"),
            ("workspace.rename", "idempotent_command"),
            ("workspace.remove", "effect_command"),
            ("workspace.create_worktree", "effect_command"),
            ("workspace.delete_worktree", "effect_command"),
            ("repository.rebind", "idempotent_command"),
            ("workspace.rebind.list", "query"),
            ("repository.rebind.list", "query"),
        ] {
            assert_eq!(names(op).2, json!(tier), "{op}");
        }
    }

    #[test]
    fn requests_round_trip_in_wire_form() {
        request::<WorkspaceOpenRequest>("workspace.open", json!({"path": "/tmp/project"}));
        request::<WorkspaceRebindListRequest>("workspace.rebind.list", json!({}));
        request::<WorkspaceRenameRequest>(
            "workspace.rename",
            json!({"workspace_id": "workspace_1", "name": "Payments"}),
        );
        request::<WorkspaceRemoveRequest>(
            "workspace.remove",
            json!({"operation_id": "op_1", "workspace_id": "workspace_1"}),
        );
        request::<WorkspaceCreateWorktreeRequest>(
            "workspace.create_worktree",
            json!({"operation_id": "op_1", "project_id": "repo_1", "name": "Payments"}),
        );
        request::<WorkspaceCreateWorktreeRequest>(
            "workspace.create_worktree",
            json!({"operation_id": "op_1", "project_id": "repo_1", "name": "Payments",
                "base": "main"}),
        );
        request::<WorkspaceDeleteWorktreeRequest>(
            "workspace.delete_worktree",
            json!({"operation_id": "op_2", "workspace_id": "workspace_1"}),
        );
        request::<WorkspaceDeleteWorktreeRequest>(
            "workspace.delete_worktree",
            json!({"operation_id": "op_2", "workspace_id": "workspace_1",
                "delete_branch": "merged"}),
        );
        request::<RepositoryRebindListRequest>("repository.rebind.list", json!({}));
        request::<WorkspaceRebindRequest>(
            "workspace.rebind",
            json!({"workspace_id": "workspace_1", "path": "/tmp/project"}),
        );
        request::<RepositoryRebindRequest>(
            "repository.rebind",
            json!({"repository_id": "repo_1", "path": "/tmp/project"}),
        );
    }

    #[test]
    fn requests_reject_missing_and_extra_fields() {
        let (name, _, _) = names("workspace.open");
        assert!(!validator(&name).is_valid(&json!({"op": "workspace.open"})));
        assert!(!validator(&name).is_valid(&json!({"op": "workspace.open", "path": "/", "x": 1})));
        let (name, _, _) = names("repository.rebind");
        assert!(!validator(&name).is_valid(&json!({"op": "repository.rebind", "path": "/"})));
        let (name, _, _) = names("workspace.rename");
        assert!(
            !validator(&name).is_valid(&json!({"op": "workspace.rename", "workspace_id": "w"}))
        );
        let (name, _, _) = names("workspace.remove");
        assert!(
            !validator(&name).is_valid(&json!({"op": "workspace.remove", "workspace_id": "w"})),
            "an effect command needs its operation ID"
        );
        let (name, _, _) = names("workspace.create_worktree");
        assert!(
            !validator(&name).is_valid(
                &json!({"op": "workspace.create_worktree", "project_id": "p", "name": "n"})
            )
        );
        let (name, _, _) = names("workspace.delete_worktree");
        assert!(
            !validator(&name).is_valid(&json!({"op": "workspace.delete_worktree",
            "operation_id": "o", "workspace_id": "w", "delete_branch": "all"}))
        );
    }

    #[test]
    fn replies_round_trip_as_the_daemon_sends_them() {
        response::<WorkspaceAck>(
            "workspace.open",
            json!({"type": "ack", "workspace": workspace()}),
        );
        let mut linked = workspace();
        linked["repository_id"] = json!("repo_1");
        response::<WorkspaceAck>(
            "workspace.rebind",
            json!({"type": "ack", "workspace": linked}),
        );
        response::<RepositoryAck>(
            "repository.rebind",
            json!({"type": "ack", "repository": {
                "id": "repo_1", "root": "/tmp/project/.git",
                "needs_rebind": false, "worktree_lifecycle_needs_rebind": false,
            }}),
        );
        response::<WorkspaceAck>(
            "workspace.rename",
            json!({"type": "ack", "workspace": workspace()}),
        );
        response::<WorkspaceRemoved>(
            "workspace.remove",
            json!({"type": "workspace_removed", "workspace_id": "workspace_1"}),
        );
        response::<WorkspaceWorktreeOperation>(
            "workspace.create_worktree",
            json!({"type": "workspace_worktree_operation", "operation_id": "op_1",
                "kind": "create_worktree", "status": "running", "project_id": "repo_1",
                "workspace_id": null, "worktree_path": null, "error": null, "code": null}),
        );
        response::<WorkspaceWorktreeOperation>(
            "workspace.delete_worktree",
            json!({"type": "workspace_worktree_operation", "operation_id": "op_2",
                "kind": "delete_worktree", "status": "failed", "project_id": "repo_1",
                "workspace_id": "workspace_1", "worktree_path": "/src/app-feature",
                "error": "Git failed", "code": "lifecycle_command_failed"}),
        );
        response::<WorkspaceRebindCatalog>(
            "workspace.rebind.list",
            json!({"type": "workspace_rebind_catalog", "workspaces": [{
                "id": "workspace_1", "root": "/tmp/project", "name": "project",
                "needs_rebind": true, "rebindable": true,
            }]}),
        );
        response::<RepositoryRebindCatalog>(
            "repository.rebind.list",
            json!({"type": "repository_rebind_catalog", "repositories": [{
                "id": "repo_1", "root": "/tmp/project/.git",
                "needs_rebind": true, "rebindable": false,
            }]}),
        );
    }

    #[test]
    fn repository_record_matches_the_stored_model() {
        let stored: Repository =
            serde_json::from_value(json!({"id": "repo_1", "root": "/r"})).unwrap();
        let record = RepositoryRecord::from(stored.clone());
        assert_eq!(
            serde_json::to_value(record).unwrap(),
            serde_json::to_value(stored).unwrap()
        );
    }

    #[test]
    fn replies_reject_a_wrong_tag() {
        let (_, name, _) = names("workspace.rebind.list");
        assert!(!validator(&name).is_valid(&json!({"type": "ack", "workspaces": []})));
    }
}
