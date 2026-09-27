use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
/// Only UI-reviewed choices are translated into provider replies. No global
/// policy edits or account changes are made by this adapter.
pub fn approval_result(
    method: &str,
    params: &Value,
    decision: &str,
    answers: Option<&Value>,
) -> Result<Value> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            ensure!(
                matches!(decision, "accept" | "decline" | "cancel"),
                "Choose accept, decline, or cancel"
            );
            if let Some(available) = params["availableDecisions"].as_array() {
                ensure!(
                    available.iter().any(|v| v.as_str() == Some(decision)),
                    "Decision is not offered by Codex"
                );
            }
            Ok(json!({"decision":decision}))
        }
        "item/permissions/requestApproval" => {
            ensure!(
                matches!(decision, "accept" | "decline"),
                "Choose accept or decline"
            );
            Ok(
                json!({"permissions":if decision == "accept" { params["permissions"].clone() } else { json!({}) },"scope":"turn"}),
            )
        }
        "item/tool/requestUserInput" => {
            ensure!(decision == "answer", "Answer the questions");
            let answers = answers
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("Answers are required"))?;
            let mut result = serde_json::Map::new();
            for q in params["questions"]
                .as_array()
                .ok_or_else(|| anyhow!("Invalid question payload"))?
            {
                let id = q["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Missing question ID"))?;
                let values = match answers.get(id) {
                    Some(Value::String(text)) => vec![text.as_str()],
                    Some(Value::Array(values)) if q["multiSelect"] == true => values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .ok_or_else(|| anyhow!("Invalid answer for {id}"))
                        })
                        .collect::<Result<Vec<_>>>()?,
                    _ => bail!("Answer required for {id}"),
                };
                ensure!(
                    !values.is_empty() && values.iter().all(|text| !text.trim().is_empty()),
                    "Answer required for {id}"
                );
                ensure!(
                    values
                        .iter()
                        .fold(0usize, |bytes, text| bytes.saturating_add(text.len()))
                        <= 16 * 1024,
                    "Answer is too long"
                );
                result.insert(id.into(), json!({"answers":values}));
            }
            Ok(json!({"answers":result}))
        }
        _ => bail!("This Codex request is not supported: {method}"),
    }
}

