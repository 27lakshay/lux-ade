use super::*;

#[cfg(test)]
fn migration_interruption_checkpoint() {
    let Some(marker) = std::env::var_os("ADE_STORE_MIGRATION_TEST_CHECKPOINT") else {
        return;
    };
    std::fs::write(marker, b"migration-six-uncommitted").unwrap();
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
            (0..=17).contains(&version),
            "Unsupported database version {version}; preserve the database and use a compatible build"
        );
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        if version == 0 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("
                CREATE TABLE repositories(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
                CREATE TABLE workspaces(id TEXT PRIMARY KEY,repository_id TEXT REFERENCES repositories(id),root TEXT NOT NULL UNIQUE,terminal_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
                CREATE TABLE conversations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),data TEXT NOT NULL);
                CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),provider_item_id TEXT,sequence INTEGER NOT NULL CHECK(sequence>0),data TEXT NOT NULL,UNIQUE(conversation_id,sequence),UNIQUE(conversation_id,provider_item_id));
                CREATE TABLE requests(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),status TEXT NOT NULL,data TEXT NOT NULL);
                CREATE TABLE windows(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),conversation_id TEXT REFERENCES conversations(id),data TEXT NOT NULL);
                PRAGMA user_version=1;
            ")?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let conversations: Vec<Conversation> =
                all(&tx, "SELECT data FROM conversations ORDER BY rowid")?;
            for conversation in conversations {
                conversation
                    .provider_config
                    .validate(&conversation.provider)?;
                write_conversation(&tx, &conversation)?;
            }
            tx.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); PRAGMA user_version=2;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(2,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("PRAGMA user_version=3;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(3,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE drafts(conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), text TEXT NOT NULL, PRIMARY KEY(conversation_id,window_id)); PRAGMA user_version=4;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(4,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE queued_prompts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','submitted','cancelled'))); CREATE INDEX queued_conversations ON queued_prompts(status,conversation_id); PRAGMA user_version=5;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(5,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 6 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE attachments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), metadata TEXT NOT NULL, data BLOB NOT NULL); ALTER TABLE drafts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'; ALTER TABLE queued_prompts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=6;")?;
            // Test-only checkpoint permits a real process kill after migration DDL,
            // before its transaction commits. Production builds have no hook.
            #[cfg(test)]
            migration_interruption_checkpoint();
            tx.execute("INSERT INTO schema_migrations VALUES(6,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 7 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE services(workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id,name)); CREATE TABLE service_ports(workspace_id TEXT NOT NULL, name TEXT NOT NULL, variable TEXT NOT NULL, port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1024 AND 65535), PRIMARY KEY(workspace_id,name,variable), FOREIGN KEY(workspace_id,name) REFERENCES services(workspace_id,name) ON DELETE CASCADE); PRAGMA user_version=7;")?;
            tx.execute("INSERT INTO schema_migrations VALUES(7,?1)", [now_ms()])?;
            tx.commit()?;
        }
        if version < 8 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS send_intents(request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), window_id TEXT NOT NULL, draft_revision INTEGER NOT NULL CHECK(draft_revision>0), draft_text TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','rejected','aborted','completed'))); CREATE UNIQUE INDEX IF NOT EXISTS pending_send_owner ON send_intents(conversation_id,window_id) WHERE state IN ('pending','rejected'); PRAGMA user_version=8;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(8,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 9 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=9;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(9,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 10 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let rows = {
                let mut statement = tx.prepare("SELECT workspace_id,name,data FROM services")?;
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (workspace, name, data) in rows {
                let mut service: ade_core::services::Service = serde_json::from_str(&data)?;
                if service.identity.is_empty() {
                    service.identity = crate::model::new_id("service");
                    tx.execute(
                        "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2",
                        params![workspace, name, serde_json::to_string(&service)?],
                    )?;
                }
            }
            tx.execute_batch("PRAGMA user_version=10;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(10,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 11 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("ALTER TABLE attachments ADD COLUMN generation TEXT NOT NULL DEFAULT ''; ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','discarded')); ALTER TABLE attachments ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;")?;
            tx.execute(
                "UPDATE attachments SET generation=lower(hex(randomblob(16)))",
                [],
            )?;
            tx.execute_batch("PRAGMA user_version=11;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(11,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 12 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_send_hold = tx
                .prepare("PRAGMA table_info(send_intents)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "restore_hold");
            if !has_send_hold {
                tx.execute_batch("ALTER TABLE send_intents ADD COLUMN restore_hold INTEGER NOT NULL DEFAULT 0 CHECK(restore_hold IN (0,1));")?;
            }
            tx.execute_batch("CREATE TABLE IF NOT EXISTS restore_fence(id INTEGER PRIMARY KEY CHECK(id=1), worktree_lifecycle_needs_rebind INTEGER NOT NULL CHECK(worktree_lifecycle_needs_rebind IN (0,1)), restored_from_backup INTEGER NOT NULL CHECK(restored_from_backup IN (0,1))); INSERT OR IGNORE INTO restore_fence VALUES(1,0,0); PRAGMA user_version=12;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(12,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 13 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS path_bindings(kind TEXT NOT NULL CHECK(kind IN ('workspace','repository')), id TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL, source_device TEXT, source_inode TEXT, PRIMARY KEY(kind,id));")?;
            let repositories: Vec<Repository> = all(&tx, "SELECT data FROM repositories")?;
            for mut repository in repositories {
                if repository.needs_rebind {
                    continue;
                }
                if std::fs::metadata(&repository.root).is_ok_and(|item| item.is_dir()) {
                    write_binding(&tx, "repository", &repository.id, &repository.root)?;
                } else {
                    repository.needs_rebind = true;
                    tx.execute(
                        "UPDATE repositories SET data=?2 WHERE id=?1",
                        params![repository.id, encode(&repository)?],
                    )?;
                }
            }
            let workspaces: Vec<WorkspaceRecord> = all(&tx, "SELECT data FROM workspaces")?;
            for mut workspace in workspaces {
                if workspace.needs_rebind {
                    continue;
                }
                if std::fs::metadata(&workspace.root).is_ok_and(|item| item.is_dir()) {
                    write_binding(&tx, "workspace", &workspace.id, &workspace.root)?;
                } else {
                    workspace.needs_rebind = true;
                    tx.execute(
                        "UPDATE workspaces SET data=?2 WHERE id=?1",
                        params![workspace.id, encode(&workspace)?],
                    )?;
                }
            }
            tx.execute_batch("PRAGMA user_version=13;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(13,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 14 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_source = tx
                .prepare("PRAGMA table_info(path_bindings)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "source_device");
            if !has_source {
                tx.execute_batch("ALTER TABLE path_bindings ADD COLUMN source_device TEXT; ALTER TABLE path_bindings ADD COLUMN source_inode TEXT;")?;
            }
            // A previously restored schema-13 profile may already have rebound.
            // Its original source cannot be reconstructed from the current row.
            tx.execute("UPDATE path_bindings SET source_device=device,source_inode=inode WHERE (SELECT restored_from_backup FROM restore_fence WHERE id=1)=0", [])?;
            tx.execute_batch("PRAGMA user_version=14;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(14,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 15 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            let has_anchor = tx
                .prepare("PRAGMA table_info(send_intents)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "review_anchor");
            if !has_anchor {
                tx.execute_batch("ALTER TABLE send_intents ADD COLUMN review_anchor TEXT;")?;
            }
            tx.execute_batch("PRAGMA user_version=15;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(15,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 16 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS terminal_creations(request_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, terminal_id TEXT NOT NULL); PRAGMA user_version=16;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(16,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        if version < 17 {
            let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)?;
            crate::receipts::ensure(&tx)?;
            tx.execute_batch("PRAGMA user_version=17;")?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_migrations VALUES(17,?1)",
                [now_ms()],
            )?;
            tx.commit()?;
        }
        ensure!(
            connection.query_row(
                "SELECT COUNT(*) FROM restore_fence WHERE id=1 AND restored_from_backup IN (0,1)",
                [],
                |row| row.get::<_, i64>(0)
            )? == 1,
            "Schema-12 restore fence is missing; preserve this profile and use a compatible build"
        );
        // Every read that lists Conversations filters on the tombstones.
        connection.execute_batch(TOMBSTONES)?;
        Ok(Self {
            connection,
            data_directory,
        })
    }
}
