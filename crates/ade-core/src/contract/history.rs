//! Combined history and work search contracts (F041, F043).
//!
//! Search reads an asynchronous full-text projection of conversation messages
//! and their review feedback. Every reply states how far that projection lags
//! the durable history, so a client never presents partial results as complete.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<HistorySearchRequest, HistorySearch>("history.search", Tier::Query),
        OperationSpec::new::<HistoryListRequest, HistoryList>("history.list", Tier::Query),
        OperationSpec::new::<HistoryIndexStatusRequest, HistoryIndexReply>(
            "history.index.status",
            Tier::Query,
        ),
        OperationSpec::new::<HistoryIndexRebuildRequest, HistoryIndexReply>(
            "history.index.rebuild",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `history.search`: one page of indexed messages that contain every query term,
/// newest indexed first, across every conversation and provider in the profile.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistorySearchRequest {
    /// 1 to 256 bytes. Whitespace separates terms; every term must match. A
    /// trailing `*` makes a term a prefix. Query operators are matched literally.
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// A provider ID such as `codex` or `claude`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// The `next_cursor` of the previous page for the same query and filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, 1 to 50; the daemon uses 20 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `history.list`: one page of conversations across providers, most recently
/// updated first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The `next_cursor` of the previous page for the same filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, 1 to 100; the daemon uses 50 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `history.index.status`: how far the search index lags durable history.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryIndexStatusRequest {}

/// `history.index.rebuild`: discard the search index and rebuild it from
/// durable history. It applies only while the index is still at
/// `expected_epoch`, so a repeated request does not restart a rebuild.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryIndexRebuildRequest {
    /// The `epoch` from the status the caller last saw.
    pub expected_epoch: u64,
}

wire_tag!(HistorySearchTag, "history_search");
wire_tag!(HistoryListTag, "history_list");
wire_tag!(HistoryIndexTag, "history_index");

/// The state of the search index when a reply was read.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct HistoryIndexStatus {
    /// Increases on every rebuild. Search cursors from another epoch expire.
    pub epoch: u64,
    /// True while the index is being rebuilt from durable history; search
    /// results cover only the messages indexed so far.
    pub rebuilding: bool,
    /// Recorded message changes the index has not applied yet.
    pub pending_changes: u64,
    /// True when the index reflected every committed message change at read time.
    pub caught_up: bool,
    /// Set after the last index update failed. The indexer retries on its own.
    pub last_error: Option<String>,
}

/// Where a history item came from. ADE never implies that one provider's
/// session continues another's.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryProvenance {
    pub conversation_id: String,
    pub conversation_title: String,
    pub provider: String,
    pub workspace_id: String,
    pub account_id: Option<String>,
    /// The provider's own session or thread ID, when the provider assigned one.
    pub native_session_id: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub conversation_updated_at: i64,
}

/// One message that matched a search.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryMatch {
    pub message_id: String,
    pub role: String,
    pub kind: String,
    /// The message's position in its conversation.
    pub sequence: i64,
    /// A short excerpt of the current message text, or of its review feedback
    /// when only the feedback matched.
    pub excerpt: String,
    pub has_review_feedback: bool,
    /// When the daemon first recorded this message, in milliseconds since the
    /// Unix epoch. Null for messages written before the index existed.
    pub observed_at: Option<i64>,
    pub provenance: HistoryProvenance,
}

/// The `history.search` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistorySearch {
    #[serde(rename = "type")]
    pub tag: HistorySearchTag,
    pub results: Vec<HistoryMatch>,
    /// Null when no more indexed matches remain.
    pub next_cursor: Option<String>,
    pub index: HistoryIndexStatus,
}

/// One conversation in the combined history.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryConversation {
    pub status: String,
    pub message_count: u64,
    pub provenance: HistoryProvenance,
}

/// The `history.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryList {
    #[serde(rename = "type")]
    pub tag: HistoryListTag,
    pub conversations: Vec<HistoryConversation>,
    /// Null when the listing has finished. A conversation updated while the
    /// caller pages may move ahead of the cursor; list again to see it.
    pub next_cursor: Option<String>,
}

/// The `history.index.status` and `history.index.rebuild` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryIndexReply {
    #[serde(rename = "type")]
    pub tag: HistoryIndexTag,
    pub index: HistoryIndexStatus,
}

#[cfg(test)]
mod tests {
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

    fn status() -> Value {
        json!({"epoch": 2, "rebuilding": false, "pending_changes": 3, "caught_up": false,
            "last_error": null})
    }

    fn provenance() -> Value {
        json!({"conversation_id": "c", "conversation_title": "Fix build", "provider": "codex",
            "workspace_id": "w", "account_id": null, "native_session_id": "thread-1",
            "conversation_updated_at": 1_700_000_000_000_i64})
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<HistorySearchRequest>(
            "history.search",
            json!({"op": "history.search", "query": "flaky test*"}),
        );
        request::<HistorySearchRequest>(
            "history.search",
            json!({"op": "history.search", "query": "x", "workspace_id": "w", "provider": "claude",
                "conversation_id": "c", "cursor": "2.40", "limit": 5}),
        );
        request::<HistoryListRequest>("history.list", json!({"op": "history.list"}));
        request::<HistoryListRequest>(
            "history.list",
            json!({"op": "history.list", "provider": "codex", "cursor": "abc", "limit": 100}),
        );
        request::<HistoryIndexStatusRequest>(
            "history.index.status",
            json!({"op": "history.index.status"}),
        );
        request::<HistoryIndexRebuildRequest>(
            "history.index.rebuild",
            json!({"op": "history.index.rebuild", "expected_epoch": 1}),
        );
        let (name, _) = names("history.search");
        assert!(!valid(&name, &json!({"op": "history.search"})));
        let (name, _) = names("history.index.rebuild");
        assert!(!valid(&name, &json!({"op": "history.index.rebuild"})));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<HistorySearch>(
            "history.search",
            json!({"type": "history_search", "results": [{
                "message_id": "m", "role": "assistant", "kind": "message", "sequence": 4,
                "excerpt": "…the flaky test…", "has_review_feedback": false,
                "observed_at": null, "provenance": provenance(),
            }], "next_cursor": "2.40", "index": status()}),
        );
        response::<HistoryList>(
            "history.list",
            json!({"type": "history_list", "conversations": [{
                "status": "ready", "message_count": 7, "provenance": provenance(),
            }], "next_cursor": null}),
        );
        response::<HistoryIndexReply>(
            "history.index.status",
            json!({"type": "history_index", "index": status()}),
        );
    }
}
