//! Prompt context capture (F033) and per-provider attachment plans (F032).
//!
//! A capture turns one selection into a context node: a bounded, provenance-
//! headed text document stored as a managed conversation attachment, so it
//! travels through drafts, sends, queues and backups like any attachment. The
//! daemon reads files and diffs itself. Terminal output and service logs live
//! in the client's terminal buffer, so the client supplies that text and the
//! node says so. A browser capture reuses the attachments that
//! `browser.context.capture` already stored.
//!
//! A plan shows, before dispatch, the form each attachment takes for one
//! provider and every attachment that provider would refuse.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::Attachment;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        // `request_id` names the node. A repeat returns the recorded node and
        // never reads the source again; a different source under the same ID
        // is refused.
        OperationSpec::new::<ContextCaptureRequest, ContextNodeReply>(
            "context.capture",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<ContextGetRequest, ContextNodeReply>("context.get", Tier::Query),
        OperationSpec::new::<ContextPlanRequest, ContextPlan>("context.plan", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// One selection to capture.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContextSource {
    /// Lines `start_line` to `end_line`, 1-based and inclusive, of one
    /// workspace file. The daemon reads the file.
    FileRange {
        workspace_id: String,
        path: String,
        start_line: u64,
        end_line: u64,
    },
    /// One hunk of a `review.diff` reply. The daemon reads the diff again and
    /// refuses the capture when its token no longer matches.
    DiffHunk {
        workspace_id: String,
        path: String,
        #[serde(default)]
        staged: bool,
        token: String,
        hunk: u64,
    },
    /// Text selected from a workspace terminal, supplied by the client.
    TerminalOutput {
        workspace_id: String,
        terminal_id: String,
        text: String,
        /// The selection's first buffer row, when the client knows it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "u64")]
        first_row: Option<u64>,
    },
    /// The last `lines` lines of a service's output, supplied by the client.
    ServiceLog {
        workspace_id: String,
        service: String,
        text: String,
        lines: u64,
    },
    /// The attachments a completed `browser.context.capture` stored.
    BrowserCapture { capture_id: String },
}

/// `context.capture`: capture one selection into a context node.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ContextCaptureRequest {
    pub conversation_id: String,
    /// The node ID, and the ID of the attachment a text capture stores.
    pub request_id: String,
    pub source: ContextSource,
}

/// `context.get`: read one recorded context node.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ContextGetRequest {
    pub conversation_id: String,
    pub node_id: String,
}

/// `context.plan`: how the conversation's provider would receive these
/// attachments, and which it would refuse, before anything is sent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ContextPlanRequest {
    pub conversation_id: String,
    /// The prompt text, which counts toward request limits.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

wire_tag!(ContextNodeTag, "context_node");
wire_tag!(ContextPlanTag, "context_plan");

/// What a context node was captured from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    FileRange,
    DiffHunk,
    TerminalOutput,
    ServiceLog,
    BrowserCapture,
}

/// Who produced the captured bytes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextOrigin {
    /// The daemon read the source itself.
    DaemonRead,
    /// The client supplied the text; the daemon checked only the source's identity.
    ClientSupplied,
    /// The browser owner captured it through `browser.context.capture`.
    BrowserOwner,
}

/// Where a node came from. Fields that do not apply to its kind are null.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq, Default)]
pub struct ContextProvenance {
    pub workspace_id: Option<String>,
    pub path: Option<String>,
    /// The captured lines, 1-based and inclusive, within the source.
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    /// The source's line count when the daemon read the whole source.
    pub total_lines: Option<u64>,
    pub terminal_id: Option<String>,
    pub service: Option<String>,
    pub staged: Option<bool>,
    pub diff_token: Option<String>,
    pub hunk: Option<u64>,
    pub capture_id: Option<String>,
    /// The captured page's URL, without user information, query or fragment.
    pub url: Option<String>,
    pub title: Option<String>,
}

