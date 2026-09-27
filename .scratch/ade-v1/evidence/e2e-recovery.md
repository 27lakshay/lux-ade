# e2e-recovery

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-3
Worker: E2E round 1, slice recovery
Requirements: R005, R006 (advanced, not fully accepted); R004 and R008 (the cancel-reserve and replay-overflow cases only)

## Outcome

Headless E2E specs in `e2e/protocol/recovery/` now prove crash and restart
recovery against real daemon, runtime and provider-mock processes: 12 pass and
1 is `test.fixme` for a real gap. The specs exposed two product bugs, both
fixed. First, a turn lost to a runtime crash was reported with a known outcome
when the daemon outlived its runtime. Second, a burst of provider output killed
the run as "Provider is unavailable or overloaded" before the replay journal
could report degraded output. No requirement is fully accepted: R005 still
needs the Electron renderer reload, and R006 still needs the stale PID and
escaped-descendant cases.

## Acceptance criteria

The criteria come from the R005 and R006 rows of `13-reliability/spec.md`, the
architecture's section 4 failure contract and runtime restart reconciliation
rules, and the "Needs E2E later" lists of the evidence files named in the task.

| Criterion | Spec | Result |
|---|---|---|
| R005: a compatible daemon restart (graceful handoff) during real execution keeps the runtime identity, the provider run, its tool process and its native session. The turn finishes once and is not replayed | `daemon-restart.spec.ts` › graceful | pass |
| R005: the same after a daemon SIGKILL | `daemon-restart.spec.ts` › kill | pass |
| R005: a frontend that closes mid-turn does not affect execution, and a new client restores state from the new daemon (a headless feed client stands in for the renderer) | `daemon-restart.spec.ts` (both) | pass |
| R005: the renderer itself closes or reloads | not covered: Electron E2E is paused | not covered |
| session-lease: a live runtime Agent is reattached before admission. A retried send with the same request ID is deduplicated, and a new prompt is refused while the turn runs | `daemon-restart.spec.ts` | pass |
| session-lease: a runtime Agent whose run differs from its Conversation | none: no fixture can make the run differ | not covered |
| Runtime crash: attempts are classified from recorded identity and fresh observation. A provider turn whose tree is gone settles with `outcome_unknown` and is never replayed. Resume and a new turn then work | `runtime-crash.spec.ts` › mid-turn (daemon-survives, daemon-first) | pass (daemon-survives failed before fix 1) |
| Runtime crash: a provider tree still running is `quarantined` with its PIDs, records one `operation_unknown` activity, refuses `agent.resume`, `agent.send` and `runtime.recovery.release`, and settles on the 10 s recheck once the tree exits | `runtime-crash.spec.ts` › quarantined provider tree | pass |
| A turn lost before its identity was recorded is `unknown`. Admission is refused until `runtime.recovery.release`, a repeated release answers the same report, and nothing is replayed | `runtime-crash.spec.ts` › lost before recorded | pass (skips itself if the 2 s snapshot wins a narrow race) |
| A lease is reconciled before new admission: a script tree that survives a runtime kill is quarantined and blocks `script.start`, `script.retire` and release in its workspace until its processes exit | `descendants.spec.ts` › script tree survives a runtime kill | pass |
| A provider that ignores SIGTERM and holds an escaped, TERM-ignoring descendant is stopped by the SIGKILL escalation. `agent.disconnect` confirms only once both are gone | `descendants.spec.ts` › disconnecting a provider | pass |
| `script.stop` never reports an exit while a TERM-ignoring, setsid'd descendant runs. This includes one reparented to launchd | `descendants.spec.ts` › stubborn, orphaning | pass |
| R006: an escaped descendant that left the group before a runtime crash keeps its attempt quarantined | `descendants.spec.ts` › escaped descendant survives a runtime kill | fixme (gap below) |
| R006: stale process identity (reused PID), unreadable process table | none: PID reuse cannot be forced deterministically | not covered |
| A service port held by an escaped process gives `unknown` (rule 6) | none | not covered |
| R008: provider output past the 32 MiB replay journal while the daemon is away is reported as an output failure, not an exit. Journaled output replays, later output does not, and nothing is replayed to the provider | `replay-overflow.spec.ts` | pass (failed before fix 2) |
| R004: with ordinary receipts saturated (4096 steers on a live run), a further ordinary command is refused, but `agent.cancel` is admitted from the control reserve and interrupts the turn | `receipt-saturation.spec.ts` | pass |

