# Ticket 07, parts 2 to 4: the desktop on the daemon's windows, layouts and terminals

Status: built. Branch `claude/agent-a00dbaa6f86c5e8cc`, rebased once on `main` at `f9c14fe`
(lane B and the coordinator's lane B desktop commit). Part 1 (lane B's desktop fields) is the
coordinator's and is not in this branch.

## Results

| Check | Result |
|---|---|
| `pnpm check:static` on HEAD after the rebase | See the report; run once, as the coordinator asked |
| Renderer tests (Vitest, Chromium) | 42 files, 311 tests pass |
| Layout double against lane A's shared vectors | 162 vectors pass (`dev/layout-double/reducer.test.ts`); a mutation of `insertBeside` fails them |
| SDK tests | catalog windows and window, layout and removal frames: pass |
| Lint rule `ade/no-layout-double` | reports an import of the double; its own test passes |
| Real app, before the rebase (scratch daemon, built app, hidden window, own ports 9433/9434) | see "In the running app" |

## What was built

- **SDK** (`packages/client/src/windows.ts`): the catalog parses `windows`; `window_changed`
  replaces a window, `layout_changed` raises `Window.layouts[workspace]` (never lowers it), and
  `layout_removed` drops it. So main's catalog always names each layout's latest revision.
- **Main** (`main/windows.ts`, `main/layouts.ts`, `main/daemon-call.ts`):
  - At start it waits up to 4 s for the daemon, then opens one native window per open record.
    With none open, it reopens the last closed record whose workspace still exists, else creates
    one (`window-<uuid>`) on the first workspace. If the daemon does not answer in time, it opens
    one window without a record and gives it one when the daemon connects
    (`ade:window-id-changed`). A profile switch rebinds every native window the same way.
  - Bounds go to `window.set_bounds` 400 ms after a move or resize ends (`getNormalBounds`).
    Electron keeps only fullscreen and maximized state, by the record ID.
  - Closing a native window calls `window.close`; quitting does not, so the windows reopen.
  - Every layout request acts on the sender's own record; the renderer never names a window.
    Refusals the window acts on (`layout_conflict`, `terminal_busy` with `terminals`,
    `tab_close_required`, ...) come back as values, because an error thrown across IPC keeps only
    its message.
  - `selectedWorkspaces` is gone. Review and feedback fencing reads the window record's
    `workspace_id` from the catalog, with an epoch that grows on each switch
    (`selectedWorkspace(senderId)`). `workspaces.select` and its IPC channel are gone.
  - `terminal.create` carries `place: {window_id, pane_id}`; `ade:terminal-close` is gone.
