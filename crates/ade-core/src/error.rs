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

/// Additive error envelope: unclassified local validation keeps its legacy shape.
pub fn error_envelope(error: anyhow::Error) -> serde_json::Value {
    if error.downcast_ref::<RestoredSendHeld>().is_some() {
        return serde_json::json!({"type":"error","message":RestoredSendHeld.to_string(),
            "code":"restored_send_held","recovery":"reconcile_source_send"});
    }
    if let Some(unknown) = error.downcast_ref::<OperationOutcomeUnknown>() {
        return serde_json::json!({"type":"error","message":unknown.to_string(),
            "code":"outcome_unknown","recovery":"inspect_before_retry"});
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
        serde_json::json!({"type":"error","message":error.to_string()})
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
