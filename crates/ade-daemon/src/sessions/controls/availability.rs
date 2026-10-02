//! Which conversation controls may run, decided from facts alone (D04).
//!
//! A control other than file rewind is available only when the
//! Conversation's provider worker declares the operation that performs it
//! (`steer`, `compact`, `rewind`) available; otherwise it is unavailable with
//! the worker's own reason. Every worker-backed provider is decided the same
//! way, bundled or installed: Codex, Claude and Oh My Pi by the descriptor
//! their workers answer `initialize` with, a plugin by the operations its
//! worker declared at its last handshake, and a generic ACP adapter by the
//! descriptor its probe recorded. No provider is decided by its name. File
//! rewind runs through ADE's checkpoints for every provider.
//!
//! The mechanism reported for a worker control is the worker operation the
//! daemon calls (`worker.steer`, `worker.compact`, `worker.rewind`). Which
//! native method a worker uses for it is the worker's own business.
use ade_core::contract::conversations::{ControlAvailability, ConversationControl};
use ade_core::contract::providers::{
    ProviderWorkerAvailability, ProviderWorkerMethod, ProviderWorkerOperation,
};

/// The mechanism that performs file rewind for every provider.
pub const CHECKPOINTS: &str = "ade.checkpoints";

/// What a provider's worker declares, or why nothing is declared.
pub type Declared<'a> = Result<&'a [ProviderWorkerOperation], &'a str>;

/// What the daemon knows about a Conversation when it decides.
#[derive(Clone, Copy, Debug)]
pub struct Facts<'a> {
    pub status: &'a str,
    pub active_turn: Option<&'a str>,
    /// The daemon holds a live runtime connection to the Conversation's Agent.
    pub connected: bool,
    /// The operations the provider's worker declares, which decide its
    /// controls; or why the provider has no declaration, such as a plugin
    /// whose worker has not completed a handshake.
    pub declared: Declared<'a>,
}

/// The worker operation that performs `control`, and the mechanism name the
/// daemon reports for it.
fn operation(control: ConversationControl) -> Option<(ProviderWorkerMethod, &'static str)> {
    use ConversationControl::*;
    match control {
        Steer => Some((ProviderWorkerMethod::Steer, "worker.steer")),
        Compact => Some((ProviderWorkerMethod::Compact, "worker.compact")),
        RewindConversation => Some((ProviderWorkerMethod::Rewind, "worker.rewind")),
        RewindFiles => None,
    }
}

/// The mechanism that performs `control` for this provider, or why it has none.
pub fn native(
    declared: Declared<'_>,
    control: ConversationControl,
) -> Result<&'static str, String> {
    let Some((method, mechanism)) = operation(control) else {
        return Ok(CHECKPOINTS);
    };
    let operations = declared.map_err(str::to_owned)?;
    match operations
        .iter()
        .find(|operation| operation.method == method)
    {
        Some(operation) if operation.availability == ProviderWorkerAvailability::Available => {
            Ok(mechanism)
        }
        Some(operation) if !operation.reason.is_empty() => Err(operation.reason.clone()),
        _ => Err(format!(
            "The provider's worker does not declare {mechanism}"
        )),
    }
}

fn busy(status: &str) -> bool {
    matches!(status, "starting" | "running" | "waiting" | "cancelling")
}

/// Why the Conversation's state refuses `control` now, if it does.
fn state_refusal(facts: &Facts, control: ConversationControl) -> Option<&'static str> {
    use ConversationControl::*;
    match control {
        Steer if facts.status == "cancelling" => Some("The running turn is being cancelled"),
        Steer if !matches!(facts.status, "running" | "waiting") || facts.active_turn.is_none() => {
            Some("No turn is running; send a message instead")
        }
        Compact if busy(facts.status) => Some("A turn is running; compact when it finishes"),
        RewindFiles if busy(facts.status) => {
            Some("A turn is running; stop it before rewinding files")
        }
        RewindConversation if busy(facts.status) => {
            Some("A turn is running; stop it before rewinding the conversation")
        }
        Steer | Compact | RewindConversation if !facts.connected => {
            Some("The Agent is not connected; resume the Conversation first")
        }
        _ => None,
    }
}

