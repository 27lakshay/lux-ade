//! Disposable client projections. The daemon alone authors runtime state.
use ade_core::error::ClientDataError;
use ade_core::model::{Catalogue, Conversation, Message, PendingRequest};
use serde::ser::{Error as _, SerializeMap};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Default, Clone)]
pub struct View {
    pub queued: Vec<ade_core::model::QueuedPrompt>,
    pub messages: Vec<Message>,
    pub requests: Vec<PendingRequest>,
    revision: u64,
    ui_revision: u64,
    pub older: bool,
}
#[derive(Default, Clone)]
pub struct Snapshot {
    pub providers: Vec<ade_core::provider::Descriptor>,
    pub connected: bool,
    pub connection_error: String,
    pub recovery_revision: u64,
    pub catalog: Catalogue,
    pub views: HashMap<String, Arc<View>>,
    pub boot: String,
    pub revision: u64,
    catalog_revision: u64,
    catalog_source_revision: u64,
    pub error: String,
    pub save_error: String,
    pub command_overflow: bool,
}
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub struct UiRevision {
    boot: String,
    error: String,
    save_error: String,
    command_overflow: bool,
    connected: bool,
    connection_error: String,
    recovery_revision: u64,
    catalog: u64,
    conversation: u64,
}
impl Snapshot {
    // Like T3's scoped thread views, streamed text invalidates only the selected
    // Conversation. Sidebar metadata, connection state and errors remain shared.
    pub fn ui_revision(&self, conversation: Option<&str>) -> UiRevision {
        UiRevision {
            boot: self.boot.clone(),
            error: self.error.clone(),
            save_error: self.save_error.clone(),
            command_overflow: self.command_overflow,
            connected: self.connected,
            connection_error: self.connection_error.clone(),
            recovery_revision: self.recovery_revision,
            catalog: self.catalog_revision,
            conversation: conversation
                .and_then(|id| self.views.get(id))
                .map_or(0, |v| v.ui_revision),
        }
    }
}
#[derive(Default)]
pub struct ClientState {
    pub data: Mutex<Snapshot>,
    listeners: Mutex<Vec<async_channel::Sender<()>>>,
    connection_owner: Arc<ConnectionOwner>,
    unsaved_drafts: Mutex<RetainedDrafts>,
    draft_conflicts: Mutex<HashMap<String, ade_core::model::Draft>>,
    draft_actions: Mutex<HashMap<String, usize>>,
}

