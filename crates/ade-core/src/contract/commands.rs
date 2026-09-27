//! Slash command and skill contracts (F037).
//!
//! `command.list` shows, for one Conversation, the commands and skills its
//! provider can be asked to run, where each came from, and how ADE would hand
//! it to the provider. `command.invoke` hands one of them to the provider in
//! its native form. When a provider has no native form that ADE's adapter
//! sends, both report the entry as unavailable with the reason; ADE never
//! rewrites a command into an ordinary prompt of its own.
use super::skills::SkillScope;
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<CommandListRequest, CommandList>("command.list", Tier::Query),
        OperationSpec::new::<CommandInvokeRequest, CommandInvoked>(
            "command.invoke",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `command.list`: the commands and skills available to one Conversation.
/// Reads provider paths and the skill catalog; writes nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CommandListRequest {
    pub conversation_id: String,
}

/// `command.invoke`: hand a listed command or skill to the Conversation's
/// provider in its native form. The invocation joins the Conversation's
/// prompt queue under the derived queue ID `<operation_id>:command`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CommandInvokeRequest {
    pub operation_id: String,
    pub conversation_id: String,
    /// The entry name as `command.list` reported it, without a leading slash.
    pub name: String,
    pub kind: CommandKind,
    /// Free text passed after the command, as the provider's own input would.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arguments: String,
}

wire_tag!(CommandListTag, "command_list");
wire_tag!(CommandInvokedTag, "command_invoked");

/// Whether an entry is a slash command or a skill.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    Command,
    Skill,
}

/// Where an entry was found.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandSource {
    /// A command file in a directory the provider reads.
    ProviderFile,
    /// A skill directory in a root the provider reads.
    ProviderSkill,
    /// A bundle in ADE's skill catalog that is not in any path the provider reads.
    AdeCatalog,
}

/// Where an entry came from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CommandProvenance {
    pub source: CommandSource,
    /// Absent for catalog-only bundles.
    pub scope: Option<SkillScope>,
    /// The file or directory ADE read.
    pub path: Option<String>,
    /// The skill bundle content hash, when the entry is a valid skill.
    pub content_hash: Option<String>,
    /// The ADE catalog bundle with the same content, if any.
    pub catalog_name: Option<String>,
}

/// One command or skill and whether ADE can hand it to the provider.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CommandEntry {
    pub name: String,
    pub kind: CommandKind,
    pub description: Option<String>,
    /// The provider's argument hint, such as `<file>`.
    pub argument_hint: Option<String>,
    pub provenance: CommandProvenance,
    pub invocable: bool,
    /// The native text the provider receives without arguments, such as `/review`.
    pub invocation: Option<String>,
    /// The native path ADE uses, such as `claude.prompt_slash`.
    pub mechanism: Option<String>,
    /// Why the entry cannot be invoked, or a caveat when it can.
    pub reason: Option<String>,
}

/// What the provider itself reports about its commands. ADE does not yet ask
/// a live provider session for its list, so built-in and plugin commands are
/// not shown and cannot be invoked through ADE.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CommandNativeCatalog {
    /// The provider method that would list them, when one exists.
    pub method: Option<String>,
    pub queried: bool,
    pub reason: String,
}

/// The `command.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CommandList {
    #[serde(rename = "type")]
    pub tag: CommandListTag,
    pub conversation_id: String,
    pub provider: String,
    /// Sorted by kind, then name, then path.
    pub entries: Vec<CommandEntry>,
    pub native_catalog: CommandNativeCatalog,
    /// Provider paths or scopes this listing did not read, and why.
    pub skipped: Vec<String>,
}

/// How an invocation ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandInvokeOutcome {
    /// The native text is in the Conversation's prompt queue. The queue
    /// delivers it; this is not a provider acknowledgement.
    Queued,
    /// Nothing was queued; `reason` says why. No receipt was recorded.
    Unavailable,
    /// ADE cannot prove whether the invocation was queued and will not queue it again.
    Unknown,
}

/// The `command.invoke` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct CommandInvoked {
    #[serde(rename = "type")]
    pub tag: CommandInvokedTag,
    pub operation_id: String,
    pub conversation_id: String,
    pub name: String,
    pub kind: CommandKind,
    pub outcome: CommandInvokeOutcome,
    /// The exact text queued for the provider.
    pub native_text: Option<String>,
    /// The queued prompt's ID.
    pub queue_id: Option<String>,
    pub mechanism: Option<String>,
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String, String) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
            spec["tier"].as_str().unwrap().to_owned(),
        )
    }

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    #[test]
    fn operations_declare_their_tiers() {
        assert_eq!(names("command.list").2, "query");
        assert_eq!(names("command.invoke").2, "effect_command");
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<CommandListRequest>(
            "command.list",
            json!({"op": "command.list", "conversation_id": "c"}),
        );
        request::<CommandInvokeRequest>(
            "command.invoke",
            json!({"op": "command.invoke", "operation_id": "o", "conversation_id": "c",
                "name": "review", "kind": "command", "arguments": "src/lib.rs"}),
        );
        request::<CommandInvokeRequest>(
            "command.invoke",
            json!({"op": "command.invoke", "operation_id": "o", "conversation_id": "c",
                "name": "pdf", "kind": "skill"}),
        );
        let (name, _, _) = names("command.invoke");
        assert!(!valid(
            &name,
            &json!({"op": "command.invoke", "operation_id": "o", "conversation_id": "c",
                "name": "pdf", "kind": "prompt"})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<CommandList>(
            "command.list",
            json!({"type": "command_list", "conversation_id": "c", "provider": "claude",
                "entries": [{"name": "review", "kind": "command", "description": "Review",
                    "argument_hint": "<file>",
                    "provenance": {"source": "provider_file", "scope": "workspace",
                        "path": "/w/.claude/commands/review.md", "content_hash": null,
                        "catalog_name": null},
                    "invocable": true, "invocation": "/review",
                    "mechanism": "claude.prompt_slash", "reason": null},
                    {"name": "pdf", "kind": "skill", "description": null, "argument_hint": null,
                    "provenance": {"source": "ade_catalog", "scope": null, "path": null,
                        "content_hash": "ab", "catalog_name": "pdf"},
                    "invocable": false, "invocation": null, "mechanism": null,
                    "reason": "Not placed"}],
                "native_catalog": {"method": "supportedCommands()", "queried": false,
                    "reason": "Not asked"},
                "skipped": ["user scope"]}),
        );
        response::<CommandInvoked>(
            "command.invoke",
            json!({"type": "command_invoked", "operation_id": "o", "conversation_id": "c",
                "name": "review", "kind": "command", "outcome": "queued",
                "native_text": "/review src/lib.rs", "queue_id": "o:command",
                "mechanism": "claude.prompt_slash", "reason": null}),
        );
        response::<CommandInvoked>(
            "command.invoke",
            json!({"type": "command_invoked", "operation_id": "o", "conversation_id": "c",
                "name": "pdf", "kind": "skill", "outcome": "unavailable",
                "native_text": null, "queue_id": null, "mechanism": null,
                "reason": "No native form"}),
        );
    }
}
