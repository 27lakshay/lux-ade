# 04 — Lane C: terminals as records

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [01](01-phase-0-foundation.md)

Today a workspace carries `terminal_id` and a flat `extra_terminals` list; a client cannot tell
what a terminal is, whether it has exited, or whether something is running in it. Make each
terminal a record, and make closing one a single daemon rule.

## Build

1. **Terminal records in the catalog:** `id`, `workspace_id`, `kind` (`shell`, `service`,
   `script`), `title` (the shell's title, else the command), `status` (`running`, `exited` with
   code, `stopped`), `busy`, `primary` (the workspace's first shell), and `service_id` or
   `script_run_id` when it has one. Keep `terminal_id` and `extra_terminals` on the workspace for
   one release, derived from the records, then remove them in ticket 08.
2. **Busy.** The runtime's terminal host reports the PTY's foreground process group
   (`tcgetpgrp` on the master); busy means it is not the shell's own group. Report the foreground
   command name with it. Changes reach the feed, debounced to at most 4 per second per terminal.
3. **`terminal.close`** (effect command): `{operation_id, terminal_id, force?}`. Refuses with
   `terminal_busy` (carrying the foreground command) when busy and not forced; otherwise stops
   and retires the terminal. Once lane A has merged, the same transaction removes the terminal's
   tabs through `layouts::remove_target`; until then, leave a `TODO(lane A)` marked hook.
4. **`terminal.create`** gains an optional `title`, and an optional `place: {window_id,
   pane_id?}` that opens a tab for the new terminal in that window's layout in the same operation
   (after lane A merges; refuse `place` with `unsupported` before then).
5. **CLI**: `ade terminal list`, `ade terminal close [--force]`, and `--title` on create.

## Acceptance

- `e2e/protocol/terminals3/`: a shell is idle, `sleep 30` makes it busy and names `sleep`,
  close is refused while busy and succeeds with `force`, an exited shell reports its code, and
  records survive a daemon restart.
- After lane A: `terminal.create` with `place` opens the tab; `terminal.close` removes it from
  every layout.
- Evidence in `.scratch/ade-v1/evidence/lane-c-terminals.md`.

## Comments
