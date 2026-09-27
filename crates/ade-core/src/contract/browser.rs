//! Browser diagnostics and recording contracts (F096, F097, decision D11),
//! browser partitions (F092), browser import (F093, decision D10) and design
//! context capture (F094).
//!
//! The daemon relays these operations to the registered browser owner (the
//! desktop main process) like the other `browser.*` reads. Each one names an
//! exact tab or recording; the owner never substitutes the focused or selected
//! tab, and the daemon refuses a reply that names a different target.
//!
//! Diagnostics are bounded and redacted in the owner: no headers, cookies or
//! bodies are captured, credential-like URL parameters and text are replaced,
//! and every reply states what it excludes.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<BrowserDiagnosticsAttachRequest, BrowserDiagnosticsState>(
            "browser.diagnostics.attach",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserDiagnosticsDetachRequest, BrowserDiagnosticsState>(
            "browser.diagnostics.detach",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserDiagnosticsReadRequest, BrowserDiagnostics>(
            "browser.diagnostics.read",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserRecordingStartRequest, BrowserRecording>(
            "browser.recording.start",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserRecordingStopRequest, BrowserRecording>(
            "browser.recording.stop",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserRecordingGetRequest, BrowserRecording>(
            "browser.recording.get",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserPartitionListRequest, BrowserPartitions>(
            "browser.partition.list",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserPartitionCreateRequest, BrowserPartitionReply>(
            "browser.partition.create",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserImportPreviewRequest, BrowserImportPreview>(
            "browser.import.preview",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserImportRunRequest, BrowserImport>(
            "browser.import.run",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<BrowserImportGetRequest, BrowserImport>(
            "browser.import.get",
            Tier::Query,
        ),
        OperationSpec::new::<BrowserContextCaptureRequest, BrowserContextCapture>(
            "browser.context.capture",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `browser.diagnostics.attach`: start capturing console and network
/// summaries for one exact tab. Attaching an attached tab changes nothing.
/// A tab without a live page, or whose debugger another client holds, fails.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnosticsAttachRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
}

/// `browser.diagnostics.detach`: stop the caller's capture on one exact tab.
/// The captured entries stay readable until the tab closes. Detaching a
/// detached tab changes nothing; an active recording keeps its own capture.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnosticsDetachRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
}

/// `browser.diagnostics.read`: one page of captured entries for one exact tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnosticsReadRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    /// Return entries whose `seq` is greater than this; the previous page's
    /// `next`. From the oldest retained entry when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub after: Option<u64>,
    /// 1 to 200 entries across both kinds; 100 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// What a recording captures.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCaptureKind {
    /// Periodic PNG stills of the tab's page.
    Screenshots,
    /// The page's navigations, titles, load failures, crashes and close.
    PageEvents,
    /// Redacted console messages and exceptions.
    Console,
    /// Redacted network request summaries.
    Network,
}

/// `browser.recording.start`: record one exact tab into a local artifact.
/// `recording_id` is caller-owned. Repeating a start with the same ID and
/// the same target and scope returns that recording in its current state and
/// never starts it again; the same ID with another target or scope conflicts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserRecordingStartRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    /// 1 to 128 ASCII letters, digits, `-` or `_`.
    pub recording_id: String,
    /// One or more distinct kinds.
    pub capture: Vec<BrowserCaptureKind>,
    /// Milliseconds between screenshots, 250 to 60000; 2000 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub interval_ms: Option<u64>,
    /// The recording window, 1000 to 1800000 milliseconds; 300000 when absent.
    /// The recording stops by itself when it ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub max_duration_ms: Option<u64>,
}

/// `browser.recording.stop`: end a recording and seal its manifest. Stopping a
/// stopped or interrupted recording returns it unchanged.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserRecordingStopRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub recording_id: String,
}

/// `browser.recording.get`: read a recording's manifest.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserRecordingGetRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub recording_id: String,
}

wire_tag!(BrowserDiagnosticsStateTag, "browser_diagnostics_state");
wire_tag!(BrowserDiagnosticsTag, "browser_diagnostics");
wire_tag!(BrowserRecordingTag, "browser_recording");

/// Whether the owner's debugger capture holds the tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAttachmentState {
    Attached,
    /// Never attached, detached by request, or detached by the page or
    /// DevTools; `reason` says which.
    Detached,
}

/// The debugger capture of one tab.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserAttachment {
    pub state: BrowserAttachmentState,
    /// Why capture is detached: `not_attached`, `requested`, `target_closed`,
    /// `target_replaced`, or the debugger's own detach reason.
    pub reason: Option<String>,
    /// Wall-clock milliseconds when capture last attached.
    pub attached_at_ms: Option<i64>,
    /// Who holds capture: `caller` and one entry per active recording ID.
    pub holders: Vec<String>,
}

/// The `browser.diagnostics.attach` and `browser.diagnostics.detach` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnosticsState {
    #[serde(rename = "type")]
    pub tag: BrowserDiagnosticsStateTag,
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    pub attachment: BrowserAttachment,
}

/// One console message, exception or browser log entry, redacted and cut to
/// 1024 characters.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserConsoleEntry {
    /// Shared with network entries; increases for the owner's lifetime.
    pub seq: u64,
    pub at_ms: i64,
    /// `console`, `exception` or `browser`.
    pub source: String,
    /// The console method or log level, such as `log`, `warning` or `error`.
    pub level: String,
    pub text: String,
    /// The redacted script or page URL, when the page reported one.
    pub url: Option<String>,
    pub line: Option<u64>,
}

