//! Advisory local TCP listener observation. This does not reserve a port or prove
//! that the process list is complete for the current user.
//!
//! It also holds the pure verdicts that turn an observation into service
//! readiness: whether a listener belongs to a service run's process tree, what
//! was seen on each assigned port, and whether a health probe may run.
//!
//! ADE does not hand services an inherited listening socket. Services are
//! arbitrary programs (`pnpm dev`, Vite, Rails, Django) that bind the port named
//! in their environment; none of the common dev servers accept a passed file
//! descriptor, and the runtime's PTY spawn does not forward extra descriptors.
//! Until a service can opt in to a socket-activation convention, ADE detects a
//! lost bind race after launch instead of preventing it.
use ade_core::contract::services::{PortObservation, ReadinessState};
use anyhow::{Context, Result, bail};
use std::{
    collections::HashSet,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Listener {
    pub pid: u32,
    pub address: String,
    pub port: u16,
    pub family: IpFamily,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum IpFamily {
    V4,
    V6,
}

#[cfg(target_os = "macos")]
pub fn observe() -> Result<Vec<Listener>> {
    // lsof's documented field output is parseable without column-width or
    // localized-header assumptions. A timeout and byte limit bound this read.
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-Fptn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Cannot inspect local TCP listeners")?;
    let stdout = child.stdout.take().context("Listener output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("Listener diagnostics unavailable")?;
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(1_048_577).read_to_end(&mut bytes)?;
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(65_537).read_to_end(&mut bytes)?;
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output_reader.join();
            let _ = error_reader.join();
            bail!("Local listener inspection timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let bytes = output_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Listener reader failed"))??;
    let diagnostics = error_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Listener diagnostics reader failed"))??;
    if bytes.len() > 1_048_576 {
        bail!("Local listener inventory exceeds the supported limit");
    }
    if diagnostics.len() > 65_536 {
        bail!("Local listener diagnostics exceed the supported limit");
    }
    // lsof uses exit status 1 when it finds no matching open files. It also
    // uses nonzero status for inspection failures, which must not look empty.
    if !status.success()
        && !(status.code() == Some(1) && bytes.is_empty() && diagnostics.is_empty())
    {
        let detail = String::from_utf8_lossy(&diagnostics);
        bail!("Local listener inspection failed: {}", detail.trim());
    }
    let output = String::from_utf8(bytes).context("Invalid local listener output")?;
    let mut pid = None;
    let mut family = None;
    let mut listeners = HashSet::new();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
            family = None;
        } else if line.starts_with('f') {
            family = None;
        } else if let Some(value) = line.strip_prefix('t') {
            family = match value {
                "IPv4" => Some(IpFamily::V4),
                "IPv6" => Some(IpFamily::V6),
                _ => None,
            };
        } else if let (Some(process), Some(value)) = (pid, line.strip_prefix('n')) {
            let Some(family) = family else { continue };
            let Some((address, port)) = value.rsplit_once(':') else {
                continue;
            };
            let Ok(port) = port.parse::<u16>() else {
                continue;
            };
            listeners.insert(Listener {
                pid: process,
                address: address
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_owned(),
                port,
                family,
            });
            if listeners.len() > 4096 {
                bail!("Local listener inventory exceeds the supported limit");
            }
        }
    }
    let mut listeners = listeners.into_iter().collect::<Vec<_>>();
    listeners.sort_by(|a, b| (a.port, &a.address, a.pid).cmp(&(b.port, &b.address, b.pid)));
    Ok(listeners)
}

#[cfg(not(target_os = "macos"))]
pub fn observe() -> Result<Vec<Listener>> {
    bail!("Local TCP listener inspection is not available on this host")
}

/// The ancestry facts attribution needs about one live process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessInfo {
    pub ppid: u32,
    pub pgid: u32,
    /// Start time in microseconds since the epoch. A descendant never starts
    /// before its ancestor, which exposes a reused PID in the chain.
    pub started_us: u64,
}

/// Whether a listener process belongs to a service run's process tree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TreeMembership {
    Member,
    NotMember,
    /// A process vanished, a PID was reused or the walk was too deep. Callers
    /// never treat this as owned.
    Unknown,
}

/// Ancestry walks stop here; real service trees are a few levels deep.
const MAX_TREE_DEPTH: usize = 64;

