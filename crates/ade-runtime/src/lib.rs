//! Persistent processes and provider transport; no database or UI dependencies.
pub use ade_core::{model, prompt, terminal_launch, transcript};
pub use ade_platform::diagnostics;
pub mod adapters;
mod agent_budget;
pub mod agent_runtime;
pub mod capabilities;
pub mod claude;
pub mod codex;
pub mod descendants;
pub mod foreground;
pub mod ghostty_colors;
pub mod omp;
pub mod provider;
pub mod rpc;
pub mod runtime;
pub mod service_logs;
pub mod terminal_ownership;
