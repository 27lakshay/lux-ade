use super::*;

impl Store {
    pub fn save_window(&self, window: &WindowRecord) -> Result<()> {
        check_id(&window.id)?;
        ensure!(
            (1..=5).contains(&window.focused_pane),
            "Unknown focused pane"
        );
        ensure!(window.panes.valid(), "Pane dimensions are out of bounds");
        ensure!(
            [window.x, window.y, window.width, window.height]
                .iter()
                .all(|n| n.is_finite()),
            "Window geometry must be finite"
        );
        ensure!(
            (1000.0..=10000.0).contains(&window.width)
                && (700.0..=10000.0).contains(&window.height),
            "Window dimensions are out of bounds"
        );
        let url = &window.browser_url;
        ensure!(
            url.len() <= 8192 && !url.chars().any(char::is_control),
            "Invalid browser URL"
        );
        ensure!(
            url.is_empty()
                || url == "about:blank"
                || ["http://", "https://"].iter().any(|scheme| url
                    .strip_prefix(scheme)
                    .is_some_and(|rest| !rest.is_empty()
                        && !rest.starts_with('/')
                        && !rest.chars().any(char::is_whitespace))),
            "Only the local fixture or HTTP(S) browser URLs may be persisted"
        );
        let tx = self.transaction()?;
        let _: WorkspaceRecord = one(&tx, "workspaces", &window.workspace_id)?;
        let tabs = &window.tabs;
        ensure!(
            tabs.terminals.len() <= 64
                && tabs.browsers.len() <= 32
                && tabs.closed_terminals.len() <= 32
                && tabs.closed_browsers.len() <= 16,
            "Too many tabs"
        );
        let mut ids = std::collections::HashSet::new();
        for tab in tabs.terminals.iter().chain(tabs.closed_terminals.iter()) {
            check_id(&tab.id)?;
            ensure!(
                ids.insert(&tab.id) && tab.title.len() <= 256,
                "Invalid terminal tab"
            );
            let workspace: WorkspaceRecord = one(&tx, "workspaces", &tab.workspace_id)?;
            ensure!(
                tab.id == workspace.terminal_id || workspace.extra_terminals.contains(&tab.id),
                "Unknown terminal tab"
            );
        }
        ids.clear();
        for tab in tabs.browsers.iter().chain(tabs.closed_browsers.iter()) {
            check_id(&tab.id)?;
            ensure!(
                ids.insert(&tab.id)
                    && tab.title.len() <= 256
                    && tab.url.len() <= 8192
                    && !tab.url.chars().any(char::is_control),
                "Invalid browser tab"
            );
            ensure!(
                tab.url.is_empty()
                    || ["http://", "https://"].iter().any(|scheme| tab
                        .url
                        .strip_prefix(scheme)
                        .is_some_and(|rest| !rest.is_empty()
                            && !rest.starts_with('/')
                            && !rest.chars().any(char::is_whitespace))),
                "Browser tabs require HTTP(S) URLs"
            );
        }
        ensure!(
            tabs.active_terminal.as_ref().is_none_or(|id| tabs
                .terminals
                .iter()
                .any(|t| &t.id == id && t.workspace_id == window.workspace_id)),
            "Active terminal must belong to the window workspace"
        );
        ensure!(
            tabs.active_browser
                .as_ref()
                .is_none_or(|id| tabs.browsers.iter().any(|t| &t.id == id)),
            "Unknown active browser tab"
        );
        if let Some(id) = &window.conversation_id {
            let conversation: Conversation = live_conversation(&tx, id)?;
            ensure!(
                conversation.workspace_id == window.workspace_id,
                "Window conversation belongs to another workspace"
            );
        }
        tx.execute("INSERT INTO windows VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,conversation_id=excluded.conversation_id,data=excluded.data",params![window.id,window.workspace_id,window.conversation_id,encode(window)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn close_window(&self, id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM windows WHERE id=?1 AND (SELECT count(*) FROM windows)>1",
            [id],
        )?;
        Ok(())
    }
}
