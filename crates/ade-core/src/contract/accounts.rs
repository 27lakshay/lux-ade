//! Provider catalogue and managed account contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::Account;
use crate::provider::Descriptor;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<ProviderListRequest, ProvidersReply>("provider.list", Tier::Query),
        OperationSpec::new::<AccountListRequest, AccountsReply>("account.list", Tier::Query),
        // Each call mints a new account ID and native home directory.
        OperationSpec::new::<AccountCreateRequest, AccountAck>(
            "account.create",
            Tier::EffectCommand,
        ),
        // Runs the provider's read-only status probe; changes no state.
        OperationSpec::new::<AccountInspectRequest, AccountInspection>(
            "account.inspect",
            Tier::Query,
        ),
        // Guarded by the expected generation and pinned identity; a repeat converges.
        OperationSpec::new::<AccountVerifyRequest, AccountAck>(
            "account.verify",
            Tier::IdempotentCommand,
        ),
        // Leaves the account disabled with no pinned identity; each call bumps the generation.
        OperationSpec::new::<AccountDisableRequest, AccountDisabled>(
            "account.disable",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `provider.list`: the providers this daemon can launch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct ProviderListRequest {}

/// `account.list`: every account in the profile.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct AccountListRequest {}

/// `account.create`: register a new native account home for a provider.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountCreateRequest {
    pub provider: String,
    /// Trimmed by the daemon; 1 to 80 characters without line breaks.
    pub name: String,
}

/// `account.inspect`: probe a managed account's native readiness.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountInspectRequest {
    pub account_id: String,
}

/// `account.verify`: pin the identity an earlier `account.inspect` returned.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountVerifyRequest {
    pub account_id: String,
    /// The `generation` from `account.inspect`. Required on the wire; the
    /// daemon reports its absence after it has found the account.
    #[schemars(with = "u64")]
    pub expected_generation: Option<u64>,
    /// The `inspection.identity` object from `account.inspect`, as returned.
    #[schemars(with = "Value")]
    pub expected_identity: Option<Value>,
}

/// `account.disable`: stop new ADE launches with this account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountDisableRequest {
    pub account_id: String,
}

wire_tag!(ProvidersTag, "providers");
wire_tag!(AccountsTag, "accounts");
wire_tag!(AccountAckTag, "ack");
wire_tag!(AccountInspectionTag, "account_inspection");

/// The `provider.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct ProvidersReply {
    #[serde(rename = "type")]
    pub tag: ProvidersTag,
    pub providers: Vec<Descriptor>,
}

/// The `account.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountsReply {
    #[serde(rename = "type")]
    pub tag: AccountsTag,
    pub accounts: Vec<Account>,
}

/// The `account.create` and `account.verify` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountAck {
    #[serde(rename = "type")]
    pub tag: AccountAckTag,
    pub account: Account,
}

/// The `account.disable` reply. ADE never logs the native CLI out.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountDisabled {
    #[serde(rename = "type")]
    pub tag: AccountAckTag,
    pub account: Account,
    pub native_logout: bool,
}

/// The `account.inspect` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountInspection {
    #[serde(rename = "type")]
    pub tag: AccountInspectionTag,
    pub account_id: String,
    pub generation: u64,
    pub inspection: Inspection,
}

/// A provider's native readiness report for one account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Inspection {
    /// `ready` when the account can be verified.
    pub state: String,
    pub reason: String,
    pub version: Option<String>,
    /// The provider-specific identity to pin; its shape depends on the provider.
    #[schemars(with = "Value")]
    pub identity: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account() -> Value {
        json!({"id":"account_1","provider":"codex","name":"Work","native_home":"/h",
            "generation":2,"state":"verified",
            "codex_identity":{"email":"a@b.c","chatgpt_account_id":"acct"}})
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: Value) {
        let typed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), wire);
    }

    #[test]
    fn replies_keep_their_wire_shape() {
        round_trip::<AccountsReply>(json!({"type":"accounts","accounts":[account()]}));
        round_trip::<AccountAck>(json!({"type":"ack","account":account()}));
        round_trip::<AccountDisabled>(
            json!({"type":"ack","account":account(),"native_logout":false}),
        );
        round_trip::<AccountInspection>(json!({"type":"account_inspection",
            "account_id":"account_1","generation":2,
            "inspection":{"state":"logged_out","reason":"Sign in","version":null,"identity":null}}));
        round_trip::<ProvidersReply>(json!({"type":"providers","providers":[]}));
    }

    #[test]
    fn verify_request_distinguishes_absent_fields() {
        let full: AccountVerifyRequest = serde_json::from_value(json!({"account_id":"a",
            "expected_generation":3,"expected_identity":{"email":"x"}}))
        .unwrap();
        assert_eq!(full.expected_generation, Some(3));
        assert_eq!(full.expected_identity, Some(json!({"email":"x"})));
        let bare: AccountVerifyRequest = serde_json::from_value(json!({"account_id":"a"})).unwrap();
        assert!(bare.expected_generation.is_none() && bare.expected_identity.is_none());
    }

    #[test]
    fn inspection_accepts_a_runtime_report_without_optional_fields() {
        let inspection: Inspection =
            serde_json::from_value(json!({"state":"ready","reason":""})).unwrap();
        assert_eq!(inspection.version, None);
        assert_eq!(inspection.identity, None);
    }
}
