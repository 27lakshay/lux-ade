//! Pure cores for prompt context capture (F033) and provider attachment plans
//! (F032): bounding captured text, rendering a provenance-headed document,
//! and deciding, before dispatch, how each provider receives an attachment.
//!
//! The provider table mirrors the bridges that actually encode prompts:
//! `providers/claude/bridge.mjs`, `crates/ade-runtime/src/codex.rs`,
//! `providers/opencode/session-api.mjs` and `providers/omp/admission.mjs`.
//! Change both together.
use crate::contract::context::{
    PartForm, PlanRejection, PlannedPart, ProviderMediaSupport, RejectionCode,
};
use crate::prompt::Prompt;
use anyhow::{Result, bail, ensure};

/// The most text a client may supply for one capture, before bounding.
pub const CLIENT_TEXT_LIMIT: usize = 1024 * 1024;
/// The most captured body a node keeps, after bounding.
pub const BODY_LIMIT: usize = 256 * 1024;
/// The most lines a node keeps.
pub const LINE_LIMIT: u64 = 5000;

/// Which end of an over-long selection to keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// Files and diffs: the start matters.
    Head,
    /// Terminal and log output: the most recent lines matter.
    Tail,
}

/// A body cut to its bounds, with what was cut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bounded {
    pub text: String,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
}

impl Bounded {
    pub fn truncated(&self) -> bool {
        self.omitted_bytes > 0 || self.omitted_lines > 0
    }
}

/// Removes terminal escape sequences and control characters other than
/// newline and tab, and turns CRLF and lone CR into newlines. Captured
/// terminal text is then plain text a model can read.
pub fn plain_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                // CSI: parameters and intermediates, then one final byte.
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC, DCS, APC, PM and SOS end at BEL or ST (ESC \).
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // A two-character escape such as ESC = or ESC ( B.
                Some(_) => {
                    let next = chars.next();
                    if matches!(next, Some('(' | ')' | '*' | '+' | '#' | '%')) {
                        chars.next();
                    }
                }
                None => {}
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            // C1 CSI introducer, as a single code point.
            '\u{9b}' => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Lines of `text`, splitting on `\n` only. A final newline does not start
/// another line.
fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n').collect()
}

/// A selected line range and the source's line count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub text: String,
    pub start_line: u64,
    pub end_line: u64,
    pub total_lines: u64,
}

/// Selects lines `start` to `end`, 1-based and inclusive. A range that starts
/// past the end of the text fails; an end past it is clamped. A range longer
/// than [`LINE_LIMIT`] fails rather than silently shortening the request.
pub fn select_lines(text: &str, start: u64, end: u64) -> Result<Selection> {
    ensure!(
        start >= 1 && end >= start,
        "Line range must start at 1 or later and not end before it starts"
    );
    ensure!(
        end - start < LINE_LIMIT,
        "Capture at most {LINE_LIMIT} lines at a time"
    );
    let all = lines(text);
    let total = all.len() as u64;
    ensure!(
        start <= total,
        "The file has {total} lines; line {start} does not exist"
    );
    let end = end.min(total);
    let mut selected = all[(start - 1) as usize..end as usize].join("\n");
    selected.push('\n');
    Ok(Selection {
        text: selected,
        start_line: start,
        end_line: end,
        total_lines: total,
    })
}

/// Keeps the last `count` lines of `text`.
pub fn tail_lines(text: &str, count: u64) -> Bounded {
    let all = lines(text);
    let keep = (count.min(LINE_LIMIT) as usize).min(all.len());
    let omitted = all.len() - keep;
    let mut kept = all[omitted..].join("\n");
    if keep > 0 {
        kept.push('\n');
    }
    let omitted_bytes = all[..omitted].iter().map(|l| l.len() as u64 + 1).sum();
    Bounded {
        text: kept,
        omitted_bytes,
        omitted_lines: omitted as u64,
    }
}

