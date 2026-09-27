//! Browser partitions (F092), browser import (F093, decision D10) and design
//! context capture (F094).
//!
//! Partitions and imports live in the profile's browser library
//! (`ade_daemon::browser_library`) and need no browser owner. A capture is
//! relayed to the owner for one exact tab, like `browser.diagnostics.*`: the
//! reply must name the same profile, owner and tab, and an owner replaced
//! meanwhile is never believed. The daemon then checks the capture against
//! its bounds, holds its bytes, and stores them as two conversation
//! attachments. A repeat of a held capture re-stores the identical bytes; it
//! never captures the page again.
use super::*;
use ade_core::contract::browser::{
    BrowserContextCapture, BrowserContextCaptureRequest, BrowserImport, BrowserImportGetRequest,
    BrowserImportPreview, BrowserImportPreviewRequest, BrowserImportRunRequest,
    BrowserPartitionCreateRequest, BrowserPartitionListRequest, BrowserPartitionReply,
    BrowserPartitions,
};
use ade_core::model::Attachment;
use ade_daemon::browser_library::{
    self as library, DEFAULT_PARTITION, Library, PARTITION_LIMIT, sources,
};
use base64::Engine;
use std::path::PathBuf;

/// The operations this module serves.
pub(super) fn is_browser_context(op: &str) -> bool {
    matches!(
        op,
        "browser.partition.list"
            | "browser.partition.create"
            | "browser.import.preview"
            | "browser.import.run"
            | "browser.import.get"
            | "browser.context.capture"
    )
}

/// Appends an explicit partition to a `browser.open` fingerprint payload. An
/// open without one keeps its earlier fingerprint.
pub(super) fn with_partition(payload: &mut Value, partition: Option<&str>) {
    if let (Some(partition), Some(items)) = (partition, payload.as_array_mut()) {
        items.push(json!(partition));
    }
}

const CONTEXT_FORMAT: &str = "ade-design-context-v1";
const HTML_LIMIT: usize = 64 * 1024;
const TEXT_LIMIT: usize = 4096;
const STYLE_LIMIT: usize = 96;
const ATTRIBUTE_LIMIT: usize = 64;
const VALUE_LIMIT: usize = 1024;
/// Keeps the whole owner reply under the 1 MiB relay bound.
const SCREENSHOT_LIMIT: usize = 512 * 1024;
const SCREENSHOT_UNAVAILABLE: &[&str] = &[
    "not_requested",
    "not_visible",
    "too_large",
    "capture_failed",
];
/// What a design context never contains, stated in every document.
const CONTEXT_EXCLUDED: &[&str] = &[
    "form field values and password inputs",
    "URL query strings, fragments and user information",
    "script and style element contents",
    "event handler attributes",
    "cookies, storage and network data",
    "contents of child frames",
];

fn invalid(message: impl std::fmt::Display) -> Value {
    browser_error("invalid_request", &message.to_string())
}

fn failed(error: anyhow::Error) -> Value {
    browser_error(library::error_code(&error), &format!("{error:#}"))
}

/// A checked capture, ready to hold and attach.
#[derive(Debug)]
struct Captured {
    context: Vec<u8>,
    screenshot: Option<Vec<u8>>,
    reply: BrowserContextCapture,
}

fn string<'a>(value: &'a Value, field: &str, limit: usize) -> Result<&'a str, String> {
    let text = value[field]
        .as_str()
        .ok_or_else(|| format!("capture {field} is missing"))?;
    if text.chars().count() > limit {
        return Err(format!("capture {field} exceeds its bound"));
    }
    Ok(text)
}

fn number(value: &Value, field: &str) -> Result<f64, String> {
    value[field]
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 1e7)
        .ok_or_else(|| format!("capture {field} is not a finite number"))
}

/// A flat map of short strings, at most `limit` entries.
fn string_map(value: &Value, field: &str, limit: usize) -> Result<Value, String> {
    let Some(map) = value[field].as_object() else {
        return Err(format!("capture {field} is not an object"));
    };
    if map.len() > limit {
        return Err(format!("capture {field} has too many entries"));
    }
    for (key, item) in map {
        let text = item
            .as_str()
            .ok_or_else(|| format!("capture {field} values must be strings"))?;
        if key.len() > 128 || text.chars().count() > VALUE_LIMIT {
            return Err(format!("capture {field} entry exceeds its bound"));
        }
    }
    Ok(Value::Object(map.clone()))
}

