//! `mcp.*` operations: the profile MCP catalog in the profile state database.
//!
//! The catalog stores definitions and credential references only. Validation,
//! scope resolution and provider projection are the pure functions in
//! [`ade_core::mcp`]; this module owns storage and revision guards.
use super::*;
use ade_core::contract::mcp::{
    McpResolution, McpResolveRequest, McpServerAddRequest, McpServerInspectRequest,
    McpServerInspection, McpServerListRequest, McpServerRemoveRequest, McpServerRemoved,
    McpServerReply, McpServerUpdateRequest, McpServers, ProviderSupport,
};
use ade_core::mcp::{self as catalog, Definition, Scope, Server, Target};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS mcp_servers(name TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), definition TEXT NOT NULL, updated_at INTEGER NOT NULL);";

/// Creates the catalog table if it is missing. The table is created on first
/// use rather than by a numbered migration.
fn ensure(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            elapsed.as_millis().min(i64::MAX as u128) as i64
        })
}

fn read_server(connection: &Connection, name: &str) -> Result<Option<Server>> {
    connection
        .query_row(
            "SELECT revision,definition FROM mcp_servers WHERE name=?1",
            [name],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .map(|(revision, definition)| stored(name, revision, &definition))
        .transpose()
}

fn read_all(connection: &Connection) -> Result<Vec<Server>> {
    let mut statement =
        connection.prepare("SELECT name,revision,definition FROM mcp_servers ORDER BY name")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.iter()
        .map(|(name, revision, definition)| stored(name, *revision, definition))
        .collect()
}

/// A stored row that no longer decodes fails the whole read: the catalog
/// never reports a partial list as complete.
fn stored(name: &str, revision: i64, definition: &str) -> Result<Server> {
    Ok(Server {
        name: name.to_owned(),
        revision: u64::try_from(revision).context("Stored MCP server revision is invalid")?,
        definition: serde_json::from_str(definition)
            .with_context(|| format!("Stored MCP server {name} is unreadable"))?,
    })
}

fn write_server(connection: &Connection, server: &Server) -> Result<()> {
    connection.execute(
        "INSERT INTO mcp_servers(name,revision,definition,updated_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,updated_at=excluded.updated_at",
        params![
            server.name,
            i64::try_from(server.revision)?,
            serde_json::to_string(&server.definition)?,
            now_ms()
        ],
    )?;
    Ok(())
}

fn provider_ids() -> Vec<&'static str> {
    provider::descriptors()
        .iter()
        .map(|descriptor| descriptor.id.as_str())
        .collect()
}

impl Sessions {
    pub(super) fn mcp_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let data = self.data.lock().unwrap();
        persistence_result(mcp_command(&data.store, request))
    }
}

/// The provider-native server map a new Agent launches with: the same
/// resolution `mcp.resolve` reports, for a provider whose adapter passes it.
/// `None` when the provider is not wired or no server applies, so a launch
/// without catalog entries is unchanged.
pub(super) fn launch_servers(
    store: &Store,
    workspace: &WorkspaceRecord,
    provider: &str,
) -> Result<Option<Value>> {
    if !catalog::WIRED_PROVIDERS.contains(&provider) {
        return Ok(None);
    }
    ensure(&store.connection)?;
    let servers = read_all(&store.connection)?;
    let repository = store.workspace_repository(&workspace.id)?;
    let resolution = catalog::resolve(
        &servers,
        &Target {
            workspace_id: &workspace.id,
            repository_id: repository.as_deref(),
            provider,
        },
    );
    if resolution.servers.is_empty() {
        return Ok(None);
    }
    Ok(resolution.document.and_then(|document| {
        document
            .as_object()
            .and_then(|object| object.values().next().cloned())
    }))
}

