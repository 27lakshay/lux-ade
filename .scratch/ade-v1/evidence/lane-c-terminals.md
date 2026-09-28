# Lane C: terminals as records (daemon-authority ticket 04)

Status: built; `TODO(lane A)` hooks left for tab placement and tab removal.
Branch `claude/agent-a757510279c0b8dab`, rebased on `main` at `69bdf5c`.

## Results

| Check | Result |
|---|---|
| `pnpm check:static` after rebase | passed; 832 Rust tests passed, 5 skipped |
| `e2e/protocol/terminals3` (`ADE_E2E_WORKERS=2`) | 5 passed |
| `reliability-core/envelope` terminal cases, with the new `terminal.close` case | 16 passed |
| Regression run: `terminals`, `terminals2`, `workspaces`, `hooks-auth` | 35 passed, 1 skipped (existing skip) |
| Regression run: `services`, `services2`, `restarts`, `recovery`, `recovery2`, `reliability-a`, `reliability-core`, `backup`, `storage` | 371 passed, 1 skipped |

One renderer test (`command-service.test.ts`, "Frame was detached") failed once in the
first gate run and passed on rerun; it does not touch this lane's code.

## Review fixes (2026-09-29)

| Finding | Fix | Evidence |
|---|---|---|
| 1. `terminal.close` could orphan a live shell restarted between its stop and its retirement | Each round holds `leases` across reading the runtime and stopping or retiring, as `terminal.retire` does. A shell found running again is stopped again, until a 10-second deadline | E2E "a close racing restarts never leaves a shell running without its record" |
| 2. Title and busy changes were written with `synchronous=FULL` under the sessions lock | `Store` keeps live state in memory. Only status, exit code, program and a settled title are written. The feed sends status and busy at once, and a title-only change at most once a second, always ending on the latest title | Unit tests `busy_and_a_running_title_stay_in_memory...`, `the_feed_sends_busy_at_once...`; E2E "an animated title reaches the feed about once a second..." |
| 3. The SDK rejected the whole catalog for an unknown terminal kind or status | The contract gives `kind` and `status` as open strings. The SDK keeps unknown values and drops only a malformed terminal | `catalog.test.mjs`; contract test |
| 4. Without `force`, a command started after the busy check was killed | The runtime's `terminal.stop` gains `if_idle`. The terminal host checks the foreground group under its state lock just before signalling. A command can still start between `tcgetpgrp` and the signal, a window of microseconds | E2E busy refusal now comes from the runtime's check |

Results after the fixes:

- `terminals3`, `terminals`, `terminals2`, `workspaces`, `reliability-core/envelope`, `services/scripts`, `services/recovery` and `restarts`: 131 passed, 1 skipped.
- Every `check:static` step passes: 834 Rust tests passed, 5 skipped.
- The renderer motion test (`motion.test.tsx`, a frame-count assertion) failed twice inside the full gate while the machine load average was about 15. It passed on its own both times. It does not touch this lane's code.
- The race E2E was not run against the code before the fix, so it is unproven that it would have caught the original bug.
- The coordinator accepted decisions 1 to 5. The desktop treats closing a service, script or Conversation terminal's tab as leaving the layout only.

## What was built

- **Records.** Table `terminals(id, workspace_id, data)`, filled from every workspace by
  `store::terminal_records::migrate_terminal_records`, called from a provisional
  `if version < 18` block. The catalog lists `terminals`: `id`, `workspace_id`, `kind`
  (`shell`, `service`, `script`, `conversation`), `title`, `status` (`not_started`,
  `running`, `exited`, `stopped`), `exit_code`, `busy`, `foreground`, `primary`,
  `service_id`, `script_run_id`, `conversation_id`.
- **Derived workspace fields.** Every membership change goes through
  `terminal_records::insert` and `remove`, which rewrite `terminal_id` and
  `extra_terminals` in the same transaction. Store open also backfills records for any
  listed terminal without one.
