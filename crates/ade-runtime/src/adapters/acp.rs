//! Pure Agent Client Protocol (ACP) v1 mapping. No I/O.
//!
//! Written against the ACP schema at `schema-v1.23.0`
//! (github.com/agentclientprotocol/agent-client-protocol). The adapter in
//! `acp_session.rs` owns the process; this module decides what each message
//! means for ADE:
//!
//! - [`handshake`] reads an `initialize` response. Capabilities come only
//!   from what the agent declared there.
//! - [`Mapper`] folds `session/update` notifications into provider events and
//!   remembers enough per turn to complete messages when the turn ends.
//! - [`permission_request`] and [`permission_outcome`] translate
//!   `session/request_permission` without widening a once-only choice into a
//!   persistent one.
use crate::provider::{Event, Item};
use crate::transcript::{Content, PlanStep, StepStatus};
use ade_core::contract::providers::adapters::AcpHandshake;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// The only ACP major version ADE speaks.
pub const PROTOCOL_VERSION: u16 = 1;
/// Method name ADE records for an ACP permission request.
pub const PERMISSION_METHOD: &str = "acp/request_permission";
/// Bound on text retained per turn to complete streamed messages.
const TURN_TEXT_LIMIT: usize = 4 * 1024 * 1024;
const TOOL_LIMIT: usize = 1024;
const OPTION_LIMIT: usize = 32;

/// The `initialize` request ADE sends. ADE offers no file system, terminal
/// or elicitation service to the agent, so it declares none.
pub fn initialize_request() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": {
            "fs": {"readTextFile": false, "writeTextFile": false},
            "terminal": false
        },
        "clientInfo": {"name": "ade", "version": env!("CARGO_PKG_VERSION")}
    })
}

fn flag(value: &Value) -> bool {
    value.as_bool() == Some(true)
}

fn present(value: &Value) -> bool {
    value.is_object()
}

fn bounded(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= limit && !s.contains('\0'))
        .map(str::to_owned)
}

/// Reads an `initialize` response. A different protocol version is refused,
/// as the specification requires of a client that cannot speak it.
pub fn handshake(response: &Value) -> Result<AcpHandshake> {
    ensure!(
        response.is_object(),
        "ACP agent returned a malformed initialize response"
    );
    let version = response["protocolVersion"]
        .as_u64()
        .context("ACP agent did not state a protocol version")?;
    ensure!(
        version == u64::from(PROTOCOL_VERSION),
        "ACP agent speaks protocol version {version}; ADE supports version {PROTOCOL_VERSION} only"
    );
    let caps = &response["agentCapabilities"];
    let prompt = &caps["promptCapabilities"];
    let session = &caps["sessionCapabilities"];
    let mcp = &caps["mcpCapabilities"];
    let auth_methods = response["authMethods"]
        .as_array()
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| bounded(&method["id"], 128))
                .take(16)
                .collect()
        })
        .unwrap_or_default();
    Ok(AcpHandshake {
        protocol_version: PROTOCOL_VERSION,
        agent_name: bounded(&response["agentInfo"]["name"], 128),
        agent_version: bounded(&response["agentInfo"]["version"], 64),
        auth_methods,
        load_session: flag(&caps["loadSession"]),
        resume_session: present(&session["resume"]),
        list_sessions: present(&session["list"]),
        prompt_image: flag(&prompt["image"]),
        prompt_audio: flag(&prompt["audio"]),
        prompt_embedded_context: flag(&prompt["embeddedContext"]),
        mcp_http: flag(&mcp["http"]),
        mcp_sse: flag(&mcp["sse"]),
    })
}

/// ADE capability names for a handshake. `streaming`, `cancel` and
/// `tool_approval` are baseline ACP v1 methods every agent must accept; the
/// rest appear only when the agent declared them.
pub fn capabilities(handshake: &AcpHandshake) -> Vec<String> {
    let mut names = vec!["streaming", "cancel", "tool_approval"];
    if handshake.prompt_image {
        names.push("images");
    }
    if handshake.prompt_embedded_context {
        names.push("text_attachments");
    }
    if handshake.load_session || handshake.resume_session {
        names.push("resume");
    }
    names.into_iter().map(str::to_owned).collect()
}

