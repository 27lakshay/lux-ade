//! Service health checks, listeners, peers and the `service.*` and `listener.list` operations.
use super::*;
use ade_core::contract::conversations::Ack;
use ade_core::contract::services::{
    ExecutionState, ListenerFamily, ListenerInventory, ListenerListRequest, ListenerOwnership,
    ListenerRow, PortAssignment, PortObservation, Readiness, ReadinessBasis, ReadinessState,
    ServiceChanged, ServiceConfigureRequest, ServiceExecution, ServiceHealthSample,
    ServiceHealthSampleRequest, ServiceInspectRequest, ServiceInspection, ServiceList,
    ServiceListRequest, ServiceRemoveRequest, ServiceReply, ServiceStartRequest,
    ServiceStopRequest,
};

/// Decodes a service request and keeps the older wording for the named fields.
fn decode_with<T: serde::de::DeserializeOwned>(
    request: &Value,
    messages: &[(&str, &str)],
) -> Result<T> {
    decode(request).map_err(|error| {
        let text = error.to_string();
        messages
            .iter()
            .find(|(field, _)| text == format!("Missing {field}"))
            .map_or(error, |(_, message)| anyhow!("{message}"))
    })
}

/// How far a service terminal's stop has got.
#[derive(Debug, PartialEq, Eq)]
enum StopProgress {
    /// The process and its tree are proven stopped; ownership may be released.
    Exited,
    /// Still running, or the runtime is still verifying the process tree.
    Pending,
    /// The process was reaped but its tree was not proven stopped.
    Unconfirmed(String),
}
fn stop_progress(metrics: &Value) -> StopProgress {
    match super::leases::terminal_liveness(metrics) {
        super::leases::Liveness::Exited => StopProgress::Exited,
        super::leases::Liveness::Unknown
            if metrics["shell_running"] == false && metrics["exit_status"]["verifying"] != true =>
        {
            StopProgress::Unconfirmed(
                metrics["exit_status"]["reason"]
                    .as_str()
                    .unwrap_or("exit status unknown")
                    .to_owned(),
            )
        }
        _ => StopProgress::Pending,
    }
}
#[cfg(test)]
mod stop_tests {
    use super::*;
    #[test]
    fn a_live_or_unverified_tree_never_counts_as_stopped() {
        // A descendant survived SIGKILL: the runtime reports the stop as unknown.
        let live = json!({"shell_running": false, "exit_status": {"kind": "unknown",
            "reason": "tree live", "child": {"kind": "signaled", "signal": 9},
            "descendants": {"verdict": "live"}}});
        assert_eq!(
            stop_progress(&live),
            StopProgress::Unconfirmed("tree live".into())
        );
        // While the runtime verifies the tree, the stop keeps waiting.
        let verifying = json!({"shell_running": false, "exit_status": {"kind": "unknown",
            "verifying": true, "child": {"kind": "signaled", "signal": 15}}});
        assert_eq!(stop_progress(&verifying), StopProgress::Pending);
        assert_eq!(
            stop_progress(&json!({"shell_running": true})),
            StopProgress::Pending
        );
        // A reaped process with no exit status is not proof either.
        assert!(matches!(
            stop_progress(&json!({"shell_running": false})),
            StopProgress::Unconfirmed(_)
        ));
        let exited = json!({"shell_running": false, "exit_status": {"kind": "signaled",
            "signal": 15, "descendants": {"verdict": "exited"}}});
        assert_eq!(stop_progress(&exited), StopProgress::Exited);
    }
}

pub(super) struct HealthCheck {
    port_variable: String,
    path: String,
    timeout: std::time::Duration,
}
impl From<&ade_core::services::HealthPolicy> for HealthCheck {
    fn from(policy: &ade_core::services::HealthPolicy) -> Self {
        Self {
            port_variable: policy.port_variable.clone(),
            path: policy.path.clone(),
            timeout: std::time::Duration::from_millis(policy.timeout_ms),
        }
    }
}

impl HealthCheck {
    pub(super) fn parse(value: &Value) -> Result<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        let fields = value.as_object().context("Invalid HTTP health check")?;
        ensure!(
            fields
                .keys()
                .all(|key| matches!(key.as_str(), "port_variable" | "path" | "timeout_ms")),
            "Unknown HTTP health check field"
        );
        let port_variable = fields
            .get("port_variable")
            .and_then(Value::as_str)
            .context("Missing HTTP health port variable")?;
        ensure!(
            !port_variable.is_empty() && port_variable.len() <= 64,
            "Invalid HTTP health port variable"
        );
        let path = fields
            .get("path")
            .and_then(Value::as_str)
            .context("Missing HTTP health path")?;
        ensure!(
            path.starts_with('/')
                && path.len() <= 1024
                && path
                    .bytes()
                    .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'#'),
            "HTTP health path must be a visible ASCII path of at most 1024 bytes"
        );
        let timeout_ms = fields
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .context("Missing HTTP health timeout")?;
        ensure!(
            (50..=2000).contains(&timeout_ms),
            "HTTP health timeout must be 50 to 2000 ms"
        );
        Ok(Some(Self {
            port_variable: port_variable.to_owned(),
            path: path.to_owned(),
            timeout: std::time::Duration::from_millis(timeout_ms),
        }))
    }

    pub(super) fn probe(&self, port: u16) -> Value {
        // This deadline bounds the HTTP socket exchange. Runtime inspection and
        // listener discovery are separate parts of the service.inspect request.
        let deadline = std::time::Instant::now() + self.timeout;
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let result = (|| -> std::io::Result<u16> {
            let mut stream = TcpStream::connect_timeout(&address, self.timeout)?;
            let request = format!(
                "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                self.path
            );
            let mut pending = request.as_bytes();
            while !pending.is_empty() {
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .ok_or(std::io::ErrorKind::TimedOut)?;
                stream.set_write_timeout(Some(remaining))?;
                let written = stream.write(pending)?;
                if written == 0 {
                    return Err(std::io::ErrorKind::WriteZero.into());
                }
                pending = &pending[written..];
            }
            let mut line = Vec::new();
            loop {
                if line.len() >= 1024 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "HTTP status line exceeds 1024 bytes",
                    ));
                }
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .ok_or(std::io::ErrorKind::TimedOut)?;
                stream.set_read_timeout(Some(remaining))?;
                let mut byte = [0];
                if stream.read(&mut byte)? == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            let line = std::str::from_utf8(&line).map_err(|_| std::io::ErrorKind::InvalidData)?;
            let mut parts = line.trim_end().split(' ');
            let version = parts.next().unwrap_or("");
            let status = parts.next().unwrap_or("");
            if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
                || status.len() != 3
                || !status.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            status
                .parse()
                .map_err(|_| std::io::ErrorKind::InvalidData.into())
        })();
        match result {
            Ok(status) => {
                json!({"state":if (200..300).contains(&status) {"healthy"} else {"unhealthy"},
                "basis":"http_status","status_code":status})
            }
            Err(error) => {
                json!({"state":if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) {"timeout"} else {"error"},
                "basis":"http_probe","error":error.to_string()})
            }
        }
    }
}
pub(super) struct HealthSample {
    result: Value,
    revision: i64,
    transfer_id: String,
    sampled_at_ms: i64,
    sampled_at: std::time::Instant,
    started_at: std::time::Instant,
}
pub(super) struct HealthAttempt {
    revision: i64,
    transfer_id: String,
    attempted_at: std::time::Instant,
}
#[derive(Clone)]
pub(super) struct PeerTarget {
    variable: String,
    port_variable: String,
    service: Service,
}
pub(super) struct ServiceStopGuard<'a> {
    sessions: &'a Sessions,
    key: (String, String),
}
impl Drop for ServiceStopGuard<'_> {
    fn drop(&mut self) {
        self.sessions
            .data
            .lock()
            .unwrap()
            .stopping_services
            .remove(&self.key);
    }
}
pub(super) struct ServiceStartGuard<'a> {
    sessions: &'a Sessions,
    key: (String, String),
}
impl Drop for ServiceStartGuard<'_> {
    fn drop(&mut self) {
        self.sessions
            .data
            .lock()
            .unwrap()
            .starting_services
            .remove(&self.key);
    }
}

