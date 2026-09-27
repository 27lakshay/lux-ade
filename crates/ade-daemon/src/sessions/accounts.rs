//! Provider catalogue, `account.*` operations and the account generation check.
use super::*;
use ade_core::contract::accounts::{
    AccountAck, AccountCreateRequest, AccountDisableRequest, AccountDisabled,
    AccountInspectRequest, AccountInspection, AccountListRequest, AccountVerifyRequest,
    AccountsReply, Inspection, ProviderListRequest, ProvidersReply,
};

impl Sessions {
    pub(super) fn account_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "provider.list" => {
                let _: ProviderListRequest = decode(request)?;
                reply(&ProvidersReply {
                    tag: Default::default(),
                    providers: provider::descriptors().to_vec(),
                })
            }
            "account.list" => {
                let _: AccountListRequest = decode(request)?;
                reply(&AccountsReply {
                    tag: Default::default(),
                    accounts: self.data.lock().unwrap().store.accounts()?,
                })
            }
            "account.create" => {
                let create: AccountCreateRequest = decode(request)?;
                let provider = non_empty("provider", &create.provider)?;
                let name = non_empty("name", &create.name)?;
                let account = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .create_account(provider, name)?;
                reply(&AccountAck {
                    tag: Default::default(),
                    account,
                })
            }
            "account.inspect" => {
                let inspect: AccountInspectRequest = decode(request)?;
                let id = non_empty("account_id", &inspect.account_id)?;
                let account = self.managed_account(id)?;
                let inspection = self.inspect_account(&account)?;
                let current = self.data.lock().unwrap().store.account(id)?;
                ensure!(
                    current.generation == account.generation,
                    "Account changed during inspection; retry"
                );
                reply(&AccountInspection {
                    tag: Default::default(),
                    account_id: account.id,
                    generation: account.generation,
                    inspection,
                })
            }
            "account.verify" => {
                let verify: AccountVerifyRequest = decode(request)?;
                let id = non_empty("account_id", &verify.account_id)?;
                let account = self.managed_account(id)?;
                let generation = verify
                    .expected_generation
                    .context("Missing expected account generation")?;
                let expected_identity = verify.expected_identity.with_context(|| {
                    let provider = match account.provider.as_str() {
                        "claude" => "Claude",
                        "codex" => "Codex",
                        _ => "Oh My Pi",
                    };
                    format!("Missing inspected {provider} identity")
                })?;
                let inspection = self.inspect_account(&account)?;
                ensure!(
                    inspection.state == "ready",
                    "{} account is not ready: {}",
                    account.provider,
                    inspection.reason
                );
                let identity = inspection
                    .identity
                    .context("Account identity is unavailable")?;
                ensure!(
                    expected_identity == identity,
                    "Account identity changed since inspection; inspect again"
                );
                let d = self.data.lock().unwrap();
                let updated = if account.provider == "claude" {
                    d.store.verify_claude_account(
                        id,
                        generation,
                        serde_json::from_value(identity)
                            .context("Invalid inspected Claude identity")?,
                    )?
                } else if account.provider == "codex" {
                    d.store.verify_codex_account(
                        id,
                        generation,
                        serde_json::from_value(identity)
                            .context("Invalid inspected Codex identity")?,
                    )?
                } else {
                    d.store.verify_omp_account(
                        id,
                        generation,
                        serde_json::from_value(identity)
                            .context("Invalid inspected Oh My Pi identity")?,
                    )?
                };
                reply(&AccountAck {
                    tag: Default::default(),
                    account: updated,
                })
            }
            "account.disable" => {
                let disable: AccountDisableRequest = decode(request)?;
                let id = non_empty("account_id", &disable.account_id)?;
                let account = self.data.lock().unwrap().store.disable_account(id)?;
                reply(&AccountDisabled {
                    tag: Default::default(),
                    account,
                    native_logout: false,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
    /// Loads an account whose provider supports native inspection.
    fn managed_account(&self, id: &str) -> Result<Account> {
        let account = self.data.lock().unwrap().store.account(id)?;
        ensure!(
            matches!(account.provider.as_str(), "claude" | "codex" | "omp"),
            "Managed account inspection is unavailable for this provider"
        );
        Ok(account)
    }
    /// Runs the provider's native status probe against one account snapshot.
    fn inspect_account(&self, account: &Account) -> Result<Inspection> {
        let context = ade_core::model::AccountExecution {
            id: account.id.clone(),
            provider: account.provider.clone(),
            native_home: account.native_home.clone(),
            generation: account.generation,
            claude_identity: account.claude_identity.clone(),
            codex_identity: account.codex_identity.clone(),
            omp_identity: account.omp_identity.clone(),
        };
        Ok(serde_json::from_value(self.runtime.agent(
            AgentOp::AccountInspect {
                account: serde_json::to_value(context)?,
            },
        )?)?)
    }
    pub(super) fn ensure_account_current(
        d: &Data,
        conversation: &Conversation,
        expected_generation: Option<u64>,
    ) -> Result<()> {
        let Some(id) = conversation.account_id.as_deref() else {
            return Ok(());
        };
        let account = d.store.account(id)?;
        ensure!(
            account.provider == conversation.provider && account.state == "verified",
            "Conversation account is not verified"
        );
        ensure!(
            expected_generation.is_none_or(|generation| generation == account.generation),
            "Conversation account changed since the Agent connected"
        );
        Ok(())
    }
}
