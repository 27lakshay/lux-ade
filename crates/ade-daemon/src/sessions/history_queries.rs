//! Daemon-owned identified native reads, coalescing, bounded retention, and query-only backoff.
use super::*;
use crate::history::import::{NativeStore, native_page};
use ade_core::contract::{
    conversations::{ConversationHistory, ConversationHistoryRequest},
    providers::{
        ProviderHistoryContext, ProviderHistorySnapshot, ProviderWorkerFailure,
        ProviderWorkerFailureCode as Code, ProviderWorkerHistoryRequest,
    },
};
use ade_core::{error::Failure, json_budget};
use rusqlite::OptionalExtension;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::Condvar,
    time::{Duration, Instant},
};

const RETAINED_BYTES: u64 = 1024 * 1024;
const RETAINED_PAGES: usize = 4;
const IN_FLIGHT: usize = 4;
const WAITERS: usize = 32;
#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    running: HashMap<String, Arc<Flight>>,
}
struct Entry {
    conversation: String,
    pin: String,
    key: String,
    page: Arc<ConversationHistory>,
    usage: json_budget::Usage,
    attempts: u8,
    retry_at: Instant,
    error: Option<ProviderWorkerFailure>,
}
struct Flight {
    answer: Mutex<Option<Arc<Answer>>>,
    ready: Condvar,
    waiters: AtomicUsize,
}
struct Answer {
    page: Arc<ConversationHistory>,
    stale_error: Option<ProviderWorkerFailure>,
}
impl Answer {
    fn value(&self) -> Result<Value> {
        let mut value = reply(self.page.as_ref())?;
        if let Some(error) = &self.stale_error {
            value["stale"] = json!(true);
            value["complete"] = json!(false);
            value["error"] = serde_json::to_value(error)?;
        }
        Ok(value)
    }
}
struct Pin {
    context: ProviderHistoryContext,
    session: String,
    fingerprint: String,
    rpc: Option<Arc<dyn Provider>>,
    store: Option<NativeStore>,
    source: Option<PathBuf>,
}
struct Hasher(Sha256);
impl Write for Hasher {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn fingerprint(value: &impl serde::Serialize) -> Result<String> {
    let mut writer = Hasher(Sha256::new());
    serde_json::to_writer(&mut writer, value)?;
    Ok(format!("{:x}", writer.0.finalize()))
}
fn failure(error: &anyhow::Error) -> ProviderWorkerFailure {
    let category = error.downcast_ref::<Failure>().copied().unwrap_or_else(|| {
        Failure::provider(&json!({"message":error.to_string()}), Failure::Unavailable)
    });
    let code = match category {
        Failure::ResourceLimit => Code::ResourceLimit,
        Failure::Authentication => Code::AuthenticationRequired,
        Failure::RateLimit | Failure::UsageLimit => Code::RateLimited,
        Failure::Disconnected
        | Failure::OutcomeUnknown
        | Failure::ProcessExited
        | Failure::Unavailable => Code::TransportFailure,
        Failure::InvalidData => Code::ProtocolMismatch,
        _ => Code::ProviderFailure,
    };
    ProviderWorkerFailure {
        code,
        message: category.to_string(),
    }
}
fn refused(
    id: &str,
    epoch: u64,
    snapshot: Option<ProviderHistorySnapshot>,
    error: ProviderWorkerFailure,
) -> ConversationHistory {
    ConversationHistory {
        tag: Default::default(),
        conversation_id: id.into(),
        snapshot,
        messages: vec![],
        next_native_cursor: None,
        complete: false,
        retained_bytes: 2,
        stale: false,
        error: Some(error),
        history_epoch: epoch,
    }
}
fn temporary(error: &ProviderWorkerFailure) -> bool {
    matches!(
        error.code,
        Code::TransportFailure | Code::Timeout | Code::RateLimited
    )
}
fn matches_scope(snapshot: &ProviderHistorySnapshot, pin: &Pin) -> bool {
    snapshot.provider == pin.context.provider
        && snapshot.session == pin.session
        && snapshot.execution_id == pin.context.execution_id
        && snapshot.account_id == pin.context.account_id
        && snapshot.invalidation_epoch == pin.context.invalidation_epoch
        && pin
            .context
            .lineage
            .as_ref()
            .is_none_or(|lineage| snapshot.lineage.as_ref() == Some(lineage))
}
impl Sessions {
    fn history_pin(&self, id: &str) -> Result<Pin> {
        let d = self.data.lock().unwrap();
        let c = d.store.conversation(id)?;
        let epoch = d.store.history_epoch(id)?;
        let imported: Option<(String, String, String, Option<String>)> = d.store.connection.query_row(
            "SELECT provider,native_session_id,source_path,account_id FROM history_imports WHERE conversation_id=?1", [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        ensure!(
            imported.as_ref().is_none_or(|row| row.0 == c.provider),
            Failure::Rejected
        );
        let account_id = imported
            .as_ref()
            .and_then(|row| row.3.clone())
            .or_else(|| c.account_id.clone());
        let account = account_id
            .as_deref()
            .map(|id| d.store.account(id))
            .transpose()?;
        ensure!(
            account
                .as_ref()
                .is_none_or(|account| account.provider == c.provider),
            Failure::Rejected
        );
        let session = imported
            .as_ref()
            .map(|row| row.1.clone())
            .or_else(|| c.provider_thread_id.clone())
            .unwrap_or_default();
        let context = ProviderHistoryContext {
            provider: c.provider.clone(),
            execution_id: c.runtime_run.clone().unwrap_or_else(|| session.clone()),
            account_id,
            lineage: None,
            invalidation_epoch: epoch,
        };
        let fingerprint = fingerprint(&(
            &c.id,
            &c.provider,
            &c.runtime_run,
            &c.provider_thread_id,
            &c.account_context,
            &c.execution_host,
            &imported,
            account.as_ref().map(|account| {
                (
                    &account.id,
                    &account.native_home,
                    account.generation,
                    &account.state,
                )
            }),
            d.agents.get(id).map(|agent| {
                (
                    &agent.run_id,
                    agent.stopping,
                    agent.account_generation,
                    agent.rpc.is_some(),
                )
            }),
            epoch,
        ))?;
        let rpc = d
            .agents
            .get(id)
            .filter(|agent| {
                !agent.stopping
                    && c.runtime_run.as_ref() == Some(&agent.run_id)
                    && agent.account_generation
                        == account.as_ref().map(|account| account.generation)
            })
            .and_then(|agent| agent.rpc.clone());
        let provider = match c.provider.as_str() {
            "codex" => Some(ade_core::contract::history::HistoryImportProvider::Codex),
            "claude" => Some(ade_core::contract::history::HistoryImportProvider::Claude),
            _ => None,
        };
        let store = if c.execution_host.is_none() {
            provider
                .map(|provider| {
                    if let Some(account) = &account {
                        Ok(NativeStore {
                            provider,
                            account_id: Some(account.id.clone()),
                            home: PathBuf::from(&account.native_home),
                        })
                    } else {
                        NativeStore::default_for(provider)
                    }
                })
                .transpose()?
        } else {
            None
        };
        Ok(Pin {
            context,
            session,
            fingerprint,
            rpc,
            store,
            source: imported.map(|row| PathBuf::from(row.2)),
        })
    }
    fn read_native_history(
        &self,
        request: &ConversationHistoryRequest,
        pin: &Pin,
    ) -> Result<ConversationHistory> {
        let query = ProviderWorkerHistoryRequest {
            session: pin.session.clone(),
            context: pin.context.clone(),
            snapshot: request.snapshot.clone(),
            cursor: request.native_cursor.clone(),
            max_items: request.max_items.unwrap_or(32),
            max_bytes: request.max_bytes.unwrap_or(262144),
        };
        if query.session.is_empty() {
            return Ok(refused(&request.conversation_id, pin.context.invalidation_epoch, None, ProviderWorkerFailure { code: Code::Unsupported,
                message: "This conversation has no identified native history source; no execution was opened".into() }));
        }
        let (snapshot, result) = if pin.context.provider != "claude"
            && let Some(rpc) = &pin.rpc
        {
            match rpc.history(&query) {
                Err(error) => {
                    return Ok(refused(
                        &request.conversation_id,
                        pin.context.invalidation_epoch,
                        None,
                        failure(&error),
                    ));
                }
                Ok(page) => {
                    ensure!(
                        page.items.len() <= query.max_items as usize
                            && page.retained_bytes
                                == json_budget::encoded_size(&page.items)? as u64,
                        Failure::InvalidData
                    );
                    let original_items = page.items.len();
                    ensure!(
                        page.item_cursors.is_empty() || page.item_cursors.len() == original_items,
                        Failure::InvalidData
                    );
                    let messages = page
                        .items
                        .into_iter()
                        .map(|item| {
                            let id = item.client_id.unwrap_or_else(|| {
                                format!("{}:{}", request.conversation_id, item.id)
                            });
                            Message {
                                id,
                                conversation_id: request.conversation_id.clone(),
                                provider_item_id: Some(item.id),
                                native_message: item.native_message,
                                role: item.role,
                                kind: item.kind,
                                text: item.text,
                                content: item.content,
                                status: item.status,
                                turn_id: item.turn,
                                sequence: 0,
                                attachments: vec![],
                                review_feedback: None,
                                delivery: None,
                            }
                        })
                        .collect::<Vec<_>>();
                    let mut response = ConversationHistory {
                        tag: Default::default(),
                        conversation_id: request.conversation_id.clone(),
                        snapshot: Some(page.snapshot),
                        messages,
                        next_native_cursor: page.next_cursor,
                        complete: page.complete && page.error.is_none(),
                        retained_bytes: 0,
                        stale: false,
                        error: page.error,
                        history_epoch: pin.context.invalidation_epoch,
                    };
                    self.merge_history_delivery(&mut response)?;
                    response.retained_bytes = json_budget::encoded_size(&response.messages)? as u64;
                    while response.retained_bytes > query.max_bytes as u64
                        && !response.messages.is_empty()
                    {
                        let last = response.messages.pop().unwrap();
                        response.retained_bytes -= json_budget::encoded_size(&last)? as u64
                            + u64::from(!response.messages.is_empty());
                    }
                    if response.messages.len() < original_items {
                        ensure!(
                            !response.messages.is_empty()
                                && page.item_cursors.len() == original_items,
                            Failure::ResourceLimit
                        );
                        let cursor = &page.item_cursors[response.messages.len() - 1];
                        ensure!(
                            !cursor.is_empty() && cursor.len() <= 4096,
                            Failure::InvalidData
                        );
                        response.next_native_cursor = Some(cursor.clone());
                        response.complete = false;
                    }
                    ensure!(
                        response.retained_bytes <= query.max_bytes as u64,
                        Failure::ResourceLimit
                    );
                    return Ok(response);
                }
            }
        } else if let Some(store) = &pin.store {
            match native_page::read_page(
                store,
                pin.source.as_deref(),
                &query,
                &request.conversation_id,
                &pin.fingerprint,
            ) {
                Ok(page) => (page.snapshot, page.result),
                Err(error) => {
                    return Ok(refused(
                        &request.conversation_id,
                        pin.context.invalidation_epoch,
                        None,
                        failure(&error),
                    ));
                }
            }
        } else {
            return Ok(refused(
                &request.conversation_id,
                pin.context.invalidation_epoch,
                None,
                ProviderWorkerFailure {
                    code: Code::Unsupported,
                    message: "This provider has no declared read-only native history source".into(),
                },
            ));
        };
        let mut response = match result {
            Ok((messages, next_native_cursor, complete)) => ConversationHistory {
                tag: Default::default(),
                conversation_id: request.conversation_id.clone(),
                snapshot: Some(snapshot),
                retained_bytes: json_budget::encoded_size(&messages)? as u64,
                messages,
                next_native_cursor,
                complete,
                stale: false,
                error: None,
                history_epoch: pin.context.invalidation_epoch,
            },
            Err(error) => refused(
                &request.conversation_id,
                pin.context.invalidation_epoch,
                Some(snapshot),
                failure(&error),
            ),
        };
        self.merge_history_delivery(&mut response)?;
        response.retained_bytes = json_budget::encoded_size(&response.messages)? as u64;
        ensure!(
            response.retained_bytes <= query.max_bytes as u64,
            Failure::ResourceLimit
        );
        Ok(response)
    }
    fn merge_history_delivery(&self, response: &mut ConversationHistory) -> Result<()> {
        let d = self.data.lock().unwrap();
        for message in &mut response.messages {
            let saved: Option<(String, i64, Option<String>)> = d.store.connection.query_row(
                "SELECT id,sequence,json_extract(data,'$.delivery') FROM messages WHERE conversation_id=?1 AND (id=?2 OR provider_item_id=?3) ORDER BY CASE WHEN id=?2 THEN 0 ELSE 1 END LIMIT 1",
                rusqlite::params![response.conversation_id, message.id, message.provider_item_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
            if let Some((id, sequence, delivery)) = saved {
                message.id = id;
                message.sequence = sequence;
                message.delivery = delivery
                    .map(|raw| {
                        ensure!(
                            json_budget::within_budget(raw.as_bytes(), 65536),
                            Failure::ResourceLimit
                        );
                        Ok::<_, anyhow::Error>(serde_json::from_str(&raw)?)
                    })
                    .transpose()?;
            }
        }
        Ok(())
    }
    pub(super) fn native_history_query(&self, request: &Value) -> Result<Value> {
        let fields = request
            .as_object()
            .context("Invalid native history query envelope")?
            .iter()
            .filter(|(key, _)| key.as_str() != "op")
            .map(|(key, value)| (key.as_str(), value));
        let request = <ConversationHistoryRequest as serde::Deserialize>::deserialize(
            serde::de::value::MapDeserializer::<_, serde_json::Error>::new(fields),
        )?;
        ensure!(
            request
                .native_cursor
                .as_ref()
                .is_none_or(|cursor| cursor.len() <= 4096),
            "Invalid native history cursor"
        );
        ensure!(
            request.native_cursor.is_none() || request.snapshot.is_some(),
            "A native continuation requires its identified snapshot"
        );
        ensure!(
            (1..=32).contains(&request.max_items.unwrap_or(32))
                && (1..=524288).contains(&request.max_bytes.unwrap_or(262144)),
            "Invalid native history page budget"
        );
        if let Some(snapshot) = &request.snapshot {
            ensure!(
                snapshot.source.len() <= 8192
                    && snapshot.generation.len() <= 128
                    && snapshot.session.len() <= 256
                    && snapshot.execution_id.len() <= 256
                    && snapshot
                        .lineage
                        .as_ref()
                        .is_none_or(|lineage| lineage.len() <= 256),
                "Invalid native history snapshot"
            );
        }
        let pin = match self.history_pin(non_empty("conversation_id", &request.conversation_id)?) {
            Ok(pin) => pin,
            Err(error) => {
                let epoch = self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .history_epoch(&request.conversation_id)?;
                return reply(&refused(
                    &request.conversation_id,
                    epoch,
                    None,
                    failure(&error),
                ));
            }
        };
        if request
            .history_epoch
            .is_some_and(|epoch| epoch != pin.context.invalidation_epoch)
            || request
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| !matches_scope(snapshot, &pin))
        {
            return reply(&refused(&request.conversation_id, pin.context.invalidation_epoch, None, ProviderWorkerFailure { code: Code::InvalidRequest,
                message: "Native history ownership or epoch changed; reload from an identified first page".into() }));
        }
        let key = fingerprint(&(&request, &pin.fingerprint))?;
        let (flight, leader) = {
            let mut cache = self.native_history.lock().unwrap();
            cache.entries.retain(|entry| {
                (entry.conversation != request.conversation_id || entry.pin == pin.fingerprint)
                    && entry
                        .page
                        .snapshot
                        .as_ref()
                        .is_some_and(native_page::source_current)
            });
            if let Some(flight) = cache.running.get(&key) {
                (flight.clone(), false)
            } else {
                if let Some(entry) = cache.entries.iter().find(|entry| {
                    entry.key == key && entry.retry_at > Instant::now() && entry.error.is_some()
                }) {
                    return Answer {
                        page: entry.page.clone(),
                        stale_error: entry.error.clone(),
                    }
                    .value();
                }
                if cache.running.len() == IN_FLIGHT {
                    return reply(&refused(
                        &request.conversation_id,
                        pin.context.invalidation_epoch,
                        None,
                        ProviderWorkerFailure {
                            code: Code::ResourceLimit,
                            message:
                                "Native history reader is at its bounded concurrent-query limit"
                                    .into(),
                        },
                    ));
                }
                let flight = Arc::new(Flight {
                    answer: Mutex::new(None),
                    ready: Condvar::new(),
                    waiters: AtomicUsize::new(0),
                });
                cache.running.insert(key.clone(), flight.clone());
                (flight, true)
            }
        };
        if !leader {
            if flight.waiters.fetch_add(1, Ordering::Relaxed) >= WAITERS {
                flight.waiters.fetch_sub(1, Ordering::Relaxed);
                return reply(&refused(
                    &request.conversation_id,
                    pin.context.invalidation_epoch,
                    None,
                    ProviderWorkerFailure {
                        code: Code::ResourceLimit,
                        message: "Native history query has too many matching waiters".into(),
                    },
                ));
            }
            let answer = flight.answer.lock().unwrap();
            let (answer, _) = flight
                .ready
                .wait_timeout_while(answer, Duration::from_secs(40), |answer| answer.is_none())
                .unwrap();
            flight.waiters.fetch_sub(1, Ordering::Relaxed);
            let current = self.history_pin(&request.conversation_id);
            if current.is_err()
                || current
                    .as_ref()
                    .is_ok_and(|current| current.fingerprint != pin.fingerprint)
                || answer.as_ref().is_some_and(|answer| {
                    answer
                        .page
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| !native_page::source_current(snapshot))
                })
            {
                return reply(&refused(
                    &request.conversation_id,
                    pin.context.invalidation_epoch,
                    None,
                    ProviderWorkerFailure {
                        code: Code::InvalidRequest,
                        message:
                            "Native history ownership or source changed before its coalesced reply"
                                .into(),
                    },
                ));
            }
            return match answer.as_ref() {
                Some(answer) => answer.value(),
                None => reply(&refused(
                    &request.conversation_id,
                    pin.context.invalidation_epoch,
                    None,
                    ProviderWorkerFailure {
                        code: Code::Timeout,
                        message:
                            "The identified native history query timed out; no effect was replayed"
                                .into(),
                    },
                )),
            };
        }
        let mut page = self
            .read_native_history(&request, &pin)
            .unwrap_or_else(|error| {
                refused(
                    &request.conversation_id,
                    pin.context.invalidation_epoch,
                    None,
                    failure(&error),
                )
            });
        let current = self.history_pin(&request.conversation_id);
        if current.is_err()
            || current
                .as_ref()
                .is_ok_and(|current| current.fingerprint != pin.fingerprint)
            || page.snapshot.as_ref().is_some_and(|snapshot| {
                !matches_scope(snapshot, &pin) || !native_page::source_current(snapshot)
            })
        {
            page = refused(&request.conversation_id, current.as_ref().map_or(pin.context.invalidation_epoch, |pin| pin.context.invalidation_epoch), None,
                ProviderWorkerFailure { code: Code::InvalidRequest, message: "Native history changed ownership while it was read; the late result was fenced".into() });
        }
        let page = Arc::new(page);
        let mut answer = Answer {
            page: page.clone(),
            stale_error: None,
        };
        {
            let mut cache = self.native_history.lock().unwrap();
            let prior = cache.entries.iter().position(|entry| entry.key == key);
            if let Some(error) = page.error.as_ref().filter(|error| temporary(error))
                && let Some(index) = prior
            {
                let entry = &mut cache.entries[index];
                if entry
                    .page
                    .snapshot
                    .as_ref()
                    .is_some_and(native_page::source_current)
                    && request
                        .snapshot
                        .as_ref()
                        .is_none_or(|snapshot| entry.page.snapshot.as_ref() == Some(snapshot))
                    && page
                        .snapshot
                        .as_ref()
                        .is_none_or(|snapshot| entry.page.snapshot.as_ref() == Some(snapshot))
                {
                    entry.attempts = entry.attempts.saturating_add(1).min(4);
                    entry.retry_at =
                        Instant::now() + Duration::from_millis(250u64 << entry.attempts);
                    entry.error = Some(error.clone());
                    answer.page = entry.page.clone();
                    answer.stale_error = Some(error.clone());
                }
            }
            if answer.stale_error.is_none() {
                if let Some(index) = prior {
                    cache.entries.remove(index);
                }
                if page.error.is_none()
                    && page.snapshot.is_some()
                    && let Some(mut usage) =
                        json_budget::encoded_usage(page.as_ref(), RETAINED_BYTES as usize)?
                    && usage.nodes <= json_budget::MAX_NODES - 16
                    && usage.bytes <= RETAINED_BYTES as usize - 2048
                {
                    // Reserve bounded typed-failure metadata before a temporary refusal.
                    usage.add(json_budget::Usage {
                        bytes: 2048,
                        nodes: 16,
                    });
                    while cache.entries.len() >= RETAINED_PAGES || {
                        let held = cache.entries.iter().fold(
                            json_budget::Usage::default(),
                            |mut held, entry| {
                                held.add(entry.usage);
                                held
                            },
                        );
                        !held.fits_with(usage, RETAINED_BYTES as usize)
                    } {
                        if cache.entries.pop_front().is_none() {
                            break;
                        }
                    }
                    cache.entries.push_back(Entry {
                        conversation: request.conversation_id.clone(),
                        pin: pin.fingerprint.clone(),
                        key: key.clone(),
                        page: page.clone(),
                        usage,
                        attempts: 0,
                        retry_at: Instant::now(),
                        error: None,
                    });
                }
            }
            let answer = Arc::new(answer);
            *flight.answer.lock().unwrap() = Some(answer.clone());
            flight.ready.notify_all();
            cache.running.remove(&key);
            answer.value()
        }
    }
}