/// A page URL for the record: HTTP(S) without user information, query or
/// fragment.
fn page_url(url: &str) -> Result<String, String> {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        ""
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty()
        || authority.contains('@')
        || url.len() > 8192
        || url.contains(['?', '#'])
        || url.chars().any(char::is_control)
    {
        return Err(
            "capture URL must be HTTP(S) without user information, query or fragment".into(),
        );
    }
    Ok(url.to_owned())
}

/// Checks an owner capture reply against its bounds and builds the context
/// document, the screenshot bytes and the reply. Pure: no I/O.
fn captured(
    request: &BrowserContextCaptureRequest,
    owner: &Value,
    captured_at_ms: i64,
) -> Result<Captured, String> {
    if owner["type"] != "browser_context_capture" || owner["tab_id"] != request.tab_id.as_str() {
        return Err("capture reply names another target".into());
    }
    let url = page_url(string(owner, "url", 8192)?)?;
    let title = string(owner, "title", 512)?.to_owned();
    let element = &owner["element"];
    let tag = string(element, "tag", 64)?;
    if tag.is_empty() || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("capture element tag is invalid".into());
    }
    let tag = tag.to_ascii_lowercase();
    let html = string(element, "html", HTML_LIMIT)?;
    let text = string(element, "text", TEXT_LIMIT)?;
    let rect = &element["rect"];
    let rect = json!({"x": number(rect, "x")?, "y": number(rect, "y")?,
        "width": number(rect, "width")?, "height": number(rect, "height")?});
    let styles = string_map(element, "styles", STYLE_LIMIT)?;
    let attributes = string_map(element, "attributes", ATTRIBUTE_LIMIT)?;
    let viewport = &owner["viewport"];
    let viewport = json!({"width": number(viewport, "width")?, "height": number(viewport, "height")?,
        "device_pixel_ratio": number(viewport, "device_pixel_ratio")?});
    let mut truncated = Vec::new();
    for part in owner["truncated"].as_array().into_iter().flatten() {
        match part.as_str() {
            Some(part @ ("html" | "text" | "attributes" | "styles"))
                if !truncated.contains(&part) =>
            {
                truncated.push(part)
            }
            _ => return Err("capture truncated list is invalid".into()),
        }
    }
    let wanted = request.screenshot.unwrap_or(true);
    let (screenshot, unavailable) = match (
        &owner["screenshot"],
        owner["screenshot_unavailable"].as_str(),
    ) {
        (Value::Null, Some(reason)) if SCREENSHOT_UNAVAILABLE.contains(&reason) => {
            if !wanted && reason != "not_requested" {
                return Err("capture reason contradicts the request".into());
            }
            (None, Some(reason.to_owned()))
        }
        (shot, None) if shot.is_object() && wanted => {
            let data = string(shot, "data", SCREENSHOT_LIMIT * 4 / 3 + 4)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "capture screenshot is not base64")?;
            let media = ade_core::prompt::media_type(&bytes).map_err(|e| e.to_string())?;
            if bytes.len() > SCREENSHOT_LIMIT || !matches!(media, "image/png" | "image/jpeg") {
                return Err("capture screenshot must be a PNG or JPEG within its bound".into());
            }
            (
                Some((bytes, number(shot, "width")?, number(shot, "height")?)),
                None,
            )
        }
        _ => return Err("capture screenshot fields are inconsistent".into()),
    };
    let shot_id = format!("{}-screenshot", request.capture_id);
    let document = json!({
        "format": CONTEXT_FORMAT,
        "capture_id": request.capture_id,
        "tab_id": request.tab_id,
        "url": url,
        "title": title,
        "selector": request.selector,
        "captured_at_ms": captured_at_ms,
        "element": {"tag": tag, "html": html, "text": text, "rect": rect,
            "attributes": attributes, "computed_styles": styles},
        "viewport": viewport,
        "screenshot": screenshot.as_ref().map(|(_, width, height)|
            json!({"attachment_id": shot_id, "width": width, "height": height})),
        "screenshot_unavailable": unavailable,
        "truncated": truncated,
        "excluded": CONTEXT_EXCLUDED,
    });
    let context = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
    let attachment = |id: String, name: String, bytes: &[u8]| -> Result<Attachment, String> {
        Ok(Attachment {
            id,
            name,
            media_type: ade_core::prompt::media_type(bytes)
                .map_err(|e| e.to_string())?
                .into(),
            size: bytes.len(),
        })
    };
    let context_attachment = attachment(
        request.capture_id.clone(),
        format!("design-context-{}.json", request.capture_id),
        &context,
    )?;
    let screenshot_attachment = screenshot
        .as_ref()
        .map(|(bytes, _, _)| {
            let extension = if bytes.starts_with(b"\x89PNG") {
                "png"
            } else {
                "jpg"
            };
            attachment(
                shot_id.clone(),
                format!("design-context-{}.{extension}", request.capture_id),
                bytes,
            )
        })
        .transpose()?;
    Ok(Captured {
        context,
        screenshot: screenshot.map(|(bytes, _, _)| bytes),
        reply: BrowserContextCapture {
            tag: Default::default(),
            profile_id: request.profile_id.clone(),
            owner_id: request.owner_id.clone(),
            tab_id: request.tab_id.clone(),
            conversation_id: request.conversation_id.clone(),
            capture_id: request.capture_id.clone(),
            url,
            title,
            element: tag,
            context: context_attachment,
            screenshot: screenshot_attachment,
            screenshot_unavailable: unavailable,
            truncated: truncated.into_iter().map(str::to_owned).collect(),
            captured_at_ms,
        },
    })
}

