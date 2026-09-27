# descendants-codex

Status: returned
Type: slice evidence
Branch: claude/wf_58471be9-2ec-5
Worker: workflow wf_58471be9, worker 5 (descendants-codex)
Requirements: R006 (escaped script descendants across a runtime kill), F039 and F043 (Codex conversation rewind)

## Outcome

Two `test.fixme` markers from `e2e-fixme-inventory.md` are closed. Both now run
and pass.

1. **R006.** A descendant that leaves its process group stays tied to its
   script attempt after a runtime kill. Three changes close the gap:
   - The runtime reports the descendants it tracks for each terminal in the
     metrics, as `descendants: [{pid, started}]`. `Shutdown::track` now also
     forgets exited and reused identities, so the list stays bounded.
   - The daemon adds those reports to its own tree tracker at each snapshot
     (`Tracker::adopt`). The tracker keeps an identity only while a fresh read
     shows the same PID with the same start stamp. The snapshot then records
     the identities in `runtime_attempt_descendants`.
   - After a restart, reconciliation grows the tree of a recorded process that
     still runs. It adds that process's children (identity-checked; a child
     older than its parent is a reused PID) and the members of the group it
     led (`recovery::extend`). Each observation (reconciliation, recheck,
     control release, `runtime.recovery.release`) records new descendants
     durably (`Store::add_attempt_descendants`). When the shell dies, the
     escaped descendant alone keeps the attempt quarantined. A later daemon
     start still knows it.
2. **F039 for Codex.** The pinned Codex 0.157.0 protocol supports
   `thread/fork` with `lastTurnId`, and it works on legacy threads:
   - `ThreadForkParams.last_turn_id` is stable, not experimental, at tag
     `rust-v0.157.0`.
   - `thread_processor.rs` at the same tag truncates a legacy thread's rollout
     with `truncate_rollout_after_turn_id`.
   The Codex adapter now rewinds as follows. It reads the thread
   (`thread/read`, `includeTurns`) and forks through the turn before the
   rewound one. It checks that the fork holds exactly the kept turn IDs, then
   continues in the fork. The earlier thread is unchanged.
   `thread/revert` and `thread/rollback` are never called. Refusals are
   definite, so the receipt settles `refused`: rewinding before the first turn,
   an unknown turn, a turn in progress, or a fork that does not match.
   Availability reports `codex.thread_fork`. The capability record reports
   `rewind: supported`.

## Specs

| Criterion | Spec | Result |
|---|---|---|
| R006: an escaped descendant, still the shell's child at the runtime kill, keeps the script attempt quarantined after the shell exits. It refuses release, retire and a new run, including after another daemon start. It settles once the descendant exits. | `recovery/descendants.spec.ts` › "an escaped descendant that survives a runtime kill keeps its script attempt quarantined" (was `fixme`) | pass (x4) |
| R006: same, for a descendant orphaned to launchd before the runtime kill; the runtime reports it and the daemon records it first | same file › "… after it was orphaned before the kill" (new) | pass (x4) |
| R006: PID reuse. An adopted or extended identity counts only with its own start stamp. A reused parent PID adopts nothing, and an ambiguous duplicate PID is ignored. | in-process: `descendants::tests::adopted_identities_are_kept_only_while_the_same_process_runs`, `recovery::tests::a_live_recorded_process_extends_its_tree_with_escaped_children`, `recovery::tests::extension_never_adopts_through_a_reused_pid` | pass |
| F039, F043: a Codex rewind previews the history. It forks through the prior turn with `lastTurnId`, drops the later messages, refuses a stale page and removes search hits. It replays after a daemon crash and forks once. The next turn runs in the fork, and a resume reads the fork back unchanged. | `context/rewind.spec.ts` › "a Codex conversation rewind forks the thread before the turn…" (was `fixme`) | pass |
| F039: a Codex rewind before the first turn is refused and keeps the thread | `context/rewind.spec.ts` (new) | pass |
| F039 unsupported reporting, still no receipt | `conversations2/rewind-create.spec.ts` › "an unavailable Conversation rewind…" now uses a disconnected Codex Agent, since Codex rewind is supported | pass |