- **Renderer**:
  - `model/layout.ts` uses the contract's types (`focused_pane`, tabs `{id, target}`). A tab's kind
    and title come from its target (`model/tab-title.ts`: the catalog's conversation or terminal
    title).
  - `model/layout-store.ts` holds `window` (from the catalog), `records` (layout records by
    workspace, kept only at a higher revision) and `pending` (a workspace just chosen, shown at
    once until the record catches up). Every change is `layout.apply`; toggles send the state they
    reach; `move_pane`, `swap_panes` and `dock_pane` carry `expected_revision`, and a
    `layout_conflict` reads the layout again and says so.
  - `model/layout-sync.ts` feeds the store: records from `layout_changed` frames and from command
    replies; a kept workspace whose held revision is below the catalog's `Window.layouts` is read
    again with `layout.get` (and after a reconnect, any that differ).
  - Gestures stay local until they end: drag previews, live split and sidebar resizes. A released
    sidebar width keeps what the hand left while the reply is on its way (`useSidebarPanels`
    follows the layout's width only when it changes), and split sizes are normalised to sum to 100
    before they are sent.
  - `panes/room.ts` keeps the room pre-check without a reducer: it builds only the shape an action
    leaves (which panes, holding which tabs, side by side or stacked) and measures its minimum.
  - Closing: `tab.close` and `pane.close`; on `terminal_busy` the existing confirm names the
    command and the close is sent again with `force`. The old client-side loop over
    `terminals.close` is gone.
  - A new terminal is one `terminal.create` with `place`; its tab arrives with the layout change.
  - Navigator collapse is `window.set_view_state`; the kept (recent) workspaces are the record's
    `recent_workspaces`. `useWorkspaceSync` is gone: the daemon moves a window off a removed
    workspace.
  - "Open browser" names a `browser-<nanoid>` target: browser tabs have no daemon records until
    ticket 09, and the daemon does not check browser IDs.
  - `usehooks-ts` was only used for the navigator's localStorage and is removed.

## The layout reducer: kept only as a test and bench double

The app has no layout reducer: `layout.logic.ts`, `layout-schema.ts`, the tree's mutating helpers
and the localStorage persistence are deleted. A wire-shaped port of the reducer survives under
`renderer/src/dev/layout-double/` because:

- the renderer tests need a daemon that applies layouts (the ticket's acceptance), and
- `?bench` uses synthetic tab targets the real daemon refuses (`tab_target_missing`).

It runs lane A's 162 shared vectors, so it cannot drift from the Rust core, and the lint rule
`ade/no-layout-double` refuses an import of it anywhere but tests, `dev/` and the test harness.
The production bundle does not contain it. `layout.logic.test.ts` and
`layout.property.test.ts` are deleted: the vectors came from them, and the Rust core has the
property tests.

## The one-time import (`model/layout-import.ts`)

- Runs once on start when `ade.layouts:main`, `ade.layouts` or `ade.navigator.collapsed:main`
  exists, after the catalog and the window record arrive.
- Imports a saved layout only for a workspace the daemon still has and only where the window has
  no stored layout (`Window.layouts[ws]` absent), with `layout.replace` at
  `expected_revision: 0`, so the daemon refuses it if a layout appeared meanwhile. It never
  overwrites a daemon layout.
- Conversion: camel-case fields to the contract's; widths clamped and rounded; split sizes made
  positive and summing to 100; a tab without a target that showed a new conversation becomes
  `new_conversation`; conversation and terminal tabs whose record is gone are dropped; browser
  tabs are dropped (no records yet); file and diff tabs keep only relative paths; `maximized`
  kept only when it is the focused pane of a split.
- A window that has shown nothing else yet shows the workspace the app showed last; collapsed
  projects are imported when the record has none.
- The keys are deleted after every layout was tried. A refused layout is logged and dropped; if
  the daemon cannot be reached the keys stay for the next start.

## In the running app

A scratch daemon (target/debug, this branch before the rebase) and the built app (`electron .`,
`ADE_SOCKET`, isolated userData, `ADE_E2E_HIDE_WINDOW=1`, ports 9433/9434), driven over the
DevTools Protocol and the CLI:

- The window opened on a new record (`?window=window-<uuid>`); tabs opened with
  `ade layout apply` appeared in it.
- Closing the window closed its record; restarting the app reopened the same record with its
  layout. Quitting kept the record open.
- Import: a layout written in the old shape (a `new_conversation` tab, a gone terminal tab, two
  panes, sidebars swapped, navigator width 300) and a collapsed project were imported at
  revision 1 exactly as converted; the gone terminal's tab was dropped; the keys were deleted.
- A new terminal placed its tab (`tab-<terminal>`, titled `bash`) in one step; closing it stopped
  the terminal. With `sleep 30` running, `tab.close` refused with `terminal_busy` naming `sleep`,
  and closed with `force`.

### Drop-to-paint

100 tab drops (a split onto a pane's edge, then a join onto the other pane's centre), with the
tests' native drag events; the hidden window still drew at 60 Hz (`visibilityState` visible,
16.2 ms frames):

| Measure | p50 | p95 | max |
|---|---|---|---|
| Drop to the DOM change (IPC, main, daemon, reply, React commit) | 6.1 ms | 9.4 ms | 14.3 ms |
| Drop to the next frame after the change | 16.6 ms | 17.4 ms | 17.9 ms |
| `layout.apply` round trip alone, from the renderer (60 calls) | 0.7 ms | 1.3 ms | 2.0 ms |

Every drop painted in the frame after it: the round trip is about a millisecond and the rest of
the commit time is React re-laying the panes, which a local apply would pay too. The "next frame"
figure is one frame by construction (the harness drops at the start of a frame), so its p95 above
16 ms is frame quantisation, not the daemon. **No optimistic local apply was added.** A drop late
in a frame may miss that frame's paint where a local apply would make it, by about the 1 ms round
trip. Measured on a debug daemon; unmeasured on the reference machine.

## Kept locally, and why

| What | Where | Why |
|---|---|---|
| `keepMounted` (3), `keepTerminals` (1) | layout store, in memory | Per-viewer performance policy (map: renderer owns it); not persisted, as nothing sets them but tests and the bench |
| Room and fit rules, window minimum | `panes/room.ts`, `cards/fit.ts` | Pre-checks while dragging; the map keeps them in the desktop |
| Drag preview, live resize, sidebar fit priority, focus and hover | components, `useSidebarFit` | Transient gesture state (decision 6) |
| `pending` workspace, a toggled collapse | layout store, `useCollapsedProjects` | Shown at once until the window record catches up; never stored |
| Record ID per native window, a switch epoch per window | main `windows.ts` | Which native window is which record; fences review requests |
| Electron fullscreen and maximized state | Electron, keyed by record ID | The daemon keeps bounds only |

## Decisions for the coordinator

1. **Start with no open window reopens the last closed record** (whose workspace still exists)
   instead of creating a new one, so a person who closed the last window on macOS gets its layouts
   back; only with none does main create one on the first workspace. Quitting never closes records.
2. **A window without a daemon** opens without a record after 4 s and is bound when the daemon
   connects; the renderer takes its record ID from the URL, then from `layouts.windowId()` and
   `ade:window-id-changed` (profile switch).
3. **Tab IDs**: a record's tab is `tab-<record id>`, so opening it again brings the tab forward
   (the daemon's rule for an existing tab ID); a new conversation's tab is `tab-<nanoid>`.
4. **Announcements** read a tab's title from its rendered tab, falling back to its kind.
5. **No optimistic apply** (above).

## Not done, unverified or uncertain

- `pnpm check:static` ran once on HEAD after the rebase; the commits before it were not gated one
  by one (coordinator's instruction).
- The real-app checks ran before the rebase onto lane B; after it only the static checks and the
  renderer tests ran. Bounds reporting and a visible window's moves were not exercised (hidden
  window). The native close guard for drafts was not re-tested.
- No Electron E2E covers windows; the packaged specs (`e2e/packaged`) were not run.
- `apps/desktop/AGENTS.md` still describes the removed `layout.logic.ts`, `layout-schema.ts`,
  `window-name.ts` and localStorage layouts: it is coordinator-owned and needs updating.
- The protocol E2E was not run: no daemon or contract code changed in this branch.

## Time log

| Step | Time |
|---|---|
| Reading the map, ticket, lane A contract and the desktop | 04:58–05:08 |
| SDK windows in the catalog | 05:08–05:14 |
| Layout double and vectors; main windows and layout IPC; renderer store, sync, room, closing, import | 05:14–05:28 |
| Tests onto the fake daemon; lint rule | 05:28–05:37 |
| Real app: windows, import, terminals, drop-to-paint | 05:37–05:43 |
| Rebase onto lane B, checks, evidence, gate | 05:43– |