/// The request fields a repeated capture must match. The owner is left out:
/// a repeat after the owner restarts still names the same tab.
fn capture_fingerprint(request: &BrowserContextCaptureRequest) -> String {
    let canonical = json!([
        request.tab_id,
        request.conversation_id,
        request.selector,
        request.screenshot.unwrap_or(true)
    ])
    .to_string();
    library::hex(&Sha256::digest(canonical.as_bytes()))
}

fn validate_capture(request: &BrowserContextCaptureRequest) -> Result<(), Value> {
    for field in ["owner_id", "tab_id"] {
        let value = if field == "owner_id" {
            &request.owner_id
        } else {
            &request.tab_id
        };
        browser_id(&json!({ field: value }), field).map_err(invalid)?;
    }
    if !library::valid_request_id(&request.capture_id, 100) {
        return Err(invalid(
            "capture_id must be 1 to 100 ASCII letters, digits, - or _",
        ));
    }
    if request.conversation_id.is_empty() || request.conversation_id.len() > 512 {
        return Err(invalid("Invalid conversation_id"));
    }
    let length = request.selector.chars().count();
    if !(1..=1024).contains(&length) || request.selector.chars().any(char::is_control) {
        return Err(invalid(
            "selector must be 1 to 1024 characters without control characters",
        ));
    }
    Ok(())
}

impl Host {
    /// The partition a `browser.open` names, after checking it is registered.
    /// `default` is the same as none.
    pub(super) fn open_partition(&self, request: &Value) -> Result<Option<String>, Value> {
        let Some(partition) = request.get("partition_id") else {
            return Ok(None);
        };
        let Some(partition) = partition
            .as_str()
            .filter(|p| library::valid_partition_id(p))
        else {
            return Err(invalid("Invalid partition_id"));
        };
        if partition == DEFAULT_PARTITION {
            return Ok(None);
        }
        match Library::open(&self.directory).and_then(|lib| lib.partition_exists(partition)) {
            Ok(true) => Ok(Some(partition.to_owned())),
            Ok(false) => Err(invalid(
                "Unknown browser partition; create it with browser.partition.create",
            )),
            Err(_) => Err(browser_error(
                "unavailable",
                "Browser library is unavailable",
            )),
        }
    }

