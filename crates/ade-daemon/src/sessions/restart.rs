//! Runtime restart reconciliation: the reads and effects around the pure
//! classifier in `recovery.rs` (R005, R006; architecture section 4).
//!
//! While a runtime incarnation lives, the daemon records the process identity
//! (PID, start stamp, group leadership) of every terminal shell and provider
//! process it runs. When the daemon later finds a different incarnation, it
//! classifies every attempt the old one owned from that record and fresh
//! observations, writes one report, records activity for each attempt that did
//! not settle, and keeps the resources of those attempts reserved. It never
//! replays anything. Open attempts are observed again until evidence settles
//! them or the user releases an `unknown` one.
use super::leases::{Claim, Holder, LeaseKey, Observation, Release, Verdict};
use super::recovery::{self, Evidence, Facts, Ports, Presence, ProcessRecord, Tree};
use super::*;
use crate::store::runtime_recovery::{
    ATTEMPT_DESCENDANTS_MAX, AttemptRecord, RecoveryNotice, RuntimeIncarnation,
};
use ade_core::contract::agents::{AgentList, TrackedDescendant};
use ade_core::contract::daemon::{
    RecoveredAttempt, RecoveredAttemptKind, RecoveryClassification, RecoveryReport,
    RuntimeRecovery, RuntimeRecoveryReleaseRequest, RuntimeRecoveryReleased,
    RuntimeRecoveryRequest,
};
use ade_runtime::descendants::{Identity, Tracker};
use anyhow::Context as _;

/// Monitor ticks (250 ms each) between attempt identity snapshots.
const SNAPSHOT_TICKS: u32 = 8;
/// Monitor ticks between observations of open attempts.
const RECHECK_TICKS: u32 = 40;

/// In-memory recovery state, kept in `Data`.
#[derive(Default)]
pub(super) struct State {
    /// Open attempts by key, observed again until evidence settles them.
    watch: HashMap<String, Watch>,
    /// The attempt records last written for the current incarnation.
    recorded: Vec<AttemptRecord>,
    /// The tree of each recorded process by key and PID, extended at every
    /// snapshot so a descendant that leaves the group stays attributed.
    trackers: HashMap<(String, u32), Tracker>,
    tick: u32,
}

impl State {
    /// Whether runtime restart reconciliation owns this lease. Ordinary lease
    /// reconciliation must not settle it: the new runtime never saw it.
    pub(super) fn holds(&self, key: &LeaseKey) -> bool {
        self.watch
            .values()
            .any(|watch| watch.lease.as_ref() == Some(key))
    }
}

#[derive(Clone)]
struct Watch {
    report_id: String,
    lease: Option<LeaseKey>,
    facts: Facts,
    record: Option<ProcessRecord>,
    runtime: Vec<RuntimeIncarnation>,
    ports: Vec<u16>,
    /// The incarnation and key of the attempt record behind `record`, so
    /// descendants found after the restart are recorded durably with it.
    origin: Option<(String, String)>,
}

/// The report key of a lease.
fn lease_key(key: &LeaseKey) -> String {
    match key {
        LeaseKey::Agent(id) => format!("agent:{id}"),
        LeaseKey::Service { workspace_id, name } => format!("service:{workspace_id}:{name}"),
        LeaseKey::Script {
            workspace_id,
            run_id,
        } => format!("script:{workspace_id}:{run_id}"),
    }
}

/// The key of the runtime-side record of a lease's process: the provider
/// process of an Agent, or the terminal shell of a service or script run.
fn record_key(claim: &Claim) -> String {
    match (&claim.key, &claim.holder) {
        (LeaseKey::Agent(id), _) => format!("agent:{id}"),
        (_, Holder::Terminal { terminal_id, .. }) => {
            format!("terminal:{}:{terminal_id}", claim.workspace_id)
        }
        (_, Holder::Agent { .. }) => String::new(),
    }
}

/// Reads one process's start stamp and group leadership.
fn identify(pid: u32) -> Option<(u64, bool)> {
    let pid = i32::try_from(pid).ok().filter(|pid| *pid > 0)?;
    ade_runtime::descendants::observe(pid, &[pid])
        .ok()?
        .into_iter()
        .find(|row| row.identity.pid == pid && !row.zombie)
        .map(|row| (row.identity.started, row.pgid == pid))
}

/// The descendants a runtime terminal reports in its metrics. A malformed
/// entry is skipped; the report only adds candidates, which a fresh read
/// confirms by identity before they are recorded.
fn reported_descendants(value: &Value) -> Vec<Identity> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(Identity {
                        pid: i32::try_from(entry["pid"].as_i64()?).ok()?,
                        started: entry["started"].as_u64()?,
                    })
                })
                .take(ATTEMPT_DESCENDANTS_MAX)
                .collect()
        })
        .unwrap_or_default()
}

