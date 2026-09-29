//! Windows and their layouts, one per window and workspace (ticket 02 of the
//! daemon authority work). The layout core in `ade_core::layout` applies each
//! change; this module stores the result with a revision, keeps tab targets
//! pointing at records that exist, and follows workspace removal.
//!
//! Other domains call [`remove_target`] inside their own transaction when a
//! record a tab can show goes away, and publish the layouts it returns.
use super::*;
use ade_core::contract::layout::{
    Layout, LayoutAction, LayoutRecord, TabTarget, Window, WindowBounds, WindowState, WindowView,
};
use ade_core::error::{LayoutError, WorkspaceNotFound, WorkspaceRemoved};
use ade_core::layout;

/// The pane every default layout starts with. Callers name every later pane.
pub const DEFAULT_PANE: &str = "pane-main";
const MAX_WINDOWS: i64 = 256;
const MAX_RECENT: usize = 16;
const MAX_COLLAPSED: usize = 1024;

/// The last action applied to a layout, so its retry from the same revision
/// returns the same result instead of applying twice.
#[derive(Serialize, serde::Deserialize, PartialEq)]
struct LastAction {
    from: u64,
    action: LayoutAction,
}

fn check_window_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(LayoutError::Invalid(
            "A window ID must be 1 to 256 bytes with no control characters".into(),
        )
        .into());
    }
    Ok(())
}

/// The workspace, refused when unknown or removed from ADE.
fn live_workspace(db: &Connection, id: &str) -> Result<WorkspaceRecord> {
    let row: Option<(String, bool)> = db
        .query_row(
            "SELECT data,EXISTS(SELECT 1 FROM workspace_tombstones WHERE workspace_id=?1) FROM workspaces WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match row {
        None => Err(WorkspaceNotFound(id.to_owned()).into()),
        Some((_, true)) => Err(WorkspaceRemoved(id.to_owned()).into()),
        Some((data, false)) => decode(data),
    }
}

