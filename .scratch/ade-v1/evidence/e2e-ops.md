# e2e-ops

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-10
Worker: ADE parallel build, E2E round 2, slice ops-leftovers
Requirements: F043, F131, F132, F136, F137, F138

## Outcome

Headless protocol E2E now covers resource visibility, diagnostics and
retention in `e2e/protocol/ops/`, against real daemons and runtimes through the
SDK, the CLI and the raw protocol. 13 tests pass there; the round-1
`e2e/protocol/catalogs/` specs for F043, F131 and F132 were rerun and pass
(23 pass, 4 fixme unchanged).

The specs found two product bugs, now fixed, and one gap, now built:

- A feed subscriber that stopped reading was dropped by its 2-second write
  timeout without being counted, so `feed.subscribers_evicted` stayed 0.
- A turn the user cancelled was reported as unknown execution with the
  reason "a daemon or runtime loss interrupted the turn".
- F136 had no process or host measurement. `diagnostics.status` now carries
  `resources`: whole process trees for the daemon, the runtime, each live
  Agent run and each terminal, with provenance, unknown markers and totals
  that count each process once.

No requirement is fully accepted by this slice. Each of F136, F137 and F138
still lacks its display (UI) part. F043, F131 and F132 keep the gaps listed
under Open.

## Acceptance criteria

### F136 Resource visibility

| Criterion | Spec | Result |
|---|---|---|
| Measured process status with provenance: the daemon, runtime, Agent and terminal groups, each with its root PID, whole tree, footprint and CPU time, `exact` provenance, and correlated with the boot, incarnation, run and terminal incarnation it measures; host CPUs and memory; CLI parity | `resources.spec.ts` "groups measure whole process trees…" | pass |
| Avoid double-counting shared memory in totals: the memory is `phys_footprint`, which leaves out shared pages; nested groups are counted once (`total_processes` = distinct PIDs; total footprint < sum of groups) | same | pass |
| Unknown markers: a lost runtime is `unavailable` with "not found", never zero; no Agent or terminal groups without a runtime catalogue; `degraded` says why; a new runtime is measured again | `resources.spec.ts` "a lost runtime is marked unknown…" | pass |
| Stale marker | `observed_at` on every measurement; staleness is for the display to judge | pass (backend field only) |
| Queues, claims, incarnations and unknown reasons: queue depths with capacity and provenance, the durable prompt queue, live runs, terminals and services with incarnations, port claims, worktree leases | `diagnostics.spec.ts` "status correlates identity, queues…" | pass |
| Display | not covered: UI |

### F137 Diagnostics

| Criterion | Spec | Result |
|---|---|---|
| Identities: host key, profile, daemon boot and PID, runtime incarnation and PID match `hello`, before and after a restart | `diagnostics.spec.ts` first and second tests | pass |
| Reasons for unknown state: a runtime crash gives `live.observed: false`, `degraded` entries, `unavailable` gauges, a `runtime` unknown and an interrupted Conversation unknown, while the call still answers; after the restart, an unresolved service claim names its incarnation and reason; resuming and stopping clear them | `diagnostics.spec.ts` "a runtime crash leaves unknown execution…" | pass |
| An effect interrupted by a daemon crash is an unknown receipt with its operation, store and time | `diagnostics.spec.ts` "an effect interrupted by a daemon crash…" | pass |
| A cancelled turn is not unknown execution | `diagnostics.spec.ts` first test | pass after fix |
| Redacted export: planted Anthropic, OpenAI and GitHub keys, a bearer value, URL credentials, daemon environment secrets, a service's secret environment, an account credential file, prompt and draft transcript text, HOME and the workspace path are all absent from the export, the status reply and the CLI file; only allow-listed events and fields survive | `diagnostics.spec.ts` "an export is bounded, correlated and contains no planted credential or transcript" | pass |
| Bounded and inspectable: the bundle stays under `max_bytes`; `max_events` bounds 0, 5 and 1000 hold with `events_truncated`; 5000 is refused by the SDK, the daemon and the CLI; the CLI writes a new `0600` file and never overwrites one | same, and "the export stays within its event and byte bounds…" | pass |
| Dropped counts: a subscriber that stops reading is evicted and counted, the feed keeps serving, and the counter resets with the daemon | `diagnostics.spec.ts` "a subscriber that stops reading…" | pass after fix |
| Export from the UI | not covered: UI |

### F138 Retention and cleanup

