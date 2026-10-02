//! Parses a Codex rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`)
//! into ADE history items. Each line is `{timestamp, type, payload}`; the
//! first `session_meta` names the session. `response_item` lines carry the
//! conversation; `event_msg` lines repeat it for live clients and are not
//! imported twice. Rollouts written before the `payload` envelope put the
//! item at the top level, and both shapes are read.
//!
//! Items are keyed by line ordinal. Codex appends to a rollout, so ordinals
//! stay stable; a rewritten file fails the re-import prefix check instead.
use super::parse::{Parsed, complete_lines, content_text};
use serde_json::Value;
use std::collections::HashMap;

const PROVIDER: &str = "Codex";

pub fn parse(text: &str) -> Parsed {
    let (lines, incomplete_tail) = complete_lines(text);
    let mut parsed = Parsed {
        incomplete_tail,
        ..Parsed::default()
    };
    for (ordinal, line) in lines {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            parsed.skipped += 1;
            continue;
        };
        if !record.is_object() {
            parsed.skipped += 1;
            continue;
        }
        parsed.saw_time(&record);
        let key = format!("line:{ordinal}");
        let enveloped = record["payload"].is_object();
        let (kind, item) = if enveloped {
            (record["type"].as_str().unwrap_or(""), &record["payload"])
        } else {
            ("response_item", &record)
        };
        match kind {
            "session_meta" => meta(&mut parsed, item),
            // A pre-envelope rollout opens with a bare metadata object.
            "response_item" if !enveloped && record.get("type").is_none() => {
                meta(&mut parsed, item)
            }
            "response_item" => response_item(&mut parsed, key, item),
            "compacted" => {
                let summary = item["message"].as_str().unwrap_or("").trim();
                let text = if summary.is_empty() {
                    "Context compacted".to_owned()
                } else {
                    format!("Context compacted\n\n{summary}")
                };
                parsed.text(key, "system", "compaction", &text);
            }
            // Turn context, token counts, events that mirror response items,
            // world state and other session metadata.
            _ => {}
        }
    }
    parsed.finish()
}

/// Only the first metadata record names this session. A forked sub-agent
/// rollout repeats its parent's metadata after its own.
fn meta(parsed: &mut Parsed, meta: &Value) {
    if parsed.session_id.is_some() {
        return;
    }
    parsed.session_id = meta["id"].as_str().map(str::to_owned);
    parsed.cwd = meta["cwd"].as_str().map(str::to_owned);
}

fn response_item(parsed: &mut Parsed, key: String, item: &Value) {
    match item["type"].as_str().unwrap_or("") {
        "message" => {
            let role = match item["role"].as_str() {
                Some("user") => "user",
                Some("assistant") => "assistant",
                // Developer and system messages are instructions, not history.
                _ => return,
            };
            let content = &item["content"];
            let parts = content
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_else(|| std::slice::from_ref(content));
            for (index, part) in parts.iter().enumerate() {
                let text = match part {
                    Value::String(text) => text.clone(),
                    _ => match part["type"].as_str().unwrap_or("") {
                        "text" | "input_text" | "output_text" => {
                            part["text"].as_str().unwrap_or("").to_owned()
                        }
                        "image" | "input_image" => "[image]".into(),
                        _ => continue,
                    },
                };
                let kind = if role == "user" && injected(&text) {
                    "context"
                } else {
                    "text"
                };
                parsed.text(format!("{key}:{index}"), role, kind, &text);
            }
        }
        // Native reasoning is private and never enters shared history.
        "reasoning" | "ghost_snapshot" | "compaction" => {}
        "function_call" => {
            let arguments = item["arguments"].as_str().unwrap_or("");
            if !crate::json_budget::within_budget(arguments.as_bytes(), super::parse::TOOL_LIMIT) {
                parsed.budget_exceeded = true;
                return;
            }
            let input = serde_json::from_str(arguments)
                .unwrap_or_else(|_| Value::String(arguments.to_owned()));
            let name = match item["namespace"].as_str() {
                Some(namespace) if !namespace.is_empty() => {
                    format!("{namespace}.{}", item["name"].as_str().unwrap_or("tool"))
                }
                _ => item["name"].as_str().unwrap_or("tool").to_owned(),
            };
            parsed.tool(key, call_id(item), &name, Some(input));
        }
        "custom_tool_call" => parsed.tool(
            key,
            call_id(item),
            item["name"].as_str().unwrap_or("tool"),
            item.get("input").cloned(),
        ),
        "local_shell_call" => parsed.tool(key, call_id(item), "shell", item.get("action").cloned()),
        "web_search_call" => parsed.tool(
            key,
            call_id(item),
            "web_search",
            item.get("action").cloned(),
        ),
        kind if kind.ends_with("_call_output") => {
            let output = &item["output"];
            let text = match output {
                Value::String(text) => text.clone(),
                Value::Array(_) => content_text(output),
                Value::Object(fields) if fields.contains_key("content") => {
                    content_text(&output["content"])
                }
                Value::Null => String::new(),
                other => other.to_string(),
            };
            parsed.tool_output(key, call_id(item), &text, output["success"] == false);
        }
        "agent_message" => {
            let header = format!(
                "{} → {}",
                item["author"].as_str().unwrap_or("agent"),
                item["recipient"].as_str().unwrap_or("agent")
            );
            let body = content_text(&item["content"]);
            parsed.text(
                key,
                "assistant",
                "agent_message",
                &format!("{header}\n{body}"),
            );
        }
        other => parsed.unrecognized(key, PROVIDER, other),
    }
}

