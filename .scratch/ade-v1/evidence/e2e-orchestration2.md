# e2e-orchestration2

Status: returned
Type: slice evidence
Branch: claude/wf_317b0f50-41b-7
Worker: parallel build, E2E round 3, slice orchestration-2
Requirements: F104, F106, F107, F117, F114 (backend), 10-S03

## Outcome

`e2e/protocol/orchestration2/` holds 26 headless specs; all pass, none is `test.fixme`. They drive
real daemon and runtime processes through the SDK and the CLI, with the Codex mock and a new
custom executable agent that fails on request. The round-1 gaps named in
[e2e-orchestration](e2e-orchestration.md) are closed by five product changes:

1. **Messages to the parent.** `orchestration.parent.send` (effect command) queues a message from
   a delegated child to its parent. Only the child's own Agent or the user may send it. The parent
   receives it after a line naming the child. `orchestration.child.messages` (query) lists both
   directions, oldest first, with sender, receiver and delivery (`queued`, `submitted`,
   `cancelled`, `missing`).
2. **Questions on the parent's view.** Every child record now carries `pending_requests`: the
   question or approval, its kind and the provider's request, including the question text.
   `orchestration.child.answer` (effect command) answers one of them for the parent Agent or the
   user. It uses the `agent.answer` path, so the same answer converges and a different one is
   refused.
3. **Delegation context (F104).** `orchestration.delegate` takes `context_attachments`: live
   attachments of the parent. The daemon copies them to the child under new IDs, in the same
   transaction, and sends them with the task. A foreign, changed or missing attachment is refused
   before any child exists. A missing attachment is named plainly; before this fix, the daemon
   reported it as a failed save.
4. **Notification preferences (F114).** `notification.preferences.get` (query) and
   `notification.preferences.set` (idempotent command) store `desktop` and `muted_kinds`. A claim
   on activity excluded by the preferences, or on activity of a snoozed Conversation, records a
   final `suppressed` delivery. Its reason is `desktop_disabled`, `kind_muted` or
   `conversation_snoozed`, and it is never granted later.
5. **CLI.** The new commands are `ade child answer`, `ade child reply`, `ade child messages`,
   `ade child delegate --context` and `ade notification preferences`.

The round-1 `test.fixme` in `e2e/protocol/orchestration/activity.spec.ts` (snooze suppresses
delivery) now passes and is a plain `test`.

Full register acceptance now passes as headless E2E for **F104, F106 and F107**. **F117** passes
at the API level; see its row for what that excludes. **F114** remains partial because OS
presentation and navigation happen in Electron.

## Acceptance criteria

| ID | Criterion | Spec | Result |
|---|---|---|---|
| F104 | Explicit provider, account, workspace and context; admission and running reported without assuming completion | `lifecycle.spec.ts` "a child is admitted, runs and settles…"; `context.spec.ts` (all 3); `lifecycle.spec.ts` "a failed child…" (ambient account on an adapter provider); round 1 `delegation.spec.ts` (inherit, managed, new worktree) | pass |
| F106 | Relationships and statuses persist across reconnect and restart, including failed and unknown children and independent lifetimes | `lifecycle.spec.ts` "a failed child…" (graceful and kill restart), "a child turn lost with its runtime…" (unknown, daemon still up), "parent and child run independently…"; `waits.spec.ts` "a wait deadline carries across a daemon restart…"; round 1 restart and crash specs | pass |
| F107 | Identified messages, bounded waits, questions answered once, timeout and cancellation, unavailable peers | `messages.spec.ts` (all 4: both directions, attribution, dedup across a crash, busy parent, CLI); `questions.spec.ts` (all 3: parent view, answered once, forged caller, restart); `waits.spec.ts` (timeout leaves the child running, cancellation ends a CLI wait in progress, cancelled queued message, deadline across restart, range checks); `lifecycle.spec.ts` "a child whose Agent is disconnected…" (unavailable peer: `blocked` with reason, across a crash) | pass |
| F117 | Durable activity with origin and status; filter and open targets; entries readable when extensions disappear | `activity.spec.ts` "child activity names the child…" (origin, target resolves to the child and its parent), "activity from an adapter agent stays readable after the adapter is removed…", cursor specs; round 1 `activity.spec.ts` (filters, read and dismissed) | pass through the API and the CLI. The desktop inbox view is Electron work and is not covered |
| F114 | Notify for selected events, respect preferences, navigate, deduplicate on reconnect | `activity.spec.ts` "notification preferences and a snooze suppress delivery…", "clients racing to claim one activity…"; round 1 `activity.spec.ts` claim, report and snooze specs | backend passes: preferences, snooze, final suppression, deduplication across restart and a 10-way claim race. **Not covered:** OS presentation and in-app navigation (Electron) |
| 10-S03 | After reconnect, show the entry once and do not repeat a handled delivery | `activity.spec.ts` "activity cursors stay valid across a restart and a crash…", "a client that was away…catches up from its cursor once…", "clients racing…" (an unreported claim is never re-delivered after restarts) | pass at the backend |

