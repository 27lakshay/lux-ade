//! Profile settings (F013, F014, F015): appearance, motion, typography and
//! keybindings. They are durable profile state, so every client applies the
//! same preferences. The operations arrive with the daemon authority work
//! (`.scratch/daemon-authority/issues/03-lane-catalog-workspaces.md`).
use super::{FrameSpec, OperationSpec};

pub fn operations() -> Vec<OperationSpec> {
    vec![]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}
