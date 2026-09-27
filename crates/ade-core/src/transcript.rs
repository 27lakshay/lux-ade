use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
    Abandoned,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanStep {
    pub step: String,
    pub status: StepStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildState {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Interrupted,
    Closed,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Child {
    pub id: String,
    pub session_id: Option<String>,
    pub name: Option<String>,
    pub state: ChildState,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Plan {
        explanation: Option<String>,
        steps: Vec<PlanStep>,
    },
    Tool {
        call_id: String,
        name: String,
        input: Option<serde_json::Value>,
        output: Option<String>,
        is_error: bool,
    },
    Subagents {
        operation: String,
        agents: Vec<Child>,
    },
}

impl Content {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Subagents { operation, agents } => {
                ensure!(
                    !operation.is_empty() && operation.len() <= 256 && agents.len() <= 256,
                    "Invalid subagent operation"
                );
                let mut ids = std::collections::HashSet::new();
                for agent in agents {
                    ensure!(
                        !agent.id.is_empty() && agent.id.len() <= 4096 && ids.insert(&agent.id),
                        "Invalid or duplicate subagent identity"
                    );
                    ensure!(
                        agent
                            .session_id
                            .as_ref()
                            .is_none_or(|s| !s.is_empty() && s.len() <= 4096),
                        "Invalid child session identity"
                    );
                    ensure!(
                        agent.name.as_ref().is_none_or(|s| s.len() <= 256)
                            && agent.summary.as_ref().is_none_or(|s| s.len() <= 16384),
                        "Subagent metadata exceeds content limits"
                    );
                }
            }
            Self::Tool {
                call_id,
                name,
                input,
                output,
                ..
            } => {
                ensure!(
                    !call_id.is_empty()
                        && call_id.len() <= 4096
                        && !name.is_empty()
                        && name.len() <= 256,
                    "Invalid tool identity"
                );
                ensure!(
                    input
                        .as_ref()
                        .is_none_or(|v| v.to_string().len() <= 1024 * 1024),
                    "Tool input exceeds 1 MiB"
                );
                ensure!(
                    output.as_ref().is_none_or(|s| s.len() <= 1024 * 1024),
                    "Tool output exceeds 1 MiB"
                );
            }
            Self::Plan { explanation, steps } => {
                ensure!(steps.len() <= 256, "Plan exceeds 256 steps");
                ensure!(
                    explanation.as_ref().is_none_or(|s| s.len() <= 16384),
                    "Plan explanation exceeds 16 KiB"
                );
                ensure!(
                    steps
                        .iter()
                        .all(|s| !s.step.trim().is_empty() && s.step.len() <= 4096),
                    "Invalid plan step text"
                );
            }
        }
        Ok(())
    }
    pub fn display_text(&self) -> String {
        match self {
            Self::Subagents { operation, agents } => {
                let mut lines = vec![operation.clone()];
                for agent in agents {
                    let state = match agent.state {
                        ChildState::Pending => "Pending",
                        ChildState::Running => "Running",
                        ChildState::Waiting => "Waiting",
                        ChildState::Completed => "Completed",
                        ChildState::Failed => "Failed",
                        ChildState::Interrupted => "Interrupted",
                        ChildState::Closed => "Closed",
                        ChildState::Unknown => "Unknown",
                    };
                    lines.push(format!(
                        "{} · {}",
                        agent.name.as_deref().unwrap_or(&agent.id),
                        state
                    ));
                    if let Some(summary) = &agent.summary {
                        lines.push(summary.clone());
                    }
                }
                lines.join("\n\n")
            }
            Self::Tool {
                name,
                input,
                output,
                is_error,
                ..
            } => {
                let mut parts = vec![format!(
                    "{}{}",
                    name,
                    if *is_error { " · failed" } else { "" }
                )];
                if let Some(input) = input {
                    parts.push(serde_json::to_string_pretty(input).unwrap_or_default());
                }
                if let Some(output) = output {
                    parts.push(output.clone());
                }
                parts.join("\n\n")
            }
            Self::Plan { explanation, steps } => {
                let mut lines = Vec::new();
                if let Some(explanation) = explanation {
                    lines.push(explanation.clone());
                }
                for step in steps {
                    let status = match step.status {
                        StepStatus::Pending => "Pending",
                        StepStatus::InProgress => "In progress",
                        StepStatus::Completed => "Completed",
                        StepStatus::Blocked => "Blocked",
                        StepStatus::Abandoned => "Abandoned",
                    };
                    lines.push(format!("- **{status}** — {}", step.step));
                }
                lines.join("\n\n")
            }
        }
    }
}

