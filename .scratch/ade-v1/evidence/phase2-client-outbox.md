# Phase 2 client-outbox

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-1
Worker: Phase 2 round B parallel build, slice client-outbox (ticket 10, part 3)
Requirements: advances F036, F075, F103, R001, R002 and R005. None is fully accepted.

## Outcome

`@ade/client/outbox` is a Node-free outbox for operations the daemon has not yet
admitted. It has pluggable storage and holds one record per owner. After an
uncertain save it refuses all further use. It also exports the pure deciders
for send recovery and Git admission. Electron main now stores both journals in
this outbox, through a file store (`outbox-file.ts`). Post-admission recovery
moved to the daemon:

- A send's journal record is dropped once `draft.send.prepare` (or a daemon
  list) proves admission.
- Retry, quit and close reconcile through `draft.send.list` and
  `draft.send.acknowledge`.
- Git reads, the one-operation-per-workspace rule and interrupted
  acknowledgements go through `review.operation.list` and
  `review.operation.acknowledge`.

Kept unchanged:

- the quit guard;
- profile-scoped record keys;
- `window.adeHost` shapes;
- the send-journal transfer bundle. Restore-held records are the one kind of
  post-admission record the journal still holds, because the bundle's import
  reconciles against them.

## Operation tiers

No operation was added or changed. The desktop now calls these existing
operations:

- `draft.send.list` (query)
- `draft.send.acknowledge` (idempotent command)
- `review.operation.list` (query)
- `review.operation.acknowledge` (idempotent command)

`draft.send.complete` stays on the live path, right after `agent.send` accepts a
prompt.

## Behaviour changes

- The send journal holds unadmitted prompts and restore-held records only. The
  "Pending prompts" IPC merges them with `draft.send.list` for the window while
  the daemon is reachable. While it is unreachable, admitted prompts are not
  listed. Ticket 10 accepted this trade-off.
- The quit and close guard treats a send as safe when the daemon holds its
  intent, or when the journal holds its exact record. Before, only the journal
  record counted.
- On quit or close, a send is acknowledged only when the daemon lists it as
  `accepted`, or when it was admitted and has since settled. A `prepared` send
  keeps its ID.
- A retried `rejected` send is released through acknowledgement. The error
  message is now generic unless `agent.send` returned one.
- The Git journal file moved to version 2 (`{version, records}`). It still reads
  version 1: active records carry over and archived ones are dropped. An
  interrupted operation acknowledged only in a version 1 file therefore shows
  once more, for acknowledgement through the daemon. That is the fail-closed
  direction.
- A Git receipt whose `op` differs from the request is refused.

## Checks

- `pnpm check:static`: pass. It covers rustfmt, the contract check,
  architecture, the SDK build, typecheck, Fallow, the JS build, the JS pure
  tests, Clippy and the legacy Rust tests.
- In-process tests added: `packages/client/src/outbox.test.mjs` (12 tests):
  - outbox persistence order and unchanged-save skip;
  - owner conflict and exact removal;
  - failed saves versus uncertain saves;
  - duplicate owners, overflow and invalid files;
  - the send-recovery decision table;
  - `findPendingSend` paging;
  - the Git admission rule and the choice of pending operation.

## Verified only statically

- the rewritten `dispatchSend`, `reconcileAcceptedSend` and `loadDraft` in
  `apps/desktop/src/main/conversations/send-pipeline.ts`;
- the Git IPC in `apps/desktop/src/main/review.ts`;
- the file store;
- the merged pending-send list.

No Electron process was run.

## Needs E2E later

- Legacy assertions expected to fail now:
  - `desktop-send-recovery`: the crash loop expects `dispatchStarted: true` in
    the journal when blocked at `agent.send`.
  - `desktop-send-recovery`, "Quit preserves an accepted prompt…": it expects
    an accepted prompt in the journal and in the offline "Pending prompts"
    panel. Its proxy also blocks only `draft.send.complete`, and quit now
    reconciles through `draft.send.acknowledge`.
- Expected to still pass:
  - `send-journal-transfer`, because the source record is pre-admission and the
    target keeps its held record;
  - `desktop-review-atomic-send` and `desktop-review-batch`, because they read
    the journal at the pre-admission pause.
- New coverage needed:
  - a relaunch that recovers a prepared send from `draft.send.list`;
  - a daemon killed during a Git mutation, then the interrupted operation
    acknowledged from the UI and listed as archived;
  - a second Git operation refused while the daemon lists a running one;
  - a legacy version 1 Git journal loaded after upgrade.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 10 | 0 |

## References

- `.scratch/parallel-build/research/08-reference-map.md` has no row for the
  client outbox. `t3code/apps/web/src/queuedMessageStore.test.ts` is listed
  there as a client-side queue pattern; I did not open it. The design follows
  `.scratch/parallel-build/research/06-client-journals.md` option C and
  `.scratch/ade-v1/evidence/phase2-outbox-daemon.md`. No code was copied.

## Open

- Retire the transfer bundle, and the held-record exception, once the legacy
  `send-journal-transfer` spec is migrated.
- The CLI still keeps no outbox. It could use `@ade/client/outbox` with its
  own storage.
- `review.operation.list` with `include_acknowledged` caps at 100 entries.
  Many acknowledged operations could crowd out a running one in the read view.
  The admission check lists without acknowledged entries, so it is not
  affected.
- The daemon does not enforce one unacknowledged Git operation per workspace.
  The desktop enforces it from the daemon list plus the local outbox, so a CLI
  caller can still bypass it.
- Coordinator: no shared-file changes. `index.ts` is unchanged.
