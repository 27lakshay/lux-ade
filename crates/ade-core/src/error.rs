//! Stable transport failures. Messages intentionally contain no provider payloads.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum TransportError {
    #[error("Provider connection closed; reconnect before continuing")]
    Disconnected,
    #[error("Provider returned invalid JSON")]
    InvalidMessage,
    #[error("Provider message exceeds the size limit")]
    MessageTooLarge,
    #[error("Provider event queue is full; reconnect to recover session state")]
    Overloaded,
    #[error("Provider state is unavailable; restart the provider connection")]
    StateUnavailable,
    #[error("Provider stopped reading requests; reconnect before retrying")]
    WriteTimeout,
    #[error("Request timed out; its outcome is uncertain. Reconcile the session before resending")]
    OutcomeUnknown,
}
impl TransportError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Disconnected => "provider_disconnected",
            Self::InvalidMessage => "provider_invalid_message",
            Self::MessageTooLarge => "provider_message_too_large",
            Self::Overloaded => "provider_overloaded",
            Self::StateUnavailable => "provider_state_unavailable",
            Self::WriteTimeout => "provider_write_timeout",
            Self::OutcomeUnknown => "provider_outcome_unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClientDataError {
    #[error(
        "lux-ade received invalid session data. Your current view was retained; reconnect to reload it"
    )]
    InvalidEvent,
    #[error("lux-ade received an oversized response. Reconnect to reload session state")]
    FrameTooLarge,
    #[error("lux-ade connection closed before a complete response arrived")]
    IncompleteFrame,
    #[error("lux-ade received invalid JSON. Reconnect to reload session state")]
    InvalidJson,
}

#[derive(Debug, thiserror::Error)]
#[error("Workspace needs_rebind before execution can use its saved path")]
pub struct NeedsRebind;

#[derive(Debug, thiserror::Error)]
#[error("Restored prompt is held until its source outcome is reconciled")]
pub struct RestoredSendHeld;

/// The Conversation has a deletion tombstone. Anything that names it, a
/// late page, a stale snapshot or a delayed write, is refused rather than
/// bringing it back.
#[derive(Debug, thiserror::Error)]
#[error("Conversation {0} was deleted; reload the conversation list")]
pub struct ConversationDeleted(pub String);

/// No workspace has this ID.
#[derive(Debug, thiserror::Error)]
#[error("Workspace {0} does not exist; reload the catalog")]
pub struct WorkspaceNotFound(pub String);

/// The workspace was removed from ADE. Its record stays so its
/// Conversations keep their workspace; `workspace.open` on its folder
/// brings it back under the same ID.
#[derive(Debug, thiserror::Error)]
#[error("Workspace {0} was removed from ADE; open its folder again to use it")]
pub struct WorkspaceRemoved(pub String);

/// `workspace.rename` refused the name.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct InvalidWorkspaceName(pub crate::workspaces::InvalidName);

/// `workspace.remove` refused while work runs in the workspace. The error
/// frame lists each blocker, so a client can show what to stop first.
#[derive(Debug, thiserror::Error)]
#[error("{}", remove_blocked_message(.0))]
pub struct WorkspaceRemoveBlocked(pub Vec<crate::workspaces::RemoveBlocker>);

fn remove_blocked_message(blockers: &[crate::workspaces::RemoveBlocker]) -> String {
    let labels: Vec<&str> = blockers
        .iter()
        .map(|blocker| blocker.label.as_str())
        .collect();
    format!(
        "Stop the work in this workspace before removing it: {}",
        labels.join(", ")
    )
}

/// `terminal.close` refused: a command holds the terminal's foreground. The
/// error frame names it in `foreground`, so a client can ask before forcing.
#[derive(Debug, thiserror::Error)]
#[error("{}", terminal_busy_message(.foreground.as_deref()))]
pub struct TerminalBusy {
    pub terminal_id: String,
    pub foreground: Option<String>,
}

fn terminal_busy_message(foreground: Option<&str>) -> String {
    match foreground {
        Some(command) => {
            format!("{command} is running in this terminal; close it with force to stop it")
        }
        None => "A command is running in this terminal; close it with force to stop it".into(),
    }
}

/// A request field this daemon does not support yet. The message names it.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Unsupported(pub String);

