# orchestration

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-8
Worker: Phase 2 parallel build, round B, slice orchestration
Requirements: F104 (delegation), F106 (parent and child tracking), F107 (agent messages, waits and questions); backend foundations only, none fully accepted

## Outcome

A Conversation can now delegate a task to a new child Conversation through the
common command API. The request states the provider, the account (inherit,
managed or ambient) and the workspace (the parent's, or a new worktree that the
daemon verifies against the lifecycle ledger), and it carries caller
attribution. One `state.sqlite` transaction commits the receipt, the child
Conversation, the durable parent and child link, and the task in the child's
prompt queue. The existing queue then delivers it; nothing is replayed. Children
can be listed, read, sent messages and waited on. A wait is a non-blocking query
that returns the child's outcome, a pending phase, a question to answer, a
blocked queue, a timeout or an unavailable child. The CLI gains a `child` area
that composes new-worktree creation and polls waits until their deadline.

Rules in `crates/ade-daemon/src/sessions/orchestration/policy.rs`:

- An Agent caller may delegate only as its own Conversation, and only the
  parent Agent or the user may message a child. Attribution is recorded as
  `user` or `agent:<conversation ID>` on the link, each message and the receipt.
- `inherit` needs the parent's provider. Depth is capped at 4 and fan-out at 32
  children per Conversation.
- A `new_worktree` choice holds only for a succeeded `worktree.switch` with
  `create`, whose canonical path is the named workspace's root, and which is not
  the parent's workspace.
- A wait settles only on evidence. A turn replaced by a later one is `unknown`,
  never `completed`. A queued prompt behind a paused queue or a terminal handoff
  is `blocked`. A missing child is `unavailable`. Only `pending` asks the caller
  to repeat.

## Operation tiers

| Operation | Tier |
|---|---|
| `orchestration.delegate` | effect command (receipt in `state.sqlite`) |
| `orchestration.child.send` | effect command (receipt in `state.sqlite`) |
| `orchestration.children` | query |
| `orchestration.child.get` | query |
| `orchestration.child.wait` | query; answers at once, never holds the request |

New tables, created idempotently on first use in `state.sqlite`:
`orchestration_children` and `orchestration_messages`. No migration and no
backup version pin changed.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/sessions/orchestration/policy.rs` (11 tests:
    attribution, account choice, limits, titles, worktree evidence, deadlines,
    wait resolution)
  - `crates/ade-core/src/contract/orchestration.rs` (2 schema round-trip tests)

A manual smoke run against a scratch daemon, with `ADE_CODEX_BIN=/usr/bin/false`
so no real provider ran, showed: delegation, replay of the same operation ID,
conflict on a changed payload, refusal of a forged Agent caller and of `inherit`
across providers, the child's failed turn reported as `settled`/`failed`, a
queued follow-up reported as `blocked` behind the paused queue, and the link,
wait and send replay surviving a daemon and runtime restart. This is not
committed test coverage.

Verified only statically: the `new_worktree` path end to end (CLI
`worktree.switch` → `worktree.operation` → `workspace.open` → delegate), the
`needs_input` state with a real provider question, and the dispatch of a child
task by a real provider.

Needs E2E later:

- F104: delegate with each account mode and both workspace modes; observe
  admission, then running, without assuming completion.
- F106: list children with failed, unknown and unavailable states across
  daemon restart and independent Agent lifetimes.
- F107: send a message, wait with a timeout, answer a child's question once
  with `agent.answer`, and see a late answer refused.
- 09-S08 for both effect commands: same ID and payload deduplicates; a changed
  payload conflicts.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 15 | 0 |

## References

- Herdr @ 9c96f7d, `src/api/wait.rs`, studied: a bounded wait that answers at
  once when already satisfied and times out otherwise → `policy::resolve_wait`.
  ADE moves the loop to the client so the daemon never holds a request.
- OpenCode-v2 @ 2c369a2, `packages/core/src/session/inbox.ts`, studied: persist
  the inbox item before the wake → the child's task and messages commit to the
  durable prompt queue before `changed` wakes the dispatcher.
- No code was copied.

## Open

- Shared file edits the coordinator should know about: `crates/ade-daemon/src/sessions.rs`
  gains `mod orchestration;` and one dispatch arm for `orchestration.*`;
  `apps/cli/src/index.ts` gains one import, one usage entry and one command-area
  entry.
- Errors for conflict, expiry and refused attribution are plain messages
  (`code: daemon` in the CLI). A typed `conflict` code needs a shared error
  classification change.
- F105 (parallel runs and comparison) is not started. Delegation to a remote
  host and the `context` binding in the spec's decision 5 are not modelled.
- No push feed for waits: a subscription frame for child settlement would let
  the SDK stop polling.
- No cancel operation for a child; `agent.cancel` and `queue.cancel` on the
  child Conversation work today but carry no orchestration attribution.
- A wait for a turn replaced before anyone observed it reports `unknown`. Recording
  each turn's outcome when it settles would remove that gap.
