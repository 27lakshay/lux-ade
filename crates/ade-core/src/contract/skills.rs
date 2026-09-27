//! Skill catalog contracts (F132, D14, architecture section 9).
//!
//! The profile catalog stores complete, pinned skill directory bundles with
//! provenance, and read-only references to skills that providers already read
//! from their own paths. Install, adopt and remove are effect commands with
//! receipts. Discovery refreshes stored references and converges when repeated.
//! No operation here writes into a provider path: projection only describes
//! where each provider would read a bundle and what a placement would need.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<SkillInstallRequest, SkillInstalled>(
            "skill.install",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<SkillAdoptRequest, SkillInstalled>("skill.adopt", Tier::EffectCommand),
        OperationSpec::new::<SkillRemoveRequest, SkillRemoved>("skill.remove", Tier::EffectCommand),
        OperationSpec::new::<SkillListRequest, SkillList>("skill.list", Tier::Query),
        OperationSpec::new::<SkillInspectRequest, SkillInspection>("skill.inspect", Tier::Query),
        OperationSpec::new::<SkillDiscoverRequest, SkillDiscovery>(
            "skill.discover",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `skill.install`: copy a local skill directory into the catalog as a pinned bundle.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillInstallRequest {
    pub operation_id: String,
    /// Absolute path of the skill directory; it must hold `SKILL.md`.
    pub source_path: String,
    /// The bundle content hash the caller expects. The install fails closed
    /// when the directory no longer hashes to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_content_hash: Option<String>,
    /// Required to replace an installed bundle of the same name: that bundle's
    /// current content hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_content_hash: Option<String>,
}

/// `skill.adopt`: take ownership of a skill directory a provider already reads.
/// The directory is copied into the catalog unchanged and its provider path is
/// recorded as catalog-owned. Only adoption lets a later placement replace it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillAdoptRequest {
    pub operation_id: String,
    /// A path that `skill.discover` reported, directly inside a provider skill root.
    pub path: String,
    /// The content hash `skill.discover` reported; adoption fails when it changed.
    pub expected_content_hash: String,
    /// The workspace whose provider roots contain `path`, for workspace-scoped skills.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `skill.remove`: drop a bundle from the catalog. Provider files are never
/// deleted; adopted paths are released back to external ownership.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillRemoveRequest {
    pub operation_id: String,
    pub name: String,
    pub expected_content_hash: String,
}

/// `skill.list`: installed bundles and the stored external references.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillListRequest {}

/// `skill.inspect`: one bundle's manifest, provenance and provider projection.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillInspectRequest {
    pub name: String,
    /// Adds workspace-scoped provider paths to the projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `skill.discover`: scan provider skill roots and replace the stored
/// references for the scanned scopes. Reads only; never writes provider paths.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillDiscoverRequest {
    /// Also scans this workspace's provider roots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

wire_tag!(SkillInstalledTag, "skill_installed");
wire_tag!(SkillRemovedTag, "skill_removed");
wire_tag!(SkillListTag, "skills");
wire_tag!(SkillInspectionTag, "skill");
wire_tag!(SkillDiscoveryTag, "skill_discovery");

/// One file in a bundle. Paths are relative, `/`-separated and normalized.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillFile {
    pub path: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the file bytes.
    pub sha256: String,
    pub executable: bool,
}

/// The validated contents of a bundle.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillManifest {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    /// Sorted by path.
    pub files: Vec<SkillFile>,
    pub total_bytes: u64,
    /// Lowercase hex SHA-256 over the sorted file list (path, mode and file hash).
    pub content_hash: String,
}

/// How a bundle entered the catalog.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillSourceKind {
    LocalDirectory,
    Adopted,
}

/// Where a bundle came from and what it is pinned to.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillProvenance {
    pub kind: SkillSourceKind,
    /// The path the caller named.
    pub source_path: String,
    /// The same path with symlinks resolved when it was read.
    pub resolved_path: String,
    /// The content hash the bundle is pinned to; equal to the manifest's.
    pub pinned_content_hash: String,
    /// Entries skipped while reading the directory, such as `.git`.
    pub excluded: Vec<String>,
    pub installed_at: i64,
}