    pub(super) fn browser_context(&self, request: &Value) -> Value {
        let op = request["op"].as_str().unwrap_or("");
        if let Some(profile) = request.get("profile_id")
            && profile.as_str() != Some(self.profile_id.as_str())
        {
            return browser_error(
                "unavailable",
                "Browser profile is unavailable on this daemon",
            );
        }
        if op == "browser.context.capture" {
            return match browser_decode::<BrowserContextCaptureRequest>(request) {
                Ok(capture) => self.context_capture(capture),
                Err(error) => error,
            };
        }
        let result = match op {
            "browser.partition.list" => browser_decode::<BrowserPartitionListRequest>(request)
                .and_then(|_| self.partition_list().map_err(failed)),
            "browser.partition.create" => browser_decode::<BrowserPartitionCreateRequest>(request)
                .and_then(|create| self.partition_create(&create).map_err(failed)),
            "browser.import.preview" => browser_decode::<BrowserImportPreviewRequest>(request)
                .and_then(|preview| self.import_preview(&preview)),
            "browser.import.run" => browser_decode::<BrowserImportRunRequest>(request)
                .and_then(|run| self.import_run(run)),
            "browser.import.get" => browser_decode::<BrowserImportGetRequest>(request)
                .and_then(|get| self.import_get(&get)),
            _ => Err(invalid("Unsupported browser operation")),
        };
        result.unwrap_or_else(|error| error)
    }

    fn partition_list(&self) -> anyhow::Result<Value> {
        let lib = Library::open(&self.directory)?;
        Ok(reply(&BrowserPartitions {
            tag: Default::default(),
            profile_id: self.profile_id.clone(),
            partitions: lib.partitions()?,
            limit: PARTITION_LIMIT,
        }))
    }

    fn partition_create(&self, create: &BrowserPartitionCreateRequest) -> anyhow::Result<Value> {
        let mut lib = Library::open(&self.directory)?;
        let (partition, created) = lib.create_partition(&create.partition_id, &create.name)?;
        Ok(reply(&BrowserPartitionReply {
            tag: Default::default(),
            profile_id: self.profile_id.clone(),
            partition,
            created,
        }))
    }

    /// The home directory import sources are found under. Isolated test
    /// fixtures point `ADE_BROWSER_IMPORT_HOME` at their own tree.
    fn import_home() -> Result<PathBuf, Value> {
        std::env::var_os("ADE_BROWSER_IMPORT_HOME")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .ok_or_else(|| browser_error("unavailable", "The home directory is unknown"))
    }

    fn import_preview(&self, preview: &BrowserImportPreviewRequest) -> Result<Value, Value> {
        let profile = sources::source_profile(preview.source, preview.source_profile.as_deref())
            .map_err(invalid)?;
        let home = Self::import_home()?;
        let staging = Library::open(&self.directory)
            .map_err(failed)?
            .staging_root();
        let classes = [
            ade_core::contract::browser::BrowserImportClass::Bookmarks,
            ade_core::contract::browser::BrowserImportClass::History,
        ]
        .into_iter()
        .map(|class| {
            let (path, read) =
                library::read_class(&home, &staging, preview.source, profile.as_deref(), class);
            read.preview(class, &path)
        })
        .collect();
        Ok(reply(&BrowserImportPreview {
            tag: Default::default(),
            profile_id: self.profile_id.clone(),
            source: preview.source,
            source_profile: profile,
            classes,
            refused: sources::refusals(preview.source),
        }))
    }

