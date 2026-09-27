//! Pure decisions for SSH bootstrap of a remote host (F124, D13).
//!
//! The host-key decision, the `ssh` argument list, the remote probe and the
//! compatibility and start-outcome classifications live here so that they can
//! be tested without a network. `sessions::remote` runs the processes and owns
//! storage.
//!
//! Host identity is pinned, never learned: a key is accepted only when its
//! OpenSSH SHA-256 fingerprint equals the one the user supplied, and every
//! later connection runs `ssh` with a one-line known-hosts file holding that
//! key, strict checking, no agent forwarding and no shared control master.
//! The SSH failure classification follows the pattern of Herdr's
//! `ssh_error_requires_authentication` (herdr/src/remote/attach.rs, Apache-2.0).
use ade_core::contract::remote::{
    BackendCompatibility, RemoteDaemon, RemotePlatform, StartOutcome, TokenReference,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Host key algorithms ADE accepts for pinning.
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
];

/// Remote operating systems whose ADE backend can run.
const SUPPORTED_OS: &[&str] = &["Darwin", "Linux"];

/// Seconds `ssh` waits for the TCP connection and key exchange.
pub const CONNECT_TIMEOUT_SECONDS: u32 = 15;

/// A parsed SSH public key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostKey {
    pub key_type: String,
    pub blob: Vec<u8>,
}

impl HostKey {
    /// OpenSSH's `SHA256:` fingerprint of the key blob.
    pub fn fingerprint(&self) -> String {
        format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(&self.blob))
        )
    }

    /// The `type base64` form stored in the registry.
    pub fn public_line(&self) -> String {
        format!("{} {}", self.key_type, STANDARD.encode(&self.blob))
    }

    /// A known-hosts line that matches only `alias`.
    pub fn known_hosts_line(&self, alias: &str) -> String {
        format!("{alias} {}\n", self.public_line())
    }

    /// The `HostKeyAlgorithms` value that makes `ssh` ask for this key type.
    pub fn algorithms(&self) -> &'static str {
        match self.key_type.as_str() {
            "ssh-ed25519" => "ssh-ed25519",
            "ecdsa-sha2-nistp256" => "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384" => "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521" => "ecdsa-sha2-nistp521",
            // An RSA key is verified with SHA-2 signatures only.
            _ => "rsa-sha2-512,rsa-sha2-256",
        }
    }
}

/// Parses `type base64 [comment]`. The blob must name the same key type.
pub fn parse_public_key(line: &str) -> Result<HostKey> {
    let mut fields = line.split_whitespace();
    let key_type = fields.next().context("Host public key is empty")?;
    ensure!(
        KEY_TYPES.contains(&key_type),
        "Host key type {key_type} is not supported; use ed25519, ECDSA or RSA"
    );
    let encoded = fields.next().context("Host public key has no key data")?;
    let blob = STANDARD
        .decode(encoded)
        .context("Host public key data is not base64")?;
    let length = blob
        .get(..4)
        .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .context("Host public key data is truncated")?;
    ensure!(
        blob.get(4..4 + length) == Some(key_type.as_bytes()),
        "Host public key data does not match its type {key_type}"
    );
    Ok(HostKey {
        key_type: key_type.to_owned(),
        blob,
    })
}

/// The keys in `ssh-keyscan` output (`host type base64` lines). Lines that do
/// not parse are skipped; only an exact fingerprint match is ever accepted.
pub fn parse_keyscan(output: &str) -> Vec<HostKey> {
    output
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| {
            let (_host, key) = line.trim().split_once(char::is_whitespace)?;
            parse_public_key(key).ok()
        })
        .collect()
}

/// Normalizes a user-supplied `SHA256:` fingerprint. Other formats are refused.
pub fn normalize_fingerprint(input: &str) -> Result<String> {
    let text = input.trim();
    let digest = text
        .strip_prefix("SHA256:")
        .context("Fingerprint must be an OpenSSH SHA256: fingerprint (ssh-keygen -lf)")?
        .trim_end_matches('=');
    let bytes = STANDARD_NO_PAD
        .decode(digest)
        .context("Fingerprint is not base64")?;
    ensure!(bytes.len() == 32, "Fingerprint is not a SHA-256 digest");
    Ok(format!("SHA256:{digest}"))
}

