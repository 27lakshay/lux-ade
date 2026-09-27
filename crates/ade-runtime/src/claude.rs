//! Claude's official SDK lives in an owned sidecar; its protocol never reaches Sessions.
use crate::{
    model::PendingRequest,
    provider::{self, Config, Connected, Event, Provider},
    rpc::Rpc,
};
use ade_core::model::AccountExecution;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    process::Command,
    sync::{Arc, mpsc},
};
pub struct Adapter {
    rpc: Arc<Rpc>,
    /// The `mcpServers` map from the profile MCP catalog (F131).
    mcp_servers: std::sync::Mutex<Option<Value>>,
}
impl Adapter {
    pub fn spawn(
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        let executable = account
            .map(provider::account_probe::verify_launch)
            .transpose()?;
        let mut command = if let Ok(mock) = std::env::var("ADE_CLAUDE_BRIDGE_BIN") {
            Command::new(mock)
        } else {
            let mut c =
                Command::new(std::env::var("ADE_NODE_BIN").unwrap_or_else(|_| "node".into()));
            c.arg(std::env::var("ADE_CLAUDE_BRIDGE").unwrap_or_else(|_| {
                ade_platform::resources::resource("providers/claude/bridge.mjs")
                    .to_string_lossy()
                    .into_owned()
            }));
            c
        };
        command.current_dir(cwd);
        if let (Some(account), Some(executable)) = (account, executable.as_deref()) {
            provider::account_probe::managed_environment(
                &mut command,
                &account.native_home,
                executable,
            );
        }
        Ok(Arc::new(Self {
            rpc: Rpc::spawn(command, events, provider::bridge_event)?,
            mcp_servers: std::sync::Mutex::new(None),
        }))
    }
}
impl Provider for Adapter {
    fn child_transcript(
        &self,
        session: &str,
        child: &str,
        offset: u64,
        cursor: Option<&str>,
    ) -> Result<Value> {
        self.rpc.request(
            "child_transcript",
            json!({"session":session,"child":child,"offset":offset,"cursor":cursor}),
        )
    }
    fn pid(&self) -> Option<u32> {
        Some(self.rpc.pid())
    }
    /// The bridge passes the map as the Agent SDK's `mcpServers` query option.
    fn configure_mcp(&self, servers: Value) -> Result<()> {
        ensure!(servers.is_object(), "Claude MCP servers must be an object");
        *self.mcp_servers.lock().unwrap() = Some(servers);
        Ok(())
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        let servers = self.mcp_servers.lock().unwrap().clone();
        let Some(servers) = servers else {
            return provider::response_session(&self.rpc, resume, config);
        };
        let result = self.rpc.request(
            "open",
            json!({"resume":resume,"config":config,"mcp_servers":servers}),
        )?;
        let connected: Connected = serde_json::from_value(result)?;
        ensure!(
            resume.is_none_or(|id| id == connected.session),
            "Provider resumed a different session; original identity retained"
        );
        Ok(connected)
    }
    fn send(
        &self,
        session: &str,
        submission: &str,
        message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        self.rpc.request(
            "send",
            json!({"session":session,"submission":submission,"message_id":message_id,"text":prompt.text,"attachments":prompt.attachments}),
        )?["turn"]
            .as_str()
            .map(str::to_owned)
            .context("Claude omitted turn ID")
    }
    fn cancel(&self, session: &str, turn: &str) -> Result<()> {
        self.rpc
            .request("cancel", json!({"session":session,"turn":turn}))?;
        Ok(())
    }
    /// Agent SDK 0.3.281: the bridge restarts its query with `resume` and
    /// `resumeSessionAt` set to the last chain entry before `turn`, the
    /// prompt UUID that started it.
    fn rewind(&self, session: &str, turn: &str, _operation: &str) -> Result<()> {
        self.rpc
            .request("rewind", json!({"session":session,"drop_from":turn}))?;
        Ok(())
    }
    fn prepare_submission(&self) -> Option<String> {
        Some(uuid::Uuid::new_v4().to_string())
    }
    fn validate_answer(
        &self,
        p: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        ensure!(
            ["accept", "decline", "answer"].contains(&decision),
            "Unknown decision"
        );
        if p.method == "claude/questions" {
            ensure!(
                decision == "answer" || decision == "decline",
                "Answer the questions or decline"
            );
            if decision == "answer" {
                for q in p.params["questions"]
                    .as_array()
                    .context("Malformed Claude questions")?
                {
                    let id = q["id"].as_str().context("Missing question ID")?;
                    ensure!(
                        answers
                            .and_then(|v| v[id].as_str())
                            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16384),
                        "Answer required for {id}"
                    );
                }
            }
        } else {
            ensure!(decision != "answer", "Choose accept or decline");
        }
        Ok(())
    }
    fn answer(&self, p: &PendingRequest, decision: &str, answers: Option<&Value>) -> Result<()> {
        self.validate_answer(p, decision, answers)?;
        self.rpc.request(
            "answer",
            json!({"id":p.rpc_id,"decision":decision,"answers":answers}),
        )?;
        Ok(())
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.rpc.request(
            "answer",
            json!({"id":id,"decision":"decline","reason":message}),
        )?;
        Ok(())
    }
    fn stop(&self) {
        self.rpc.stop();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.rpc.stop_confirmed()
    }
}

