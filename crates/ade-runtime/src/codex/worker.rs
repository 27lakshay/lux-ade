//! The SDK worker's bounded native protocol translator. This mode owns no daemon
//! receipts, scheduler or supervisor; every application execution enters via Worker.
use super::NativeClient;
use crate::provider::{Event, Provider};
use ade_core::{
    contract::{Tier, providers::*},
    error::Failure,
    json_budget,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
};

const FRAME: usize = 1024 * 1024;
/// Requests carry a prompt with ADE's 8 MiB of attachments, base64-encoded.
const INPUT_FRAME: usize = 16 * FRAME;
/// An item event carries up to 1 MiB of message text and 1 MiB of tool output (F031).
const OUTPUT_FRAME: usize = 4 * FRAME;
const EVENT_ENTRIES: usize = 32;
/// How long semantic output may wait for a slow reader before it fails.
const SEMANTIC_BACKPRESSURE: std::time::Duration = std::time::Duration::from_secs(30);
const EVENT_BYTES: usize = 2 * OUTPUT_FRAME;

pub fn public_descriptor() -> ProviderWorkerInitialize {
    let native = ade_core::provider::descriptors()
        .iter()
        .find(|d| d.id == "codex")
        .expect("registered Codex descriptor");
    let capabilities = [
        (ProviderWorkerCapabilityName::Streaming, "streaming"),
        (ProviderWorkerCapabilityName::Images, "images"),
        (
            ProviderWorkerCapabilityName::TextAttachments,
            "text_attachments",
        ),
        (ProviderWorkerCapabilityName::Resume, "resume"),
        (ProviderWorkerCapabilityName::Cancel, "cancel"),
        (ProviderWorkerCapabilityName::Questions, "questions"),
        (
            ProviderWorkerCapabilityName::ChildTranscript,
            "child_transcript",
        ),
    ]
    .into_iter()
    .map(|(name, key)| ProviderWorkerCapability {
        name,
        support: Support::Supported,
        available: native.capabilities.iter().any(|c| c == key),
        reason: String::new(),
    })
    .chain([ProviderWorkerCapability {
        name: ProviderWorkerCapabilityName::ToolApproval,
        support: Support::Supported,
        available: native
            .capabilities
            .iter()
            .any(|c| c == "command_approval" || c == "file_approval"),
        reason: String::new(),
    }])
    .collect();
    ProviderWorkerInitialize {
        protocol_version: 2,
        compatible_protocol_versions: vec![2],
        name: native.name.clone(),
        capabilities,
        permission_modes: native.permission_modes.clone(),
        operations: [
            (ProviderWorkerMethod::Initialize, Tier::Query),
            (ProviderWorkerMethod::Open, Tier::EffectCommand),
            (ProviderWorkerMethod::Send, Tier::EffectCommand),
            (ProviderWorkerMethod::Steer, Tier::EffectCommand),
            (ProviderWorkerMethod::Cancel, Tier::IdempotentCommand),
            (ProviderWorkerMethod::Answer, Tier::EffectCommand),
            (ProviderWorkerMethod::History, Tier::Query),
            (ProviderWorkerMethod::ConfigureMcp, Tier::IdempotentCommand),
            (ProviderWorkerMethod::Compact, Tier::EffectCommand),
            (ProviderWorkerMethod::Rewind, Tier::EffectCommand),
            (ProviderWorkerMethod::ChildTranscript, Tier::Query),
            (ProviderWorkerMethod::AccountInspect, Tier::Query),
        ]
        .into_iter()
        .map(|(method, tier)| match method {
            // A bundled provider's managed logins are read by ADE's account probe
            // for that provider (`codex_probe`, `account_probe`, `omp_probe`).
            ProviderWorkerMethod::AccountInspect => ProviderWorkerOperation {
                method,
                tier,
                availability: ProviderWorkerAvailability::Unsupported,
                reason: "ADE's bundled account probe reads this provider's managed logins before the worker starts".into(),
            },
            _ => ProviderWorkerOperation {
                method,
                tier,
                availability: ProviderWorkerAvailability::Available,
                reason: String::new(),
            },
        })
        .collect(),
        limits: ProviderWorkerLimits {
            max_input_frame_bytes: INPUT_FRAME as u32,
            max_input_entries: 1024,
            max_initialize_ms: 15000,
            max_output_frame_bytes: OUTPUT_FRAME as u32,
            max_history_page_items: 32,
            max_output_entries: 32,
            max_concurrency: 4,
            max_partial_frame_ms: 10000,
            max_operation_ms: 45000,
            max_cleanup_ms: 5000,
        },
        requirements: ProviderWorkerRequirements {
            sdk_api_version: 2,
            sdk_version: "0.2.0".into(),
            effect_version: "4.0.0-rc.118".into(),
            platform_node_version: "4.0.0-rc.118".into(),
            node_engine: ">=22".into(),
        },
        native_peer: None,
    }
}

