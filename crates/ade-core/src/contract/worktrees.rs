//! Worktree lifecycle contracts: repository registration, linked-tree listing,
//! switch, adopt, remove, refresh, configuration, operation receipts and rebind.
//!
//! Effect commands carry `operation_id`; `request_id` is accepted as an alias
//! for callers written before the rename. Replies describe exactly what the
//! lifecycle daemon sends.
use super::{FrameSpec, OperationSpec, Tier};
use crate::worktrees::Config;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<WorktreeRepositoryRequest, WorktreeState>(
            "worktree.repository",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeGetRequest, WorktreeState>("worktree.get", Tier::Query),
        OperationSpec::new::<WorktreeSwitchRequest, WorktreeState>(
            "worktree.switch",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeAdoptRequest, WorktreeState>(
            "worktree.adopt",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeRemoveRequest, WorktreeState>(
            "worktree.remove",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeRefreshRequest, WorktreeState>(
            "worktree.refresh",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeConfigureRequest, WorktreeState>(
            "worktree.configure",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeOperationRequest, WorktreeOperationReply>(
            "worktree.operation",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeRebindRequest, WorktreeState>(
            "worktree.rebind",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeRebindListRequest, WorktreeRebindCatalog>(
            "worktree.rebind.list",
            Tier::Query,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `worktree.repository`: register the Git repository containing `path`, or
/// return the one already registered for its common directory.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRepositoryRequest {
    pub path: String,
}

/// `worktree.get`: read a registered repository's lifecycle state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeGetRequest {
    pub repository_id: String,
}

/// `worktree.switch`: check out `target` in a linked tree, creating the branch
/// when `create` is true.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeSwitchRequest {
    pub repository_id: String,
    /// Caller-owned operation ID; `request_id` is accepted as an alias.
    #[serde(alias = "request_id")]
    pub operation_id: String,
    /// A branch name, or the path of an existing linked tree.
    pub target: String,
    /// Start point for a new branch; the daemon uses `HEAD` when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Absolute path for a new tree, directly inside the configured directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<bool>,
}

/// `worktree.adopt`: take ADE removal authority over an existing linked tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeAdoptRequest {
    pub repository_id: String,
    pub path: String,
    /// Must equal the canonical form of `path`. Optional in Rust only so a
    /// missing value keeps the daemon's own error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(required)]
    pub confirm_path: Option<String>,
}

/// What `worktree.remove` does with the removed tree's branch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BranchPolicy {
    Keep,
    /// Delete the branch only if Git reports it merged.
    Merged,
}

/// `worktree.remove`: remove a clean ADE-owned linked tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRemoveRequest {
    pub repository_id: String,
    /// Caller-owned operation ID; `request_id` is accepted as an alias.
    #[serde(alias = "request_id")]
    pub operation_id: String,
    pub path: String,
    /// Branch policy; the daemon uses `keep` when it is absent. The daemon
    /// reads the raw string so an unknown policy keeps its own error message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<BranchPolicy>")]
    pub delete_branch: Option<String>,
    /// Forced removal is unavailable; `true` is rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_path: Option<String>,
}

/// `worktree.refresh`: re-read the Git worktree listing under the repository lock.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRefreshRequest {
    pub repository_id: String,
    /// Caller-owned operation ID; `request_id` is accepted as an alias.
    #[serde(alias = "request_id")]
    pub operation_id: String,
}

/// `worktree.configure`: replace a repository's lifecycle configuration.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeConfigureRequest {
    pub repository_id: String,
    pub config: WorktreeConfigInput,
}

/// The configuration a caller sends. Absent fields take their defaults; the
/// stored form is [`Config`].
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct WorktreeConfigInput {
    /// Parent directory for new trees; the repository's parent when absent.
    pub directory: Option<String>,
    /// Git command timeout; the daemon accepts 5 to 300.
    pub timeout_seconds: u64,
}

impl Default for WorktreeConfigInput {
    fn default() -> Self {
        let Config {
            directory,
            timeout_seconds,
        } = Config::default();
        Self {
            directory,
            timeout_seconds,
        }
    }
}

impl From<WorktreeConfigInput> for Config {
    fn from(input: WorktreeConfigInput) -> Self {
        Self {
            directory: input.directory,
            timeout_seconds: input.timeout_seconds,
        }
    }
}

/// `worktree.operation`: read one lifecycle operation receipt in full.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperationRequest {
    pub repository_id: String,
    /// The operation's ID; `request_id` is accepted as an alias.
    #[serde(alias = "request_id")]
    pub operation_id: String,
}