/// Fills in the revision of each layout the window has stored.
fn with_revisions(db: &Connection, mut window: Window) -> Result<Window> {
    let mut statement =
        db.prepare_cached("SELECT workspace_id,revision FROM layouts WHERE window_id=?1")?;
    window.layouts = statement
        .query_map([&window.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .map(|row| {
            let (workspace, revision) = row?;
            Ok((workspace, u64::try_from(revision)?))
        })
        .collect::<Result<_>>()?;
    Ok(window)
}

pub fn windows(db: &Connection) -> Result<Vec<Window>> {
    all(db, "SELECT data FROM windows ORDER BY rowid")?
        .into_iter()
        .map(|window| with_revisions(db, window))
        .collect()
}

pub fn window(db: &Connection, id: &str) -> Result<Window> {
    let data: Option<String> = db
        .query_row("SELECT data FROM windows WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    match data {
        Some(data) => with_revisions(db, decode(data)?),
        None => Err(LayoutError::WindowNotFound(id.to_owned()).into()),
    }
}

fn save_window(db: &Connection, window: &Window) -> Result<()> {
    let state = match window.state {
        WindowState::Open => "open",
        WindowState::Closed => "closed",
    };
    db.execute(
        "INSERT INTO windows(id,workspace_id,state,data) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,state=excluded.state,data=excluded.data",
        params![
            window.id,
            window.workspace_id,
            state,
            // The revisions are read from the layouts table, never stored here.
            encode(&Window {
                layouts: Default::default(),
                ..window.clone()
            })?
        ],
    )?;
    Ok(())
}

/// Moves `workspace` to the front of the window's recent workspaces.
fn remember(view: &mut WindowView, workspace: &str) {
    view.recent_workspaces.retain(|id| id != workspace);
    view.recent_workspaces.insert(0, workspace.to_owned());
    view.recent_workspaces.truncate(MAX_RECENT);
}

/// The stored layout, or the default a window starts with (revision 0).
pub fn layout(db: &Connection, window_id: &str, workspace_id: &str) -> Result<LayoutRecord> {
    let row: Option<(i64, String)> = db
        .query_row(
            "SELECT revision,data FROM layouts WHERE window_id=?1 AND workspace_id=?2",
            [window_id, workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (revision, layout) = match row {
        Some((revision, data)) => (u64::try_from(revision)?, decode(data)?),
        None => (0, layout::default_layout(DEFAULT_PANE)),
    };
    Ok(LayoutRecord {
        window_id: window_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        revision,
        layout,
    })
}

fn last_action(db: &Connection, window_id: &str, workspace_id: &str) -> Result<Option<LastAction>> {
    let data: Option<Option<String>> = db
        .query_row(
            "SELECT last_action FROM layouts WHERE window_id=?1 AND workspace_id=?2",
            [window_id, workspace_id],
            |row| row.get(0),
        )
        .optional()?;
    data.flatten().map(decode).transpose()
}

/// Stores the next revision of a layout.
fn save_layout(
    db: &Connection,
    current: &LayoutRecord,
    layout: Layout,
    last: Option<&LastAction>,
) -> Result<LayoutRecord> {
    let record = LayoutRecord {
        window_id: current.window_id.clone(),
        workspace_id: current.workspace_id.clone(),
        revision: current.revision + 1,
        layout,
    };
    let last = last.map(encode).transpose()?;
    db.execute(
        "INSERT INTO layouts(window_id,workspace_id,revision,data,last_action) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(window_id,workspace_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,last_action=excluded.last_action",
        params![
            record.window_id,
            record.workspace_id,
            i64::try_from(record.revision)?,
            encode(&record.layout)?,
            last
        ],
    )?;
    Ok(record)
}

/// Whether the record a tab target names exists. A browser tab's record
/// lives with its browser owner until browser tabs move to the daemon, and a
/// file or diff path may name a file not written yet, so neither is checked.
pub fn target_exists(db: &Connection, target: &TabTarget) -> Result<bool> {
    Ok(match target {
        TabTarget::Conversation { id } => db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM conversation_tombstones WHERE conversation_id=?1)",
            [id],
            |row| row.get(0),
        )?,
        TabTarget::Terminal { id } => super::terminal_records::load(db, id)?.is_some(),
        TabTarget::Browser { .. }
        | TabTarget::File { .. }
        | TabTarget::Diff { .. }
        | TabTarget::NewConversation => true,
    })
}

fn require_target(db: &Connection, target: &TabTarget) -> Result<()> {
    if !target_exists(db, target)? {
        return Err(LayoutError::TabTargetMissing(serde_json::to_string(target)?).into());
    }
    Ok(())
}

/// Closes every tab that shows `target`, in every layout, inside the
/// caller's transaction. Each changed layout gets a new revision; the caller
/// publishes the returned layouts once it commits.
pub fn remove_target(tx: &Connection, target: &TabTarget) -> Result<Vec<LayoutRecord>> {
    let mut statement =
        tx.prepare("SELECT window_id,workspace_id FROM layouts ORDER BY window_id,workspace_id")?;
    let keys = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut changed = Vec::new();
    for (window_id, workspace_id) in keys {
        let current = layout(tx, &window_id, &workspace_id)?;
        if let Some(next) = layout::close_target(&current.layout, target) {
            changed.push(save_layout(tx, &current, next, None)?);
        }
    }
    Ok(changed)
}

/// Opens `tab` in the window's layout for `workspace_id`, inside the
/// caller's transaction, as `terminal.create` does for its `place`. Returns
/// the layout when it changed.
pub fn place_tab(
    tx: &Connection,
    window_id: &str,
    workspace_id: &str,
    pane_id: Option<&str>,
    tab: ade_core::contract::layout::Tab,
) -> Result<Option<LayoutRecord>> {
    window(tx, window_id)?;
    live_workspace(tx, workspace_id)?;
    layout::check_target(&tab.target)?;
    require_target(tx, &tab.target)?;
    let current = layout(tx, window_id, workspace_id)?;
    let action = LayoutAction::OpenTab {
        tab,
        pane_id: pane_id.map(str::to_owned),
    };
    let next = layout::apply(&current.layout, &action)?;
    if next == current.layout {
        return Ok(None);
    }
    let last = LastAction {
        from: current.revision,
        action,
    };
    save_layout(tx, &current, next, Some(&last)).map(Some)
}

/// What removing a workspace did to windows and layouts.
#[derive(Debug, Default)]
pub struct WorkspaceRemoval {
    /// Windows that showed it or listed it as recent, as they now stand.
    pub windows: Vec<Window>,
    /// The `(window_id, workspace_id)` of each deleted layout.
    pub layouts: Vec<(String, String)>,
    /// For each window moved to another workspace, the layout it now shows.
    pub shown: Vec<LayoutRecord>,
}

/// Follows a workspace's removal inside its transaction: its layouts go, and
/// a window showing it moves to the first remaining workspace by project and
/// name. With no workspace left, the window closes and keeps pointing at it.
///
/// Call it in the same transaction that records the removal, after the
/// tombstone insert: the replacement is chosen among workspaces still listed.
pub fn workspace_removed(tx: &Connection, workspace_id: &str) -> Result<WorkspaceRemoval> {
    let mut removal = WorkspaceRemoval::default();
    {
        let mut statement = tx.prepare(
            "DELETE FROM layouts WHERE workspace_id=?1 RETURNING window_id,workspace_id",
        )?;
        removal.layouts = statement
            .query_map([workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        removal.layouts.sort();
    }
    let replacement = replacement_workspace(tx, workspace_id)?;
    for mut window in windows(tx)? {
        let showed = window.workspace_id == workspace_id;
        let listed = window
            .view
            .recent_workspaces
            .iter()
            .any(|id| id == workspace_id);
        if !showed && !listed {
            continue;
        }
        window
            .view
            .recent_workspaces
            .retain(|id| id != workspace_id);
        if showed {
            match &replacement {
                Some(next) => {
                    window.workspace_id = next.clone();
                    remember(&mut window.view, next);
                    removal.shown.push(layout(tx, &window.id, next)?);
                }
                None => window.state = WindowState::Closed,
            }
        }
        save_window(tx, &window)?;
        removal.windows.push(with_revisions(tx, window)?);
    }
    Ok(removal)
}

/// The first workspace still in the catalog, other than `removed`, ordered
/// by project name, then workspace name.
fn replacement_workspace(db: &Connection, removed: &str) -> Result<Option<String>> {
    let mut statement = db.prepare(
        "SELECT w.id,w.data,r.root FROM workspaces w LEFT JOIN repositories r ON r.id=w.project_id WHERE w.id<>?1 AND w.id NOT IN (SELECT workspace_id FROM workspace_tombstones)",
    )?;
    let mut candidates = statement
        .query_map([removed], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(id, data, root)| {
            let workspace: WorkspaceRecord = decode(data)?;
            let project = root
                .map(|root| ade_core::workspaces::project_name(&root))
                .unwrap_or_else(|| workspace.name.clone());
            Ok((project.to_lowercase(), workspace.name.to_lowercase(), id))
        })
        .collect::<Result<Vec<_>>>()?;
    candidates.sort();
    Ok(candidates.into_iter().next().map(|(_, _, id)| id))
}

fn check_bounds(bounds: &WindowBounds) -> Result<()> {
    let WindowBounds {
        x,
        y,
        width,
        height,
    } = *bounds;
    let finite = [x, y, width, height].iter().all(|n| n.is_finite());
    if !finite
        || !(1.0..=100_000.0).contains(&width)
        || !(1.0..=100_000.0).contains(&height)
        || x.abs() > 1_000_000.0
        || y.abs() > 1_000_000.0
    {
        return Err(LayoutError::Invalid(
            "Window bounds must be finite, with a positive width and height".into(),
        )
        .into());
    }
    Ok(())
}

fn terminal_targets(layout: &Layout) -> Vec<&str> {
    layout::targets(layout)
        .into_iter()
        .filter_map(|target| match target {
            TabTarget::Terminal { id } => Some(id.as_str()),
            _ => None,
        })
        .collect()
}

/// Whether a layout other than `(window_id, workspace_id)` has a tab
/// showing the terminal.
fn shown_elsewhere(
    db: &Connection,
    window_id: &str,
    workspace_id: &str,
    terminal: &str,
) -> Result<bool> {
    let mut statement =
        db.prepare_cached("SELECT data FROM layouts WHERE NOT (window_id=?1 AND workspace_id=?2)")?;
    let others = statement
        .query_map([window_id, workspace_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for data in others {
        let other: Layout = decode(data)?;
        if terminal_targets(&other).contains(&terminal) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The shell terminals whose last tab, counted across every window's
/// layouts, goes when `current` becomes `next`; with `running_only`, only
/// those whose shell runs. Each comes with its tabs in `current`.
fn shells_losing_last_tab(
    db: &Connection,
    current: &LayoutRecord,
    next: &Layout,
    running_only: bool,
) -> Result<Vec<(String, Vec<String>)>> {
    use ade_core::contract::terminals::{TerminalKind, TerminalStatus};
    let kept = terminal_targets(next);
    let mut shells = Vec::new();
    for id in terminal_targets(&current.layout) {
        if kept.contains(&id) || shown_elsewhere(db, &current.window_id, &current.workspace_id, id)?
        {
            continue;
        }
        let Some(record) = super::terminal_records::load(db, id)?.map(|stored| stored.record())
        else {
            continue;
        };
        if record.kind != TerminalKind::Shell
            || (running_only && record.status != TerminalStatus::Running)
        {
            continue;
        }
        let tabs = current
            .layout
            .tabs
            .values()
            .filter(|tab| matches!(&tab.target, TabTarget::Terminal { id: shown } if shown == id))
            .map(|tab| tab.id.clone())
            .collect();
        shells.push((id.to_owned(), tabs));
    }
    Ok(shells)
}

/// Refuses a change that would take away a running shell's last tab: only
/// `tab.close` and `pane.close` end a process (`tab_close_required`).
fn refuse_closing_shells(db: &Connection, current: &LayoutRecord, next: &Layout) -> Result<()> {
    let shells = shells_losing_last_tab(db, current, next, true)?;
    if shells.is_empty() {
        return Ok(());
    }
    Err(
        LayoutError::TabCloseRequired(shells.into_iter().flat_map(|(_, tabs)| tabs).collect())
            .into(),
    )
}

/// The outcome of a window command: the window, and whether it changed.
#[derive(Debug)]
pub struct WindowChange {
    pub window: Window,
    pub changed: bool,
}

/// The outcome of a layout command.
#[derive(Debug)]
pub struct LayoutChange {
    pub layout: LayoutRecord,
    /// What the reply says: the action changed the layout, now or, for a
    /// recognised retry, when it first ran.
    pub changed: bool,
    /// Whether this call stored a new revision, which the feed then carries.
    pub stored: bool,
}

impl Store {
    pub fn windows(&self) -> Result<Vec<Window>> {
        windows(&self.connection)
    }

    /// `window.create`: a new open window showing `workspace_id`. A repeat
    /// with the same workspace returns the window as it stands.
    pub fn create_window(
        &self,
        id: &str,
        workspace_id: &str,
        bounds: Option<WindowBounds>,
    ) -> Result<WindowChange> {
        check_window_id(id)?;
        if let Some(bounds) = &bounds {
            check_bounds(bounds)?;
        }
        let tx = self.transaction()?;
        match window(&tx, id) {
            Ok(existing) => {
                // A retry: the same workspace, or one removed since, which
                // moved the window elsewhere.
                let removed = live_workspace(&tx, workspace_id)
                    .err()
                    .is_some_and(|error| error.downcast_ref::<WorkspaceRemoved>().is_some());
                if existing.workspace_id == workspace_id || removed {
                    return Ok(WindowChange {
                        window: existing,
                        changed: false,
                    });
                }
                return Err(LayoutError::WindowExists(id.to_owned()).into());
            }
            Err(error) if error.downcast_ref::<LayoutError>().is_some() => {}
            Err(error) => return Err(error),
        }
        live_workspace(&tx, workspace_id)?;
        let count: i64 = tx.query_row("SELECT count(*) FROM windows", [], |row| row.get(0))?;
        if count >= MAX_WINDOWS {
            return Err(LayoutError::Invalid(format!(
                "A profile holds at most {MAX_WINDOWS} windows"
            ))
            .into());
        }
        let window = Window {
            id: id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            state: WindowState::Open,
            bounds,
            view: WindowView {
                collapsed_projects: Vec::new(),
                recent_workspaces: vec![workspace_id.to_owned()],
            },
            layouts: Default::default(),
        };
        save_window(&tx, &window)?;
        tx.commit()?;
        Ok(WindowChange {
            window,
            changed: true,
        })
    }

    /// `window.claim`: an open window not in `claimed`, else the last closed
    /// one whose workspace is listed, reopened, else a new window `id` on the
    /// first listed workspace.
    pub fn claim_window(&self, id: &str, claimed: &[String]) -> Result<WindowChange> {
        check_window_id(id)?;
        if claimed.len() > MAX_WINDOWS as usize {
            return Err(LayoutError::Invalid(format!(
                "A claim names at most {MAX_WINDOWS} windows"
            ))
            .into());
        }
        let listed = windows(&self.connection)?;
        let free = |window: &&Window| !claimed.contains(&window.id);
        if let Some(open) = listed
            .iter()
            .filter(free)
            .find(|window| window.state == WindowState::Open)
        {
            return Ok(WindowChange {
                window: open.clone(),
                changed: false,
            });
        }
        let closed = listed.iter().filter(free).rev().find(|window| {
            window.state == WindowState::Closed
                && live_workspace(&self.connection, &window.workspace_id).is_ok()
        });
        if let Some(closed) = closed {
            return self.set_window_state(&closed.id, WindowState::Open);
        }
        let first: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM workspaces WHERE id NOT IN (SELECT workspace_id FROM workspace_tombstones) ORDER BY rowid LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let first = first
            .ok_or_else(|| LayoutError::Invalid("The profile has no workspace to show".into()))?;
        self.create_window(id, &first, None)
    }

    /// Reads the window, lets `change` edit it, and stores it when it changed.
    fn change_window(
        &self,
        id: &str,
        change: impl FnOnce(&Connection, &mut Window) -> Result<()>,
    ) -> Result<WindowChange> {
        let tx = self.transaction()?;
        let before = window(&tx, id)?;
        let mut window = before.clone();
        change(&tx, &mut window)?;
        let changed = window != before;
        if changed {
            save_window(&tx, &window)?;
            tx.commit()?;
        }
        Ok(WindowChange { window, changed })
    }

    pub fn set_window_state(&self, id: &str, state: WindowState) -> Result<WindowChange> {
        self.change_window(id, |tx, window| {
            if state == WindowState::Open {
                // A window closed because its workspace was removed needs another first.
                live_workspace(tx, &window.workspace_id)?;
            }
            window.state = state;
            Ok(())
        })
    }

    pub fn set_window_bounds(&self, id: &str, bounds: WindowBounds) -> Result<WindowChange> {
        check_bounds(&bounds)?;
        self.change_window(id, |_, window| {
            window.bounds = Some(bounds);
            Ok(())
        })
    }

    pub fn show_workspace(&self, id: &str, workspace_id: &str) -> Result<WindowChange> {
        self.change_window(id, |tx, window| {
            live_workspace(tx, workspace_id)?;
            window.workspace_id = workspace_id.to_owned();
            remember(&mut window.view, workspace_id);
            Ok(())
        })
    }

    pub fn set_window_view(&self, id: &str, collapsed: &[String]) -> Result<WindowChange> {
        let mut projects: Vec<String> = Vec::new();
        for project in collapsed {
            check_window_id(project)
                .map_err(|_| LayoutError::Invalid("A project ID must be 1 to 256 bytes".into()))?;
            if !projects.contains(project) {
                projects.push(project.clone());
            }
        }
        if projects.len() > MAX_COLLAPSED {
            return Err(LayoutError::Invalid(format!(
                "At most {MAX_COLLAPSED} projects may be collapsed"
            ))
            .into());
        }
        self.change_window(id, |_, window| {
            window.view.collapsed_projects = projects;
            Ok(())
        })
    }

    /// The workspace a layout command names: the one given, or the one the
    /// window shows. Refuses an unknown window or a removed workspace.
    fn layout_key(
        &self,
        db: &Connection,
        window_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<String> {
        let window = window(db, window_id)?;
        let workspace = workspace_id.unwrap_or(&window.workspace_id).to_owned();
        live_workspace(db, &workspace)?;
        Ok(workspace)
    }

    /// For `tab.close` and `pane.close`: the shell terminals, running or
    /// not, whose last tab across every window's layouts `action` removes.
    pub fn closing_shells(
        &self,
        window_id: &str,
        workspace_id: Option<&str>,
        action: &LayoutAction,
    ) -> Result<Vec<String>> {
        let workspace = self.layout_key(&self.connection, window_id, workspace_id)?;
        let current = layout(&self.connection, window_id, &workspace)?;
        let next = layout::apply(&current.layout, action)?;
        Ok(
            shells_losing_last_tab(&self.connection, &current, &next, false)?
                .into_iter()
                .map(|(id, _)| id)
                .collect(),
        )
    }

    /// `layout.get`.
    pub fn layout(&self, window_id: &str, workspace_id: Option<&str>) -> Result<LayoutRecord> {
        let workspace = self.layout_key(&self.connection, window_id, workspace_id)?;
        layout(&self.connection, window_id, &workspace)
    }

    /// `layout.apply`: applies one action and stores the result as the next
    /// revision. An action that changes nothing keeps the revision.
    pub fn apply_layout(
        &self,
        window_id: &str,
        workspace_id: Option<&str>,
        action: &LayoutAction,
        expected: Option<u64>,
    ) -> Result<LayoutChange> {
        if expected.is_none() && !layout::repeatable(action) {
            return Err(LayoutError::Invalid(
                "Moving, swapping or docking a pane needs expected_revision, so a retry is recognised"
                    .into(),
            )
            .into());
        }
        let tx = self.transaction()?;
        let workspace = self.layout_key(&tx, window_id, workspace_id)?;
        let current = layout(&tx, window_id, &workspace)?;
        if let Some(expected) = expected
            && expected != current.revision
        {
            // The retry of the last action from `expected` returns its result.
            let last = last_action(&tx, window_id, &workspace)?;
            let retry = LastAction {
                from: expected,
                action: action.clone(),
            };
            if current.revision == expected + 1 && last.as_ref() == Some(&retry) {
                return Ok(LayoutChange {
                    layout: current,
                    changed: true,
                    stored: false,
                });
            }
            return Err(LayoutError::Conflict {
                expected,
                current: current.revision,
            }
            .into());
        }
        if let LayoutAction::OpenTab { tab, .. } = action {
            layout::check_target(&tab.target)?;
            require_target(&tx, &tab.target)?;
        }
        let next = layout::apply(&current.layout, action)?;
        if next == current.layout {
            return Ok(LayoutChange {
                layout: current,
                changed: false,
                stored: false,
            });
        }
        refuse_closing_shells(&tx, &current, &next)?;
        let last = LastAction {
            from: current.revision,
            action: action.clone(),
        };
        let record = save_layout(&tx, &current, next, Some(&last))?;
        tx.commit()?;
        Ok(LayoutChange {
            layout: record,
            changed: true,
            stored: true,
        })
    }
}
