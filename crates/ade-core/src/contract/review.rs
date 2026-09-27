//! Review and Git contracts: status, diffs, reviewed Git mutations and their
//! receipts, and saved review-note search.
//!
//! Git mutations are effect commands. Each carries a caller-owned
//! `operation_id`; `request_id` is accepted as its older name.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ReviewStatusRequest, ReviewStatus>("review.status", Tier::Query),
        OperationSpec::new::<ReviewDiffRequest, ReviewDiff>("review.diff", Tier::Query),
        OperationSpec::new::<ReviewDiffPageRequest, ReviewDiffPage>(
            "review.diff_page",
            Tier::Query,
        ),
        OperationSpec::new::<ReviewHunkRequest, ReviewOperationReply>(
            "review.hunk",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ReviewStageRequest, ReviewOperationReply>(
            "review.stage",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ReviewUnstageRequest, ReviewOperationReply>(
            "review.unstage",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ReviewDiscardRequest, ReviewOperationReply>(
            "review.discard",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ReviewCommitRequest, ReviewOperationReply>(
            "review.commit",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ReviewOperationRequest, ReviewOperationReply>(
            "review.operation",
            Tier::Query,
        ),
        OperationSpec::new::<ReviewOperationListRequest, ReviewOperationList>(
            "review.operation.list",
            Tier::Query,
        ),
        OperationSpec::new::<ReviewOperationAcknowledgeRequest, ReviewOperationAcknowledged>(
            "review.operation.acknowledge",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ReviewFeedbackSearchRequest, ReviewFeedbackSearch>(
            "review.feedback.search",
            Tier::Query,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

fn is_false(value: &bool) -> bool {
    !value
}

/// Keeps an explicit `null` distinct from an absent field: absent is `None`,
/// `null` is `Some(None)`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `review.status`: read Git status for a workspace. Replies within 750 ms of
/// the last read come from a shared cache unless `force` is true.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewStatusRequest {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub force: bool,
}

/// `review.diff`: read one file's whole diff, split into hunks.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewDiffRequest {
    pub workspace_id: String,
    pub path: String,
    /// The staged side; the unstaged side when false or absent.
    #[serde(default)]
    pub staged: bool,
}

/// `review.diff_page`: read one bounded page of a file's diff. A first page
/// omits `cursor`; a continued page sends the previous `next_cursor`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewDiffPageRequest {
    pub workspace_id: String,
    pub path: String,
    pub staged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub cursor: Option<String>,
    /// The token of the first page; a changed diff fails as stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub expected_token: Option<String>,
}

/// `review.hunk`: stage, or with `staged` unstage, one hunk of a reviewed diff.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewHunkRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
    pub path: String,
    #[serde(default)]
    pub staged: bool,
    /// The `review.diff` token the hunk was chosen from.
    pub token: String,
    /// The hunk's index in that diff.
    pub hunk: u64,
}

/// `review.stage`: stage one reviewed file at a status revision.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewStageRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
    pub path: String,
    pub revision: String,
}

/// `review.unstage`: unstage one reviewed file at a status revision.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewUnstageRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
    pub path: String,
    pub revision: String,
}

/// `review.discard`: discard one previewed, tracked, unstaged file change.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewDiscardRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
    pub path: String,
    pub revision: String,
    /// The unstaged diff token the user previewed.
    pub diff_token: String,
}

/// `review.commit`: commit the reviewed staged index.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewCommitRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
    pub message: String,
    /// The status `index_token` the user reviewed.
    pub index_token: String,
}

/// `review.operation`: read a Git mutation's receipt by its operation ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
}

/// `review.operation.list`: the workspace's Git mutations that still need the
/// person: running ones and interrupted ones not yet acknowledged, newest
/// first. `include_acknowledged` adds acknowledged interrupted ones.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationListRequest {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_acknowledged: bool,
}

/// `review.operation.acknowledge`: record that the person saw an interrupted
/// Git mutation. The operation never runs again either way.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationAcknowledgeRequest {
    pub workspace_id: String,
    #[serde(rename = "operation_id", alias = "request_id")]
    pub operation_id: String,
}