/// Cuts `text` to at most `limit` bytes and [`LINE_LIMIT`] lines on line
/// boundaries where possible and always on a character boundary, keeping
/// the chosen end.
pub fn bound(text: &str, limit: usize, keep: Keep) -> Bounded {
    let all = lines(text);
    let mut kept_lines: Vec<&str> = Vec::new();
    let mut used = 0usize;
    let mut partial: Option<String> = None;
    let ordered: Box<dyn Iterator<Item = &&str>> = match keep {
        Keep::Head => Box::new(all.iter()),
        Keep::Tail => Box::new(all.iter().rev()),
    };
    for line in ordered {
        if kept_lines.len() as u64 >= LINE_LIMIT {
            break;
        }
        let cost = line.len() + 1;
        if used + cost <= limit {
            used += cost;
            kept_lines.push(line);
            continue;
        }
        // The first line that does not fit is kept in part only when no whole
        // line fits, so a single enormous line still yields something.
        if kept_lines.is_empty() && limit > 1 {
            let room = limit - 1;
            let cut = match keep {
                Keep::Head => {
                    let mut at = room.min(line.len());
                    while !line.is_char_boundary(at) {
                        at -= 1;
                    }
                    line[..at].to_owned()
                }
                Keep::Tail => {
                    let mut at = line.len().saturating_sub(room);
                    while !line.is_char_boundary(at) {
                        at += 1;
                    }
                    line[at..].to_owned()
                }
            };
            used = cut.len() + 1;
            partial = Some(cut);
        }
        break;
    }
    let whole = kept_lines.len();
    let mut pieces: Vec<&str> = kept_lines;
    if let Some(cut) = partial.as_deref() {
        pieces.push(cut);
    }
    if keep == Keep::Tail {
        pieces.reverse();
    }
    let mut out = pieces.join("\n");
    if !pieces.is_empty() {
        out.push('\n');
    }
    let original = all.iter().map(|l| l.len() as u64 + 1).sum::<u64>();
    let consumed = whole + usize::from(partial.is_some());
    Bounded {
        omitted_bytes: original.saturating_sub(used as u64),
        omitted_lines: (all.len() - consumed) as u64,
        text: out,
    }
}

/// A Markdown code fence longer than any backtick run inside `body`.
pub fn fence(body: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

/// The document a text node stores: a provenance header, a truncation line
/// when bounds cut the selection, then the body in a fence.
pub fn render(title: &str, facts: &[(&str, String)], body: &Bounded) -> String {
    let mut out = format!("ADE context: {title}\n");
    for (label, value) in facts {
        out.push_str(&format!("{label}: {}\n", one_line(value)));
    }
    if body.truncated() {
        out.push_str(&format!(
            "Truncated: {} lines and {} bytes were left out to stay within ADE's bounds\n",
            body.omitted_lines, body.omitted_bytes
        ));
    }
    let fence = fence(&body.text);
    out.push_str(&format!("{fence}\n{}{fence}\n", body.text));
    out
}

fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// A valid attachment name: no control characters, at most 255 bytes, and
/// ending in `.txt`.
pub fn attachment_name(stem: &str) -> String {
    let mut clean: String = stem
        .chars()
        .map(|c| if c.is_control() || c == '/' { '_' } else { c })
        .collect();
    let mut limit = 255 - ".txt".len();
    while clean.len() > limit {
        while !clean.is_char_boundary(limit) {
            limit -= 1;
        }
        clean.truncate(limit);
    }
    if clean.trim().is_empty() {
        clean = "context".into();
    }
    format!("{clean}.txt")
}

const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
const ATTACHED: &str = "Attached file ";

/// The Claude API's 10 MB base64 per-image limit, as raw bytes.
const CLAUDE_IMAGE_BYTES: u64 = 10_000_000 / 4 * 3;
/// Oh My Pi 18.3.0 `MAX_RPC_FRAME_BYTES`: one prompt frame, JSON and newline.
const OMP_FRAME_BYTES: u64 = 1024 * 1024;

/// What `provider` accepts. An unknown provider is a generic adapter whose
/// handshake decides at dispatch.
pub fn media_support(provider: &str) -> ProviderMediaSupport {
    let strings = |values: &[&str]| values.iter().map(|s| (*s).to_owned()).collect();
    let ade = crate::prompt::ATTACHMENT_LIMIT as u64;
    let known = |image_form: &str, text_form: &str, image: u64, request: Option<u64>, sources| {
        ProviderMediaSupport {
            provider: provider.to_owned(),
            known: true,
            image_types: strings(IMAGE_TYPES),
            image_form: Some(image_form.into()),
            text_form: Some(text_form.into()),
            max_image_bytes: Some(image),
            max_request_bytes: request,
            sources,
        }
    };
    match provider {
        "claude" => known(
            "Anthropic image content block, base64 source",
            "text content block",
            CLAUDE_IMAGE_BYTES,
            Some(ade),
            strings(&[
                "platform.claude.com/docs/en/build-with-claude/vision: JPEG, PNG, GIF and WebP; 10 MB base64 per image on the Claude API; 8000x8000 px",
                "ADE: 8 MiB of attachments per prompt",
            ]),
        ),
        "codex" => known(
            "Codex UserInput image with a data URL",
            "Codex UserInput text item",
            ade,
            Some(ade),
            strings(&[
                "developers.openai.com/api/docs/guides/images-vision: PNG, JPEG, WEBP and non-animated GIF; 512 MB per request",
                "ADE: 8 MiB of attachments per prompt",
            ]),
        ),
        "opencode" => known(
            "OpenCode file part with a data URI",
            "appended to the prompt text",
            ade,
            Some(ade),
            strings(&[
                "providers/opencode/session-api.mjs: images as file parts, text appended",
                "ADE: 8 MiB of attachments per prompt",
            ]),
        ),
        "omp" => known(
            "Oh My Pi RPC prompt image",
            "appended to the prompt text",
            ade,
            Some(OMP_FRAME_BYTES),
            strings(&[
                "@oh-my-pi/pi-coding-agent 18.3.0 MAX_RPC_FRAME_BYTES: 1 MiB per prompt frame, base64 images included",
            ]),
        ),
        _ => ProviderMediaSupport {
            provider: provider.to_owned(),
            known: false,
            image_types: Vec::new(),
            image_form: None,
            text_form: None,
            max_image_bytes: None,
            max_request_bytes: None,
            sources: strings(&[
                "The adapter's own handshake; it refuses undeclared attachment kinds at dispatch",
            ]),
        },
    }
}

/// A provider plan: each attachment's form and every refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub support: ProviderMediaSupport,
    pub parts: Vec<PlannedPart>,
    pub rejections: Vec<PlanRejection>,
}

