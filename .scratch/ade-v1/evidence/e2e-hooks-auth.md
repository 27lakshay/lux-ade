# e2e-hooks-auth

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-6
Worker: ADE parallel build, E2E round 2, hooks-terminal-auth slice
Requirements: F067 (05-workspaces), F083 (07-terminals-services)

## Outcome

Setup and teardown hooks now stream their status. While a hook runs,
`worktree.operation` returns `running_hook`: its name, phase, tree, position,
the hooks already finished and its latest output, bounded to 16 KiB. The
daemon and runtime sockets now check the peer's user ID on every accepted
connection. A peer that is not the profile's user gets one `unauthenticated`
refusal, and its request is never interpreted. Six headless specs in
`e2e/protocol/hooks-auth/` prove both. F067 and F083 now pass their full
register acceptance.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F067 | Hooks run with the correct host and workspace context | `worktrees/lifecycle.spec.ts` › setup hooks run in the tree with its context… (round 1) | pass |
| F067 | Stream status: a query shows the running hook with bounded output | `hooks.spec.ts` › a running setup hook streams its name, position, finished hooks and bounded latest output… (SDK and CLI `worktree operation`) | pass |
| F067 | Teardown hooks stream too | `hooks.spec.ts` › a teardown hook streams while it runs… | pass |
| F067 | Duplicate request while a hook runs replays and does not rerun hooks; a competing operation is refused | `hooks.spec.ts` › a running setup hook streams… | pass |
| F067 | Failure exposed; no running status after the hook ends; safe recovery before destructive cleanup | `hooks.spec.ts` › a teardown hook streams…; `worktrees/lifecycle.spec.ts` › setup hooks…, › a failed teardown… | pass |
| F067 | Daemon crash during a streaming hook: no stale status, the operation reads `interrupted`, cleanup refuses the tree | `hooks.spec.ts` › a daemon crash during a streaming hook… | pass |
| F083 | Both sockets are owner-only files of the profile user | `auth.spec.ts` › both profile sockets are owner-only files… | pass |
| F083 | The daemon refuses a foreign peer: raw `hello`, CLI `terminal create/list/send/resize/stop`, SDK `terminal.create/stop`, terminal stream subscribe (no snapshot) | `auth.spec.ts` › the daemon refuses a peer that is not the profile user… | pass |
| F083 | Refused commands change nothing: no receipt, same terminal list, same shell PID and `run_id`, no foreign input, old size | same | pass |
| F083 | A daemon restarted after SIGKILL authenticates the same way | same | pass |
| F083 | The runtime refuses a foreign peer for `hello`, `owner.claim`, `terminal.connect` and `runtime.stop` | `auth.spec.ts` › the runtime refuses a foreign peer outright… | pass |
| F083 | A same-user peer without the owner token cannot claim the runtime, attach a terminal or stop it; the daemon still drives the terminal | same | pass |
| F083 | Create, inspect, write, resize, stop; target, incarnation and viewport ownership | `terminals/*.spec.ts` (round 1) | pass |

No spec in this area is marked `test.fixme`. The round-1 fixme in
`worktrees/lifecycle.spec.ts` is replaced by a pointer to `hooks.spec.ts`.

## How a foreign peer is simulated

A test machine has no second account. In debug builds only, the daemon reads
the user ID it admits from the file named by `ADE_E2E_DAEMON_PEER_UID_FILE`.
The runtime reads its own from `ADE_E2E_RUNTIME_PEER_UID_FILE`. A spec writes
another user ID there, which makes the test process a foreign peer. Release
builds ignore both variables.

## Product fixes

1. **F067: hook status streams.** Before, hooks reported only on completion.
   - `crates/ade-daemon/src/worktrees/hooks.rs`: new `LiveHooks`, an
     in-memory record per operation. `run_hooks` publishes each hook before it
     starts, and `capture` taps each output chunk into a bounded tail.
   - `crates/ade-daemon/src/worktrees.rs`: `capture` takes an optional tap.
     `worktree.operation` adds `running_hook` while the operation is `running`.
   - The status lives in memory only. A restarted daemon reports the
     operation `interrupted` without progress.
2. **F083: peer authentication on both sockets.** Before, each socket relied
   on its 0600 file mode alone, and nothing checked who connected. The mode
   is also set after `bind`, which leaves a short window.
   - `crates/ade-runtime/src/runtime.rs`: new `peer_uid` (`getpeereid`, or
     `SO_PEERCRED` on Linux), `peer_authorized`, `authenticate_peer` and
     `refuse_peer`.
   - `refuse_peer` writes one refusal line and shuts down writing. It then
     discards the peer's input, unread, for at most one second and 128 KiB.
     Without this the client saw `EPIPE` instead of the refusal.
   - Wired into the accept loops in `crates/ade-daemon/src/bin/daemon/server.rs`
     and `crates/ade-runtime/src/bin/supervisor/server.rs`.
   - Runtime owner-token fencing was already in place and is unchanged.

## Operation tiers

`worktree.operation` stays a query. Its reply gains an optional
`running_hook` (`WorktreeHookProgress`). `packages/contracts` was regenerated.
No operation was added.

## Fixture added

`e2e/protocol/fixtures/sockets.ts` (new file, not exported from `index.ts`):

- `socketReply(path, request)`: one request on any Unix socket. It returns
  the first reply line, or `closed` when the peer closed without replying.
- `socketAccess(path)`: a socket file's mode and owner.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/hooks-auth`:
  6 passed.
- Regression run of `hooks-auth`, `worktrees` and `terminals`: 36 passed.
- Regression run of `hooks-auth`, `boot.spec.ts` and `recovery`: 25 passed.
- `pnpm check:static`: pass (734 Rust tests, 5 skipped).
- In-process tests added:
  - `crates/ade-daemon/src/worktrees/hooks.rs` (`live_output_keeps_only_a_bounded_tail`)
  - `crates/ade-runtime/src/runtime.rs` (`only_the_profile_user_is_authorized`)
  - `crates/ade-core/src/contract/worktrees.rs` (`replies_round_trip`: a reply with `running_hook`)
- No `ade-daemon` or `ade-runtime` from this worktree was left running (`pgrep`).

## Requirements whose full register acceptance now passes

- F067
- F083. Its round-1 caveat, that there was no proof for another local user,
  is closed.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 40 | 5 | 15 | 0 |

## References

None.

## Open

- Hook status is a polled query. No session frame pushes it. The spec allows
  "a frame or query".
- 07-S10 (stop under saturated receipts and streams) is still not covered.
- The socket mode is still set after `bind`. The peer check makes that window
  harmless, so no umask change was made.
