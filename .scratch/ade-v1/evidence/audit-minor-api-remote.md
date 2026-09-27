# Audit fixes: api-remote

I traced the code for all three findings before fixing them, and each scenario was real. `pnpm check:static` passes.

## 1. A daemon `unavailable` reply tore down a healthy SSH forward

- **Confirmed:** `RemoteDaemonTransport.request` dispatched `link_lost` on any `unavailable` error unless delivery was `rejected`. No daemon sets `pre_admission_rejected`. So a `{type:error, code:'unavailable'}` reply, such as "Browser owner is unavailable", killed the forward.
- **Fix:** `DaemonRequestError` gains a `replied` field. It is true when the daemon sent the error as a reply frame, and `requestDaemon` sets it on error frames only. The new pure decision `requestLostLink` in `packages/client/src/remote-state.ts` treats a link as lost only for `unavailable` with no reply. `remote.ts` uses it. The wire format is unchanged.
- **Test:** `packages/client/src/remote-state.test.mjs`, "a daemon-coded unavailable reply does not count as link loss".

## 2. Remote host readiness depended on a receipt that retention empties

- **Confirmed:** `last_start` in `sessions/placement.rs` read the latest `remote.host.start` receipt that had a non-null result. `receipts::prune` sets `result=NULL` after 30 days, so a running host became Unavailable.
- **Fix:**
  - A new `remote_host_starts` table (host_id, result, settled_at) in `sessions/remote.rs` holds each host's last start.
  - `settle_start` settles the receipt and upserts the row in one transaction.
  - Placement reads the table, and `remote.host.remove` deletes the row.
  - When the table is first created, it is seeded from each host's latest unexpired start receipt, so an upgrade keeps each host's current readiness.
- **Tests:**
  - `sessions::remote::tests::last_start_outlives_receipt_retention`: prunes the receipt at 31 days and checks that the row survives.
  - `start_table_is_seeded_from_unexpired_receipts`.

## 3. `ade remote start` gave up at 30 s, and the retry reply advised a new ID

- **Confirmed:** the CLI used the 30 s default, but `remote.host.start` can run for 105 s (a 45 s probe, then a 60 s start). When the retry found a `dispatched` receipt with no result, the reply told the caller to use a new operation ID, which could start the host twice.
- **Fix:**
  - `apps/cli/src/commands/remote-deadline.ts` gives each call the daemon's budget plus 30 s: `remote.host.add` 70 s, `remote.host.probe` 75 s and `remote.host.start` 135 s.
  - The daemon's replay detail now comes from the pure function `remote::unsettled_start_detail`. It says the attempt may still be running and to retry the same ID after 105 s. Only if the attempt still has no outcome should the caller probe the host and then use a new ID.
  - A compile-time assertion keeps `START_BUDGET_SECS` equal to the probe deadline plus the start deadline.
- **Tests:** `apps/cli/src/commands/remote-deadline.test.mjs` and `remote::tests::unsettled_start_retry_keeps_the_same_operation_id`.

## Known limits

- If the daemon crashes during a start, its `dispatched` receipt is never moved to `unknown`. Every retry then gets the "may still be running" reply, which says what to do when this persists.
- A socket error other than ENOENT, ECONNREFUSED or EACCES (for example ECONNRESET) is still reported as `protocol` and does not dispatch `link_lost`. This is unchanged from before.