/// Builds `session/prompt` content blocks, refusing what the agent did not
/// declare rather than degrading it silently.
pub fn prompt_blocks(
    prompt: &crate::prompt::Prompt,
    handshake: &AcpHandshake,
) -> Result<Vec<Value>> {
    let mut blocks = vec![json!({"type":"text","text":prompt.text})];
    for content in &prompt.attachments {
        let media = &content.attachment.media_type;
        if media.starts_with("image/") {
            ensure!(
                handshake.prompt_image,
                "This ACP agent did not declare image prompts"
            );
            blocks.push(json!({"type":"image","mimeType":media,"data":content.data}));
        } else {
            ensure!(
                handshake.prompt_embedded_context,
                "This ACP agent did not declare embedded file context"
            );
            let text = content.text_block()?;
            blocks.push(json!({
                "type":"resource",
                "resource":{
                    "uri":format!("attachment:{}", content.attachment.name),
                    "mimeType":media,
                    "text":text
                }
            }));
        }
    }
    Ok(blocks)
}

/// How a `session/prompt` reply ends a turn: the ADE status and error.
pub fn stop_reason(result: &Value) -> (&'static str, Option<String>) {
    match result["stopReason"].as_str() {
        Some("end_turn") => ("completed", None),
        Some("cancelled") => ("interrupted", None),
        Some("max_tokens") => (
            "failed",
            Some("The agent stopped at its token limit".into()),
        ),
        Some("max_turn_requests") => (
            "failed",
            Some("The agent stopped at its limit of model requests for one turn".into()),
        ),
        Some("refusal") => (
            "failed",
            Some("The agent refused to continue this turn".into()),
        ),
        _ => (
            "failed",
            Some("The agent ended the turn without a recognised stop reason".into()),
        ),
    }
}

#[derive(Clone)]
struct Segment {
    first_seen: usize,
    id: String,
    role: &'static str,
    text: String,
}

#[derive(Clone, Default)]
struct Tool {
    first_seen: usize,
    title: String,
    kind: String,
    status: String,
    input: Option<Value>,
    output: String,
}

/// Folds one session's `session/update` notifications into provider events.
pub struct Mapper {
    session: String,
    turn: Option<String>,
    /// While a `session/load` replays history, updates become history items
    /// instead of live events.
    loading: bool,
    segments: Vec<Segment>,
    current: Option<usize>,
    tools: HashMap<String, Tool>,
    tool_order: Vec<String>,
    counter: u64,
    bytes: usize,
    pending_permissions: HashSet<String>,
}

