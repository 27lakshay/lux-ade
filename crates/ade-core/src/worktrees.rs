use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A repository's stored lifecycle configuration. Fields added after the
/// first release are omitted from the wire while they hold their defaults.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Parent directory for new trees; the repository's parent when absent.
    pub directory: Option<String>,
    /// Git command timeout in seconds.
    pub timeout_seconds: u64,
    /// Prefix for branches that `worktree.create` names, such as `ade/`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_prefix: Option<String>,
    /// Start point for `worktree.create` when the request names none; `HEAD`
    /// when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_base: Option<String>,
    /// Hooks run in order inside a new tree after Git creates it. The tree is
    /// ready for an Agent only after every hook exits 0.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<Hook>,
    /// Hooks run in order inside a tree before ADE removes it. A failed hook
    /// keeps the tree.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub teardown: Vec<Hook>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            directory: None,
            timeout_seconds: 60,
            branch_prefix: None,
            default_base: None,
            setup: Vec::new(),
            teardown: Vec::new(),
        }
    }
}

/// One setup or teardown hook. `command` is an argument vector run without a
/// shell; write `["sh", "-c", "…"]` to use one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Hook {
    /// A short label shown in operation results.
    pub name: String,
    pub command: Vec<String>,
    /// The hook's time limit; the daemon accepts 1 to 3600 and uses 300 when absent.
    #[serde(
        default = "default_hook_timeout",
        skip_serializing_if = "is_default_hook_timeout"
    )]
    pub timeout_seconds: u64,
}

fn default_hook_timeout() -> u64 {
    300
}

// Omitting the default keeps one schema for requests and replies.
fn is_default_hook_timeout(timeout: &u64) -> bool {
    *timeout == default_hook_timeout()
}
