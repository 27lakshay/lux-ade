# Phase 1 review contracts

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-7
Worker: workflow wf_e0896549, Phase 1 typed domains, review worker
Requirements: none (Phase 1 contract typing)

## Outcome

`crates/ade-core/src/contract/review.rs` now types every review operation's
request and reply. The review handlers in `crates/ade-daemon/src/review.rs`
decode typed requests and build typed replies, and `review.feedback.search`
moved out of `sessions.rs` into `review::feedback_search`. Git mutation receipts
moved from the review database's `jobs` table onto `receipts.rs`. Existing `jobs`
rows are copied into `operations` when the database opens. The CLI `git`
commands and the desktop main-process review IPC now send typed requests
through `dailyUseCommand`, which validates each reply with `decodeResponse`.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `review.status` | query | `force` optional; 750 ms shared cache unchanged |
| `review.diff` | query | `staged` optional, default false |
| `review.diff_page` | query | `cursor`, `expected_token` optional; `next_cursor` is null on the last page |
| `review.hunk` | effect command | receipt in `operations` |
| `review.stage` | effect command | receipt in `operations` |
| `review.unstage` | effect command | receipt in `operations` |
| `review.discard` | effect command | receipt in `operations`; `backup_path` recorded before the swap |
| `review.commit` | effect command | receipt in `operations` |
| `review.operation` | query | reads a stored receipt |
| `review.feedback.search` | query | `next_cursor` is null on the last page |
| `git.commit` | none | The daemon has no `git.commit` operation. `review.commit` is the commit. Nothing was added. |

Receipt behaviour:

- `operation_id` is the canonical field. `request_id` is still accepted as a serde alias.
- The daemon computes the fingerprint over the typed request, without the ID.
- A reused ID with the same payload replays the stored operation. A different
  payload fails with "Request ID was used for different parameters". Another
  workspace's ID fails with "Operation belongs to another workspace".
- Receipt states move as follows:
  - `accepted` and `dispatched` when admitted, with the running operation stored as the result;
  - `acknowledged` when a discard records its `backup_path`;
  - `settled` on success or failure;
  - `unknown` (operation `interrupted`) for any receipt still open when the daemon reopens.
- A receipt past 30 days now returns "Request ID has expired; use a new request ID".
  The old `jobs` table never expired.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/review.rs` (schema round trips for every request and reply, the `request_id` alias, tiers)
- A temporary in-process run checked the `jobs` migration, the interruption on reopen, and alias replay. It was removed before the commit.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 10 | 0 |

## References

None.

## Open

- The `jobs` table in `review.sqlite3` is no longer written or read, except for the one-time copy into `operations` when the database opens. The table is left in place for the coordinator to drop.
- `crates/ade-core/src/contract/tests.rs` (shared): I added the ten review operations to the tier list in `every_operation_declares_a_tier_and_named_types`. Other workers' entries will conflict on this list.
- These wire shapes changed or could not be confirmed:
  - A malformed Git mutation, such as a missing `path`, `message` or `hunk`, now fails at once. Before, it created a receipt that later failed. The error text is unchanged: "Missing or invalid <field>".
  - A field with the wrong JSON type now fails with "Invalid request: …". Before, some checks gave their own message, such as "Invalid review search limit", or quietly treated a non-boolean `staged` as false.
  - An explicit `null` for an optional request field now counts as absent.
  - `GitOperation.code` and `recovery` keep "present and null" on failures without a code. That uses a double-`Option`.
  - `GitOperation.result` and `ReviewFeedbackMatch.review_feedback` are typed as `Value` because their shapes vary.
- The desktop and CLI now send `operation_id`. The generated request schema does not list `request_id`, because schemars ignores serde aliases. Clients that bypass `@ade/contracts` can still send `request_id`.
- The desktop checks "Invalid review status" and "Invalid review diff" are gone. A contract failure on those replies now shows as the `dailyUseCommand` protocol error.
