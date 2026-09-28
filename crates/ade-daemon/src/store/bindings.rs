use super::*;

#[derive(PartialEq, Eq)]
pub(crate) struct CatalogBindingClaim {
    workspace: Option<(u64, u64)>,
    repository: Option<(String, Option<(u64, u64)>)>,
}
pub use ade_core::contract::workspaces::WorkspaceRebindEntry;
use ade_core::workspaces::{RemoveBlocker, RemoveBlockerKind};

/// Workspaces removed from ADE. The workspace row stays, so its
/// Conversations keep a valid workspace; the catalog, rebind checks and the
/// prompt queue skip it, and `workspace.open` on its root deletes the row.
pub(crate) const WORKSPACE_TOMBSTONES: &str = "CREATE TABLE IF NOT EXISTS workspace_tombstones(workspace_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, removed_at INTEGER NOT NULL, terminals_retired INTEGER NOT NULL DEFAULT 0 CHECK(terminals_retired IN (0,1)));";
/// A SQL condition on a workspace ID column: the workspace is not removed.
macro_rules! visible {
    ($column:literal) => {
        concat!(
            $column,
            " NOT IN (SELECT workspace_id FROM workspace_tombstones)"
        )
    };
}
fn binding_matches(db: &Connection, kind: &str, id: &str, root: &str) -> Result<bool> {
    let saved: Option<(String, String)> = db
        .query_row(
            "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((device, inode)) = saved else {
        return Ok(false);
    };
    let Ok(metadata) = std::fs::metadata(root) else {
        return Ok(false);
    };
    Ok(metadata.is_dir()
        && device == metadata.dev().to_string()
        && inode == metadata.ino().to_string())
}
fn current_binding_identity(db: &Connection, kind: &str, id: &str) -> Result<Option<(u64, u64)>> {
    let saved: Option<(String, String)> = db
        .query_row(
            "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    saved
        .map(|(device, inode)| Ok((device.parse()?, inode.parse()?)))
        .transpose()
}
fn physical_binding_matches(root: &str, expected: Option<(u64, u64)>) -> bool {
    expected.is_some_and(|expected| {
        std::fs::metadata(root)
            .is_ok_and(|metadata| metadata.is_dir() && (metadata.dev(), metadata.ino()) == expected)
    })
}
pub(crate) fn probe_catalog_bindings(catalog: &mut Catalogue, claims: &[CatalogBindingClaim]) {
    if cfg!(debug_assertions)
        && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
        && let Ok(directory) = std::env::var("ADE_E2E_CATALOG_PAUSE_DIR")
        && Path::new(&directory).join("armed").exists()
    {
        let directory = Path::new(&directory);
        let _ = std::fs::write(directory.join("signal"), b"");
        for _ in 0..500 {
            if directory.join("release").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    for (workspace, claim) in catalog.workspaces.iter_mut().zip(claims) {
        let repository_unbound = claim.repository.as_ref().is_some_and(|(root, expected)| {
            !physical_binding_matches(root, *expected)
                || !linked_common_matches(&workspace.root, root)
        });
        workspace.needs_rebind |=
            repository_unbound || !physical_binding_matches(&workspace.root, claim.workspace);
    }
}
fn small_git_path(path: &Path, prefix: &str) -> Option<PathBuf> {
    if !std::fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(4097).read_to_string(&mut text).ok()?;
    if text.len() > 4096 {
        return None;
    }
    let value = text.trim_end_matches(['\r', '\n']);
    let value = value.strip_prefix(prefix)?;
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return None;
    }
    Some(PathBuf::from(value))
}
fn linked_common_matches(workspace_root: &str, repository_root: &str) -> bool {
    // This runs while the store mutex is held. Inspect the standard on-disk
    // Git layout directly so catalogue polling cannot wait on a Git child.
    // Unrecognized layouts fail closed and can be explicitly rebound.
    let Some(expected) = std::fs::canonicalize(repository_root).ok() else {
        return false;
    };
    let root = Path::new(workspace_root);
    for ancestor in root.ancestors() {
        let dot_git = ancestor.join(".git");
        match std::fs::symlink_metadata(&dot_git) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
        let Ok(metadata) = std::fs::metadata(&dot_git) else {
            return false;
        };
        let git_dir = if metadata.is_dir() {
            dot_git
        } else if metadata.is_file() {
            let Some(pointer) = small_git_path(&dot_git, "gitdir: ") else {
                return false;
            };
            if pointer.is_absolute() {
                pointer
            } else {
                ancestor.join(pointer)
            }
        } else {
            return false;
        };
        let Some(git_dir) = std::fs::canonicalize(git_dir).ok() else {
            return false;
        };
        let common_file = git_dir.join("commondir");
        let common = match std::fs::symlink_metadata(&common_file) {
            Ok(_) => {
                let Some(pointer) = small_git_path(&common_file, "") else {
                    return false;
                };
                if pointer.is_absolute() {
                    pointer
                } else {
                    git_dir.join(pointer)
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => git_dir,
            Err(_) => return false,
        };
        return std::fs::canonicalize(common).is_ok_and(|common| common == expected);
    }
    // A bare repository has no .git entry; its root is the common directory.
    root == expected
        && root.join("HEAD").is_file()
        && root.join("objects").is_dir()
        && root.join("refs").is_dir()
}
fn saved_binding_identity(db: &Connection, kind: &str, id: &str) -> Result<Option<(u64, u64)>> {
    let saved: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT source_device,source_inode FROM path_bindings WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    saved
        .and_then(|(device, inode)| device.zip(inode))
        .map(|(device, inode)| Ok((device.parse()?, inode.parse()?)))
        .transpose()
}
pub(super) fn write_binding(db: &Connection, kind: &str, id: &str, root: &str) -> Result<()> {
    let metadata = std::fs::metadata(root).context("Selected directory is unavailable")?;
    ensure!(metadata.is_dir(), "Selected path must be a directory");
    write_binding_identity(db, kind, id, (metadata.dev(), metadata.ino()))
}
fn write_binding_identity(
    db: &Connection,
    kind: &str,
    id: &str,
    identity: (u64, u64),
) -> Result<()> {
    db.execute("INSERT INTO path_bindings(kind,id,device,inode,source_device,source_inode) VALUES(?1,?2,?3,?4,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET device=excluded.device,inode=excluded.inode",
        params![kind, id, identity.0.to_string(), identity.1.to_string()])?;
    Ok(())
}
fn ensure_not_source_directory(db: &Connection, root: &str) -> Result<()> {
    let mut rows = db.prepare("SELECT source_device,source_inode FROM path_bindings WHERE source_device IS NOT NULL AND source_inode IS NOT NULL")?;
    let sources: Vec<(String, String)> = rows
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for ancestor in Path::new(root).ancestors() {
        let Ok(metadata) = std::fs::metadata(ancestor) else {
            continue;
        };
        ensure!(
            !sources
                .iter()
                .any(|(device, inode)| device == &metadata.dev().to_string()
                    && inode == &metadata.ino().to_string()),
            "Selected directory belongs to a saved source workspace or repository"
        );
    }
    Ok(())
}
fn verify_binding_identity(root: &str, identity: (u64, u64)) -> Result<()> {
    let metadata = std::fs::metadata(root).context("Selected directory is unavailable")?;
    ensure!(
        metadata.is_dir() && (metadata.dev(), metadata.ino()) == identity,
        "Selected directory changed during rebind"
    );
    Ok(())
}

impl Store {
    pub fn workspace(&self, id: &str) -> Result<WorkspaceRecord> {
        one(&self.connection, "workspaces", id)
    }
    pub fn rebind_workspaces(&self) -> Result<Vec<WorkspaceRebindEntry>> {
        let workspaces: Vec<WorkspaceRecord> = all(
            &self.connection,
            concat!(
                "SELECT data FROM workspaces WHERE ",
                visible!("id"),
                " ORDER BY rowid"
            ),
        )?;
        workspaces
            .into_iter()
            .map(|workspace| {
                let repository_unbound = match &workspace.repository_id {
                    Some(id) => {
                        let repository = self.repository(id)?;
                        repository.needs_rebind
                            || !binding_matches(
                                &self.connection,
                                "repository",
                                id,
                                &repository.root,
                            )?
                            || !linked_common_matches(&workspace.root, &repository.root)
                    }
                    None => false,
                };
                let needs_rebind = workspace.needs_rebind
                    || repository_unbound
                    || !binding_matches(
                        &self.connection,
                        "workspace",
                        &workspace.id,
                        &workspace.root,
                    )?;
                let rebindable =
                    saved_binding_identity(&self.connection, "workspace", &workspace.id)?.is_some();
                Ok(WorkspaceRebindEntry {
                    id: workspace.id,
                    root: workspace.root,
                    name: workspace.name,
                    needs_rebind,
                    rebindable,
                })
            })
            .collect()
    }
    pub fn repository(&self, id: &str) -> Result<Repository> {
        one(&self.connection, "repositories", id)
    }
    pub fn rebind_repositories(&self) -> Result<Vec<(String, String, bool, bool)>> {
        let repositories: Vec<Repository> = all(&self.connection, VISIBLE_REPOSITORIES)?;
        repositories
            .into_iter()
            .map(|repository| {
                let needs_rebind = repository.needs_rebind
                    || !binding_matches(
                        &self.connection,
                        "repository",
                        &repository.id,
                        &repository.root,
                    )?;
                let rebindable =
                    saved_binding_identity(&self.connection, "repository", &repository.id)?
                        .is_some();
                Ok((repository.id, repository.root, needs_rebind, rebindable))
            })
            .collect()
    }
    pub fn repository_bound(&self, id: &str) -> Result<bool> {
        let repository = self.repository(id)?;
        Ok(!repository.needs_rebind
            && binding_matches(&self.connection, "repository", id, &repository.root)?)
    }
    pub fn workspace_binding_identity(&self, id: &str) -> Result<(u64, u64)> {
        self.binding_identity("workspace", id)
    }
    pub fn repository_binding_identity(&self, id: &str) -> Result<(u64, u64)> {
        self.binding_identity("repository", id)
    }
    fn binding_identity(&self, kind: &str, id: &str) -> Result<(u64, u64)> {
        let saved: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT device,inode FROM path_bindings WHERE kind=?1 AND id=?2",
                params![kind, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (device, inode) = saved.context(ade_core::error::NeedsRebind)?;
        Ok((device.parse()?, inode.parse()?))
    }
    pub fn ensure_workspace_bound(&self, id: &str) -> Result<()> {
        // A path can be replaced by an external process after this check and
        // before a spawned child opens it. Callers recheck at admission and
        // launch; durable device/inode identity catches later attempts, but
        // path-based OS APIs cannot make that handoff fully atomic.
        let workspace = self.workspace(id)?;
        if self.workspace_removed(id)? {
            return Err(ade_core::error::WorkspaceRemoved(id.to_owned()).into());
        }
        if workspace.needs_rebind {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if !binding_matches(&self.connection, "workspace", id, &workspace.root)? {
            return Err(ade_core::error::NeedsRebind.into());
        }
        if let Some(repository_id) = &workspace.repository_id {
            let repository: Repository = one(&self.connection, "repositories", repository_id)?;
            if repository.needs_rebind
                || !binding_matches(
                    &self.connection,
                    "repository",
                    repository_id,
                    &repository.root,
                )?
                || !linked_common_matches(&workspace.root, &repository.root)
            {
                return Err(ade_core::error::NeedsRebind.into());
            }
        }
        Ok(())
    }
    pub fn has_pending_rebind(&self) -> Result<bool> {
        let marker: i64 = self.connection.query_row(
            "SELECT worktree_lifecycle_needs_rebind FROM restore_fence WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(marker != 0 || self.has_unbound_records()?)
    }
    pub fn has_unbound_records(&self) -> Result<bool> {
        // A removed workspace, and a repository only removed workspaces use,
        // never fences the profile: its folder may be gone on purpose.
        let pending: i64 = self.connection.query_row(
            concat!(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE (json_extract(data,'$.needs_rebind')=1 OR json_extract(data,'$.worktree_lifecycle_needs_rebind')=1) AND ",
                visible!("id"),
                " UNION ALL SELECT 1 FROM repositories WHERE (json_extract(data,'$.needs_rebind')=1 OR json_extract(data,'$.worktree_lifecycle_needs_rebind')=1) AND id IN (SELECT repository_id FROM workspaces WHERE ",
                visible!("id"),
                "))"
            ),
            [], |row| row.get(0),
        )?;
        if pending != 0 {
            return Ok(true);
        }
        let workspaces: Vec<WorkspaceRecord> = all(
            &self.connection,
            concat!("SELECT data FROM workspaces WHERE ", visible!("id")),
        )?;
        for workspace in workspaces {
            if !binding_matches(
                &self.connection,
                "workspace",
                &workspace.id,
                &workspace.root,
            )? {
                return Ok(true);
            }
            if let Some(repository_id) = &workspace.repository_id {
                let repository: Repository = one(&self.connection, "repositories", repository_id)?;
                if !linked_common_matches(&workspace.root, &repository.root) {
                    return Ok(true);
                }
            }
        }
        let repositories: Vec<Repository> = all(&self.connection, VISIBLE_REPOSITORIES)?;
        for repository in repositories {
            if !binding_matches(
                &self.connection,
                "repository",
                &repository.id,
                &repository.root,
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn release_restore_fence(&self) -> Result<()> {
        ensure!(
            !self.has_unbound_records()?,
            "Restore bindings remain unresolved"
        );
        self.connection.execute(
            "UPDATE restore_fence SET worktree_lifecycle_needs_rebind=0 WHERE id=1",
            [],
        )?;
        Ok(())
    }
    /// The indexed root and public JSON change in one SQLite transaction. An
    /// interrupted command therefore leaves the old fenced row or the new row.
    pub fn rebind_repository(
        &self,
        id: &str,
        common: &str,
        identity: (u64, u64),
    ) -> Result<Repository> {
        let tx = self.transaction()?;
        let mut repository: Repository = one(&tx, "repositories", id)?;
        let source_identity = saved_binding_identity(&tx, "repository", id)?
            .context("Saved repository physical identity is unavailable; rebind remains fenced")?;
        ensure!(
            source_identity != identity,
            "Select a different physical repository from the saved checkout"
        );
        ensure_not_source_directory(&tx, common)?;
        ensure!(
            repository.needs_rebind || !binding_matches(&tx, "repository", id, &repository.root)?,
            "Repository is already bound"
        );
        ensure!(
            repository.root != common || !binding_matches(&tx, "repository", id, common)?,
            "Select a different repository from the source checkout"
        );
        let collision: Option<String> = tx
            .query_row(
                "SELECT id FROM repositories WHERE root=?1 AND id!=?2",
                params![common, id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            collision.is_none(),
            "Repository path belongs to another identity"
        );
        repository.root = common.into();
        repository.needs_rebind = false;
        repository.worktree_lifecycle_needs_rebind = false;
        tx.execute(
            "UPDATE repositories SET root=?2,data=?3 WHERE id=?1",
            params![id, common, encode(&repository)?],
        )?;
        verify_binding_identity(common, identity)?;
        write_binding_identity(&tx, "repository", id, identity)?;
        tx.commit()?;
        Ok(repository)
    }
    pub fn repository_source_identity(&self, id: &str) -> Result<(u64, u64)> {
        saved_binding_identity(&self.connection, "repository", id)?
            .context("Saved repository physical identity is unavailable; rebind remains fenced")
    }
    pub fn reject_source_path(&self, path: &str) -> Result<()> {
        ensure_not_source_directory(&self.connection, path)
    }
    pub fn rebind_workspace(
        &self,
        id: &str,
        root: &str,
        common: Option<&str>,
        identity: (u64, u64),
    ) -> Result<WorkspaceRecord> {
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        let source_identity = saved_binding_identity(&tx, "workspace", id)?
            .context("Saved workspace physical identity is unavailable; rebind remains fenced")?;
        ensure!(
            source_identity != identity,
            "Select a different physical directory from the saved workspace"
        );
        ensure!(
            workspace.repository_id.is_some() || common.is_none(),
            "An ordinary workspace cannot rebind to a Git checkout; bind a repository first"
        );
        ensure_not_source_directory(&tx, root)?;
        let linked_repository = workspace
            .repository_id
            .as_ref()
            .map(|repository_id| one::<Repository>(&tx, "repositories", repository_id))
            .transpose()?;
        let linked_common_changed = linked_repository
            .as_ref()
            .is_some_and(|repository| !linked_common_matches(&workspace.root, &repository.root));
        ensure!(
            workspace.needs_rebind
                || !binding_matches(&tx, "workspace", id, &workspace.root)?
                || linked_common_changed,
            "Workspace is already bound"
        );
        ensure!(
            workspace.root != root
                || !binding_matches(&tx, "workspace", id, root)?
                || linked_common_changed,
            "Select a different directory from the source workspace"
        );
        let collision: Option<String> = tx
            .query_row(
                "SELECT id FROM workspaces WHERE root=?1 AND id!=?2",
                params![root, id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            collision.is_none(),
            "Workspace path belongs to another identity"
        );
        if let Some(repository) = linked_repository {
            let repository_id = &repository.id;
            ensure!(
                !repository.needs_rebind
                    && binding_matches(&tx, "repository", repository_id, &repository.root)?,
                "Rebind the repository first"
            );
            ensure!(
                Some(repository.root.as_str()) == common,
                "Workspace Git common directory differs from its repository binding"
            );
        }
        workspace.root = root.into();
        workspace.needs_rebind = false;
        workspace.worktree_lifecycle_needs_rebind = false;
        tx.execute(
            "UPDATE workspaces SET root=?2,data=?3 WHERE id=?1",
            params![id, root, encode(&workspace)?],
        )?;
        verify_binding_identity(root, identity)?;
        write_binding_identity(&tx, "workspace", id, identity)?;
        tx.commit()?;
        Ok(workspace)
    }
    pub fn restored_from_backup(&self) -> Result<bool> {
        let restored: i64 = self.connection.query_row(
            "SELECT restored_from_backup FROM restore_fence WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(restored != 0)
    }
    pub fn inherited_binding(&self, root: &str) -> Result<(bool, bool)> {
        let mut needs_rebind = false;
        let mut lifecycle_needs_rebind = false;
        let workspaces: Vec<WorkspaceRecord> = all(
            &self.connection,
            concat!("SELECT data FROM workspaces WHERE ", visible!("id")),
        )?;
        for workspace in workspaces {
            if Path::new(root).starts_with(&workspace.root) {
                needs_rebind |= workspace.needs_rebind;
                lifecycle_needs_rebind |= workspace.worktree_lifecycle_needs_rebind;
            }
        }
        Ok((needs_rebind, lifecycle_needs_rebind))
    }
    pub fn catalog(&self) -> Result<Catalogue> {
        let tx = self.connection.unchecked_transaction()?;
        // A removed workspace leaves the catalog with its Conversations; they
        // return when its folder is opened again. Windows are all listed: a
        // removal moves the windows that showed it.
        let repositories: Vec<Repository> = all(&tx, VISIBLE_REPOSITORIES)?;
        let result = Catalogue {
            repositories: repositories
                .into_iter()
                .map(|repository| CatalogRepository {
                    name: ade_core::workspaces::project_name(&repository.root),
                    id: repository.id,
                    root: repository.root,
                })
                .collect(),
            workspaces: all(
                &tx,
                concat!(
                    "SELECT data FROM workspaces WHERE ",
                    visible!("id"),
                    " ORDER BY rowid"
                ),
            )?,
            conversations: all(
                &tx,
                &format!(
                    "SELECT data FROM conversations c WHERE {NOT_DELETED} AND {} ORDER BY rowid",
                    visible!("c.workspace_id")
                ),
            )?,
            windows: super::layouts::windows(&tx)?,
            terminals: super::terminal_records::visible(&tx)?
                .iter()
                .map(|terminal| self.terminal_record(terminal))
                .collect(),
        };
        tx.commit()?;
        Ok(result)
    }
    pub(crate) fn catalog_binding_claims(
        &self,
        catalog: &Catalogue,
    ) -> Result<Vec<CatalogBindingClaim>> {
        catalog
            .workspaces
            .iter()
            .map(|workspace| {
                let repository = workspace
                    .repository_id
                    .as_ref()
                    .map(|id| {
                        let record: Repository = one(&self.connection, "repositories", id)?;
                        let expected =
                            current_binding_identity(&self.connection, "repository", id)?;
                        Ok::<_, anyhow::Error>((
                            record.root,
                            if record.needs_rebind { None } else { expected },
                        ))
                    })
                    .transpose()?;
                Ok(CatalogBindingClaim {
                    workspace: current_binding_identity(
                        &self.connection,
                        "workspace",
                        &workspace.id,
                    )?,
                    repository,
                })
            })
            .collect()
    }
    pub fn workspace_open(
        &self,
        root: &str,
        repository_root: Option<&str>,
    ) -> Result<WorkspaceRecord> {
        ensure!(!root.is_empty(), "Workspace root is empty");
        let (mut needs_rebind, worktree_lifecycle_needs_rebind) = self.inherited_binding(root)?;
        needs_rebind |= self.has_pending_rebind()?;
        let tx = self.transaction()?;
        let existing: Option<String> = tx
            .query_row("SELECT data FROM workspaces WHERE root=?1", [root], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(existing) = existing {
            let mut workspace: WorkspaceRecord = decode(existing)?;
            // Opening a removed workspace's folder restores the same identity
            // (F061) with its Conversations. Its saved physical binding is
            // checked below like any other: a replaced folder needs a rebind.
            tx.execute(
                "DELETE FROM workspace_tombstones WHERE workspace_id=?1",
                [&workspace.id],
            )?;
            let repository_changed = if let Some(repository_id) = &workspace.repository_id {
                let repository: Repository = one(&tx, "repositories", repository_id)?;
                repository.needs_rebind
                    || !binding_matches(&tx, "repository", repository_id, &repository.root)?
                    || !linked_common_matches(&workspace.root, &repository.root)
            } else {
                false
            };
            if !workspace.needs_rebind
                && (repository_changed
                    || !binding_matches(&tx, "workspace", &workspace.id, &workspace.root)?)
            {
                workspace.needs_rebind = true;
                tx.execute(
                    "UPDATE workspaces SET data=?2 WHERE id=?1",
                    params![workspace.id, encode(&workspace)?],
                )?;
            }
            tx.commit()?;
            return Ok(workspace);
        }
        // A new path has no saved identity to recover. Persisting it while a
        // restored claim is unresolved would give it a fenced, unbindable ID
        // and could also block the original workspace from selecting it.
        ensure!(!needs_rebind, ade_core::error::NeedsRebind);
        let repository_id = if let Some(repository_root) = repository_root {
            ensure!(!repository_root.is_empty(), "Repository root is empty");
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM repositories WHERE root=?1",
                    [repository_root],
                    |r| r.get(0),
                )
                .optional()?;
            Some(if let Some(id) = existing {
                id
            } else {
                let repository = Repository {
                    id: new_id("repo"),
                    root: repository_root.into(),
                    needs_rebind: false,
                    worktree_lifecycle_needs_rebind: false,
                };
                tx.execute(
                    "INSERT INTO repositories VALUES(?1,?2,?3)",
                    params![repository.id, repository.root, encode(&repository)?],
                )?;
                if !needs_rebind {
                    write_binding(&tx, "repository", &repository.id, &repository.root)?;
                }
                repository.id
            })
        } else {
            None
        };
        if let Some(id) = &repository_id {
            let repository: Repository = one(&tx, "repositories", id)?;
            needs_rebind |= repository.needs_rebind
                || !binding_matches(&tx, "repository", id, &repository.root)?;
        }
        let workspace = WorkspaceRecord {
            extra_terminals: Vec::new(),
            id: new_id("workspace"),
            repository_id,
            root: root.into(),
            needs_rebind,
            worktree_lifecycle_needs_rebind,
            name: Path::new(root)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(root)
                .into(),
            terminal_id: new_id("terminal"),
        };
        tx.execute(
            "INSERT INTO workspaces VALUES(?1,?2,?3,?4,?5)",
            params![
                workspace.id,
                workspace.repository_id,
                workspace.root,
                workspace.terminal_id,
                encode(&workspace)?
            ],
        )?;
        write_binding(&tx, "workspace", &workspace.id, &workspace.root)?;
        super::terminal_records::insert(
            &tx,
            &super::terminal_records::Stored::primary(&workspace.terminal_id, &workspace.id),
        )?;
        // The lifecycle hook commits with the new workspace (F058).
        crate::hooks::enqueue(
            &tx,
            &crate::hooks::Event::workspace_created(&workspace),
            now_ms(),
        )?;
        tx.commit()?;
        Ok(workspace)
    }
}

/// Repositories that a workspace still in the catalog uses, in registration order.
const VISIBLE_REPOSITORIES: &str = concat!(
    "SELECT data FROM repositories WHERE id IN (SELECT repository_id FROM workspaces WHERE ",
    visible!("id"),
    ") ORDER BY rowid"
);

impl Store {
    /// Whether the workspace exists and was removed from ADE. An unknown ID
    /// is [`ade_core::error::WorkspaceNotFound`].
    pub fn workspace_removed(&self, id: &str) -> Result<bool> {
        let row: Option<i64> = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_tombstones WHERE workspace_id=?1) FROM workspaces WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match row {
            Some(removed) => Ok(removed != 0),
            None => Err(ade_core::error::WorkspaceNotFound(id.to_owned()).into()),
        }
    }
    /// `workspace.rename`: stores a new display name. Only the name changes.
    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<WorkspaceRecord> {
        let name = ade_core::workspaces::display_name(name)
            .map_err(ade_core::error::InvalidWorkspaceName)?;
        let tx = self.transaction()?;
        if self.workspace_removed(id)? {
            return Err(ade_core::error::WorkspaceRemoved(id.to_owned()).into());
        }
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        workspace.name = name;
        tx.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![id, encode(&workspace)?],
        )?;
        tx.commit()?;
        Ok(workspace)
    }
    /// What the profile database knows blocks removing the workspace: busy or
    /// terminal-owned Conversations and running services. The daemon adds the
    /// runtime's script runs and its default workspace.
    pub fn workspace_remove_blockers(&self, id: &str) -> Result<Vec<RemoveBlocker>> {
        let conversations: Vec<Conversation> = self
            .connection
            .prepare(&format!(
                "SELECT data FROM conversations c WHERE {NOT_DELETED} AND c.workspace_id=?1 ORDER BY rowid"
            ))?
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|row| decode(row?))
            .collect::<Result<_>>()?;
        let mut blockers = Vec::new();
        for conversation in conversations {
            let kind =
                if conversation.terminal_owner.is_some() || conversation.view_terminal.is_some() {
                    RemoveBlockerKind::ConversationInTerminal
                } else if BUSY.contains(&conversation.status.as_str())
                    || conversation.active_turn_id.is_some()
                {
                    RemoveBlockerKind::ConversationRunning
                } else {
                    continue;
                };
            blockers.push(RemoveBlocker {
                kind,
                label: format!("Conversation \"{}\"", conversation.title),
                id: conversation.id,
            });
        }
        for service in self.services(id)? {
            if service.terminal_owner.is_some() {
                blockers.push(RemoveBlocker {
                    kind: RemoveBlockerKind::ServiceRunning,
                    label: format!("Service {}", service.name),
                    id: service.name,
                });
            }
        }
        Ok(blockers)
    }
    /// Records the removal, deletes the workspace's layouts and moves the
    /// windows showing it (`layouts::workspace_removed`). Returns None when
    /// the workspace was already removed.
    pub fn remove_workspace(
        &self,
        id: &str,
        operation_id: &str,
    ) -> Result<Option<super::layouts::WorkspaceRemoval>> {
        let tx = self.transaction()?;
        if self.workspace_removed(id)? {
            return Ok(None);
        }
        let blockers = self.workspace_remove_blockers(id)?;
        if !blockers.is_empty() {
            return Err(ade_core::error::WorkspaceRemoveBlocked(blockers).into());
        }
        tx.execute(
            "INSERT INTO workspace_tombstones(workspace_id,operation_id,removed_at) VALUES(?1,?2,?3)",
            params![id, operation_id, now_ms()],
        )?;
        // Keep this in the tombstone's transaction: the layouts go and the
        // windows move with the removal, or neither happens.
        let removal = super::layouts::workspace_removed(&tx, id)?;
        tx.commit()?;
        Ok(Some(removal))
    }
    /// Retires a removed workspace's terminals from its record, once per
    /// removal: its primary terminal gets a fresh ID and every extra terminal
    /// except a service's is dropped, so reopening the folder starts clean
    /// shells. Returns the retired terminal IDs, empty on a repeat. Service
    /// terminals stay with their service.
    pub fn retire_removed_terminals(&self, id: &str) -> Result<Vec<String>> {
        Ok(self.retire_removed_terminal_tabs(id)?.0)
    }
    /// [`Self::retire_removed_terminals`], with the layouts that lost the
    /// retired terminals' tabs, for the caller to publish.
    pub fn retire_removed_terminal_tabs(
        &self,
        id: &str,
    ) -> Result<(Vec<String>, Vec<ade_core::contract::layout::LayoutRecord>)> {
        let tx = self.transaction()?;
        let retired: Option<i64> = tx
            .query_row(
                "SELECT terminals_retired FROM workspace_tombstones WHERE workspace_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match retired {
            None => anyhow::bail!("Only a removed workspace retires all its terminals"),
            Some(1) => return Ok((Vec::new(), Vec::new())),
            Some(_) => {}
        }
        let workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        let services: Vec<String> = self
            .services(id)?
            .into_iter()
            .filter_map(|service| service.terminal_id)
            .collect();
        let retired: Vec<String> = std::iter::once(&workspace.terminal_id)
            .chain(&workspace.extra_terminals)
            .filter(|terminal| !services.contains(terminal))
            .cloned()
            .collect();
        let mut layouts = Vec::new();
        for terminal in &retired {
            layouts.extend(super::terminal_records::remove(&tx, id, terminal)?.unwrap_or_default());
        }
        tx.execute(
            "UPDATE workspace_tombstones SET terminals_retired=1 WHERE workspace_id=?1",
            [id],
        )?;
        tx.commit()?;
        Ok((retired, layouts))
    }
}
