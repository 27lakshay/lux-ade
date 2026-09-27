use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A repository's stored lifecycle configuration.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Parent directory for new trees; the repository's parent when absent.
    pub directory: Option<String>,
    /// Git command timeout in seconds.
    pub timeout_seconds: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            directory: None,
            timeout_seconds: 60,
        }
    }
}
