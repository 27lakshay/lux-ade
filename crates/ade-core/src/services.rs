use crate::credentials::CredentialReference;
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
    /// Names of `env` entries whose values are secret. ADE never stores or
    /// returns their values: each shows as [`REDACTED`], and sending
    /// [`REDACTED`] back keeps the stored reference. A value sent here is
    /// moved into the Keychain and replaced by a reference in `secret_refs`.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub secret_env: BTreeSet<String>,
    /// Where each secret's value lives. Resolved only when the service
    /// launches; a reference that cannot be resolved refuses the start before
    /// anything is reserved. A secret with no reference was withheld by a
    /// backup and must be sent again.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secret_refs: BTreeMap<String, CredentialReference>,
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
            self.secret_env
                .iter()
                .all(|k| self.env.contains_key(k) || self.secret_refs.contains_key(k)),
            "Secret service environment names must be configured environment variables"
        );
        ensure!(
            self.secret_refs.len() <= 64,
            "Invalid service secret references"
        );
        for (key, reference) in &self.secret_refs {
            ensure!(
                env_name(key)
                    && !key.starts_with("ADE_")
                    && !self.ports.contains(key)
                    && !self.peers.contains_key(key),
                "Invalid service secret reference name {key}"
            );
            reference.validate()?;
            ensure!(
                self.env.get(key).is_none_or(|value| value == REDACTED),
                "Secret {key} was sent with both a value and a reference; send one"
            );
        }
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
    /// Decides what `service.configure` does with the secrets it was sent,
    /// against the stored configuration. Afterwards every secret shows as
    /// [`REDACTED`] in `env` and has a reference in `secret_refs`, except the
    /// ones returned: values the daemon must move into the Keychain before it
    /// saves. A secret sent as [`REDACTED`] keeps its stored reference, or a
    /// value stored before references existed; with neither it is refused, so
    /// the placeholder never stands in for a value.
    pub fn plan_secrets(&mut self, stored: Option<&Config>) -> Result<Vec<(String, String)>> {
        for (key, reference) in &self.secret_refs {
            if self.env.get(key).is_some_and(|value| value != REDACTED) {
                bail!("Secret {key} was sent with both a value and a reference; send one");
            }
            // ADE deletes the items it owns when a secret changes, so one
            // may only be kept by the secret it was made for, never shared.
            if reference.ade_owned()
                && stored
                    .filter(|stored| stored.secret_env.contains(key))
                    .and_then(|stored| stored.secret_refs.get(key))
                    != Some(reference)
            {
                bail!(
                    "Secret {key} names a Keychain item ADE made for another secret; send the value or your own reference"
                );
            }
            self.secret_env.insert(key.clone());
            self.env.insert(key.clone(), REDACTED.into());
        }
        let mut pending = Vec::new();
        for key in &self.secret_env {
            if self.secret_refs.contains_key(key) {
                continue;
            }
            let Some(value) = self.env.get_mut(key) else {
                bail!("Secret service environment names must be configured environment variables");
            };
            if value != REDACTED {
                pending.push((key.clone(), std::mem::replace(value, REDACTED.into())));
                continue;
            }
            let stored = stored.filter(|stored| stored.secret_env.contains(key));
            if let Some(reference) = stored.and_then(|stored| stored.secret_refs.get(key)) {
                self.secret_refs.insert(key.clone(), reference.clone());
                continue;
            }
            match stored.and_then(|stored| stored.env.get(key)) {
                Some(kept) if kept == REDACTED => {
                    bail!("Secret {key} was withheld from a backup; send its value")
                }
                // A value stored before references existed moves into the
                // Keychain on this save.
                Some(kept) => pending.push((key.clone(), kept.clone())),
                None => bail!("Secret {key} has no stored value; send its value"),
            }
        }
        Ok(pending)
    }
    /// The secrets a stored record still holds in plain text: values saved
    /// before references existed. Opening the profile moves each into the
    /// Keychain.
    pub fn legacy_secret_values(&self) -> Vec<(String, String)> {
        self.secret_env
            .iter()
            .filter(|key| !self.secret_refs.contains_key(*key))
            .filter_map(|key| {
                let value = self.env.get(key)?;
                (value != REDACTED).then(|| (key.clone(), value.clone()))
            })
            .collect()
    }
    /// Refuses a launch while any secret has no reference. A backup drops the
    /// references to items ADE owns, so a restored service has nothing to
    /// resolve until its secrets are configured again. A value still stored
    /// in plain text is never launched from the database.
    pub fn ensure_secrets_present(&self) -> Result<()> {
        for key in &self.secret_env {
            if self.secret_refs.contains_key(key) {
                continue;
            }
            if self.env.get(key).is_some_and(|value| value == REDACTED) {
                bail!(
                    "Secret {key} was withheld from a backup; configure its value before starting the service"
                );
            }
            bail!(
                "Secret {key} is still stored in plain text because it could not be moved to the Keychain; configure its value before starting the service"
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
/// database holds) with [`REDACTED`], and drops each reference to a Keychain
/// item ADE owns. A backup applies it to its copy, so a bundle never carries
/// a secret and a restored profile never shares the source profile's items;
/// a reference the user made (an environment variable or their own Keychain
/// item) is kept. Every other field is left as stored.
pub fn withhold_secret_values(record: &mut serde_json::Value) -> Result<()> {
    let (names, env) = stored_secrets(record)?;
    if let Some(env) = env {
        for name in names {
            if let Some(value) = env.get_mut(&name) {
                *value = serde_json::Value::String(REDACTED.into());
            }
        }
    }
    let config = record
        .get_mut("config")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("Stored service has no configuration"))?;
    match config.get_mut("secret_refs") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(references)) => {
            let mut owned = Vec::new();
            for (name, reference) in references.iter() {
                let reference: CredentialReference = serde_json::from_value(reference.clone())
                    .map_err(|_| anyhow::anyhow!("Stored service secret references are invalid"))?;
                if reference.ade_owned() {
                    owned.push(name.clone());
                }
            }
            for name in owned {
                references.remove(&name);
            }
            if references.is_empty() {
                config.remove("secret_refs");
            }
        }
        Some(_) => bail!("Stored service secret references are invalid"),
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
    use crate::credentials::ADE_KEYCHAIN_SERVICE;

    fn config(env: &[(&str, &str)], secret: &[&str]) -> Config {
        Config {
            program: "serve".into(),
            args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            secret_env: secret.iter().map(|k| k.to_string()).collect(),
            secret_refs: BTreeMap::new(),
            cwd: ".".into(),
            ports: Vec::new(),
            peers: BTreeMap::new(),
            health: None,
        }
    }

    fn owned(account: &str) -> CredentialReference {
        CredentialReference::Keychain {
            service: ADE_KEYCHAIN_SERVICE.into(),
            account: account.into(),
        }
    }

    /// A configuration as the daemon saves it: each secret's value moved to
    /// the Keychain item `account`.
    fn saved(mut config: Config, stored: Option<&Config>, account: &str) -> Config {
        for (key, _) in config.plan_secrets(stored).unwrap() {
            config.secret_refs.insert(key, owned(account));
        }
        config
    }

    #[test]
    fn secret_values_are_redacted_and_kept_only_from_a_stored_secret() {
        // A sent value is handed to the daemon to move into the Keychain and
        // never stays in the configuration.
        let mut sent = config(&[("TOKEN", "s3cret"), ("MODE", "dev")], &["TOKEN"]);
        sent.validate().unwrap();
        let pending = sent.plan_secrets(None).unwrap();
        assert_eq!(pending, vec![("TOKEN".into(), "s3cret".into())]);
        assert_eq!(sent.env["TOKEN"], REDACTED);
        assert_eq!(sent.env["MODE"], "dev");
        assert!(!serde_json::to_string(&sent).unwrap().contains("s3cret"));
        sent.secret_refs.insert("TOKEN".into(), owned("a"));
        sent.validate().unwrap();
        let stored = sent;
        stored.ensure_secrets_present().unwrap();
        assert_eq!(stored.redacted(), stored);

        // Saving what was shown keeps the stored reference and converges.
        let mut edited = stored.redacted();
        assert!(edited.plan_secrets(Some(&stored)).unwrap().is_empty());
        assert_eq!(edited, stored);
        edited.env.insert("MODE".into(), "prod".into());
        assert!(edited.plan_secrets(Some(&stored)).unwrap().is_empty());
        assert_eq!(edited.secret_refs["TOKEN"], owned("a"));
        // A new value replaces it.
        let mut replaced = config(&[("TOKEN", "n3w")], &["TOKEN"]);
        assert_eq!(
            replaced.plan_secrets(Some(&stored)).unwrap(),
            vec![("TOKEN".into(), "n3w".into())]
        );
        // The placeholder never becomes a stored value.
        let mut placeholder = stored.redacted();
        placeholder.secret_refs.clear();
        assert!(placeholder.plan_secrets(None).is_err());
        // ADE's own item is kept only by the secret it was made for.
        let mut copied = config(&[], &[]);
        copied.secret_refs.insert("OTHER".into(), owned("a"));
        assert!(copied.clone().plan_secrets(Some(&stored)).is_err());
        assert!(copied.plan_secrets(None).is_err());
        let plain = config(&[("TOKEN", "visible")], &[]);
        let mut marked = config(&[("TOKEN", REDACTED)], &["TOKEN"]);
        assert!(marked.plan_secrets(Some(&plain)).is_err());
        // A secret name must be a configured variable or reference.
        assert!(config(&[], &["TOKEN"]).validate().is_err());
    }

    #[test]
    fn a_reference_is_stored_as_sent_and_never_alongside_a_value() {
        let mut by_reference = config(&[("MODE", "dev")], &[]);
        by_reference.secret_refs.insert(
            "TOKEN".into(),
            CredentialReference::Env("HOST_TOKEN".into()),
        );
        by_reference.validate().unwrap();
        assert!(by_reference.plan_secrets(None).unwrap().is_empty());
        assert_eq!(by_reference.env["TOKEN"], REDACTED);
        assert!(by_reference.secret_env.contains("TOKEN"));
        by_reference.validate().unwrap();

        let mut both = config(&[("TOKEN", "value")], &["TOKEN"]);
        both.secret_refs.insert(
            "TOKEN".into(),
            CredentialReference::Env("HOST_TOKEN".into()),
        );
        assert!(both.validate().is_err());
        assert!(both.plan_secrets(None).is_err());
        let mut invalid = config(&[], &[]);
        invalid
            .secret_refs
            .insert("TOKEN".into(), CredentialReference::Env("ghp_raw".into()));
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn a_value_stored_before_references_is_never_launched_and_moves_on_the_next_save() {
        let legacy = config(&[("TOKEN", "s3cret")], &["TOKEN"]);
        assert_eq!(
            legacy.legacy_secret_values(),
            vec![("TOKEN".into(), "s3cret".into())]
        );
        let error = legacy.ensure_secrets_present().unwrap_err().to_string();
        assert!(error.contains("still stored in plain text"), "{error}");
        // Saving the redacted view moves the stored value.
        let mut resaved = legacy.redacted();
        assert_eq!(
            resaved.plan_secrets(Some(&legacy)).unwrap(),
            vec![("TOKEN".into(), "s3cret".into())]
        );
        let migrated = saved(legacy.clone(), None, "m");
        assert!(migrated.legacy_secret_values().is_empty());
        migrated.ensure_secrets_present().unwrap();
    }

    #[test]
    fn a_backup_copy_withholds_every_secret_value_and_a_restored_service_cannot_start_until_resent()
    {
        let mut stored = saved(
            config(&[("TOKEN", "s3cret"), ("MODE", "dev")], &["TOKEN"]),
            None,
            "a",
        );
        stored
            .secret_refs
            .insert("USER".into(), CredentialReference::Env("HOST_USER".into()));
        stored.secret_env.insert("USER".into());
        stored.env.insert("USER".into(), REDACTED.into());
        stored.validate().unwrap();
        // A legacy record with the value in plain text.
        let legacy = config(&[("TOKEN", "s3cret"), ("MODE", "dev")], &["TOKEN"]);
        let mut legacy_record = serde_json::json!({"name": "api", "revision": 3, "config": legacy});
        assert!(holds_secret_values(&legacy_record));
        withhold_secret_values(&mut legacy_record).unwrap();
        assert!(!holds_secret_values(&legacy_record));
        assert!(!legacy_record.to_string().contains("s3cret"));
        assert_eq!(legacy_record["config"]["env"]["MODE"], "dev");
        assert_eq!(legacy_record["revision"], 3);

        // A current record keeps the user's reference and drops ADE's own.
        let mut record = serde_json::json!({"name": "api", "revision": 3, "config": stored});
        assert!(!holds_secret_values(&record));
        withhold_secret_values(&mut record).unwrap();
        assert_eq!(
            record["config"]["secret_refs"],
            serde_json::json!({"USER": {"env": "HOST_USER"}})
        );

        // The restored service reads back, refuses to start, and refuses a
        // re-save that would keep the withheld placeholder.
        let restored: Config = serde_json::from_value(record["config"].clone()).unwrap();
        let error = restored.ensure_secrets_present().unwrap_err().to_string();
        assert!(error.contains("Secret TOKEN was withheld"), "{error}");
        let error = restored
            .redacted()
            .plan_secrets(Some(&restored))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Secret TOKEN was withheld"), "{error}");
        // Sending the value again makes it launchable.
        let mut resent = restored.clone();
        resent.env.insert("TOKEN".into(), "n3w".into());
        let resent = saved(resent, Some(&restored), "b");
        resent.ensure_secrets_present().unwrap();
        assert_eq!(
            resent.secret_refs["USER"],
            CredentialReference::Env("HOST_USER".into())
        );

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
        let mut bad_refs = serde_json::json!({"config": {"env": {}, "secret_refs": {"T": "raw"}}});
        assert!(withhold_secret_values(&mut bad_refs).is_err());
    }
}
