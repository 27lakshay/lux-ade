# runtime-crash-recovery

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-9
Worker: Phase 2 round E, runtime-crash-recovery
Requirements: R005, R006 (advanced, not accepted)

## Outcome

When the daemon starts and finds a runtime incarnation that no report has
reconciled, it classifies every attempt the old incarnation may have owned. That
covers provider turns, plain terminals, services and script runs. Each attempt is
**settled**, **quarantined** (processes still run without an owner) or **unknown**.
The classification uses process identities recorded while the old runtime lived,
fresh process-tree and old-runtime observations, and listener checks on service
ports. Nothing is replayed. Quarantined and unknown leases stay reserved and
refuse conflicting admission. They are observed again every 10 seconds, and the
user can release an unknown one explicitly. The rules are in
`docs/proposed-architecture.md`, section 4, "Runtime restart reconciliation".

Before this slice, a script run from a crashed runtime was retired, and an Agent
lease was released, because the replacement runtime did not list them. Absence
from a replacement runtime is now never treated as proof of exit.

## Operation tiers

- `runtime.recovery`: query. Reads the reports, newest first; `open_only` filters.
- `runtime.recovery.release`: idempotent command. Resolves an `unknown` attempt
  without proof. It is refused while processes from the attempt are observed.
  Repeating it returns the same report.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/sessions/recovery.rs` (classifier, tree, presence,
    port and attribution rules)
  - `crates/ade-core/src/contract/daemon.rs` (`runtime_recovery_operations_round_trip`,
    tier list)

Verified only statically:

- the restore-pass integration (`sessions/restart.rs`, `reconcile_runtime_restart`);
- the 2-second attempt-identity snapshot;
- the 10-second recheck;
- report persistence and activity recording (`store/runtime_recovery.rs`);
- the `service.stop` and `script.retire` resolution hook;
- the CLI `recovery list|release` command.

Needs E2E later:

- Kill the runtime during a running provider turn, a running service, a script
  run and a plain shell with a descendant that ignores SIGHUP. Restart the
  daemon, then check:
  - the report shows quarantine with PIDs;
  - admission is refused;
  - the descendant's exit settles the attempt;
  - no prompt is resent.
- A reused PID and an unreadable process table.
- A service port held by an escaped process.
- `runtime.recovery.release` refused while processes still run.
- The activity feed entries (UI surface).

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 10 | 0 |

## References

- orca @ ade-evaluation-2026-09-24, `src/shared/pty-liveness-verdict.ts`:
  studied. Exit needs positive evidence, and a lost observer is `unverifiable`.
  No code was copied.
- `crates/ade-runtime/src/descendants.rs` (in-repo): reused `observe` and the
  PID-plus-start-stamp identity.
- POSIX "Process ID Reuse" (a PID is not reused while its process group exists):
  the basis for rule 2.

## Open

- A daemon that loses its runtime while running does not reconnect to a new
  incarnation. Detection happens at the next daemon start.
- Activity for non-Conversation attempts uses `operation_unknown` with an empty
  `conversation_id`. A dedicated activity kind would need an edit to
  `contract/activity.rs` (another domain).
- No `runtime.recovery.stop` exists to signal a quarantined orphan tree. Today
  the user stops those processes outside ADE.
- A descendant that left its group before the crash is not tracked. The runtime
  could report tracked descendants per attempt to close this gap.
- An attempt that started within 2 seconds of the crash is unrecorded, so it is
  unknown.
- New tables in `sessions.sqlite`: `runtime_incarnations`,
  `runtime_attempt_records` and `runtime_recovery_reports`. The backup-coverage
  slice should confirm they are included or deliberately excluded.