use crate::{
    model::PendingRequest,
    provider::{Config, Connected, Event, Item, Provider},
    rpc::{Rpc, WireEvent},
};
use ade_core::model::{AccountExecution, CodexIdentity};
use std::{
    process::Command,
    sync::{Arc, Mutex, mpsc},
};
/// Whether a launch runs on the shared app-server transport, which Bun
/// serves. A managed-account launch, and any launch with
/// `ADE_CODEX_TRANSPORT=stdio`, runs the Codex CLI directly.
pub fn shared_transport(managed: bool) -> bool {
    !managed && std::env::var("ADE_CODEX_TRANSPORT").as_deref() != Ok("stdio")
}
pub struct Adapter {
    rpc: Arc<Rpc>,
    cwd: String,
    socket_directory: Option<std::path::PathBuf>,
    session: Mutex<Option<String>>,
    identity: Option<CodexIdentity>,
    /// The `mcp_servers` table from the profile MCP catalog (F131).
    mcp_servers: Mutex<Option<Value>>,
}
impl Adapter {
    pub fn spawn(
        cwd: &str,
        account: Option<&AccountExecution>,
        events: mpsc::SyncSender<Event>,
    ) -> Result<Arc<Self>> {
        let managed_executable = account
            .map(crate::provider::codex_probe::verify_launch)
            .transpose()?;
        let shared = shared_transport(managed_executable.is_some());
        let socket_directory = shared.then(|| {
            std::path::PathBuf::from(format!("/tmp/ade-codex-{}", uuid::Uuid::new_v4().simple()))
        });
        if let Some(directory) = &socket_directory {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(directory)?;
        }
        let mut command = if shared {
            let mut command =
                Command::new(std::env::var("ADE_BUN_BIN").unwrap_or_else(|_| "bun".into()));
            command.arg(ade_platform::resources::resource(
                "providers/codex/shared-server.mjs",
            ));
            command
        } else {
            let mut command = Command::new(
                managed_executable
                    .as_deref()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        std::env::var("ADE_CODEX_BIN").unwrap_or_else(|_| "codex".into())
                    }),
            );
            command.args(["app-server", "--listen", "stdio://"]);
            if let Some(account) = account {
                crate::provider::codex_probe::managed_environment(
                    &mut command,
                    &account.native_home,
                    managed_executable
                        .as_deref()
                        .context("Managed Codex executable missing")?,
                );
            }
            command
        };
        command.current_dir(cwd);
        if let Some(directory) = &socket_directory {
            command.env("ADE_CODEX_SOCKET_DIR", directory);
        }
        let rpc = match Rpc::spawn(command, events, decode) {
            Ok(rpc) => rpc,
            Err(error) => {
                if let Some(directory) = &socket_directory {
                    let _ = std::fs::remove_dir(directory);
                }
                return Err(error);
            }
        };
        Ok(Arc::new(Self {
            rpc,
            cwd: cwd.into(),
            socket_directory,
            session: Mutex::new(None),
            identity: account.and_then(|value| value.codex_identity.clone()),
            mcp_servers: Mutex::new(None),
        }))
    }
}
impl Provider for Adapter {
    fn child_transcript(
        &self,
        _session: &str,
        child: &str,
        offset: u64,
        cursor: Option<&str>,
    ) -> Result<Value> {
        ensure!(
            cursor.is_none() && offset <= 100_000,
            "Codex child reader requires a valid item offset"
        );
        let result = self
            .rpc
            .request("thread/read", json!({"threadId":child,"includeTurns":true}))?;
        child_page(&result, child, offset)
    }
    fn pid(&self) -> Option<u32> {
        Some(self.rpc.pid())
    }
    /// Codex 0.157.0 `thread/start` and `thread/resume` take `config`, which
    /// overrides `config.toml` keys for the thread; each server goes in as
    /// its own `mcp_servers.<name>` key (see `mcp_overrides`).
    fn configure_mcp(&self, servers: Value) -> Result<()> {
        ensure!(servers.is_object(), "Codex MCP servers must be a table");
        *self.mcp_servers.lock().unwrap() = Some(servers);
        Ok(())
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        self.rpc.request(
            "initialize",
            json!({"clientInfo":{"name":"ade","title":"lux-ade","version":"0.3.0"},
                "capabilities": if self.identity.is_some() { json!({"experimentalApi":true}) } else { json!({}) }}),
        )?;
        self.rpc.notify("initialized", json!({}))?;
        if let Some(expected) = &self.identity {
            let config = self
                .rpc
                .request("config/read", json!({"includeLayers":false}))?;
            ensure!(
                crate::provider::codex_probe::effective_config_supported(&config),
                "Codex effective configuration may override file credentials"
            );
            let account = self
                .rpc
                .request("account/read", json!({"refreshToken":false}))?;
            ensure!(
                crate::provider::codex_probe::readback_identity(&account)? == *expected,
                "Codex account identity changed before opening the session"
            );
        }
        let mut params = json!({"cwd":self.cwd,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":if config.permission_mode=="read-only" {"read-only"}else{"workspace-write"}});
        if let Some(model) = &config.model {
            params["model"] = json!(model);
        }
        if let Some(servers) = self.mcp_servers.lock().unwrap().clone() {
            params["config"] = mcp_overrides(&servers);
        }
        let method = if let Some(session) = resume {
            params["threadId"] = json!(session);
            "thread/resume"
        } else {
            "thread/start"
        };
        let result = self.rpc.request(method, params)?;
        let session = result["thread"]["id"]
            .as_str()
            .ok_or_else(|| anyhow!("Codex omitted session ID"))?
            .to_owned();
        ensure!(
            resume.is_none_or(|id| id == session),
            "Codex resumed another session; original identity retained"
        );
        let mut history = Vec::new();
        for turn in result["thread"]["turns"].as_array().into_iter().flatten() {
            for value in turn["items"].as_array().into_iter().flatten() {
                if let Some(mut item) =
                    item(value, turn["id"].as_str(), turn["status"] == "completed")
                {
                    if turn["status"] != "completed" && item.role != "user" {
                        item.status = "interrupted".into();
                    }
                    history.push(item);
                }
            }
        }
        *self.session.lock().unwrap() = Some(session.clone());
        Ok(Connected {
            session,
            history,
            rewound_from: None,
        })
    }
    fn send(
        &self,
        session: &str,
        submission: &str,
        _message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        if let Some(expected) = &self.identity {
            let config = self
                .rpc
                .request("config/read", json!({"includeLayers":false}))?;
            ensure!(
                crate::provider::codex_probe::effective_config_supported(&config),
                "Codex effective configuration may override file credentials"
            );
            let account = self
                .rpc
                .request("account/read", json!({"refreshToken":false}))?;
            ensure!(
                crate::provider::codex_probe::readback_identity(&account)? == *expected,
                "Codex account identity changed before starting a turn"
            );
        }
        let input = user_input(prompt)?;
        let r = self.rpc.request(
            "turn/start",
            json!({"threadId":session,"clientUserMessageId":submission,"input":input}),
        )?;
        r["turn"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("Codex omitted turn ID"))
    }
    fn cancel(&self, session: &str, turn: &str) -> Result<()> {
        self.rpc
            .request("turn/interrupt", json!({"threadId":session,"turnId":turn}))?;
        Ok(())
    }
    /// Codex 0.157.0 `turn/steer`: the request fails unless `expectedTurnId`
    /// is the active turn, and the reply names the turn that took the input.
    fn steer(
        &self,
        session: &str,
        turn: &str,
        message_id: &str,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        let r = self.rpc.request(
            "turn/steer",
            json!({"threadId":session,"expectedTurnId":turn,"clientUserMessageId":message_id,"input":user_input(prompt)?}),
        )?;
        r["turnId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("Codex omitted the steered turn ID"))
    }
    /// Codex 0.157.0 `thread/compact/start`: an empty reply acknowledges the
    /// start; a `contextCompaction` item reports the result.
    fn compact(&self, session: &str, _operation: &str) -> Result<()> {
        self.rpc
            .request("thread/compact/start", json!({"threadId":session}))?;
        Ok(())
    }
    fn validate_answer(
        &self,
        p: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        approval_result(&p.method, &p.params, decision, answers)?;
        Ok(())
    }
    fn answer(&self, p: &PendingRequest, decision: &str, answers: Option<&Value>) -> Result<()> {
        self.rpc.respond(
            p.rpc_id.clone(),
            approval_result(&p.method, &p.params, decision, answers)?,
        )
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        self.rpc.reject(id, message)
    }
    fn stop(&self) {
        let _ = self.stop_confirmed();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.rpc.stop_confirmed()?;
        if let Some(directory) = &self.socket_directory {
            // Rpc kills the entire owned process group. The relay cannot run
            // its finally cleanup after SIGKILL, so its owner removes only
            // these two known paths after confirmed process termination.
            let _ = std::fs::remove_file(directory.join("control.sock"));
            let _ = std::fs::remove_dir(directory);
        }
        Ok(())
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.stop_confirmed();
    }
}

fn child_page(result: &Value, child: &str, offset: u64) -> Result<Value> {
    ensure!(
        result["thread"]["id"].as_str() == Some(child),
        "Codex returned a different child thread"
    );
    let turns = result["thread"]["turns"]
        .as_array()
        .ok_or_else(|| anyhow!("Codex omitted child turns"))?;
    let mut items = Vec::new();
    let mut position = 0_u64;
    let mut bytes = 0;
    let mut more = false;
    'turns: for turn in turns {
        for value in turn["items"]
            .as_array()
            .ok_or_else(|| anyhow!("Codex omitted child items"))?
        {
            // Use the same public-content projection as the parent transcript;
            // reasoning items remain excluded. Reading never resumes a thread.
            if let Some(projected) = item(value, turn["id"].as_str(), turn["status"] == "completed")
            {
                position += 1;
                if position <= offset {
                    continue;
                }
                if items.len() == 50 {
                    more = true;
                    break 'turns;
                }
                if let Some(content) = &projected.content {
                    content.validate()?;
                }
                bytes += serde_json::to_vec(&projected)?.len();
                ensure!(
                    bytes <= 2 * 1024 * 1024,
                    "Codex child page exceeds display limits"
                );
                items.push(projected);
            }
        }
    }
    Ok(
        json!({"type":"child_transcript","child_id":child,"items":items,"next_offset":if more {Some(offset+50)} else {None}}),
    )
}
fn decode(wire: WireEvent) -> Result<Option<Event>> {
    let text = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_owned();
    let event = match wire {
        WireEvent::Request(id, method, params) => {
            let supported = matches!(
                method.as_str(),
                "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/permissions/requestApproval"
                    | "item/tool/requestUserInput"
            );
            Event::Request {
                session: text(&params, "threadId"),
                turn: text(&params, "turnId"),
                id,
                method,
                params,
                supported,
            }
        }
        WireEvent::Notification(method, p) => match method.as_str() {
            "turn/plan/updated" => {
                let content = crate::transcript::Content::Plan {
                    explanation: p["explanation"].as_str().map(str::to_owned),
                    steps: serde_json::from_value(p["plan"].clone())?,
                };
                content.validate()?;
                Event::Item {
                    session: text(&p, "threadId"),
                    item: Item {
                        id: format!("{}:plan", text(&p, "turnId")),
                        client_id: None,
                        turn: p["turnId"].as_str().map(str::to_owned),
                        role: "assistant".into(),
                        kind: "plan".into(),
                        text: content.display_text(),
                        status: "streaming".into(),
                        content: Some(content),
                    },
                }
            }
            "turn/started" => Event::Started {
                session: text(&p, "threadId"),
                turn: text(&p["turn"], "id"),
            },
            "turn/completed" => Event::Finished {
                session: text(&p, "threadId"),
                turn: text(&p["turn"], "id"),
                status: text(&p["turn"], "status"),
                error: (!p["turn"]["error"].is_null()).then(|| {
                    ade_core::error::Failure::provider(
                        &p["turn"]["error"],
                        ade_core::error::Failure::Rejected,
                    )
                    .to_string()
                }),
            },
            "item/started" | "item/completed" => {
                let Some(item) = item(&p["item"], p["turnId"].as_str(), method == "item/completed")
                else {
                    return Ok(None);
                };
                Event::Item {
                    session: text(&p, "threadId"),
                    item,
                }
            }
            "item/agentMessage/delta" | "item/commandExecution/outputDelta" | "item/plan/delta" => {
                Event::Delta {
                    session: text(&p, "threadId"),
                    turn: p["turnId"].as_str().map(str::to_owned),
                    id: text(&p, "itemId"),
                    role: if method.contains("commandExecution") {
                        "tool"
                    } else {
                        "assistant"
                    }
                    .into(),
                    kind: if method.contains("commandExecution") {
                        "commandExecution"
                    } else if method.contains("/plan/") {
                        "plan"
                    } else {
                        "text"
                    }
                    .into(),
                    text: text(&p, "delta"),
                }
            }
            // Usage is forwarded as reported; the daemon normalizes it and
            // never fills in a figure Codex left out.
            "thread/tokenUsage/updated" => Event::Usage {
                session: text(&p, "threadId"),
                turn: p["turnId"].as_str().map(str::to_owned),
                source: method.clone(),
                report: p["tokenUsage"].clone(),
            },
            // Account-wide and sparse: it names no thread.
            "account/rateLimits/updated" => Event::Usage {
                session: String::new(),
                turn: None,
                source: method.clone(),
                report: p["rateLimits"].clone(),
            },
            "serverRequest/resolved" => Event::Resolved {
                id: p["requestId"].clone(),
            },
            "error" => Event::Error {
                error: ade_core::error::Failure::provider(
                    &p["error"],
                    ade_core::error::Failure::Rejected,
                )
                .to_string(),
                turn: p["turnId"].as_str().map(str::to_owned),
            },
            _ => return Ok(None),
        },
        WireEvent::Exited(error) => Event::Exited { error },
    };
    Ok(Some(crate::provider::sanitize_event(event)))
}
/// A prompt as Codex `UserInput` items; images travel as data URLs.
fn user_input(prompt: &crate::prompt::Prompt) -> Result<Vec<Value>> {
    let mut input = vec![json!({"type":"text","text":prompt.text})];
    for content in &prompt.attachments {
        if content.attachment.media_type.starts_with("image/") {
            input.push(json!({"type":"image","url":format!("data:{};base64,{}",content.attachment.media_type,content.data)}));
        } else {
            input.push(json!({"type":"text","text":content.text_block()?}));
        }
    }
    Ok(input)
}
fn item(value: &Value, turn: Option<&str>, completed: bool) -> Option<Item> {
    let id = value["id"].as_str()?;
    let kind = value["type"].as_str()?;
    let (role, text) = match kind {
        "userMessage" => (
            "user",
            value["content"]
                .as_array()?
                .iter()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "agentMessage" | "plan" => ("assistant", value["text"].as_str().unwrap_or("").into()),
        "collabAgentToolCall" | "subAgentActivity" => ("tool", String::new()),
        "commandExecution" => (
            "tool",
            format!(
                "{}\n{}",
                value["command"].as_str().unwrap_or(""),
                value["aggregatedOutput"].as_str().unwrap_or("")
            ),
        ),
        "fileChange" => (
            "tool",
            serde_json::to_string_pretty(&value["changes"]).unwrap_or_default(),
        ),
        "mcpToolCall" => (
            "tool",
            format!(
                "{} / {}\n{}",
                value["server"].as_str().unwrap_or("MCP"),
                value["tool"].as_str().unwrap_or("tool"),
                value["result"]
            ),
        ),
        // Native reasoning is private and must never enter the shared history.
        "reasoning" => return None,
        // The provider's own record that it compacted context (F040). Codex
        // does not expose the retained summary, so none is claimed.
        "contextCompaction" => (
            "tool",
            if completed {
                "Codex compacted the conversation context."
            } else {
                "Codex is compacting the conversation context."
            }
            .into(),
        ),
        _ => (
            "tool",
            format!(
                "Unrecognized Codex item ({}). Its details require a newer ADE adapter.",
                kind.chars().take(128).collect::<String>()
            ),
        ),
    };
    let is_error = value["status"].as_str() == Some("failed")
        || value["exitCode"].as_i64().is_some_and(|code| code != 0)
        || (!value["error"].is_null());
    let content = match kind {
        "collabAgentToolCall" => {
            use crate::transcript::{Child, ChildState, Content};
            let mut ids = std::collections::BTreeSet::new();
            if let Some(receivers) = value["receiverThreadIds"].as_array() {
                ids.extend(receivers.iter().filter_map(Value::as_str));
            }
            if let Some(states) = value["agentsStates"].as_object() {
                ids.extend(states.keys().map(String::as_str));
            }
            let agents = ids
                .into_iter()
                .map(|id| {
                    let state = &value["agentsStates"][id];
                    Child {
                        id: id.into(),
                        session_id: Some(id.into()),
                        name: None,
                        state: match state["status"].as_str() {
                            Some("pendingInit") => ChildState::Pending,
                            Some("running") => ChildState::Running,
                            Some("completed") => ChildState::Completed,
                            Some("errored") => ChildState::Failed,
                            Some("interrupted") => ChildState::Interrupted,
                            Some("shutdown") => ChildState::Closed,
                            _ => ChildState::Unknown,
                        },
                        summary: state["message"].as_str().map(str::to_owned),
                    }
                })
                .collect();
            Some(Content::Subagents {
                operation: value["tool"]
                    .as_str()
                    .unwrap_or("subagent operation")
                    .into(),
                agents,
            })
        }
        "subAgentActivity" => {
            use crate::transcript::{Child, ChildState, Content};
            let id = value["agentThreadId"].as_str()?;
            Some(Content::Subagents {
                operation: value["kind"].as_str().unwrap_or("activity").into(),
                agents: vec![Child {
                    id: id.into(),
                    session_id: Some(id.into()),
                    name: value["agentPath"].as_str().map(str::to_owned),
                    state: match value["kind"].as_str() {
                        Some("started") => ChildState::Running,
                        Some("completed") => ChildState::Completed,
                        Some("interrupted") => ChildState::Interrupted,
                        _ => ChildState::Unknown,
                    },
                    summary: None,
                }],
            })
        }
        "commandExecution" => Some(crate::transcript::Content::Tool {
            call_id: id.into(),
            name: "command".into(),
            input: Some(json!({"command":value["command"],"cwd":value["cwd"]})),
            output: Some(
                value["aggregatedOutput"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
            ),
            is_error,
        }),
        "mcpToolCall" => Some(crate::transcript::Content::Tool {
            call_id: id.into(),
            name: format!(
                "{} / {}",
                value["server"].as_str().unwrap_or("MCP"),
                value["tool"].as_str().unwrap_or("tool")
            ),
            input: value.get("arguments").cloned(),
            output: if !value["error"].is_null() {
                Some(value["error"].to_string())
            } else {
                value
                    .get("result")
                    .filter(|v| !v.is_null())
                    .map(Value::to_string)
            },
            is_error,
        }),
        "fileChange" => Some(crate::transcript::Content::Tool {
            call_id: id.into(),
            name: "file changes".into(),
            input: value.get("changes").cloned(),
            output: None,
            is_error,
        }),
        _ => None,
    };
    let text = if matches!(kind, "collabAgentToolCall" | "subAgentActivity") {
        content.as_ref()?.display_text()
    } else {
        text
    };
    Some(Item {
        content,
        id: id.into(),
        client_id: if role == "user" {
            value["clientId"].as_str().map(str::to_owned)
        } else {
            None
        },
        turn: turn.map(str::to_owned),
        role: role.into(),
        kind: if matches!(kind, "userMessage" | "agentMessage") {
            "text"
        } else {
            kind
        }
        .into(),
        text,
        status: if is_error {
            "failed"
        } else if completed {
            "completed"
        } else {
            "streaming"
        }
        .into(),
    })
}

/// Checked against the `codex app-server generate-json-schema` output of
/// codex-cli 0.157.0, the build the account probe validates.
pub fn capabilities() -> crate::capabilities::CapabilityRecord {
    use crate::capabilities::*;
    use Support::*;
    CapabilityRecord {
        provider: "codex".into(),
        name: "Codex".into(),
        revision: 1,
        fingerprint: String::new(),
        checked_against: "codex-cli 0.157.0 app-server protocol v2".into(),
        models: ModelCapabilities {
            selection: capability(Supported, "thread/start carries the model"),
            format: ModelFormat::NativeId,
            aliases: vec![],
            discovery: capability(NativeOnly, "model/list; ADE does not call it"),
        },
        reasoning: ReasoningCapabilities {
            selection: capability(
                NativeOnly,
                "turn/start effort; ADE launches do not carry a reasoning level yet",
            ),
            // Each model advertises its own supportedReasoningEfforts.
            levels: vec![],
            varies_by_model: true,
        },
        permission_modes: vec![
            mode(
                "default",
                Supported,
                "Ask on request, inside a workspace-write sandbox",
            ),
            mode(
                "read-only",
                Supported,
                "Ask on request, inside a read-only sandbox",
            ),
            mode(
                "danger-full-access",
                NativeOnly,
                "No sandbox; ADE does not offer it",
            ),
        ],
        grants: GrantCapabilities {
            once: capability(
                Supported,
                "accept for one command or file change; permission grants are turn-scoped",
            ),
            session: capability(NativeOnly, "acceptForSession; ADE never sends it"),
            persistent: capability(NativeOnly, "Execpolicy amendments; ADE never sends them"),
        },
        conversation: ConversationCapabilities {
            steering: capability(NativeOnly, "turn/steer; ADE does not call it"),
            rewind: capability(
                NativeOnly,
                "thread/revert rewrites history only and leaves files unchanged",
            ),
            compaction: capability(NativeOnly, "thread/compact/start"),
            resume: capability(Supported, "thread/resume with the native thread ID"),
            import: capability(
                Supported,
                "history.import reads rollouts; imported sessions are not resumed automatically",
            ),
            fork: capability(NativeOnly, "thread/fork"),
            account_switch: capability(
                Unknown,
                "Login runs per app-server process; switching inside a thread is not documented",
            ),
        },
        quota: capability(
            Supported,
            "account/rateLimits/updated, recorded by the usage domain",
        ),
        managed_accounts: capability(Supported, "One CODEX_HOME per account"),
    }
}

/// The Codex CLI, and Bun for the shared app-server transport.
pub const INSTALLATION: &[crate::capabilities::Executable] = &[
    crate::capabilities::Executable {
        check: "executable:codex",
        env: "ADE_CODEX_BIN",
        default: Some("codex"),
        used_by: crate::capabilities::UsedBy::Every,
    },
    crate::capabilities::Executable {
        check: "runtime:bun",
        env: "ADE_BUN_BIN",
        default: Some("bun"),
        used_by: crate::capabilities::UsedBy::CodexSharedTransport,
    },
];

/// The `config` overrides for the catalog's servers, one `mcp_servers.<name>`
/// key per server. A key for the whole `mcp_servers` table could replace the
/// servers the user configured in `config.toml`; a per-server key sets only
/// that entry. Catalog names are lowercase letters, digits, `-` and `_`, so
/// a name never adds a path segment.
fn mcp_overrides(servers: &Value) -> Value {
    Value::Object(
        servers
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, server)| (format!("mcp_servers.{name}"), server.clone()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn mcp_overrides_set_each_server_and_leave_the_table_alone() {
        let servers = serde_json::json!({"files": {"command": "files-mcp"}, "docs-2": {"url": "https://x.invalid"}});
        assert_eq!(
            super::mcp_overrides(&servers),
            serde_json::json!({"mcp_servers.files": {"command": "files-mcp"},
                "mcp_servers.docs-2": {"url": "https://x.invalid"}})
        );
    }
    #[test]
    fn confirmed_shutdown_removes_owned_socket_after_group_exit() {
        use super::*;
        use std::os::unix::net::UnixListener;
        let directory =
            std::path::PathBuf::from(format!("/tmp/ade-codex-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&directory).unwrap();
        let listener = UnixListener::bind(directory.join("control.sock")).unwrap();
        let (events, _reader) = mpsc::sync_channel(8);
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let rpc = Rpc::spawn(command, events, decode).unwrap();
        let adapter = Adapter {
            rpc,
            cwd: "/tmp".into(),
            socket_directory: Some(directory.clone()),
            session: Mutex::new(None),
            identity: None,
            mcp_servers: Mutex::new(None),
        };
        adapter.stop_confirmed().unwrap();
        assert!(!directory.exists());
        adapter.stop_confirmed().unwrap();
        drop(listener);
    }
    #[test]
    fn child_reader_pages_public_items_and_checks_identity() {
        use super::*;
        let mut values: Vec<Value> = (0..55).map(|n| json!({"id":format!("item-{n}"),"type":"agentMessage","text":format!("answer {n}")})).collect();
        values.insert(
            2,
            json!({"id":"private","type":"reasoning","text":"PRIVATE"}),
        );
        let result = json!({"thread":{"id":"child","turns":[{"id":"turn","status":"completed","items":values}]}});
        let first = child_page(&result, "child", 0).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 50);
        assert_eq!(first["next_offset"], 50);
        assert!(!first.to_string().contains("PRIVATE"));
        let last = child_page(&result, "child", 50).unwrap();
        assert_eq!(last["items"][0]["text"], "answer 50");
        assert_eq!(last["items"].as_array().unwrap().len(), 5);
        assert!(last["next_offset"].is_null());
        assert!(child_page(&result, "unrelated", 0).is_err());
    }
    #[test]
    fn subagent_call_completion_does_not_complete_running_or_unknown_children() {
        use super::*;
        use crate::transcript::{ChildState, Content};
        let value = json!({"id":"spawn", "type":"collabAgentToolCall", "tool":"spawnAgent", "status":"completed", "receiverThreadIds":["running","unknown","running"], "agentsStates":{"running":{"status":"running"},"failed":{"status":"errored","message":"Task failed"}}});
        let result = item(&value, Some("turn"), true).unwrap();
        assert_eq!(result.status, "completed");
        let Some(Content::Subagents { agents, operation }) = result.content else {
            panic!("Missing subagents");
        };
        assert_eq!(operation, "spawnAgent");
        assert_eq!(agents.len(), 3);
        assert_eq!(
            agents.iter().find(|a| a.id == "running").unwrap().state,
            ChildState::Running
        );
        assert_eq!(
            agents.iter().find(|a| a.id == "unknown").unwrap().state,
            ChildState::Unknown
        );
        let failed = agents.iter().find(|a| a.id == "failed").unwrap();
        assert_eq!(failed.state, ChildState::Failed);
        assert_eq!(failed.summary.as_deref(), Some("Task failed"));
    }

    #[test]
    fn subagent_activity_preserves_child_identity_and_interruption() {
        use super::*;
        use crate::transcript::{ChildState, Content};
        let result=item(&json!({"id":"activity", "type":"subAgentActivity", "agentThreadId":"child", "agentPath":"/root/reviewer", "kind":"interrupted"}),Some("turn"),true).unwrap();
        let Some(Content::Subagents { agents, .. }) = result.content else {
            panic!("Missing activity");
        };
        assert_eq!(agents[0].session_id.as_deref(), Some("child"));
        assert_eq!(agents[0].name.as_deref(), Some("/root/reviewer"));
        assert_eq!(agents[0].state, ChildState::Interrupted);
    }
    #[test]
    fn command_output_keeps_typed_input_and_nonzero_exit_failure() {
        use super::*;
        let result = item(&json!({"id":"call", "type":"commandExecution", "command":"false", "cwd":"/project", "aggregatedOutput":"failed output", "exitCode":1, "status":"completed"}), Some("turn"), true).unwrap();
        assert_eq!(result.status, "failed");
        let Some(crate::transcript::Content::Tool {
            call_id,
            input,
            output,
            is_error,
            ..
        }) = result.content
        else {
            panic!("Missing typed tool");
        };
        assert_eq!(call_id, "call");
        assert!(is_error);
        assert_eq!(input.unwrap()["cwd"], "/project");
        assert_eq!(output.as_deref(), Some("failed output"));
    }
    #[test]
    fn a_provider_error_keeps_the_turn_it_names() {
        use super::*;
        let named = json!({"threadId":"thread", "turnId":"turn-a", "error":{"message":"boom"}});
        let Some(Event::Error { turn, .. }) =
            decode(WireEvent::Notification("error".into(), named)).unwrap()
        else {
            panic!("Missing error");
        };
        assert_eq!(turn.as_deref(), Some("turn-a"));
        let unnamed = json!({"error":{"message":"boom"}});
        let Some(Event::Error { turn, .. }) =
            decode(WireEvent::Notification("error".into(), unnamed)).unwrap()
        else {
            panic!("Missing error");
        };
        assert_eq!(turn, None);
    }
    #[test]
    fn structured_plan_updates_keep_identity_and_step_status() {
        use super::*;
        let payload = json!({"threadId":"thread", "turnId":"turn", "explanation":"Build it", "plan":[{"step":"Inspect", "status":"inProgress"}]});
        let Some(Event::Item { item: first, .. }) = decode(WireEvent::Notification(
            "turn/plan/updated".into(),
            payload.clone(),
        ))
        .unwrap() else {
            panic!("Missing plan");
        };
        let mut updated = payload;
        updated["plan"][0]["status"] = json!("completed");
        let Some(Event::Item { item: second, .. }) =
            decode(WireEvent::Notification("turn/plan/updated".into(), updated)).unwrap()
        else {
            panic!("Missing update");
        };
        assert_eq!(first.id, second.id);
        assert_eq!(second.kind, "plan");
        assert!(first.text.contains("In progress"));
        assert!(second.text.contains("Completed"));
        assert_ne!(first.content, second.content);
        let message = second.message("conversation");
        let restored: crate::model::Message =
            serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();
        assert_eq!(restored.content, message.content);
    }

    #[test]
    fn plan_text_items_are_not_reclassified_as_chat_text() {
        use super::*;
        assert_eq!(
            item(
                &json!({"id":"plan", "type":"plan", "text":"Plan"}),
                Some("turn"),
                true
            )
            .unwrap()
            .kind,
            "plan"
        );
    }
    use super::*;
    #[test]
    fn approval_mapping_never_broadens_the_requested_grant() {
        let p = json!({"permissions":{"network":{"enabled":true}}});
        assert_eq!(
            approval_result("item/permissions/requestApproval", &p, "accept", None).unwrap()["permissions"],
            p["permissions"]
        );
        assert_eq!(
            approval_result("item/permissions/requestApproval", &p, "decline", None).unwrap()["permissions"],
            json!({})
        );
        assert!(
            approval_result(
                "item/commandExecution/requestApproval",
                &json!({"availableDecisions":["decline"]}),
                "accept",
                None
            )
            .is_err()
        );
        assert!(approval_result("unknown", &json!({}), "accept", None).is_err());
    }
    #[test]
    fn multiple_choices_preserve_labels_without_splitting_commas() {
        let params = json!({"questions":[{"id":"features","multiSelect":true}]});
        let choices = json!({"features":["Read, write", "Review"]});
        let result = approval_result(
            "item/tool/requestUserInput",
            &params,
            "answer",
            Some(&choices),
        )
        .unwrap();
        assert_eq!(
            result["answers"]["features"]["answers"],
            choices["features"]
        );
        for invalid in [
            json!([]),
            json!([""]),
            json!([3]),
            json!(["x".repeat(16385)]),
        ] {
            assert!(
                approval_result(
                    "item/tool/requestUserInput",
                    &params,
                    "answer",
                    Some(&json!({"features":invalid}))
                )
                .is_err()
            );
        }
        let single = json!({"questions":[{"id":"features"}]});
        assert!(
            approval_result(
                "item/tool/requestUserInput",
                &single,
                "answer",
                Some(&choices)
            )
            .is_err()
        );
    }

    #[test]
    fn questions_require_every_answer() {
        let p = json!({"questions":[{"id":"a"},{"id":"b"}]});
        assert!(
            approval_result(
                "item/tool/requestUserInput",
                &p,
                "answer",
                Some(&json!({"a":"one"}))
            )
            .is_err()
        );
        assert_eq!(
            approval_result(
                "item/tool/requestUserInput",
                &p,
                "answer",
                Some(&json!({"a":"one","b":"two"}))
            )
            .unwrap()["answers"]["b"]["answers"],
            json!(["two"])
        );
    }
}
