//! Pure pieces shared by the native session importers: the history item
//! model, line splitting, bounded text, timestamps and the re-import decider.
//! Nothing here reads files or touches SQLite.
use crate::transcript::Content;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The most text one imported message keeps. Longer text is cut with a
/// visible marker, never silently.
pub const TEXT_LIMIT: usize = 256 * 1024;
/// The most tool input or output one imported tool message keeps.
pub const TOOL_LIMIT: usize = 64 * 1024;
const TITLE_LIMIT: usize = 120;

/// One ADE history item read from a native record.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// Stable within the native session: a native record ID or line ordinal,
    /// plus a block index when one record yields several items.
    pub key: String,
    pub role: &'static str,
    pub kind: &'static str,
    pub text: String,
    pub content: Option<Content>,
}

/// What a native session file yields.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// The newest record timestamp, in milliseconds since the Unix epoch.
    pub last_at: Option<i64>,
    pub items: Vec<Item>,
    /// Readers refuse a projected page when a record would require truncation.
    pub budget_exceeded: bool,
    /// Complete lines that were not valid JSON records.
    pub skipped: u64,
    /// The file ended in a line without a newline, which was not read.
    pub incomplete_tail: bool,
}

impl Parsed {
    pub fn saw_time(&mut self, record: &Value) {
        if let Some(at) = record["timestamp"].as_str().and_then(rfc3339_ms) {
            self.last_at = Some(self.last_at.map_or(at, |last| last.max(at)));
        }
    }

    /// Uses the first user prompt as the title when the store named none.
    pub fn finish(mut self) -> Self {
        if self.title.is_none() {
            self.title = self
                .items
                .iter()
                .find(|item| item.role == "user" && item.kind == "text")
                .and_then(|item| title(&item.text));
        }
        self
    }

    /// Adds a tool call. Its output arrives later through [`Self::tool_output`].
    pub fn tool(&mut self, key: String, call_id: &str, name: &str, input: Option<Value>) {
        if call_id.len() > 4096
            || name.len() > 256
            || input.as_ref().is_some_and(|value| {
                crate::json_budget::encoded_size(value).map_or(true, |bytes| bytes > TOOL_LIMIT)
            })
        {
            self.budget_exceeded = true;
            return;
        }
        let content = Content::Tool {
            call_id: bounded(if call_id.is_empty() { &key } else { call_id }, 4096),
            name: bounded(if name.is_empty() { "tool" } else { name }, 256),
            input,
            output: None,
            is_error: false,
        };
        self.items.push(Item {
            key,
            role: "tool",
            kind: "tool",
            text: content.display_text(),
            content: Some(content),
        });
    }

    /// Attaches a result to the latest tool call with this call ID. A result
    /// with no matching call becomes its own tool message so it is not lost.
    pub fn tool_output(&mut self, key: String, call_id: &str, output: &str, is_error: bool) {
        if output.len() > TOOL_LIMIT {
            self.budget_exceeded = true;
            return;
        }
        let found = self.items.iter().rposition(|item| {
            matches!(&item.content, Some(Content::Tool { call_id: id, .. }) if id == call_id)
        });
        let index = match found {
            Some(index) if !call_id.is_empty() => index,
            _ => {
                self.tool(key, call_id, "tool result", None);
                self.items.len() - 1
            }
        };
        let item = &mut self.items[index];
        if let Some(Content::Tool {
            output: slot,
            is_error: failed,
            ..
        }) = &mut item.content
        {
            *slot = Some(truncate(output, TOOL_LIMIT));
            *failed = is_error;
        }
        item.text = truncate(
            &item
                .content
                .as_ref()
                .map(Content::display_text)
                .unwrap_or_default(),
            TEXT_LIMIT,
        );
    }