/// One captured selection and the attachments that carry it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ContextNode {
    pub id: String,
    pub conversation_id: String,
    pub kind: ContextKind,
    pub origin: ContextOrigin,
    pub provenance: ContextProvenance,
    /// Add these to a draft or send to include the node.
    pub attachments: Vec<Attachment>,
    /// Lowercase hex SHA-256 of each attachment's bytes, in order.
    pub sha256: Vec<String>,
    /// Whether bounds cut the selection. The stored document says so too.
    pub truncated: bool,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
    pub captured_at: i64,
}

/// The `context.capture` and `context.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ContextNodeReply {
    #[serde(rename = "type")]
    pub tag: ContextNodeTag,
    pub node: ContextNode,
    /// False when an attachment was reclaimed; attach the context again.
    pub available: bool,
}

/// How one attachment reaches a provider.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PartForm {
    /// A native image input: base64 image block, data URL or file part.
    NativeImage,
    /// A separate text content block, introduced by `text_prefix`.
    TextBlock,
    /// Appended to the prompt text after a blank line, introduced by `text_prefix`.
    PromptText,
    /// The adapter decides from its handshake at dispatch; it refuses what it
    /// did not declare.
    AdapterDeclared,
}

/// What a provider accepts, and where each limit comes from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ProviderMediaSupport {
    pub provider: String,
    /// False for a provider ADE has no table for, such as a generic adapter.
    pub known: bool,
    pub image_types: Vec<String>,
    pub image_form: Option<String>,
    pub text_form: Option<String>,
    /// The largest image, in raw bytes, this provider takes.
    pub max_image_bytes: Option<u64>,
    /// The largest whole prompt request, in bytes, this provider takes.
    pub max_request_bytes: Option<u64>,
    /// Where the limits come from.
    pub sources: Vec<String>,
}

/// One attachment's planned form.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PlannedPart {
    pub attachment_id: String,
    pub form: PartForm,
    /// The exact text placed before a text attachment's contents.
    pub text_prefix: Option<String>,
}

/// Why a provider would refuse an attachment or the whole prompt.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RejectionCode {
    UnsupportedMediaType,
    ImageTooLarge,
    RequestTooLarge,
    AttachmentsUnsupported,
}

/// One refusal found before dispatch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct PlanRejection {
    /// Null when the refusal covers the whole prompt.
    pub attachment_id: Option<String>,
    pub code: RejectionCode,
    pub message: String,
}

/// The `context.plan` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ContextPlan {
    #[serde(rename = "type")]
    pub tag: ContextPlanTag,
    pub support: ProviderMediaSupport,
    pub parts: Vec<PlannedPart>,
    pub rejections: Vec<PlanRejection>,
    /// True only when there are no rejections.
    pub admissible: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;

    #[test]
    fn operations_declare_their_tiers() {
        let bundle = bundle();
        let tier = |name: &str| {
            bundle["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|spec| spec["name"] == name)
                .map(|spec| spec["tier"].as_str().unwrap().to_owned())
        };
        assert_eq!(
            tier("context.capture").as_deref(),
            Some("idempotent_command")
        );
        assert_eq!(tier("context.get").as_deref(), Some("query"));
        assert_eq!(tier("context.plan").as_deref(), Some("query"));
    }

    #[test]
    fn sources_round_trip_and_refuse_unknown_fields() {
        let source = ContextSource::FileRange {
            workspace_id: "w".into(),
            path: "src/lib.rs".into(),
            start_line: 1,
            end_line: 3,
        };
        let wire = serde_json::to_value(&source).unwrap();
        assert_eq!(wire["kind"], "file_range");
        assert_eq!(
            serde_json::from_value::<ContextSource>(wire).unwrap(),
            source
        );
        assert!(
            serde_json::from_value::<ContextSource>(serde_json::json!({
                "kind": "browser_capture", "capture_id": "c", "extra": 1
            }))
            .is_err()
        );
    }
}
