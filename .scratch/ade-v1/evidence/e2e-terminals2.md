# E2E round 6: terminals 2

Status: returned
Type: slice evidence
Branch: claude/wf_58471be9-2ec-1
Worker: ADE parallel build, round 6, terminals slice
Requirements: F081, F082 (07-terminals-services), decision D06; the resync wire break from `e2e-terminal-flood.md`

## Outcome

The runtime's mid-stream `resync: true` snapshot (merged here from
`claude/wf_ead686db-a2b-3`) broke every caller. The CLI's `terminal attach`
failed with a byte gap. The SDK passed a gap on silently. The desktop adapter
would have replayed on top of a stale screen while applying live output
during the replay. All three now reset and restore from a resync snapshot.
The flood specs prove the CLI and the SDK, and the new CLI spec fails on the
old CLI. F081 now passes headlessly, down to the xterm.js screen and modes,
through the adapter's own restore code. F082 passes only for its headless
parts. One F082 bug is fixed: xterm counted an emoji as one cell while the
runtime counts two.

## How xterm runs headless

`@xterm/xterm`'s core runs in Node without `open()`. Its parser, buffers,
modes, cursor, Unicode widths and `onData` replies all work. Selection,
`paste()`, the keyboard, fit and rendering need a DOM. The adapter's
stream logic moved out of `mountTerminal` into
`packages/terminal/src/feed.ts` (`TerminalFeed`, `suppressReplies`), and its
terminal options into `options.ts` (`terminalOptions`, `prepareTerminal`).
The specs drive those same modules against a real `Terminal`, so the code
under test is the code the desktop runs.

## Acceptance criteria

| Criterion | Spec (`e2e/protocol/terminals2/`) | Result |
|---|---|---|
| SDK: a mid-stream `resync: true` snapshot is passed on; its offset is tracked; `resyncs()` counts it; nothing is closed | `resync.spec.ts` › the SDK and the xterm adapter restore exactly from a resync snapshot mid-stream | pass |
| xterm adapter: a resync with full history resets xterm and replays it. The resynchronized viewer's viewport, cursor, buffer and modes equal a new attachment's. No gap status, then live output. Same shell | same | pass |
| xterm adapter: a resync past the 4 MiB replay bound resets xterm and reports that history is lost. There is no gap, and the view is live afterwards | `resync.spec.ts` › a resync past the replay bound resets the xterm view … | pass |
| CLI `terminal attach` under a PTY that reads slower than a 16 MiB flood is resynchronized. It resets the TTY (RIS), reports no gap and stays attached. Later output reaches the TTY. Ctrl-] detaches with exit 0 and the same shell keeps running | `resync.spec.ts` › ade terminal attach resets and restores its TTY on a resync and stays attached | pass; fails on the old CLI ("live output after the resync on the TTY") |
| SDK refuses a real output gap: `output_gap` error frame, then close | `resync.spec.ts` › the SDK passes a resync snapshot on and refuses a real output gap (scripted socket peer) | pass |
| F081: a full-screen program (raw mode, alternate screen, bracketed paste, application cursor keys, mouse reporting) keeps running. Its only view detaches and the daemon is SIGKILLed. A new view restores the same viewport, cursor, alternate buffer and modes in xterm. The program PID, shell PID and `run_id` are unchanged. The program still reads keys. Leaving it restores the normal screen and modes. A replay-only view matches the live one | `screen.spec.ts` › a full-screen program survives detach and a daemon kill … | pass |
| F081, earlier round: replay bytes, resize order, graceful restart, CLI detach | `terminals/recovery.spec.ts` (unchanged) | pass |
| F082 Unicode: UTF-8 reaches xterm and the replay byte for byte. CJK (2 cells) and e + U+0301 (1 cell) leave xterm's cursor on the runtime's column | `ergonomics.spec.ts` › Unicode reaches xterm byte for byte … | pass |
| F082 Unicode: an emoji takes 2 cells in xterm, as in the runtime | `ergonomics.spec.ts` › an emoji takes the same cells … | pass after fix; failed before (xterm 53, runtime 54) |
| F082 keyboard, byte level: Ctrl-C reaches the foreground program, not the shell, with the same shell PID and `run_id` | `ergonomics.spec.ts` › Unicode … (second half) | pass |
| D06: xterm does not answer DSR 6 or DA1 that the runtime already answered. The program reads exactly one answer each and nothing else before `q`. Control: an unprepared xterm fed the same frames does answer | `ergonomics.spec.ts` › xterm does not answer a terminal query … | pass |
| F082 fit, search, links, selection and copy, key mapping, IME, bracketed `paste()`, themes, renderer fallback | none | needs Electron: each needs a DOM |
| F081 drawing the restored screen on a DOM, and fit after restore | none | needs Electron |

