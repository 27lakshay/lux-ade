//! Oh My Pi through its public provider worker (`providers/omp/worker.mjs`, run by
//! Bun): the worker descriptor, capability record and installation requirements.
/// The public worker metadata for `providers/omp/worker.mjs`. OMP has no
/// native steer for an identified turn and no conversation rewind; history,
/// child transcripts and compaction are native RPC operations.
pub fn worker_descriptor() -> ade_core::contract::providers::ProviderWorkerInitialize {
    use ade_core::contract::providers::{
        ProviderWorkerAvailability as Availability, ProviderWorkerCapabilityName as Capability,
        ProviderWorkerMethod as Method, Support,
    };
    let mut descriptor = crate::codex::public_descriptor();
    descriptor.name = "Oh My Pi".into();
    descriptor.permission_modes = vec!["default".into()];
    for capability in &mut descriptor.capabilities {
        capability.available = match capability.name {
            Capability::Streaming
            | Capability::Images
            | Capability::TextAttachments
            | Capability::Resume
            | Capability::Cancel
            | Capability::Questions
            | Capability::ChildTranscript => true,
            // Installed OMP 18.4 ran its built-in bash tool without asking (live probe, ticket 31);
            // only an extension's confirmation reaches ADE, as a question.
            Capability::Steering | Capability::ToolApproval => false,
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
                "Oh My Pi RPC has steer, but it cannot bind a steered message to the identified running turn and its submission"
            }
            Method::Rewind => {
                "Oh My Pi RPC has branch, but ADE's Oh My Pi worker does not map a branch onto a conversation rewind"
            }
            _ => continue,
        };
        operation.availability = Availability::Unsupported;
        operation.reason = reason.into();
    }
    descriptor
}

/// Checked against `@oh-my-pi/pi-coding-agent` 18.3.0 and its `docs/rpc.md`.
pub fn capabilities() -> crate::capabilities::CapabilityRecord {
    use crate::capabilities::*;
    use Support::*;
    CapabilityRecord {
        provider: "omp".into(),
        name: "Oh My Pi".into(),
        revision: 2,
        fingerprint: String::new(),
        checked_against: "@oh-my-pi/pi-coding-agent 18.3.0 RPC".into(),
        models: ModelCapabilities {
            selection: capability(Supported, "The --model launch argument"),
            format: ModelFormat::NativeId,
            aliases: vec![],
            discovery: capability(
                Supported,
                "get_available_models when the session opens, as provider/id; get_available_thinking_levels for the model in effect",
            ),
        },
        reasoning: ReasoningCapabilities {
            selection: capability(
                NativeOnly,
                "set_thinking_level; ADE launches do not carry a reasoning level yet",
            ),
            levels: strings(&["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
            varies_by_model: true,
        },
        permission_modes: vec![mode(
            "default",
            Supported,
            "Built-in tools run without asking; an extension may ask for confirmation, shown as a request",
        )],
        grants: GrantCapabilities {
            once: capability(Supported, "Accept answers one approval request"),
            session: capability(Unknown, "Not documented in the RPC protocol"),
            persistent: capability(Unknown, "Not documented in the RPC protocol"),
        },
        conversation: ConversationCapabilities {
            steering: capability(NativeOnly, "The steer command; ADE does not send it"),
            rewind: capability(NativeOnly, "branch from an earlier entry"),
            compaction: capability(NativeOnly, "The compact command"),
            resume: capability(Supported, "Reopens the session file"),
            import: capability(
                NativeOnly,
                "Sessions are stored natively; ADE's history import reads Claude and Codex only",
            ),
            fork: capability(NativeOnly, "new_session with a parent session"),
            account_switch: capability(Unknown, "Not documented in the RPC protocol"),
        },
        quota: capability(
            Unknown,
            "Reports per-call token usage; no limit windows have been observed",
        ),
        managed_accounts: capability(Supported, "One agent directory per account"),
    }
}

/// Bun runs the worker and the bundled CLI; `ADE_OMP_BIN` replaces the CLI.
pub const INSTALLATION: &[crate::capabilities::Executable] = &[
    crate::capabilities::Executable {
        check: "runtime:bun",
        env: "ADE_BUN_BIN",
        default: Some("bun"),
        used_by: crate::capabilities::UsedBy::Every,
    },
    crate::capabilities::Executable {
        check: "executable:omp",
        env: "ADE_OMP_BIN",
        default: None,
        used_by: crate::capabilities::UsedBy::Every,
    },
];