/// The host-key decision: the key whose fingerprint equals `expected`, or an
/// error listing what the host presented. Never trusts on first use.
pub fn select_pinned(keys: &[HostKey], expected: &str) -> Result<HostKey> {
    let expected = normalize_fingerprint(expected)?;
    if let Some(key) = keys.iter().find(|key| key.fingerprint() == expected) {
        return Ok(key.clone());
    }
    if keys.is_empty() {
        bail!("The host presented no supported host key; nothing was recorded");
    }
    let presented = keys
        .iter()
        .map(|key| format!("{} {}", key.key_type, key.fingerprint()))
        .collect::<Vec<_>>()
        .join(", ");
    bail!(
        "No host key matches {expected}; the host presented {presented}. Nothing was recorded. \
         Compare them with the host's own `ssh-keygen -lf` output before trusting any."
    )
}

/// Registry host IDs: lowercase letters, digits and `-`, 1 to 64 characters.
pub fn validate_host_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && !id.starts_with('-')
            && id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "Host ID must be 1 to 64 lowercase letters, digits or '-'"
    );
    // `local` names this machine in placement; a remote host never takes it.
    ensure!(id != "local", "Host ID local is reserved for this machine");
    Ok(())
}

/// An SSH destination that `ssh` cannot read as an option or split.
pub fn validate_target(target: &str) -> Result<()> {
    ensure!(
        !target.is_empty()
            && target.len() <= 255
            && !target.starts_with('-')
            && !target
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\'' | '"' | '\\')),
        "SSH target must be an alias or user@host without spaces, quotes or a leading '-'"
    );
    Ok(())
}

/// An absolute remote path with no control characters.
pub fn validate_remote_path(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/') && path.len() <= 1024 && !path.chars().any(char::is_control),
        "Backend path must be an absolute path on the remote host"
    );
    Ok(())
}

/// Remote profile IDs are the UUIDs `ade-control profiles` assigns.
pub fn validate_profile_id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "Remote profile ID must be a UUID from `ade-control profiles list`"
    );
    Ok(())
}

pub fn validate_label(label: &str) -> Result<()> {
    ensure!(
        !label.trim().is_empty()
            && label.chars().count() <= 80
            && !label.chars().any(char::is_control),
        "Label must contain 1 to 80 characters"
    );
    Ok(())
}

/// A token reference names where the token lives and never holds it.
pub fn validate_token_reference(reference: &TokenReference) -> Result<()> {
    match reference {
        TokenReference::Env(name) => ensure!(
            !name.is_empty()
                && name.len() <= 128
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
            "Token environment variable must be an uppercase name such as ADE_HOST_TOKEN"
        ),
        TokenReference::Keychain { service, account } => ensure!(
            [service, account].iter().all(|part| !part.is_empty()
                && part.len() <= 256
                && !part.chars().any(char::is_control)),
            "Keychain service and account must be 1 to 256 characters"
        ),
    }
    Ok(())
}

/// The known-hosts alias that ties one registry host to its pinned key.
pub fn host_key_alias(host_id: &str) -> String {
    format!("ade-remote-{host_id}")
}