/// `review.feedback.search`: find saved review notes by file, note text or both.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewFeedbackSearchRequest {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub query: Option<String>,
    /// The `next_cursor` of the previous page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "i64")]
    pub before: Option<i64>,
    /// Page size from 1 to 50; the daemon uses 20 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

wire_tag!(ReviewStatusTag, "review_status");
wire_tag!(ReviewDiffTag, "review_diff");
wire_tag!(ReviewDiffPageTag, "review_diff_page");
wire_tag!(ReviewOperationTag, "review_operation");
wire_tag!(ReviewOperationListTag, "review_operations");
wire_tag!(
    ReviewOperationAcknowledgedTag,
    "review_operation_acknowledged"
);
wire_tag!(ReviewFeedbackSearchTag, "review_feedback_search");

/// The `review.status` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewStatus {
    #[serde(rename = "type")]
    pub tag: ReviewStatusTag,
    /// The canonical Git worktree root.
    pub root: String,
    /// The branch name, or `(detached)`.
    pub branch: String,
    /// The HEAD commit, or `(initial)` before the first commit.
    pub head: String,
    pub files: Vec<ReviewFile>,
    /// How many files are in conflict.
    pub conflicts: u64,
    /// Identifies HEAD and the index; `review.commit` must send it back.
    pub index_token: String,
    /// Identifies the whole status; file mutations must send it back.
    pub revision: String,
}

/// One changed file in `review.status`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewFile {
    /// The literal repository-relative path.
    pub path: String,
    /// The two-letter porcelain v2 status code.
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflict: bool,
    pub untracked: bool,
    pub submodule: bool,
}

/// The `review.diff` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewDiff {
    #[serde(rename = "type")]
    pub tag: ReviewDiffTag,
    pub path: String,
    pub staged: bool,
    pub token: String,
    pub header: String,
    pub hunks: Vec<String>,
    /// Whether single hunks can be staged; binary, mode, link and
    /// conflicted changes move only as whole files.
    pub hunk_actions: bool,
    pub conflict: bool,
    pub binary: bool,
    pub bytes: u64,
}

/// The `review.diff_page` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewDiffPage {
    #[serde(rename = "type")]
    pub tag: ReviewDiffPageTag,
    pub path: String,
    pub staged: bool,
    pub revision: String,
    pub token: String,
    pub header: String,
    pub rows: Vec<ReviewDiffRow>,
    /// The cursor for the next page; null on the last page.
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub binary: bool,
    pub conflict: bool,
    pub bytes: u64,
}

/// What one diff line is.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDiffRowKind {
    Hunk,
    Context,
    Added,
    Removed,
    Meta,
}

/// One line of a paged diff.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ReviewDiffRow {
    pub kind: ReviewDiffRowKind,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
    /// The line, cut to 8 KiB.
    pub text: String,
    /// The header of the hunk the line belongs to.
    pub hunk: String,
    pub truncated: bool,
}

/// The reply to every Git mutation and to `review.operation`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationReply {
    #[serde(rename = "type")]
    pub tag: ReviewOperationTag,
    pub operation: GitOperation,
}

/// Where a Git mutation stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationStatus {
    Running,
    Succeeded,
    Failed,
    /// The daemon stopped during the Git step; it will not run again.
    Interrupted,
}

/// A Git mutation's receipt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct GitOperation {
    /// The caller's operation ID.
    pub id: String,
    pub status: GitOperationStatus,
    pub started_at: i64,
    /// The operation name, such as `review.stage`.
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    /// The success result: `{head, output}` for a commit, otherwise
    /// `{changed, action, receipt}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Value")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The failure code; present and null on a failure without one.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<Option<String>>,
    /// The recovery hint; present and null on a failure without one.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery: Option<Option<String>>,
    /// Where a discard kept the displaced file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// One listed Git mutation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationEntry {
    pub operation: GitOperation,
    /// When the person acknowledged it; null while unacknowledged.
    pub acknowledged_at: Option<i64>,
}

/// The `review.operation.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationList {
    #[serde(rename = "type")]
    pub tag: ReviewOperationListTag,
    pub operations: Vec<ReviewOperationEntry>,
    /// More matching operations exist than the reply carries.
    pub truncated: bool,
}

