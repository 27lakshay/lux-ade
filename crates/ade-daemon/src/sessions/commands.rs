//! `command.*` operations: slash commands and skills for one Conversation (F037).
//!
//! `command.list` reads the provider's command directories and skill roots
//! for the Conversation's workspace, plus ADE's skill catalog, and merges them
//! in [`catalog::merge`]. Filesystem reads run without the session lock.
//!
//! `command.invoke` is an effect command. Its receipt, in the profile
//! database, records the exact native text before anything is queued. The
//! text then joins the Conversation's prompt queue under the derived queue ID
//! `<operation_id>:command`. The queue refuses a second, different prompt under
//! one ID and accepts the same one as already done, so a retry after a lost
//! reply re-offers the stored text and converges instead of queueing twice.
//! Delivery to the provider is the queue's job; the reply says `queued`, never
//! that the provider ran the command.
use super::*;
use crate::receipts::{self, Admission, Status};
use crate::skills::{self, placement};
use ade_core::contract::commands::{
    CommandInvokeOutcome, CommandInvokeRequest, CommandInvoked, CommandKind, CommandList,
    CommandListRequest,
};
use ade_core::contract::skills::{SkillList, SkillReferenceStatus, SkillRootStatus, SkillScope};
use ade_core::model::now_ms;
use rusqlite::{Transaction, TransactionBehavior};
use std::{fs, path::PathBuf};

mod catalog;
use catalog::{Catalogued, Found, Resolution};

const OPERATION_ID_LIMIT: usize = 480;
/// Entries read from one command directory.
const MAX_DIRECTORY_ENTRIES: usize = 512;
/// Largest command file whose frontmatter is read.
const MAX_COMMAND_FILE_BYTES: u64 = 256 * 1024;

/// What a new invocation would do, decided from a fresh listing.
enum Planned {
    Queue(String, Option<String>),
    Unavailable(String),
    Missing(String),
}

/// The derived prompt queue ID of an invocation.
fn queue_id(operation_id: &str) -> String {
    format!("{operation_id}:command")
}

/// The home directory whose provider paths this Conversation reads, or
/// `None` when it runs under an ADE-managed account with its own native home.
fn provider_home(conversation: &Conversation) -> Result<Option<PathBuf>> {
    if conversation.account_id.is_some() {
        return Ok(None);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .context("HOME is not an absolute path; provider command paths are unknown")?;
    Ok(Some(home))
}

/// Reads the command files directly inside `root`.
fn read_command_root(
    root: &catalog::CommandRoot,
    found: &mut Vec<Found>,
    skipped: &mut Vec<String>,
) {
    let entries = match fs::read_dir(&root.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            skipped.push(format!("{}: {error}", root.path.display()));
            return;
        }
        Ok(entries) => entries,
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    if entries.len() > MAX_DIRECTORY_ENTRIES {
        skipped.push(format!(
            "{}: only the first {MAX_DIRECTORY_ENTRIES} entries were read",
            root.path.display()
        ));
    }
    for entry in entries.into_iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some(file) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(name) = file.strip_suffix(".md") else {
            continue;
        };
        if file.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // Providers follow links to command files, so the listing does too.
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let mut command = Found {
            name: name.to_owned(),
            kind: CommandKind::Command,
            scope: root.scope,
            path: path.display().to_string(),
            description: None,
            argument_hint: None,
            content_hash: None,
            problem: None,
        };
        if metadata.len() > MAX_COMMAND_FILE_BYTES {
            command.problem = Some("The command file exceeds 256 KiB".into());
        } else {
            match fs::read_to_string(&path) {
                Ok(text) => {
                    (command.description, command.argument_hint) =
                        catalog::command_file_meta(&text);
                }
                Err(error) => command.problem = Some(format!("Unreadable: {error}")),
            }
        }
        found.push(command);
    }
}

