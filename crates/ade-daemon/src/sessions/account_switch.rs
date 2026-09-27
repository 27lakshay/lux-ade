//! `account.switch.preview`, `account.switch` and `account.switch.list` (F026).
//!
//! The eligibility decision is pure and lives in [`crate::account_switch`].
//! This module gathers its facts under the session lock, stops an idle Agent
//! that still runs under the earlier account, and commits the switch with its
//! receipt and activity in one transaction.
use super::*;
use crate::account_switch::{self as switch, Decision, Excerpt, Expectation, Facts, Target};
use ade_core::contract::accounts::{
    AccountSwitch, AccountSwitchListRequest, AccountSwitchPreview, AccountSwitchPreviewRequest,
    AccountSwitchRequest, AccountSwitched, AccountSwitches, ContextTransfer, SwitchContinuity,
};
use ade_core::contract::providers::{Capability, Support};

/// The owned inputs of one eligibility decision.
struct Gathered {
    conversation: Conversation,
    target: Account,
    open_requests: usize,
    queued: usize,
    lease_unresolved: bool,
    draining: bool,
    capability: Capability,
}

impl Gathered {
    fn read(d: &Data, conversation_id: &str, account_id: &str) -> Result<Self> {
        let conversation = d.store.conversation(conversation_id)?;
        let target = d.store.account(account_id)?;
        let open_requests = d
            .store
            .pending(conversation_id)?
            .iter()
            .filter(|request| matches!(request.status.as_str(), "pending" | "responding"))
            .count();
        // A provider without a capability record never claims native continuation.
        let capability = crate::capabilities::record(&conversation.provider)
            .map(|record| record.conversation.account_switch)
            .unwrap_or_else(|_| Capability::new(Support::Unknown, "No capability record"));
        Ok(Self {
            open_requests,
            queued: d.store.queued(conversation_id)?.len(),
            lease_unresolved: Sessions::ensure_lease_resolved(
                d,
                &leases::LeaseKey::Agent(conversation_id.to_owned()),
            )
            .is_err(),
            draining: d.draining,
            capability,
            conversation,
            target,
        })
    }

    fn facts(&self) -> Facts<'_> {
        let c = &self.conversation;
        let t = &self.target;
        Facts {
            provider: &c.provider,
            status: &c.status,
            active_turn: c.active_turn_id.is_some(),
            open_requests: self.open_requests,
            queued: self.queued,
            queue_paused: c.queue_paused,
            terminal_owned: c.terminal_owner.is_some(),
            imported: c.status == crate::history::import::IMPORTED_STATUS,
            lease_unresolved: self.lease_unresolved,
            draining: self.draining,
            setting_sources: c.provider_config.setting_sources.len(),
            current_account: c.account_id.as_deref(),
            native_session: c.provider_thread_id.is_some(),
            native_switch: self.capability.support,
            target: Target {
                id: &t.id,
                provider: &t.provider,
                state: &t.state,
                generation: t.generation,
                identity_pinned: match t.provider.as_str() {
                    "claude" => t.claude_identity.is_some(),
                    "codex" => t.codex_identity.is_some(),
                    "omp" => t.omp_identity.is_some(),
                    _ => false,
                },
            },
        }
    }
}

/// The excerpt a new native session would receive, or none for native continuation.
fn transfer(d: &Data, conversation: &str, continuity: SwitchContinuity) -> Result<Excerpt> {
    if continuity == SwitchContinuity::NativeContinuation {
        return Ok(Excerpt {
            text: String::new(),
            messages: 0,
            truncated: false,
        });
    }
    let messages = d.store.messages(conversation, None, 200)?;
    let lines: Vec<_> = messages
        .iter()
        .map(|message| switch::Line {
            role: &message.role,
            text: &message.text,
        })
        .collect();
    Ok(switch::excerpt(&lines))
}

