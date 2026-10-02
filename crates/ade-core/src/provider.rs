//! Provider contracts shared by the client, daemon, and runtime.
use crate::model::Message;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider-reported terminal evidence, kept separate from ADE's interrupt request.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeTerminalEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_error_status: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Value>,
}
/// The daemon advertises the same contract it uses to validate configuration.
/// Clients consume descriptors; they do not infer support from a provider name.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct Descriptor {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<String>,
    pub permission_modes: Vec<String>,
    #[serde(default)]
    pub setting_sources: Vec<String>,
}
pub fn descriptors() -> &'static [Descriptor] {
    static REGISTRY: std::sync::OnceLock<Vec<Descriptor>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| {
        let strings = |values: &[&str]| values.iter().map(|s| (*s).to_owned()).collect();
        vec![
            Descriptor {
                id: "omp".into(),
                name: "Oh My Pi".into(),
                capabilities: strings(&[
                    "streaming",
                    "images",
                    "text_attachments",
                    "resume",
                    "cancel",
                    "questions",
                    "child_transcript",
                ]),
                permission_modes: strings(&["default"]),
                setting_sources: vec![],
            },
            Descriptor {
                id: "codex".into(),
                name: "Codex".into(),
                capabilities: strings(&[
                    "child_transcript",
                    "streaming",
                    "images",
                    "text_attachments",
                    "resume",
                    "cancel",
                    "command_approval",
                    "file_approval",
                    "scoped_permissions",
                    "questions",
                ]),
                permission_modes: strings(&["default", "read-only"]),
                setting_sources: vec![],
            },
            Descriptor {
                id: "claude".into(),
                name: "Claude Code".into(),
                capabilities: strings(&[
                    "child_transcript",
                    "streaming",
                    "images",
                    "text_attachments",
                    "resume",
                    "cancel",
                    "tool_approval",
                    "questions",
                ]),
                permission_modes: strings(&["default", "plan", "acceptEdits", "dontAsk"]),
                setting_sources: strings(&["user", "project", "local"]),
            },
        ]
    })
}
pub fn descriptor(id: &str) -> Result<&'static Descriptor> {
    descriptors()
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| crate::error::ProviderNotFound(id.to_owned()).into())
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub model: Option<String>,
    pub permission_mode: String,
    pub setting_sources: Vec<String>,
    /// A reasoning level from [`reasoning_efforts`]; absent means the provider's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            model: None,
            permission_mode: "default".into(),
            setting_sources: vec![],
            reasoning_effort: None,
        }
    }
}
impl Config {
    pub fn validate(&self, provider: &str) -> Result<()> {
        self.validate_against(descriptor(provider)?)
    }
    /// Validates against a descriptor that is not in the static catalogue,
    /// such as one a plugin provider worker declared in its handshake.
    pub fn validate_against(&self, descriptor: &Descriptor) -> Result<()> {
        let provider = &descriptor.id;
        ensure!(
            self.model
                .as_ref()
                .is_none_or(|s| !s.is_empty() && s.len() <= 256 && !s.contains('\0')),
            "Invalid model"
        );
        ensure!(
            descriptor.permission_modes.contains(&self.permission_mode),
            "Unsupported permission mode for {provider}"
        );
        ensure!(
            self.setting_sources.len() <= descriptor.setting_sources.len()
                && self
                    .setting_sources
                    .iter()
                    .all(|s| descriptor.setting_sources.contains(s)),
            "Unsupported setting sources for {provider}"
        );
        ensure!(
            self.reasoning_effort
                .as_ref()
                .is_none_or(|level| reasoning_efforts(provider).contains(&level.as_str())),
            "Unsupported reasoning level for {provider}"
        );
        Ok(())
    }
}

/// Reasoning levels ADE can request from a provider at launch. Empty means
/// ADE cannot select reasoning for that provider; it is never emulated.
pub fn reasoning_efforts(provider: &str) -> &'static [&'static str] {
    match provider {
        // Codex app-server `turn/start` takes `effort`.
        "codex" => &["minimal", "low", "medium", "high"],
        // The Claude Agent SDK `effort` query option.
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        _ => &[],
    }
}

