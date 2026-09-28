//! Projects and what the daemon derives for each record it lists: one project
//! identity shared by the catalog and the worktree lifecycle, each
//! workspace's kind, branch and ADE ownership, and the presentation fields
//! every reply carries (a Conversation's attention, unread state and
//! orchestration links, and the default workspace).
use super::*;
use ade_core::model::{CatalogProject, CatalogRepository, ProjectKind, WorkspaceKind};
use std::collections::{HashMap, HashSet};

/// The profile schema this module adds. Applied by [`migrate`], which the
/// provisional `version < 18` block of `Store::open` calls.
const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS conversation_seen(conversation_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_worktree_operations(operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workspace_worktree_operations_running ON workspace_worktree_operations(status);
";

/// The catalog projects migration: every workspace gets a `project_id` (its
/// repository, or a new folder project), and every existing Conversation
/// starts read so an upgrade marks nothing unread.
pub(super) fn migrate(tx: &Connection) -> Result<()> {
    tx.execute_batch(SCHEMA)?;
    assign_project_ids(tx)?;
    tx.execute(
        "INSERT OR IGNORE INTO conversation_seen(conversation_id,seen_at) SELECT id,COALESCE(json_extract(data,'$.updated_at'),0) FROM conversations",
        [],
    )?;
    Ok(())
}

/// Gives each workspace without one its project: its repository, or a folder
/// project of its own.
fn assign_project_ids(tx: &Connection) -> Result<()> {
    let rows: Vec<(String, String)> = tx
        .prepare("SELECT id,data FROM workspaces ORDER BY rowid")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, data) in rows {
        let mut workspace: WorkspaceRecord = decode(data)?;
        if !workspace.project_id.is_empty() {
            continue;
        }
        workspace.project_id = project_of(&workspace);
        tx.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![id, encode(&workspace)?],
        )?;
    }
    Ok(())
}

/// A new workspace's project: its repository, or a new folder project.
pub(super) fn project_of(workspace: &WorkspaceRecord) -> String {
    workspace
        .repository_id
        .clone()
        .unwrap_or_else(|| new_id("project"))
}

/// What the daemon last recorded about a workspace's folder, and where to
/// look again.
#[derive(Clone, Debug)]
pub struct FactTarget {
    pub id: String,
    pub root: String,
    /// Whether the workspace belongs to a Git repository project.
    pub repository: bool,
    pub facts: WorkspaceFacts,
}

/// The folder facts a workspace record carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFacts {
    pub kind: WorkspaceKind,
    pub branch: Option<String>,
    pub ade_owned: bool,
}

/// A project as a command resolves it.
#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub kind: ProjectKind,
    /// A repository's Git common directory, or the folder.
    pub root: String,
}

fn table_exists(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

/// Whether two paths name the same directory once symlinks resolve.
fn same_directory(left: &str, right: &str) -> bool {
    left == right
        || matches!(
            (std::fs::canonicalize(left), std::fs::canonicalize(right)),
            (Ok(a), Ok(b)) if a == b
        )
}

/// The ID of the repository whose Git common directory is `common`.
pub(super) fn repository_by_common(db: &Connection, common: &str) -> Result<Option<String>> {
    let exact: Option<String> = db
        .query_row(
            "SELECT id FROM repositories WHERE root=?1",
            [common],
            |row| row.get(0),
        )
        .optional()?;
    if exact.is_some() {
        return Ok(exact);
    }
    let rows: Vec<(String, String)> = db
        .prepare("SELECT id,root FROM repositories ORDER BY rowid")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .find(|(_, root)| same_directory(root, common))
        .map(|(id, _)| id))
}

/// Runs `query`, narrowed to `key = only` when `only` is set.
fn rows<T>(
    db: &Connection,
    query: &str,
    key: &str,
    only: Option<&str>,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut sql = query.to_owned();
    if only.is_some() {
        sql.push_str(&format!(" AND {key}=?1"));
    }
    let mut statement = db.prepare(&sql)?;
    Ok(statement
        .query_map(rusqlite::params_from_iter(only), map)?
        .collect::<rusqlite::Result<_>>()?)
}

/// The presentation of Conversations, read in one pass.
struct ConversationFacts {
    open_requests: HashSet<String>,
    seen: HashMap<String, i64>,
    parents: HashMap<String, String>,
    groups: HashMap<String, String>,
}

