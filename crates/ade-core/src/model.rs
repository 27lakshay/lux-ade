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
    pub id: String,
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub needs_rebind: bool,
    #[serde(default)]
    pub worktree_lifecycle_needs_rebind: bool,
    /// The project this workspace belongs to; never empty. A repository
    /// workspace's project is its repository; a plain folder is a project of
    /// its own.
    pub project_id: String,
    /// Whether this is a repository's primary checkout, a linked worktree or
    /// a plain folder.
    #[serde(default)]
    pub kind: WorkspaceKind,
    /// The branch the checkout's `HEAD` names; null when `HEAD` is detached
    /// or the workspace is not a Git checkout. The daemon refreshes it on
    /// open, after its own Git operations and when `HEAD` changes.
    #[serde(default)]
    pub branch: Option<String>,
    /// Whether this is the daemon's own workspace: attachments that name no
    /// workspace open their terminal here, and it cannot be removed. Set on
    /// every reply, never stored.
    #[serde(default)]
    pub default: bool,
    /// Whether ADE made (or adopted) this linked worktree and may delete it.
    #[serde(default)]
    pub ade_owned: bool,
}
/// What a workspace's folder is.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceKind {
    /// A repository's main checkout, whose `.git` is the common directory.
    PrimaryCheckout,
    /// A worktree linked to a repository with `git worktree add`.
    LinkedWorktree,
    /// A plain folder, outside any Git repository ADE registered.
    #[default]
    Folder,
}
/// Whether a Conversation needs the person, as the navigator shows it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    #[default]
    Idle,
    /// A turn is starting, running, responding, streaming or cancelling.
    Running,
    /// A question or approval waits on the person.
    NeedsYou,
    /// The Conversation failed, or its Agent is unavailable or disconnected.
    Error,
}
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct Conversation {
    #[serde(default)]
    pub terminal_owner: Option<TerminalOwner>,
    #[serde(default)]
    pub queue_paused: bool,
    /// The turn that was active when the person resumed the queue. That
    /// turn's interruption or failure then leaves the queue running, so a
    /// wake received while an older run cleans up is kept (R003).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_resumed_during: Option<String>,
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
    /// Derived from `status` and open requests
    /// (`crate::workspaces::attention`). Set on every reply, never stored.
    #[serde(default)]
    pub attention: Attention,
    /// Whether the Conversation has a message the person did not write
    /// (a reply, a notice) newer than the profile's seen mark
    /// (`conversation.mark_seen`). Status changes show in `attention`
    /// instead. Set on every reply, never stored.
    #[serde(default)]
    pub unread: bool,
    /// The Conversation that delegated this one, when it is an
    /// orchestration child. Set on every reply, never stored.
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    /// The orchestration group this child runs in, if any. Set on every
    /// reply, never stored.
    #[serde(default)]
    pub group_id: Option<String>,
}
impl Conversation {
    /// Clears the fields the daemon derives on every reply, so a stored
    /// record never carries a stale copy of them.
    pub fn without_presentation(&self) -> Self {
        Self {
            attention: Attention::Idle,
            unread: false,
            parent_conversation_id: None,
            group_id: None,
            ..self.clone()
        }
    }
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
    /// Context the window attached besides its text and attachments, kept
    /// with the draft revision that saved it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_nodes: Vec<crate::contract::conversations::DraftContextNode>,
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
/// What a project is.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    /// A Git repository: its primary checkout and linked worktrees.
    Repository,
    /// An ordinary folder: a project with exactly one workspace.
    Folder,
}
/// A project as the catalog lists it. Every workspace names its project in
/// `WorkspaceRecord::project_id`, and the worktree lifecycle takes a
/// repository project's ID as its `repository_id`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct CatalogProject {
    pub id: String,
    pub kind: ProjectKind,
    /// The display name: a repository's checkout folder (see
    /// `crate::workspaces::project_name`), or the folder's own name.
    pub name: String,
    /// A repository's Git common directory, or the folder.
    pub root: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, JsonSchema)]
pub struct Catalogue {
    /// The projects of the listed workspaces, in the order their first
    /// workspace was registered.
    pub projects: Vec<CatalogProject>,
    pub workspaces: Vec<WorkspaceRecord>,
    pub conversations: Vec<Conversation>,
    /// Every window, open and closed, as `window.list` gives them.
    pub windows: Vec<crate::contract::layout::Window>,
    /// The listed workspaces' terminals, in creation order.
    pub terminals: Vec<crate::contract::terminals::TerminalRecord>,
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