/// How a network request ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserNetworkOutcome {
    Completed,
    Failed,
    Canceled,
    Blocked,
    /// Capture ended, or the in-flight table was full, before the request did.
    Incomplete,
}

/// One network request summary. It never carries headers, cookies or bodies.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserNetworkEntry {
    pub seq: u64,
    pub at_ms: i64,
    pub method: String,
    /// Without user information or fragment, credential-like query values
    /// replaced, cut to 1024 characters.
    pub url: String,
    pub resource_type: Option<String>,
    pub status: Option<u64>,
    pub mime_type: Option<String>,
    pub encoded_bytes: Option<u64>,
    pub duration_ms: Option<u64>,
    pub outcome: BrowserNetworkOutcome,
    pub error: Option<String>,
}

/// Entries the owner discarded to stay within its bounds.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnosticsDropped {
    pub console: u64,
    pub network: u64,
}

/// The `browser.diagnostics.read` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserDiagnostics {
    #[serde(rename = "type")]
    pub tag: BrowserDiagnosticsTag,
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    pub attachment: BrowserAttachment,
    pub console: Vec<BrowserConsoleEntry>,
    pub network: Vec<BrowserNetworkEntry>,
    /// Pass as `after` to read the next page.
    pub next: u64,
    /// True when more entries follow this page.
    pub more: bool,
    /// Requests seen but not yet finished; they appear once they end.
    pub in_flight: u64,
    pub dropped: BrowserDiagnosticsDropped,
    /// The redaction policy, such as `ade-browser-redaction-v1`.
    pub redaction: String,
    /// What capture never includes.
    pub excluded: Vec<String>,
}

/// Where a recording stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserRecordingState {
    Recording,
    Stopped,
    /// The owner that ran it ended before sealing it. It is never resumed;
    /// the files on disk are what it captured.
    Interrupted,
}

/// The `browser.recording.*` reply: the recording's manifest.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserRecording {
    #[serde(rename = "type")]
    pub tag: BrowserRecordingTag,
    pub profile_id: String,
    pub owner_id: String,
    pub recording_id: String,
    pub tab_id: String,
    /// `ade-browser-recording-v1`.
    pub format: String,
    pub state: BrowserRecordingState,
    pub capture: Vec<BrowserCaptureKind>,
    pub interval_ms: u64,
    pub max_duration_ms: u64,
    pub started_at_ms: i64,
    pub stopped_at_ms: Option<i64>,
    /// `requested`, `duration_reached`, `frame_limit`, `size_limit`,
    /// `target_closed`, `write_failed` or `owner_stopped`.
    pub stop_reason: Option<String>,
    /// The local artifact directory. Nothing is published.
    pub artifact_dir: String,
    pub frames: u64,
    /// Screenshot ticks that produced no image, such as a hidden page.
    pub frames_unavailable: u64,
    pub page_events: u64,
    pub console_entries: u64,
    pub network_entries: u64,
    pub bytes: u64,
    /// What this recording does not cover, in plain words.
    pub coverage_gaps: Vec<String>,
}

// ---------------------------------------------------------------------------
// Browser partitions (F092)
// ---------------------------------------------------------------------------

/// `browser.partition.list`: the profile's browser partitions. A partition is
/// a named browser profile inside an ADE profile, with its own cookies,
/// storage and cache. `default` always exists: it is the storage every tab
/// used before partitions, and it cannot be created or renamed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct BrowserPartitionListRequest {
    /// Defaults to this daemon's profile; any other profile is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// `browser.partition.create`: register a named partition. `partition_id` is
