# e2e-reliability-b

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-3
Worker: E2E round 3, slice reliability-b
Requirements: R005, R006, R008, R009, R010, R011

## Outcome

Headless E2E specs in `e2e/protocol/reliability-b/` prove the reliability
criteria for restarts, process uncertainty, output limits, slow consumers,
view consistency and stale results. They drive real daemon, runtime and
provider-mock processes through the SDK (including `@ade/client/sync`), the
CLI and the raw protocol. All 13 specs pass, and none is `test.fixme`. The
specs exposed two product bugs, both fixed:

- A provider burst killed its run as "exceeded the replay buffer while the
  daemon was unavailable", although the daemon was attached.
- A descendant that left the provider's group before a runtime crash was not
  recorded, so its attempt settled while it still ran.

R006, R008, R009 and R010 now pass their full register acceptance. R005 and
R011 are partial; see below.

## Acceptance criteria

The criteria are the R005, R006 and R008 to R011 rows of `13-reliability/spec.md`,
plus the "needs E2E later" items in `e2e-recovery.md`.

| Req | Criterion | Spec | Result |
|---|---|---|---|
| R005 | A view (SDK client plus sync projection) closes mid-turn. The daemon is killed, then restarted gracefully. The provider run, its tool, a terminal shell and the runtime identity survive, and nothing is reconciled or replayed | `restarts.spec.ts` | pass |
| R005 | The checkout claim protects the tree throughout. While no daemon runs, the claim is `quarantined` with `owner_lost_during_use`, and another profile's removal is refused. After each restart, one active live claim from the new incarnation replaces it | `restarts.spec.ts` | pass |
| R005 | A new view restores the running turn and follows it to the end. A retried send is deduplicated, and the same provider process takes the next turn | `restarts.spec.ts` | pass |
| R005 | The Electron renderer itself closes or reloads | none: Electron E2E is paused | not covered |
| R006 | Stale process identity: a recorded PID now held by an unrelated process (different start stamp) is read as gone. The attempt settles `outcome_unknown` with no PIDs, the unrelated process is not signalled, and the turn is not replayed | `uncertainty.spec.ts` › recorded PID | pass |
| R006 | A provider descendant that left its group before a runtime crash keeps the attempt `quarantined`, with its PID, and refuses resume. Once it exits, a recheck settles the attempt and resume works | `uncertainty.spec.ts` › left its group | pass (failed before fix 2) |
| R006 | Ignored signals, reparented descendants, quarantined trees | `recovery/descendants.spec.ts`, `recovery/runtime-crash.spec.ts` (round 1) | pass |
| R008 | Terminal output past the replay bound while no daemon runs is reported as `replay_limit_exceeded` with `through_offset`, through the SDK and the CLI. The shell keeps running and nothing is replayed | `output-limit.spec.ts` | pass |
| R008 | An evicted feed subscriber receives an unbroken run of revisions, then a close, never a silent gap. A new subscription starts from a fresh catalog | `slow-subscriber.spec.ts` › feed | pass |
| R008 | A stuck terminal viewer receives an unbroken prefix of offsets, then a close. Reattaching replays everything it missed | `slow-subscriber.spec.ts` › terminal | pass |
| R008 | The provider replay journal overflows while the daemon is away (degraded, no exit) | `recovery/replay-overflow.spec.ts` (round 1) | pass |
| R009 | A raw feed client stops reading. A Codex flood (640 × 64 KiB), Claude turns and a fast SDK client run alongside it. The stuck client is evicted and counted (`feed.subscribers_evicted` = 1, subscribers back to 1). The fast client sees every revision in order, without reconnecting, and receives all 640 items. Every `hello`, `catalog.get` and `diagnostics.status` answers in under 2 s | `slow-subscriber.spec.ts` › feed | pass (failed before fix 1) |
| R009 | A terminal viewer that stops reading does not slow another viewer. Input still echoes in under 2 s, the PTY producer is never stalled, and the shell is untouched | `slow-subscriber.spec.ts` › terminal | pass |
| R009 | A stopped (disconnected) SDK client receives nothing more | `stale-results.spec.ts` › stopped client | pass |
| R010 | The projection loses its connection mid-turn (same boot, revision gap). It shows `stale`, takes a new snapshot and ends equal to a fresh `conversation.get` | `consistent-view.spec.ts` › repairs | pass |
| R010 | After a daemon kill or a graceful restart mid-turn, the client reconnects by itself. The boot change forces a new snapshot, the view converges, and there are no duplicate messages or replayed tools | `consistent-view.spec.ts` › repairs | pass |
| R010 | A late snapshot never hides newer frames. A snapshot read from the old daemon, delivered after the new boot's first frame, is replaced by a fresh one | `consistent-view.spec.ts` › late snapshot | pass |
| R010 | A retained activity cursor catches up exactly across a daemon kill. A history search cursor still pages on its own epoch after the restart, and is refused as expired after a rebuild changes the epoch | `consistent-view.spec.ts` › cursors | pass |
| R011 | A profile switch while the old profile's snapshot reply is held back: the late reply and later frames never reach the closed view or the new one. The other profile's conversation ID does not resolve | `stale-results.spec.ts` › profile switch | pass |
| R011 | A switch between conversations in different workspaces while the old one produces: the new view takes none of its content. A workspace-scoped search excludes it | `stale-results.spec.ts` › workspaces | pass |
| R011 | A late older page holds only older messages and merges without duplicates. A search cursor replayed on another profile returns only that profile's data | `stale-results.spec.ts` › late pages | pass |
| R011 | Delete or rewind, then late results | none: there is no conversation delete, and conversation rewind is reported unavailable (F039) | not covered |
| R011 | A delayed `history.search` reply discarded by the caller after a switch | none: the SDK has no search client that tracks context; this belongs to the renderer | not covered |