/// The `ssh` arguments for one remote command against the pinned key. The
/// user's SSH config still supplies user, identity and proxy settings, but
/// command-line options win: host checking is strict against only the pinned
/// key, and no agent, forwarding or existing control master is used.
pub fn ssh_args(
    target: &str,
    known_hosts: &str,
    alias: &str,
    key: &HostKey,
    remote_command: &str,
) -> Result<Vec<String>> {
    validate_target(target)?;
    ensure!(
        !known_hosts
            .chars()
            .any(|c| c.is_whitespace() || c.is_control()),
        "Known-hosts path contains whitespace"
    );
    let options = [
        "BatchMode=yes".to_owned(),
        "StrictHostKeyChecking=yes".to_owned(),
        format!("UserKnownHostsFile={known_hosts}"),
        "GlobalKnownHostsFile=/dev/null".to_owned(),
        "KnownHostsCommand=none".to_owned(),
        format!("HostKeyAlias={alias}"),
        format!("HostKeyAlgorithms={}", key.algorithms()),
        "UpdateHostKeys=no".to_owned(),
        "CheckHostIP=no".to_owned(),
        "VerifyHostKeyDNS=no".to_owned(),
        "ControlMaster=no".to_owned(),
        "ControlPath=none".to_owned(),
        "ForwardAgent=no".to_owned(),
        "ForwardX11=no".to_owned(),
        "ClearAllForwardings=yes".to_owned(),
        "PermitLocalCommand=no".to_owned(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"),
        "ServerAliveInterval=15".to_owned(),
        "ServerAliveCountMax=2".to_owned(),
    ];
    let mut args = Vec::with_capacity(options.len() * 2 + 4);
    for option in options {
        args.push("-o".to_owned());
        args.push(option);
    }
    args.extend([
        "-T".to_owned(),
        "--".to_owned(),
        target.to_owned(),
        remote_command.to_owned(),
    ]);
    Ok(args)
}

/// The host and port `ssh -G` resolves a target to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub hostname: String,
    pub port: u16,
    /// True when a ProxyJump or ProxyCommand applies; `ssh-keyscan` cannot follow it.
    pub proxied: bool,
}

pub fn parse_ssh_config(output: &str) -> Result<ResolvedTarget> {
    let mut hostname = None;
    let mut port = 22;
    let mut proxied = false;
    for line in output.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else {
            continue;
        };
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "hostname" => hostname = Some(value.to_owned()),
            "port" => port = value.parse().context("ssh -G reported an invalid port")?,
            "proxyjump" | "proxycommand" if value != "none" => proxied = true,
            _ => {}
        }
    }
    let hostname = hostname.context("ssh -G reported no hostname")?;
    ensure!(
        !hostname.is_empty()
            && !hostname.starts_with('-')
            && !hostname.contains(char::is_whitespace),
        "ssh -G reported an unusable hostname"
    );
    Ok(ResolvedTarget {
        hostname,
        port,
        proxied,
    })
}