/// `worktree.rebind`: bind a restored lifecycle repository to a verified checkout.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindRequest {
    pub repository_id: String,
    pub path: String,
}

/// `worktree.rebind.list`: list lifecycle repositories and whether each needs a rebind.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct WorktreeRebindListRequest {}

wire_tag!(WorktreeStateTag, "worktree_state");
wire_tag!(WorktreeOperationTag, "worktree_operation");
wire_tag!(WorktreeRebindCatalogTag, "worktree_rebind_catalog");

/// A repository's lifecycle state: the reply to every command except
/// `worktree.operation` and `worktree.rebind.list`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeState {
    #[serde(rename = "type")]
    pub tag: WorktreeStateTag,
    pub repository: WorktreeRepository,
    /// The cached Git listing, primary checkout first.
    pub worktrees: Vec<WorktreeItem>,
    /// Whether a lifecycle or review operation holds the repository.
    pub busy: bool,
    /// The newest 100 operations, newest first, without command output.
    pub operations: Vec<WorktreeOperation>,
}

/// A registered lifecycle repository. Device and inode identities are decimal strings.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRepository {
    pub id: String,
    /// The primary checkout, where lifecycle commands run.
    pub root: String,
    pub common_dir: String,
    /// The common directory before the first rebind.
    pub source_common_dir: Option<String>,
    pub root_device: Option<String>,
    pub root_inode: Option<String>,
    pub source_root_device: Option<String>,
    pub source_root_inode: Option<String>,
    pub common_device: Option<String>,
    pub common_inode: Option<String>,
    pub source_common_device: Option<String>,
    pub source_common_inode: Option<String>,
    pub needs_rebind: bool,
    pub binding_generation: i64,
    pub config: Config,
    pub refreshed_at: Option<i64>,
}

/// Whether a tree is ready for an Agent, from its latest `worktree.switch`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupState {
    Ready,
    Preparing,
    Interrupted,
    Failed,
}

/// One entry of `git worktree list`, with ADE's ownership and setup state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prunable: Option<bool>,
    /// Whether ADE holds removal authority over this tree.
    pub ade_owned: bool,
    pub setup_state: SetupState,
}

/// A lifecycle operation's status in its ledger.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeOperationStatus {
    Running,
    Succeeded,
    /// The tree was removed but its branch was kept.
    Partial,
    Failed,
    /// The daemon stopped while the operation ran; inspect before retrying.
    Interrupted,
}

/// One lifecycle operation from the ledger. The daemon stores this shape.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperation {
    /// The caller's operation ID.
    pub id: String,
    pub repository_id: String,
    #[serde(default)]
    pub binding_generation: i64,
    /// The request as the caller sent it, including `op`.
    #[schemars(with = "Value")]
    pub request: Value,
    #[serde(default)]
    pub worktree_path: Option<String>,
    pub status: WorktreeOperationStatus,
    /// Command output and its `value`; `null` until the command runs.
    /// `worktree_state` omits `stdout` and `stderr`.
    #[schemars(with = "Value")]
    pub result: Value,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// The `worktree.operation` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperationReply {
    #[serde(rename = "type")]
    pub tag: WorktreeOperationTag,
    pub operation: WorktreeOperation,
}

/// The `worktree.rebind.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindCatalog {
    #[serde(rename = "type")]
    pub tag: WorktreeRebindCatalogTag,
    pub repositories: Vec<WorktreeRebindCandidate>,
}

