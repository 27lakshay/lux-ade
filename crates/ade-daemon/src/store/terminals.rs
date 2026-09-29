use super::terminal_records::{self as records, Stored};
use super::*;
use crate::receipts;
use ade_core::contract::terminals::{TerminalKind, TerminalRecord};

use ade_core::contract::layout::{LayoutRecord, Tab, TabTarget};
use ade_core::contract::terminals::TerminalPlace;

const TERMINAL_CREATE: &str = "terminal.create";

/// A terminal `terminal.create` made, and the layout its tab opened in.
pub struct PlacedTerminal {
    pub terminal_id: String,
    pub layout: Option<LayoutRecord>,
}
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

impl Store {
    pub fn reserve_terminal(&self, id: &str, instance: &str) -> Result<Conversation> {
        let tx = self.transaction()?;
        let mut c: Conversation = live_conversation(&tx, id)?;
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
        let workspace: WorkspaceRecord = one(&tx, "workspaces", &c.workspace_id)?;
        records::ensure_room(&tx, &workspace.id)?;
        let terminal_id = new_id("terminal");
        records::insert(
            &tx,
            &Stored {
                conversation_id: Some(c.id.clone()),
                ..Stored::new(&terminal_id, &workspace.id, TerminalKind::Conversation)
            },
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
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE json_extract(data,'$.terminal_owner.terminal_id')=?1 UNION ALL SELECT 1 FROM services WHERE json_extract(data,'$.terminal_id')=?1)", [terminal], |row| row.get(0))?)
    }
    pub fn register_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        let tx = self.transaction()?;
        let _: WorkspaceRecord = one(&tx, "workspaces", workspace_id)?;
        records::ensure_room(&tx, workspace_id)?;
        ensure!(
            records::load(&tx, run_id)?.is_none(),
            "Script run already exists"
        );
        records::insert(
            &tx,
            &Stored {
                script_run_id: Some(run_id.into()),
                label: Some(ade_core::scripts::run_name(run_id)?.into()),
                ..Stored::new(run_id, workspace_id, TerminalKind::Script)
            },
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn retire_script_run(&self, workspace_id: &str, run_id: &str) -> Result<()> {
        ade_core::scripts::run_name(run_id)?;
        ensure!(
            self.workspace_has_terminal(workspace_id, run_id)?,
            "Script run is unavailable"
        );
        self.retire_terminal(workspace_id, run_id).map(drop)
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
            _ => Ok(None),
        }
    }
    /// Adds a shell to a workspace. With an operation ID, the receipt
    /// commits with the new terminal, and a retry returns the same terminal.
    /// A title is part of the receipt's payload.
    pub fn create_terminal(
        &self,
        id: &str,
        operation_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<String> {
        Ok(self
            .create_placed_terminal(id, operation_id, title, None)?
            .terminal_id)
    }
    /// [`Self::create_terminal`], opening the new terminal's tab in `place`
    /// in the same transaction. `place` joins the receipt's payload, and a
    /// retry returns the terminal without placing it again.
    pub fn create_placed_terminal(
        &self,
        id: &str,
        operation_id: Option<&str>,
        title: Option<&str>,
        place: Option<&TerminalPlace>,
    ) -> Result<PlacedTerminal> {
        // Immediate: a deferred read that later writes fails at once with
        // "database is locked" when another connection to this database
        // committed in between; taking the write lock first waits instead.
        let tx = self.transaction()?;
        let now = now_ms();
        if let Some(operation_id) = operation_id {
            valid_creation_id(operation_id)?;
            // The title and the place join the payload only when given.
            let mut payload = json!({"workspace_id": id});
            if let Some(title) = title {
                payload["title"] = json!(title);
            }
            if let Some(place) = place {
                payload["place"] = json!(place);
            }
            match receipts::begin(&tx, operation_id, TERMINAL_CREATE, &payload, None, now)? {
                receipts::Admission::New => {}
                receipts::Admission::Replay(receipt) => {
                    let result = receipt
                        .result
                        .context("Terminal creation has no recorded result")?;
                    return Ok(PlacedTerminal {
                        terminal_id: creation(&result)?.1,
                        layout: None,
                    });
                }
                receipts::Admission::Conflict => anyhow::bail!(CREATION_CONFLICT),
                receipts::Admission::Expired => {
                    anyhow::bail!("Terminal request ID has expired; use a new ID")
                }
            }
        }
        let _: WorkspaceRecord = one(&tx, "workspaces", id)?;
        records::ensure_room(&tx, id)?;
        let terminal = new_id("terminal");
        records::insert(
            &tx,
            &Stored {
                name: title.map(str::to_owned),
                ..Stored::new(&terminal, id, TerminalKind::Shell)
            },
        )?;
        let layout = place
            .map(|place| {
                super::layouts::place_tab(
                    &tx,
                    &place.window_id,
                    id,
                    place.pane_id.as_deref(),
                    Tab {
                        id: format!("tab-{terminal}"),
                        target: TabTarget::Terminal {
                            id: terminal.clone(),
                        },
                    },
                )
            })
            .transpose()?
            .flatten();
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
        Ok(PlacedTerminal {
            terminal_id: terminal,
            layout,
        })
    }
    /// Removes a terminal from its workspace and its tabs from every layout.
    /// A removed primary shell is replaced by a new one. Removing an absent
    /// terminal changes nothing. Returns the layouts that lost a tab.
    pub fn retire_terminal(&self, id: &str, terminal: &str) -> Result<Vec<LayoutRecord>> {
        let tx = self.transaction()?;
        let _: WorkspaceRecord = one(&tx, "workspaces", id)?;
        let layouts = records::remove(&tx, id, terminal)?.unwrap_or_default();
        tx.commit()?;
        Ok(layouts)
    }
    /// A workspace's primary shell.
    pub fn primary_terminal(&self, workspace_id: &str) -> Result<String> {
        records::primary(&self.connection, workspace_id)
    }
    /// The IDs of a workspace's terminals in creation order.
    pub fn workspace_terminals(&self, workspace_id: &str) -> Result<Vec<String>> {
        Ok(records::of_workspace(&self.connection, workspace_id)?
            .into_iter()
            .map(|terminal| terminal.id)
            .collect())
    }
    /// Whether `terminal_id` is one of the workspace's terminals.
    pub fn workspace_has_terminal(&self, workspace_id: &str, terminal_id: &str) -> Result<bool> {
        Ok(records::load(&self.connection, terminal_id)?
            .is_some_and(|terminal| terminal.workspace_id == workspace_id))
    }
    /// One terminal's record, or `None` when no terminal has this ID.
    pub fn terminal(&self, id: &str) -> Result<Option<TerminalRecord>> {
        Ok(records::load(&self.connection, id)?.map(|stored| self.terminal_record(&stored)))
    }
    /// A stored terminal's record with its in-memory live state.
    pub(crate) fn terminal_record(&self, stored: &Stored) -> TerminalRecord {
        match self.live_terminals.lock().unwrap().get(&stored.id) {
            Some(live) => stored.record_with(live),
            None => stored.record(),
        }
    }
    /// The last known live state of every listed terminal, keyed by
    /// `(workspace_id, terminal_id)`. Forgets the live state of terminals
    /// that are gone.
    pub(crate) fn terminal_states(&self) -> Result<Vec<(String, String, records::Live)>> {
        let listed = records::visible(&self.connection)?;
        let mut memory = self.live_terminals.lock().unwrap();
        memory.retain(|id, _| listed.iter().any(|stored| &stored.id == id));
        Ok(listed
            .into_iter()
            .map(|stored| {
                let live = memory.get(&stored.id).cloned().unwrap_or(stored.live);
                (stored.workspace_id, stored.id, live)
            })
            .collect())
    }
    /// Keeps what the runtime shows of a terminal, writing only its durable
    /// part. Returns its record when that changed what the catalog lists.
    pub(crate) fn save_terminal_state(
        &self,
        id: &str,
        live: records::Live,
    ) -> Result<Option<TerminalRecord>> {
        records::save_live(
            &self.connection,
            &mut self.live_terminals.lock().unwrap(),
            id,
            live,
        )
    }
}