No spec is marked `test.fixme`.

## Product fixes

- `apps/cli/src/commands/terminals.ts` (`attachTerminal`): a snapshot after
  the first resets the TTY with RIS. With full history it replays that
  history. Past the replay bound it moves to `through_offset` and writes a
  `replay_limit_exceeded` warning with `resync: true`. Before this fix, the
  first live frame after a resync failed as a byte gap.
- `packages/client/src/terminal.ts`: tracks the live offset from each
  snapshot's `through_offset`. A frame at any other offset gives an
  `output_gap` error frame and closes the connection. Adds `offset()` and
  `resyncs()`.
- `packages/terminal/src/feed.ts` (new, from `index.ts`): `TerminalFeed`
  resets xterm on a later snapshot and replays it. It queues live frames
  during any restore, within the existing bound, and gates input until the
  restore ends. Before, only the first snapshot was a restore, and live
  frames were written into xterm during a later replay.
- `packages/terminal/src/options.ts` (new): `prepareTerminal` loads
  `@xterm/addon-unicode11` 0.9.0 (MIT, xterm.js authors; the release that
  matches xterm 6.0.0 and addon-fit 0.11.0) and activates Unicode 11 widths.
  `terminal.unicode` needs `allowProposedApi: true`.
- `apps/desktop/src/main/terminals.ts` and `preload/terminal.ts` forward
  frames unchanged and in order. Only a comment and the `TerminalBridge`
  doc changed. The SDK below them now refuses gaps, and the feed above them
  handles the resync.

## Operation tiers

No operation was added or changed. The SDK's `TerminalConnection` gains
`offset()` and `resyncs()`. It emits a new client-side `output_gap` error
frame.

## Fixture changes

- `e2e/protocol/fixtures/terminals.ts`: `attachThroughTty` takes an optional
  `TtyThrottle` (`bytesPerTick`, `tickMs`, `releaseFile`). The relay then
  reads the PTY at that rate until the release file exists.
- `e2e/protocol/terminals2/xterm.ts`: a headless xterm built with the
  adapter's options, `screenOf`, `xtermView` and `openView` (SDK plus
  TerminalFeed).
- `e2e/protocol/terminals2/viewer-worker.mjs`: a desktop-shaped viewer on a
  worker thread. It blocks per output byte until the test releases it.
  Node strips `feed.ts`'s types, so the feed avoids parameter properties.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only terminals2 terminals reliability-b/slow-subscriber.spec.ts`: 23 passed
- Other callers of the SDK or CLI terminal (`resources/host-resources`,
  `hooks-auth/auth`, `load/fault-gaps`, `profiles/continuity`): 18 passed
- `terminals2/ergonomics.spec.ts terminals2/screen.spec.ts --repeat-each 6`: 24 passed
- `pnpm check:static`: pass (804 Rust tests)
- In-process tests added: none
- No `ade-daemon`, `ade-runtime` or `security` process from this worktree was
  left running (`pgrep`). Nothing called the Security framework or a keychain.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 30 | 5 |

## References

- xterm.js `@xterm/addon-unicode11` 0.9.0 README (usage), studied.

## Open

- `pnpm-lock.yaml` gains `@xterm/addon-unicode11` for `packages/terminal`.
  The coordinator may need to regenerate the lockfile on a merge conflict.
- The desktop main process forwards frames over IPC without backpressure. A
  slow renderer therefore never lags the socket, and the runtime never
  resynchronizes it. Main-process memory grows instead. This belongs to the
  UI phase.
- During a resync replay the adapter drops keystrokes, as it did during the
  first restore. This keeps xterm's replay replies out of the PTY (D06). A
  replay under the 4 MiB bound takes well under a second.
- F082 needs Electron E2E for fit, search, links, selection and copy, key
  mapping, IME, bracketed `paste()`, themes and renderer fallback. The
  package has no search or web-links addon yet.
- Outside this area, and unchanged since `e2e-terminal-flood.md`:
  `load/load.spec.ts` retries a closed attachment, and the daemon relay
  comment about eviction in `server.rs` is out of date.
