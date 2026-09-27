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
    /// Ignored local resources, such as `.env` files or `node_modules`, and
    /// how each reaches a tree ADE creates. Nothing ignored is copied or
    /// linked unless a rule names it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ResourceRule>,
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
            resources: Vec::new(),
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

/// How an ignored resource of the primary checkout reaches a tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceMode {
    /// An independent copy; the tree owns it and removal deletes it.
    Copy,
    /// A symbolic link to the primary checkout's resource, which stays
    /// externally owned: removing the tree removes only the link.
    Link,
    /// Recorded and reported, never materialized.
    Skip,
}

/// One ignored-resource rule. `path` is a literal path relative to the
/// repository root: no globs, no `..`, not inside `.git`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceRule {
    pub path: String,
    pub mode: ResourceMode,
}
