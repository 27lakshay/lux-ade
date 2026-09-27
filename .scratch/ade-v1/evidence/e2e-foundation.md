# E2E foundation: headless protocol E2E

Status: returned
Type: slice evidence
Branch: claude/wf_7abfdbf1-8ad-1
Worker: parallel build, E2E foundation worker
Requirements: none (foundation work for the test policy in AGENTS.md)

## Outcome

`e2e/protocol/` now has a fixture library. Each test gets a real `ade-daemon`
and `ade-runtime` on unique temp paths with a scratch `HOME`. The library also
provides scratch Git repositories, an SDK handle with contract-validated replies,
a CLI runner, the deterministic Codex and Claude mocks, and fault helpers.
Teardown fails the test when any process it owns is still running.
`pnpm test:e2e:protocol` builds the backend, SDK and CLI, then runs the suite in
parallel. `test:e2e:protocol:only` runs it without building. The proof spec
`e2e/protocol/boot.spec.ts` passes: 7 tests, and 42 of 42 under
`--repeat-each 6` with 8 workers.

Isolation fixes from research 03:

- `desktop-smoke.spec.ts` sets `ADE_PROFILES_HOME` inside its temp user-data
  directory.
- All four Playwright configs delete the inherited `ADE_SOCKET`,
  `ADE_PROFILES_HOME`, `ADE_RUNTIME_HOME`, `ADE_DATA_DIR`, `ADE_ROOT` and
  `ADE_DAEMON_BIN`.
- The package config now also deletes `NO_COLOR`, as the others already did.

## Operation tiers

None added or changed.

## Checks

- `pnpm test:e2e:protocol`: pass, 7 of 7 (3.1 s of test time after the builds).
- `pnpm test:e2e:protocol:only --repeat-each 6` with `ADE_E2E_WORKERS=8`: pass, 42 of 42.
- `pnpm check:static`: pass. `pnpm typecheck` now also runs `tsc -p e2e/protocol/tsconfig.json`.
- Negative checks, run from temporary specs and then deleted:
  - A process registered in the ledger and left running fails the test in teardown, and the harness kills it.
  - A daemon that fails at startup leaves no runtime behind.
  - The ledger sweep finds the provider mocks and shells the runtime starts.
- `pgrep` after the runs: no `ade-daemon` or `ade-runtime` from this worktree is running.
- In-process tests added: none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 11 | 1 | 4 | 0 |

## References

- Research: `.scratch/parallel-build/research/03-e2e-isolation.md`, rows 1, 6 and 14.
- Pattern: `e2e/fixtures/daemon.ts`. The fixtures reuse its `rpc`. Its identity checks before `runtime.stop` are the model for the shutdown code.
- Pattern: `e2e/specs/provider-daemon-handoff.spec.ts` and `conversation-answer-cli.spec.ts`, for mock provider wiring and answer shapes.
- No external reference repositories were used.

## Behaviour observed while building (for spec writers)

- After `killRuntime`, the daemon keeps running and keeps reporting the dead
  runtime in `hello`. `runtime.prepare_restart` then fails with "Runtime control
  connection failed". `restartDaemon()` falls back to SIGKILL and starts a
  daemon that launches a new runtime.
- After a daemon SIGKILL, the runtime survives, and the next daemon adopts it
  (same `runtime_instance`).
- A killed runtime stays a zombie of the daemon until the daemon exits.
  `isRunning(pid)` treats zombies as exited; `process.kill(pid, 0)` does not.
- The daemon rejects an `ADE_RUNTIME_HOME` whose last component is not
  `runtime`. The fixtures leave it unset.
- `agent.cancel` leaves a conversation `interrupted`, not `idle`.

## Open

- Shared files touched: none of the coordinator-only files. This slice changes
  root `package.json`:
  - It adds the `test:e2e:protocol` and `test:e2e:protocol:only` scripts.
  - It adds the `@types/node` 24.6.0 root dev dependency, the version the
    packages already use, and updates the lockfile to match.
  - It extends the `typecheck` script.
- AGENTS.md already names `e2e/protocol/` and `pnpm test:e2e:protocol`. It could
  link `e2e/protocol/README.md`. That edit belongs to the coordinator.
- Load across concurrent worktrees is unmeasured (research 03, row 14). The
  default worker count is half the CPUs. Lower it with `ADE_E2E_WORKERS` when
  several worktrees run suites at once.
