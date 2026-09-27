# E2E round 2: conversation fixes

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-2
Worker: ADE parallel build, E2E round 2, conversation-fixes worker
Requirements: F031, F034, F040, F036 (draft history), R001, R002

## Outcome

Three conversation bugs from round 1 are fixed and proven in
`e2e/protocol/conversations2/`: 17 tests pass and 1 is `test.fixme`. Every
spec was run against the pre-fix build first; the bug specs failed there (6
failures) and pass with the fixes. R001 and R002 now pass for every
conversation effect command except `conversation.create`, which takes no
operation ID (gap below). No requirement's full register acceptance is newly
claimed: R001 and R002 are shared across domains, and `conversation.create`
still fails them.

## Acceptance criteria

R001: crash around intent commit, dispatch, external acknowledgement and
settlement; recorded outcome or explicit unknown, no blind replay. R002:
identical ID and payload deduplicates, an altered payload conflicts, also
after reconnect.

| Operation (tier) | Criterion | Spec | Result |
|---|---|---|---|
| queue.pause (effect) | Unpausing an `interrupted` Conversation dispatches its head, as for an idle one (SDK and `ade queue resume`) | `queue.spec.ts` "resuming the queue of an interrupted Conversation" | pass (failed before fix 1) |
| queue.pause, R001 | After a runtime crash the queue waits, unpaused, for `agent.resume`, then dispatches once; the lost prompt is never replayed | `queue.spec.ts` "after a runtime crash, the queue waits for an explicit resume" | pass |
| queue.pause, R001/R002 | Pause twice converges; unpause with a lost reply, daemon SIGKILL, unpause twice more: each queued prompt reaches the provider once | `queue.spec.ts` "repeating queue.pause converges" | pass |
| queue.enqueue, R001/R002 | Enqueue with a lost reply and a daemon SIGKILL is kept once; SDK and CLI retries converge; another prompt, another Conversation or `agent.send` under the ID is refused; a retry after delivery does not requeue | `queue.spec.ts` "an enqueue whose reply was lost is kept once" | pass |
| conversation.compact, R002 | Same ID converges on the stored reply (SDK, CLI, after a daemon SIGKILL); the ID on another Conversation conflicts (SDK and CLI); one native call, one transcript record | `compact.spec.ts` "the same compaction converges" | pass |
| conversation.compact, R001 | Reply lost, daemon SIGKILL: the retry reads `acknowledged` without a second native call | `compact.spec.ts` "a compaction whose reply was lost" | pass |
| conversation.compact, R001 | Daemon SIGKILL after dispatch, before the provider acknowledged: the provider acknowledges while no daemon holds the reply, and the retry reads it from the same run; one native call | `compact.spec.ts` "a daemon crash between dispatch and the provider acknowledgement" | pass |
| conversation.compact, R001 | Runtime killed before the provider saw the call: the retry reports `unknown` (SDK) or `outcome_unknown` (CLI), stays unknown after resume, and the provider is never called for that ID; a new ID compacts | `compact.spec.ts` "a compaction whose run was lost with the runtime" | pass |
| conversation.rewind files (effect), R001/R002 | Reply lost, daemon SIGKILL: the checkpoint is restored once (one safety checkpoint); SDK and CLI retries read `restored` and do not overwrite later edits; `confirm_overwrite` changed or another Conversation under the ID conflicts and writes nothing | `rewind-create.spec.ts` "a file rewind whose reply was lost" | pass |
| conversation.rewind conversation | Reports its limitation and records no receipt; the ID stays usable | `rewind-create.spec.ts` "a Conversation rewind reports its limitation" | pass |
| conversation.create (effect), R002 | A retried create under one operation ID makes one Conversation | `rewind-create.spec.ts` | fixme (gap below) |
| draft.history.* (via draft.save, draft.send.complete), R001 | A discard and a send are recorded once despite lost replies and daemon SIGKILLs; paging reads them after the crash | `draft-history.spec.ts` "a discard and a send are recorded in history once" | pass |
| draft.history.restore, R001/R002 | Recall with a lost reply and a daemon SIGKILL: SDK and CLI retries read `already_restored`, the displaced draft is kept once; another entry under the same revisions is a `conflict` that writes nothing; another Conversation's entry is refused | `draft-history.spec.ts` "a recall converges after a lost reply and a crash" | pass |
| F031 | One agent message and one tool output of 1.5 MiB are stored cut at 1 MiB on a character boundary with an explicit marker; the turn completes, the text survives a daemon SIGKILL, and the next turn runs | `large-message.spec.ts` "a message and a tool output past 1 MiB" | pass (failed before fix 2) |
| F031 | A prompt past 1 MiB is still refused before dispatch | `large-message.spec.ts` "a prompt past 1 MiB" | pass |
| R001 | A turn lost to a runtime crash records exactly one `operation_unknown` for the turn in both orderings (daemon outlives the runtime; daemon dies first); the recovery report agrees; the prompt is not replayed | `lost-turn.spec.ts` (daemon-survives, daemon-first) | pass (daemon-survives failed before fix 3) |
| R001 | A cancelled turn records neither `turn_interrupted` nor `operation_unknown` | `lost-turn.spec.ts` "a turn the user cancels" | pass |