impl Mapper {
    pub fn new(session: &str) -> Self {
        Self {
            session: session.into(),
            turn: None,
            loading: false,
            segments: vec![],
            current: None,
            tools: HashMap::new(),
            tool_order: vec![],
            counter: 0,
            bytes: 0,
            pending_permissions: HashSet::new(),
        }
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    fn reset(&mut self) {
        self.segments.clear();
        self.current = None;
        self.tools.clear();
        self.tool_order.clear();
        self.bytes = 0;
    }

    /// Starts a live turn. Refused while another turn is active.
    pub fn begin_turn(&mut self, turn: &str) -> Result<Event> {
        ensure!(!self.loading, "The ACP session is still loading");
        ensure!(
            self.turn.is_none(),
            "A turn is already running in this ACP session"
        );
        self.reset();
        self.turn = Some(turn.into());
        Ok(Event::Started {
            session: self.session.clone(),
            turn: turn.into(),
        })
    }

    /// Starts replaying history for `session/load`.
    pub fn begin_load(&mut self) {
        self.reset();
        self.loading = true;
    }

    /// Ends a replay and returns the history it produced.
    pub fn end_load(&mut self) -> Vec<Item> {
        // Messages and tool calls, in the order the replay first named them.
        let mut items: Vec<(usize, Item)> = self
            .completed_items(None, "completed")
            .into_iter()
            .zip(self.segments.iter().map(|s| s.first_seen))
            .map(|(item, seen)| (seen, item))
            .collect();
        items.extend(self.tool_order.iter().filter_map(|id| {
            self.tools
                .get(id)
                .map(|tool| (tool.first_seen, self.tool_item(id, tool)))
        }));
        items.sort_by_key(|(seen, _)| *seen);
        self.loading = false;
        self.reset();
        items.into_iter().map(|(_, item)| item).collect()
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        let scope = self.turn.clone().unwrap_or_else(|| "history".into());
        format!("{scope}:{prefix}:{}", self.counter)
    }

    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self.bytes.saturating_add(bytes);
        ensure!(
            self.bytes <= TURN_TEXT_LIMIT,
            "ACP agent output exceeded 4 MiB in one turn"
        );
        Ok(())
    }

    fn chunk(&mut self, role: &'static str, update: &Value) -> Result<Vec<Event>> {
        let content = &update["content"];
        // Only text is shown as a message; other block types are not rendered.
        let Some(text) = (content["type"] == "text")
            .then(|| content["text"].as_str())
            .flatten()
        else {
            return Ok(vec![]);
        };
        self.charge(text.len())?;
        let message_id = bounded(&update["messageId"], 256);
        let reuse = self.current.and_then(|index| {
            let segment = &self.segments[index];
            (segment.role == role
                && message_id
                    .as_ref()
                    .is_none_or(|id| segment.id.ends_with(&format!(":{id}"))))
            .then_some(index)
        });
        let index = match reuse {
            Some(index) => index,
            None => {
                let id = match &message_id {
                    Some(id) => format!(
                        "{}:{id}",
                        self.turn.clone().unwrap_or_else(|| "history".into())
                    ),
                    None => self.next_id(role),
                };
                self.segments.push(Segment {
                    first_seen: self.segments.len() + self.tool_order.len(),
                    id,
                    role,
                    text: String::new(),
                });
                self.segments.len() - 1
            }
        };
        self.current = Some(index);
        self.segments[index].text.push_str(text);
        if self.loading || role == "user" {
            // A live user chunk echoes the prompt the daemon already recorded.
            return Ok(vec![]);
        }
        Ok(vec![Event::Delta {
            session: self.session.clone(),
            turn: self.turn.clone(),
            id: self.segments[index].id.clone(),
            role: role.into(),
            kind: "text".into(),
            text: text.into(),
        }])
    }

    fn tool_item(&self, id: &str, tool: &Tool) -> Item {
        let is_error = tool.status == "failed";
        let status = match tool.status.as_str() {
            "completed" => "completed",
            "failed" => "failed",
            _ => "streaming",
        };
        let output = (!tool.output.is_empty()).then(|| tool.output.clone());
        Item {
            content: Some(Content::Tool {
                call_id: id.into(),
                name: tool.title.clone(),
                input: tool.input.clone(),
                output,
                is_error,
            }),
            id: id.into(),
            client_id: None,
            turn: self.turn.clone(),
            role: "tool".into(),
            kind: tool.kind.clone(),
            text: tool.title.clone(),
            status: status.into(),
        }
    }

