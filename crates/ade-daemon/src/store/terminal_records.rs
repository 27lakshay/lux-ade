//! Terminal records: each terminal is stored flat by ID with one owning
//! workspace (daemon-authority map, "The model").
//!
//! The `terminals` table is the source of truth for which terminals a
//! workspace has. The workspace's `terminal_id` and `extra_terminals` are
//! derived from it by [`derive`] in the same transaction as every change, and
//! are kept for one release (removed by ticket 08 of the daemon-authority map).
//! Every change to a workspace's terminals goes through [`insert`] and
//! [`remove`].
//!
//! What runs in a terminal (`status`, `busy`, the foreground command and the
//! title the program set) is observed from the runtime by [`observe`] and
//! saved with the record, so a restarted daemon lists the last known state
//! until the runtime is read again.
use super::*;
use ade_core::contract::terminals::{TerminalKind, TerminalRecord, TerminalStatus, runtime};
use serde::Deserialize;

/// A stored terminal. [`Stored::record`] is what the catalog lists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Stored {
    pub id: String,
    pub workspace_id: String,
    pub kind: TerminalKind,
    #[serde(default)]
    pub primary: bool,
    /// The title given at creation.
    #[serde(default)]
    pub name: Option<String>,
    /// The service or script name, shown when the program sets no title.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub service_id: Option<String>,
    #[serde(default)]
    pub script_run_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub live: Live,
}

/// What the runtime last showed of a terminal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub(crate) struct Live {
    #[serde(default)]
    pub status: TerminalStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub foreground: Option<String>,
    /// The title the program set.
    #[serde(default)]
    pub title: Option<String>,
    /// The terminal's own program, such as `zsh`.
    #[serde(default)]
    pub program: Option<String>,
}

impl Stored {
    pub fn new(id: &str, workspace_id: &str, kind: TerminalKind) -> Self {
        Self {
            id: id.into(),
            workspace_id: workspace_id.into(),
            kind,
            primary: false,
            name: None,
            label: None,
            service_id: None,
            script_run_id: None,
            conversation_id: None,
            live: Live::default(),
        }
    }
    pub fn primary(id: &str, workspace_id: &str) -> Self {
        Self {
            primary: true,
            ..Self::new(id, workspace_id, TerminalKind::Shell)
        }
    }
    pub fn record(&self) -> TerminalRecord {
        let live = &self.live;
        let title = self
            .name
            .clone()
            .or_else(|| live.title.clone())
            .or_else(|| self.label.clone())
            .or_else(|| live.program.clone())
            .unwrap_or_else(|| {
                match self.kind {
                    TerminalKind::Shell => "Shell",
                    TerminalKind::Service => "Service",
                    TerminalKind::Script => "Script",
                    TerminalKind::Conversation => "Conversation",
                }
                .into()
            });
        TerminalRecord {
            id: self.id.clone(),
            workspace_id: self.workspace_id.clone(),
            kind: self.kind,
            title,
            status: live.status,
            exit_code: live.exit_code,
            busy: live.busy,
            foreground: live.foreground.clone(),
            primary: self.primary,
            service_id: self.service_id.clone(),
            script_run_id: self.script_run_id.clone(),
            conversation_id: self.conversation_id.clone(),
        }
    }
}

/// The exit code in a runtime `exit_status`: the code of a plain exit, or
/// 128 plus the signal of one ended by a signal. An unconfirmed process tree
/// reports its child's status under `child`.
fn exit_code(status: &Value) -> Option<i32> {
    let status = if status["kind"] == "unknown" {
        &status["child"]
    } else {
        status
    };
    match status["kind"].as_str()? {
        "success" | "failure" => status["code"].as_i64().and_then(|c| i32::try_from(c).ok()),
        "signaled" => status["signal"]
            .as_i64()
            .and_then(|s| i32::try_from(128 + s).ok()),
        _ => None,
    }
}

/// A terminal's live state from the runtime's entry for it, or from its
/// absence: a terminal the runtime no longer lists was stopped (the runtime
/// retired it or restarted), unless it never ran.
pub(crate) fn observe(previous: &Live, entry: Option<&runtime::Terminal>) -> Live {
    let Some(entry) = entry else {
        return Live {
            status: match previous.status {
                TerminalStatus::Running => TerminalStatus::Stopped,
                status => status,
            },
            busy: false,
            foreground: None,
            ..previous.clone()
        };
    };
    let activity = &entry.activity;
    let mut live = Live {
        title: activity.title.clone(),
        program: activity
            .program
            .clone()
            .or_else(|| previous.program.clone()),
        ..Live::default()
    };
    if entry.shell_running() {
        live.status = TerminalStatus::Running;
        live.busy = activity.busy;
        live.foreground = activity.foreground.clone().filter(|_| activity.busy);
    } else if activity.stop_requested {
        live.status = TerminalStatus::Stopped;
    } else {
        live.status = TerminalStatus::Exited;
        live.exit_code = exit_code(&entry.metrics["exit_status"]);
    }
    live
}

