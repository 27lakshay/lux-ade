# Phase 2: runtime replay

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-6
Worker: Phase 2 workflow, slice runtime-replay
Requirements: R004 (partial), R008 (partial)

## Outcome

Agent replay overflow in `crates/ade-runtime/src/agent_runtime.rs` no longer
substitutes an `Exited` event. Overflow now records one output-failure marker
(`OperationFailed` with no submission) in reserved space, sets the run's
`output_failure` state, and discards later ordinary output. The runtime then
attempts a confirmed stop off the drain thread. `Exited` is journaled only when
an exit is observed or `stop_confirmed` succeeds, and it always fits, even in a
full or degraded journal.

Receipt admission now reserves capacity for control commands. `cancel` and
`reject` may use 256 extra receipts and 1 MiB extra bytes beyond the ordinary
4096 receipts and 32 MiB. Saturated ordinary receipts no longer block
cancellation, and a control command's result is stored in the same reserve.

The decisions live in pure functions in `crates/ade-runtime/src/agent_budget.rs`:
`journal`, `classify`, `admit_receipt` and `store_result`.

## Operation tiers

No operation was added. `agent.events` gains an additive `output_failure` field
(string or null) on the internal runtime socket. `Remote::events` ignores it.
The daemon needs no edit: it already treats `OperationFailed` with no submission
as a run failure, which fails the Conversation and requests `agent.stop`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-runtime/src/agent_budget.rs` (4 tests).
  The legacy test `overflow_preserves_earlier_events_and_reports_failure` in
  `agent_runtime.rs` asserted the old false-exit behavior; it now asserts the
  degraded state, no exit on unconfirmed stop, and an observed exit afterwards.

Verified only statically and in-process: the journal and receipt deciders, and
the journal state transitions against a fake provider.

Needs E2E later:
- R008: exhaust the runtime spool with a real provider while the daemon is
  away; the Conversation shows the output failure, not a process exit.
- R004: saturate ordinary receipts on a live run; cancel still reaches the
  provider.
- The overflow-triggered `stop_confirmed` against real providers, including
  the case where the stop cannot be confirmed.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 5 | 0 |

## References

- `docs/proposed-architecture.md` sections 4, 6 and 11 (audit findings).
- `.scratch/parallel-build/research/08-reference-map.md` has no row for Agent
  replay overflow or receipt reserves. t3code `apps/server/src/orchestration/LiveStreamBudget.ts`
  is listed for byte budgets (R009); not consulted. No code copied.

## Open

- `rpc.rs` sends `Exited` after an unconfirmed `stop()` when the provider
  connection closes (audit finding 3, another slice). That path can still
  report an exit whose shutdown was not confirmed.
- The daemon's `fail` removes the Agent from memory even when `agent.stop`
  fails; ownership reconciliation belongs to the sessions slice.
- `AgentRun` (from `describe`) does not expose `output_failure`. Add it to
  `contract/agents.rs` if a client must list degraded runs.
