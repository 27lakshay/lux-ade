# e2e-profiles

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-5
Worker: E2E round 3, profiles-continuity worker
Requirements: F010 (full register acceptance passes headlessly; the CLI, terminal attachments and SDK feed are the views that close); F005 and F007 (advanced, not accepted: the desktop connection and the Electron partition storage need Electron)

## Outcome

Headless E2E specs in `e2e/protocol/profiles/` prove independent managed
profiles and background continuity against real daemons and runtimes. The CLI
cold-starts each profile through `ade-control` under a scratch
`ADE_PROFILES_HOME`. 12 specs pass, with none marked `test.fixme`. They also
passed 24 of 24 under `--repeat-each 2` with 2 workers. The specs exposed no
product bugs, so no product code changed.

A new generic fixture, `e2e/protocol/fixtures/managed-profiles.ts`, provides
the `host` fixture (`ProfileHost`, `ManagedProfile`). It registers profiles
with `ade-control profiles create` and runs the CLI with `--profile ID`. It
owns the detached daemons, runtimes and their children in the harness ledger.
Its teardown stops them before the harness checks for survivors, in the same
way as `remote-hosts.ts`. `asScratch()` lends a managed profile to the
existing helpers that use only `call`, `socket`, `root`, `env`,
`logsDirectory` and `defaultWorkspaceRoot`: conversation, terminal, feed,
plugin, raw-reply and the resources steps.

## Acceptance criteria and specs

F005 "Start backend without Electron; connect from desktop and CLI; close clients without stopping admitted work" (`headless.spec.ts`, `continuity.spec.ts`):

| Criterion | Spec | Result |
|---|---|---|
| Start the backend without Electron: `ade --profile ID` cold-starts the daemon and runtime through ade-control. Nothing runs before first use. The daemon is its own session with ppid 1, detached from the CLI. The runtime serves the profile's own data directory. | the CLI cold-starts a registered profile through ade-control, detached, and later clients attach to it | pass |
| Connect from the CLI and SDK: later CLI runs, the SDK `call()`, the raw protocol and the SDK `AdeClient` feed all attach to the same daemon (same pid and boot_id) | same spec, plus the feed subscriber in `continuity.spec.ts` | pass |
| Duplicate starts: 4 concurrent first commands start exactly one daemon and one runtime | concurrent first commands on one profile start exactly one daemon | pass |
| Refusals: an unknown ID, a malformed ID, `--profile` with `--socket`, and a missing controller are each refused with a typed code, and nothing starts | an unknown, malformed or conflicting profile selection is refused without starting anything | pass |
| Crash: after a daemon SIGKILL, the next command starts a replacement that adopts the live runtime (same `runtime_instance`). After the daemon and runtime are both killed, a fresh backend starts on the same data. | after a daemon crash the next command starts a replacement … | pass |
| Stop and cold start again on the same data, with nothing left running | a stopped profile leaves nothing running, and the next command starts it again on the same data | pass |
| Close clients without stopping admitted work | the four `continuity.spec.ts` specs | pass |
| Connect from the desktop | none | not covered: needs Electron, which is out of scope for protocol E2E |

F007 "Create two profiles; verify isolated records, plugins and browser data after restart while shared-resource conflicts remain visible" (`isolation.spec.ts`):

| Criterion | Spec | Result |
|---|---|---|
| Separate processes, endpoints and state: daemon and runtime PIDs, runtime instances, daemon and runtime sockets, and data directories under `<profiles home>/profiles/<id>/runtime/data` | two profiles keep separate processes, data, records, accounts, plugins and browser data, across a restart | pass |
| Isolated records: workspace, conversation and finished turn. Each provider ran only in its own profile. The other profile's conversation is not found, and the CLI lists only the profile's own workspaces. | same spec | pass |
| Isolated accounts: each native home is under its profile's data directory, and neither profile lists the other's account | same spec | pass |
| Isolated plugins: each profile installed the same plugin ID with its own plugin record, and neither profile sees the other's record | same spec | pass |
| Isolated browser data: named partitions, and a Chrome bookmark import from a scratch import home. The other profile's import is not found, and its `profile_id` is refused as unavailable. | same spec | pass |
| After a restart: A crashes (daemon and runtime) while B is untouched, and B is stopped. Both cold-start from the CLI with new runtime instances, and all of the above holds again. | same spec | pass |
| Starting one profile neither starts nor selects the other | starting one profile from the CLI neither starts nor selects the other | pass |
| Shared-resource conflicts stay visible. One profile's shell holds a checkout. The other profile sees the claim (owner = the first profile's UUID, `mine: false`), and its removal is refused with `host_resource_conflict`. After the remover restarts, it still sees the same claim and is still refused. The checkout and the shell survive. | a checkout one profile works in stays a visible conflict for the other profile | pass |
| Electron partition storage (cookies and site storage) per profile | none | not covered: that data lives in Electron's session storage |

F010 "Close all views during terminal/provider activity; reopen and recover state without replaying the command" (`continuity.spec.ts`, each run twice: once with all clients closed, and once with a daemon crash while detached):

| Criterion | Spec | Result |
|---|---|---|
| Terminal: the CLI sends a held command and exits, and a terminal attachment and a feed subscriber close. The command finishes with no client attached, which the file system shows. On reattach, the CLI inspect and a new attachment show the same run ID with the output exactly once. The command's start is logged once, not replayed. | a terminal command keeps running with no client and is observed once on reattach (both modes) | pass |
| Provider: the CLI sends a turn with a held tool and exits, and a feed subscriber closes. The tool and turn complete with no client attached, which the mock's saved thread shows. On reattach, the turn is settled with its result once and one `turn/start`. A retried send with the same request ID does not start another turn. The same provider process takes the next turn. | a provider turn keeps running with no client and settles once on reattach (both modes) | pass |
| Close desktop windows and views specifically | none | not covered: needs Electron. The headless clients (CLI, terminal attachment, SDK feed) stand in for views. |

## Product fixes

None. No spec exposed a product bug in this area.

## Operation tiers

None added or changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/profiles`: pass, 12 of 12. It also passed 24 of 24 with `--repeat-each 2`.
- `pnpm check:static`: pass.
- `pgrep` after the runs: no `ade-daemon` or `ade-runtime` from this worktree is running.
- In-process tests added: none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 3 | 8 | 0 |

## References

- Pattern: `e2e/protocol/fixtures/remote-hosts.ts`, for a `test.extend` fixture that stops detached `ade-control` daemons before the harness survivor check.
- Pattern: `e2e/protocol/recovery/daemon-restart.spec.ts`, for counting `turn/start` and the held-tool release.
- Reused: `e2e/protocol/resources/steps.ts` (adopt, launchShell, claimsOn, removeTree).
- No external reference repositories were used.

## Open

- F005 stays partial until an Electron E2E connects the desktop to a
  CLI-started backend. F007 stays partial until an Electron E2E shows that
  per-profile partition storage (cookies and site storage) survives a restart.
  All of F007's daemon-side parts pass.
- F010 is claimed on headless clients. If the coordinator reads "views" as
  desktop windows only, an Electron spec that closes every window during the
  same work would complete it.
- Shared files touched: none.