/// The descendants the runtime reports it tracks for one Agent run. Like a
/// terminal's report, it only adds candidates that a fresh read confirms.
fn agent_descendants(reported: Option<&[TrackedDescendant]>) -> Vec<Identity> {
    reported
        .unwrap_or_default()
        .iter()
        .map(|descendant| Identity {
            pid: descendant.pid,
            started: descendant.started,
        })
        .take(ATTEMPT_DESCENDANTS_MAX)
        .collect()
}

/// Extends one recorded process's tree from a fresh table read and returns
/// its descendants other than the process itself. A failed read keeps what
/// was already tracked.
fn track_descendants(tracker: &mut Tracker, pid: u32, started: u64) -> Vec<(u32, u64)> {
    if let Ok(rows) = ade_runtime::descendants::observe(pid as i32, &tracker.parents()) {
        tracker.observe(&rows);
        tracker.forget_exited(&rows);
    }
    let mut descendants: Vec<(u32, u64)> = tracker
        .tracked()
        .into_iter()
        .filter(|identity| !(identity.pid as u32 == pid && identity.started == started))
        .filter_map(|identity| {
            u32::try_from(identity.pid)
                .ok()
                .map(|pid| (pid, identity.started))
        })
        .collect();
    descendants.sort_unstable();
    descendants
}

/// Reads one recorded tree. While a recorded process still runs, children it
/// started are added to the record first, so they stay attributed after it
/// exits. Returns the tree and the descendants added.
fn observe_tree(record: &mut ProcessRecord) -> (Tree, Vec<(u32, u64)>) {
    let Ok(pid) = i32::try_from(record.pid) else {
        return (
            Tree::Unreadable(format!("process ID {} is out of range", record.pid)),
            Vec::new(),
        );
    };
    let parents = |record: &ProcessRecord| -> Vec<i32> {
        std::iter::once(pid)
            .chain(
                record
                    .descendants
                    .iter()
                    .filter_map(|&(descendant, _)| i32::try_from(descendant).ok()),
            )
            .collect()
    };
    let mut added = Vec::new();
    // Each read lists the children of the processes known before it, so a
    // grandchild needs another read; the depth is bounded.
    for _ in 0..8 {
        let rows = match ade_runtime::descendants::observe(pid, &parents(record)) {
            Ok(rows) => rows,
            Err(reason) => return (Tree::Unreadable(reason), added),
        };
        let room = ATTEMPT_DESCENDANTS_MAX.saturating_sub(record.descendants.len());
        let found: Vec<_> = recovery::extend(record, &rows)
            .into_iter()
            .take(room)
            .collect();
        if found.is_empty() {
            return (recovery::tree(record, Ok(&rows)), added);
        }
        record.descendants.extend(found.iter().copied());
        added.extend(found);
    }
    let rows = ade_runtime::descendants::observe(pid, &parents(record));
    (
        recovery::tree(record, rows.as_deref().map_err(String::as_str)),
        added,
    )
}

/// The presence of the old runtimes that could own an attempt: running if any
/// runs, unreadable if any cannot be read, gone only when all are gone.
fn observe_runtimes(runtimes: &[RuntimeIncarnation]) -> Presence {
    let mut result = Presence::Gone;
    for runtime in runtimes {
        let Ok(pid) = i32::try_from(runtime.pid) else {
            continue;
        };
        let rows = ade_runtime::descendants::observe(pid, &[pid]);
        match recovery::presence(
            runtime.pid,
            runtime.started,
            rows.as_deref().map_err(String::as_str),
        ) {
            Presence::Running => return Presence::Running,
            Presence::Unreadable(reason) => result = Presence::Unreadable(reason),
            Presence::Gone => {}
        }
    }
    result
}

/// Listener observation is slow, so it is read at most once per pass.
#[derive(Default)]
struct Listeners(Option<std::result::Result<Vec<(u16, u32)>, String>>);

impl Listeners {
    fn ports(&mut self, assigned: &[u16]) -> Ports {
        if assigned.is_empty() {
            return Ports::NotApplicable;
        }
        let observed = self.0.get_or_insert_with(|| {
            crate::listeners::observe()
                .map(|all| all.into_iter().map(|l| (l.port, l.pid)).collect())
                .map_err(|error| format!("{error:#}"))
        });
        recovery::ports(assigned, observed.as_deref().map_err(String::as_str))
    }
}

