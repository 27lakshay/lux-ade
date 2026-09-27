//! Retention and cleanup contracts (F138, decision D15).
//!
//! Cleanup is a preview-and-apply pair. `retention.preview` lists every item
//! the configured retention would remove and names it with a `generation`.
//! `retention.policy.set` configures the service log and diagnostic log limits
//! under a revision guard; a changed policy changes every generation, so a
//! preview made under the old policy cannot apply.
//! `retention.apply` takes that generation, recomputes the candidates, and
//! removes them only when the recomputed set still has the same generation, so
//! it never removes an item the caller did not see. Referenced data, in-flight
//! uploads, live terminals and service logs a service still owns are never
//! candidates. Effect receipts past the 30-day rule are pruned on a daemon
//! schedule instead; the preview reports that schedule's last result.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<RetentionPreviewRequest, RetentionPreview>(
            "retention.preview",
            Tier::Query,
        ),
        // Removes only the previewed set; a completed generation replays its
        // stored result, so a repeat converges instead of removing more.
        OperationSpec::new::<RetentionApplyRequest, RetentionApply>(
            "retention.apply",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<RetentionPolicyGetRequest, RetentionPolicyReply>(
            "retention.policy.get",
            Tier::Query,
        ),
        // Guarded by the revision the caller saw; a retry of an applied change
        // converges on the stored policy instead of applying twice.
        OperationSpec::new::<RetentionPolicySetRequest, RetentionPolicyReply>(
            "retention.policy.set",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `retention.preview`: list what retention would remove now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RetentionPreviewRequest {}

/// `retention.apply`: remove exactly the set a preview listed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RetentionApplyRequest {
    /// The preview's `generation`. A changed candidate set is refused.
    pub generation: String,
}

/// `retention.policy.get`: the policy retention applies now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RetentionPolicyGetRequest {}

/// `retention.policy.set`: configure the limits a user may change. An absent
/// field returns that limit to its default. Each limit is 1 to 365 days.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RetentionPolicySetRequest {
    /// The policy `revision` the caller saw; a newer stored policy is refused.
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_log_idle_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_log_max_age_ms: Option<i64>,
}

/// The configured limits, as stored; null means the default applies.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RetentionConfigured {
    pub service_log_idle_ms: Option<i64>,
    pub diagnostic_log_max_age_ms: Option<i64>,
}

/// The `retention.policy.get` and `retention.policy.set` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RetentionPolicyReply {
    #[serde(rename = "type")]
    pub tag: RetentionPolicyTag,
    /// The effective policy; its `revision` guards the next change.
    pub policy: RetentionPolicy,
    pub configured: RetentionConfigured,
    /// False when a set found the policy already as requested.
    pub changed: bool,
}

wire_tag!(RetentionPreviewTag, "retention_preview");
wire_tag!(RetentionPolicyTag, "retention_policy");
wire_tag!(RetentionApplyTag, "retention_apply");

/// What a retention candidate is.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum RetentionKind {
    /// An uploaded attachment nothing references, past the in-flight grace period.
    Attachment,
    /// Skill bundle files no installed skill references.
    SkillBlob,
    /// Durable service or script output whose terminal no workspace, service
    /// or runtime terminal still owns.
    ServiceLog,
    /// A rotated diagnostic log file past its age limit.
    DiagnosticLog,
}

/// The limits this daemon applies.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionPolicy {
    /// Effect receipts older than this lose their body and keep an expired marker.
    pub receipt_retention_ms: i64,
    /// How often the daemon prunes receipts.
    pub receipt_prune_interval_ms: i64,
    /// An unreferenced attachment younger than this may be an in-flight upload.
    pub attachment_grace_ms: i64,
    /// A service log must be idle this long before it can go.
    pub service_log_idle_ms: i64,
    /// Rotated diagnostic logs older than this can go; the newest file of each
    /// process is always kept.
    pub diagnostic_log_max_age_ms: i64,
    /// Most candidates one preview lists.
    pub candidate_limit: u64,
    /// The configuration revision; 0 until `retention.policy.set` first changes it.
    #[serde(default)]
    pub revision: u64,
}

/// One item the preview would remove.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionCandidate {
    pub kind: RetentionKind,
    /// The attachment ID, skill content hash, service log key or log file name.
    pub id: String,
    /// The owning Conversation for an attachment; otherwise null.
    pub scope: Option<String>,
    /// Estimated bytes freed. Attachment and skill bytes free space inside the
    /// profile database, which the file keeps until SQLite reuses it.
    pub bytes: u64,
    /// When the item last changed, in Unix milliseconds, when known.
    pub last_activity_at: Option<i64>,
    /// Why retention selected it.
    pub reason: String,
}