/// Single-quotes a word for POSIX `sh`.
pub fn sh_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// The script the remote `/bin/sh -s` runs to describe its backend. It reads
/// and runs `ade-control version` only; it writes nothing.
pub fn probe_script(backend_path: Option<&str>) -> String {
    let locate = match backend_path {
        Some(path) => format!("ctl={}", sh_quote(path)),
        None => "ctl=$(command -v ade-control 2>/dev/null || true)".to_owned(),
    };
    format!(
        "set -u
printf 'ade-probe=1\\n'
printf 'os=%s\\n' \"$(uname -s)\"
printf 'arch=%s\\n' \"$(uname -m)\"
{locate}
printf 'control=%s\\n' \"$ctl\"
if [ -z \"$ctl\" ]; then exit 0; fi
if [ -f \"$ctl\" ] && [ -x \"$ctl\" ]; then printf 'control_executable=1\\n'; else printf 'control_executable=0\\n'; exit 0; fi
printf 'version=%s\\n' \"$(\"$ctl\" version 2>/dev/null | head -n 1)\"
"
    )
}

/// What the probe script printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProbeReport {
    pub os: String,
    pub arch: String,
    pub control: Option<String>,
    pub control_executable: bool,
    pub version: Option<String>,
}

/// Reads the probe's `key=value` lines after its marker. Shell start-up noise
/// before the marker is ignored; a missing marker fails closed.
pub fn parse_probe(stdout: &str) -> Result<ProbeReport> {
    let mut lines = stdout.lines().skip_while(|line| *line != "ade-probe=1");
    ensure!(
        lines.next().is_some(),
        "The remote shell did not run the probe"
    );
    let mut report = ProbeReport::default();
    let mut seen = std::collections::HashSet::new();
    for line in lines {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !seen.insert(key.to_owned()) {
            continue;
        }
        let value = value.trim();
        match key {
            "os" => report.os = value.to_owned(),
            "arch" => report.arch = value.to_owned(),
            "control" => report.control = (!value.is_empty()).then(|| value.to_owned()),
            "control_executable" => report.control_executable = value == "1",
            "version" => report.version = (!value.is_empty()).then(|| value.to_owned()),
            _ => {}
        }
    }
    ensure!(
        !report.os.is_empty(),
        "The remote probe did not report an operating system"
    );
    Ok(report)
}

/// The compatibility decision for a probed backend. Every gap is named; none
/// is filled by installing anything.
pub fn compatibility(
    report: &ProbeReport,
    backend_path: Option<&str>,
    application_protocol: &str,
    runtime_protocol: &str,
) -> (RemotePlatform, BackendCompatibility) {
    let platform = RemotePlatform {
        os: report.os.clone(),
        arch: report.arch.clone(),
    };
    let mut missing = Vec::new();
    let mut incompatible = Vec::new();
    let mut versions = (None, None);
    if !SUPPORTED_OS.contains(&report.os.as_str()) {
        incompatible.push(format!(
            "operating system {} is not supported; ADE runs on Darwin or Linux",
            report.os
        ));
    }
    match (&report.control, backend_path) {
        (None, None) => missing.push(
            "ade-control is not on the remote non-interactive PATH; install it or set backend_path"
                .to_owned(),
        ),
        (None, Some(path)) => missing.push(format!("ade-control at {path}")),
        (Some(path), _) if !report.control_executable => {
            missing.push(format!("an executable ade-control at {path}"))
        }
        (Some(path), _) => match report.version.as_deref().map(serde_json::from_str::<Value>) {
            Some(Ok(version)) if version["type"] == "backend_version" => {
                let application = version["application_protocol"].as_str().map(str::to_owned);
                let runtime = version["runtime_protocol"].as_str().map(str::to_owned);
                if application.as_deref() != Some(application_protocol) {
                    incompatible.push(format!(
                        "application protocol {}, expected {application_protocol}",
                        application.as_deref().unwrap_or("unknown")
                    ));
                }
                if runtime.as_deref() != Some(runtime_protocol) {
                    incompatible.push(format!(
                        "runtime protocol {}, expected {runtime_protocol}",
                        runtime.as_deref().unwrap_or("unknown")
                    ));
                }
                for artifact in ["ade-daemon", "ade-runtime"] {
                    if version["artifacts"][artifact] != true {
                        missing.push(format!("an executable {artifact} beside {path}"));
                    }
                }
                versions = (application, runtime);
            }
            _ => missing.push(format!(
                "`{path} version`; the remote backend predates remote bootstrap"
            )),
        },
    }
    (
        platform,
        BackendCompatibility {
            compatible: missing.is_empty() && incompatible.is_empty(),
            control_path: report.control.clone(),
            application_protocol: versions.0,
            runtime_protocol: versions.1,
            missing,
            incompatible,
        },
    )
}

/// The script that starts the remote profile daemon, or attaches to the one
/// running, through the `ade-control` the probe verified.
pub fn start_script(control_path: &str, profile_id: Option<&str>) -> String {
    let profile = profile_id
        .map(|id| format!(" {}", sh_quote(id)))
        .unwrap_or_default();
    format!("exec {} profiles start{profile}\n", sh_quote(control_path))
}

/// How a finished (or abandoned) `ssh` process ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Finished {
    /// The exit code; `None` when a signal ended it or it was killed.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Whether `ssh` failed before any remote command could run.
pub fn failed_before_session(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    [
        "host key verification failed",
        "remote host identification has changed",
        "no matching host key type",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "no route to host",
        "network is unreachable",
        "permission denied (",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

/// Whether the host failed the pinned key check.
pub fn host_key_rejected(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("host key verification failed")
        || text.contains("remote host identification has changed")
        || text.contains("no matching host key type")
}

/// The first line of `ssh` or `ade-control` diagnostics, bounded for replies.
pub fn diagnostic(stderr: &str) -> String {
    let message = stderr
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_owned))
        })
        .or_else(|| {
            stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "no diagnostic".to_owned());
    message.chars().take(400).collect()
}

