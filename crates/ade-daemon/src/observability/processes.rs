//! Process-tree resource measurement for `diagnostics.status` (F136).
//!
//! One read of the process table gives each process's parent, physical
//! footprint and CPU time. Every group (the daemon, the runtime, each live
//! Agent run and each terminal shell) counts its root and all descendants.
//! Groups nest, so the totals count each distinct process once. Memory is the
//! physical footprint (macOS `phys_footprint`, Linux proportional set size),
//! which leaves out memory shared with other processes; summing resident set
//! sizes would count shared libraries once per process.
//!
//! [`measure`] is pure; the platform readers only fill [`Sample`]s.

use ade_core::contract::daemon::{
    DiagnosticHost, DiagnosticProcessGroup, DiagnosticProcessKind, DiagnosticProvenance,
    DiagnosticResources,
};
use std::collections::{BTreeMap, BTreeSet};

/// One process as the table read it. `None` fields could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub pid: u32,
    pub ppid: u32,
    pub footprint_bytes: Option<u64>,
    pub cpu_time_ms: Option<u64>,
}

/// A process to measure with its descendants.
#[derive(Clone, Debug)]
pub struct Root {
    pub kind: DiagnosticProcessKind,
    pub subject: String,
    pub incarnation: Option<String>,
    pub pid: u32,
}

/// The whole tree under `root`, root first, then by PID. A cycle in a
/// malformed table cannot loop, because each PID is visited once.
fn tree(root: u32, children: &BTreeMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut seen = BTreeSet::from([root]);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for &child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child) {
                stack.push(child);
            }
        }
    }
    seen.remove(&root);
    std::iter::once(root).chain(seen).collect()
}

fn sum(values: impl Iterator<Item = Option<u64>>) -> (Option<u64>, usize) {
    let mut total = None;
    let mut missing = 0;
    for value in values {
        match value {
            Some(value) => *total.get_or_insert(0u64) += value,
            None => missing += 1,
        }
    }
    (total, missing)
}

/// Measures every root against one table. `table` is `None` when the process
/// table could not be read: every group is then unavailable.
pub fn measure(
    roots: &[Root],
    table: Option<&[Sample]>,
    observed_at: i64,
    method: &str,
    host: DiagnosticHost,
) -> DiagnosticResources {
    let Some(table) = table else {
        return DiagnosticResources {
            observed: false,
            observed_at,
            method: method.into(),
            groups: roots
                .iter()
                .map(|root| {
                    group(
                        root,
                        Vec::new(),
                        None,
                        None,
                        DiagnosticProvenance::Unavailable,
                        "the process table could not be read".into(),
                    )
                })
                .collect(),
            total_processes: 0,
            total_footprint_bytes: None,
            total_cpu_time_ms: None,
            host,
        };
    };
    let by_pid: BTreeMap<u32, &Sample> = table.iter().map(|sample| (sample.pid, sample)).collect();
    let mut children: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for sample in table {
        if sample.ppid != sample.pid {
            children.entry(sample.ppid).or_default().push(sample.pid);
        }
    }
    let mut counted = BTreeSet::new();
    let mut groups = Vec::with_capacity(roots.len());
    for root in roots {
        if !by_pid.contains_key(&root.pid) {
            groups.push(group(
                root,
                Vec::new(),
                None,
                None,
                DiagnosticProvenance::Unavailable,
                "the process was not found; its resource use is unknown".into(),
            ));
            continue;
        }
        let pids = tree(root.pid, &children);
        counted.extend(pids.iter().copied());
        let (footprint, unread_memory) = sum(pids.iter().map(|pid| by_pid[pid].footprint_bytes));
        let (cpu, unread_cpu) = sum(pids.iter().map(|pid| by_pid[pid].cpu_time_ms));
        let unread = unread_memory.max(unread_cpu);
        let (provenance, note) = if footprint.is_none() && cpu.is_none() {
            (
                DiagnosticProvenance::Unavailable,
                "no process in the tree could be read".to_owned(),
            )
        } else if unread > 0 {
            (
                DiagnosticProvenance::Approximate,
                format!("{unread} of {} processes could not be read", pids.len()),
            )
        } else {
            (DiagnosticProvenance::Exact, String::new())
        };
        groups.push(group(root, pids, footprint, cpu, provenance, note));
    }
    let (total_footprint_bytes, _) = sum(counted.iter().map(|pid| by_pid[pid].footprint_bytes));
    let (total_cpu_time_ms, _) = sum(counted.iter().map(|pid| by_pid[pid].cpu_time_ms));
    DiagnosticResources {
        observed: true,
        observed_at,
        method: method.into(),
        groups,
        total_processes: counted.len() as u64,
        total_footprint_bytes,
        total_cpu_time_ms,
        host,
    }
}

