//! Remote-side pairing enforcement (F121, F122; D13).
//!
//! A profile daemon started by `ade-control` on an execution host keeps a
//! grant file in its runtime home. Each grant is one pairing a client profile
//! made with this host: its pairing ID and the SHA-256 of its token, never the
//! token. Once the host holds a grant, the daemon serves a second, owner-only
//! Unix socket, the paired endpoint. Every connection to it must present an
//! active pairing's ID and token in its `hello`; a revoked pairing is refused
//! and its open connections are closed. The owner socket stays the host
//! user's own: SSH login as that user remains full authority over the host.
//!
//! `ade-control` writes the file under a lock; the daemon only reads it. The
//! decisions here are pure.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The grant file in a runtime home.
pub const GRANTS_FILE: &str = "access-grants.json";
/// The lock `ade-control` holds while it rewrites the grant file.
pub const GRANTS_LOCK: &str = "access-grants.lock";
const FORMAT_VERSION: u32 = 1;
const MAX_TOKEN_BYTES: usize = 4096;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrantState {
    Active,
    Revoked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub pairing_id: String,
    /// Lowercase hex SHA-256 of the token; null for a pairing revoked before
    /// this host ever granted it.
    pub token_sha256: Option<String>,
    pub state: GrantState,
    pub granted_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Grants {
    pub format_version: u32,
    pub grants: Vec<Grant>,
}

impl Default for Grants {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            grants: Vec::new(),
        }
    }
}

impl Grants {
    /// Parses the grant file. An unknown format is refused rather than guessed.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let grants: Self = serde_json::from_slice(bytes)?;
        ensure!(
            grants.format_version == FORMAT_VERSION,
            "Unsupported access grant format {}",
            grants.format_version
        );
        Ok(grants)
    }

    pub fn has_active(&self) -> bool {
        self.grants
            .iter()
            .any(|grant| grant.state == GrantState::Active)
    }

    pub fn is_active(&self, pairing_id: &str) -> bool {
        self.find(pairing_id)
            .is_some_and(|grant| grant.state == GrantState::Active)
    }

    fn find(&self, pairing_id: &str) -> Option<&Grant> {
        self.grants
            .iter()
            .find(|grant| grant.pairing_id == pairing_id)
    }
}

/// The paired endpoint beside a daemon's owner socket: `x.sock` serves
/// `x.paired.sock`.
pub fn paired_socket(socket: &Path) -> PathBuf {
    let text = socket.to_string_lossy();
    match text.strip_suffix(".sock") {
        Some(stem) => PathBuf::from(format!("{stem}.paired.sock")),
        None => PathBuf::from(format!("{text}.paired")),
    }
}

pub fn token_sha256(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn validate_pairing_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "Pairing ID must be 1 to 128 letters, digits, '-' or '_'"
    );
    Ok(())
}

fn validate_digest(digest: &str) -> Result<()> {
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "Token digest must be 64 lowercase hex digits"
    );
    Ok(())
}

/// What `grant` changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantChange {
    Granted,
    /// The same pairing and token were already granted.
    Unchanged,
}

/// Grants a pairing. Granting the same pairing and token again converges. A
/// revoked pairing stays revoked, and an active pairing keeps its token.
pub fn grant(grants: &mut Grants, pairing_id: &str, digest: &str, now: i64) -> Result<GrantChange> {
    validate_pairing_id(pairing_id)?;
    validate_digest(digest)?;
    if let Some(existing) = grants.find(pairing_id) {
        ensure!(
            existing.state == GrantState::Active,
            "Access grant refused: pairing {pairing_id} was revoked on this host; pair again"
        );
        ensure!(
            existing.token_sha256.as_deref() == Some(digest),
            "Access grant refused: pairing {pairing_id} is granted with another token"
        );
        return Ok(GrantChange::Unchanged);
    }
    grants.grants.push(Grant {
        pairing_id: pairing_id.to_owned(),
        token_sha256: Some(digest.to_owned()),
        state: GrantState::Active,
        granted_at_ms: Some(now),
        revoked_at_ms: None,
    });
    Ok(GrantChange::Granted)
}

/// Revokes a pairing; revoking again converges. A pairing this host never
/// granted is recorded revoked, so a later grant of it is refused.
pub fn revoke(grants: &mut Grants, pairing_id: &str, now: i64) -> Result<bool> {
    validate_pairing_id(pairing_id)?;
    if let Some(existing) = grants
        .grants
        .iter_mut()
        .find(|grant| grant.pairing_id == pairing_id)
    {
        if existing.state == GrantState::Revoked {
            return Ok(false);
        }
        existing.state = GrantState::Revoked;
        existing.revoked_at_ms = Some(now);
        return Ok(true);
    }
    grants.grants.push(Grant {
        pairing_id: pairing_id.to_owned(),
        token_sha256: None,
        state: GrantState::Revoked,
        granted_at_ms: None,
        revoked_at_ms: Some(now),
    });
    Ok(true)
}