Accepted in full: **F104, F106, F107, F117** (F117 at the API level).
Partial: **F114**, because OS presentation and navigation happen in Electron.

## Operation tiers

| Operation | Tier |
|---|---|
| `orchestration.parent.send` | effect command (receipt in `state.sqlite`) |
| `orchestration.child.answer` | effect command (identity is the request; the answer fingerprint deduplicates, as for `agent.answer`) |
| `orchestration.child.messages` | query |
| `notification.preferences.get` | query |
| `notification.preferences.set` | idempotent command |
| `orchestration.delegate` | unchanged tier; gains the optional `context_attachments` field |
| `orchestration.children`, `orchestration.child.get`, `orchestration.delegate` replies | `ChildRecord` gains `pending_requests` |

New tables, created idempotently on first use: `orchestration_parent_messages` and
`notification_preferences`. No migration number changed.

## Checks

- `pnpm check:static`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/orchestration2`: 26 passed. 75 of 75
  passed under `--repeat-each 3` before the adapter-removal spec was added.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/orchestration/`: 23 passed, 0 fixme.
- In-process tests added (pure cores):
  - `crates/ade-daemon/src/sessions/orchestration/policy.rs`: `agents_act_only_as_themselves_and_are_attributed`
    (extended for parent messages), `a_parent_sees_who_sent_a_message_and_what_a_request_asks`.
  - `crates/ade-daemon/src/store/activity.rs`: `preferences_and_snoozes_suppress_in_a_fixed_order`.
  - `crates/ade-core/src/contract/orchestration.rs` and `activity.rs`: round-trip cases for the new types.
- New generic fixture: `e2e/protocol/fixtures/failing-agent.ts`. It stages a custom executable
  agent that fails a turn with exit status 3 when the prompt contains "fail". `fixtures/index.ts`
  is unchanged.
- After the runs, `pgrep` found no `ade-daemon` or `ade-runtime` from this worktree.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 120 | 10 | 30 | 0 |

## References

None.

## Open

- **A settled task loses its failed outcome.** Once a later turn replaces a failed task, a wait
  on that task reports `unknown`, not `failed`. The child's status stays correct. Recording each
  turn's outcome when it settles would fix this (see phase2-orchestration, Open).
- **A Conversation cannot be removed.** A `Missing` delivery and the `unavailable` wait state
  therefore cannot be produced through the protocol. The unavailable-peer case is proven with a
  disconnected child Agent.
- **One unexplained failure.** Once, straight after a daemon rebuild, a single `toBe` assertion
  failed in `context.spec.ts`. The detail was not captured, and it did not recur in more than 130
  later runs of that file.
- **Shared-file edits.** The coordinator should know about:
  - `crates/ade-daemon/src/sessions.rs`: two dispatch arms, `notification.preferences.get` and
    `notification.preferences.set`.
  - `crates/ade-daemon/src/store/attachments.rs` (conversations/context domain): a new
    `Store::copy_attachments` method.
  - The regenerated `packages/contracts` files.
- **Custom executable adapters accept attachments.** `prompt_context::plan` treats an unknown
  provider's attachments as `AdapterDeclared` and never refuses them. So a child on an adapter
  provider receives context attachments, whether or not that agent can read them. This belongs to
  the providers domain.
