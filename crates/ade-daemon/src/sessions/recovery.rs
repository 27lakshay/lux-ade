//! Runtime restart reconciliation: the pure classifier.
//!
//! When the daemon finds a runtime incarnation other than the one that owned
//! durable work, every attempt the old incarnation owned is classified from
//! evidence as `Settled`, `Quarantined` or `Unknown`. The rules are written
//! down in `docs/proposed-architecture.md`, section 4, "Runtime restart
//! reconciliation". This module holds only decisions over observations; the
//! reads live in `restart.rs`.
//!
//! The verdict vocabulary follows Orca's `src/shared/pty-liveness-verdict.ts`
//! (MIT, studied, not copied): exit needs positive evidence of absence, and
//! losing the observer is never proof of exit.
use ade_core::contract::daemon::{RecoveredAttemptKind, RecoveryClassification};
use ade_runtime::descendants::Row;

/// What the daemon knows about who owned one durable lease.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Ownership {
    /// An earlier report left it open.
    pub open: bool,
    /// At least one earlier incarnation has not been reconciled.
    pub restarted: bool,
    /// The current runtime reports it with a matching identity.
    pub live_now: bool,
    /// Its durable record names a runtime incarnation other than the current one.
    pub old_instance_recorded: bool,
    /// The daemon has never owned the current runtime incarnation before, so
    /// nothing durable can belong to it.
    pub fresh_runtime: bool,
    /// An earlier incarnation recorded its process.
    pub old_record: bool,
}

/// Whether runtime restart reconciliation, rather than ordinary lease
/// reconciliation, decides a lease. Absence from a replacement runtime is
/// never proof of exit, so every lease an old incarnation may have owned is
/// taken out of the ordinary path.
pub(super) fn attributed(ownership: &Ownership) -> bool {
    ownership.open
        || (ownership.restarted
            && !ownership.live_now
            && (ownership.old_instance_recorded || ownership.fresh_runtime || ownership.old_record))
}

/// A process identity recorded while the old runtime incarnation was alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ProcessRecord {
    pub pid: u32,
    /// The platform start stamp; a reused PID has another one.
    pub started: u64,
    /// Whether the process led its own process group when it was recorded.
    pub leader: bool,
}

/// What an observation says about one recorded process and its group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Tree {
    /// Neither the recorded process nor a member of the group it led runs.
    Gone,
    /// These processes from the recorded tree still run.
    Running(Vec<u32>),
    /// The process table could not be read.
    Unreadable(String),
}

/// Reads one recorded tree out of process-table rows.
///
/// A PID is not reused while a process group with that ID exists (POSIX
/// "Process ID Reuse"). So when the PID now belongs to a process with another
/// start stamp, the group the recorded process led has no members left, and
/// the rows naming that group belong to the new process.
pub(super) fn tree(record: &ProcessRecord, rows: Result<&[Row], &str>) -> Tree {
    let rows = match rows {
        Ok(rows) => rows,
        Err(reason) => return Tree::Unreadable(reason.to_owned()),
    };
    let pid = record.pid as i32;
    let root = rows.iter().find(|row| row.identity.pid == pid);
    if root.is_some_and(|row| row.identity.started != record.started) {
        return Tree::Gone;
    }
    let mut running: Vec<u32> = rows
        .iter()
        .filter(|row| !row.zombie)
        .filter(|row| row.identity.pid == pid || (record.leader && row.pgid == pid))
        .map(|row| row.identity.pid as u32)
        .collect();
    running.sort_unstable();
    running.dedup();
    if running.is_empty() {
        Tree::Gone
    } else {
        Tree::Running(running)
    }
}

/// Whether the old runtime process itself still runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Presence {
    Gone,
    Running,
    Unreadable(String),
}

/// Reads the old runtime process. Without a recorded start stamp a live PID
/// cannot be told apart from a reused one.
pub(super) fn presence(pid: u32, started: Option<u64>, rows: Result<&[Row], &str>) -> Presence {
    let rows = match rows {
        Ok(rows) => rows,
        Err(reason) => return Presence::Unreadable(reason.to_owned()),
    };
    match rows
        .iter()
        .find(|row| row.identity.pid == pid as i32 && !row.zombie)
    {
        None => Presence::Gone,
        Some(row) => match started {
            Some(started) if row.identity.started == started => Presence::Running,
            Some(_) => Presence::Gone,
            None => Presence::Unreadable(format!(
                "process {pid} runs, and the old runtime's start time was not recorded"
            )),
        },
    }
}