/// Whether `control` may run now. Provider support is checked first, so an
/// unsupported control always reports its limitation.
pub fn decide(facts: &Facts, control: ConversationControl) -> ControlAvailability {
    let (mechanism, reason) = match native(facts.declared, control) {
        Err(reason) => (None, Some(reason)),
        Ok(mechanism) => (
            Some(mechanism.to_owned()),
            state_refusal(facts, control).map(str::to_owned),
        ),
    };
    ControlAvailability {
        control,
        available: reason.is_none(),
        mechanism,
        reason,
    }
}

/// Every control, in a fixed order.
pub const ALL: [ConversationControl; 4] = [
    ConversationControl::Steer,
    ConversationControl::Compact,
    ConversationControl::RewindConversation,
    ConversationControl::RewindFiles,
];

#[cfg(test)]
mod tests {
    use super::*;
    use ConversationControl::*;

    /// A bundled provider's declaration: the descriptor its worker answers
    /// `initialize` with.
    fn bundled(provider: &str) -> &'static [ProviderWorkerOperation] {
        use ade_runtime::provider::registry::bundled;
        let descriptor = bundled()
            .get(provider)
            .and_then(|registered| registered.entry.worker_descriptor())
            .expect("a bundled worker descriptor");
        Box::leak(descriptor.operations.into_boxed_slice())
    }

    fn facts(provider: &str, status: &'static str) -> Facts<'static> {
        Facts {
            status,
            active_turn: matches!(status, "running" | "waiting" | "cancelling").then_some("turn_1"),
            connected: true,
            declared: Ok(bundled(provider)),
        }
    }

    #[test]
    fn a_plugin_worker_gets_the_controls_it_declares_with_its_own_reasons() {
        let operation = |method, availability, reason: &str| ProviderWorkerOperation {
            method,
            tier: ade_core::contract::Tier::EffectCommand,
            availability,
            reason: reason.into(),
        };
        let declared = [
            operation(
                ProviderWorkerMethod::Steer,
                ProviderWorkerAvailability::Available,
                "",
            ),
            operation(
                ProviderWorkerMethod::Compact,
                ProviderWorkerAvailability::Unsupported,
                "This agent has no compaction",
            ),
        ];
        let plugin = |status| Facts {
            declared: Ok(&declared),
            ..facts("codex", status)
        };
        let steer = decide(&plugin("running"), Steer);
        assert!(steer.available);
        assert_eq!(steer.mechanism.as_deref(), Some("worker.steer"));
        assert_eq!(
            decide(&plugin("ready"), Compact).reason.as_deref(),
            Some("This agent has no compaction")
        );
        assert!(
            decide(&plugin("ready"), RewindConversation)
                .reason
                .unwrap()
                .contains("does not declare worker.rewind")
        );
        // Without a declaration nothing is claimed, and the reason says why.
        let unknown = Facts {
            declared: Err("The worker has not completed its handshake"),
            ..facts("codex", "ready")
        };
        assert_eq!(
            decide(&unknown, Compact).reason.as_deref(),
            Some("The worker has not completed its handshake")
        );
        assert!(decide(&unknown, RewindFiles).available);
    }

    #[test]
    fn bundled_controls_are_exactly_what_their_workers_declare() {
        for provider in ["codex", "claude", "omp"] {
            let operations = bundled(provider);
            for control in [Steer, Compact, RewindConversation] {
                let (method, mechanism) = operation(control).unwrap();
                let declared = operations
                    .iter()
                    .find(|operation| operation.method == method)
                    .unwrap();
                let status = if control == Steer { "running" } else { "ready" };
                let decided = decide(&facts(provider, status), control);
                if declared.availability == ProviderWorkerAvailability::Available {
                    assert!(decided.available, "{provider} {control:?}");
                    assert_eq!(decided.mechanism.as_deref(), Some(mechanism));
                } else {
                    assert!(!decided.available, "{provider} {control:?}");
                    assert!(decided.mechanism.is_none());
                    // Every bundled worker names why it does not perform a control.
                    assert!(!declared.reason.is_empty(), "{provider} {control:?}");
                    assert_eq!(decided.reason.as_deref(), Some(declared.reason.as_str()));
                }
            }
        }
    }

    #[test]
    fn bundled_workers_declare_the_controls_they_implement() {
        let available = |provider, control| {
            let status = if control == Steer { "running" } else { "ready" };
            decide(&facts(provider, status), control).available
        };
        assert!(available("codex", Steer));
        assert!(available("codex", Compact));
        assert!(available("codex", RewindConversation));
        assert!(!available("claude", Steer));
        assert!(!available("claude", Compact));
        assert!(available("claude", RewindConversation));
        assert!(!available("omp", Steer));
        assert!(available("omp", Compact));
        assert!(!available("omp", RewindConversation));
    }

    #[test]
    fn steering_needs_a_running_turn_and_never_becomes_a_queued_message() {
        for status in ["ready", "idle", "starting", "interrupted", "error"] {
            let steer = decide(&facts("codex", status), Steer);
            assert!(!steer.available, "{status}");
            assert_eq!(
                steer.reason.as_deref(),
                Some("No turn is running; send a message instead")
            );
        }
        let cancelling = decide(&facts("codex", "cancelling"), Steer);
        assert_eq!(
            cancelling.reason.as_deref(),
            Some("The running turn is being cancelled")
        );
        let no_turn = Facts {
            active_turn: None,
            ..facts("codex", "running")
        };
        assert!(!decide(&no_turn, Steer).available);
    }

    #[test]
    fn conversation_rewind_runs_only_on_an_idle_connected_agent() {
        for provider in ["claude", "codex"] {
            let decided = decide(&facts(provider, "ready"), RewindConversation);
            assert!(decided.available);
            assert_eq!(decided.mechanism.as_deref(), Some("worker.rewind"));
            for status in ["running", "waiting", "starting", "cancelling"] {
                let busy = decide(&facts(provider, status), RewindConversation);
                assert!(!busy.available, "{status}");
                assert!(busy.reason.unwrap().contains("stop it before rewinding"));
            }
            let disconnected = Facts {
                connected: false,
                ..facts(provider, "ready")
            };
            assert!(
                decide(&disconnected, RewindConversation)
                    .reason
                    .unwrap()
                    .contains("not connected")
            );
        }
    }

    #[test]
    fn file_rewind_uses_checkpoints_only_while_no_turn_runs() {
        for provider in ["codex", "claude", "omp"] {
            let idle = decide(&facts(provider, "ready"), RewindFiles);
            assert!(idle.available, "{provider}");
            assert_eq!(idle.mechanism.as_deref(), Some(CHECKPOINTS));
            assert!(!decide(&facts(provider, "running"), RewindFiles).available);
        }
        // A disconnected Agent cannot write files, so file rewind still runs.
        let disconnected = Facts {
            connected: false,
            ..facts("claude", "interrupted")
        };
        assert!(decide(&disconnected, RewindFiles).available);
    }

    #[test]
    fn native_controls_need_a_connected_agent_outside_a_terminal() {
        let disconnected = Facts {
            connected: false,
            ..facts("codex", "running")
        };
        assert!(
            decide(&disconnected, Steer)
                .reason
                .unwrap()
                .contains("not connected")
        );
        assert!(
            !decide(
                &Facts {
                    connected: false,
                    ..facts("codex", "ready")
                },
                Compact
            )
            .available
        );
    }
}