impl ConversationFacts {
    /// Reads the facts for `only`, or for every Conversation.
    fn read(db: &Connection, only: Option<&str>) -> Result<Self> {
        let open_requests = rows(
            db,
            "SELECT DISTINCT conversation_id FROM requests WHERE status='pending'",
            "conversation_id",
            only,
            |row| row.get::<_, String>(0),
        )?
        .into_iter()
        .collect();
        let seen = rows(
            db,
            "SELECT conversation_id,seen_at FROM conversation_seen WHERE 1",
            "conversation_id",
            only,
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?
        .into_iter()
        .collect();
        let pair =
            |row: &rusqlite::Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?));
        // Orchestration creates its tables on first use.
        let parents = if table_exists(db, "orchestration_children")? {
            rows(
                db,
                "SELECT child_id,parent_id FROM orchestration_children WHERE 1",
                "child_id",
                only,
                pair,
            )?
            .into_iter()
            .collect()
        } else {
            HashMap::new()
        };
        let groups = if table_exists(db, "orchestration_group_runs")? {
            rows(
                db,
                "SELECT child_id,group_id FROM orchestration_group_runs WHERE 1",
                "child_id",
                only,
                pair,
            )?
            .into_iter()
            .collect()
        } else {
            HashMap::new()
        };
        Ok(Self {
            open_requests,
            seen,
            parents,
            groups,
        })
    }

    fn present(&self, conversation: &mut Conversation) {
        conversation.attention = ade_core::workspaces::attention(
            &conversation.status,
            self.open_requests.contains(&conversation.id),
        );
        // A Conversation never marked seen, such as an imported one, is unread.
        conversation.unread = self
            .seen
            .get(&conversation.id)
            .is_none_or(|seen| conversation.updated_at > *seen);
        conversation.parent_conversation_id = self.parents.get(&conversation.id).cloned();
        conversation.group_id = self.groups.get(&conversation.id).cloned();
    }
}

impl Store {
    /// Records the daemon's own workspace, which replies mark `default`.
    pub fn set_default_workspace(&mut self, id: &str) {
        self.default_workspace = (!id.is_empty()).then(|| id.to_owned());
    }

    /// Fills the fields a workspace reply carries but the record never stores.
    pub fn present_workspace(&self, workspace: &mut WorkspaceRecord) {
        workspace.default = self.default_workspace.as_deref() == Some(workspace.id.as_str());
        if let Some(repository) = &workspace.repository_id {
            workspace.project_id = repository.clone();
        }
    }

    /// Fills a Conversation's attention, unread state and orchestration links.
    pub fn present_conversation(&self, conversation: &mut Conversation) -> Result<()> {
        ConversationFacts::read(&self.connection, Some(&conversation.id))?.present(conversation);
        Ok(())
    }

    /// Lists the projects of `catalog`'s workspaces and fills every
    /// presentation field, inside the catalog's read transaction.
    pub(super) fn present_catalog(&self, db: &Connection, catalog: &mut Catalogue) -> Result<()> {
        let repositories: HashMap<String, CatalogRepository> = catalog
            .repositories
            .iter()
            .map(|repository| (repository.id.clone(), repository.clone()))
            .collect();
        let mut listed = HashSet::new();
        for workspace in &mut catalog.workspaces {
            self.present_workspace(workspace);
            if !listed.insert(workspace.project_id.clone()) {
                continue;
            }
            catalog
                .projects
                .push(match repositories.get(&workspace.project_id) {
                    Some(repository) => CatalogProject {
                        id: repository.id.clone(),
                        kind: ProjectKind::Repository,
                        name: repository.name.clone(),
                        root: repository.root.clone(),
                    },
                    None => CatalogProject {
                        id: workspace.project_id.clone(),
                        kind: ProjectKind::Folder,
                        name: ade_core::workspaces::folder_name(&workspace.root),
                        root: workspace.root.clone(),
                    },
                });
        }
        let facts = ConversationFacts::read(db, None)?;
        for conversation in &mut catalog.conversations {
            facts.present(conversation);
        }
        Ok(())
    }

    /// Marks a Conversation seen up to `through`, its last change when
    /// absent. Idempotent: the mark never moves back. Returns whether its
    /// unread state could have changed.
    pub fn mark_seen(&self, conversation: &str, through: Option<i64>) -> Result<bool> {
        let current = self.conversation(conversation)?;
        let through = through.unwrap_or(current.updated_at);
        ensure!(through >= 0, "Invalid seen time");
        let changed = self.connection.execute(
            "INSERT INTO conversation_seen(conversation_id,seen_at) VALUES(?1,?2) ON CONFLICT(conversation_id) DO UPDATE SET seen_at=excluded.seen_at WHERE excluded.seen_at>seen_at",
            params![conversation, through],
        )?;
        Ok(changed > 0)
    }