/// One installed bundle as `skill.list` shows it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub content_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub provenance: SkillProvenance,
    /// Provider paths this catalog owns through adoption.
    pub adopted_paths: Vec<String>,
}

/// Whether a provider root belongs to the user or to one workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Global,
    Workspace,
}

/// What discovery found at one entry of a provider skill root.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillReferenceStatus {
    /// A complete bundle that passes validation.
    Valid,
    /// Readable, but not a valid bundle; `problem` says why.
    Invalid,
    /// Could not be read; `problem` says why.
    Unreadable,
}

/// A skill directory that a provider reads and ADE does not own.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillReference {
    pub provider: String,
    pub scope: SkillScope,
    /// Set for workspace-scoped references.
    pub workspace_id: Option<String>,
    pub root: String,
    pub path: String,
    /// The entry's directory name.
    pub entry: String,
    pub status: SkillReferenceStatus,
    pub problem: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub content_hash: Option<String>,
    /// The link target when the entry is a symbolic link.
    pub symlink_target: Option<String>,
    /// The catalog bundle that owns this path through adoption.
    pub adopted_by: Option<String>,
    pub discovered_at: i64,
}

/// What a provider skill root looked like during discovery.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillRootStatus {
    Present,
    Missing,
    NotDirectory,
    Unreadable,
}

/// One provider skill root that discovery scanned.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillRoot {
    pub provider: String,
    pub scope: SkillScope,
    pub path: String,
    pub status: SkillRootStatus,
}

/// The state observed at the path a provider would read a bundle from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillObservedPlacement {
    Absent,
    /// An external directory with the same content hash as the bundle.
    ExternalIdentical,
    ExternalDifferent,
    /// An external symbolic link, file or other non-directory entry.
    ExternalOther,
    /// Adopted and unchanged since adoption.
    AdoptedUnchanged,
    /// Adopted, but changed on disk since adoption.
    AdoptedDrifted,
    Unreadable,
}

/// What a placement of the bundle at that path would need.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillPlacementDecision {
    /// Nothing is there; a placement may create the directory.
    Create,
    /// The path already holds this bundle's content.
    UpToDate,
    /// The catalog owns the path and it is unchanged; a placement may replace it.
    Replace,
    /// An external owner holds the path; only explicit adoption may change it.
    RequiresAdoption,
    /// The path cannot be changed safely; `reason` says why.
    Refuse,
}

/// Where one provider would read the bundle and what placing it there needs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct SkillProjection {
    pub provider: String,
    pub scope: SkillScope,
    pub root: String,
    pub path: String,
    pub observed: SkillObservedPlacement,
    pub decision: SkillPlacementDecision,
    pub reason: Option<String>,
}

/// The `skill.install` and `skill.adopt` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillInstalled {
    #[serde(rename = "type")]
    pub tag: SkillInstalledTag,
    pub skill: SkillSummary,
    /// False when the same bundle was already installed with this content.
    pub changed: bool,
    /// The content hash this install replaced, if any.
    pub replaced_content_hash: Option<String>,
}

/// The `skill.remove` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillRemoved {
    #[serde(rename = "type")]
    pub tag: SkillRemovedTag,
    pub name: String,
    pub content_hash: String,
    /// Adopted provider paths returned to external ownership, left in place.
    pub released_paths: Vec<String>,
}

/// The `skill.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillList {
    #[serde(rename = "type")]
    pub tag: SkillListTag,
    pub skills: Vec<SkillSummary>,
    /// References from the most recent discovery of each scope.
    pub references: Vec<SkillReference>,
}

/// The `skill.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillInspection {
    #[serde(rename = "type")]
    pub tag: SkillInspectionTag,
    pub skill: SkillSummary,
    pub manifest: SkillManifest,
    pub projection: Vec<SkillProjection>,
}

