# E2E round 1: terminals

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-6
Worker: ADE parallel build, E2E round 1, terminals slice
Requirements: F081, F082, F083 (07-terminals-services), decision D06; 07-S11 in passing

## Outcome

Eleven headless specs in `e2e/protocol/terminals/` drive real daemon and runtime processes
through the CLI, the SDK and the raw terminal stream. They cover creation with a receipt,
incarnation fencing, viewport hand-off, `xterm-replay-v1` recovery after daemon restarts and a
runtime crash, bounded replay, detach, and a verified stop. One spec exposed a product bug:
`terminal.stop` on a shell reported an exit while a child that ignores TERM and HUP kept
running. That is fixed. F083's register acceptance now passes headlessly (see the caveat under
Open). F081 passes on the backend side only; F082 is renderer work and is not covered.

## Acceptance criteria

| Criterion | Spec | Result |
|---|---|---|
| F083 create through a public command, with a receipt | `create.spec.ts` › terminal create returns a receipt that a duplicate, a lookup and a daemon crash all resolve to one terminal | pass |
| F083 duplicate create and retry after a lost reply return the same terminal (CLI and SDK) | same | pass |
| F083 reusing an operation ID for another workspace is a conflict and creates nothing | same | pass |
| F083 receipt and terminal survive a daemon SIGKILL | same | pass |
| F083 create without an ID makes a new terminal each time; unknown receipt, missing `--request-id` and `null` ID are refused | `create.spec.ts` › terminal create without an operation ID … | pass |
| F083 input and resize fenced by incarnation: a stale or malformed `run_id` is refused, and its input never reaches the shell | `ownership.spec.ts` › input and resize naming another incarnation change nothing … | pass |
| F083 a subscribe that names another incarnation gets no snapshot | same | pass |
| F083 input and resize on an exited incarnation give `incarnation_exited`; CLI `terminal send` and `terminal resize` fail instead of reporting success | same | pass |
| F083 restart: new `run_id` and shell PID; old `run_id` is stale; a duplicate restart is refused and keeps the running shell | same | pass |
| F083 inspect, write and resize through the CLI on the current incarnation | same | pass |
| F083 runtime crash: the next daemon starts a new incarnation; the old `run_id` is fenced; the new replay does not show the lost shell's output | `ownership.spec.ts` › a runtime crash starts a new incarnation … | pass |
| F083 viewport ownership: claim, observer update does not resize the PTY (`stty size`), input moves ownership, detach hands it back with the survivor's size, a closed socket releases it | `ownership.spec.ts` › two attachments hand viewport ownership over … | pass |
| F083 stop proven only by an empty process tree (child ignores TERM and HUP) | `stop.spec.ts` › a stop settles as exited only after a child that ignores TERM and HUP is gone | pass after fix; failed before |
| F083 duplicate stop converges; retire refused while running, allowed after the stop settles | `stop.spec.ts` (both tests) | pass |
| F081 / D06 an interactive program (`cat`) and its shell survive a daemon restart; `xterm-replay-v1` replays from offset 0 with no gap, the resize in place and the mode bytes (bracketed paste); same `run_id` and shell PID (SIGKILL and graceful restart) | `recovery.spec.ts` › an interactive program keeps running and replays exactly after a kill / graceful daemon restart | pass |
| F081 detach without stopping: SDK `detach()` and CLI Ctrl-] (under a real PTY) release ownership; shell and background job keep running; history keeps the CLI's output | `recovery.spec.ts` › detach leaves the shell and its program running … | pass |
| 07-S11 replay past its 4 MiB bound reports `complete: false`, `replay_limit_exceeded`, no events, same running shell; live output resumes at `through_offset`; the earlier command is not replayed | `recovery.spec.ts` › replay past its bound reports incomplete recovery … | pass |
| F081 screen and mode restoration inside xterm.js | none | not covered: renderer, needs Electron E2E |
| F082 fit, search, links, selection/copy, keyboard/IME, Unicode, themes, renderer fallback | none | not covered: renderer, needs Electron E2E |
| D06 xterm-generated replies do not duplicate Rust Ghostty replies | none | not covered: needs a renderer |
| 07-S10 stop under saturated receipts and streams | none | not covered |

No spec is marked `test.fixme`.

## Product fix

`terminal.stop` on a shell was not proven by its process tree.

- Failing spec: `stop.spec.ts` › a stop settles as exited only after a child that ignores TERM
  and HUP is gone. Before the fix the terminal settled as `signaled` with no `descendants`
  verdict while `sleep 600` (ignoring TERM and HUP) kept running; teardown then killed it.
- Cause: `crates/ade-runtime/src/bin/supervisor/terminal_host.rs` tracked process trees only
  for launched programs (services, scripts, view terminals). A shell stop sent SIGHUP to the
  shell alone and reported the shell's own exit.
- Fix, same file: every terminal now tracks its tree. `terminal.stop` on a shell observes the
  tree, sends SIGHUP, and marks the stop. The reader then settles the exit by the tree verdict
  (TERM, then KILL, as for programs), so the status is `unknown` while verifying and names the
  `descendants` verdict. If the shell itself outlives a 2 s grace period, its tree is killed.
  A shell the user exits on their own keeps its plain status and its jobs, as before.
- Pure-core test: `terminal_host::tests::a_stopped_shell_is_settled_by_its_tree_but_an_exited_one_is_not`
  (`verifies_tree`).

## Operation tiers

No operation was added or changed. `terminal.stop` stays an effect command that acks at once;
its settlement is observed through `runtime.status` metrics (`exit_status.descendants`).

## Fixture added

`e2e/protocol/fixtures/terminals.ts` (new file; `fixtures/index.ts` is unchanged, so specs import
it directly):

- `TerminalStream`: one raw terminal attachment over the daemon socket, with frame waits and
  decoded output.
- `terminalMetrics`, `settledExit`: terminal metrics through `runtime.status`.
- `replayText`, `clientSdk`.
- `attachThroughTty`: runs `ade terminal attach` under a Python PTY relay with an 80x24 size,
  owned by the test's ledger.

## Checks

- `pnpm check:static`: pass (726 Rust tests).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/terminals e2e/protocol/boot.spec.ts`:
  18 passed, twice in a row.
- In-process tests added: `crates/ade-runtime/src/bin/supervisor/terminal_host.rs` (one test).
- No `ade-daemon` or `ade-runtime` from this worktree was left running (`pgrep`).

## Requirements whose full register acceptance now passes

- F083, headlessly: create, inspect, write, resize and stop through public commands, with
  target, incarnation and viewport ownership enforced. See the caveat under Open.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

None.

## Open

- F083 says "authenticated public commands". The specs use the profile's owner-only Unix socket;
  no spec proves a refusal for another local user.
- F081 and F082 need renderer E2E once Electron E2E resumes: xterm screen and mode restoration
  from the replay, fit, search, links, IME, themes and renderer fallback, and the D06 reply
  duplication check.
- 07-S10 (stop under saturated receipts and streams) is not covered.
- A shell stop now takes up to about 5 s to settle when a child ignores TERM (2 s grace, then
  KILL, then proof). During that window `exit_status` is `unknown` with `verifying: true`, so
  lease and service consumers do not count it as exited yet.
- The stream ops still have no typed contract (noted by the terminal-ownership slice).
