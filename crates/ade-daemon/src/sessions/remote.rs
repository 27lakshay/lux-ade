//! `remote.*` operations: the profile's remote host registry, pairings and
//! SSH bootstrap (F122, F124).
//!
//! The registry lives in the profile state database. It holds the pinned host
//! key (a public value), the SSH target and a reference to each pairing token,
//! never a secret. Decisions are the pure functions in [`crate::remote`]; this
//! module owns storage, receipts and the `ssh` processes. The data lock is
//! never held while `ssh` runs.
use super::*;
use crate::receipts::{self, Admission, Status};
use crate::remote::{self as decide, Finished, HostKey};
use ade_core::contract::remote::{
    InstallOutcome, PairingState, RemoteHost, RemoteHostAddRequest, RemoteHostInstall,
    RemoteHostInstallRequest, RemoteHostListRequest, RemoteHostProbe, RemoteHostProbeRequest,
    RemoteHostRemoveRequest, RemoteHostRemoved, RemoteHostReply, RemoteHostStart,
    RemoteHostStartRequest, RemoteHosts, RemotePairRequest, RemotePairing, RemotePairingReply,
    RemoteRevokeRequest, StartOutcome, TokenReference,
};
use ade_core::protocol::{APPLICATION_PROTOCOL, RUNTIME_PROTOCOL};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::{
    process::Stdio,
    time::{Duration, Instant},
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS remote_hosts(host_id TEXT PRIMARY KEY, label TEXT NOT NULL, ssh_target TEXT NOT NULL, host_key TEXT NOT NULL, host_key_fingerprint TEXT NOT NULL, backend_path TEXT, remote_profile_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS remote_pairings(pairing_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, token_reference TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')), paired_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS remote_pairings_one_active ON remote_pairings(host_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS remote_host_installs(host_id TEXT PRIMARY KEY, control_path TEXT NOT NULL, installed_at INTEGER NOT NULL);";

/// Each host's last settled start. Receipt retention empties old receipts, so
/// current readiness lives here and never in receipt history.
const START_SCHEMA: &str = "CREATE TABLE remote_host_starts(host_id TEXT PRIMARY KEY, result TEXT NOT NULL, settled_at INTEGER NOT NULL);
INSERT INTO remote_host_starts(host_id,result,settled_at) SELECT host_id,result,updated_at FROM (SELECT json_extract(result,'$.host_id') AS host_id,result,updated_at,row_number() OVER (PARTITION BY json_extract(result,'$.host_id') ORDER BY updated_at DESC, rowid DESC) AS n FROM operations WHERE op='remote.host.start' AND result IS NOT NULL) WHERE n=1 AND host_id IS NOT NULL;";

/// Only this profile refuses the pairing.
const LOCAL_ENFORCEMENT: &str = "local_profile";
/// The host recorded the revocation and refuses the pairing itself.
const REMOTE_ENFORCEMENT: &str = "remote_daemon";
const REVOKE_TIMEOUT: Duration = Duration::from_secs(45);
const OUTPUT_LIMIT: u64 = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);
const START_TIMEOUT: Duration = Duration::from_secs(60);
const _: () =
    assert!(PROBE_TIMEOUT.as_secs() + START_TIMEOUT.as_secs() == decide::START_BUDGET_SECS);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(decide::UPLOAD_TIMEOUT_SECS);
const _: () = assert!(
    PROBE_TIMEOUT.as_secs() * 2 + UPLOAD_TIMEOUT.as_secs() * 3 == decide::INSTALL_BUDGET_SECS
);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
const KEYSCAN_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn ensure_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    receipts::ensure(connection)?;
    let has_starts: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_host_starts')",
        [],
        |row| row.get(0),
    )?;
    if !has_starts {
        // Created once, seeded from receipts that retention has not emptied yet.
        let tx = transaction(connection)?;
        tx.execute_batch(START_SCHEMA)?;
        tx.commit()?;
    }
    Ok(())
}