## Product fixes

1. **The in-flight turn of a crashed runtime was reported as settled with a
   known outcome.** When the daemon outlives its runtime, `fail_if` marks the
   Conversation `interrupted` and clears its turn. The next start then read no
   busy status and reported the lost turn as settled with `outcome_unknown:
   false`. Which answer the report gave depended on a race: whether the daemon
   noticed the loss before it restarted.
   - Fix: `recovery::turn_in_flight` in `crates/ade-daemon/src/sessions/recovery.rs`
     is a pure decider with its own test. Its rule: `interrupted` counts as in
     flight when the old incarnation recorded the same run the Conversation
     still names. `restart.rs` `lease_candidate` now uses it.
   - Spec: `runtime-crash.spec.ts`, the daemon-survives case.
2. **A burst of provider output killed the run.** The JSON-RPC transport
   (`crates/ade-runtime/src/rpc.rs`) used `try_send` into the run's 256-event
   queue. A burst that filled the queue failed the transport with `Overloaded`,
   stopped the provider and published an exit ("Provider is unavailable or
   overloaded"). This happened even with the daemon attached, and the bounded
   replay journal never decided anything.
   - Fix: the reader now blocks on the bounded queue. Backpressure reaches the
     provider pipe, and only the journal decides overflow. The drain thread
     never waits on the reader, so blocking cannot deadlock. The send fails
     once the drain has stopped.
   - Spec: `replay-overflow.spec.ts`.

## New generic fixtures

All are in `e2e/protocol/fixtures/`:

- `recovery.ts`:
  - `attemptRecords` and `waitForAttemptRecord` wait for the daemon's 2 s
    process-identity snapshot. They read `sessions.sqlite` read-only with
    `sqlite3`, because no query exposes the snapshot.
  - `waitForPidFile`.
  - `recoveryFixtures`, the paths below.
- `escapee.py`: a descendant that ignores TERM and HUP, calls setsid and can
  double-fork to be reparented. It writes its PID to a file.
- `codex_stubborn.sh`: the Codex mock with TERM and HUP ignored and an escaped
  descendant.
- `codex_flood.py`: a proxy in front of the Codex mock. Its `flood` prompt
  streams 640 messages of 64 KiB once `flood-release` exists.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm check:static`: pass. It ran 726 Rust tests.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/recovery`: 12 passed, 1 fixme.
- In-process tests added: `crates/ade-daemon/src/sessions/recovery.rs`
  (`a_turn_interrupted_by_a_surviving_daemon_stays_in_flight_only_for_its_recorded_run`).
- `pgrep` after the runs found no `ade-daemon`, `ade-runtime` or fixture process
  left from this worktree.

## Requirements whose full register acceptance passes

None. R005 still needs the renderer close and reload (Electron, paused). R006
still needs stale process identity and the escaped-descendant fixme.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 10 | 25 | 0 |

## References

- `docs/proposed-architecture.md` section 4 (failure contract, runtime restart
  reconciliation), `e2e/specs/provider-daemon-handoff.spec.ts` (legacy handoff
  scenario, re-expressed on the shared fixtures). No external code was copied.

## Open

- **Gap (fixme):** a descendant that left its process group before a runtime
  crash is not in the attempt record. Its attempt settles and the workspace is
  released while it still runs. Closing it needs the runtime to report tracked
  descendants per attempt, and the daemon to record them.
- **Same pattern, not fixed:** `crates/ade-runtime/src/adapters/acp_session.rs`
  (lines 55 and 228) uses `try_send` then `Overloaded` on the same bounded
  queue, so an ACP provider burst can still kill its run. No ACP mock exists in
  the shared fixtures, so no spec exercises it.
- **Outside this area (conversations):** one agent message larger than 1 MiB
  fails the Conversation with "Agent message exceeds 1 MiB". To reproduce,
  stream 640 × 64 KiB deltas into one message. This was the first version of
  `codex_flood.py` in `replay-overflow.spec.ts`; that spec now uses separate
  messages.
- **Outside this area (conversations):** after `agent.resume`, the status is
  `starting` until the provider opens. During that window `agent.send` answers
  "Conversation already has an active turn", which is misleading. The specs
  wait for idle.
- **Minor:** after a daemon-first crash, the lost turn's error reads "The daemon
  restarted during this turn", even though the runtime crashed. On runtime
  loss, `fail_if` also marks an idle Agent `interrupted`, so a later report can
  mark that idle run `outcome_unknown` (conservative).