/// caller-owned: repeating a create with the same ID and name returns the
/// partition unchanged, and the same ID with another name conflicts. The
/// browser owner creates its storage when a tab first opens in it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserPartitionCreateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// 1 to 64 lowercase ASCII letters, digits, `-` or `_`, starting with a
    /// letter or digit. `default` is reserved.
    pub partition_id: String,
    /// 1 to 64 characters without control characters.
    pub name: String,
}

wire_tag!(BrowserPartitionsTag, "browser_partitions");
wire_tag!(BrowserPartitionTag, "browser_partition");

/// One browser partition.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct BrowserPartition {
    pub partition_id: String,
    pub name: String,
    /// Wall-clock milliseconds; `null` for `default`.
    pub created_at_ms: Option<i64>,
}

/// The `browser.partition.list` reply, `default` first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserPartitions {
    #[serde(rename = "type")]
    pub tag: BrowserPartitionsTag,
    pub profile_id: String,
    pub partitions: Vec<BrowserPartition>,
    /// The most named partitions a profile holds.
    pub limit: u64,
}

/// The `browser.partition.create` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserPartitionReply {
    #[serde(rename = "type")]
    pub tag: BrowserPartitionTag,
    pub profile_id: String,
    pub partition: BrowserPartition,
    /// False when the partition already existed with this name.
    pub created: bool,
}

// ---------------------------------------------------------------------------
// Browser import (F093, decision D10)
// ---------------------------------------------------------------------------

/// A browser ADE can import from, on macOS only.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BrowserImportSource {
    /// Google Chrome: `Bookmarks` (JSON, format version 1) and `History`
    /// (SQLite, schema versions 40 to 99) in one profile directory.
    Chrome,
    /// Safari's default profile: `Bookmarks.plist` (binary property list,
    /// file version 1) and `History.db` (SQLite). Reading them needs Full
    /// Disk Access for ADE.
    Safari,
}

/// A data class ADE imports. Every other class is refused, and the preview
/// lists each one with its reason.
#[derive(
    Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum BrowserImportClass {
    /// HTTP(S) bookmarks with their folder path. Other URL schemes are skipped.
    Bookmarks,
    /// The most recently visited HTTP(S) URLs, at most 50000, with title,
    /// visit count and last visit time. Individual visits are not imported.
    History,
}

/// `browser.import.preview`: what an import from one source would read. It
/// stores nothing in ADE and never writes the source.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportPreviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub source: BrowserImportSource,
    /// Chrome only: `Default` or `Profile N`; `Default` when absent. Safari
    /// takes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile: Option<String>,
}

/// `browser.import.run`: import the named classes into a partition's library.
/// `import_id` is caller-owned. The import is one transaction: every requested
/// class is read and stored, or nothing is. Repeating it with the same ID and
/// request returns the stored import without reading the source again; the
/// same ID with another request conflicts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportRunRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// 1 to 128 ASCII letters, digits, `-` or `_`.
    pub import_id: String,
    /// `default` or a registered partition.
    pub partition_id: String,
    pub source: BrowserImportSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile: Option<String>,
    /// One or more distinct classes.
    pub classes: Vec<BrowserImportClass>,
}

/// `browser.import.get`: read a stored import by its ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportGetRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub import_id: String,
}

wire_tag!(BrowserImportPreviewTag, "browser_import_preview");
wire_tag!(BrowserImportTag, "browser_import");

/// Whether a class can be read from the source now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserImportAvailability {
    /// The source file exists, has a supported format and was read.
    Ready,
    /// The source file does not exist.
    Missing,
    /// macOS refused access, as it does for Safari without Full Disk Access.
    PermissionDenied,
    /// The file exists but its format or version is not supported, or it is
    /// damaged or too large. `reason` says which.
    Unsupported,
}

/// One class as the source holds it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportClassPreview {
    pub class: BrowserImportClass,
    pub availability: BrowserImportAvailability,
    /// The file this class reads.
    pub path: String,
    /// The detected format, such as `chrome-bookmarks-json-1` or
    /// `chrome-history-sqlite-68`.
    pub format: Option<String>,
    /// Entries that would be imported.
    pub importable: u64,
    /// Entries skipped: non-HTTP(S) or over-long URLs.
    pub skipped: u64,
    /// Entries beyond the import bound that would be left out.
    pub truncated: u64,
    pub reason: Option<String>,
}

/// A class ADE never imports from this source, and why.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportRefusal {
    /// Such as `cookies`, `passwords` or `open_tabs`.
    pub class: String,
    pub reason: String,
}

/// The `browser.import.preview` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportPreview {
    #[serde(rename = "type")]
    pub tag: BrowserImportPreviewTag,
    pub profile_id: String,
    pub source: BrowserImportSource,
    pub source_profile: Option<String>,
    pub classes: Vec<BrowserImportClassPreview>,
    pub refused: Vec<BrowserImportRefusal>,
}

