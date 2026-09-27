# e2e-conversation-delete

Status: returned
Type: slice evidence
Branch: claude/wf_ead686db-a2b-2
Worker: E2E round 5, slice conversation-delete
Requirements: R011 (accepted: its delete half now passes, beside the rewind and profile-switch halves); F140 (advanced: the "late pages after a deletion" fault now has tests; not accepted, its load, migration and real-provider matrices are wider than this slice); F043 (its "deleted conversation leaves search" fixme now passes)

## Outcome

ADE now has `conversation.delete`, an effect command whose receipt commits in
the same transaction as the deletion. It refuses while a turn runs, stops an
idle Agent first, removes the Conversation's history, drafts, queue, send
intents, snooze and window reference, and writes a tombstone. Every later read,
write, page, search filter or feed consumer that names the Conversation is
refused with the new `conversation_deleted` error code, and every listing
leaves it out. `conversation.create` now refuses a disabled account with the
same error that launch and send use. R011 is accepted.

## Design

- **Tombstone, not row removal.** The `conversations` row stays behind a
  `conversation_tombstones` row. Attachment payloads reference the row through a
  foreign key, and the existing reclaim rules need it to free them. The store
  refuses the Conversation through `live_conversation`, which replaced every
  write-path lookup in `store/*`. The catalogue, `history.list`, diagnostics'
  interrupted list, restart recovery, orchestration, placement and device-caller
  lookups filter it out. `Store::open` creates the table with
  `CREATE TABLE IF NOT EXISTS` and no numbered migration.
- **Cleanup.** In one transaction, the deletion removes these rows: messages
  (the history index drops them through its delete journal), requests, drafts,
  draft context, draft history, draft stashes, context captures, queued
  prompts, send intents, the snooze and account-switch records. Windows keep
  their layout and show no Conversation.
- **Attachments.** Deletion never removes a payload. Once nothing references
  it, `attachment.reclaim.preview` reports it reclaimable, and
  `attachment.reclaim.apply` frees it. The reply counts these payloads as
  `attachments_left_for_retention`. Attachments are per Conversation, and a
  delegated child gets its own copies, so no blob is shared across
  Conversations.
- **Feed and SDK.** The deletion publishes a `conversation_deleted` frame and
  a new catalogue. The SDK projection (`@ade/client/sync`) gains a `deleted`
  status and cause. A deletion frame ends the projection, even across a gap
  or a boot change. A snapshot fetch refused as `conversation_deleted` also
  ends it. A snapshot read before the deletion and delivered after it is
  dropped, and the projection never loads again.
- **Disabled account.** `ACCOUNT_DISABLED` ("Conversation account is disabled
  in ADE; create or choose another account") is the error for
  `conversation.create`, launch (`attach_agent`) and send
  (`ensure_account_current`). Before this change, launch said "Conversation
  account is not verified" for a disabled account.

## Operation tiers

- `conversation.delete`: effect command (new). It has an operation ID and a
  daemon-computed fingerprint. Its receipt is in `state.sqlite`'s `operations`
  table, in the deletion's transaction. A retry replays the reply; the same ID
  with another payload conflicts. A refusal records nothing.
- `conversation.create`: effect command (unchanged tier). It gains the
  disabled-account refusal.
- New feed frame: `conversation_deleted`. New error code:
  `conversation_deleted` (recovery `reload_catalog`, CLI exit 18).

## Acceptance criteria

R011 "Delay history/search responses, then delete/rewind/switch profile; late results cannot resurrect or cross-associate data":

| Criterion | Spec | Result |
|---|---|---|
| A snapshot read before a deletion arrives after it. The view goes to `deleted` with no snapshot and is never `current` again. It loads nothing more. | `restarts/stale-rewind.spec.ts` › a result delayed across a conversation delete | pass |
| A search match read before the deletion, opened at its position, is refused as deleted | same spec | pass |
| An older page read before the deletion is refused as deleted | same spec | pass |
| A search cursor issued before the deletion pages nothing of the deleted Conversation; its words are no longer found | same spec | pass |
| A new Conversation with the same words is found only under its own identity | same spec | pass |
| Rewind half | `restarts/stale-rewind.spec.ts` (round 4) | pass (re-run) |
| Profile-switch half | `reliability-b/stale-results.spec.ts` (round 3) | pass (re-run) |

The slice's own criteria, all in `conversation-delete/delete.spec.ts`:

| Criterion | Result |
|---|---|
| An idle Conversation with a turn, a draft with an attachment, a pending send intent, a queued prompt, a snooze and a window is deleted. The reply counts each removal. The idle Codex Agent process stops. | pass |
| A retry under the same operation ID returns the same reply. The ID with another Conversation is refused as a conflict, and that Conversation is untouched. | pass |
| After the deletion, 13 operations that name the Conversation are refused with `conversation_deleted` and one message: get, a late page, controls, send, resume, the draft read and write, enqueue, upload, snooze, a search filter, window save and a second delete. | pass |
| The catalogue and `history.list` leave the Conversation out. The window shows no Conversation, the deleted words are not found, and the send outbox is empty. | pass |
| The deleted Conversation's attachment is still live and now reclaimable, and the reclaim frees it. Another Conversation's upload, which its draft references, stays protected. | pass |
| A delete while a turn runs is refused and records no receipt. The turn is not touched. After a cancel, the same operation ID deletes. | pass |
| After a daemon kill, the tombstone holds, the receipt replays, a late page is refused and the catalogue omits the Conversation. After an index rebuild, the words are still not found. | pass |
| The CLI `conversation delete ID` deletes and replays with `--operation-id`. `conversation inspect` of a deleted Conversation exits 18 with `conversation_deleted`. A missing ID is a usage error. | pass |
| `conversation.create` on a disabled account is refused with the error that the launch of an existing Conversation on that account also returns | pass |

F043: `catalogs/history.spec.ts` › "a deleted conversation disappears from
search results" was a fixme and now passes (search and `history.list`).

F140: `fault-suite.ts` class 4, "late pages after a deletion", had a gap. It
now names three tests. `load/fault-classes.spec.ts` confirms that the fault
suite runs all three.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only conversation-delete`: 5 passed
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only restarts/stale-rewind.spec.ts catalogs/history.spec.ts load/fault-classes.spec.ts`: 8 passed, 2 skipped (existing gaps)
- Regression: `providers reliability-b conversations conversations2 context` gave 115 passed and 2 skipped. `orchestration orchestration2 accounts-rewind reliability-c devices backup ops restarts` gave 324 passed and 1 skipped.
- `pnpm check:static`: pass
- In-process tests added: three pure projection tests in
  `packages/client/src/sync.test.mjs` (a reducer for the deletion frame, a
  late snapshot dropped after a deletion, a fetch refused as deleted). The
  contract tier test in `crates/ade-core/src/contract/conversations.rs` gains
  `conversation.delete`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 25 | 0 |

## References

None.

## Open

- Coordinator: `conversation_deleted` joins the error code list in
  `packages/client/src/request.ts`, and CLI exit code 18 joins
  `apps/cli/src/index.ts`. The generated contracts were regenerated with
  `pnpm contract:generate`. No migration number was taken.
- Activity entries, usage records, orchestration links, checkpoints and the
  receipts that name a deleted Conversation are kept. Activity for it can
  still be listed. Deleting a parent with delegated children leaves the
  children as they are.
- `attachment.inspect` and the reclaim operations still accept a deleted
  Conversation, because they are how its payloads are freed.
- The desktop renderer treats the new `deleted` projection cause like any
  other state change. Showing a "deleted" notice is UI-phase work.
