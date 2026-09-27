//! Parses a Claude Code session transcript
//! (`<config dir>/projects/<project>/<session id>.jsonl`) into ADE history
//! items. Claude Code documents the location and says the record format is
//! internal and changes between versions, so every unknown record is either
//! metadata ADE ignores or a visible "unrecognized" item, never a guess.
//!
//! The file keeps every branch a rewind left behind. Records link to their
//! parent by `parentUuid` (and across a compaction by `logicalParentUuid`);
//! the importer keeps only the branch that ends at the newest message, the
//! history Claude Code itself would resume.
use super::parse::{Parsed, complete_lines, content_text};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const PROVIDER: &str = "Claude Code";

pub fn parse(text: &str) -> Parsed {
    let (lines, incomplete_tail) = complete_lines(text);
    let mut parsed = Parsed {
        incomplete_tail,
        ..Parsed::default()
    };
    let mut records = Vec::new();
    for (ordinal, line) in lines {
        match serde_json::from_str::<Value>(line) {
            Ok(record) if record.is_object() => records.push((ordinal, record)),
            _ => parsed.skipped += 1,
        }
    }
    let active = active_branch(&records);
    let (mut custom, mut generated, mut summary) = (None, None, None);
    for (ordinal, record) in &records {
        parsed.saw_time(record);
        if parsed.session_id.is_none() {
            parsed.session_id = text_field(record, "sessionId");
        }
        if parsed.cwd.is_none() {
            parsed.cwd = text_field(record, "cwd");
        }
        match record["type"].as_str().unwrap_or("") {
            "custom-title" => custom = text_field(record, "customTitle").or(custom),
            "ai-title" => generated = text_field(record, "aiTitle").or(generated),
            "summary" => summary = text_field(record, "summary").or(summary),
            kind @ ("user" | "assistant" | "system") => {
                if record["isSidechain"] == true || record["isMeta"] == true {
                    continue;
                }
                let uuid = record["uuid"].as_str();
                if let (Some(active), Some(uuid)) = (&active, uuid)
                    && !active.contains(uuid)
                {
                    continue;
                }
                let key = uuid.map_or_else(|| format!("line:{ordinal}"), str::to_owned);
                message(&mut parsed, key, kind, record);
            }
            // Snapshots, attachments, modes, costs and other session metadata.
            _ => {}
        }
    }
    parsed.title = custom.or(generated).or(summary);
    parsed.finish()
}