fn base64_len(bytes: u64) -> u64 {
    bytes.div_ceil(3) * 4
}

/// Oh My Pi's prompt frame exactly as `providers/omp/admission.mjs` builds
/// it, measured the way its transport does.
fn omp_frame_bytes(prompt: &Prompt) -> Result<u64> {
    use base64::Engine;
    let mut parts = vec![prompt.text.clone()];
    let mut images = Vec::new();
    for content in &prompt.attachments {
        if content.attachment.media_type.starts_with("image/") {
            images.push(serde_json::json!({"type":"image","mimeType":content.attachment.media_type,"data":content.data}));
        } else {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&content.data)?;
            parts.push(format!(
                "{ATTACHED}{}:\n{}",
                content.attachment.name,
                String::from_utf8(bytes)?
            ));
        }
    }
    let mut frame = serde_json::json!({"message": parts.join("\n\n")});
    if !images.is_empty() {
        frame["images"] = serde_json::Value::Array(images);
    }
    frame["type"] = "prompt".into();
    // The turn ID is a UUID the bridge chooses at dispatch.
    frame["id"] = "00000000-0000-0000-0000-000000000000".into();
    Ok(serde_json::to_string(&frame)?.len() as u64 + 1)
}

/// How `provider` would receive `prompt`, and what it would refuse, decided
/// before dispatch.
pub fn plan(provider: &str, prompt: &Prompt) -> Plan {
    let support = media_support(provider);
    let mut parts = Vec::new();
    let mut rejections = Vec::new();
    let reject = |id: Option<&str>, code, message: String| PlanRejection {
        attachment_id: id.map(str::to_owned),
        code,
        message,
    };
    for content in &prompt.attachments {
        let attachment = &content.attachment;
        let id = attachment.id.as_str();
        if !support.known {
            parts.push(PlannedPart {
                attachment_id: id.into(),
                form: PartForm::AdapterDeclared,
                text_prefix: None,
            });
            continue;
        }
        if attachment.media_type.starts_with("image/") {
            if !support.image_types.contains(&attachment.media_type) {
                rejections.push(reject(
                    Some(id),
                    RejectionCode::UnsupportedMediaType,
                    format!(
                        "{} does not accept {} images",
                        support.provider, attachment.media_type
                    ),
                ));
                continue;
            }
            if let Some(limit) = support.max_image_bytes
                && attachment.size as u64 > limit
            {
                rejections.push(reject(
                    Some(id),
                    RejectionCode::ImageTooLarge,
                    format!(
                        "{} is {} bytes; {} accepts images up to {limit} bytes",
                        attachment.name, attachment.size, support.provider
                    ),
                ));
                continue;
            }
            parts.push(PlannedPart {
                attachment_id: id.into(),
                form: PartForm::NativeImage,
                text_prefix: None,
            });
        } else if attachment.media_type == "text/plain" {
            let (form, prefix) = match provider {
                "opencode" | "omp" => (
                    PartForm::PromptText,
                    format!("\n\n{ATTACHED}{}:\n", attachment.name),
                ),
                _ => (
                    PartForm::TextBlock,
                    format!("{ATTACHED}{}:\n", attachment.name),
                ),
            };
            parts.push(PlannedPart {
                attachment_id: id.into(),
                form,
                text_prefix: Some(prefix),
            });
        } else {
            rejections.push(reject(
                Some(id),
                RejectionCode::UnsupportedMediaType,
                format!(
                    "{} does not accept {} attachments",
                    support.provider, attachment.media_type
                ),
            ));
        }
    }
    if provider == "omp" && !prompt.attachments.is_empty() {
        let limit = OMP_FRAME_BYTES;
        match omp_frame_bytes(prompt) {
            Ok(bytes) if bytes <= limit => {}
            Ok(bytes) => rejections.push(reject(
                None,
                RejectionCode::RequestTooLarge,
                format!(
                    "The prompt frame would be {bytes} bytes; Oh My Pi accepts at most {limit}"
                ),
            )),
            Err(error) => rejections.push(reject(
                None,
                RejectionCode::UnsupportedMediaType,
                format!("An attachment could not be encoded for Oh My Pi: {error}"),
            )),
        }
    } else if let Some(limit) = support.max_request_bytes {
        let images: u64 = prompt
            .attachments
            .iter()
            .filter(|c| c.attachment.media_type.starts_with("image/"))
            .map(|c| base64_len(c.attachment.size as u64))
            .sum();
        let text: u64 = prompt
            .attachments
            .iter()
            .filter(|c| !c.attachment.media_type.starts_with("image/"))
            .map(|c| c.attachment.size as u64)
            .sum();
        let raw: u64 = prompt
            .attachments
            .iter()
            .map(|c| c.attachment.size as u64)
            .sum();
        // ADE's own per-prompt limit counts raw bytes; report it as such.
        if raw > limit {
            rejections.push(reject(
                None,
                RejectionCode::RequestTooLarge,
                format!(
                    "Attachments total {raw} bytes ({} encoded); the limit is {limit}",
                    images + text
                ),
            ));
        }
    }
    Plan {
        support,
        parts,
        rejections,
    }
}