/// Covers a draft action and admission of its resulting save. The
/// persistence fence covers that save after this guard is released.
pub(crate) struct DraftAction {
    shared: Shared,
    window: String,
}
pub(crate) fn begin_draft_action(shared: &Shared, window: &str) -> DraftAction {
    *shared
        .draft_actions
        .lock()
        .unwrap()
        .entry(window.into())
        .or_default() += 1;
    DraftAction {
        shared: shared.clone(),
        window: window.into(),
    }
}
pub(crate) fn has_draft_actions(shared: &Shared, window: &str) -> bool {
    shared.draft_actions.lock().unwrap().contains_key(window)
}
impl Drop for DraftAction {
    fn drop(&mut self) {
        let mut actions = self.shared.draft_actions.lock().unwrap();
        if let Some(count) = actions.get_mut(&self.window) {
            *count -= 1;
            if *count == 0 {
                actions.remove(&self.window);
            }
        }
    }
}
/// Latest unacknowledged payloads outlive disposable panes and workspace hosts.
/// One payload per draft is retained; successful acknowledgement releases it.
#[derive(Default)]
struct RetainedDrafts(HashMap<String, (u64, Value)>, HashMap<String, Vec<Value>>);
impl RetainedDrafts {
    fn retain(&mut self, key: &str, sequence: u64, payload: &Value) -> bool {
        if self.0.get(key).is_some_and(|(_, previous)| {
            previous["revision"].as_u64() > payload["revision"].as_u64()
        }) {
            return false;
        }
        if let Some((_, previous)) = self.0.get(key)
            && previous["revision"] == payload["revision"]
            && (previous["text"] != payload["text"]
                || previous["attachments"] != payload["attachments"])
        {
            let alternatives = self.1.entry(key.into()).or_default();
            if !alternatives.iter().any(|candidate| candidate == previous) {
                alternatives.push(previous.clone());
            }
        }
        self.0.insert(key.into(), (sequence, payload.clone()));
        true
    }
    fn acknowledge(&mut self, key: &str, sequence: u64) {
        if self
            .0
            .get(key)
            .is_some_and(|(current, _)| *current == sequence)
        {
            self.0.remove(key);
        }
    }
    fn adopt_saved(
        &mut self,
        key: &str,
        expected: Option<u64>,
        saved: &mut Value,
    ) -> Result<(), String> {
        if self.0.get(key).map(|(sequence, _)| *sequence) != expected {
            return Err(
                "The local draft changed while loading. Review it before choosing again.".into(),
            );
        }
        if let Some((_, local)) = self.0.get(key) {
            saved["revision"] = json!(
                saved["revision"]
                    .as_i64()
                    .unwrap_or_default()
                    .max(local["revision"].as_i64().unwrap_or_default())
            );
        }
        self.0.remove(key);
        self.1.remove(key);
        Ok(())
    }
    fn for_window(&self, window: &str) -> Vec<Value> {
        self.0
            .values()
            .filter(|(_, payload)| payload["window_id"] == window)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}
#[derive(Clone)]
pub struct DraftConflict {
    pub local: ade_core::model::Draft,
    pub saved: ade_core::model::Draft,
    pub alternatives: Vec<ade_core::model::Draft>,
}
pub fn draft_conflict(shared: &Shared, window: &str, conversation: &str) -> Option<DraftConflict> {
    let key = format!("draft:{window}:{conversation}");
    let saved = shared.draft_conflicts.lock().unwrap().get(&key).cloned()?;
    let alternatives = shared
        .unsaved_drafts
        .lock()
        .unwrap()
        .1
        .get(&key)
        .into_iter()
        .flatten()
        .filter_map(|payload| serde_json::from_value(payload.clone()).ok())
        .collect();
    Some(DraftConflict {
        local: unsaved_draft(shared, window, conversation)?,
        saved,
        alternatives,
    })
}
fn resolution_revision(editor: i64, retained: i64, saved: i64) -> Option<i64> {
    editor.max(retained).max(saved).checked_add(1)
}
/// A resolution is an explicit user decision. Ordinary retries never raise a revision.
pub fn resolve_draft(
    shared: &Shared,
    window: &str,
    conversation: &str,
    keep_local: Option<ade_core::model::Draft>,
) -> async_channel::Receiver<Result<Value, String>> {
    let key = format!("draft:{window}:{conversation}");
    let conflict = draft_conflict(shared, window, conversation);
    let Some(conflict) = conflict else {
        let (tx, rx) = async_channel::bounded(1);
        let _ = tx.try_send(Err(
            "This draft conflict has changed. Review the draft again.".into(),
        ));
        return rx;
    };
    match keep_local {
        Some(mut draft) => {
            let Some(revision) = resolution_revision(
                draft.revision,
                conflict.local.revision,
                conflict.saved.revision,
            ) else {
                let (tx, rx) = async_channel::bounded(1);
                let _ = tx.try_send(Err(
                    "Draft revision limit reached; copy your text before closing.".into(),
                ));
                return rx;
            };
            draft.revision = revision;
            command(
                shared.clone(),
                json!({"op":"draft.save", "window_id":window,
                "conversation_id":conversation, "text":draft.text, "attachments":draft.attachments,
                "revision":revision, "expected_revision":conflict.saved.revision, "resolve_draft":true}),
            )
        }
        None => {
            let sequence = shared
                .unsaved_drafts
                .lock()
                .unwrap()
                .0
                .get(&key)
                .map(|(sequence, _)| *sequence);
            command(
                shared.clone(),
                json!({"op":"draft.get", "window_id":window,
                "conversation_id":conversation,"resolve_draft":true,"retained_sequence":sequence}),
            )
        }
    }
}

pub fn restored_draft(
    mut saved: ade_core::model::Draft,
    local: Option<&ade_core::model::Draft>,
    retained: Option<ade_core::model::Draft>,
) -> ade_core::model::Draft {
    if let Some(local) = local
        && local.revision >= saved.revision
    {
        saved = local.clone();
    }
    if let Some(retained) = retained
        && retained.revision >= saved.revision
    {
        saved = retained;
    }
    saved
}
/// Recover the latest failed/in-flight save when its pane is recreated.
pub fn unsaved_draft(
    shared: &Shared,
    window: &str,
    conversation: &str,
) -> Option<ade_core::model::Draft> {
    shared
        .unsaved_drafts
        .lock()
        .unwrap()
        .0
        .get(&format!("draft:{window}:{conversation}"))
        .and_then(|(_, payload)| serde_json::from_value(payload.clone()).ok())
}
#[cfg(test)]
pub(crate) fn retain_draft_for_test(shared: &Shared, payload: Value) {
    let key = persistence_key(&payload).expect("draft persistence key");
    shared
        .unsaved_drafts
        .lock()
        .unwrap()
        .retain(&key, 1, &payload);
}
#[cfg(test)]
pub(crate) fn retry_payloads_for_test(shared: &Shared, window: &str) -> Vec<Value> {
    shared.unsaved_drafts.lock().unwrap().for_window(window)
}
/// Resubmit payloads whose editors may already have been removed. Call before
/// the persistence fence, after capturing any currently mounted editors.
pub fn retry_unsaved_drafts(shared: &Shared, window: &str) {
    let drafts = shared.unsaved_drafts.lock().unwrap().for_window(window);
    for draft in drafts {
        command(shared.clone(), draft);
    }
}
/// Cancels only this client's subscription. Never stops daemon/provider processes.
#[derive(Default)]
struct ConnectionOwner {
    cancelled: AtomicBool,
    socket: Mutex<Option<UnixStream>>,
    wake: Condvar,
}
impl ConnectionOwner {
    fn attach(&self, stream: &UnixStream) -> std::io::Result<()> {
        let mut socket = self.socket.lock().unwrap();
        if self.cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Client closed",
            ));
        }
        *socket = Some(stream.try_clone()?);
        Ok(())
    }
    fn cancel(&self) {
        let mut socket = self
            .socket
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.cancelled.store(true, Ordering::Release);
        if let Some(socket) = socket.take() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
        self.wake.notify_all();
    }
    fn retry_wait(&self) -> bool {
        let socket = self.socket.lock().unwrap();
        let _ = self
            .wake
            .wait_timeout_while(socket, Duration::from_secs(1), |_| {
                !self.cancelled.load(Ordering::Acquire)
            })
            .unwrap();
        !self.cancelled.load(Ordering::Acquire)
    }
}
impl Drop for ClientState {
    fn drop(&mut self) {
        self.connection_owner.cancel();
    }
}
pub type Shared = Arc<ClientState>;
impl ClientState {
    pub fn subscribe(&self) -> async_channel::Receiver<()> {
        let (tx, rx) = async_channel::bounded(1);
        self.listeners.lock().unwrap().push(tx);
        rx
    }
    pub fn notify(&self) {
        self.listeners
            .lock()
            .unwrap()
            .retain(|tx| !matches!(tx.try_send(()), Err(async_channel::TrySendError::Closed(_))));
    }
    pub fn ingest(&self, v: Value) {
        if let Err(error) = self.try_ingest(v) {
            self.data.lock().unwrap().error = error.to_string();
            self.notify();
        }
    }
    fn try_ingest(&self, v: Value) -> Result<(), ClientDataError> {
        // Validate every recognized field before changing boot, catalogue, or view.
        let Some(event) = ValidatedEvent::parse(&v)? else {
            return Ok(());
        };
        if event.older {
            return Ok(());
        }
        let mut s = self.data.lock().unwrap();
        if let Some(boot) = &event.boot {
            if !s.boot.is_empty() && boot != &s.boot {
                return Ok(());
            }
            s.boot = boot.clone();
        }
        let revision = event.revision.unwrap_or(0);
        match event.body {
            EventBody::Catalog {
                mut catalog,
                providers,
            } => {
                if event
                    .revision
                    .is_some_and(|revision| revision < s.catalog_source_revision)
                {
                    return Ok(());
                }
                // A catalogue snapshot may arrive after newer conversation events.
                if event.revision.is_some() {
                    for old in &s.catalog.conversations {
                        if s.views
                            .get(&old.id)
                            .is_some_and(|view| view.revision > revision)
                        {
                            if let Some(incoming) =
                                catalog.conversations.iter_mut().find(|c| c.id == old.id)
                            {
                                *incoming = old.clone();
                            } else {
                                catalog.conversations.push(old.clone());
                            }
                        }
                    }
                    s.catalog_source_revision = revision;
                }
                s.providers = providers;
                s.catalog = catalog;
                s.catalog_revision += 1;
            }
            EventBody::Conversation {
                conversation: c,
                messages,
                requests,
                queued,
                snapshot,
            } => {
                let c = *c;
                let view = Arc::make_mut(s.views.entry(c.id.clone()).or_default());
                let stale = revision < view.revision;
                if stale && !snapshot {
                    return Ok(());
                }
                view.ui_revision += 1;
                view.revision = view.revision.max(revision);
                if let Some(mut incoming) = messages {
                    if snapshot {
                        if stale {
                            for current in &view.messages {
                                if let Some(old) = incoming.iter_mut().find(|m| m.id == current.id)
                                {
                                    *old = current.clone();
                                } else {
                                    incoming.push(current.clone());
                                }
                            }
                        }
                        incoming.sort_by_key(|m| m.sequence);
                        incoming.drain(..incoming.len().saturating_sub(200));
                        view.messages = incoming;
                        view.older = false;
                    } else if !view.older {
                        for message in incoming {
                            if let Some(old) = view.messages.iter_mut().find(|m| m.id == message.id)
                            {
                                *old = message;
                            } else {
                                view.messages.push(message);
                            }
                        }
                        view.messages.sort_by_key(|m| m.sequence);
                        let excess = view.messages.len().saturating_sub(200);
                        view.messages.drain(..excess);
                    }
                }
                if !stale {
                    if let Some(queued) = queued {
                        view.queued = queued;
                    }
                    if let Some(requests) = requests {
                        view.requests = requests;
                    }
                    if let Some(old) = s
                        .catalog
                        .conversations
                        .iter_mut()
                        .find(|old| old.id == c.id)
                    {
                        let changed = old.title != c.title
                            || old.status != c.status
                            || old.workspace_id != c.workspace_id;
                        *old = c;
                        if changed {
                            s.catalog_revision += 1;
                        }
                    } else {
                        s.catalog.conversations.push(c);
                        s.catalog_revision += 1;
                    }
                }
            }
        }
        if crate::bench::enabled()
            && let Some(id) = v["conversation"]["id"].as_str()
            && let Some(view) = s.views.get(id)
        {
            crate::bench::agent_messages("provider_to_client_apply_us", &view.messages);
        }
        s.revision += 1;
        drop(s);
        self.notify();
        Ok(())
    }
}
enum EventBody {
    Catalog {
        catalog: Catalogue,
        providers: Vec<ade_core::provider::Descriptor>,
    },
    Conversation {
        conversation: Box<Conversation>,
        messages: Option<Vec<Message>>,
        requests: Option<Vec<PendingRequest>>,
        queued: Option<Vec<ade_core::model::QueuedPrompt>>,
        snapshot: bool,
    },
}
struct ValidatedEvent {
    boot: Option<String>,
    revision: Option<u64>,
    older: bool,
    body: EventBody,
}
impl ValidatedEvent {
    fn parse(value: &Value) -> Result<Option<Self>, ClientDataError> {
        let kind = value["type"]
            .as_str()
            .ok_or(ClientDataError::InvalidEvent)?;
        if !matches!(
            kind,
            "catalog" | "conversation_snapshot" | "conversation_changed" | "conversation_reload"
        ) {
            return Ok(None);
        }
        fn field<T: serde::de::DeserializeOwned>(
            value: &Value,
            name: &str,
        ) -> Result<T, ClientDataError> {
            serde_json::from_value(value[name].clone()).map_err(|_| ClientDataError::InvalidEvent)
        }
        fn optional<T: serde::de::DeserializeOwned>(
            value: &Value,
            name: &str,
        ) -> Result<Option<T>, ClientDataError> {
            value.get(name).map(|_| field(value, name)).transpose()
        }
        let boot: Option<String> = optional(value, "boot_id")?;
        if boot.as_ref().is_some_and(|boot| boot.is_empty()) {
            return Err(ClientDataError::InvalidEvent);
        }
        let revision = optional(value, "revision")?;
        let older = optional(value, "older")?.unwrap_or(false);
        let body = if kind == "catalog" {
            EventBody::Catalog {
                catalog: field(value, "catalog")?,
                providers: field(value, "providers")?,
            }
        } else {
            let conversation: Conversation = field(value, "conversation")?;
            let messages: Option<Vec<Message>> = optional(value, "messages")?;
            let requests: Option<Vec<PendingRequest>> = optional(value, "requests")?;
            let queued: Option<Vec<ade_core::model::QueuedPrompt>> = optional(value, "queued")?;
            if conversation.id.is_empty()
                || (kind != "conversation_reload" && (messages.is_none() || requests.is_none()))
            {
                return Err(ClientDataError::InvalidEvent);
            }
            let mut ids = std::collections::HashSet::new();
            if messages.as_ref().is_some_and(|items| {
                items.iter().any(|message| {
                    message.conversation_id != conversation.id
                        || message.id.is_empty()
                        || !ids.insert(message.id.clone())
                })
            }) || requests.as_ref().is_some_and(|items| {
                items
                    .iter()
                    .any(|request| request.conversation_id != conversation.id)
            }) || queued.as_ref().is_some_and(|items| {
                items
                    .iter()
                    .any(|prompt| prompt.conversation_id != conversation.id)
            }) {
                return Err(ClientDataError::InvalidEvent);
            }
            EventBody::Conversation {
                conversation: Box::new(conversation),
                messages,
                requests,
                queued,
                snapshot: kind == "conversation_snapshot",
            }
        };
        Ok(Some(Self {
            boot,
            revision,
            older,
            body,
        }))
    }
}

fn read_frame(reader: &mut impl BufRead, limit: u64) -> anyhow::Result<Value> {
    let mut bytes = Vec::new();
    let count = reader.take(limit + 1).read_until(b'\n', &mut bytes)?;
    anyhow::ensure!(count as u64 <= limit, ClientDataError::FrameTooLarge);
    anyhow::ensure!(bytes.ends_with(b"\n"), ClientDataError::IncompleteFrame);
    serde_json::from_slice(&bytes).map_err(|_| ClientDataError::InvalidJson.into())
}

