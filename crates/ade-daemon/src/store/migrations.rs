use super::*;

/// The profile database schema this build creates and reads. Nothing upgrades
/// an older database until ADE launches (decision D19): a database at any
/// other version is refused, and the person deletes it to start again.
pub const SCHEMA_VERSION: i64 = 21;

/// The whole profile schema, created in one transaction for a new database.
/// Stores that create their own tables on first use (drafts, activity,
/// runtime recovery, receipts and others) add them with `IF NOT EXISTS`.
const SCHEMA: &str = "
    CREATE TABLE repositories(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, repository_id TEXT REFERENCES repositories(id), root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), provider_item_id TEXT, sequence INTEGER NOT NULL CHECK(sequence>0), data TEXT NOT NULL, UNIQUE(conversation_id,sequence), UNIQUE(conversation_id,provider_item_id));
    CREATE TABLE requests(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE drafts(conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(conversation_id,window_id));
    CREATE TABLE queued_prompts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','submitted','cancelled')), attachments TEXT NOT NULL DEFAULT '[]', review_feedback TEXT);
    CREATE INDEX queued_conversations ON queued_prompts(status,conversation_id);
    CREATE TABLE attachments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), metadata TEXT NOT NULL, data BLOB NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','discarded')), created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE services(workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id,name));
    CREATE TABLE service_ports(workspace_id TEXT NOT NULL, name TEXT NOT NULL, variable TEXT NOT NULL, port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1024 AND 65535), PRIMARY KEY(workspace_id,name,variable), FOREIGN KEY(workspace_id,name) REFERENCES services(workspace_id,name) ON DELETE CASCADE);
    CREATE TABLE send_intents(request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, draft_revision INTEGER NOT NULL CHECK(draft_revision>0), draft_text TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','rejected','aborted','completed')), restore_hold INTEGER NOT NULL DEFAULT 0 CHECK(restore_hold IN (0,1)));
    CREATE UNIQUE INDEX pending_send_owner ON send_intents(conversation_id,window_id) WHERE state IN ('pending','rejected');
    CREATE TABLE accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE restore_fence(id INTEGER PRIMARY KEY CHECK(id=1), worktree_lifecycle_needs_rebind INTEGER NOT NULL CHECK(worktree_lifecycle_needs_rebind IN (0,1)), restored_from_backup INTEGER NOT NULL CHECK(restored_from_backup IN (0,1)));
    INSERT INTO restore_fence VALUES(1,0,0);
    CREATE TABLE path_bindings(kind TEXT NOT NULL CHECK(kind IN ('workspace','repository')), id TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL, source_device TEXT, source_inode TEXT, PRIMARY KEY(kind,id));
    CREATE TABLE terminals(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL);
    CREATE INDEX terminals_by_workspace ON terminals(workspace_id);
    CREATE TABLE windows(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), state TEXT NOT NULL CHECK(state IN ('open','closed')), data TEXT NOT NULL);
    CREATE TABLE layouts(window_id TEXT NOT NULL REFERENCES windows(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL, last_action TEXT, PRIMARY KEY(window_id,workspace_id));
    CREATE INDEX layouts_by_workspace ON layouts(workspace_id);
    CREATE TABLE conversation_seen(conversation_id TEXT PRIMARY KEY, seen_sequence INTEGER NOT NULL);
    CREATE TABLE conversation_news(conversation_id TEXT PRIMARY KEY, news_sequence INTEGER NOT NULL);
    CREATE TABLE profile_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE workspace_worktree_operations(operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX workspace_worktree_operations_running ON workspace_worktree_operations(status);
";

#[cfg(test)]
fn creation_interruption_checkpoint() {
    let Some(marker) = std::env::var_os("ADE_STORE_CREATION_TEST_CHECKPOINT") else {
        return;
    };
    std::fs::write(marker, b"creation-uncommitted").unwrap();
    loop {
        std::thread::park();
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        let data_directory = parent.canonicalize()?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            version == 0 || version == SCHEMA_VERSION,
            "The profile database {} has schema version {version}; this build reads only schema {SCHEMA_VERSION} and does not upgrade older databases before launch. Delete the database to start this profile again",
            path.display()
        );
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        if version == 0 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch(SCHEMA)?;
            tx.execute_batch(TOMBSTONES)?;
            tx.execute_batch(WORKSPACE_TOMBSTONES)?;
            crate::receipts::ensure(&tx)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            // Test-only checkpoint permits a real process kill after the DDL,
            // before its transaction commits. Production builds have no hook.
            #[cfg(test)]
            creation_interruption_checkpoint();
            tx.commit()?;
        }
        Ok(Self {
            connection,
            data_directory,
            live_terminals: Default::default(),
            default_workspace: None,
        })
    }
}