- **Busy.** The runtime's terminal host reads `tcgetpgrp` on the PTY master
  (`MasterPty::process_group_leader`); busy means the foreground group differs from the
  program's own group. `foreground` is the group leader's name (`proc_name` on macOS,
  `/proc/<pid>/comm` on Linux). The host also follows OSC 0 and 2 titles. The runtime
  reports these in `terminal.list` as `activity`. The daemon reads them on its existing
  250 ms tick, saves changes and publishes `terminal_changed`, so each terminal sends at
  most four updates a second. The E2E checks this bound with about 100 title changes a
  second.
- **`terminal.close`** is an effect command in the envelope. It refuses `terminal_busy`
  with `foreground` unless `force` is set. Otherwise it stops the shell, waits up to 10
  seconds for the runtime to prove the process tree stopped, then retires the record and
  the runtime terminal. Closing the primary shell gives the workspace a new primary shell
  that has not started. The observer reconciles on the record's absence.
- **`terminal.create`** takes an optional `title`: trimmed, 1 to 100 characters, no
  control characters. The title joins the receipt payload only when given, so older
  receipts keep their fingerprint. `place` is refused with the `unsupported` code.
- **CLI:** `ade terminal list [WORKSPACE_ID]` lists the records, keeping `terminal_id` for
  older scripts. `ade terminal close TERMINAL_ID [--force]` closes a terminal, and
  `--title` works on create. New exit codes: 22 for `terminal_busy`, 23 for `unsupported`.
- **SDK:** `Catalog.terminals`, `parseTerminal`, and `terminal_changed` applied to the
  catalog projection. `terminal_busy` and `unsupported` are known refusal codes.

## Decisions to confirm (flagged)

1. Status gains `not_started` for a terminal whose shell has not been attached yet. The
   ticket listed only `running`, `exited` and `stopped`.
2. Kind gains `conversation`, for a Conversation handed to a terminal, with
   `conversation_id`.
3. `terminal.close` supports shells only. Service, script and Conversation terminals are
   refused with a plain message pointing to their own commands. Decision 5 may want
   script tabs to close their script run.
4. A signalled exit reports `exit_code` 128 plus the signal. A stop that ADE requested
   reports `stopped` with no code.
5. The title is chosen in this order: the title given at creation, then the OSC title
   from the program, then the service or script name, then the program name (`zsh`),
   then the kind name.

## Limits of busy detection

- A background job (`sleep 30 &`) is not busy, but closing the terminal still ends it.
- `exec cmd` keeps the shell's process group, so it is not busy.
- A nested shell, `tmux` or `ssh` counts as busy for as long as it runs, even at an idle
  prompt.
- A shell without job control runs its commands in its own group, so they are never
  busy.
- The catalog's `busy` can lag the terminal by up to one tick (250 ms). `terminal.close`
  reads the runtime at the moment it is called instead.

## Hooks for lane A

- `crates/ade-daemon/src/store/terminal_records.rs`, in `remove`: call
  `layouts::remove_target` in the same transaction.
- `crates/ade-daemon/src/store/terminals.rs`, in `create_terminal`: open a tab for
  `place`.
- `crates/ade-daemon/src/sessions/terminals.rs`, in `terminal.create`: remove the
  `unsupported` refusal of `place`.

## For the coordinator at merge

- Renumber the provisional schema 18. `bin/control/backup/coverage.rs` also says 18.
- Code from any lane that adds or removes a workspace terminal must call
  `terminal_records::insert` or `remove`. If it edits `extra_terminals` directly, the
  next `derive` drops that terminal.
- Shared files this lane touched additively: `ade-core/src/error.rs`, the `Catalogue` in
  `model.rs`, the `contract/tests.rs` catalog literal, `store/bindings.rs` (workspace
  creation, catalog, removal), `services.rs`, `envelope.rs` (`OPERATIONS` has 23
  entries), and the CLI exit codes.