/// Finder launches start the local daemon without blocking the GPUI event loop.
pub fn start_local_daemon(shared: Shared) {
    if std::env::var_os("ADE_SOCKET").is_some() {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| -> anyhow::Result<()> {
            let daemon = ade_platform::resources::sibling_binary("ade-daemon")?;
            anyhow::ensure!(
                daemon.is_file(),
                "The lux-ade daemon is missing from this installation"
            );
            let output = ade_platform::process::run(
                std::process::Command::new("python3")
                    .arg(ade_platform::resources::resource("scripts/runtime.py"))
                    .arg("start")
                    .arg("--daemon")
                    .arg(daemon),
                Duration::from_secs(40),
                256 * 1024,
            )?;
            anyhow::ensure!(
                output.status.success(),
                "Local daemon startup failed; open Runtime for recovery details"
            );
            Ok(())
        })();
        if let Err(error) = result {
            shared.data.lock().unwrap().error = error.to_string();
            shared.notify();
        }
    });
}

pub fn socket() -> String {
    // Compatibility for terminal launch strings. An unresolved endpoint must not
    // point at an unrelated legacy daemon; RPC callers use the fallible API.
    resolved_socket().unwrap_or_default()
}
pub(crate) fn resolved_socket() -> anyhow::Result<String> {
    static SOCKET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(endpoint) = SOCKET.get() {
        return Ok(endpoint.clone());
    }
    let endpoint = if let Ok(endpoint) = std::env::var("ADE_SOCKET") {
        anyhow::ensure!(!endpoint.is_empty(), "ADE_SOCKET must not be empty");
        endpoint
    } else {
        let output = ade_platform::process::run(
            std::process::Command::new("python3")
                .arg(ade_platform::resources::resource("scripts/runtime.py"))
                .arg("locate"),
            Duration::from_secs(5),
            16 * 1024,
        )?;
        anyhow::ensure!(
            output.status.success(),
            "Could not locate lux-ade runtime; check the controller installation"
        );
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| anyhow::anyhow!("Controller returned an invalid runtime location"))?;
        value["socket"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Controller omitted the runtime location"))?
            .to_owned()
    };
    // Failed discovery is never cached, so a later reconnect can recover.
    let _ = SOCKET.set(endpoint.clone());
    Ok(endpoint)
}

fn deadline_error(error: std::io::Error) -> std::io::Error {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ) {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "lux-ade request deadline elapsed; check session state before retrying",
        )
    } else {
        error
    }
}
struct DeadlineIo<'a> {
    stream: &'a mut UnixStream,
    deadline: Instant,
}
impl DeadlineIo<'_> {
    fn remaining(&self) -> std::io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "lux-ade request deadline elapsed; check session state before retrying",
                )
            })
    }
}
impl Read for DeadlineIo<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        ade_platform::ipc::read_until(self.stream, bytes, Some(self.deadline))
            .map_err(deadline_error)
    }
}
impl Write for DeadlineIo<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(bytes).map_err(deadline_error)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}
fn checked_stream() -> anyhow::Result<UnixStream> {
    checked_stream_until(Instant::now() + Duration::from_secs(5))
}
fn checked_stream_until(deadline: Instant) -> anyhow::Result<UnixStream> {
    checked_stream_owned(deadline, None)
}
fn checked_stream_owned(
    deadline: Instant,
    owner: Option<&ConnectionOwner>,
) -> anyhow::Result<UnixStream> {
    if owner.is_some_and(|owner| owner.cancelled.load(Ordering::Acquire)) {
        anyhow::bail!("Read cancelled because its view closed or changed");
    }
    let endpoint = resolved_socket()?;
    let mut stream = ade_platform::ipc::connect(std::path::Path::new(&endpoint), deadline)?;
    if let Some(owner) = owner {
        owner.attach(&stream)?;
    }
    let mut transport = DeadlineIo {
        stream: &mut stream,
        deadline,
    };
    writeln!(transport, "{}", json!({"op":"hello"}))?;
    let hello = read_frame(&mut BufReader::new(transport), 128 * 1024)?;
    anyhow::ensure!(
        hello["application_protocol"] == ade_core::protocol::APPLICATION_PROTOCOL
            && hello["session_protocol"] == "ade-sessions-v1",
        "Incompatible application daemon; existing runtime was left untouched"
    );
    Ok(stream)
}
pub fn rpc(value: &Value) -> anyhow::Result<Value> {
    rpc_owned(value, None)
}
fn rpc_owned(value: &Value, owner: Option<&ConnectionOwner>) -> anyhow::Result<Value> {
    let diagnostic_id = ade_core::diagnostics::new_id();
    let operation_family =
        ade_core::diagnostics::operation_family(value["op"].as_str().unwrap_or(""));
    let started = Instant::now();
    tracing::info!(target: "ade", event = "rpc_started", diagnostic_id, operation_family);
    let result = rpc_owned_traced(value, owner, &diagnostic_id);
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    match result {
        Ok(value) => {
            tracing::info!(target: "ade", event = "rpc_succeeded", diagnostic_id, operation_family, elapsed_ms);
            Ok(value)
        }
        Err(error) => {
            tracing::warn!(target: "ade", event = "rpc_failed", diagnostic_id, operation_family, elapsed_ms);
            Err(anyhow::anyhow!("{error} [diagnostic ID: {diagnostic_id}]"))
        }
    }
}

