//! Credential references (architecture section 7). ADE stores where a secret
//! lives, never the secret: the name of a variable in the daemon's
//! environment, or a Keychain generic password. The daemon resolves a
//! reference only when it launches the process that needs the value, and no
//! reply, feed frame or database row carries the value.
use anyhow::{Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The Keychain service name of every item ADE itself creates. An item under
/// this name is ADE's to replace and delete; any other item belongs to the user.
pub const ADE_KEYCHAIN_SERVICE: &str = "ADE secret";

/// Where a secret lives. Serialized as `{"env": "NAME"}` or
/// `{"keychain": {"service": "...", "account": "..."}}`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialReference {
    /// An uppercase variable name in the daemon's environment.
    Env(String),
    /// A Keychain generic password.
    Keychain { service: String, account: String },
}

impl CredentialReference {
    /// A reference names where a secret lives and never holds it. An
    /// environment name must be uppercase, so a pasted token is refused
    /// rather than read as a variable name.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Env(name) => ensure!(
                !name.is_empty()
                    && name.len() <= 128
                    && !name.starts_with(|c: char| c.is_ascii_digit())
                    && name.bytes().all(|byte| byte.is_ascii_uppercase()
                        || byte.is_ascii_digit()
                        || byte == b'_'),
                "A credential environment variable must be an uppercase name such as API_TOKEN"
            ),
            Self::Keychain { service, account } => ensure!(
                [service, account].iter().all(|part| !part.is_empty()
                    && part.len() <= 256
                    && !part.chars().any(char::is_control)),
                "A credential Keychain service and account must be 1 to 256 characters"
            ),
        }
        Ok(())
    }

    /// Whether ADE created the item this reference names, so ADE may replace
    /// or delete it.
    pub fn ade_owned(&self) -> bool {
        matches!(self, Self::Keychain { service, .. } if service == ADE_KEYCHAIN_SERVICE)
    }

    /// Whether the profile with owner ID `owner` made this item: an ADE
    /// item whose account starts with `<owner>/`. Only that profile may
    /// reuse or delete it.
    pub fn owned_by(&self, owner: &str) -> bool {
        matches!(self, Self::Keychain { service, account }
            if service == ADE_KEYCHAIN_SERVICE
                && !owner.is_empty()
                && account.strip_prefix(owner).is_some_and(|rest| rest.starts_with('/')))
    }

    /// A short description for messages; it never contains a secret.
    pub fn describe(&self) -> String {
        match self {
            Self::Env(name) => format!("environment variable {name}"),
            Self::Keychain { service, account } => {
                format!("Keychain item {service:?} account {account:?}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn references_are_typed_validated_and_owned_only_under_the_ade_service() {
        let env: CredentialReference = serde_json::from_value(json!({"env": "API_TOKEN"})).unwrap();
        assert!(env.validate().is_ok());
        assert!(!env.ade_owned());
        let owned: CredentialReference = serde_json::from_value(
            json!({"keychain": {"service": ADE_KEYCHAIN_SERVICE, "account": "service/x"}}),
        )
        .unwrap();
        assert!(owned.ade_owned());
        assert!(
            !CredentialReference::Keychain {
                service: "mine".into(),
                account: "a".into()
            }
            .ade_owned()
        );
        // Ownership is per profile: the account starts with the owner ID.
        let mine: CredentialReference = serde_json::from_value(
            json!({"keychain": {"service": ADE_KEYCHAIN_SERVICE, "account": "p1/service/x/y"}}),
        )
        .unwrap();
        assert!(mine.owned_by("p1"));
        assert!(!mine.owned_by("p"));
        assert!(!mine.owned_by("p2"));
        assert!(!mine.owned_by(""));
        assert!(
            !CredentialReference::Keychain {
                service: "mine".into(),
                account: "p1/a".into()
            }
            .owned_by("p1")
        );
        // A pasted token is not a variable name.
        assert!(
            CredentialReference::Env("ghp_abc123".into())
                .validate()
                .is_err()
        );
        assert!(CredentialReference::Env(String::new()).validate().is_err());
        assert!(
            CredentialReference::Keychain {
                service: String::new(),
                account: "a".into()
            }
            .validate()
            .is_err()
        );
        assert!(serde_json::from_value::<CredentialReference>(json!("API_TOKEN")).is_err());
        assert!(serde_json::from_value::<CredentialReference>(json!({"value": "x"})).is_err());
    }
}