/// A category the preview did not evaluate, and why. Nothing of that kind
/// is a candidate until the reason clears.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionWithheld {
    pub kind: RetentionKind,
    pub reason: String,
}

/// One store's receipt pruning state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionReceiptStore {
    /// `sessions`, `lifecycle`, `review` or `plugins`.
    pub store: String,
    /// Receipts past retention that still hold a body; null when unreadable.
    pub past_retention: Option<u64>,
    /// When the schedule last pruned this store, in Unix milliseconds.
    pub last_pruned_at: Option<i64>,
    /// Receipts the last prune expired.
    pub last_expired: Option<u64>,
    /// Why the last scheduled prune failed; null after a success.
    pub last_error: Option<String>,
}

/// A log the daemon observes but does not remove, with its size.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionObservedLog {
    pub name: String,
    /// Null when the file is absent or unreadable.
    pub bytes: Option<u64>,
    pub note: String,
}

/// The `retention.preview` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionPreview {
    #[serde(rename = "type")]
    pub tag: RetentionPreviewTag,
    /// Names this exact candidate set for `retention.apply`.
    pub generation: String,
    pub generated_at: i64,
    pub policy: RetentionPolicy,
    /// Sorted by kind, then ID.
    pub candidates: Vec<RetentionCandidate>,
    /// Whether more items were eligible than `candidate_limit`; apply again
    /// after a new preview to reach them.
    pub truncated: bool,
    pub reclaimable_bytes: u64,
    pub withheld: Vec<RetentionWithheld>,
    pub receipts: Vec<RetentionReceiptStore>,
    pub observed_logs: Vec<RetentionObservedLog>,
}

/// What happened to one previewed item.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetentionOutcome {
    /// Removed, and its absence was checked.
    Removed,
    /// Not removed; `error` says why. Preview again to retry.
    Failed,
}

/// One item's result.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionItemResult {
    pub kind: RetentionKind,
    pub id: String,
    pub outcome: RetentionOutcome,
    /// Bytes freed; zero unless removed.
    pub bytes: u64,
    pub error: Option<String>,
}

/// The `retention.apply` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RetentionApply {
    #[serde(rename = "type")]
    pub tag: RetentionApplyTag,
    pub generation: String,
    /// True when this reply is the stored result of an earlier apply.
    pub replayed: bool,
    /// True only when every previewed item was removed.
    pub complete: bool,
    pub results: Vec<RetentionItemResult>,
    pub removed_bytes: u64,
    pub applied_at: i64,
}

#[cfg(test)]
mod tests {
    //! Schema round trips for the retention pair.
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

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

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<RetentionPreviewRequest>("retention.preview", json!({"op": "retention.preview"}));
        request::<RetentionApplyRequest>(
            "retention.apply",
            json!({"op": "retention.apply", "generation": "abc"}),
        );
        let (name, _) = names("retention.apply");
        assert!(!valid(&name, &json!({"op": "retention.apply"})));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<RetentionPreview>(
            "retention.preview",
            json!({"type": "retention_preview", "generation": "g", "generated_at": 5,
                "policy": {"receipt_retention_ms": 1, "receipt_prune_interval_ms": 2,
                    "attachment_grace_ms": 3, "service_log_idle_ms": 4,
                    "diagnostic_log_max_age_ms": 5, "candidate_limit": 500, "revision": 0},
                "candidates": [{"kind": "attachment", "id": "a", "scope": "c", "bytes": 10,
                    "last_activity_at": 1, "reason": "unreferenced"}],
                "truncated": false, "reclaimable_bytes": 10,
                "withheld": [{"kind": "service_log", "reason": "runtime unavailable"}],
                "receipts": [{"store": "sessions", "past_retention": 0, "last_pruned_at": null,
                    "last_expired": null, "last_error": null}],
                "observed_logs": [{"name": "daemon.log", "bytes": null, "note": "n"}]}),
        );
        response::<RetentionApply>(
            "retention.apply",
            json!({"type": "retention_apply", "generation": "g", "replayed": false,
                "complete": false, "removed_bytes": 0, "applied_at": 9,
                "results": [{"kind": "diagnostic_log", "id": "x.jsonl", "outcome": "failed",
                    "bytes": 0, "error": "changed"}]}),
        );
    }
}
