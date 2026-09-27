//! Remote host registry, SSH bootstrap and pairing contracts (F122, F124; D13).
//!
//! The profile records each remote host once: its SSH target, the host key it
//! pinned after matching a fingerprint the user supplied, and at most one
//! active pairing. A pairing stores a reference to its token, never the token.
//! Execution, credentials and workspaces stay on the remote host; these
//! operations only verify it, report what its ADE backend lacks, and start or
//! attach the daemon that is already installed there. Nothing is installed.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<RemoteHostListRequest, RemoteHosts>("remote.host.list", Tier::Query),
        // Pins the host key only when it matches `expected_fingerprint`.
        // Repeating it with the same definition returns the stored host; a
        // different definition for the same ID is refused.
        OperationSpec::new::<RemoteHostAddRequest, RemoteHostReply>(
            "remote.host.add",
            Tier::IdempotentCommand,
        ),
        // Refused while a pairing is active. Removing an absent host converges.
        // Nothing on the remote host changes.
        OperationSpec::new::<RemoteHostRemoveRequest, RemoteHostRemoved>(
            "remote.host.remove",
            Tier::IdempotentCommand,
        ),
        // Connects with the pinned host key and reads what the backend offers.
        // It starts nothing and writes nothing on either host.
        OperationSpec::new::<RemoteHostProbeRequest, RemoteHostProbe>(
            "remote.host.probe",
            Tier::Query,
        ),
        // Repeating it with the same token reference returns the active pairing.
        OperationSpec::new::<RemotePairRequest, RemotePairingReply>(
            "remote.host.pair",
            Tier::IdempotentCommand,
        ),
        // Revoked is final; revoking again converges.
        OperationSpec::new::<RemoteRevokeRequest, RemotePairingReply>(
            "remote.host.revoke",
            Tier::IdempotentCommand,
        ),
        // Starts the remote profile daemon or attaches to the running one.
        OperationSpec::new::<RemoteHostStartRequest, RemoteHostStart>(
            "remote.host.start",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// Where the pairing token lives. The daemon stores the reference only.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenReference {
    /// The name of an environment variable in the daemon's environment.
    Env(String),
    /// A macOS Keychain generic password.
    Keychain { service: String, account: String },
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingState {
    Active,
    Revoked,
}

/// One pairing between this profile and a remote host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RemotePairing {
    pub pairing_id: String,
    pub state: PairingState,
    pub token_reference: TokenReference,
    pub paired_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
}

/// One registered remote host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RemoteHost {
    pub host_id: String,
    pub label: String,
    /// What `ssh` is given: an alias from the user's SSH config or `user@host`.
    pub ssh_target: String,
    /// The pinned host key algorithm, such as `ssh-ed25519`.
    pub host_key_type: String,
    /// The pinned key's OpenSSH SHA-256 fingerprint, `SHA256:...`.
    pub host_key_fingerprint: String,
    /// Absolute path of `ade-control` on the remote host; null uses its `PATH`.
    pub backend_path: Option<String>,
    /// The remote profile to start; null uses the remote host's selected profile.
    pub remote_profile_id: Option<String>,
    pub created_at_ms: i64,
    /// The active pairing, or else the most recent revoked one; null when never paired.
    pub pairing: Option<RemotePairing>,
}

/// `remote.host.list`: every registered host, in ID order.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct RemoteHostListRequest {}

/// `remote.host.add`: verify and record a host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostAddRequest {
    /// Lowercase letters, digits and `-`, at most 64 characters.
    pub host_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub ssh_target: String,
    /// The host key fingerprint obtained out of band, `SHA256:...`.
    pub expected_fingerprint: String,
    /// The host's public key line. Required when the target is reached through
    /// a proxy; otherwise the daemon reads the keys with `ssh-keyscan`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_profile_id: Option<String>,
}

/// `remote.host.remove`: forget a host that has no active pairing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostRemoveRequest {
    pub host_id: String,
}

/// `remote.host.probe`: check the host key and the remote backend.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostProbeRequest {
    pub host_id: String,
}

/// `remote.host.pair`: record an explicit pairing and its token reference.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemotePairRequest {
    pub host_id: String,
    pub token_reference: TokenReference,
}

/// `remote.host.revoke`: invalidate one pairing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteRevokeRequest {
    pub host_id: String,
    pub pairing_id: String,
}

/// `remote.host.start`: start or attach the remote profile daemon.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostStartRequest {
    pub operation_id: String,
    pub host_id: String,
}

wire_tag!(RemoteHostsTag, "remote_hosts");
wire_tag!(RemoteHostTag, "remote_host");
wire_tag!(RemoteHostRemovedTag, "remote_host_removed");
wire_tag!(RemoteHostProbeTag, "remote_host_probe");
wire_tag!(RemotePairingTag, "remote_pairing");
wire_tag!(RemoteHostStartTag, "remote_host_start");

/// The `remote.host.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHosts {
    #[serde(rename = "type")]
    pub tag: RemoteHostsTag,
    pub hosts: Vec<RemoteHost>,
}