/// A window or layout command the daemon refused. Each kind has a stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LayoutError {
    #[error("Window {0} does not exist; list the windows again")]
    WindowNotFound(String),
    #[error("Window {0} already exists on another workspace; choose another window ID")]
    WindowExists(String),
    #[error(
        "The layout is at revision {current}, not {expected}; read it again before changing it"
    )]
    Conflict { expected: u64, current: u64 },
    #[error("The tab target does not exist: {0}")]
    TabTargetMissing(String),
    #[error("{0}")]
    Invalid(String),
    /// Shell terminals whose tabs the change removes are busy: each
    /// `(terminal_id, foreground)`.
    #[error("{}", terminals_busy_message(.0))]
    TerminalsBusy(Vec<(String, Option<String>)>),
    /// The change would end running shells; these tabs need `tab.close`.
    #[error("Closing these tabs ends their terminals; close them with tab.close or pane.close")]
    TabCloseRequired(Vec<String>),
}

fn terminals_busy_message(busy: &[(String, Option<String>)]) -> String {
    let names: Vec<&str> = busy
        .iter()
        .map(|(id, foreground)| foreground.as_deref().unwrap_or(id))
        .collect();
    format!(
        "A command is running in a terminal this close ends ({}); close it with force to stop it",
        names.join(", ")
    )
}

impl LayoutError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::WindowNotFound(_) => "window_not_found",
            Self::WindowExists(_) => "window_exists",
            Self::Conflict { .. } => "layout_conflict",
            Self::TabTargetMissing(_) => "tab_target_missing",
            Self::Invalid(_) => "invalid_layout",
            Self::TerminalsBusy(_) => "terminal_busy",
            Self::TabCloseRequired(_) => "tab_close_required",
        }
    }

    pub fn recovery(&self) -> &'static str {
        match self {
            Self::WindowNotFound(_) => "reload_windows",
            Self::WindowExists(_) => "choose_another_id",
            Self::Conflict { .. } => "reload_layout",
            Self::TabTargetMissing(_) => "reload_catalog",
            Self::Invalid(_) => "fix_request",
            Self::TerminalsBusy(_) => "confirm_close",
            Self::TabCloseRequired(_) => "use_tab_close",
        }
    }
}

/// `workspace.delete_worktree` refused before changing anything. The error
/// frame lists each blocker of the workspace and of its tree.
#[derive(Debug, thiserror::Error)]
#[error("{}", delete_blocked_message(.0))]
pub struct WorktreeDeleteBlocked(pub Vec<crate::workspaces::DeleteBlocker>);

fn delete_blocked_message(blockers: &[crate::workspaces::DeleteBlocker]) -> String {
    let labels: Vec<&str> = blockers
        .iter()
        .map(|blocker| blocker.label.as_str())
        .collect();
    format!("This worktree cannot be deleted: {}", labels.join(", "))
}

/// A review anchor no longer matches the workspace's diff: its status
/// revision, the file's diff token or the selected text moved. Refresh
/// Changes and select the line again.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ReviewAnchorStale(pub &'static str);

/// Review feedback would replace text or attachments the window's draft
/// still holds.
#[derive(Debug, thiserror::Error)]
#[error("Send or clear the ordinary conversation draft before sending review feedback")]
pub struct DraftNotEmpty;

/// The worktree lifecycle refused an effect only because another operation
/// holds the repository now. Nothing changed; the same request can be sent
/// again once it finishes.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LifecycleBusy(pub &'static str);

/// The workspace was removed from ADE, but one of its terminals has not
/// stopped yet. Retrying finishes the removal.
#[derive(Debug, thiserror::Error)]
#[error("The workspace was removed, but a terminal is still stopping; retry workspace.remove")]
pub struct TerminalsStillStopping;

/// The built review prompt is longer than a queued prompt may be.
#[derive(Debug, thiserror::Error)]
#[error(
    "The review prompt is {0} bytes; a prompt holds at most 65536. Send fewer or shorter notes"
)]
pub struct ReviewPromptTooLong(pub usize);

/// No project has this ID, and no worktree lifecycle alias names one.
#[derive(Debug, thiserror::Error)]
#[error("Project {0} does not exist; reload the catalog")]
pub struct ProjectNotFound(pub String);

/// The project is a plain folder, so it has no worktrees.
#[derive(Debug, thiserror::Error)]
#[error("Project {0} is a plain folder; only a Git repository has worktrees")]
pub struct ProjectNotRepository(pub String);

/// `settings.set` named a key the profile does not keep.
#[derive(Debug, thiserror::Error)]
#[error("Unknown setting {0}")]
pub struct UnknownSetting(pub String);

/// `settings.set` gave a command a key that is not an Electron accelerator.
#[derive(Debug, thiserror::Error)]
#[error("Key {key} for {command} is not an accelerator: {reason}")]
pub struct InvalidKeybinding {
    pub command: String,
    pub key: String,
    pub reason: String,
}

/// `settings.set` would leave two or more commands on one key.
#[derive(Debug, thiserror::Error)]
#[error("{} would share the key {key}; unbind one or choose another key", commands.join(" and "))]
pub struct KeybindingConflict {
    pub key: String,
    pub commands: Vec<String>,
}