fn mcp_command(store: &Store, request: &Value) -> Result<Value> {
    let connection = &store.connection;
    match request["op"].as_str().unwrap_or("") {
        "mcp.server.list" => {
            let _: McpServerListRequest = decode(request)?;
            ensure(connection)?;
            reply(&McpServers {
                tag: Default::default(),
                servers: read_all(connection)?,
            })
        }
        "mcp.server.inspect" => {
            let inspect: McpServerInspectRequest = decode(request)?;
            ensure(connection)?;
            let server = read_server(connection, &inspect.name)?
                .with_context(|| format!("Unknown MCP server {}", inspect.name))?;
            let providers = catalog::PROJECTED_PROVIDERS
                .iter()
                .map(|provider| {
                    let projection = catalog::project(&server.definition.transport, provider);
                    ProviderSupport {
                        provider: (*provider).to_owned(),
                        unsupported_reason: projection.as_ref().err().cloned(),
                        native: projection.ok(),
                        wired: catalog::WIRED_PROVIDERS.contains(provider),
                    }
                })
                .collect();
            reply(&McpServerInspection {
                tag: Default::default(),
                server,
                providers,
                protocol_versions: protocol_versions(),
            })
        }
        "mcp.server.add" => {
            let add: McpServerAddRequest = decode(request)?;
            catalog::validate_name(&add.name)?;
            catalog::validate(&add.definition, &provider_ids())?;
            check_scope(store, &add.definition, None)?;
            let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
            ensure(&tx)?;
            let server = match read_server(&tx, &add.name)? {
                // A repeated add converges on the entry it created.
                Some(existing) if existing.definition == add.definition => existing,
                Some(existing) => bail!(
                    "MCP server {} already exists at revision {}; update it instead",
                    add.name,
                    existing.revision
                ),
                None => {
                    let server = Server {
                        name: add.name,
                        revision: 1,
                        definition: add.definition,
                    };
                    write_server(&tx, &server)?;
                    server
                }
            };
            tx.commit()?;
            reply(&McpServerReply {
                tag: Default::default(),
                server,
            })
        }
        "mcp.server.update" => {
            let update: McpServerUpdateRequest = decode(request)?;
            catalog::validate_name(&update.name)?;
            catalog::validate(&update.definition, &provider_ids())?;
            let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
            ensure(&tx)?;
            let current = read_server(&tx, &update.name)?
                .with_context(|| format!("Unknown MCP server {}", update.name))?;
            check_scope(store, &update.definition, Some(&current.definition))?;
            let server = match decide_update(
                current.revision,
                &current.definition,
                update.expected_revision,
                &update.definition,
            ) {
                Guard::Apply => {
                    let server = Server {
                        name: update.name,
                        revision: current.revision + 1,
                        definition: update.definition,
                    };
                    write_server(&tx, &server)?;
                    server
                }
                Guard::Converged => current,
                Guard::Stale => bail!(
                    "MCP server {} changed since revision {}; it is at revision {}",
                    update.name,
                    update.expected_revision,
                    current.revision
                ),
            };
            tx.commit()?;
            reply(&McpServerReply {
                tag: Default::default(),
                server,
            })
        }
        "mcp.server.remove" => {
            let remove: McpServerRemoveRequest = decode(request)?;
            let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
            ensure(&tx)?;
            let removed = match read_server(&tx, &remove.name)? {
                None => false,
                Some(current) if current.revision == remove.expected_revision => {
                    tx.execute("DELETE FROM mcp_servers WHERE name=?1", [&remove.name])?;
                    true
                }
                Some(current) => bail!(
                    "MCP server {} changed since revision {}; it is at revision {}",
                    remove.name,
                    remove.expected_revision,
                    current.revision
                ),
            };
            tx.commit()?;
            reply(&McpServerRemoved {
                tag: Default::default(),
                name: remove.name,
                removed,
            })
        }
        "mcp.resolve" => {
            let resolve: McpResolveRequest = decode(request)?;
            let workspace_id = non_empty("workspace_id", &resolve.workspace_id)?;
            let provider = non_empty("provider", &resolve.provider)?;
            ensure!(
                provider_ids().contains(&provider),
                ade_core::error::ProviderNotFound(provider.to_owned())
            );
            let workspace = store.workspace(workspace_id)?;
            ensure(connection)?;
            let servers = read_all(connection)?;
            let repository = store.workspace_repository(workspace_id)?;
            let resolution = catalog::resolve(
                &servers,
                &Target {
                    workspace_id,
                    repository_id: repository.as_deref(),
                    provider,
                },
            );
            reply(&McpResolution {
                tag: Default::default(),
                workspace_id: workspace.id,
                provider: provider.to_owned(),
                delivery: "direct".into(),
                wired: catalog::WIRED_PROVIDERS.contains(&provider),
                servers: resolution.servers,
                excluded: resolution.excluded,
                document: resolution.document,
                format: resolution.format,
                protocol_versions: protocol_versions(),
            })
        }
        _ => bail!("Unknown session operation"),
    }
}

