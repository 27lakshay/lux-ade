//! Projects and what the daemon derives for each record it lists: one project
//! identity shared by the catalog and the worktree lifecycle, each
//! workspace's kind, branch and ADE ownership, and the presentation fields
//! every reply carries (a Conversation's attention, unread state and
//! orchestration links, and the default workspace).
use super::*;
use ade_core::model::{CatalogProject, ProjectKind, WorkspaceKind};
use std::collections::{HashMap, HashSet};

/// A message the person did not write themselves: what makes a Conversation
/// unread. Only a rewind reads it from messages.
const NEWS: &str = "COALESCE(json_extract(data,'$.role'),'')!='user'";

/// Records a message written at `sequence` in `conversation`: news unless the
/// person wrote it. Every message writer calls it in its own transaction.
pub fn record_news(db: &Connection, conversation: &str, sequence: i64, role: &str) -> Result<()> {
    if role != "user" {
        db.execute(
            "INSERT INTO conversation_news(conversation_id,news_sequence) VALUES(?1,?2) ON CONFLICT(conversation_id) DO UPDATE SET news_sequence=MAX(news_sequence,excluded.news_sequence)",
            params![conversation, sequence],
        )?;
    }
    Ok(())
}

/// Recounts a Conversation's news and seen marks after messages were
/// removed (a rewind), so later messages at reused sequences are news again.
pub(super) fn recount_news(db: &Connection, conversation: &str) -> Result<()> {
    db.execute(
        &format!(
            "INSERT OR REPLACE INTO conversation_news(conversation_id,news_sequence) VALUES(?1,COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id=?1 AND {NEWS}),0))"
        ),
        [conversation],
    )?;
    db.execute(
        "UPDATE conversation_seen SET seen_sequence=MIN(seen_sequence,COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id=?1),0)) WHERE conversation_id=?1",
        [conversation],
    )?;
    Ok(())
}

