# diagnostics

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-10
Worker: Phase 2 parallel build, round B, slice diagnostics
Requirements: F136 (resource visibility, backend part), F137 (diagnostics, backend part); architecture §10 "queue and spool sizes, dropped/coalesced counts, retention status, resource claims, and reasons for unknown execution"

## Outcome

The daemon answers two new queries. `diagnostics.status` reports queue and
spool depths, dropped and coalesced counters, receipt counts by status for each
database, live Agent runs, terminals and services with their incarnations, lease
and claim state, retention status and a bounded list of unknown executions with
their reasons. `diagnostics.export` wraps that report and the newest allow-listed
log records in a bounded (1 MiB), redacted bundle that correlates host, profile,
operation, attempt and runtime incarnation. The CLI gains `ade diagnostics status`
and `ade diagnostics export [--output PATH] [--events N]`. Neither requirement is
fully accepted: the UI surfaces and E2E evidence remain.

Design points:

- Each store is read through its own read-only SQLite connection
  (`sessions.sqlite`, `sessions.worktrees/lifecycle.sqlite3`,
  `sessions.review.sqlite3`), plus the in-memory browser journal. No store lock
  is taken and no table is created or migrated.
- Fail closed. An unreadable source is reported with `available: false` or
  `provenance: unavailable` and a fixed `degraded` sentence, never as zero. A
  runtime that cannot be asked, or is draining for a restart, gives
  `live.observed: false`, services with `running: null`, and a `runtime` entry
  in `unknown`. The report never waits on a draining runtime.
- Both operations bypass the admission lock, as `runtime.status` does, so they
  still answer while the daemon drains.
- Redaction (`crates/ade-daemon/src/observability/redact.rs`) runs over the
  status reply and the whole export. It drops values under credential key
  families (`token`, `secret`, `api_key`, `authorization`, `cookie`, `env` and
  others) and transcript keys (`prompt`, `text`, `stdout`, `messages`,
  `snapshot` and others). Inside strings it removes PEM blocks, labeled
  key-values (`token=…`, `Authorization: Bearer …`), provider-key fingerprints
  (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, JWT) and URL userinfo, and it
  folds `$HOME` to `~`. Strings, containers and nesting are bounded. The reply
  must still decode as its contract after redaction, or the operation fails.
  Log events come only through the existing allow-list
  (`ade_platform::diagnostics::safe_record`), now public.
- The CLI writes an export as a new `0600` file, refuses to overwrite and
  removes a partial file after a failed write.

Counters and their accuracy:

| Name | Source | Accuracy |
|---|---|---|
| `feed.subscribers` (queue) | session subscriber map | exact |
| `conversation.queued_prompts`, `send.outbox` (queues) | sessions store | exact |
| `runtime.agent_runs` (queue, capacity 16) | runtime `agent.list` | exact |
| `terminal.scrollback` (spool, bytes) | runtime terminal metrics | exact for live incarnations |
| `feed.subscribers_evicted` (dropped) | new in-memory counter; a full queue only | approximate: resets on daemon restart |
| `prompt_queue.wakes_coalesced` (coalesced) | new in-memory counter | approximate: resets on daemon restart |
| `terminal.reply_bytes_dropped` (dropped) | runtime terminal metrics | approximate: retired incarnations are not counted |
| `log.records_dropped`, `agent.output_overflows` | none | reported as `unavailable`, not instrumented |

## Operation tiers

- `diagnostics.status`: query
- `diagnostics.export`: query. It only reads; the caller saves the bundle.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/observability/redact.rs` (9 tests: key classes,
    labeled values, provider keys, PEM and userinfo, home folding, idempotence,
    bounds, a clean report passing unchanged, event fitting)
  - `crates/ade-daemon/src/observability.rs` (5 tests: receipt tally, terminal
    summaries and unverified exits, service liveness, event selection, unknown bound)
  - `crates/ade-core/src/contract/daemon.rs` (tier list and a wire round trip)

A manual smoke run (not a gate) started an isolated daemon and runtime, then ran
`ade diagnostics status`, `ade diagnostics export --output` (file mode `0600`,
refused on a second run), `--events 5000` (refused by the CLI) and
`request diagnostics.export {"max_events":5000}` (refused by the daemon).

Verified only statically: the SQL reads against the real schemas, the
unresolved-claim snapshot, the eviction and coalescing counters, the bypass of
the admission lock and the draining guard.

Needs E2E later:

- An unknown receipt, an unresolved claim after a daemon restart and an
  interrupted Conversation each appear in `unknown` with their reasons.
- A stopped runtime gives `live.observed: false` and a `degraded` entry, while
  the call still answers.
- A slow feed subscriber raises `feed.subscribers_evicted`.
- An export built from logs and state that contain planted credentials and
  transcript text contains neither.
- F136 display with stale and unknown markers, and F137 export from the UI.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 15 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/observability/redactor.ts` and
  `redactor.test.ts`, adapted → `crates/ade-daemon/src/observability/redact.rs`
  (key-family blocklist, labeled key-value rule, provider-key patterns, URL
  userinfo; MIT)
- Orca @ ade-evaluation-2026-09-24, `src/main/observability/diagnostic-bundle-limits.ts`,
  pattern (a fixed byte bound on the bundle)
- t3code @ ade-evaluation-2026-09-24, `apps/server/src/resourceTelemetry/ResourceTelemetry.test.ts`,
  not opened; F136 process-tree measurement is left open

## Open

- `THIRD-PARTY-NOTICES.md` needs an Orca MIT entry for
  `crates/ade-daemon/src/observability/redact.rs` (coordinator file).
- F136 process and host resource measurement (CPU, memory, whole process tree,
  shared-memory de-duplication) is not in this slice. The pre-registered
  `resources` contract domain looks like its home.
- Plugin activation identity is not correlated yet; plugins have no activation
  records in the daemon.
- No opt-in to include transcripts; the export always excludes them.
- `log.records_dropped` needs a counter in `ade_platform::diagnostics`
  (`ByteBudget` and the lossy non-blocking writer), and
  `agent.output_overflows` needs one in the runtime.
- Only the `interrupted` Conversation status counts as unknown execution;
  `disconnected` is treated as a settled state.
