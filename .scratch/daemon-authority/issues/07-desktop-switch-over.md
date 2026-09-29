# 07 — Desktop switch-over

Status: closed
Type: task
Label: wayfinder:task
Assignee: coordinator and a sub-agent
Blocked by: [02](02-lane-windows-layouts.md), [03](03-lane-catalog-workspaces.md), [04](04-lane-terminal-records.md), [05](05-desktop-terminals.md)

Move the desktop onto the daemon's records and delete what it no longer owns. Each part can
start as soon as its lane has merged.

## Build

1. **Onto lane B:**
   - The navigator groups by `project_id` and reads `kind`, `branch`, `default`, `attention` and
     `unread` from the catalog. Delete `conversationState` and the name fallback.
   - Hide "Remove from ADE" on the default workspace; show "Delete worktree" only when
     `kind` is `linked_worktree` and `ade_owned`.
   - New workspace and Delete worktree call `workspace.create_worktree` and
     `workspace.delete_worktree`; delete `main/workspace-actions.ts`'s chain and poll (the
     blocker wording stays).
   - Review feedback calls `review.feedback.send`; delete the prompt building in `review.ts`.
   - Appearance and motion read and write `settings`; main keeps only a startup copy.
2. **Onto lane A:**
   - Main opens one native window per open `window` record on start, creates records for new
     windows, and reports bounds with `window.set_bounds`. The renderer's window identity is the
     record ID in its URL.
   - The renderer subscribes to its window and the shown workspace's layout, and renders them.
     Gestures stay local until they end, then send one `layout.apply`: tab and pane drops,
     resize release, sidebar width release, open, close, focus.
   - Delete `layout.logic.ts`, `layout-tree.ts`'s mutating helpers, the localStorage
     persistence and main's `selectedWorkspaces`. Keep `hasRoomFor` and the fit rules as
     pre-checks.
   - On first connect, import each localStorage layout with `layout.replace`, then delete the
     local keys.
   - Navigator collapse and recent workspaces use window view state.
3. **Onto lane C:** terminal tabs close through `terminal.close`; new terminals use
   `terminal.create` with `place`.
4. **Measure** drop-to-paint on the reference machine. If p95 exceeds 16 ms, add optimistic
   local apply checked against lane A's JSON vectors (decision 1's fallback).

## Acceptance

- The desktop's renderer tests pass against a fake daemon that applies layouts through the
  lane A vectors.
- In the dev app: everything the navigator and panes did before still works; a layout changed
  with `ade layout apply` appears in the open window within a frame of the feed update.
- No `localStorage` use remains except per-viewer conveniences (none planned).

## Comments

- 2026-09-29 — Done. Part 1 (lane B's fields, worktree commands, settings) at `f9c14fe`; parts 2–4
  (windows and layouts from the daemon, `tab.close`/`pane.close`, `terminal.create` with `place`,
  one-time import, reducer kept only as a test/bench double behind `ade/no-layout-double`) at
  `f800afe`–`d8eca07`; guide updated at `b7afe16`. Drop-to-paint p95 9.4 ms on a debug daemon, so
  no optimistic apply. Checked in the dev app: the window record and imported layouts arrived; the
  CLI split a pane and opened a live terminal (`ade pane split`, `ade terminal create`,
  `ade tab open`) and the window showed both; `ade tab close` closed it. Review fencing now reads
  the window record, which also covers ticket 10 step 4. Review feedback still goes through main's
  old path until ticket 10 step 3.