| Criterion | Spec | Result |
|---|---|---|
| Preview by generation: an idle orphan service log and an aged rotated diagnostic log are the only candidates; reclaim estimates per item and in total; the policy is reported; the generation is stable; CLI parity | `retention.spec.ts` "preview selects only unowned…" | pass |
| Never delete referenced or in-flight data or active resources: an unreferenced upload, a message-referenced upload and a draft-referenced upload stay; a live service's log aged 10 days stays; a recent orphan, a stray file, a symlinked key and a process's newest log stay; installed skill files stay | same | pass |
| Apply removes exactly the generation, confirms each removal, and replays after a daemon kill (SDK and CLI) | same | pass |
| Unresolved claims: a service quarantined after a runtime crash keeps its log, aged 30 days | `diagnostics.spec.ts` "a runtime crash leaves unknown execution…" | pass |
| Conflicts: a rewritten file, a new candidate, an unknown or empty generation are refused and nothing is removed; two racing applies remove each item once and one replays | `retention.spec.ts` "a candidate set that changed…" | pass |
| Failures exposed: a removal that fails is reported per item, not stored, and the same set succeeds on retry | `retention.spec.ts` "a removal that fails…" | pass |
| Fail closed without the runtime terminal list: service logs are withheld with a reason; other kinds are still judged | `retention.spec.ts` "without the runtime terminal list…" | pass |
| The receipt prune schedule records every store's outcome (first run after 60 s) | `retention.spec.ts` "the scheduled receipt prune…" | pass |
| Unreferenced skill files are candidates | not reachable through the protocol: `skill.install` and `skill.remove` release old files in their own transaction, so none are left to find. The spec asserts that none appear. | not covered |
| Configured retention | the policy is fixed and reported; there is no user setting | not covered |
| Display | not covered: UI |

### F043, F131, F132

Round 1 proved these in `e2e/protocol/catalogs/` (see `e2e-catalogs.md`); the
rerun passes. Work search with provenance, cursors, rebuild expiry and
catch-up after a daemon kill passes. MCP scope resolution per workspace and
provider passes. Pinned skill bundles with external files left byte-identical
pass. Their `test.fixme` specs stay open:

- F043 "remove deleted records from results": no operation deletes a message
  or a Conversation (`conversation.rewind` is unavailable everywhere).
- F131 "expose the server through compatible adapters, with both-leg handling":
  `WIRED_PROVIDERS` is empty and there is no gateway.
- F132 "invoke through adapter rules": placement into provider paths and
  adapter invocation are not built. Remote installation is not built.

## Product fixes

- `crates/ade-daemon/src/bin/daemon/server.rs`,
  `crates/ade-daemon/src/sessions/inspection.rs`: a feed write that times out
  now evicts the subscriber through `Sessions::evict_stalled`. It counts
  once, even when the subscriber's queue had already filled.
- `crates/ade-daemon/src/observability.rs`: only an interrupted Conversation
  with a recorded loss (`error` set) is unknown execution. A provider-reported
  interruption, as after a user cancel, is a known outcome.
- F136 measurement: `crates/ade-daemon/src/observability/processes.rs`
  (pure `measure` over one process-table read; macOS `proc_listallpids`,
  `proc_pidinfo` and `proc_pid_rusage`; Linux `/proc` with proportional set
  size), wired into `diagnostics.status` as `resources`. Contract types
  `DiagnosticResources`, `DiagnosticProcessGroup`, `DiagnosticProcessKind` and
  `DiagnosticHost` in `crates/ade-core/src/contract/daemon.rs`; contracts
  regenerated.

## Operation tiers

- `diagnostics.status`: query (reply gains `resources`).
- `diagnostics.export`: query (its `status` gains `resources`).

## Fixture changes

None to the shared fixtures. Area steps are in `e2e/protocol/ops/steps.ts`.
`diagnostics.spec.ts` imports the worktree lifecycle steps from
`e2e/protocol/worktrees/lifecycle.ts` without changing them.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops e2e/protocol/catalogs`: 36 passed, 4 fixme (all in catalogs).
- `pnpm check:static`: pass.
- In-process tests added:
  - `crates/ade-daemon/src/observability/processes.rs` (nested groups counted once, missing and unreadable processes marked, parent cycle)
  - `crates/ade-daemon/src/observability.rs` (only an interruption with a recorded loss is unknown)
  - `crates/ade-core/src/contract/daemon.rs` and `crates/ade-daemon/src/observability/redact.rs` (existing tests extended with `resources`)
- Verified only statically: the Linux `/proc` reader. It was not run on Linux.
- `pgrep`: no `ade-daemon` or `ade-runtime` from this worktree was left running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 5 | 20 | 0 |

## References

None.

## Open

- F043: a deletion operation for Conversations or messages. This needs a
  product decision; the spec's out-of-scope list excludes archive UI but
  does not settle deletion.
- F131: adapter wiring (Claude `mcpServers`, Codex `mcp_servers`, Oh My Pi
  `mcp.json`) and a gateway with both-leg negotiation. This is providers work.
- F132: placement into provider paths, invocation through adapters and remote
  installation.
- F136: the display, with stale markers judged from `observed_at`. CPU is
  cumulative time, not a rate; a rate needs two samples.
- F137: the UI export. `log.records_dropped` and `agent.output_overflows` are
  still not instrumented and report `unavailable`.
- F138: user-configured retention, and a retention path for unreferenced
  skill files that the protocol can produce. `daemon.log` is observed at
  `ADE_RUNTIME_HOME`, the control launcher's home, and reports `null` for a
  profile run without the launcher.
- Coordinator: `THIRD-PARTY-NOTICES.md` still needs the Orca MIT entry for
  `redact.rs` noted in `phase2-diagnostics.md`.
