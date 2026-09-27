//! `browser.diagnostics.*` and `browser.recording.*`: relays to the browser
//! owner for one exact tab or recording (F096, F097).
//!
//! The daemon forwards only the typed request fields and accepts a reply only
//! when it names the same profile, owner and target. An owner that answers for
//! another tab, as focus-following code would, gets a protocol error, and a
//! reply from an owner that was replaced meanwhile is never presented.
use super::*;
use ade_core::contract::browser::{
    BrowserCaptureKind, BrowserDiagnostics, BrowserDiagnosticsAttachRequest,
    BrowserDiagnosticsDetachRequest, BrowserDiagnosticsReadRequest, BrowserDiagnosticsState,
    BrowserEvaluation, BrowserRecording, BrowserRecordingGetRequest, BrowserRecordingStartRequest,
    BrowserRecordingStopRequest, BrowserScreenshot, BrowserWait,
};

/// The operations this module relays.
pub(super) fn is_browser_tool(op: &str) -> bool {
    matches!(
        op,
        "browser.diagnostics.attach"
            | "browser.diagnostics.detach"
            | "browser.diagnostics.read"
            | "browser.recording.start"
            | "browser.recording.stop"
            | "browser.recording.get"
    ) || super::browser_automation::is_automation_query(op)
}

/// The exact resource a request names. The reply must name the same one.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    Tab(String),
    Recording(String),
}

/// A validated request: the owner it addresses, its target and the fields to forward.
#[derive(Debug)]
struct Relay {
    owner_id: String,
    target: Target,
    forward: Value,
    /// A longer reply window for an operation that waits on the page.
    reply_timeout: Option<Duration>,
}

fn invalid(message: impl std::fmt::Display) -> Value {
    browser_error("invalid_request", &message.to_string())
}

fn bounded(value: Option<u64>, field: &str, min: u64, max: u64) -> Result<(), Value> {
    match value {
        Some(value) if !(min..=max).contains(&value) => {
            Err(invalid(format!("{field} must be between {min} and {max}")))
        }
        _ => Ok(()),
    }
}

fn typed<T: DeserializeOwned + Serialize>(request: &Value, op: &str) -> Result<(T, Value), Value> {
    let decoded: T = browser_decode(request)?;
    let mut forward = serde_json::to_value(&decoded).map_err(invalid)?;
    forward["op"] = json!(op);
    Ok((decoded, forward))
}

/// Decodes and bounds-checks one request. The owner repeats every check.
fn relay_request(op: &str, request: &Value) -> Result<Relay, Value> {
    let owner_id = browser_id(request, "owner_id").map_err(invalid)?;
    let tab = || {
        browser_id(request, "tab_id")
            .map(Target::Tab)
            .map_err(invalid)
    };
    let recording = || {
        browser_id(request, "recording_id")
            .map(Target::Recording)
            .map_err(invalid)
    };
    if super::browser_automation::is_automation_query(op) {
        let relay = super::browser_automation::query_relay(op, request)?;
        return Ok(Relay {
            owner_id,
            target: Target::Tab(relay.tab_id),
            forward: relay.forward,
            reply_timeout: Some(relay.reply_timeout),
        });
    }
    let (target, forward) = match op {
        "browser.diagnostics.attach" => {
            let target = tab()?;
            (
                target,
                typed::<BrowserDiagnosticsAttachRequest>(request, op)?.1,
            )
        }
        "browser.diagnostics.detach" => {
            let target = tab()?;
            (
                target,
                typed::<BrowserDiagnosticsDetachRequest>(request, op)?.1,
            )
        }
        "browser.diagnostics.read" => {
            let target = tab()?;
            let (read, forward) = typed::<BrowserDiagnosticsReadRequest>(request, op)?;
            bounded(read.limit, "limit", 1, 200)?;
            bounded(read.after, "after", 0, 9_007_199_254_740_991)?;
            (target, forward)
        }
        "browser.recording.start" => {
            let target = recording()?;
            tab()?;
            let (start, forward) = typed::<BrowserRecordingStartRequest>(request, op)?;
            let mut kinds: Vec<BrowserCaptureKind> = Vec::new();
            for kind in &start.capture {
                if kinds.contains(kind) {
                    return Err(invalid("capture kinds must be distinct"));
                }
                kinds.push(*kind);
            }
            if kinds.is_empty() {
                return Err(invalid("capture needs at least one kind"));
            }
            bounded(start.interval_ms, "interval_ms", 250, 60_000)?;
            bounded(start.max_duration_ms, "max_duration_ms", 1_000, 1_800_000)?;
            (target, forward)
        }
        "browser.recording.stop" => {
            let target = recording()?;
            (target, typed::<BrowserRecordingStopRequest>(request, op)?.1)
        }
        "browser.recording.get" => {
            let target = recording()?;
            (target, typed::<BrowserRecordingGetRequest>(request, op)?.1)
        }
        _ => return Err(invalid("Unsupported browser operation")),
    };
    Ok(Relay {
        owner_id,
        target,
        forward,
        reply_timeout: None,
    })
}