/// Checked against `@anthropic-ai/claude-agent-sdk` 0.3.281 (`sdk.d.ts`) and
/// the Claude Code 2.1.x range the account probe validates.
pub fn capabilities() -> crate::capabilities::CapabilityRecord {
    use crate::capabilities::*;
    use Support::*;
    CapabilityRecord {
        provider: "claude".into(),
        name: "Claude Code".into(),
        revision: 1,
        fingerprint: String::new(),
        checked_against: "@anthropic-ai/claude-agent-sdk 0.3.281; Claude Code 2.1.x".into(),
        models: ModelCapabilities {
            selection: capability(Supported, "The bridge passes the model option to the SDK"),
            format: ModelFormat::NativeId,
            aliases: strings(&["default", "sonnet", "opus", "haiku", "opusplan"]),
            discovery: capability(
                NativeOnly,
                "Query.supportedModels() lists them; the bridge does not call it",
            ),
        },
        reasoning: ReasoningCapabilities {
            selection: capability(
                NativeOnly,
                "The SDK effort option; ADE launches do not carry a reasoning level yet",
            ),
            levels: strings(&["low", "medium", "high", "xhigh", "max"]),
            varies_by_model: true,
        },
        permission_modes: vec![
            mode("default", Supported, "Ask before tools that need approval"),
            mode(
                "plan",
                Supported,
                "Plan without editing files or running tools",
            ),
            mode("acceptEdits", Supported, "Approve file edits automatically"),
            mode(
                "dontAsk",
                Supported,
                "Deny anything not already allowed, without asking",
            ),
            mode(
                "bypassPermissions",
                NativeOnly,
                "Skip every permission check; ADE does not offer it",
            ),
            mode(
                "auto",
                NativeOnly,
                "A classifier decides approvals; ADE does not offer it",
            ),
        ],
        grants: GrantCapabilities {
            once: capability(Supported, "Accept answers one canUseTool request"),
            session: capability(
                NativeOnly,
                "updatedPermissions with the session destination; ADE never sends it",
            ),
            persistent: capability(
                NativeOnly,
                "updatedPermissions saved to settings files; ADE never sends it",
            ),
        },
        conversation: ConversationCapabilities {
            steering: capability(
                NativeOnly,
                "Streaming input accepts messages during a turn; ADE queues prompts until the turn settles",
            ),
            rewind: capability(
                NativeOnly,
                "Query.rewindFiles() restores files to a user message",
            ),
            compaction: capability(NativeOnly, "The /compact command"),
            resume: capability(
                Supported,
                "The SDK resume option with the native session ID",
            ),
            import: capability(
                Supported,
                "history.import reads native transcripts; imported sessions are not resumed automatically",
            ),
            fork: capability(NativeOnly, "The forkSession option"),
            account_switch: capability(
                Unknown,
                "No in-session account switch is documented; a native session belongs to one config directory",
            ),
        },
        quota: capability(
            Supported,
            "rate_limit_event messages, recorded by the usage domain",
        ),
        managed_accounts: capability(Supported, "One CLAUDE_CONFIG_DIR per account"),
    }
}

/// The Claude Code CLI the SDK drives, and Node for the bridge.
pub const INSTALLATION: &[crate::capabilities::Executable] = &[
    crate::capabilities::Executable {
        check: "executable:claude",
        env: "ADE_CLAUDE_BIN",
        default: Some("claude"),
        used_by: crate::capabilities::UsedBy::Every,
    },
    crate::capabilities::Executable {
        check: "runtime:node",
        env: "ADE_NODE_BIN",
        default: Some("node"),
        used_by: crate::capabilities::UsedBy::Every,
    },
];