Round 1 already proves R001 and R002 for `agent.send`, `agent.answer` and
`conversation.steer` (`e2e/protocol/conversations/`); they still pass.

## Product fixes

1. **An unpaused queue ignored an `interrupted` or `error` Conversation.**
   `queue_heads` selected only `idle` and `ready`. Every move into
   `interrupted` or `error` already pauses the queue, so both statuses now
   dispatch once the user resumes it (`QUEUE_DISPATCH_STATUSES` in
   `crates/ade-daemon/src/store/conversations.rs`). A Conversation that has a
   provider session but no connected Agent is skipped until `agent.resume`,
   instead of being tried, refused and re-paused
   (`crates/ade-daemon/src/sessions/agents.rs`, `dispatch_queued`).
2. **One message past 1 MiB failed the Conversation.** Provider text is now
   bounded, not refused. `ade_core::transcript::{bound_text, append_bounded,
   bound_message}` cut at 1 MiB on a character boundary and end the text with
   `[ADE truncated this message at 1 MiB. The rest of the provider's output was
   not stored.]`. Later deltas are dropped, and a completed item bounds to the
   same text as its stream. Streaming deltas and every non-user message commit
   use it; user prompts are still refused past 1 MiB.
3. **A lost turn was `turn_interrupted` or `operation_unknown` by timing.**
   When the daemon outlived its runtime, `fail_if` committed `interrupted`
   through the ordinary path, which records `turn_interrupted`. A failure whose
   provider stop was not confirmed, or whose runtime is gone, now commits
   through `Store::commit_lost_run`. That path records the turn with
   `activity::lost_turn_activity`, the same `operation_unknown` and key as the
   restart path, so both orderings record one activity.

In-process tests for the pure cores: `crates/ade-core/src/transcript.rs`
(bounding) and `crates/ade-daemon/src/store/activity.rs`
(`a_turn_lost_with_its_run_is_unknown_whatever_noticed_it`).

## Spec changed outside this area

`e2e/protocol/orchestration/delegation.spec.ts`, "messages a child ...": it
asserted fix 1's bug, that unpausing an interrupted child with a connected
Agent keeps its queued message blocked until `agent.resume`. It now asserts
that the message completes after the unpause. The runtime-loss test in the
same file still passes unchanged, because the queue now waits for the resume.

## New generic fixtures

- `e2e/protocol/fixtures/codex_faults.py`: a proxy in front of the Codex mock.
  Its `large-message` prompt streams one 1.5 MiB agent message and one
  1.5 MiB command output, then completes the turn. While `hold-compact`
  exists, it holds `thread/compact/start` until `release-compact`.
- `e2e/protocol/fixtures/conversation-faults.ts`: its environment, prompt
  names and `waitForHeldCompaction`.

## Requirements whose full register acceptance now passes

None. R001 and R002 pass for every conversation effect command except
`conversation.create`, and other domains must prove their own operations.

## Operation tiers

No operation was added or changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/conversations2`:
  17 passed and 1 fixme. Under `--repeat-each 3`: 51 passed, no flakes.
- Pre-fix build, same bug specs: 6 failed.
- Regression runs with the fixes: `conversations`, `recovery`,
  `orchestration`, `boot.spec.ts`, `terminals/ownership`,
  `resources/host-resources`, `services/recovery`, `services/proxy` and
  `backup/fences` all pass (92 and 21 passed in two runs, the first including
  this area; the known fixmes skipped).
- `pnpm check:static`: pass. 736 Rust tests passed, 5 skipped.
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 60 | 5 | 30 | 0 |

## References

- `.scratch/ade-v1/evidence/e2e-conversations.md` and `e2e-recovery.md` (round 1 gaps), `e2e/protocol/fixtures/codex_flood.py` (proxy pattern, studied). No external code was copied.

## Open

- **Gap (fixme):** `conversation.create` is declared an effect command, but
  `ConversationCreateRequest` has no `operation_id`, so a create whose reply is
  lost cannot be retried without making a second Conversation. Closing it
  needs a contract field and a receipt in the daemon.
- The error text after a daemon-first crash still reads "The daemon restarted
  during this turn" when the runtime crashed (round 1, minor).
