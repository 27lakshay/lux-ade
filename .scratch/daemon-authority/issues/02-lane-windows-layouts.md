# 02 — Lane A: windows and layouts in the daemon

Status: closed
Type: task
Label: wayfinder:task
Assignee: coordinator (lane agent)
Blocked by: [01](01-phase-0-foundation.md)

Move windows, layouts, panes and tabs into the daemon, so any client can read and drive what a
window shows. The desktop's current model is the reference behaviour:
`apps/desktop/src/renderer/src/features/workspace/model/` (`layout.ts` for the shape,
`layout.logic.ts` and `layout-tree.ts` for the rules, `layout.logic.test.ts` and
`layout.property.test.ts` for the invariants).

## Build

1. **Pure layout core** in `crates/ade-core/src/layout/`: the `Layout` record and an
   `apply(layout, action) -> Result<Layout>` that matches `layout.logic.ts` for every action in
   today's `LayoutAction`: `swapSidebars`, `toggleSide`, `setCollapsed`, `setWidth`, `openTab`,
   `activateTab`, `closeTab`, `moveTab`, `dropTab`, `splitPane`, `movePane`, `swapPanes`,
   `dockTab`, `dockPane`, `closePane`, `focusPane`, `setSplitSizes`, `toggleMaximize`,
   `equalizeSplits`, `resetLayout`. A tab carries a `TabTarget` instead of a kind and title.
   Callers supply every new ID (`newPaneId`, tab IDs), so applying the same action twice gives
   the same result.
   - Port the TS example tests as JSON vectors under `crates/ade-core/tests/layout-vectors/`
     (`{before, action, after}`); both the Rust core and, until ticket 07 deletes it, the TS
     reducer run them.
   - Port the property invariants with proptest: every pane reachable, every tab in exactly one
     pane, split sizes sum to 100, focused pane exists, maximized is focused or null.
   - Structural limits only: the daemon knows no pixels. Minimum sizes and room rules stay in
     the desktop.
2. **Records and storage.** A `windows` table (`id`, `workspace_id`, bounds, `state`, view state:
   collapsed project IDs, recent workspace IDs) and a `layouts` table keyed by
   `(window_id, workspace_id)` with `revision`. Removing a workspace deletes its layouts; a
   window showing it moves to another workspace (the first by project and name) in the same
   transaction.
3. **Operations** (contract `layout.rs`):

   | Operation | Tier | Does |
   |---|---|---|
   | `window.list` | Query | Windows with their state |
   | `window.create` | Idempotent command (caller ID) | A window on a workspace, with a default layout |
   | `window.close`, `window.reopen` | Idempotent command | Keep the record; closed windows restore on reopen |
   | `window.set_bounds` | Idempotent command | Position and size |
   | `window.show_workspace` | Idempotent command | Which workspace the window shows; updates `recent` |
   | `window.set_view_state` | Idempotent command | Collapsed projects |
   | `layout.get` | Query | One window's layout for one workspace, with revision |
   | `layout.apply` | Idempotent command | One action; optional `expected_revision` refuses with `layout_conflict` when stale; replies with the new layout and revision |
   | `layout.replace` | Idempotent command | Whole layout (reset, and the one-time import of localStorage layouts) |

   Replace the legacy `window.save` and `window.close` from ticket 01.
4. **Feed.** Window and layout changes reach subscribers through the durable feed, with the
   revision, so a second client and the desktop stay current.
5. **Tab targets.** `openTab` refuses a target that does not exist in the catalog
   (`tab_target_missing`). When a terminal is retired or a conversation deleted, its tabs leave
   every layout in the same transaction (lane C calls the hook this lane exposes:
   `layouts::remove_target(tx, target)`).
6. **CLI.** `ade window list|create|close|show`, `ade layout get`, and
   `ade layout apply --action <json>`, plus `ade tab open <kind> <id> [--pane]`,
   `ade tab close <tab-id>`, `ade pane split <pane-id> --direction row|column`.

## Migrations

Write the schema change as a named function in this lane's own module and call it from a
provisional `if version < 18` block in `store/migrations.rs`. The coordinator assigns the final
number when merging.

## Acceptance

- `e2e/protocol/layouts/` drives every action through the SDK and the CLI and reads the layout
  back; a replayed `layout.apply` gives the same revision; a stale `expected_revision` is refused.
- Layouts survive a daemon restart; removing a workspace moves its windows and deletes its
  layouts.
- The shared JSON vectors pass in Rust.
- Evidence in `.scratch/ade-v1/evidence/lane-a-layouts.md`.

## Comments
- 2026-09-29 — Done: layout core, windows and layouts in the daemon, feed frames, CLI (`0eb446a`–`b6b1d04`); review fixes: `tab.close`/`pane.close` effect commands, explicit toggle state, last-tab counted across windows, layout revisions on windows (`80991fd`, `3f6bc41`). Evidence: `.scratch/ade-v1/evidence/lane-a-layouts.md`.
