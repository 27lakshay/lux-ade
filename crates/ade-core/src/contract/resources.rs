//! HostResources contracts: inspect the host-local claim registry that every
//! profile's daemon uses for physical checkouts, resolve a quarantined claim
//! after explicit recovery, and accept a replaced or missing registry.
//!
//! Claims are keyed by host plus canonical filesystem identity (device, inode
//! and generation), not by a profile path. Device, inode and generation are
//! decimal strings.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ResourcesInspectRequest, HostResourcesState>(
            "resources.inspect",
            Tier::Query,
        ),
        OperationSpec::new::<ResourcesClaimResolveRequest, HostResourcesState>(
            "resources.claim.resolve",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<ResourcesRegistryAcceptRequest, HostResourcesState>(
            "resources.registry.accept",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `resources.inspect`: read the registry status and its claims. With `path`,
/// only claims on that path, inside it, or containing it are listed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ResourcesInspectRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `resources.claim.resolve`: release one quarantined claim after the caller
/// has reconciled the resource outside ADE. Active claims cannot be resolved.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ResourcesClaimResolveRequest {
    /// Caller-owned operation ID.
    pub operation_id: String,
    pub claim_id: String,
    /// Must equal the claim's recorded `path`.
    pub confirm_path: String,
}

/// `resources.registry.accept`: bind this profile to the registry currently
/// on disk after it was replaced, went missing or became unreadable. An
/// unreadable file is moved aside, never deleted. Owners recorded only in the
/// lost registry are forgotten, which is why the caller must confirm.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ResourcesRegistryAcceptRequest {
    /// Caller-owned operation ID.
    pub operation_id: String,
    /// Must equal `registry.path` from `resources.inspect`.
    pub confirm_registry: String,
}

wire_tag!(HostResourcesStateTag, "host_resources");

/// The reply to every `resources.*` operation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct HostResourcesState {
    #[serde(rename = "type")]
    pub tag: HostResourcesStateTag,
    pub registry: RegistryStatus,
    /// The profile this daemon claims for.
    pub profile: String,
    /// This daemon's incarnation; claims from earlier incarnations of the same
    /// profile are listed with `mine: false`.
    pub incarnation: String,
    pub claims: Vec<ResourceClaim>,
}

/// Where the registry lives and whether it admits new claims.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RegistryStatus {
    pub path: String,
    /// `host` when every profile shares the registry; `profile` when this
    /// daemon runs outside a managed profile and coordinates with nobody.
    pub scope: RegistryScope,
    /// `None` until the registry has been opened successfully.
    pub host_id: Option<String>,
    pub state: RegistryState,
    /// Why the registry is blocked; absent when it is ready.
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistryScope {
    Host,
    Profile,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistryState {
    Ready,
    /// New lifecycle claims are refused until explicit recovery.
    Blocked,
}

/// One physical resource claim.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct ResourceClaim {
    pub id: String,
    pub host_id: String,
    /// The canonical path when the claim was taken; informational only.
    pub path: String,
    pub device: String,
    pub inode: String,
    pub generation: String,
    /// For a reservation of a path that does not exist yet: its folded final
    /// name. The identity fields then describe the parent directory.
    pub unborn_name: Option<String>,
    pub mode: ClaimMode,
    pub purpose: ClaimPurpose,
    pub phase: ClaimPhase,
    pub state: ClaimState,
    pub owner_profile: String,
    pub owner_incarnation: String,
    /// Diagnostic only; a missing PID never clears a claim.
    pub owner_pid: u32,
    /// Whether the owning incarnation still holds its liveness lock.
    pub owner_live: bool,
    /// Whether this daemon incarnation owns the claim.
    pub mine: bool,
    pub operation_id: Option<String>,
    /// Why the claim is quarantined.
    pub reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Shared use admits other shared use; an exclusive lifecycle claim admits nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimMode {
    Shared,
    Exclusive,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimPurpose {
    /// A terminal, Agent, service or script works in the checkout.
    Use,
    /// ADE is creating a worktree at a reserved path.
    Create,
    /// ADE is removing a worktree.
    Remove,
}

/// Operation phases, persisted before each step.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimPhase {
    /// Reserved; no effect has started.
    Reserved,
    /// The effect was handed to Git; its outcome is not yet known.
    Dispatched,
    /// A created path is bound to its filesystem identity.
    Bound,
    /// Shared use is in progress.
    Active,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimState {
    Active,
    /// Ownership or outcome is uncertain. The claim still conflicts until
    /// resource-specific reconciliation or explicit resolution.
    Quarantined,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn validator(name: &str) -> jsonschema::Validator {
        let bundle = super::super::bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).expect("generated schema compiles")
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(
        name: &str,
        op: Option<&str>,
        value: &T,
    ) {
        let mut wire = serde_json::to_value(value).unwrap();
        if let Some(op) = op {
            wire["op"] = json!(op);
        }
        let errors: Vec<String> = validator(name)
            .iter_errors(&wire)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name} rejected {wire}: {errors:?}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again: Value = serde_json::to_value(decoded).unwrap();
        if let Some(op) = op {
            again["op"] = json!(op);
        }
        assert_eq!(again, wire);
    }

    #[test]
    fn resources_requests_and_state_round_trip_through_their_schemas() {
        round_trip(
            "ResourcesInspectRequest",
            Some("resources.inspect"),
            &ResourcesInspectRequest {
                path: Some("/w/tree".into()),
            },
        );
        round_trip(
            "ResourcesClaimResolveRequest",
            Some("resources.claim.resolve"),
            &ResourcesClaimResolveRequest {
                operation_id: "op".into(),
                claim_id: "claim_1".into(),
                confirm_path: "/w/tree".into(),
            },
        );
        round_trip(
            "ResourcesRegistryAcceptRequest",
            Some("resources.registry.accept"),
            &ResourcesRegistryAcceptRequest {
                operation_id: "op".into(),
                confirm_registry: "/h/host-resources.sqlite3".into(),
            },
        );
        round_trip(
            "HostResourcesState",
            None,
            &HostResourcesState {
                tag: Default::default(),
                registry: RegistryStatus {
                    path: "/h/host-resources.sqlite3".into(),
                    scope: RegistryScope::Host,
                    host_id: Some("host_1".into()),
                    state: RegistryState::Ready,
                    reason: None,
                },
                profile: "p".into(),
                incarnation: "incarnation_1".into(),
                claims: vec![ResourceClaim {
                    id: "claim_1".into(),
                    host_id: "host_1".into(),
                    path: "/w/tree".into(),
                    device: "1".into(),
                    inode: "2".into(),
                    generation: "3".into(),
                    unborn_name: None,
                    mode: ClaimMode::Exclusive,
                    purpose: ClaimPurpose::Remove,
                    phase: ClaimPhase::Dispatched,
                    state: ClaimState::Quarantined,
                    owner_profile: "p".into(),
                    owner_incarnation: "incarnation_0".into(),
                    owner_pid: 42,
                    owner_live: false,
                    mine: false,
                    operation_id: Some("op".into()),
                    reason: Some("outcome_unknown".into()),
                    created_at: 1,
                    updated_at: 2,
                }],
            },
        );
    }
}