/// One imported class.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImportedClass {
    pub class: BrowserImportClass,
    pub format: String,
    pub imported: u64,
    pub skipped: u64,
    pub truncated: u64,
}

/// The `browser.import.run` and `browser.import.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserImport {
    #[serde(rename = "type")]
    pub tag: BrowserImportTag,
    pub profile_id: String,
    pub import_id: String,
    pub partition_id: String,
    pub source: BrowserImportSource,
    pub source_profile: Option<String>,
    pub classes: Vec<BrowserImportedClass>,
    /// What this source holds that was not imported.
    pub refused: Vec<BrowserImportRefusal>,
    pub imported_at_ms: i64,
}

// ---------------------------------------------------------------------------
// Design context capture (F094)
// ---------------------------------------------------------------------------

/// `browser.context.capture`: capture one element of one exact tab into two
/// conversation attachments. The first is a UTF-8 JSON document
/// (`ade-design-context-v1`) with the element's redacted HTML snippet,
/// computed styles and geometry. The second, when the element is visible, is a
/// PNG or JPEG screenshot of it. The owner reads the named tab only; it never
/// substitutes the selected or focused tab, and a page that navigates during
/// the capture fails it.
///
/// `capture_id` is caller-owned and becomes the context attachment's ID; the
/// screenshot's is `<capture_id>-screenshot`. Repeating a capture with the
/// same ID and request returns the stored capture and never captures again;
/// the same ID with another request conflicts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserContextCaptureRequest {
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    pub conversation_id: String,
    /// 1 to 100 ASCII letters, digits, `-` or `_`.
    pub capture_id: String,
    /// A CSS selector of 1 to 1024 characters; its first match is captured.
    pub selector: String,
    /// Take a screenshot of the element; true when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<bool>,
}

wire_tag!(BrowserContextCaptureTag, "browser_context_capture");

