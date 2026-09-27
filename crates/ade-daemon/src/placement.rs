//! Pure placement decisions for execution hosts (F126, F127, F129).
//!
//! `sessions::placement` gathers the evidence (the remote registry, the last
//! `remote.host.start` receipt, the resources this daemon holds and the
//! recorded placements) and these functions decide. Three rules hold
//! throughout:
//!
//! - A host is named explicitly. Nothing here substitutes the local host for
//!   an unavailable remote host.
//! - A resource never changes host. A resource this daemon holds is local and
//!   cannot be recorded as remote; a recorded resource cannot be re-recorded
//!   on another host.
//! - Work inside a workspace runs on that workspace's host.
use ade_core::contract::placement::{
    DeviceAccess, ExecutionHost, ExecutionHostEntry, HostCapabilities, HostReadiness,
    PlacedResource, Placement, PlacementDecision, PlacementSource, PreviewTransport, ResourceKind,
};
use ade_core::contract::remote::{PairingState, RemoteHostStart, StartOutcome};
use anyhow::{Result, bail, ensure};

const ALL_KINDS: [ResourceKind; 4] = [
    ResourceKind::Workspace,
    ResourceKind::Conversation,
    ResourceKind::Terminal,
    ResourceKind::Service,
];

/// What a remote host can run and expose. Previews travel over the SSH
/// transport; device control is not offered remotely, and is never
/// redirected to a device on this machine.
pub fn capabilities(host: &ExecutionHost) -> HostCapabilities {
    match host {
        ExecutionHost::Local {} => HostCapabilities {
            resources: ALL_KINDS.to_vec(),
            previews: PreviewTransport::Direct,
            devices: DeviceAccess::LocalHost,
        },
        ExecutionHost::Remote { .. } => HostCapabilities {
            resources: ALL_KINDS.to_vec(),
            previews: PreviewTransport::SshForward,
            devices: DeviceAccess::Unsupported,
        },
    }
}

pub fn local_entry() -> ExecutionHostEntry {
    ExecutionHostEntry {
        host: ExecutionHost::Local {},
        label: "This Mac".into(),
        readiness: HostReadiness::Ready,
        reason: None,
        capabilities: capabilities(&ExecutionHost::Local {}),
        remote_socket: None,
        remote_profile_id: None,
    }
}

/// The last `remote.host.start` result recorded for a host.
#[derive(Clone, Debug)]
pub struct StartEvidence {
    pub reply: RemoteHostStart,
    pub settled_at_ms: i64,
}

/// What the profile's registry and receipts say about one remote host.
#[derive(Clone, Debug)]
pub struct RemoteEvidence {
    pub host_id: String,
    pub label: String,
    pub registered_at_ms: i64,
    pub pairing: Option<PairingState>,
    pub last_start: Option<StartEvidence>,
}

/// Readiness from the daemon's own evidence. `Started` is the most a
/// daemon can say about a remote host: the live link belongs to the client's
/// remote transport, which must still be connected when work is sent.
pub fn remote_entry(evidence: &RemoteEvidence) -> ExecutionHostEntry {
    let host = ExecutionHost::Remote {
        host_id: evidence.host_id.clone(),
    };
    let unavailable = |reason: String| (HostReadiness::Unavailable, Some(reason), None);
    // Start evidence from before the host was (re)registered is about a host
    // definition that no longer exists.
    let start = evidence
        .last_start
        .as_ref()
        .filter(|start| start.settled_at_ms >= evidence.registered_at_ms);
    let (readiness, reason, daemon) = match (evidence.pairing, start) {
        (None, _) => unavailable(format!("{} is not paired", evidence.host_id)),
        (Some(PairingState::Revoked), _) => {
            unavailable(format!("The pairing with {} was revoked", evidence.host_id))
        }
        (Some(PairingState::Active), None) => unavailable(format!(
            "{} has not been started since it was registered; run remote.host.start",
            evidence.host_id
        )),
        (Some(PairingState::Active), Some(start)) => match start.reply.outcome {
            StartOutcome::Running => match &start.reply.daemon {
                Some(daemon) => (
                    HostReadiness::Started,
                    Some(format!(
                        "Send work through the remote transport; it must be connected to {}",
                        evidence.host_id
                    )),
                    Some(daemon.clone()),
                ),
                None => (
                    HostReadiness::Unknown,
                    Some("The last start reported running without a daemon identity".into()),
                    None,
                ),
            },
            StartOutcome::Failed => unavailable(format!(
                "The last start failed: {}",
                start.reply.detail.as_deref().unwrap_or("no detail")
            )),
            StartOutcome::Unknown => (
                HostReadiness::Unknown,
                Some(format!(
                    "The last start's outcome is unknown; probe {} before placing work",
                    evidence.host_id
                )),
                None,
            ),
        },
    };
    ExecutionHostEntry {
        capabilities: capabilities(&host),
        host,
        label: evidence.label.clone(),
        readiness,
        reason,
        remote_socket: daemon.as_ref().map(|daemon| daemon.socket.clone()),
        remote_profile_id: daemon.map(|daemon| daemon.profile_id),
    }
}