/// Observes one watched attempt. Returns the evidence and the descendants
/// added to its record, which the caller records with [`remember`].
fn gather(watch: &mut Watch, listeners: &mut Listeners) -> (Evidence, Vec<(u32, u64)>) {
    let (tree, added) = match watch.record.as_mut().map(observe_tree) {
        Some((tree, added)) => (Some(tree), added),
        None => (None, Vec::new()),
    };
    let ports = if tree == Some(Tree::Gone) {
        listeners.ports(&watch.ports)
    } else {
        Ports::NotApplicable
    };
    let evidence = Evidence {
        runtime: observe_runtimes(&watch.runtime),
        tree,
        ports,
    };
    (evidence, added)
}

/// Records descendants found after the restart with the attempt, durably and
/// in the watched copy, so a later observation or daemon start still counts
/// them once their parent has exited.
fn remember(d: &mut Data, key: &str, watch: &Watch, added: &[(u32, u64)]) {
    if added.is_empty() {
        return;
    }
    if let Some((instance, record_key)) = &watch.origin
        && let Err(error) = d.store.add_attempt_descendants(instance, record_key, added)
    {
        eprintln!("Runtime restart reconciliation: {key}: {error:#}");
    }
    if let Some(current) = d.recovery.watch.get_mut(key)
        && let (Some(record), Some(grown)) = (current.record.as_mut(), watch.record.as_ref())
        && record.pid == grown.pid
        && record.started == grown.started
    {
        for descendant in added {
            if !record.descendants.contains(descendant) {
                record.descendants.push(*descendant);
            }
        }
    }
}

fn open_count(report: &RecoveryReport) -> u32 {
    report
        .attempts
        .iter()
        .filter(|a| a.classification != RecoveryClassification::Settled && a.resolved_at.is_none())
        .count() as u32
}

fn resolve_in(report: &mut RecoveryReport, key: &str, resolution: String) -> bool {
    let Some(attempt) = report
        .attempts
        .iter_mut()
        .find(|a| a.key == key && a.resolved_at.is_none())
    else {
        return false;
    };
    attempt.resolved_at = Some(now_ms());
    attempt.resolution = Some(resolution);
    report.open = open_count(report);
    true
}

fn classification_name(classification: RecoveryClassification) -> &'static str {
    match classification {
        RecoveryClassification::Settled => "settled",
        RecoveryClassification::Quarantined => "quarantined: processes from it still run",
        RecoveryClassification::Unknown => "unknown",
    }
}

fn process(record: &AttemptRecord) -> ProcessRecord {
    ProcessRecord {
        pid: record.pid,
        started: record.started,
        leader: record.leader,
        descendants: record.descendants.clone(),
    }
}

/// Everything restart reconciliation knows before it classifies.
struct Context {
    current: String,
    /// The daemon has never owned the current incarnation before.
    fresh: bool,
    previous: Vec<RuntimeIncarnation>,
    /// Records by key; a later incarnation's record wins.
    records: HashMap<String, AttemptRecord>,
    incarnations: HashMap<String, RuntimeIncarnation>,
    /// Open attempts of earlier reports, by key, with their report ID.
    open: HashMap<String, String>,
}

impl Context {
    fn runtimes_for(&self, record: Option<&AttemptRecord>) -> Vec<RuntimeIncarnation> {
        match record.and_then(|r| self.incarnations.get(&r.instance)) {
            Some(runtime) => vec![runtime.clone()],
            None => self.incarnations.values().cloned().collect(),
        }
    }
}

/// One attempt to classify in the restore pass.
struct Candidate {
    key: String,
    watch: Watch,
    /// The report entry; its classification is filled in by the pass.
    attempt: RecoveredAttempt,
    conversation_id: String,
    turn_id: Option<String>,
    title: String,
}

/// The state of one restore pass.
struct Pass {
    report_id: String,
    listeners: Listeners,
    attempts: Vec<RecoveredAttempt>,
    notices: Vec<RecoveryNotice>,
    /// Earlier reports touched by this pass.
    earlier: HashMap<String, RecoveryReport>,
}

impl Pass {
    fn earlier(&mut self, d: &Data, id: &str) -> Result<&mut RecoveryReport> {
        if !self.earlier.contains_key(id) {
            let report = d.store.recovery_report(id)?;
            self.earlier.insert(id.to_owned(), report);
        }
        Ok(self.earlier.get_mut(id).expect("inserted above"))
    }