struct Native {
    client: Option<Arc<NativeClient>>,
    servers: Option<Value>,
}
struct Pending {
    id: Value,
    method: String,
    params: Value,
    bytes: usize,
}
struct State {
    native: Mutex<Native>,
    account: Option<ade_core::model::AccountExecution>,
    events: Mutex<Option<mpsc::SyncSender<Event>>>,
    pending: Mutex<HashMap<String, Pending>>,
    stopping: AtomicBool,
    failed: AtomicBool,
}
impl State {
    fn client(&self) -> Result<Arc<NativeClient>> {
        ensure!(!self.stopping.load(Ordering::SeqCst), Failure::Disconnected);
        let mut native = self.native.lock().unwrap();
        if let Some(client) = &native.client {
            return Ok(client.clone());
        }
        let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
        let events = self
            .events
            .lock()
            .unwrap()
            .as_ref()
            .context("Native client is stopping")?
            .clone();
        let client = NativeClient::spawn(&cwd, self.account.as_ref(), events)?;
        if let Some(servers) = native.servers.take() {
            client.configure_mcp(servers)?;
        }
        native.client = Some(client.clone());
        Ok(client)
    }
    fn stop(&self) -> Result<()> {
        self.stopping.store(true, Ordering::SeqCst);
        self.events.lock().unwrap().take();
        let client = self.native.lock().unwrap().client.clone();
        if let Some(client) = client {
            client.stop_confirmed()?;
        }
        Ok(())
    }
    fn dispatch(&self, request: ProviderWorkerRequest) -> Result<Value> {
        use ProviderWorkerMethod::*;
        let params = Value::Object(request.params);
        if request.method == ConfigureMcp {
            let p: ProviderWorkerConfigureMcpRequest = serde_json::from_value(params)?;
            let mut native = self.native.lock().unwrap();
            let servers = Value::Object(p.servers);
            if let Some(client) = &native.client {
                client.configure_mcp(servers)?;
            } else {
                native.servers = Some(servers);
            }
            return Ok(json!({}));
        }
        if request.method == Cancel {
            let p: ProviderWorkerCancelRequest = serde_json::from_value(params)?;
            let evidence = if let Some(turn) = p.turn.as_deref() {
                self.client()?.cancel(&p.session, turn)?;
                ProviderCancelEvidence {
                    scope: ProviderCancelScope::Turn,
                    interruption_requested: true,
                    termination: ProviderCancelTermination::Requested,
                    active_work_remaining: None,
                    queued_work_count: None,
                    background_work_remaining: None,
                    observed_at_ms: None,
                }
            } else {
                ProviderCancelEvidence {
                    scope: ProviderCancelScope::Unknown,
                    interruption_requested: false,
                    termination: ProviderCancelTermination::Unknown,
                    active_work_remaining: None,
                    queued_work_count: None,
                    background_work_remaining: None,
                    observed_at_ms: None,
                }
            };
            return Ok(serde_json::to_value(ProviderWorkerCancelResult {
                tag: ProviderWorkerCancelTag::CancelResult,
                evidence,
            })?);
        }
        let client = self.client()?;
        match request.method {
            Open => {
                let p: ProviderWorkerOpenRequest = serde_json::from_value(params)?;
                Ok(serde_json::to_value(
                    client.open(p.resume.as_deref(), &p.config)?,
                )?)
            }
            Send => {
                let p: ProviderWorkerSendRequest = serde_json::from_value(params)?;
                let prompt = crate::prompt::Prompt {
                    text: p.text,
                    attachments: p.attachments,
                };
                Ok(
                    json!({"turn":client.send(&p.session, &p.submission, p.message_id.as_deref(), &prompt)?,"admitted":true,"dispatch":"dispatched","native_outcome":"accepted"}),
                )
            }
            Steer => {
                let p: ProviderWorkerSteerRequest = serde_json::from_value(params)?;
                let prompt = crate::prompt::Prompt {
                    text: p.text,
                    attachments: p.attachments,
                };
                // The worker contract types a steer reply as a send result.
                Ok(
                    json!({"turn":client.steer(&p.session, &p.turn, &p.message_id, &prompt)?,"admitted":true,"dispatch":"dispatched","native_outcome":"accepted"}),
                )
            }
            Cancel => anyhow::bail!(Failure::Rejected),
            Compact => {
                let p: ProviderWorkerCompactRequest = serde_json::from_value(params)?;
                client.compact(&p.session, &p.operation)?;
                Ok(json!({}))
            }
            Rewind => {
                let p: ProviderWorkerRewindRequest = serde_json::from_value(params)?;
                let result = if let Some(locator) = p.native_message.as_ref() {
                    client.rewind_message(&p.session, locator, &p.operation)?
                } else if let Some(turn) = p.turn.as_deref() {
                    client.rewind(&p.session, turn, &p.operation, None)?
                } else {
                    anyhow::bail!("Codex rewind requires a native turn or message locator")
                };
                Ok(json!({"session":result}))
            }
            ChildTranscript => {
                let p: ProviderWorkerChildTranscriptRequest = serde_json::from_value(params)?;
                client.initialize_native()?;
                client.verify_identity()?;
                client.child_transcript(&p.session, &p.child, p.offset, p.cursor.as_deref())
            }
            History => {
                let p: ProviderWorkerHistoryRequest = serde_json::from_value(params)?;
                ensure!(
                    p.context.account_id.as_deref() == self.account.as_ref().map(|a| a.id.as_str()),
                    Failure::Rejected
                );
                super::history::read(&client, p)
            }
            Answer => {
                let p: ProviderWorkerAnswerRequest = serde_json::from_value(params)?;
                let key = p.id.to_string();
                let mut pending = self.pending.lock().unwrap();
                // Refusing is always safe, even for a request whose turn already
                // ended: the native side gets an answer instead of waiting.
                if let (Some(reason), None) = (&p.reason, pending.get(&key)) {
                    client.rpc.reject(p.id.clone(), reason)?;
                    return Ok(json!({}));
                }
                let native = pending
                    .get(&key)
                    .context("Native request is no longer pending")?;
                if let Some(reason) = &p.reason {
                    client.rpc.reject(native.id.clone(), reason)?;
                } else {
                    let answer: ade_core::requests::RequestAnswer = p.answer.clone();
                    let metadata =
                        super::request_metadata(&native.id, &native.method, &native.params);
                    metadata.validate_answer(&answer)?;
                    client.rpc.respond(
                        native.id.clone(),
                        super::typed_approval_result(&native.method, &answer)?,
                    )?;
                }
                pending.remove(&key);
                Ok(json!({}))
            }
            Initialize | ConfigureMcp | AccountInspect => anyhow::bail!(Failure::Rejected),
        }
    }
}

