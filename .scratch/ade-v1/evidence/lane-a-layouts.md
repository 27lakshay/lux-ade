# Lane A: windows and layouts in the daemon (daemon-authority ticket 02)

Status: built. Branch `claude/agent-a885b80600a051798`, rebased on `main` at `9286c36`
(lanes C and E merged). Three commits: layout core, daemon windows and layouts,
decision 5 for layout changes.

## Results

| Check | Result |
|---|---|
| `pnpm check:static`, each of the three commits after the last rebase | passed (842, 850, 850 Rust tests) |
| Shared JSON vectors (`crates/ade-core/tests/layout_vectors.rs`) | 162 vectors, all pass |
| Proptest (`ade_core::layout::tests`), 2000 cases each | well-formed after every step; pane-making actions idempotent |
| `e2e/protocol/layouts` (`ADE_E2E_WORKERS=2`), final | 9 passed |
| Final run: `layouts`, `terminals3`, `conversation-delete`, `orchestration/parity`, `workspaces` | 31 passed |
| Regression: `backup`, `restarts`, `storage`, `catalogs` | 46 passed |
| Review fixes: `layouts` (12) plus terminals, services, reliability, recovery, restarts, backup, errors, orchestration, workspaces, conversation-delete | 494 passed, 2 skipped |
| Full protocol suite without `@load` (before the decision 5 commit) | 852 passed, 14 skipped, 1 failed: `orchestration/parity` lacked a `layout` domain sample; added, it passes |

## What was built

- **Layout core** (`crates/ade-core/src/layout/`): `apply(layout, action)` for all 20
  actions of the desktop's `LayoutAction`, ported from `layout.logic.ts` and
  `layout-tree.ts`. A tab carries a `TabTarget`. `check(layout)` tests well-formedness;
  `close_target` closes every tab showing a target. Beyond the desktop reducer it
  refuses malformed IDs (empty, over 256 bytes, control characters), non-finite widths,
  split sizes that are not positive or do not sum to 100, file and diff paths that are
  absolute or contain `.`/`..`, a tab ID reused for another target, a new pane ID that
  names a split, and more than 64 panes or 512 tabs. An action whose new pane already
  exists changes nothing (its own retry); opening an existing tab with the same target
  activates it.
- **Shared vectors**: `crates/ade-core/tests/layout-vectors/*.json`, `{name, before,
  action, after}` in the wire format. They were produced by running the desktop's TS
  reducer (`layout.logic.ts`, unmodified) on every example of `layout.logic.test.ts` plus
  three seeded random walks of 40 steps over the property test's action mix, then
  converting to the wire format (a tab `{kind, title}` becomes `{target}`). The Rust core
  matches all 162. A mutation of `remove_node` fails them.
- **Contract** (`contract/layout.rs`): the `Window`, `Layout`, `LayoutRecord`,
  `LayoutAction` types, 10 operations and 3 feed frames (`window_changed`,
  `layout_changed`, `layout_removed`). `Catalogue.windows` is now `Vec<Window>`, so the
  subscribe snapshot carries the windows. The legacy `window.save` and `window.close`
  (conversations domain) and the prototype's `WindowRecord`, `Tabs`, `PaneLayout` model
  are removed; `window.close` is now the layout domain's.
- **Storage** (`crates/ade-daemon/src/store/layouts.rs`): `windows(id, workspace_id,
  state, data)` and `layouts(window_id, workspace_id, revision, data, last_action)`. The
  migration `layouts::migrate` drops the prototype's `windows` table (identified by its
  `conversation_id` column) and creates both; it runs under a provisional
  `if version < 19` (lane C holds 18). Supported range and backup coverage are 19.
- **Operations** (all routed by `sessions/layouts.rs`):

  | Operation | Tier | CLI |
  |---|---|---|
  | `window.list` | query | `ade window list` |
  | `window.create` | idempotent command | `ade window create WORKSPACE_ID [--id ID]` |
  | `window.close` | idempotent command | `ade window close WINDOW_ID` |
  | `window.reopen` | idempotent command | `ade window reopen WINDOW_ID` |
  | `window.set_bounds` | idempotent command | `ade window bounds WINDOW_ID X Y W H` |
  | `window.show_workspace` | idempotent command | `ade window show WINDOW_ID WORKSPACE_ID` |
  | `window.set_view_state` | idempotent command | `ade window collapse WINDOW_ID [PROJECT_ID...]` |
  | `layout.get` | query | `ade layout get` |
  | `layout.apply` | idempotent command | `ade layout apply --action JSON`, `ade tab open`, `ade tab close`, `ade pane split` |
  | `layout.replace` | idempotent command | `ade layout replace --layout JSON` |

  Layout commands without `--window` act on the only open window.
- **Revisions and retries.** A layout never changed is served as the default at revision
  0 and stored on its first change. Each change adds 1; a change that changes nothing
  keeps the revision and publishes nothing. `expected_revision` that is stale is refused
  with `layout_conflict`, except the repeat of the last applied action from that revision,
  which returns its result (so a toggle can be retried safely).
- **Tab targets.** `open_tab` and `layout.replace` refuse a missing conversation or
  terminal with `tab_target_missing`. `store::layouts::remove_target(tx, &TabTarget) ->
  Result<Vec<LayoutRecord>>` closes every tab of a target in every layout inside the
  caller's transaction; the caller publishes the returned layouts. Conversation deletion
  calls it (`ConversationDeletion.windows_detached` became `layouts_changed`), and so does
  `terminal_records::remove`, which now returns the changed layouts.
- **Lane C hooks wired.** `terminal.create` with `place: {window_id, pane_id?}` opens a
  tab `tab-<terminal_id>` in the window's layout for the terminal's workspace, in the
  creation transaction; `place` joins the receipt payload; an unknown window is
  `window_not_found` and creates nothing. `terminal.close` and every other terminal
  retirement close that terminal's tabs and publish the layouts.
