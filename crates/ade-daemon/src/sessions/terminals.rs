//! `terminal.*` operations, terminal leases and view-terminal recovery.
use super::*;
use ade_core::contract::conversations::AckTag;
use ade_core::contract::terminals::{
    TerminalCreateRequest, TerminalCreated, TerminalOperation, TerminalOperationRequest,
    TerminalOperationTag, runtime,
};

impl Sessions {
    pub(super) fn terminal_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "terminal.create" => {
                for key in ["operation_id", "request_id"] {
                    if let Some(value) = request.get(key) {
                        ensure!(value.is_string(), "Invalid terminal request ID");
                    }
                }
                let create: TerminalCreateRequest = decode(request)?;
                let mut d = self.data.lock().unwrap();
                let terminal = d
                    .store
                    .create_terminal(&create.workspace_id, create.operation_id.as_deref())?;
                self.catalog_changed(&mut d)?;
                reply(&TerminalCreated {
                    tag: AckTag::Tag,
                    terminal_id: terminal,
                })
            }
            "terminal.operation" => {
                ensure!(
                    request.get("operation_id").is_some() || request.get("request_id").is_some(),
                    "Missing request_id"
                );
                let lookup: TerminalOperationRequest = decode(request)?;
                let workspace_id = non_empty("workspace_id", &lookup.workspace_id)?;
                let operation_id = non_empty("request_id", &lookup.operation_id)?;
                let d = self.data.lock().unwrap();
                let (owner, terminal_id) = d
                    .store
                    .terminal_creation(operation_id)?
                    .context("Terminal operation is unavailable")?;
                ensure!(
                    owner == workspace_id,
                    "Terminal operation belongs to another workspace"
                );
                reply(&TerminalOperation {
                    tag: TerminalOperationTag::Tag,
                    workspace_id: owner,
                    request_id: operation_id.to_owned(),
                    terminal_id,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
    pub fn terminal_reserved(&self, terminal: &str) -> Result<bool> {
        self.data.lock().unwrap().store.terminal_reserved(terminal)
    }
    pub fn retire_terminal(&self, workspace: &str, terminal: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.store.terminal_reserved(terminal)?,
            "Remove its service, or return the Conversation to the GUI before retiring this terminal"
        );
        d.store.retire_terminal(workspace, terminal)?;
        self.catalog_changed(&mut d)
    }
    pub(super) fn clear_view_terminal(&self, id: &str) -> Result<()> {
        let c = self.data.lock().unwrap().store.conversation(id)?;
        let Some(owner) = c.view_terminal.clone().or(c.terminal_owner.clone()) else {
            return Ok(());
        };
        if owner.runtime_instance == self.runtime.instance {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut stopped = false;
            loop {
                let state: runtime::Terminals = serde_json::from_value(
                    self.runtime.command(runtime::Command::List.to_value())?,
                )
                .context("Invalid terminal catalogue")?;
                let terminal = state
                    .terminals
                    .iter()
                    .find(|t| t.workspace.terminal_id == owner.terminal_id);
                let Some(terminal) = terminal else { break };
                ensure!(
                    terminal.metrics["transfer_id"] == owner.transfer_id,
                    "Terminal view ownership changed"
                );
                if terminal.metrics["shell_running"] == false {
                    self.runtime.command(
                        runtime::Command::Retire {
                            workspace_id: c.workspace_id.clone(),
                            terminal_id: owner.terminal_id.clone(),
                        }
                        .to_value(),
                    )?;
                    break;
                }
                if !stopped {
                    self.runtime.command(
                        runtime::Command::Stop {
                            workspace_id: c.workspace_id.clone(),
                            terminal_id: owner.terminal_id.clone(),
                        }
                        .to_value(),
                    )?;
                    stopped = true;
                }
                ensure!(
                    std::time::Instant::now() < deadline,
                    "Terminal view is still stopping; retry resume"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let mut d = self.data.lock().unwrap();
        let mut current = d.store.conversation(id)?;
        ensure!(
            current
                .view_terminal
                .as_ref()
                .or(current.terminal_owner.as_ref())
                == Some(&owner),
            "Terminal view changed during recovery"
        );
        current.view_terminal = None;
        if current.terminal_owner.take().is_some() {
            current.status = "disconnected".into();
            current.runtime_run = None;
            current.runtime_submission = None;
            current.runtime_cursor = 0;
            current.error = None;
        }
        d.store.commit_conversation(&current, &[], &[])?;
        d.store
            .retire_terminal(&c.workspace_id, &owner.terminal_id)?;
        self.catalog_changed(&mut d)?;
        self.changed(&mut d, &current, &[])?;
        Ok(())
    }
}