/// Where the placement's workspace runs, when the work is inside one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceHost {
    /// The work is a workspace itself.
    NotApplicable,
    Known(ExecutionHost),
    /// Neither held here nor recorded.
    Unknown(String),
}

/// Whether new work of `kind` may be placed on `host`. `entry` is the host's
/// entry from [`local_entry`] or [`remote_entry`], or `None` when the host is
/// not registered.
pub fn check(
    host: &ExecutionHost,
    kind: ResourceKind,
    entry: Option<&ExecutionHostEntry>,
    workspace: &WorkspaceHost,
) -> PlacementDecision {
    let remote = matches!(host, ExecutionHost::Remote { .. });
    let decision = |admitted: bool, reason: Option<String>| PlacementDecision {
        tag: Default::default(),
        host: host.clone(),
        resource: kind,
        admitted,
        reason,
        requires_remote_transport: remote,
    };
    let refuse = |reason: String| decision(false, Some(format!("{reason}. Nothing was placed.")));
    let Some(entry) = entry.filter(|entry| &entry.host == host) else {
        return refuse(format!("{} is not a registered execution host", name(host)));
    };
    if !entry.capabilities.resources.contains(&kind) {
        return refuse(format!("{} cannot run a {}", name(host), kind_name(kind)));
    }
    match (kind, workspace) {
        (ResourceKind::Workspace, WorkspaceHost::NotApplicable) => {}
        (ResourceKind::Workspace, _) => {
            return refuse("A workspace placement does not name a workspace".into());
        }
        (_, WorkspaceHost::NotApplicable) => {
            return refuse(format!(
                "A {} placement must name its workspace",
                kind_name(kind)
            ));
        }
        (_, WorkspaceHost::Unknown(workspace_id)) => {
            return refuse(format!(
                "Workspace {workspace_id} is neither held here nor recorded on a remote host"
            ));
        }
        (_, WorkspaceHost::Known(workspace_host)) if workspace_host != host => {
            return refuse(format!(
                "The workspace runs on {}; work inside it runs there too",
                name(workspace_host)
            ));
        }
        (_, WorkspaceHost::Known(_)) => {}
    }
    match entry.readiness {
        HostReadiness::Ready => decision(true, None),
        HostReadiness::Started => decision(true, entry.reason.clone()),
        HostReadiness::Unavailable | HostReadiness::Unknown => refuse(
            entry
                .reason
                .clone()
                .unwrap_or_else(|| format!("{} is not available", name(host))),
        ),
    }
}

/// What a `placement.record` should do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordAction {
    /// Write a new record.
    Insert,
    /// The same record exists; return it unchanged.
    Existing,
    /// The resource is held here, so it is local; nothing is written.
    Local,
}

/// Facts about the resource a record names.
#[derive(Clone, Debug, Default)]
pub struct RecordEvidence {
    /// The workspace that holds the resource locally, when this daemon holds it.
    pub held_by: Option<String>,
    /// The host already recorded for the resource.
    pub recorded: Option<ExecutionHost>,
    /// For work inside a workspace: the workspace's recorded remote host.
    pub workspace_recorded: Option<ExecutionHost>,
    /// Whether the workspace is held here.
    pub workspace_held: bool,
    /// The target remote host's registry and pairing state, when registered.
    pub target_pairing: Option<Option<PairingState>>,
}

