use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Repository {
    pub id: String,
    pub root: String,
    #[serde(default)]
    pub needs_rebind: bool,
    #[serde(default)]
    pub worktree_lifecycle_needs_rebind: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct WorkspaceRecord {
    #[serde(default)]
    pub extra_terminals: Vec<String>,
    pub id: String,
    pub repository_id: Option<String>,
    pub root: String,
    pub name: String,
    pub terminal_id: String,
    #[serde(default)]
    pub needs_rebind: bool,
    #[serde(default)]
    pub worktree_lifecycle_needs_rebind: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct Conversation {
    #[serde(default)]
    pub view_terminal: Option<TerminalOwner>,
    #[serde(default)]
    pub terminal_owner: Option<TerminalOwner>,
    #[serde(default)]
    pub queue_paused: bool,
    #[serde(default)]
    pub runtime_run: Option<String>,
    #[serde(default)]
    pub runtime_cursor: u64,
    #[serde(default)]
    pub runtime_submission: Option<String>,
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub provider: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default = "legacy_ambient_account_context")]
    pub account_context: String,
    #[serde(default)]
    #[schemars(with = "serde_json::Value")]
    pub provider_config: crate::provider::Config,
    pub provider_thread_id: Option<String>,
    pub status: String,
    pub active_turn_id: Option<String>,
    pub error: Option<String>,
    pub updated_at: i64,
}
fn legacy_ambient_account_context() -> String {
    "legacy_ambient".into()
}

/// Profile-owned account metadata. Credentials remain with the native provider.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub native_home: String,
    pub generation: u64,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_identity: Option<ClaudeIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_identity: Option<CodexIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omp_identity: Option<OmpIdentity>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct ClaudeIdentity {
    pub auth_method: String,
    pub api_provider: String,
    pub email: String,
    pub org_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct CodexIdentity {
    pub email: String,
    pub chatgpt_account_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct OmpIdentity {
    pub provider: String,
    pub credential_id: u64,
    pub credential_type: String,
    pub identity_key: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub org_id: Option<String>,
}

/// The immutable account context pinned to one provider execution.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AccountExecution {
    pub id: String,
    pub provider: String,
    pub native_home: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_identity: Option<ClaudeIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_identity: Option<CodexIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omp_identity: Option<OmpIdentity>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Draft {
    pub text: String,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub size: usize,
}
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct QueuedPrompt {
    pub id: String,
    pub conversation_id: String,
    pub text: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct Message {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<Value>")]
    pub content: Option<crate::transcript::Content>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_feedback: Option<serde_json::Value>,
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub kind: String,
    pub text: String,
    pub status: String,
    pub turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub sequence: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct PendingRequest {
    pub id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub rpc_id: Value,
    pub method: String,
    pub params: Value,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_fingerprint: Option<String>,
    #[serde(default)]
    pub answer_dispatched: bool,
    #[serde(default)]
    pub answer_attempt: u32,
}
impl PendingRequest {
    pub fn answer_command_key(&self) -> String {
        if self.answer_attempt == 0 {
            format!("answer:{}", self.id)
        } else {
            format!("answer:{}:attempt-{}", self.id, self.answer_attempt)
        }
    }
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct PaneLayout {
    pub sidebar_visible: bool,
    pub terminal_visible: bool,
    pub browser_visible: bool,
    pub sidebar_width: f32,
    pub browser_width: f32,
    pub terminal_height: f32,
}
impl Default for PaneLayout {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            terminal_visible: true,
            browser_visible: false,
            sidebar_width: 256.,
            browser_width: 300.,
            terminal_height: 200.,
        }
    }
}
impl PaneLayout {
    pub fn valid(&self) -> bool {
        (180.0..=360.0).contains(&self.sidebar_width)
            && (240.0..=600.0).contains(&self.browser_width)
            && (120.0..=600.0).contains(&self.terminal_height)
    }
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TerminalTab {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BrowserTab {
    pub id: String,
    pub url: String,
    pub title: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Tabs {
    pub initialized: bool,
    pub terminals: Vec<TerminalTab>,
    pub browsers: Vec<BrowserTab>,
    pub active_terminal: Option<String>,
    pub active_browser: Option<String>,
    pub closed_terminals: Vec<TerminalTab>,
    pub closed_browsers: Vec<BrowserTab>,
}
fn default_focused_pane() -> u32 {
    5
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WindowRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dock_layout: Option<Value>,
    #[serde(default = "default_focused_pane")]
    pub focused_pane: u32,
    #[serde(default)]
    pub tabs: Tabs,
    #[serde(default)]
    pub panes: PaneLayout,
    pub id: String,
    pub workspace_id: String,
    pub conversation_id: Option<String>,
    pub browser_url: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, JsonSchema)]
pub struct Catalogue {
    pub workspaces: Vec<WorkspaceRecord>,
    pub conversations: Vec<Conversation>,
    #[schemars(with = "Vec<Value>")]
    pub windows: Vec<WindowRecord>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BeginTurn {
    pub conversation: Conversation,
    pub message: Message,
    pub duplicate: bool,
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4())
}
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct TerminalOwner {
    pub terminal_id: String,
    pub transfer_id: String,
    pub runtime_instance: String,
}