/// True when an owner reply names exactly the profile, owner and target the
/// request named. Errors name the profile and owner but may omit the target.
fn names_target(reply: &Value, profile_id: &str, owner_id: &str, target: &Target) -> bool {
    if !reply.is_object()
        || !reply["type"].is_string()
        || reply["profile_id"] != profile_id
        || reply["owner_id"] != owner_id
    {
        return false;
    }
    if reply["type"] == "error" {
        return true;
    }
    match target {
        Target::Tab(id) => reply["tab_id"] == id.as_str(),
        Target::Recording(id) => reply["recording_id"] == id.as_str(),
    }
}

/// Checks a success reply against the operation's contract.
fn contract_reply(op: &str, reply: Value) -> Option<Value> {
    let expected = match op {
        "browser.diagnostics.attach" | "browser.diagnostics.detach" => "browser_diagnostics_state",
        "browser.diagnostics.read" => "browser_diagnostics",
        "browser.evaluate" => "browser_evaluation",
        "browser.wait" => "browser_wait",
        "browser.screenshot" => "browser_screenshot",
        _ => "browser_recording",
    };
    if reply["type"] != expected {
        return None;
    }
    match expected {
        "browser_diagnostics_state" => serde_json::from_value::<BrowserDiagnosticsState>(reply)
            .ok()
            .map(|value| super::reply(&value)),
        "browser_diagnostics" => serde_json::from_value::<BrowserDiagnostics>(reply)
            .ok()
            .map(|value| super::reply(&value)),
        "browser_evaluation" => serde_json::from_value::<BrowserEvaluation>(reply)
            .ok()
            .map(|value| super::reply(&value)),
        "browser_wait" => serde_json::from_value::<BrowserWait>(reply)
            .ok()
            .map(|value| super::reply(&value)),
        "browser_screenshot" => serde_json::from_value::<BrowserScreenshot>(reply)
            .ok()
            .map(|value| super::reply(&value)),
        _ => serde_json::from_value::<BrowserRecording>(reply)
            .ok()
            .map(|value| super::reply(&value)),
    }
}

