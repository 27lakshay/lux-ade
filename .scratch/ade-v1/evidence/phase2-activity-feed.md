# activity-feed

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-4
Worker: Phase 2 parallel build, round B, slice activity-feed
Requirements: F117 (activity feed, backend), F114 (desktop notifications, backend and Electron main delivery), 10-S03 (no repeat notification on reconnect); architecture section 9 (notifications originate from durable activity identities)

## Outcome

The profile state database now records durable activity in the same
transaction as the event it describes. `Store::commit_conversation` records a
completed, failed or interrupted turn, and a new approval or question request.
`Store::recover_except` records an `operation_unknown` activity for a turn lost
to a daemon restart. A submission interrupted before it was confirmed also
records `operation_unknown`. Each record has a unique source key, so replaying
the same event records nothing new.

New typed operations list activity with a cursor, mark it read or dismissed,
and keep delivery records for notifications. After each commit, the feed
publishes an `activity_changed` frame. The 250 ms monitor also publishes any
activity committed on a path that does not publish.

Electron main presents a native notification for new unread activity only when
no window is focused. It first claims the delivery from the daemon, so each
activity is presented at most once. It then reports what the OS said: `shown`
on the `show` event, `failed` on the `failed` event or when notifications are
unsupported, and `suppressed` when a window is focused. A claim with no report
stays `claimed`, which means the outcome is unknown. Nobody presents that
activity again. On every connect or reconnect, Electron main reads the unread
activity and passes it through the same claim, so a reconnect cannot repeat a
delivery that was already handled.

No requirement is fully accepted. F114, F117 and 10-S03 still need E2E and UI
evidence.

## Operation tiers

| Operation | Tier |
|---|---|
| `activity.list` | query |
| `activity.mark` | idempotent command (read and dismissed only move forward) |
| `notification.delivery.claim` | idempotent command (one holder; the holder's retry converges) |
| `notification.delivery.report` | idempotent command (holder only; the outcome is final; a repeat converges) |
| `notification.delivery.list` | query (lists failed deliveries for inspection) |
| Frame `activity_changed` | feed frame |

None of these is an effect command. The OS notification is the effect. It is
protected by the durable claim: a claim is never re-granted to another client,
and nothing ever replays it.

## Storage

- `activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id UNIQUE, source_key UNIQUE, state, data)` and
  `notification_deliveries(activity_id REFERENCES activity(id), channel, status, updated_at, data)`.
  Both tables live in `state.sqlite`.
- `store::activity::ensure` creates them with `CREATE TABLE IF NOT EXISTS` before
  first use. The slice adds no migration and changes no version pin.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, JS pure tests, strict Clippy, legacy Rust tests).
- In-process tests added:
  - `crates/ade-daemon/src/store/activity.rs` (`#[cfg(test)]`): which status
    changes record activity and with which source key, how cancelling and
    connecting are excluded, request classification, detail bounding, forward-only
    read state, the claim grant rule, and the report transition rule.
  - `crates/ade-core/src/contract/activity.rs` (`#[cfg(test)]`): wire round trips.
  - `apps/desktop/src/main/notification-policy.test.mjs`: the present, suppress and
    skip decisions, and the bounded set of handled activity IDs.

### Verified only statically

- The SQL paths: recording activity inside `commit_conversation` and
  `recover_except`, list paging, marking, claim and report. These were checked by
  type checking and by the existing store tests still passing. No test drives the
  new SQL directly.
- The feed flush and the `activity_changed` frame on a live subscription.
- The Electron `Notification` wiring: claim, then show, then report on `show` or
  `failed`; click focuses the window and marks the activity read; catch-up on
  reconnect.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `orca/src/main/notifications/notification-delivery-service.ts`: pattern. Suppress when focused, report delivery outcomes, and never report macOS delivery as successful without evidence.
- Orca, `orca/src/main/notifications/announced-notification-registry.ts`: pattern. A bounded record of announced IDs, used by `rememberHandled`.
- Electron Notification API docs (electronjs.org, fetched 2026-09-27): `show` and `failed` events, the `id` option, and `isSupported`. An unsigned macOS build emits `failed`.
- No code was copied.

## Open

- **Service failed** activity is not recorded yet. A service run's exit lives in
  runtime terminal metrics, not in a state-database transition. It needs a
  durable service-exit record to hook into first.
- **Other unknown operations** are not recorded yet: review and git receipts in
  `review.sqlite3`, browser receipts (in memory), and uncertain session leases.
  The review database cannot share a transaction with `state.sqlite`, so it needs
  a durable phase plus reconciliation (architecture section 10).
- Notification preferences and snooze (spec decision 3) are not built yet.
  Suppression currently covers window focus, activity older than 10 minutes, and
  hidden E2E windows only.
- Deep navigation to the target resource is renderer work for the UI phase. A
  click currently focuses the window and marks the activity read.
- There is no activity retention or pruning yet. The tables grow without bound.
- No CLI command module was added, to avoid editing `apps/cli/src/index.ts`. The
  new operations work through `ade request activity.list '{}'`.
- E2E (UI phase): F114, F117 and 10-S03 as described in the spec's
  feature-acceptance table.
- Shared files: none need changing. The coordinator's `activity` domain entry in
  `contract/mod.rs` was already present.
