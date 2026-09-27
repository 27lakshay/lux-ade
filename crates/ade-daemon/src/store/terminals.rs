use super::*;

pub(crate) fn forget_terminal_views(tx: &Connection, terminal: &str) -> Result<()> {
    for mut window in all::<WindowRecord>(tx, "SELECT data FROM windows")? {
        window.tabs.terminals.retain(|tab| tab.id != terminal);
        window
            .tabs
            .closed_terminals
            .retain(|tab| tab.id != terminal);
        if window.tabs.active_terminal.as_deref() == Some(terminal) {
            window.tabs.active_terminal = None;
        }
        tx.execute(
            "UPDATE windows SET data=?2 WHERE id=?1",
            params![window.id, encode(&window)?],
        )?;
    }
    Ok(())
}

impl Store {
    pub fn reserve_terminal(&self, id: &str, instance: &str) -> Result<Conversation> {
        let tx = self.transaction()?;
        let mut c: Conversation = one(&tx, "conversations", id)?;
        if c.terminal_owner.is_some() {
            return Ok(c);
        }
        ensure!(
            !BUSY.contains(&c.status.as_str()) && c.active_turn_id.is_none(),
            "Cancel the active turn before transferring"
        );
        ensure!(
            c.provider_thread_id.is_some(),
            "Start the Conversation before transferring"
        );
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", &c.workspace_id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        let terminal_id = new_id("terminal");
        workspace.extra_terminals.push(terminal_id.clone());
        tx.execute(
            "UPDATE workspaces SET data=?1 WHERE id=?2",
            params![encode(&workspace)?, workspace.id],
        )?;
        c.terminal_owner = Some(TerminalOwner {
            terminal_id,
            transfer_id: new_id("transfer"),
            runtime_instance: instance.into(),
        });
        c.queue_paused = true;
        c.status = "terminal".into();
        c.updated_at = now_ms();
        write_conversation(&tx, &c)?;
        tx.commit()?;
        Ok(c)
    }
    pub fn terminal_reserved(&self, terminal: &str) -> Result<bool> {
        if ade_core::scripts::run_name(terminal).is_ok() {
            return Ok(true);
        }
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE (json_extract(data,'$.terminal_owner.terminal_id')=?1 OR json_extract(data,'$.view_terminal.terminal_id')=?1) UNION ALL SELECT 1 FROM services WHERE json_extract(data,'$.terminal_id')=?1)", [terminal], |row| row.get(0))?)
    }
    pub fn register_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", workspace_id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        ensure!(
            !workspace.extra_terminals.iter().any(|id| id == run_id),
            "Script run already exists"
        );
        workspace.extra_terminals.push(run_id.to_owned());
        tx.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![workspace_id, encode(&workspace)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn retire_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        let workspace = self.workspace(workspace_id)?;
        ensure!(
            workspace.extra_terminals.iter().any(|id| id == run_id),
            "Script run is unavailable"
        );
        self.retire_terminal(workspace_id, run_id)
    }
    pub fn terminal_creation(&self, request_id: &str) -> Result<Option<(String, String)>> {
        ensure!(
            !request_id.is_empty() && request_id.len() <= 256,
            "Invalid terminal request ID"
        );
        self.connection
            .query_row(
                "SELECT workspace_id,terminal_id FROM terminal_creations WHERE request_id=?1",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }
    pub fn create_terminal(&self, id: &str, request_id: Option<&str>) -> Result<String> {
        let tx = self.connection.unchecked_transaction()?;
        if let Some(request_id) = request_id {
            ensure!(
                !request_id.is_empty() && request_id.len() <= 256,
                "Invalid terminal request ID"
            );
            let prior: Option<(String, String)> = tx
                .query_row(
                    "SELECT workspace_id,terminal_id FROM terminal_creations WHERE request_id=?1",
                    [request_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((workspace_id, terminal_id)) = prior {
                ensure!(
                    workspace_id == id,
                    "Terminal request ID conflicts with another workspace"
                );
                return Ok(terminal_id);
            }
        }
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        ensure!(
            workspace.extra_terminals.len() < 32,
            "Workspace terminal limit reached"
        );
        let terminal = new_id("terminal");
        workspace.extra_terminals.push(terminal.clone());
        tx.execute(
            "UPDATE workspaces SET data=?1 WHERE id=?2",
            params![encode(&workspace)?, id],
        )?;
        if let Some(request_id) = request_id {
            tx.execute(
                "INSERT INTO terminal_creations VALUES(?1,?2,?3)",
                params![request_id, id, terminal],
            )?;
        }
        tx.commit()?;
        Ok(terminal)
    }
    pub fn retire_terminal(&self, id: &str, terminal: &str) -> Result<()> {
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        if workspace.terminal_id != terminal
            && !workspace
                .extra_terminals
                .iter()
                .any(|item| item == terminal)
        {
            return Ok(());
        }
        if workspace.terminal_id == terminal {
            workspace.terminal_id = new_id("terminal");
        } else {
            workspace.extra_terminals.retain(|item| item != terminal);
        }
        tx.execute(
            "UPDATE workspaces SET terminal_id=?2,data=?3 WHERE id=?1",
            params![id, workspace.terminal_id, encode(&workspace)?],
        )?;
        forget_terminal_views(&tx, terminal)?;
        tx.commit()?;
        Ok(())
    }
}