struct Packet {
    bytes: Vec<u8>,
    semantic: bool,
}
struct Output {
    send: mpsc::SyncSender<Packet>,
    entries: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
}
impl Output {
    fn emit(&self, value: &Value, semantic: bool) -> Result<()> {
        ensure!(
            json_budget::encoded_usage(value, OUTPUT_FRAME - 1)?.is_some(),
            Failure::ResourceLimit
        );
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        if semantic {
            // A slow reader applies backpressure: wait for the bounded queue to
            // drain, which in turn stops reading native output. Only a reader
            // that stays stuck past the deadline fails the session.
            let deadline = std::time::Instant::now() + SEMANTIC_BACKPRESSURE;
            loop {
                if self.entries.fetch_add(1, Ordering::SeqCst) < EVENT_ENTRIES {
                    if self.bytes.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len()
                        <= EVENT_BYTES
                    {
                        break;
                    }
                    self.bytes.fetch_sub(bytes.len(), Ordering::SeqCst);
                }
                self.entries.fetch_sub(1, Ordering::SeqCst);
                ensure!(std::time::Instant::now() < deadline, Failure::ResourceLimit);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        let len = bytes.len();
        if self.send.try_send(Packet { bytes, semantic }).is_err() {
            if semantic {
                self.entries.fetch_sub(1, Ordering::SeqCst);
                self.bytes.fetch_sub(len, Ordering::SeqCst);
            }
            anyhow::bail!(Failure::ResourceLimit);
        }
        Ok(())
    }
}
fn worker_failure(error: &anyhow::Error) -> ProviderWorkerFailure {
    let typed = error
        .downcast_ref::<Failure>()
        .copied()
        .unwrap_or(Failure::Rejected);
    let code = match typed {
        Failure::ResourceLimit => ProviderWorkerFailureCode::ResourceLimit,
        Failure::Authentication => ProviderWorkerFailureCode::AuthenticationRequired,
        Failure::RateLimit | Failure::UsageLimit => ProviderWorkerFailureCode::RateLimited,
        Failure::Disconnected | Failure::ProcessExited | Failure::OutcomeUnknown => {
            ProviderWorkerFailureCode::TransportFailure
        }
        Failure::InvalidData => ProviderWorkerFailureCode::IntegrationBug,
        _ => ProviderWorkerFailureCode::ProviderFailure,
    };
    ProviderWorkerFailure {
        code,
        message: typed.to_string(),
    }
}
fn response(id: Value, result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Native Codex request failed","data":worker_failure(&error)}})
        }
    }
}

