# draft-stash

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-10
Worker: Phase 2 round E, draft-stash worker
Requirements: F036 (advanced, not accepted)

## Outcome

The daemon now keeps a durable draft history per Conversation and window and
a named draft stash per Conversation. A sent draft enters history in the same
transaction that clears it on send completion. A `draft.save` that empties a
non-empty draft keeps the old text as a discarded entry. A stash keeps text,
attachments and context nodes. Every restore names the window draft revision
the caller saw. A newer draft is never overwritten: the daemon writes nothing
and returns `conflict` with the current draft. A restore that replaces a
non-empty draft keeps it in history first. F036 is not accepted: there is no
UI, no E2E coverage, and the live draft still does not store context nodes.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `draft.history.list` | query | Newest first, pages of 1 to 100 (default 20) by `before` entry ID. `window_id` is optional, so a closed or crashed window's drafts stay reachable. |
| `draft.history.restore` | idempotent command | Entry from any window of the Conversation into the named window. `expected_revision` must equal the stored revision; `revision` must be greater. A retry that finds the same content at `revision` replies `already_restored`. |
| `draft.stash.save` | idempotent command | Same content converges (`unchanged`). Different content under a taken name needs `expected_revision` equal to the stash revision; otherwise refused. Expecting a dropped stash is refused. At most 50 stashes per Conversation. |
| `draft.stash.list` | query | Most recently saved first. |
| `draft.stash.restore` | idempotent command | Requires the listed `stash_revision`, then the same revision rule as history restore. The stash stays. |
| `draft.stash.drop` | idempotent command | Absent stash converges (`dropped: false`); a replaced stash is refused. |

Other behaviour:

- Restore refuses while the window has a pending or rejected send, as `draft.save` does.
- Restore and stash save validate attachments as live and owned by the Conversation. A restore whose attachment was reclaimed fails and writes nothing.
- `attachment.reclaim.preview` now reports `draft_stash` in `protected_by` when a stash keeps the attachment. History entries do not protect attachments.
- History keeps the newest 100 entries per window. Entry `source` keys (`send:<request_id>`, `draft:<revision>`) keep a replayed event to one entry.
- Tables `draft_history` and `draft_stashes` are created idempotently in the profile state database by `store/drafts.rs`. No migration version changed.
- CLI: `ade draft history|recall` and `ade draft stash save|list|restore|drop`. A `conflict` restore exits with `not_applied`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/store/drafts.rs` (restore revision decision, retry convergence, displacement, stash save and drop decisions, name and context-node bounds); `crates/ade-core/src/contract/conversations.rs` (tiers and schema round trip for the new types).
- A throwaway store smoke test (save, discard, conflict, restore, retry, stash create/unchanged/replace/restore across windows, drop) passed locally and was removed, per the test policy.

Verified only statically: the session dispatch in `sessions/drafts.rs`, the CLI command file, and the send-completion and `draft.save` history hooks in a running daemon.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

- t3code @ ade-evaluation-2026-09-24, `apps/web/src/promptStashStore.ts`, pattern: a stash entry keeps context records beside attachments; bounded entry count. No code copied.
- opencode-v2 @ ade-evaluation-2026-09-24, `packages/tui/test/prompt/draft-stash.test.ts`, studied: per-slot stash taken back explicitly. No code copied.

## Open

- The live window draft does not persist context nodes; restore returns them for the client to reattach. Persisting them needs a companion table or a `drafts` column (a migration the coordinator owns).
- Desktop main and renderer do not call these operations yet; the composer recall/stash UI and its E2E coverage come with UI work.
- Explicit draft transfer between windows works through a stash; a dedicated `draft.transfer` operation is not built.
- Discarded history does not protect attachments from explicit reclaim; recalling such an entry fails closed.
- Backup coverage: the two new tables live in the profile state database; the backup-coverage slice should confirm they are included.
- The new types live in `crates/ade-core/src/contract/conversations/drafts.rs`, a child module of `conversations.rs`, to keep merge conflicts small.
