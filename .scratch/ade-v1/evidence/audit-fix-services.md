# Audit fix: services

Status: returned
Type: slice evidence
Branch: claude/wf_bb3781ba-3ed-5
Worker: audit-fix workflow, services worker
Requirements: R005, R006 (runtime restart reconciliation); service start and stop

## Outcome

`service.stop` and `script.retire` no longer treat a run's absence from a
replacement runtime as proof of exit. `service.start` no longer holds the
global Sessions data lock across lsof, the host registry, the worktree lease
or the runtime launch.

## Defects

### 1 and 2. `service.stop` and `script.retire` settle a quarantined recovery attempt

Both findings describe the same flaw. The first is from `service.stop`, the
second also covers `script.retire`.

- Defect: the replacement runtime never saw the run, so `stop_service` broke out
  of its loop and released the reservation. `settle_unresolved` then marked the
  recovery attempt resolved. It never observed the recorded process tree again.
  The `script.retire` callback did the same.
- Fix: `Sessions::recovery_control_release` (restart.rs) runs before anything
  is released. When restart reconciliation watches the lease, it clones the
  watch under the lock. Outside the lock it runs `gather` and `classify` again,
  as `release_attempt` does. The pure decider `recovery::control_release` then
  applies these rules:
  - Settled: proceeds and records the observation as the resolution.
  - Quarantined: refuses with the running PIDs.
  - Unknown: refuses and points the user to `runtime.recovery.release`. That
    command stays the only way to accept an attempt without proof.
- `stop_service` runs the check before it settles the port claims.
- The `script.retire` callback in sessions.rs runs it before it retires the run.
- `settle_unresolved` and `recovery_lease_settled` now carry the resolution.
- Test: `sessions::recovery::tests::a_control_path_settles_a_watched_attempt_only_on_proof_of_exit`
  reproduces the scenario. A service tree still runs after the crash (PID 4242),
  and the stop is refused. The test also covers these cases:
  - a live old runtime refuses;
  - an unknown attempt refuses, whether no record was made, the port is held
    or the process table is unreadable;
  - a gone tree with free ports settles.

### 3. `start_service` holds the global data lock across slow calls

- Defect: `start_service` kept `self.data` locked through all of these calls:
  - `resolve_peer_targets` (terminal list and lsof);
  - the worktree lease;
  - the terminal retire;
  - the host registry port reservation;
  - `TerminalCommand::Launch`.
- Fix: the start now runs in phases.
  1. Under the lock, it validates and reads. It also enters a new
     `starting_services` fence, which refuses a concurrent start of the same
     service.
  2. Without the lock, it resolves peers, takes the lease, checks the directory
     and ports, retires the previous terminal and reserves the ports.
  3. Under the lock, `start_still_admitted` re-checks what phase 1 read: the
     service, its workspace root, and that each peer is unchanged and not
     stopping. It then commits `reserve_service`.
  4. Without the lock, it launches under the durable reservation.
  5. Under the lock, it publishes.
- `service.stop` refuses while the start fence is held. Otherwise it could
  release the reservation before the launch lands.
- The owner-present branch now runs its terminal list without the lock too.
- Test: `sessions::services::tests::a_start_reserves_only_what_it_admitted_before_releasing_the_lock`.
  It refuses in each of these cases:
  - the service was edited;
  - another run reserved the service;
  - the workspace root changed;
  - a peer is stopping, was edited or was removed.

## Operation tiers

No operation was added and no tier changed. The wire contract is unchanged.
Two new refusal messages exist:

- `service.stop` refuses while a start is in progress;
- `service.stop` and `script.retire` refuse a watched attempt that has not settled.

## Checks

- `pnpm check:static`: pass. 687 legacy Rust tests passed.
- In-process tests added:
  - `crates/ade-daemon/src/sessions/recovery.rs`
  - `crates/ade-daemon/src/sessions/services.rs`

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 10 | 0 |

## References

None.

## Open

- A service lease that is unresolved but not watched keeps its old behaviour.
  Its owner names another runtime instance, and the current runtime does not
  list it. `service.stop` still releases it. Restart reconciliation routes every
  lease of an unreconciled old incarnation to the watch, so this case arises
  only after the recovery report settled the lease or the user released it.
- The recovery check reads the process table and lsof without the lock. The
  lock is taken again only to settle.