/// One lifecycle repository in the rebind catalog.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindCandidate {
    pub id: String,
    pub root: String,
    pub common_dir: String,
    pub needs_rebind: bool,
    /// Whether the saved source identity survives, so a rebind can be verified.
    pub rebindable: bool,
    pub binding_generation: i64,
}

#[cfg(test)]
mod tests {
    use super::super::{DEFINITIONS, bundle};
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn names(op: &str) -> (String, String) {
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
        )
    }

    fn errors(name: &str, value: &Value) -> Vec<String> {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("{DEFINITIONS}{name}"),
        });
        jsonschema::validator_for(&schema)
            .unwrap()
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect()
    }

    /// A wire request the daemon receives today decodes, and its canonical
    /// re-encoding matches the generated schema.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let decoded: T = serde_json::from_value(wire).unwrap();
        let mut canonical = serde_json::to_value(&decoded).unwrap();
        canonical["op"] = json!(op);
        let (name, _) = names(op);
        let found = errors(&name, &canonical);
        assert!(found.is_empty(), "{name} rejected {canonical}: {found:?}");
        decoded
    }

    fn reply<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        let found = errors(&name, &wire);
        assert!(found.is_empty(), "{name} rejected {wire}: {found:?}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn operation() -> Value {
        json!({"id": "op-1", "repository_id": "repository_1", "binding_generation": 0,
            "request": {"op": "worktree.switch", "repository_id": "repository_1",
                "target": "feature", "create": true, "request_id": "op-1"},
            "worktree_path": "/tmp/repo-feature", "status": "failed",
            "result": {"exit_code": 1, "elapsed_ms": 3, "value": {"path": null, "git_exit_code": 1}},
            "error": "Git command failed", "code": "lifecycle_command_failed",
            "recovery": "inspect_repository", "started_at": 1, "finished_at": 2})
    }

    fn state() -> Value {
        json!({"type": "worktree_state",
            "repository": {"id": "repository_1", "root": "/tmp/repo", "common_dir": "/tmp/repo/.git",
                "source_common_dir": null, "root_device": "1", "root_inode": "2",
                "source_root_device": "1", "source_root_inode": "2", "common_device": "1",
                "common_inode": "3", "source_common_device": "1", "source_common_inode": "3",
                "needs_rebind": false, "binding_generation": 0,
                "config": {"directory": null, "timeout_seconds": 60}, "refreshed_at": null},
            "worktrees": [
                {"path": "/tmp/repo", "branch": "main", "ade_owned": false, "setup_state": "ready"},
                {"path": "/tmp/repo-x", "detached": true, "locked": true, "lock_reason": "moving",
                    "prunable": true, "ade_owned": true, "setup_state": "preparing"}],
            "busy": false,
            "operations": [operation(),
                {"id": "op-2", "repository_id": "repository_1", "binding_generation": 1,
                    "request": {"op": "worktree.refresh"}, "worktree_path": null,
                    "status": "running", "result": null, "error": null,
                    "started_at": 3, "finished_at": null}]})
    }

    #[test]
    fn effect_requests_accept_request_id_and_emit_operation_id() {
        let switch: WorktreeSwitchRequest = request(
            "worktree.switch",
            json!({"op": "worktree.switch", "repository_id": "r", "request_id": "k",
                "target": "feature", "base": "main", "create": true}),
        );
        assert_eq!(switch.operation_id, "k");
        let switch: WorktreeSwitchRequest = request(
            "worktree.switch",
            json!({"repository_id": "r", "operation_id": "k", "target": "feature",
                "base": null, "path": null}),
        );
        assert!(switch.base.is_none() && switch.create.is_none());
        let remove: WorktreeRemoveRequest = request(
            "worktree.remove",
            json!({"repository_id": "r", "request_id": "k", "path": "/tmp/t",
                "delete_branch": "merged"}),
        );
        assert_eq!(remove.delete_branch.as_deref(), Some("merged"));
        let refresh: WorktreeRefreshRequest = request(
            "worktree.refresh",
            json!({"repository_id": "r", "request_id": "k"}),
        );
        assert_eq!(refresh.operation_id, "k");
        let lookup: WorktreeOperationRequest = request(
            "worktree.operation",
            json!({"repository_id": "r", "request_id": "k"}),
        );
        assert_eq!(lookup.operation_id, "k");
    }

    #[test]
    fn remaining_requests_round_trip() {
        request::<WorktreeRepositoryRequest>("worktree.repository", json!({"path": "/tmp/repo"}));
        request::<WorktreeGetRequest>("worktree.get", json!({"repository_id": "r"}));
        let adopt: WorktreeAdoptRequest = request(
            "worktree.adopt",
            json!({"repository_id": "r", "path": "/tmp/t", "confirm_path": "/tmp/t"}),
        );
        assert_eq!(adopt.confirm_path.as_deref(), Some("/tmp/t"));
        let configure: WorktreeConfigureRequest = request(
            "worktree.configure",
            json!({"repository_id": "r", "config": {}}),
        );
        let config = Config::from(configure.config);
        assert_eq!((config.directory, config.timeout_seconds), (None, 60));
        request::<WorktreeRebindRequest>(
            "worktree.rebind",
            json!({"repository_id": "r", "path": "/tmp/repo"}),
        );
        request::<WorktreeRebindListRequest>("worktree.rebind.list", json!({}));
    }

    #[test]
    fn request_schemas_reject_what_the_daemon_rejects() {
        let (adopt, _) = names("worktree.adopt");
        assert!(
            !errors(
                &adopt,
                &json!({"op": "worktree.adopt", "repository_id": "r", "path": "/p"})
            )
            .is_empty()
        );
        let (remove, _) = names("worktree.remove");
        assert!(
            !errors(
                &remove,
                &json!({"op": "worktree.remove", "repository_id": "r", "operation_id": "k",
                    "path": "/p", "delete_branch": "always"})
            )
            .is_empty()
        );
        let (configure, _) = names("worktree.configure");
        assert!(
            !errors(
                &configure,
                &json!({"op": "worktree.configure", "repository_id": "r",
                    "config": {"path_template": "x"}})
            )
            .is_empty()
        );
        assert!(
            serde_json::from_value::<WorktreeConfigureRequest>(
                json!({"repository_id": "r", "config": {"hooks": true}})
            )
            .is_err()
        );
    }

    #[test]
    fn replies_round_trip() {
        for op in [
            "worktree.repository",
            "worktree.get",
            "worktree.switch",
            "worktree.adopt",
            "worktree.remove",
            "worktree.refresh",
            "worktree.configure",
            "worktree.rebind",
        ] {
            reply::<WorktreeState>(op, state());
        }
        reply::<WorktreeOperationReply>(
            "worktree.operation",
            json!({"type": "worktree_operation", "operation": operation()}),
        );
        reply::<WorktreeRebindCatalog>(
            "worktree.rebind.list",
            json!({"type": "worktree_rebind_catalog", "repositories": [
                {"id": "repository_1", "root": "/tmp/repo", "common_dir": "/tmp/repo/.git",
                    "needs_rebind": true, "rebindable": true, "binding_generation": 2}]}),
        );
    }

    #[test]
    fn legacy_ledger_rows_default_new_fields() {
        let legacy: WorktreeOperation = serde_json::from_value(json!({"id": "old",
            "repository_id": "repo", "request": {}, "status": "interrupted",
            "result": null, "error": null, "started_at": 1, "finished_at": null}))
        .unwrap();
        assert_eq!(legacy.binding_generation, 0);
        assert!(legacy.worktree_path.is_none() && legacy.code.is_none());
        let encoded = serde_json::to_value(legacy).unwrap();
        assert!(encoded.get("code").is_none());
        assert_eq!(encoded["worktree_path"], Value::Null);
    }
}
