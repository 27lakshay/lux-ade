//! Generic ACP adapter: runs any agent that speaks the Agent Client Protocol
//! v1 over standard input and output.
//!
//! The adapter launches the profile-configured executable, sends
//! `initialize`, and keeps the agent's declared capabilities for the life of
//! the process. It then opens one session and runs one prompt turn at a time.
//! `session/prompt` replies only when the turn ends, so the adapter waits for
//! it on its own thread and reports the turn's end from the stop reason.
//! Message mapping lives in [`super::acp`].
use super::acp::{self, Mapper};
use crate::{
    model::PendingRequest,
    provider::{Config, Connected, Event, Provider},
    rpc::{Framing, Rpc, WireEvent},
};
use ade_core::{
    contract::providers::adapters::{AcpHandshake, AdapterDefinition},
    error::TransportError,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

/// `session/load` replays history before it replies; allow for a long one.
const LOAD_LIMIT: Duration = Duration::from_secs(120);

type Shared = Arc<Mutex<Option<Mapper>>>;

pub struct Adapter {
    rpc: Arc<Rpc>,
    mapper: Shared,
    events: mpsc::SyncSender<Event>,
    cwd: String,
    handshake: AcpHandshake,
}

fn decoder(
    mapper: Shared,
    events: mpsc::SyncSender<Event>,
) -> impl Fn(WireEvent) -> Result<Option<Event>> + Send + 'static {
    move |wire| {
        let mut guard = mapper
            .lock()
            .map_err(|_| TransportError::StateUnavailable)?;
        match wire {
            WireEvent::Notification(method, params) if method == "session/update" => {
                let Some(mapper) = guard.as_mut() else {
                    return Ok(None);
                };
                for event in mapper.update(&params)? {
                    events
                        .try_send(event)
                        .map_err(|_| TransportError::Overloaded)?;
                }
                Ok(None)
            }
            WireEvent::Request(id, method, params) => {
                let turn = guard
                    .as_ref()
                    .and_then(|m| m.turn().map(str::to_owned))
                    .unwrap_or_default();
                match guard.as_mut() {
                    Some(mapper) if method == "session/request_permission" => {
                        Ok(Some(mapper.permission_request(&id, &params)))
                    }
                    // ADE declared no file system, terminal or elicitation
                    // service, so any other agent request is unsupported.
                    _ => Ok(Some(Event::Request {
                        session: params["sessionId"].as_str().unwrap_or("").to_owned(),
                        turn,
                        id,
                        method,
                        params: json!({}),
                        supported: false,
                    })),
                }
            }
            _ => Ok(None),
        }
    }
}

impl Adapter {
    /// Launches the agent and completes the `initialize` handshake.
    pub fn spawn(
        definition: &AdapterDefinition,
        cwd: &str,
        events: mpsc::SyncSender<Event>,
        initialize_limit: Duration,
    ) -> Result<Arc<Self>> {
        super::check_executable(&definition.command)?;
        let mapper: Shared = Arc::new(Mutex::new(None));
        let rpc = Rpc::spawn_with(
            super::command(definition, cwd),
            events.clone(),
            Framing::JsonRpc2,
            decoder(mapper.clone(), events.clone()),
        )?;
        let handshake = match rpc
            .request_within(
                "initialize",
                acp::initialize_request(),
                Some(initialize_limit),
            )
            .and_then(|response| acp::handshake(&response))
            .context("The agent did not complete the ACP initialize handshake")
        {
            Ok(handshake) => handshake,
            Err(error) => {
                if let Err(stop) = rpc.stop_confirmed() {
                    return Err(error.context(stop.to_string()));
                }
                return Err(error);
            }
        };
        Ok(Arc::new(Self {
            rpc,
            mapper,
            events,
            cwd: cwd.into(),
            handshake,
        }))
    }

