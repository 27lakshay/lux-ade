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
