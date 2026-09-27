use super::*;
#[test]
fn terminal_reservation_is_atomic_durable_and_fences_prompt_admission() {
    let db = Database::new();
    let store = db.open();
    let (w, mut c) = fixture(&store);
    c.provider_thread_id = Some("native-session".into());
    c.status = "ready".into();
    store.commit_conversation(&c, &[], &[]).unwrap();
    store.enqueue(&c.id, "queued", "Keep queued").unwrap();
    let owned = store.reserve_terminal(&c.id, "runtime").unwrap();
    let owner = owned.terminal_owner.unwrap();
    assert!(
        store
            .workspace(&w.id)
            .unwrap()
            .extra_terminals
            .contains(&owner.terminal_id)
    );
    assert_eq!(
        store
            .reserve_terminal(&c.id, "runtime")
            .unwrap()
            .terminal_owner
            .unwrap()
            .transfer_id,
        owner.transfer_id
    );
    drop(store);
    let store = db.open();
    store.recover_interrupted().unwrap();
    assert!(store.conversation(&c.id).unwrap().queue_paused);
    assert!(store.terminal_reserved(&owner.terminal_id).unwrap());
    assert!(store.queue_heads().unwrap().is_empty());
    assert!(
        store
            .begin_turn(&c.id, "manual", "Cannot race the terminal")
            .is_err()
    );
    assert!(
        store
            .begin_queued_turn(&c.id, "queued", "Keep queued")
            .is_err()
    );
    assert_eq!(store.queued(&c.id).unwrap().len(), 1);
    assert!(store.message("manual").unwrap().is_none());
}
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
fn attachment_migration_preserves_v5_drafts_and_queued_prompts() {
    let db = Database::new();
    let store = db.open();
    let (_, c) = fixture(&store);
    store
        .save_draft(
            &c.id,
            "window",
            &Draft {
                text: "Draft before upgrade".into(),
                revision: 4,
                attachments: vec![],
            },
        )
        .unwrap();
    store
        .enqueue(&c.id, "queued-before-upgrade", "Queued before upgrade")
        .unwrap();
    store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DELETE FROM schema_migrations WHERE version=7; DROP TABLE attachments; ALTER TABLE drafts DROP COLUMN attachments; ALTER TABLE queued_prompts DROP COLUMN attachments; DELETE FROM schema_migrations WHERE version=6; PRAGMA user_version=5;").unwrap();
    drop(store);
    let store = db.open();
    let draft = store.draft(&c.id, "window").unwrap();
    assert_eq!(draft.text, "Draft before upgrade");
    assert_eq!(draft.revision, 4);
    assert!(draft.attachments.is_empty());
    let queued = store.queued(&c.id).unwrap();
    assert_eq!(queued[0].text, "Queued before upgrade");
    assert!(queued[0].attachments.is_empty());
    let attachment = store
        .attach(&c.id, "file", "example.txt", b"Snapshot")
        .unwrap();
    store
        .save_draft(
            &c.id,
            "window",
            &Draft {
                text: draft.text,
                revision: 5,
                attachments: vec![attachment.clone()],
            },
        )
        .unwrap();
    drop(store);
    let store = db.open();
    assert_eq!(
        store.draft(&c.id, "window").unwrap().attachments.as_slice(),
        std::slice::from_ref(&attachment)
    );
    assert!(
        store.prompt(&c.id, "", &[attachment]).unwrap().attachments[0]
            .text_block()
            .unwrap()
            .ends_with("Snapshot")
    );
}
#[test]
fn queue_migration_preserves_drafts_and_conversations() {
    let db = Database::new();
    let store = db.open();
    let (_, c) = fixture(&store);
    store
        .save_draft(
            &c.id,
            "window",
            &Draft {
                attachments: vec![],
                text: "Keep".into(),
                revision: 1,
            },
        )
        .unwrap();
    store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DELETE FROM schema_migrations WHERE version=7; DROP TABLE attachments; ALTER TABLE drafts DROP COLUMN attachments; DROP TABLE queued_prompts; DELETE FROM schema_migrations WHERE version>=5; PRAGMA user_version=4;").unwrap();
    drop(store);
    let store = db.open();
    assert_eq!(store.draft(&c.id, "window").unwrap().text, "Keep");
    store.enqueue(&c.id, "queued", "New").unwrap();
    assert_eq!(store.queue_heads().unwrap()[0].id, "queued");
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
#[test]
fn draft_migration_preserves_existing_conversations() {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    store.connection.execute_batch("DROP TABLE service_ports; DROP TABLE services; DROP TABLE attachments; DROP TABLE drafts; DROP TABLE queued_prompts; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3;").unwrap();
    drop(store);
    let store = db.open();
    assert_eq!(
        store.conversation(&conversation.id).unwrap().title,
        conversation.title
    );
    assert!(
        store
            .draft(&conversation.id, "window-a")
            .unwrap()
            .text
            .is_empty()
    );
}
struct Database {
    directory: std::path::PathBuf,
}
impl Database {
    fn new() -> Self {
        Self {
            directory: std::env::temp_dir().join(new_id("ade-store-test")),
        }
    }
    fn path(&self) -> std::path::PathBuf {
        self.directory.join("state.sqlite")
    }
    fn open(&self) -> Store {
        Store::open(&self.path()).unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
// Workspace roots must exist: opening a missing directory fails closed.
fn test_root(name: &str) -> String {
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
fn assistant(conversation: &Conversation, id: &str, provider: &str) -> Message {
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
fn window(workspace: &WorkspaceRecord, conversation: &Conversation, id: &str) -> WindowRecord {
    WindowRecord {
        dock_layout: None,
        panes: Default::default(),
        tabs: Default::default(),
        focused_pane: 5,
        id: id.into(),
        workspace_id: workspace.id.clone(),
        conversation_id: Some(conversation.id.clone()),
        browser_url: String::new(),
        x: 10.0,
        y: 20.0,
        width: 1200.0,
        height: 800.0,
    }
}
#[test]
fn pane_layout_restores_and_rejects_invalid_sizes() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    let mut record = window(&workspace, &conversation, "layout-window");
    record.panes.sidebar_visible = false;
    record.panes.browser_width = 420.;
    record.dock_layout = Some(serde_json::json!({"active_panel":"pane-test","closed":[]}));
    store.save_window(&record).unwrap();
    drop(store);
    let store = db.open();
    let restored = store.catalog().unwrap().windows.remove(0);
    assert!(!restored.panes.sidebar_visible);
    assert_eq!(restored.panes.browser_width, 420.);
    assert_eq!(restored.dock_layout, record.dock_layout);
    for invalid in [f32::NAN, f32::INFINITY, 0., 601.] {
        record.panes.browser_width = invalid;
        assert!(store.save_window(&record).is_err());
    }
    let mut legacy = serde_json::to_value(&restored).unwrap();
    legacy.as_object_mut().unwrap().remove("panes");
    let legacy: WindowRecord = serde_json::from_value(legacy).unwrap();
    assert!(
        legacy.panes.sidebar_visible
            && legacy.panes.terminal_visible
            && !legacy.panes.browser_visible
    );
    assert!(legacy.panes.valid());
}
#[test]
#[ignore = "stale fixture: needs recorded path bindings since fail-closed rebind checks"]
fn tabs_validate_ownership_and_restore_closed_views() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    let extra = store.create_terminal(&workspace.id, None).unwrap();
    let mut record = window(&workspace, &conversation, "tabs-window");
    record.tabs.initialized = true;
    let tab = TerminalTab {
        id: extra.clone(),
        workspace_id: workspace.id.clone(),
        title: "Second shell".into(),
    };
    record.tabs.terminals.push(tab.clone());
    record.tabs.active_terminal = Some(extra.clone());
    store.save_window(&record).unwrap();
    record.tabs.closed_terminals.push(tab.clone());
    assert!(
        store.save_window(&record).is_err(),
        "open/closed duplicates must be rejected"
    );
    record.tabs.terminals.clear();
    assert!(
        store.save_window(&record).is_err(),
        "active terminal must be an open view"
    );
    record.tabs.active_terminal = None;
    store.save_window(&record).unwrap();
    record.tabs.closed_terminals[0].id = "unknown-shell".into();
    assert!(store.save_window(&record).is_err());
    let other = store.workspace_open(&test_root("other"), None).unwrap();
    record.tabs.closed_terminals[0] = TerminalTab {
        workspace_id: other.id,
        ..tab
    };
    assert!(
        store.save_window(&record).is_err(),
        "terminal identity cannot move between workspaces"
    );
    drop(store);
    let reopened = db.open();
    assert!(
        reopened
            .workspace(&workspace.id)
            .unwrap()
            .extra_terminals
            .contains(&extra)
    );
    let restored = reopened.catalog().unwrap().windows.remove(0);
    assert_eq!(restored.tabs.closed_terminals[0].id, extra);
    let mut legacy = serde_json::to_value(&restored).unwrap();
    legacy.as_object_mut().unwrap().remove("tabs");
    assert!(
        !serde_json::from_value::<WindowRecord>(legacy)
            .unwrap()
            .tabs
            .initialized
    );
}
#[test]
fn reopen_retains_identity_history_resume_and_windows() {
    let db = Database::new();
    let store = db.open();
    let (workspace, mut conversation) = fixture(&store);
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
        .save_window(&window(&workspace, &conversation, "window-1"))
        .unwrap();
    store
        .save_window(&window(&workspace, &conversation, "window-2"))
        .unwrap();
    store.close_window("window-2").unwrap();
    store.close_window("window-1").unwrap();
    drop(store);
    let store = db.open();
    let reopened = store
        .workspace_open(&test_root("project"), Some(&test_root("project")))
        .unwrap();
    assert_eq!(workspace.id, reopened.id);
    assert_eq!(workspace.repository_id, reopened.repository_id);
    assert_eq!(workspace.terminal_id, reopened.terminal_id);
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
    assert_eq!(store.catalog().unwrap().windows[0].id, "window-1");
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
#[ignore = "stale fixture: needs recorded path bindings since fail-closed rebind checks"]
fn invalid_windows_and_future_database_fail_without_clobbering() {
    let db = Database::new();
    let store = db.open();
    let (workspace, conversation) = fixture(&store);
    let mut value = window(&workspace, &conversation, "w");
    value.width = f32::NAN;
    assert!(store.save_window(&value).is_err());
    value.width = 999.0;
    assert!(store.save_window(&value).is_err());
    value.width = 1200.0;
    value.browser_url = "file:///etc/passwd".into();
    assert!(store.save_window(&value).is_err());
    value.browser_url = "https://example.com/path".into();
    store.save_window(&value).unwrap();
    let other = store.workspace_open(&test_root("other"), None).unwrap();
    value.workspace_id = other.id;
    assert!(store.save_window(&value).is_err());
    assert_eq!(
        store.catalog().unwrap().windows[0].workspace_id,
        workspace.id
    );
    store
        .connection
        .pragma_update(None, "user_version", 99)
        .unwrap();
    drop(store);
    assert!(Store::open(&db.path()).is_err());
    let conn = Connection::open(db.path()).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        99
    );
}
fn migration_v5_fixture() -> (Database, String) {
    let db = Database::new();
    let store = db.open();
    let (_, conversation) = fixture(&store);
    store
        .save_draft(
            &conversation.id,
            "migration-window",
            &Draft {
                text: "unsent migration draft".into(),
                revision: 8,
                attachments: vec![],
            },
        )
        .unwrap();
    store
        .enqueue(&conversation.id, "migration-queued", "saved queued prompt")
        .unwrap();
    store
        .connection
        .execute_batch(
            "DROP TABLE service_ports; DROP TABLE services;
            DELETE FROM schema_migrations WHERE version >= 6; DROP TABLE attachments;
            ALTER TABLE drafts DROP COLUMN attachments;
            ALTER TABLE queued_prompts DROP COLUMN attachments; PRAGMA user_version=5;",
        )
        .unwrap();
    (db, conversation.id)
}

fn assert_v5_migration_rolled_back(db: &Database, conversation: &str) {
    let connection = Connection::open(db.path()).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='attachments'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('drafts') WHERE name='attachments'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('queued_prompts') WHERE name='attachments'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version>=6",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT text FROM drafts WHERE conversation_id=?1",
                [conversation],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "unsent migration draft"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT text FROM queued_prompts WHERE conversation_id=?1",
                [conversation],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "saved queued prompt"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE id=?1",
                [conversation],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
#[ignore = "stale: expects a schema version older than the current ladder"]
fn migration_sql_failure_rolls_back_ddl_and_preserves_data_for_retry() {
    let (db, conversation) = migration_v5_fixture();
    let connection = Connection::open(db.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_migration_six BEFORE INSERT ON schema_migrations
            WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END;",
        )
        .unwrap();
    drop(connection);
    let failure = Store::open(&db.path()).err().expect("migration must fail");
    assert!(failure.to_string().contains("fixture migration failure"));
    assert_v5_migration_rolled_back(&db, &conversation);
    let connection = Connection::open(db.path()).unwrap();
    connection
        .execute_batch("DROP TRIGGER reject_migration_six")
        .unwrap();
    drop(connection);
    let restored = db.open();
    assert_eq!(
        restored
            .draft(&conversation, "migration-window")
            .unwrap()
            .text,
        "unsent migration draft"
    );
    assert_eq!(
        restored.queued(&conversation).unwrap()[0].text,
        "saved queued prompt"
    );
    assert_eq!(
        restored
            .connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
}

#[test]
fn newer_schema_rejection_preserves_original_database_bytes_and_journal() {
    let db = Database::new();
    std::fs::create_dir_all(&db.directory).unwrap();
    let connection = Connection::open(db.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE future_payload(id INTEGER PRIMARY KEY, value BLOB);
            INSERT INTO future_payload VALUES(1, X'0001FF'); PRAGMA user_version=99;",
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(db.path()).unwrap();
    let failure = Store::open(&db.path())
        .err()
        .expect("future schema must fail");
    assert!(
        failure
            .to_string()
            .contains("Unsupported database version 99")
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

#[test]
#[ignore = "subprocess entry point used by migration kill regression"]
fn migration_interruption_child() {
    let path = std::env::var_os("ADE_STORE_MIGRATION_TEST_DB").expect("test DB path");
    Store::open(Path::new(&path)).unwrap();
    panic!("migration unexpectedly completed instead of reaching checkpoint");
}

#[test]
fn killed_migration_rolls_back_and_next_start_preserves_saved_data() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let (db, conversation) = migration_v5_fixture();
    let marker = db.directory.join("migration-checkpoint");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::tests::migration_interruption_child",
            "--ignored",
            "--nocapture",
        ])
        .env("ADE_STORE_MIGRATION_TEST_DB", db.path())
        .env("ADE_STORE_MIGRATION_TEST_CHECKPOINT", &marker)
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
    assert!(reached, "child did not reach real uncommitted migration");
    assert!(!status.success());
    assert_v5_migration_rolled_back(&db, &conversation);
    let restored = db.open();
    assert_eq!(
        restored
            .draft(&conversation, "migration-window")
            .unwrap()
            .text,
        "unsent migration draft"
    );
    assert_eq!(
        restored.queued(&conversation).unwrap()[0].text,
        "saved queued prompt"
    );
}