    /// Records a new Conversation as seen at its creation.
    pub(super) fn created_seen(db: &Connection, conversation: &Conversation) -> Result<()> {
        db.execute(
            "INSERT OR IGNORE INTO conversation_seen(conversation_id,seen_at) VALUES(?1,?2)",
            params![conversation.id, conversation.updated_at],
        )?;
        Ok(())
    }

    /// The workspaces in the catalog, or only `only`, with the facts last
    /// recorded for them.
    pub fn fact_targets(&self, only: Option<&str>) -> Result<Vec<FactTarget>> {
        let workspaces: Vec<WorkspaceRecord> = match only {
            Some(id) => vec![self.workspace(id)?],
            None => all(
                &self.connection,
                "SELECT data FROM workspaces WHERE id NOT IN (SELECT workspace_id FROM workspace_tombstones) ORDER BY rowid",
            )?,
        };
        Ok(workspaces
            .into_iter()
            .map(|workspace| FactTarget {
                repository: workspace.repository_id.is_some(),
                facts: WorkspaceFacts {
                    kind: workspace.kind,
                    branch: workspace.branch.clone(),
                    ade_owned: workspace.ade_owned,
                },
                id: workspace.id,
                root: workspace.root,
            })
            .collect())
    }

    /// Stores a workspace's folder facts. Returns whether they changed.
    pub fn set_workspace_facts(&self, id: &str, facts: &WorkspaceFacts) -> Result<bool> {
        let tx = self.transaction()?;
        let mut workspace: WorkspaceRecord = one(&tx, "workspaces", id)?;
        if workspace.kind == facts.kind
            && workspace.branch == facts.branch
            && workspace.ade_owned == facts.ade_owned
        {
            return Ok(false);
        }
        workspace.kind = facts.kind;
        workspace.branch = facts.branch.clone();
        workspace.ade_owned = facts.ade_owned;
        tx.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![id, encode(&workspace)?],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// The catalog repository whose Git common directory is `common`, created
    /// and bound when there is none, so the worktree lifecycle and the
    /// catalog share one project ID.
    pub fn project_for_common(&self, common: &str) -> Result<String> {
        ensure!(!common.is_empty(), "Repository root is empty");
        ensure!(!self.has_pending_rebind()?, ade_core::error::NeedsRebind);
        let tx = self.transaction()?;
        if let Some(id) = repository_by_common(&tx, common)? {
            return Ok(id);
        }
        let repository = Repository {
            id: new_id("repo"),
            root: common.into(),
            needs_rebind: false,
            worktree_lifecycle_needs_rebind: false,
        };
        tx.execute(
            "INSERT INTO repositories VALUES(?1,?2,?3)",
            params![repository.id, repository.root, encode(&repository)?],
        )?;
        write_binding(&tx, "repository", &repository.id, &repository.root)?;
        tx.commit()?;
        Ok(repository.id)
    }

    /// A project by its ID: a repository, or a folder workspace's project.
    pub fn project(&self, id: &str) -> Result<Project> {
        if let Ok(repository) = self.repository(id) {
            return Ok(Project {
                id: repository.id,
                kind: ProjectKind::Repository,
                root: repository.root,
            });
        }
        let root: Option<String> = self
            .connection
            .query_row(
                "SELECT root FROM workspaces WHERE json_extract(data,'$.project_id')=?1 AND repository_id IS NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match root {
            Some(root) => Ok(Project {
                id: id.to_owned(),
                kind: ProjectKind::Folder,
                root,
            }),
            None => Err(ade_core::error::ProjectNotFound(id.to_owned()).into()),
        }
    }

    /// The roots of a project's workspaces, those in the catalog first.
    pub fn project_roots(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .connection
            .prepare(
                "SELECT root FROM workspaces WHERE repository_id=?1 ORDER BY id IN (SELECT workspace_id FROM workspace_tombstones), rowid",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Database, test_root};
    use super::*;

    #[test]
    fn every_workspace_names_a_project_and_folders_are_projects() {
        let db = Database::new();
        let store = db.open();
        let project = new_id("repo-project");
        let main = test_root(&project);
        let common = test_root(&format!("{project}/.git"));
        let checkout = store.workspace_open(&main, Some(&common)).unwrap();
        let folder = store
            .workspace_open(&test_root(&new_id("notes")), None)
            .unwrap();
        assert_eq!(Some(&checkout.project_id), checkout.repository_id.as_ref());
        assert!(folder.project_id.starts_with("project_"));
        assert_eq!(folder.repository_id, None);
        let catalog = store.catalog().unwrap();
        let kinds: Vec<_> = catalog
            .projects
            .iter()
            .map(|project| (project.id.clone(), project.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (checkout.project_id.clone(), ProjectKind::Repository),
                (folder.project_id.clone(), ProjectKind::Folder),
            ]
        );
        assert_eq!(catalog.projects[1].root, folder.root);
        assert_eq!(catalog.repositories.len(), 1);
        assert!(matches!(
            store.project(&folder.project_id).unwrap().kind,
            ProjectKind::Folder
        ));
        let missing = store.project("repo_missing").unwrap_err();
        assert_eq!(
            ade_core::error::error_envelope(missing)["code"],
            "project_not_found"
        );
        // The lifecycle finds the same project from the common directory.
        assert_eq!(
            store.project_for_common(&common).unwrap(),
            checkout.project_id
        );
        // A repository the catalog has not seen is created once, bound.
        let other = test_root(&format!("{}/.git", new_id("lifecycle-only")));
        let created = store.project_for_common(&other).unwrap();
        assert_eq!(store.project_for_common(&other).unwrap(), created);
        assert!(store.repository_bound(&created).unwrap());
    }

    #[test]
    fn the_migration_assigns_projects_and_marks_existing_conversations_read() {
        let db = Database::new();
        let store = db.open();
        let folder = store
            .workspace_open(&test_root(&new_id("legacy")), None)
            .unwrap();
        let conversation = store.create_conversation(&folder.id, "Old").unwrap();
        // A record written before projects existed.
        let mut legacy = store.workspace(&folder.id).unwrap();
        legacy.project_id = String::new();
        store
            .connection
            .execute(
                "UPDATE workspaces SET data=?2 WHERE id=?1",
                params![legacy.id, encode(&legacy).unwrap()],
            )
            .unwrap();
        store
            .connection
            .execute("DELETE FROM conversation_seen", [])
            .unwrap();
        migrate(&store.connection).unwrap();
        let migrated = store.workspace(&folder.id).unwrap();
        assert!(migrated.project_id.starts_with("project_"));
        let mut listed = store.conversation(&conversation.id).unwrap();
        store.present_conversation(&mut listed).unwrap();
        assert!(!listed.unread);
    }

    #[test]
    fn unread_follows_changes_after_the_seen_mark_and_attention_follows_status() {
        let db = Database::new();
        let store = db.open();
        let workspace = store
            .workspace_open(&test_root(&new_id("attention")), None)
            .unwrap();
        let mut conversation = store.create_conversation(&workspace.id, "Talk").unwrap();
        let present = |store: &Store, id: &str| {
            let mut conversation = store.conversation(id).unwrap();
            store.present_conversation(&mut conversation).unwrap();
            conversation
        };
        // A new Conversation starts read and idle.
        let fresh = present(&store, &conversation.id);
        assert!(!fresh.unread);
        assert_eq!(fresh.attention, Attention::Idle);
        conversation.status = "running".into();
        conversation.updated_at += 10;
        store.commit_conversation(&conversation, &[], &[]).unwrap();
        let running = present(&store, &conversation.id);
        assert!(running.unread);
        assert_eq!(running.attention, Attention::Running);
        // Marking seen clears it, and is idempotent; an older mark never wins.
        assert!(store.mark_seen(&conversation.id, None).unwrap());
        assert!(!store.mark_seen(&conversation.id, None).unwrap());
        assert!(!store.mark_seen(&conversation.id, Some(0)).unwrap());
        assert!(!present(&store, &conversation.id).unread);
        // The stored record never carries the presentation.
        let stored: String = store
            .connection
            .query_row(
                "SELECT data FROM conversations WHERE id=?1",
                [&conversation.id],
                |row| row.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["attention"], "idle");
        assert_eq!(stored["unread"], false);
    }

    #[test]
    fn workspace_facts_are_stored_and_the_default_is_only_presented() {
        let db = Database::new();
        let mut store = db.open();
        let workspace = store
            .workspace_open(&test_root(&new_id("facts")), None)
            .unwrap();
        let facts = WorkspaceFacts {
            kind: WorkspaceKind::LinkedWorktree,
            branch: Some("feature".into()),
            ade_owned: true,
        };
        assert!(store.set_workspace_facts(&workspace.id, &facts).unwrap());
        assert!(!store.set_workspace_facts(&workspace.id, &facts).unwrap());
        let target = &store.fact_targets(Some(&workspace.id)).unwrap()[0];
        assert_eq!(target.facts, facts);
        store.set_default_workspace(&workspace.id);
        let listed = store.catalog().unwrap();
        assert!(listed.workspaces[0].default);
        assert_eq!(listed.workspaces[0].branch.as_deref(), Some("feature"));
        assert!(!store.workspace(&workspace.id).unwrap().default);
    }
}