## Product fixes

1. **A provider burst killed its run while the daemon was attached.**
   The runtime journal accepted output as fast as the provider wrote it and
   overflowed at 32 MiB. The daemon drains in 128-event batches, so a 40 MiB
   burst stopped the run with "Agent output exceeded the replay buffer while
   the daemon was unavailable". It then lost the last 130 messages, although
   the daemon was attached and consuming.
   - Fix: `agent_budget::backpressure` is a pure decider with its own test,
     in `crates/ade-runtime/src/agent_budget.rs`. A full journal now waits for
     acknowledgement while the daemon has read events within
     `CONSUMER_WINDOW` (5 s). The journaling thread stops reading, the
     bounded queue fills, and the provider pipe blocks. `acknowledge` wakes the
     waiter. A daemon that is away still gets the overflow marker, and
     `recovery/replay-overflow.spec.ts` still passes.
   - Spec: `slow-subscriber.spec.ts` › feed.
2. **An escaped provider or shell descendant was invisible to restart
   reconciliation.** Only the recorded process and its group were checked.
   A descendant that called `setsid` let the attempt settle and released its
   workspace while it still ran. This is the gap behind the round-1 fixme.
   - Fix: at every 2 s identity snapshot, the daemon extends a
     `descendants::Tracker` for each recorded process. A new
     `Tracker::forget_exited` keeps it bounded to what runs. The daemon records
     each live descendant's PID and start stamp in a new table,
     `runtime_attempt_descendants`, which is created idempotently, pruned with
     its incarnation and cleared on backup restore. `recovery::tree` counts a
     recorded descendant only while its own start stamp matches, even when
     the root PID was reused. Both rules have pure tests, in
     `crates/ade-daemon/src/sessions/recovery.rs` and
     `crates/ade-runtime/src/descendants.rs`.
   - Spec: `uncertainty.spec.ts` › left its group.
   - The `test.fixme` in `e2e/protocol/recovery/descendants.spec.ts`
     (escaped script descendant) passes with this fix: it was checked on a
     scratch copy with `fixme` removed. It belongs to the recovery area, so it
     was not edited.

## New generic fixtures

Both are in `e2e/protocol/fixtures/`:

- `raw-feed.ts`: `RawFeed.open` subscribes to the feed, and
  `RawFeed.openTerminal` attaches as a terminal viewer. Either can `pause()`
  and `resume()` reading, and records its frames and the close.
- `sync-view.ts`: `openConversationView` is the renderer's pair: the SDK
  `AdeClient` feed plus `startConversationProjection` from
  `@ade/client/sync`, with `conversation.get` snapshots. It can hold a
  snapshot reply back (`holdNextSnapshot`), detach and attach clients, and
  dispose. `viewDigest` compares a view with a fresh snapshot.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm check:static`: pass. It ran 758 Rust tests.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/reliability-b
  e2e/protocol/recovery e2e/protocol/backup/restore`, after the final build:
  28 passed, including all 13 in this area, and 1 skipped (the round-1 fixme).
- In-process tests added:
  - `agent_budget::tests::a_full_journal_waits_for_an_attached_daemon_and_overflows_without_one`
  - `recovery::tests::a_recorded_descendant_that_left_the_group_keeps_the_tree_running`
  - `descendants::tests::exited_and_reused_descendants_are_forgotten_and_escaped_ones_kept`
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree after the runs.

## Requirements whose full register acceptance passes

- **R006**: ignored signals, reparented and escaped descendants, stale process
  identity. This slice covers the last two; round 1 covered the rest.
- **R008**: the provider spool (round 1), the terminal replay (here and in
  `terminals`), and reconnect history (evicted subscriber, projection
  resnapshot).
- **R009**.
- **R010**. The SDK persists no feed cursor: every reconnect takes a new
  snapshot. So "interrupted cursor persistence" is covered by the
  projection-interruption cases and the retained and expired cursor cases.

Partial:

- **R005**: every part passes except the Electron renderer close and reload.
  The headless view uses the same SDK modules as the renderer.
- **R011**: profile and workspace switches, late snapshots, late pages and
  crossed cursors pass. Delete and rewind have no operation to exercise, and
  discarding a delayed search reply is renderer work.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 150 | 10 | 25 | 0 |

## References

- `docs/proposed-architecture.md` section 4 (runtime restart reconciliation)
  and section 5 (HostResources).
- `e2e/protocol/ops/diagnostics.spec.ts` (stalled-subscriber pattern).
- No external code was copied.

## Open

- Enable the `test.fixme` in `e2e/protocol/recovery/descendants.spec.ts`. It
  passes with fix 2.
- A descendant that escapes and is reparented before the first 2 s identity
  snapshot is still not recorded. The runtime would have to report its own
  tracked descendants to close that window.
- The same attached-daemon backpressure question applies to the ACP adapter's
  `try_send` then `Overloaded` path (`acp_session.rs`), noted in round 1. It
  was not changed.
- The claim a daemon holds for a live shell gets a new ID with each daemon
  incarnation. Protection is continuous, but a UI that tracks claims by ID
  sees a replacement.