/// `ade-control profiles start` refusals that happen before it launches anything.
const REFUSED_BEFORE_LAUNCH: &[&str] = &[
    "No profile is selected",
    "Profile ID is not registered on this host",
    "Another process owns",
    "Existing daemon cannot hand off this runtime",
];

/// The start decision. Success needs a compatible daemon identity; anything
/// that might have launched a process without proving it is unknown.
pub fn classify_start(
    finished: &Finished,
    application_protocol: &str,
    runtime_protocol: &str,
) -> (StartOutcome, Option<String>, Option<RemoteDaemon>) {
    let unknown = |detail: String| (StartOutcome::Unknown, Some(detail), None);
    let failed = |detail: String| (StartOutcome::Failed, Some(detail), None);
    if finished.timed_out {
        return unknown(
            "ssh did not finish in time; the remote daemon may be running. Probe the host before retrying"
                .to_owned(),
        );
    }
    match finished.code {
        None => unknown("ssh ended without an exit status; probe the host before retrying".to_owned()),
        Some(0) => match parse_started(&finished.stdout) {
            Ok(daemon)
                if daemon.application_protocol == application_protocol
                    && daemon.runtime_protocol == runtime_protocol =>
            {
                (StartOutcome::Running, None, Some(daemon))
            }
            Ok(daemon) => (
                StartOutcome::Failed,
                Some(format!(
                    "The remote daemon speaks {} / {}, expected {application_protocol} / {runtime_protocol}; it was left running",
                    daemon.application_protocol, daemon.runtime_protocol
                )),
                None,
            ),
            Err(error) => unknown(format!(
                "The remote reply could not be read ({error}); the daemon may be running"
            )),
        },
        Some(255) if host_key_rejected(&finished.stderr) => failed(
            "The host did not present the pinned key; nothing ran on it. Verify a rotated key out of band, then remove and re-add the host"
                .to_owned(),
        ),
        Some(255) if failed_before_session(&finished.stderr) => failed(format!(
            "ssh could not connect; nothing ran: {}",
            diagnostic(&finished.stderr)
        )),
        Some(127) => failed(format!("ade-control could not run: {}", diagnostic(&finished.stderr))),
        Some(_) => {
            let message = diagnostic(&finished.stderr);
            if REFUSED_BEFORE_LAUNCH
                .iter()
                .any(|prefix| message.starts_with(prefix))
            {
                failed(message)
            } else {
                unknown(format!("{message}; probe the host before retrying"))
            }
        }
    }
}

