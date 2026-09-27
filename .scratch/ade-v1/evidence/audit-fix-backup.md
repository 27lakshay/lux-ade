# Audit fix: backup

All changes are in `crates/ade-daemon/src/bin/control/backup.rs`.

## 1. Restored profile inherited the source profile's runtime records

- **Defect:** `fence()` copied `runtime_incarnations`, `runtime_attempt_records` and
  `runtime_recovery_reports` unchanged. The restored daemon found the source's
  unreconciled incarnation, attributed the private workspace's leases and the terminal
  records to runtime restart reconciliation, and quarantined them while the source
  profile ran.
- **Fix:** `fence()` deletes the rows of those three tables when they exist. With no
  earlier incarnation, `recovery_context` returns `None` and leases take the ordinary
  path: an Agent lease the fresh runtime does not report is released as absent, and
  `recover_except` interrupts a busy Conversation and pauses its queue. A restored
  service's run reservation named the source runtime instance, which the ordinary path
  holds as uncertain forever. `fence()` now clears each service's `terminal_owner` and
  `launch_peers` through `release_service`, so the restored service starts stopped.
- **Test:** `restored_service_does_not_keep_the_source_runtime_run`.

## 2. Restored daemon auto-sent queued prompts

- **Defect:** `fence()` held only send intents. An idle Conversation with queued prompts,
  such as an orchestration child in the private workspace, was dispatched by
  `dispatch_queued` in the restored profile while the source sent the same prompts.
- **Fix:** `fence()` sets `queue_paused=true` on every Conversation that has a
  `status='queued'` row, through `hold_queue`. It adds an error that starts with
  `Prompt queue paused:` only when no error is set, so `queue.pause` with
  `paused=false` clears it when the user continues the queue.
- **Test:** `restore_pauses_only_queues_that_hold_prompts`.

## 3. Online SQLite backup had a fixed 30 s deadline and throttled copy

- **Defect:** `snapshot()` copied 128 pages per step, slept 25 ms after each, and failed
  after 30 s. A database over about 600 MB always failed, and daemon writes restarted
  the copy between steps.
- **Fix:** `step_pages` copies the whole database in one step (`-1`), under one read
  transaction, so writes cannot restart it. The copy sleeps only on `Busy` or `Locked`.
  `backup_deadline` allows 30 s plus 1 s per 8 MiB of the database and its WAL. The
  armed E2E pause still steps one page at a time until it holds.
- **Test:** `online_copy_takes_the_whole_database_in_one_step_with_a_size_bound_deadline`.

## Checks

- `node scripts/cargo.mjs test -p ade-daemon --bin ade-control backup`: 16 passed.
- `pnpm check:static`: passed.

## Not verified

- No restore was run against a live source profile; the E2E suite is not a gate now.
- Copy throughput on a large real profile was not measured.