/// Refuses, before dispatch, a prompt the provider would refuse.
pub fn admit(provider: &str, prompt: &Prompt) -> Result<()> {
    let plan = plan(provider, prompt);
    if plan.rejections.is_empty() {
        return Ok(());
    }
    let reasons: Vec<_> = plan.rejections.iter().map(|r| r.message.as_str()).collect();
    bail!("Attachment refused before sending: {}", reasons.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Attachment;
    use crate::prompt::Content;

    fn content(id: &str, media_type: &str, size: usize) -> Content {
        use base64::Engine;
        let bytes = vec![b'a'; size];
        Content {
            attachment: Attachment {
                id: id.into(),
                name: format!("{id}.bin"),
                media_type: media_type.into(),
                size,
            },
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    fn prompt(attachments: Vec<Content>) -> Prompt {
        Prompt {
            text: "Look".into(),
            attachments,
        }
    }

    #[test]
    fn plain_text_strips_escapes_and_normalizes_newlines() {
        let raw = "\u{1b}[1;31mred\u{1b}[0m\r\nnext\rover\u{1b}]0;title\u{7}\tend\u{1b}(Bok\u{0}";
        assert_eq!(plain_text(raw), "red\nnext\nover\tendok");
        assert_eq!(
            plain_text("a\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\b"),
            "alinkb"
        );
    }

    #[test]
    fn select_lines_is_inclusive_and_clamps_the_end() {
        let s = select_lines("one\ntwo\nthree\n", 2, 9).unwrap();
        assert_eq!(s.text, "two\nthree\n");
        assert_eq!((s.start_line, s.end_line, s.total_lines), (2, 3, 3));
        assert!(select_lines("one\n", 2, 2).is_err());
        assert!(select_lines("one\n", 0, 1).is_err());
        assert!(select_lines("one\n", 3, 2).is_err());
        assert!(select_lines("x", 1, LINE_LIMIT + 1).is_err());
        assert_eq!(select_lines("a\r\nb", 1, 1).unwrap().text, "a\r\n");
    }

    #[test]
    fn tail_lines_keeps_the_most_recent() {
        let b = tail_lines("1\n2\n3\n4\n", 2);
        assert_eq!(b.text, "3\n4\n");
        assert_eq!((b.omitted_lines, b.omitted_bytes), (2, 4));
        assert_eq!(tail_lines("1\n", 5).text, "1\n");
        assert_eq!(tail_lines("", 5).text, "");
    }

    #[test]
    fn bound_keeps_whole_lines_from_the_chosen_end() {
        let text = "aaaa\nbbbb\ncccc\n";
        let head = bound(text, 10, Keep::Head);
        assert_eq!(head.text, "aaaa\nbbbb\n");
        assert_eq!((head.omitted_lines, head.omitted_bytes), (1, 5));
        let tail = bound(text, 10, Keep::Tail);
        assert_eq!(tail.text, "bbbb\ncccc\n");
        let whole = bound(text, 100, Keep::Head);
        assert_eq!(whole.text, text);
        assert!(!whole.truncated());
    }

    #[test]
    fn bound_cuts_one_long_line_on_a_character_boundary() {
        let text = "ééééé";
        let head = bound(text, 6, Keep::Head);
        assert_eq!(head.text, "éé\n");
        assert!(head.truncated());
        let tail = bound(text, 6, Keep::Tail);
        assert_eq!(tail.text, "éé\n");
        assert!(head.text.len() <= 6 && tail.text.len() <= 6);
    }

    #[test]
    fn render_fences_past_any_backtick_run_and_states_truncation() {
        let body = Bounded {
            text: "```rust\nx\n```\n".into(),
            omitted_bytes: 3,
            omitted_lines: 1,
        };
        let doc = render("file range", &[("Path", "a\nb".into())], &body);
        assert!(
            doc.starts_with("ADE context: file range\nPath: a b\nTruncated: 1 lines and 3 bytes")
        );
        assert!(doc.contains("````\n```rust\nx\n```\n````\n"));
        assert_eq!(fence("plain"), "```");
    }

    #[test]
    fn attachment_names_are_bounded_and_clean() {
        assert_eq!(attachment_name("src/a.rs L1-2"), "src_a.rs L1-2.txt");
        assert_eq!(attachment_name("\n"), "_.txt");
        assert_eq!(attachment_name(""), "context.txt");
        let long = attachment_name(&"é".repeat(300));
        assert!(long.len() <= 255 && long.ends_with(".txt"));
    }

    #[test]
    fn plan_maps_each_provider_to_its_native_form() {
        let p = prompt(vec![
            content("img", "image/png", 10),
            content("txt", "text/plain", 4),
        ]);
        let claude = plan("claude", &p);
        assert!(claude.rejections.is_empty());
        assert_eq!(claude.parts[0].form, PartForm::NativeImage);
        assert_eq!(claude.parts[1].form, PartForm::TextBlock);
        assert_eq!(
            claude.parts[1].text_prefix.as_deref(),
            Some("Attached file txt.bin:\n")
        );
        let opencode = plan("opencode", &p);
        assert_eq!(opencode.parts[1].form, PartForm::PromptText);
        assert_eq!(
            opencode.parts[1].text_prefix.as_deref(),
            Some("\n\nAttached file txt.bin:\n")
        );
        assert_eq!(plan("codex", &p).parts[1].form, PartForm::TextBlock);
        assert_eq!(plan("omp", &p).parts[1].form, PartForm::PromptText);
        let adapter = plan("acp-agent", &p);
        assert!(!adapter.support.known);
        assert!(
            adapter
                .parts
                .iter()
                .all(|p| p.form == PartForm::AdapterDeclared)
        );
        assert!(admit("acp-agent", &p).is_ok());
    }

    #[test]
    fn plan_refuses_what_the_provider_documents_it_refuses() {
        let big = prompt(vec![content("big", "image/png", 7_600_000)]);
        let claude = plan("claude", &big);
        assert_eq!(claude.rejections[0].code, RejectionCode::ImageTooLarge);
        assert!(admit("claude", &big).is_err());
        assert!(admit("codex", &big).is_ok());
        let omp = plan("omp", &prompt(vec![content("a", "image/png", 800_000)]));
        assert_eq!(omp.rejections[0].code, RejectionCode::RequestTooLarge);
        assert!(omp.rejections[0].attachment_id.is_none());
        assert!(admit("omp", &prompt(vec![content("a", "image/png", 700_000)])).is_ok());
        let odd = prompt(vec![content("x", "image/bmp", 4)]);
        assert_eq!(
            plan("codex", &odd).rejections[0].code,
            RejectionCode::UnsupportedMediaType
        );
        assert!(admit("claude", &prompt(Vec::new())).is_ok());
    }
}
