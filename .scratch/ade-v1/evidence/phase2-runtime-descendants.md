# runtime-descendants

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-7
Worker: Phase 2 parallel build, slice runtime-descendants
Requirements: R006 (advanced, not accepted)

## Outcome

Direct-child exit is no longer treated as proof of shutdown. The new
`crates/ade-runtime/src/descendants.rs` tracks every process observed in an
owned tree by identity (PID plus start time), signals it with bounded
escalation (`SIGTERM`, then `SIGKILL` after 2 s, verdict at 5 s), and returns
`exited`, `live` or `unverifiable`. Only `exited` releases ownership.
`Rpc::stop_confirmed` now fails with a typed `descendants::Unconfirmed` error
when the tree is not proven stopped, and the provider `Exited` event text says
so. Terminal-owned programs (launches with a transfer ID) in
`bin/supervisor/terminal_host.rs` track their tree every second, observe it
before `stop()` signals, and add a `descendants` verdict to `exit_status`.

Design choices:

- The direct child is reaped only after the tree verdict, so its PID (the
  group ID) stays reserved while the group is signalled. After reaping, only
  processes whose identity matched in the same read are signalled.
- A child that started before its parent, a parent PID that now has a
  different start time, and duplicate PID rows are never adopted or signalled.
- An unreadable process table, or a tree that could not be observed before
  the first signal, is `unverifiable`, never `exited`.
- macOS reads use libproc (`proc_listpids` by group and by parent,
  `proc_pidinfo` `PROC_PIDTBSDINFO`). Linux reads `/proc/<pid>/stat`. Other
  platforms are always `unverifiable`.

## Operation tiers

None added or changed. `agent.stop` keeps its wire shape; it now returns an
error in more cases (tree not proven stopped), which callers already treat as
"ownership remains reserved".

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-runtime/src/descendants.rs` (14 tests of
  the pure tracker, verdict, signal-target and escalation functions, plus the
  Linux stat parser)
- Manual, not committed: two temporary real-process tests through
  `Rpc::stop_confirmed` on macOS. A `setsid` descendant that ignores `SIGTERM`
  and a group member that ignores `SIGTERM` were both killed after the 2 s
  grace, and the stop returned success only then. The previous code would
  have reported success with the escaped descendant still running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

- Orca @ b7a4fee7, `src/shared/pty-liveness-verdict.ts`, pattern → `crates/ade-runtime/src/descendants.rs` (verdict vocabulary: exited needs positive evidence; unreadable is unverifiable)
- Orca @ b7a4fee7, `src/main/pty-descendant-exit-verification.ts`, pattern → same file (identity match on PID + start time, duplicate-PID rows are ambiguous, slow reads keep waiting until the deadline)
- Orca @ b7a4fee7, `config/docker/daemon-shutdown-descendants/README.md`, studied (fixture shape: setsid child ignoring SIGTERM; its stated limit on already-reparented processes)

No code was copied, so no `THIRD-PARTY-NOTICES.md` entry is needed.

## Open

- Verified statically and by pure tests only: the terminal-host path
  (`terminal_host.rs`), the Linux `/proc` reader, and the `live` and
  `unverifiable` verdicts against real processes.
- E2E later (R006): ignored signals, reparented and escaped fixture
  descendants and stale process identity, through a running runtime; confirm
  clients show the `descendants` verdict and that a quarantined run keeps its
  reservation.
- Limitation: macOS has no kernel containment. A process that forks, leaves
  the group and loses its parent between two observations (20 ms while
  stopping, 1 s while a terminal runs; providers are observed only at stop) is
  never seen. `exited` means nothing observed is still running.
- Not changed: `account_probe::stop_probe` still `SIGKILL`s the group and waits
  for the direct child only; probes are short-lived identity checks.
  `runtime.rs` `gone()` checks one supervisor PID without a start time.
- Provider stop now waits up to 2 s for `SIGTERM` before `SIGKILL`, so a
  provider that ignores `SIGTERM` stops 2 s later than before.