/// The `browser.context.capture` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct BrowserContextCapture {
    #[serde(rename = "type")]
    pub tag: BrowserContextCaptureTag,
    pub profile_id: String,
    pub owner_id: String,
    pub tab_id: String,
    pub conversation_id: String,
    pub capture_id: String,
    /// The page URL without user information, query or fragment.
    pub url: String,
    pub title: String,
    /// The element's lowercase tag name.
    pub element: String,
    /// The `ade-design-context-v1` document.
    pub context: crate::model::Attachment,
    pub screenshot: Option<crate::model::Attachment>,
    /// Why there is no screenshot: `not_requested`, `not_visible`,
    /// `too_large` or `capture_failed`.
    pub screenshot_unavailable: Option<String>,
    /// Parts of the context cut to stay within bounds, such as `html`,
    /// `text` or `attributes`.
    pub truncated: Vec<String>,
    pub captured_at_ms: i64,
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

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        let target = json!({"profile_id": "p", "owner_id": "o", "tab_id": "t"});
        for op in ["browser.diagnostics.attach", "browser.diagnostics.detach"] {
            let mut wire = target.clone();
            wire["op"] = json!(op);
            request::<BrowserDiagnosticsAttachRequest>(op, wire);
        }
        request::<BrowserDiagnosticsReadRequest>(
            "browser.diagnostics.read",
            json!({"op": "browser.diagnostics.read", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "after": 12, "limit": 50}),
        );
        request::<BrowserRecordingStartRequest>(
            "browser.recording.start",
            json!({"op": "browser.recording.start", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "recording_id": "r1", "capture": ["screenshots", "network"],
                "interval_ms": 1000}),
        );
        request::<BrowserRecordingStopRequest>(
            "browser.recording.stop",
            json!({"op": "browser.recording.stop", "profile_id": "p", "owner_id": "o",
                "recording_id": "r1"}),
        );
        // A read never falls back to the focused tab: the target is required.
        let (name, _) = names("browser.diagnostics.read");
        assert!(!valid(
            &name,
            &json!({"op": "browser.diagnostics.read", "profile_id": "p", "owner_id": "o"})
        ));
        let (name, _) = names("browser.recording.start");
        assert!(!valid(
            &name,
            &json!({"op": "browser.recording.start", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "recording_id": "r", "capture": ["video"]})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_owner_shape() {
        let attachment = json!({"state": "attached", "reason": null, "attached_at_ms": 5,
            "holders": ["caller"]});
        response::<BrowserDiagnosticsState>(
            "browser.diagnostics.attach",
            json!({"type": "browser_diagnostics_state", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "attachment": attachment}),
        );
        response::<BrowserDiagnostics>(
            "browser.diagnostics.read",
            json!({"type": "browser_diagnostics", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "attachment": attachment,
                "console": [{"seq": 1, "at_ms": 10, "source": "console", "level": "error",
                    "text": "boom", "url": null, "line": null}],
                "network": [{"seq": 2, "at_ms": 11, "method": "GET",
                    "url": "https://a.test/?token=[redacted]", "resource_type": "Fetch",
                    "status": 500, "mime_type": "application/json", "encoded_bytes": 20,
                    "duration_ms": 3, "outcome": "completed", "error": null}],
                "next": 2, "more": false, "in_flight": 0,
                "dropped": {"console": 0, "network": 0},
                "redaction": "ade-browser-redaction-v1", "excluded": ["cookies"]}),
        );
        response::<BrowserRecording>(
            "browser.recording.get",
            json!({"type": "browser_recording", "profile_id": "p", "owner_id": "o",
                "recording_id": "r1", "tab_id": "t", "format": "ade-browser-recording-v1",
                "state": "interrupted", "capture": ["screenshots"], "interval_ms": 2000,
                "max_duration_ms": 300000, "started_at_ms": 1, "stopped_at_ms": null,
                "stop_reason": null, "artifact_dir": "/tmp/r1", "frames": 3,
                "frames_unavailable": 0, "page_events": 0, "console_entries": 0,
                "network_entries": 0, "bytes": 99, "coverage_gaps": ["no video"]}),
        );
    }

    #[test]
    fn partition_import_and_capture_round_trip() {
        request::<BrowserPartitionCreateRequest>(
            "browser.partition.create",
            json!({"op": "browser.partition.create", "partition_id": "work", "name": "Work"}),
        );
        request::<BrowserImportRunRequest>(
            "browser.import.run",
            json!({"op": "browser.import.run", "import_id": "i1", "partition_id": "default",
                "source": "chrome", "source_profile": "Profile 1",
                "classes": ["bookmarks", "history"]}),
        );
        // Encrypted or live classes and unsupported sources cannot be requested.
        let (name, _) = names("browser.import.run");
        for (source, class) in [
            ("chrome", "cookies"),
            ("chrome", "passwords"),
            ("firefox", "history"),
        ] {
            assert!(!valid(
                &name,
                &json!({"op": "browser.import.run", "import_id": "i1",
                    "partition_id": "default", "source": source, "classes": [class]})
            ));
        }
        request::<BrowserContextCaptureRequest>(
            "browser.context.capture",
            json!({"op": "browser.context.capture", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "conversation_id": "c", "capture_id": "k",
                "selector": "main > h1", "screenshot": false}),
        );
        // A capture never falls back to the focused tab.
        let (name, _) = names("browser.context.capture");
        assert!(!valid(
            &name,
            &json!({"op": "browser.context.capture", "profile_id": "p", "owner_id": "o",
                "conversation_id": "c", "capture_id": "k", "selector": "h1"})
        ));
        response::<BrowserPartitions>(
            "browser.partition.list",
            json!({"type": "browser_partitions", "profile_id": "p", "limit": 32,
                "partitions": [{"partition_id": "default", "name": "Default",
                    "created_at_ms": null}]}),
        );
        response::<BrowserImportPreview>(
            "browser.import.preview",
            json!({"type": "browser_import_preview", "profile_id": "p", "source": "safari",
                "source_profile": null,
                "classes": [{"class": "history", "availability": "permission_denied",
                    "path": "/x/History.db", "format": null, "importable": 0, "skipped": 0,
                    "truncated": 0, "reason": "Full Disk Access"}],
                "refused": [{"class": "cookies", "reason": "live session state"}]}),
        );
        response::<BrowserImport>(
            "browser.import.get",
            json!({"type": "browser_import", "profile_id": "p", "import_id": "i1",
                "partition_id": "work", "source": "chrome", "source_profile": "Default",
                "classes": [{"class": "bookmarks", "format": "chrome-bookmarks-json-1",
                    "imported": 3, "skipped": 1, "truncated": 0}],
                "refused": [], "imported_at_ms": 9}),
        );
        response::<BrowserContextCapture>(
            "browser.context.capture",
            json!({"type": "browser_context_capture", "profile_id": "p", "owner_id": "o",
                "tab_id": "t", "conversation_id": "c", "capture_id": "k",
                "url": "https://a.test/", "title": "A", "element": "h1",
                "context": {"id": "k", "name": "design-context-k.json",
                    "media_type": "text/plain", "size": 10},
                "screenshot": null, "screenshot_unavailable": "not_requested",
                "truncated": [], "captured_at_ms": 4}),
        );
    }
}