    pub fn handshake(&self) -> &AcpHandshake {
        &self.handshake
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Mapper>>> {
        self.mapper
            .lock()
            .map_err(|_| TransportError::StateUnavailable.into())
    }

    fn session_params(&self, session: &str) -> Value {
        json!({"sessionId":session,"cwd":self.cwd,"mcpServers":[]})
    }

    fn resume(&self, session: &str) -> Result<Connected> {
        ensure!(
            !session.is_empty() && session.len() <= 4096,
            "Invalid ACP session ID"
        );
        if self.handshake.load_session {
            {
                let mut guard = self.lock()?;
                ensure!(guard.is_none(), "The ACP session is already open");
                let mut mapper = Mapper::new(session);
                mapper.begin_load();
                *guard = Some(mapper);
            }
            let loaded = self.rpc.request_within(
                "session/load",
                self.session_params(session),
                Some(LOAD_LIMIT),
            );
            let mut guard = self.lock()?;
            if let Err(error) = loaded {
                *guard = None;
                return Err(error);
            }
            let history = guard.as_mut().map(Mapper::end_load).unwrap_or_default();
            return Ok(Connected {
                session: session.into(),
                history,
            });
        }
        if self.handshake.resume_session {
            ensure!(self.lock()?.is_none(), "The ACP session is already open");
            self.rpc
                .request("session/resume", self.session_params(session))?;
            *self.lock()? = Some(Mapper::new(session));
            // session/resume restores context without replaying history.
            return Ok(Connected {
                session: session.into(),
                history: vec![],
            });
        }
        bail!("This ACP agent did not declare session loading or resuming")
    }
}

impl Provider for Adapter {
    fn pid(&self) -> Option<u32> {
        Some(self.rpc.pid())
    }
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        super::ensure_default_config(config)?;
        if let Some(session) = resume {
            return self.resume(session);
        }
        ensure!(self.lock()?.is_none(), "The ACP session is already open");
        let response = self
            .rpc
            .request("session/new", json!({"cwd":self.cwd,"mcpServers":[]}))?;
        let session = response["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .context("ACP agent returned no session ID")?
            .to_owned();
        *self.lock()? = Some(Mapper::new(&session));
        Ok(Connected {
            session,
            history: vec![],
        })
    }
    fn send(
        &self,
        session: &str,
        _submission: &str,
        _message_id: Option<&str>,
        prompt: &crate::prompt::Prompt,
    ) -> Result<String> {
        let blocks = acp::prompt_blocks(prompt, &self.handshake)?;
        let turn = format!("turn-{}", uuid::Uuid::new_v4());
        {
            let mut guard = self.lock()?;
            let mapper = guard
                .as_mut()
                .filter(|m| m.session() == session)
                .context("Unknown ACP session")?;
            let started = mapper.begin_turn(&turn)?;
            // Started is queued before the prompt is written, so it precedes
            // every update of this turn.
            if self.events.try_send(started).is_err() {
                mapper.finish(Err(String::new()));
                bail!(TransportError::Overloaded);
            }
        }
        let rpc = self.rpc.clone();
        let mapper = self.mapper.clone();
        let events = self.events.clone();
        let params = json!({"sessionId":session,"prompt":blocks});
        std::thread::spawn(move || {
            let result = rpc.request_within("session/prompt", params, None);
            if result.is_err() && rpc.is_closed() {
                // The transport ended: its exit event reports the outcome as
                // unknown. Never claim the turn finished.
                return;
            }
            let finished = {
                let Ok(mut guard) = mapper.lock() else { return };
                let Some(mapper) = guard.as_mut() else { return };
                match &result {
                    Ok(value) => mapper.finish(Ok(value)),
                    // Agent errors reach here already reduced to a safe failure.
                    Err(error) => mapper.finish(Err(error.to_string())),
                }
            };
            for event in finished {
                let _ = events.send(event);
            }
        });
        Ok(turn)
    }
    fn cancel(&self, session: &str, turn: &str) -> Result<()> {
        let pending = {
            let mut guard = self.lock()?;
            let mapper = guard
                .as_mut()
                .filter(|m| m.session() == session && m.turn() == Some(turn))
                .context("That turn is not running")?;
            mapper.take_pending_permissions()
        };
        self.rpc
            .notify("session/cancel", json!({"sessionId":session}))?;
        // The protocol requires open permission requests of a cancelled turn
        // to be answered with the cancelled outcome.
        for id in pending {
            self.rpc.respond(id, acp::cancelled_outcome())?;
        }
        Ok(())
    }
    fn validate_answer(
        &self,
        p: &PendingRequest,
        decision: &str,
        answers: Option<&Value>,
    ) -> Result<()> {
        ensure!(p.method == acp::PERMISSION_METHOD, "Unknown ACP request");
        acp::permission_outcome(&p.params, decision, answers).map(|_| ())
    }
    fn answer(&self, p: &PendingRequest, decision: &str, answers: Option<&Value>) -> Result<()> {
        ensure!(p.method == acp::PERMISSION_METHOD, "Unknown ACP request");
        let outcome = acp::permission_outcome(&p.params, decision, answers)?;
        self.rpc.respond(p.rpc_id.clone(), outcome)?;
        if let Some(mapper) = self.lock()?.as_mut() {
            mapper.permission_settled(&p.rpc_id);
        }
        Ok(())
    }
    fn reject(&self, id: Value, message: &str) -> Result<()> {
        if let Some(mapper) = self.lock()?.as_mut() {
            mapper.permission_settled(&id);
        }
        self.rpc.reject(id, message)
    }
    fn stop(&self) {
        self.rpc.stop();
    }
    fn stop_confirmed(&self) -> Result<()> {
        self.rpc.stop_confirmed()
    }
}
