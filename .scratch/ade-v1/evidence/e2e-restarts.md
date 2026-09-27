# e2e-restarts

Status: returned
Type: slice evidence
Branch: claude/wf_59b7ac6e-d6c-2
Worker: E2E round 4, slice restarts-profiles
Requirements: R011 (advanced: the rewind half now passes; not accepted, because ADE has no conversation delete); R005, F005, F007 (re-run, not accepted: the remaining parts need the Electron window)

## Outcome

New headless specs in `e2e/protocol/restarts/` prove that results read
before a Claude conversation rewind cannot resurrect or cross-associate data
after it. They exposed one product bug, now fixed: a search match carried no
history epoch, so a late match opened by position showed a different message.
No requirement is fully accepted by this slice. The earlier specs for R005,
F005 and F007 still pass on the current build.

## Acceptance criteria

R011 "Delay history/search responses, then delete/rewind/switch profile; late results cannot resurrect or cross-associate data":

| Criterion | Spec | Result |
|---|---|---|
| A snapshot read before a rewind arrives after it. The view shows it only as `stale`, never as `current`. The view then settles on the rewound history (epoch 1). After the next turn reuses the removed sequence numbers, the view holds the new messages. | `restarts/stale-rewind.spec.ts` › snapshot delayed across a rewind | pass |
| A search match read before a rewind is refused when opened at its position (`conversation.get` with `before` and the match's `history_epoch`). Without this, the position would show the next turn's message, which reused the sequence. The removed message ID resolves nowhere. A fresh match carries epoch 1 and opens on the new message. | `restarts/stale-rewind.spec.ts` › search reply, older page and cursor | pass (failed before the fix) |
| An older page read before the rewind is refused | same spec | pass |
| A search cursor issued before the rewind pages only messages that still exist | same spec | pass |
| Profile switch: late snapshot, late frames, crossed cursors | `reliability-b/stale-results.spec.ts` (round 3) | pass |
| Delete, then late results | `restarts/stale-rewind.spec.ts` › conversation delete | fixme: no operation deletes a Conversation |
| A renderer discards a delayed search reply after a switch | none | not covered: renderer work. The daemon side is now covered: a late match carries its epoch and conversation, and neither resolves after a rewind or in another profile. |

R005, F005 and F007 were re-run, not extended. The earlier evidence maps
their criteria: `e2e-reliability-b.md`, `e2e-recovery.md` and
`e2e-profiles.md`. All their headless parts pass on this build. These parts
remain uncovered because they need the Electron window:

- R005: the renderer itself closes or reloads.
- F005: the desktop connects to a CLI-started backend.
- F007: Electron partition storage (cookies and site storage) survives a restart for each profile.

## Product fixes

1. **A late search match could cross-associate after a rewind.** A rewind
   deletes messages from a sequence onward. The next turn takes those
   sequence numbers again (`next_sequence` is `MAX(sequence)+1`). A
   `history.search` match gave `message_id` and `sequence`, but no history
   epoch. A caller that opened a delayed match at its position therefore saw
   a different message, and could not detect this.
   - Fix: `HistoryMatch` gains `history_epoch`, the conversation's rewind
     epoch when the match was read (`crates/ade-core/src/contract/history.rs`).
     The search joins `conversation_history_epochs`, which `History::open` now
     creates idempotently with the store's own `HISTORY_EPOCHS` schema
     (`crates/ade-daemon/src/history.rs`, `crates/ade-daemon/src/store.rs`).
     `conversation.get` already refuses `before` with a stale `history_epoch`,
     so opening a late match is refused.
   - Spec: `restarts/stale-rewind.spec.ts` › search reply.

## Operation tiers

`history.search` (query): its reply gained one field, `history_epoch`, on each match. No tier changed.
Generated contracts were regenerated with `pnpm contract:generate`.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/restarts`: 2 passed, 1 fixme. It also passed 12 of 12 with `--repeat-each 6`.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/restarts e2e/protocol/profiles e2e/protocol/reliability-b e2e/protocol/recovery e2e/protocol/ops3/rewind.spec.ts e2e/protocol/catalogs/history.spec.ts e2e/protocol/catalogs/imports.spec.ts e2e/protocol/backup/history.spec.ts e2e/protocol/backup/restore.spec.ts`: 55 passed, 3 skipped, 1 failed. The failure is a race in an ops3 spec, described under Open. It fails 1 in 8 when repeated alone.
- `pnpm check:static`: pass, 784 Rust tests.
- In-process tests changed: `crates/ade-core/src/contract/history.rs` `replies_round_trip_in_the_daemon_shape` now includes `history_epoch`.
- `pgrep` after the runs: no `ade-daemon`, `ade-runtime` or `security` process from this worktree is running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 20 | 0 |

## References

- `e2e/protocol/ops3/rewind.spec.ts`: the three-turn Claude rewind pattern.
- `e2e/protocol/reliability-b/stale-results.spec.ts` and `e2e/protocol/fixtures/sync-view.ts`: the held-snapshot pattern.
- No external code was copied.

## Open

- **Outside this area (ops3):** `e2e/protocol/ops3/rewind.spec.ts:247`
  (`a rewind Claude refuses at resume…`) asserts `hits(profile, 'quokkaflux')`
  once, without `expect.poll`. The history indexer runs every 250 ms, so the
  assertion fails when the test outruns it (1 in 8 when repeated alone). The
  fix is to poll, as the first test in that spec does.
- R011 needs a conversation delete operation before its "delete" half can be
  proved. The fixme names this gap.
- Renderer and desktop search views should pass `history_epoch` with `before`
  when opening a match.
- Shared files touched: the generated contracts only (`packages/contracts`),
  regenerated from the `history` domain contract.
