//! `terminal.*` operations, terminal leases and view-terminal recovery.
use super::*;

impl Sessions {
    pub(super) fn terminal_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let string = required_str(request);
        match request["op"].as_str().unwrap_or("") {
            "terminal.create" => {
                let mut d = self.data.lock().unwrap();
                let request_id = match request.get("request_id") {
                    Some(value) => Some(value.as_str().context("Invalid terminal request ID")?),
                    None => None,
                };
                let terminal = d
                    .store
                    .create_terminal(string("workspace_id")?, request_id)?;
                self.catalog_changed(&mut d)?;
                Ok(json!({"type":"ack", "terminal_id":terminal}))
            }
            "terminal.operation" => {
                let d = self.data.lock().unwrap();
                let workspace_id = string("workspace_id")?;
                let request_id = string("request_id")?;
                let (owner, terminal_id) = d
                    .store
                    .terminal_creation(request_id)?
                    .context("Terminal operation is unavailable")?;
                ensure!(
                    owner == workspace_id,
                    "Terminal operation belongs to another workspace"
                );
                Ok(json!({"type":"terminal_operation", "workspace_id":owner,
                    "request_id":request_id, "terminal_id":terminal_id}))
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
                let state = self.runtime.command(json!({"op":"terminal.list"}))?;
                let terminal = state["terminals"]
                    .as_array()
                    .context("Invalid terminal catalogue")?
                    .iter()
                    .find(|t| t["workspace"]["terminal_id"] == owner.terminal_id);
                let Some(terminal) = terminal else { break };
                ensure!(
                    terminal["metrics"]["transfer_id"] == owner.transfer_id,
                    "Terminal view ownership changed"
                );
                if terminal["metrics"]["shell_running"] == false {
                    self.runtime.command(json!({"op":"terminal.retire","workspace_id":c.workspace_id,"terminal_id":owner.terminal_id}))?;
                    break;
                }
                if !stopped {
                    self.runtime.command(json!({"op":"terminal.stop","workspace_id":c.workspace_id,"terminal_id":owner.terminal_id}))?;
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