    pub fn text(&mut self, key: String, role: &'static str, kind: &'static str, text: &str) {
        if text.len() > TEXT_LIMIT {
            self.budget_exceeded = true;
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        self.items.push(Item {
            key,
            role,
            kind,
            text: truncate(text, TEXT_LIMIT),
            content: None,
        });
    }

    /// Records a native construct ADE does not model yet, so the history
    /// shows that something was there rather than hiding it.
    pub fn unrecognized(&mut self, key: String, provider: &str, kind: &str) {
        let kind = bounded(kind, 128);
        self.text(
            key,
            "tool",
            "unrecognized",
            &format!("Unrecognized {provider} record ({kind}). A newer ADE importer may show it."),
        );
    }
}

/// The complete lines of a JSONL file with their zero-based ordinals, and
/// whether a final line lacked its newline (a record still being written).
pub fn complete_lines(text: &str) -> (Vec<(usize, &str)>, bool) {
    let mut lines: Vec<(usize, &str)> = text.split('\n').enumerate().collect();
    let tail = lines.pop().is_some_and(|(_, last)| !last.trim().is_empty());
    lines.retain(|(_, line)| !line.trim().is_empty());
    (lines, tail)
}

/// Cuts `text` to at most `limit` bytes on a character boundary and says so.
pub fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[ADE import kept the first {end} of {} bytes]",
        &text[..end],
        text.len()
    )
}

fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// The first non-empty line of a prompt, shortened for a title.
pub fn title(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut title: String = line.chars().take(TITLE_LIMIT).collect();
    if line.chars().count() > TITLE_LIMIT {
        title.push('…');
    }
    Some(title)
}

/// Joins the text parts of a content array: plain strings, or objects with a
/// `text` field whose type is text-like. Images become a visible placeholder.
pub fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.clone()),
                _ => match part["type"].as_str().unwrap_or("") {
                    "text" | "input_text" | "output_text" => {
                        part["text"].as_str().map(str::to_owned)
                    }
                    "image" | "input_image" => Some("[image]".into()),
                    _ => None,
                },
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Parses an RFC 3339 UTC or offset timestamp to milliseconds since the Unix
/// epoch. Returns none for anything else rather than guessing.
pub fn rfc3339_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let kept = &fraction[..digits.min(3)];
        millis = kept.parse::<i64>().ok()? * 10_i64.pow(3 - kept.len() as u32);
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && matches!(&rest[..1], "+" | "-") && &rest[3..4] == ":" => {
            let hours: i64 = rest[1..3].parse().ok()?;
            let minutes: i64 = rest[4..6].parse().ok()?;
            let total = (hours * 60 + minutes) * 60_000;
            if rest.starts_with('-') { -total } else { total }
        }
        _ => return None,
    };
    // Days from civil, after Howard Hinnant's public-domain algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis - offset)
}

/// Fingerprints the identity of imported items. Tool results are left out,
/// because a native session writes them after the call and a re-import may
/// legitimately fill them in.
pub fn digest(items: &[Item]) -> String {
    let mut hash = Sha256::new();
    for item in items {
        let identity = match &item.content {
            Some(Content::Tool {
                call_id,
                name,
                input,
                ..
            }) => format!(
                "{call_id}\u{0}{name}\u{0}{}",
                input.as_ref().unwrap_or(&Value::Null)
            ),
            _ => item.text.clone(),
        };
        for part in [item.key.as_str(), item.role, item.kind, identity.as_str()] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
    }
    format!("{:x}", hash.finalize())
}

/// What an earlier import of the same native session recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prior {
    pub workspace_id: String,
    pub item_count: usize,
    pub digest: String,
}

/// What an import request should do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Create the conversation with every item.
    Create,
    /// Rewrite the first `known` items in place (to fill in tool results) and
    /// append the rest.
    Extend {
        known: usize,
    },
    Refuse(String),
}