/// The most provider text ADE stores for one message, or for one tool's output.
pub const MESSAGE_TEXT_LIMIT: usize = 1024 * 1024;

/// Ends a message ADE cut at [`MESSAGE_TEXT_LIMIT`]. The marker is part of the
/// stored text, so every client shows it and a copy carries it.
pub const TRUNCATION_MARKER: &str =
    "\n\n[ADE truncated this message at 1 MiB. The rest of the provider's output was not stored.]";

/// Whether ADE already cut `text` at the limit.
pub fn is_truncated(text: &str) -> bool {
    text.len() <= MESSAGE_TEXT_LIMIT && text.ends_with(TRUNCATION_MARKER)
}

/// Bounds provider text to [`MESSAGE_TEXT_LIMIT`]: a longer text is cut on a
/// character boundary and ends with [`TRUNCATION_MARKER`]. Bounding the same
/// output again, whole or streamed, yields the same text. Returns whether it cut.
pub fn bound_text(text: &mut String) -> bool {
    if text.len() <= MESSAGE_TEXT_LIMIT {
        return false;
    }
    let mut cut = MESSAGE_TEXT_LIMIT - TRUNCATION_MARKER.len();
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str(TRUNCATION_MARKER);
    true
}

/// Appends one streamed delta. Once the text was cut, later deltas are dropped.
pub fn append_bounded(text: &mut String, delta: &str) {
    if is_truncated(text) {
        return;
    }
    text.push_str(delta);
    bound_text(text);
}

/// Bounds a provider message's text and its tool output. Returns whether either was cut.
pub fn bound_message(text: &mut String, content: &mut Option<Content>) -> bool {
    let mut cut = bound_text(text);
    if let Some(Content::Tool {
        output: Some(output),
        ..
    }) = content
    {
        cut |= bound_text(output);
    }
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_and_whole_output_bound_to_the_same_marked_text() {
        let whole = "ab".repeat(MESSAGE_TEXT_LIMIT);
        let mut once = whole.clone();
        assert!(bound_text(&mut once));
        assert!(once.len() <= MESSAGE_TEXT_LIMIT && is_truncated(&once));
        let mut streamed = String::new();
        for chunk in whole.as_bytes().chunks(65536) {
            append_bounded(&mut streamed, std::str::from_utf8(chunk).unwrap());
        }
        assert_eq!(streamed, once);
        let mut again = once.clone();
        assert!(!bound_text(&mut again));
        append_bounded(&mut again, "late");
        assert_eq!(again, once);
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        let cut = MESSAGE_TEXT_LIMIT - TRUNCATION_MARKER.len();
        let mut text = format!("{}é{}", "a".repeat(cut - 1), "b".repeat(4096));
        assert!(bound_text(&mut text));
        assert_eq!(text, format!("{}{TRUNCATION_MARKER}", "a".repeat(cut - 1)));
    }

    #[test]
    fn short_text_and_tool_output_are_kept_whole() {
        let mut text = "short".to_owned();
        let mut content = Some(Content::Tool {
            call_id: "c".into(),
            name: "tool".into(),
            input: None,
            output: Some("x".repeat(MESSAGE_TEXT_LIMIT + 1)),
            is_error: false,
        });
        assert!(bound_message(&mut text, &mut content));
        assert_eq!(text, "short");
        let Some(Content::Tool {
            output: Some(output),
            ..
        }) = &content
        else {
            panic!("tool content");
        };
        assert!(is_truncated(output));
        assert!(content.as_ref().unwrap().validate().is_ok());
    }
}
