use super::*;
use crate::receipts;

const TERMINAL_CREATE: &str = "terminal.create";
const CREATION_CONFLICT: &str = "Terminal request ID conflicts with another workspace";

fn valid_creation_id(operation_id: &str) -> Result<()> {
    ensure!(
        !operation_id.is_empty() && operation_id.len() <= 256,
        "Invalid terminal request ID"
    );
    Ok(())
}

/// The `(workspace_id, terminal_id)` stored in a `terminal.create` receipt.
fn creation(result: &Value) -> Result<(String, String)> {
    let field = |key: &str| {
        result[key]
            .as_str()
            .map(str::to_owned)
            .context("Terminal creation receipt is invalid")
    };
    Ok((field("workspace_id")?, field("terminal_id")?))
}

/// Creations recorded in `terminal_creations` before receipts moved to the
/// shared `operations` table. Nothing writes that table any more.
fn legacy_creation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<(String, String)>> {
    connection
        .query_row(
            "SELECT workspace_id,terminal_id FROM terminal_creations WHERE request_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(Into::into)
}

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
    /// The workspace and terminal a settled `terminal.create` receipt produced.
    pub fn terminal_creation(&self, operation_id: &str) -> Result<Option<(String, String)>> {
        valid_creation_id(operation_id)?;
        let receipt: Option<(String, String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT op,status,result FROM operations WHERE id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match receipt {
            Some((op, status, Some(result)))
                if op == TERMINAL_CREATE && status == receipts::Status::Settled.as_str() =>
            {
                creation(&serde_json::from_str(&result)?).map(Some)
            }
            Some(_) => Ok(None),
            None => legacy_creation(&self.connection, operation_id),
        }
    }
    /// Adds a terminal to a workspace. With an operation ID, the receipt
    /// commits with the new terminal, and a retry returns the same terminal.
    pub fn create_terminal(&self, id: &str, operation_id: Option<&str>) -> Result<String> {
        // Immediate: a deferred read that later writes fails at once with
        // "database is locked" when another connection to this database
        // committed in between; taking the write lock first waits instead.
        let tx = self.transaction()?;
        let now = now_ms();
        if let Some(operation_id) = operation_id {
            valid_creation_id(operation_id)?;
            if let Some((workspace_id, terminal_id)) = legacy_creation(&tx, operation_id)? {
                ensure!(workspace_id == id, CREATION_CONFLICT);
                return Ok(terminal_id);
            }
            let payload = json!({"workspace_id": id});
            match receipts::begin(&tx, operation_id, TERMINAL_CREATE, &payload, None, now)? {
                receipts::Admission::New => {}
                receipts::Admission::Replay(receipt) => {
                    let result = receipt
                        .result
                        .context("Terminal creation has no recorded result")?;
                    return Ok(creation(&result)?.1);
                }
                receipts::Admission::Conflict => anyhow::bail!(CREATION_CONFLICT),
                receipts::Admission::Expired => {
                    anyhow::bail!("Terminal request ID has expired; use a new ID")
                }
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
        if let Some(operation_id) = operation_id {
            receipts::settle(
                &tx,
                operation_id,
                receipts::Status::Settled,
                Some(&json!({"workspace_id": id, "terminal_id": terminal})),
                now,
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