/// A request named a provider this daemon has neither built in nor
/// registered. `provider.capabilities` lists the ones it has.
#[derive(Debug, thiserror::Error)]
#[error("Unknown provider: {0}")]
pub struct ProviderNotFound(pub String);

/// An effect whose outcome cannot be known, such as a Git command interrupted
/// by a crash. The message is the operation's own account of what to inspect;
/// the envelope types it `outcome_unknown`, so a client can tell it from a
/// failure without parsing text.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct OperationOutcomeUnknown(pub String);

/// Another claim on the same physical resource refuses this one. The message
/// names the conflicting claim, its purpose and its owning profile.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HostResourceConflict(pub String);

/// The host resource registry cannot admit claims until explicit recovery.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HostResourcesUnavailable(pub String);

/// Categories carry no raw provider payload. Recovery is advice, never an
/// authorization to replay a mutation whose outcome might be unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    #[error(
        "Provider authentication failed. Sign in to the provider, then resume this conversation"
    )]
    Authentication,
    #[error("Provider rate limit reached. Wait for the limit to reset, then retry manually")]
    RateLimit,
    #[error("Provider usage allowance is exhausted. Check your provider account before retrying")]
    UsageLimit,
    #[error(
        "Provider process exited. Resume the conversation and check its last turn before resending"
    )]
    ProcessExited,
    #[error("Provider connection was lost. Reconnect and check the last turn before resending")]
    Disconnected,
    #[error("Provider returned invalid JSON or session data. Reconnect to reload the session")]
    InvalidData,
    #[error(
        "lux-ade could not save these changes. Check available disk space and data-folder access, then retry"
    )]
    SaveFailed,
    #[error(
        "The request outcome is unknown. Reconnect and inspect the last turn before sending it again"
    )]
    OutcomeUnknown,
    #[error("Provider is unavailable or overloaded. Check its status, then retry manually")]
    Unavailable,
    #[error(
        "The original provider session is unavailable. Restore its history before resuming; lux-ade retained the session ID and did not start a replacement"
    )]
    SessionUnavailable,
    #[error(
        "Provider rejected the operation. Check the provider configuration and requested operation before retrying"
    )]
    Rejected,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recovery {
    SignIn,
    WaitThenRetryManually,
    CheckAccount,
    ReconnectAndReconcile,
    CheckStorage,
    CheckProvider,
}
impl Failure {
    pub fn recovery(self) -> Recovery {
        match self {
            Self::Authentication => Recovery::SignIn,
            Self::RateLimit => Recovery::WaitThenRetryManually,
            Self::UsageLimit => Recovery::CheckAccount,
            Self::ProcessExited | Self::Disconnected | Self::InvalidData | Self::OutcomeUnknown => {
                Recovery::ReconnectAndReconcile
            }
            Self::SaveFailed => Recovery::CheckStorage,
            Self::Unavailable | Self::SessionUnavailable | Self::Rejected => {
                Recovery::CheckProvider
            }
        }
    }
    /// Classify structured provider status first. Text-only bridges get narrow
    /// known signatures, never broad matches against words like "token".
    pub fn provider(value: &serde_json::Value, fallback: Self) -> Self {
        let code = value
            .get("code")
            .or_else(|| value.get("type"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match code {
            "authentication_error" | "invalid_api_key" | "unauthorized" => {
                return Self::Authentication;
            }
            "rate_limit_error" | "rate_limit_exceeded" | "rateLimitExceeded" => {
                return Self::RateLimit;
            }
            "insufficient_quota" | "usage_limit_reached" | "usageLimitExceeded" => {
                return Self::UsageLimit;
            }
            "overloaded_error" | "server_overloaded" => return Self::Unavailable,
            "session_unavailable" => return Self::SessionUnavailable,
            _ => {}
        }
        let status = value
            .get("status")
            .or_else(|| value.get("statusCode"))
            .or_else(|| value.get("httpStatusCode"))
            .and_then(|value| value.as_u64());
        match status {
            Some(401) => return Self::Authentication,
            Some(429) => return Self::RateLimit,
            Some(500 | 502 | 503 | 504 | 529) => return Self::Unavailable,
            // 403 can mean policy or permission denial, not expired credentials.
            _ => {}
        }
        let message = value
            .as_str()
            .or_else(|| value.get("message").and_then(|value| value.as_str()))
            .unwrap_or("");
        for known in [
            Self::Authentication,
            Self::RateLimit,
            Self::UsageLimit,
            Self::ProcessExited,
            Self::Disconnected,
            Self::InvalidData,
            Self::SaveFailed,
            Self::OutcomeUnknown,
            Self::Unavailable,
            Self::SessionUnavailable,
            Self::Rejected,
        ] {
            if message == known.to_string() {
                return known;
            }
        }
        for transport in [
            TransportError::Disconnected,
            TransportError::InvalidMessage,
            TransportError::MessageTooLarge,
            TransportError::Overloaded,
            TransportError::StateUnavailable,
            TransportError::WriteTimeout,
            TransportError::OutcomeUnknown,
        ] {
            if message == transport.to_string() {
                return transport.into();
            }
        }
        // Bound classification work as well as output; nothing is retained.
        let text = message
            .chars()
            .take(2048)
            .collect::<String>()
            .to_ascii_lowercase();
        if text == "claude session is unavailable; original session id retained" {
            Self::SessionUnavailable
        } else if text.contains("executable is unavailable") {
            Self::Unavailable
        } else if [
            "invalid api key",
            "invalid_api_key",
            "authentication failed",
            "authentication_error",
            "not logged in",
        ]
        .iter()
        .any(|signature| text.contains(signature))
        {
            Self::Authentication
        } else if [
            "insufficient_quota",
            "usage limit reached",
            "usage allowance is exhausted",
        ]
        .iter()
        .any(|signature| text.contains(signature))
        {
            Self::UsageLimit
        } else if [
            "rate limit exceeded",
            "rate_limit_error",
            "rate limit reached",
        ]
        .iter()
        .any(|signature| text.contains(signature))
        {
            Self::RateLimit
        } else {
            fallback
        }
    }
}
impl From<TransportError> for Failure {
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::Disconnected => Self::Disconnected,
            TransportError::InvalidMessage | TransportError::MessageTooLarge => Self::InvalidData,
            TransportError::Overloaded | TransportError::StateUnavailable => Self::Unavailable,
            TransportError::WriteTimeout | TransportError::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

/// Git and lifecycle failures never include command output, hook text, or remote URLs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleFailure {
    #[error(
        "The Git or worktree command failed. Inspect repository status and configured hooks before retrying"
    )]
    LifecycleCommandFailed,
    #[error(
        "The Git or worktree command outcome is uncertain. Refresh repository status and inspect Git history before retrying; lux-ade will not replay it automatically"
    )]
    LifecycleOutcomeUnknown,
    #[error(
        "lux-ade could not start the Git worktree command. Check that Git is installed and executable"
    )]
    LifecycleUnavailable,
    #[error(
        "The Git or worktree command returned invalid or excessive output. Inspect repository status and configured hooks before retrying"
    )]
    LifecycleInvalidOutput,
}
impl LifecycleFailure {
    pub fn recovery(self) -> &'static str {
        match self {
            Self::LifecycleUnavailable => "check_lifecycle_tools",
            Self::LifecycleCommandFailed | Self::LifecycleInvalidOutput => "inspect_repository",
            Self::LifecycleOutcomeUnknown => "inspect_repository_before_retry",
        }
    }
}

