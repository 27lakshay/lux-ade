# session-lease

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-8
Worker: Phase 2 parallel build, slice session-lease
Requirements: R005 (retain independent work across daemon restarts), R006 (see actual process uncertainty); architecture §11 audit item "daemon-owned session leases require ownership reconciliation before new admission after restart"

## Outcome

Daemon startup now resolves every persisted session lease (script runs, service
reservations, Agent runs, and runtime Agents with no durable Conversation) against
the runtime's terminal and Agent catalogues through one pure decider,
`sessions::leases::decide`. Each lease resolves to live, released or uncertain.
An uncertain lease keeps its worktree lease and refuses conflicting admission
(`agent.send`, `agent.resume`, queued dispatch, `service.start`, `script.start` in
the same workspace). The 250 ms monitor re-observes the runtime and settles it
once there is proof. `service.stop` and `script.retire` also settle it.

Behaviour changes at startup:

- A runtime Agent that does not match its Conversation, and a runtime Agent with
  no Conversation, no longer abort daemon startup. They become uncertain. The
  Conversation is marked interrupted with its queue paused, and it cannot start
  another run until the runtime run is gone.
- A script run whose runtime terminal has another root, no transfer identity or
  an unknown exit status no longer aborts startup. It becomes uncertain and keeps
  the worktree lease.
- A service lease from another runtime incarnation, or with a changed terminal
  incarnation, is recorded as uncertain. Its durable reservation and worktree
  lease behave as before.

The daemon-restart handoff is unchanged: a matching live runtime Agent is attached
as before, with the same prompt, cancel and answer reconciliation.

## Operation tiers

No operations were added or changed on the wire. Existing effect commands gained
an extra refusal while a lease is unresolved.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/sessions/leases.rs` (8 decider tests)

Verified only statically: the restore wiring in `crates/ade-daemon/src/sessions.rs`,
the admission gates, and the monitor settlement in `reconcile_unresolved`.

Needs E2E later:

- A daemon restart with a surviving runtime Agent still attaches and continues.
- A runtime Agent whose run differs from its Conversation: startup succeeds,
  `agent.resume` and `agent.send` refuse, and resume works after the run stops.
- A service reserved by a replaced runtime stays refused until `service.stop`.
- A script run with an unknown exit status blocks `script.start` in that
  workspace until `script.stop` or `script.retire`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 10 | 0 |

## References

- Orca @ b7a4fee7, `src/shared/pty-liveness-verdict.ts`: studied, pattern (exit needs positive evidence of absence; unverifiable is never a stop) → `crates/ade-daemon/src/sessions/leases.rs`. No code copied.

## Open

- Conversation terminal handoffs (`terminal_owner`) still go through
  `clear_view_terminal` at startup. A failure there still aborts startup, and an
  owner from another runtime incarnation is cleared without proof of exit. That
  is unchanged existing behaviour and is left for a follow-up slice.
- Workspace shell terminal leases in `bin/daemon/server.rs` (`refresh_leases`)
  are not durable session leases and are unchanged.
- An uncertain lease whose workspace root no longer exists holds no worktree
  lease; admission is still refused by key.
- Unresolved leases are reported through error text and the daemon log only; no
  query exposes them yet.
- No migration and no shared-file change is needed.
