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
wire_tag!(WorkspaceRebindCatalogTag, "workspace_rebind_catalog");
wire_tag!(RepositoryRebindCatalogTag, "repository_rebind_catalog");

/// The `workspace.open` and `workspace.rebind` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorkspaceAck {
    #[serde(rename = "type")]
    pub tag: WorkspaceAckTag,
    pub workspace: WorkspaceRecord,
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
            "extra_terminals": [], "id": "workspace_1", "repository_id": null,
            "root": "/tmp/project", "name": "project", "terminal_id": "terminal_1",
            "needs_rebind": false, "worktree_lifecycle_needs_rebind": false,
        })
    }

    #[test]
    fn tiers_are_declared() {
        for (op, tier) in [
            ("workspace.open", "idempotent_command"),
            ("workspace.rebind", "idempotent_command"),
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