    fn import_run(&self, run: BrowserImportRunRequest) -> Result<Value, Value> {
        if !library::valid_request_id(&run.import_id, 128) {
            return Err(invalid(
                "import_id must be 1 to 128 ASCII letters, digits, - or _",
            ));
        }
        let mut classes = run.classes.clone();
        classes.sort();
        classes.dedup();
        if classes.is_empty() || classes.len() != run.classes.len() {
            return Err(invalid("classes must name one or more distinct classes"));
        }
        let profile =
            sources::source_profile(run.source, run.source_profile.as_deref()).map_err(invalid)?;
        let fingerprint = library::import_fingerprint(
            &run.partition_id,
            run.source,
            profile.as_deref(),
            &classes,
        );
        let mut lib = Library::open(&self.directory).map_err(failed)?;
        if let Some((stored, record)) = lib.import(&run.import_id).map_err(failed)? {
            if stored != fingerprint {
                return Err(browser_error(
                    "conflict",
                    "import_id was already used for another import",
                ));
            }
            return Ok(reply(&record));
        }
        if !library::valid_partition_id(&run.partition_id)
            || !lib.partition_exists(&run.partition_id).map_err(failed)?
        {
            return Err(invalid(
                "Unknown browser partition; create it with browser.partition.create",
            ));
        }
        let home = Self::import_home()?;
        let staging = lib.staging_root();
        let reads = classes
            .iter()
            .map(|class| {
                let (_, read) =
                    library::read_class(&home, &staging, run.source, profile.as_deref(), *class);
                (*class, read)
            })
            .collect();
        let record = BrowserImport {
            tag: Default::default(),
            profile_id: self.profile_id.clone(),
            import_id: run.import_id,
            partition_id: run.partition_id,
            source: run.source,
            source_profile: profile,
            classes: Vec::new(),
            refused: sources::refusals(run.source),
            imported_at_ms: 0,
        };
        lib.store_import(&fingerprint, record, reads)
            .map(|record| reply(&record))
            .map_err(failed)
    }

    fn import_get(&self, get: &BrowserImportGetRequest) -> Result<Value, Value> {
        let lib = Library::open(&self.directory).map_err(failed)?;
        match lib.import(&get.import_id).map_err(failed)? {
            Some((_, record)) => Ok(reply(&record)),
            None => Err(browser_error(
                "unavailable",
                "No browser import has this ID",
            )),
        }
    }