/// Decides a `placement.record`. It refuses anything that would move a
/// resource between hosts or attach it to a host this profile cannot use.
pub fn decide_record(
    resource: &PlacedResource,
    host: &ExecutionHost,
    evidence: &RecordEvidence,
) -> Result<RecordAction> {
    validate_resource(resource)?;
    let label = describe(resource);
    if let Some(holder) = &evidence.held_by {
        ensure!(
            holder == resource.workspace_id(),
            "{label} belongs to workspace {holder} here, not {}",
            resource.workspace_id()
        );
    }
    if let Some(recorded) = &evidence.recorded {
        ensure!(
            evidence.held_by.is_none(),
            "{label} is held here and also recorded on {}; resolve the conflict before placing it",
            name(recorded)
        );
        ensure!(
            recorded == host,
            "{label} runs on {}; a resource never moves to {}",
            name(recorded),
            name(host)
        );
        return Ok(RecordAction::Existing);
    }
    let ExecutionHost::Remote { host_id } = host else {
        ensure!(
            evidence.held_by.is_some(),
            "{label} is not held here; a local resource is created by its own operation, not recorded"
        );
        return Ok(RecordAction::Local);
    };
    validate_host_id(host_id)?;
    ensure!(
        evidence.held_by.is_none(),
        "{label} is held on this Mac; it is never relocated to {host_id}"
    );
    match evidence.target_pairing {
        None => bail!("{host_id} is not a registered remote host"),
        Some(Some(PairingState::Active)) => {}
        Some(Some(PairingState::Revoked)) => {
            bail!("The pairing with {host_id} was revoked; nothing new is recorded on it")
        }
        Some(None) => bail!("{host_id} is not paired; nothing is recorded on it"),
    }
    if resource.kind() != ResourceKind::Workspace {
        ensure!(
            !evidence.workspace_held,
            "Workspace {} is held on this Mac; work inside it cannot run on {host_id}",
            resource.workspace_id()
        );
        match &evidence.workspace_recorded {
            Some(workspace_host) if workspace_host == host => {}
            Some(other) => bail!(
                "Workspace {} runs on {}; work inside it cannot run on {host_id}",
                resource.workspace_id(),
                name(other)
            ),
            None => bail!(
                "Record workspace {} on {host_id} before the work inside it",
                resource.workspace_id()
            ),
        }
    }
    Ok(RecordAction::Insert)
}

/// The host of one resource. A resource held here is local; a recorded one
/// runs on its recorded host. Anything else is refused, never assumed local.
pub fn resolve(
    resource: &PlacedResource,
    held_by: Option<&str>,
    recorded: Option<(ExecutionHost, i64)>,
) -> Result<Placement> {
    validate_resource(resource)?;
    let label = describe(resource);
    if let Some(holder) = held_by {
        ensure!(
            holder == resource.workspace_id(),
            "{label} belongs to workspace {holder} here, not {}",
            resource.workspace_id()
        );
    }
    match (held_by, recorded) {
        (Some(_), Some((host, _))) => bail!(
            "{label} is held here and also recorded on {}; its host is ambiguous",
            name(&host)
        ),
        (Some(_), None) => Ok(Placement {
            resource: resource.clone(),
            host: ExecutionHost::Local {},
            source: PlacementSource::LocalState,
            recorded_at_ms: None,
        }),
        (None, Some((host, at))) => Ok(Placement {
            resource: resource.clone(),
            host,
            source: PlacementSource::Recorded,
            recorded_at_ms: Some(at),
        }),
        (None, None) => bail!("{label} is neither held here nor recorded on a remote host"),
    }
}

/// The stored form of a host: `local` is never stored, so a stored value is
/// always a remote host ID.
pub fn stored_host(host_id: String) -> Result<ExecutionHost> {
    validate_host_id(&host_id)?;
    Ok(ExecutionHost::Remote { host_id })
}

fn validate_host_id(host_id: &str) -> Result<()> {
    crate::remote::validate_host_id(host_id)
}

