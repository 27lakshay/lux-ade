//! Explicit executable launch shared by native agents and workspace services.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub transfer_id: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
}
impl Launch {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.transfer_id.is_empty() && self.transfer_id.len() <= 256,
            "Invalid transfer identity"
        );
        ensure!(
            !self.program.is_empty() && self.program.len() <= 4096 && !self.program.contains('\0'),
            "Invalid terminal executable"
        );
        ensure!(
            self.args.len() <= 64
                && self
                    .args
                    .iter()
                    .all(|s| s.len() <= 8192 && !s.contains('\0')),
            "Invalid terminal arguments"
        );
        ensure!(
            self.env.len() <= 80
                && self.env.iter().all(|(key, value)| !key.is_empty()
                    && key.len() <= 128
                    && !key.contains(['=', '\0'])
                    && value.len() <= 8192
                    && !value.contains('\0')),
            "Invalid terminal environment"
        );
        ensure!(
            self.cwd
                .as_ref()
                .is_none_or(|cwd| !cwd.is_empty() && cwd.len() <= 4096 && !cwd.contains('\0')),
            "Invalid terminal directory"
        );
        ensure!(
            serde_json::to_vec(self)?.len() <= 96 * 1024,
            "Terminal launch exceeds 96 KiB"
        );
        Ok(())
    }
}