    /// Classifies one candidate and records the outcome.
    fn classify(
        &mut self,
        d: &mut Data,
        context: &Context,
        mut candidate: Candidate,
    ) -> Result<recovery::Outcome> {
        let (evidence, added) = gather(&mut candidate.watch, &mut self.listeners);
        let outcome = recovery::classify(&candidate.watch.facts, &evidence);
        if let Some((instance, record_key)) = &candidate.watch.origin
            && !added.is_empty()
        {
            d.store
                .add_attempt_descendants(instance, record_key, &added)?;
        }
        let settled = outcome.classification == RecoveryClassification::Settled;
        let key = candidate.key;
        eprintln!(
            "Runtime restart reconciliation: {key}: {:?}: {}",
            outcome.classification, outcome.reason
        );
        if let Some(earlier_id) = context.open.get(&key) {
            // Reconciled by an earlier start: settle it there, or keep watching.
            if settled {
                let reason = format!("a later observation settled it: {}", outcome.reason);
                resolve_in(self.earlier(d, earlier_id)?, &key, reason);
            }
        } else {
            if !settled {
                self.notices.push(RecoveryNotice {
                    source_key: format!("runtime-recovery:{}:{key}", self.report_id),
                    workspace_id: candidate.attempt.workspace_id.clone(),
                    conversation_id: candidate.conversation_id,
                    turn_id: candidate.turn_id,
                    title: candidate.title,
                    detail: format!(
                        "The runtime restarted. This attempt is {}: {}. Nothing was replayed.",
                        classification_name(outcome.classification),
                        outcome.reason
                    ),
                });
            }
            self.attempts.push(RecoveredAttempt {
                classification: outcome.classification,
                reason: outcome.reason.clone(),
                pids: outcome.pids.clone(),
                outcome_unknown: outcome.outcome_unknown,
                ..candidate.attempt
            });
        }
        if !settled {
            d.recovery.watch.insert(key, candidate.watch);
        }
        Ok(outcome)
    }
}

impl Sessions {
    /// Called from the restore pass with the ordinary lease plan. When the
    /// runtime restarted, re-decides every lease the old incarnation owned
    /// from evidence, classifies its plain terminals, writes the report and
    /// returns the adjusted plan.
    pub(super) fn reconcile_runtime_restart(
        &self,
        d: &mut Data,
        plan: Vec<(Claim, Verdict)>,
        observed: &Observation,
    ) -> Result<Vec<(Claim, Verdict)>> {
        let Some(context) = self.recovery_context(d)? else {
            return Ok(plan);
        };
        let mut pass = Pass {
            report_id: new_id("recovery"),
            listeners: Listeners::default(),
            attempts: Vec::new(),
            notices: Vec::new(),
            earlier: HashMap::new(),
        };
        let mut consumed = HashSet::new();
        let mut adjusted = Vec::with_capacity(plan.len());
        for (claim, verdict) in plan {
            let key = lease_key(&claim.key);
            let rkey = record_key(&claim);
            let record = context.records.get(&rkey);
            let from_old_instance = matches!(
                &claim.holder,
                Holder::Terminal { runtime_instance: Some(instance), .. } if *instance != context.current
            );
            let attributed = recovery::attributed(&recovery::Ownership {
                open: context.open.contains_key(&key),
                restarted: !context.previous.is_empty(),
                live_now: verdict == Verdict::Live,
                old_instance_recorded: from_old_instance,
                fresh_runtime: context.fresh,
                old_record: record.is_some(),
            });
            if !attributed {
                adjusted.push((claim, verdict));
                continue;
            }
            consumed.insert(rkey);
            let candidate = self.lease_candidate(d, &context, &pass, &claim, key, record);
            let outcome = pass.classify(d, &context, candidate)?;
            let verdict = if outcome.classification == RecoveryClassification::Settled {
                Verdict::Released(Release::Absent)
            } else {
                Verdict::Uncertain(format!("the runtime restarted: {}", outcome.reason))
            };
            adjusted.push((claim, verdict));
        }
        // Plain terminals hold no lease; they are classified for the report
        // unless the current runtime still lists them.
        let listed: HashSet<String> = observed
            .terminals
            .iter()
            .map(|t| format!("terminal:{}:{}", t.workspace_id, t.terminal_id))
            .collect();
        let mut terminals: Vec<&AttemptRecord> = context
            .records
            .values()
            .filter(|r| r.key.starts_with("terminal:"))
            .filter(|r| !consumed.contains(&r.key) && !listed.contains(&r.key))
            .collect();
        terminals.sort_by(|a, b| a.key.cmp(&b.key));
        for record in terminals {
            let mut parts = record.key.splitn(3, ':').skip(1);
            let workspace_id = parts.next().unwrap_or_default().to_owned();
            let terminal_id = parts.next().unwrap_or_default().to_owned();
            let candidate = Candidate {
                key: record.key.clone(),
                watch: Watch {
                    report_id: context
                        .open
                        .get(&record.key)
                        .cloned()
                        .unwrap_or_else(|| pass.report_id.clone()),
                    lease: None,
                    facts: Facts {
                        kind: RecoveredAttemptKind::Terminal,
                        in_flight: true,
                        native_session: false,
                    },
                    record: Some(process(record)),
                    runtime: context.runtimes_for(Some(record)),
                    ports: Vec::new(),
                    origin: Some((record.instance.clone(), record.key.clone())),
                },
                attempt: RecoveredAttempt {
                    key: record.key.clone(),
                    kind: RecoveredAttemptKind::Terminal,
                    workspace_id,
                    subject: terminal_id.clone(),
                    attempt: record.attempt.clone(),
                    runtime_instance: Some(record.instance.clone()),
                    classification: RecoveryClassification::Unknown,
                    reason: String::new(),
                    pids: Vec::new(),
                    outcome_unknown: false,
                    resolved_at: None,
                    resolution: None,
                },
                conversation_id: String::new(),
                turn_id: None,
                title: format!("Terminal {terminal_id}"),
            };
            pass.classify(d, &context, candidate)?;
        }
        // An open attempt of an earlier report that nothing claims any more
        // was released through a control path.
        for (key, earlier_id) in &context.open {
            if !d.recovery.watch.contains_key(key) {
                let report = pass.earlier(d, earlier_id)?;
                resolve_in(report, key, "its durable claim no longer exists".into());
            }
        }
        for report in pass.earlier.values() {
            d.store.update_recovery_report(report)?;
        }
        if !context.previous.is_empty() {
            let mut report = RecoveryReport {
                id: pass.report_id,
                previous_instances: context
                    .previous
                    .iter()
                    .map(|p| p.instance.clone())
                    .collect(),
                current_instance: context.current.clone(),
                detected_at: now_ms(),
                attempts: pass.attempts,
                open: 0,
            };
            report.open = open_count(&report);
            d.store.save_recovery_report(&report, pass.notices)?;
            eprintln!(
                "Runtime restart reconciliation: {} attempt(s), {} open",
                report.attempts.len(),
                report.open
            );
        }
        self.record_incarnation(d)?;
        Ok(adjusted)
    }