struct DiagnosticRequest<'a> {
    request: &'a Value,
    id: &'a str,
}
impl Serialize for DiagnosticRequest<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let object = self
            .request
            .as_object()
            .ok_or_else(|| S::Error::custom("RPC request must be an object"))?;
        let mut map = serializer.serialize_map(Some(object.len() + 1))?;
        map.serialize_entry("diagnostic_id", self.id)?;
        for (key, value) in object {
            if key != "diagnostic_id" {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

fn rpc_owned_traced(
    value: &Value,
    owner: Option<&ConnectionOwner>,
    diagnostic_id: &str,
) -> anyhow::Result<Value> {
    let timeout = Duration::from_secs(
        if value["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("review."))
        {
            60
        } else {
            5
        },
    );
    let deadline = Instant::now() + timeout;
    let mut stream =
        checked_stream_owned(deadline.min(Instant::now() + Duration::from_secs(5)), owner)?;
    let mut transport = DeadlineIo {
        stream: &mut stream,
        deadline,
    };
    serde_json::to_writer(
        &mut transport,
        &DiagnosticRequest {
            request: value,
            id: diagnostic_id,
        },
    )?;
    transport.write_all(b"\n")?;
    let v = read_frame(
        &mut BufReader::new(transport),
        ade_core::protocol::MAX_MESSAGE_BYTES,
    )?;
    anyhow::ensure!(
        v["type"] != "error",
        "{}",
        v["message"].as_str().unwrap_or("Daemon rejected request")
    );
    Ok(v)
}
/// A view owns this guard. Dropping it aborts only the disposable read socket.
/// Admitted mutations never use this API.
pub struct ReadRequest {
    owner: Arc<ConnectionOwner>,
}
impl Drop for ReadRequest {
    fn drop(&mut self) {
        self.owner.cancel();
    }
}
pub fn is_disposable_read(value: &Value) -> bool {
    matches!(
        value["op"].as_str(),
        Some(
            "review.status"
                | "review.diff"
                | "review.operation"
                | "worktree.get"
                | "service.list"
                | "conversation.get"
                | "agent.child_transcript"
        )
    )
}
pub fn disposable_read(
    value: Value,
) -> (ReadRequest, async_channel::Receiver<Result<Value, String>>) {
    let owner = Arc::new(ConnectionOwner::default());
    let task_owner = owner.clone();
    let handle = ReadRequest { owner };
    let bytes = value.to_string().len();
    let result = enqueue_result(read_workers(), bytes, move || {
        if !is_disposable_read(&value) {
            return Err("This operation is not a disposable read".into());
        }
        rpc_owned(&value, Some(&task_owner)).map_err(|error| error.to_string())
    });
    (handle, result)
}
/// A lost completion is an uncertain outcome, never permission to replay work.
pub(crate) fn response_result<T>(
    response: Result<Result<T, String>, async_channel::RecvError>,
) -> Result<T, String> {
    response.unwrap_or_else(|_| {
        Err("The request ended without a response. Check the current state before retrying.".into())
    })
}

/// Bound UI acknowledgement waits without cancelling work already admitted to
/// the daemon. Timeout means the outcome is unknown, so callers must keep the
/// current window and let the user inspect or retry from current state.
pub(crate) async fn confirmed_before<T>(
    receiver: async_channel::Receiver<Result<T, String>>,
    timer: impl std::future::Future<Output = ()>,
    timeout_message: &'static str,
) -> Result<T, String> {
    use std::{future::Future, task::Poll};
    let mut response = std::pin::pin!(receiver.recv());
    let mut timer = std::pin::pin!(timer);
    std::future::poll_fn(|context| {
        if let Poll::Ready(result) = response.as_mut().poll(context) {
            return Poll::Ready(response_result(result));
        }
        if let Poll::Ready(()) = timer.as_mut().poll(context) {
            return Poll::Ready(Err(timeout_message.into()));
        }
        Poll::Pending
    })
    .await
}

/// Bounded worker admission for existing multi-RPC operations. Closing a view
/// discards its result but never cancels an admitted mutation.
pub fn background_request<T: Send + 'static>(
    payload_bytes: usize,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> async_channel::Receiver<Result<T, String>> {
    enqueue_result(command_workers(), payload_bytes, work)
}
fn enqueue_result<T: Send + 'static>(
    queue: &'static JobQueue,
    bytes: usize,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> async_channel::Receiver<Result<T, String>> {
    let (tx, rx) = async_channel::bounded(1);
    let failure_tx = tx.clone();
    let job = Job {
        bytes,
        order: None,
        key: None,
        work: Box::new(move || {
            let _ = tx.try_send(work());
        }),
        superseded: Box::new(|| {}),
    };
    if queue.enqueue(job).is_err() {
        let _ = failure_tx.try_send(Err(
            "lux-ade's request queue is full. Wait for pending operations, then retry.".into(),
        ));
    }
    rx
}
fn read_workers() -> &'static JobQueue {
    static WORKERS: std::sync::OnceLock<&'static JobQueue> = std::sync::OnceLock::new();
    WORKERS.get_or_init(|| workers(2, 64))
}

pub fn command(shared: Shared, value: Value) -> async_channel::Receiver<Result<Value, String>> {
    let (tx, rx) = async_channel::bounded(1);
    let layout = value["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("window.") || op.starts_with("draft."));
    let urgent = matches!(
        value["op"].as_str(),
        Some("agent.cancel" | "agent.answer" | "agent.disconnect")
    );
    let bytes = value.to_string().len();
    let order = (value["op"] == "draft.save")
        .then(|| value["revision"].as_u64())
        .flatten();
    let key = if value["op"] == "draft.get" && value["resolve_draft"] == true {
        Some(format!(
            "draft:{}:{}",
            value["window_id"].as_str().unwrap_or_default(),
            value["conversation_id"].as_str().unwrap_or_default()
        ))
    } else {
        persistence_key(&value)
    };
    static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    // window.close is explicitly acknowledged by the close gate. Tracking it here
    // would prevent a retry from ever reaching that gate after a failed close.
    let persistence = key
        .clone()
        .map(|key| (key, SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    if value["op"] == "draft.save"
        && let Some((key, sequence)) = &persistence
        && !shared
            .unsaved_drafts
            .lock()
            .unwrap()
            .retain(key, *sequence, &value)
    {
        let _ = tx.try_send(Err("A newer draft is already awaiting save.".into()));
        return rx;
    }
    if value["op"] == "draft.save"
        && value["resolve_draft"] != true
        && key
            .as_ref()
            .is_some_and(|key| shared.draft_conflicts.lock().unwrap().contains_key(key))
    {
        let _ = tx.try_send(Err(
            "Resolve this draft conflict before saving or closing.".into()
        ));
        shared.notify();
        return rx;
    }
    let failed_persistence = persistence.clone();
    let superseded_tx = tx.clone();
    let failure_state = shared.clone();
    let failure_tx = tx.clone();
    let coalesce_key = if value["resolve_draft"] == true {
        None
    } else {
        key.clone()
    };
    let work = move || {
        let blocked = value["op"] == "draft.save"
            && value["resolve_draft"] != true
            && persistence
                .as_ref()
                .is_some_and(|(key, _)| shared.draft_conflicts.lock().unwrap().contains_key(key));
        let result = if blocked { Err("Resolve this draft conflict before saving or closing.".into()) }
            else { rpc(&value).map_err(|e| e.to_string()) }.and_then(|mut v| {
            if value["before"].is_number() {
                v["older"] = json!(true);
            }
            if value["op"] == "draft.save" {
                let competing_local = value["resolve_draft"] != true && persistence.as_ref().is_some_and(|(key,_)|
                    shared.unsaved_drafts.lock().unwrap().1.get(key).is_some_and(|drafts| !drafts.is_empty()));
                let changed_during_resolution = value["resolve_draft"] == true
                    && persistence.as_ref().is_some_and(|(key,sequence)|
                        shared.unsaved_drafts.lock().unwrap().0.get(key).map(|(current,_)| current) != Some(sequence));
                let validation = validate_draft_ack(&value, &v).and_then(|()| {
                    if changed_during_resolution {
                        return Err("The local draft changed while saving. Review it before choosing again.".into());
                    }
                    if competing_local { Err("Two panes changed this draft. Choose which text to keep before closing.".into()) } else { Ok(()) }
                });
                if let Err(error) = validation {
                    if let (Some((key, _)), Ok(saved)) = (&persistence,
                        serde_json::from_value::<ade_core::model::Draft>(v["draft"].clone())) {
                        shared.draft_conflicts.lock().unwrap().insert(key.clone(), saved);
                    }
                    return Err(error);
                }
            }
            if value["op"] == "draft.get" && value["resolve_draft"] == true {
                serde_json::from_value::<ade_core::model::Draft>(v["draft"].clone())
                    .map_err(|_| "Could not read the saved draft. Your local text is retained.".to_string())?;
                if let Some((key, _)) = &persistence {
                    let mut retained = shared.unsaved_drafts.lock().unwrap();
                    retained.adopt_saved(key, value["retained_sequence"].as_u64(), &mut v["draft"])?;
                    shared.draft_conflicts.lock().unwrap().remove(key);
                }
            }
            shared
                .try_ingest(v.clone())
                .map_err(|error| error.to_string())?;
            Ok(v)
        });
        if result.is_ok()
            && value["op"] == "draft.save"
            && let Some((key, sequence)) = &persistence
        {
            shared
                .unsaved_drafts
                .lock()
                .unwrap()
                .acknowledge(key, *sequence);
            if value["resolve_draft"] == true {
                shared.unsaved_drafts.lock().unwrap().1.remove(key);
            }
            shared.draft_conflicts.lock().unwrap().remove(key);
        }
        publish_command_result(
            &shared,
            &layout_writer().failures,
            persistence.as_ref(),
            &result,
            !layout && value["op"] != "conversation.get",
        );
        shared.notify();
        let _ = tx.send_blocking(result);
    };
    let job = Job {
        bytes,
        order,
        key: coalesce_key,
        work: Box::new(work),
        superseded: Box::new(move || {
            let _ = superseded_tx.try_send(Err("A newer save replaced this pending save.".into()));
        }),
    };
    let queue = if layout {
        layout_writer()
    } else if urgent {
        control_worker()
    } else {
        command_workers()
    };
    if queue.enqueue(job).is_err() {
        let error = if layout { "lux-ade's save queue is full. These changes were not saved; retry after pending saves finish." } else { "lux-ade's request queue is full. Wait for pending operations, then retry." }.to_string();
        publish_command_result(
            &failure_state,
            &layout_writer().failures,
            failed_persistence.as_ref(),
            &Err(error.clone()),
            false,
        );
        failure_state.notify();
        let _ = failure_tx.try_send(Err(error));
    }
    rx
}
fn publish_command_result(
    shared: &Shared,
    failures: &Mutex<PersistenceFailures>,
    persistence: Option<&(String, u64)>,
    result: &Result<Value, String>,
    clear_action: bool,
) {
    if let Some((key, sequence)) = persistence {
        // Publish under the failure lock: an older completion must not overwrite
        // a newer projection after another worker rejects queue admission.
        let mut failures = failures.lock().unwrap();
        failures.record(key, *sequence, result.as_ref().err().cloned());
        let mut state = shared.data.lock().unwrap();
        state.save_error = failures.result().err().unwrap_or_default();
        state.revision += 1;
    } else {
        let mut state = shared.data.lock().unwrap();
        if let Err(error) = result {
            state.error = error.clone();
        } else if clear_action {
            state.error.clear();
        }
        state.revision += 1;
    }
}

fn validate_draft_ack(request: &Value, response: &Value) -> Result<(), String> {
    let empty = vec![];
    let same = response["draft"]["revision"] == request["revision"]
        && response["draft"]["text"] == request["text"]
        && response["draft"]["attachments"]
            .as_array()
            .unwrap_or(&empty)
            == request["attachments"].as_array().unwrap_or(&empty);
    if same {
        Ok(())
    } else {
        Err("Another pane has a newer draft. This pane's unsaved text is retained; resolve the draft before closing.".into())
    }
}
fn persistence_key(value: &Value) -> Option<String> {
    match value["op"].as_str()? {
        "window.save" => Some(format!("window:{}", value["window"]["id"].as_str()?)),
        "draft.save" => Some(format!(
            "draft:{}:{}",
            value["window_id"].as_str()?,
            value["conversation_id"].as_str()?
        )),
        _ => None,
    }
}
type Work = Box<dyn FnOnce() + Send>;
struct Job {
    bytes: usize,
    order: Option<u64>,
    key: Option<String>,
    work: Work,
    superseded: Work,
}
#[derive(Default)]
struct PersistenceFailures {
    failed: HashMap<String, (u64, String)>,
    overflow: bool,
}
impl PersistenceFailures {
    fn record(&mut self, key: &str, sequence: u64, error: Option<String>) {
        if self
            .failed
            .get(key)
            .is_some_and(|(prior, _)| *prior > sequence)
        {
            return;
        }
        if let Some(error) = error {
            if self.failed.len() >= 128 && !self.failed.contains_key(key) {
                self.overflow = true;
                return;
            }
            self.failed.insert(key.into(), (sequence, error));
        } else {
            self.failed.remove(key);
        }
    }
    fn result(&self) -> Result<(), String> {
        if self.overflow {
            return Err("Too many unsaved changes to track. Keep this client open and recover the data folder before restarting.".into());
        }
        self.failed
            .values()
            .min_by_key(|(sequence, _)| *sequence)
            .map_or(Ok(()), |(_, error)| Err(error.clone()))
    }
}
struct JobQueue {
    failures: Mutex<PersistenceFailures>,
    jobs: Mutex<VecDeque<Job>>,
    available: Condvar,
    capacity: usize,
}
impl JobQueue {
    fn new(capacity: usize) -> Self {
        Self {
            failures: Mutex::new(PersistenceFailures::default()),
            jobs: Mutex::new(VecDeque::new()),
            available: Condvar::new(),
            capacity,
        }
    }
    fn enqueue(&self, job: Job) -> Result<(), Job> {
        let mut jobs = self.jobs.lock().unwrap();
        // Never coalesce across a close, read, or flush boundary.
        if let Some(key) = &job.key
            && let Some(index) = jobs
                .iter()
                .enumerate()
                .rev()
                .take_while(|(_, queued)| queued.key.is_some())
                .find_map(|(i, queued)| (queued.key.as_ref() == Some(key)).then_some(i))
        {
            if job
                .order
                .zip(jobs[index].order)
                .is_some_and(|(incoming, pending)| incoming < pending)
            {
                drop(jobs);
                (job.superseded)();
                return Ok(());
            }
            let bytes: usize = jobs.iter().map(|job| job.bytes).sum();
            if bytes
                .saturating_sub(jobs[index].bytes)
                .saturating_add(job.bytes)
                > 32 * 1024 * 1024
            {
                return Err(job);
            }
            let replaced = std::mem::replace(&mut jobs[index], job);
            drop(jobs);
            (replaced.superseded)();
            return Ok(());
        }
        if jobs.len() >= self.capacity
            || jobs
                .iter()
                .map(|job| job.bytes)
                .sum::<usize>()
                .saturating_add(job.bytes)
                > 32 * 1024 * 1024
        {
            return Err(job);
        }
        jobs.push_back(job);
        self.available.notify_one();
        Ok(())
    }
    fn pop(&self) -> Job {
        let mut jobs = self.jobs.lock().unwrap();
        while jobs.is_empty() {
            jobs = self.available.wait(jobs).unwrap();
        }
        let job = jobs.pop_front().unwrap();
        self.available.notify_all();
        job
    }
    fn barrier(&self, work: Work) -> Result<(), ()> {
        const RESERVED_FENCES: usize = 16;
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.len() >= self.capacity.saturating_add(RESERVED_FENCES) {
            return Err(());
        }
        jobs.push_back(Job {
            bytes: 0,
            order: None,
            key: None,
            work,
            superseded: Box::new(|| {}),
        });
        self.available.notify_one();
        Ok(())
    }
}
fn workers(count: usize, capacity: usize) -> &'static JobQueue {
    let queue = Box::leak(Box::new(JobQueue::new(capacity)));
    for _ in 0..count {
        let queue: &'static JobQueue = queue;
        std::thread::spawn(move || {
            loop {
                let job = queue.pop();
                (job.work)();
            }
        });
    }
    queue
}
fn layout_writer() -> &'static JobQueue {
    static WRITER: std::sync::OnceLock<&'static JobQueue> = std::sync::OnceLock::new();
    WRITER.get_or_init(|| workers(1, 128))
}
fn command_workers() -> &'static JobQueue {
    static WORKERS: std::sync::OnceLock<&'static JobQueue> = std::sync::OnceLock::new();
    WORKERS.get_or_init(|| workers(4, 64))
}
fn control_worker() -> &'static JobQueue {
    static WORKER: std::sync::OnceLock<&'static JobQueue> = std::sync::OnceLock::new();
    WORKER.get_or_init(|| workers(1, 16))
}
pub fn flush_layout() -> async_channel::Receiver<Result<(), String>> {
    flush_queue(layout_writer())
}
fn flush_queue(queue: &'static JobQueue) -> async_channel::Receiver<Result<(), String>> {
    let (tx, rx) = async_channel::bounded(1);
    let completion = tx.clone();
    // The boundary is admitted now, before later saves, without spawning a
    // waiting thread. Reserved zero-byte slots let a full write queue flush.
    if queue
        .barrier(Box::new(move || {
            let _ = completion.try_send(queue.failures.lock().unwrap().result());
        }))
        .is_err()
    {
        let _ = tx.try_send(Err(
            "Too many save checks are pending. Keep this window open and retry saving shortly."
                .into(),
        ));
    }
    rx
}
pub fn connect() -> Shared {
    let shared = Arc::new(ClientState::default());
    spawn_subscription(&shared, checked_stream);
    shared
}
fn spawn_subscription(
    shared: &Shared,
    mut connector: impl FnMut() -> anyhow::Result<UnixStream> + Send + 'static,
) -> std::thread::JoinHandle<()> {
    let weak: Weak<ClientState> = Arc::downgrade(shared);
    let owner = shared.connection_owner.clone();
    std::thread::spawn(move || {
        loop {
            if owner.cancelled.load(Ordering::Acquire) {
                return;
            }
            let connection = connector();
            let Some(state) = weak.upgrade() else {
                return;
            };
            if let Err(error) = &connection {
                state.data.lock().unwrap().connection_error = error.to_string();
            }
            drop(state);
            if let Ok(mut stream) = connection {
                if owner.attach(&stream).is_err() {
                    return;
                }
                let _ = stream.set_read_timeout(None);
                let _ = writeln!(stream, "{}", json!({"op":"session.subscribe"}));
                let mut reader = BufReader::new(stream);
                loop {
                    let v = match read_frame(&mut reader, ade_core::protocol::MAX_MESSAGE_BYTES) {
                        Ok(value) => value,
                        Err(error) => {
                            if let Some(state) = weak.upgrade() {
                                state.data.lock().unwrap().connection_error = error.to_string();
                            }
                            break;
                        }
                    };
                    let Some(state) = weak.upgrade() else {
                        return;
                    };
                    if let Err(error) = ValidatedEvent::parse(&v) {
                        state.data.lock().unwrap().connection_error = error.to_string();
                        break;
                    }
                    if v["type"] == "error" {
                        state.data.lock().unwrap().error = v["message"].to_string();
                        break;
                    }
                    {
                        let mut snapshot = state.data.lock().unwrap();
                        snapshot.connected = true;
                        snapshot.connection_error.clear();
                    }
                    let reload = if v["type"] == "conversation_reload" {
                        v["conversation"]["id"].as_str().map(str::to_owned)
                    } else {
                        None
                    };
                    let catalog = v["type"] == "catalog";
                    let prior_views: Vec<String> = if catalog {
                        let mut s = state.data.lock().unwrap();
                        let ids = s.views.keys().cloned().collect();
                        if let Some(boot) = v["boot_id"].as_str()
                            && s.boot != boot
                        {
                            s.boot = boot.into();
                            // Retain the last healthy transcript while fresh snapshots arrive.
                            // Revisions restart with the new daemon boot.
                            s.catalog_source_revision = 0;
                            for view in s.views.values_mut() {
                                Arc::make_mut(view).revision = 0;
                            }
                        }
                        ids
                    } else {
                        Vec::new()
                    };
                    state.ingest(v);
                    if let Some(id) = reload {
                        command(
                            state.clone(),
                            json!({"op":"conversation.get","conversation_id":id}),
                        );
                    }
                    if catalog {
                        let mut ids: Vec<_> = state
                            .data
                            .lock()
                            .unwrap()
                            .catalog
                            .windows
                            .iter()
                            .filter_map(|w| w.conversation_id.clone())
                            .chain(prior_views)
                            .collect();
                        ids.sort();
                        ids.dedup();
                        for id in ids {
                            command(
                                state.clone(),
                                json!({"op":"conversation.get","conversation_id":id}),
                            );
                        }
                    }
                }
            }
            let Some(state) = weak.upgrade() else {
                return;
            };
            {
                let mut s = state.data.lock().unwrap();
                s.connected = false;
                if s.connection_error.is_empty() {
                    s.connection_error = "Connection interrupted; retrying automatically.".into();
                }
                s.revision += 1;
            }
            state.notify();
            drop(state);
            if !owner.retry_wait() {
                return;
            }
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn poll_ready<T>(future: impl std::future::Future<Output = T>) -> T {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let mut future = Box::pin(future);
        match Future::poll(future.as_mut(), &mut Context::from_waker(Waker::noop())) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("test future was not ready"),
        }
    }

    #[test]
    fn shutdown_confirmation_prefers_a_ready_reply_and_bounds_a_missing_one() {
        let (sent, received) = async_channel::bounded(1);
        sent.try_send(Ok::<_, String>(7)).unwrap();
        assert_eq!(
            poll_ready(confirmed_before(
                received,
                std::future::ready(()),
                "timeout"
            )),
            Ok(7)
        );

        let (sent, received) = async_channel::bounded::<Result<(), String>>(1);
        assert_eq!(
            poll_ready(confirmed_before(
                received,
                std::future::ready(()),
                "uncertain"
            )),
            Err("uncertain".into())
        );
        assert!(
            sent.is_closed(),
            "timed-out acknowledgement waiter must release its receiver"
        );
    }
    #[test]
    fn diagnostic_request_preserves_domain_request_and_bounded_payload() {
        let id = ade_core::diagnostics::new_id();
        let request = json!({"op":"queue.enqueue","request_id":"domain-request","text":"private prompt","diagnostic_id":"untrusted replacement"});
        let encoded = serde_json::to_value(DiagnosticRequest {
            request: &request,
            id: &id,
        })
        .unwrap();
        assert_eq!(encoded["diagnostic_id"], id);
        assert_eq!(encoded["request_id"], "domain-request");
        assert_eq!(encoded["text"], "private prompt");
        assert_eq!(
            request["diagnostic_id"], "untrusted replacement",
            "serialization must not mutate the caller's request"
        );
        assert!(
            serde_json::to_vec(&DiagnosticRequest {
                request: &json!([1, 2]),
                id: &id
            })
            .is_err()
        );
    }
    #[test]
    fn deadline_reader_keeps_complete_reply_after_peer_closes() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        server.write_all(b"{\"type\":\"ok\"}\n").unwrap();
        drop(server);
        let transport = DeadlineIo {
            stream: &mut client,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        let reply = read_frame(&mut BufReader::new(transport), 1024).unwrap();
        assert_eq!(reply, json!({"type":"ok"}));
    }

    #[test]
    fn concurrent_imports_guard_only_their_own_window_until_last_completion() {
        let shared = Arc::new(ClientState::default());
        let first = begin_draft_action(&shared, "window-a");
        let second = begin_draft_action(&shared, "window-a");
        let other = begin_draft_action(&shared, "window-b");
        assert!(!has_draft_actions(&shared, "window-c"));
        drop(first);
        assert!(has_draft_actions(&shared, "window-a"));
        drop(second);
        assert!(!has_draft_actions(&shared, "window-a"));
        assert!(has_draft_actions(&shared, "window-b"));
        drop(other);
        assert!(!has_draft_actions(&shared, "window-b"));
    }

    #[test]
    fn disposable_reads_reject_mutations_without_sending_them() {
        for op in [
            "review.commit",
            "service.start",
            "worktree.switch",
            "workspace.open",
        ] {
            let (handle, result) = disposable_read(json!({"op":op}));
            assert!(
                result
                    .recv_blocking()
                    .unwrap()
                    .unwrap_err()
                    .contains("not a disposable read")
            );
            drop(handle);
        }
        for op in ["review.diff", "conversation.get", "agent.child_transcript"] {
            assert!(is_disposable_read(&json!({"op":op})));
        }
    }
    #[test]
    fn dropping_read_scope_interrupts_its_socket_and_skips_queued_work() {
        let owner = Arc::new(ConnectionOwner::default());
        let handle = ReadRequest {
            owner: owner.clone(),
        };
        let (mut client, _server) = UnixStream::pair().unwrap();
        owner.attach(&client).unwrap();
        let (finished, result) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let transport = DeadlineIo {
                stream: &mut client,
                deadline: Instant::now() + Duration::from_secs(60),
            };
            let outcome = read_frame(&mut BufReader::new(transport), 1024);
            let _ = finished.send(outcome.is_err());
        });
        drop(handle);
        assert!(result.recv_timeout(Duration::from_secs(1)).unwrap());
        // This must fail before socket discovery or any transport write.
        let error = rpc_owned(&json!({"op":"review.status"}), Some(&owner)).unwrap_err();
        assert!(error.to_string().contains("Read cancelled"));
    }
    #[test]
    fn dropping_mutation_receiver_does_not_cancel_admitted_work() {
        let (started, begun) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let (finished, done) = std::sync::mpsc::channel();
        let receiver = background_request(0, move || {
            started.send(()).unwrap();
            released.recv().unwrap();
            finished.send(()).unwrap();
            Ok(())
        });
        begun.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(receiver);
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(1)).unwrap();
    }
    #[test]
    fn slow_drip_responses_cannot_extend_the_absolute_deadline() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..20 {
                if server.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let started = Instant::now();
        let transport = DeadlineIo {
            stream: &mut client,
            deadline: started + Duration::from_millis(50),
        };
        let error = read_frame(&mut BufReader::new(transport), 1024).unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(client);
        writer.join().unwrap();
    }
    #[test]
    fn recovered_save_clears_its_notice() {
        let shared = Arc::new(ClientState::default());
        let failures = Mutex::new(PersistenceFailures::default());
        publish_command_result(
            &shared,
            &failures,
            Some(&("window:a".into(), 1)),
            &Err("Save timed out".into()),
            false,
        );
        assert_eq!(shared.data.lock().unwrap().save_error, "Save timed out");
        publish_command_result(
            &shared,
            &failures,
            Some(&("window:a".into(), 2)),
            &Ok(json!({})),
            false,
        );
        assert!(failures.lock().unwrap().result().is_ok());
        assert!(
            shared.data.lock().unwrap().save_error.is_empty(),
            "a successful matching save leaves a stale notice"
        );
    }

    #[test]
    fn save_notices_remain_until_matching_recovery_and_keep_action_errors() {
        let shared = Arc::new(ClientState::default());
        let failures = Mutex::new(PersistenceFailures::default());
        let publish = |key: &str, sequence, error: Option<&str>| {
            publish_command_result(
                &shared,
                &failures,
                Some(&(key.into(), sequence)),
                &error.map_or_else(|| Ok(json!({})), |error| Err(error.into())),
                false,
            );
        };
        publish("window:a", 2, Some("Window unsaved"));
        let failed_revision = shared.data.lock().unwrap().ui_revision(None);
        publish_command_result(&shared, &failures, None, &Ok(json!({})), true);
        assert_eq!(shared.data.lock().unwrap().save_error, "Window unsaved");
        publish("window:b", 3, None);
        publish("window:a", 1, None);
        assert_eq!(shared.data.lock().unwrap().save_error, "Window unsaved");
        publish("draft:a:c", 4, Some("Draft unsaved"));
        publish_command_result(
            &shared,
            &failures,
            None,
            &Err("Action failed".into()),
            false,
        );
        publish("window:a", 5, None);
        assert_eq!(shared.data.lock().unwrap().save_error, "Draft unsaved");
        publish("draft:a:c", 6, None);
        let state = shared.data.lock().unwrap();
        assert!(state.save_error.is_empty());
        assert_eq!(state.error, "Action failed");
        assert_ne!(state.ui_revision(None), failed_revision);
        assert!(failures.lock().unwrap().result().is_ok());
    }

    #[test]
    fn persistence_fence_remembers_failures_until_a_newer_matching_save_succeeds() {
        let mut failures = PersistenceFailures::default();
        failures.record("window:a", 2, Some("Disk full".into()));
        failures.record("window:b", 3, None);
        assert_eq!(failures.result(), Err("Disk full".into()));
        failures.record("window:a", 1, None);
        assert!(
            failures.result().is_err(),
            "older in-flight success hid rejected newer save"
        );
        failures.record("window:a", 4, None);
        assert!(failures.result().is_ok());
    }
    #[test]
    fn subscription_first_catalog_initializes_an_empty_projection() {
        let shared = Arc::new(ClientState::default());
        let updates = shared.subscribe();
        let (client, mut server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut client = Some(client);
        let worker = spawn_subscription(&shared, move || Ok(client.take().unwrap()));
        let mut request = String::new();
        BufReader::new(server.try_clone().unwrap())
            .read_line(&mut request)
            .unwrap();
        writeln!(server, "{}", json!({"type":"catalog","boot_id":"first-boot","revision":1,"catalog":{"workspaces":[],"conversations":[],"windows":[]},"providers":[]})).unwrap();
        // Real channel delivery proves the first event updates subscribers without
        // an eager catalog.get on the main thread.
        let deadline = Instant::now() + Duration::from_secs(2);
        while updates.try_recv().is_err() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(shared.data.lock().unwrap().boot, "first-boot");
        assert!(shared.data.lock().unwrap().connected);
        drop(shared);
        worker.join().unwrap();
    }
    #[test]
    fn dropping_client_interrupts_idle_subscription_without_stopping_daemon() {
        let shared = Arc::new(ClientState::default());
        let (client, mut server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut client = Some(client);
        let worker = spawn_subscription(&shared, move || Ok(client.take().unwrap()));
        let mut request = String::new();
        BufReader::new(server.try_clone().unwrap())
            .read_line(&mut request)
            .unwrap();
        assert!(request.contains("session.subscribe"));
        let weak = Arc::downgrade(&shared);
        drop(shared);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tx.send(worker.join()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_ok());
        assert!(weak.upgrade().is_none());
        let mut extra = String::new();
        server.read_to_string(&mut extra).unwrap();
        assert!(
            extra.is_empty(),
            "cancellation must not send a process-stop command"
        );
    }
    #[test]
    fn queued_saves_coalesce_but_never_cross_close_or_read_boundaries() {
        let queue = JobQueue::new(4);
        let (tx, rx) = std::sync::mpsc::channel();
        let job = |key: Option<&str>, label: &'static str| {
            let work_tx = tx.clone();
            let superseded_tx = tx.clone();
            Job {
                bytes: 0,
                order: None,
                key: key.map(str::to_owned),
                work: Box::new(move || {
                    work_tx.send(label).unwrap();
                }),
                superseded: Box::new(move || {
                    superseded_tx.send("superseded").unwrap();
                }),
            }
        };
        assert!(queue.enqueue(job(Some("window:a"), "old")).is_ok());
        assert!(queue.enqueue(job(Some("window:a"), "new")).is_ok());
        assert_eq!(rx.recv().unwrap(), "superseded");
        assert_eq!(queue.jobs.lock().unwrap().len(), 1);
        assert!(queue.enqueue(job(None, "close")).is_ok());
        assert!(queue.enqueue(job(Some("window:a"), "after close")).is_ok());
        for _ in 0..3 {
            (queue.pop().work)();
        }
        assert_eq!(
            rx.try_iter().collect::<Vec<_>>(),
            ["new", "close", "after close"]
        );
    }
    #[test]
    fn queues_reject_excess_work_and_keep_accepted_order() {
        let queue = JobQueue::new(1);
        let job = || Job {
            bytes: 0,
            order: None,
            key: None,
            work: Box::new(|| {}),
            superseded: Box::new(|| {}),
        };
        assert!(queue.enqueue(job()).is_ok());
        assert!(queue.enqueue(job()).is_err());
        assert_eq!(queue.jobs.lock().unwrap().len(), 1);
        (queue.pop().work)();
        assert!(queue.enqueue(job()).is_ok());
    }
    #[test]
    fn queue_byte_budget_and_draft_revision_prevent_memory_growth_and_stale_saves() {
        let queue = JobQueue::new(4);
        let job = |bytes, order| Job {
            bytes,
            order,
            key: Some("draft:w:c".into()),
            work: Box::new(|| {}),
            superseded: Box::new(|| {}),
        };
        assert!(queue.enqueue(job(20 * 1024 * 1024, Some(4))).is_ok());
        assert!(queue.enqueue(job(10, Some(3))).is_ok());
        assert_eq!(queue.jobs.lock().unwrap()[0].order, Some(4));
        let mut other = job(20 * 1024 * 1024, None);
        other.key = None;
        assert!(queue.enqueue(other).is_err());
        assert!(queue.enqueue(job(40 * 1024 * 1024, Some(5))).is_err());
        assert_eq!(queue.jobs.lock().unwrap()[0].order, Some(4));
    }
    #[test]
    fn flush_fence_uses_reserved_slot_without_dropping_accepted_saves() {
        let queue = Arc::new(JobQueue::new(1));
        let (tx, rx) = std::sync::mpsc::channel();
        let saved = tx.clone();
        assert!(
            queue
                .enqueue(Job {
                    bytes: 0,
                    order: None,
                    key: Some("window:a".into()),
                    work: Box::new(move || {
                        saved.send("saved").unwrap();
                    }),
                    superseded: Box::new(|| {})
                })
                .is_ok()
        );
        assert!(
            queue
                .barrier(Box::new(move || {
                    tx.send("flushed").unwrap();
                }))
                .is_ok()
        );
        (queue.pop().work)();
        (queue.pop().work)();
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), ["saved", "flushed"]);
    }
    #[test]
    fn flush_overload_is_visible_bounded_and_preserves_prior_failure() {
        let queue = Box::leak(Box::new(JobQueue::new(1)));
        queue
            .enqueue(Job {
                bytes: 1,
                order: None,
                key: Some("window:a".into()),
                work: Box::new(|| {}),
                superseded: Box::new(|| {}),
            })
            .unwrap_or_else(|_| panic!("admit save"));
        queue
            .failures
            .lock()
            .unwrap()
            .record("window:a", 1, Some("disk full".into()));
        let admitted: Vec<_> = (0..16).map(|_| flush_queue(queue)).collect();
        let rejected = flush_queue(queue);
        assert!(
            rejected
                .try_recv()
                .unwrap()
                .unwrap_err()
                .contains("retry saving")
        );
        assert_eq!(queue.jobs.lock().unwrap().len(), 17);
        (queue.pop().work)();
        for reply in admitted {
            (queue.pop().work)();
            assert_eq!(reply.try_recv().unwrap(), Err("disk full".into()));
        }
        assert!(queue.jobs.lock().unwrap().is_empty());
        queue.failures.lock().unwrap().record("window:a", 2, None);
        let retry = flush_queue(queue);
        (queue.pop().work)();
        assert_eq!(retry.try_recv().unwrap(), Ok(()));
    }
    #[test]
    fn immediate_fence_boundary_prevents_later_save_coalescing() {
        let queue = JobQueue::new(3);
        let (tx, rx) = std::sync::mpsc::channel();
        let job = |label, tx: std::sync::mpsc::Sender<&'static str>| Job {
            bytes: 0,
            order: None,
            key: Some("window:a".into()),
            work: Box::new(move || {
                tx.send(label).unwrap();
            }),
            superseded: Box::new(|| panic!("save must not coalesce across flush")),
        };
        assert!(queue.enqueue(job("before", tx.clone())).is_ok());
        let boundary = tx.clone();
        assert!(
            queue
                .barrier(Box::new(move || {
                    boundary.send("fence").unwrap();
                }))
                .is_ok()
        );
        assert!(queue.enqueue(job("after", tx)).is_ok());
        for _ in 0..3 {
            (queue.pop().work)();
        }
        assert_eq!(
            rx.try_iter().collect::<Vec<_>>(),
            ["before", "fence", "after"]
        );
    }
    fn conversation_event(revision: u64, text: &str) -> Value {
        json!({"type":"conversation_snapshot","boot_id":"boot","revision":revision,"conversation":{"id":"c","workspace_id":"w","title":"Healthy","provider":"codex","provider_thread_id":"thread","status":"running","active_turn_id":"turn","error":null,"updated_at":1},"messages":[{"id":"m","conversation_id":"c","role":"assistant","kind":"text","text":text,"status":"streaming","turn_id":"turn","provider_item_id":"m","sequence":1}],"requests":[]})
    }
    #[test]
    fn malformed_snapshot_is_atomic_and_keeps_last_healthy_transcript() {
        let state = ClientState::default();
        state.ingest(conversation_event(2, "healthy"));
        for field in ["messages", "requests", "queued", "revision", "older"] {
            let mut malformed = conversation_event(3, "replacement");
            malformed[field] = json!("invalid secret");
            state.ingest(malformed);
            let snapshot = state.data.lock().unwrap();
            assert_eq!(snapshot.views["c"].messages[0].text, "healthy");
            assert_eq!(snapshot.views["c"].revision, 2);
            assert!(!snapshot.error.contains("secret"));
            assert!(snapshot.error.contains("retained"));
        }
        let mut wrong_identity = conversation_event(4, "another conversation");
        wrong_identity["messages"][0]["conversation_id"] = json!("other");
        assert_eq!(
            state.try_ingest(wrong_identity),
            Err(ClientDataError::InvalidEvent)
        );
    }
    #[test]
    fn malformed_catalogue_does_not_clear_providers_or_commit_a_boot() {
        let state = ClientState::default();
        let provider = json!({"id":"codex","name":"Codex","capabilities":[],"permission_modes":[],"setting_sources":[]});
        let good = json!({"type":"catalog","boot_id":"boot","revision":5,"catalog":{"workspaces":[],"conversations":[],"windows":[]},"providers":[provider]});
        state.ingest(good.clone());
        let mut bad = good.clone();
        bad["providers"] = json!(null);
        state.ingest(bad);
        let mut bad = good.clone();
        bad["catalog"] = json!({});
        bad["providers"] = json!([]);
        state.ingest(bad);
        assert_eq!(state.data.lock().unwrap().providers.len(), 1);
        let mut stale = good;
        stale["revision"] = json!(4);
        stale["providers"] = json!([]);
        state.ingest(stale);
        assert_eq!(state.data.lock().unwrap().providers.len(), 1);
        let fresh = ClientState::default();
        fresh.ingest(json!({"type":"catalog","boot_id":"invalid","catalog":null,"providers":[]}));
        assert!(fresh.data.lock().unwrap().boot.is_empty());
    }
    #[test]
    fn late_catalogue_cannot_replace_newer_conversation_metadata() {
        let state = ClientState::default();
        let mut latest = conversation_event(8, "latest");
        latest["conversation"]["title"] = json!("Newest title");
        state.ingest(latest.clone());
        latest["conversation"]["title"] = json!("Stale title");
        state.ingest(json!({"type":"catalog","boot_id":"boot","revision":7,"catalog":{"workspaces":[],"windows":[],"conversations":[latest["conversation"].clone()]},"providers":[]}));
        let snapshot = state.data.lock().unwrap();
        assert_eq!(snapshot.catalog.conversations[0].title, "Newest title");
        assert_eq!(snapshot.views["c"].messages[0].text, "latest");
    }
    #[test]
    fn reload_without_messages_preserves_transcript_and_requests_a_later_snapshot() {
        let state = ClientState::default();
        let mut reload = conversation_event(2, "live");
        state.ingest(reload.clone());
        reload["type"] = json!("conversation_reload");
        reload["revision"] = json!(3);
        let object = reload.as_object_mut().unwrap();
        object.remove("messages");
        object.remove("requests");
        assert!(state.try_ingest(reload).is_ok());
        assert_eq!(
            state.data.lock().unwrap().views["c"].messages[0].text,
            "live"
        );
    }
    #[test]
    fn frame_reader_is_bounded_and_preserves_following_frames() {
        let mut input = std::io::Cursor::new(b"{}\n{\"next\":true}\n");
        assert_eq!(read_frame(&mut input, 16).unwrap(), json!({}));
        assert_eq!(read_frame(&mut input, 16).unwrap(), json!({"next":true}));
        for (bytes, expected) in [
            (b"secret invalid\n".as_slice(), ClientDataError::InvalidJson),
            (b"{}".as_slice(), ClientDataError::IncompleteFrame),
            (b"123456789".as_slice(), ClientDataError::FrameTooLarge),
        ] {
            let error = read_frame(&mut std::io::Cursor::new(bytes), 8).unwrap_err();
            let expected = if bytes.len() > 8 {
                ClientDataError::FrameTooLarge
            } else {
                expected
            };
            assert_eq!(error.downcast_ref::<ClientDataError>(), Some(&expected));
            assert!(!error.to_string().contains("secret"));
        }
        let error = read_frame(&mut std::io::Cursor::new(b"bad\n"), 8).unwrap_err();
        assert_eq!(
            error.downcast_ref::<ClientDataError>(),
            Some(&ClientDataError::InvalidJson)
        );
    }
    #[test]
    fn paging_one_window_does_not_replace_shared_live_messages() {
        let state = ClientState::default();
        let c = json!({"id":"c","workspace_id":"w","title":"Test","provider":"codex","provider_thread_id":"thread","status":"running","active_turn_id":"turn","error":null,"updated_at":1});
        let message = |seq: i64, text: &str| json!({"id":format!("m{seq}"),"conversation_id":"c","role":"assistant","kind":"text","text":text,"status":"streaming","turn_id":"turn","provider_item_id":format!("m{seq}"),"sequence":seq});
        state.ingest(json!({"type":"conversation_snapshot","revision":1,"conversation":c,"messages":[message(201,"live")],"requests":[]}));
        state.ingest(json!({"type":"conversation_snapshot","revision":1,"older":true,"conversation":c,"messages":[message(1,"history")],"requests":[]}));
        assert_eq!(
            state.data.lock().unwrap().views["c"].messages[0].text,
            "live"
        );
        state.ingest(json!({"type":"conversation_changed","revision":2,"conversation":c,"messages":[message(201,"live continues")],"requests":[]}));
        assert_eq!(
            state.data.lock().unwrap().views["c"].messages[0].text,
            "live continues"
        );
    }
    #[test]
    fn updates_fan_out_coalesce_and_release_closed_windows() {
        let state = ClientState::default();
        let a = state.subscribe();
        let b = state.subscribe();
        for _ in 0..100 {
            state.notify();
        }
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        drop(b);
        state.notify();
        assert_eq!(state.listeners.lock().unwrap().len(), 1);
    }
    #[test]
    fn late_snapshot_keeps_newer_live_text_and_restores_prior_messages() {
        let state = ClientState::default();
        let c = json!({"id":"c","workspace_id":"w","title":"Test","provider":"codex","provider_thread_id":"thread","status":"running","active_turn_id":"turn","error":null,"updated_at":1});
        let message = |id: &str, seq: i64, text: &str| json!({"id":id,"conversation_id":"c","role":"assistant","kind":"text","text":text,"status":"streaming","turn_id":"turn","provider_item_id":id,"sequence":seq});
        state.ingest(json!({"type":"conversation_changed","boot_id":"boot1","revision":8,"conversation":c,"messages":[message("new",2,"newest")],"requests":[]}));
        let before = state.data.lock().unwrap().ui_revision(Some("c"));
        state.ingest(json!({"type":"conversation_snapshot","boot_id":"boot1","revision":7,"conversation":c,"messages":[message("old",1,"history"),message("new",2,"stale")],"requests":[]}));
        let s = state.data.lock().unwrap();
        assert_ne!(
            s.ui_revision(Some("c")),
            before,
            "history must invalidate the selected window"
        );
        assert_eq!(s.views["c"].messages[0].text, "history");
        assert_eq!(s.views["c"].messages[1].text, "newest");
        drop(s);
        state.ingest(json!({"type":"conversation_snapshot","boot_id":"old-boot","revision":99,"conversation":c,"messages":[message("new",2,"wrong boot")],"requests":[]}));
        assert_eq!(
            state.data.lock().unwrap().views["c"].messages[1].text,
            "newest"
        );
    }
    #[test]
    fn unrelated_token_updates_do_not_invalidate_a_window_but_sidebar_changes_do() {
        let state = ClientState::default();
        let event = |id: &str, text: &str, status: &str, revision: u64| json!({"type":"conversation_changed","boot_id":"boot","revision":revision,"conversation":{"id":id,"workspace_id":"w","title":id,"provider":"codex","provider_thread_id":id,"status":status,"active_turn_id":"t","error":null,"updated_at":revision},"messages":[{"id":format!("{id}:m"),"conversation_id":id,"role":"assistant","kind":"text","text":text,"status":"streaming","turn_id":"t","provider_item_id":"m","sequence":1}],"requests":[]});
        state.ingest(event("a", "a", "running", 1));
        state.ingest(event("b", "b", "running", 2));
        let a = state.data.lock().unwrap().ui_revision(Some("a"));
        state.ingest(event("b", "b delta", "running", 3));
        assert_eq!(
            state.data.lock().unwrap().ui_revision(Some("a")),
            a,
            "unrelated tokens invalidated A"
        );
        state.ingest(event("b", "b delta", "waiting", 4));
        assert_ne!(
            state.data.lock().unwrap().ui_revision(Some("a")),
            a,
            "sidebar status failed to invalidate A"
        );
        let a = state.data.lock().unwrap().ui_revision(Some("a"));
        state.ingest(event("a", "own delta", "running", 5));
        assert_ne!(
            state.data.lock().unwrap().ui_revision(Some("a")),
            a,
            "own tokens failed to invalidate A"
        );
    }
    #[test]
    fn provider_catalogue_comes_from_the_daemon_and_updates_with_catalogues() {
        let state = ClientState::default();
        let catalogue = |providers: Value| json!({"type":"catalog","catalog":{"workspaces":[],"conversations":[],"windows":[]},"providers":providers});
        let remote_provider = json!({"id":"remote-provider","name":"Remote provider","capabilities":["resume"],"permission_modes":["ask"],"setting_sources":["project"]});
        state.ingest(catalogue(json!([remote_provider])));
        let before = state.data.lock().unwrap().ui_revision(None);
        assert_eq!(
            state.data.lock().unwrap().providers[0].id,
            "remote-provider"
        );
        assert_eq!(
            state.data.lock().unwrap().providers[0].permission_modes,
            ["ask"]
        );
        state.ingest(catalogue(json!([])));
        let snapshot = state.data.lock().unwrap();
        assert!(snapshot.providers.is_empty());
        assert_ne!(before, snapshot.ui_revision(None));
    }
}