/// A failed write to the daemon's own storage, classified from the SQLite
/// result code and the operating-system error number. Only a real full disk
/// (`SQLITE_FULL` or `ENOSPC`) says to check disk space. A busy or locked
/// database, an unwritable data folder and a damaged file each say what they
/// are. Messages carry no SQL, values or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum StorageFailure {
    /// The disk holding the data folder is full. It keeps the code and
    /// wording `Failure::SaveFailed` has always sent.
    #[serde(rename = "save_failed")]
    #[error(
        "lux-ade could not save these changes. Check available disk space and data-folder access, then retry"
    )]
    Full,
    /// Another writer held the database past the wait and every safe retry.
    /// The transaction was rolled back, so nothing was saved.
    #[serde(rename = "storage_busy")]
    #[error(
        "lux-ade could not save these changes because its database stayed busy. Nothing was saved; retry"
    )]
    Busy,
    /// The data folder or a database file cannot be written.
    #[serde(rename = "storage_unwritable")]
    #[error(
        "lux-ade could not save these changes because its data folder is not writable. Check the folder's permissions, then retry"
    )]
    Unwritable,
    /// A database file is damaged or is not a database.
    #[serde(rename = "storage_corrupt")]
    #[error(
        "lux-ade could not save these changes because a database file is damaged. Restore the profile from a backup"
    )]
    Corrupt,
    /// Any other storage failure, such as an I/O error.
    #[serde(rename = "storage_failed")]
    #[error(
        "lux-ade could not save these changes because of a storage error. Retry; if it repeats, check the daemon log"
    )]
    Failed,
}

