# E2E round 1: conversations

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-4
Worker: ADE parallel build, E2E round 1, conversations worker
Requirements: F031, F034, F035, F036, F038, F040, R001, R002

## Outcome

Headless protocol E2E now covers the conversation core in
`e2e/protocol/conversations/`: 40 tests pass and 1 is `test.fixme`. Every test drives a real
`ade-daemon` and `ade-runtime` through the SDK, the CLI or raw protocol lines,
with the Codex and Claude fixture providers. No product bug surfaced, so no
product code changed. The register E2E acceptance for F031, F034, F035 and F038
passes with fixture providers. F036 stops at one gap: a live draft does not
keep context nodes. R001 and R002 pass for every conversation operation. They
are shared reliability requirements, so other domains must still prove their
own operations.

Fixture providers alone do not establish product completion (spec 03,
"Feature acceptance"). Real-provider evidence and UI coverage are still
required separately.

## Acceptance criteria

| Requirement | Criterion | Spec | Result |
|---|---|---|---|
| F031 | Stream text before completion | `send-queue.spec.ts` "a codex/claude reply streams before it completes" | pass |
| F031 | Structured tool events, ordering, readable fallback for unknown content after restart | `send-queue.spec.ts` "tool events and an unknown item keep their order and readable fallback across a daemon restart" | pass |
| F034 | Queue, inspect, remove, pause, restart, dispatch once each | `send-queue.spec.ts` "queued prompts can be inspected, removed and paused, survive a restart and dispatch once each" (SDK and `ade queue add/pause/resume`) | pass |
| F034 | Automatic dispatch when the turn ends | `send-queue.spec.ts` "a prompt queued behind a running turn dispatches automatically" | pass |
| F034, R001 | Queued prompt in dispatch when the daemon is killed is delivered once | `send-queue.spec.ts` "a queued prompt in dispatch when the daemon crashes is delivered once after restart" | pass |
| F035 | Steer a compatible active run; native acknowledgement | `controls.spec.ts` "steering a running Codex turn is acknowledged natively" | pass |
| F035 | Idle or stale turn refused, no receipt, no queued message | `controls.spec.ts` "steering an idle Codex turn or a stale turn is refused" | pass |
| F035 | Provider refusal settles as `refused`; retry reads it | `controls.spec.ts` "a steer the provider refuses settles as refused" | pass |
| F035 | Unsupported provider reports its limitation without mislabelling a message | `controls.spec.ts` "Claude reports steering and compaction as unavailable" | pass |
| F036 | Draft restored after window and daemon crash; older write never overwrites | `drafts.spec.ts` "a draft survives a crashed window and a crashed daemon" | pass |
| F036 | Live draft context restored after window crash | `drafts.spec.ts` "a live draft restores its context nodes after a window crash" | fixme (gap below) |
| F036 | Recall sent and discarded drafts with revision conflict | `drafts.spec.ts` "sent and discarded drafts can be recalled only over the revision the caller saw" (SDK and `ade draft history/recall`) | pass |
| F036 | Stash text and context, explicit transfer between windows, stale-revision refusals, drop | `drafts.spec.ts` "a stash keeps text and context, transfers a draft between windows" | pass |
| F036 | Pending send fences draft edits and restores | `drafts.spec.ts` "a draft with a pending send cannot be edited or replaced" | pass |
| F036, R001 | `draft.send.list` and `draft.send.acknowledge` after a lost reply and a daemon crash | `outbox.spec.ts` "a send accepted with its reply lost is listed as accepted and acknowledged once" | pass |
| F036, R001 | Prepared but undelivered send cannot be acknowledged away; delivery with the same ID | `outbox.spec.ts` "a prepared send that never reached the daemon" | pass |
| F036, R001 | Rejected send acknowledged as aborted, draft kept, ID never delivered later | `outbox.spec.ts` "a send the daemon rejected is listed as rejected" | pass |
| F038 | Native choices exposed as sent; answer outside them refused before dispatch; rich questions | `requests.spec.ts` "Codex native choices are offered as sent" | pass |
| F038 | One answer; repeat converges; late or conflicting answer after settlement refused (both providers, across restart) | `requests.spec.ts` "a codex/claude approval takes one answer", "questions take free-text answers once" | pass |
| F038 | Concurrent conflicting answers admit one decision | `requests.spec.ts` "concurrent conflicting answers admit exactly one decision" | pass |
| F038 | Late answer to a request the provider withdrew | `requests.spec.ts` "a request the provider withdrew refuses a late answer" | pass |
| F038, R001 | Uncertain answer (daemon exits before or after delivery), then retry: conflict refused, one native reply | `requests.spec.ts` "an answer left uncertain by a daemon crash before/after delivery" | pass |
| F038, R001 | Answer proven unsent; one safe retry | `requests.spec.ts` "an answer the runtime proves was never sent" | pass |
| F040 | Codex compaction acknowledged; `contextCompaction` record in transcript; busy refusal | `controls.spec.ts` "Codex compaction is acknowledged and its native record appears" | pass |
| F040 | Compaction failure claims no new context | `controls.spec.ts` "a compaction the provider refuses reports the failure" | pass |
| R001 | Send reply lost, daemon killed, retry does not dispatch again | `send-queue.spec.ts` "a send whose reply was lost is accepted once" | pass |
| R001 | Runtime killed mid-turn: prompt kept, interruption reported, nothing replayed | `send-queue.spec.ts` "a runtime crash during a turn keeps the accepted prompt" | pass |
| R001 | Steer reply lost, daemon killed, retry reads the outcome without a second native call | `controls.spec.ts` "a steer whose reply was lost is read back after a daemon crash" | pass |
| R002 | Same request ID and payload converges; different payload or Conversation conflicts, also after restart and through the CLI | `send-queue.spec.ts` "agent.send with the same request ID admits one turn" | pass |
| R002 | Queue ID reuse, including a cancelled or delivered entry | `send-queue.spec.ts` F034 queue test | pass |
| R002 | Steer operation ID: stored reply after restart; different payload conflicts | `controls.spec.ts` steer test | pass |
| R002 | Send intent: same preparation converges; different payload or owner refused; list paging | `outbox.spec.ts` "send intents refuse a different payload or owner" | pass |

