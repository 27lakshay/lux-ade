# agent-descendants

Status: returned
Type: slice evidence
Branch: claude/wf_29c70e79-8bf-2
Worker: workflow wf_29c70e79, worker 2 (agent-descendants)
Requirements: R006 (escaped Agent provider descendants across a runtime kill)

## Outcome

The runtime now tracks each Agent provider's process tree while it runs and
reports what it tracks in the `agent.list` reply. The daemon adopts that report
into its tree tracker and records it with the attempt, as it already does for
terminals. So a provider descendant that escapes between two of the daemon's
own 2-second observations stays tied to its Agent attempt.

Changes:
- **Contract** (`crates/ade-core/src/contract/agents.rs`): `AgentRun` has an
  optional `descendants: [{pid, started}]` (new type `TrackedDescendant`).
  An older runtime omits it. `pnpm contract:generate` was run.
- **Runtime** (`crates/ade-runtime/src/rpc.rs`): every provider transport
  (Codex, Claude, OpenCode, omp, provider workers, ACP adapters) observes its
  tree at spawn and every 200 ms. It never waits for the tree lock, which a
  stop holds. It stops once the transport closes or the leader is reaped, so a
  reused group ID is never read. `Provider::descendants()` exposes the list, and
  `Run::describe` adds it to the `agent.list` reply.
- **Daemon** (`crates/ade-daemon/src/sessions/restart.rs`): `record_attempts`
  passes each run's reported descendants to `Tracker::adopt`, which keeps them
  only while the same identity runs. The snapshot then records them in
  `runtime_attempt_descendants`. Restart reconciliation, rechecks and release
  already read that table for every attempt key.

## Specs

| Criterion | Spec | Result |
|---|---|---|
| R006: a provider descendant spawns, leaves the group and is orphaned to launchd just before a runtime kill. The provider exits with the runtime. The Agent attempt stays quarantined with the descendant's PID. It refuses release, `agent.resume` and a new prompt, including after another daemon start. It settles once the descendant exits. The Conversation then resumes without replaying the held prompt. | `recovery2/agent-descendants.spec.ts` › "an escaped provider descendant that survives a runtime kill keeps its agent attempt quarantined until it exits" (new) | pass (x5) |

The fixture provider is `e2e/protocol/fixtures/codex_escaping.sh`. It runs the
Codex mock with a watcher (`escape_watcher.py`) in its process group. When the
spec creates `escape-now` in the mock directory, the watcher becomes
`escapee.py` with a 0.5-second linger. The escapee leaves the group, and its
intermediate parent exits half a second later. `escaped.pid` is written only
once the escapee is orphaned. The spec waits for the daemon's record of that
PID, not for a fixed time, and then kills the runtime.

Negative control: the daemon's adoption was disabled temporarily and the spec
was run 4 times. All 4 failed at "the daemon to record <pid> under agent:…".
The daemon's own observation missed the escapee every time. The change was
restored before the checks below.

## Operation tiers

No operation was added. `agent.list` stays a query on the runtime socket. Its
reply gains an optional field.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `pnpm check:static`: pass (810 Rust tests).
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only recovery recovery2 restarts conversations adapters providers load/fault-classes.spec.ts`:
  117 passed, 2 skipped. The two skips are pre-existing conditional skips.
- `recovery2` with `--repeat-each 4`: 4 passed.
- In-process tests: `contract::agents::tests::runtime_operations_round_trip` now
  covers a run with and without `descendants`.
- Machine safety:
  - No spec, fixture or product change calls the Security framework, the
    `security` tool or `hdiutil`.
  - The runtime's tree observation uses `proc_listpids` and `proc_pidinfo` only.
  - `pgrep` found no `ade-daemon`, `ade-runtime`, `security` or escapee process
    from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 20 | 0 |

## References

- Orca `src/main/pty-descendant-exit-verification.ts` (MIT): identity-checked
  tracking. Already cited in `crates/ade-runtime/src/descendants.rs`. Not
  consulted again, and no code was copied.

## Open

- The custom-executable adapter (`crates/ade-runtime/src/adapters/executable.rs`)
  runs one process per turn and reports no `pid`. The daemon records no attempt
  for it, so it reports no descendants either. This slice did not change that.
- The macOS limit named in `descendants.rs` remains. A descendant that forks,
  leaves its group and loses its parent within one 200 ms runtime observation
  is never seen.
- Coordinator: `requirements.md` already lists R006 as accepted. The
  "Provider (Agent) descendants" item in `e2e-descendants-codex.md` › Open is
  closed by this slice. No shared file was edited.
