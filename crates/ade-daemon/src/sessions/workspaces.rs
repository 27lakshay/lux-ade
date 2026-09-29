//! Workspace binding, rebind operations, the catalog and the restore fence.
use super::*;
use ade_core::contract::workspaces::{
    CatalogFrame, CatalogGetRequest, RepositoryAck, RepositoryRebindCatalog, RepositoryRebindEntry,
    RepositoryRebindListRequest, RepositoryRebindRequest, WorkspaceAck, WorkspaceOpenRequest,
    WorkspaceRebindCatalog, WorkspaceRebindListRequest, WorkspaceRebindRequest,
    WorkspaceRenameRequest,
};
use ade_core::workspaces::{RemoveBlocker, RemoveBlockerKind};

#[derive(PartialEq, Eq)]
pub(super) struct SelectedBinding {
    pub(super) root: String,
    pub(super) common: Option<String>,
    root_identity: (u64, u64),
    common_identity: Option<(u64, u64)>,
}
fn e2e_rebind_exit(point: &str) {
    if std::env::var("ADE_E2E_REBIND_FAILPOINT").as_deref() == Ok(point) {
        std::process::exit(93);
    }
}
pub(super) fn selected_binding(path: &str, require_git: bool) -> Result<SelectedBinding> {
    let root = std::fs::canonicalize(path).context("Selected directory is unavailable")?;
    ensure!(root.is_dir(), "Selected path must be a directory");
    let metadata = std::fs::metadata(&root)?;
    let root_text = root.to_str().context("Selected path must be UTF-8")?;
    let common = crate::worktrees::git(
        root_text,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .ok()
    .and_then(|value| std::fs::canonicalize(value).ok());
    let common_metadata = common.as_ref().map(std::fs::metadata).transpose()?;
    if require_git {
        ensure!(
            common.is_some(),
            "Selected directory must belong to a Git repository"
        );
    }
    let verified = std::fs::canonicalize(path)?;
    let after = std::fs::metadata(&verified)?;
    ensure!(
        verified == root && after.dev() == metadata.dev() && after.ino() == metadata.ino(),
        "Selected directory changed during rebind"
    );
    if let Some(expected) = &common {
        let current = crate::worktrees::git(
            root_text,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        ensure!(
            std::fs::canonicalize(current)? == *expected,
            "Git common directory changed during rebind"
        );
        let current_metadata = std::fs::metadata(expected)?;
        let original = common_metadata
            .as_ref()
            .context("Git common directory is unavailable")?;
        ensure!(
            current_metadata.dev() == original.dev() && current_metadata.ino() == original.ino(),
            "Git common directory changed during rebind"
        );
    }
    Ok(SelectedBinding {
        root: root_text.into(),
        common: common.map(|value| value.to_string_lossy().into_owned()),
        root_identity: (metadata.dev(), metadata.ino()),
        common_identity: common_metadata.map(|value| (value.dev(), value.ino())),
    })
}
impl Sessions {
    pub(super) fn workspace_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "catalog.get" => {
                let CatalogGetRequest {} = decode(request)?;
                self.discover_plugin_providers();
                let (catalog, revision) = self.live_catalog()?;
                reply(&CatalogFrame {
                    tag: Default::default(),
                    catalog,
                    providers: self.provider_descriptors(),
                    boot_id: self.boot_id.clone(),
                    revision,
                })
            }
            "workspace.rebind.list" => {
                let WorkspaceRebindListRequest {} = decode(request)?;
                let workspaces = self.data.lock().unwrap().store.rebind_workspaces()?;
                reply(&WorkspaceRebindCatalog {
                    tag: Default::default(),
                    workspaces,
                })
            }
            "repository.rebind.list" => {
                let RepositoryRebindListRequest {} = decode(request)?;
                let repositories = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .rebind_repositories()?
                    .into_iter()
                    .map(
                        |(id, root, needs_rebind, rebindable)| RepositoryRebindEntry {
                            id,
                            root,
                            needs_rebind,
                            rebindable,
                        },
                    )
                    .collect();
                reply(&RepositoryRebindCatalog {
                    tag: Default::default(),
                    repositories,
                })
            }
            "workspace.open" => {
                let open: WorkspaceOpenRequest = decode(request)?;
                let opened = self.open_workspace(non_empty("path", &open.path)?)?;
                reply(&WorkspaceAck {
                    tag: Default::default(),
                    workspace: self.presented_workspace(&opened.id)?,
                })
            }
            "workspace.rename" => {
                let rename: WorkspaceRenameRequest = decode(request)?;
                let id = non_empty("workspace_id", &rename.workspace_id)?;
                {
                    let mut d = self.data.lock().unwrap();
                    d.store.rename_workspace(id, &rename.name)?;
                    self.catalog_changed(&mut d)?;
                }
                reply(&WorkspaceAck {
                    tag: Default::default(),
                    workspace: self.presented_workspace(id)?,
                })
            }
            "repository.rebind" => {
                ensure!(
                    !self.worktrees.has_pending_rebind()?,
                    "Rebind restored Git lifecycle repositories first"
                );
                let rebind: RepositoryRebindRequest = decode(request)?;
                let selected = non_empty("path", &rebind.path)?;
                let binding = selected_binding(selected, true)?;
                let common = binding
                    .common
                    .as_deref()
                    .context("Git common directory is unavailable")?;
                let common_identity = binding
                    .common_identity
                    .context("Git common directory is unavailable")?;
                let repository_id = non_empty("repository_id", &rebind.repository_id)?;
                let saved = self.data.lock().unwrap().store.repository(repository_id)?;
                let source_identity = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .repository_source_identity(repository_id)?;
                ensure!(
                    !self
                        .data
                        .lock()
                        .unwrap()
                        .store
                        .repository_bound(repository_id)?,
                    "Repository is already bound"
                );
                self.worktrees
                    .validate_core_binding(&saved.root, source_identity, common)?;
                let mut d = self.data.lock().unwrap();
                let checked = selected_binding(selected, true)?;
                ensure!(
                    binding == checked,
                    "Selected repository changed during rebind"
                );
                ensure!(
                    d.store.repository(repository_id)?.root == saved.root,
                    "Repository binding changed during rebind"
                );
                let repository =
                    d.store
                        .rebind_repository(repository_id, common, common_identity)?;
                self.catalog_changed(&mut d)?;
                drop(d);
                self.release_restore_fence_if_bound()?;
                reply(&RepositoryAck {
                    tag: Default::default(),
                    repository: repository.into(),
                })
            }
            "workspace.rebind" => {
                ensure!(
                    !self.worktrees.has_pending_rebind()?,
                    "Rebind restored Git lifecycle repositories first"
                );
                let rebind: WorkspaceRebindRequest = decode(request)?;
                let selected = non_empty("path", &rebind.path)?;
                let binding = selected_binding(selected, false)?;
                let mut d = self.data.lock().unwrap();
                let checked = selected_binding(selected, false)?;
                ensure!(
                    binding == checked,
                    "Selected workspace changed during rebind"
                );
                e2e_rebind_exit("before_workspace_commit");
                let workspace = d.store.rebind_workspace(
                    non_empty("workspace_id", &rebind.workspace_id)?,
                    &binding.root,
                    binding.common.as_deref(),
                    binding.root_identity,
                )?;
                e2e_rebind_exit("after_workspace_commit");
                self.catalog_changed(&mut d)?;
                drop(d);
                self.release_restore_fence_if_bound()?;
                reply(&WorkspaceAck {
                    tag: Default::default(),
                    workspace: self.presented_workspace(&workspace.id)?,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
    pub fn workspace(&self, id: &str) -> Result<WorkspaceRecord> {
        self.data.lock().unwrap().store.workspace(id)
    }
    pub fn ensure_workspace_bound(&self, id: &str) -> Result<()> {
        self.data.lock().unwrap().store.ensure_workspace_bound(id)
    }
    /// Whether the workspace was removed from ADE; an unknown ID is an error.
    pub fn workspace_removed(&self, id: &str) -> Result<bool> {
        self.data.lock().unwrap().store.workspace_removed(id)
    }
    /// The durable half of `workspace.remove`: refuses while `blockers` (the
    /// caller's runtime observations) or the store's own blockers stand,
    /// disconnects the workspace's idle Agents, then records the removal and
    /// publishes the catalog. Returns false when it was already removed.
    /// Terminals are the caller's to stop; afterwards it calls
    /// [`Self::retire_removed_terminals`].
    pub fn remove_workspace(
        self: &Arc<Self>,
        id: &str,
        operation_id: &str,
        mut blockers: Vec<RemoveBlocker>,
    ) -> Result<bool> {
        let agents = {
            let d = self.data.lock().unwrap();
            if d.store.workspace_removed(id)? {
                return Ok(false);
            }
            blockers.extend(d.store.workspace_remove_blockers(id)?);
            if !blockers.is_empty() {
                return Err(ade_core::error::WorkspaceRemoveBlocked(blockers).into());
            }
            self.workspace_agents(&d, id)?
        };
        // An idle Agent keeps a provider process and a worktree lease; the
        // removal must not leave either behind.
        for conversation in agents {
            self.disconnect(&conversation)?;
        }
        let mut d = self.data.lock().unwrap();
        let restarted = self.workspace_agents(&d, id)?;
        if let Some(conversation) = restarted.first() {
            let title = d.store.conversation(conversation)?.title;
            return Err(ade_core::error::WorkspaceRemoveBlocked(vec![RemoveBlocker {
                kind: RemoveBlockerKind::ConversationRunning,
                id: conversation.clone(),
                label: format!("Conversation \"{title}\""),
            }])
            .into());
        }
        let removal = d.store.remove_workspace(id, operation_id)?;
        if let Some(removal) = &removal {
            self.workspace_layouts_removed(&mut d, removal);
        }
        self.catalog_changed(&mut d)?;
        Ok(removal.is_some())
    }
    /// The Conversations of `workspace` with a connected Agent.
    fn workspace_agents(&self, d: &Data, workspace: &str) -> Result<Vec<String>> {
        let mut agents = Vec::new();
        for id in d.agents.keys() {
            // A deleted Conversation's Agent is not this workspace's to stop.
            if d.store
                .conversation(id)
                .is_ok_and(|conversation| conversation.workspace_id == workspace)
            {
                agents.push(id.clone());
            }
        }
        agents.sort();
        Ok(agents)
    }
    /// Retires a removed workspace's terminal records, once, and releases the
    /// worktree leases its script runs held. The caller then releases the
    /// runtime state of every terminal the workspace no longer has.
    pub fn retire_removed_terminals(&self, id: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        let (retired, layouts) = d.store.retire_removed_terminal_tabs(id)?;
        for terminal in retired {
            d.terminal_leases.remove(&terminal);
        }
        self.layouts_changed(&mut d, &layouts);
        Ok(())
    }
    pub fn has_pending_rebind(&self) -> Result<bool> {
        if self.worktrees.has_pending_rebind()? {
            return Ok(true);
        }
        self.data.lock().unwrap().store.has_pending_rebind()
    }
    pub(super) fn release_restore_fence_if_bound(&self) -> Result<()> {
        if self.worktrees.has_pending_rebind()? {
            return Ok(());
        }
        let d = self.data.lock().unwrap();
        if !d.store.has_unbound_records()? {
            d.store.release_restore_fence()?;
        }
        Ok(())
    }
    pub fn open_workspace(&self, path: &str) -> Result<WorkspaceRecord> {
        let root = std::fs::canonicalize(path).context("Workspace directory is unavailable")?;
        ensure!(root.is_dir(), "Workspace must be a directory");
        let root = root
            .to_str()
            .ok_or_else(|| anyhow!("Workspace path must be UTF-8"))?;
        // A Git common directory identifies one repository across its worktrees.
        // No worktree is created, moved, pruned, or removed by this operation.
        let pending_rebind = self.data.lock().unwrap().store.has_pending_rebind()?;
        let repo = if pending_rebind {
            None
        } else {
            Command::new("git")
                .args([
                    "-C",
                    root,
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_owned())
        };
        // A repository the lifecycle registered first keeps its ID as the project's.
        let lifecycle = match &repo {
            Some(common) => self.worktrees.repository_for_common(common)?,
            None => None,
        };
        let mut d = self.data.lock().unwrap();
        let w = d
            .store
            .workspace_open_as(root, repo.as_deref(), lifecycle.as_deref())?;
        self.catalog_changed(&mut d)?;
        Ok(w)
    }
    pub(super) fn catalog_changed(&self, d: &mut Data) -> Result<()> {
        // Mutations publish the durable snapshot while holding the state lock.
        // Clients needing current path health refresh with catalog.get, whose
        // filesystem probes run outside this lock.
        let catalog = d.store.catalog()?;
        self.publish(
            d,
            json!({"type":"catalog","catalog":catalog,"providers":self.provider_descriptors()}),
        );
        Ok(())
    }
    pub(super) fn live_catalog(&self) -> Result<(Catalogue, u64)> {
        self.with_live_catalog(|d, catalog| Ok((catalog, d.revision)))
    }
    /// Runs `finish` under the sole-writer lock with the current catalogue,
    /// whose workspaces' path health was probed outside the lock. Durable
    /// workspaces and binding claims are copied under the lock, then the
    /// filesystem metadata and Git-layout probes run without blocking other
    /// commands. Only a change to the workspaces or their binding claims
    /// invalidates the probe. Conversations and windows are read again under
    /// the final lock, so a busy profile, whose revision moves with every
    /// turn event, still gets a snapshot consistent with the revision it is
    /// given.
    pub(super) fn with_live_catalog<T>(
        &self,
        mut finish: impl FnMut(&mut Data, Catalogue) -> Result<T>,
    ) -> Result<T> {
        for _ in 0..3 {
            let (mut probed, claims) = {
                let d = self.data.lock().unwrap();
                let catalog = d.store.catalog()?;
                let claims = d.store.catalog_binding_claims(&catalog)?;
                (catalog, claims)
            };
            let basis = serde_json::to_value(&probed.workspaces)?;
            probe_catalog_bindings(&mut probed, &claims);
            let mut d = self.data.lock().unwrap();
            let mut current = d.store.catalog()?;
            if serde_json::to_value(&current.workspaces)? == basis
                && d.store.catalog_binding_claims(&current)? == claims
            {
                current.workspaces = probed.workspaces;
                return finish(&mut d, current);
            }
        }
        Err(anyhow!(
            "Catalog changed during workspace identity inspection; retry"
        ))
    }
}