impl StorageFailure {
    /// Classify a failure from its SQLite result code (primary or extended)
    /// and its `errno`, when either is known. `ENOSPC` wins over a generic
    /// SQLite I/O code, because SQLite can report a full-disk write as
    /// `SQLITE_IOERR_WRITE`.
    pub fn classify(sqlite_code: Option<i32>, os_error: Option<i32>) -> Self {
        // POSIX numbers; macOS and Linux agree on each of these.
        const EPERM: i32 = 1;
        const EACCES: i32 = 13;
        const ENOSPC: i32 = 28;
        const EROFS: i32 = 30;
        match os_error {
            Some(ENOSPC) => return Self::Full,
            Some(EPERM | EACCES | EROFS) => return Self::Unwritable,
            _ => {}
        }
        match sqlite_code.map(|code| code & 0xff) {
            // SQLITE_FULL
            Some(13) => Self::Full,
            // SQLITE_BUSY, SQLITE_LOCKED and their extended codes
            Some(5 | 6) => Self::Busy,
            // SQLITE_PERM, SQLITE_READONLY, SQLITE_CANTOPEN, SQLITE_AUTH
            Some(3 | 8 | 14 | 23) => Self::Unwritable,
            // SQLITE_CORRUPT, SQLITE_NOTADB
            Some(11 | 26) => Self::Corrupt,
            _ => Self::Failed,
        }
    }

    /// Whether a new attempt may succeed with no action from the user. Only
    /// a busy or locked database qualifies, and a caller retries only where
    /// no work of the failed attempt survived.
    pub fn retryable(self) -> bool {
        self == Self::Busy
    }

    /// The stable code the error envelope carries.
    pub fn code(self) -> &'static str {
        match self {
            Self::Full => "save_failed",
            Self::Busy => "storage_busy",
            Self::Unwritable => "storage_unwritable",
            Self::Corrupt => "storage_corrupt",
            Self::Failed => "storage_failed",
        }
    }

    pub fn recovery(self) -> &'static str {
        match self {
            Self::Full => "check_storage",
            Self::Busy | Self::Failed => "retry",
            Self::Unwritable => "check_data_folder",
            Self::Corrupt => "restore_backup",
        }
    }
}