/// The paired endpoint's decision for one connection's `hello`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Admission {
    Granted(String),
    /// The pairing was revoked on this host.
    Revoked(String),
    /// No credential, an unknown pairing, or a token that does not match.
    Unauthenticated(&'static str),
}

pub fn admit(grants: &Grants, pairing_id: Option<&str>, token: Option<&str>) -> Admission {
    let (Some(pairing_id), Some(token)) = (pairing_id, token) else {
        return Admission::Unauthenticated(
            "This endpoint accepts paired clients only; present a pairing ID and token in hello",
        );
    };
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Admission::Unauthenticated("The pairing token is empty or too long");
    }
    let Some(grant) = grants.find(pairing_id) else {
        return Admission::Unauthenticated("This host has no grant for that pairing");
    };
    if grant.state == GrantState::Revoked {
        return Admission::Revoked(pairing_id.to_owned());
    }
    let presented = token_sha256(token);
    match &grant.token_sha256 {
        Some(expected) if constant_time_eq(expected.as_bytes(), presented.as_bytes()) => {
            Admission::Granted(pairing_id.to_owned())
        }
        _ => Admission::Unauthenticated("The pairing token does not match this host's grant"),
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// The refusal frame's code and message for a refused hello.
pub fn refusal(admission: &Admission) -> Option<(&'static str, String)> {
    match admission {
        Admission::Granted(_) => None,
        Admission::Revoked(id) => Some((
            "pairing_revoked",
            format!("Pairing {id} was revoked on this host; pair again to reconnect"),
        )),
        Admission::Unauthenticated(reason) => Some(("unauthenticated", (*reason).to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "correct horse battery staple";

    #[test]
    fn a_granted_pairing_is_admitted_only_with_its_own_token_until_revoked() {
        let mut grants = Grants::default();
        let digest = token_sha256(TOKEN);
        assert_eq!(
            grant(&mut grants, "p1", &digest, 1).unwrap(),
            GrantChange::Granted
        );
        assert_eq!(
            grant(&mut grants, "p1", &digest, 2).unwrap(),
            GrantChange::Unchanged
        );
        assert!(grant(&mut grants, "p1", &token_sha256("other"), 3).is_err());
        assert_eq!(
            admit(&grants, Some("p1"), Some(TOKEN)),
            Admission::Granted("p1".into())
        );
        assert!(matches!(
            admit(&grants, Some("p1"), Some("wrong")),
            Admission::Unauthenticated(_)
        ));
        assert!(matches!(
            admit(&grants, Some("p2"), Some(TOKEN)),
            Admission::Unauthenticated(_)
        ));
        assert!(matches!(
            admit(&grants, None, Some(TOKEN)),
            Admission::Unauthenticated(_)
        ));
        assert!(matches!(
            admit(&grants, Some("p1"), None),
            Admission::Unauthenticated(_)
        ));

        assert!(revoke(&mut grants, "p1", 4).unwrap());
        assert!(!revoke(&mut grants, "p1", 5).unwrap());
        assert_eq!(
            admit(&grants, Some("p1"), Some(TOKEN)),
            Admission::Revoked("p1".into())
        );
        assert!(!grants.has_active());
        // Revoked is final for that pairing, even with the same token.
        assert!(grant(&mut grants, "p1", &digest, 6).is_err());
        // A new pairing may reuse the token; the revoked one stays refused.
        grant(&mut grants, "p2", &digest, 7).unwrap();
        assert_eq!(
            admit(&grants, Some("p2"), Some(TOKEN)),
            Admission::Granted("p2".into())
        );
        assert_eq!(
            admit(&grants, Some("p1"), Some(TOKEN)),
            Admission::Revoked("p1".into())
        );
    }

    #[test]
    fn a_pairing_revoked_before_it_was_granted_can_never_be_granted() {
        let mut grants = Grants::default();
        assert!(revoke(&mut grants, "p9", 1).unwrap());
        assert!(grant(&mut grants, "p9", &token_sha256(TOKEN), 2).is_err());
        assert_eq!(
            admit(&grants, Some("p9"), Some(TOKEN)),
            Admission::Revoked("p9".into())
        );
    }

    #[test]
    fn inputs_and_the_file_format_are_checked() {
        let mut grants = Grants::default();
        assert!(grant(&mut grants, "", &token_sha256(TOKEN), 1).is_err());
        assert!(grant(&mut grants, "p 1", &token_sha256(TOKEN), 1).is_err());
        assert!(grant(&mut grants, "p1", "ABC", 1).is_err());
        assert!(Grants::parse(br#"{"format_version":2,"grants":[]}"#).is_err());
        let round = serde_json::to_vec(&Grants::default()).unwrap();
        assert_eq!(Grants::parse(&round).unwrap(), Grants::default());
    }

    #[test]
    fn the_paired_endpoint_sits_beside_the_owner_socket() {
        assert_eq!(
            paired_socket(Path::new("/tmp/ade-501-abc.sock")),
            PathBuf::from("/tmp/ade-501-abc.paired.sock")
        );
        assert_eq!(
            paired_socket(Path::new("/tmp/d")),
            PathBuf::from("/tmp/d.paired")
        );
    }
}
