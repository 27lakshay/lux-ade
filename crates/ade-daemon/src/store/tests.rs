use super::*;
use ade_core::contract::layout::{LayoutAction, Tab, TabTarget, WindowState};
use ade_core::model::ProjectKind;
#[test]
fn queue_consumption_is_atomic_ordered_and_not_replayed_after_restart() {
    let db = Database::new();
    let store = db.open();
    let (_, mut c) = fixture(&store);
    store.enqueue(&c.id, "first", "First").unwrap();
    store.enqueue(&c.id, "second", "Second").unwrap();
    assert!(store.begin_queued_turn(&c.id, "second", "Second").is_err());
    c.queue_paused = true;
    store.commit_conversation(&c, &[], &[]).unwrap();
    assert!(store.queue_heads().unwrap().is_empty());
    assert!(store.begin_queued_turn(&c.id, "first", "First").is_err());
    c.queue_paused = false;
    store.commit_conversation(&c, &[], &[]).unwrap();
    store.begin_queued_turn(&c.id, "first", "First").unwrap();
    assert_eq!(store.queued(&c.id).unwrap()[0].id, "second");
    drop(store);
    let store = db.open();
    assert!(store.message("first").unwrap().is_some());
    assert!(store.queue_heads().unwrap().is_empty());
    store.enqueue(&c.id, "first", "First").unwrap();
    assert_eq!(store.queued(&c.id).unwrap().len(), 1);
    store.cancel_queued(&c.id, "second").unwrap();
    store.enqueue(&c.id, "second", "Second").unwrap();
    assert!(store.queued(&c.id).unwrap().is_empty());
    assert!(store.begin_turn(&c.id, "second", "Second").is_err());
    assert!(store.cancel_queued(&c.id, "first").is_err());
}
#[test]
fn drafts_are_scoped_durable_and_ignore_late_writes() {
    let db = Database::new();
    let store = db.open();
    let (workspace, first) = fixture(&store);
    let second = store
        .create_with_provider(&workspace.id, "Second", "codex", Default::default())
        .unwrap();
    store
        .save_draft(
            &first.id,
            "window-a",
            &Draft {
                context_nodes: Vec::new(),
                attachments: vec![],
                text: "First draft".into(),
                revision: 2,
            },
        )
        .unwrap();
    store
        .save_draft(
            &first.id,
            "window-a",
            &Draft {
                context_nodes: Vec::new(),
                attachments: vec![],
                text: "late stale draft".into(),
                revision: 1,
            },
        )
        .unwrap();
    store
        .save_draft(
            &first.id,
            "window-b",
            &Draft {
                context_nodes: Vec::new(),
                attachments: vec![],
                text: "Independent draft".into(),
                revision: 1,
            },
        )
        .unwrap();
    assert!(store.draft(&second.id, "window-a").unwrap().text.is_empty());
    drop(store);
    let store = db.open();
    assert_eq!(
        store.draft(&first.id, "window-a").unwrap().text,
        "First draft"
    );
    assert_eq!(
        store.draft(&first.id, "window-b").unwrap().text,
        "Independent draft"
    );
    store
        .save_draft(
            &first.id,
            "window-a",
            &Draft {
                context_nodes: Vec::new(),
                attachments: vec![],
                text: String::new(),
                revision: 3,
            },
        )
        .unwrap();
    store
        .save_draft(
            &first.id,
            "window-a",
            &Draft {
                context_nodes: Vec::new(),
                attachments: vec![],
                text: "stale retry".into(),
                revision: 2,
            },
        )
        .unwrap();
    assert!(store.draft(&first.id, "window-a").unwrap().text.is_empty());
}
#[test]
fn pristine_draft_is_read_only_and_revisioned_empty_save_still_clears() {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    let pristine = store.draft(&conversation.id, "window").unwrap();
    assert_eq!(pristine.revision, 0);
    assert!(pristine.text.is_empty());
    assert!(
        store
            .save_draft(&conversation.id, "window", &pristine)
            .is_err()
    );
    store
        .save_draft(
            &conversation.id,
            "window",
            &Draft {
                context_nodes: Vec::new(),
                text: "saved text".into(),
                revision: 1,
                attachments: vec![],
            },
        )
        .unwrap();
    assert!(
        store
            .save_draft(&conversation.id, "window", &pristine)
            .is_err()
    );
    assert_eq!(
        store.draft(&conversation.id, "window").unwrap().text,
        "saved text"
    );
    store
        .save_draft(
            &conversation.id,
            "window",
            &Draft {
                context_nodes: Vec::new(),
                text: String::new(),
                revision: 2,
                attachments: vec![],
            },
        )
        .unwrap();
    let cleared = store.draft(&conversation.id, "window").unwrap();
    assert!(cleared.text.is_empty());
    assert_eq!(cleared.revision, 2);
}
#[test]
fn draft_resolution_rejects_intervening_writer_and_preserves_text() {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    let draft = |text: &str, revision| Draft {
        context_nodes: Vec::new(),
        text: text.into(),
        revision,
        attachments: vec![],
    };
    store
        .save_draft(&conversation.id, "window", &draft("third writer", 8))
        .unwrap();
    let stale = store
        .resolve_draft(&conversation.id, "window", &draft("chosen local", 9), 7)
        .unwrap();
    assert_eq!(stale.text, "third writer");
    assert_eq!(stale.revision, 8);
    let resolved = store
        .resolve_draft(&conversation.id, "window", &draft("chosen local", 9), 8)
        .unwrap();
    assert_eq!(resolved.text, "chosen local");
    assert_eq!(resolved.revision, 9);
}
pub(super) struct Database {
    directory: std::path::PathBuf,
}
impl Database {
    pub(super) fn new() -> Self {
        Self {
            directory: std::env::temp_dir().join(new_id("ade-store-test")),
        }
    }
    fn path(&self) -> std::path::PathBuf {
        self.directory.join("state.sqlite")
    }
    pub(super) fn open(&self) -> Store {
        Store::open(&self.path()).unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
// Workspace roots must exist: opening a missing directory fails closed.
pub(super) fn test_root(name: &str) -> String {
    let root = std::env::temp_dir().join("ade-store-test-roots").join(name);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::canonicalize(root)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}
#[test]
fn new_submission_identity_is_durable_with_its_prompt() {
    let db = Database::new();
    let store = db.open();
    let (_, mut c) = fixture(&store);
    c.runtime_run = Some("existing-run".into());
    c.runtime_submission = Some("old-submission".into());
    c.status = "ready".into();
    store.commit_conversation(&c, &[], &[]).unwrap();
    store
        .begin_turn(&c.id, "new-submission", "new prompt")
        .unwrap();
    drop(store); // daemon dies before any subsequent transaction or send
    let recovered = db.open().conversation(&c.id).unwrap();
    assert_eq!(
        recovered.runtime_submission.as_deref(),
        Some("new-submission")
    );
    assert_eq!(recovered.runtime_run.as_deref(), Some("existing-run"));
    assert_eq!(recovered.status, "starting");
}
#[test]
fn event_cursor_and_projection_commit_or_rollback_together() {
    let db = Database::new();
    let store = db.open();
    let (_, mut c) = fixture(&store);
    c.runtime_run = Some("run".into());
    c.runtime_cursor = 1;
    let message = assistant(&c, "event-message", "provider-item");
    store
        .commit_conversation(&c, std::slice::from_ref(&message), &[])
        .unwrap();
    c.runtime_cursor = 2;
    let mut invalid = message;
    invalid.conversation_id = "another-conversation".into();
    assert!(store.commit_conversation(&c, &[invalid], &[]).is_err());
    drop(store);
    let reopened = db.open();
    assert_eq!(reopened.conversation(&c.id).unwrap().runtime_cursor, 1);
    assert_eq!(
        reopened.message("event-message").unwrap().unwrap().text,
        "hello"
    );
}
fn fixture(store: &Store) -> (WorkspaceRecord, Conversation) {
    let workspace = store
        .workspace_open(&test_root("project"), Some(&test_root("project")))
        .unwrap();
    let conversation = store.create_conversation(&workspace.id, "Test").unwrap();
    (workspace, conversation)
}
#[test]
fn structured_plan_updates_survive_reopen_and_reject_invalid_content() {
    use crate::transcript::{Content, PlanStep, StepStatus};
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    let mut message = assistant(&conversation, "plan-message", "turn:plan");
    message.kind = "plan".into();
    message.content = Some(Content::Plan {
        explanation: None,
        steps: vec![PlanStep {
            step: "Inspect".into(),
            status: StepStatus::InProgress,
        }],
    });
    store
        .commit_conversation(&conversation, &[message.clone()], &[])
        .unwrap();
    let sequence = store.message(&message.id).unwrap().unwrap().sequence;
    message.content = Some(Content::Plan {
        explanation: None,
        steps: vec![PlanStep {
            step: "Inspect".into(),
            status: StepStatus::Completed,
        }],
    });
    store
        .commit_conversation(&conversation, &[message.clone()], &[])
        .unwrap();
    drop(store);
    let store = db.open();
    let restored = store.message(&message.id).unwrap().unwrap();
    assert_eq!(restored.content, message.content);
    assert_eq!(restored.sequence, sequence);
    message.content = Some(Content::Plan {
        explanation: None,
        steps: vec![PlanStep {
            step: String::new(),
            status: StepStatus::Pending,
        }],
    });
    assert!(
        store
            .commit_conversation(&conversation, &[message], &[])
            .is_err()
    );
    assert_eq!(
        store.message("plan-message").unwrap().unwrap().content,
        restored.content
    );
}
pub(super) fn assistant(conversation: &Conversation, id: &str, provider: &str) -> Message {
    Message {
        content: None,
        review_feedback: None,
        attachments: vec![],
        id: id.into(),
        conversation_id: conversation.id.clone(),
        role: "assistant".into(),
        kind: "text".into(),
        text: "hello".into(),
        status: "completed".into(),
        turn_id: Some("turn-1".into()),
        provider_item_id: Some(provider.into()),
        sequence: 0,
    }
}
fn open_tab(id: &str, target: TabTarget) -> LayoutAction {
    LayoutAction::OpenTab {
        tab: Tab {
            id: id.into(),
            target,
        },
        pane_id: None,
    }
}
#[test]
fn layouts_persist_with_their_revision_and_refuse_a_stale_one() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    store.create_window("w", &workspace.id, None).unwrap();
    let fresh = store.layout("w", None).unwrap();
    assert_eq!(fresh.revision, 0);
    let target = TabTarget::Conversation {
        id: conversation.id.clone(),
    };
    let opened = store
        .apply_layout("w", None, &open_tab("t1", target), Some(0))
        .unwrap();
    assert!(opened.changed);
    assert_eq!(opened.layout.revision, 1);
    let toggle = LayoutAction::SetSideCollapsed {
        side: ade_core::contract::layout::Side::Left,
        collapsed: true,
    };
    let toggled = store.apply_layout("w", None, &toggle, Some(1)).unwrap();
    assert_eq!(toggled.layout.revision, 2);
    // The retry of the last action from its revision returns its result.
    let retried = store.apply_layout("w", None, &toggle, Some(1)).unwrap();
    assert_eq!(retried.layout, toggled.layout);
    // Without a revision, setting the same state again changes nothing.
    let again = store.apply_layout("w", None, &toggle, None).unwrap();
    assert!(!again.changed);
    assert_eq!(again.layout, toggled.layout);
    // Moving a pane needs a revision.
    let swap = LayoutAction::SwapPanes {
        pane_id: "pane-main".into(),
        target_id: "pane-main".into(),
    };
    let refused = store.apply_layout("w", None, &swap, None).unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(refused)["code"],
        "invalid_layout"
    );
    // Any other stale revision is a conflict.
    let stale = store
        .apply_layout(
            "w",
            None,
            &LayoutAction::SetSidebarSides {
                left: ade_core::contract::layout::SidebarId::Inspector,
            },
            Some(1),
        )
        .unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(stale)["code"],
        "layout_conflict"
    );
    let missing = store
        .apply_layout(
            "w",
            None,
            &open_tab(
                "t2",
                TabTarget::Terminal {
                    id: "terminal_missing".into(),
                },
            ),
            None,
        )
        .unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(missing)["code"],
        "tab_target_missing"
    );
    drop(store);
    let store = db.open();
    assert_eq!(store.layout("w", None).unwrap(), toggled.layout);
    let unknown = store.layout("nowhere", None).unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(unknown)["code"],
        "window_not_found"
    );
}
#[test]
fn deleting_a_conversation_closes_its_tabs_in_every_layout() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    let target = TabTarget::Conversation {
        id: conversation.id.clone(),
    };
    for window in ["a", "b"] {
        store.create_window(window, &workspace.id, None).unwrap();
        store
            .apply_layout(window, None, &open_tab("t", target.clone()), None)
            .unwrap();
    }
    let tx = store.connection.unchecked_transaction().unwrap();
    let deleted = delete_conversation(&tx, &conversation.id, "op", 1).unwrap();
    tx.commit().unwrap();
    assert_eq!(deleted.removed.layouts_changed, 2);
    assert_eq!(deleted.layouts.len(), 2);
    for window in ["a", "b"] {
        let layout = store.layout(window, None).unwrap();
        assert!(layout.layout.tabs.is_empty());
        assert_eq!(layout.revision, 2);
    }
}
#[test]
fn removing_a_workspace_deletes_its_layouts_and_moves_its_windows() {
    let db = Database::new();
    let store = db.open();
    let removed = store
        .workspace_open(&test_root(&new_id("zulu")), None)
        .unwrap();
    let beta = store
        .workspace_open(&test_root(&new_id("beta")), None)
        .unwrap();
    let alpha = store
        .workspace_open(&test_root(&new_id("alpha")), None)
        .unwrap();
    store.create_window("w", &removed.id, None).unwrap();
    store.show_workspace("w", &beta.id).unwrap();
    store.show_workspace("w", &removed.id).unwrap();
    store
        .apply_layout(
            "w",
            None,
            &LayoutAction::SetSidebarSides {
                left: ade_core::contract::layout::SidebarId::Inspector,
            },
            None,
        )
        .unwrap();
    let removal = store.remove_workspace(&removed.id, "op").unwrap().unwrap();
    assert_eq!(removal.layouts, vec![("w".to_owned(), removed.id.clone())]);
    // The first remaining workspace by project and name: alpha.
    let window = &store.windows().unwrap()[0];
    assert_eq!(window.workspace_id, alpha.id);
    assert_eq!(
        window.view.recent_workspaces,
        vec![alpha.id.clone(), beta.id.clone()]
    );
    assert_eq!(removal.windows, vec![window.clone()]);
    let gone = store.layout("w", Some(&removed.id)).unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(gone)["code"],
        "workspace_removed"
    );
    // Reopening the folder starts that workspace's layout afresh.
    store.workspace_open(&removed.root, None).unwrap();
    assert_eq!(store.layout("w", Some(&removed.id)).unwrap().revision, 0);
}
#[test]
fn a_window_whose_last_workspace_is_removed_closes() {
    let db = Database::new();
    let store = db.open();
    let only = store
        .workspace_open(&test_root(&new_id("only")), None)
        .unwrap();
    store.create_window("w", &only.id, None).unwrap();
    store.remove_workspace(&only.id, "op").unwrap().unwrap();
    let window = &store.windows().unwrap()[0];
    assert_eq!(window.state, WindowState::Closed);
    assert_eq!(window.workspace_id, only.id);
    let refused = store.set_window_state("w", WindowState::Open).unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(refused)["code"],
        "workspace_removed"
    );
}
#[test]
fn reopen_retains_identity_history_resume_and_windows() {
    let db = Database::new();
    let store = db.open();
    let (workspace, mut conversation) = fixture(&store);
    let primary = store.primary_terminal(&workspace.id).unwrap();
    let original = store
        .begin_turn(&conversation.id, "submission-1", "prompt")
        .unwrap();
    conversation.status = "idle".into();
    conversation.provider_thread_id = Some("provider-thread".into());
    store
        .commit_conversation(
            &conversation,
            &[assistant(&conversation, "answer", "provider-item")],
            &[],
        )
        .unwrap();
    store
        .create_window("window-1", &workspace.id, None)
        .unwrap();
    store
        .create_window("window-2", &workspace.id, None)
        .unwrap();
    store
        .set_window_state("window-2", WindowState::Closed)
        .unwrap();
    drop(store);
    let store = db.open();
    let reopened = store
        .workspace_open(&test_root("project"), Some(&test_root("project")))
        .unwrap();
    assert_eq!(workspace.id, reopened.id);
    assert_eq!(workspace.project_id, reopened.project_id);
    assert_eq!(primary, store.primary_terminal(&reopened.id).unwrap());
    assert_eq!(
        store
            .conversation(&conversation.id)
            .unwrap()
            .provider_thread_id
            .as_deref(),
        Some("provider-thread")
    );
    let messages = store.messages(&conversation.id, None, 200).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, original.message.id);
    let windows = store.catalog().unwrap().windows;
    assert_eq!(windows[0].id, "window-1");
    assert_eq!(windows[1].state, WindowState::Closed);
}
#[test]
fn recovery_invalidates_requests_but_keeps_resume_and_submission() {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    let mut conversation = store
        .begin_turn(&conversation.id, "submission", "prompt")
        .unwrap()
        .conversation;
    conversation.status = "waiting".into();
    conversation.provider_thread_id = Some("thread".into());
    conversation.active_turn_id = Some("turn".into());
    let request = PendingRequest {
        id: "permission".into(),
        conversation_id: conversation.id.clone(),
        run_id: "run".into(),
        rpc_id: serde_json::json!({"opaque":[1,"a"]}),
        method: "approval".into(),
        params: serde_json::json!({"command":"test"}),
        status: "pending".into(),
        answer_fingerprint: None,
        answer_dispatched: false,
        answer_attempt: 0,
    };
    store
        .commit_conversation(&conversation, &[], std::slice::from_ref(&request))
        .unwrap();
    drop(store);
    let store = db.open();
    store.recover_interrupted().unwrap();
    let recovered = store.conversation(&conversation.id).unwrap();
    assert_eq!(recovered.status, "interrupted");
    assert!(recovered.error.is_some());
    assert!(recovered.active_turn_id.is_none());
    assert_eq!(
        recovered.provider_thread_id,
        conversation.provider_thread_id
    );
    assert!(store.pending(&conversation.id).unwrap().is_empty());
    assert!(
        store
            .begin_turn(&conversation.id, "submission", "prompt")
            .unwrap()
            .duplicate
    );
    assert!(
        store
            .commit_conversation(&recovered, &[], &[request])
            .is_err()
    );
    assert!(
        !store
            .begin_turn(&conversation.id, "new-submission", "new prompt")
            .unwrap()
            .duplicate
    );
}
#[test]
fn submissions_are_idempotent_even_while_busy_and_reject_key_reuse() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    store
        .begin_turn(&conversation.id, "request", "prompt")
        .unwrap();
    assert!(
        store
            .begin_turn(&conversation.id, "request", "prompt")
            .unwrap()
            .duplicate
    );
    assert!(
        store
            .begin_turn(&conversation.id, "request", "different")
            .is_err()
    );
    assert!(store.begin_turn(&conversation.id, "next", "next").is_err());
    let other = store.create_conversation(&workspace.id, "other").unwrap();
    assert!(store.begin_turn(&other.id, "request", "prompt").is_err());
    assert_eq!(store.conversation(&other.id).unwrap().status, "idle");
    assert!(
        store
            .begin_turn(&other.id, "huge", &"a".repeat(TEXT_LIMIT + 1))
            .is_err()
    );
    assert_eq!(
        store.messages(&conversation.id, None, 200).unwrap().len(),
        1
    );
}
#[test]
fn transaction_rejects_cross_conversation_writes_without_partial_changes() {
    let db = Database::new();
    let store = db.open();
    let (workspace, mut conversation) = fixture(&store);
    let other = store.create_conversation(&workspace.id, "other").unwrap();
    let first = assistant(&conversation, "m1", "p1");
    store
        .commit_conversation(&conversation, std::slice::from_ref(&first), &[])
        .unwrap();
    conversation.title = "must roll back".into();
    let wrong = assistant(&other, "m2", "p2");
    assert!(
        store
            .commit_conversation(
                &conversation,
                &[assistant(&conversation, "m3", "p3"), wrong],
                &[]
            )
            .is_err()
    );
    assert_eq!(store.conversation(&conversation.id).unwrap().title, "Test");
    assert_eq!(
        store.messages(&conversation.id, None, 200).unwrap().len(),
        1
    );
    let mut stolen = first;
    stolen.conversation_id = other.id.clone();
    assert!(store.commit_conversation(&other, &[stolen], &[]).is_err());
}
#[test]
fn provider_replay_retains_message_identity_and_sequence_with_bounded_pages() {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    let messages: Vec<_> = (0..205)
        .map(|i| assistant(&conversation, &format!("m{i}"), &format!("p{i}")))
        .collect();
    store
        .commit_conversation(&conversation, &messages, &[])
        .unwrap();
    let mut replay = assistant(&conversation, "different-id", "p0");
    replay.text = "final".into();
    store
        .commit_conversation(&conversation, &[replay], &[])
        .unwrap();
    let page = store.messages(&conversation.id, None, usize::MAX).unwrap();
    assert_eq!(page.len(), 200);
    assert_eq!(page[0].sequence, 6);
    assert_eq!(page.last().unwrap().sequence, 205);
    let old = store
        .messages(&conversation.id, Some(page[0].sequence), 200)
        .unwrap();
    assert_eq!(old.len(), 5);
    assert_eq!(old[0].id, "m0");
    assert_eq!(old[0].text, "final");
    assert_eq!(old[0].sequence, 1);
    assert!(store.message("different-id").unwrap().is_none());
    assert!(
        store
            .messages(&conversation.id, None, 0)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn another_schema_version_is_refused_untouched_with_the_delete_instruction() {
    for version in [1, SCHEMA_VERSION - 1, SCHEMA_VERSION + 1] {
        let db = Database::new();
        std::fs::create_dir_all(&db.directory).unwrap();
        let connection = Connection::open(db.path()).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE payload(id INTEGER PRIMARY KEY, value BLOB);
                INSERT INTO payload VALUES(1, X'0001FF'); PRAGMA user_version={version};"
            ))
            .unwrap();
        drop(connection);
        let before = std::fs::read(db.path()).unwrap();
        let failure = Store::open(&db.path())
            .err()
            .expect("another schema must fail")
            .to_string();
        assert!(
            failure.contains(&format!("has schema version {version}"))
                && failure.contains("Delete the database"),
            "{failure}"
        );
        assert_eq!(std::fs::read(db.path()).unwrap(), before);
        assert!(!db.path().with_extension("sqlite-wal").exists());
        assert!(!db.path().with_extension("sqlite-shm").exists());
        let connection = Connection::open(db.path()).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
    }
}