/// What the assigned ports of a service show once its tree is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Ports {
    /// Not a service, or a service without assigned ports.
    NotApplicable,
    Free,
    /// A listener ADE cannot attribute holds this port.
    Held {
        port: u16,
        pid: u32,
    },
    Unreadable(String),
}

/// Reads the assigned ports out of a listener observation.
pub(super) fn ports(assigned: &[u16], listeners: Result<&[(u16, u32)], &str>) -> Ports {
    if assigned.is_empty() {
        return Ports::NotApplicable;
    }
    let listeners = match listeners {
        Ok(listeners) => listeners,
        Err(reason) => return Ports::Unreadable(reason.to_owned()),
    };
    let mut held: Vec<_> = listeners
        .iter()
        .filter(|(port, _)| assigned.contains(port))
        .copied()
        .collect();
    held.sort_unstable();
    match held.first() {
        Some(&(port, pid)) => Ports::Held { port, pid },
        None => Ports::Free,
    }
}

/// The durable facts about one attempt the old incarnation owned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Facts {
    pub kind: RecoveredAttemptKind,
    /// A provider turn was in flight. Terminals, services and scripts are
    /// always in flight while they are owned.
    pub in_flight: bool,
    /// The Conversation records a native provider session to resume from.
    pub native_session: bool,
}

/// Whether a Conversation's provider turn was in flight when its runtime
/// stopped. `status` is `None` for a missing Conversation, which counts as
/// mid-turn. A busy status is in flight. So is `interrupted` when the old
/// incarnation recorded the very run the Conversation still names: a daemon
/// that outlived its runtime marks the lost turn interrupted and clears it
/// before the next start reconciles, so the busy status alone would report
/// the lost turn's outcome as known.
pub(super) fn turn_in_flight(status: Option<&str>, recorded_run: bool) -> bool {
    match status {
        None => true,
        Some("starting" | "running" | "waiting" | "cancelling") => true,
        Some("interrupted") => recorded_run,
        Some(_) => false,
    }
}

/// Everything observed about one attempt after the restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Evidence {
    pub runtime: Presence,
    /// `None` when no process identity was recorded for the attempt.
    pub tree: Option<Tree>,
    pub ports: Ports,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Outcome {
    pub classification: RecoveryClassification,
    pub reason: String,
    pub pids: Vec<u32>,
    pub outcome_unknown: bool,
}

fn outcome(classification: RecoveryClassification, reason: impl Into<String>) -> Outcome {
    Outcome {
        classification,
        reason: reason.into(),
        pids: Vec::new(),
        outcome_unknown: false,
    }
}

