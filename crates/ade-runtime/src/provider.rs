//! Provider interface: lux-ade owns identity/durability; each adapter owns its native protocol.
use crate::{model::PendingRequest, rpc::Rpc};
use ade_core::model::AccountExecution;
#[path = "account_probe.rs"]
pub mod account_probe;
#[path = "codex_probe.rs"]
pub mod codex_probe;
#[path = "omp_probe.rs"]
pub mod omp_probe;
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::sync::{Arc, mpsc};

pub use ade_core::provider::{Config, Connected, Descriptor, Event, Item, descriptor, descriptors};

pub trait Provider: Send + Sync {
    /// Internal, transient launch credentials. Never persist or publish this value.
    fn child_transcript(
        &self,
        _session: &str,
        _child: &str,
        _offset: u64,
        _cursor: Option<&str>,
    ) -> Result<Value> {
        bail!("This provider does not support reading child transcripts yet")
    }
    fn pid(&self) -> Option<u32> {
        None
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected>;
    fn send(
        &self,
        session: &str,
        submission: &str,
        message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String>;
    fn cancel(&self, session: &str, turn: &str) -> Result<()>;
    /// Adds input to the running `turn` through the provider's native steer
    /// method and returns the turn that accepted it. An adapter without one
    /// refuses; it never queues the input as a new prompt (F035).
    fn steer(
        &self,
        _session: &str,
        _turn: &str,
        _message_id: &str,
        _prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        bail!("This provider adapter does not support steering a running turn")
    }
    /// Starts the provider's native context compaction (F040). `operation`
    /// identifies the request so a retry is not delivered twice.
    fn compact(&self, _session: &str, _operation: &str) -> Result<()> {
        bail!("This provider adapter does not support context compaction")
    }
    fn prepare_submission(&self) -> Option<String> {
        None
    }
    fn validate_answer(
        &self,
        request: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()>;
    fn answer(
        &self,
        request: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()>;
    fn reject(&self, id: Value, message: &str) -> Result<()>;
    fn stop(&self);
    fn stop_confirmed(&self) -> Result<()> {
        bail!("Provider does not support confirmed shutdown")
    }
}
pub fn spawn(
    provider: &str,
    cwd: &str,
    account: Option<&AccountExecution>,
    events: mpsc::SyncSender<Event>,
) -> Result<Arc<dyn Provider>> {
    if let Some(account) = account {
        ensure!(
            account.provider == provider,
            "Agent account belongs to another provider"
        );
    }
    match provider {
        "codex" if account.is_some() => Ok(crate::codex::Adapter::spawn(cwd, account, events)?),
        "omp" if account.is_some() => Ok(crate::omp::Adapter::spawn(cwd, account, events)?),
        "opencode" if account.is_some() => bail!("Managed OpenCode accounts are not supported yet"),
        "codex" => Ok(crate::codex::Adapter::spawn(cwd, None, events)?),
        "claude" => Ok(crate::claude::Adapter::spawn(cwd, account, events)?),
        "opencode" => Ok(crate::opencode::Adapter::spawn(cwd, events)?),
        "omp" => Ok(crate::omp::Adapter::spawn(cwd, None, events)?),
        _ => bail!("Unsupported provider {provider}"),
    }
}
pub fn catalogue() -> Value {
    json!({"type":"providers","providers":descriptors()})
}
pub(crate) fn bridge_event(event: crate::rpc::WireEvent) -> Result<Option<Event>> {
    match event {
        crate::rpc::WireEvent::Notification(method, value) if method == "event" => {
            let event = serde_json::from_value(value)
                .map_err(|_| ade_core::error::TransportError::InvalidMessage)?;
            Ok(Some(sanitize_event(event)))
        }
        crate::rpc::WireEvent::Request(..) => bail!("Unexpected bridge request"),
        _ => Ok(None),
    }
}
pub(crate) fn response_session(
    rpc: &Rpc,
    resume: Option<&str>,
    config: &Config,
) -> Result<Connected> {
    let result = rpc.request("open", json!({"resume":resume,"config":config}))?;
    let connected: Connected = serde_json::from_value(result)?;
    ensure!(
        resume.is_none_or(|id| id == connected.session),
        "Provider resumed a different session; original identity retained"
    );
    Ok(connected)
}

/// Error surfaces are operational metadata; tool result content remains unchanged.
pub(crate) fn sanitize_event(mut event: Event) -> Event {
    use ade_core::error::Failure;
    let (error, fallback) = match &mut event {
        Event::Error { error } | Event::OperationFailed { error, .. } => {
            (Some(error), Failure::Rejected)
        }
        Event::Exited { error } => (Some(error), Failure::ProcessExited),
        Event::Finished { error, .. } => (error.as_mut(), Failure::Rejected),
        _ => (None, Failure::Rejected),
    };
    if let Some(error) = error {
        *error = Failure::provider(&Value::String(error.clone()), fallback).to_string();
    }
    event
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    #[test]
    fn bridge_error_events_never_publish_raw_provider_secrets() {
        let event = bridge_event(crate::rpc::WireEvent::Notification(
            "event".into(),
            json!({"type":"exited","error":"authentication_error: token=secret"}),
        ))
        .unwrap()
        .unwrap();
        let Event::Exited { error } = event else {
            panic!("wrong event");
        };
        assert_eq!(error, ade_core::error::Failure::Authentication.to_string());
        assert!(!error.contains("secret"));
        let Event::Error { error } = sanitize_event(Event::Error {
            error: "Unexpected response includes prompt secret".into(),
        }) else {
            panic!("wrong event");
        };
        assert_eq!(error, ade_core::error::Failure::Rejected.to_string());
    }
}
