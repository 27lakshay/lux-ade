use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub user_config: Option<String>,
    pub project_config: Option<String>,
    pub path_template: Option<String>,
    pub hooks: bool,
    pub timeout_seconds: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            user_config: None,
            project_config: None,
            path_template: None,
            hooks: false,
            timeout_seconds: 60,
        }
    }
}