fn protocol_versions() -> Vec<String> {
    catalog::PROTOCOL_VERSIONS
        .iter()
        .map(|version| (*version).to_owned())
        .collect()
}

/// Refuses a scope that names a workspace or repository this profile does not
/// have. IDs the stored entry already names are kept, so an entry whose
/// workspace was later removed can still be edited or disabled.
fn check_scope(
    store: &Store,
    definition: &Definition,
    previous: Option<&Definition>,
) -> Result<()> {
    let known = |scope: Option<&Scope>, id: &str| match scope {
        Some(Scope::Workspaces { workspace_ids }) => workspace_ids.iter().any(|known| known == id),
        Some(Scope::Repositories { repository_ids }) => {
            repository_ids.iter().any(|known| known == id)
        }
        _ => false,
    };
    let previous = previous.map(|definition| &definition.scope);
    match &definition.scope {
        Scope::Profile => {}
        Scope::Workspaces { workspace_ids } => {
            for id in workspace_ids {
                let same_kind = matches!(previous, Some(Scope::Workspaces { .. }));
                if !(same_kind && known(previous, id)) {
                    store.workspace(id)?;
                }
            }
        }
        Scope::Repositories { repository_ids } => {
            for id in repository_ids {
                let same_kind = matches!(previous, Some(Scope::Repositories { .. }));
                if !(same_kind && known(previous, id)) {
                    store.repository(id)?;
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum Guard {
    Apply,
    /// The caller's update already applied; return the stored entry.
    Converged,
    Stale,
}

/// The revision guard for `mcp.server.update`.
fn decide_update(
    current_revision: u64,
    current: &Definition,
    expected_revision: u64,
    requested: &Definition,
) -> Guard {
    if current_revision == expected_revision {
        Guard::Apply
    } else if current_revision == expected_revision + 1 && current == requested {
        Guard::Converged
    } else {
        Guard::Stale
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ade_core::mcp::{Installation, ProviderSelection, Transport};

    fn definition(enabled: bool) -> Definition {
        Definition {
            enabled,
            installation: Installation::Manual,
            transport: Transport::Stdio {
                command: "srv".into(),
                args: vec![],
                env: Default::default(),
                cwd: None,
            },
            scope: Scope::Profile,
            providers: ProviderSelection::All,
        }
    }

    #[test]
    fn update_guard_applies_converges_or_refuses() {
        let on = definition(true);
        let off = definition(false);
        assert_eq!(decide_update(3, &on, 3, &off), Guard::Apply);
        // A lost reply: the stored entry is one ahead and matches the request.
        assert_eq!(decide_update(4, &off, 3, &off), Guard::Converged);
        // Someone else's change in between is never overwritten.
        assert_eq!(decide_update(4, &on, 3, &off), Guard::Stale);
        assert_eq!(decide_update(6, &off, 3, &off), Guard::Stale);
        assert_eq!(decide_update(2, &off, 3, &off), Guard::Stale);
    }
}
