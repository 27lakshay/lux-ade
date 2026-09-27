//! `placement.*` operations: execution host identity and explicit placement
//! (F126, F127, F129).
//!
//! The profile state database holds one record per resource created on a
//! remote host. A resource this daemon holds in its own tables is local and is
//! never recorded. Decisions are the pure functions in [`crate::placement`];
//! this module gathers their evidence and owns the `execution_placements`
//! table, which it creates on first use.
use super::*;
use crate::placement::{self as decide, RecordAction, RecordEvidence, WorkspaceHost};
use ade_core::contract::placement::{
    ExecutionHost, ExecutionHostEntry, ExecutionHosts, PlacedResource, Placement,
    PlacementCheckRequest, PlacementHostsRequest, PlacementListRequest, PlacementReleaseRequest,
    PlacementReleased, PlacementReply, PlacementResolveRequest, PlacementSource, Placements,
    ResourceKind,
};
use ade_core::contract::remote::{PairingState, RemoteHostStart};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS execution_placements(kind TEXT NOT NULL CHECK(kind IN ('workspace','conversation','terminal','service')), identity TEXT NOT NULL, workspace_id TEXT NOT NULL, resource_key TEXT NOT NULL, host_id TEXT NOT NULL CHECK(host_id <> 'local'), recorded_at INTEGER NOT NULL, PRIMARY KEY(kind, identity));
CREATE INDEX IF NOT EXISTS execution_placements_host ON execution_placements(host_id);";

/// Separates a service's workspace and name in its stored identity.
const SEPARATOR: char = '\u{1f}';

fn ensure_schema(connection: &Connection) -> Result<()> {
    super::remote::ensure_schema(connection)?;
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

/// How many placements are recorded on `host_id`.
pub(super) fn placements_on_host(connection: &Connection, host_id: &str) -> Result<u64> {
    ensure_schema(connection)?;
    Ok(connection.query_row(
        "SELECT count(*) FROM execution_placements WHERE host_id=?1",
        [host_id],
        |row| row.get::<_, i64>(0),
    )? as u64)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            elapsed.as_millis().min(i64::MAX as u128) as i64
        })
}

fn kind_text(kind: ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Workspace => "workspace",
        ResourceKind::Conversation => "conversation",
        ResourceKind::Terminal => "terminal",
        ResourceKind::Service => "service",
    }
}

/// The stored key. Conversation and terminal IDs are unique on their own; a
/// service name is unique within its workspace.
fn identity(resource: &PlacedResource) -> String {
    match resource {
        PlacedResource::Service { workspace_id, name } => {
            format!("{workspace_id}{SEPARATOR}{name}")
        }
        other => other.key().to_owned(),
    }
}