/// Reads `ade-control profiles start` output.
fn parse_started(stdout: &str) -> Result<RemoteDaemon> {
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .context("no JSON reply")?;
    let reply: Value = serde_json::from_str(line)?;
    ensure!(reply["type"] == "profile_started", "unexpected reply type");
    let text = |value: &Value, name: &str| -> Result<String> {
        value
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .with_context(|| format!("missing {name}"))
    };
    let daemon = &reply["daemon"];
    Ok(RemoteDaemon {
        profile_id: text(&reply["profile"]["id"], "profile ID")?,
        socket: text(&reply["socket"], "socket")?,
        boot_id: text(&daemon["boot_id"], "boot ID")?,
        pid: daemon["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .context("missing pid")?,
        build_id: daemon["build_id"].as_str().map(str::to_owned),
        application_protocol: text(&daemon["application_protocol"], "application protocol")?,
        runtime_protocol: text(&daemon["runtime_protocol"], "runtime protocol")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIVO8CLyE1GFZ94uSXokPZM7Jqo2H/D9LUFC9IiYYjan test";

    fn ed25519() -> HostKey {
        parse_public_key(ED25519).unwrap()
    }

    fn key(key_type: &str, body: &[u8]) -> HostKey {
        let mut blob = (key_type.len() as u32).to_be_bytes().to_vec();
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(body);
        HostKey {
            key_type: key_type.to_owned(),
            blob,
        }
    }

    #[test]
    fn fingerprints_match_openssh() {
        // `ssh-keygen -lf` prints this fingerprint for ED25519.
        assert_eq!(
            ed25519().fingerprint(),
            "SHA256:IXTmr1kZ17AkVE0WfwjIP7YwJcnzY0K+UiY17p2W3Oo"
        );
        assert_eq!(
            parse_public_key(&ed25519().public_line()).unwrap(),
            ed25519()
        );
        assert_eq!(
            ed25519().known_hosts_line("ade-remote-a"),
            format!("ade-remote-a {}\n", ed25519().public_line())
        );
    }

    #[test]
    fn malformed_or_unsupported_keys_are_refused() {
        assert!(parse_public_key("ssh-dss AAAA").is_err());
        assert!(parse_public_key("ssh-ed25519").is_err());
        assert!(parse_public_key("ssh-ed25519 !!!").is_err());
        let rsa_blob = STANDARD.encode(&key("ssh-rsa", b"x").blob);
        assert!(parse_public_key(&format!("ssh-ed25519 {rsa_blob}")).is_err());
        assert!(parse_public_key(&format!("ssh-rsa {rsa_blob}")).is_ok());
    }

    #[test]
    fn fingerprints_are_normalized_and_other_formats_refused() {
        let fingerprint = ed25519().fingerprint();
        assert_eq!(
            normalize_fingerprint(&format!(" {fingerprint}= ")).unwrap(),
            fingerprint
        );
        assert!(normalize_fingerprint("MD5:12:34").is_err());
        assert!(normalize_fingerprint("SHA256:abcd").is_err());
    }

    #[test]
    fn the_pinned_key_is_the_one_matching_the_expected_fingerprint() {
        let rsa = key("ssh-rsa", b"rsa");
        let keys = vec![rsa.clone(), ed25519()];
        assert_eq!(
            select_pinned(&keys, &ed25519().fingerprint()).unwrap(),
            ed25519()
        );
        assert_eq!(select_pinned(&keys, &rsa.fingerprint()).unwrap(), rsa);
        let error =
            select_pinned(std::slice::from_ref(&rsa), &ed25519().fingerprint()).unwrap_err();
        assert!(error.to_string().contains(&rsa.fingerprint()));
        assert!(error.to_string().contains("Nothing was recorded"));
        assert!(select_pinned(&[], &ed25519().fingerprint()).is_err());
    }

    #[test]
    fn keyscan_lines_are_read_and_comments_skipped() {
        let output = format!("# devbox:22 SSH-2.0-OpenSSH_9.6\ndevbox {ED25519}\ngarbage\n");
        assert_eq!(parse_keyscan(&output), vec![ed25519()]);
    }

    #[test]
    fn ssh_arguments_pin_the_key_and_keep_the_target_last() {
        let args = ssh_args(
            "me@devbox",
            "/tmp/kh",
            "ade-remote-devbox",
            &ed25519(),
            "/bin/sh -s",
        )
        .unwrap();
        for option in [
            "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=/tmp/kh",
            "GlobalKnownHostsFile=/dev/null",
            "HostKeyAlias=ade-remote-devbox",
            "HostKeyAlgorithms=ssh-ed25519",
            "BatchMode=yes",
            "ForwardAgent=no",
            "ControlPath=none",
        ] {
            let index = args.iter().position(|arg| arg == option).unwrap();
            assert_eq!(args[index - 1], "-o");
        }
        assert_eq!(&args[args.len() - 3..], ["--", "me@devbox", "/bin/sh -s"]);
        assert!(ssh_args("-oProxyCommand=x", "/tmp/kh", "a", &ed25519(), "c").is_err());
        assert!(ssh_args("devbox", "/tmp/a b", "a", &ed25519(), "c").is_err());
        assert_eq!(
            key("ssh-rsa", b"x").algorithms(),
            "rsa-sha2-512,rsa-sha2-256"
        );
    }

    #[test]
    fn identifiers_and_token_references_are_validated() {
        assert!(validate_host_id("dev-box-2").is_ok());
        assert!(validate_host_id("Dev").is_err());
        assert!(validate_host_id("-x").is_err());
        assert!(validate_host_id("local").is_err());
        assert!(validate_target("me@devbox").is_ok());
        assert!(validate_target("me@devbox; rm").is_err());
        assert!(validate_remote_path("/opt/ade/bin/ade-control").is_ok());
        assert!(validate_remote_path("ade-control").is_err());
        assert!(validate_profile_id("not-a-uuid").is_err());
        assert!(validate_token_reference(&TokenReference::Env("ADE_TOKEN".into())).is_ok());
        assert!(validate_token_reference(&TokenReference::Env("ghp_secret".into())).is_err());
        assert!(
            validate_token_reference(&TokenReference::Keychain {
                service: "ade".into(),
                account: String::new()
            })
            .is_err()
        );
    }

    #[test]
    fn ssh_config_resolution_reports_proxies() {
        let plain = parse_ssh_config("user me\nhostname 10.0.0.5\nport 2222\n").unwrap();
        assert_eq!(
            plain,
            ResolvedTarget {
                hostname: "10.0.0.5".into(),
                port: 2222,
                proxied: false
            }
        );
        assert!(
            parse_ssh_config("hostname h\nport 22\nproxyjump bastion\n")
                .unwrap()
                .proxied
        );
        assert!(
            !parse_ssh_config("hostname h\nproxycommand none\n")
                .unwrap()
                .proxied
        );
        assert!(parse_ssh_config("port 22\n").is_err());
    }

    #[test]
    fn scripts_quote_remote_paths() {
        assert_eq!(sh_quote("a'b"), r"'a'\''b'");
        assert!(
            probe_script(Some("/opt/it's/ade-control")).contains(r"ctl='/opt/it'\''s/ade-control'")
        );
        assert!(probe_script(None).contains("command -v ade-control"));
        assert_eq!(
            start_script("/opt/ade/ade-control", Some("p1")),
            "exec '/opt/ade/ade-control' profiles start 'p1'\n"
        );
        assert_eq!(
            start_script("/opt/ade/ade-control", None),
            "exec '/opt/ade/ade-control' profiles start\n"
        );
    }

    fn version(application: &str, runtime: &str, daemon: bool) -> String {
        json!({"type": "backend_version", "application_protocol": application,
            "runtime_protocol": runtime, "artifacts": {"ade-daemon": daemon, "ade-runtime": true}})
        .to_string()
    }

    fn probe(stdout: &str) -> BackendCompatibility {
        compatibility(&parse_probe(stdout).unwrap(), None, "app-v1", "rt-v8").1
    }

    #[test]
    fn a_compatible_backend_is_reported_compatible() {
        let stdout = format!(
            "motd noise\nade-probe=1\nos=Linux\narch=x86_64\ncontrol=/opt/ade/ade-control\ncontrol_executable=1\nversion={}\n",
            version("app-v1", "rt-v8", true)
        );
        let backend = probe(&stdout);
        assert!(backend.compatible, "{backend:?}");
        assert_eq!(
            backend.control_path.as_deref(),
            Some("/opt/ade/ade-control")
        );
        assert_eq!(backend.runtime_protocol.as_deref(), Some("rt-v8"));
    }

    #[test]
    fn every_gap_is_named_exactly() {
        let missing = probe("ade-probe=1\nos=Linux\narch=aarch64\ncontrol=\n");
        assert!(!missing.compatible);
        assert!(missing.missing[0].contains("not on the remote non-interactive PATH"));

        let configured = compatibility(
            &parse_probe("ade-probe=1\nos=Linux\narch=x\ncontrol=\n").unwrap(),
            Some("/opt/ade-control"),
            "a",
            "r",
        )
        .1;
        assert_eq!(configured.missing, ["ade-control at /opt/ade-control"]);

        let old = probe(
            "ade-probe=1\nos=Darwin\narch=arm64\ncontrol=/c\ncontrol_executable=1\nversion=\n",
        );
        assert!(old.missing[0].contains("predates remote bootstrap"));

        let stale = probe(&format!(
            "ade-probe=1\nos=Darwin\narch=arm64\ncontrol=/c\ncontrol_executable=1\nversion={}\n",
            version("app-v0", "rt-v8", false)
        ));
        assert_eq!(
            stale.incompatible,
            ["application protocol app-v0, expected app-v1"]
        );
        assert_eq!(stale.missing, ["an executable ade-daemon beside /c"]);

        let windows = probe("ade-probe=1\nos=MINGW64\narch=x\ncontrol=/c\ncontrol_executable=0\n");
        assert!(windows.incompatible[0].contains("MINGW64"));
        assert_eq!(windows.missing, ["an executable ade-control at /c"]);

        assert!(parse_probe("hello\n").is_err());
        assert!(parse_probe("ade-probe=1\n").is_err());
    }

    fn finished(code: Option<i32>, stdout: &str, stderr: &str) -> Finished {
        Finished {
            code,
            timed_out: false,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    fn started(application: &str) -> String {
        json!({"type": "profile_started", "profile": {"id": "p1"}, "socket": "/r/ade.sock",
            "daemon": {"boot_id": "b1", "pid": 42, "build_id": "abc",
                "application_protocol": application, "runtime_protocol": "rt-v8"}})
        .to_string()
    }

    #[test]
    fn only_a_compatible_daemon_identity_counts_as_running() {
        let (outcome, _, daemon) = classify_start(
            &finished(Some(0), &started("app-v1"), ""),
            "app-v1",
            "rt-v8",
        );
        assert_eq!(outcome, StartOutcome::Running);
        assert_eq!(daemon.unwrap().boot_id, "b1");

        let (outcome, detail, _) = classify_start(
            &finished(Some(0), &started("app-v0"), ""),
            "app-v1",
            "rt-v8",
        );
        assert_eq!(outcome, StartOutcome::Failed);
        assert!(detail.unwrap().contains("left running"));

        let (outcome, ..) = classify_start(
            &finished(Some(0), "{\"type\":\"other\"}", ""),
            "app-v1",
            "rt-v8",
        );
        assert_eq!(outcome, StartOutcome::Unknown);
    }

    #[test]
    fn failures_are_failed_only_when_nothing_can_have_started() {
        let cases = [
            (
                Some(255),
                "Host key verification failed.",
                StartOutcome::Failed,
            ),
            (
                Some(255),
                "ssh: connect to host h port 22: Connection refused",
                StartOutcome::Failed,
            ),
            (
                Some(255),
                "Connection to h closed by remote host.",
                StartOutcome::Unknown,
            ),
            (
                Some(127),
                "sh: ade-control: not found",
                StartOutcome::Failed,
            ),
            (
                Some(1),
                r#"{"type":"error","message":"No profile is selected"}"#,
                StartOutcome::Failed,
            ),
            (
                Some(1),
                r#"{"type":"error","message":"Daemon is not ready; see log"}"#,
                StartOutcome::Unknown,
            ),
            (None, "", StartOutcome::Unknown),
        ];
        for (code, stderr, expected) in cases {
            assert_eq!(
                classify_start(&finished(code, "", stderr), "a", "r").0,
                expected,
                "{stderr}"
            );
        }
        let timed_out = Finished {
            timed_out: true,
            code: Some(0),
            ..Default::default()
        };
        assert_eq!(
            classify_start(&timed_out, "a", "r").0,
            StartOutcome::Unknown
        );
    }
}