The old fixme bodies no longer matched the contract. The Codex body sent no
`before_message_id` or `expected_state`. The descendants body asserted before
any recheck could run. Both were rewritten to the current contract and made
stricter.

The Codex mock (`scripts/fixtures/codex_mock.py`) adds two methods:
- `thread/read` for the current thread.
- `thread/fork`, following only the documented `lastTurnId` behaviour: the
  fork keeps turns through that turn, inclusive; an unknown or in-progress
  turn is refused; the fork gets a new thread ID and emits `thread/started`
  with `forkedFromId`.

## Operation tiers

No operation was added. `conversation.rewind` stays an effect command. Terminal
metrics are passed through untyped (`metrics: Value`), so the new
`descendants` field needs no contract change.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `pnpm check:static`: pass (808 Rust tests)
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only` on these paths:
  - `recovery`, `restarts`, `context/rewind.spec.ts`, `conversations2`,
    `accounts-rewind`, `terminals`, `services` and `services2`: 120 passed,
    1 failed. The failure is the pre-existing flake below.
  - `load/fault-classes.spec.ts`, `adapters/acp.spec.ts` and
    `providers/capabilities.spec.ts`: pass.
- In-process tests added:
  - `crates/ade-runtime/src/descendants.rs`: adopt.
  - `crates/ade-daemon/src/sessions/recovery.rs`: extend, and the reuse cases.
  - `crates/ade-runtime/src/codex.rs`: `fork_boundary`, `forked_thread` and
    `refusal`.
  - `crates/ade-daemon/src/sessions/controls/availability.rs`: the Codex
    rewind decision.
- Machine safety:
  - No spec, fixture or product change calls the Security framework, the
    `security` tool or `hdiutil`.
  - `codex` was not run. The schema was read from GitHub at the
    `rust-v0.157.0` tag.
  - `pgrep` found no `ade-daemon`, `ade-runtime` or `security` process from
    this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 30 | 0 |

## References

- openai/codex @ `rust-v0.157.0`:
  - `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`: `ThreadForkParams.last_turn_id` (stable) and `ThreadRevertParams` (paginated only). Studied.
  - `codex-rs/app-server/src/request_processors/thread_processor.rs`: `thread_fork_inner`, the legacy truncation path. Studied.
  - `codex-rs/core/src/thread_rollout_truncation.rs`: `truncate_rollout_after_turn_id`, the not-found and in-progress errors the mock mirrors. Studied.
  - `codex-rs/app-server/README.md`: `thread/rollback` removed, `forkedFromId` on `thread/started`. Studied.
- t3code @ ade-evaluation-2026-09-24, `packages/effect-codex-app-server/src/_generated/schema.gen.ts`: `ThreadForkParams` with `lastTurnId`. Studied.
- paseo @ ade-evaluation-2026-09-24, `packages/server/src/server/agent/providers/codex/rewind.ts`: Codex rewind by fork. Studied, not copied. Paseo uses the experimental `beforeTurnId` and the removed `thread/rollback`; ADE uses neither.

## Open

- Outside this slice: `context/rewind.spec.ts` › "R001: a file rewind whose
  reply was lost is read back after a daemon crash and restores once" is
  flaky. It failed 2 of 6 repeats with "Operation rewind-lost:files was
  interrupted while it was changing the workspace; its outcome is unknown".
  - Likely cause: the test kills the daemon as soon as the file content
    changes. That can happen before the checkpoint receipt settles.
  - This slice did not change that test's body or the checkpoint code.
    It was not checked on the base commit.
- Provider (Agent) descendants are still recorded only from the daemon's own
  2-second tree observation. The runtime reports its per-attempt tracking for
  terminals only (scripts and services). Adding it for Agents needs a field in
  the `AgentList` contract.
- A descendant that forks, leaves its group and loses its parent between two
  observations is never seen. This is the macOS limit named in
  `descendants.rs`.
- Coordinator:
  - `requirements.md` already lists R006 and F039 as accepted. No shared file
    was edited.
  - `e2e-fixme-inventory.md` still lists these two gaps. Its "Real product
    gaps" table can drop the R006 and Codex rows.