/// Decides whether `pid` belongs to the run whose direct process is `root`.
///
/// A process is a member when it is the root, when the root is among its
/// parents, or when it sits in the process group the live root leads. The
/// runtime starts each service through portable-pty, which calls `setsid`, so
/// the root leads its own group, and a group ID cannot be reused while its
/// leader lives. The group rule keeps a grandchild whose parent exited and left
/// it to launchd. A walk that loses a process or meets a parent that started
/// after its child is `Unknown`.
pub fn tree_membership(
    root: u32,
    pid: u32,
    lookup: impl Fn(u32) -> Option<ProcessInfo>,
) -> TreeMembership {
    if pid == root && root > 1 {
        return TreeMembership::Member;
    }
    if root <= 1 || pid <= 1 {
        return TreeMembership::NotMember;
    }
    let Some(root_info) = lookup(root) else {
        return TreeMembership::Unknown;
    };
    let Some(mut current) = lookup(pid) else {
        return TreeMembership::Unknown;
    };
    if current.started_us < root_info.started_us {
        return TreeMembership::NotMember;
    }
    if root_info.pgid == root && current.pgid == root {
        return TreeMembership::Member;
    }
    for _ in 0..MAX_TREE_DEPTH {
        if current.ppid == root {
            return TreeMembership::Member;
        }
        if current.ppid <= 1 {
            return TreeMembership::NotMember;
        }
        let Some(parent) = lookup(current.ppid) else {
            return TreeMembership::Unknown;
        };
        if parent.started_us > current.started_us {
            return TreeMembership::Unknown;
        }
        if parent.started_us < root_info.started_us {
            // An ancestor older than the run: the chain left the run's tree
            // without passing through its root.
            return TreeMembership::NotMember;
        }
        current = parent;
    }
    TreeMembership::Unknown
}

