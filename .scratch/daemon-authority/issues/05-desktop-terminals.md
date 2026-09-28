# 05 — Lane D: real terminals in the desktop

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [01](01-phase-0-foundation.md)

Coordinator's lane, in `apps/desktop`, while lanes A–C build. It works on today's local layout
store; ticket 07 moves the same data to the daemon.

## Build

1. **Tab targets.** Local tabs gain `target: TabTarget` from `@ade/contracts`. The benchmark's
   tabs get synthetic targets. The title shown comes from the target when it has a record.
2. **New terminal.** "New terminal" calls `terminal.create` for the shown workspace and opens a
   tab on the new terminal's ID. The workspace's primary shell opens through the same path.
3. **Stream bridge.** Accept any terminal the catalog lists for the workspace, not only
   `terminal_id` (`src/stream-bridge/index.ts`).
4. **Terminal content.** The real Ghostty view bound to the stream: attach, restore from the
   daemon's snapshot, input, resize ownership, and reattach after a stream loss. Hidden
   terminals follow `keepTerminals`: detached and released beyond it, restored from the snapshot
   when shown again.
5. **Close.** Closing a terminal tab calls `terminal.stop`, then `terminal.retire`. After lane C
   merges, it calls `terminal.close` instead and shows its `terminal_busy` refusal as a
   confirmation naming the running command.
6. **Exited terminals** show their exit code and a Restart action (`terminal.restart`).
7. **Surfaces without a Pen design** (the exited state, the busy confirmation) use stock kit
   components under `provisional/`.

## Acceptance

- Vitest browser tests: a terminal tab attaches, renders a snapshot, takes input, survives a
  workspace switch, and closes; closing a busy terminal asks first.
- In the dev app against the real daemon: open three terminals, run `ls` and `sleep 30`, switch
  workspaces and back, close the busy one with confirmation.
- The four-workspace benchmark rerun with real terminals: workspace switch holds 60 fps.

## Comments
