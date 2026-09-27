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
        // Reports whether and how a conversation could switch account; changes nothing.
        OperationSpec::new::<AccountSwitchPreviewRequest, AccountSwitchPreview>(
            "account.switch.preview",
            Tier::Query,
        ),
        // Rebinds a conversation to another account for future turns (F026).
        OperationSpec::new::<AccountSwitchRequest, AccountSwitched>(
            "account.switch",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<AccountSwitchListRequest, AccountSwitches>(
            "account.switch.list",
            Tier::Query,
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
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
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

/// How a conversation keeps going after an account switch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SwitchContinuity {
    /// The adapter declares that its native session continues under another
    /// account; the native session ID is kept.
    NativeContinuation,
    /// The next turn opens a new native session under the new account. ADE
    /// sends a bounded excerpt of the ADE transcript with that turn; the
    /// earlier native session, its tool state and hidden context do not carry over.
    NewNativeSession,
}

/// Whether ADE still owes the new native session the transferred context.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextTransfer {
    /// Nothing to transfer: native continuation, or an empty transcript.
    None,
    /// The next turn's prompt carries the excerpt.
    Pending,
    /// The provider acknowledged a turn that carried the excerpt.
    Delivered,
    /// A later switch replaced this one before its excerpt was delivered.
    Superseded,
}

/// `account.switch.preview`: ask how a conversation could move to an account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitchPreviewRequest {
    pub conversation_id: String,
    /// The account the conversation would use for future turns.
    pub account_id: String,
}

/// `account.switch`: rebind a conversation to another account of the same
/// provider for future turns. Refused while a turn is active.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitchRequest {
    /// Caller-chosen; reuse it only to retry the same switch.
    pub operation_id: String,
    pub conversation_id: String,
    pub account_id: String,
    /// The conversation's current account, or null for a legacy ambient
    /// conversation. Any other current account refuses the switch.
    #[serde(default)]
    pub expected_account_id: Option<String>,
    /// The target account's `generation` from the preview or `account.list`.
    pub expected_generation: u64,
    /// The continuity the preview offered. The daemon refuses any other.
    pub continuity: SwitchContinuity,
}

/// `account.switch.list`: the switches recorded for a conversation.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitchListRequest {
    pub conversation_id: String,
}

/// One recorded account switch: the provenance of a conversation's account.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct AccountSwitch {
    /// The operation ID that made the switch.
    pub id: String,
    pub conversation_id: String,
    pub provider: String,
    /// Null when the conversation used the legacy ambient account.
    pub from_account_id: Option<String>,
    pub from_generation: Option<u64>,
    pub to_account_id: String,
    pub to_generation: u64,
    pub continuity: SwitchContinuity,
    /// The native session the conversation used before the switch.
    pub previous_native_session: Option<String>,
    pub context_transfer: ContextTransfer,
    /// How many ADE transcript messages the excerpt carries.
    pub context_messages: u32,
    /// True when older messages did not fit the excerpt.
    pub context_truncated: bool,
    /// True when the switch stopped the conversation's idle Agent process.
    pub agent_stopped: bool,
    /// What does and does not carry over, in words a user can read.
    pub disclosure: String,
    pub created_at: i64,
}

wire_tag!(AccountSwitchPreviewTag, "account_switch_preview");
wire_tag!(AccountSwitchedTag, "account_switched");
wire_tag!(AccountSwitchesTag, "account_switches");

/// The `account.switch.preview` reply. Exactly one of `continuity` and
/// `refusal` is set.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitchPreview {
    #[serde(rename = "type")]
    pub tag: AccountSwitchPreviewTag,
    pub conversation_id: String,
    pub from_account_id: Option<String>,
    pub to_account_id: String,
    /// Pass as `expected_generation`.
    pub to_generation: u64,
    pub continuity: Option<SwitchContinuity>,
    pub refusal: Option<String>,
    /// The adapter's declared account-switch support and its note.
    pub capability: super::providers::Capability,
    pub disclosure: Option<String>,
}

/// The `account.switch` reply. A retry with the same operation ID returns it again.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitched {
    #[serde(rename = "type")]
    pub tag: AccountSwitchedTag,
    pub switch: AccountSwitch,
}

/// The `account.switch.list` reply, oldest first.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct AccountSwitches {
    #[serde(rename = "type")]
    pub tag: AccountSwitchesTag,
    pub switches: Vec<AccountSwitch>,
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
    fn switch_contracts_keep_their_wire_shape() {
        round_trip::<AccountSwitched>(json!({"type":"account_switched","switch":{
            "id":"op","conversation_id":"c","provider":"claude","from_account_id":null,
            "from_generation":null,"to_account_id":"a","to_generation":1,
            "continuity":"new_native_session","previous_native_session":"s",
            "context_transfer":"pending","context_messages":2,"context_truncated":false,
            "agent_stopped":true,"disclosure":"d","created_at":5}}));
        let request: AccountSwitchRequest = serde_json::from_value(json!({"operation_id":"o",
            "conversation_id":"c","account_id":"a","expected_generation":0,
            "continuity":"native_continuation"}))
        .unwrap();
        assert_eq!(request.expected_account_id, None);
        assert_eq!(request.continuity, SwitchContinuity::NativeContinuation);
    }

    #[test]
    fn inspection_accepts_a_runtime_report_without_optional_fields() {
        let inspection: Inspection =
            serde_json::from_value(json!({"state":"ready","reason":""})).unwrap();
        assert_eq!(inspection.version, None);
        assert_eq!(inspection.identity, None);
    }
}