#[cfg(target_os = "macos")]
fn process_info(pid: u32) -> Option<ProcessInfo> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    let pid_arg = libc::c_int::try_from(pid).ok()?;
    // SAFETY: the buffer is a zeroed proc_bsdinfo of exactly `size` bytes, and
    // proc_pidinfo writes at most `size` bytes into it.
    let written = unsafe {
        libc::proc_pidinfo(
            pid_arg,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: proc_pidinfo filled the whole structure, and every field is plain data.
    let info = unsafe { info.assume_init() };
    (info.pbi_pid == pid).then_some(ProcessInfo {
        ppid: info.pbi_ppid,
        pgid: info.pbi_pgid,
        started_us: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(not(target_os = "macos"))]
fn process_info(_pid: u32) -> Option<ProcessInfo> {
    None
}

/// The one run root among `roots` whose tree holds `pid`, or `None` when no
/// root or more than one does. Only the listener itself, its group leader and
/// its ancestors can be its root, so only those are checked.
pub fn owning_root(
    pid: u32,
    roots: &HashSet<u32>,
    lookup: impl Fn(u32) -> Option<ProcessInfo>,
) -> Option<u32> {
    let mut candidates = vec![pid];
    let mut current = pid;
    for _ in 0..MAX_TREE_DEPTH {
        let Some(info) = lookup(current) else { break };
        if current == pid {
            candidates.push(info.pgid);
        }
        if info.ppid <= 1 || candidates.contains(&info.ppid) {
            break;
        }
        candidates.push(info.ppid);
        current = info.ppid;
    }
    let mut owners = candidates
        .into_iter()
        .filter(|candidate| roots.contains(candidate))
        .collect::<Vec<_>>();
    owners.sort_unstable();
    owners.dedup();
    owners.retain(|root| tree_membership(*root, pid, &lookup) == TreeMembership::Member);
    match owners.as_slice() {
        [root] => Some(*root),
        _ => None,
    }
}

/// [`tree_membership`] against the host's live process table.
pub fn in_service_tree(root: u32, pid: u32) -> bool {
    tree_membership(root, pid, process_info) == TreeMembership::Member
}

/// [`owning_root`] against the host's live process table.
pub fn live_owning_root(pid: u32, roots: &HashSet<u32>) -> Option<u32> {
    owning_root(pid, roots, process_info)
}

/// What was seen on one assigned port, from the listeners on that port.
pub fn port_observation(owned_by_service: bool, held_by_other: bool) -> PortObservation {
    match (owned_by_service, held_by_other) {
        (true, false) => PortObservation::VerifiedManaged,
        (true, true) => PortObservation::Contested,
        (false, true) => PortObservation::ObservedOther,
        (false, false) => PortObservation::Unobserved,
    }
}

/// The readiness verdict for a running service.
///
/// `listens_elsewhere` is true when the service's process tree holds a listener
/// on a port it was not assigned. That is the usual sign that the service lost
/// the bind race for its assigned port and chose another, as Vite does without
/// `strictPort`.
pub fn readiness_verdict(ports: &[PortObservation], listens_elsewhere: bool) -> ReadinessState {
    if ports.is_empty() {
        ReadinessState::UnknownNoPortCheck
    } else if ports.iter().any(|item| {
        matches!(
            item,
            PortObservation::ObservedOther | PortObservation::Contested
        )
    }) {
        ReadinessState::PortConflict
    } else if ports
        .iter()
        .all(|item| *item == PortObservation::VerifiedManaged)
    {
        ReadinessState::TcpListening
    } else if listens_elsewhere {
        ReadinessState::BoundUnassignedPort
    } else {
        ReadinessState::NotObserved
    }
}

/// Why a health probe must not run against an assigned port, or `None` when
/// the service verifiably owns it. A port another process holds, or a service
/// that bound a different port, is unhealthy: a probe would test someone
/// else's server. An unobserved port is unknown, because it may still bind.
pub fn health_gate(
    observation: Option<PortObservation>,
    listens_elsewhere: bool,
) -> Option<serde_json::Value> {
    match observation {
        Some(PortObservation::VerifiedManaged) => None,
        Some(PortObservation::ObservedOther | PortObservation::Contested) => {
            Some(serde_json::json!({"state":"unhealthy","basis":"port_taken_by_other_process"}))
        }
        Some(PortObservation::Unobserved) if listens_elsewhere => {
            Some(serde_json::json!({"state":"unhealthy","basis":"assigned_port_not_bound"}))
        }
        _ => Some(serde_json::json!({"state":"unknown","basis":"managed_listener_unverified"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn membership(rows: &[(u32, u32, u32, u64)], root: u32, pid: u32) -> TreeMembership {
        let rows = rows
            .iter()
            .map(|&(pid, ppid, pgid, started_us)| {
                (
                    pid,
                    ProcessInfo {
                        ppid,
                        pgid,
                        started_us,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        tree_membership(root, pid, |pid| rows.get(&pid).copied())
    }

    #[test]
    fn the_direct_process_is_a_member_without_a_lookup() {
        assert_eq!(membership(&[], 500, 500), TreeMembership::Member);
    }

    #[test]
    fn a_grandchild_through_live_parents_is_a_member() {
        // pnpm (500) -> node (501) -> worker (502), each in its own group.
        let rows = [(500, 1, 400, 10), (501, 500, 501, 11), (502, 501, 502, 12)];
        assert_eq!(membership(&rows, 500, 502), TreeMembership::Member);
    }

    #[test]
    fn an_orphan_in_the_leaders_group_is_a_member() {
        // The parent exited and launchd adopted the listener; the group remains.
        let rows = [(500, 1, 500, 10), (502, 1, 500, 12)];
        assert_eq!(membership(&rows, 500, 502), TreeMembership::Member);
    }

    #[test]
    fn a_group_match_needs_the_root_to_lead_that_group() {
        let rows = [(500, 1, 400, 10), (502, 1, 500, 12)];
        assert_eq!(membership(&rows, 500, 502), TreeMembership::NotMember);
    }

    #[test]
    fn an_unrelated_process_is_not_a_member() {
        let rows = [(500, 1, 500, 10), (650, 1, 650, 5), (700, 650, 700, 20)];
        assert_eq!(membership(&rows, 500, 700), TreeMembership::NotMember);
    }

    #[test]
    fn a_listener_older_than_the_run_is_not_a_member() {
        let rows = [(500, 1, 400, 10), (700, 500, 700, 5)];
        assert_eq!(membership(&rows, 500, 700), TreeMembership::NotMember);
    }

    #[test]
    fn a_vanished_process_or_reused_parent_is_unknown() {
        assert_eq!(
            membership(&[(500, 1, 500, 10)], 500, 700),
            TreeMembership::Unknown
        );
        assert_eq!(
            membership(&[(700, 1, 700, 20)], 500, 700),
            TreeMembership::Unknown
        );
        // 600 names 650 as its parent, but 650 started later: a reused PID.
        let rows = [(500, 1, 400, 10), (600, 650, 600, 20), (650, 500, 650, 30)];
        assert_eq!(membership(&rows, 500, 600), TreeMembership::Unknown);
    }

    #[test]
    fn a_parent_cycle_ends_as_unknown() {
        let rows = [(500, 1, 400, 10), (600, 601, 600, 20), (601, 600, 601, 20)];
        assert_eq!(membership(&rows, 500, 600), TreeMembership::Unknown);
    }

    #[test]
    fn init_never_joins_or_roots_a_tree() {
        let rows = [(500, 1, 500, 10), (1, 0, 1, 0)];
        assert_eq!(membership(&rows, 500, 1), TreeMembership::NotMember);
        assert_eq!(membership(&rows, 1, 500), TreeMembership::NotMember);
        assert_eq!(membership(&rows, 1, 1), TreeMembership::NotMember);
    }

    #[test]
    fn a_listener_is_owned_by_exactly_one_run_root() {
        let rows = [
            (500, 1, 500, 10),
            (501, 500, 501, 11),
            (502, 501, 502, 12),
            (600, 1, 600, 10),
            (650, 1, 650, 5),
            (700, 650, 700, 20),
        ]
        .iter()
        .map(|&(pid, ppid, pgid, started_us)| {
            (
                pid,
                ProcessInfo {
                    ppid,
                    pgid,
                    started_us,
                },
            )
        })
        .collect::<HashMap<_, _>>();
        let lookup = |pid| rows.get(&pid).copied();
        let roots = HashSet::from([500, 600]);
        assert_eq!(owning_root(502, &roots, lookup), Some(500));
        assert_eq!(owning_root(600, &roots, lookup), Some(600));
        assert_eq!(owning_root(700, &roots, lookup), None);
        assert_eq!(owning_root(999, &roots, lookup), None);
        // A listener whose chain passes through two recorded roots is ambiguous.
        let nested = HashSet::from([500, 501]);
        assert_eq!(owning_root(502, &nested, lookup), None);
    }

    #[test]
    fn port_observation_covers_each_combination() {
        assert_eq!(
            port_observation(true, false),
            PortObservation::VerifiedManaged
        );
        assert_eq!(port_observation(true, true), PortObservation::Contested);
        assert_eq!(
            port_observation(false, true),
            PortObservation::ObservedOther
        );
        assert_eq!(port_observation(false, false), PortObservation::Unobserved);
    }

    #[test]
    fn readiness_is_listening_only_when_every_port_is_verified() {
        use PortObservation::*;
        assert_eq!(
            readiness_verdict(&[], true),
            ReadinessState::UnknownNoPortCheck
        );
        assert_eq!(
            readiness_verdict(&[VerifiedManaged, VerifiedManaged], true),
            ReadinessState::TcpListening
        );
        assert_eq!(
            readiness_verdict(&[VerifiedManaged, Unobserved], false),
            ReadinessState::NotObserved
        );
        assert_eq!(
            readiness_verdict(&[VerifiedManaged, Unobserved], true),
            ReadinessState::BoundUnassignedPort
        );
        for conflict in [ObservedOther, Contested] {
            assert_eq!(
                readiness_verdict(&[VerifiedManaged, conflict], true),
                ReadinessState::PortConflict
            );
        }
    }

    #[test]
    fn health_probes_only_a_verified_port() {
        use PortObservation::*;
        assert_eq!(health_gate(Some(VerifiedManaged), true), None);
        for taken in [ObservedOther, Contested] {
            assert_eq!(
                health_gate(Some(taken), false).unwrap(),
                serde_json::json!({"state":"unhealthy","basis":"port_taken_by_other_process"})
            );
        }
        assert_eq!(
            health_gate(Some(Unobserved), true).unwrap(),
            serde_json::json!({"state":"unhealthy","basis":"assigned_port_not_bound"})
        );
        assert_eq!(
            health_gate(Some(Unobserved), false).unwrap()["state"],
            "unknown"
        );
        assert_eq!(health_gate(None, true).unwrap()["state"], "unknown");
    }
}