    /// Builds the candidate for one durable lease.
    fn lease_candidate(
        &self,
        d: &Data,
        context: &Context,
        pass: &Pass,
        claim: &Claim,
        key: String,
        record: Option<&AttemptRecord>,
    ) -> Candidate {
        let in_flight_facts = |kind| Facts {
            kind,
            in_flight: true,
            native_session: false,
        };
        let (facts, subject, conversation_id, turn_id, title, ports) = match &claim.key {
            LeaseKey::Agent(id) => {
                let c = d.store.conversation(id).ok();
                let recorded_run = c.as_ref().is_some_and(|c| {
                    c.runtime_run.is_some() && record.is_some_and(|r| r.attempt == c.runtime_run)
                });
                (
                    Facts {
                        kind: RecoveredAttemptKind::ProviderTurn,
                        in_flight: recovery::turn_in_flight(
                            c.as_ref().map(|c| c.status.as_str()),
                            recorded_run,
                        ),
                        native_session: c.as_ref().is_some_and(|c| c.provider_thread_id.is_some()),
                    },
                    id.clone(),
                    id.clone(),
                    c.as_ref()
                        .and_then(|c| c.active_turn_id.clone().or(c.runtime_submission.clone())),
                    c.map_or_else(|| "Agent run".into(), |c| c.title),
                    Vec::new(),
                )
            }
            LeaseKey::Service { workspace_id, name } => (
                in_flight_facts(RecoveredAttemptKind::Service),
                name.clone(),
                String::new(),
                None,
                format!("Service {name}"),
                d.store
                    .service(workspace_id, name)
                    .map(|s| s.ports.values().copied().collect())
                    .unwrap_or_default(),
            ),
            LeaseKey::Script { run_id, .. } => (
                in_flight_facts(RecoveredAttemptKind::Script),
                run_id.clone(),
                String::new(),
                None,
                "Script run".into(),
                Vec::new(),
            ),
        };
        let (holder_attempt, holder_instance) = match &claim.holder {
            Holder::Agent { run, .. } => (run.clone(), None),
            Holder::Terminal {
                transfer_id,
                runtime_instance,
                ..
            } => (transfer_id.clone(), runtime_instance.clone()),
        };
        Candidate {
            watch: Watch {
                report_id: context
                    .open
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| pass.report_id.clone()),
                lease: Some(claim.key.clone()),
                facts: facts.clone(),
                record: record.map(process),
                runtime: context.runtimes_for(record),
                ports,
                origin: record.map(|r| (r.instance.clone(), r.key.clone())),
            },
            attempt: RecoveredAttempt {
                key: key.clone(),
                kind: facts.kind,
                workspace_id: claim.workspace_id.clone(),
                subject,
                attempt: record.and_then(|r| r.attempt.clone()).or(holder_attempt),
                runtime_instance: record.map(|r| r.instance.clone()).or(holder_instance),
                classification: RecoveryClassification::Unknown,
                reason: String::new(),
                pids: Vec::new(),
                outcome_unknown: false,
                resolved_at: None,
                resolution: None,
            },
            key,
            conversation_id,
            turn_id,
            title,
        }
    }

    /// Records the incarnation this daemon owns. It is recorded only after any
    /// report about earlier ones commits, so a daemon that dies in between
    /// still finds the current incarnation fresh on its next start.
    fn record_incarnation(&self, d: &mut Data) -> Result<()> {
        d.store.record_runtime_incarnation(&RuntimeIncarnation {
            instance: self.runtime.instance.clone(),
            pid: self.runtime.pid,
            started: identify(self.runtime.pid).map(|(started, _)| started),
        })
    }

    /// Reads what earlier incarnations left. `None` when there is nothing to
    /// reconcile.
    fn recovery_context(&self, d: &mut Data) -> Result<Option<Context>> {
        let current = self.runtime.instance.clone();
        let fresh = !d.store.runtime_incarnation_known(&current)?;
        let previous = d.store.unreconciled_incarnations(&current)?;
        let open_reports = d.store.recovery_reports(true)?;
        if previous.is_empty() && open_reports.is_empty() {
            self.record_incarnation(d)?;
            return Ok(None);
        }
        let mut instances: Vec<String> = Vec::new();
        let mut open = HashMap::new();
        for report in &open_reports {
            instances.extend(report.previous_instances.iter().cloned());
            for attempt in &report.attempts {
                if attempt.classification != RecoveryClassification::Settled
                    && attempt.resolved_at.is_none()
                {
                    open.insert(attempt.key.clone(), report.id.clone());
                }
            }
        }
        instances.extend(previous.iter().map(|p| p.instance.clone()));
        let mut seen = HashSet::new();
        instances.retain(|instance| seen.insert(instance.clone()));
        let mut records = HashMap::new();
        for record in d.store.attempt_records(&instances)? {
            records.insert(record.key.clone(), record);
        }
        let incarnations = d
            .store
            .runtime_incarnations(&instances)?
            .into_iter()
            .map(|i| (i.instance.clone(), i))
            .collect();
        Ok(Some(Context {
            current,
            fresh,
            previous,
            records,
            incarnations,
            open,
        }))
    }

    /// Runs from the monitor loop: records attempt identities for the current
    /// incarnation and observes open attempts again.
    pub(super) fn recovery_tick(&self) -> Result<()> {
        let (snapshot, recheck, appearance_pending) = {
            let mut d = self.data.lock().unwrap();
            d.recovery.tick = d.recovery.tick.wrapping_add(1);
            if d.draining || self.runtime.draining() {
                return Ok(());
            }
            (
                d.recovery.tick.is_multiple_of(SNAPSHOT_TICKS),
                d.recovery.tick.is_multiple_of(RECHECK_TICKS) && !d.recovery.watch.is_empty(),
                d.appearance_pending,
            )
        };
        if appearance_pending {
            let _lifecycle = self.plugin_lifecycle.lock().unwrap();
            self.sync_plugin_themes()?;
        }
        if snapshot {
            self.record_attempts()?;
        }
        if recheck {
            self.recheck_open_attempts()?;
        }
        Ok(())
    }

    /// Records the process identity of every terminal shell and provider
    /// process the current incarnation runs. Writes only on change.
    fn record_attempts(&self) -> Result<()> {
        let terminals = self.runtime.command(TerminalCommand::List)?;
        let agents: AgentList = serde_json::from_value(self.runtime.agent(AgentOp::List)?)
            .context("Invalid Agent catalogue")?;
        // Key, attempt, PID, and the descendants the runtime reports it tracks.
        let mut wanted: Vec<(String, Option<String>, u32, Vec<Identity>)> = Vec::new();
        for item in terminals["terminals"]
            .as_array()
            .context("Invalid terminal catalogue")?
        {
            let (Some(workspace), Some(terminal), Some(pid)) = (
                item["workspace"]["id"].as_str(),
                item["workspace"]["terminal_id"].as_str(),
                item["metrics"]["shell_pid"].as_u64(),
            ) else {
                continue;
            };
            wanted.push((
                format!("terminal:{workspace}:{terminal}"),
                item["metrics"]["transfer_id"].as_str().map(str::to_owned),
                u32::try_from(pid).unwrap_or(0),
                reported_descendants(&item["metrics"]["descendants"]),
            ));
        }
        for run in agents.agents {
            if let Some(pid) = run.pid {
                wanted.push((
                    format!("agent:{}", run.spec.conversation),
                    Some(run.spec.run),
                    pid,
                    agent_descendants(run.descendants.as_deref()),
                ));
            }
        }
        let instance = self.runtime.instance.clone();
        let (previous, mut trackers) = {
            let mut d = self.data.lock().unwrap();
            (
                d.recovery.recorded.clone(),
                std::mem::take(&mut d.recovery.trackers),
            )
        };
        let mut kept = HashMap::new();
        let mut records = Vec::with_capacity(wanted.len());
        for (key, attempt, pid, reported) in wanted {
            if pid == 0 {
                continue;
            }
            // The same key, attempt and PID is the same process; skip the read.
            let identity = match previous
                .iter()
                .find(|r| r.key == key && r.attempt == attempt && r.pid == pid)
            {
                Some(known) => Some((known.started, known.leader)),
                // An exited shell can no longer be identified; it stays unrecorded.
                None => identify(pid),
            };
            let Some((started, leader)) = identity else {
                continue;
            };
            let tracker_key = (key.clone(), pid);
            let mut tracker = trackers
                .remove(&tracker_key)
                .unwrap_or_else(|| Tracker::new(pid as i32, pid as i32));
            // The runtime observes the tree while it runs; what it saw joins
            // this tracker, which keeps it only while the same identity runs.
            tracker.adopt(&reported);
            let descendants = track_descendants(&mut tracker, pid, started);
            kept.insert(tracker_key, tracker);
            records.push(AttemptRecord {
                instance: instance.clone(),
                key,
                attempt,
                pid,
                started,
                leader,
                descendants,
            });
        }
        self.data.lock().unwrap().recovery.trackers = kept;
        records.sort_by(|a, b| a.key.cmp(&b.key));
        let mut d = self.data.lock().unwrap();
        if records != d.recovery.recorded {
            d.store.replace_attempt_records(&instance, &records)?;
            d.recovery.recorded = records;
        }
        Ok(())
    }

    /// Observes open attempts again and settles those with new evidence.
    fn recheck_open_attempts(&self) -> Result<()> {
        let watched: Vec<(String, Watch)> = {
            let d = self.data.lock().unwrap();
            d.recovery
                .watch
                .iter()
                .map(|(key, watch)| (key.clone(), watch.clone()))
                .collect()
        };
        let mut listeners = Listeners::default();
        for (key, mut watch) in watched {
            let (evidence, added) = gather(&mut watch, &mut listeners);
            let outcome = recovery::classify(&watch.facts, &evidence);
            if !added.is_empty() {
                remember(&mut self.data.lock().unwrap(), &key, &watch, &added);
            }
            if outcome.classification == RecoveryClassification::Settled {
                let mut d = self.data.lock().unwrap();
                self.resolve_attempt(
                    &mut d,
                    &key,
                    format!("a later observation settled it: {}", outcome.reason),
                )?;
            }
        }
        Ok(())
    }

    /// Closes one open attempt: updates its report and releases its lease.
    fn resolve_attempt(&self, d: &mut Data, key: &str, resolution: String) -> Result<()> {
        let Some(watch) = d.recovery.watch.remove(key) else {
            return Ok(());
        };
        eprintln!("Runtime restart reconciliation: {key}: resolved: {resolution}");
        let mut report = d.store.recovery_report(&watch.report_id)?;
        if resolve_in(&mut report, key, resolution) {
            d.store.update_recovery_report(&report)?;
        }
        if let Some(lease) = &watch.lease
            && let Some(unresolved) = d.unresolved.remove(lease)
        {
            // A service's durable reservation stays, and keeps its worktree lease.
            Self::keep_settled_lease(d, unresolved, false);
            if let LeaseKey::Script {
                workspace_id,
                run_id,
            } = lease
            {
                // The new runtime never held this run; its durable membership goes.
                d.store.retire_script_run(workspace_id, run_id)?;
                self.catalog_changed(d)?;
            }
        }
        Ok(())
    }

    /// Before a control path (service stop, script retire) releases a lease
    /// that restart reconciliation watches, observes the attempt again outside
    /// the data lock. Refuses unless the observation settles it, because the
    /// replacement runtime's silence is not proof of exit. Returns the
    /// resolution to record, or `None` when the lease is not watched.
    pub(super) fn recovery_control_release(&self, lease: &LeaseKey) -> Result<Option<String>> {
        let key = lease_key(lease);
        let Some(mut watch) = self
            .data
            .lock()
            .unwrap()
            .recovery
            .watch
            .get(&key)
            .filter(|watch| watch.lease.as_ref() == Some(lease))
            .cloned()
        else {
            return Ok(None);
        };
        let (evidence, added) = gather(&mut watch, &mut Listeners::default());
        remember(&mut self.data.lock().unwrap(), &key, &watch, &added);
        let outcome = recovery::classify(&watch.facts, &evidence);
        recovery::control_release(&outcome)
            .map(Some)
            .map_err(anyhow::Error::msg)
    }

    /// A control path (service stop, script retire) settled a lease that
    /// restart reconciliation was watching, after
    /// [`Sessions::recovery_control_release`] allowed it.
    pub(super) fn recovery_lease_settled(
        &self,
        d: &mut Data,
        lease: &LeaseKey,
        resolution: Option<String>,
    ) {
        let key = lease_key(lease);
        let Some(watch) = d.recovery.watch.remove(&key) else {
            return;
        };
        let result = d
            .store
            .recovery_report(&watch.report_id)
            .and_then(|mut report| {
                let resolution = resolution
                    .unwrap_or_else(|| "released through its own stop or retire command".into());
                if resolve_in(&mut report, &key, resolution) {
                    d.store.update_recovery_report(&report)?;
                }
                Ok(())
            });
        if let Err(error) = result {
            eprintln!("Runtime restart reconciliation: {key}: {error:#}");
        }
    }

    pub(super) fn recovery_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or_default() {
            "runtime.recovery" => {
                let request: RuntimeRecoveryRequest = decode(request)?;
                let d = self.data.lock().unwrap();
                reply(&RuntimeRecovery {
                    tag: Default::default(),
                    current_instance: self.runtime.instance.clone(),
                    reports: d.store.recovery_reports(request.open_only == Some(true))?,
                })
            }
            "runtime.recovery.release" => {
                let request: RuntimeRecoveryReleaseRequest = decode(request)?;
                non_empty("report_id", &request.report_id)?;
                non_empty("attempt_key", &request.attempt_key)?;
                reply(&self.release_attempt(&request)?)
            }
            _ => bail!("Unknown session operation"),
        }
    }

    fn release_attempt(
        &self,
        request: &RuntimeRecoveryReleaseRequest,
    ) -> Result<RuntimeRecoveryReleased> {
        let key = request.attempt_key.as_str();
        let (report, watch) = {
            let d = self.data.lock().unwrap();
            let report = d.store.recovery_report(&request.report_id)?;
            let watch = d
                .recovery
                .watch
                .get(key)
                .filter(|w| w.report_id == report.id)
                .cloned();
            (report, watch)
        };
        let attempt = report
            .attempts
            .iter()
            .find(|a| a.key == key)
            .with_context(|| format!("Recovery report {} has no attempt {key}", report.id))?;
        let released = |report: RecoveryReport| RuntimeRecoveryReleased {
            tag: Default::default(),
            attempt_key: key.to_owned(),
            report,
        };
        if attempt.classification == RecoveryClassification::Settled
            || attempt.resolved_at.is_some()
        {
            return Ok(released(report));
        }
        let Some(mut watch) = watch else {
            bail!(
                "The attempt is open but this daemon is not observing it; restart the daemon to reconcile it again"
            )
        };
        // Observe again outside the lock: a live process refuses the release.
        let (evidence, added) = gather(&mut watch, &mut Listeners::default());
        remember(&mut self.data.lock().unwrap(), key, &watch, &added);
        let outcome = recovery::classify(&watch.facts, &evidence);
        let resolution = match outcome.classification {
            RecoveryClassification::Quarantined => bail!(
                "The attempt is still running ({}). Stop those processes before releasing it",
                outcome.reason
            ),
            RecoveryClassification::Settled => {
                format!("a later observation settled it: {}", outcome.reason)
            }
            RecoveryClassification::Unknown => format!(
                "released by the user without proof of exit ({}); nothing was replayed",
                outcome.reason
            ),
        };
        let mut d = self.data.lock().unwrap();
        self.resolve_attempt(&mut d, key, resolution)?;
        Ok(released(d.store.recovery_report(&request.report_id)?))
    }
}