pub(crate) fn ensure_table(tx: &Connection) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS terminals_by_workspace ON terminals(workspace_id);",
    )?;
    Ok(())
}

/// The schema change: the `terminals` table, filled from every workspace's
/// `terminal_id` and `extra_terminals`. The coordinator assigns its schema
/// version at merge.
pub(crate) fn migrate_terminal_records(tx: &Connection) -> Result<()> {
    ensure_table(tx)?;
    backfill(tx)
}

/// Adds a record for every terminal a workspace lists without one, keeping
/// the workspace's order. Each terminal's kind is read from what owns it: a
/// script run's ID, a service that names it, or a Conversation handed to it.
pub(crate) fn backfill(tx: &Connection) -> Result<()> {
    let workspaces: Vec<WorkspaceRecord> = all(tx, "SELECT data FROM workspaces ORDER BY rowid")?;
    for workspace in workspaces {
        let ids = std::iter::once(&workspace.terminal_id).chain(&workspace.extra_terminals);
        for id in ids {
            if load(tx, id)?.is_some() {
                continue;
            }
            let primary = id == &workspace.terminal_id;
            let stored = if primary {
                Stored::primary(id, &workspace.id)
            } else {
                classify(tx, &workspace.id, id)?
            };
            write(tx, &stored)?;
        }
    }
    Ok(())
}