#[test]
fn a_new_database_gets_the_whole_schema_and_reopens() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    drop(store);
    let store = db.open();
    let version: i64 = store
        .connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let fence: (i64, i64) = store
        .connection
        .query_row(
            "SELECT worktree_lifecycle_needs_rebind,restored_from_backup FROM restore_fence WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(fence, (0, 0));
    assert_eq!(store.workspace(&workspace.id).unwrap().root, workspace.root);
    assert_eq!(
        store.conversation(&conversation.id).unwrap().title,
        conversation.title
    );
}

#[test]
#[ignore = "subprocess entry point used by the creation kill regression"]
fn creation_interruption_child() {
    let path = std::env::var_os("ADE_STORE_CREATION_TEST_DB").expect("test DB path");
    Store::open(Path::new(&path)).unwrap();
    panic!("creation unexpectedly completed instead of reaching checkpoint");
}

#[test]
fn a_killed_creation_leaves_no_schema_and_the_next_start_creates_it() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let db = Database::new();
    std::fs::create_dir_all(&db.directory).unwrap();
    let marker = db.directory.join("creation-checkpoint");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::tests::creation_interruption_child",
            "--ignored",
            "--nocapture",
        ])
        .env("ADE_STORE_CREATION_TEST_DB", db.path())
        .env("ADE_STORE_CREATION_TEST_CHECKPOINT", &marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Always reap the child, including assertion failures, so test timeouts
    // never leave a writer holding the fixture database open.
    let reached = marker.exists();
    let _ = child.kill();
    let status = child.wait().unwrap();
    assert!(reached, "child did not reach the uncommitted creation");
    assert!(!status.success());
    let connection = Connection::open(db.path()).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let tables: i64 = connection
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tables, 0);
    drop(connection);
    let store = db.open();
    fixture(&store);
}
#[test]
fn a_renamed_workspace_keeps_its_name_across_reopen_and_rejects_bad_names() {
    let db = Database::new();
    let store = db.open();
    let workspace = store
        .workspace_open(&test_root(&new_id("rename")), None)
        .unwrap();
    let renamed = store
        .rename_workspace(&workspace.id, "  Payments API  ")
        .unwrap();
    assert_eq!(renamed.name, "Payments API");
    assert_eq!(renamed.root, workspace.root);
    for bad in ["   ", &"x".repeat(101), "two\nlines"] {
        let error = store.rename_workspace(&workspace.id, bad).unwrap_err();
        assert_eq!(
            ade_core::error::error_envelope(error)["code"],
            "invalid_workspace_name"
        );
    }
    let missing = store
        .rename_workspace("workspace_missing", "Name")
        .unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(missing)["code"],
        "workspace_not_found"
    );
    drop(store);
    let store = db.open();
    assert_eq!(store.workspace(&workspace.id).unwrap().name, "Payments API");
    // Opening the folder again returns the stored name, not the folder's.
    assert_eq!(
        store.workspace_open(&workspace.root, None).unwrap().name,
        "Payments API"
    );
}
#[test]
fn a_removed_workspace_leaves_the_catalog_and_returns_with_its_conversations() {
    let db = Database::new();
    let store = db.open();
    let root = test_root(&new_id("remove"));
    let workspace = store.workspace_open(&root, None).unwrap();
    let mut busy = store.create_conversation(&workspace.id, "Busy").unwrap();
    busy.status = "running".into();
    store.commit_conversation(&busy, &[], &[]).unwrap();
    let blocked = store.remove_workspace(&workspace.id, "op-1").unwrap_err();
    let envelope = ade_core::error::error_envelope(blocked);
    assert_eq!(envelope["code"], "workspace_remove_blocked");
    assert_eq!(
        envelope["blockers"][0]["kind"], "conversation_running",
        "{envelope}"
    );
    assert!(!store.workspace_removed(&workspace.id).unwrap());

    busy.status = "idle".into();
    store.commit_conversation(&busy, &[], &[]).unwrap();
    store.enqueue(&busy.id, "queued", "Later").unwrap();
    assert!(
        store
            .remove_workspace(&workspace.id, "op-1")
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .remove_workspace(&workspace.id, "op-2")
            .unwrap()
            .is_none()
    );
    let catalog = store.catalog().unwrap();
    assert!(catalog.workspaces.iter().all(|w| w.id != workspace.id));
    assert!(catalog.conversations.iter().all(|c| c.id != busy.id));
    // The Conversation still names a real workspace, and its queue waits.
    assert_eq!(
        store.conversation(&busy.id).unwrap().workspace_id,
        workspace.id
    );
    assert!(store.queue_heads().unwrap().is_empty());
    let refused = store.ensure_workspace_bound(&workspace.id).unwrap_err();
    assert_eq!(
        ade_core::error::error_envelope(refused)["code"],
        "workspace_removed"
    );

    // Terminals retire once: the primary gets a fresh ID.
    let primary = store.primary_terminal(&workspace.id).unwrap();
    let extra = store.create_terminal(&workspace.id, None, None).unwrap();
    let retired = store.retire_removed_terminals(&workspace.id).unwrap();
    assert_eq!(retired, vec![primary.clone(), extra]);
    assert!(
        store
            .retire_removed_terminals(&workspace.id)
            .unwrap()
            .is_empty()
    );
    let replaced = store.primary_terminal(&workspace.id).unwrap();
    assert_ne!(replaced, primary);
    assert_eq!(
        store.workspace_terminals(&workspace.id).unwrap(),
        vec![replaced]
    );

    // The removal survives a restart; reopening restores the same identity.
    drop(store);
    let store = db.open();
    assert!(store.workspace_removed(&workspace.id).unwrap());
    let reopened = store.workspace_open(&root, None).unwrap();
    assert_eq!(reopened.id, workspace.id);
    let catalog = store.catalog().unwrap();
    assert!(catalog.workspaces.iter().any(|w| w.id == workspace.id));
    assert!(catalog.conversations.iter().any(|c| c.id == busy.id));
    assert_eq!(store.queue_heads().unwrap().len(), 1);
}
#[test]
fn a_removed_workspace_whose_folder_is_gone_does_not_fence_the_profile() {
    let db = Database::new();
    let store = db.open();
    let root = test_root(&new_id("gone"));
    std::fs::create_dir_all(format!("{root}/.git")).unwrap();
    let workspace = store
        .workspace_open(&root, Some(&format!("{root}/.git")))
        .unwrap();
    assert!(
        store
            .remove_workspace(&workspace.id, "op")
            .unwrap()
            .is_some()
    );
    std::fs::remove_dir_all(&root).unwrap();
    assert!(!store.has_pending_rebind().unwrap());
    assert!(store.rebind_workspaces().unwrap().is_empty());
    assert!(store.rebind_repositories().unwrap().is_empty());
    assert!(store.catalog().unwrap().projects.is_empty());
    let other = store
        .workspace_open(&test_root(&new_id("other")), None)
        .unwrap();
    assert!(!other.needs_rebind);
}
#[test]
fn the_catalog_names_each_repository_after_its_checkout_folder() {
    let db = Database::new();
    let store = db.open();
    // The on-disk layout `git worktree add` leaves: a main checkout whose
    // `.git` is the common directory, and a linked tree pointing into it.
    let project = new_id("project");
    let main = test_root(&project);
    let common = test_root(&format!("{project}/.git"));
    let linked = test_root(&new_id("linked"));
    let admin = test_root(&format!("{project}/.git/worktrees/linked"));
    std::fs::write(format!("{admin}/commondir"), "../..\n").unwrap();
    std::fs::write(format!("{linked}/.git"), format!("gitdir: {admin}\n")).unwrap();
    let first = store.workspace_open(&main, Some(&common)).unwrap();
    let second = store.workspace_open(&linked, Some(&common)).unwrap();
    let folder = store
        .workspace_open(&test_root(&new_id("folder")), None)
        .unwrap();
    let catalog = store.catalog().unwrap();
    assert_eq!(catalog.projects.len(), 2);
    let repository = &catalog.projects[0];
    assert_eq!(repository.kind, ProjectKind::Repository);
    assert_eq!(repository.root, common);
    assert_eq!(repository.name, project);
    assert_eq!(first.project_id, repository.id);
    assert_eq!(second.project_id, repository.id);
    assert_eq!(catalog.projects[1].kind, ProjectKind::Folder);
    assert_eq!(folder.project_id, catalog.projects[1].id);
}