impl Host {
    pub(super) fn browser_tool(&self, request: &Value) -> Value {
        let op = request["op"].as_str().unwrap_or("");
        let profile_id = match browser_id(request, "profile_id") {
            Ok(id) => id,
            Err(error) => return invalid(error),
        };
        if profile_id != self.profile_id {
            return browser_error(
                "unavailable",
                "Browser profile is unavailable on this daemon",
            );
        }
        let relay = match relay_request(op, request) {
            Ok(relay) => relay,
            Err(error) => return error,
        };
        let current = self.browser_owner.lock().unwrap().clone();
        let Some(owner) = current
            .filter(|owner| owner.profile_id == profile_id && owner.owner_id == relay.owner_id)
        else {
            return browser_error("unavailable", "Browser owner changed; inspect it again");
        };
        // A command whose reply is lost may have run; repeating the same
        // request converges, so the caller is told to repeat, not to guess.
        let lost = |message: &str| {
            if op.ends_with(".read")
                || op.ends_with(".get")
                || super::browser_automation::is_automation_query(op)
            {
                browser_error("unavailable", message)
            } else {
                browser_error(
                    "outcome_unknown",
                    &format!("{message}; repeat the same request to converge"),
                )
            }
        };
        let _permit = self.browser_budget.acquire();
        let connected = browser_connect(&owner).and_then(|stream| {
            if let Some(window) = relay.reply_timeout {
                stream.set_read_timeout(Some(window))?;
            }
            Ok(stream)
        });
        let mut stream = match connected {
            Ok(stream) => stream,
            Err(_) => return browser_error("unavailable", "Browser owner is unavailable"),
        };
        let mut command = relay.forward;
        command["profile_id"] = json!(owner.profile_id);
        command["owner_id"] = json!(owner.owner_id);
        if writeln!(stream, "{command}").is_err() {
            return lost("Browser owner did not accept the request");
        }
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        if reader
            .by_ref()
            .take(MAX_BROWSER_REPLY + 1)
            .read_until(b'\n', &mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BROWSER_REPLY
            || bytes.last() != Some(&b'\n')
        {
            return lost("Browser owner reply is unavailable or too large");
        }
        let Ok(response) = serde_json::from_slice::<Value>(&bytes) else {
            return browser_error("protocol", "Browser owner returned invalid JSON");
        };
        if !names_target(&response, &profile_id, &relay.owner_id, &relay.target) {
            return browser_error(
                "protocol",
                "Browser owner answered for another target; nothing is reported",
            );
        }
        if !self.owner_is_current(&owner) {
            return lost("Browser owner changed during the request");
        }
        if response["type"] == "error" {
            return response;
        }
        contract_reply(op, response)
            .unwrap_or_else(|| browser_error("protocol", "Browser owner reply failed its contract"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(extra: Value) -> Value {
        let mut request = json!({"op": "browser.diagnostics.read", "profile_id": "p",
            "owner_id": "o", "tab_id": "tab-1"});
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        request
    }

    #[test]
    fn a_reply_for_another_tab_or_recording_is_refused() {
        let tab = Target::Tab("tab-1".into());
        let ok = json!({"type": "browser_diagnostics", "profile_id": "p", "owner_id": "o",
            "tab_id": "tab-1"});
        assert!(names_target(&ok, "p", "o", &tab));
        let focused = json!({"type": "browser_diagnostics", "profile_id": "p", "owner_id": "o",
            "tab_id": "tab-2"});
        assert!(!names_target(&focused, "p", "o", &tab));
        let untargeted = json!({"type": "browser_diagnostics", "profile_id": "p", "owner_id": "o"});
        assert!(!names_target(&untargeted, "p", "o", &tab));
        let other_owner = json!({"type": "error", "profile_id": "p", "owner_id": "x"});
        assert!(!names_target(&other_owner, "p", "o", &tab));
        let error = json!({"type": "error", "code": "unavailable", "profile_id": "p",
            "owner_id": "o"});
        assert!(names_target(&error, "p", "o", &tab));
        let recording = Target::Recording("r1".into());
        let other = json!({"type": "browser_recording", "profile_id": "p", "owner_id": "o",
            "recording_id": "r2", "tab_id": "tab-1"});
        assert!(!names_target(&other, "p", "o", &recording));
    }

    #[test]
    fn requests_are_bounded_and_forward_only_their_fields() {
        let relay = relay_request("browser.diagnostics.read", &read(json!({"limit": 5}))).unwrap();
        assert_eq!(relay.target, Target::Tab("tab-1".into()));
        assert_eq!(relay.forward["limit"], 5);
        assert_eq!(relay.forward["op"], "browser.diagnostics.read");
        let smuggled = relay_request(
            "browser.diagnostics.read",
            &read(json!({"socket_path": "/tmp/x"})),
        )
        .unwrap();
        assert!(smuggled.forward.get("socket_path").is_none());
        for bad in [
            json!({"limit": 0}),
            json!({"limit": 201}),
            json!({"tab_id": "../x"}),
            json!({"tab_id": null}),
        ] {
            let error = relay_request("browser.diagnostics.read", &read(bad)).unwrap_err();
            assert_eq!(error["code"], "invalid_request");
        }
        let start = |capture: Value, interval: Value| {
            relay_request(
                "browser.recording.start",
                &json!({"op": "browser.recording.start", "profile_id": "p", "owner_id": "o",
                    "tab_id": "tab-1", "recording_id": "r1", "capture": capture,
                    "interval_ms": interval}),
            )
        };
        assert_eq!(
            start(json!(["screenshots"]), json!(1000)).unwrap().target,
            Target::Recording("r1".into())
        );
        assert!(start(json!([]), json!(1000)).is_err());
        assert!(start(json!(["console", "console"]), json!(1000)).is_err());
        assert!(start(json!(["screenshots"]), json!(10)).is_err());
    }

    #[test]
    fn only_the_contract_reply_for_the_operation_is_relayed() {
        let recording = json!({"type": "browser_recording", "profile_id": "p", "owner_id": "o",
            "recording_id": "r1", "tab_id": "t", "format": "ade-browser-recording-v1",
            "state": "stopped", "capture": ["screenshots"], "interval_ms": 2000,
            "max_duration_ms": 300000, "started_at_ms": 1, "stopped_at_ms": 2,
            "stop_reason": "requested", "artifact_dir": "/tmp/r1", "frames": 1,
            "frames_unavailable": 0, "page_events": 0, "console_entries": 0,
            "network_entries": 0, "bytes": 9, "coverage_gaps": []});
        assert!(contract_reply("browser.recording.stop", recording.clone()).is_some());
        assert!(contract_reply("browser.diagnostics.read", recording.clone()).is_none());
        let mut partial = recording;
        partial.as_object_mut().unwrap().remove("coverage_gaps");
        assert!(contract_reply("browser.recording.get", partial).is_none());
    }
}