impl Sessions {
    pub(super) fn account_switch_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "account.switch.preview" => {
                let preview: AccountSwitchPreviewRequest = decode(request)?;
                let id = non_empty("conversation_id", &preview.conversation_id)?;
                let account_id = non_empty("account_id", &preview.account_id)?;
                let d = self.data.lock().unwrap();
                let gathered = Gathered::read(&d, id, account_id)?;
                let (continuity, refusal, disclosure) =
                    match switch::decide(&gathered.facts(), None) {
                        Decision::Eligible(continuity) => {
                            let excerpt = transfer(&d, id, continuity)?;
                            let disclosure = switch::disclosure(
                                continuity,
                                gathered.conversation.provider_thread_id.is_some(),
                                excerpt.messages,
                                excerpt.truncated,
                            );
                            (Some(continuity), None, Some(disclosure))
                        }
                        Decision::Refused(reason) => (None, Some(reason), None),
                    };
                reply(&AccountSwitchPreview {
                    tag: Default::default(),
                    conversation_id: gathered.conversation.id.clone(),
                    from_account_id: gathered.conversation.account_id.clone(),
                    to_account_id: gathered.target.id.clone(),
                    to_generation: gathered.target.generation,
                    continuity,
                    refusal,
                    capability: gathered.capability,
                    disclosure,
                })
            }
            "account.switch" => self.switch_account(request),
            "account.switch.list" => {
                let list: AccountSwitchListRequest = decode(request)?;
                let id = non_empty("conversation_id", &list.conversation_id)?;
                reply(&AccountSwitches {
                    tag: Default::default(),
                    switches: self.data.lock().unwrap().store.account_switches(id)?,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }

    fn switch_account(&self, request: &Value) -> Result<Value> {
        let switch_request: AccountSwitchRequest = decode(request)?;
        let operation_id = non_empty("operation_id", &switch_request.operation_id)?;
        ensure!(operation_id.len() <= 512, "Invalid operation_id");
        let id = non_empty("conversation_id", &switch_request.conversation_id)?;
        let account_id = non_empty("account_id", &switch_request.account_id)?;
        let now = now_ms();
        let mut d = self.data.lock().unwrap();
        if let Some(stored) =
            persistence_result(d.store.account_switch_admission(operation_id, request, now))?
        {
            return Ok(stored);
        }
        let gathered = Gathered::read(&d, id, account_id)?;
        let expectation = Expectation {
            current_account: switch_request.expected_account_id.as_deref(),
            target_generation: switch_request.expected_generation,
            continuity: switch_request.continuity,
        };
        let continuity = match switch::decide(&gathered.facts(), Some(&expectation)) {
            Decision::Eligible(continuity) => continuity,
            Decision::Refused(reason) => bail!(reason),
        };
        let excerpt = transfer(&d, id, continuity)?;
        let prior = gathered.conversation;
        let from_generation = prior
            .account_id
            .as_deref()
            .and_then(|from| d.store.account(from).ok())
            .map(|account| account.generation);
        // An idle Agent still runs under the earlier account. Stop it before
        // the switch commits; a failed stop leaves the switch unapplied.
        let agent_stopped = match d.agents.get(id) {
            Some(agent) => {
                let rpc = agent
                    .rpc
                    .as_ref()
                    .context("The Agent is still connecting; retry the switch")?;
                rpc.stop_confirmed()?;
                d.agents.remove(id);
                true
            }
            None => false,
        };
        let mut next = prior.clone();
        next.account_id = Some(gathered.target.id.clone());
        next.account_context = "managed".into();
        if continuity == SwitchContinuity::NewNativeSession {
            next.provider_thread_id = None;
            next.runtime_cursor = 0;
        }
        if agent_stopped {
            next.status = "disconnected".into();
        }
        next.updated_at = now;
        let record = AccountSwitch {
            id: operation_id.to_owned(),
            conversation_id: prior.id.clone(),
            provider: prior.provider.clone(),
            from_account_id: prior.account_id.clone(),
            from_generation,
            to_account_id: gathered.target.id.clone(),
            to_generation: gathered.target.generation,
            continuity,
            previous_native_session: prior.provider_thread_id.clone(),
            context_transfer: if excerpt.messages > 0 {
                ContextTransfer::Pending
            } else {
                ContextTransfer::None
            },
            context_messages: excerpt.messages,
            context_truncated: excerpt.truncated,
            agent_stopped,
            disclosure: switch::disclosure(
                continuity,
                prior.provider_thread_id.is_some(),
                excerpt.messages,
                excerpt.truncated,
            ),
            created_at: now,
        };
        let response = reply(&AccountSwitched {
            tag: Default::default(),
            switch: record.clone(),
        })?;
        let committed = d.store.commit_account_switch(
            crate::store::SwitchCommit {
                operation_id,
                payload: request,
                prior: &prior,
                next: &next,
                record: &record,
                excerpt: (excerpt.messages > 0).then_some(excerpt.text.as_str()),
                account_name: &gathered.target.name,
                now,
            },
            &response,
        );
        if let Err(error) = committed {
            // The Agent is gone even though the switch did not commit; record
            // that honestly under the unchanged account.
            if agent_stopped {
                let mut current = prior.clone();
                current.status = "disconnected".into();
                current.updated_at = now;
                if d.store.commit_conversation(&current, &[], &[]).is_ok() {
                    let _ = self.changed(&mut d, &current, &[]);
                }
            }
            return persistence_result(Err(error));
        }
        self.changed(&mut d, &next, &[])?;
        Ok(response)
    }
}