/// The error frame for `error`: its message, a code and, for a classified
/// failure, a recovery hint. A refusal with no more specific code is `daemon`.
pub fn error_envelope(error: anyhow::Error) -> serde_json::Value {
    if error.downcast_ref::<RestoredSendHeld>().is_some() {
        return serde_json::json!({"type":"error","message":RestoredSendHeld.to_string(),
            "code":"restored_send_held","recovery":"reconcile_source_send"});
    }
    if let Some(deleted) = error.downcast_ref::<ConversationDeleted>() {
        return serde_json::json!({"type":"error","message":deleted.to_string(),
            "code":"conversation_deleted","recovery":"reload_catalog"});
    }
    if let Some(unknown) = error.downcast_ref::<OperationOutcomeUnknown>() {
        return serde_json::json!({"type":"error","message":unknown.to_string(),
            "code":"outcome_unknown","recovery":"inspect_before_retry"});
    }
    if let Some(missing) = error.downcast_ref::<WorkspaceNotFound>() {
        return serde_json::json!({"type":"error","message":missing.to_string(),
            "code":"workspace_not_found","recovery":"reload_catalog"});
    }
    if let Some(removed) = error.downcast_ref::<WorkspaceRemoved>() {
        return serde_json::json!({"type":"error","message":removed.to_string(),
            "code":"workspace_removed","recovery":"reopen_workspace"});
    }
    if let Some(invalid) = error.downcast_ref::<InvalidWorkspaceName>() {
        return serde_json::json!({"type":"error","message":invalid.to_string(),
            "code":"invalid_workspace_name","recovery":"choose_another_name"});
    }
    if let Some(blocked) = error.downcast_ref::<WorkspaceRemoveBlocked>() {
        return serde_json::json!({"type":"error","message":blocked.to_string(),
            "code":"workspace_remove_blocked","recovery":"stop_workspace_work",
            "blockers":blocked.0});
    }
    if let Some(busy) = error.downcast_ref::<TerminalBusy>() {
        return serde_json::json!({"type":"error","message":busy.to_string(),
            "code":"terminal_busy","recovery":"confirm_close",
            "terminal_id":busy.terminal_id,"foreground":busy.foreground});
    }
    if let Some(unsupported) = error.downcast_ref::<Unsupported>() {
        return serde_json::json!({"type":"error","message":unsupported.to_string(),
            "code":"unsupported","recovery":"omit_unsupported_field"});
    }
    if let Some(layout) = error.downcast_ref::<LayoutError>() {
        let mut envelope = serde_json::json!({"type":"error","message":layout.to_string(),
            "code":layout.code(),"recovery":layout.recovery()});
        if let LayoutError::TabCloseRequired(tabs) = layout {
            envelope["tabs"] = serde_json::json!(tabs);
        }
        if let LayoutError::TerminalsBusy(busy) = layout {
            envelope["terminals"] = busy
                .iter()
                .map(|(id, foreground)| serde_json::json!({"terminal_id":id,"foreground":foreground}))
                .collect();
        }
        return envelope;
    }
    if let Some(blocked) = error.downcast_ref::<WorktreeDeleteBlocked>() {
        return serde_json::json!({"type":"error","message":blocked.to_string(),
            "code":"worktree_delete_blocked","recovery":"clear_worktree_blockers",
            "blockers":blocked.0});
    }
    if let Some(busy) = error.downcast_ref::<LifecycleBusy>() {
        return serde_json::json!({"type":"error","message":busy.to_string(),
            "code":"lifecycle_busy","recovery":"retry_after_current_operation"});
    }
    if let Some(long) = error.downcast_ref::<ReviewPromptTooLong>() {
        return serde_json::json!({"type":"error","message":long.to_string(),
            "code":"review_prompt_too_long","recovery":"shorten_feedback"});
    }
    if let Some(stale) = error.downcast_ref::<ReviewAnchorStale>() {
        return serde_json::json!({"type":"error","message":stale.to_string(),
            "code":"review_anchor_stale","recovery":"refresh_changes"});
    }
    if error.downcast_ref::<DraftNotEmpty>().is_some() {
        return serde_json::json!({"type":"error","message":DraftNotEmpty.to_string(),
            "code":"draft_not_empty","recovery":"send_or_clear_draft"});
    }
    if let Some(missing) = error.downcast_ref::<ProjectNotFound>() {
        return serde_json::json!({"type":"error","message":missing.to_string(),
            "code":"project_not_found","recovery":"reload_catalog"});
    }
    if let Some(folder) = error.downcast_ref::<ProjectNotRepository>() {
        return serde_json::json!({"type":"error","message":folder.to_string(),
            "code":"project_not_repository","recovery":"choose_repository_project"});
    }
    if let Some(unknown) = error.downcast_ref::<UnknownSetting>() {
        return serde_json::json!({"type":"error","message":unknown.to_string(),
            "code":"unknown_setting","recovery":"check_setting_name"});
    }
    if let Some(invalid) = error.downcast_ref::<InvalidKeybinding>() {
        return serde_json::json!({"type":"error","message":invalid.to_string(),
            "code":"invalid_keybinding","recovery":"choose_another_key",
            "command":invalid.command});
    }
    if let Some(conflict) = error.downcast_ref::<KeybindingConflict>() {
        return serde_json::json!({"type":"error","message":conflict.to_string(),
            "code":"keybinding_conflict","recovery":"choose_another_key",
            "key":conflict.key,"commands":conflict.commands});
    }
    if let Some(unknown) = error.downcast_ref::<ProviderNotFound>() {
        return serde_json::json!({"type":"error","message":unknown.to_string(),
            "code":"provider_not_found","recovery":"list_providers"});
    }
    if error.downcast_ref::<NeedsRebind>().is_some() {
        return serde_json::json!({"type":"error","message":NeedsRebind.to_string(),
            "code":"needs_rebind","recovery":"rebind_workspace"});
    }
    if let Some(conflict) = error.downcast_ref::<HostResourceConflict>() {
        return serde_json::json!({"type":"error","message":conflict.to_string(),
            "code":"host_resource_conflict","recovery":"inspect_host_resources"});
    }
    if let Some(unavailable) = error.downcast_ref::<HostResourcesUnavailable>() {
        return serde_json::json!({"type":"error","message":unavailable.to_string(),
            "code":"host_resources_unavailable","recovery":"recover_host_resources"});
    }
    if let Some(failure) = error.downcast_ref::<StorageFailure>() {
        return serde_json::json!({"type":"error","message":failure.to_string(),
            "code":failure.code(),"recovery":failure.recovery()});
    }
    if let Some(failure) = error.downcast_ref::<LifecycleFailure>() {
        return serde_json::json!({"type":"error","message":failure.to_string(),"code":failure,"recovery":failure.recovery()});
    }
    let failure = error.downcast_ref::<Failure>().copied().or_else(|| {
        error
            .downcast_ref::<TransportError>()
            .copied()
            .map(Into::into)
    });
    if let Some(failure) = failure {
        serde_json::json!({"type":"error","message":failure.to_string(),"code":failure,"recovery":failure.recovery()})
    } else {
        serde_json::json!({"type":"error","message":error.to_string(),"code":"daemon"})
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_failures_use_safe_actionable_categories() {
        for (value, expected) in [
            (
                json!({"message":"Claude session is unavailable; original session ID retained"}),
                Failure::SessionUnavailable,
            ),
            (
                json!({"status":401,"message":"Bearer secret"}),
                Failure::Authentication,
            ),
            (json!({"status":429}), Failure::RateLimit),
            (
                json!({"code":"insufficient_quota","status":429}),
                Failure::UsageLimit,
            ),
            (
                json!({"message":"Invalid API key secret"}),
                Failure::Authentication,
            ),
            (
                json!({"status":403,"message":"Policy denied"}),
                Failure::Rejected,
            ),
            (
                json!({"message":"An ordinary token counter failed secret"}),
                Failure::Rejected,
            ),
        ] {
            let failure = Failure::provider(&value, Failure::Rejected);
            assert_eq!(failure, expected);
            assert!(!failure.to_string().contains("secret"));
        }
        assert_eq!(
            Failure::OutcomeUnknown.recovery(),
            Recovery::ReconnectAndReconcile
        );
        assert_eq!(Failure::Authentication.recovery(), Recovery::SignIn);
        assert_eq!(
            Failure::RateLimit.recovery(),
            Recovery::WaitThenRetryManually
        );
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use crate::workspaces::{InvalidName, RemoveBlocker, RemoveBlockerKind};
    use serde_json::json;

    #[test]
    fn workspace_errors_carry_codes_and_the_blockers() {
        let missing = error_envelope(WorkspaceNotFound("workspace_x".into()).into());
        assert_eq!(missing["code"], "workspace_not_found");
        assert_eq!(missing["recovery"], "reload_catalog");
        let removed = error_envelope(WorkspaceRemoved("workspace_x".into()).into());
        assert_eq!(removed["code"], "workspace_removed");
        let invalid = error_envelope(InvalidWorkspaceName(InvalidName::TooLong).into());
        assert_eq!(invalid["code"], "invalid_workspace_name");
        assert_eq!(invalid["message"], InvalidName::TooLong.to_string());
        let blocker = RemoveBlocker {
            kind: RemoveBlockerKind::ServiceRunning,
            id: "web".into(),
            label: "Service web".into(),
        };
        let blocked = error_envelope(WorkspaceRemoveBlocked(vec![blocker]).into());
        assert_eq!(blocked["code"], "workspace_remove_blocked");
        assert_eq!(
            blocked["blockers"],
            json!([{"kind": "service_running", "id": "web", "label": "Service web"}])
        );
        assert!(blocked["message"].as_str().unwrap().contains("Service web"));
    }

    #[test]
    fn terminal_refusals_carry_their_codes_and_the_foreground_command() {
        let busy = error_envelope(
            TerminalBusy {
                terminal_id: "terminal_1".into(),
                foreground: Some("sleep".into()),
            }
            .into(),
        );
        assert_eq!(busy["code"], "terminal_busy");
        assert_eq!(busy["foreground"], "sleep");
        assert_eq!(busy["terminal_id"], "terminal_1");
        assert!(
            busy["message"]
                .as_str()
                .unwrap()
                .starts_with("sleep is running")
        );
        let unsupported = error_envelope(Unsupported("place is not supported".into()).into());
        assert_eq!(unsupported["code"], "unsupported");
    }

    #[test]
    fn project_worktree_and_setting_errors_carry_codes() {
        use crate::contract::worktrees::CleanupBlocker;
        use crate::workspaces::DeleteBlocker;
        let blocked = error_envelope(
            WorktreeDeleteBlocked(vec![DeleteBlocker::tree(CleanupBlocker::Dirty, "/t")]).into(),
        );
        assert_eq!(blocked["code"], "worktree_delete_blocked");
        assert_eq!(blocked["blockers"][0]["kind"], "dirty");
        assert!(blocked["message"].as_str().unwrap().contains("uncommitted"));
        let missing = error_envelope(ProjectNotFound("repo_x".into()).into());
        assert_eq!(missing["code"], "project_not_found");
        let folder = error_envelope(ProjectNotRepository("project_x".into()).into());
        assert_eq!(folder["code"], "project_not_repository");
        let unknown = error_envelope(UnknownSetting("colour".into()).into());
        assert_eq!(unknown["code"], "unknown_setting");
        let provider = error_envelope(
            anyhow::Error::from(ProviderNotFound("gemini".into())).context("Create failed"),
        );
        assert_eq!(provider["code"], "provider_not_found");
        assert_eq!(provider["recovery"], "list_providers");
        let invalid = error_envelope(
            InvalidKeybinding {
                command: "new-tab".into(),
                key: "Ctrl+".into(),
                reason: "empty".into(),
            }
            .into(),
        );
        assert_eq!(invalid["code"], "invalid_keybinding");
        assert_eq!(invalid["command"], "new-tab");
        let conflict = error_envelope(
            KeybindingConflict {
                key: "Ctrl+T".into(),
                commands: vec!["new-tab".into(), "close-tab".into()],
            }
            .into(),
        );
        assert_eq!(conflict["code"], "keybinding_conflict");
        assert_eq!(conflict["commands"][1], "close-tab");
        assert!(
            conflict["message"]
                .as_str()
                .unwrap()
                .contains("new-tab and close-tab")
        );
        let busy =
            error_envelope(LifecycleBusy("Repository lifecycle operation is running").into());
        assert_eq!(busy["code"], "lifecycle_busy");
        assert_eq!(busy["message"], "Repository lifecycle operation is running");
        let long = error_envelope(ReviewPromptTooLong(70_000).into());
        assert_eq!(long["code"], "review_prompt_too_long");
        let stale = error_envelope(ReviewAnchorStale("Stale diff: token moved").into());
        assert_eq!(stale["code"], "review_anchor_stale");
        assert_eq!(stale["recovery"], "refresh_changes");
        assert_eq!(stale["message"], "Stale diff: token moved");
        assert_eq!(
            error_envelope(DraftNotEmpty.into())["code"],
            "draft_not_empty"
        );
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    #[test]
    fn only_a_full_disk_reports_disk_space() {
        for (code, errno) in [
            (Some(13), None),      // SQLITE_FULL
            (None, Some(28)),      // ENOSPC
            (Some(778), Some(28)), // SQLITE_IOERR_WRITE carrying ENOSPC
        ] {
            let failure = StorageFailure::classify(code, errno);
            assert_eq!(failure, StorageFailure::Full, "{code:?} {errno:?}");
            assert!(failure.to_string().contains("disk space"));
        }
        for (code, errno, expected) in [
            (Some(5), None, StorageFailure::Busy),        // SQLITE_BUSY
            (Some(517), None, StorageFailure::Busy),      // SQLITE_BUSY_SNAPSHOT
            (Some(261), None, StorageFailure::Busy),      // SQLITE_BUSY_RECOVERY
            (Some(6), None, StorageFailure::Busy),        // SQLITE_LOCKED
            (Some(262), None, StorageFailure::Busy),      // SQLITE_LOCKED_SHAREDCACHE
            (Some(8), None, StorageFailure::Unwritable),  // SQLITE_READONLY
            (Some(14), None, StorageFailure::Unwritable), // SQLITE_CANTOPEN
            (Some(3), None, StorageFailure::Unwritable),  // SQLITE_PERM
            (None, Some(13), StorageFailure::Unwritable), // EACCES
            (None, Some(30), StorageFailure::Unwritable), // EROFS
            (Some(11), None, StorageFailure::Corrupt),    // SQLITE_CORRUPT
            (Some(26), None, StorageFailure::Corrupt),    // SQLITE_NOTADB
            (Some(10), None, StorageFailure::Failed),     // SQLITE_IOERR
            (Some(778), Some(5), StorageFailure::Failed), // SQLITE_IOERR_WRITE with EIO
            (Some(19), None, StorageFailure::Failed),     // SQLITE_CONSTRAINT
            (None, None, StorageFailure::Failed),
        ] {
            let failure = StorageFailure::classify(code, errno);
            assert_eq!(failure, expected, "{code:?} {errno:?}");
            assert!(
                !failure.to_string().contains("disk space"),
                "{code:?} {errno:?} must not blame disk space"
            );
        }
    }

    #[test]
    fn only_busy_is_retried_and_each_class_keeps_its_code() {
        use StorageFailure::*;
        let all = [Full, Busy, Unwritable, Corrupt, Failed];
        let retried: Vec<_> = all.into_iter().filter(|f| f.retryable()).collect();
        assert_eq!(retried, [Busy]);
        let codes: Vec<_> = all.iter().map(|f| f.code()).collect();
        assert_eq!(
            codes,
            [
                "save_failed",
                "storage_busy",
                "storage_unwritable",
                "storage_corrupt",
                "storage_failed"
            ]
        );
        // A full disk keeps the wording `Failure::SaveFailed` has always sent.
        assert_eq!(Full.to_string(), Failure::SaveFailed.to_string());
        for failure in all {
            assert_eq!(serde_json::to_value(failure).unwrap(), failure.code());
            let envelope = error_envelope(failure.into());
            assert_eq!(envelope["code"], failure.code());
            assert_eq!(envelope["recovery"], failure.recovery());
        }
    }
}
