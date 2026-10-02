//! Claude Code through its public provider worker (`providers/claude/worker.mjs`):
//! the worker descriptor, capability record and installation requirements.
pub fn worker_descriptor() -> ade_core::contract::providers::ProviderWorkerInitialize {
    use ade_core::contract::providers::{
        ProviderWorkerAvailability as Availability, ProviderWorkerCapabilityName as Capability,
        ProviderWorkerMethod as Method, Support,
    };
    let mut descriptor = crate::codex::public_descriptor();
    descriptor.name = "Claude Code".into();
    descriptor.permission_modes = vec![
        "default".into(),
        "plan".into(),
        "acceptEdits".into(),
        "dontAsk".into(),
    ];
    for capability in &mut descriptor.capabilities {
        capability.available = match capability.name {
            Capability::Streaming
            | Capability::Images
            | Capability::TextAttachments
            | Capability::Resume
            | Capability::Cancel
            | Capability::ToolApproval
            | Capability::Questions
            | Capability::ChildTranscript => true,
            Capability::Steering => false,
        };
        capability.support = if capability.available {
            Support::Supported
        } else {
            Support::Unsupported
        };
    }
    for operation in &mut descriptor.operations {
        let reason = match operation.method {
            Method::Steer => {
                "ADE's Claude worker admits one turn at a time; the Agent SDK has no steer for an identified running turn"
            }
            Method::Compact => "ADE's Claude worker does not issue Claude Code's /compact command",
            _ => continue,
        };
        operation.availability = Availability::Unsupported;
        operation.reason = reason.into();
    }
    descriptor
}

/// Checked against `@anthropic-ai/claude-agent-sdk` 0.3.281 (`sdk.d.ts`) and
/// the Claude Code 2.1.x range the account probe validates.
pub fn capabilities() -> crate::capabilities::CapabilityRecord {
    use crate::capabilities::*;
    use Support::*;
    CapabilityRecord {
        provider: "claude".into(),
        name: "Claude Code".into(),
        revision: 2,
        fingerprint: String::new(),
        checked_against: "@anthropic-ai/claude-agent-sdk 0.3.281; Claude Code 2.1.x".into(),
        models: ModelCapabilities {
            selection: capability(Supported, "The worker passes the model option to the SDK"),
            format: ModelFormat::NativeId,
            aliases: strings(&["default", "sonnet", "opus", "haiku", "opusplan"]),
            discovery: capability(
                Supported,
                "initializationResult().models (as Query.supportedModels() lists them) when the session opens, with each model's supportedEffortLevels",
            ),
        },
        reasoning: ReasoningCapabilities {
            selection: capability(
                Supported,
                "conversation.settings.update stores a level; the launch passes it as the SDK effort option",
            ),
            levels: ade_core::provider::reasoning_efforts("claude")
                .iter()
                .map(|level| (*level).to_owned())
                .collect(),
            varies_by_model: true,
        },
        permission_modes: vec![
            mode("default", Supported, "Ask before tools that need approval"),
            mode(
                "plan",
                Supported,
                "Plan without editing files or running tools",
            ),
            mode("acceptEdits", Supported, "Approve file edits automatically"),
            mode(
                "dontAsk",
                Supported,
                "Deny anything not already allowed, without asking",
            ),
            mode(
                "bypassPermissions",
                NativeOnly,
                "Skip every permission check; ADE does not offer it",
            ),
            mode(
                "auto",
                NativeOnly,
                "A classifier decides approvals; ADE does not offer it",
            ),
        ],
        grants: GrantCapabilities {
            once: capability(Supported, "Accept answers one canUseTool request"),
            session: capability(
                NativeOnly,
                "updatedPermissions with the session destination; ADE never sends it",
            ),
            persistent: capability(
                NativeOnly,
                "updatedPermissions saved to settings files; ADE never sends it",
            ),
        },
        conversation: ConversationCapabilities {
            steering: capability(
                NativeOnly,
                "Streaming input accepts messages during a turn; ADE queues prompts until the turn settles",
            ),
            rewind: capability(
                Supported,
                "forkSession() up to the entry before a turn, then resume the fork; files rewind through ADE checkpoints, not Query.rewindFiles()",
            ),
            compaction: capability(NativeOnly, "The /compact command"),
            resume: capability(
                Supported,
                "The SDK resume option with the native session ID",
            ),
            import: capability(
                Supported,
                "history.import reads native transcripts; imported sessions are not resumed automatically",
            ),
            fork: capability(NativeOnly, "The forkSession option"),
            account_switch: capability(
                Supported,
                "ADE copies the session transcript into the new account's CLAUDE_CONFIG_DIR/projects and resumes it there, as the Agent SDK documents for resuming a session on another host",
            ),
        },
        quota: capability(
            Supported,
            "rate_limit_event messages, recorded by the usage domain",
        ),
        managed_accounts: capability(Supported, "One CLAUDE_CONFIG_DIR per account"),
    }
}

/// The Claude Code CLI the SDK drives, and Node for the worker.
pub const INSTALLATION: &[crate::capabilities::Executable] = &[
    crate::capabilities::Executable {
        check: "executable:claude",
        env: "ADE_CLAUDE_BIN",
        default: Some("claude"),
        used_by: crate::capabilities::UsedBy::Every,
    },
    crate::capabilities::Executable {
        check: "runtime:node",
        env: "ADE_NODE_BIN",
        default: Some("node"),
        used_by: crate::capabilities::UsedBy::Every,
    },
];
