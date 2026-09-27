# e2e-terminal-cleanup

Status: returned
Type: slice evidence
Branch: claude/wf_29c70e79-8bf-3
Worker: workflow wf_29c70e79, worker 3 (terminal-cleanup)
Requirements: R019 (load run, slow consumer), F081 (CLI restore after a resync); follow-up to `e2e-terminals2.md`

## Outcome

The cleanup after the terminal resync change is done, and one new CLI spec
proves the complete-history resync path end to end. The spec also exposed one
runtime gap, which is recorded as a `test.fixme` and not fixed here. No
requirement changes state: R019 and F081 were already accepted, and they
still pass.

- `load/load.spec.ts` no longer reattaches a closed terminal. Each streaming
  terminal waits on its original attachment and must still be open when its
  last line arrives. After the sustained phase, the spec asserts that no
  terminal attachment was closed. The results record `viewer_resyncs`, the sum
  of the runtime's resync counter over all 20 terminals, in place of
  `slow_attachments_evicted`.
- The relay comment in `crates/ade-daemon/src/bin/daemon/server.rs` now says
  the runtime resynchronizes a slow viewer instead of closing it. There is no
  code change.
- `terminals2/resync.spec.ts` › "ade terminal attach replays the complete
  history after a resync within the replay bound" is new. The shell prints
  `seq 1 300000`, about 2.3 MB of distinct lines, which is under the 4 MiB
  replay bound. The CLI sits behind a TTY that drains 4 KiB every 50 ms, so it
  falls a whole frame budget behind. The spec then checks:
  - the runtime counted at least one resync;
  - the CLI wrote one reset (`ESC c`) for each resync;
  - there is no `replay_limit_exceeded` warning, no byte gap and no error;
  - after the last reset, the TTY holds every line from 1 to 300000 exactly
    once and in order, then `flood-end`, then live output typed after the
    resync;
  - the CLI is still attached, a fresh snapshot still reports
    `complete: true`, Ctrl-] exits 0, and the shell PID and `run_id` are
    unchanged.

  The TTY is released once the flood has finished. At that point the runtime
  is still draining the frames it queued before the lag, so the replay goes
  to a fast TTY. For why this matters, see Open.

## Bug found, outside this area (runtime or CLI)

`ade terminal attach` behind a slow TTY is closed during a complete-history
replay. The CLI writes the replay to its TTY synchronously. If that takes
longer than 2 s, the CLI stops reading its socket for that long. The
runtime's terminal writer has a 2 s write timeout, which is meant for a
viewer that reads nothing. It closes the attachment, and the CLI exits 3 with
`{"type":"error","code":"unavailable","message":"Terminal connection closed."}`.

To reproduce, run a 2.3 MB replay into a TTY that drains about 320 KB/s. Seen
at `crates/ade-runtime/src/bin/supervisor/terminal_host.rs` (writer thread,
`set_write_timeout(2 s)`) and `apps/cli/src/commands/terminals.ts` (the resync
replay loop).

This contradicts "a slow viewer is resynchronized, not closed". It is recorded
as `terminals2/resync.spec.ts` › "ade terminal attach survives a
complete-history replay slower than the write timeout" (`test.fixme`). I ran
it unmarked, and it failed as described. Possible fixes:
- make the CLI yield between replay chunks (async writes with backpressure);
- or have the runtime resynchronize, not close, a writer that times out
  while it is lagging.

## Operation tiers

No operations were added or changed.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only terminals2 load/fault-classes.spec.ts load/fault-gaps.spec.ts load/computer-availability.spec.ts`: 16 passed, 3 skipped. The skips are 2 existing fault-class gaps and the new fixme. The new CLI spec also passed 4 of 4 with `--repeat-each 4`.
- `ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only load/load.spec.ts`, run alone: pass in 9.3 s. Results:
  - `viewer_resyncs` was 19, and no attachment was closed.
  - Admission p95 was 48.9 ms sustained, 20.7 ms idle and 17.6 ms after the crash; the target is 250 ms.
  - Echo p95 was 16.4 ms sustained.
  - Recovery after the crash took 100 ms.
  - Host: 10 CPUs, load average 1.3 to 2.6.
- `pnpm check:static`: pass (810 legacy Rust tests passed).
- In-process tests added: none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 20 | 0 |

## References

None.

## Open

- Fix the slow-TTY close above, in the terminals domain (runtime or CLI).
  Then remove `fixme` from the gap spec.
- The slow-consumer row of R019 in `e2e-load-conformance.md` now notes the
  change: terminal viewers are resynchronized, not reattached.
