# Audit fix: desktop

## Defect

A Git mutation that the daemon refused before admission left its local outbox
record in place. Examples: `Repository is busy`, `Too many Git operations`,
NeedsRebind, and the lifecycle lock. The record is in `git-intents-v1.json`.
Nothing ever released it, so every later Git operation in the workspace was
refused. The only way out was to retry the refused operation.

## Fix

- `apps/desktop/src/main/git-refusal.ts` is a new pure decider. It releases the
  record only when both of these hold:
  - The send failed with a definite refusal. That means delivery `not_sent` or
    `rejected`, or a daemon error frame with code `daemon`, `invalid_request`,
    `conflict`, `overloaded` or `not_applied`.
  - The daemon then answers `Unknown review operation` for the ID, and
    `review.operation.list` (including acknowledged operations) does not list it.
- The record is kept when any of these happens:
  - timeout
  - socket close (`unavailable`)
  - `protocol`
  - `outcome_unknown`
  - `in_progress`
  - a failed lookup
  - a failed listing
- `apps/desktop/src/main/review.ts` changes:
  - The Git branch of `ade:review-request` catches the send failure.
  - It runs `releaseRefusedGitRecord`, which calls the decider and then
    `gitRecovery().release`.
  - It then rethrows the original error. A failed release keeps the record and
    does not mask the send error.
- `apps/desktop/src/renderer/src/review.tsx` changes:
  - `retryGit` now re-reads the journal after a failure, as `startGit` does.
  - A retry that the daemon refuses before admission now clears the pending
    operation. Before, it stayed stuck on "Unknown review operation".
- No wire or contract change. No daemon change.

## Test

`apps/desktop/src/main/git-refusal.test.mjs` runs in process and is part of the
`check:static` pure-test step. It covers these cases:

- A discard refused with `Repository is busy` while `review.status` holds the
  guard, followed by the lookup answer `Unknown review operation`, releases the
  record.
- Other pre-admission refusals release the record.
- Lost, timed-out or unreadable replies keep the record.
- The record is kept when the daemon knows the ID, lists it, or cannot be asked.

## Checks

- `node --test apps/desktop/src/main/git-refusal.test.mjs`: 5 passed.
- `pnpm check:static`: passed.

## Limits

- A record that is already stuck on disk is cleared the next time the person
  retries it. That happens only if the daemon refuses the retry before
  admission. If the retry is admitted, the operation runs.
- There is no separate "abandon" action. The second option in the audit was not
  built.

References: audit finding on `apps/desktop/src/main/review.ts:238`;
`crates/ade-daemon/src/review.rs` (`command`, `admit`, `review_guard`);
`packages/client/src/request.ts` (`DaemonRequestError` delivery).