- **Workspace removal.** `Store::remove_workspace` now returns the removal: the
  workspace's layouts are deleted, and a window showing it moves to the first remaining
  workspace ordered by project name, then workspace name (case-insensitive), in the same
  transaction. The feed carries `layout_removed` and `window_changed`.
- **Decision 5, after review** (`layout_close` in `bin/daemon/server.rs`):
  `layout.apply` and `layout.replace` never end a process. A change that would remove
  the last tab, counted across every window's layouts, of a running shell is refused
  with `tab_close_required`, listing those tabs in `tabs`. The effect commands
  `tab.close` and `pane.close` (envelope receipts; observer reads the layout) close
  every shell terminal, running or not, whose last tab they remove, by
  `terminal.close`'s rule without its bound-workspace check, so they work in a
  workspace that needs rebind. All busy shells are found from the runtime under the
  lease lock before any stops; a busy one refuses with `terminal_busy` listing
  `terminals: [{terminal_id, foreground}]` and nothing closes, unless `force`. A retry
  with the same operation ID returns the recorded outcome. CLI: `ade tab close [--force]`
  uses `tab.close`; `ade pane close [--force]` is new.
- **Explicit state actions.** `toggle_side`, `swap_sidebars` and `toggle_maximize` became
  `set_side_collapsed {side, collapsed}`, `set_sidebar_sides {left}` and
  `set_maximized {pane_id|null}`. Every action but `move_pane`, `swap_panes` and
  `dock_pane` is idempotent (proptest checks it over 2000 random sequences);
  `layout.apply` refuses those three without `expected_revision`, so their retry is
  recognised. The vectors were regenerated from the TS reducer, mapping each TS toggle
  to the state it reached.
- **Recovery after missed frames.** `Window.layouts` gives each stored layout's revision
  by workspace, in `window.list`, the catalog and `window_changed`. A window moved by a
  workspace removal also gets `layout_changed` for the layout it now shows.
- **Other review fixes.** A replay of `window.create` whose workspace was removed since
  returns the window. Service removal and a removed workspace's terminal retirement now
  publish the layouts that lost tabs.
- **Errors.** `ade_core::error::LayoutError`: `window_not_found`, `window_exists`,
  `layout_conflict`, `tab_target_missing`, `invalid_layout`, `tab_close_required`, and
  `terminal_busy` for `tab.close` and `pane.close`, each with a recovery.

## Decisions to confirm (flagged)

1. **Relative pane moves need a revision.** `move_pane`, `swap_panes` and `dock_pane`
   cannot name a target state, so `layout.apply` requires `expected_revision` for them
   (`invalid_layout` without); the repeat of the last action from that revision returns
   its result.
2. **Window whose last workspace is removed** closes and keeps pointing at the removed
   workspace; `window.reopen` then refuses `workspace_removed` until
   `window.show_workspace` moves it.
3. **Prototype window rows are dropped**, not migrated: no client reads them, and the
   desktop's layouts live in localStorage (decision 9 imports them with
   `layout.replace`).
4. **Tab target checks** cover conversations (live, not deleted) and terminals (a
   terminal record exists). Browser tab IDs are not checked until browser tabs are daemon
   records (ticket 09). File and diff paths are checked for shape only. A tab may show a
   conversation or terminal of another workspace.
5. **Default pane ID** is `pane-main` for every default layout.
6. **Wire shape.** `LayoutNode` is untagged over `PaneNode` and `SplitNode`, each carrying
   its own `type` tag, so generated TS types are flat. `active` and `maximized` are
   required and nullable in both directions (`Nullable` schema helper), matching the TS
   layout.
7. **Which shells `tab.close` ends**: any shell-kind terminal whose last tab it removes,
   running or not; `layout.apply` refuses only for a running shell, and otherwise leaves
   a stopped shell without a tab.
8. **Race**: a shell restarted and made busy between `tab.close`'s check and its stop is
   stopped only with `force`; without it the close fails part way, having closed the
   earlier shells (their tabs are gone, so the state is consistent).
9. **`remove_workspace` signature** changed from `Result<bool>` to
   `Result<Option<WorkspaceRemoval>>` (lane B owns workspace removal; small merge risk).

## Not done or untested

- The TS reducer does not run the shared vectors yet: `apps/desktop` is
  coordinator-owned. Ticket 07 can run them through a converter, or delete the reducer.
  The generator is not committed; it ran from a scratch copy of the three TS files.
- `ade terminal create` has no `--window`/`--pane` flag for `place`; the SDK covers it.
- The legacy Python scripts (`scripts/benchmark_runtime.py`, `test_tabs.py` and others)
  still call `window.save`; they drive the removed GPUI prototype and were left alone.
- `e2e/specs/local-profiles.spec.ts` uses `user_version=18` as a future schema and
  `e2e/specs/attachment-retention.spec.ts` expects schema 17; both legacy specs were
  already stale after lane C and are not in the gate.
- No per-window minimum size or room rules: they stay in the desktop by design.

## Time log

| Step | Time |
|---|---|
| Reading, exploring the daemon and desktop model | 03:05–03:15 |
| Layout core, vectors from the TS reducer, proptest, first gate and commit | 03:15–03:30 |
| Daemon storage, operations, feed, CLI, E2E | 03:30–03:45 |
| Rebase onto lane C, wiring its hooks, regression and full E2E | 03:45–04:10 |
| Decision 5 for layout changes, rebase, gating each commit | 04:10–04:30 |
| Review fixes: tab.close / pane.close, explicit state actions, revisions, gaps | 04:35–05:30 |