/// The recorded host, workspace and time for one resource.
fn recorded(
    connection: &Connection,
    resource: &PlacedResource,
) -> Result<Option<(ExecutionHost, i64)>> {
    let row = connection
        .query_row(
            "SELECT host_id,workspace_id,recorded_at FROM execution_placements WHERE kind=?1 AND identity=?2",
            params![kind_text(resource.kind()), identity(resource)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((host_id, workspace_id, at)) = row else {
        return Ok(None);
    };
    ensure!(
        workspace_id == resource.workspace_id(),
        "{} is recorded under workspace {workspace_id}, not {}",
        resource.key(),
        resource.workspace_id()
    );
    Ok(Some((decide::stored_host(host_id)?, at)))
}

/// The local workspace that holds the resource, when this daemon holds it.
fn held_by(connection: &Connection, resource: &PlacedResource) -> Result<Option<String>> {
    let holder = match resource {
        PlacedResource::Workspace { workspace_id } => connection
            .query_row(
                "SELECT id FROM workspaces WHERE id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .optional()?,
        PlacedResource::Conversation {
            conversation_id, ..
        } => connection
            .query_row(
                "SELECT workspace_id FROM conversations WHERE id=?1",
                [conversation_id],
                |row| row.get(0),
            )
            .optional()?,
        PlacedResource::Terminal { terminal_id, .. } => connection
            .query_row(
                // A workspace's primary terminal, or one of its extra terminals.
                "SELECT id FROM workspaces WHERE json_extract(data,'$.terminal_id')=?1 UNION ALL SELECT workspaces.id FROM workspaces, json_each(workspaces.data,'$.extra_terminals') AS terminal WHERE terminal.value=?1 LIMIT 1",
                [terminal_id],
                |row| row.get(0),
            )
            .optional()?,
        PlacedResource::Service { workspace_id, name } => connection
            .query_row(
                "SELECT workspace_id FROM services WHERE workspace_id=?1 AND name=?2",
                params![workspace_id, name],
                |row| row.get(0),
            )
            .optional()?,
    };
    Ok(holder)
}

fn workspace_of(resource: &PlacedResource) -> PlacedResource {
    PlacedResource::Workspace {
        workspace_id: resource.workspace_id().to_owned(),
    }
}

/// Pairing state for a registered remote host; `None` when it is not registered.
fn registered_pairing(
    connection: &Connection,
    host_id: &str,
) -> Result<Option<Option<PairingState>>> {
    let registered: Option<i64> = connection
        .query_row(
            "SELECT created_at FROM remote_hosts WHERE host_id=?1",
            [host_id],
            |row| row.get(0),
        )
        .optional()?;
    if registered.is_none() {
        return Ok(None);
    }
    let state: Option<String> = connection
        .query_row(
            "SELECT state FROM remote_pairings WHERE host_id=?1 ORDER BY state='active' DESC, paired_at DESC, rowid DESC LIMIT 1",
            [host_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(Some(match state.as_deref() {
        None => None,
        Some("active") => Some(PairingState::Active),
        Some("revoked") => Some(PairingState::Revoked),
        Some(other) => bail!("Stored pairing for {host_id} has unknown state {other}"),
    }))
}

/// The most recent settled `remote.host.start` result for a host.
fn last_start(connection: &Connection, host_id: &str) -> Result<Option<decide::StartEvidence>> {
    super::remote::last_start(connection, host_id)?
        .map(|(result, at)| {
            Ok(decide::StartEvidence {
                reply: serde_json::from_str::<RemoteHostStart>(&result)
                    .with_context(|| format!("Stored start result for {host_id} is unreadable"))?,
                settled_at_ms: at,
            })
        })
        .transpose()
}

fn remote_entries(connection: &Connection) -> Result<Vec<ExecutionHostEntry>> {
    let mut statement =
        connection.prepare("SELECT host_id,label,created_at FROM remote_hosts ORDER BY host_id")?;
    let hosts = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    hosts
        .into_iter()
        .map(|(host_id, label, registered_at_ms)| {
            let pairing = registered_pairing(connection, &host_id)?.flatten();
            let last_start = last_start(connection, &host_id)?;
            Ok(decide::remote_entry(&decide::RemoteEvidence {
                host_id,
                label,
                registered_at_ms,
                pairing,
                last_start,
            }))
        })
        .collect()
}

fn host_entry(connection: &Connection, host: &ExecutionHost) -> Result<Option<ExecutionHostEntry>> {
    Ok(match host {
        ExecutionHost::Local {} => Some(decide::local_entry()),
        ExecutionHost::Remote { .. } => remote_entries(connection)?
            .into_iter()
            .find(|entry| &entry.host == host),
    })
}

fn workspace_host(connection: &Connection, workspace_id: &str) -> Result<WorkspaceHost> {
    let workspace = PlacedResource::Workspace {
        workspace_id: workspace_id.to_owned(),
    };
    let held = held_by(connection, &workspace)?;
    Ok(match (held, recorded(connection, &workspace)?) {
        (Some(_), None) => WorkspaceHost::Known(ExecutionHost::Local {}),
        (None, Some((host, _))) => WorkspaceHost::Known(host),
        (None, None) => WorkspaceHost::Unknown(workspace_id.to_owned()),
        (Some(_), Some((host, _))) => bail!(
            "Workspace {workspace_id} is held here and also recorded on {}; its host is ambiguous",
            decide::name(&host)
        ),
    })
}

fn placement_reply(placement: Placement) -> Result<Value> {
    reply(&PlacementReply {
        tag: Default::default(),
        placement,
    })
}

fn record(connection: &Connection, resource: PlacedResource, host: ExecutionHost) -> Result<Value> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let current = recorded(&tx, &resource)?;
    let workspace = workspace_of(&resource);
    let evidence = RecordEvidence {
        held_by: held_by(&tx, &resource)?,
        recorded: current.as_ref().map(|(host, _)| host.clone()),
        workspace_recorded: recorded(&tx, &workspace)?.map(|(host, _)| host),
        workspace_held: held_by(&tx, &workspace)?.is_some(),
        target_pairing: match &host {
            ExecutionHost::Local {} => None,
            ExecutionHost::Remote { host_id } => registered_pairing(&tx, host_id)?,
        },
    };
    let placement = match decide::decide_record(&resource, &host, &evidence)? {
        RecordAction::Local => Placement {
            resource,
            host: ExecutionHost::Local {},
            source: PlacementSource::LocalState,
            recorded_at_ms: None,
        },
        RecordAction::Existing => Placement {
            resource,
            host,
            source: PlacementSource::Recorded,
            recorded_at_ms: current.map(|(_, at)| at),
        },
        RecordAction::Insert => {
            let ExecutionHost::Remote { host_id } = &host else {
                bail!("Only a remote host is recorded");
            };
            let at = now_ms();
            tx.execute(
                "INSERT INTO execution_placements(kind,identity,workspace_id,resource_key,host_id,recorded_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    kind_text(resource.kind()),
                    identity(&resource),
                    resource.workspace_id(),
                    resource.key(),
                    host_id,
                    at
                ],
            )?;
            tx.commit()?;
            Placement {
                resource,
                host,
                source: PlacementSource::Recorded,
                recorded_at_ms: Some(at),
            }
        }
    };
    placement_reply(placement)
}

fn list(connection: &Connection, host_id: Option<&str>) -> Result<Value> {
    let mut statement = connection.prepare(
        "SELECT kind,workspace_id,resource_key,host_id,recorded_at FROM execution_placements WHERE ?1 IS NULL OR host_id=?1 ORDER BY host_id,workspace_id,kind,resource_key",
    )?;
    let rows = statement
        .query_map([host_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let placements = rows
        .into_iter()
        .map(|(kind, workspace_id, key, host_id, at)| {
            let resource = match kind.as_str() {
                "workspace" => PlacedResource::Workspace { workspace_id },
                "conversation" => PlacedResource::Conversation {
                    workspace_id,
                    conversation_id: key,
                },
                "terminal" => PlacedResource::Terminal {
                    workspace_id,
                    terminal_id: key,
                },
                "service" => PlacedResource::Service {
                    workspace_id,
                    name: key,
                },
                other => bail!("Stored placement has unknown kind {other}"),
            };
            Ok(Placement {
                resource,
                host: decide::stored_host(host_id)?,
                source: PlacementSource::Recorded,
                recorded_at_ms: Some(at),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    reply(&Placements {
        tag: Default::default(),
        placements,
    })
}

impl Sessions {
    pub(super) fn placement_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "placement.hosts" => {
                let _: PlacementHostsRequest = decode(request)?;
                self.placement_store(|connection| {
                    let mut hosts = vec![decide::local_entry()];
                    hosts.extend(remote_entries(connection)?);
                    reply(&ExecutionHosts {
                        tag: Default::default(),
                        hosts,
                    })
                })
            }
            "placement.check" => {
                let check: PlacementCheckRequest = decode(request)?;
                self.placement_store(|connection| {
                    let entry = host_entry(connection, &check.host)?;
                    let workspace = match &check.workspace_id {
                        None => WorkspaceHost::NotApplicable,
                        Some(id) => workspace_host(connection, id)?,
                    };
                    reply(&decide::check(
                        &check.host,
                        check.resource,
                        entry.as_ref(),
                        &workspace,
                    ))
                })
            }
            "placement.record" => {
                let request: ade_core::contract::placement::PlacementRecordRequest =
                    decode(request)?;
                self.placement_store(|connection| {
                    record(connection, request.resource, request.host)
                })
            }
            "placement.resolve" => {
                let resolve: PlacementResolveRequest = decode(request)?;
                self.placement_store(|connection| {
                    let held = held_by(connection, &resolve.resource)?;
                    let stored = recorded(connection, &resolve.resource)?;
                    placement_reply(decide::resolve(&resolve.resource, held.as_deref(), stored)?)
                })
            }
            "placement.list" => {
                let request: PlacementListRequest = decode(request)?;
                self.placement_store(|connection| list(connection, request.host_id.as_deref()))
            }
            "placement.release" => {
                let release: PlacementReleaseRequest = decode(request)?;
                self.placement_store(|connection| {
                    if let PlacedResource::Workspace { workspace_id } = &release.resource {
                        let inside: i64 = connection.query_row(
                            "SELECT count(*) FROM execution_placements WHERE workspace_id=?1 AND kind<>'workspace'",
                            [workspace_id],
                            |row| row.get(0),
                        )?;
                        ensure!(
                            inside == 0,
                            "Release the {inside} recorded resources inside workspace {workspace_id} first"
                        );
                    }
                    let released = connection.execute(
                        "DELETE FROM execution_placements WHERE kind=?1 AND identity=?2 AND workspace_id=?3",
                        params![
                            kind_text(release.resource.kind()),
                            identity(&release.resource),
                            release.resource.workspace_id()
                        ],
                    )? > 0;
                    reply(&PlacementReleased {
                        tag: Default::default(),
                        resource: release.resource,
                        released,
                    })
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }

    /// The execution host of a workspace whose services and scripts this
    /// daemon runs. That is always the local host: a workspace recorded on a
    /// remote host is refused, never run or routed here instead. Call it
    /// without the data lock held.
    pub fn execution_host(&self, workspace_id: &str) -> Result<ExecutionHost> {
        self.placement_store(|connection| match workspace_host(connection, workspace_id)? {
            WorkspaceHost::Known(ExecutionHost::Local {}) => Ok(ExecutionHost::Local {}),
            WorkspaceHost::Known(host) => bail!(
                "Workspace {workspace_id} runs on {}; its services and scripts run there, not on this Mac",
                decide::name(&host)
            ),
            WorkspaceHost::NotApplicable | WorkspaceHost::Unknown(_) => bail!(
                "Workspace {workspace_id} is neither held here nor recorded on a remote host"
            ),
        })
    }

    /// Runs `work` against the profile database under the data lock.
    fn placement_store<T>(&self, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let data = self.data.lock().unwrap();
        let connection = &data.store.connection;
        persistence_result(ensure_schema(connection).and_then(|()| work(connection)))
    }
}
