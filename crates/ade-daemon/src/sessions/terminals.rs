//! `terminal.*` operations, terminal leases and view-terminal recovery.
use super::*;
use crate::store::terminal_records;
use ade_core::contract::conversations::AckTag;
use ade_core::contract::terminals::{
    TerminalChanged, TerminalChangedTag, TerminalCreateRequest, TerminalCreated, TerminalOperation,
    TerminalOperationRequest, TerminalOperationTag, TerminalRecord, runtime,
};

/// A title for `terminal.create`: trimmed, 1 to 100 characters, with no
/// control characters.
fn terminal_title(title: &str) -> Result<&str> {
    let title = title.trim();
    ensure!(
        !title.is_empty() && title.chars().count() <= 100 && !title.chars().any(char::is_control),
        "Invalid terminal title: use 1 to 100 characters without control characters"
    );
    Ok(title)
}

impl Sessions {
    pub(super) fn terminal_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "terminal.appearance.get" | "terminal.appearance.set" => {
                use ade_core::contract::terminals::{
                    ResolvedTerminalAppearance, TerminalAppearanceProvenance,
                    TerminalAppearanceRequest, TerminalAppearanceSetRequest,
                };
                let mut d = self.data.lock().unwrap();
                let (workspace, id) = if request["op"] == "terminal.appearance.set" {
                    ensure!(
                        request.get("binding").is_some(),
                        "Missing terminal binding; use null to reset"
                    );
                    let change: TerminalAppearanceSetRequest = decode(request)?;
                    if d.store.set_terminal_binding(
                        &change.workspace_id,
                        &change.terminal_id,
                        change.binding,
                        change.expected_appearance_revision,
                    )? {
                        let settings = d.store.settings()?;
                        self.publish(
                            &mut d,
                            json!({"type":"settings_changed", "settings": settings}),
                        );
                        self.catalog_changed(&mut d)?;
                    }
                    self.runtime
                        .command(runtime::Command::Appearance {
                            appearance: d.store.terminal_appearance_projection()?,
                        })
                        .context(
                            "Appearance saved, but the terminal update could not be confirmed",
                        )?;
                    (change.workspace_id, change.terminal_id)
                } else {
                    let target: TerminalAppearanceRequest = decode(request)?;
                    (target.workspace_id, target.terminal_id)
                };
                let record = d.store.terminal(&id)?.context("Unknown terminal")?;
                ensure!(
                    record.workspace_id == workspace,
                    "Terminal belongs to another workspace"
                );
                let settings = d.store.settings()?;
                let provenance = if record.appearance_binding.is_some() {
                    TerminalAppearanceProvenance::Terminal
                } else {
                    TerminalAppearanceProvenance::Profile
                };
                let binding = record
                    .appearance_binding
                    .unwrap_or(settings.terminal_binding);
                let (palette, selected_id, diagnostic) = d.store.resolve_theme_binding(
                    &binding,
                    ade_core::appearance::ThemeSectionKind::Terminal,
                )?;
                let desired = d.store.terminal_appearance_projection()?;
                reply(&ResolvedTerminalAppearance {
                    tag: Default::default(),
                    terminal_id: id.clone(),
                    revision: settings.appearance_revision,
                    binding,
                    provenance,
                    selected_id,
                    resolved_id: palette.id.clone(),
                    mode: palette.mode,
                    fallback: diagnostic.is_some(),
                    diagnostics: diagnostic.into_iter().collect(),
                    appearance: desired.for_terminal(&id).clone(),
                    propagation: self.appearance_propagation(&desired),
                })
            }
            "terminal.create" => {
                if let Some(value) = request.get("operation_id") {
                    ensure!(value.is_string(), "Invalid terminal operation ID");
                }
                let create: TerminalCreateRequest = decode(request)?;
                let title = create.title.as_deref().map(terminal_title).transpose()?;
                let mut d = self.data.lock().unwrap();
                let created = d.store.create_placed_terminal(
                    &create.workspace_id,
                    create.operation_id.as_deref(),
                    title,
                    create.place.as_ref(),
                )?;
                self.catalog_changed(&mut d)?;
                self.layouts_changed(&mut d, created.layout.as_slice());
                reply(&TerminalCreated {
                    tag: AckTag::Tag,
                    terminal_id: created.terminal_id,
                })
            }
            "terminal.operation" => {
                ensure!(
                    request.get("operation_id").is_some(),
                    "Missing operation_id"
                );
                let lookup: TerminalOperationRequest = decode(request)?;
                let workspace_id = non_empty("workspace_id", &lookup.workspace_id)?;
                let operation_id = non_empty("operation_id", &lookup.operation_id)?;
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
                    operation_id: operation_id.to_owned(),
                    terminal_id,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
    /// A terminal's record, or `None` when no terminal has this ID.
    pub fn terminal_record(&self, id: &str) -> Result<Option<TerminalRecord>> {
        self.data.lock().unwrap().store.terminal(id)
    }
    /// Saves what the runtime's terminal list shows of every listed terminal
    /// and publishes `terminal_changed` for each whose record changed. Runs
    /// on the 250 ms tick, so a terminal changes at most four times a second.
    pub(super) fn observe_terminals(&self, catalogue: &Value) -> Result<()> {
        let listed: runtime::Terminals =
            serde_json::from_value(catalogue.clone()).context("Invalid terminal catalogue")?;
        let mut d = self.data.lock().unwrap();
        let states = d.store.terminal_states()?;
        d.terminal_feed
            .retain(|id| states.iter().any(|(_, terminal_id, _)| terminal_id == id));
        for (workspace_id, terminal_id, previous) in states {
            let entry = listed.terminals.iter().find(|entry| {
                entry.workspace.id == workspace_id && entry.workspace.terminal_id == terminal_id
            });
            let live = terminal_records::observe(&previous, entry);
            if live == previous {
                continue;
            }
            if let Some(terminal) = d.store.save_terminal_state(&terminal_id, live)? {
                d.terminal_feed.changed(terminal);
            }
        }
        for terminal in d.terminal_feed.due(std::time::Instant::now()) {
            self.publish(
                &mut d,
                serde_json::to_value(TerminalChanged {
                    tag: TerminalChangedTag::Tag,
                    terminal,
                    boot_id: String::new(),
                    revision: 0,
                })?,
            );
        }
        Ok(())
    }
    /// A workspace's primary shell.
    pub fn primary_terminal(&self, workspace: &str) -> Result<String> {
        self.data.lock().unwrap().store.primary_terminal(workspace)
    }
    /// Whether `terminal` is one of the workspace's terminals.
    pub fn workspace_has_terminal(&self, workspace: &str, terminal: &str) -> Result<bool> {
        self.data
            .lock()
            .unwrap()
            .store
            .workspace_has_terminal(workspace, terminal)
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
        let layouts = d.store.retire_terminal(workspace, terminal)?;
        self.layouts_changed(&mut d, &layouts);
        self.catalog_changed(&mut d)
    }
}