/// Settles a start's receipt and records it as the host's last start, in one
/// transaction.
fn settle_start(
    connection: &Connection,
    operation_id: &str,
    status: Status,
    result: &Value,
    now: i64,
) -> Result<()> {
    let tx = transaction(connection)?;
    receipts::settle(&tx, operation_id, status, Some(result), now)?;
    if let Some(host_id) = result["host_id"].as_str() {
        tx.execute(
            "INSERT INTO remote_host_starts(host_id,result,settled_at) VALUES(?1,?2,?3) ON CONFLICT(host_id) DO UPDATE SET result=excluded.result,settled_at=excluded.settled_at",
            params![host_id, result.to_string(), now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The last settled start for a host, as its stored reply and settle time.
pub(super) fn last_start(connection: &Connection, host_id: &str) -> Result<Option<(String, i64)>> {
    Ok(connection
        .query_row(
            "SELECT result,settled_at FROM remote_host_starts WHERE host_id=?1",
            [host_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            elapsed.as_millis().min(i64::MAX as u128) as i64
        })
}

/// A registry row with its pinned key.
#[derive(Clone)]
struct Stored {
    host: RemoteHost,
    key: HostKey,
}

fn read_host(connection: &Connection, host_id: &str) -> Result<Option<Stored>> {
    let row = connection
        .query_row(
            "SELECT label,ssh_target,host_key,host_key_fingerprint,backend_path,remote_profile_id,created_at FROM remote_hosts WHERE host_id=?1",
            [host_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((label, ssh_target, host_key, fingerprint, backend_path, remote_profile_id, created)) =
        row
    else {
        return Ok(None);
    };
    // A stored key that no longer matches its fingerprint is never used.
    let key = decide::parse_public_key(&host_key)
        .ok()
        .filter(|key| key.fingerprint() == fingerprint)
        .with_context(|| format!("Stored host key for {host_id} is unreadable"))?;
    Ok(Some(Stored {
        host: RemoteHost {
            host_id: host_id.to_owned(),
            label,
            ssh_target,
            host_key_type: key.key_type.clone(),
            host_key_fingerprint: fingerprint,
            host_public_key: key.public_line(),
            backend_path,
            remote_profile_id,
            installed_backend_path: connection
                .query_row(
                    "SELECT control_path FROM remote_host_installs WHERE host_id=?1",
                    [host_id],
                    |row| row.get(0),
                )
                .optional()?,
            created_at_ms: created,
            pairing: latest_pairing(connection, host_id)?,
        },
        key,
    }))
}

fn required_host(connection: &Connection, host_id: &str) -> Result<Stored> {
    read_host(connection, host_id)?.with_context(|| format!("Unknown remote host {host_id}"))
}

fn latest_pairing(connection: &Connection, host_id: &str) -> Result<Option<RemotePairing>> {
    connection
        .query_row(
            "SELECT pairing_id,state,token_reference,paired_at,revoked_at FROM remote_pairings WHERE host_id=?1 ORDER BY state='active' DESC, paired_at DESC, rowid DESC LIMIT 1",
            [host_id],
            pairing_row,
        )
        .optional()?
        .map(stored_pairing)
        .transpose()
}

type PairingRow = (String, String, String, i64, Option<i64>);

fn pairing_row(row: &rusqlite::Row) -> rusqlite::Result<PairingRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn stored_pairing(
    (pairing_id, state, token_reference, paired_at, revoked_at): PairingRow,
) -> Result<RemotePairing> {
    Ok(RemotePairing {
        state: match state.as_str() {
            "active" => PairingState::Active,
            "revoked" => PairingState::Revoked,
            other => bail!("Stored pairing {pairing_id} has unknown state {other}"),
        },
        token_reference: serde_json::from_str(&token_reference)
            .with_context(|| format!("Stored pairing {pairing_id} is unreadable"))?,
        pairing_id,
        paired_at_ms: paired_at,
        revoked_at_ms: revoked_at,
    })
}

fn transaction(connection: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        connection,
        TransactionBehavior::Immediate,
    )?)
}

/// A private one-line known-hosts file, removed when dropped.
struct KnownHosts {
    directory: std::path::PathBuf,
    file: String,
}

impl KnownHosts {
    fn write(alias: &str, key: &HostKey) -> Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let directory =
            std::env::temp_dir().join(format!("ade-remote-{}", uuid::Uuid::new_v4().simple()));
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let guard = Self {
            file: directory.join("known_hosts").to_string_lossy().into_owned(),
            directory,
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&guard.file)?;
        file.write_all(key.known_hosts_line(alias).as_bytes())?;
        file.sync_all()?;
        Ok(guard)
    }
}

impl Drop for KnownHosts {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/// What a program reads on stdin.
enum Input<'a> {
    Nothing,
    Text(&'a str),
    File(&'a std::path::Path),
}

/// Runs a program with bounded output and a deadline; a late process is killed
/// and reported as timed out, never as finished.
fn run(program: &str, args: &[String], stdin: Input, timeout: Duration) -> Result<Finished> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("SSH_ASKPASS")
        .env_remove("DISPLAY")
        .stdin(match stdin {
            Input::Nothing => Stdio::null(),
            Input::Text(_) => Stdio::piped(),
            Input::File(path) => Stdio::from(
                std::fs::File::open(path)
                    .with_context(|| format!("Could not read {}", path.display()))?,
            ),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("Could not run {program}"))?;
    if let (Input::Text(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_owned();
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    let reader = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(pipe) = pipe {
                let mut bytes = Vec::new();
                let _ = pipe.take(OUTPUT_LIMIT).read_to_end(&mut bytes);
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
            text
        })
    };
    let stdout = reader(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = reader(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + timeout;
    let (code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok(Finished {
        code,
        timed_out,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Runs `/bin/sh -s` on the host with `script` on stdin, pinned to its key.
fn remote_shell(stored: &Stored, script: &str, timeout: Duration) -> Result<Finished> {
    remote_command(stored, "/bin/sh -s", Input::Text(script), timeout)
}

/// Runs one command on the host, pinned to its key.
fn remote_command(
    stored: &Stored,
    command: &str,
    stdin: Input,
    timeout: Duration,
) -> Result<Finished> {
    let alias = decide::host_key_alias(&stored.host.host_id);
    let known_hosts = KnownHosts::write(&alias, &stored.key)?;
    let args = decide::ssh_args(
        &stored.host.ssh_target,
        &known_hosts.file,
        &alias,
        &stored.key,
        command,
    )?;
    run("ssh", &args, stdin, timeout)
}

/// The `ade-control` probe and start use: the one the user named, else the
/// one ADE installed, else the host's PATH.
fn effective_backend(stored: &Stored) -> Option<&str> {
    stored
        .host
        .backend_path
        .as_deref()
        .or(stored.host.installed_backend_path.as_deref())
}

/// The host key `remote.host.add` pins, or why none can be.
fn obtain_key(request: &RemoteHostAddRequest) -> Result<HostKey> {
    if let Some(line) = &request.host_public_key {
        let key = decide::parse_public_key(line)?;
        return decide::select_pinned(&[key], &request.expected_fingerprint);
    }
    let resolved = run(
        "ssh",
        &["-G".to_owned(), "--".to_owned(), request.ssh_target.clone()],
        Input::Nothing,
        RESOLVE_TIMEOUT,
    )?;
    ensure!(
        resolved.code == Some(0),
        "ssh -G could not resolve {}: {}",
        request.ssh_target,
        decide::diagnostic(&resolved.stderr)
    );
    let target = decide::parse_ssh_config(&resolved.stdout)?;
    ensure!(
        !target.proxied,
        "{} is reached through a proxy, which ssh-keyscan cannot follow. Pass the host's public key line (host_public_key)",
        request.ssh_target
    );
    let scan = run(
        "ssh-keyscan",
        &[
            "-T".to_owned(),
            "10".to_owned(),
            "-p".to_owned(),
            target.port.to_string(),
            "-t".to_owned(),
            "ed25519,ecdsa,rsa".to_owned(),
            "--".to_owned(),
            target.hostname.clone(),
        ],
        Input::Nothing,
        KEYSCAN_TIMEOUT,
    )?;
    ensure!(
        !scan.timed_out,
        "ssh-keyscan did not finish; nothing was recorded"
    );
    decide::select_pinned(
        &decide::parse_keyscan(&scan.stdout),
        &request.expected_fingerprint,
    )
}

/// The probe: connect with the pinned key and describe the backend.
fn probe(stored: &Stored) -> Result<RemoteHostProbe> {
    let backend_path = effective_backend(stored);
    let finished = remote_shell(stored, &decide::probe_script(backend_path), PROBE_TIMEOUT)?;
    ensure!(
        !finished.timed_out,
        "The probe of {} did not finish in time",
        stored.host.host_id
    );
    if finished.code != Some(0) {
        ensure!(
            !decide::host_key_rejected(&finished.stderr),
            "{} did not present the pinned host key {}; nothing ran on it. Verify a rotated key out of band, then remove and re-add the host",
            stored.host.host_id,
            stored.host.host_key_fingerprint
        );
        bail!(
            "ssh could not probe {}: {}",
            stored.host.host_id,
            decide::diagnostic(&finished.stderr)
        );
    }
    let report = decide::parse_probe(&finished.stdout)?;
    let (platform, backend) = decide::compatibility(
        &report,
        backend_path,
        APPLICATION_PROTOCOL,
        RUNTIME_PROTOCOL,
    );
    Ok(RemoteHostProbe {
        tag: Default::default(),
        host_id: stored.host.host_id.clone(),
        host_key_fingerprint: stored.host.host_key_fingerprint.clone(),
        platform,
        backend,
    })
}

fn start_reply(
    operation_id: &str,
    host_id: &str,
    outcome: StartOutcome,
    detail: Option<String>,
    daemon: Option<ade_core::contract::remote::RemoteDaemon>,
) -> RemoteHostStart {
    RemoteHostStart {
        tag: Default::default(),
        operation_id: operation_id.to_owned(),
        host_id: host_id.to_owned(),
        outcome,
        detail,
        daemon,
    }
}

/// Reads a pairing token from where its reference points. The value is used
/// only to compute the digest the host stores; it is never written anywhere.
fn resolve_token(reference: &TokenReference) -> Result<String> {
    let token = match reference {
        TokenReference::Env(name) => std::env::var(name).with_context(|| {
            format!("The pairing token variable {name} is not set in this daemon's environment")
        })?,
        // Through the shared secret store, so tests use the file store and never
        // reach the login keychain (AGENTS.md, machine safety).
        TokenReference::Keychain { service, account } => {
            crate::credentials::resolve(&ade_core::credentials::CredentialReference::Keychain {
                service: service.clone(),
                account: account.clone(),
            })
            .with_context(|| {
                format!(
                    "The Keychain has no pairing token for service {service}, account {account}"
                )
            })?
        }
    };
    ensure!(!token.is_empty(), "The pairing token is empty");
    Ok(token)
}

/// Probes, then starts or attaches. Only a start that ran can be unknown.
fn attempt_start(stored: &Stored, operation_id: &str) -> RemoteHostStart {
    let host_id = &stored.host.host_id;
    let failed = |detail: String| {
        start_reply(
            operation_id,
            host_id,
            StartOutcome::Failed,
            Some(detail),
            None,
        )
    };
    // Admission checked the pairing is active; the host is granted exactly it.
    let Some(pairing) = stored.host.pairing.as_ref() else {
        return failed(format!("{host_id} is not paired; nothing was started"));
    };
    let digest = match resolve_token(&pairing.token_reference) {
        Ok(token) => crate::remote_access::token_sha256(&token),
        Err(error) => return failed(format!("{error:#}; nothing was started")),
    };
    let probe = match probe(stored) {
        Ok(probe) => probe,
        Err(error) => return failed(format!("{error:#}; nothing was started")),
    };
    let Some(control) = probe
        .backend
        .control_path
        .as_deref()
        .filter(|_| probe.backend.compatible)
    else {
        let gaps = probe
            .backend
            .missing
            .iter()
            .map(|gap| format!("missing {gap}"))
            .chain(probe.backend.incompatible.iter().cloned())
            .collect::<Vec<_>>()
            .join("; ");
        return failed(format!(
            "The remote backend is not compatible ({gaps}); nothing was installed or started"
        ));
    };
    let script = decide::start_script(
        control,
        stored.host.remote_profile_id.as_deref(),
        Some((&pairing.pairing_id, &digest)),
    );
    let finished = match remote_shell(stored, &script, START_TIMEOUT) {
        Ok(finished) => finished,
        Err(error) => return failed(format!("{error:#}; nothing was started")),
    };
    let (outcome, detail, daemon) =
        decide::classify_start(&finished, APPLICATION_PROTOCOL, RUNTIME_PROTOCOL);
    start_reply(operation_id, host_id, outcome, detail, daemon)
}

fn install_reply(
    operation_id: &str,
    host_id: &str,
    outcome: InstallOutcome,
    detail: Option<String>,
    control_path: Option<String>,
    installed: Vec<String>,
) -> RemoteHostInstall {
    RemoteHostInstall {
        tag: Default::default(),
        operation_id: operation_id.to_owned(),
        host_id: host_id.to_owned(),
        outcome,
        detail,
        control_path,
        installed,
    }
}

/// This installation's own backend executables, beside the running daemon.
fn local_artifacts() -> Result<Vec<(&'static str, std::path::PathBuf)>> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .context("The daemon executable has no directory")?;
    decide::INSTALL_ARTIFACTS
        .iter()
        .map(|name| {
            let path = directory.join(name);
            ensure!(
                path.is_file(),
                "This installation has no {name} to install at {}",
                path.display()
            );
            Ok((*name, path))
        })
        .collect()
}

/// Probes, then copies this installation's backend into the ADE-owned
/// directory when the plan allows, then probes again through what it wrote.
fn attempt_install(stored: &Stored, operation_id: &str) -> RemoteHostInstall {
    let host_id = &stored.host.host_id;
    let done = |outcome, detail: String, control: Option<String>, installed: Vec<String>| {
        install_reply(
            operation_id,
            host_id,
            outcome,
            Some(detail),
            control,
            installed,
        )
    };
    let failed = |detail: String| done(InstallOutcome::Failed, detail, None, vec![]);
    let artifacts = match local_artifacts() {
        Ok(artifacts) => artifacts,
        Err(error) => return failed(format!("{error:#}; nothing was installed")),
    };
    let probed = match probe(stored) {
        Ok(probed) => probed,
        Err(error) => return failed(format!("{error:#}; nothing was installed")),
    };
    match decide::install_plan(
        &decide::local_platform(),
        &probed.platform,
        &probed.backend,
        stored.host.backend_path.as_deref(),
    ) {
        decide::InstallPlan::AlreadyCompatible(control) => {
            return done(
                InstallOutcome::AlreadyCompatible,
                "The host already has a compatible backend; nothing was written".to_owned(),
                Some(control),
                vec![],
            );
        }
        decide::InstallPlan::Refuse(reason) => return failed(reason),
        decide::InstallPlan::Install => {}
    }
    let directory = decide::install_directory(APPLICATION_PROTOCOL, RUNTIME_PROTOCOL);
    let mut installed = Vec::new();
    let mut control = None;
    for (index, (name, path)) in artifacts.iter().enumerate() {
        let command = decide::upload_command(&directory, name);
        let finished = match remote_command(stored, &command, Input::File(path), UPLOAD_TIMEOUT) {
            Ok(finished) => finished,
            Err(error) if index == 0 => {
                return failed(format!("{error:#}; nothing was installed"));
            }
            Err(error) => {
                return done(
                    InstallOutcome::Unknown,
                    format!(
                        "{error:#}; some artifacts may have been written. Probe the host; installing again is safe"
                    ),
                    None,
                    installed,
                );
            }
        };
        let written = (finished.code == Some(0) && !finished.timed_out)
            .then(|| decide::uploaded_path(&finished.stdout))
            .flatten();
        let Some(written) = written else {
            let (outcome, detail) = decide::upload_failure(&finished, index == 0);
            return done(outcome, detail, None, installed);
        };
        installed.push((*name).to_owned());
        if *name == "ade-control" {
            control = Some(written);
        }
    }
    let Some(control) = control else {
        return done(
            InstallOutcome::Unknown,
            "The upload did not report where ade-control was installed; probe the host".to_owned(),
            None,
            installed,
        );
    };
    // The install counts only when the host now probes compatible through it.
    let mut installed_host = stored.clone();
    installed_host.host.installed_backend_path = Some(control.clone());
    installed_host.host.backend_path = None;
    match probe(&installed_host) {
        Ok(verified)
            if verified.backend.compatible
                && verified.backend.control_path.as_deref() == Some(control.as_str()) =>
        {
            done(
                InstallOutcome::Installed,
                format!(
                    "Installed this installation's backend at {control}; the host's own configuration was not changed"
                ),
                Some(control),
                installed,
            )
        }
        Ok(verified) => done(
            InstallOutcome::Unknown,
            format!(
                "The artifacts were written to {control}, but the host does not probe compatible: {}",
                verified
                    .backend
                    .missing
                    .iter()
                    .chain(verified.backend.incompatible.iter())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            None,
            installed,
        ),
        Err(error) => done(
            InstallOutcome::Unknown,
            format!(
                "The artifacts were written to {control}, but the closing probe failed: {error:#}"
            ),
            None,
            installed,
        ),
    }
}

impl Sessions {
    pub(super) fn remote_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "remote.host.list" => {
                let _: RemoteHostListRequest = decode(request)?;
                self.remote_store(|connection| {
                    let mut statement =
                        connection.prepare("SELECT host_id FROM remote_hosts ORDER BY host_id")?;
                    let ids = statement
                        .query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    let hosts = ids
                        .iter()
                        .map(|id| required_host(connection, id).map(|stored| stored.host))
                        .collect::<Result<Vec<_>>>()?;
                    reply(&RemoteHosts {
                        tag: Default::default(),
                        hosts,
                    })
                })
            }
            "remote.host.add" => self.remote_add(decode(request)?),
            "remote.host.remove" => {
                let remove: RemoteHostRemoveRequest = decode(request)?;
                self.remote_store(|connection| {
                    let tx = transaction(connection)?;
                    let active = latest_pairing(&tx, &remove.host_id)?
                        .filter(|pairing| pairing.state == PairingState::Active)
                        .map(|pairing| pairing.pairing_id);
                    let placements = super::placement::placements_on_host(&tx, &remove.host_id)?;
                    if let Some(refusal) =
                        decide::removal_refusal(&remove.host_id, active.as_deref(), placements)
                    {
                        bail!(refusal);
                    }
                    tx.execute(
                        "DELETE FROM remote_pairings WHERE host_id=?1",
                        [&remove.host_id],
                    )?;
                    tx.execute(
                        "DELETE FROM remote_host_starts WHERE host_id=?1",
                        [&remove.host_id],
                    )?;
                    tx.execute(
                        "DELETE FROM remote_host_installs WHERE host_id=?1",
                        [&remove.host_id],
                    )?;
                    let removed = tx.execute(
                        "DELETE FROM remote_hosts WHERE host_id=?1",
                        [&remove.host_id],
                    )? > 0;
                    tx.commit()?;
                    reply(&RemoteHostRemoved {
                        tag: Default::default(),
                        host_id: remove.host_id,
                        removed,
                    })
                })
            }
            "remote.host.probe" => {
                let request: RemoteHostProbeRequest = decode(request)?;
                let stored =
                    self.remote_store(|connection| required_host(connection, &request.host_id))?;
                reply(&probe(&stored)?)
            }
            "remote.host.pair" => {
                let pair: RemotePairRequest = decode(request)?;
                decide::validate_token_reference(&pair.token_reference)?;
                self.remote_store(|connection| pair_host(connection, &pair))
            }
            "remote.host.revoke" => {
                let revoke: RemoteRevokeRequest = decode(request)?;
                let (stored, pairing) = self.remote_store(|connection| {
                    let pairing = revoke_pairing(connection, &revoke)?;
                    Ok((required_host(connection, &revoke.host_id)?, pairing))
                })?;
                // The revocation is final here first; then the host records it,
                // without the data lock. A host that cannot be reached keeps
                // the pairing refused by this profile, and revoking again retries.
                let (enforcement, detail) = match remote_revoke(&stored, &pairing.pairing_id) {
                    Ok(()) => (REMOTE_ENFORCEMENT, None),
                    Err(error) => (
                        LOCAL_ENFORCEMENT,
                        Some(format!(
                            "{error:#}. This profile refuses the pairing; the host has not recorded the revocation yet. Revoke again when the host is reachable"
                        )),
                    ),
                };
                pairing_reply(&revoke.host_id, pairing, enforcement, detail)
            }
            "remote.host.start" => self.remote_start(request),
            "remote.host.install" => self.remote_install(request),
            _ => bail!("Unknown session operation"),
        }
    }

    /// Runs `work` against the profile database under the data lock.
    fn remote_store<T>(&self, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let data = self.data.lock().unwrap();
        let connection = &data.store.connection;
        persistence_result(ensure_schema(connection).and_then(|()| work(connection)))
    }

    fn remote_add(&self, request: RemoteHostAddRequest) -> Result<Value> {
        decide::validate_host_id(&request.host_id)?;
        decide::validate_target(&request.ssh_target)?;
        let label = request
            .label
            .clone()
            .unwrap_or_else(|| request.host_id.clone());
        decide::validate_label(&label)?;
        if let Some(path) = &request.backend_path {
            decide::validate_remote_path(path)?;
        }
        if let Some(id) = &request.remote_profile_id {
            decide::validate_profile_id(id)?;
        }
        let expected = decide::normalize_fingerprint(&request.expected_fingerprint)?;
        let same = |host: &RemoteHost| {
            host.label == label
                && host.ssh_target == request.ssh_target
                && host.host_key_fingerprint == expected
                && host.backend_path == request.backend_path
                && host.remote_profile_id == request.remote_profile_id
        };
        let existing = |connection: &Connection| -> Result<Option<Value>> {
            let Some(stored) = read_host(connection, &request.host_id)? else {
                return Ok(None);
            };
            ensure!(
                same(&stored.host),
                "Remote host {} is registered with a different definition; remove it first",
                request.host_id
            );
            Ok(Some(reply(&RemoteHostReply {
                tag: Default::default(),
                host: stored.host,
            })?))
        };
        if let Some(stored) = self.remote_store(existing)? {
            return Ok(stored);
        }
        // Network reads run without the data lock.
        let key = obtain_key(&request)?;
        self.remote_store(|connection| {
            let tx = transaction(connection)?;
            if let Some(stored) = existing(&tx)? {
                return Ok(stored);
            }
            tx.execute(
                "INSERT INTO remote_hosts(host_id,label,ssh_target,host_key,host_key_fingerprint,backend_path,remote_profile_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    request.host_id,
                    label,
                    request.ssh_target,
                    key.public_line(),
                    key.fingerprint(),
                    request.backend_path,
                    request.remote_profile_id,
                    now_ms()
                ],
            )?;
            let host = required_host(&tx, &request.host_id)?.host;
            tx.commit()?;
            reply(&RemoteHostReply {
                tag: Default::default(),
                host,
            })
        })
    }

    /// Admits an effect command on a paired host: a new receipt moves to
    /// `dispatched` before any `ssh` runs. A stored result is replayed; an
    /// attempt that never recorded one is not run again, and `unsettled`
    /// builds the reply that says so.
    fn admit_effect(
        &self,
        op: &str,
        request: &Value,
        operation_id: &str,
        host_id: &str,
        verb: &str,
        unsettled: impl FnOnce(&str) -> Result<Value>,
    ) -> Result<std::result::Result<Stored, Value>> {
        ensure!(
            !operation_id.is_empty() && operation_id.len() <= 512,
            "Missing operation_id"
        );
        self.remote_store(|connection| {
            let tx = transaction(connection)?;
            match receipts::begin(&tx, operation_id, op, request, None, now_ms())? {
                Admission::New => {}
                Admission::Replay(receipt) => {
                    return Ok(Err(match receipt.result {
                        Some(result) => result,
                        None => unsettled(receipt.status.as_str())?,
                    }));
                }
                Admission::Conflict => {
                    bail!("Operation ID was already used for different parameters")
                }
                Admission::Expired => {
                    bail!(
                        "Operation ID is past its 30-day receipt retention; use a new operation ID"
                    )
                }
            }
            let stored = required_host(&tx, host_id)?;
            match &stored.host.pairing {
                Some(pairing) if pairing.state == PairingState::Active => {}
                Some(pairing) => bail!(
                    "Pairing {} with {host_id} was revoked; pair again before {verb} it",
                    pairing.pairing_id,
                ),
                None => bail!("{host_id} is not paired; pair it before {verb} it"),
            }
            receipts::settle(&tx, operation_id, Status::Dispatched, None, now_ms())?;
            tx.commit()?;
            Ok(Ok(stored))
        })
    }

    fn remote_start(&self, request: &Value) -> Result<Value> {
        let start: RemoteHostStartRequest = decode(request)?;
        let operation_id = start.operation_id.as_str();
        let admitted = self.admit_effect(
            "remote.host.start",
            request,
            operation_id,
            &start.host_id,
            "starting",
            |status| {
                reply(&start_reply(
                    operation_id,
                    &start.host_id,
                    StartOutcome::Unknown,
                    Some(decide::unsettled_start_detail(status)),
                    None,
                ))
            },
        )?;
        let stored = match admitted {
            Ok(stored) => stored,
            Err(replayed) => return Ok(replayed),
        };
        let result = reply(&attempt_start(&stored, operation_id))?;
        let status = if result["outcome"] == "unknown" {
            Status::Unknown
        } else {
            Status::Settled
        };
        self.remote_store(|connection| {
            settle_start(connection, operation_id, status, &result, now_ms())
        })?;
        Ok(result)
    }

    fn remote_install(&self, request: &Value) -> Result<Value> {
        let install: RemoteHostInstallRequest = decode(request)?;
        let operation_id = install.operation_id.as_str();
        let admitted = self.admit_effect(
            "remote.host.install",
            request,
            operation_id,
            &install.host_id,
            "installing on",
            |status| {
                reply(&install_reply(
                    operation_id,
                    &install.host_id,
                    InstallOutcome::Unknown,
                    Some(format!(
                        "An earlier attempt with this operation ID is {status} and has no recorded outcome; it may still be running, so it was not run again. Probe the host; installing again under a new operation ID is safe once it has finished"
                    )),
                    None,
                    vec![],
                ))
            },
        )?;
        let stored = match admitted {
            Ok(stored) => stored,
            Err(replayed) => return Ok(replayed),
        };
        let outcome = attempt_install(&stored, operation_id);
        let result = reply(&outcome)?;
        self.remote_store(|connection| {
            let tx = transaction(connection)?;
            let status = if outcome.outcome == InstallOutcome::Unknown {
                Status::Unknown
            } else {
                Status::Settled
            };
            receipts::settle(&tx, operation_id, status, Some(&result), now_ms())?;
            if let (InstallOutcome::Installed, Some(control)) =
                (outcome.outcome, &outcome.control_path)
            {
                tx.execute(
                    "INSERT INTO remote_host_installs(host_id,control_path,installed_at) VALUES(?1,?2,?3) ON CONFLICT(host_id) DO UPDATE SET control_path=excluded.control_path,installed_at=excluded.installed_at",
                    params![install.host_id, control, now_ms()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })?;
        Ok(result)
    }
}

fn pair_host(connection: &Connection, pair: &RemotePairRequest) -> Result<Value> {
    let tx = transaction(connection)?;
    let stored = required_host(&tx, &pair.host_id)?;
    let pairing = match stored.host.pairing {
        Some(active) if active.state == PairingState::Active => {
            ensure!(
                active.token_reference == pair.token_reference,
                "{} already has active pairing {}; revoke it before pairing again",
                pair.host_id,
                active.pairing_id
            );
            active
        }
        _ => {
            let pairing = RemotePairing {
                pairing_id: uuid::Uuid::new_v4().to_string(),
                state: PairingState::Active,
                token_reference: pair.token_reference.clone(),
                paired_at_ms: now_ms(),
                revoked_at_ms: None,
            };
            tx.execute(
                "INSERT INTO remote_pairings(pairing_id,host_id,token_reference,state,paired_at,revoked_at) VALUES(?1,?2,?3,'active',?4,NULL)",
                params![
                    pairing.pairing_id,
                    pair.host_id,
                    serde_json::to_string(&pairing.token_reference)?,
                    pairing.paired_at_ms
                ],
            )?;
            pairing
        }
    };
    tx.commit()?;
    // Granted on the host by the next `remote.host.start`.
    pairing_reply(&pair.host_id, pairing, LOCAL_ENFORCEMENT, None)
}

/// Records a revoked pairing on the host, pinned to its key.
fn remote_revoke(stored: &Stored, pairing_id: &str) -> Result<()> {
    let script = decide::revoke_script(
        effective_backend(stored),
        pairing_id,
        stored.host.remote_profile_id.as_deref(),
    );
    let finished = remote_shell(stored, &script, REVOKE_TIMEOUT)?;
    ensure!(!finished.timed_out, "The host did not answer in time");
    ensure!(
        !decide::host_key_rejected(&finished.stderr),
        "{} did not present the pinned host key {}",
        stored.host.host_id,
        stored.host.host_key_fingerprint
    );
    ensure!(
        decide::revocation_confirmed(&finished, pairing_id),
        "The host could not record the revocation: {}",
        decide::diagnostic(&finished.stderr)
    );
    Ok(())
}

fn revoke_pairing(connection: &Connection, revoke: &RemoteRevokeRequest) -> Result<RemotePairing> {
    let tx = transaction(connection)?;
    tx.execute(
        "UPDATE remote_pairings SET state='revoked',revoked_at=?3 WHERE pairing_id=?1 AND host_id=?2 AND state='active'",
        params![revoke.pairing_id, revoke.host_id, now_ms()],
    )?;
    let pairing = tx
        .query_row(
            "SELECT pairing_id,state,token_reference,paired_at,revoked_at FROM remote_pairings WHERE pairing_id=?1 AND host_id=?2",
            params![revoke.pairing_id, revoke.host_id],
            pairing_row,
        )
        .optional()?
        .map(stored_pairing)
        .transpose()?
        .with_context(|| {
            format!(
                "Unknown pairing {} for {}",
                revoke.pairing_id, revoke.host_id
            )
        })?;
    tx.commit()?;
    Ok(pairing)
}

fn pairing_reply(
    host_id: &str,
    pairing: RemotePairing,
    enforcement: &str,
    detail: Option<String>,
) -> Result<Value> {
    reply(&RemotePairingReply {
        tag: Default::default(),
        host_id: host_id.to_owned(),
        pairing,
        enforcement: enforcement.to_owned(),
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn last_start_outlives_receipt_retention() {
        let connection = Connection::open_in_memory().unwrap();
        ensure_schema(&connection).unwrap();
        let started = 1_000_000;
        let request = json!({"op": "remote.host.start", "operation_id": "op-1", "host_id": "box"});
        receipts::begin(
            &connection,
            "op-1",
            "remote.host.start",
            &request,
            None,
            started,
        )
        .unwrap();
        receipts::settle(&connection, "op-1", Status::Dispatched, None, started).unwrap();
        let result = json!({"type": "remote_host_start", "host_id": "box", "outcome": "running"});
        settle_start(&connection, "op-1", Status::Settled, &result, started).unwrap();
        // 31 days later, retention empties the receipt.
        assert_eq!(
            receipts::prune(&connection, started + 31 * DAY_MS).unwrap(),
            1
        );
        let (stored, at) = last_start(&connection, "box").unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), result);
        assert_eq!(at, started);
    }

    #[test]
    fn start_table_is_seeded_from_unexpired_receipts() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        receipts::ensure(&connection).unwrap();
        for (id, at, outcome) in [("a", 10, "failed"), ("b", 20, "running")] {
            let request = json!({"op": "remote.host.start", "operation_id": id, "host_id": "box"});
            receipts::begin(&connection, id, "remote.host.start", &request, None, at).unwrap();
            let result = json!({"host_id": "box", "outcome": outcome});
            receipts::settle(&connection, id, Status::Settled, Some(&result), at).unwrap();
        }
        ensure_schema(&connection).unwrap();
        ensure_schema(&connection).unwrap();
        let (stored, at) = last_start(&connection, "box").unwrap().unwrap();
        assert_eq!(at, 20);
        assert!(stored.contains("running"));
    }
}