Not covered here: F040 retained-context content, because Codex does not expose
the summary and ADE claims none. 03-S17 and 03-S18 were outside this slice.

## Product fixes

None. No spec exposed a product bug in the conversation area.

## Fixture changes

- New generic fixture `e2e/protocol/fixtures/lost-reply.ts` (`sendAndLoseReply`):
  it writes one protocol line and closes the socket before any reply. It is not
  re-exported from `fixtures/index.ts`, because that file is shared; specs import it
  directly.
- `scripts/fixtures/codex_mock.py` gained two additive methods, which no
  existing test calls:
  - `turn/steer` checks `expectedTurnId` against the active turn, appends the
    steered user item with its `clientId`, and replies with `turnId`. It refuses
    when the `refuse-steer` release file exists.
  - `thread/compact/start` acknowledges, then emits a `contextCompaction` item
    in its own turn. It refuses when the `refuse-compact` release file exists.

  Before this change both methods replied "Fixture unsupported method".

## Requirements whose register E2E acceptance now passes

- F031, F034, F035, F038: full register acceptance passes with fixture providers.
- R001 and R002: pass for the conversation operations (`agent.send`,
  `queue.*`, `agent.answer`, `conversation.steer`, `conversation.compact`,
  `draft.send.*`, `draft.history.*`, `draft.stash.*`). Other domains still need
  their own evidence.
- Not fully passing: F036 (context-node gap) and F040 (retained context not
  shown).

## Operation tiers

No operation was added or changed.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/conversations`:
  40 passed and 1 fixme. Under `--repeat-each 3`: 102 passed and 3 skipped (the
  fixme), with no flakes. `boot.spec.ts` still passes with the changed Codex mock.
- `pnpm check:static`: pass. It ran 725 legacy Rust tests: all passed, 5 skipped.
- In-process tests added: none. No decision changed.
- `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree after the runs.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 15 | 0 |

## References

- `e2e/specs/answer-recovery.spec.ts` (legacy), studied: the answer failpoint scenarios, re-expressed on the shared fixtures.
- `e2e/specs/daemon-send-intent.spec.ts` (legacy), studied: the lost-reply socket pattern, now `fixtures/lost-reply.ts`.
- No reference repository was used.

## Open

- F036 gap: `draft.save` has no `context_nodes` field and the `drafts` table
  has no column for it. Context captured into a live draft is lost when its
  window crashes. The fix needs a `state.sqlite` migration, which the coordinator
  owns. The `test.fixme` in `drafts.spec.ts` names the gap.
- `agent.cancel` settles a turn as `interrupted` and pauses the queue. The
  shared helper `waitForIdle` accepts only `idle` or `ready`, so specs that cancel
  wait for `interrupted` themselves.
- Coordinator: `scripts/fixtures/codex_mock.py` is shared. Another worker's
  mock edits may conflict with the two new `elif` branches at the end of the
  method dispatch.
