# Phase 2 outbox-daemon

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-1
Worker: workflow wf_8cf324d1, Phase 2, outbox-daemon worker
Requirements: advances R001, R002, R005, F036 and F075; partial groundwork for F103 (ticket 10, part 1). None is fully accepted.

## Outcome

The daemon now answers, without any client journal, which sends a window still
has open across Conversations and which reviewed Git mutations a workspace still
has running or interrupted. It also settles each one on acknowledgement.
Sends are backed by the existing `send_intents` table and the `messages` table.
Git operations are backed by the review database's `operations` receipts, plus a
new `operation_acknowledgements` table in that same database. `state.sqlite`
needed no migration, so version 18 is unused. The Electron journals and
`@ade/client` are unchanged.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `draft.send.list` | query | `window_id`, optional `after` cursor (Conversation ID) and `limit` (1 to 200, default 50). Each entry carries the intent and an `outcome`: `prepared`, `accepted`, `rejected`, `held` or `conflict`. The reply also carries `restored_from_backup` and `next_cursor`. |
| `draft.send.acknowledge` | idempotent command | Takes `conversation_id`, `window_id` and `request_id`. `accepted` completes the send, clearing the draft; `rejected` aborts it, keeping the draft text. A repeat returns the same resolution with the current draft. `prepared` is refused: retry delivery with the same ID. `held` returns `restored_send_held`. `conflict` is refused. The operation never dispatches a prompt. |
| `review.operation.list` | query | `workspace_id`, optional `include_acknowledged`. It lists running operations and unacknowledged interrupted ones for the workspace's Git root, newest first, capped at 100 with `truncated`. |
| `review.operation.acknowledge` | idempotent command | `workspace_id` and `operation_id` (the `request_id` alias is accepted). Only an interrupted operation can be acknowledged. A repeat returns the first `acknowledged_at`. Running and settled operations are refused. The receipt stays `unknown`, so the ID still never runs again. |

## Checks

- `pnpm check:static`: pass.
- In-process tests added:
  - `crates/ade-daemon/src/store/send_outbox.rs`: classification, the acknowledgement decision and the page bound.
  - `crates/ade-daemon/src/review/outbox.rs`: the list filter and the acknowledgement decision.
  - `crates/ade-core/src/contract/conversations.rs` and `crates/ade-core/src/contract/review.rs`: schema round trips and tiers.
- Temporary store-level runs exercised the SQL paths, then were removed before the commit:
  - sends: prepared, accepted, completed, rejected, aborted and held, plus paging across two Conversations;
  - Git: running, then interrupted after reopen; another root; a settled operation; acknowledgement and a repeat; `include_acknowledged`.
- Verified only statically: the socket routing in `sessions.rs` and `review.rs`, the error envelopes returned to callers, and the generated TypeScript types.

## Needs E2E later

- A desktop relaunch that finds its pending prompts through `draft.send.list` instead of `pending-sends-v1.json`.
- A daemon killed during a Git mutation, then the interrupted operation listed and acknowledged from the UI.
- A backup restore whose held sends list as `held` and refuse acknowledgement.
- Retiring the `send-journal-transfer` spec and the journal-field assertions in `desktop-send-recovery` once the client migrates.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 40 | 5 | 15 | 0 |

## References

- None of the reference repos was used. `.scratch/parallel-build/research/08-reference-map.md` has no row for the send or Git outbox. The design follows `.scratch/parallel-build/research/06-client-journals.md`, option C.

## Open

- The client migration (ticket 10, part 2) should replace the Electron journals' post-admission records with these operations and keep only a pre-admission outbox.
- The daemon does not enforce one unacknowledged Git operation per workspace. The Electron journal still does.
- `restore_hold` is never cleared by any daemon path, so a held send stays listed as `held` until some reconciliation operation exists.
- Coordinator: no shared-file changes are needed. No `state.sqlite` migration was used.
