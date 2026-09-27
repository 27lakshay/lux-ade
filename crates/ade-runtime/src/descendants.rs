//! Verified shutdown of an owned process tree.
//!
//! A direct child's exit is evidence about that one process. It is not proof
//! that its process group or its descendants have stopped: a descendant can
//! leave the group with `setsid`, ignore `SIGTERM`, or be reparented to launchd
//! after its parent dies. This module tracks every process it has observed in
//! the tree by identity (PID plus start time, so a reused PID never matches),
//! signals with bounded escalation (`SIGTERM`, then `SIGKILL` after a grace
//! period), and reports one of three verdicts:
//!
//! - `Exited` needs positive evidence: a readable process table in which no
//!   group member and no tracked identity is still running.
//! - `Live` names the tracked processes still running at the deadline.
//! - `Unverifiable` covers every case without that evidence, such as an
//!   unreadable process table or a tree that was never observed before signalling.
//!
//! Only `Exited` releases ownership. Callers treat the other two as a
//! quarantined execution and keep its resources reserved.
//!
//! The verdict vocabulary and the identity-checked tracking follow the patterns
//! in Orca's `src/shared/pty-liveness-verdict.ts` and
//! `src/main/pty-descendant-exit-verification.ts` (MIT). No code was copied.
//!
//! Limitation: macOS offers no kernel containment for arbitrary descendants. A
//! process that forks, leaves the group and loses its parent between two
//! observations is never seen, so `Exited` means "nothing observed is running",
//! not a containment guarantee.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::{Duration, Instant},
};

/// A process identity that survives PID reuse: the same PID with a different
/// start time is a different process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Identity {
    pub pid: i32,
    /// Platform start stamp: microseconds since the epoch on macOS, clock ticks
    /// since boot on Linux. Only equality and ordering are used.
    pub started: u64,
}

/// One process-table row, as read at one instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub identity: Identity,
    pub ppid: i32,
    pub pgid: i32,
    /// A zombie has exited and holds no resources beyond its PID.
    pub zombie: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Exited,
    Live { pids: Vec<i32> },
    Unverifiable { reason: String },
}

impl Verdict {
    pub fn code(&self) -> &'static str {
        match self {
            Verdict::Exited => "exited",
            Verdict::Live { .. } => "live",
            Verdict::Unverifiable { .. } => "unverifiable",
        }
    }
    /// Stable, secret-free detail for logs and client messages.
    pub fn detail(&self) -> String {
        match self {
            Verdict::Exited => "every observed process in the tree has exited".into(),
            Verdict::Live { pids } => format!(
                "{} process(es) in the tree are still running after SIGKILL (pids {})",
                pids.len(),
                pids.iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Verdict::Unverifiable { reason } => reason.clone(),
        }
    }
}

/// Returned when shutdown could not prove the tree stopped. The execution is
/// quarantined: its owner must keep resources reserved and report uncertainty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unconfirmed(pub Verdict);

impl std::fmt::Display for Unconfirmed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Process tree was not confirmed stopped ({}): {}; ownership remains reserved",
            self.0.code(),
            self.0.detail()
        )
    }
}

impl std::error::Error for Unconfirmed {}

/// The set of processes known to belong to one owned tree.
#[derive(Clone, Debug)]
pub struct Tracker {
    root: i32,
    pgid: i32,
    tracked: BTreeMap<i32, u64>,
    /// Set when the tree could not be observed before the first signal, so
    /// descendants that had already left the group are unknown.
    blind: Option<String>,
    observed: bool,
}

impl Tracker {
    /// `root` is the direct child. It leads its own group, so `pgid == root`
    /// unless the caller placed it elsewhere.
    pub fn new(root: i32, pgid: i32) -> Self {
        Self {
            root,
            pgid,
            tracked: BTreeMap::new(),
            blind: None,
            observed: false,
        }
    }

    /// PIDs whose children must be observed to extend the tree.
    pub fn parents(&self) -> Vec<i32> {
        let mut parents = self.tracked.keys().copied().collect::<BTreeSet<_>>();
        parents.insert(self.root);
        parents.into_iter().collect()
    }

    pub fn tracked(&self) -> Vec<Identity> {
        self.tracked
            .iter()
            .map(|(&pid, &started)| Identity { pid, started })
            .collect()
    }