    /// Stores a held capture's attachments, screenshot first, and marks it
    /// complete. Each store is idempotent for identical bytes.
    fn finish_capture(
        &self,
        lib: &Library,
        request: &BrowserContextCaptureRequest,
        context: &[u8],
        screenshot: Option<&[u8]>,
        reply: &BrowserContextCapture,
    ) -> Value {
        let put = |attachment: &Attachment, bytes: &[u8]| -> anyhow::Result<()> {
            let stored = self.sessions.command(&json!({"op": "attachment.put",
                "conversation_id": request.conversation_id, "request_id": attachment.id,
                "name": attachment.name,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes)}))?;
            anyhow::ensure!(
                serde_json::from_value::<Attachment>(stored["attachment"].clone())
                    .ok()
                    .as_ref()
                    == Some(attachment),
                "The stored attachment does not match the capture"
            );
            Ok(())
        };
        let stored = match (&reply.screenshot, screenshot) {
            (Some(attachment), Some(bytes)) => put(attachment, bytes),
            (None, None) => Ok(()),
            _ => Err(anyhow::anyhow!("Held capture is inconsistent")),
        }
        .and_then(|()| put(&reply.context, context))
        .and_then(|()| lib.complete_capture(&request.capture_id));
        match stored {
            Ok(()) => super::reply(reply),
            Err(error) => browser_error(
                "unavailable",
                &format!(
                    "The capture is held but its attachments were not all stored: {error:#}; \
                     repeat the same capture to finish"
                ),
            ),
        }
    }

    fn context_capture(&self, request: BrowserContextCaptureRequest) -> Value {
        if let Err(error) = validate_capture(&request) {
            return error;
        }
        let fingerprint = capture_fingerprint(&request);
        let lib = match Library::open(&self.directory) {
            Ok(lib) => lib,
            Err(error) => return failed(error),
        };
        match lib.capture(&request.capture_id) {
            Err(error) => return failed(error),
            Ok(Some(held)) => {
                if held.fingerprint != fingerprint {
                    return browser_error(
                        "conflict",
                        "capture_id was already used for another capture",
                    );
                }
                let Ok(mut stored) = serde_json::from_value::<BrowserContextCapture>(held.reply)
                else {
                    return browser_error("protocol", "Stored capture is damaged");
                };
                // The reply names the caller's current owner; the capture itself is unchanged.
                stored.owner_id = request.owner_id.clone();
                if held.completed {
                    return super::reply(&stored);
                }
                let Some(context) = held.context else {
                    return browser_error("protocol", "Held capture lost its context");
                };
                return self.finish_capture(
                    &lib,
                    &request,
                    &context,
                    held.screenshot.as_deref(),
                    &stored,
                );
            }
            Ok(None) => {}
        }
        if let Err(error) = self.sessions.command(&json!({"op": "conversation.get",
            "conversation_id": request.conversation_id, "limit": 1}))
        {
            return browser_error(
                "unavailable",
                &format!("Conversation is unavailable: {error:#}"),
            );
        }
        let current = self.browser_owner.lock().unwrap().clone();
        let Some(owner) = current.filter(|owner| {
            owner.profile_id == request.profile_id && owner.owner_id == request.owner_id
        }) else {
            return browser_error("unavailable", "Browser owner changed; inspect it again");
        };
        let _permit = self.browser_budget.acquire();
        let Ok(mut stream) = browser_connect(&owner) else {
            return browser_error("unavailable", "Browser owner is unavailable");
        };
        // A capture can wait on the page and the compositor.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let command = json!({"op": "browser.context.capture", "profile_id": owner.profile_id,
            "owner_id": owner.owner_id, "tab_id": request.tab_id, "selector": request.selector,
            "screenshot": request.screenshot.unwrap_or(true)});
        // Nothing is stored until a checked reply arrives, so a lost reply
        // leaves nothing behind and the same request can be repeated.
        let lost = || {
            browser_error(
                "unavailable",
                "Browser owner reply was lost; nothing was stored",
            )
        };
        if writeln!(stream, "{command}").is_err() {
            return lost();
        }
        let mut bytes = Vec::new();
        if BufReader::new(stream)
            .take(MAX_BROWSER_REPLY + 1)
            .read_until(b'\n', &mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BROWSER_REPLY
            || bytes.last() != Some(&b'\n')
        {
            return lost();
        }
        let Ok(response) = serde_json::from_slice::<Value>(&bytes) else {
            return browser_error("protocol", "Browser owner returned invalid JSON");
        };
        if response["profile_id"] != request.profile_id.as_str()
            || response["owner_id"] != request.owner_id.as_str()
        {
            return browser_error("protocol", "Browser owner answered for another owner");
        }
        if !self.owner_is_current(&owner) {
            return browser_error("unavailable", "Browser owner changed during the capture");
        }
        if response["type"] == "error" {
            return response;
        }
        let captured = match captured(&request, &response, now_ms()) {
            Ok(captured) => captured,
            Err(message) => return browser_error("protocol", &message),
        };
        if let Err(error) = lib.hold_capture(
            &request.capture_id,
            &fingerprint,
            &captured.context,
            captured.screenshot.as_deref(),
            &reply(&captured.reply),
        ) {
            return failed(error);
        }
        self.finish_capture(
            &lib,
            &request,
            &captured.context,
            captured.screenshot.as_deref(),
            &captured.reply,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000";

    fn request(screenshot: Option<bool>) -> BrowserContextCaptureRequest {
        BrowserContextCaptureRequest {
            profile_id: "p".into(),
            owner_id: "o".into(),
            tab_id: "tab-1".into(),
            conversation_id: "c".into(),
            capture_id: "k1".into(),
            selector: "main h1".into(),
            screenshot,
        }
    }

    fn owner(shot: Value, unavailable: Value) -> Value {
        json!({"type": "browser_context_capture", "profile_id": "p", "owner_id": "o",
            "tab_id": "tab-1", "url": "https://a.test/page", "title": "A",
            "element": {"tag": "H1", "html": "<h1 class=\"t\">Hi</h1>", "text": "Hi",
                "rect": {"x": 1, "y": 2, "width": 300, "height": 40},
                "styles": {"color": "rgb(0, 0, 0)", "font-size": "32px"},
                "attributes": {"class": "t"}},
            "viewport": {"width": 1280, "height": 800, "device_pixel_ratio": 2},
            "truncated": [], "screenshot": shot, "screenshot_unavailable": unavailable})
    }

    #[test]
    fn a_capture_becomes_a_context_document_and_a_screenshot() {
        let shot = json!({"data": base64::engine::general_purpose::STANDARD.encode(PNG),
            "width": 300, "height": 40});
        let done = captured(&request(None), &owner(shot, Value::Null), 7).unwrap();
        assert_eq!(done.reply.element, "h1");
        assert_eq!(done.reply.context.id, "k1");
        assert_eq!(done.reply.context.media_type, "text/plain");
        let screenshot = done.reply.screenshot.unwrap();
        assert_eq!(screenshot.id, "k1-screenshot");
        assert_eq!(screenshot.media_type, "image/png");
        assert_eq!(done.screenshot.as_deref(), Some(PNG));
        let document: Value = serde_json::from_slice(&done.context).unwrap();
        assert_eq!(document["format"], CONTEXT_FORMAT);
        assert_eq!(document["screenshot"]["attachment_id"], "k1-screenshot");
        assert_eq!(document["element"]["computed_styles"]["font-size"], "32px");
        assert!(!document["excluded"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_capture_for_another_tab_or_outside_its_bounds_is_refused() {
        let unavailable = || owner(Value::Null, json!("not_visible"));
        assert!(captured(&request(None), &unavailable(), 1).is_ok());
        let mut other = unavailable();
        other["tab_id"] = json!("tab-2");
        assert!(captured(&request(None), &other, 1).is_err());
        let mut query = unavailable();
        query["url"] = json!("https://a.test/?token=x");
        assert!(captured(&request(None), &query, 1).is_err());
        let mut huge = unavailable();
        huge["element"]["html"] = json!("x".repeat(HTML_LIMIT + 1));
        assert!(captured(&request(None), &huge, 1).is_err());
        let mut styles = unavailable();
        let many: serde_json::Map<String, Value> = (0..=STYLE_LIMIT)
            .map(|i| (format!("p{i}"), json!("v")))
            .collect();
        styles["element"]["styles"] = Value::Object(many);
        assert!(captured(&request(None), &styles, 1).is_err());
        let mut reason = unavailable();
        reason["screenshot_unavailable"] = json!("because");
        assert!(captured(&request(None), &reason, 1).is_err());
        // A screenshot the caller declined must not arrive.
        let shot = json!({"data": base64::engine::general_purpose::STANDARD.encode(PNG),
            "width": 1, "height": 1});
        assert!(captured(&request(Some(false)), &owner(shot, Value::Null), 1).is_err());
        let text = json!({"data": base64::engine::general_purpose::STANDARD.encode(b"hello"),
            "width": 1, "height": 1});
        assert!(captured(&request(None), &owner(text, Value::Null), 1).is_err());
    }

    #[test]
    fn a_capture_fingerprint_ignores_the_owner_only() {
        let base = request(None);
        let mut restarted = request(None);
        restarted.owner_id = "o2".into();
        assert_eq!(capture_fingerprint(&base), capture_fingerprint(&restarted));
        let mut declined = request(None);
        declined.screenshot = Some(false);
        assert_ne!(capture_fingerprint(&base), capture_fingerprint(&declined));
        assert_eq!(
            capture_fingerprint(&base),
            capture_fingerprint(&request(Some(true)))
        );
        let mut other = request(None);
        other.selector = "h2".into();
        assert_ne!(capture_fingerprint(&base), capture_fingerprint(&other));
    }

    #[test]
    fn an_explicit_partition_extends_the_open_fingerprint_only_when_present() {
        let mut plain = json!(["browser.open", "p", "o", null, "https://a.test/"]);
        let before = plain.clone();
        with_partition(&mut plain, None);
        assert_eq!(plain, before);
        with_partition(&mut plain, Some("work"));
        assert_eq!(plain[5], "work");
    }

    #[test]
    fn record_urls_carry_no_credentials_query_or_fragment() {
        assert!(page_url("https://a.test/@me/page").is_ok());
        for bad in [
            "https://u:p@a.test/",
            "https://a.test/?q=1",
            "https://a.test/#x",
            "file:///etc/hosts",
            "https://",
        ] {
            assert!(page_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn capture_requests_are_bounded() {
        assert!(validate_capture(&request(None)).is_ok());
        let mut bad = request(None);
        bad.capture_id = "a/b".into();
        assert!(validate_capture(&bad).is_err());
        let mut bad = request(None);
        bad.selector = String::new();
        assert!(validate_capture(&bad).is_err());
        let mut bad = request(None);
        bad.tab_id = "../x".into();
        assert!(validate_capture(&bad).is_err());
    }
}