#[cfg(test)]
mod retained_draft_tests {
    use super::*;
    fn draft(window: &str, revision: u64, text: &str) -> Value {
        json!({"op":"draft.save","window_id":window,"conversation_id":"chat", "revision":revision,"text":text,"attachments":[{"id":"attachment"}]})
    }
    #[test]
    fn loading_saved_draft_cannot_discard_a_concurrent_edit() {
        let mut retained = RetainedDrafts::default();
        retained.retain("key", 1, &draft("window", 8, "local"));
        retained.retain("key", 2, &draft("window", 9, "typed during load"));
        let mut saved = draft("window", 5, "saved text");
        assert!(retained.adopt_saved("key", Some(1), &mut saved).is_err());
        assert_eq!(retained.0["key"].1["text"], "typed during load");
        retained.adopt_saved("key", Some(2), &mut saved).unwrap();
        assert_eq!(saved["text"], "saved text");
        assert_eq!(saved["revision"], 9);
        assert!(retained.0.is_empty());
    }

    #[test]
    fn conflicting_equal_revisions_preserve_both_local_payloads() {
        let mut retained = RetainedDrafts::default();
        let first = draft("window", 4, "first editor");
        let second = draft("window", 4, "second editor");
        assert!(retained.retain("key", 1, &first));
        assert!(retained.retain("key", 2, &second));
        assert_eq!(retained.0["key"].1, second);
        assert_eq!(retained.1["key"], vec![first]);
        retained.acknowledge("key", 1);
        assert_eq!(retained.0["key"].1, second);
    }
    #[test]
    fn explicit_resolution_never_lowers_or_wraps_revision() {
        assert_eq!(resolution_revision(9, 5, 12), Some(13));
        assert_eq!(resolution_revision(9, 15, 12), Some(16));
        assert_eq!(resolution_revision(i64::MAX, 0, 0), None);
    }