/// Classifies one attempt. The rules apply in order; the first that matches wins.
pub(super) fn classify(facts: &Facts, evidence: &Evidence) -> Outcome {
    use RecoveryClassification::{Quarantined, Settled, Unknown};
    // 1. A live old runtime may still own the attempt.
    if evidence.runtime == Presence::Running {
        return outcome(
            Quarantined,
            "the previous runtime process is still running and may still own it",
        );
    }
    // 2. Processes from the recorded tree still run without an owner.
    if let Some(Tree::Running(pids)) = &evidence.tree {
        return Outcome {
            pids: pids.clone(),
            ..outcome(
                Quarantined,
                format!(
                    "{} process(es) from it still run after the runtime stopped",
                    pids.len()
                ),
            )
        };
    }
    // 3. and 4. An unreadable observation is not proof of exit.
    if let Some(Tree::Unreadable(reason)) = &evidence.tree {
        return outcome(
            Unknown,
            format!("its process tree could not be read: {reason}"),
        );
    }
    if let Presence::Unreadable(reason) = &evidence.runtime {
        return outcome(
            Unknown,
            format!("whether the previous runtime stopped could not be verified: {reason}"),
        );
    }
    // 5. Without a recorded identity only an idle Conversation is settled:
    // there was no turn whose effects could be lost.
    if evidence.tree.is_none() {
        return if facts.kind == RecoveredAttemptKind::ProviderTurn && !facts.in_flight {
            outcome(
                Settled,
                "no turn was in flight and the previous runtime has stopped",
            )
        } else {
            outcome(
                Unknown,
                "no process identity was recorded for it before the runtime stopped",
            )
        };
    }
    // 6. The tree is gone. A service port still held may be an escaped descendant.
    match &evidence.ports {
        Ports::Held { port, pid } => {
            return outcome(
                Unknown,
                format!("port {port} is held by process {pid}, which ADE cannot attribute to it"),
            );
        }
        Ports::Unreadable(reason) => {
            return outcome(
                Unknown,
                format!("its assigned ports could not be checked: {reason}"),
            );
        }
        Ports::NotApplicable | Ports::Free => {}
    }
    // 7. A provider turn that was in flight stopped; its effects are unknown.
    if facts.kind == RecoveredAttemptKind::ProviderTurn && facts.in_flight {
        let resume = if facts.native_session {
            "resume reconciles its history from the native session"
        } else {
            "no native session is recorded to reconcile against"
        };
        return Outcome {
            outcome_unknown: true,
            ..outcome(
                Settled,
                format!(
                    "the provider process exited mid-turn; the turn's effects are unknown and it was not replayed; {resume}"
                ),
            )
        };
    }
    outcome(Settled, "every recorded process in its tree has exited")
}