impl Sessions {
    pub(super) fn commands_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "command.list" => {
                let list: CommandListRequest = decode(request)?;
                non_empty("conversation_id", &list.conversation_id)?;
                reply(&self.command_listing(&list.conversation_id)?.1)
            }
            "command.invoke" => self.invoke_command(request),
            _ => bail!("Unknown command operation"),
        }
    }

    fn command_listing(&self, conversation_id: &str) -> Result<(Conversation, CommandList)> {
        let conversation = self
            .data
            .lock()
            .unwrap()
            .store
            .conversation(conversation_id)?;
        self.ensure_workspace_bound(&conversation.workspace_id)?;
        let workspace = PathBuf::from(self.workspace(&conversation.workspace_id)?.root);
        let provider = conversation.provider.as_str();
        let home = provider_home(&conversation)?;
        let mut skipped = Vec::new();
        if home.is_none() {
            skipped.push(
                "User scope: this Conversation runs under an ADE-managed account, whose native home this listing does not read".into(),
            );
        }
        let mut found = Vec::new();
        for root in catalog::command_roots(provider, home.as_deref(), &workspace) {
            read_command_root(&root, &mut found, &mut skipped);
        }
        let skill_roots: Vec<_> =
            placement::provider_roots(home.as_deref().unwrap_or(&workspace), Some(&workspace))
                .into_iter()
                .filter(|root| {
                    root.provider == provider
                        && (home.is_some() || root.scope == SkillScope::Workspace)
                })
                .collect();
        let (roots, references) =
            skills::scan(&skill_roots, Some(&conversation.workspace_id), now_ms());
        for root in roots {
            if matches!(
                root.status,
                SkillRootStatus::Unreadable | SkillRootStatus::NotDirectory
            ) {
                skipped.push(format!("{}: {:?}", root.path, root.status));
            }
        }
        for reference in references {
            found.push(Found {
                name: reference.name.clone().unwrap_or(reference.entry.clone()),
                kind: CommandKind::Skill,
                scope: reference.scope,
                path: reference.path,
                description: reference.description,
                argument_hint: None,
                content_hash: reference.content_hash,
                problem: match reference.status {
                    SkillReferenceStatus::Valid => None,
                    _ => Some(
                        reference
                            .problem
                            .unwrap_or_else(|| "Not a valid skill".into()),
                    ),
                },
            });
        }
        let installed: SkillList = {
            let d = self.data.lock().unwrap();
            skills::ensure_tables(&d.store.connection)?;
            serde_json::from_value(skills::list(&d.store.connection)?)?
        };
        let bundles: Vec<Catalogued> = installed
            .skills
            .into_iter()
            .map(|skill| Catalogued {
                name: skill.name,
                description: skill.description,
                content_hash: skill.content_hash,
            })
            .collect();
        let facts = catalog::Facts {
            provider,
            setting_sources: &conversation.provider_config.setting_sources,
        };
        let entries = catalog::merge(&facts, found, &bundles);
        let listing = CommandList {
            tag: Default::default(),
            conversation_id: conversation.id.clone(),
            provider: provider.to_owned(),
            entries,
            native_catalog: catalog::native_catalog(provider),
            skipped,
        };
        Ok((conversation, listing))
    }

    fn invoke_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let invoke: CommandInvokeRequest = decode(request)?;
        ensure!(
            !invoke.operation_id.is_empty() && invoke.operation_id.len() <= OPERATION_ID_LIMIT,
            "Missing or invalid operation_id"
        );
        non_empty("conversation_id", &invoke.conversation_id)?;
        non_empty("name", &invoke.name)?;
        catalog::check_arguments(&invoke.arguments).map_err(|error| anyhow!(error))?;
        let (conversation, listing) = self.command_listing(&invoke.conversation_id)?;
        let answer = |outcome, native_text: Option<String>, mechanism: Option<String>, reason| {
            CommandInvoked {
                tag: Default::default(),
                operation_id: invoke.operation_id.clone(),
                conversation_id: invoke.conversation_id.clone(),
                name: invoke.name.clone(),
                kind: invoke.kind,
                outcome,
                queue_id: native_text.as_ref().map(|_| queue_id(&invoke.operation_id)),
                native_text,
                mechanism,
                reason,
            }
        };
        // What a new operation would queue; a replay uses its stored record.
        let planned = match catalog::resolve(&listing.entries, &invoke.name, invoke.kind) {
            Resolution::Invoke(entry) => Planned::Queue(
                catalog::native_text(
                    entry
                        .invocation
                        .as_deref()
                        .context("Invocable entry has no text")?,
                    &invoke.arguments,
                ),
                entry.mechanism.clone(),
            ),
            Resolution::Unavailable(reason) => Planned::Unavailable(reason),
            Resolution::Missing(reason) => Planned::Missing(reason),
        };
        let (text, mechanism) = {
            let d = self.data.lock().unwrap();
            ensure!(!d.draining, "Application daemon is restarting");
            receipts::ensure(&d.store.connection)?;
            let tx =
                Transaction::new_unchecked(&d.store.connection, TransactionBehavior::Immediate)?;
            let now = now_ms();
            match receipts::begin(
                &tx,
                &invoke.operation_id,
                "command.invoke",
                request,
                None,
                now,
            )? {
                Admission::New => {
                    // Returning early drops the transaction, which rolls the
                    // receipt back: nothing was queued, so nothing needs reconciling.
                    let (text, mechanism) = match planned {
                        Planned::Queue(text, mechanism) => (text, mechanism),
                        Planned::Missing(reason) => bail!("{reason}"),
                        Planned::Unavailable(reason) => {
                            return reply(&answer(
                                CommandInvokeOutcome::Unavailable,
                                None,
                                None,
                                Some(reason),
                            ));
                        }
                    };
                    Self::ensure_not_imported(&conversation)?;
                    let record = json!({"text": text, "mechanism": mechanism});
                    receipts::settle(
                        &tx,
                        &invoke.operation_id,
                        Status::Dispatched,
                        Some(&record),
                        now,
                    )?;
                    tx.commit()?;
                    (text, mechanism)
                }
                Admission::Replay(receipt) => {
                    let stored = receipt.result.clone().unwrap_or(Value::Null);
                    match receipt.status {
                        Status::Settled | Status::Acknowledged
                            if stored["type"] == "command_invoked" =>
                        {
                            return Ok(stored);
                        }
                        Status::Dispatched if stored["text"].is_string() => (
                            stored["text"].as_str().unwrap_or_default().to_owned(),
                            stored["mechanism"].as_str().map(str::to_owned),
                        ),
                        _ => {
                            if receipt.status != Status::Unknown {
                                receipts::settle(
                                    &tx,
                                    &invoke.operation_id,
                                    Status::Unknown,
                                    None,
                                    now,
                                )?;
                                tx.commit()?;
                            }
                            return reply(&answer(
                                CommandInvokeOutcome::Unknown,
                                None,
                                None,
                                Some("ADE cannot confirm whether this invocation was queued, and it will not queue it again. Inspect the Conversation's queue and transcript.".into()),
                            ));
                        }
                    }
                }
                Admission::Conflict => bail!(
                    "Operation ID {} was already used for a different request",
                    invoke.operation_id
                ),
                Admission::Expired => bail!(
                    "Operation ID {} is past receipt retention; it will not run again",
                    invoke.operation_id
                ),
            }
        };
        // Same derived ID and text: the queue either inserts it or finds it
        // already queued or sent, and refuses any other prompt under that ID.
        let id = queue_id(&invoke.operation_id);
        self.ensure_workspace_bound(&conversation.workspace_id)?;
        let mut d = self.data.lock().unwrap();
        let queued = d.store.conversation(&invoke.conversation_id).and_then(|c| {
            Self::ensure_not_imported(&c)?;
            d.store.enqueue_content(&c.id, &id, &text, &[])?;
            Ok(c)
        });
        let c = queued.map_err(|error| {
            anyhow!(
                "{error:#}. The invocation was not confirmed as queued; retry with the same operation_id, never with a new one"
            )
        })?;
        let done = answer(CommandInvokeOutcome::Queued, Some(text), mechanism, None);
        let value = serde_json::to_value(&done)?;
        receipts::settle(
            &d.store.connection,
            &invoke.operation_id,
            Status::Settled,
            Some(&value),
            now_ms(),
        )?;
        // Publishes the queue change and wakes the dispatcher.
        self.changed(&mut d, &c, &[])?;
        Ok(value)
    }
}