fn text_field(record: &Value, field: &str) -> Option<String> {
    record[field]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

/// A record's parent: `Some(None)` for a root, which records an explicit null
/// `parentUuid` and no logical parent; `None` when the record does not say.
fn parent(record: &Value) -> Option<Option<&str>> {
    match &record["parentUuid"] {
        Value::String(parent) => Some(Some(parent)),
        Value::Null if record.get("parentUuid").is_some() => {
            Some(record["logicalParentUuid"].as_str())
        }
        _ => None,
    }
}

/// The UUIDs on the branch that ends at the newest main-thread message, or
/// none when the chain cannot be followed to its root. Without a complete
/// chain the importer keeps every message instead of dropping real history.
fn active_branch(records: &[(usize, Value)]) -> Option<HashSet<String>> {
    let parents: HashMap<&str, Option<Option<&str>>> = records
        .iter()
        .filter_map(|(_, record)| Some((record["uuid"].as_str()?, parent(record))))
        .collect();
    let leaf = records.iter().rev().find_map(|(_, record)| {
        let conversational = matches!(record["type"].as_str(), Some("user" | "assistant"));
        (conversational && record["isSidechain"] != true)
            .then(|| record["uuid"].as_str())
            .flatten()
    })?;
    let mut branch = HashSet::new();
    let mut current = Some(leaf);
    while let Some(uuid) = current {
        if !branch.insert(uuid.to_owned()) {
            return None;
        }
        current = (*parents.get(uuid)?)?;
    }
    Some(branch)
}

fn message(parsed: &mut Parsed, key: String, kind: &str, record: &Value) {
    if kind == "system" {
        if record["subtype"] == "compact_boundary" {
            parsed.text(key, "system", "compaction", "Context compacted");
        }
        return;
    }
    let content = &record["message"]["content"];
    if kind == "user" && record["isCompactSummary"] == true {
        parsed.text(key, "system", "compaction_summary", &content_text(content));
        return;
    }
    let role = if kind == "user" { "user" } else { "assistant" };
    let Some(blocks) = content.as_array() else {
        parsed.text(key, role, "text", &content_text(content));
        return;
    };
    for (index, block) in blocks.iter().enumerate() {
        let key = format!("{key}:{index}");
        match block["type"].as_str().unwrap_or("") {
            "text" => parsed.text(key, role, "text", block["text"].as_str().unwrap_or("")),
            "image" | "document" if role == "user" => {
                parsed.text(
                    key,
                    role,
                    "text",
                    &format!("[{}]", block["type"].as_str().unwrap_or("")),
                );
            }
            // Native reasoning is private and never enters shared history.
            "thinking" | "redacted_thinking" => {}
            "tool_use" | "server_tool_use" | "mcp_tool_use" => parsed.tool(
                key,
                block["id"].as_str().unwrap_or(""),
                block["name"].as_str().unwrap_or("tool"),
                block.get("input").cloned(),
            ),
            kind if kind.ends_with("tool_result") => parsed.tool_output(
                key,
                block["tool_use_id"].as_str().unwrap_or(""),
                &match &block["content"] {
                    Value::String(_) | Value::Array(_) => content_text(&block["content"]),
                    Value::Null => String::new(),
                    other => other.to_string(),
                },
                block["is_error"] == true,
            ),
            other => parsed.unrecognized(key, PROVIDER, other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::transcript::Content;

    // Trimmed from a Claude Code 2.x transcript: metadata records, a prompt,
    // a thinking block, a tool call and its result, and a final answer.
    const SESSION: &str = r#"{"type":"mode","mode":"default","sessionId":"effc8dc5-4adb-433e-9f12-25c6a7dd1c5b"}
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"sessionId":"effc8dc5-4adb-433e-9f12-25c6a7dd1c5b","cwd":"/repo","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"Fix the flaky test"}}
{"type":"user","uuid":"m1","parentUuid":"u1","isMeta":true,"isSidechain":false,"timestamp":"2026-09-01T10:00:00.100Z","message":{"role":"user","content":"<local-command-caveat>ignored</local-command-caveat>"}}
{"type":"assistant","uuid":"a1","parentUuid":"m1","isSidechain":false,"timestamp":"2026-09-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-09-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pnpm test"}}]}}
{"type":"user","uuid":"r1","parentUuid":"a2","isSidechain":false,"timestamp":"2026-09-01T10:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"1 failed","is_error":true}]}}
{"type":"file-history-snapshot","messageId":"x","snapshot":{}}
{"type":"assistant","uuid":"a3","parentUuid":"r1","isSidechain":false,"timestamp":"2026-09-01T10:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"The test races the clock."}]}}
{"type":"ai-title","aiTitle":"Fix flaky test","sessionId":"effc8dc5-4adb-433e-9f12-25c6a7dd1c5b"}
"#;

    #[test]
    fn a_transcript_becomes_prompt_tool_and_answer() {
        let parsed = parse(SESSION);
        assert_eq!(
            parsed.session_id.as_deref(),
            Some("effc8dc5-4adb-433e-9f12-25c6a7dd1c5b")
        );
        assert_eq!(parsed.cwd.as_deref(), Some("/repo"));
        assert_eq!(parsed.title.as_deref(), Some("Fix flaky test"));
        assert_eq!(
            parsed.last_at,
            super::super::parse::rfc3339_ms("2026-09-01T10:00:04Z")
        );
        assert!(!parsed.incomplete_tail);
        assert_eq!(parsed.skipped, 0);
        let shape: Vec<_> = parsed
            .items
            .iter()
            .map(|item| (item.key.as_str(), item.role, item.kind))
            .collect();
        assert_eq!(
            shape,
            [
                ("u1", "user", "text"),
                ("a2:0", "tool", "tool"),
                ("a3:0", "assistant", "text"),
            ]
        );
        assert!(matches!(
            &parsed.items[1].content,
            Some(Content::Tool { name, output: Some(out), is_error: true, .. })
                if name == "Bash" && out == "1 failed"
        ));
    }

    #[test]
    fn a_rewound_branch_is_left_out() {
        let text = r#"{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"s","message":{"content":"first"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"content":[{"type":"text","text":"old answer"}]}}
{"type":"user","uuid":"u2","parentUuid":null,"message":{"content":"edited prompt"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"content":[{"type":"text","text":"new answer"}]}}
"#;
        let texts: Vec<_> = parse(text)
            .items
            .into_iter()
            .map(|item| item.text)
            .collect();
        assert_eq!(texts, ["edited prompt", "new answer"]);
    }

    #[test]
    fn a_compaction_is_followed_through_its_logical_parent() {
        let text = r#"{"type":"user","uuid":"u1","parentUuid":null,"message":{"content":"before"}}
{"type":"system","subtype":"compact_boundary","uuid":"b1","parentUuid":null,"logicalParentUuid":"u1"}
{"type":"user","uuid":"s1","parentUuid":"b1","isCompactSummary":true,"message":{"content":"summary of before"}}
{"type":"user","uuid":"u2","parentUuid":"s1","message":{"content":"after"}}
"#;
        let shape: Vec<_> = parse(text)
            .items
            .into_iter()
            .map(|item| (item.kind, item.text))
            .collect();
        assert_eq!(
            shape,
            [
                ("text", "before".to_owned()),
                ("compaction", "Context compacted".to_owned()),
                ("compaction_summary", "summary of before".to_owned()),
                ("text", "after".to_owned()),
            ]
        );
    }

    #[test]
    fn a_broken_chain_keeps_everything_and_bad_lines_are_counted() {
        let text = "{\"type\":\"user\",\"uuid\":\"u1\",\"parentUuid\":\"missing\",\"message\":{\"content\":\"kept\"}}\nnot json\n{\"type\":\"user\",\"uuid\":\"u0\",\"parentUuid\":null,\"message\":{\"content\":\"also kept\"}}\n{\"type\":\"assistant\",\"uuid\":\"a9\",\"message\":{\"content\":[{\"type\":\"future_block\"}]}}\n{\"type\":\"user\"";
        let parsed = parse(text);
        assert_eq!(parsed.skipped, 1);
        assert!(parsed.incomplete_tail);
        let kinds: Vec<_> = parsed.items.iter().map(|item| item.kind).collect();
        assert_eq!(kinds, ["text", "text", "unrecognized"]);
        assert_eq!(parsed.title.as_deref(), Some("kept"));
    }
}