    /// Record that the pre-signal observation failed. Later reads can still
    /// show the group empty, but never prove escaped descendants stopped.
    pub fn mark_blind(&mut self, reason: &str) {
        if !self.observed && self.blind.is_none() {
            self.blind = Some(format!(
                "the process tree could not be observed before signalling: {reason}"
            ));
        }
    }

    /// Extend the tracked set from one table read. A row joins when it is in
    /// the owned group, is the root, or is a child of a tracked process whose
    /// identity matches in this same read. A child cannot start before its
    /// parent, so an earlier start marks a reused PID and is ignored. Duplicate
    /// PIDs make a non-atomic read ambiguous; neither row is trusted.
    pub fn observe(&mut self, rows: &[Row]) {
        self.observed = true;
        let rows = unique_rows(rows);
        let current = |pid: i32, tracked: &BTreeMap<i32, u64>| {
            let started = *tracked.get(&pid)?;
            rows.get(&pid)
                .filter(|row| row.identity.started == started)
                .map(|_| started)
        };
        if let Some(root) = rows.get(&self.root) {
            self.tracked
                .entry(self.root)
                .or_insert(root.identity.started);
        }
        for row in rows.values() {
            if row.pgid == self.pgid && !row.zombie {
                self.tracked
                    .entry(row.identity.pid)
                    .or_insert(row.identity.started);
            }
        }
        // Walk parent links to a fixed point so grandchildren seen in the same
        // read join even when they appear before their parent.
        loop {
            let mut added = false;
            for row in rows.values() {
                if self.tracked.contains_key(&row.identity.pid) {
                    continue;
                }
                if let Some(parent_started) = current(row.ppid, &self.tracked)
                    && row.identity.started >= parent_started
                {
                    self.tracked.insert(row.identity.pid, row.identity.started);
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
    }

    /// Rows from `rows` that are still running members of this tree.
    pub fn live<'a>(&self, rows: &'a [Row]) -> Vec<&'a Row> {
        let unique = unique_rows(rows);
        let mut live = rows
            .iter()
            .filter(|row| !row.zombie)
            .filter(|row| {
                // Ambiguous duplicate rows count as live: they are never proof of exit.
                if !unique.contains_key(&row.identity.pid) {
                    return self.tracked.contains_key(&row.identity.pid) || row.pgid == self.pgid;
                }
                row.pgid == self.pgid
                    || self.tracked.get(&row.identity.pid) == Some(&row.identity.started)
            })
            .collect::<Vec<_>>();
        live.sort_by_key(|row| row.identity);
        live.dedup_by_key(|row| row.identity.pid);
        live
    }

    /// The liveness verdict for one observation. `Exited` needs a readable
    /// table showing nothing running and a tree that was observed before
    /// signalling.
    pub fn verdict(&self, observation: Result<&[Row], &str>) -> Verdict {
        let rows = match observation {
            Ok(rows) => rows,
            Err(reason) => {
                return Verdict::Unverifiable {
                    reason: format!("the process table could not be read: {reason}"),
                };
            }
        };
        let live = self.live(rows);
        if !live.is_empty() {
            return Verdict::Live {
                pids: live.iter().map(|row| row.identity.pid).collect(),
            };
        }
        match &self.blind {
            Some(reason) => Verdict::Unverifiable {
                reason: reason.clone(),
            },
            None => Verdict::Exited,
        }
    }

    /// What to signal. While the direct child is unreaped its PID cannot be
    /// reused, so signalling its group is safe. Tracked processes outside the
    /// group, and every process once the child is reaped, are signalled one
    /// by one, only when this read matched their identity.
    pub fn targets(&self, rows: Option<&[Row]>, leader_reaped: bool) -> Targets {
        let group = !leader_reaped && self.pgid > 1;
        let pids = rows
            .map(|rows| {
                let unique = unique_rows(rows);
                self.live(rows)
                    .into_iter()
                    .filter(|row| unique.contains_key(&row.identity.pid))
                    .filter(|row| !group || row.pgid != self.pgid)
                    .map(|row| row.identity.pid)
                    .filter(|&pid| pid > 1)
                    .collect()
            })
            .unwrap_or_default();
        Targets { group, pids }
    }
}

fn unique_rows(rows: &[Row]) -> HashMap<i32, Row> {
    let mut unique: HashMap<i32, Option<Row>> = HashMap::new();
    for row in rows {
        unique
            .entry(row.identity.pid)
            .and_modify(|seen| *seen = None)
            .or_insert(Some(*row));
    }
    unique
        .into_iter()
        .filter_map(|(pid, row)| Some((pid, row?)))
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Targets {
    /// Signal the whole process group by its ID.
    pub group: bool,
    /// Signal these processes individually.
    pub pids: Vec<i32>,
}

#[derive(Clone, Copy, Debug)]
pub struct Policy {
    /// Time between `SIGTERM` and `SIGKILL`.
    pub grace: Duration,
    /// Total time before an unproven tree is reported and quarantined.
    pub deadline: Duration,
    pub poll: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            grace: Duration::from_secs(2),
            deadline: Duration::from_secs(5),
            poll: Duration::from_millis(20),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Wait,
    Kill,
    Done(Verdict),
}

/// The escalation decision for one poll. An unreadable table is not an
/// answer, so it keeps waiting until the deadline rather than giving up early.
pub fn escalation(elapsed: Duration, kill_sent: bool, verdict: &Verdict, policy: &Policy) -> Step {
    if *verdict == Verdict::Exited {
        return Step::Done(Verdict::Exited);
    }
    if elapsed >= policy.deadline {
        return Step::Done(verdict.clone());
    }
    // An unreadable table must not delay escalation of the group we own.
    if !kill_sent && elapsed >= policy.grace {
        return Step::Kill;
    }
    Step::Wait
}

/// The shutdown state of one owned tree. It is kept by the owner across calls
/// so a retried stop resumes tracking instead of starting blind, and never
/// signals the group again after its leader was reaped.
#[derive(Debug)]
pub struct Shutdown {
    tracker: Tracker,
    leader_reaped: bool,
    settled: Option<Verdict>,
}

impl Shutdown {
    pub fn new(leader: u32) -> Self {
        let pid = leader as i32;
        Self {
            tracker: Tracker::new(pid, pid),
            leader_reaped: false,
            settled: None,
        }
    }

    /// The last verdict, if a stop has run.
    pub fn verdict(&self) -> Option<&Verdict> {
        self.settled.as_ref()
    }

    pub fn leader_reaped(&self) -> bool {
        self.leader_reaped
    }

    /// Observe the tree without signalling it, so descendants that later
    /// leave the group and lose their parent stay tracked. Owners call this
    /// periodically while the execution runs.
    pub fn track(&mut self) {
        if let Ok(rows) = observe(self.tracker.pgid, &self.tracker.parents()) {
            self.tracker.observe(&rows);
        }
    }

    /// Observe, then send `SIGKILL` to the group and every tracked process at
    /// once. The caller must still run `stop` to prove the tree has exited.
    pub fn kill_now(&mut self) {
        let rows = observe(self.tracker.pgid, &self.tracker.parents());
        match &rows {
            Ok(rows) => self.tracker.observe(rows),
            Err(reason) => self.tracker.mark_blind(reason),
        }
        let verdict = self
            .tracker
            .verdict(rows.as_deref().map_err(String::as_str));
        self.signal(libc::SIGKILL, rows.as_deref().ok(), verdict);
    }

    /// Signal the tree and wait for proof it has stopped. `reap` reaps the
    /// direct child without blocking and returns `true` once it has been reaped.
    /// It is only called after the table shows the leader has exited, so the
    /// group ID stays reserved while it is signalled.
    pub fn stop(
        &mut self,
        policy: &Policy,
        reap: &mut dyn FnMut() -> std::io::Result<bool>,
    ) -> Verdict {
        if self.settled == Some(Verdict::Exited) {
            return Verdict::Exited;
        }
        let start = Instant::now();
        let first = observe(self.tracker.pgid, &self.tracker.parents());
        match &first {
            Ok(rows) => self.tracker.observe(rows),
            Err(reason) => self.tracker.mark_blind(reason),
        }
        self.signal(
            libc::SIGTERM,
            first.as_deref().ok(),
            self.tracker
                .verdict(first.as_deref().map_err(String::as_str)),
        );
        let mut kill_sent = false;
        let verdict = loop {
            std::thread::sleep(policy.poll);
            let rows = observe(self.tracker.pgid, &self.tracker.parents());
            if let Ok(rows) = &rows {
                self.tracker.observe(rows);
            }
            let verdict = self
                .tracker
                .verdict(rows.as_deref().map_err(String::as_str));
            match escalation(start.elapsed(), kill_sent, &verdict, policy) {
                Step::Done(verdict) => break verdict,
                Step::Kill => {
                    self.signal(libc::SIGKILL, rows.as_deref().ok(), verdict);
                    kill_sent = true;
                }
                Step::Wait => {}
            }
        };
        let verdict = self.reap_leader(verdict, start + policy.deadline, policy, reap);
        if verdict != Verdict::Exited {
            tracing::warn!(target: "ade", event = "process_tree_quarantined", pgid = self.tracker.pgid, verdict = verdict.code(), detail = %verdict.detail());
        }
        self.settled = Some(verdict.clone());
        verdict
    }

    fn reap_leader(
        &mut self,
        verdict: Verdict,
        deadline: Instant,
        policy: &Policy,
        reap: &mut dyn FnMut() -> std::io::Result<bool>,
    ) -> Verdict {
        if self.leader_reaped {
            return verdict;
        }
        loop {
            match reap() {
                Ok(true) => {
                    self.leader_reaped = true;
                    return verdict;
                }
                Ok(false) if verdict == Verdict::Exited && Instant::now() < deadline => {
                    std::thread::sleep(policy.poll);
                }
                // The table showed nothing running, yet the child is not
                // reapable: that contradiction is not proof of exit.
                Ok(false) if verdict == Verdict::Exited => {
                    return Verdict::Unverifiable {
                        reason: "the direct child could not be reaped".into(),
                    };
                }
                Ok(false) => return verdict,
                Err(error) => {
                    return Verdict::Unverifiable {
                        reason: format!("the direct child could not be reaped: {error}"),
                    };
                }
            }
        }
    }

    fn signal(&self, signal: libc::c_int, rows: Option<&[Row]>, verdict: Verdict) {
        if verdict == Verdict::Exited && rows.is_some() {
            return;
        }
        let targets = self.tracker.targets(rows, self.leader_reaped);
        if targets.group {
            // SAFETY: plain syscall. The leader is unreaped, so the group ID is ours.
            unsafe {
                libc::killpg(self.tracker.pgid, signal);
            }
        }
        for pid in targets.pids {
            // SAFETY: plain syscall; the identity matched in the read just made.
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
}

/// Read the rows relevant to one tree: members of `pgid` and children of
/// `parents` (plus the parents themselves). A row that exists but cannot be
/// read makes the whole observation unreadable, because it could be ours.
#[cfg(target_os = "macos")]
pub fn observe(pgid: i32, parents: &[i32]) -> Result<Vec<Row>, String> {
    const PROC_PGRP_ONLY: u32 = 2;
    const PROC_PPID_ONLY: u32 = 6;
    let mut pids = BTreeSet::new();
    pids.extend(list_pids(PROC_PGRP_ONLY, pgid as u32)?);
    for &parent in parents {
        pids.insert(parent);
        pids.extend(list_pids(PROC_PPID_ONLY, parent as u32)?);
    }
    let mut rows = Vec::with_capacity(pids.len());
    for pid in pids {
        if let Some(row) = bsd_row(pid)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

#[cfg(target_os = "macos")]
fn list_pids(kind: u32, filter: u32) -> Result<Vec<i32>, String> {
    let mut capacity = 256usize;
    loop {
        let mut buffer = vec![0i32; capacity];
        let bytes = (capacity * std::mem::size_of::<i32>()) as libc::c_int;
        // SAFETY: the buffer holds `bytes` bytes and outlives the call.
        let filled =
            unsafe { libc::proc_listpids(kind, filter, buffer.as_mut_ptr().cast(), bytes) };
        if filled < 0 {
            return Err(format!(
                "proc_listpids failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if filled >= bytes {
            // A full buffer may have been truncated; read again with more room.
            capacity = capacity
                .checked_mul(4)
                .filter(|c| *c <= 1 << 20)
                .ok_or("process list exceeded its bound")?;
            continue;
        }
        buffer.truncate(filled as usize / std::mem::size_of::<i32>());
        buffer.retain(|&pid| pid > 0);
        return Ok(buffer);
    }
}

#[cfg(target_os = "macos")]
fn bsd_row(pid: i32) -> Result<Option<Row>, String> {
    // SAFETY: zeroed plain-old-data struct, filled by the kernel.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the pointer and size describe `info`.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read == size {
        return Ok(Some(Row {
            identity: Identity {
                pid,
                started: info
                    .pbi_start_tvsec
                    .saturating_mul(1_000_000)
                    .saturating_add(info.pbi_start_tvusec),
            },
            ppid: info.pbi_ppid as i32,
            pgid: info.pbi_pgid as i32,
            zombie: info.pbi_status == libc::SZOMB,
        }));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(None);
    }
    // A process that vanished between listing and reading can report other
    // errors; confirm absence with a null signal before trusting it.
    // SAFETY: signal 0 only checks existence.
    let exists = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    if exists {
        Err(format!("process {pid} could not be inspected: {error}"))
    } else {
        Ok(None)
    }
}

/// Linux reads every `/proc/<pid>/stat`; the tracker filters the rows.
#[cfg(target_os = "linux")]
pub fn observe(_pgid: i32, _parents: &[i32]) -> Result<Vec<Row>, String> {
    let entries = std::fs::read_dir("/proc").map_err(|e| format!("/proc unreadable: {e}"))?;
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("/proc unreadable: {e}"))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => rows.push(
                parse_linux_stat(pid, &stat)
                    .ok_or_else(|| format!("process {pid} has an unreadable stat record"))?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(error) => return Err(format!("process {pid} could not be inspected: {error}")),
        }
    }
    Ok(rows)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn observe(_pgid: i32, _parents: &[i32]) -> Result<Vec<Row>, String> {
    Err("process tree inspection is not supported on this platform".into())
}

/// Parse `/proc/<pid>/stat`. The command name can contain spaces and
/// parentheses, so fields are counted after the last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_linux_stat(pid: i32, stat: &str) -> Option<Row> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields = rest.split_whitespace().collect::<Vec<_>>();
    // After the name: state(0) ppid(1) pgrp(2) ... starttime(19).
    Some(Row {
        identity: Identity {
            pid,
            started: fields.get(19)?.parse().ok()?,
        },
        ppid: fields.get(1)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        zombie: matches!(*fields.first()?, "Z" | "X"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: i32, started: u64, ppid: i32, pgid: i32) -> Row {
        Row {
            identity: Identity { pid, started },
            ppid,
            pgid,
            zombie: false,
        }
    }
    fn zombie(mut row: Row) -> Row {
        row.zombie = true;
        row
    }
    fn policy() -> Policy {
        Policy {
            grace: Duration::from_secs(2),
            deadline: Duration::from_secs(5),
            poll: Duration::from_millis(20),
        }
    }

    #[test]
    fn empty_group_with_observed_tree_is_exited() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100)]);
        assert_eq!(tracker.verdict(Ok(&[])), Verdict::Exited);
    }

    #[test]
    fn direct_child_exit_is_not_proof_while_group_member_runs() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(101, 11, 100, 100)]);
        // The leader is a zombie; its child was reparented but stays in the group.
        let after = [zombie(row(100, 10, 1, 100)), row(101, 11, 1, 100)];
        assert_eq!(
            tracker.verdict(Ok(&after)),
            Verdict::Live { pids: vec![101] }
        );
    }