    fn tool(&mut self, update: &Value, create: bool) -> Result<Vec<Event>> {
        let id = bounded(&update["toolCallId"], 256).context("ACP tool call has no ID")?;
        if !self.tools.contains_key(&id) {
            ensure!(
                self.tools.len() < TOOL_LIMIT,
                "ACP agent reported too many tool calls in one turn"
            );
            let first_seen = self.segments.len() + self.tool_order.len();
            self.tool_order.push(id.clone());
            self.tools.insert(
                id.clone(),
                Tool {
                    first_seen,
                    title: "tool".into(),
                    kind: "other".into(),
                    status: "pending".into(),
                    ..Tool::default()
                },
            );
        }
        let mut output = String::new();
        if let Some(blocks) = update["content"].as_array() {
            for block in blocks {
                if block["type"] == "content"
                    && block["content"]["type"] == "text"
                    && let Some(text) = block["content"]["text"].as_str()
                {
                    output.push_str(text);
                }
            }
        }
        self.charge(output.len())?;
        let tool = self.tools.get_mut(&id).expect("tool inserted above");
        if let Some(title) = bounded(&update["title"], 1024) {
            tool.title = title;
        }
        if let Some(kind) = bounded(&update["kind"], 64) {
            tool.kind = kind;
        }
        if let Some(status) = update["status"].as_str()
            && ["pending", "in_progress", "completed", "failed"].contains(&status)
        {
            tool.status = status.into();
        }
        if !update["rawInput"].is_null() {
            tool.input = Some(update["rawInput"].clone());
        }
        // Tool call content replaces the previous collection when present.
        if create || update["content"].is_array() {
            tool.output = output;
        }
        self.current = None;
        let tool = tool.clone();
        if self.loading {
            return Ok(vec![]);
        }
        Ok(vec![Event::Item {
            session: self.session.clone(),
            item: self.tool_item(&id, &tool),
        }])
    }

    fn plan(&self, update: &Value) -> Result<Vec<Event>> {
        let entries = update["entries"]
            .as_array()
            .context("ACP plan has no entries")?;
        let steps = entries
            .iter()
            .take(256)
            .map(|entry| {
                let status = match entry["status"].as_str() {
                    Some("completed") => StepStatus::Completed,
                    Some("in_progress") => StepStatus::InProgress,
                    _ => StepStatus::Pending,
                };
                PlanStep {
                    step: entry["content"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(4096)
                        .collect(),
                    status,
                }
            })
            .collect();
        let content = Content::Plan {
            explanation: None,
            steps,
        };
        content.validate()?;
        if self.loading {
            return Ok(vec![]);
        }
        let turn = self.turn.clone();
        Ok(vec![Event::Item {
            session: self.session.clone(),
            item: Item {
                id: format!("{}:plan", turn.as_deref().unwrap_or("history")),
                client_id: None,
                turn,
                role: "assistant".into(),
                kind: "plan".into(),
                text: content.display_text(),
                status: "streaming".into(),
                content: Some(content),
            },
        }])
    }

    /// Maps the params of one `session/update` notification. Updates for
    /// another session are ignored; updates this build does not render yield
    /// no event.
    pub fn update(&mut self, params: &Value) -> Result<Vec<Event>> {
        if params["sessionId"].as_str() != Some(self.session.as_str()) {
            return Ok(vec![]);
        }
        let update = &params["update"];
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => self.chunk("assistant", update),
            Some("user_message_chunk") => self.chunk("user", update),
            Some("tool_call") => self.tool(update, true),
            Some("tool_call_update") => self.tool(update, false),
            Some("plan") => self.plan(update),
            Some("usage_update") if !self.loading => Ok(vec![Event::Usage {
                session: self.session.clone(),
                turn: self.turn.clone(),
                source: "acp/usage_update".into(),
                report: update.clone(),
            }]),
            // Private reasoning is not persisted as transcript text, and mode,
            // command and configuration updates have no ADE surface yet.
            _ => Ok(vec![]),
        }
    }

    fn completed_items(&self, turn: Option<&str>, status: &str) -> Vec<Item> {
        self.segments
            .iter()
            .map(|segment| Item {
                content: None,
                id: segment.id.clone(),
                client_id: None,
                turn: turn.map(str::to_owned),
                role: segment.role.into(),
                kind: "text".into(),
                text: segment.text.clone(),
                status: status.into(),
            })
            .collect()
    }

