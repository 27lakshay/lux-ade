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
    fn open(&self, resume: Option<&str>, config: &Config) -> Result<Connected> {
        provider::response_session(&self.rpc, resume, config)
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