/// The `remote.host.add` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostReply {
    #[serde(rename = "type")]
    pub tag: RemoteHostTag,
    pub host: RemoteHost,
}

/// The `remote.host.remove` reply. `removed` is false when no host existed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostRemoved {
    #[serde(rename = "type")]
    pub tag: RemoteHostRemovedTag,
    pub host_id: String,
    pub removed: bool,
}

/// The remote operating system and machine, from `uname`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RemotePlatform {
    pub os: String,
    pub arch: String,
}

/// Whether the remote ADE backend can serve this daemon.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct BackendCompatibility {
    pub compatible: bool,
    /// The `ade-control` the probe found; null when none was found.
    pub control_path: Option<String>,
    pub application_protocol: Option<String>,
    pub runtime_protocol: Option<String>,
    /// Each artifact or capability the host lacks, stated exactly.
    pub missing: Vec<String>,
    /// Each version or platform mismatch, stated exactly.
    pub incompatible: Vec<String>,
}

/// The `remote.host.probe` reply. It is only returned after the host
/// presented the pinned key.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemoteHostProbe {
    #[serde(rename = "type")]
    pub tag: RemoteHostProbeTag,
    pub host_id: String,
    pub host_key_fingerprint: String,
    pub platform: RemotePlatform,
    pub backend: BackendCompatibility,
}

/// The `remote.host.pair` and `remote.host.revoke` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RemotePairingReply {
    #[serde(rename = "type")]
    pub tag: RemotePairingTag,
    pub host_id: String,
    pub pairing: RemotePairing,
    /// Where revocation takes effect. `local_profile`: this profile refuses to
    /// start or attach the host; the remote backend does not yet check tokens.
    pub enforcement: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartOutcome {
    /// The remote daemon answered with compatible protocols.
    Running,
    /// Nothing was started, or the running daemon is incompatible and was left alone.
    Failed,
    /// The attempt may or may not have started the daemon; probe before retrying.
    Unknown,
}

/// The remote daemon's identity as its `hello` reported it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RemoteDaemon {
    pub profile_id: String,
    /// The daemon's socket path on the remote host.
    pub socket: String,
    pub boot_id: String,
    pub pid: u32,
    pub build_id: Option<String>,
    pub application_protocol: String,
    pub runtime_protocol: String,
}

/// The `remote.host.start` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RemoteHostStart {
    #[serde(rename = "type")]
    pub tag: RemoteHostStartTag,
    pub operation_id: String,
    pub host_id: String,
    pub outcome: StartOutcome,
    pub detail: Option<String>,
    pub daemon: Option<RemoteDaemon>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: Value) {
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    #[test]
    fn requests_and_replies_keep_their_wire_shape() {
        round_trip::<RemoteHostAddRequest>(json!({"host_id": "devbox", "ssh_target": "me@devbox",
            "expected_fingerprint": "SHA256:abc"}));
        round_trip::<RemotePairRequest>(
            json!({"host_id": "devbox", "token_reference": {"env": "ADE_DEVBOX_TOKEN"}}),
        );
        round_trip::<RemotePairRequest>(json!({"host_id": "devbox",
            "token_reference": {"keychain": {"service": "ade", "account": "devbox"}}}));
        let pairing = json!({"pairing_id": "p1", "state": "revoked",
            "token_reference": {"env": "T"}, "paired_at_ms": 1, "revoked_at_ms": 2});
        round_trip::<RemotePairingReply>(json!({"type": "remote_pairing", "host_id": "devbox",
            "pairing": pairing.clone(), "enforcement": "local_profile"}));
        round_trip::<RemoteHosts>(
            json!({"type": "remote_hosts", "hosts": [{"host_id": "devbox",
            "label": "devbox", "ssh_target": "devbox", "host_key_type": "ssh-ed25519",
            "host_key_fingerprint": "SHA256:abc", "backend_path": null,
            "remote_profile_id": null, "created_at_ms": 1, "pairing": pairing}]}),
        );
        round_trip::<RemoteHostProbe>(json!({"type": "remote_host_probe", "host_id": "devbox",
            "host_key_fingerprint": "SHA256:abc", "platform": {"os": "Linux", "arch": "x86_64"},
            "backend": {"compatible": false, "control_path": null, "application_protocol": null,
                "runtime_protocol": null, "missing": ["ade-control"], "incompatible": []}}));
        round_trip::<RemoteHostStart>(json!({"type": "remote_host_start", "operation_id": "o",
            "host_id": "devbox", "outcome": "unknown", "detail": "d", "daemon": null}));
    }

    #[test]
    fn a_raw_token_is_not_accepted() {
        let wire = json!({"host_id": "h", "token_reference": {"token": "secret"}});
        assert!(serde_json::from_value::<RemotePairRequest>(wire).is_err());
        let wire = json!({"host_id": "h", "token_reference": {"env": "T", "value": "secret"}});
        assert!(serde_json::from_value::<RemotePairRequest>(wire).is_err());
    }
}
