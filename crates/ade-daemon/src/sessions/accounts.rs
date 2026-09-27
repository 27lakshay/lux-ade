//! Provider catalogue, `account.*` operations and the account generation check.
use super::*;

impl Sessions {
    pub(super) fn account_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let string = required_str(request);
        match request["op"].as_str().unwrap_or("") {
            "provider.list" => Ok(provider::catalogue()),
            "account.list" => Ok(
                json!({"type":"accounts","accounts":self.data.lock().unwrap().store.accounts()?}),
            ),
            "account.create" => {
                let d = self.data.lock().unwrap();
                let account = d
                    .store
                    .create_account(string("provider")?, string("name")?)?;
                Ok(json!({"type":"ack","account":account}))
            }
            "account.inspect" | "account.verify" => {
                let id = string("account_id")?;
                let account = self.data.lock().unwrap().store.account(id)?;
                ensure!(
                    matches!(account.provider.as_str(), "claude" | "codex" | "omp"),
                    "Managed account inspection is unavailable for this provider"
                );
                let expected_generation = if request["op"] == "account.verify" {
                    Some(
                        request["expected_generation"]
                            .as_u64()
                            .context("Missing expected account generation")?,
                    )
                } else {
                    None
                };
                let expected_identity: Option<Value> = if request["op"] == "account.verify" {
                    Some(request.get("expected_identity").cloned().with_context(|| {
                        let provider = match account.provider.as_str() {
                            "claude" => "Claude",
                            "codex" => "Codex",
                            _ => "Oh My Pi",
                        };
                        format!("Missing inspected {provider} identity")
                    })?)
                } else {
                    None
                };
                let context = ade_core::model::AccountExecution {
                    id: account.id.clone(),
                    provider: account.provider.clone(),
                    native_home: account.native_home.clone(),
                    generation: account.generation,
                    claude_identity: account.claude_identity.clone(),
                    codex_identity: account.codex_identity.clone(),
                    omp_identity: account.omp_identity.clone(),
                };
                let inspection: provider::account_probe::Inspection = serde_json::from_value(
                    self.runtime
                        .agent(json!({"op":"agent.account_inspect","account":context}))?,
                )?;
                if let Some(generation) = expected_generation {
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
                        expected_identity.as_ref() == Some(&identity),
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
                    Ok(json!({"type":"ack","account":updated}))
                } else {
                    let current = self.data.lock().unwrap().store.account(id)?;
                    ensure!(
                        current.generation == account.generation,
                        "Account changed during inspection; retry"
                    );
                    Ok(
                        json!({"type":"account_inspection","account_id":id,"generation":account.generation,"inspection":inspection}),
                    )
                }
            }
            "account.disable" => {
                let account = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .disable_account(string("account_id")?)?;
                Ok(json!({"type":"ack","account":account,"native_logout":false}))
            }
            _ => bail!("Unknown session operation"),
        }
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