    /// Ends the live turn with the `session/prompt` result, or with the
    /// agent's error reply. Completes streamed messages, then finishes.
    pub fn finish(&mut self, result: std::result::Result<&Value, String>) -> Vec<Event> {
        let Some(turn) = self.turn.take() else {
            return vec![];
        };
        let (status, error) = match result {
            Ok(value) => stop_reason(value),
            Err(error) => ("failed", Some(error)),
        };
        let item_status = if status == "completed" {
            "completed"
        } else {
            "failed"
        };
        let mut events: Vec<Event> = self
            .completed_items(Some(&turn), item_status)
            .into_iter()
            .filter(|item| item.role != "user")
            .map(|item| Event::Item {
                session: self.session.clone(),
                item,
            })
            .collect();
        events.push(Event::Finished {
            session: self.session.clone(),
            turn,
            status: status.into(),
            error,
        });
        self.reset();
        self.pending_permissions.clear();
        events
    }

    /// Maps one `session/request_permission` request. A malformed request is
    /// reported unsupported, so the daemon refuses it instead of guessing.
    pub fn permission_request(&mut self, id: &Value, params: &Value) -> Event {
        let session = params["sessionId"].as_str().unwrap_or("").to_owned();
        let turn = self.turn.clone().unwrap_or_default();
        let valid = session == self.session && valid_options(&params["options"]).is_ok();
        if valid {
            self.pending_permissions.insert(id.to_string());
        }
        Event::Request {
            session,
            turn,
            id: id.clone(),
            method: if valid {
                PERMISSION_METHOD.into()
            } else {
                "session/request_permission".into()
            },
            params: json!({"toolCall":params["toolCall"],"options":params["options"]}),
            supported: valid,
        }
    }

    /// Marks a permission request answered.
    pub fn permission_settled(&mut self, id: &Value) {
        self.pending_permissions.remove(&id.to_string());
    }

    /// Permission requests still waiting; cancelling a turn must answer them
    /// with the `cancelled` outcome.
    pub fn take_pending_permissions(&mut self) -> Vec<Value> {
        self.pending_permissions
            .drain()
            .filter_map(|id| serde_json::from_str(&id).ok())
            .collect()
    }
}

fn valid_options(options: &Value) -> Result<()> {
    let options = options
        .as_array()
        .context("Permission request has no options")?;
    ensure!(
        !options.is_empty() && options.len() <= OPTION_LIMIT,
        "Permission request has no usable options"
    );
    let mut ids = HashSet::new();
    for option in options {
        let id = bounded(&option["optionId"], 256).context("Permission option has no ID")?;
        ensure!(ids.insert(id), "Permission options repeat an ID");
        ensure!(
            matches!(
                option["kind"].as_str(),
                Some("allow_once" | "allow_always" | "reject_once" | "reject_always")
            ),
            "Permission option has an unknown kind"
        );
    }
    Ok(())
}

/// The reply to a permission request. `accept` picks the agent's
/// `allow_once` option and `decline` its `reject_once` option. A persistent
/// option is chosen only when named by `answers.option_id`, and a named
/// option must match the decision.
pub fn permission_outcome(
    params: &Value,
    decision: &str,
    answers: Option<&Value>,
) -> Result<Value> {
    valid_options(&params["options"])?;
    let options = params["options"].as_array().expect("validated above");
    let (allowed, default): (&[&str], &str) = match decision {
        "accept" => (&["allow_once", "allow_always"], "allow_once"),
        "decline" => (&["reject_once", "reject_always"], "reject_once"),
        _ => bail!("Choose accept or decline"),
    };
    let named = answers.and_then(|answers| answers.get("option_id"));
    let chosen = match named {
        Some(named) => {
            let named = named.as_str().context("option_id must be a string")?;
            let option = options
                .iter()
                .find(|option| option["optionId"] == named)
                .context("The agent did not offer that option")?;
            ensure!(
                allowed.contains(&option["kind"].as_str().unwrap_or("")),
                "That option does not match the decision"
            );
            option
        }
        None => options
            .iter()
            .find(|option| option["kind"] == default)
            .with_context(|| {
                format!(
                    "The agent offered no {default} option; choose one explicitly with option_id"
                )
            })?,
    };
    Ok(json!({"outcome":{"outcome":"selected","optionId":chosen["optionId"]}}))
}