/// Most models one discovery report may list; a longer report is not used.
pub const MAX_NATIVE_MODELS: usize = 512;

/// One model a provider listed for its open session (Codex `model/list`,
/// Claude `supportedModels()`, Oh My Pi `get_available_models`), with the
/// dependent settings it reported for that model. A null list was not reported.
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct NativeModel {
    /// The value a launch passes as the model.
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// The provider's default model.
    #[serde(default)]
    pub is_default: bool,
    /// Other names the provider resolves to this model.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Reasoning levels the provider listed for this model.
    #[serde(default)]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    /// Permission modes the provider listed for this model.
    #[serde(default)]
    pub permission_modes: Option<Vec<String>>,
}

/// The models a provider listed when its session opened.
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct NativeChoices {
    /// The native call that listed them, such as `model/list`.
    pub source: String,
    pub models: Vec<NativeModel>,
}
impl NativeChoices {
    /// A report within ADE's bounds; a larger or malformed one is not used.
    pub fn validate(&self) -> Result<()> {
        fn name(value: &str) -> bool {
            !value.is_empty() && value.len() <= 256 && !value.contains('\0')
        }
        fn names(values: Option<&Vec<String>>) -> bool {
            values.is_none_or(|values| values.len() <= 32 && values.iter().all(|v| name(v)))
        }
        ensure!(
            !self.source.is_empty() && self.source.len() <= 128,
            "Invalid model discovery source"
        );
        ensure!(
            self.models.len() <= MAX_NATIVE_MODELS,
            "The provider listed more than {MAX_NATIVE_MODELS} models"
        );
        ensure!(
            self.models.iter().all(|model| name(&model.id)
                && model.display_name.as_deref().is_none_or(|n| n.len() <= 256)
                && model.aliases.len() <= 16
                && model.aliases.iter().all(|alias| name(alias))
                && names(model.reasoning_efforts.as_ref())
                && names(model.permission_modes.as_ref())
                && model.default_reasoning_effort.as_deref().is_none_or(name)),
            "The provider listed a malformed model"
        );
        Ok(())
    }
    /// The listed model a launch value names, by its ID or else an alias.
    pub fn model(&self, value: &str) -> Option<&NativeModel> {
        self.models
            .iter()
            .find(|model| model.id == value)
            .or_else(|| {
                self.models
                    .iter()
                    .find(|model| model.aliases.iter().any(|alias| alias == value))
            })
    }
    pub fn default_model(&self) -> Option<&NativeModel> {
        self.models.iter().find(|model| model.is_default)
    }
}