    #[test]
    fn newer_daemon_draft_is_not_reported_as_successful_save() {
        let request = draft("window", 3, "old pane text");
        assert!(
            validate_draft_ack(
                &request,
                &json!({"draft":draft("window", 4, "newer pane text")})
            )
            .is_err()
        );
        assert!(validate_draft_ack(&request, &json!({"draft":request.clone()})).is_ok());
    }
    #[test]
    fn failed_payload_outlives_editor_and_retries_with_attachments() {
        let shared = Arc::new(ClientState::default());
        let editor_payload = draft("window", 4, "unsaved text");
        shared
            .unsaved_drafts
            .lock()
            .unwrap()
            .retain("draft:window:chat", 10, &editor_payload);
        drop(editor_payload); // pane/workspace teardown releases its local owner
        let retained = shared.unsaved_drafts.lock().unwrap().for_window("window");
        assert_eq!(retained, vec![draft("window", 4, "unsaved text")]);
        assert!(
            shared
                .unsaved_drafts
                .lock()
                .unwrap()
                .for_window("other")
                .is_empty()
        );
        let mut retained_state = shared.unsaved_drafts.lock().unwrap();
        assert!(retained_state.retain("draft:window:chat", 11, &retained[0]));
        retained_state.acknowledge("draft:window:chat", 10);
        assert_eq!(retained_state.for_window("window"), retained);
        retained_state.acknowledge("draft:window:chat", 11);
        assert!(retained_state.for_window("window").is_empty());
    }
    #[test]
    fn stale_retry_and_old_ack_cannot_replace_newer_draft() {
        let mut retained = RetainedDrafts::default();
        assert!(retained.retain("draft", 1, &draft("window", 1, "old")));
        assert!(retained.retain("draft", 2, &draft("window", 2, "latest")));
        assert!(!retained.retain("draft", 3, &draft("window", 1, "old")));
        retained.acknowledge("draft", 1);
        assert_eq!(
            retained.for_window("window"),
            vec![draft("window", 2, "latest")]
        );
        retained.acknowledge("draft", 2);
        assert!(retained.0.is_empty());
    }
}
