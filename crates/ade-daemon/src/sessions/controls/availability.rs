//! Which conversation controls may run, decided from facts alone (D04).
//!
//! A control is available only when the Conversation's provider adapter
//! performs it through a native method, or, for file rewind, when ADE's
//! checkpoints do. The table below records what each adapter in
//! `crates/ade-runtime` actually calls today, checked against the pinned
//! provider protocols: Codex 0.157.0 app-server, Claude Agent SDK 0.3.281,
//! Oh My Pi 18.3.0 RPC and ADE's OpenCode v2 bridge. A protocol method that
//! the adapter does not call is unavailable, and the reason says so.
use ade_core::contract::conversations::{ControlAvailability, ConversationControl};

/// The mechanism that performs file rewind for every provider.
pub const CHECKPOINTS: &str = "ade.checkpoints";

/// What the daemon knows about a Conversation when it decides.
#[derive(Clone, Copy, Debug)]
pub struct Facts<'a> {
    pub provider: &'a str,
    pub status: &'a str,
    pub active_turn: Option<&'a str>,
    /// The daemon holds a live runtime connection to the Conversation's Agent.
    pub connected: bool,
    /// The Conversation was handed to a terminal, which the daemon cannot steer.
    pub terminal_owned: bool,
}

/// The native method an adapter calls for `control`, or why it has none.
pub fn native(provider: &str, control: ConversationControl) -> Result<&'static str, String> {
    use ConversationControl::*;
    let missing = |text: &str| Err(text.to_owned());
    match (provider, control) {
        (_, RewindFiles) => Ok(CHECKPOINTS),
        ("codex", Steer) => Ok("turn/steer"),
        ("codex", Compact) => Ok("thread/compact/start"),
        ("codex", RewindConversation) => missing(
            "Codex removed thread/rollback, and thread/revert rewrites only paginated threads while ADE's adapter starts legacy ones; thread/fork at an earlier turn exists but ADE's adapter does not call it",
        ),
        ("claude", Steer) => {
            missing("ADE's Claude adapter admits one turn at a time and has no native steer path")
        }
        ("claude", Compact) => {
            missing("ADE's Claude adapter does not issue Claude Code's compaction command yet")
        }
        ("claude", RewindConversation) => Ok("claude.fork_session"),
        ("omp", Steer) => missing(
            "Oh My Pi RPC has steer, but ADE's adapter cannot yet bind a steered entry to its submission ledger",
        ),
        ("omp", Compact) => {
            missing("Oh My Pi RPC has compact, but ADE's adapter does not call it yet")
        }
        ("omp", RewindConversation) => {
            missing("Oh My Pi RPC has branch, but ADE's adapter does not call it yet")
        }
        ("opencode", Steer) => missing("ADE's OpenCode adapter has no native steer path"),
        ("opencode", Compact) => {
            missing("ADE's OpenCode adapter does not call OpenCode's compaction yet")
        }
        ("opencode", RewindConversation) => {
            missing("ADE's OpenCode adapter does not call OpenCode's revert yet")
        }
        (adapter, control) if adapter.starts_with("adapter:") => match control {
            Steer => missing(
                "Generic ACP and custom executable adapters have no native steer path; ACP v1 has no steer method",
            ),
            Compact => missing(
                "Generic adapters cannot compact: ACP v1 has no compaction method, and a custom executable has none",
            ),
            _ => missing("Generic adapters cannot resume at an earlier message"),
        },
        (plugin, control) if plugin.starts_with("plugin:") => match control {
            Steer => missing(
                "ADE does not admit steering for provider plugin workers yet; their handshake is not checked before admission",
            ),
            Compact => missing("The provider worker protocol v1 has no compaction method"),
            _ => missing("The provider worker protocol v1 cannot resume at an earlier message"),
        },
        (other, _) => Err(format!("Unknown provider {other}")),
    }
}

fn busy(status: &str) -> bool {
    matches!(status, "starting" | "running" | "waiting" | "cancelling")
}

/// Why the Conversation's state refuses `control` now, if it does.
fn state_refusal(facts: &Facts, control: ConversationControl) -> Option<&'static str> {
    use ConversationControl::*;
    if facts.terminal_owned {
        return Some("The Conversation runs in a terminal; ADE does not control it there");
    }
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
    let (mechanism, reason) = match native(facts.provider, control) {
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

    fn facts(provider: &'static str, status: &'static str) -> Facts<'static> {
        Facts {
            provider,
            status,
            active_turn: matches!(status, "running" | "waiting" | "cancelling").then_some("turn_1"),
            connected: true,
            terminal_owned: false,
        }
    }

    #[test]
    fn codex_steers_a_running_turn_and_compacts_when_idle() {
        let steer = decide(&facts("codex", "running"), Steer);
        assert!(steer.available);
        assert_eq!(steer.mechanism.as_deref(), Some("turn/steer"));
        assert!(decide(&facts("codex", "waiting"), Steer).available);
        let compact = decide(&facts("codex", "ready"), Compact);
        assert!(compact.available);
        assert_eq!(compact.mechanism.as_deref(), Some("thread/compact/start"));
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
    fn unsupported_providers_report_their_limitation_whatever_the_state() {
        for provider in ["claude", "omp", "opencode"] {
            for status in ["running", "ready"] {
                for control in [Steer, Compact, RewindConversation] {
                    if provider == "claude" && control == RewindConversation {
                        continue;
                    }
                    let decided = decide(&facts(provider, status), control);
                    assert!(!decided.available, "{provider} {status} {control:?}");
                    assert!(decided.mechanism.is_none());
                    assert!(decided.reason.unwrap().contains("adapter"));
                }
            }
        }
        let unknown = decide(&facts("gemini", "running"), Steer);
        assert_eq!(unknown.reason.as_deref(), Some("Unknown provider gemini"));
        // Adapters and plugin workers name their own limitation, not an unknown provider.
        for provider in ["adapter:my-agent", "plugin:e2e.agent"] {
            for control in [Steer, Compact, RewindConversation] {
                let decided = decide(&facts(provider, "running"), control);
                assert!(!decided.available);
                assert!(!decided.reason.unwrap().starts_with("Unknown provider"));
            }
            assert!(decide(&facts(provider, "ready"), RewindFiles).available);
        }
    }

    #[test]
    fn conversation_rewind_runs_only_on_an_idle_connected_claude_agent() {
        for provider in ["codex", "omp", "opencode"] {
            assert!(!decide(&facts(provider, "ready"), RewindConversation).available);
        }
        let claude = decide(&facts("claude", "ready"), RewindConversation);
        assert!(claude.available);
        assert_eq!(claude.mechanism.as_deref(), Some("claude.fork_session"));
        for status in ["running", "waiting", "starting", "cancelling"] {
            let busy = decide(&facts("claude", status), RewindConversation);
            assert!(!busy.available, "{status}");
            assert!(busy.reason.unwrap().contains("stop it before rewinding"));
        }
        let disconnected = Facts {
            connected: false,
            ..facts("claude", "ready")
        };
        assert!(
            decide(&disconnected, RewindConversation)
                .reason
                .unwrap()
                .contains("not connected")
        );
    }

    #[test]
    fn file_rewind_uses_checkpoints_only_while_no_turn_runs() {
        for provider in ["codex", "claude", "omp", "opencode"] {
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
        let terminal = Facts {
            terminal_owned: true,
            ..facts("codex", "ready")
        };
        for control in [Steer, Compact, RewindFiles] {
            assert!(!decide(&terminal, control).available);
        }
    }
}
