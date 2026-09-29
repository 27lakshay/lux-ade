//! Durable workspace service definitions. Port assignments are leases in lux-ade's
//! catalogue, not promises that unrelated host processes cannot bind them.
use crate::{model::WorkspaceRecord, store::Store};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, net::TcpListener};
#[cfg(test)]
use std::{collections::HashSet, path::PathBuf};

pub use ade_core::services::{Config, Service};

fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}
fn load(db: &Connection, workspace: &str, name: &str) -> Result<Option<Service>> {
    let row: Option<String> = db
        .query_row(
            "SELECT data FROM services WHERE workspace_id=?1 AND name=?2",
            params![workspace, name],
            |r| r.get(0),
        )
        .optional()?;
    row.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
}
fn reaches_service(
    db: &Connection,
    workspace: &str,
    target: &str,
    desired: &str,
    seen: &mut Vec<String>,
) -> Result<bool> {
    if target == desired {
        return Ok(true);
    }
    if seen.iter().any(|name| name == target) {
        return Ok(false);
    }
    seen.push(target.to_owned());
    let Some(service) = load(db, workspace, target)? else {
        return Ok(false);
    };
    for peer in service.config.peers.values() {
        if reaches_service(db, workspace, &peer.service, desired, seen)? {
            return Ok(true);
        }
    }
    Ok(false)
}
// Probe both loopback families while choosing a new port. Release the sockets
// after the catalogue transaction: the service itself must bind at launch. Never
// silently change an existing assignment because an unrelated listener took it.
fn available(port: u16) -> Option<Vec<TcpListener>> {
    let ipv4 = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).ok()?;
    let ipv6 = TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port));
    match ipv6 {
        Ok(ipv6) => Some(vec![ipv4, ipv6]),
        Err(error) if error.kind() == std::io::ErrorKind::AddrNotAvailable => Some(vec![ipv4]),
        Err(_) => None,
    }
}
impl Store {
    pub fn all_services_for_health(&self) -> Result<Vec<Service>> {
        let mut statement = self
            .connection
            .prepare("SELECT data FROM services WHERE json_extract(data,'$.config.health') IS NOT NULL AND json_extract(data,'$.terminal_owner') IS NOT NULL ORDER BY workspace_id,name LIMIT 513")?;
        let services = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        ensure!(services.len() <= 512, "Too many services to monitor");
        Ok(services)
    }
    pub fn services(&self, workspace: &str) -> Result<Vec<Service>> {
        self.workspace(workspace)?;
        let mut statement = self
            .connection
            .prepare("SELECT data FROM services WHERE workspace_id=?1 ORDER BY name")?;
        statement
            .query_map([workspace], |r| r.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
    pub fn configure_service(
        &self,
        workspace: &str,
        name: &str,
        revision: i64,
        mut config: Config,
    ) -> Result<Service> {
        ensure!(
            name_valid(name),
            "Service name must be a lowercase DNS label, at most 40 characters"
        );
        config.validate()?;
        let workspace: WorkspaceRecord = self.workspace(workspace)?;
        config.directory(&workspace.root)?;
        let tx =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let before = load(&tx, &workspace.id, name)?;
        let stored = before.as_ref().map(|s| &s.config);
        let values = config.plan_secrets(stored)?;
        config.validate()?;
        // A value already in the item this secret names is kept there, so a
        // repeated save converges. Any other value goes into a new item: the
        // stored one stays intact until the new configuration commits.
        let mut writes = Vec::new();
        for (key, value) in values {
            match stored.and_then(|stored| stored.secret_refs.get(&key)) {
                Some(kept) if crate::credentials::owned_holds(kept, &value) => {
                    config.secret_refs.insert(key, kept.clone());
                }
                _ => writes.push((key, value)),
            }
        }
        if !writes.is_empty() {
            ensure!(
                before.as_ref().is_none_or(|s| s.terminal_owner.is_none()),
                "Stop the service before editing it"
            );
            ensure!(
                before.as_ref().map_or(0, |s| s.revision) == revision,
                "Service changed; reload before saving"
            );
        }
        let mut pending = crate::credentials::Pending::default();
        for (key, value) in writes {
            let scope = format!("service/{}/{name}/{key}", workspace.id);
            let reference = pending.store(&scope, &value)?;
            config.secret_refs.insert(key, reference);
        }
        for peer in config.peers.values() {
            ensure!(
                !reaches_service(&tx, &workspace.id, &peer.service, name, &mut Vec::new())?,
                "Service peer dependency cycle"
            );
        }
        if let Some(before) = &before
            && before.config == config
        {
            return Ok(before.clone());
        }
        ensure!(
            before.as_ref().is_none_or(|s| s.terminal_owner.is_none()),
            "Stop the service before editing it"
        );
        ensure!(
            before.as_ref().map_or(0, |s| s.revision) == revision,
            "Service changed; reload before saving"
        );
        if before.is_none() {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM services WHERE workspace_id=?1",
                [&workspace.id],
                |r| r.get(0),
            )?;
            ensure!(count < 16, "Workspace service limit reached");
        }
        if config.health.is_some() && before.as_ref().is_none_or(|s| s.config.health.is_none()) {
            let count: i64 = tx.query_row("SELECT count(*) FROM services WHERE json_extract(data,'$.config.health') IS NOT NULL", [], |row| row.get(0))?;
            ensure!(count < 512, "Profile health policy limit reached");
        }
        let digest = Sha256::digest(workspace.id.as_bytes());
        let suffix = digest[..6]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut service = Service {
            identity: before.as_ref().map_or_else(
                || crate::model::new_id("service"),
                |s| {
                    if s.identity.is_empty() {
                        crate::model::new_id("service")
                    } else {
                        s.identity.clone()
                    }
                },
            ),
            terminal_id: before.as_ref().and_then(|s| s.terminal_id.clone()),
            terminal_owner: None,
            last_run_transfer_id: before.as_ref().and_then(|s| s.last_run_transfer_id.clone()),
            workspace_id: workspace.id,
            name: name.into(),
            revision: revision
                .checked_add(1)
                .context("Service revision overflow")?,
            config,
            ports: BTreeMap::new(),
            hostname: format!("{name}-{suffix}.localhost"),
            launch_peers: BTreeMap::new(),
        };
        // Insert the parent first for the FK. Nothing is visible until all leases
        // and the final record commit together.
        tx.execute("INSERT INTO services(workspace_id,name,data) VALUES(?1,?2,?3) ON CONFLICT(workspace_id,name) DO NOTHING", params![service.workspace_id,name,serde_json::to_string(&service)?])?;
        let mut held = Vec::new();
        for variable in &service.config.ports {
            if let Some(port) = before.as_ref().and_then(|s| s.ports.get(variable)) {
                service.ports.insert(variable.clone(), *port);
                continue;
            }
            let hash =
                Sha256::digest(format!("{}:{name}:{variable}", service.workspace_id).as_bytes());
            let start = u16::from_be_bytes([hash[0], hash[1]]) as usize % 20000;
            let mut chosen = None;
            for offset in 0..256 {
                let port = (20000 + (start + offset) % 20000) as u16;
                let claimed: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM service_ports WHERE port=?1)",
                    [port],
                    |r| r.get(0),
                )?;
                if claimed {
                    continue;
                }
                if let Some(sockets) = available(port) {
                    tx.execute("INSERT INTO service_ports(workspace_id,name,variable,port) VALUES(?1,?2,?3,?4)", params![service.workspace_id,name,variable,port])?;
                    held.extend(sockets);
                    chosen = Some(port);
                    break;
                }
            }
            let Some(port) = chosen else {
                bail!("No available service port in the allocation window");
            };
            service.ports.insert(variable.clone(), port);
        }
        if let Some(before) = &before {
            for variable in before
                .ports
                .keys()
                .filter(|v| !service.ports.contains_key(*v))
            {
                tx.execute(
                    "DELETE FROM service_ports WHERE workspace_id=?1 AND name=?2 AND variable=?3",
                    params![service.workspace_id, name, variable],
                )?;
            }
        }
        tx.execute(
            "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2",
            params![service.workspace_id, name, serde_json::to_string(&service)?],
        )?;
        tx.commit()?;
        pending.commit();
        drop(held);
        // Items the saved configuration no longer names are ADE's to delete.
        if let Some(before) = &before {
            crate::credentials::delete_owned_quietly(
                before
                    .config
                    .secret_refs
                    .values()
                    .filter(|old| !service.config.secret_refs.values().any(|kept| kept == *old)),
            );
        }
        Ok(service)
    }
    /// Removes a service and its terminal. Returns the layouts that lost the
    /// terminal's tabs, for the caller to publish.
    pub fn remove_service(
        &self,
        workspace: &str,
        name: &str,
        revision: i64,
    ) -> Result<Vec<ade_core::contract::layout::LayoutRecord>> {
        self.workspace(workspace)?;
        let tx =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mut removed = None;
        let mut layouts = Vec::new();
        if let Some(service) = load(&tx, workspace, name)? {
            ensure!(
                service.terminal_owner.is_none(),
                "Stop the service before removing it"
            );
            removed = Some(service.config.secret_refs.clone());
            if let Some(terminal) = &service.terminal_id {
                layouts = crate::store::terminal_records::remove(&tx, workspace, terminal)?
                    .unwrap_or_default();
            }
            ensure!(
                service.revision == revision,
                "Service changed; reload before removing"
            );
            tx.execute(
                "DELETE FROM services WHERE workspace_id=?1 AND name=?2",
                params![workspace, name],
            )?;
        }
        tx.commit()?;
        if let Some(references) = removed {
            crate::credentials::delete_owned_quietly(references.values());
        }
        Ok(layouts)
    }
    /// Moves every secret value a service record still holds in plain text
    /// (saved before references existed) into the Keychain, and rewrites
    /// the database so no copy of it is left in its free pages or journal.
    /// Opening the profile calls it; a value that cannot be moved stays, is
    /// never launched, and is tried again on the next open. Returns how many
    /// values moved.
    pub fn migrate_service_secrets(&self) -> Result<usize> {
        let rows = {
            let mut query = self
                .connection
                .prepare("SELECT workspace_id,name,data FROM services")?;
            query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut moved = 0;
        let mut failed = Vec::new();
        for (workspace, name, data) in rows {
            let Ok(mut service) = serde_json::from_str::<Service>(&data) else {
                continue;
            };
            let legacy = service.config.legacy_secret_values();
            let count = legacy.len();
            if legacy.is_empty() {
                continue;
            }
            let mut pending = crate::credentials::Pending::default();
            let mut stored = true;
            for (key, value) in legacy {
                let scope = format!("service/{workspace}/{name}/{key}");
                match pending.store(&scope, &value) {
                    Ok(reference) => {
                        service.config.secret_refs.insert(key.clone(), reference);
                        service
                            .config
                            .env
                            .insert(key, ade_core::services::REDACTED.into());
                    }
                    Err(error) => {
                        failed.push(format!("{workspace}/{name} {key}: {error:#}"));
                        stored = false;
                        break;
                    }
                }
            }
            if !stored {
                continue;
            }
            self.connection.pragma_update(None, "secure_delete", "ON")?;
            let updated = self.connection.execute(
                "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2 AND data=?4",
                params![workspace, name, serde_json::to_string(&service)?, data],
            )?;
            if updated == 1 {
                pending.commit();
                moved += count;
            }
        }
        if moved > 0 {
            // Rebuild the file so no earlier revision of a record keeps a
            // plain-text value in a free page, then empty the journal.
            self.connection.execute_batch("VACUUM")?;
            self.connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        self.connection
            .pragma_update(None, "secure_delete", "OFF")?;
        if !failed.is_empty() {
            bail!(
                "Service secrets stayed in plain text because the Keychain refused them: {}",
                failed.join("; ")
            );
        }
        Ok(moved)
    }
}

pub trait ServiceExt {
    fn launch(
        &self,
        root: &str,
        host: &ade_core::contract::placement::ExecutionHost,
        peer_endpoints: &BTreeMap<String, String>,
        secrets: &BTreeMap<String, String>,
    ) -> Result<crate::terminal_launch::Launch>;
    fn check_ports(&self) -> Result<()>;
}
impl ServiceExt for Service {
    fn launch(
        &self,
        root: &str,
        host: &ade_core::contract::placement::ExecutionHost,
        peer_endpoints: &BTreeMap<String, String>,
        secrets: &BTreeMap<String, String>,
    ) -> Result<crate::terminal_launch::Launch> {
        self.config.directory(root)?;
        ensure!(
            peer_endpoints.len() == self.config.peers.len()
                && peer_endpoints.keys().eq(self.config.peers.keys()),
            "Service peer endpoints were not resolved"
        );
        // Every secret launches with the value its reference resolved to,
        // never with the placeholder the configuration stores.
        ensure!(
            secrets.keys().eq(self.config.secret_env.iter()),
            "Service secrets were not resolved"
        );
        let mut env = self.config.env.clone();
        env.extend(secrets.clone());
        env.extend(
            self.ports
                .iter()
                .map(|(key, port)| (key.clone(), port.to_string())),
        );
        env.insert("ADE_WORKSPACE_ROOT".into(), root.into());
        env.insert("ADE_WORKSPACE_ID".into(), self.workspace_id.clone());
        env.insert(
            "ADE_EXECUTION_HOST".into(),
            crate::placement::env_value(host),
        );
        env.insert("ADE_SERVICE_NAME".into(), self.name.clone());
        env.insert("ADE_SERVICE_HOST".into(), self.hostname.clone());
        env.extend(peer_endpoints.clone());
        let launch = crate::terminal_launch::Launch {
            transfer_id: self
                .terminal_owner
                .as_ref()
                .context("Service has no terminal owner")?
                .transfer_id
                .clone(),
            program: self.config.program.clone(),
            args: self.config.args.clone(),
            env,
            cwd: Some(self.config.cwd.clone()),
        };
        launch.validate()?;
        Ok(launch)
    }
    fn check_ports(&self) -> Result<()> {
        for (variable, port) in &self.ports {
            ensure!(
                available(*port).is_some(),
                "Service port {variable}={port} is in use; stop its owner before starting this service"
            );
        }
        Ok(())
    }
}
impl Store {
    pub fn service(&self, workspace: &str, name: &str) -> Result<Service> {
        load(&self.connection, workspace, name)?.context("Unknown workspace service")
    }
    pub fn reserve_service(
        &self,
        workspace: &str,
        name: &str,
        instance: &str,
        peer_endpoints: &BTreeMap<String, String>,
    ) -> Result<Service> {
        let tx =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mut service = load(&tx, workspace, name)?.context("Unknown workspace service")?;
        if service.terminal_owner.is_some() {
            return Ok(service);
        }
        let w = self.workspace(workspace)?;
        if service.terminal_id.is_none() {
            ensure!(
                w.extra_terminals.len() < 32,
                "Workspace terminal limit reached"
            );
            let id = crate::model::new_id("terminal");
            crate::store::terminal_records::insert(
                &tx,
                &crate::store::terminal_records::Stored {
                    service_id: Some(service.identity.clone()),
                    label: Some(service.name.clone()),
                    ..crate::store::terminal_records::Stored::new(
                        &id,
                        workspace,
                        ade_core::contract::terminals::TerminalKind::Service,
                    )
                },
            )?;
            service.terminal_id = Some(id);
        }
        service.terminal_owner = Some(crate::model::TerminalOwner {
            terminal_id: service.terminal_id.clone().unwrap(),
            transfer_id: crate::model::new_id("service-run"),
            runtime_instance: instance.into(),
        });
        service.last_run_transfer_id = service
            .terminal_owner
            .as_ref()
            .map(|owner| owner.transfer_id.clone());
        service.launch_peers = peer_endpoints.clone();
        tx.execute(
            "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2",
            params![workspace, name, serde_json::to_string(&service)?],
        )?;
        let run = service.last_run_transfer_id.as_deref().unwrap_or_default();
        crate::hooks::enqueue(
            &tx,
            &crate::hooks::Event::service_state(workspace, name, "starting", run),
            crate::model::now_ms(),
        )?;
        tx.commit()?;
        Ok(service)
    }
    pub fn release_service(
        &self,
        workspace: &str,
        name: &str,
        owner: &crate::model::TerminalOwner,
    ) -> Result<Service> {
        let mut service = self.service(workspace, name)?;
        ensure!(
            service.terminal_owner.as_ref() == Some(owner),
            "Service ownership changed"
        );
        service.terminal_owner = None;
        service.launch_peers.clear();
        let tx =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE services SET data=?3 WHERE workspace_id=?1 AND name=?2",
            params![workspace, name, serde_json::to_string(&service)?],
        )?;
        // The lifecycle hook commits with the release (F058).
        crate::hooks::enqueue(
            &tx,
            &crate::hooks::Event::service_state(workspace, name, "stopped", &owner.transfer_id),
            crate::model::now_ms(),
        )?;
        tx.commit()?;
        Ok(service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        directory: PathBuf,
        database: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("ade-services-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            Self {
                database: directory.join("sessions.sqlite"),
                directory,
            }
        }
        fn store(&self) -> Store {
            Store::open(&self.database).unwrap()
        }
        fn workspace(&self, store: &Store) -> WorkspaceRecord {
            store
                .workspace_open(self.directory.to_str().unwrap(), None)
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    fn config() -> Config {
        serde_json::from_value(
            serde_json::json!({"program":"pnpm","args":["dev"],"ports":["PORT"]}),
        )
        .unwrap()
    }
    #[test]
    fn service_identity_and_ports_survive_reopen_edits_and_occupied_ports() {
        let f = Fixture::new();
        let store = f.store();
        let w = f.workspace(&store);
        let first = store.configure_service(&w.id, "web", 0, config()).unwrap();
        let occupied = TcpListener::bind(("127.0.0.1", first.ports["PORT"])).unwrap();
        drop(store);
        let store = f.store();
        assert_eq!(store.services(&w.id).unwrap(), vec![first.clone()]);
        assert_eq!(
            store.configure_service(&w.id, "web", 0, config()).unwrap(),
            first
        );
        let mut updated = config();
        updated.args.push("--host".into());
        assert!(
            store
                .configure_service(&w.id, "web", 0, updated.clone())
                .is_err()
        );
        let second = store.configure_service(&w.id, "web", 1, updated).unwrap();
        assert_eq!(second.ports, first.ports);
        assert_eq!(second.hostname, first.hostname);
        assert_eq!(second.revision, 2);
        assert!(store.remove_service(&w.id, "web", 1).is_err());
        assert_eq!(store.services(&w.id).unwrap(), vec![second]);
        store.remove_service(&w.id, "web", 2).unwrap();
        assert!(store.services(&w.id).unwrap().is_empty());
        let remaining: i64 = store
            .connection
            .query_row("SELECT count(*) FROM service_ports", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        drop(occupied);
    }
    #[test]
    fn allocations_are_unique_and_removed_variables_release_only_their_lease() {
        let f = Fixture::new();
        let store = f.store();
        let w = f.workspace(&store);
        let mut a = config();
        a.ports.push("API_PORT".into());
        let first = store.configure_service(&w.id, "web", 0, a).unwrap();
        let second = store
            .configure_service(&w.id, "worker", 0, config())
            .unwrap();
        let ports = first
            .ports
            .values()
            .chain(second.ports.values())
            .collect::<HashSet<_>>();
        assert_eq!(ports.len(), 3);
        let updated = store.configure_service(&w.id, "web", 1, config()).unwrap();
        assert_eq!(updated.ports["PORT"], first.ports["PORT"]);
        let remaining: i64 = store
            .connection
            .query_row("SELECT count(*) FROM service_ports", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 2);
        assert_eq!(store.services(&w.id).unwrap().len(), 2);
    }
    #[test]
    fn service_paths_and_environment_cannot_escape_their_contract() {
        let f = Fixture::new();
        let store = f.store();
        let w = f.workspace(&store);
        std::os::unix::fs::symlink(std::env::temp_dir(), f.directory.join("outside")).unwrap();
        for cwd in ["..", "/tmp", "outside", "missing"] {
            let mut c = config();
            c.cwd = cwd.into();
            assert!(
                store.configure_service(&w.id, "web", 0, c).is_err(),
                "{cwd}"
            );
        }
        for env in [
            serde_json::json!({"PORT":"123"}),
            serde_json::json!({"ADE_SOCKET":"x"}),
            serde_json::json!({"BAD=NAME":"x"}),
        ] {
            let mut c = config();
            c.env = serde_json::from_value(env).unwrap();
            assert!(store.configure_service(&w.id, "web", 0, c).is_err());
        }
        let mut c = config();
        c.ports.push("PORT".into());
        assert!(store.configure_service(&w.id, "web", 0, c).is_err());
        assert!(store.services(&w.id).unwrap().is_empty());
    }
    #[test]
    fn service_reservation_fences_edits_and_removal_and_removes_terminal_views() {
        let f = Fixture::new();
        let store = f.store();
        let w = f.workspace(&store);
        store.configure_service(&w.id, "web", 0, config()).unwrap();
        let reserved = store
            .reserve_service(&w.id, "web", "runtime", &BTreeMap::new())
            .unwrap();
        assert_eq!(
            store
                .reserve_service(&w.id, "web", "runtime", &BTreeMap::new())
                .unwrap(),
            reserved
        );
        let owner = reserved.terminal_owner.as_ref().unwrap();
        assert!(store.terminal_reserved(&owner.terminal_id).unwrap());
        let mut edited = config();
        edited.args.clear();
        assert!(store.configure_service(&w.id, "web", 1, edited).is_err());
        assert!(store.remove_service(&w.id, "web", 1).is_err());
        store.create_window("service-window", &w.id, None).unwrap();
        let open = ade_core::contract::layout::LayoutAction::OpenTab {
            tab: ade_core::contract::layout::Tab {
                id: "web-tab".into(),
                target: ade_core::contract::layout::TabTarget::Terminal {
                    id: owner.terminal_id.clone(),
                },
            },
            pane_id: None,
        };
        store
            .apply_layout("service-window", None, &open, None)
            .unwrap();
        store.release_service(&w.id, "web", owner).unwrap();
        assert!(
            store.terminal_reserved(&owner.terminal_id).unwrap(),
            "Stopped services still own their terminal"
        );
        store.remove_service(&w.id, "web", 1).unwrap();
        assert!(!store.terminal_reserved(&owner.terminal_id).unwrap());
        let catalog = store.catalog().unwrap();
        assert!(
            !catalog.workspaces[0]
                .extra_terminals
                .contains(&owner.terminal_id)
        );
        let layout = store.layout("service-window", None).unwrap();
        assert!(layout.layout.tabs.is_empty());
        assert_eq!(layout.revision, 2);
    }
}