/// Decides whether a control path (`service.stop`, `script.retire`) may
/// settle an attempt that restart reconciliation still watches, from a fresh
/// classification. The replacement runtime never saw the attempt, so its
/// absence there proves nothing: only a settled observation releases it. A
/// running attempt refuses, and an unverifiable one needs the user's explicit
/// `runtime.recovery.release`. Returns the resolution to record, or the refusal.
pub(super) fn control_release(outcome: &Outcome) -> std::result::Result<String, String> {
    match outcome.classification {
        RecoveryClassification::Settled => Ok(format!(
            "released through its own stop or retire command after an observation settled it: {}",
            outcome.reason
        )),
        RecoveryClassification::Quarantined => {
            let pids = if outcome.pids.is_empty() {
                String::new()
            } else {
                let list: Vec<String> = outcome.pids.iter().map(u32::to_string).collect();
                format!("; process IDs {}", list.join(", "))
            };
            Err(format!(
                "The run from the replaced runtime is still running ({}{pids}). Stop those processes, then retry",
                outcome.reason
            ))
        }
        RecoveryClassification::Unknown => Err(format!(
            "ADE cannot verify that the run from the replaced runtime stopped ({}). Release it with runtime.recovery.release, then retry",
            outcome.reason
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RecoveryClassification::{Quarantined, Settled, Unknown};
    use ade_runtime::descendants::Identity;

    fn row(pid: i32, started: u64, pgid: i32, zombie: bool) -> Row {
        Row {
            identity: Identity { pid, started },
            ppid: 1,
            pgid,
            zombie,
        }
    }
    const LEADER: ProcessRecord = ProcessRecord {
        pid: 40,
        started: 7,
        leader: true,
    };

    #[test]
    fn restart_reconciliation_decides_every_lease_an_old_incarnation_may_own() {
        let restarted = Ownership {
            restarted: true,
            ..Default::default()
        };
        // Nothing ties the lease to the old incarnation.
        assert!(!attributed(&restarted));
        for owned in [
            Ownership {
                fresh_runtime: true,
                ..restarted
            },
            Ownership {
                old_record: true,
                ..restarted
            },
            Ownership {
                old_instance_recorded: true,
                ..restarted
            },
        ] {
            assert!(attributed(&owned));
            // The current runtime runs it: ordinary reconciliation keeps it live.
            assert!(!attributed(&Ownership {
                live_now: true,
                ..owned
            }));
        }
        // Without a restart only an open attempt stays with this path.
        assert!(!attributed(&Ownership {
            fresh_runtime: true,
            ..Default::default()
        }));
        assert!(attributed(&Ownership {
            open: true,
            ..Default::default()
        }));
    }

    #[test]
    fn a_running_root_or_orphaned_group_member_is_running() {
        let rows = [row(40, 7, 40, false), row(41, 9, 40, false)];
        assert_eq!(tree(&LEADER, Ok(&rows)), Tree::Running(vec![40, 41]));
        // The leader exited; its group member was reparented and still runs.
        let orphan = [row(41, 9, 40, false)];
        assert_eq!(tree(&LEADER, Ok(&orphan)), Tree::Running(vec![41]));
    }

    #[test]
    fn a_reused_pid_proves_the_old_group_is_empty() {
        let rows = [row(40, 99, 40, false), row(41, 100, 40, false)];
        assert_eq!(tree(&LEADER, Ok(&rows)), Tree::Gone);
    }

    #[test]
    fn zombies_and_foreign_groups_do_not_count() {
        let rows = [row(40, 7, 40, true), row(50, 1, 50, false)];
        assert_eq!(tree(&LEADER, Ok(&rows)), Tree::Gone);
        // A process that did not lead its group only proves itself.
        let follower = ProcessRecord {
            leader: false,
            ..LEADER
        };
        let rows = [row(41, 9, 40, false)];
        assert_eq!(tree(&follower, Ok(&rows)), Tree::Gone);
    }

    #[test]
    fn an_unreadable_table_is_never_gone() {
        assert_eq!(
            tree(&LEADER, Err("denied")),
            Tree::Unreadable("denied".into())
        );
        assert!(matches!(
            presence(10, Some(1), Err("denied")),
            Presence::Unreadable(_)
        ));
    }

    #[test]
    fn runtime_presence_needs_a_matching_start_stamp() {
        let rows = [row(10, 5, 10, false)];
        assert_eq!(presence(10, Some(5), Ok(&rows)), Presence::Running);
        assert_eq!(presence(10, Some(6), Ok(&rows)), Presence::Gone);
        assert!(matches!(
            presence(10, None, Ok(&rows)),
            Presence::Unreadable(_)
        ));
        assert_eq!(presence(10, None, Ok(&[])), Presence::Gone);
    }

    #[test]
    fn assigned_ports_report_the_lowest_held_port() {
        assert_eq!(ports(&[], Ok(&[(3000, 1)])), Ports::NotApplicable);
        assert_eq!(ports(&[3000], Ok(&[(4000, 1)])), Ports::Free);
        assert_eq!(
            ports(&[3001, 3000], Ok(&[(3001, 8), (3000, 9)])),
            Ports::Held { port: 3000, pid: 9 }
        );
        assert!(matches!(ports(&[3000], Err("lsof")), Ports::Unreadable(_)));
    }

    #[test]
    fn a_turn_interrupted_by_a_surviving_daemon_stays_in_flight_only_for_its_recorded_run() {
        for busy in ["starting", "running", "waiting", "cancelling"] {
            assert!(turn_in_flight(Some(busy), false));
        }
        assert!(turn_in_flight(None, false));
        // The daemon saw its runtime go and marked the turn interrupted.
        assert!(turn_in_flight(Some("interrupted"), true));
        // Interrupted by an earlier incarnation: this one never ran it.
        assert!(!turn_in_flight(Some("interrupted"), false));
        for idle in ["ready", "idle", "error", "disconnected"] {
            assert!(!turn_in_flight(Some(idle), true));
        }
    }

    fn facts(kind: RecoveredAttemptKind, in_flight: bool) -> Facts {
        Facts {
            kind,
            in_flight,
            native_session: true,
        }
    }
    fn evidence(runtime: Presence, tree: Option<Tree>, ports: Ports) -> Evidence {
        Evidence {
            runtime,
            tree,
            ports,
        }
    }

    #[test]
    fn a_live_old_runtime_quarantines_everything() {
        let result = classify(
            &facts(RecoveredAttemptKind::Terminal, true),
            &evidence(Presence::Running, Some(Tree::Gone), Ports::NotApplicable),
        );
        assert_eq!(result.classification, Quarantined);
    }

    #[test]
    fn orphaned_processes_are_quarantined_with_their_pids() {
        let result = classify(
            &facts(RecoveredAttemptKind::Script, true),
            &evidence(
                Presence::Gone,
                Some(Tree::Running(vec![41])),
                Ports::NotApplicable,
            ),
        );
        assert_eq!(result.classification, Quarantined);
        assert_eq!(result.pids, vec![41]);
    }

    #[test]
    fn missing_evidence_is_unknown() {
        for (runtime, tree) in [
            (Presence::Gone, Some(Tree::Unreadable("x".into()))),
            (Presence::Unreadable("x".into()), Some(Tree::Gone)),
            (Presence::Gone, None),
        ] {
            let result = classify(
                &facts(RecoveredAttemptKind::Service, true),
                &evidence(runtime, tree, Ports::Free),
            );
            assert_eq!(result.classification, Unknown);
        }
        // A provider turn in flight without an identity is unknown too.
        let result = classify(
            &facts(RecoveredAttemptKind::ProviderTurn, true),
            &evidence(Presence::Gone, None, Ports::NotApplicable),
        );
        assert_eq!(result.classification, Unknown);
    }

    #[test]
    fn an_idle_conversation_settles_once_the_runtime_is_gone() {
        let result = classify(
            &facts(RecoveredAttemptKind::ProviderTurn, false),
            &evidence(Presence::Gone, None, Ports::NotApplicable),
        );
        assert_eq!(result.classification, Settled);
        assert!(!result.outcome_unknown);
    }

    #[test]
    fn a_held_or_unchecked_service_port_is_unknown() {
        for ports in [
            Ports::Held { port: 3000, pid: 9 },
            Ports::Unreadable("lsof".into()),
        ] {
            let result = classify(
                &facts(RecoveredAttemptKind::Service, true),
                &evidence(Presence::Gone, Some(Tree::Gone), ports),
            );
            assert_eq!(result.classification, Unknown);
        }
    }

    #[test]
    fn a_stopped_tree_settles_and_an_in_flight_turn_keeps_its_outcome_unknown() {
        let result = classify(
            &facts(RecoveredAttemptKind::Service, true),
            &evidence(Presence::Gone, Some(Tree::Gone), Ports::Free),
        );
        assert_eq!(result.classification, Settled);
        assert!(!result.outcome_unknown);
        let turn = classify(
            &facts(RecoveredAttemptKind::ProviderTurn, true),
            &evidence(Presence::Gone, Some(Tree::Gone), Ports::NotApplicable),
        );
        assert_eq!(turn.classification, Settled);
        assert!(turn.outcome_unknown);
        assert!(turn.reason.contains("not replayed"));
    }

    #[test]
    fn a_control_path_settles_a_watched_attempt_only_on_proof_of_exit() {
        // The runtime crashed and a daemonized child of the service survived
        // the hangup. service.stop finds no terminal in the replacement
        // runtime, but the attempt still runs, so the stop must refuse.
        let running = classify(
            &facts(RecoveredAttemptKind::Service, true),
            &evidence(
                Presence::Gone,
                Some(Tree::Running(vec![4242])),
                Ports::NotApplicable,
            ),
        );
        let refusal = control_release(&running).unwrap_err();
        assert!(refusal.contains("still running") && refusal.contains("4242"));
        // A live old runtime may still own a script run.
        let owner = classify(
            &facts(RecoveredAttemptKind::Script, true),
            &evidence(Presence::Running, Some(Tree::Gone), Ports::NotApplicable),
        );
        assert!(control_release(&owner).is_err());
        // An unverifiable exit stays unknown; only the explicit release accepts it.
        for (tree, ports) in [
            (None, Ports::Free),
            (Some(Tree::Gone), Ports::Held { port: 3000, pid: 9 }),
            (Some(Tree::Unreadable("ps".into())), Ports::NotApplicable),
        ] {
            let unknown = classify(
                &facts(RecoveredAttemptKind::Service, true),
                &evidence(Presence::Gone, tree, ports),
            );
            let refusal = control_release(&unknown).unwrap_err();
            assert!(refusal.contains("runtime.recovery.release"));
        }
        // A gone tree with free ports is proof of exit.
        let settled = classify(
            &facts(RecoveredAttemptKind::Service, true),
            &evidence(Presence::Gone, Some(Tree::Gone), Ports::Free),
        );
        assert!(control_release(&settled).is_ok());
    }
}