/// Settings the provider itself reported for an opened session; each value
/// is null when the provider did not report it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct NativeSettings {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_mode: Option<String>,
}
/// Provider-native transcript identity. It is independent of ADE message IDs,
/// client IDs, and turn IDs, and is valid only in its native session.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct NativeMessageLocator {
    pub provider: String,
    pub session: String,
    pub message_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Item {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<crate::transcript::Content>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_message: Option<NativeMessageLocator>,
    pub client_id: Option<String>,
    pub turn: Option<String>,
    pub role: String,
    pub kind: String,
    pub text: String,
    pub status: String,
}
impl Item {
    pub fn message(&self, conversation: &str) -> Message {
        Message {
            content: self.content.clone(),
            review_feedback: None,
            delivery: None,
            attachments: vec![],
            id: self
                .client_id
                .clone()
                .unwrap_or_else(|| format!("{conversation}:{}", self.id)),
            conversation_id: conversation.into(),
            role: self.role.clone(),
            kind: self.kind.clone(),
            text: self.text.clone(),
            status: self.status.clone(),
            turn_id: self.turn.clone(),
            provider_item_id: Some(self.id.clone()),
            native_message: self.native_message.clone(),
            sequence: 0,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Connected {
    pub session: String,
    pub history: Vec<Item>,
    /// Set when a rewind forked `session` from this one after the Agent
    /// opened (F039): a daemon that reattaches may still hold it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewound_from: Option<String>,
    /// What the provider reported in effect when the session opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_settings: Option<NativeSettings>,
    /// The models, with their dependent settings, the provider listed for
    /// this session; null when it listed none or discovery failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_choices: Option<NativeChoices>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    OperationFailed {
        submission: Option<String>,
        error: String,
    },
    Submitted {
        submission: String,
        turn: Option<String>,
        #[serde(default)]
        admitted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dispatch: Option<crate::contract::conversations::SubmissionDispatch>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_outcome: Option<crate::contract::conversations::SubmissionNativeOutcome>,
    },
    Started {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submission: Option<String>,
        turn: Option<String>,
    },
    Finished {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submission: Option<String>,
        turn: Option<String>,
        status: String,
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_terminal: Option<NativeTerminalEvidence>,
        #[serde(default)]
        interrupt_requested: bool,
    },
    Item {
        session: String,
        #[serde(default)]
        submission: Option<String>,
        item: Item,
    },
    Delta {
        session: String,
        #[serde(default)]
        submission: Option<String>,
        turn: Option<String>,
        id: String,
        role: String,
        kind: String,
        text: String,
    },
    Request {
        session: String,
        #[serde(default)]
        submission: Option<String>,
        turn: Option<String>,
        id: Value,
        method: String,
        params: Value,
        supported: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<crate::requests::RequestMetadata>,
    },
    Resolved {
        #[serde(default)]
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submission: Option<String>,
        id: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolution: Option<crate::requests::RequestResolution>,
    },
    /// Token, cost or rate-limit figures exactly as the provider reported
    /// them. `source` names the native event; the daemon normalizes `report`
    /// and never fills in a figure the provider left out.
    /// Background work the provider reports for its session, apart from the
    /// foreground turn: running native tasks, children or processes. Null
    /// fields mean the provider gave no evidence for them.
    Background {
        session: String,
        active: Option<bool>,
        running: Option<u64>,
        source: String,
    },
    /// Settings the provider reported in effect during its session, such as
    /// Claude's `system/init` frame. A null field was not reported.
    Settings {
        session: String,
        settings: NativeSettings,
    },
    Usage {
        #[serde(default)]
        session: String,
        #[serde(default)]
        turn: Option<String>,
        /// The submission the report belongs to, for a provider that names no
        /// turn; ADE then keys the turn's usage by it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submission: Option<String>,
        source: String,
        #[serde(default)]
        report: Value,
    },
    Error {
        error: String,
        /// The provider turn the error belongs to, when the provider names
        /// one. An error for another turn never reaches the active one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn: Option<String>,
    },
    Exited {
        error: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_discovery_report_finds_models_by_id_then_alias_and_refuses_one_beyond_its_bounds() {
        let model = |id: &str, aliases: &[&str]| NativeModel {
            id: id.into(),
            aliases: aliases.iter().map(|a| (*a).to_owned()).collect(),
            ..NativeModel::default()
        };
        let choices = NativeChoices {
            source: "supportedModels".into(),
            models: vec![
                NativeModel {
                    is_default: true,
                    ..model("default", &["claude-x"])
                },
                model("claude-x", &[]),
            ],
        };
        choices.validate().unwrap();
        assert_eq!(choices.model("claude-x").unwrap().id, "claude-x");
        assert_eq!(choices.default_model().unwrap().id, "default");
        assert!(choices.model("other").is_none());
        let mut large = choices.clone();
        large.models = vec![model("m", &[]); MAX_NATIVE_MODELS + 1];
        assert!(large.validate().is_err());
        let mut malformed = choices;
        malformed.models[0].reasoning_efforts = Some(vec![String::new()]);
        assert!(malformed.validate().is_err());
    }
}
