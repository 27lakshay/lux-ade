# control-lane

Status: returned
Type: slice evidence
Branch: claude/wf_58471be9-2ec-4
Worker: workflow wf_58471be9, worker 4 (control-lane)
Requirements: R004

## Outcome

Each profile daemon now has a control lane: a second owner-only socket beside
its profile socket, with its own accept thread and listen backlog. It serves
only stop, health and shutdown operations. `@ade/client` sends those
operations there, so the SDK and the CLI can stop existing work while a
connection flood fills the profile socket's backlog.

The fixme in `reliability-a/overload.spec.ts` ("a cancel sent during a
connection flood past the socket backlog is admitted on its first attempt")
now passes. With it, every part of the R004 register criterion has a passing
spec. One part, the full data volume, was not rerun in this slice (see
"What is uncertain").

## What is uncertain

- **The full-volume test was not rerun.** It needs `hdiutil`
  (`ADE_E2E_SYSTEM=1`), which this slice was not allowed to use. It skipped
  in every run here. Its last passing runs are in `e2e-reliability-a.md`
  (overload follow-up, round 4). The control lane does not change the
  storage path it covers.
- **The flood is made deterministic by pausing the daemon.** A flood of 2,000
  connections refused 700 to 900 of them at the profile socket, but a cancel
  sent after them still connected in every run, with or without a control
  lane. The backlog drains too fast to test by timing alone. `fillBacklog`
  (`control-lane/backlog.ts`) therefore pauses the daemon with SIGSTOP. It
  floods the profile socket until a new connection gets ECONNREFUSED, sends
  the stop, checks that the profile socket still refuses, and then sends
  SIGCONT. This models an accept loop that falls behind a flood. It does not
  measure how far behind the real loop falls.
- **The tests fail without the lane.** With the control socket removed, the
  positive cancel test failed in 3 of 6 runs. The other 3 passed only
  because the SDK's fallback connected after the daemon resumed. With the
  old client, which had no control lane, the cancel connects while the
  daemon is paused, so the test fails every time. The negative test waits
  for the fallback to settle while the daemon is paused, so its refusal is
  deterministic.
- **The CLI has no flood test.** A spawned CLI's connect time cannot be
  placed inside the pause without sleeping. The CLI uses the same
  `requestDaemon` from `@ade/client`. Its routing is covered by the
  unauthenticated test and the fallback test.
- **The fixture still stops daemons over the profile socket.** It sends
  `runtime.prepare_restart` with a raw `rpc` (`fixtures/profile.ts`).
  Shutdown over the control lane has its own spec.
- **`runtime.prepare_restart` is refused during a flood.** It needs the
  admission write lock (`try_write`), and in-flight ordinary commands hold
  read locks. The refusal "A command is still being admitted; retry
  shortly" is true and comes before admission. The lane only removes the
  backlog refusal.

## Design

- Path: `/x/ade.sock` becomes `/x/ade.control.sock`. A path without `.sock`
  gains `.control`. Both the daemon (`control_socket`) and the client
  (`controlSocketPath`) derive it the same way.
- Allowlist: `hello`, `runtime.status`, `diagnostics.status`,
  `agent.cancel`, `terminal.stop`, `service.stop` and
  `runtime.prepare_restart` (shutdown). Any other line, including a raw
  terminal protocol line, gets `invalid_request` with
  `pre_admission_rejected: true`. The connection stays open.
- Authentication is the owner socket's: the file is mode 0600, and every
  accepted peer passes `authenticate_peer`. Requests are served by the same
  `handle_connection`, with a `Lane` argument.
- The lane opens after the owner socket is bound. If it cannot be opened,
  the daemon logs this and keeps serving the owner socket.
- The client tries the control lane first for an allowlisted operation, but
  not for a paired (remote) connection. It falls back to the profile socket
  only when the lane took nothing: the error is `unavailable`, `not_sent`
  and not a daemon reply. That covers a missing lane (an older daemon, or a
  forwarded remote socket), a refused connection and a close before the
  request was sent. A daemon refusal such as `unauthenticated` is returned
  as is, with no fallback.

Code:

- `crates/ade-daemon/src/bin/daemon/server/control.rs` (new)
- `crates/ade-daemon/src/bin/daemon/server.rs`: `Lane`, the allowlist check
  in `handle_connection`, and `control::start`
- `crates/ade-daemon/src/bin/daemon/server/paired.rs`: passes `Lane::Owner`
- `packages/client/src/request.ts`: `controlOperations`,
  `controlSocketPath`, and the routing in `requestDaemon`

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| R004 | Saturate ordinary commands: a cancel sent while a flood fills the profile socket's backlog is admitted on its first attempt | `reliability-a/overload.spec.ts` "a cancel sent during a connection flood past the socket backlog"; `control-lane/control-lane.spec.ts` "a cancel sent while a connection flood fills the profile socket backlog" | pass (was fixme) |
| R004 | Stops of other existing work under the same flood | `control-lane.spec.ts` "terminal.stop and service.stop sent while a connection flood fills the profile socket backlog" | pass |
| R004 | Saturate output together with 400 ordinary commands | `overload.spec.ts` "an output flood and a burst of ordinary commands" | pass (rerun) |
| R004 | Saturate receipts | `recovery/receipt-saturation.spec.ts` | pass (rerun in the `recovery` run) |
| R004 | Fill a disposable volume: new work refused, stop still sent, truthful reply | `overload.spec.ts` "with the data volume full" | pass (cited from round 4; skipped here, needs `hdiutil`) |
| R004 | The emergency stop path is authenticated | `control-lane.spec.ts` "the control lane refuses a peer that is not the profile user" (raw, SDK and CLI) and "an owner-only socket" | pass |
| R004 | Ordinary work cannot use the reserved lane | `control-lane.spec.ts` "refuses ordinary commands before admission and nothing runs" | pass |
| (compat) | With no control lane, the SDK and the CLI fall back to the profile socket | `control-lane.spec.ts` "without a control lane, as with an older daemon" | pass |
| (compat) | Without the lane, the same full backlog refuses the cancel truthfully (`unavailable`, `not_sent`) | `control-lane.spec.ts` "without the control lane, the same full backlog" | pass |
| (shutdown) | Shutdown over the lane hands the runtime over and removes both sockets. The next daemon opens a new lane. | `control-lane.spec.ts` "shutdown over the control lane" | pass |

## Operation tiers

No operation was added and no tier changed. The lane is a transport.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/control-lane
  --repeat-each 5`: 40 passed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only
  e2e/protocol/reliability-a/overload.spec.ts --repeat-each 3`: 6 passed
  and 3 skipped (the full-volume test).
- Regression, `ADE_E2E_WORKERS=2`: `control-lane`, `reliability-a`,
  `hooks-auth`, `recovery`, `terminals`, `services`, `remote`, `remote2`,
  `profiles`, `restarts`, `boot.spec.ts` and `load/fault-classes.spec.ts`
  gave 214 passed and 4 skipped. `conversations`, `conversations2`,
  `reliability-b`, `reliability-core`, `errors` and `secrets` gave 268
  passed.
- `pnpm --filter @ade/client test`: 58 passed.
- `pnpm check:static`: pass, with 806 Rust tests passed and 5 skipped.
- In-process tests added:
  - `control.rs`: `the_control_socket_sits_beside_the_owner_socket` and
    `only_stop_health_and_shutdown_operations_use_the_control_lane`.
  - `packages/client/src/request.test.mjs`: "the control lane socket sits
    beside the profile socket".
- Machine safety:
  - No keychain, Security framework, `security` tool or `hdiutil` was used.
  - After the runs, `pgrep` found no `ade-daemon`, `ade-runtime` or
    `security` process from this worktree.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 10 | 30 | 0 |

## References

- `docs/proposed-architecture.md` section 4: reserved control capacity and
  the authenticated emergency control path.
- `crates/ade-daemon/src/bin/daemon/server/paired.rs`: the second-socket
  pattern (studied).
- No external code was copied.

## Open

- **Coordinator:** in `.scratch/ade-v1/evidence/e2e-fixme-inventory.md`,
  the `reliability-a/overload.spec.ts` backlog row is now resolved. This
  slice did not edit another slice's evidence.
- **Coordinator:** R004 can move to Accepted in `requirements.md` if a
  serial `ADE_E2E_SYSTEM=1` run of the full-volume test is accepted as
  still current.
- **Possible follow-up:** `docs/troubleshooting.md` could name the
  `*.control.sock` file beside the profile socket.
