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
use std::path::{Path, PathBuf};

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
                    _ => t.worker_identity.is_some(),
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
    let messages = d.store.messages(conversation, None, 32)?;
    let lines: Vec<_> = messages
        .iter()
        .map(|message| switch::Line {
            role: &message.role,
            text: &message.text,
        })
        .collect();
    let mut excerpt = switch::excerpt(&lines);
    if let Some(first) = messages.first() {
        excerpt.truncated |= d.store.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND sequence<?2)",
            rusqlite::params![conversation, first.sequence],
            |row| row.get::<_, bool>(0),
        )?;
    }
    Ok(excerpt)
}

/// Native continuation for Claude (F026): copies the session's transcript,
/// `<config>/projects/<project>/<session>.jsonl`, and its `<session>/`
/// sidecar directory from the earlier account's config home into the new
/// one's, where `resume` finds it; the Agent SDK documents moving a session
/// file this way to resume it on another host. The earlier home keeps its
/// copy. A transcript already in place with the same bytes is accepted, so a
/// retried switch converges; different bytes are never overwritten.
fn carry_claude_session(session: &str, from: &Path, to: &Path) -> Result<()> {
    ensure!(
        !session.is_empty()
            && session.len() <= 128
            && session
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "The native session ID is not a Claude session ID"
    );
    let name = format!("{session}.jsonl");
    let projects = from.join("projects");
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(&name);
            if std::fs::symlink_metadata(&candidate).is_ok_and(|meta| meta.file_type().is_file()) {
                found.push(entry.file_name());
            }
        }
    }
    let project = match found.as_slice() {
        [project] => project.clone(),
        [] => bail!(
            "Claude's transcript for this session is not in the earlier account's home; nothing was switched"
        ),
        _ => bail!(
            "Claude's transcript for this session is in more than one project directory; nothing was switched"
        ),
    };
    let source = projects.join(&project);
    let target = to.join("projects").join(&project);
    copy_new_file(&source.join(&name), &target.join(&name))?;
    let sidecar = source.join(session);
    if std::fs::symlink_metadata(&sidecar).is_ok_and(|meta| meta.file_type().is_dir()) {
        copy_new_tree(&sidecar, &target.join(session), 0)?;
    }
    Ok(())
}