/// The `review.operation.acknowledge` reply. A repeat returns the first time.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewOperationAcknowledged {
    #[serde(rename = "type")]
    pub tag: ReviewOperationAcknowledgedTag,
    pub operation: GitOperation,
    pub acknowledged_at: i64,
}

/// The `review.feedback.search` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewFeedbackSearch {
    #[serde(rename = "type")]
    pub tag: ReviewFeedbackSearchTag,
    pub results: Vec<ReviewFeedbackMatch>,
    /// The cursor for the next page; null on the last page.
    pub next_cursor: Option<i64>,
}

/// One message whose review notes match a search.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ReviewFeedbackMatch {
    pub message_id: String,
    pub conversation_id: String,
    /// The matching notes as `ade-review-feedback-v1`.
    #[schemars(with = "Value")]
    pub review_feedback: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
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

    fn assert_valid(name: &str, value: &Value) {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        let validator = jsonschema::validator_for(&schema).unwrap();
        let errors: Vec<_> = validator
            .iter_errors(value)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
    }

    /// A wire request decodes, re-encodes to the same JSON, and the schema
    /// accepts it.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let (name, _) = names(op);
        let mut with_op = wire.clone();
        with_op["op"] = json!(op);
        assert_valid(&name, &with_op);
        let typed: T = serde_json::from_value(with_op).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), wire);
        typed
    }

    fn reply<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        assert_valid(&name, &wire);
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    #[test]
    fn requests_round_trip() {
        let status: ReviewStatusRequest =
            request("review.status", json!({"workspace_id": "w", "force": true}));
        assert!(status.force);
        request::<ReviewDiffRequest>(
            "review.diff",
            json!({"workspace_id": "w", "path": "a b", "staged": false}),
        );
        request::<ReviewDiffPageRequest>(
            "review.diff_page",
            json!({"workspace_id": "w", "path": "a", "staged": true,
                "cursor": "diff_page_1", "expected_token": "0123456789abcdef"}),
        );
        request::<ReviewHunkRequest>(
            "review.hunk",
            json!({"workspace_id": "w", "operation_id": "o", "path": "a",
                "staged": false, "token": "t", "hunk": 2}),
        );
        request::<ReviewStageRequest>(
            "review.stage",
            json!({"workspace_id": "w", "operation_id": "o", "path": "a", "revision": "r"}),
        );
        request::<ReviewUnstageRequest>(
            "review.unstage",
            json!({"workspace_id": "w", "operation_id": "o", "path": "a", "revision": "r"}),
        );
        request::<ReviewDiscardRequest>(
            "review.discard",
            json!({"workspace_id": "w", "operation_id": "o", "path": "a",
                "revision": "r", "diff_token": "d"}),
        );
        request::<ReviewCommitRequest>(
            "review.commit",
            json!({"workspace_id": "w", "operation_id": "o", "message": "m", "index_token": "i"}),
        );
        request::<ReviewOperationRequest>(
            "review.operation",
            json!({"workspace_id": "w", "operation_id": "o"}),
        );
        request::<ReviewOperationListRequest>(
            "review.operation.list",
            json!({"workspace_id": "w"}),
        );
        let all: ReviewOperationListRequest = request(
            "review.operation.list",
            json!({"workspace_id": "w", "include_acknowledged": true}),
        );
        assert!(all.include_acknowledged);
        request::<ReviewOperationAcknowledgeRequest>(
            "review.operation.acknowledge",
            json!({"workspace_id": "w", "operation_id": "o"}),
        );
        request::<ReviewFeedbackSearchRequest>(
            "review.feedback.search",
            json!({"workspace_id": "w", "path": "a", "query": "q", "before": 9, "limit": 20}),
        );
    }

    #[test]
    fn request_id_still_names_the_operation() {
        let stage: ReviewStageRequest = serde_json::from_value(json!({"workspace_id": "w",
            "request_id": "old", "path": "a", "revision": "r"}))
        .unwrap();
        assert_eq!(stage.operation_id, "old");
        assert_eq!(serde_json::to_value(&stage).unwrap()["operation_id"], "old");
        let defaults: ReviewDiffRequest =
            serde_json::from_value(json!({"workspace_id": "w", "path": "a"})).unwrap();
        assert!(!defaults.staged);
    }

    #[test]
    fn replies_round_trip() {
        reply::<ReviewStatus>(
            "review.status",
            json!({"type": "review_status", "root": "/r", "branch": "main", "head": "(initial)",
                "files": [{"path": "[x]\nname", "code": "MM", "staged": true, "unstaged": true,
                    "conflict": false, "untracked": false, "submodule": false}],
                "conflicts": 0, "index_token": "0123456789abcdef", "revision": "fedcba9876543210"}),
        );
        reply::<ReviewDiff>(
            "review.diff",
            json!({"type": "review_diff", "path": "a", "staged": false, "token": "t",
                "header": "diff --git a/a b/a\n", "hunks": ["@@ -1 +1 @@\n-a\n+b\n"],
                "hunk_actions": true, "conflict": false, "binary": false, "bytes": 40}),
        );
        reply::<ReviewDiffPage>(
            "review.diff_page",
            json!({"type": "review_diff_page", "path": "a", "staged": false, "revision": "r",
                "token": "t", "header": "h", "rows": [
                    {"kind": "hunk", "old_line": null, "new_line": null, "text": "@@ -1 +1 @@",
                        "hunk": "@@ -1 +1 @@", "truncated": false},
                    {"kind": "added", "old_line": null, "new_line": 1, "text": "+b",
                        "hunk": "@@ -1 +1 @@", "truncated": false}],
                "next_cursor": null, "complete": true, "binary": false, "conflict": false,
                "bytes": 10}),
        );
        reply::<ReviewOperationReply>(
            "review.stage",
            json!({"type": "review_operation", "operation": {"id": "o", "status": "running",
                "started_at": 1, "op": "review.stage"}}),
        );
        reply::<ReviewOperationReply>(
            "review.operation",
            json!({"type": "review_operation", "operation": {"id": "o", "status": "failed",
                "started_at": 1, "op": "review.discard", "finished_at": 2, "error": "No",
                "code": null, "recovery": null, "backup_path": "/g/ade-discard-v1/k/a"}}),
        );
        reply::<ReviewOperationReply>(
            "review.commit",
            json!({"type": "review_operation", "operation": {"id": "o", "status": "succeeded",
                "started_at": 1, "op": "review.commit", "finished_at": 2,
                "result": {"head": "abc", "output": "[main abc] m\n"}}}),
        );
        reply::<ReviewOperationList>(
            "review.operation.list",
            json!({"type": "review_operations", "operations": [
                {"operation": {"id": "o", "status": "interrupted", "started_at": 1,
                    "op": "review.commit", "error": "Interrupted"}, "acknowledged_at": null},
                {"operation": {"id": "p", "status": "running", "started_at": 2,
                    "op": "review.stage"}, "acknowledged_at": 3}],
                "truncated": false}),
        );
        reply::<ReviewOperationAcknowledged>(
            "review.operation.acknowledge",
            json!({"type": "review_operation_acknowledged", "operation": {"id": "o",
                "status": "interrupted", "started_at": 1, "op": "review.commit",
                "error": "Interrupted"}, "acknowledged_at": 5}),
        );
        reply::<ReviewFeedbackSearch>(
            "review.feedback.search",
            json!({"type": "review_feedback_search", "results": [{"message_id": "m",
                "conversation_id": "c", "review_feedback": {"format": "ade-review-feedback-v1",
                    "workspace_id": "w", "notes": []}}], "next_cursor": 7}),
        );
    }

    #[test]
    fn mutations_are_effect_commands_and_reads_are_queries() {
        for spec in operations() {
            let effect = matches!(
                spec.name,
                "review.hunk"
                    | "review.stage"
                    | "review.unstage"
                    | "review.discard"
                    | "review.commit"
            );
            assert_eq!(spec.tier == Tier::EffectCommand, effect, "{}", spec.name);
            let acknowledge = spec.name == "review.operation.acknowledge";
            assert_eq!(
                spec.tier == Tier::IdempotentCommand,
                acknowledge,
                "{}",
                spec.name
            );
        }
    }
}