fn validate_resource(resource: &PlacedResource) -> Result<()> {
    for (field, value) in [
        ("workspace_id", resource.workspace_id()),
        ("resource key", resource.key()),
    ] {
        ensure!(
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
            "Invalid {field}"
        );
    }
    Ok(())
}

/// The host as `ADE_EXECUTION_HOST` gives it to services and scripts:
/// `local`, or the remote host's registry ID (which is never `local`).
pub fn env_value(host: &ExecutionHost) -> String {
    match host {
        ExecutionHost::Local {} => "local".into(),
        ExecutionHost::Remote { host_id } => host_id.clone(),
    }
}

pub fn name(host: &ExecutionHost) -> String {
    match host {
        ExecutionHost::Local {} => "this Mac".into(),
        ExecutionHost::Remote { host_id } => format!("remote host {host_id}"),
    }
}

fn kind_name(kind: ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Workspace => "workspace",
        ResourceKind::Conversation => "conversation",
        ResourceKind::Terminal => "terminal",
        ResourceKind::Service => "service",
    }
}

fn describe(resource: &PlacedResource) -> String {
    match resource {
        PlacedResource::Workspace { workspace_id } => format!("Workspace {workspace_id}"),
        PlacedResource::Service { name, .. } => format!("Service {name}"),
        other => format!("{} {}", capitalized(kind_name(other.kind())), other.key()),
    }
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::contract::remote::RemoteDaemon;

    fn remote(id: &str) -> ExecutionHost {
        ExecutionHost::Remote { host_id: id.into() }
    }

    fn start(outcome: StartOutcome, at: i64) -> StartEvidence {
        StartEvidence {
            reply: RemoteHostStart {
                tag: Default::default(),
                operation_id: "op".into(),
                host_id: "devbox".into(),
                outcome,
                detail: Some("ssh exited".into()),
                daemon: (outcome == StartOutcome::Running).then(|| RemoteDaemon {
                    profile_id: "p1".into(),
                    socket: "/home/me/.ade/p1/daemon.sock".into(),
                    boot_id: "b".into(),
                    pid: 7,
                    build_id: None,
                    application_protocol: "a".into(),
                    runtime_protocol: "r".into(),
                }),
            },
            settled_at_ms: at,
        }
    }

    fn evidence(pairing: Option<PairingState>, last: Option<StartEvidence>) -> RemoteEvidence {
        RemoteEvidence {
            host_id: "devbox".into(),
            label: "Devbox".into(),
            registered_at_ms: 100,
            pairing,
            last_start: last,
        }
    }

    #[test]
    fn remote_readiness_needs_pairing_and_a_current_running_start() {
        let active = Some(PairingState::Active);
        let cases = [
            (evidence(None, None), HostReadiness::Unavailable),
            (
                evidence(
                    Some(PairingState::Revoked),
                    Some(start(StartOutcome::Running, 200)),
                ),
                HostReadiness::Unavailable,
            ),
            (evidence(active, None), HostReadiness::Unavailable),
            // A start from before the host was re-registered is ignored.
            (
                evidence(active, Some(start(StartOutcome::Running, 50))),
                HostReadiness::Unavailable,
            ),
            (
                evidence(active, Some(start(StartOutcome::Failed, 200))),
                HostReadiness::Unavailable,
            ),
            (
                evidence(active, Some(start(StartOutcome::Unknown, 200))),
                HostReadiness::Unknown,
            ),
            (
                evidence(active, Some(start(StartOutcome::Running, 200))),
                HostReadiness::Started,
            ),
        ];
        for (evidence, expected) in cases {
            let entry = remote_entry(&evidence);
            assert_eq!(entry.readiness, expected, "{evidence:?}");
            assert!(entry.reason.is_some());
            assert_eq!(entry.capabilities.devices, DeviceAccess::Unsupported);
            assert_eq!(entry.capabilities.previews, PreviewTransport::SshForward);
            assert_eq!(
                entry.remote_socket.is_some(),
                expected == HostReadiness::Started
            );
        }
        let mut running = start(StartOutcome::Running, 200);
        running.reply.daemon = None;
        assert_eq!(
            remote_entry(&evidence(active, Some(running))).readiness,
            HostReadiness::Unknown
        );
    }

    #[test]
    fn placement_on_an_unavailable_host_is_refused_and_never_falls_back() {
        let unavailable = remote_entry(&evidence(Some(PairingState::Revoked), None));
        let decision = check(
            &remote("devbox"),
            ResourceKind::Workspace,
            Some(&unavailable),
            &WorkspaceHost::NotApplicable,
        );
        assert!(!decision.admitted);
        assert_eq!(decision.host, remote("devbox"));
        assert!(decision.requires_remote_transport);
        assert!(decision.reason.unwrap().contains("revoked"));

        let unknown = remote_entry(&evidence(
            Some(PairingState::Active),
            Some(start(StartOutcome::Unknown, 200)),
        ));
        assert!(
            !check(
                &remote("devbox"),
                ResourceKind::Workspace,
                Some(&unknown),
                &WorkspaceHost::NotApplicable
            )
            .admitted
        );

        // An unregistered host, or an entry for another host, is refused.
        for entry in [None, Some(&local_entry())] {
            let decision = check(
                &remote("devbox"),
                ResourceKind::Workspace,
                entry,
                &WorkspaceHost::NotApplicable,
            );
            assert!(!decision.admitted);
            assert_eq!(decision.host, remote("devbox"));
        }
    }

    #[test]
    fn placement_on_a_ready_host_is_admitted() {
        let local = check(
            &ExecutionHost::Local {},
            ResourceKind::Workspace,
            Some(&local_entry()),
            &WorkspaceHost::NotApplicable,
        );
        assert!(local.admitted && !local.requires_remote_transport);
        let started = remote_entry(&evidence(
            Some(PairingState::Active),
            Some(start(StartOutcome::Running, 200)),
        ));
        let decision = check(
            &remote("devbox"),
            ResourceKind::Terminal,
            Some(&started),
            &WorkspaceHost::Known(remote("devbox")),
        );
        assert!(decision.admitted && decision.requires_remote_transport);
        assert!(decision.reason.unwrap().contains("remote transport"));
    }

    #[test]
    fn work_inside_a_workspace_runs_on_the_workspace_host() {
        let started = remote_entry(&evidence(
            Some(PairingState::Active),
            Some(start(StartOutcome::Running, 200)),
        ));
        let refused = [
            (
                remote("devbox"),
                Some(&started),
                WorkspaceHost::Known(ExecutionHost::Local {}),
            ),
            (
                ExecutionHost::Local {},
                Some(&local_entry()),
                WorkspaceHost::Known(remote("devbox")),
            ),
            (
                remote("devbox"),
                Some(&started),
                WorkspaceHost::Known(remote("other")),
            ),
            (
                remote("devbox"),
                Some(&started),
                WorkspaceHost::Unknown("w9".into()),
            ),
            (
                remote("devbox"),
                Some(&started),
                WorkspaceHost::NotApplicable,
            ),
        ];
        for (host, entry, workspace) in refused {
            let decision = check(&host, ResourceKind::Service, entry, &workspace);
            assert!(!decision.admitted, "{workspace:?}");
            assert_eq!(decision.host, host);
        }
        assert!(
            !check(
                &ExecutionHost::Local {},
                ResourceKind::Workspace,
                Some(&local_entry()),
                &WorkspaceHost::Known(ExecutionHost::Local {})
            )
            .admitted
        );
    }

    fn workspace(id: &str) -> PlacedResource {
        PlacedResource::Workspace {
            workspace_id: id.into(),
        }
    }

    fn terminal(workspace: &str) -> PlacedResource {
        PlacedResource::Terminal {
            workspace_id: workspace.into(),
            terminal_id: "t1".into(),
        }
    }

    fn paired() -> RecordEvidence {
        RecordEvidence {
            target_pairing: Some(Some(PairingState::Active)),
            ..Default::default()
        }
    }

    #[test]
    fn recording_never_relocates_a_resource() {
        let host = remote("devbox");
        assert_eq!(
            decide_record(&workspace("w1"), &host, &paired()).unwrap(),
            RecordAction::Insert
        );
        let recorded = RecordEvidence {
            recorded: Some(host.clone()),
            ..paired()
        };
        assert_eq!(
            decide_record(&workspace("w1"), &host, &recorded).unwrap(),
            RecordAction::Existing
        );
        // Another host, or back to local, is refused.
        assert!(decide_record(&workspace("w1"), &remote("other"), &recorded).is_err());
        assert!(decide_record(&workspace("w1"), &ExecutionHost::Local {}, &recorded).is_err());
        // A resource held here is local and cannot be recorded remotely.
        let held = RecordEvidence {
            held_by: Some("w1".into()),
            ..paired()
        };
        assert!(decide_record(&workspace("w1"), &host, &held).is_err());
        assert_eq!(
            decide_record(&workspace("w1"), &ExecutionHost::Local {}, &held).unwrap(),
            RecordAction::Local
        );
        // Local is never recorded for something this daemon does not hold.
        assert!(decide_record(&workspace("w1"), &ExecutionHost::Local {}, &paired()).is_err());
        // Held here and recorded elsewhere is a conflict, not a choice.
        let both = RecordEvidence {
            held_by: Some("w1".into()),
            recorded: Some(host.clone()),
            ..paired()
        };
        assert!(decide_record(&workspace("w1"), &host, &both).is_err());
    }

    #[test]
    fn recording_needs_a_usable_host_and_a_matching_workspace() {
        let host = remote("devbox");
        for pairing in [None, Some(None), Some(Some(PairingState::Revoked))] {
            let evidence = RecordEvidence {
                target_pairing: pairing,
                ..Default::default()
            };
            assert!(decide_record(&workspace("w1"), &host, &evidence).is_err());
        }
        // "local" can never be a remote host ID.
        assert!(decide_record(&workspace("w1"), &remote("local"), &paired()).is_err());
        assert!(decide_record(&workspace("w1"), &remote("Bad Id"), &paired()).is_err());
        // Work inside a workspace needs that workspace recorded on the same host.
        assert!(decide_record(&terminal("w1"), &host, &paired()).is_err());
        let elsewhere = RecordEvidence {
            workspace_recorded: Some(remote("other")),
            ..paired()
        };
        assert!(decide_record(&terminal("w1"), &host, &elsewhere).is_err());
        let local_workspace = RecordEvidence {
            workspace_held: true,
            ..paired()
        };
        assert!(decide_record(&terminal("w1"), &host, &local_workspace).is_err());
        let same = RecordEvidence {
            workspace_recorded: Some(host.clone()),
            ..paired()
        };
        assert_eq!(
            decide_record(&terminal("w1"), &host, &same).unwrap(),
            RecordAction::Insert
        );
        // A local resource named under the wrong workspace is refused.
        let wrong = RecordEvidence {
            held_by: Some("w2".into()),
            ..paired()
        };
        assert!(decide_record(&terminal("w1"), &ExecutionHost::Local {}, &wrong).is_err());
        assert!(decide_record(&workspace(""), &host, &paired()).is_err());
    }

    #[test]
    fn resolving_defaults_to_local_only_for_resources_held_here() {
        let local = resolve(&workspace("w1"), Some("w1"), None).unwrap();
        assert_eq!(local.host, ExecutionHost::Local {});
        assert_eq!(local.source, PlacementSource::LocalState);
        let recorded = resolve(&workspace("w1"), None, Some((remote("devbox"), 5))).unwrap();
        assert_eq!(recorded.host, remote("devbox"));
        assert_eq!(recorded.recorded_at_ms, Some(5));
        assert!(resolve(&workspace("w1"), None, None).is_err());
        assert!(resolve(&workspace("w1"), Some("w1"), Some((remote("devbox"), 5))).is_err());
        assert!(resolve(&terminal("w1"), Some("w2"), None).is_err());
    }

    #[test]
    fn stored_hosts_are_always_remote() {
        assert_eq!(stored_host("devbox".into()).unwrap(), remote("devbox"));
        assert!(stored_host("local".into()).is_err());
        assert!(stored_host(String::new()).is_err());
    }
}
