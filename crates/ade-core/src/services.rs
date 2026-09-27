use anyhow::{Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::{Component, Path, PathBuf},
};

/// Inlined in schemas: a request's defaults make its required fields differ
/// from a reply's, so the two cannot share one named definition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct Config {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Names of `env` entries whose values are secret. Replies show each one
    /// as [`REDACTED`]; sending [`REDACTED`] back keeps the stored value.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub secret_env: BTreeSet<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    /// Environment variables that receive stable, host-local TCP ports.
    #[serde(default)]
    pub ports: Vec<String>,
    /// Environment variables populated from another managed service in this workspace.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub peers: BTreeMap<String, PeerEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<HealthPolicy>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PeerEndpoint {
    pub service: String,
    pub port_variable: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HealthPolicy {
    pub port_variable: String,
    pub path: String,
    pub timeout_ms: u64,
    pub interval_ms: u64,
}
/// What replies show in place of a secret environment value.
pub const REDACTED: &str = "[redacted]";
fn default_cwd() -> String {
    ".".into()
}
fn env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !matches!(value, "TERM" | "COLORTERM")
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}
fn text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.program.is_empty() && text(&self.program, 4096),
            "Invalid service executable"
        );
        ensure!(
            self.args.len() <= 64 && self.args.iter().all(|v| text(v, 8192)),
            "Invalid service arguments"
        );
        ensure!(
            self.env.len() <= 64
                && self
                    .env
                    .iter()
                    .all(|(k, v)| env_name(k) && !k.starts_with("ADE_") && text(v, 8192)),
            "Invalid service environment"
        );
        ensure!(
            self.secret_env.iter().all(|k| self.env.contains_key(k)),
            "Secret service environment names must be configured environment variables"
        );
        ensure!(
            self.ports.len() <= 8
                && self
                    .ports
                    .iter()
                    .all(|k| env_name(k) && !k.starts_with("ADE_") && !self.env.contains_key(k)),
            "Invalid service port variables"
        );
        ensure!(
            self.ports.iter().collect::<HashSet<_>>().len() == self.ports.len(),
            "Duplicate service port variable"
        );
        ensure!(
            self.peers.len() <= 16
                && self.peers.iter().all(|(variable, peer)| {
                    env_name(variable)
                        && !variable.starts_with("ADE_")
                        && !self.env.contains_key(variable)
                        && !self.ports.contains(variable)
                        && !peer.service.is_empty()
                        && peer.service.len() <= 40
                        && !peer.service.starts_with('-')
                        && !peer.service.ends_with('-')
                        && peer.service.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                        && env_name(&peer.port_variable)
                }),
            "Invalid peer service endpoints or environment variables"
        );
        if let Some(health) = &self.health {
            ensure!(
                self.ports.contains(&health.port_variable),
                "HTTP health port variable must be a configured service port"
            );
            ensure!(
                health.path.starts_with('/')
                    && health.path.len() <= 1024
                    && health
                        .path
                        .bytes()
                        .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'#'),
                "HTTP health path must be a visible ASCII path of at most 1024 bytes"
            );
            ensure!(
                (50..=2000).contains(&health.timeout_ms),
                "HTTP health timeout must be 50 to 2000 ms"
            );
            ensure!(
                (250..=60000).contains(&health.interval_ms)
                    && health.interval_ms > health.timeout_ms,
                "HTTP health interval must be 250 to 60000 ms and exceed timeout"
            );
        }
        ensure!(
            text(&self.cwd, 4096)
                && !self.cwd.is_empty()
                && Path::new(&self.cwd)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
            "Service directory must be relative to its workspace"
        );
        ensure!(
            serde_json::to_vec(self)?.len() <= 64 * 1024,
            "Service definition exceeds 64 KiB"
        );
        Ok(())
    }
    /// This configuration as replies show it: secret values replaced by
    /// [`REDACTED`].
    pub fn redacted(&self) -> Self {
        let mut shown = self.clone();
        for key in &self.secret_env {
            if let Some(value) = shown.env.get_mut(key) {
                *value = REDACTED.into();
            }
        }
        shown
    }
    /// Replaces each secret value sent as [`REDACTED`] with the value stored
    /// for it, so a client can save a configuration it read without knowing
    /// its secrets. A secret with no stored value is refused, never saved as
    /// the placeholder.
    pub fn keep_secrets(&mut self, stored: Option<&Config>) -> Result<()> {
        for key in &self.secret_env {
            let Some(value) = self.env.get_mut(key) else {
                continue;
            };
            if value != REDACTED {
                continue;
            }
            match stored
                .filter(|stored| stored.secret_env.contains(key))
                .and_then(|stored| stored.env.get(key))
            {
                Some(kept) => value.clone_from(kept),
                None => bail!("Secret {key} has no stored value; send its value"),
            }
        }
        Ok(())
    }
    pub fn directory(&self, root: &str) -> Result<PathBuf> {
        self.validate()?;
        let root = Path::new(root).canonicalize()?;
        let directory = root.join(&self.cwd).canonicalize()?;
        ensure!(
            directory.starts_with(&root) && directory.is_dir(),
            "Service directory escapes its workspace or is unavailable"
        );
        Ok(directory)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Service {
    /// Durable incarnation; a removed service with the same name gets a new ID.
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub terminal_owner: Option<crate::model::TerminalOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_transfer_id: Option<String>,
    pub workspace_id: String,
    pub name: String,
    pub revision: i64,
    pub config: Config,
    pub ports: BTreeMap<String, u16>,
    pub hostname: String,
    /// URLs placed in the environment of the currently reserved service run.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub launch_peers: BTreeMap<String, String>,
}
impl Service {
    /// This service as replies and feed frames show it; see [`Config::redacted`].
    pub fn redacted(&self) -> Self {
        Self {
            config: self.config.redacted(),
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(env: &[(&str, &str)], secret: &[&str]) -> Config {
        Config {
            program: "serve".into(),
            args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            secret_env: secret.iter().map(|k| k.to_string()).collect(),
            cwd: ".".into(),
            ports: Vec::new(),
            peers: BTreeMap::new(),
            health: None,
        }
    }

    #[test]
    fn secret_values_are_redacted_and_kept_only_from_a_stored_secret() {
        let stored = config(&[("TOKEN", "s3cret"), ("MODE", "dev")], &["TOKEN"]);
        stored.validate().unwrap();
        let shown = stored.redacted();
        assert_eq!(shown.env["TOKEN"], REDACTED);
        assert_eq!(shown.env["MODE"], "dev");
        assert!(!serde_json::to_string(&shown).unwrap().contains("s3cret"));

        // Saving what was shown keeps the stored secret.
        let mut edited = shown.clone();
        edited.env.insert("MODE".into(), "prod".into());
        edited.keep_secrets(Some(&stored)).unwrap();
        assert_eq!(edited.env["TOKEN"], "s3cret");
        // A new value replaces it.
        let mut replaced = config(&[("TOKEN", "n3w")], &["TOKEN"]);
        replaced.keep_secrets(Some(&stored)).unwrap();
        assert_eq!(replaced.env["TOKEN"], "n3w");
        // The placeholder never becomes a stored value.
        assert!(shown.clone().keep_secrets(None).is_err());
        let plain = config(&[("TOKEN", "visible")], &[]);
        assert!(shown.clone().keep_secrets(Some(&plain)).is_err());
        // A secret name must be a configured variable.
        assert!(config(&[], &["TOKEN"]).validate().is_err());
    }
}
