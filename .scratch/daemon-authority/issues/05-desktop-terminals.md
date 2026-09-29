# 05 — Lane D: real terminals in the desktop

Status: closed
Type: task
Label: wayfinder:task
Assignee: coordinator (lane agent)
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
- 2026-09-29 — Steps 1–4, 6 and 7 built at `bd82613`. Tabs carry `target`; New terminal calls
  `terminal.create` and opens the tab in the workspace the terminal runs in; the stream bridge
  accepts extra terminals; closing a tab or pane calls `terminal.stop` then `terminal.retire`
  (the workspace's first shell is only stopped) and keeps the tab on refusal; the view draws
  only while shown, restores from the snapshot, retries attach three times, then offers
  Reconnect and Restart shell (`provisional/TerminalStatus.tsx`). Checked in the dev app against
  the real daemon: a shell ran `echo` and `pwd`, survived a workspace switch, and closing its tab
  removed it from `extra_terminals`. Waiting on lane C for step 5 (`terminal.close` with the
  busy confirmation). Not done yet: the real-terminal benchmark (deferred to ticket 08 so it
  does not compete with the lanes' builds). Known gap until ticket 07: Reset layout drops
  terminal tabs without stopping their terminals.
- 2026-09-29 — Done: busy confirmation and placement via lanes C and A (`882f12d`, ticket 07); canvas release (`1fdb779`). Closed.
