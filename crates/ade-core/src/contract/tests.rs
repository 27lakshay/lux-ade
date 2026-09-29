//! Schema round trips: typed values serialize to JSON that their generated
//! schema accepts, and deserialize back.
use super::conversations::*;
use super::workspaces::*;
use super::*;
use crate::model::{Attachment, Catalogue, Conversation, Message, PendingRequest, QueuedPrompt};
use serde::de::DeserializeOwned;

fn validator(name: &str) -> jsonschema::Validator {
    let bundle = bundle();
    let schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": bundle["$defs"],
        "$ref": format!("{DEFINITIONS}{name}"),
    });
    jsonschema::validator_for(&schema).expect("generated schema compiles")
}

fn operation(op: &str) -> (String, String) {
    let bundle = bundle();
    let spec = bundle["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|spec| spec["name"] == op)
        .unwrap_or_else(|| panic!("{op} is registered"));
    (
        spec["request"].as_str().unwrap().to_owned(),
        spec["response"].as_str().unwrap().to_owned(),
    )
}

fn assert_valid(name: &str, value: &Value) {
    let errors: Vec<_> = validator(name)
        .iter_errors(value)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "{name} rejected {value}: {errors:?}");
}

/// The client sends the request body plus `op`.
fn request_round_trip<T: Serialize + DeserializeOwned>(op: &str, request: &T) {
    let (name, _) = operation(op);
    let mut wire = serde_json::to_value(request).unwrap();
    wire["op"] = json!(op);
    assert_valid(&name, &wire);
    let decoded: T = serde_json::from_value(wire.clone()).unwrap();
    let mut again = serde_json::to_value(decoded).unwrap();
    again["op"] = json!(op);
    assert_eq!(again, wire);
}

fn response_round_trip<T: Serialize + DeserializeOwned>(op: &str, response: &T) {
    let (_, name) = operation(op);
    reply_round_trip(&name, response);
}

fn reply_round_trip<T: Serialize + DeserializeOwned>(name: &str, reply: &T) {
    let wire = serde_json::to_value(reply).unwrap();
    assert_valid(name, &wire);
    let decoded: T = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
}

fn conversation() -> Conversation {
    serde_json::from_value(json!({
        "id": "conversation_1", "workspace_id": "workspace_1", "title": "Title",
        "provider": "codex", "provider_thread_id": null, "status": "idle",
        "active_turn_id": null, "error": null, "updated_at": 1,
    }))
    .unwrap()
}

fn attachment() -> Attachment {
    Attachment {
        id: "attachment_1".into(),
        name: "notes.txt".into(),
        media_type: "text/plain".into(),
        size: 12,
    }
}

fn message() -> Message {
    serde_json::from_value(json!({
        "id": "message_1", "conversation_id": "conversation_1", "role": "user",
        "kind": "text", "text": "hello", "status": "complete", "turn_id": null,
        "provider_item_id": null, "sequence": 3, "attachments": [attachment()],
        "review_feedback": {"workspace_id": "workspace_1"},
    }))
    .unwrap()
}

fn pending() -> PendingRequest {
    serde_json::from_value(json!({
        "id": "request_1", "conversation_id": "conversation_1", "run_id": "run_1",
        "rpc_id": 7, "method": "item/tool/requestUserInput", "params": {"questions": []},
        "status": "pending",
    }))
    .unwrap()
}

fn queued() -> QueuedPrompt {
    QueuedPrompt {
        id: "queued_1".into(),
        conversation_id: "conversation_1".into(),
        text: "later".into(),
        status: "queued".into(),
        attachments: Vec::new(),
    }
}