/// Copies one regular file into place through a temporary name. An existing
/// target must already hold the same bytes.
fn copy_new_file(source: &Path, target: &Path) -> Result<()> {
    let bytes =
        std::fs::read(source).with_context(|| format!("Could not read {}", source.display()))?;
    match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            ensure!(
                meta.file_type().is_file() && std::fs::read(target)? == bytes,
                "A different copy of {} already exists in the new account's home; nothing was overwritten",
                target.display()
            );
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = target.parent().context("Invalid transcript target")?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.ade-{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&temporary, &bytes)?;
    if let Err(error) = std::fs::rename(&temporary, target) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// Copies the regular files under `source`; links and other entries are skipped.
fn copy_new_tree(source: &Path, target: &Path, depth: usize) -> Result<()> {
    ensure!(depth < 8, "Claude's session directory is nested too deeply");
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_new_tree(&entry.path(), &target.join(entry.file_name()), depth + 1)?;
        } else if kind.is_file() {
            copy_new_file(&entry.path(), &target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// The config home a Claude conversation's native session lives in: its
/// managed account's, or, on the provider login, the daemon user's own.
fn claude_home(d: &Data, account: Option<&str>) -> Result<PathBuf> {
    match account {
        Some(account) => Ok(PathBuf::from(d.store.account(account)?.native_home)),
        None => Ok(crate::history::import::NativeStore::default_for(
            ade_core::contract::history::HistoryImportProvider::Claude,
        )?
        .home),
    }
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
        let expectation = Expectation {
            current_account: switch_request.expected_account_id.as_deref(),
            target_generation: switch_request.expected_generation,
            continuity: switch_request.continuity,
        };
        // Replays a settled switch, or decides whether this one may run.
        let plan = |d: &Data| -> Result<std::result::Result<Value, (Gathered, SwitchContinuity)>> {
            if let Some(stored) = persistence_result(d.store.account_switch_admission(
                operation_id,
                request,
                now_ms(),
            ))? {
                return Ok(Ok(stored));
            }
            let gathered = Gathered::read(d, id, account_id)?;
            match switch::decide(&gathered.facts(), Some(&expectation)) {
                Decision::Eligible(continuity) => Ok(Err((gathered, continuity))),
                Decision::Refused(reason) => bail!(reason),
            }
        };
        let mut d = self.data.lock().unwrap();
        if let Ok(stored) = plan(&d)? {
            return Ok(stored);
        }
        // An idle Agent still runs under the earlier account. Stop it before
        // the switch commits; a failed stop leaves the switch unapplied. The
        // stop can take a full shutdown escalation, so it runs without the
        // session lock, and the switch is decided again afterwards.
        let mut agent_stopped = false;
        if let Some(agent) = d.agents.get(id) {
            ensure!(
                agent.rpc.is_some(),
                "The Agent is still connecting; retry the switch"
            );
            if let Some((run, rpc)) = Self::begin_stop(&mut d, id)? {
                drop(d);
                self.finish_stop(id, &run, rpc)?;
                d = self.data.lock().unwrap();
                if Self::owns(&d, id, &run) {
                    d.agents.remove(id);
                }
                agent_stopped = true;
            }
        }
        let now = now_ms();
        let (gathered, continuity) = match plan(&d) {
            Ok(Ok(stored)) => return Ok(stored),
            Ok(Err(eligible)) => eligible,
            Err(error) => {
                if agent_stopped {
                    self.record_stopped_agent(&mut d, id, now);
                }
                return Err(error);
            }
        };
        let excerpt = match transfer(&d, id, continuity) {
            Ok(excerpt) => excerpt,
            Err(error) => {
                if agent_stopped {
                    self.record_stopped_agent(&mut d, id, now);
                }
                return Err(error);
            }
        };
        let prior = gathered.conversation;
        // Native continuation carries the native session to the new account
        // before the switch commits; a failed copy leaves the switch unapplied.
        if continuity == SwitchContinuity::NativeContinuation {
            let carried = (|| -> Result<()> {
                let session = prior
                    .provider_thread_id
                    .as_deref()
                    .context("No native session to continue")?;
                ensure!(
                    prior.provider == "claude",
                    "ADE cannot carry this provider's native session to another account"
                );
                let from = claude_home(&d, prior.account_id.as_deref())?;
                let to = PathBuf::from(&gathered.target.native_home);
                ensure!(from != to, "Both accounts use the same native home");
                carry_claude_session(session, &from, &to)
            })();
            if let Err(error) = carried {
                if agent_stopped {
                    self.record_stopped_agent(&mut d, id, now);
                }
                return Err(error);
            }
        }
        let from_generation = prior
            .account_id
            .as_deref()
            .and_then(|from| d.store.account(from).ok())
            .map(|account| account.generation);
        let mut next = prior.clone();
        next.account_id = Some(gathered.target.id.clone());
        next.account_context = crate::model::AccountContext::Managed;
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
        let response = match reply(&AccountSwitched {
            tag: Default::default(),
            switch: record.clone(),
        }) {
            Ok(response) => response,
            Err(error) => {
                if agent_stopped {
                    self.record_stopped_agent(&mut d, id, now);
                }
                return Err(error);
            }
        };
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
            if agent_stopped {
                self.record_stopped_agent(&mut d, id, now);
            }
            return persistence_result(Err(error));
        }
        self.changed(&mut d, &next, &[])?;
        Ok(response)
    }

    /// The Agent is gone even though the switch did not commit; record that
    /// honestly under the unchanged account.
    fn record_stopped_agent(&self, d: &mut Data, id: &str, now: i64) {
        let Ok(mut current) = d.store.conversation(id) else {
            return;
        };
        current.status = "disconnected".into();
        current.updated_at = now;
        if d.store.commit_conversation(&current, &[], &[]).is_ok() {
            let _ = self.changed(d, &current, &[]);
        }
    }
}