fn group(
    root: &Root,
    pids: Vec<u32>,
    footprint_bytes: Option<u64>,
    cpu_time_ms: Option<u64>,
    provenance: DiagnosticProvenance,
    note: String,
) -> DiagnosticProcessGroup {
    DiagnosticProcessGroup {
        kind: root.kind,
        subject: root.subject.clone(),
        incarnation: root.incarnation.clone(),
        root_pid: root.pid,
        pids,
        footprint_bytes,
        cpu_time_ms,
        provenance,
        note,
    }
}

/// How this platform measures memory.
pub const METHOD: &str = if cfg!(target_os = "macos") {
    "phys_footprint"
} else if cfg!(target_os = "linux") {
    "proportional_set_size"
} else {
    "unsupported"
};

/// Reads the whole process table, or `None` when it cannot be listed.
#[cfg(target_os = "macos")]
pub fn read_table() -> Option<Vec<Sample>> {
    /// `mach_timebase_info_data_t`: CPU times from `proc_pid_rusage` are in
    /// Mach absolute-time units, which this ratio converts to nanoseconds.
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
    }
    let mut timebase = Timebase { numer: 0, denom: 0 };
    // SAFETY: the pointer refers to a live struct of the C layout the call fills.
    if unsafe { mach_timebase_info(&mut timebase) } != 0 || timebase.denom == 0 {
        return None;
    }
    let mut capacity = 1024usize;
    let pids = loop {
        let mut buffer = vec![0i32; capacity];
        let bytes = (capacity * std::mem::size_of::<i32>()) as libc::c_int;
        // SAFETY: the buffer holds `bytes` bytes and outlives the call.
        let count = unsafe { libc::proc_listallpids(buffer.as_mut_ptr().cast(), bytes) };
        if count < 0 {
            return None;
        }
        if count as usize >= capacity {
            capacity = capacity.checked_mul(4).filter(|c| *c <= 1 << 20)?;
            continue;
        }
        buffer.truncate(count as usize);
        break buffer;
    };
    let ticks_to_ms = |ticks: u64| {
        (ticks as u128 * timebase.numer as u128 / timebase.denom as u128 / 1_000_000) as u64
    };
    let mut table = Vec::with_capacity(pids.len());
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
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
        if read != size {
            // Gone since the listing, or another user's process.
            continue;
        }
        // SAFETY: zeroed plain-old-data struct, filled by the kernel.
        let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        // SAFETY: the flavor matches the struct the pointer refers to.
        let usage_read = unsafe {
            libc::proc_pid_rusage(
                pid,
                libc::RUSAGE_INFO_V2,
                (&mut usage as *mut libc::rusage_info_v2).cast(),
            )
        } == 0;
        table.push(Sample {
            pid: pid as u32,
            ppid: info.pbi_ppid,
            footprint_bytes: usage_read.then_some(usage.ri_phys_footprint),
            cpu_time_ms: usage_read
                .then(|| ticks_to_ms(usage.ri_user_time.saturating_add(usage.ri_system_time))),
        });
    }
    Some(table)
}

/// Reads every `/proc/<pid>`: the parent and CPU ticks from `stat`, the
/// proportional set size from `smaps_rollup`.
#[cfg(target_os = "linux")]
pub fn read_table() -> Option<Vec<Sample>> {
    // SAFETY: sysconf has no preconditions.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let ticks = u64::try_from(ticks).ok().filter(|t| *t > 0)?;
    let mut table = Vec::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // Fields after the parenthesized command name, which may hold spaces.
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let Some(ppid) = fields.get(1).and_then(|f| f.parse().ok()) else {
            continue;
        };
        let cpu = fields
            .get(11)
            .zip(fields.get(12))
            .and_then(|(user, system)| {
                Some(user.parse::<u64>().ok()? + system.parse::<u64>().ok()?)
            })
            .map(|total| total * 1000 / ticks);
        let pss = std::fs::read_to_string(entry.path().join("smaps_rollup"))
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    let kib = line.strip_prefix("Pss:")?.trim().strip_suffix("kB")?.trim();
                    kib.parse::<u64>().ok().map(|kib| kib * 1024)
                })
            });
        table.push(Sample {
            pid,
            ppid,
            footprint_bytes: pss,
            cpu_time_ms: cpu,
        });
    }
    Some(table)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn read_table() -> Option<Vec<Sample>> {
    None
}

/// The host's CPU count, memory and one-minute load average.
pub fn host() -> DiagnosticHost {
    let logical_cpus = std::thread::available_parallelism()
        .ok()
        .map(|n| n.get() as u64);
    let mut load = [0f64; 1];
    // SAFETY: the buffer holds one element, as requested.
    let load_average_milli = (unsafe { libc::getloadavg(load.as_mut_ptr(), 1) } == 1)
        .then(|| (load[0].max(0.0) * 1000.0).round() as u64);
    DiagnosticHost {
        logical_cpus,
        memory_bytes: memory_bytes(),
        load_average_milli,
    }
}

