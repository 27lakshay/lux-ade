use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub directory: Option<String>,
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
