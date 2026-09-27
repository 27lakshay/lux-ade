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
                Some(kept) if kept == REDACTED => {
                    bail!("Secret {key} was withheld from a backup; send its value")
                }
                Some(kept) => value.clone_from(kept),
                None => bail!("Secret {key} has no stored value; send its value"),
            }
        }
        Ok(())
    }
    /// Refuses a launch while any secret value is withheld. A backup stores
    /// [`REDACTED`] in place of each secret value, so a restored service has
    /// no value to give its process until its secrets are configured again.
    pub fn ensure_secrets_present(&self) -> Result<()> {
        if let Some(key) = self
            .secret_env
            .iter()
            .find(|key| self.env.get(*key).is_some_and(|value| value == REDACTED))
        {
            bail!(
                "Secret {key} was withheld from a backup; configure its value before starting the service"
            );
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

/// The secret names of a stored service record and its `config.env`. A
/// malformed record is refused, so a caller never treats an unreadable secret
/// list as "no secrets".
type StoredEnv<'a> = Option<&'a mut serde_json::Map<String, serde_json::Value>>;
fn stored_secrets(record: &mut serde_json::Value) -> Result<(Vec<String>, StoredEnv<'_>)> {
    let config = record
        .get_mut("config")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("Stored service has no configuration"))?;
    let names = match config.get("secret_env") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| anyhow::anyhow!("Stored service secret names are invalid"))?,
        Some(_) => bail!("Stored service secret names are invalid"),
    };
    let env = match config.get_mut("env") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(env)) => Some(env),
        Some(_) => bail!("Stored service environment is invalid"),
    };
    Ok((names, env))
}

/// Replaces each secret value in a stored service record (the JSON a profile
/// database holds) with [`REDACTED`]. A backup applies it to its copy, so a
/// bundle never carries a secret; every other field is left as stored.
pub fn withhold_secret_values(record: &mut serde_json::Value) -> Result<()> {
    let (names, env) = stored_secrets(record)?;
    if let Some(env) = env {
        for name in names {
            if let Some(value) = env.get_mut(&name) {
                *value = serde_json::Value::String(REDACTED.into());
            }
        }
    }
    Ok(())
}

/// Whether a stored service record still holds a secret value, that is a
/// secret whose value is anything but [`REDACTED`]. A malformed record counts
/// as holding one.
pub fn holds_secret_values(record: &serde_json::Value) -> bool {
    let mut record = record.clone();
    let Ok((names, env)) = stored_secrets(&mut record) else {
        return true;
    };
    let Some(env) = env else {
        return false;
    };
    names
        .iter()
        .any(|name| env.get(name).is_some_and(|value| value != REDACTED))
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

    #[test]
    fn a_backup_copy_withholds_every_secret_value_and_a_restored_service_cannot_start_until_resent()
    {
        let stored = config(&[("TOKEN", "s3cret"), ("MODE", "dev")], &["TOKEN"]);
        let mut record = serde_json::json!({"name": "api", "revision": 3, "config": stored});
        assert!(holds_secret_values(&record));
        withhold_secret_values(&mut record).unwrap();
        assert!(!holds_secret_values(&record));
        assert!(!record.to_string().contains("s3cret"));
        assert_eq!(record["config"]["env"]["MODE"], "dev");
        assert_eq!(record["revision"], 3);

        // The restored service reads back, refuses to start, and refuses a
        // re-save that would keep the withheld placeholder.
        let restored: Config = serde_json::from_value(record["config"].clone()).unwrap();
        let error = restored.ensure_secrets_present().unwrap_err().to_string();
        assert!(error.contains("Secret TOKEN was withheld"), "{error}");
        let error = restored
            .redacted()
            .keep_secrets(Some(&restored))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Secret TOKEN was withheld"), "{error}");
        // Sending the value again makes it launchable.
        let mut resent = config(&[("TOKEN", "n3w"), ("MODE", "dev")], &["TOKEN"]);
        resent.keep_secrets(Some(&restored)).unwrap();
        resent.ensure_secrets_present().unwrap();
        stored.ensure_secrets_present().unwrap();

        // A service without secrets is unchanged; a malformed secret list
        // is refused rather than read as "no secrets".
        let mut plain = serde_json::json!({"config": config(&[("MODE", "dev")], &[])});
        let before = plain.clone();
        withhold_secret_values(&mut plain).unwrap();
        assert_eq!(plain, before);
        assert!(!holds_secret_values(&plain));
        let mut malformed = serde_json::json!({"config": {"env": {"T": "x"}, "secret_env": "T"}});
        assert!(withhold_secret_values(&mut malformed).is_err());
        assert!(holds_secret_values(&malformed));
    }
}
