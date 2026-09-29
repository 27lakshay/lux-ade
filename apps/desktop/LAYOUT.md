# Workspace layout

Read this when changing the workspace shell, sidebars, panes, tabs or drag behavior. Paths are
relative to `apps/desktop/src/renderer/src/features/workspace` unless stated otherwise.

The approved Pen shell guides the visual arrangement. `chrome/` draws the fixed title bar, rail
and bottom bar. `cards/` arranges the navigator, centre and inspector. `panes/` draws the daemon's
pane tree and tab strips. The layout store in `model/` holds daemon records by revision; it does
not own a production layout reducer. `layout-sync.ts` follows feed updates and refetches after a
revision conflict. A gesture sends a typed action to `layout.apply` when it ends. Closing a tab
or pane that ends a terminal uses `tab.close` or `pane.close`.

`panes/room.ts` refuses a split or drop that would leave a pane below its minimum. `cards/fit.ts`
temporarily closes a sidebar when the window has insufficient room. The saved layout retains its
open state. The renderer reports the resulting minimum window size to main. A pane's gutter
respects its content minimum; `cards/handle-focus.ts` preserves focus on pointer actions.

Tabs reorder or move between panes through Pragmatic drag and drop. A drop on a pane edge splits;
a drop on its centre joins the pane. A pane grip can move or swap a pane. Tab strips use one
keyboard tab stop and arrow, Home and End navigation. Drop feedback and screen-reader
announcements live beside the drag components. Use the existing command service and native menu
for keyboard actions.

`content/ContentHosts.tsx` keeps recently used content mounted so a tab move does not remount it.
`keepMounted` and `keepTerminals` in `model/layout-store.ts` are local viewer policies. A terminal
that unmounts reattaches from the daemon's snapshot. `content/tab-content.tsx` currently renders
real terminals; other pane targets return no content. `?bench` uses `dev/bench.tsx` and the test
layout double, so its synthetic conversations do not measure a production transcript.

Check layout invariants in `crates/ade-core/src/layout`, renderer interaction tests beside the
components, and the [desktop E2E suite](../../e2e/desktop/README.md). After a pointer or motion
change, inspect the app with the [desktop debugging guide](../../docs/agents/desktop-debugging.md):
watch the state during drag, after pointer release, and after keyboard focus changes.