/// Decides an import against the prior import, if any. Only a native history
/// that still starts with exactly what was imported may be extended; anything
/// else (a rewind, a rewritten file, another workspace) is refused, so ADE
/// never shows a mix of two different histories.
pub fn plan(prior: Option<&Prior>, workspace_id: &str, items: &[Item]) -> Plan {
    let Some(prior) = prior else {
        if items.is_empty() {
            return Plan::Refuse("The native session has no messages to import yet".into());
        }
        return Plan::Create;
    };
    if prior.workspace_id != workspace_id {
        return Plan::Refuse(format!(
            "This native session is already imported into workspace {}",
            prior.workspace_id
        ));
    }
    if items.len() < prior.item_count || digest(&items[..prior.item_count]) != prior.digest {
        return Plan::Refuse(
            "The native session no longer extends the imported history (it was rewound or \
             rewritten); ADE kept the earlier import unchanged"
                .into(),
        );
    }
    Plan::Extend {
        known: prior.item_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, text: &str) -> Item {
        Item {
            key: key.into(),
            role: "user",
            kind: "text",
            text: text.into(),
            content: None,
        }
    }

    #[test]
    fn timestamps_parse_utc_offsets_and_fractions() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            rfc3339_ms("2026-09-06T13:36:02.049Z"),
            Some(1_788_701_762_049)
        );
        assert_eq!(
            rfc3339_ms("2026-09-06T15:36:02.0491+02:00"),
            Some(1_788_701_762_049)
        );
        assert_eq!(rfc3339_ms("2000-02-29T00:00:00.5Z"), Some(951_782_400_500));
        for bad in [
            "",
            "2026-09-06",
            "2026-13-01T00:00:00Z",
            "2026-09-06T13:36:02",
            "x".repeat(24).as_str(),
        ] {
            assert_eq!(rfc3339_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_line_without_its_newline_is_left_for_later() {
        let (lines, tail) = complete_lines("{\"a\":1}\n\n{\"b\":2}\n{\"c\"");
        assert_eq!(lines, vec![(0, "{\"a\":1}"), (2, "{\"b\":2}")]);
        assert!(tail);
        let (lines, tail) = complete_lines("{\"a\":1}\n");
        assert_eq!(lines.len(), 1);
        assert!(!tail);
    }

    #[test]
    fn truncation_is_visible_and_keeps_characters_whole() {
        let cut = truncate("ééé", 3);
        assert!(cut.starts_with("é\n[ADE import kept the first 2 of 6 bytes]"));
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn tool_results_fill_the_matching_call_and_orphans_are_kept() {
        let mut parsed = Parsed::default();
        parsed.tool(
            "a".into(),
            "call_1",
            "Bash",
            Some(serde_json::json!({"command": "ls"})),
        );
        parsed.tool_output("b".into(), "call_1", "file.txt", false);
        parsed.tool_output("c".into(), "call_9", "lost", true);
        assert_eq!(parsed.items.len(), 2);
        assert!(parsed.items[0].text.contains("file.txt"));
        assert!(matches!(
            &parsed.items[1].content,
            Some(Content::Tool { output: Some(out), is_error: true, .. }) if out == "lost"
        ));
    }

    #[test]
    fn reimport_extends_only_an_unchanged_prefix() {
        let first = vec![item("1", "hello"), item("2", "again")];
        assert_eq!(plan(None, "w", &first), Plan::Create);
        assert!(matches!(plan(None, "w", &[]), Plan::Refuse(_)));
        let prior = Prior {
            workspace_id: "w".into(),
            item_count: 2,
            digest: digest(&first),
        };
        let mut longer = first.clone();
        longer.push(item("3", "more"));
        assert_eq!(plan(Some(&prior), "w", &longer), Plan::Extend { known: 2 });
        assert_eq!(plan(Some(&prior), "w", &first), Plan::Extend { known: 2 });
        assert!(matches!(
            plan(Some(&prior), "other", &longer),
            Plan::Refuse(_)
        ));
        let rewound = vec![item("1", "hello"), item("2b", "different")];
        assert!(matches!(plan(Some(&prior), "w", &rewound), Plan::Refuse(_)));
        assert!(matches!(
            plan(Some(&prior), "w", &first[..1]),
            Plan::Refuse(_)
        ));
    }

    #[test]
    fn a_late_tool_result_does_not_count_as_divergence() {
        let mut before = Parsed::default();
        before.tool("t".into(), "c", "Read", None);
        let mut after = before.clone();
        after.tool_output(String::new(), "c", "contents", false);
        assert_eq!(digest(&before.items), digest(&after.items));
    }
}
