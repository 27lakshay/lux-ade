//! `workspace.remove` ("Remove from ADE"): the daemon half, which owns the
//! runtime's terminals and this daemon's terminal leases. The profile
//! database half is `Sessions::remove_workspace`. The envelope records the
//! operation's receipt (see `ade_daemon::envelope`).
use super::{Host, decode, reply};
use ade_core::contract::terminals::runtime as terminal_runtime;
use ade_core::contract::workspaces::{WorkspaceRemoveRequest, WorkspaceRemoved};
use ade_core::workspaces::{RemoveBlocker, RemoveBlockerKind};
use serde_json::Value;
use std::time::{Duration, Instant};

/// How long removal waits for stopped shells, and their process trees, to exit.
const STOP_WAIT: Duration = Duration::from_secs(10);

impl Host {
    /// `workspace.remove`. A repeat on a removed workspace changes nothing
    /// except to stop a terminal that is somehow still running.
    pub(super) fn workspace_remove(&self, request: &Value) -> anyhow::Result<Value> {
        let remove: WorkspaceRemoveRequest = decode(request)?;
        let id = remove.workspace_id.as_str();
        anyhow::ensure!(!id.is_empty(), "Missing workspace_id");
        self.remove_from_ade(id, &remove.operation_id)?;
        Ok(removed(id))
    }

    /// Removes a workspace from ADE under `operation_id`, or finishes an
    /// earlier removal: records it, stops its terminals and releases its
    /// leases. `workspace.delete_worktree` takes the same step.
    pub(super) fn remove_from_ade(&self, id: &str, operation_id: &str) -> anyhow::Result<()> {
        {
            // Holding the lease map serializes removal with terminal
            // attachment, which starts shells under the same lock.
            let _attachments = self.leases.lock().unwrap();
            if !self.sessions.workspace_removed(id)? {
                let blockers = self.runtime_blockers(id)?;
                self.sessions.remove_workspace(id, operation_id, blockers)?;
            }
            self.stop_removed_terminals(id)?;
            // The record first, as `terminal.retire` does: runtime state of a
            // terminal the record no longer lists is then safe to release.
            let record = self.sessions.retire_removed_terminals(id)?;
            for terminal in self.runtime_terminals()? {
                let terminal_id = terminal.workspace.terminal_id;
                if terminal.workspace.id == id
                    && terminal_id != record.terminal_id
                    && !record.extra_terminals.contains(&terminal_id)
                {
                    self.runtime.command(terminal_runtime::Command::Retire {
                        workspace_id: id.to_owned(),
                        terminal_id,
                    })?;
                }
            }
        }
        // Drops this workspace's worktree lease at once, so the folder's
        // host-wide claim no longer reports active work.
        self.refresh_leases()?;
        Ok(())
    }

    /// What only the daemon can see blocks removal: its default workspace and
    /// script runs still running in the runtime.
    pub(super) fn runtime_blockers(&self, id: &str) -> anyhow::Result<Vec<RemoveBlocker>> {
        let mut blockers = Vec::new();
        if id == self.default_workspace {
            blockers.push(RemoveBlocker {
                kind: RemoveBlockerKind::DefaultWorkspace,
                id: id.to_owned(),
                label: "The daemon's default workspace".into(),
            });
        }
        for terminal in self.runtime_terminals()? {
            let run_id = &terminal.workspace.terminal_id;
            if terminal.workspace.id == id
                && terminal.shell_running()
                && let Ok(name) = ade_core::scripts::run_name(run_id)
            {
                blockers.push(RemoveBlocker {
                    kind: RemoveBlockerKind::ScriptRunning,
                    id: run_id.clone(),
                    label: format!("Script {name}"),
                });
            }
        }
        Ok(blockers)
    }

    /// Stops every running terminal of a removed workspace and waits,
    /// bounded, until none runs.
    fn stop_removed_terminals(&self, id: &str) -> anyhow::Result<()> {
        for terminal in self.running_terminals(id)? {
            self.runtime.command(terminal_runtime::Command::Stop {
                workspace_id: id.to_owned(),
                terminal_id: terminal,
                if_idle: false,
            })?;
        }
        let deadline = Instant::now() + STOP_WAIT;
        while !self.running_terminals(id)?.is_empty() {
            anyhow::ensure!(
                Instant::now() < deadline,
                "The workspace was removed, but a terminal is still stopping; retry workspace.remove"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    fn running_terminals(&self, id: &str) -> anyhow::Result<Vec<String>> {
        Ok(self
            .runtime_terminals()?
            .into_iter()
            .filter(|terminal| terminal.workspace.id == id && terminal.shell_running())
            .map(|terminal| terminal.workspace.terminal_id)
            .collect())
    }

    /// After a daemon stopped mid-removal: the removal is proven when the
    /// workspace is removed and none of its terminals runs.
    pub(super) fn observe_workspace_remove(&self, request: &Value) -> Option<Value> {
        let id = request["workspace_id"].as_str()?;
        (self.sessions.workspace_removed(id).ok()? && self.running_terminals(id).ok()?.is_empty())
            .then(|| removed(id))
    }
}

fn removed(id: &str) -> Value {
    reply(&WorkspaceRemoved {
        tag: Default::default(),
        workspace_id: id.to_owned(),
    })
}