#[cfg(target_os = "macos")]
fn memory_bytes() -> Option<u64> {
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: the name is NUL-terminated and the output buffer is `size` bytes.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
}

#[cfg(target_os = "linux")]
fn memory_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    text.lines().find_map(|line| {
        let kib = line
            .strip_prefix("MemTotal:")?
            .trim()
            .strip_suffix("kB")?
            .trim();
        kib.parse::<u64>().ok().map(|kib| kib * 1024)
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(pid: u32, ppid: u32, footprint: Option<u64>, cpu: Option<u64>) -> Sample {
        Sample {
            pid,
            ppid,
            footprint_bytes: footprint,
            cpu_time_ms: cpu,
        }
    }

    fn root(kind: DiagnosticProcessKind, pid: u32) -> Root {
        Root {
            kind,
            subject: format!("s{pid}"),
            incarnation: None,
            pid,
        }
    }

    fn host() -> DiagnosticHost {
        DiagnosticHost {
            logical_cpus: None,
            memory_bytes: None,
            load_average_milli: None,
        }
    }

    #[test]
    fn nested_groups_count_each_process_once_in_the_totals() {
        // daemon 10 -> runtime 20 -> agent 30 -> tool 31; terminal 40 under the runtime.
        let table = [
            sample(1, 0, Some(1), Some(1)),
            sample(10, 1, Some(100), Some(10)),
            sample(20, 10, Some(200), Some(20)),
            sample(30, 20, Some(300), Some(30)),
            sample(31, 30, Some(310), Some(31)),
            sample(40, 20, Some(400), Some(40)),
        ];
        let roots = [
            root(DiagnosticProcessKind::Daemon, 10),
            root(DiagnosticProcessKind::Runtime, 20),
            root(DiagnosticProcessKind::Agent, 30),
            root(DiagnosticProcessKind::Terminal, 40),
        ];
        let report = measure(&roots, Some(&table), 5, "m", host());
        assert!(report.observed);
        assert_eq!(report.groups[0].pids, vec![10, 20, 30, 31, 40]);
        assert_eq!(report.groups[1].pids, vec![20, 30, 31, 40]);
        assert_eq!(report.groups[2].pids, vec![30, 31]);
        assert_eq!(report.groups[2].footprint_bytes, Some(610));
        assert_eq!(report.groups[3].cpu_time_ms, Some(40));
        let group_sum: u64 = report.groups.iter().filter_map(|g| g.footprint_bytes).sum();
        assert!(group_sum > report.total_footprint_bytes.unwrap());
        assert_eq!(report.total_processes, 5);
        assert_eq!(report.total_footprint_bytes, Some(1310));
        assert_eq!(report.total_cpu_time_ms, Some(131));
        assert!(
            report
                .groups
                .iter()
                .all(|g| g.provenance == DiagnosticProvenance::Exact)
        );
    }

    #[test]
    fn missing_and_unreadable_processes_are_marked_not_zeroed() {
        let table = [
            sample(10, 1, Some(100), Some(1)),
            sample(11, 10, None, None),
        ];
        let roots = [
            root(DiagnosticProcessKind::Daemon, 10),
            root(DiagnosticProcessKind::Terminal, 99),
            root(DiagnosticProcessKind::Agent, 11),
        ];
        let report = measure(&roots, Some(&table), 5, "m", host());
        assert_eq!(
            report.groups[0].provenance,
            DiagnosticProvenance::Approximate
        );
        assert_eq!(report.groups[0].footprint_bytes, Some(100));
        assert_eq!(
            report.groups[1].provenance,
            DiagnosticProvenance::Unavailable
        );
        assert_eq!(report.groups[1].footprint_bytes, None);
        assert!(report.groups[1].pids.is_empty());
        assert_eq!(
            report.groups[2].provenance,
            DiagnosticProvenance::Unavailable
        );
        assert_eq!(report.groups[2].footprint_bytes, None);

        let blind = measure(&roots, None, 5, "m", host());
        assert!(!blind.observed);
        assert_eq!(blind.total_footprint_bytes, None);
        assert!(
            blind
                .groups
                .iter()
                .all(|g| g.provenance == DiagnosticProvenance::Unavailable)
        );
    }

    #[test]
    fn a_parent_cycle_terminates() {
        let table = [
            sample(10, 11, Some(1), Some(1)),
            sample(11, 10, Some(1), Some(1)),
        ];
        let report = measure(
            &[root(DiagnosticProcessKind::Daemon, 10)],
            Some(&table),
            5,
            "m",
            host(),
        );
        assert_eq!(report.groups[0].pids, vec![10, 11]);
    }
}
