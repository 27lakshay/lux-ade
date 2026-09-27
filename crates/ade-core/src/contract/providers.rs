//! Provider capability and preset contracts.
//!
//! [`adapters`] holds the profile-scoped generic adapter definitions (F024).
use super::{FrameSpec, OperationSpec};

pub mod adapters;

pub fn operations() -> Vec<OperationSpec> {
    let mut operations = vec![];
    operations.extend(adapters::operations());
    operations
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}
