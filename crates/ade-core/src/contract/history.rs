//! Combined history, work search and external session import contracts
//! (F041, F042, F043).
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
        OperationSpec::new::<HistoryImportScanRequest, HistoryImportScan>(
            "history.import.scan",
            Tier::Query,
        ),
        OperationSpec::new::<HistoryImportRequest, HistoryImported>(
            "history.import.session",
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
wire_tag!(HistoryImportScanTag, "history_import_scan");
wire_tag!(HistoryImportedTag, "history_imported");

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
    /// Present when the conversation is a read-only import of a native
    /// session rather than one ADE ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<HistoryImportSource>,
}

/// One message that matched a search.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryMatch {
    pub message_id: String,
    pub role: String,
    pub kind: String,
    /// The message's position in its conversation.
    pub sequence: i64,
    /// The conversation's `history_epoch` when this match was read. A rewind
    /// reuses sequence numbers, so pass it with `before` to `conversation.get`
    /// when opening the match: a late match is then refused, not shown at a
    /// position that now holds another message.
    pub history_epoch: u64,
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

/// A provider whose native on-disk sessions ADE can import.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryImportProvider {
    /// Claude Code transcripts under `<config dir>/projects`.
    Claude,
    /// Codex rollouts under `<CODEX_HOME>/sessions` and `archived_sessions`.
    Codex,
}

impl HistoryImportProvider {
    /// The ADE provider ID the imported conversation records.
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// `history.import.scan`: the native sessions one provider store holds, newest
/// first. It reads the store and changes nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportScanRequest {
    pub provider: HistoryImportProvider,
    /// Scan this ADE account's native home. Absent scans the daemon user's
    /// default store (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or
    /// `~/.codex`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Keep only sessions whose recorded working directory is this
    /// workspace's root or lies inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// 1 to 200; the daemon uses 50 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `history.import.session`: import one native session as a read-only
/// conversation. Keyed by provider and native session ID: repeating it
/// returns the same conversation, adds only records appended since, and
/// refuses when the native history no longer extends what was imported.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportRequest {
    pub provider: HistoryImportProvider,
    /// The provider's own session UUID, as `history.import.scan` reports it.
    pub native_session_id: String,
    /// The workspace the imported conversation belongs to. A repeat must name
    /// the same workspace.
    pub workspace_id: String,
    /// Read from this ADE account's native home instead of the default store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// The native store a scan read.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportStore {
    pub provider: HistoryImportProvider,
    pub account_id: Option<String>,
    /// The directory scanned.
    pub root: String,
    /// False when the store could not be read; `unavailable_reason` says why.
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

/// One native session found by a scan. Metadata comes from the start of the
/// file; importing reads all of it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportCandidate {
    pub native_session_id: String,
    /// The working directory the native session recorded, when it did.
    pub cwd: Option<String>,
    /// A native title or the first user prompt, when one was found.
    pub title: Option<String>,
    /// When the file last changed, in milliseconds since the Unix epoch.
    pub modified_at: i64,
    pub size_bytes: u64,
    pub source_path: String,
    /// The conversation an earlier import created, when there is one.
    pub imported_conversation_id: Option<String>,
}

/// The `history.import.scan` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportScan {
    #[serde(rename = "type")]
    pub tag: HistoryImportScanTag,
    pub store: HistoryImportStore,
    pub sessions: Vec<HistoryImportCandidate>,
    /// True when more matching sessions exist than `limit` allowed.
    pub more: bool,
    /// Session files whose metadata could not be read; they are not listed.
    pub unreadable: u64,
}

/// Where an imported conversation came from, and what ADE can do with it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImportSource {
    /// The native file the history was read from.
    pub source_path: String,
    /// The working directory the native session recorded.
    pub native_cwd: Option<String>,
    /// The ADE account whose native home held the session.
    pub account_id: Option<String>,
    /// The last import, in milliseconds since the Unix epoch.
    pub imported_at: i64,
    /// False while ADE cannot continue this native session. Sending to an
    /// imported conversation is refused, never silently started fresh.
    pub resumable: bool,
    pub resume_unavailable_reason: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryImportOutcome {
    /// A new read-only conversation was created.
    Imported,
    /// Records the native session gained since the last import were added.
    Appended,
    /// The conversation already held every record.
    Unchanged,
}

/// The `history.import.session` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HistoryImported {
    #[serde(rename = "type")]
    pub tag: HistoryImportedTag,
    pub outcome: HistoryImportOutcome,
    pub conversation: HistoryConversation,
    pub added_messages: u64,
    /// Earlier imported messages whose native record gained detail since,
    /// such as a tool result written after its call.
    pub updated_messages: u64,
    /// Native records that could not be parsed and were left out. Records
    /// ADE does not model, such as private reasoning, are not counted.
    pub skipped_records: u64,
    /// True when the file ended in a partly written record, which a later
    /// import picks up once the provider finishes it.
    pub incomplete_tail: bool,
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
        request::<HistoryImportScanRequest>(
            "history.import.scan",
            json!({"op": "history.import.scan", "provider": "claude", "workspace_id": "w",
                "limit": 10}),
        );
        request::<HistoryImportRequest>(
            "history.import.session",
            json!({"op": "history.import.session", "provider": "codex",
                "native_session_id": "01a076ee-e1bb-71a1-9a20-d12ac6dc30ea", "workspace_id": "w",
                "account_id": "account_1"}),
        );
        let (name, _) = names("history.import.scan");
        assert!(!valid(
            &name,
            &json!({"op": "history.import.scan", "provider": "omp"})
        ));
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
                "message_id": "m", "role": "assistant", "kind": "message", "sequence": 4, "history_epoch": 1,
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
        let mut imported = provenance();
        imported["import"] = json!({"source_path": "/h/.codex/sessions/r.jsonl",
            "native_cwd": "/repo", "account_id": null, "imported_at": 1_700_000_000_001_i64,
            "resumable": false, "resume_unavailable_reason": "read-only"});
        response::<HistoryImported>(
            "history.import.session",
            json!({"type": "history_imported", "outcome": "appended", "conversation": {
                "status": "imported", "message_count": 9, "provenance": imported,
            }, "added_messages": 2, "updated_messages": 1, "skipped_records": 0, "incomplete_tail": true}),
        );
        response::<HistoryImportScan>(
            "history.import.scan",
            json!({"type": "history_import_scan", "store": {"provider": "claude",
                "account_id": null, "root": "/h/.claude/projects", "available": true,
                "unavailable_reason": null}, "sessions": [{"native_session_id": "s",
                "cwd": null, "title": "Fix", "modified_at": 1, "size_bytes": 10,
                "source_path": "/h/.claude/projects/p/s.jsonl",
                "imported_conversation_id": null}], "more": false, "unreadable": 0}),
        );
    }
}