/// Marks everything a Conversation holds now as seen, such as history just
/// imported: old work is not news.
pub fn seen_as_is(db: &Connection, conversation: &str) -> Result<()> {
    db.execute(
        "INSERT INTO conversation_seen(conversation_id,seen_sequence) SELECT ?1,COALESCE(MAX(sequence),0) FROM messages WHERE conversation_id=?1 ON CONFLICT(conversation_id) DO UPDATE SET seen_sequence=MAX(seen_sequence,excluded.seen_sequence)",
        [conversation],
    )?;
    Ok(())
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

/// The newest message `sequence` in `conversation` the person did not write.
fn newest_news(db: &Connection, conversation: &str) -> Result<Option<i64>> {
    Ok(db
        .query_row(
            "SELECT news_sequence FROM conversation_news WHERE conversation_id=?1",
            [conversation],
            |row| row.get(0),
        )
        .optional()?)
}

/// The presentation of Conversations, read in one pass.
struct ConversationFacts {
    open_requests: HashSet<String>,
    seen: HashMap<String, i64>,
    /// The newest message `sequence` the person did not write, per Conversation.
    news: HashMap<String, i64>,
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
            "SELECT conversation_id,seen_sequence FROM conversation_seen WHERE 1",
            "conversation_id",
            only,
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?
        .into_iter()
        .collect();
        let news = rows(
            db,
            "SELECT conversation_id,news_sequence FROM conversation_news WHERE 1",
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
            news,
            parents,
            groups,
        })
    }

    fn present(&self, conversation: &mut Conversation) {
        conversation.attention = ade_core::workspaces::attention(
            &conversation.status,
            self.open_requests.contains(&conversation.id),
        );
        let seen = self.seen.get(&conversation.id).copied().unwrap_or(0);
        conversation.unread = self
            .news
            .get(&conversation.id)
            .is_some_and(|newest| *newest > seen);
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
    }

    /// Fills a Conversation's attention, unread state and orchestration links.
    pub fn present_conversation(&self, conversation: &mut Conversation) -> Result<()> {
        ConversationFacts::read(&self.connection, Some(&conversation.id))?.present(conversation);
        Ok(())
    }

    /// Lists the projects of `catalog`'s workspaces, the repository ones from
    /// `repositories`, and fills every presentation field, inside the
    /// catalog's read transaction.
    pub(super) fn present_catalog(
        &self,
        db: &Connection,
        catalog: &mut Catalogue,
        repositories: &HashMap<String, Repository>,
    ) -> Result<()> {
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
                        name: ade_core::workspaces::project_name(&repository.root),
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

    /// Records the review feedback a queued prompt carries, for its message.
    pub fn set_queued_review_feedback(&self, id: &str, feedback: &Value) -> Result<()> {
        self.connection.execute(
            "UPDATE queued_prompts SET review_feedback=?2 WHERE id=?1 AND status='queued'",
            params![id, feedback.to_string()],
        )?;
        Ok(())
    }

    /// The review feedback a queued prompt carries, if any.
    pub fn queued_review_feedback(&self, id: &str) -> Result<Option<Value>> {
        let text: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT review_feedback FROM queued_prompts WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        text.flatten()
            .map(|text| Ok(serde_json::from_str(&text)?))
            .transpose()
    }

    /// Marks a Conversation seen up to message `through`, its newest message
    /// when absent. Idempotent: the mark never moves back, nor past the
    /// newest message. Returns whether the mark moved.
    pub fn mark_seen(&self, conversation: &str, through: Option<i64>) -> Result<bool> {
        self.conversation(conversation)?;
        ensure!(
            through.is_none_or(|through| through >= 0),
            "Invalid message sequence"
        );
        // A message the client has not shown yet stays unread.
        let newest = newest_news(&self.connection, conversation)?.unwrap_or(0);
        let through = through.map_or(newest, |through| through.min(newest));
        let seen: i64 = self
            .connection
            .query_row(
                "SELECT seen_sequence FROM conversation_seen WHERE conversation_id=?1",
                [conversation],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if through <= seen {
            return Ok(false);
        }
        self.connection.execute(
            "INSERT INTO conversation_seen(conversation_id,seen_sequence) VALUES(?1,?2) ON CONFLICT(conversation_id) DO UPDATE SET seen_sequence=excluded.seen_sequence",
            params![conversation, through],
        )?;
        Ok(true)
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
        workspaces
            .into_iter()
            .map(|workspace| {
                Ok(FactTarget {
                    repository: super::bindings::repository_of(&self.connection, &workspace.id)?
                        .is_some(),
                    facts: WorkspaceFacts {
                        kind: workspace.kind,
                        branch: workspace.branch.clone(),
                        ade_owned: workspace.ade_owned,
                    },
                    id: workspace.id,
                    root: workspace.root,
                })
            })
            .collect()
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

    /// The catalog repository whose Git common directory is `common`, if the
    /// catalog has one. It never creates one: a repository the lifecycle
    /// registers first keeps the lifecycle's ID, and the catalog takes that ID
    /// when a workspace of it opens (`workspace_open`'s `preferred_id`).
    pub fn project_for_common(&self, common: &str) -> Result<Option<String>> {
        if common.is_empty() {
            return Ok(None);
        }
        repository_by_common(&self.connection, common)
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
                "SELECT root FROM workspaces WHERE project_id=?1 AND project_id NOT IN (SELECT id FROM repositories)",
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

    /// The roots of a repository project's workspaces, those in the catalog
    /// first. A folder project has none: it has no checkout to register.
    pub fn project_roots(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .connection
            .prepare(
                "SELECT root FROM workspaces WHERE project_id=?1 AND project_id IN (SELECT id FROM repositories) ORDER BY id IN (SELECT workspace_id FROM workspace_tombstones), rowid",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Database, assistant, test_root};
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
        assert_eq!(
            store.workspace_repository(&checkout.id).unwrap(),
            Some(checkout.project_id.clone())
        );
        assert!(folder.project_id.starts_with("project_"));
        assert_eq!(store.workspace_repository(&folder.id).unwrap(), None);
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
            Some(checkout.project_id.clone())
        );
        // A repository the catalog has not seen is not created by the lookup;
        // its first workspace takes the lifecycle's ID.
        let name = new_id("lifecycle-only");
        let other = test_root(&format!("{name}/.git"));
        assert_eq!(store.project_for_common(&other).unwrap(), None);
        let opened = store
            .workspace_open_as(
                &test_root(&name),
                Some(&other),
                Some("repository_lifecycle"),
            )
            .unwrap();
        assert_eq!(opened.project_id, "repository_lifecycle");
        assert!(store.repository_bound("repository_lifecycle").unwrap());
        // A preferred ID another repository holds is not reused.
        let third = new_id("third");
        let taken = store
            .workspace_open_as(
                &test_root(&third),
                Some(&test_root(&format!("{third}/.git"))),
                Some("repository_lifecycle"),
            )
            .unwrap();
        assert_ne!(taken.project_id, "repository_lifecycle");
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
        // A status change alone is not news: attention shows it.
        conversation.status = "running".into();
        conversation.updated_at += 10;
        store.commit_conversation(&conversation, &[], &[]).unwrap();
        let running = present(&store, &conversation.id);
        assert!(!running.unread);
        assert_eq!(running.attention, Attention::Running);
        // A reply is.
        let reply = assistant(&conversation, "reply-1", "item-1");
        store
            .commit_conversation(&conversation, &[reply], &[])
            .unwrap();
        assert!(present(&store, &conversation.id).unread);
        // Marking seen clears it, and is idempotent; an older mark never wins.
        assert!(!store.mark_seen(&conversation.id, Some(0)).unwrap());
        assert!(store.mark_seen(&conversation.id, None).unwrap());
        assert!(!store.mark_seen(&conversation.id, None).unwrap());
        assert!(!store.mark_seen(&conversation.id, Some(0)).unwrap());
        assert!(!present(&store, &conversation.id).unread);
        // A mark past the newest message does not hide the next one.
        assert!(!store.mark_seen(&conversation.id, Some(1_000)).unwrap());
        let next = assistant(&conversation, "reply-2", "item-2");
        store
            .commit_conversation(&conversation, &[next], &[])
            .unwrap();
        assert!(present(&store, &conversation.id).unread);
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
    fn news_survives_a_rewind() {
        let db = Database::new();
        let store = db.open();
        let workspace = store
            .workspace_open(&test_root(&new_id("news")), None)
            .unwrap();
        let conversation = store.create_conversation(&workspace.id, "Talk").unwrap();
        let unread = |store: &Store| {
            let mut listed = store.conversation(&conversation.id).unwrap();
            store.present_conversation(&mut listed).unwrap();
            listed.unread
        };
        for id in ["a1", "a2"] {
            let reply = assistant(&conversation, id, id);
            store
                .commit_conversation(&conversation, &[reply], &[])
                .unwrap();
        }
        assert!(store.mark_seen(&conversation.id, None).unwrap());
        // A rewind drops the second reply; the next reply reuses its
        // sequence and is news again.
        store
            .connection
            .execute(
                "DELETE FROM messages WHERE conversation_id=?1 AND sequence>=2",
                [&conversation.id],
            )
            .unwrap();
        recount_news(&store.connection, &conversation.id).unwrap();
        assert!(!unread(&store));
        let again = assistant(&conversation, "a3", "a3");
        store
            .commit_conversation(&conversation, &[again], &[])
            .unwrap();
        assert!(unread(&store));
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
