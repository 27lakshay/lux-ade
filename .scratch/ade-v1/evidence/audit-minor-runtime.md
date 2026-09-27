# Audit minor fixes: runtime

## Settling a service lease drops its worktree lease while the durable service reservation remains

Confirmed. At restore, an uncertain Service claim goes to `hold_unresolved`, so its
worktree lease lives in `Unresolved.lease`. Three paths later remove that entry:

- `reconcile_unresolved` (`sessions/leases.rs`) on a `Released` verdict;
- `resolve_attempt` (`sessions/restart.rs`) when a later observation settles the watch;
- `resolve_attempt` when the user releases the attempt.

Each dropped the lease. The service's `terminal_owner` reservation stays until
`service.stop`, but `d.terminal_leases` never received the lease, so worktree removal
could succeed under a reserved service. The ordinary restore arm keeps a service's
worktree lease until `service.stop`.

Fix: a pure decider `settled_lease_keeper(claim, live)` names the terminal that keeps
a settled lease's worktree lease. A service's terminal keeps it for any verdict; any
other terminal keeps it only when live; an Agent keeps none.
`Sessions::keep_settled_lease` moves `Unresolved.lease` into `d.terminal_leases` under
that terminal. Both `reconcile_unresolved` and `resolve_attempt` now use it.
`service.stop` still removes the terminal lease and then calls `settle_unresolved`,
so the release order is unchanged. No runtime call runs under the data lock.

Test: `sessions::leases::tests::a_settled_service_keeps_its_worktree_lease`.

Verification: `pnpm check:static` passed.