#[test]
fn every_operation_declares_a_tier_and_named_types() {
    let bundle = bundle();
    // Each domain asserts its own operations; this test covers the first two.
    let example = |spec: &&Value| {
        matches!(
            spec["domain"].as_str(),
            Some("workspaces" | "conversations")
        )
    };
    let tiers: Vec<_> = bundle["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(example)
        .map(|spec| {
            (
                spec["name"].as_str().unwrap(),
                spec["tier"].as_str().unwrap(),
            )
        })
        .collect();
    // Each domain module checks its own operations' tiers.
    for expected in [
        ("catalog.get", "query"),
        ("conversation.get", "query"),
        ("agent.send", "effect_command"),
        ("agent.answer", "effect_command"),
    ] {
        assert!(tiers.contains(&expected), "{expected:?}");
    }
    let kinds: Vec<_> = bundle["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(example)
        .map(|spec| spec["type"].as_str().unwrap())
        .collect();
    // Each domain module checks its own frames.
    for expected in ["catalog", "conversation_changed"] {
        assert!(kinds.contains(&expected), "{expected}");
    }
}

#[test]
fn catalog_get_round_trips() {
    request_round_trip("catalog.get", &CatalogGetRequest {});
    let workspace = serde_json::from_value(json!({
        "id": "workspace_1", "root": "/tmp/project", "name": "project",
        "project_id": "project_1",
    }))
    .unwrap();
    let frame = CatalogFrame {
        tag: CatalogTag::Tag,
        catalog: Catalogue {
            projects: vec![
                crate::model::CatalogProject {
                    id: "repo_1".into(),
                    kind: crate::model::ProjectKind::Repository,
                    name: "project".into(),
                    root: "/tmp/project/.git".into(),
                },
                crate::model::CatalogProject {
                    id: "project_1".into(),
                    kind: crate::model::ProjectKind::Folder,
                    name: "notes".into(),
                    root: "/tmp/notes".into(),
                },
            ],
            workspaces: vec![workspace],
            conversations: vec![conversation()],
            windows: Vec::new(),
            terminals: vec![
                serde_json::from_value(json!({
                    "id": "terminal_1", "workspace_id": "workspace_1", "kind": "shell",
                    "title": "zsh", "status": "running", "exit_code": null, "busy": true,
                    "foreground": "sleep", "primary": true, "service_id": null,
                    "script_run_id": null, "conversation_id": null,
                }))
                .unwrap(),
            ],
        },
        providers: crate::provider::descriptors().to_vec(),
        boot_id: "boot_1".into(),
        revision: 4,
    };
    response_round_trip("catalog.get", &frame);
    reply_round_trip("CatalogFrame", &frame);
}

#[test]
fn conversation_get_round_trips() {
    request_round_trip(
        "conversation.get",
        &ConversationGetRequest {
            conversation_id: "conversation_1".into(),
            before: None,
            limit: None,
            history_epoch: None,
        },
    );
    request_round_trip(
        "conversation.get",
        &ConversationGetRequest {
            conversation_id: "conversation_1".into(),
            before: Some(10),
            limit: Some(200),
            history_epoch: Some(2),
        },
    );
    let snapshot = ConversationSnapshot {
        tag: ConversationSnapshotTag::Tag,
        conversation: conversation(),
        messages: vec![message()],
        requests: vec![pending()],
        queued: vec![queued()],
        boot_id: "boot_1".into(),
        revision: 9,
        history_epoch: 0,
    };
    response_round_trip("conversation.get", &snapshot);
    let changed = ConversationChanged {
        tag: ConversationChangedTag::Tag,
        conversation: conversation(),
        messages: vec![message()],
        requests: Vec::new(),
        queued: Vec::new(),
        boot_id: "boot_1".into(),
        revision: 10,
    };
    reply_round_trip("ConversationChanged", &changed);
}

#[test]
fn agent_send_and_answer_round_trip() {
    request_round_trip(
        "agent.send",
        &AgentSendRequest {
            conversation_id: "conversation_1".into(),
            request_id: "send_1".into(),
            text: "hello".into(),
            attachments: vec![attachment()],
        },
    );
    request_round_trip(
        "agent.answer",
        &AgentAnswerRequest {
            conversation_id: "conversation_1".into(),
            request_id: "request_1".into(),
            decision: "answer".into(),
            answers: Some(json!({"q1": ["yes"]})),
        },
    );
    request_round_trip(
        "agent.answer",
        &AgentAnswerRequest {
            conversation_id: "conversation_1".into(),
            request_id: "request_1".into(),
            decision: "decline".into(),
            answers: None,
        },
    );
    response_round_trip("agent.send", &Ack::default());
    response_round_trip("agent.answer", &Ack::default());
}

#[test]
fn requests_are_closed_and_replies_are_open() {
    assert!(!validator("CatalogGetRequest").is_valid(&json!({"op": "catalog.get", "extra": 1})));
    assert!(!validator("CatalogGetRequest").is_valid(&json!({"op": "agent.send"})));
    assert!(validator("Ack").is_valid(&json!({"type": "ack", "request_id": "send_1"})));
    assert!(!validator("Ack").is_valid(&json!({"type": "catalog"})));
    assert!(!validator("ConversationGetRequest").is_valid(&json!({
        "op": "conversation.get", "conversation_id": "c", "limit": 9_007_199_254_740_992_u64,
    })));
}