fn classify(tx: &Connection, workspace_id: &str, id: &str) -> Result<Stored> {
    if let Ok(name) = ade_core::scripts::run_name(id) {
        return Ok(Stored {
            script_run_id: Some(id.into()),
            label: Some(name.into()),
            ..Stored::new(id, workspace_id, TerminalKind::Script)
        });
    }
    let service: Option<String> = tx
        .query_row(
            "SELECT data FROM services WHERE workspace_id=?1 AND json_extract(data,'$.terminal_id')=?2",
            params![workspace_id, id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(service) = service {
        let service: ade_core::services::Service = decode(service)?;
        return Ok(Stored {
            service_id: Some(service.identity),
            label: Some(service.name),
            ..Stored::new(id, workspace_id, TerminalKind::Service)
        });
    }
    let conversation: Option<String> = tx
        .query_row(
            "SELECT id FROM conversations WHERE json_extract(data,'$.terminal_owner.terminal_id')=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match conversation {
        Some(conversation) => Stored {
            conversation_id: Some(conversation),
            ..Stored::new(id, workspace_id, TerminalKind::Conversation)
        },
        None => Stored::new(id, workspace_id, TerminalKind::Shell),
    })
}

pub(crate) fn load(db: &Connection, id: &str) -> Result<Option<Stored>> {
    db.query_row("SELECT data FROM terminals WHERE id=?1", [id], |row| {
        row.get::<_, String>(0)
    })
    .optional()?
    .map(decode)
    .transpose()
}

fn of_workspace(db: &Connection, workspace_id: &str) -> Result<Vec<Stored>> {
    let mut statement =
        db.prepare("SELECT data FROM terminals WHERE workspace_id=?1 ORDER BY rowid")?;
    statement
        .query_map([workspace_id], |row| row.get::<_, String>(0))?
        .map(|row| decode(row?))
        .collect()
}

/// The terminals of workspaces that are not removed, in creation order.
pub(crate) fn visible(db: &Connection) -> Result<Vec<Stored>> {
    all(
        db,
        "SELECT data FROM terminals WHERE workspace_id NOT IN (SELECT workspace_id FROM workspace_tombstones) ORDER BY rowid",
    )
}

fn write(tx: &Connection, stored: &Stored) -> Result<()> {
    tx.execute(
        "INSERT INTO terminals VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![stored.id, stored.workspace_id, encode(stored)?],
    )?;
    Ok(())
}

/// Saves a terminal's live state. Returns the new record when it changed.
pub(crate) fn save_live(tx: &Connection, id: &str, live: Live) -> Result<Option<TerminalRecord>> {
    let Some(mut stored) = load(tx, id)? else {
        return Ok(None);
    };
    if stored.live == live {
        return Ok(None);
    }
    let before = stored.record();
    stored.live = live;
    tx.execute(
        "UPDATE terminals SET data=?2 WHERE id=?1",
        params![id, encode(&stored)?],
    )?;
    let after = stored.record();
    Ok((after != before).then_some(after))
}

/// Adds a terminal to its workspace.
pub(crate) fn insert(tx: &Connection, stored: &Stored) -> Result<()> {
    ensure!(
        load(tx, &stored.id)?.is_none(),
        "Terminal {} already exists",
        stored.id
    );
    write(tx, stored)?;
    derive(tx, &stored.workspace_id)
}

/// Removes a terminal from its workspace, with its tabs in saved windows. A
/// removed primary shell is replaced by a new one that has not started.
/// Returns false when the workspace has no such terminal.
pub(crate) fn remove(tx: &Connection, workspace_id: &str, terminal_id: &str) -> Result<bool> {
    let Some(stored) = load(tx, terminal_id)?.filter(|s| s.workspace_id == workspace_id) else {
        return Ok(false);
    };
    tx.execute("DELETE FROM terminals WHERE id=?1", [terminal_id])?;
    if stored.primary {
        write(tx, &Stored::primary(&new_id("terminal"), workspace_id))?;
    }
    super::forget_terminal_views(tx, terminal_id)?;
    // TODO(lane A): once daemon layouts merge, remove this terminal's tabs
    // from every layout in this same transaction:
    // `layouts::remove_target(tx, &TabTarget::Terminal { id: terminal_id })`.
    derive(tx, workspace_id)?;
    Ok(true)
}

/// Rewrites a workspace's `terminal_id` and `extra_terminals` from its
/// terminal records. A workspace without a primary record keeps its
/// `terminal_id` and gains a record for it.
pub(crate) fn derive(tx: &Connection, workspace_id: &str) -> Result<()> {
    let mut workspace: WorkspaceRecord = one(tx, "workspaces", workspace_id)?;
    let mut terminals = of_workspace(tx, workspace_id)?;
    if !terminals.iter().any(|terminal| terminal.primary) {
        let primary = Stored::primary(&workspace.terminal_id, workspace_id);
        write(tx, &primary)?;
        terminals.insert(0, primary);
    }
    let (primary, extra): (Vec<_>, Vec<_>) = terminals.into_iter().partition(|t| t.primary);
    workspace.terminal_id = primary[0].id.clone();
    workspace.extra_terminals = extra.into_iter().map(|terminal| terminal.id).collect();
    tx.execute(
        "UPDATE workspaces SET terminal_id=?2,data=?3 WHERE id=?1",
        params![workspace_id, workspace.terminal_id, encode(&workspace)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::terminals::runtime::{Activity, Terminal};

    fn entry(metrics: Value, activity: Activity) -> Terminal {
        Terminal {
            workspace: serde_json::from_value(json!({
                "id": "w", "repository_id": null, "root": "/tmp/w", "name": "w", "terminal_id": "t",
            }))
            .unwrap(),
            metrics,
            activity,
        }
    }

    #[test]
    fn a_running_shell_is_busy_only_while_another_group_holds_the_foreground() {
        let idle = observe(
            &Live::default(),
            Some(&entry(
                json!({"shell_running": true}),
                Activity {
                    program: Some("zsh".into()),
                    ..Default::default()
                },
            )),
        );
        assert_eq!(idle.status, TerminalStatus::Running);
        assert!(!idle.busy && idle.foreground.is_none());
        let busy = observe(
            &idle,
            Some(&entry(
                json!({"shell_running": true}),
                Activity {
                    busy: true,
                    foreground: Some("sleep".into()),
                    program: Some("zsh".into()),
                    ..Default::default()
                },
            )),
        );
        assert!(busy.busy);
        assert_eq!(busy.foreground.as_deref(), Some("sleep"));
    }

    #[test]
    fn an_exit_reports_its_code_and_a_stop_reports_stopped() {
        let running = Live {
            status: TerminalStatus::Running,
            program: Some("zsh".into()),
            ..Default::default()
        };
        let exited = observe(
            &running,
            Some(&entry(
                json!({"shell_running": false, "exit_status": {"kind": "failure", "code": 3}}),
                Activity::default(),
            )),
        );
        assert_eq!(exited.status, TerminalStatus::Exited);
        assert_eq!(exited.exit_code, Some(3));
        assert_eq!(exited.program.as_deref(), Some("zsh"));
        let signalled = observe(
            &running,
            Some(&entry(
                json!({"shell_running": false, "exit_status": {"kind": "unknown", "verifying": true,
                    "child": {"kind": "signaled", "signal": 9}}}),
                Activity::default(),
            )),
        );
        assert_eq!(signalled.exit_code, Some(137));
        let stopped = observe(
            &running,
            Some(&entry(
                json!({"shell_running": false, "exit_status": {"kind": "signaled", "signal": 1}}),
                Activity {
                    stop_requested: true,
                    ..Default::default()
                },
            )),
        );
        assert_eq!(stopped.status, TerminalStatus::Stopped);
        assert_eq!(stopped.exit_code, None);
    }

    #[test]
    fn a_terminal_the_runtime_lost_is_stopped_but_one_never_started_stays_so() {
        let running = Live {
            status: TerminalStatus::Running,
            busy: true,
            foreground: Some("vim".into()),
            ..Default::default()
        };
        let lost = observe(&running, None);
        assert_eq!(lost.status, TerminalStatus::Stopped);
        assert!(!lost.busy && lost.foreground.is_none());
        assert_eq!(
            observe(&Live::default(), None).status,
            TerminalStatus::NotStarted
        );
        let exited = Live {
            status: TerminalStatus::Exited,
            exit_code: Some(0),
            ..Default::default()
        };
        assert_eq!(observe(&exited, None), exited);
    }

    /// A scratch profile database and workspace folder, removed on drop.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(new_id("ade-terminal-records"));
            std::fs::create_dir_all(directory.join("workspace")).unwrap();
            Self(directory.canonicalize().unwrap())
        }
        fn open(&self) -> Store {
            Store::open(&self.0.join("state.sqlite")).unwrap()
        }
        fn root(&self) -> String {
            self.0.join("workspace").to_string_lossy().into_owned()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn records_own_the_workspace_terminal_fields() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        let primary = store.terminal(&workspace.terminal_id).unwrap().unwrap();
        assert!(primary.primary && primary.kind == TerminalKind::Shell);
        assert_eq!(primary.status, TerminalStatus::NotStarted);

        let named = store
            .create_terminal(&workspace.id, None, Some("Logs"))
            .unwrap();
        let plain = store.create_terminal(&workspace.id, None, None).unwrap();
        let listed = |store: &Store| store.workspace(&workspace.id).unwrap();
        assert_eq!(
            listed(&store).extra_terminals,
            vec![named.clone(), plain.clone()]
        );
        assert_eq!(store.terminal(&named).unwrap().unwrap().title, "Logs");
        let ids: Vec<_> = store
            .catalog()
            .unwrap()
            .terminals
            .into_iter()
            .map(|terminal| terminal.id)
            .collect();
        assert_eq!(
            ids,
            vec![workspace.terminal_id.clone(), named.clone(), plain.clone()]
        );

        // Retiring the primary shell gives the workspace a new one.
        store
            .retire_terminal(&workspace.id, &workspace.terminal_id)
            .unwrap();
        let replaced = listed(&store).terminal_id;
        assert_ne!(replaced, workspace.terminal_id);
        assert!(store.terminal(&workspace.terminal_id).unwrap().is_none());
        assert!(store.terminal(&replaced).unwrap().unwrap().primary);
        store.retire_terminal(&workspace.id, &named).unwrap();
        assert_eq!(listed(&store).extra_terminals, vec![plain.clone()]);

        // A terminal a workspace lists without a record gains one on open.
        store
            .connection
            .execute("DELETE FROM terminals WHERE id=?1", [&plain])
            .unwrap();
        drop(store);
        let store = scratch.open();
        assert_eq!(
            store.terminal(&plain).unwrap().unwrap().kind,
            TerminalKind::Shell
        );
        assert_eq!(listed(&store).extra_terminals, vec![plain]);
    }

    #[test]
    fn live_state_is_saved_and_reported_only_when_the_record_changes() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        let running = Live {
            status: TerminalStatus::Running,
            program: Some("zsh".into()),
            ..Default::default()
        };
        let changed = store
            .save_terminal_state(&workspace.terminal_id, running.clone())
            .unwrap()
            .unwrap();
        assert_eq!(changed.status, TerminalStatus::Running);
        assert_eq!(changed.title, "zsh");
        assert!(
            store
                .save_terminal_state(&workspace.terminal_id, running)
                .unwrap()
                .is_none()
        );
        drop(store);
        let store = scratch.open();
        assert_eq!(
            store
                .terminal(&workspace.terminal_id)
                .unwrap()
                .unwrap()
                .status,
            TerminalStatus::Running
        );
    }

    #[test]
    fn the_title_prefers_the_given_name_then_the_program_title_then_its_name() {
        let mut stored = Stored::new("t", "w", TerminalKind::Service);
        assert_eq!(stored.record().title, "Service");
        stored.live.program = Some("node".into());
        assert_eq!(stored.record().title, "node");
        stored.label = Some("web".into());
        assert_eq!(stored.record().title, "web");
        stored.live.title = Some("vite".into());
        assert_eq!(stored.record().title, "vite");
        stored.name = Some("Frontend".into());
        assert_eq!(stored.record().title, "Frontend");
    }
}