/// Decides whether a start admitted from `before` may still reserve its run
/// once the checks it ran without the data lock finish. The service, its
/// workspace root and each peer must be unchanged, no peer may be stopping,
/// and no other run may hold the service. Each peer is the service seen at
/// admission, the service now (`None` once removed) and whether it is stopping.
pub(super) fn start_still_admitted(
    before: &Service,
    current: &Service,
    root_before: &str,
    root_now: &str,
    peers: &[(&Service, Option<Service>, bool)],
) -> Result<()> {
    ensure!(
        current.terminal_owner.is_none(),
        "Service run is already reserved"
    );
    ensure!(
        current == before,
        "Service changed while it was starting; retry start"
    );
    ensure!(
        root_before == root_now,
        "Workspace root changed while the service was starting; retry start"
    );
    for (seen, now, stopping) in peers {
        ensure!(!stopping, "Peer service {} is stopping", seen.name);
        ensure!(
            now.as_ref() == Some(*seen),
            "Peer service {} changed while this service was starting; retry start",
            seen.name
        );
    }
    Ok(())
}

pub(super) struct HealthSampleGuard<'a>(&'a Sessions);
impl Drop for HealthSampleGuard<'_> {
    fn drop(&mut self) {
        self.0.data.lock().unwrap().active_health_samples -= 1;
    }
}
impl Sessions {
    pub(super) fn service_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "service.start" => {
                let start: ServiceStartRequest = decode(request)?;
                reply(&self.start_service(
                    non_empty("workspace_id", &start.workspace_id)?,
                    non_empty("name", &start.name)?,
                )?)
            }
            "service.stop" => {
                let stop: ServiceStopRequest = decode(request)?;
                reply(&self.stop_service(
                    non_empty("workspace_id", &stop.workspace_id)?,
                    non_empty("name", &stop.name)?,
                )?)
            }
            "service.health.sample" => {
                let sample: ServiceHealthSampleRequest = decode(request)?;
                reply(&self.sample_service_health(
                    non_empty("workspace_id", &sample.workspace_id)?,
                    non_empty("name", &sample.name)?,
                )?)
            }
            "service.inspect" => {
                let inspect: ServiceInspectRequest = decode(request)?;
                let health_check =
                    HealthCheck::parse(inspect.health_check.as_ref().unwrap_or(&Value::Null))?;
                let limit = inspect.tail_bytes.unwrap_or(8192);
                ensure!(
                    (1..=32768).contains(&limit),
                    "Tail limit must be 1 to 32768 bytes"
                );
                reply(&self.inspect_service(
                    non_empty("workspace_id", &inspect.workspace_id)?,
                    non_empty("name", &inspect.name)?,
                    limit,
                    health_check.as_ref(),
                )?)
            }
            "listener.list" => {
                let ListenerListRequest {} = decode(request)?;
                reply(&self.list_listeners()?)
            }
            "service.list" => {
                let list: ServiceListRequest = decode(request)?;
                let workspace = non_empty("workspace_id", &list.workspace_id)?;
                let services = self.data.lock().unwrap().store.services(workspace)?;
                let terminals = self.runtime.command(TerminalCommand::List)?;
                let terminals = terminals["terminals"]
                    .as_array()
                    .context("Invalid terminal catalogue")?;
                let states = services
                    .iter()
                    .map(|service| {
                        let terminal = service.terminal_id.as_ref().and_then(|id| {
                            terminals
                                .iter()
                                .find(|t| t["workspace"]["terminal_id"] == *id)
                        });
                        let state = match &service.terminal_owner {
                            None => ExecutionState::Stopped,
                            Some(owner) if owner.runtime_instance != self.runtime.instance => {
                                ExecutionState::Unavailable
                            }
                            Some(owner) => match terminal {
                                Some(t) if t["metrics"]["transfer_id"] == owner.transfer_id => {
                                    if t["metrics"]["shell_running"] == true {
                                        ExecutionState::Running
                                    } else {
                                        ExecutionState::Exited
                                    }
                                }
                                _ => ExecutionState::Unavailable,
                            },
                        };
                        (
                            service.name.clone(),
                            ServiceExecution {
                                state,
                                metrics: terminal.map(|t| t["metrics"].clone()),
                            },
                        )
                    })
                    .collect();
                reply(&ServiceList {
                    tag: Default::default(),
                    services,
                    states,
                })
            }
            "service.configure" => {
                let configure: ServiceConfigureRequest =
                    decode_with(request, &[("revision", "Missing service revision")])?;
                let config = serde_json::from_value(configure.config)?;
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                let service = d.store.configure_service(
                    non_empty("workspace_id", &configure.workspace_id)?,
                    non_empty("name", &configure.name)?,
                    configure.revision,
                    config,
                )?;
                d.health_samples
                    .remove(&(service.workspace_id.clone(), service.name.clone()));
                d.health_attempts
                    .remove(&(service.workspace_id.clone(), service.name.clone()));
                reply(&ServiceReply::service(service))
            }
            "service.remove" => {
                let remove: ServiceRemoveRequest =
                    decode_with(request, &[("revision", "Missing service revision")])?;
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                let workspace = non_empty("workspace_id", &remove.workspace_id)?;
                let name = non_empty("name", &remove.name)?;
                let revision = remove.revision;
                if let Some(service) = d
                    .store
                    .services(workspace)?
                    .into_iter()
                    .find(|s| s.name == name)
                {
                    ensure!(
                        service.terminal_owner.is_none(),
                        "Stop the service before removing it"
                    );
                    ensure!(
                        service.revision == revision,
                        "Service changed; reload before removing"
                    );
                    if let Some(terminal) = service.terminal_id {
                        self.runtime.command(TerminalCommand::Retire {
                            workspace_id: workspace.to_string(),
                            terminal_id: terminal.to_string(),
                        })?;
                    }
                }
                d.store.remove_service(workspace, name, revision)?;
                d.health_samples
                    .remove(&(workspace.to_owned(), name.to_owned()));
                d.health_attempts
                    .remove(&(workspace.to_owned(), name.to_owned()));
                self.catalog_changed(&mut d)?;
                reply(&Ack::default())
            }
            _ => bail!("Unknown session operation"),
        }
    }
    pub(super) fn monitored_health(
        d: &Data,
        service: &ade_core::services::Service,
        execution_state: ExecutionState,
    ) -> Value {
        let Some(policy) = &service.config.health else {
            return json!({"state":"disabled"});
        };
        let Some(owner) = &service.terminal_owner else {
            return json!({"state":"not_running"});
        };
        if execution_state != ExecutionState::Running {
            return json!({"state":"unknown","basis":"execution_unavailable"});
        }
        if d.stopping_services
            .contains(&(service.workspace_id.clone(), service.name.clone()))
        {
            return json!({"state":"unknown","basis":"service_stopping"});
        }
        let Some(sample) = d
            .health_samples
            .get(&(service.workspace_id.clone(), service.name.clone()))
        else {
            return json!({"state":"unknown","basis":"no_sample"});
        };
        if sample.revision != service.revision || sample.transfer_id != owner.transfer_id {
            return json!({"state":"unknown","basis":"run_changed"});
        }
        let age = sample.sampled_at.elapsed();
        let interval = std::time::Duration::from_millis(policy.interval_ms);
        let schedule_delay_ms = age.saturating_sub(interval).as_millis() as u64;
        let freshness = std::time::Duration::from_millis(policy.interval_ms.saturating_mul(2));
        if age > freshness {
            return json!({"state":"stale","basis":"sampling_delayed",
                "last_result":sample.result,"sampled_at_ms":sample.sampled_at_ms,
                "schedule_delay_ms":schedule_delay_ms});
        }
        let mut result = sample.result.clone();
        result["sampled_at_ms"] = json!(sample.sampled_at_ms);
        result["fresh_until_ms"] = json!(sample.sampled_at_ms + freshness.as_millis() as i64);
        result["schedule_delay_ms"] = json!(schedule_delay_ms);
        result
    }

    pub(super) fn sample_service_health(
        self: &Arc<Self>,
        workspace: &str,
        name: &str,
    ) -> Result<ServiceHealthSample> {
        self.ensure_workspace_bound(workspace)?;
        let started_at = std::time::Instant::now();
        let service = {
            let mut d = self.data.lock().unwrap();
            let service = d.store.service(workspace, name)?;
            ensure!(
                service.config.health.is_some(),
                "Service has no configured HTTP health policy"
            );
            ensure!(
                d.active_health_samples < 4,
                "Too many HTTP health samples in progress"
            );
            d.active_health_samples += 1;
            if let Some(owner) = &service.terminal_owner {
                d.health_attempts.insert(
                    (workspace.to_owned(), name.to_owned()),
                    HealthAttempt {
                        revision: service.revision,
                        transfer_id: owner.transfer_id.clone(),
                        attempted_at: std::time::Instant::now(),
                    },
                );
            }
            service
        };
        let _sample_guard = HealthSampleGuard(self);
        let policy = service.config.health.as_ref().unwrap();
        let inspection =
            self.inspect_service(workspace, name, 1, Some(&HealthCheck::from(policy)))?;
        let result = inspection.health.clone().unwrap_or(Value::Null);
        let mut d = self.data.lock().unwrap();
        let current = d.store.service(workspace, name)?;
        if current != service
            || d.stopping_services
                .contains(&(workspace.to_owned(), name.to_owned()))
        {
            return Ok(ServiceHealthSample {
                tag: Default::default(),
                health_monitor: json!({"state":"unknown","basis":"identity_changed"}),
            });
        }
        if let Some(owner) = &service.terminal_owner
            && inspection.execution_state == ExecutionState::Running
        {
            let key = (workspace.to_owned(), name.to_owned());
            let superseded = d.health_samples.get(&key).is_some_and(|prior| {
                prior.revision == service.revision
                    && prior.transfer_id == owner.transfer_id
                    && prior.started_at > started_at
            });
            if !superseded {
                d.health_samples.insert(
                    key,
                    HealthSample {
                        result,
                        revision: service.revision,
                        transfer_id: owner.transfer_id.clone(),
                        sampled_at_ms: now_ms(),
                        sampled_at: std::time::Instant::now(),
                        started_at,
                    },
                );
            }
        }
        Ok(ServiceHealthSample {
            tag: Default::default(),
            health_monitor: Self::monitored_health(&d, &current, inspection.execution_state),
        })
    }

    pub(super) fn sample_due_service_health(self: &Arc<Self>) -> Result<()> {
        let due = {
            let d = self.data.lock().unwrap();
            if d.draining {
                return Ok(());
            }
            let mut selected: Option<(String, String, Option<std::time::Instant>)> = None;
            for service in d.store.all_services_for_health()? {
                if d.store
                    .ensure_workspace_bound(&service.workspace_id)
                    .is_err()
                {
                    continue;
                }
                let Some(policy) = &service.config.health else {
                    continue;
                };
                let Some(owner) = &service.terminal_owner else {
                    continue;
                };
                if d.stopping_services
                    .contains(&(service.workspace_id.clone(), service.name.clone()))
                {
                    continue;
                }
                let last = d
                    .health_attempts
                    .get(&(service.workspace_id.clone(), service.name.clone()))
                    .filter(|attempt| {
                        attempt.revision == service.revision
                            && attempt.transfer_id == owner.transfer_id
                    })
                    .map(|attempt| attempt.attempted_at);
                if last.is_some_and(|at| {
                    at.elapsed() < std::time::Duration::from_millis(policy.interval_ms)
                }) {
                    continue;
                }
                if selected
                    .as_ref()
                    .is_none_or(|(_, _, previous)| last < *previous)
                {
                    selected = Some((service.workspace_id, service.name, last));
                }
            }
            selected.map(|(workspace, name, _)| (workspace, name))
        };
        if let Some((workspace, name)) = due {
            // A concurrent stop or edit can invalidate this candidate; sampling fences it again.
            let _ = self.sample_service_health(&workspace, &name);
        }
        Ok(())
    }

    pub(super) fn inspect_service(
        self: &Arc<Self>,
        workspace: &str,
        name: &str,
        limit: u64,
        health_check: Option<&HealthCheck>,
    ) -> Result<ServiceInspection> {
        let (service, peer_targets, mut peer_error) = {
            let d = self.data.lock().unwrap();
            let service = d.store.service(workspace, name)?;
            let (targets, error) = match Self::peer_targets(&d, &service) {
                Ok(targets) => (targets, None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            };
            (service, targets, error)
        };
        let mut current_peer_endpoints = if peer_error.is_none() {
            match self.resolve_peer_targets(&peer_targets) {
                Ok(endpoints) => endpoints,
                Err(error) => {
                    peer_error = Some(error.to_string());
                    BTreeMap::new()
                }
            }
        } else {
            BTreeMap::new()
        };
        if let Some(check) = health_check {
            ensure!(
                service
                    .config
                    .ports
                    .iter()
                    .any(|variable| variable == &check.port_variable)
                    && service.ports.contains_key(&check.port_variable),
                "HTTP health port variable is not configured for this service"
            );
        }
        let mut shell_pid = None;
        let (state, execution_error, durable_capture_error) = match self
            .command(&json!({"op":"service.list","workspace_id":workspace}))
        {
            Ok(listed) => {
                let metrics = &listed["states"][name]["metrics"];
                shell_pid = metrics["shell_pid"]
                    .as_u64()
                    .and_then(|pid| u32::try_from(pid).ok());
                (
                    <ExecutionState as serde::Deserialize>::deserialize(
                        &listed["states"][name]["state"],
                    )
                    .unwrap_or(ExecutionState::Unavailable),
                    None,
                    if service.last_run_transfer_id.as_deref() == metrics["transfer_id"].as_str() {
                        metrics["durable_log_error"].as_str().map(str::to_owned)
                    } else {
                        None
                    },
                )
            }
            Err(error) => (ExecutionState::Unavailable, Some(error.to_string()), None),
        };
        let running = state == ExecutionState::Running;
        let observations = if running {
            Some(self.list_listeners())
        } else {
            None
        };
        // The service's own listeners: rows attributed to this run's process tree.
        let own_rows = |inventory: &ListenerInventory| {
            inventory
                .listeners
                .iter()
                .filter(|row| {
                    row.workspace_id.as_deref() == Some(workspace)
                        && row.service_name.as_deref() == Some(name)
                })
                .map(|row| (row.port, row.pid))
                .collect::<Vec<_>>()
        };
        // True when the tree listens on a port it was not assigned.
        let listens_elsewhere = observations
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .is_some_and(|inventory| {
                own_rows(inventory)
                    .iter()
                    .any(|(port, _)| !service.ports.values().any(|assigned| assigned == port))
            });
        let mut through_descendant = false;
        let (readiness_state, observation_error) = match &observations {
            None => (
                match state {
                    ExecutionState::Stopped => ReadinessState::Stopped,
                    ExecutionState::Exited => ReadinessState::Exited,
                    _ => ReadinessState::Unknown,
                },
                None,
            ),
            Some(Ok(inventory)) => {
                let ports = inventory
                    .assignments
                    .iter()
                    .filter(|item| item.workspace_id == workspace && item.service_name == name)
                    .map(|item| item.observation)
                    .collect::<Vec<_>>();
                through_descendant = own_rows(inventory)
                    .iter()
                    .any(|(_, pid)| Some(*pid) != shell_pid);
                (
                    listeners::readiness_verdict(&ports, listens_elsewhere),
                    None,
                )
            }
            Some(Err(error)) => (
                ReadinessState::ObservationUnavailable,
                Some(error.to_string()),
            ),
        };
        let mut health = health_check.map(|check| {
            let result = if !running {
                json!({"state":"not_running","basis":"execution_state"})
            } else if observations.as_ref().is_none_or(Result::is_err) {
                json!({"state":"unknown","basis":"listener_observation_unavailable"})
            } else {
                let assignment = observations
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|inventory| {
                        inventory.assignments.iter().find(|item| {
                            item.workspace_id == workspace
                                && item.service_name == name
                                && item.variable == check.port_variable
                        })
                    });
                listeners::health_gate(assignment.map(|item| item.observation), listens_elsewhere)
                    .unwrap_or_else(|| check.probe(service.ports[&check.port_variable]))
            };
            let mut result = result;
            result["port_variable"] = json!(check.port_variable);
            result["path"] = json!(check.path);
            result
        });
        let logs = if let Some(terminal_id) = &service.terminal_id {
            match self.runtime.command(TerminalCommand::Tail {
                workspace_id: workspace.to_string(),
                terminal_id: terminal_id.to_string(),
                limit_bytes: limit,
            }) {
                Ok(tail)
                    if service
                        .terminal_owner
                        .as_ref()
                        .is_none_or(|owner| tail["transfer_id"] == owner.transfer_id) =>
                {
                    let mut tail = tail;
                    tail["available"] = json!(true);
                    tail
                }
                _ => json!({"available":false,"reason":"runtime_terminal_unavailable"}),
            }
        } else {
            json!({"available":false,"reason":"not_started"})
        };
        let mut durable_logs = match (&service.terminal_id, &service.last_run_transfer_id) {
            (Some(terminal_id), Some(transfer_id)) => ade_runtime::service_logs::tail(
                self.runtime.data_directory(),
                workspace,
                terminal_id,
                transfer_id,
                limit as usize,
            ),
            (None, _) => json!({"available":false,"reason":"not_started"}),
            (_, None) => json!({"available":false,"reason":"run_identity_unrecorded"}),
        };
        if let Some(error) = durable_capture_error {
            durable_logs["capture_error"] = json!(error);
        }
        let still_running = if running && health_check.is_some() {
            self.command(&json!({"op":"service.list","workspace_id":workspace}))
                .ok()
                .is_some_and(|listed| listed["states"][name]["state"] == "running")
        } else {
            false
        };
        // A listener can close or be replaced while the HTTP request is in flight.
        // Only retain a probe result when the same managed assignment remains verified.
        let still_managed = health_check.is_none_or(|check| {
            if !health.as_ref().is_some_and(|result| {
                result["basis"] == "http_status" || result["basis"] == "http_probe"
            }) {
                return true;
            }
            self.list_listeners().ok().is_some_and(|inventory| {
                inventory.assignments.iter().any(|item| {
                    item.workspace_id == workspace
                        && item.service_name == name
                        && item.variable == check.port_variable
                        && item.port == service.ports[&check.port_variable]
                        && item.observation == PortObservation::VerifiedManaged
                })
            })
        });
        let d = self.data.lock().unwrap();
        let current = d.store.service(workspace, name)?;
        if current != service {
            const CHANGED: &str = "Service changed during inspection; refresh";
            return Ok(ServiceInspection {
                tag: Default::default(),
                service: current,
                execution_state: ExecutionState::Unavailable,
                execution_error: Some(CHANGED.into()),
                readiness: Readiness {
                    state: ReadinessState::Unknown,
                    basis: ReadinessBasis::IdentityChanged,
                    application_ready: Default::default(),
                    observation_error: Some(CHANGED.into()),
                },
                logs: json!({"available":false,"reason":"service_changed_during_inspection"}),
                durable_logs: json!({"available":false,"reason":"service_changed_during_inspection"}),
                effective_peers: BTreeMap::new(),
                current_peer_endpoints: None,
                peer_error: Some(CHANGED.into()),
                health: health_check.map(|_| json!({"state":"unknown","basis":"identity_changed"})),
                health_monitor: json!({"state":"unknown","basis":"identity_changed"}),
            });
        }
        if peer_targets.iter().any(|target| {
            d.stopping_services
                .contains(&(workspace.to_owned(), target.service.name.clone()))
                || d.store
                    .service(workspace, &target.service.name)
                    .ok()
                    .as_ref()
                    != Some(&target.service)
        }) {
            current_peer_endpoints.clear();
            peer_error = Some("Peer service changed during inspection; refresh".into());
        }
        let effective_peers = if running && service.terminal_owner.is_some() {
            service.launch_peers.clone()
        } else {
            BTreeMap::new()
        };
        if service.terminal_owner.is_some()
            && peer_error.is_none()
            && current_peer_endpoints != effective_peers
        {
            peer_error = Some("Peer endpoint changed since launch; restart this service".into());
        }
        if running && health_check.is_some() {
            let stopping = d
                .stopping_services
                .contains(&(workspace.to_owned(), name.to_owned()));
            if stopping || !still_running {
                health = Some(json!({"state":"unknown","basis":"execution_changed"}));
            } else if !still_managed {
                health = Some(json!({"state":"unknown","basis":"managed_listener_changed"}));
            }
        }
        let health_monitor = Self::monitored_health(&d, &service, state);
        Ok(ServiceInspection {
            tag: Default::default(),
            service,
            execution_state: state,
            execution_error,
            readiness: Readiness {
                state: readiness_state,
                basis: if running && through_descendant {
                    ReadinessBasis::ProcessTreeTcpListener
                } else if running {
                    ReadinessBasis::DirectProcessTcpListener
                } else {
                    ReadinessBasis::ExecutionState
                },
                application_ready: Default::default(),
                observation_error,
            },
            logs,
            durable_logs,
            effective_peers,
            current_peer_endpoints: Some(current_peer_endpoints),
            peer_error,
            health,
            health_monitor,
        })
    }

    pub(super) fn list_listeners(&self) -> Result<ListenerInventory> {
        let services = {
            let d = self.data.lock().unwrap();
            let workspaces = d.store.catalog()?.workspaces;
            let mut services = Vec::new();
            for workspace in workspaces {
                services.extend(d.store.services(&workspace.id)?);
                ensure!(
                    services.len() <= 512,
                    "Too many service assignments to inspect"
                );
            }
            services
        };
        let before = self.runtime.command(TerminalCommand::List)?;
        let observed = listeners::observe()?;
        let after = self.runtime.command(TerminalCommand::List)?;
        let terminal_metrics = |snapshot: &Value, terminal_id: &str| -> Option<Value> {
            snapshot["terminals"]
                .as_array()?
                .iter()
                .find(|item| item["workspace"]["terminal_id"] == terminal_id)
                .map(|item| item["metrics"].clone())
        };
        let mut managed = HashMap::<u32, (String, String)>::new();
        for service in &services {
            let (Some(owner), Some(terminal_id)) = (&service.terminal_owner, &service.terminal_id)
            else {
                continue;
            };
            if owner.runtime_instance != self.runtime.instance {
                continue;
            }
            let (Some(first), Some(last)) = (
                terminal_metrics(&before, terminal_id),
                terminal_metrics(&after, terminal_id),
            ) else {
                continue;
            };
            let pid = first["shell_pid"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok());
            if first["shell_running"] != true
                || last["shell_running"] != true
                || first["transfer_id"] != owner.transfer_id
                || last["transfer_id"] != owner.transfer_id
                || first["shell_pid"] != last["shell_pid"]
                || first["run_id"] != last["run_id"]
                || first["run_id"].as_str().is_none_or(str::is_empty)
            {
                continue;
            }
            if let Some(pid) = pid {
                // A shared PID would make attribution ambiguous; direct service
                // processes should each have a distinct identity.
                managed
                    .entry(pid)
                    .and_modify(|entry| entry.0.clear())
                    .or_insert_with(|| (service.workspace_id.clone(), service.name.clone()));
            }
        }
        managed.retain(|_, (workspace, _)| !workspace.is_empty());
        // Attribute each listener to the one run whose process tree holds it,
        // so `pnpm dev` counts through the node child that actually binds.
        let roots = managed.keys().copied().collect::<HashSet<u32>>();
        let mut owner_of = HashMap::<u32, Option<(String, String)>>::new();
        for listener in &observed {
            owner_of.entry(listener.pid).or_insert_with(|| {
                listeners::live_owning_root(listener.pid, &roots)
                    .and_then(|root| managed.get(&root).cloned())
            });
        }
        let listener_rows = observed
            .iter()
            .map(|listener| {
                let owner = owner_of.get(&listener.pid).and_then(Option::as_ref);
                ListenerRow {
                    protocol: Default::default(),
                    address: listener.address.clone(),
                    port: listener.port,
                    family: match listener.family {
                        listeners::IpFamily::V4 => ListenerFamily::Ipv4,
                        listeners::IpFamily::V6 => ListenerFamily::Ipv6,
                    },
                    pid: listener.pid,
                    ownership: if owner.is_some() {
                        ListenerOwnership::ManagedService
                    } else {
                        ListenerOwnership::Unknown
                    },
                    workspace_id: owner.map(|value| value.0.clone()),
                    service_name: owner.map(|value| value.1.clone()),
                }
            })
            .collect();
        let assignments = services
            .iter()
            .flat_map(|service| {
                service.ports.iter().map(|(variable, port)| {
                    let mut own = false;
                    let mut other = false;
                    for listener in observed.iter().filter(|item| item.port == *port) {
                        if owner_of.get(&listener.pid).and_then(Option::as_ref)
                            == Some(&(service.workspace_id.clone(), service.name.clone()))
                        {
                            own = true;
                        } else {
                            other = true;
                        }
                    }
                    let observation = listeners::port_observation(own, other);
                    PortAssignment {
                        workspace_id: service.workspace_id.clone(),
                        service_name: service.name.clone(),
                        variable: variable.clone(),
                        port: *port,
                        observation,
                    }
                })
            })
            .collect();
        // Bind each launched port claim to the listener verified in its run's
        // own process tree. A port someone else also holds is left unbound.
        for service in &services {
            let owner = Some((service.workspace_id.clone(), service.name.clone()));
            for port in service.ports.values() {
                let mut own = observed
                    .iter()
                    .filter(|item| item.port == *port)
                    .map(|item| {
                        (
                            owner_of.get(&item.pid).cloned().flatten() == owner,
                            item.pid,
                        )
                    });
                let first = own.next();
                if let Some((true, pid)) = first
                    && own.all(|(mine, _)| mine)
                {
                    let holder = crate::host_resources::service_holder(
                        &service.workspace_id,
                        &service.name,
                        &service.identity,
                    );
                    if let Err(error) = self
                        .worktrees
                        .host_resources()
                        .bind_listener(&holder, *port, pid)
                    {
                        eprintln!("Port claim {holder} tcp:{port} was not bound: {error}");
                    }
                }
            }
        }
        Ok(ListenerInventory {
            tag: Default::default(),
            scope: Default::default(),
            coverage: Default::default(),
            listeners: listener_rows,
            assignments,
        })
    }

    /// After a verified stop, releases the run's port claims when no
    /// listener is left on the port, and quarantines them otherwise. A
    /// registry failure leaves the claims in place, still conflicting.
    fn settle_service_ports(&self, holder: &str) {
        let listening: Option<Vec<u16>> = listeners::observe()
            .ok()
            .map(|rows| rows.iter().map(|row| row.port).collect());
        let result = self
            .worktrees
            .host_resources()
            .settle_holder(holder, |claim| match &claim.resource {
                crate::host_resources::Resource::Port { port } => Some(
                    crate::host_resources::settle_port_after_stop(*port, listening.as_deref()),
                ),
                _ => None,
            });
        if let Err(error) = result {
            eprintln!("Port claims of {holder} were not settled after stop: {error}");
        }
    }

    pub(super) fn peer_targets(d: &Data, service: &Service) -> Result<Vec<PeerTarget>> {
        service
            .config
            .peers
            .iter()
            .map(|(variable, peer)| {
                let target = d
                    .store
                    .service(&service.workspace_id, &peer.service)
                    .with_context(|| format!("Peer service {} is unavailable", peer.service))?;
                ensure!(
                    target.ports.contains_key(&peer.port_variable),
                    "Peer service {} has no {} port",
                    peer.service,
                    peer.port_variable
                );
                ensure!(
                    !d.stopping_services
                        .contains(&(service.workspace_id.clone(), peer.service.clone())),
                    "Peer service {} is stopping",
                    peer.service
                );
                Ok(PeerTarget {
                    variable: variable.clone(),
                    port_variable: peer.port_variable.clone(),
                    service: target,
                })
            })
            .collect()
    }

    pub(super) fn resolve_peer_targets(
        &self,
        targets: &[PeerTarget],
    ) -> Result<BTreeMap<String, String>> {
        if targets.is_empty() {
            return Ok(BTreeMap::new());
        }
        let terminals = self.runtime.command(TerminalCommand::List)?;
        let terminals = terminals["terminals"]
            .as_array()
            .context("Peer terminal catalogue is unavailable")?;
        let listeners = listeners::observe().context("Peer listener observation is unavailable")?;
        let reachable = |entry: &listeners::Listener, family: listeners::IpFamily| {
            entry.family == family
                && match family {
                    listeners::IpFamily::V4 => {
                        matches!(entry.address.as_str(), "127.0.0.1" | "0.0.0.0" | "*")
                    }
                    listeners::IpFamily::V6 => {
                        matches!(entry.address.as_str(), "::1" | "::" | "*")
                    }
                }
        };
        let mut resolved = BTreeMap::new();
        for target in targets {
            let peer = &target.service;
            let port = peer.ports[&target.port_variable];
            let owner = peer
                .terminal_owner
                .as_ref()
                .with_context(|| format!("Peer service {} is stopped", peer.name))?;
            ensure!(
                owner.runtime_instance == self.runtime.instance,
                "Peer service {} belongs to an unavailable runtime",
                peer.name
            );
            let terminal = terminals
                .iter()
                .find(|entry| entry["workspace"]["terminal_id"] == owner.terminal_id)
                .with_context(|| format!("Peer service {} has no live terminal", peer.name))?;
            let metrics = &terminal["metrics"];
            ensure!(
                metrics["shell_running"] == true
                    && metrics["transfer_id"] == owner.transfer_id
                    && metrics["shell_pid"].as_u64().is_some(),
                "Peer service {} execution identity is unavailable",
                peer.name
            );
            let pid = u32::try_from(metrics["shell_pid"].as_u64().unwrap())?;
            let address = [
                (listeners::IpFamily::V4, "127.0.0.1"),
                (listeners::IpFamily::V6, "[::1]"),
            ]
            .into_iter()
            .find_map(|(family, address)| {
                let on_port = listeners
                    .iter()
                    .filter(|entry| entry.port == port && reachable(entry, family))
                    .map(|entry| listeners::in_service_tree(pid, entry.pid))
                    .collect::<Vec<_>>();
                let own = on_port.iter().any(|owned| *owned);
                let other = on_port.iter().any(|owned| !*owned);
                (own && !other).then_some(address)
            })
            .with_context(|| {
                format!(
                    "Peer service {} does not own a verified loopback listener on {}",
                    peer.name, target.port_variable
                )
            })?;
            resolved.insert(target.variable.clone(), format!("http://{address}:{port}"));
        }
        Ok(resolved)
    }

    pub(super) fn start_service(&self, workspace: &str, name: &str) -> Result<ServiceReply> {
        let lease_key = super::leases::LeaseKey::Service {
            workspace_id: workspace.to_owned(),
            name: name.to_owned(),
        };
        let key = (workspace.to_owned(), name.to_owned());
        // Phase 1, under the data lock: validate and read. Runtime calls,
        // listener observation, the worktree lease and the host registry run
        // outside it, so a slow lsof, registry or launch stalls no other
        // session. The start fence keeps a concurrent start or stop out.
        let (w, before, targets) = {
            let mut d = self.data.lock().unwrap();
            ensure!(!d.draining, "Application daemon is restarting");
            ensure!(
                !d.starting_services.contains(&key),
                "Service start is already in progress"
            );
            Self::ensure_lease_resolved(&d, &lease_key)?;
            d.store.ensure_workspace_bound(workspace)?;
            let w = d.store.workspace(workspace)?;
            let before = d.store.service(workspace, name)?;
            let targets = if before.terminal_owner.is_none() {
                let targets = Self::peer_targets(&d, &before)?;
                d.starting_services.insert(key.clone());
                targets
            } else {
                Vec::new()
            };
            (w, before, targets)
        };
        if let Some(owner) = &before.terminal_owner {
            ensure!(
                owner.runtime_instance == self.runtime.instance,
                "Service supervisor was replaced; stop the service before starting a new run"
            );
            let state = self.runtime.command(TerminalCommand::List)?;
            let terminal = state["terminals"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item["workspace"]["terminal_id"] == owner.terminal_id)
                })
                .context("Service terminal is unavailable; stop the prior run before restarting")?;
            ensure!(
                terminal["metrics"]["transfer_id"] == owner.transfer_id,
                "Service terminal ownership changed"
            );
            ensure!(
                terminal["metrics"]["shell_running"] == true,
                "Service exited; stop the prior run before restarting"
            );
            return Ok(ServiceReply {
                terminal_id: Some(owner.terminal_id.clone()),
                metrics: Some(terminal["metrics"].clone()),
                effective_peers: Some(before.launch_peers.clone()),
                ..ServiceReply::service(before.clone())
            });
        }
        let _start_guard = ServiceStartGuard {
            sessions: self,
            key: key.clone(),
        };
        // Phase 2, without the lock: observe peers, lease the worktree and
        // reserve the ports host-wide, so another profile's run cannot launch
        // onto them. The catalogue shows no run and the probe found them free,
        // which retires this service's own quarantined claims.
        let peer_endpoints = self.resolve_peer_targets(&targets)?;
        let lease = self.worktrees.agent_lease(&w.root)?;
        before.config.directory(&w.root)?;
        before.check_ports()?;
        if let Some(terminal) = &before.terminal_id {
            self.runtime.command(TerminalCommand::Retire {
                workspace_id: workspace.to_string(),
                terminal_id: terminal.to_string(),
            })?;
        }
        let holder = crate::host_resources::service_holder(workspace, name, &before.identity);
        let mut ports = crate::host_resources::PortReservation::reserve(
            self.worktrees.host_resources(),
            before.ports.values().copied(),
            &holder,
            true,
        )?;
        // Phase 3, under the lock: re-check what phase 1 read, then commit the
        // durable reservation. It fences editing, removal and replacement runs
        // while the launch below runs without the lock.
        let (service, owner, mut w) = {
            let mut d = self.data.lock().unwrap();
            ensure!(!d.draining, "Application daemon is restarting");
            Self::ensure_lease_resolved(&d, &lease_key)?;
            d.store.ensure_workspace_bound(workspace)?;
            let current = d.store.service(workspace, name)?;
            let current_workspace = d.store.workspace(workspace)?;
            let peers: Vec<_> = targets
                .iter()
                .map(|target| {
                    let peer = &target.service;
                    (
                        peer,
                        d.store.service(workspace, &peer.name).ok(),
                        d.stopping_services
                            .contains(&(workspace.to_owned(), peer.name.clone())),
                    )
                })
                .collect();
            start_still_admitted(&before, &current, &w.root, &current_workspace.root, &peers)?;
            let service = d.store.reserve_service(
                workspace,
                name,
                &self.runtime.instance,
                &peer_endpoints,
            )?;
            d.health_samples.remove(&key);
            d.health_attempts.remove(&key);
            let owner = service.terminal_owner.as_ref().unwrap().clone();
            ensure!(
                owner.runtime_instance == self.runtime.instance,
                "Service supervisor was replaced; stop the service before starting a new run"
            );
            d.terminal_leases.insert(owner.terminal_id.clone(), lease);
            self.catalog_changed(&mut d)?;
            (service, owner, d.store.workspace(workspace)?)
        };
        // Phase 4, without the lock: launch under the durable reservation.
        let launch = service.launch(&w.root, &peer_endpoints)?;
        w.terminal_id = owner.terminal_id.clone();
        ports.dispatch()?;
        let result = self.runtime.command(TerminalCommand::Launch {
            workspace: w,
            terminal_key: Some(owner.terminal_id.clone()),
            launch,
            session_subscribers: self.subscribers.load(Ordering::Relaxed),
        })?;
        ports.launched();
        ensure!(
            result["metrics"]["transfer_id"] == owner.transfer_id,
            "Service launch returned another transfer identity"
        );
        let mut d = self.data.lock().unwrap();
        let changed = self.service_changed(&d, &service, Some(result["metrics"].clone()));
        self.publish(&mut d, changed);
        Ok(ServiceReply {
            terminal_id: Some(owner.terminal_id),
            metrics: Some(result["metrics"].clone()),
            effective_peers: Some(peer_endpoints),
            ..ServiceReply::service(service)
        })
    }
    pub(super) fn stop_service(&self, workspace: &str, name: &str) -> Result<ServiceReply> {
        let (owner, holder) = {
            let mut d = self.data.lock().unwrap();
            ensure!(!d.draining, "Application daemon is restarting");
            let service = d.store.service(workspace, name)?;
            let holder = crate::host_resources::service_holder(workspace, name, &service.identity);
            let Some(owner) = service.terminal_owner else {
                return Ok(ServiceReply::service(service));
            };
            // A start launches without the lock under its durable reservation;
            // a stop now could release that reservation before the launch lands.
            ensure!(
                !d.starting_services
                    .contains(&(workspace.to_owned(), name.to_owned())),
                "Service start is in progress; retry stop after it finishes"
            );
            ensure!(
                d.stopping_services
                    .insert((workspace.to_owned(), name.to_owned())),
                "Service stop is already in progress"
            );
            (owner, holder)
        };
        let _stop_guard = ServiceStopGuard {
            sessions: self,
            key: (workspace.to_owned(), name.to_owned()),
        };
        // Do not hold the application state lock while waiting for process reap.
        // The durable reservation fences editing, removal and replacement runs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut sent = false;
        loop {
            let state = self.runtime.command(TerminalCommand::List)?;
            let terminal = state["terminals"]
                .as_array()
                .context("Invalid terminal catalogue")?
                .iter()
                .find(|t| t["workspace"]["terminal_id"] == owner.terminal_id);
            let Some(terminal) = terminal else {
                break;
            };
            ensure!(
                owner.runtime_instance == self.runtime.instance
                    && terminal["metrics"]["transfer_id"] == owner.transfer_id,
                "Service terminal ownership changed"
            );
            match stop_progress(&terminal["metrics"]) {
                StopProgress::Exited => break,
                StopProgress::Unconfirmed(reason) => bail!(
                    "Service process tree was not confirmed stopped ({reason}); its reservation is kept"
                ),
                StopProgress::Pending => {}
            }
            if !sent {
                self.runtime.command(TerminalCommand::Stop {
                    workspace_id: workspace.to_string(),
                    terminal_id: owner.terminal_id.clone(),
                })?;
                sent = true;
            }
            ensure!(
                std::time::Instant::now() < deadline,
                "Service has not exited; retry stop to confirm cleanup"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // A run from a replaced runtime is absent from this one, and that
        // absence is not proof of exit. When restart reconciliation watches
        // the run, observe its recorded tree again before anything is released.
        let lease_key = super::leases::LeaseKey::Service {
            workspace_id: workspace.to_owned(),
            name: name.to_owned(),
        };
        let resolution = self.recovery_control_release(&lease_key)?;
        self.settle_service_ports(&holder);
        let mut d = self.data.lock().unwrap();
        ensure!(
            !d.draining,
            "Application daemon is restarting; retry service stop"
        );
        let current = d.store.service(workspace, name)?;
        if current.terminal_owner.is_none() {
            return Ok(ServiceReply::service(current));
        }
        let service = d.store.release_service(workspace, name, &owner)?;
        d.health_samples
            .remove(&(workspace.to_owned(), name.to_owned()));
        d.health_attempts
            .remove(&(workspace.to_owned(), name.to_owned()));
        d.terminal_leases.remove(&owner.terminal_id);
        self.settle_unresolved(&mut d, &lease_key, resolution);
        let changed = self.service_changed(&d, &service, None);
        self.publish(&mut d, changed);
        Ok(ServiceReply::service(service))
    }

    /// The `service_changed` frame; [`Sessions::publish`] stamps its revision.
    fn service_changed(&self, d: &Data, service: &Service, metrics: Option<Value>) -> Value {
        json!(ServiceChanged {
            tag: Default::default(),
            service: service.clone(),
            metrics,
            boot_id: self.boot_id.clone(),
            revision: d.revision,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(name: &str, revision: i64) -> Service {
        serde_json::from_value(json!({
            "identity": format!("{name}-identity"),
            "workspace_id": "w",
            "name": name,
            "revision": revision,
            "config": {"program": "serve"},
            "ports": {"PORT": 4100},
            "hostname": format!("{name}.localhost"),
        }))
        .unwrap()
    }

    #[test]
    fn a_start_reserves_only_what_it_admitted_before_releasing_the_lock() {
        let web = service("web", 1);
        let api = service("api", 3);
        let peers = |now: Option<Service>, stopping| vec![(&api, now, stopping)];
        start_still_admitted(&web, &web, "/r", "/r", &peers(Some(api.clone()), false)).unwrap();
        // The service was edited while peers, ports and the lease were checked.
        let edited = service("web", 2);
        assert!(start_still_admitted(&web, &edited, "/r", "/r", &[]).is_err());
        // Another run reserved the service in the meantime.
        let mut reserved = web.clone();
        reserved.terminal_owner = Some(ade_core::model::TerminalOwner {
            terminal_id: "t".into(),
            transfer_id: "run".into(),
            runtime_instance: "runtime".into(),
        });
        let error = start_still_admitted(&web, &reserved, "/r", "/r", &[]).unwrap_err();
        assert!(error.to_string().contains("already reserved"));
        // The workspace moved to another root.
        assert!(start_still_admitted(&web, &web, "/r", "/other", &[]).is_err());
        // A peer began stopping, was edited or was removed.
        for (now, stopping) in [
            (Some(api.clone()), true),
            (Some(service("api", 4)), false),
            (None, false),
        ] {
            assert!(start_still_admitted(&web, &web, "/r", "/r", &peers(now, stopping)).is_err());
        }
    }
}
