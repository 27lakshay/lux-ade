# E2E round 5: terminal flood

Status: returned
Type: slice evidence
Branch: claude/wf_ead686db-a2b-3
Worker: ADE parallel build, round 5, terminal-flood slice
Requirements: R009 and R008 on the terminal lane (both already accepted; this closes a gap in them), 07-S11; F039 (a flaky spec)

## Outcome

Under a terminal flood, a new attachment was closed before its snapshot
arrived, and a viewer slower than the flood could keep missing its snapshot.
Both are fixed in the runtime's terminal host. A viewer that falls a whole
budget behind is now resynchronized in place from a fresh snapshot instead of
being closed. Two new flood specs prove it; the first fails on the old code
exactly as reported. The flaky `quokkaflux` search check in the rewind spec now
polls. No requirement changes status.

## Acceptance criteria

| Criterion | Spec | Result |
|---|---|---|
| An attachment opened during a sustained flood gets its snapshot, then live output contiguous from the snapshot's offset; `xterm-replay-v1` (large, then incomplete past 4 MiB) and base64 `binary` snapshots, eight attachments in a row | `terminals/flood.spec.ts` › attachments opened during a flood each get their snapshot, then live output in order | pass; fails before the fix with "Terminal stream closed before the snapshot" |
| A viewer that reads slower than a 16 MiB flood (64 KiB every 50 ms) is never closed; it gets `resync: true` snapshots, each followed by live output in order, and catches up to the terminal's last byte | `terminals/flood.spec.ts` › a viewer slower than the flood is resynchronized … | pass |
| A fast viewer on the same terminal sees every byte in order on one snapshot while the slow one lags | same | pass |
| Memory stays bounded: runtime RSS growth during the flood stays below 4 × the 4 MiB viewer budget + 8 MiB (measured about 14 MiB; unbounded queueing would hold about 80 MiB of frames) | same | pass |
| A resynchronized viewer is still live afterwards: new output reaches it directly | same | pass |
| A viewer that stops reading entirely is still cut off with an unbroken prefix, and the other viewer keeps up | `reliability-b/slow-subscriber.spec.ts` › a terminal viewer that stops reading is cut off … (unchanged) | pass |
| The rewind spec's search check waits for the history indexer | `accounts-rewind/rewind.spec.ts` › F039: a rewind Claude refuses at its fork-time check … | pass, 10 of 10 repeated |

No spec is marked `test.fixme`.

## Product fix

`crates/ade-runtime/src/bin/supervisor/terminal_host.rs`, `broadcast` and
`subscribe`.

- Cause: each attachment had a 64-frame queue shared by its snapshot and live
  frames. A large snapshot took long enough to write that 64 flood frames
  arrived behind it, and a full queue closed the socket. A viewer slower than
  the flood repeated this on every reattach.
- Fix: each attachment has an `Outbox` budget of 4 MiB and 1024 frames for
  live frames (`VIEWER_QUEUE_BYTES`, `VIEWER_QUEUE_FRAMES`). Snapshots and
  replies are not counted against it. When a frame would exceed the budget,
  the attachment is marked lagging and broadcasts stop queueing for it. When
  its writer thread has written every frame queued before the lag, it takes
  the state lock and builds a fresh snapshot of the kind the attachment
  subscribed with. The writer clears the lag under that lock, so the next
  live frame follows the snapshot with no gap. The snapshot carries
  `resync: true`, `run_id` and `attachment`.
- A viewer that reads nothing is still closed by the socket's existing 2 s
  write timeout. A viewer whose writer is gone is dropped at the next
  broadcast.
- Metrics gain `viewer_resyncs` and `viewer_queue_limit_bytes`.
- Pure-core test, replacing the old eviction test:
  `terminal_host::tests::history_is_bounded_and_a_slow_subscriber_is_resynchronized_not_removed`.

## Operation tiers

No operation was added or changed. The subscribe stream gains the
`resync: true` snapshot frame, and `runtime.status` terminal metrics gain two
fields. Both are additive.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only terminals reliability-b/slow-subscriber.spec.ts accounts-rewind/rewind.spec.ts`: 23 passed
- `terminals/flood.spec.ts --repeat-each 5`: 10 passed
- `accounts-rewind/rewind.spec.ts --grep "fork-time check" --repeat-each 10`: 10 passed
- `pnpm check:static`: pass (798 Rust tests)
- In-process tests added: the replaced test above

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 10 | 35 | 0 |

## References

None.

## Open

- The SDK (`packages/client/src/terminal.ts`) passes a mid-stream snapshot to
  `onFrame` unchanged. A renderer must treat a `resync: true` snapshot as a
  reset and replay it; no renderer does yet. This belongs to the UI phase.
- An incomplete `xterm-replay-v1` resync snapshot (past the 4 MiB bound) has
  no events, so a resynchronized xterm viewer loses the skipped output's
  screen. The `binary` snapshot keeps the screen. This is the existing 07-S11
  behaviour, now reached by slow viewers too.
- Outside this area: `e2e/protocol/load/load.spec.ts` (around line 56–73)
  retries an attachment closed before its snapshot, and its
  `slow_attachments_evicted` result counts those closes. Both are now mostly
  dead paths; the load owner may drop the retry and report `viewer_resyncs`.
- The daemon relay comment in `crates/ade-daemon/src/bin/daemon/server.rs`
  ("slow viewers are evicted upstream") now means "resynchronized upstream,
  or cut off by the write timeout". Not edited, since it is outside this area.
- The round-4 report named `e2e/protocol/ops3/rewind.spec.ts:247`. That file
  does not exist on this branch; the check is in
  `e2e/protocol/accounts-rewind/rewind.spec.ts` (line 368 before the edit).
- A spec note for future flood tests: an `expect` per frame over a flood
  stalls the test's event loop for seconds, so the test itself becomes a
  stuck viewer and is cut off. `flood.spec.ts` checks order in plain code and
  asserts once.