/// The managed Codex account this worker runs on, from the public account
/// context every worker on a managed account receives.
fn execution_account() -> Result<Option<ade_core::model::AccountExecution>> {
    let Ok(context) = std::env::var(crate::provider::worker::ACCOUNT_CONTEXT) else {
        return Ok(None);
    };
    let context: ProviderWorkerAccountContext =
        serde_json::from_str(&context).context("Malformed managed account context")?;
    ensure!(
        context.provider == "codex",
        "Managed account context belongs to another provider"
    );
    let identity = context
        .identity
        .map(|identity| serde_json::from_value(Value::Object(identity)))
        .transpose()
        .context("Malformed pinned Codex identity")?;
    Ok(Some(ade_core::model::AccountExecution {
        id: context.account_id,
        provider: context.provider,
        native_home: context.native_home,
        generation: context.generation,
        claude_identity: None,
        codex_identity: identity,
        omp_identity: None,
        worker_identity: None,
    }))
}

pub fn run_native_client() -> Result<()> {
    let account = execution_account()?;
    let (event_send, event_read) = mpsc::sync_channel(4); // Four individually bounded native frames before projection.
    let state = Arc::new(State {
        native: Mutex::new(Native {
            client: None,
            servers: None,
        }),
        account,
        events: Mutex::new(Some(event_send)),
        pending: Mutex::new(HashMap::new()),
        stopping: AtomicBool::new(false),
        failed: AtomicBool::new(false),
    });
    let (output_send, output_read) = mpsc::sync_channel(EVENT_ENTRIES + 5); // Four replies/control plus one fatal report are reserved.
    let output = Arc::new(Output {
        send: output_send,
        entries: Arc::new(AtomicUsize::new(0)),
        bytes: Arc::new(AtomicUsize::new(0)),
    });
    let (commands_send, commands_read) = mpsc::sync_channel(3);
    let commands_read = Arc::new(Mutex::new(commands_read));
    let (controls_send, controls_read) = mpsc::sync_channel(1);
    let mut dispatchers = Vec::new();
    for reader in [
        commands_read.clone(),
        commands_read.clone(),
        commands_read,
        Arc::new(Mutex::new(controls_read)),
    ] {
        let state = state.clone();
        let output = output.clone();
        dispatchers.push(std::thread::spawn(move || {
            loop {
                let request = { reader.lock().unwrap().recv() };
                let Ok(request) = request else { break };
                let request: ProviderWorkerRequest = request;
                let id =
                    serde_json::to_value(&request.id).expect("scalar worker identity serializes");
                let packet = response(id, state.dispatch(request));
                if output.emit(&packet, false).is_err() {
                    state.failed.store(true, Ordering::SeqCst);
                    let _ = state.stop();
                    break;
                }
            }
        }));
    }
    let writer = {
        let state = state.clone();
        let entries = output.entries.clone();
        let bytes = output.bytes.clone();
        std::thread::spawn(move || {
            let mut stdout = std::io::stdout().lock();
            while let Ok(packet) = output_read.recv() {
                if stdout
                    .write_all(&packet.bytes)
                    .and_then(|_| stdout.flush())
                    .is_err()
                {
                    state.failed.store(true, Ordering::SeqCst);
                    let _ = state.stop();
                    break;
                }
                if packet.semantic {
                    entries.fetch_sub(1, Ordering::SeqCst);
                    bytes.fetch_sub(packet.bytes.len(), Ordering::SeqCst);
                }
            }
        })
    };
    let event_reader = {
        let state = state.clone();
        let output = output.clone();
        std::thread::spawn(move || {
            while let Ok(event) = event_read.recv() {
                if state.stopping.load(Ordering::SeqCst) {
                    break;
                }
                let result = (|| -> Result<()> {
                    let packet = json!({"jsonrpc":"2.0","method":"event","params":event});
                    if let Event::Request {
                        id, method, params, ..
                    } = &event
                    {
                        let bytes = json_budget::encoded_size(params)?;
                        let mut pending = state.pending.lock().unwrap();
                        ensure!(
                            pending.len() < 32
                                && pending.values().map(|p| p.bytes).sum::<usize>() + bytes
                                    <= EVENT_BYTES,
                            Failure::ResourceLimit
                        );
                        pending.insert(
                            id.to_string(),
                            Pending {
                                id: id.clone(),
                                method: method.clone(),
                                params: params.clone(),
                                bytes,
                            },
                        );
                    } else if let Event::Finished { session, turn, .. } = &event {
                        state.pending.lock().unwrap().retain(|_, p| {
                            p.params["threadId"] != *session
                                || turn.as_ref().is_none_or(|turn| p.params["turnId"] != *turn)
                        });
                    }
                    output.emit(&packet, true)
                })();
                if result.is_err() {
                    state.failed.store(true, Ordering::SeqCst);
                    let _ = output.emit(&json!({"jsonrpc":"2.0","method":"event","params":Event::Exited { error: Failure::ResourceLimit.to_string() }}), false);
                    let _ = state.stop();
                    break;
                }
            }
        })
    };
    let read_result = (|| -> Result<()> {
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            if state.failed.load(Ordering::SeqCst) {
                anyhow::bail!(Failure::ResourceLimit);
            }
            let mut readiness = libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut readiness, 1, 100) };
            ensure!(ready >= 0, Failure::Disconnected);
            if ready == 0 && reader.buffer().is_empty() {
                continue;
            }
            let mut line = String::new();
            let n = reader
                .by_ref()
                .take(INPUT_FRAME as u64)
                .read_line(&mut line)?;
            if n == 0 {
                break;
            }
            ensure!(
                line.ends_with('\n')
                    && json_budget::within_request_budget(line.as_bytes(), INPUT_FRAME),
                Failure::ResourceLimit
            );
            let request: ProviderWorkerRequest = serde_json::from_str(&line)?;
            let control = matches!(
                request.method,
                ProviderWorkerMethod::Cancel
                    | ProviderWorkerMethod::Answer
                    | ProviderWorkerMethod::Steer
            );
            let send = if control {
                &controls_send
            } else {
                &commands_send
            };
            let id = serde_json::to_value(&request.id)?;
            if send.try_send(request).is_err() {
                output.emit(&response(id, Err(Failure::ResourceLimit.into())), false)?;
            }
        }
        Ok(())
    })();
    let stopped = state.stop();
    drop(commands_send);
    drop(controls_send);
    for dispatcher in dispatchers {
        dispatcher
            .join()
            .map_err(|_| anyhow::anyhow!(Failure::InvalidData))?;
    }
    state.native.lock().unwrap().client.take();
    event_reader
        .join()
        .map_err(|_| anyhow::anyhow!(Failure::InvalidData))?;
    drop(state);
    drop(output);
    writer
        .join()
        .map_err(|_| anyhow::anyhow!(Failure::InvalidData))?;
    stopped?;
    read_result
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_without_a_native_turn_reports_unknown_without_spawning_one() {
        let state = State {
            native: Mutex::new(Native {
                client: None,
                servers: None,
            }),
            account: None,
            events: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        };
        let params = serde_json::from_value(json!({
            "session": "session",
            "source_attempt_id": "attempt",
            "submission_id": "submission",
        }))
        .unwrap();
        let request = ProviderWorkerRequest {
            jsonrpc: ProviderWorkerJsonRpcVersion::V2,
            id: ProviderWorkerRequestId::String("cancel".into()),
            method: ProviderWorkerMethod::Cancel,
            params,
        };

        assert_eq!(
            state.dispatch(request).unwrap(),
            json!({
                "type": "cancel_result",
                "evidence": {
                    "scope": "unknown",
                    "interruption_requested": false,
                    "termination": "unknown",
                    "active_work_remaining": null,
                    "queued_work_count": null,
                    "background_work_remaining": null,
                    "observed_at_ms": null,
                },
            })
        );
        assert!(state.native.lock().unwrap().client.is_none());
    }
}
