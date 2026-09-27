# storage-errors

Status: returned
Type: slice evidence
Branch: claude/wf_ead686db-a2b-4
Worker: workflow wf_ead686db, worker a2b-4 (slice storage-errors)
Requirements: R002 (advanced across backup and restore; not accepted), R004 (truthful storage refusals; not accepted), R014 and F050 (backup coverage)

## Outcome

Storage failures are now reported as what they are. Only a real `SQLITE_FULL` or
`ENOSPC` gives "lux-ade could not save these changes. Check available disk
space..." (code `save_failed`). A busy or locked database is `storage_busy`; an
unwritable data folder, a damaged file and any other storage error each have their
own code. Backups now copy the two receipt stores outside the profile database, so
a retried operation ID replays after a restore instead of running again. No
requirement is fully accepted by this slice.

### The incident's cause

The false "check disk space" in `orchestration/parallel-runs.spec.ts` came from the
orchestration transactions. They opened with a deferred `BEGIN`, read the receipt
table, then wrote. In WAL mode, SQLite refuses that read-to-write upgrade at once
with `SQLITE_BUSY` when another connection is writing. It does not run the busy
wait. Several daemon modules keep their own connections to `sessions.sqlite`, so
this happens under load. `persistence_result` then mapped every `rusqlite::Error`
to `Failure::SaveFailed`, whose message blames the disk.
`sessions::failure_tests::a_write_transaction_waits_for_the_lock_a_deferred_upgrade_cannot`
reproduces the immediate refusal.

### Changes

1. `ade_core::error::StorageFailure` (pure core): `classify(sqlite_code, errno)`
   returns `Full`, `Busy`, `Unwritable`, `Corrupt` or `Failed`. Each class has a
   stable code and recovery hint, and `error_envelope` sends them. `Full` keeps
   the `save_failed` code, the `check_storage` recovery and the old wording.
   | Class | Source | Code | Recovery |
   |---|---|---|---|
   | Full | `SQLITE_FULL`, `ENOSPC` | `save_failed` | `check_storage` |
   | Busy | `SQLITE_BUSY*`, `SQLITE_LOCKED*` | `storage_busy` | `retry` |
   | Unwritable | `SQLITE_READONLY`, `PERM`, `CANTOPEN`, `AUTH`, `EACCES`, `EPERM`, `EROFS` | `storage_unwritable` | `check_data_folder` |
   | Corrupt | `SQLITE_CORRUPT`, `SQLITE_NOTADB` | `storage_corrupt` | `restore_backup` |
   | Failed | any other SQLite or library error | `storage_failed` | `retry` |
2. `store::storage_failure` classifies an error chain. `persistence_result` uses it
   in place of the blanket `SaveFailed`. It still hides SQL text, values and paths.
3. `store::begin_write` opens every store write transaction with `BEGIN IMMEDIATE`,
   where the busy wait applies. It retries once more on busy, which is safe because
   nothing has run inside the transaction yet. `Store::transaction` and the
   orchestration transactions (`delegate`, `group.start`, `peek` and the others in
   `sessions/orchestration.rs`) use it.
4. The orchestration admission step (schema creation and the receipt probe) now
   runs under `persistence_result`. Before, a busy database there leaked the raw
   "database is locked" text with no code.
5. Diagnostics keep the new codes (`ade-platform` diagnostics allowlist).
6. Backup format 7 backs up `sessions.envelope.sqlite3` and
   `browser-operations.sqlite3`:
   | Store | Disposition | Why |
   |---|---|---|
   | `sessions.envelope.sqlite3` | backed_up | Effect receipts of enveloped commands. A retried ID replays; an open one settles as not applied or unknown when the restored daemon opens. |
   | `browser-operations.sqlite3` | backed_up | Browser mutation receipts. A retried ID replays; an open one reopens as unknown. |

   Neither can be rebuilt from other data, and excluding either breaks R002.
   Restore still reads formats 2 to 6; format 6 keeps its own coverage list
   (`COVERAGE_V6`). A bundle without a receipt store restores with an empty one,
   as before. A format-6 manifest that claims a receipt store is refused. The
   unpublished-restore check (`resume`) also checks both stores' schema.

## Operation tiers

No operation was added and no tier changed. `notification.preferences.set`
(idempotent command), `orchestration.group.start` and `orchestration.delegate`
(effect commands) now report storage failures by class.

## Checks

- `pnpm build:backend && pnpm build`: pass
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only storage backup orchestration/parallel-runs.spec.ts orchestration/delegation`: 28 passed
- `pnpm check:static`: pass (804 Rust tests)
- New protocol E2E:
  - `e2e/protocol/storage/busy.spec.ts`: a test connection holds the write lock on
    `sessions.sqlite`. `notification.preferences.set` and `orchestration.group.start`
    are refused as `storage_busy` with `retry`, with no word about disk space and
    nothing saved. The same request then succeeds, and the group runs once under
    its operation ID.
  - `e2e/protocol/storage/receipts-backup.spec.ts`: a live backup of a profile with
    a `browser.open` and an `account.create` receipt is format 7 and covers both
    stores. The profile loses its data directory and is restored in place. Both
    retries replay the recorded reply, the browser owner is not reached again, no
    second account appears, and altered payloads conflict. A format-6 bundle
    without the stores inspects and restores. A format-6 bundle claiming one is
    refused.
- Updated: `e2e/protocol/backup/restore.spec.ts` and `backup/secrets.spec.ts` expect
  format 7.
- In-process tests added:
  - `crates/ade-core/src/error.rs` `storage_tests` (classification, codes, envelope)
  - `crates/ade-daemon/src/sessions.rs` `failure_tests`: a real `SQLITE_FULL` via
    `max_page_count`, busy retry then `storage_busy`, and the deferred-upgrade cause
  - `crates/ade-daemon/src/bin/control/backup/coverage.rs`
    `format_7_backs_up_both_receipt_stores_and_format_6_still_reads`

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 15 | 0 |

## References

None.

## Open

- The real full-disk path is not in this slice's E2E. `reliability-a/overload.spec.ts`
  covers it behind `ADE_E2E_SYSTEM=1`, which uses `hdiutil`, and this slice did not
  run it. That spec matches the raw SQLite text "database or disk is full". It
  comes from operations that do not use `persistence_result`, such as
  `conversation.create`. Those still send raw SQLite text with no code.
- Outside this area, not fixed: `worktrees.rs` `probe` opens a deferred transaction
  and `receipts::begin` writes in it. It can hit the same immediate busy refusal
  when a second connection writes to `lifecycle.sqlite3`.
- SDK and CLI: `packages/client/src/request.ts` `daemonRefusalCodes` and the CLI
  exit-code table do not list the new `storage_*` codes. The SDK keeps them as
  sent, and the CLI exits 7 for them.
- The coordinator may want to record backup format 7 in `decisions.md` (D15).
