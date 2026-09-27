//! `diagnostics.status` and `diagnostics.export`: read-only reports on queue,
//! counter, receipt, execution, claim and retention state (F136, F137).
//!
//! A report never waits on a draining runtime and never reports a source it
//! could not read as empty: the value is absent, its provenance says
//! `unavailable`, and `degraded` names the source.
use super::*;
use ade_core::contract::agents::AgentList;
use ade_core::contract::daemon::{
    DiagnosticClaims, DiagnosticCounter, DiagnosticCounterKind, DiagnosticIdentity, DiagnosticLive,
    DiagnosticProcessKind, DiagnosticProvenance, DiagnosticQueue, DiagnosticRetention,
    DiagnosticRun, DiagnosticUnit, DiagnosticUnknown, DiagnosticUnknownSource, DiagnosticWindow,
    DiagnosticsExport, DiagnosticsExportRequest, DiagnosticsStatus, DiagnosticsStatusRequest,
};
use ade_daemon::observability::{self as observe, redact};
use ade_daemon::sessions::FEED_QUEUE_CAPACITY;

/// The serialized bundle stays under this many bytes.
const EXPORT_MAX_BYTES: usize = 1024 * 1024;
const DEFAULT_EVENTS: u32 = 200;
const MAX_EVENTS: u32 = 1000;
/// The runtime supervisor's Agent run limit.
const AGENT_RUN_LIMIT: u64 = 16;
const FORMAT: &str = "ade-diagnostics-v1";

/// What a bundle never contains, whatever its sources hold.
const EXCLUDED: &[&str] = &[
    "credentials, tokens and account contexts",
    "conversation transcripts, prompts and drafts",
    "terminal, service and script output",
    "environment variables",
    "file contents and diffs",
    "workspace roots and names",
];

fn queue(
    name: &str,
    unit: DiagnosticUnit,
    depth: Option<u64>,
    capacity: Option<u64>,
    note: &str,
) -> DiagnosticQueue {
    DiagnosticQueue {
        name: name.into(),
        unit,
        provenance: if depth.is_some() {
            DiagnosticProvenance::Exact
        } else {
            DiagnosticProvenance::Unavailable
        },
        depth,
        capacity,
        note: note.into(),
    }
}

fn counter(
    name: &str,
    kind: DiagnosticCounterKind,
    value: Option<u64>,
    window: DiagnosticWindow,
    note: &str,
) -> DiagnosticCounter {
    DiagnosticCounter {
        name: name.into(),
        kind,
        provenance: if value.is_some() {
            DiagnosticProvenance::Approximate
        } else {
            DiagnosticProvenance::Unavailable
        },
        value,
        window,
        note: note.into(),
    }
}

impl Host {
    pub(super) fn diagnostics(&self, request: &Value) -> anyhow::Result<Value> {
        if request["op"] == "diagnostics.export" {
            let request: DiagnosticsExportRequest = decode(request)?;
            return Ok(reply(&self.diagnostics_export(&request)?));
        }
        let DiagnosticsStatusRequest {} = decode(request)?;
        let status = serde_json::to_value(self.diagnostics_status())?;
        // The same rules as an export; the reply must still match its contract.
        let redacted = redactor().value(status);
        let typed: DiagnosticsStatus = serde_json::from_value(redacted).map_err(|_| {
            anyhow::anyhow!("Diagnostics report failed its contract after redaction")
        })?;
        Ok(reply(&typed))
    }

