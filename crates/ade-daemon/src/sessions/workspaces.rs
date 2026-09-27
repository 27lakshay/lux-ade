//! Workspace binding, rebind operations, the catalog and the restore fence.
use super::*;
use ade_core::contract::workspaces::{
    CatalogFrame, CatalogGetRequest, RepositoryAck, RepositoryRebindCatalog, RepositoryRebindEntry,
    RepositoryRebindListRequest, RepositoryRebindRequest, WorkspaceAck, WorkspaceOpenRequest,
    WorkspaceRebindCatalog, WorkspaceRebindListRequest, WorkspaceRebindRequest,
};

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
                let (catalog, revision) = self.live_catalog()?;
                reply(&CatalogFrame {
                    tag: Default::default(),
                    catalog,
                    providers: provider::descriptors().to_vec(),
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
                reply(&WorkspaceAck {
                    tag: Default::default(),
                    workspace: self.open_workspace(non_empty("path", &open.path)?)?,
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
                    workspace,
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
        let mut d = self.data.lock().unwrap();
        let w = d.store.workspace_open(root, repo.as_deref())?;
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
            json!({"type":"catalog","catalog":catalog,"providers":provider::descriptors()}),
        );
        Ok(())
    }
    pub(super) fn live_catalog(&self) -> Result<(Catalogue, u64)> {
        // Copy durable claims while holding the sole-writer lock, then let
        // filesystem metadata and Git-layout probes run without blocking other
        // commands. A changed daemon revision invalidates the entire snapshot.
        for _ in 0..3 {
            let (mut catalog, claims, revision) = {
                let d = self.data.lock().unwrap();
                let catalog = d.store.catalog()?;
                let claims = d.store.catalog_binding_claims(&catalog)?;
                (catalog, claims, d.revision)
            };
            probe_catalog_bindings(&mut catalog, &claims);
            if self.data.lock().unwrap().revision == revision {
                return Ok((catalog, revision));
            }
        }
        Err(anyhow!(
            "Catalog changed during workspace identity inspection; retry"
        ))
    }
}
