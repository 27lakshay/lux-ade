# Audit fix: sessions-agents

Status: returned
Type: audit fix evidence
Branch: claude/wf_bb3781ba-3ed-1
Worker: ADE parallel build, audit-fix worker "sessions-agents"
Requirements: F035 (steer), F040 (compaction), F026 (account switch), F042 (history import), D04

## Outcome

Five confirmed defects in the daemon's Agent and control paths are fixed. A
provider refusal of a steer or compaction now settles as refused. Agent leases
are taken, and provider stops run, outside the global Sessions lock. A failed
Agent whose stop is unconfirmed keeps its worktree lease. `agent.disconnect`
no longer makes an imported conversation sendable.

## Defects

### 1. A refused steer or compaction never settled

- **Fix.** `definite_refusal` in `crates/ade-daemon/src/sessions/controls.rs`
  treats an error as proof only when it carries the runtime's error-receipt
  marker (`runtime::Rejected`) and a typed provider reply: `rejected`,
  `authentication`, `rate_limit`, `usage_limit` or `session_unavailable`.
  Those settle the control receipt with the new `ControlOutcome::Refused` and
  the provider's message, so a retry reads the stored reply. Transport-shaped
  categories (`disconnected`, `process_exited`, `invalid_data`, `unavailable`,
  `outcome_unknown`, `save_failed`) and untyped receipts keep the
  "not confirmed" reply and the Dispatched receipt.
- **Contract.** `ControlOutcome` gains `refused`. I ran `pnpm contract:generate`.
  The change is additive, and no client code matches on the enum.
- **Tests.** `a_provider_refusal_settles_as_refused_and_a_retry_reads_it` and
  `an_uncertain_control_failure_is_never_settled_as_refused` (controls.rs).

### 2. Every prompt send ran two git subprocesses under the Sessions lock

- **Fix.** `send()` and `resume()` in `crates/ade-daemon/src/sessions/agents.rs`
  take the Agent lease before the data lock, and only when no Agent is
  connected. Under the lock they check again. If the Agent disconnected in
  between, the loop takes a lease and admits again.
- **Test.** None. The fix is lock ordering, with no decision to extract.

### 3. `fail_if` released the lease without a confirmed stop

- **Fix.** `fail_if` calls `stop_confirmed()`. `failed_agent` (a pure function)
  decides the outcome. Only a confirmed stop, or an Agent with no provider,
  releases the lease and records `error`. Any stop error, including a refused
  socket after the runtime exits, has two effects:
  - The lease moves into `d.unresolved` as a `LeaseKey::Agent` claim for the
    run.
  - The Conversation is marked `interrupted` with its queue paused.

  `reconcile_unresolved` settles the claim only when the runtime reports the
  run absent.
- **Tests.** `an_unconfirmed_stop_keeps_the_lease_and_marks_the_attempt_interrupted`
  and `only_a_confirmed_stop_releases_the_lease` (agents.rs).

### 4. Provider shutdown ran while holding the Sessions lock

- **Fix.** `Agent` gains a `stopping` flag. `begin_stop` sets it under the lock.
  The stop runs after the lock is released: `finish_stop` for disconnect and the
  account switch, and inline in `fail_if`. The lock is then taken again to
  commit. A failed disconnect or switch stop clears the flag and leaves the
  Agent attached, as before.
- **What refuses a stopping Agent.** Sends, resumes, controls, a second stop
  and `fail_if`.
- **Account switch.** The switch decides once before the stop and again after
  it. If it fails after the stop, it records the Conversation as
  `disconnected`.
- **Message change.** `ensure_lease_resolved` no longer says "after a daemon
  restart", because live failures now create unresolved claims too.
- **Test.** None. The fix is lock ordering. The switch's pure decision is
  unchanged.

### 5. `agent.disconnect` made an imported conversation sendable

- **Fix.** `disconnect_refusal` (conversations.rs) refuses an `imported`
  Conversation before the terminal and busy checks.
- **Tests.** `an_imported_conversation_is_never_disconnected_into_a_sendable_one`
  and `disconnect_keeps_its_terminal_and_active_turn_refusals` (conversations.rs).

## Operation tiers

- `conversation.steer` and `conversation.compact`: effect commands, unchanged
  tier. They gain the `refused` outcome.
- `agent.disconnect`, `agent.send`, `agent.resume`: unchanged tiers.
- `account.switch`: effect command, unchanged tier.

## Checks

- `pnpm check:static`: pass. All 691 legacy Rust tests pass; 5 are skipped.
- In-process tests added:
  - `crates/ade-daemon/src/sessions/controls.rs`
  - `crates/ade-daemon/src/sessions/agents.rs`
  - `crates/ade-daemon/src/sessions/conversations.rs`

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 10 | 10 | 0 |

## References

None.

## Open

- `events()` still calls `rpc.reject` under the Sessions lock for unsupported
  or mismatched provider requests. It is a runtime round trip, and it was
  outside this list.
- `attach_agent` still ignores a failed `rpc.stop()` after `pre_open` fails. If
  `fail_if` removed an Agent with no provider while `rpc.create()` was running,
  the lease is released before that run is stopped.
- `ensure_not_imported` still reads the mutable status string rather than the
  `history_imports` row. Disconnect was the only path found that changed that
  status.
- A `fail_if` that arrives while a disconnect or switch stop is in flight is
  skipped. If that stop then fails, the Agent stays attached with no event
  thread, as it would have before this change.
