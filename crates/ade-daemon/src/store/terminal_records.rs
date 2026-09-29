//! Terminal records: each terminal is stored flat by ID with one owning
//! workspace (daemon-authority map, "The model").
//!
//! The `terminals` table is the only record of which terminals a workspace
//! has; the first shell is marked `primary`. Every change to a workspace's
//! terminals goes through [`insert`] and [`remove`].
//!
//! What runs in a terminal (`status`, `busy`, the foreground command and the
//! title the program set) is observed from the runtime by [`observe`] and
//! saved with the record, so a restarted daemon lists the last known state
//! until the runtime is read again.
use super::*;
use ade_core::contract::terminals::{TerminalKind, TerminalRecord, TerminalStatus, runtime};
use serde::Deserialize;
use std::collections::HashMap;

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
        self.record_with(&self.live)
    }
    /// The record with `live` in place of the saved live state.
    pub fn record_with(&self, live: &Live) -> TerminalRecord {
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

/// How often a terminal whose only change is its title reaches the feed. A
/// program animating its title (a spinner, a progress count) would otherwise
/// send a frame every tick.
pub(crate) const TITLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Which `terminal_changed` frames are due. Every change waits here until
/// [`Feed::due`] releases it: a change to status, busy or the foreground
/// command at once (the daemon's 250 ms tick bounds it to four a second),
/// a change to the title alone at most once per [`TITLE_INTERVAL`]. The
/// latest record always goes out, so the last title is never lost.
#[derive(Default, Debug)]
pub(crate) struct Feed {
    published: HashMap<String, (TerminalRecord, std::time::Instant)>,
    pending: HashMap<String, TerminalRecord>,
}

impl Feed {
    pub fn changed(&mut self, record: TerminalRecord) {
        self.pending.insert(record.id.clone(), record);
    }
    /// Forgets terminals that are gone.
    pub fn retain(&mut self, listed: impl Fn(&str) -> bool) {
        self.published.retain(|id, _| listed(id));
        self.pending.retain(|id, _| listed(id));
    }
    /// The records to publish now, in no particular order.
    pub fn due(&mut self, now: std::time::Instant) -> Vec<TerminalRecord> {
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|(id, next)| match self.published.get(*id) {
                None => true,
                Some((last, at)) => {
                    let title_only = TerminalRecord {
                        title: next.title.clone(),
                        ..last.clone()
                    } == **next;
                    last != *next && (!title_only || now.duration_since(*at) >= TITLE_INTERVAL)
                }
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut due = Vec::new();
        for id in ready {
            let record = self.pending.remove(&id).expect("pending record");
            self.published.insert(id, (record.clone(), now));
            due.push(record);
        }
        // A pending record equal to the published one needs no frame.
        self.pending
            .retain(|id, next| self.published.get(id).is_none_or(|(last, _)| last != next));
        due
    }
}

pub(crate) fn load(db: &Connection, id: &str) -> Result<Option<Stored>> {
    db.query_row("SELECT data FROM terminals WHERE id=?1", [id], |row| {
        row.get::<_, String>(0)
    })
    .optional()?
    .map(decode)
    .transpose()
}

/// A workspace's terminals in creation order.
pub(crate) fn of_workspace(db: &Connection, workspace_id: &str) -> Result<Vec<Stored>> {
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

/// The part of a terminal's live state that is written to the database:
/// its status, exit code and program, and the title only once the program
/// has stopped running. Busy, the foreground command and the title of a
/// running program live in memory only.
pub(crate) fn durable(live: &Live) -> Live {
    let settled = live.status != TerminalStatus::Running;
    Live {
        status: live.status,
        exit_code: live.exit_code,
        busy: false,
        foreground: None,
        title: live.title.clone().filter(|_| settled),
        program: live.program.clone(),
    }
}

/// Keeps a terminal's live state in `memory` and writes its durable part
/// ([`durable`]) only when that changed. Returns the new record when what
/// the catalog lists changed.
pub(crate) fn save_live(
    db: &Connection,
    memory: &mut HashMap<String, Live>,
    id: &str,
    live: Live,
) -> Result<Option<TerminalRecord>> {
    let Some(mut stored) = load(db, id)? else {
        memory.remove(id);
        return Ok(None);
    };
    let previous = memory
        .get(id)
        .cloned()
        .unwrap_or_else(|| stored.live.clone());
    if previous == live {
        return Ok(None);
    }
    let before = stored.record_with(&previous);
    let after = stored.record_with(&live);
    let saved = durable(&live);
    memory.insert(id.to_owned(), live);
    if saved != stored.live {
        stored.live = saved;
        db.execute(
            "UPDATE terminals SET data=?2 WHERE id=?1",
            params![id, encode(&stored)?],
        )?;
    }
    Ok((after != before).then_some(after))
}

/// A workspace's primary shell.
pub(crate) fn primary(db: &Connection, workspace_id: &str) -> Result<String> {
    db.query_row(
        "SELECT id FROM terminals WHERE workspace_id=?1 AND json_extract(data,'$.primary')=1",
        [workspace_id],
        |row| row.get(0),
    )
    .optional()?
    .with_context(|| format!("Workspace {workspace_id} has no primary shell"))
}

/// How many terminals a workspace may have besides its primary shell.
pub(crate) const MAX_EXTRA: i64 = 32;

/// Refuses another terminal when the workspace has [`MAX_EXTRA`] besides its
/// primary shell.
pub(crate) fn ensure_room(db: &Connection, workspace_id: &str) -> Result<()> {
    let extra: i64 = db.query_row(
        "SELECT COUNT(*) FROM terminals WHERE workspace_id=?1 AND COALESCE(json_extract(data,'$.primary'),0)=0",
        [workspace_id],
        |row| row.get(0),
    )?;
    ensure!(extra < MAX_EXTRA, "Workspace terminal limit reached");
    Ok(())
}

/// Adds a terminal to its workspace.
pub(crate) fn insert(tx: &Connection, stored: &Stored) -> Result<()> {
    ensure!(
        load(tx, &stored.id)?.is_none(),
        "Terminal {} already exists",
        stored.id
    );
    write(tx, stored)
}

/// Removes a terminal from its workspace and its tabs from every layout. A
/// removed primary shell is replaced by a new one that has not started.
/// Returns the layouts that lost a tab, for the caller to publish, or None
/// when the workspace has no such terminal.
pub(crate) fn remove(
    tx: &Connection,
    workspace_id: &str,
    terminal_id: &str,
) -> Result<Option<Vec<ade_core::contract::layout::LayoutRecord>>> {
    let Some(stored) = load(tx, terminal_id)?.filter(|s| s.workspace_id == workspace_id) else {
        return Ok(None);
    };
    tx.execute("DELETE FROM terminals WHERE id=?1", [terminal_id])?;
    if stored.primary {
        write(tx, &Stored::primary(&new_id("terminal"), workspace_id))?;
    }
    let layouts = super::layouts::remove_target(
        tx,
        &ade_core::contract::layout::TabTarget::Terminal {
            id: terminal_id.to_owned(),
        },
    )?;
    Ok(Some(layouts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::terminals::runtime::{Activity, Terminal};

    fn entry(metrics: Value, activity: Activity) -> Terminal {
        Terminal {
            workspace: runtime::Workspace {
                id: "w".into(),
                root: "/tmp/w".into(),
                terminal_id: "t".into(),
            },
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
    fn a_workspace_starts_with_a_primary_shell_and_keeps_one() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        let first = store.primary_terminal(&workspace.id).unwrap();
        let primary = store.terminal(&first).unwrap().unwrap();
        assert!(primary.primary && primary.kind == TerminalKind::Shell);
        assert_eq!(primary.status, TerminalStatus::NotStarted);

        let named = store
            .create_terminal(&workspace.id, None, Some("Logs"))
            .unwrap();
        let plain = store.create_terminal(&workspace.id, None, None).unwrap();
        assert_eq!(
            store.workspace_terminals(&workspace.id).unwrap(),
            vec![first.clone(), named.clone(), plain.clone()]
        );
        assert_eq!(store.terminal(&named).unwrap().unwrap().title, "Logs");
        let ids: Vec<_> = store
            .catalog()
            .unwrap()
            .terminals
            .into_iter()
            .map(|terminal| terminal.id)
            .collect();
        assert_eq!(ids, vec![first.clone(), named.clone(), plain.clone()]);

        // Retiring the primary shell gives the workspace a new one.
        store.retire_terminal(&workspace.id, &first).unwrap();
        let replaced = store.primary_terminal(&workspace.id).unwrap();
        assert_ne!(replaced, first);
        assert!(store.terminal(&first).unwrap().is_none());
        assert!(!store.workspace_has_terminal(&workspace.id, &first).unwrap());
        assert!(store.terminal(&replaced).unwrap().unwrap().primary);
        store.retire_terminal(&workspace.id, &named).unwrap();
        assert_eq!(
            store.workspace_terminals(&workspace.id).unwrap(),
            vec![plain, replaced]
        );
    }

    #[test]
    fn a_workspace_holds_at_most_32_terminals_besides_its_primary_shell() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        for _ in 0..MAX_EXTRA {
            store.create_terminal(&workspace.id, None, None).unwrap();
        }
        let refused = store
            .create_terminal(&workspace.id, None, None)
            .unwrap_err();
        assert_eq!(refused.to_string(), "Workspace terminal limit reached");
    }

    #[test]
    fn live_state_is_saved_and_reported_only_when_the_record_changes() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        let primary = store.primary_terminal(&workspace.id).unwrap();
        let running = Live {
            status: TerminalStatus::Running,
            program: Some("zsh".into()),
            ..Default::default()
        };
        let changed = store
            .save_terminal_state(&primary, running.clone())
            .unwrap()
            .unwrap();
        assert_eq!(changed.status, TerminalStatus::Running);
        assert_eq!(changed.title, "zsh");
        assert!(
            store
                .save_terminal_state(&primary, running)
                .unwrap()
                .is_none()
        );
        drop(store);
        let store = scratch.open();
        assert_eq!(
            store.terminal(&primary).unwrap().unwrap().status,
            TerminalStatus::Running
        );
    }

    /// The saved row's live state, bypassing the in-memory state.
    fn saved(store: &Store, id: &str) -> Live {
        load(&store.connection, id).unwrap().unwrap().live
    }

    #[test]
    fn busy_and_a_running_title_stay_in_memory_and_only_durable_state_is_written() {
        let scratch = Scratch::new();
        let store = scratch.open();
        let workspace = store.workspace_open(&scratch.root(), None).unwrap();
        let id = &store.primary_terminal(&workspace.id).unwrap();
        let running = Live {
            status: TerminalStatus::Running,
            program: Some("zsh".into()),
            ..Default::default()
        };
        store.save_terminal_state(id, running.clone()).unwrap();
        assert_eq!(saved(&store, id), running);
        let busy = Live {
            busy: true,
            foreground: Some("sleep".into()),
            title: Some("step-1".into()),
            ..running.clone()
        };
        let record = store
            .save_terminal_state(id, busy.clone())
            .unwrap()
            .unwrap();
        assert!(record.busy && record.title == "step-1");
        assert_eq!(store.terminal(id).unwrap().unwrap(), record);
        assert_eq!(store.catalog().unwrap().terminals[0], record);
        // Nothing but the durable part reached the database.
        assert_eq!(saved(&store, id), running);
        // An exit settles the title and writes it.
        let exited = Live {
            status: TerminalStatus::Exited,
            exit_code: Some(0),
            title: Some("step-9".into()),
            program: Some("zsh".into()),
            ..Default::default()
        };
        store.save_terminal_state(id, exited.clone()).unwrap();
        assert_eq!(saved(&store, id), exited);
        drop(store);
        let store = scratch.open();
        assert_eq!(store.terminal(id).unwrap().unwrap().title, "step-9");
    }

    fn shell(title: &str, busy: bool) -> TerminalRecord {
        TerminalRecord {
            title: title.into(),
            busy,
            status: TerminalStatus::Running,
            ..Stored::new("t", "w", TerminalKind::Shell).record()
        }
    }

    #[test]
    fn the_feed_sends_busy_at_once_and_a_title_alone_at_most_once_a_second() {
        let start = std::time::Instant::now();
        let at = |ms: u64| start + std::time::Duration::from_millis(ms);
        let mut feed = Feed::default();
        feed.changed(shell("a", false));
        assert_eq!(feed.due(at(0)), vec![shell("a", false)]);
        feed.changed(shell("b", false));
        assert!(feed.due(at(250)).is_empty());
        feed.changed(shell("c", false));
        assert!(feed.due(at(500)).is_empty());
        // Busy goes out at once, with the latest title.
        feed.changed(shell("c", true));
        assert_eq!(feed.due(at(750)), vec![shell("c", true)]);
        feed.changed(shell("d", true));
        assert!(feed.due(at(1000)).is_empty());
        // The held title is sent once its second has passed, with no new change.
        assert_eq!(feed.due(at(1750)), vec![shell("d", true)]);
        assert!(feed.due(at(3000)).is_empty());
        // A change back to what was published sends nothing.
        feed.changed(shell("e", true));
        feed.changed(shell("d", true));
        assert!(feed.due(at(3000)).is_empty());
        assert!(feed.due(at(5000)).is_empty());
        feed.changed(shell("f", true));
        feed.retain(|_| false);
        assert!(feed.due(at(9000)).is_empty());
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
