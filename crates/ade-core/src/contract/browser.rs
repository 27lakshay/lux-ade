//! Browser diagnostics and recording contracts (F096, F097, decision D11).
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
}
