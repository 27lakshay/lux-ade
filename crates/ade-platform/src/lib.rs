//! Shared process diagnostics and platform resource locations.
pub mod bench;
pub mod diagnostics;
pub mod resources;
pub mod tool_paths;

#[cfg(all(target_os = "macos", feature = "native-ui"))]
pub mod terminal;

pub mod process;

pub mod ipc;