fn call_id(item: &Value) -> &str {
    item["call_id"]
        .as_str()
        .or_else(|| item["id"].as_str())
        .unwrap_or("")
}

/// Context Codex injects as a user message: repository instructions, or one
/// block wrapped in a single tag such as `<environment_context>`.
fn injected(text: &str) -> bool {
    let text = text.trim();
    if text.starts_with("# AGENTS.md instructions") {
        return true;
    }
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    let tag: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    !tag.is_empty() && text.ends_with(&format!("</{tag}>"))
}

/// Thread names from `<CODEX_HOME>/session_index.jsonl`; a later line for the
/// same session wins.
pub fn index_titles(text: &str) -> HashMap<String, String> {
    let (lines, _) = complete_lines(text);
    lines
        .into_iter()
        .filter_map(|(_, line)| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| {
            let name = entry["thread_name"].as_str()?.trim();
            let id = entry["id"].as_str()?;
            (!name.is_empty()).then(|| (id.to_owned(), name.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::Content;

    // Trimmed from a Codex CLI rollout of September 2026: a sub-agent fork
    // with its own and its parent's metadata, injected context, a prompt, a
    // reasoning item, a tool call with its output, an answer and a compaction.
    const ROLLOUT: &str = r#"{"timestamp":"2026-09-06T13:36:02.049Z","type":"session_meta","payload":{"id":"01a076ee-e1bb-71a1-9a20-d12ac6dc30ea","cwd":"/repo","forked_from_id":"01a0766c-355a-7993-95b2-df3ed30f9513"}}
{"timestamp":"2026-09-06T13:36:02.049Z","type":"session_meta","payload":{"id":"01a0766c-355a-7993-95b2-df3ed30f9513","cwd":"/elsewhere"}}
{"timestamp":"2026-09-06T13:36:03.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"sandbox rules"}]}}
{"timestamp":"2026-09-06T13:36:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"},{"type":"input_text","text":"why is CI red?"}]}}
{"timestamp":"2026-09-06T13:36:03.100Z","type":"event_msg","payload":{"type":"user_message","message":"why is CI red?"}}
{"timestamp":"2026-09-06T13:36:04.000Z","type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"x"}}
{"timestamp":"2026-09-06T13:36:05.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"gh run list\"}","call_id":"call_1"}}
{"timestamp":"2026-09-06T13:36:06.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"failed: lint"}}
{"timestamp":"2026-09-06T13:36:07.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Lint fails."}]}}
{"timestamp":"2026-09-06T13:36:08.000Z","type":"compacted","payload":{"message":"","replacement_history":[]}}
"#;

    #[test]
    fn a_rollout_becomes_prompt_tool_and_answer() {
        let parsed = parse(ROLLOUT);
        assert_eq!(
            parsed.session_id.as_deref(),
            Some("01a076ee-e1bb-71a1-9a20-d12ac6dc30ea")
        );
        assert_eq!(parsed.cwd.as_deref(), Some("/repo"));
        assert_eq!(parsed.title.as_deref(), Some("why is CI red?"));
        let shape: Vec<_> = parsed
            .items
            .iter()
            .map(|item| (item.key.as_str(), item.role, item.kind))
            .collect();
        assert_eq!(
            shape,
            [
                ("line:3:0", "user", "context"),
                ("line:3:1", "user", "text"),
                ("line:6", "tool", "tool"),
                ("line:8:0", "assistant", "text"),
                ("line:9", "system", "compaction"),
            ]
        );
        assert!(matches!(
            &parsed.items[2].content,
            Some(Content::Tool { name, input: Some(input), output: Some(out), .. })
                if name == "exec_command" && input["cmd"] == "gh run list" && out == "failed: lint"
        ));
    }

    #[test]
    fn a_pre_envelope_rollout_and_unknown_items_are_read_visibly() {
        let text = "{\"id\":\"old-session\",\"timestamp\":\"2025-04-01T00:00:00Z\",\"instructions\":null}\n{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}\n{\"type\":\"future_item\"}\n[1]\n";
        let parsed = parse(text);
        assert_eq!(parsed.session_id.as_deref(), Some("old-session"));
        assert_eq!(parsed.skipped, 1);
        let kinds: Vec<_> = parsed.items.iter().map(|item| item.kind).collect();
        assert_eq!(kinds, ["text", "unrecognized"]);
    }

    #[test]
    fn thread_names_use_the_latest_entry() {
        let titles = index_titles(
            "{\"id\":\"a\",\"thread_name\":\"old\"}\n{\"id\":\"a\",\"thread_name\":\"new\"}\n{\"id\":\"b\",\"thread_name\":\" \"}\n",
        );
        assert_eq!(titles.get("a").map(String::as_str), Some("new"));
        assert!(!titles.contains_key("b"));
    }
}