    #[test]
    fn escaped_descendant_is_tracked_after_setsid_and_reparenting() {
        let mut tracker = Tracker::new(100, 100);
        // 102 called setsid (own group) under 101, which is in the owned group.
        tracker.observe(&[
            row(100, 10, 1, 100),
            row(101, 11, 100, 100),
            row(102, 12, 101, 102),
        ]);
        // Its parents died; launchd adopted it. Only identity tracking finds it.
        let after = [row(102, 12, 1, 102)];
        assert_eq!(
            tracker.verdict(Ok(&after)),
            Verdict::Live { pids: vec![102] }
        );
        assert_eq!(
            tracker.targets(Some(&after), false),
            Targets {
                group: true,
                pids: vec![102]
            }
        );
    }

    #[test]
    fn grandchildren_listed_before_their_parent_join_in_one_read() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[
            row(300, 13, 200, 300),
            row(200, 12, 101, 200),
            row(101, 11, 100, 100),
            row(100, 10, 1, 100),
        ]);
        assert_eq!(
            tracker.tracked().iter().map(|i| i.pid).collect::<Vec<_>>(),
            vec![100, 101, 200, 300]
        );
    }

    #[test]
    fn reused_pid_is_not_mistaken_for_a_tracked_process() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(102, 12, 100, 102)]);
        // PID 102 now belongs to an unrelated process with a later start.
        let after = [row(102, 99, 1, 102)];
        assert_eq!(tracker.verdict(Ok(&after)), Verdict::Exited);
        assert!(tracker.targets(Some(&after), true).pids.is_empty());
    }

    #[test]
    fn child_older_than_its_parent_is_a_reused_pid_and_not_adopted() {
        let mut tracker = Tracker::new(100, 100);
        // 500 claims parent 100 but started before it: the parent PID was reused.
        tracker.observe(&[row(100, 10, 1, 100), row(500, 5, 100, 500)]);
        assert!(!tracker.tracked().iter().any(|i| i.pid == 500));
    }

    #[test]
    fn children_of_a_reused_parent_pid_are_not_adopted() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(101, 11, 100, 100)]);
        // 101 exited; an unrelated process reused its PID and has a child.
        tracker.observe(&[row(101, 50, 1, 101), row(600, 60, 101, 101)]);
        assert!(!tracker.tracked().iter().any(|i| i.pid == 600));
        assert_eq!(
            tracker.verdict(Ok(&[row(101, 50, 1, 101), row(600, 60, 101, 101)])),
            Verdict::Exited
        );
    }

    #[test]
    fn unreadable_table_is_unverifiable_never_exited() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100)]);
        assert!(matches!(
            tracker.verdict(Err("denied")),
            Verdict::Unverifiable { .. }
        ));
    }

    #[test]
    fn tree_not_observed_before_signalling_cannot_be_proven_exited() {
        let mut tracker = Tracker::new(100, 100);
        tracker.mark_blind("denied");
        assert!(matches!(
            tracker.verdict(Ok(&[])),
            Verdict::Unverifiable { .. }
        ));
        // A later readable observation does not recover what was never seen.
        tracker.observe(&[]);
        assert!(matches!(
            tracker.verdict(Ok(&[])),
            Verdict::Unverifiable { .. }
        ));
    }

    #[test]
    fn duplicate_pid_rows_are_ambiguous_and_count_as_live_but_are_not_signalled() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(101, 11, 100, 101)]);
        let after = [row(101, 11, 1, 101), row(101, 70, 1, 101)];
        assert_eq!(
            tracker.verdict(Ok(&after)),
            Verdict::Live { pids: vec![101] }
        );
        assert!(tracker.targets(Some(&after), true).pids.is_empty());
    }

    #[test]
    fn zombies_are_exited() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(101, 11, 100, 100)]);
        let after = [zombie(row(100, 10, 1, 100)), zombie(row(101, 11, 100, 100))];
        assert_eq!(tracker.verdict(Ok(&after)), Verdict::Exited);
    }

    #[test]
    fn reaped_leader_switches_to_identity_checked_signals() {
        let mut tracker = Tracker::new(100, 100);
        tracker.observe(&[row(100, 10, 1, 100), row(101, 11, 100, 100)]);
        let after = [row(101, 11, 1, 100)];
        assert_eq!(
            tracker.targets(Some(&after), true),
            Targets {
                group: false,
                pids: vec![101]
            }
        );
        // Without a readable table only the unreaped group may be signalled.
        assert_eq!(
            tracker.targets(None, true),
            Targets {
                group: false,
                pids: vec![]
            }
        );
    }

    #[test]
    fn escalation_terms_then_kills_then_quarantines() {
        let live = Verdict::Live { pids: vec![7] };
        let p = policy();
        assert_eq!(
            escalation(Duration::from_millis(100), false, &live, &p),
            Step::Wait
        );
        assert_eq!(
            escalation(Duration::from_secs(2), false, &live, &p),
            Step::Kill
        );
        assert_eq!(
            escalation(Duration::from_secs(3), true, &live, &p),
            Step::Wait
        );
        assert_eq!(
            escalation(Duration::from_secs(5), true, &live, &p),
            Step::Done(live.clone())
        );
        assert_eq!(
            escalation(Duration::ZERO, false, &Verdict::Exited, &p),
            Step::Done(Verdict::Exited)
        );
        let unknown = Verdict::Unverifiable {
            reason: "slow".into(),
        };
        assert_eq!(
            escalation(Duration::from_millis(100), false, &unknown, &p),
            Step::Wait
        );
        assert_eq!(
            escalation(Duration::from_secs(2), false, &unknown, &p),
            Step::Kill
        );
        assert_eq!(
            escalation(Duration::from_secs(6), true, &unknown, &p),
            Step::Done(unknown)
        );
    }

    #[test]
    fn linux_stat_parser_handles_names_with_parentheses() {
        let stat = "42 (a) b (c)) S 7 42 42 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0";
        assert_eq!(parse_linux_stat(42, stat), Some(row(42, 12345, 7, 42)));
        assert_eq!(
            parse_linux_stat(42, "42 (x) Z 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 9")
                .map(|r| r.zombie),
            Some(true)
        );
        assert_eq!(parse_linux_stat(42, "garbage"), None);
    }
}
