# e2e-orchestration

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-10
Worker: parallel build, E2E round 1, slice orchestration
Requirements: F101, F102, F103, F104, F105, F106, F107, F114 (backend), F117, 09-S08, 10-S03

## Outcome

`e2e/protocol/orchestration/` holds 23 headless specs (22 pass, 1 `test.fixme`).
They drive real daemon and runtime processes through the SDK, the CLI and the feed,
using the Codex and Claude mocks. The specs found three product bugs, and all three
are fixed:

1. A wait on a queued message reported `pending` when the message could not move. The
   child was interrupted, failed or disconnected, and its queue was unpaused. The
   queue submits only to an idle or ready Conversation, so the wait now reports
   `blocked` with the reason (`sessions/orchestration/policy.rs`).
2. `ade runs start` without `--repository-id` always failed with
   `Unknown worktree record`. It passed the catalog's `repo_…` ID to
   `worktree.switch`, which needs the lifecycle `repository_…` ID. The CLI now gets the
   lifecycle ID from `worktree.repository` at the parent workspace root
   (`apps/cli/src/commands/runs.ts`).
3. Runtime reconciliation and daemon restart recovery each recorded an
   `operation_unknown` activity for the same lost turn under different source keys, so
   the turn showed up twice. An `operation_unknown` activity that names a turn is now
   keyed by that turn, whichever path records it (`store/activity.rs`).

Register acceptance now passes as E2E for F101, F102, F103, F105 and 09-S08, and for
10-S03 at the backend. For F104, F106, F107, F114 and F117, gaps remain; they are
listed below.

## Acceptance criteria

| ID | Criterion | Spec | Result |
|---|---|---|---|
| F101 | One versioned interface; authority, target identity, idempotency, same lifecycle rules | `parity.spec.ts` "an effect command sent by the CLI and retried by the SDK…", "every operation family…"; `delegation.spec.ts` "refuses a forged Agent caller…" | pass |
| F102 | Discover commands, explicit target, structured output, stable errors and exit codes, control GUI-created work | `parity.spec.ts` "every operation family…" (`ade operations` against the contract catalog), "the CLI controls work another client created…" (exit codes 2, 7, `invalid_request`/`not_sent`); CLI cases in `delegation.spec.ts`, `parallel-runs.spec.ts`, `activity.spec.ts` | pass |
| F103 | Headless consumer connects, issues commands, subscribes through generated contracts without React or Electron | `parity.spec.ts` "a headless SDK consumer…"; `activity.spec.ts` feed cases use `AdeClient` | pass |
| F104 | Child with explicit provider, account and workspace; admission and running reported without assuming completion | `delegation.spec.ts` "delegates a child with a durable parent link…", "delegates into a new worktree…" (managed account), "messages a child…" (running phase) | pass, except the `context` binding, which is not modelled |
| F105 | Independent runs with explicit shared or new workspaces; compare outcomes and changes; no automatic merge | `parallel-runs.spec.ts`, all 4 tests (two providers in new worktrees, committed and uncommitted changes, overlap, nothing merged; shared-workspace attribution; attention and ended states) | pass |
| F106 | Relationships and statuses persist across reconnect and restart, including failed and unknown children and independent lifetimes | `delegation.spec.ts` "links, messages and replays survive a daemon restart and a daemon crash", "a child turn lost with its runtime…" | pass for interrupted and unknown; a **failed** child is not covered (no mock prompt fails a turn); **unavailable** cannot occur (no operation removes a Conversation) |
| F107 | Identified messages, bounded waits, questions answered once, timeout and cancellation semantics, unavailable peers | `delegation.spec.ts` "messages a child…" (non-blocking wait, deadline repeat, `timed_out`, `blocked`), "a child question is reported as needs_input…" (late answer refused, mock sees one reply) | pass, except **unavailable peers**, which cannot occur (see F106) |
| 09-S08 | Same ID and payload deduplicates; a changed payload conflicts | `delegation.spec.ts` "a repeated operation ID…" (delegate, child send), CLI case; `parallel-runs.spec.ts` "a repeated group operation ID…"; `parity.spec.ts` (`agent.send` across CLI and SDK) | pass |
| 09-S09 | Old cancellation callbacks must not settle a successor | none | not covered; it belongs to the conversations turn lifecycle |
| F117 | Durable activity with origin and status; filter and open targets; entries readable when extensions disappear | `activity.spec.ts` "a finished turn and a pending request…" (same-commit visibility, targets), "pages activity with a cursor…" (cursor paging, unread filter, read and dismissed state, transactional batch mark, CLI) | pass for backend activity. Extension-originated activity does not exist yet, so its disappearance is not covered. Opening a target in the UI is not covered |
| F114 | Notify for selected events, respect preferences, navigate, deduplicate on reconnect | `activity.spec.ts` "one client claims a notification delivery…" | backend claim and report pass; **preferences and snooze**: `test.fixme` (the daemon has no preference model); navigation and OS presentation are Electron work (not covered) |
| 10-S03 | After reconnect, show the entry once and do not repeat a handled delivery | `activity.spec.ts` "activity survives daemon restarts and crashes…", "a feed consumer reconnects…", "one client claims a notification delivery…" | pass at the backend; Electron presentation not covered |

"Same transaction" is checked through what can be observed. The test sees
`conversation_changed` with status `ready`, then lists activity at once without
polling. The turn's activity is already there, and an `activity_changed` frame
follows it.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm check:static`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/orchestration`: 22 passed, 1 fixme; 44 of 44
  under `--repeat-each 2`.
- In-process tests added (pure cores):
  - `crates/ade-daemon/src/sessions/orchestration/policy.rs`, `queued_messages_wait_unless_the_queue_cannot_move`,
    extended: busy children keep a queued message pending; error, interrupted and disconnected children block it.
  - `crates/ade-daemon/src/store/activity.rs`, `every_report_of_one_lost_turn_shares_its_key`.
- New generic fixtures: `e2e/protocol/fixtures/worktrees.ts` (`createWorktree`, `repositoryId`) and
  `e2e/protocol/fixtures/feed.ts` (`subscribeFeed`, a headless `AdeClient` recorder). Specs import them by
  path; `fixtures/index.ts` is unchanged.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 25 | 0 |

## References

None.

## Open

- A turn lost to a runtime crash is recorded as `turn_interrupted` when the running daemon sees the loss first.
  It is recorded as `operation_unknown` when a restarted daemon sees it first. Each is recorded once. The runtime
  domain should decide whether a runtime crash is always an unknown outcome.
- One run of the full area had a single failure in "delegates into a new worktree…" at the final
  `rejects.toThrow(/different workspace/)`. The error message was not captured. It did not recur in 15 later runs of that test.
- After a cancel or a runtime loss, a child's queue pauses. Unpausing it is not enough: `agent.resume` is also
  required before queued messages move. Waits now say so; the conversations domain may want one action for both.
- Not modelled: the `context` binding for delegation (F104), notification preferences (F114), and
  extension-originated activity (F117).