    fn diagnostics_export(
        &self,
        request: &DiagnosticsExportRequest,
    ) -> anyhow::Result<DiagnosticsExport> {
        let max_events = request.max_events.unwrap_or(DEFAULT_EVENTS);
        anyhow::ensure!(
            max_events <= MAX_EVENTS,
            "max_events must be at most {MAX_EVENTS}"
        );
        let status = serde_json::to_value(self.diagnostics_status())?;
        let (events, events_skipped) =
            observe::recent_events(&ade_platform::resources::logs(), max_events as usize);
        let mut redactor = redactor();
        let status: DiagnosticsStatus =
            serde_json::from_value(redactor.value(status)).map_err(|_| {
                anyhow::anyhow!("Diagnostics report failed its contract after redaction")
            })?;
        let events: Vec<Value> = events
            .into_iter()
            .map(|event| redactor.value(event))
            .collect();
        let mut export = DiagnosticsExport {
            tag: Default::default(),
            format: FORMAT.into(),
            generated_at: status.generated_at,
            max_bytes: EXPORT_MAX_BYTES as u64,
            excluded: EXCLUDED.iter().map(|item| (*item).to_owned()).collect(),
            redaction: redactor.summary(),
            status,
            events: Vec::new(),
            // `false` serializes longer than `true`, so the bound holds either way.
            events_truncated: false,
        };
        let fixed = serde_json::to_string(&export)?.len();
        let (events, dropped) = redact::fit_events(events, fixed, EXPORT_MAX_BYTES)
            .ok_or_else(|| anyhow::anyhow!("Diagnostics report exceeds the bundle bound"))?;
        export.events = events;
        export.events_truncated = events_skipped || dropped;
        Ok(export)
    }

