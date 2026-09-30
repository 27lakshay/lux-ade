//! Current-format coordinated packs contain complete, independently selectable definitions.
use super::definition::ThemeDefinition;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_PACK_BYTES: usize = 512 * 1024;
pub const MAX_PACK_MEMBERS: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ThemePackIdentity {
    pub id: String,
    pub name: String,
}

impl ThemePackIdentity {
    pub fn valid(&self) -> bool {
        super::definition::valid_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.len() <= 256
            && !self.name.chars().any(char::is_control)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemePack {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub themes: Vec<ThemeDefinition>,
}