/// The reply that answers a permission request of a cancelled turn.
pub fn cancelled_outcome() -> Value {
    json!({"outcome":{"outcome":"cancelled"}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(session: &str, update: Value) -> Value {
        json!({"sessionId":session,"update":update})
    }

    #[test]
    fn capabilities_come_only_from_the_initialize_response() {
        let minimal = handshake(&json!({"protocolVersion":1})).unwrap();
        assert_eq!(
            capabilities(&minimal),
            ["streaming", "cancel", "tool_approval"]
        );
        assert!(minimal.auth_methods.is_empty());
        let full = handshake(&json!({
            "protocolVersion":1,
            "agentCapabilities":{
                "loadSession":true,
                "promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},
                "mcpCapabilities":{"http":true,"sse":false},
                "sessionCapabilities":{"resume":{},"list":{}}
            },
            "authMethods":[{"id":"agent-login","name":"Log in"}],
            "agentInfo":{"name":"sample-agent","version":"2.1.0"}
        }))
        .unwrap();
        assert!(full.load_session && full.resume_session && full.list_sessions);
        assert!(full.prompt_audio && full.mcp_http && !full.mcp_sse);
        assert_eq!(full.auth_methods, ["agent-login"]);
        assert_eq!(full.agent_name.as_deref(), Some("sample-agent"));
        assert_eq!(
            capabilities(&full),
            [
                "streaming",
                "cancel",
                "tool_approval",
                "images",
                "text_attachments",
                "resume"
            ]
        );
        // A non-boolean flag is not a declaration.
        let odd =
            handshake(&json!({"protocolVersion":1,"agentCapabilities":{"loadSession":"yes"}}))
                .unwrap();
        assert!(!odd.load_session);
    }

    #[test]
    fn another_protocol_version_is_refused() {
        assert!(handshake(&json!({"protocolVersion":2})).is_err());
        assert!(handshake(&json!({})).is_err());
        assert!(handshake(&json!([])).is_err());
    }

    #[test]
    fn prompt_refuses_undeclared_attachment_kinds() {
        let prompt: crate::prompt::Prompt = serde_json::from_value(json!({
            "text":"look",
            "attachments":[{"attachment":{"id":"a","name":"x.png","media_type":"image/png","size":1},"data":"AA=="}]
        }))
        .unwrap();
        let without = AcpHandshake::default();
        assert!(prompt_blocks(&prompt, &without).is_err());
        let with = AcpHandshake {
            prompt_image: true,
            ..AcpHandshake::default()
        };
        let blocks = prompt_blocks(&prompt, &with).unwrap();
        assert_eq!(blocks[0], json!({"type":"text","text":"look"}));
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["mimeType"], "image/png");
    }

    #[test]
    fn a_turn_streams_text_and_tools_then_completes_messages() {
        let mut mapper = Mapper::new("s1");
        let Event::Started { turn, .. } = mapper.begin_turn("t1").unwrap() else {
            panic!("expected started");
        };
        assert_eq!(turn, "t1");
        assert!(mapper.begin_turn("t2").is_err());
        let first = mapper
            .update(&update("s1", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hel"}})))
            .unwrap();
        let second = mapper
            .update(&update("s1", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"lo"}})))
            .unwrap();
        let (Event::Delta { id: a, .. }, Event::Delta { id: b, text, .. }) =
            (&first[0], &second[0])
        else {
            panic!("expected deltas");
        };
        assert_eq!(a, b);
        assert_eq!(text, "lo");
        let tool = mapper
            .update(&update("s1", json!({"sessionUpdate":"tool_call","toolCallId":"c1","title":"Read file","kind":"read","status":"pending","rawInput":{"path":"a"}})))
            .unwrap();
        let Event::Item { item, .. } = &tool[0] else {
            panic!("expected item");
        };
        assert_eq!(
            (item.role.as_str(), item.kind.as_str(), item.status.as_str()),
            ("tool", "read", "streaming")
        );
        let done = mapper
            .update(&update("s1", json!({"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"file body"}}]})))
            .unwrap();
        let Event::Item { item, .. } = &done[0] else {
            panic!("expected item");
        };
        assert_eq!(item.status, "completed");
        assert_eq!(item.text, "Read file");
        let Some(Content::Tool { output, input, .. }) = &item.content else {
            panic!("expected tool content");
        };
        assert_eq!(output.as_deref(), Some("file body"));
        assert_eq!(input.as_ref().unwrap()["path"], "a");
        // Text after a tool call starts a new message.
        let after = mapper
            .update(&update("s1", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"}})))
            .unwrap();
        let Event::Delta { id: c, .. } = &after[0] else {
            panic!("expected delta");
        };
        assert_ne!(a, c);
        let events = mapper.finish(Ok(&json!({"stopReason":"end_turn"})));
        let texts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Event::Item { item, .. } => Some((item.text.clone(), item.status.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            [
                ("Hello".into(), "completed".into()),
                ("Done".into(), "completed".into())
            ]
        );
        let Some(Event::Finished {
            status,
            error,
            turn,
            ..
        }) = events.last()
        else {
            panic!("expected finished");
        };
        assert_eq!(
            (status.as_str(), error, turn.as_str()),
            ("completed", &None, "t1")
        );
        assert!(mapper.turn().is_none());
        assert!(
            mapper
                .finish(Ok(&json!({"stopReason":"end_turn"})))
                .is_empty()
        );
    }

    #[test]
    fn other_sessions_thoughts_and_unknown_updates_emit_nothing() {
        let mut mapper = Mapper::new("s1");
        mapper.begin_turn("t1").unwrap();
        for value in [
            update(
                "s2",
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"secret plan"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"current_mode_update","currentModeId":"code"}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"AA==","mimeType":"image/png"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"echo"}}),
            ),
        ] {
            assert!(mapper.update(&value).unwrap().is_empty());
        }
    }

    #[test]
    fn stop_reasons_map_to_honest_statuses() {
        let mut mapper = Mapper::new("s1");
        for (reason, status, failed) in [
            ("cancelled", "interrupted", false),
            ("max_tokens", "failed", true),
            ("refusal", "failed", true),
            ("something_new", "failed", true),
        ] {
            mapper.begin_turn("t").unwrap();
            let events = mapper.finish(Ok(&json!({"stopReason":reason})));
            let Some(Event::Finished {
                status: s, error, ..
            }) = events.last()
            else {
                panic!("expected finished");
            };
            assert_eq!(s, status);
            assert_eq!(error.is_some(), failed);
        }
        mapper.begin_turn("t").unwrap();
        let events = mapper.finish(Err("rejected".into()));
        assert!(
            matches!(events.last(), Some(Event::Finished { status, .. }) if status == "failed")
        );
    }

    #[test]
    fn plans_and_usage_are_forwarded() {
        let mut mapper = Mapper::new("s1");
        mapper.begin_turn("t1").unwrap();
        let plan = mapper
            .update(&update("s1", json!({"sessionUpdate":"plan","entries":[{"content":"Read","priority":"high","status":"completed"},{"content":"Edit","priority":"medium","status":"in_progress"}]})))
            .unwrap();
        let Event::Item { item, .. } = &plan[0] else {
            panic!("expected plan item");
        };
        assert_eq!(item.id, "t1:plan");
        let Some(Content::Plan { steps, .. }) = &item.content else {
            panic!("expected plan content");
        };
        assert_eq!(steps[1].status, StepStatus::InProgress);
        let usage = mapper
            .update(&update(
                "s1",
                json!({"sessionUpdate":"usage_update","used":10,"size":100}),
            ))
            .unwrap();
        assert!(
            matches!(&usage[0], Event::Usage { source, report, .. } if source == "acp/usage_update" && report["used"] == 10)
        );
    }

    #[test]
    fn load_replays_history_without_live_events() {
        let mut mapper = Mapper::new("s1");
        mapper.begin_load();
        for value in [
            update(
                "s1",
                json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"lo"}}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"tool_call","toolCallId":"c1","title":"ls","status":"completed"}),
            ),
            update(
                "s1",
                json!({"sessionUpdate":"usage_update","used":1,"size":2}),
            ),
        ] {
            assert!(mapper.update(&value).unwrap().is_empty());
        }
        let history = mapper.end_load();
        let summary: Vec<_> = history
            .iter()
            .map(|item| (item.role.as_str(), item.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            [("user", "hi"), ("assistant", "hello"), ("tool", "ls")]
        );
        assert!(mapper.begin_turn("t1").is_ok());
    }

    #[test]
    fn permission_choices_keep_once_only_meaning() {
        let params = json!({
            "sessionId":"s1",
            "toolCall":{"toolCallId":"c1","title":"Write"},
            "options":[
                {"optionId":"always","name":"Always","kind":"allow_always"},
                {"optionId":"once","name":"Once","kind":"allow_once"},
                {"optionId":"no","name":"No","kind":"reject_once"}
            ]
        });
        assert_eq!(
            permission_outcome(&params, "accept", None).unwrap()["outcome"]["optionId"],
            "once"
        );
        assert_eq!(
            permission_outcome(&params, "decline", None).unwrap()["outcome"]["optionId"],
            "no"
        );
        let always = json!({"option_id":"always"});
        assert_eq!(
            permission_outcome(&params, "accept", Some(&always)).unwrap()["outcome"]["optionId"],
            "always"
        );
        assert!(permission_outcome(&params, "decline", Some(&always)).is_err());
        assert!(permission_outcome(&params, "answer", None).is_err());
        let only_always = json!({"options":[{"optionId":"a","name":"A","kind":"allow_always"}]});
        assert!(permission_outcome(&only_always, "accept", None).is_err());
    }

    #[test]
    fn malformed_permission_requests_are_unsupported_and_cancel_answers_pending() {
        let mut mapper = Mapper::new("s1");
        mapper.begin_turn("t1").unwrap();
        let bad = mapper.permission_request(
            &json!(7),
            &json!({"sessionId":"s1","toolCall":{},"options":[{"optionId":"x","name":"X","kind":"maybe"}]}),
        );
        assert!(matches!(
            bad,
            Event::Request {
                supported: false,
                ..
            }
        ));
        let good = mapper.permission_request(
            &json!(8),
            &json!({"sessionId":"s1","toolCall":{},"options":[{"optionId":"x","name":"X","kind":"allow_once"}]}),
        );
        let Event::Request {
            supported,
            method,
            turn,
            ..
        } = good
        else {
            panic!("expected request");
        };
        assert!(supported);
        assert_eq!((method.as_str(), turn.as_str()), (PERMISSION_METHOD, "t1"));
        assert_eq!(mapper.take_pending_permissions(), [json!(8)]);
        assert!(mapper.take_pending_permissions().is_empty());
        assert_eq!(cancelled_outcome()["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn turn_output_is_bounded() {
        let mut mapper = Mapper::new("s1");
        mapper.begin_turn("t1").unwrap();
        let big = "x".repeat(1024 * 1024);
        for _ in 0..4 {
            mapper
                .update(&update("s1", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":big}})))
                .unwrap();
        }
        assert!(
            mapper
                .update(&update("s1", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"y"}})))
                .is_err()
        );
    }
}