    fn diagnostics_status(&self) -> DiagnosticsStatus {
        let now = now_ms();
        let mut degraded = Vec::new();
        let mut unknown = Vec::new();

        // Live execution. A draining runtime is not asked, because its Agent
        // socket blocks until the drain ends.
        let draining = self.runtime.draining();
        let terminals = if draining {
            None
        } else {
            self.runtime_terminals().ok()
        };
        let runs = if draining {
            None
        } else {
            self.runtime
                .agent(ade_core::runtime_protocol::AgentOp::List)
                .ok()
                .and_then(|value| serde_json::from_value::<AgentList>(value).ok())
        };
        if draining {
            degraded.push("the runtime is draining for a restart and was not asked".to_owned());
        }
        let (terminals, terminal_unknown) = match &terminals {
            Some(list) => {
                let (summaries, unknown) = observe::terminals(list);
                (Some(summaries), unknown)
            }
            None => {
                if !draining {
                    degraded.push("the runtime terminal catalogue could not be read".into());
                }
                (None, Vec::new())
            }
        };
        if runs.is_none() && !draining {
            degraded.push("the runtime Agent catalogue could not be read".into());
        }
        if terminals.is_none() || runs.is_none() {
            unknown.push(DiagnosticUnknown {
                source: DiagnosticUnknownSource::Runtime,
                subject: self.runtime.instance.clone(),
                operation: None,
                scope: None,
                reason: "the runtime was not observed; live execution is unknown".into(),
                since: None,
            });
        }

        let inspection = self.sessions.inspection();
        unknown.extend(inspection.unresolved.iter().map(|claim| DiagnosticUnknown {
            source: DiagnosticUnknownSource::Claim,
            subject: claim.subject.clone(),
            operation: None,
            scope: Some(claim.workspace_id.clone()),
            reason: claim.reason.clone(),
            since: None,
        }));
        unknown.extend(terminal_unknown);

        // Durable stores, each through its own read-only connection.
        let stores = observe::Stores::in_directory(&self.directory);
        let sessions_db = observe::read_only(&stores.sessions);
        let mut receipts = Vec::new();
        let side_stores = stores
            .receipts
            .iter()
            .map(|(name, path)| (*name, observe::read_only(path)))
            .collect::<Vec<_>>();
        for (name, connection) in std::iter::once(("sessions", sessions_db.as_ref())).chain(
            side_stores
                .iter()
                .map(|(name, connection)| (*name, connection.as_ref())),
        ) {
            match connection.map(|connection| observe::receipts(connection, name, now)) {
                Some(Ok((tally, lost))) => {
                    receipts.push(tally);
                    unknown.extend(lost);
                }
                _ => {
                    degraded.push(format!("the {name} receipts could not be read"));
                    receipts.push(observe::unavailable_tally(name));
                }
            }
        }
        match observe::receipts(&self.browser_receipts.lock().unwrap(), "browser", now) {
            Ok((tally, lost)) => {
                receipts.push(tally);
                unknown.extend(lost);
            }
            Err(_) => {
                degraded.push("the browser receipts could not be read".into());
                receipts.push(observe::unavailable_tally("browser"));
            }
        }
        let session_queues = sessions_db
            .as_ref()
            .and_then(|connection| observe::session_queues(connection).ok());
        if session_queues.is_none() {
            degraded.push("the sessions store queues could not be read".into());
        }
        let mut services = sessions_db
            .as_ref()
            .and_then(|connection| observe::services(connection).ok())
            .unwrap_or_else(|| {
                degraded.push("the service catalogue could not be read".into());
                Vec::new()
            });
        observe::mark_services(&mut services, terminals.as_deref());
        match sessions_db.as_ref().map(observe::interrupted_conversations) {
            Some(Ok(interrupted)) => unknown.extend(interrupted),
            _ => degraded.push("interrupted Conversations could not be read".into()),
        }

        let scrollback = terminals
            .as_deref()
            .and_then(|list| observe::sum_metric(list, |t| t.scrollback_bytes));
        let reply_dropped = terminals
            .as_deref()
            .and_then(|list| observe::sum_metric(list, |t| t.reply_dropped_bytes).or(Some(0)));
        let queues = vec![
            queue(
                "feed.subscribers",
                DiagnosticUnit::Items,
                Some(inspection.feed_subscribers),
                None,
                &format!(
                    "live feed connections; each queues at most {FEED_QUEUE_CAPACITY} frames and is evicted when full or when a write to it times out"
                ),
            ),
            queue(
                "conversation.queued_prompts",
                DiagnosticUnit::Items,
                session_queues.as_ref().map(|q| q.queued_prompts),
                None,
                "durable prompts waiting for their Conversation",
            ),
            queue(
                "send.outbox",
                DiagnosticUnit::Items,
                session_queues.as_ref().map(|q| q.send_outbox),
                None,
                "durable send intents pending or rejected",
            ),
            queue(
                "runtime.agent_runs",
                DiagnosticUnit::Items,
                runs.as_ref().map(|list| list.agents.len() as u64),
                Some(AGENT_RUN_LIMIT),
                "Agent runs the runtime supervisor holds",
            ),
            queue(
                "terminal.scrollback",
                DiagnosticUnit::Bytes,
                terminals.as_ref().map(|_| scrollback.unwrap_or(0)),
                None,
                "terminal output the runtime retains across its live incarnations",
            ),
        ];
        let counters = vec![
            counter(
                "feed.subscribers_evicted",
                DiagnosticCounterKind::Dropped,
                Some(inspection.feed_evictions),
                DiagnosticWindow::DaemonBoot,
                "subscribers removed because their queue filled or a write to them timed out; each loses its queued frames and must resubscribe",
            ),
            counter(
                "prompt_queue.wakes_coalesced",
                DiagnosticCounterKind::Coalesced,
                Some(inspection.queue_wakes_coalesced),
                DiagnosticWindow::DaemonBoot,
                "wakes merged into one already pending; no queued prompt is lost",
            ),
            counter(
                "terminal.reply_bytes_dropped",
                DiagnosticCounterKind::Dropped,
                reply_dropped,
                DiagnosticWindow::LiveIncarnations,
                "terminal replies dropped by a full PTY reply queue; retired incarnations are not counted",
            ),
            counter(
                "log.records_dropped",
                DiagnosticCounterKind::Dropped,
                None,
                DiagnosticWindow::DaemonBoot,
                "not instrumented: the log writer drops records past its budget without counting them",
            ),
            counter(
                "agent.output_overflows",
                DiagnosticCounterKind::Dropped,
                None,
                DiagnosticWindow::DaemonBoot,
                "not instrumented: the runtime reports overflow per run, not as a count",
            ),
        ];

        let mut terminal_worktree_leases: Vec<String> =
            self.leases.lock().unwrap().keys().cloned().collect();
        terminal_worktree_leases.sort();
        let claims = DiagnosticClaims {
            terminal_worktree_leases,
            session_worktree_leases: inspection.session_worktree_leases,
            unresolved: inspection.unresolved,
            active_git_operations: self.sessions.worktrees.active_operations() as u64,
        };
        let retention = DiagnosticRetention {
            receipt_retention_ms: ade_daemon::receipts::RETENTION_MS,
            receipts_past_retention: receipts.iter().map(|tally| tally.past_retention).sum(),
            logs: observe::log_retention(&ade_platform::resources::logs()),
            attachment_bytes: session_queues.as_ref().map(|q| q.attachment_bytes),
        };
        let live = DiagnosticLive {
            observed: terminals.is_some() && runs.is_some(),
            runtime_instance: self.runtime.instance.clone(),
            runs: runs
                .map(|list| {
                    list.agents
                        .into_iter()
                        .map(|run| DiagnosticRun {
                            conversation_id: run.spec.conversation,
                            run_id: run.spec.run,
                            provider: run.spec.provider,
                            pid: run.pid,
                            account_pinned: run.spec.account.is_some_and(|a| !a.is_null()),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            terminals: terminals.unwrap_or_default(),
            services,
        };
        // Whole process trees, measured from one read of the process table.
        let mut roots = vec![
            observe::processes::Root {
                kind: DiagnosticProcessKind::Daemon,
                subject: self.sessions.boot_id.clone(),
                incarnation: None,
                pid: std::process::id(),
            },
            observe::processes::Root {
                kind: DiagnosticProcessKind::Runtime,
                subject: self.runtime.instance.clone(),
                incarnation: None,
                pid: self.runtime.pid,
            },
        ];
        roots.extend(live.runs.iter().filter_map(|run| {
            Some(observe::processes::Root {
                kind: DiagnosticProcessKind::Agent,
                subject: run.conversation_id.clone(),
                incarnation: Some(run.run_id.clone()),
                pid: run.pid?,
            })
        }));
        roots.extend(live.terminals.iter().filter_map(|terminal| {
            Some(observe::processes::Root {
                kind: DiagnosticProcessKind::Terminal,
                subject: terminal.terminal_id.clone(),
                incarnation: terminal.transfer_id.clone(),
                pid: terminal.shell_pid.filter(|_| terminal.shell_running)?,
            })
        }));
        let table = observe::processes::read_table();
        if table.is_none() {
            degraded.push("the process table could not be read".into());
        }
        let resources = observe::processes::measure(
            &roots,
            table.as_deref(),
            now_ms(),
            observe::processes::METHOD,
            observe::processes::host(),
        );
        let (unknown, unknown_truncated) = observe::bound_unknown(unknown, observe::UNKNOWN_LIMIT);
        DiagnosticsStatus {
            tag: Default::default(),
            generated_at: now,
            identity: DiagnosticIdentity {
                host_key: observe::host_key(),
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                profile_id: self.profile_id.clone(),
                boot_id: self.sessions.boot_id.clone(),
                daemon_pid: std::process::id(),
                build_id: std::env::var("ADE_BUILD_ID").ok(),
                application_protocol: runtime::APPLICATION_PROTOCOL.into(),
                runtime_protocol: runtime::PROTOCOL.into(),
                runtime_instance: self.runtime.instance.clone(),
                runtime_pid: self.runtime.pid,
            },
            queues,
            counters,
            receipts,
            live,
            resources,
            claims,
            retention,
            unknown,
            unknown_truncated,
            degraded,
        }
    }
}

fn redactor() -> redact::Redactor {
    let home = std::env::var("HOME").ok();
    redact::Redactor::new(home.as_deref())
}
