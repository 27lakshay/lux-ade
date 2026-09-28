//! Shared lux-ade models and wire contracts. No GUI, native, or process dependencies.
#![forbid(unsafe_code)]

pub mod contract;
pub mod credentials;
pub mod layout;
pub mod model;
pub mod prompt;
pub mod prompt_context;
pub mod protocol;
pub mod provider;
pub mod review_prompt;
pub mod runtime_protocol;
pub mod transcript;

pub mod scripts;
pub mod services;
pub mod terminal_launch;
pub mod workspaces;
pub mod worktrees;

pub mod diagnostics;
pub mod error;
pub mod mcp;