/// The `skill.discover` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct SkillDiscovery {
    #[serde(rename = "type")]
    pub tag: SkillDiscoveryTag,
    pub roots: Vec<SkillRoot>,
    pub references: Vec<SkillReference>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String, String) {
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
            spec["tier"].as_str().unwrap().to_owned(),
        )
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
        let (name, _, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn summary() -> Value {
        json!({"name": "pdf", "description": "Reads PDFs.", "content_hash": "ab", "file_count": 1,
            "total_bytes": 10, "adopted_paths": ["/h/.claude/skills/pdf"],
            "provenance": {"kind": "adopted", "source_path": "/h/.claude/skills/pdf",
                "resolved_path": "/h/.claude/skills/pdf", "pinned_content_hash": "ab",
                "excluded": [".git"], "installed_at": 5}})
    }

    fn reference() -> Value {
        json!({"provider": "claude", "scope": "global", "workspace_id": null,
            "root": "/h/.claude/skills", "path": "/h/.claude/skills/pdf", "entry": "pdf",
            "status": "valid", "problem": null, "name": "pdf", "description": "Reads PDFs.",
            "content_hash": "ab", "symlink_target": null, "adopted_by": null, "discovered_at": 7})
    }

    #[test]
    fn operations_declare_their_tiers() {
        assert_eq!(names("skill.install").2, "effect_command");
        assert_eq!(names("skill.adopt").2, "effect_command");
        assert_eq!(names("skill.remove").2, "effect_command");
        assert_eq!(names("skill.list").2, "query");
        assert_eq!(names("skill.inspect").2, "query");
        assert_eq!(names("skill.discover").2, "idempotent_command");
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<SkillInstallRequest>(
            "skill.install",
            json!({"op": "skill.install", "operation_id": "o", "source_path": "/s/pdf"}),
        );
        request::<SkillInstallRequest>(
            "skill.install",
            json!({"op": "skill.install", "operation_id": "o", "source_path": "/s/pdf",
                "expected_content_hash": "ab", "replace_content_hash": "cd"}),
        );
        request::<SkillAdoptRequest>(
            "skill.adopt",
            json!({"op": "skill.adopt", "operation_id": "o", "path": "/p",
                "expected_content_hash": "ab", "workspace_id": "w"}),
        );
        request::<SkillRemoveRequest>(
            "skill.remove",
            json!({"op": "skill.remove", "operation_id": "o", "name": "pdf",
                "expected_content_hash": "ab"}),
        );
        request::<SkillListRequest>("skill.list", json!({"op": "skill.list"}));
        request::<SkillInspectRequest>(
            "skill.inspect",
            json!({"op": "skill.inspect", "name": "pdf", "workspace_id": "w"}),
        );
        request::<SkillDiscoverRequest>("skill.discover", json!({"op": "skill.discover"}));
        let (name, _, _) = names("skill.adopt");
        assert!(!valid(
            &name,
            &json!({"op": "skill.adopt", "operation_id": "o", "path": "/p"})
        ));
        let (name, _, _) = names("skill.remove");
        assert!(!valid(
            &name,
            &json!({"op": "skill.remove", "operation_id": "o", "name": "pdf",
                "expected_content_hash": "ab", "force": true})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<SkillInstalled>(
            "skill.install",
            json!({"type": "skill_installed", "skill": summary(), "changed": true,
                "replaced_content_hash": null}),
        );
        response::<SkillRemoved>(
            "skill.remove",
            json!({"type": "skill_removed", "name": "pdf", "content_hash": "ab",
                "released_paths": ["/h/.claude/skills/pdf"]}),
        );
        response::<SkillList>(
            "skill.list",
            json!({"type": "skills", "skills": [summary()], "references": [reference()]}),
        );
        response::<SkillInspection>(
            "skill.inspect",
            json!({"type": "skill", "skill": summary(),
                "manifest": {"name": "pdf", "description": "Reads PDFs.", "license": "MIT",
                    "files": [{"path": "SKILL.md", "size": 10, "sha256": "ef", "executable": false}],
                    "total_bytes": 10, "content_hash": "ab"},
                "projection": [{"provider": "claude", "scope": "global", "root": "/h/.claude/skills",
                    "path": "/h/.claude/skills/pdf", "observed": "adopted_unchanged",
                    "decision": "up_to_date", "reason": null}]}),
        );
        response::<SkillDiscovery>(
            "skill.discover",
            json!({"type": "skill_discovery", "references": [reference()],
                "roots": [{"provider": "codex", "scope": "global", "path": "/h/.codex/skills",
                    "status": "missing"}]}),
        );
        let (_, name, _) = names("skill.inspect");
        assert!(!valid(
            &name,
            &json!({"type": "skill", "skill": summary(), "manifest": {}, "projection": []})
        ));
    }
}
