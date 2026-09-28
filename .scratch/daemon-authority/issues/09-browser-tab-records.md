# 09 — Browser tab records in the daemon

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [08](08-integration-audit.md)

Planned in detail on 2026-09-29. The last large block of durable state outside the daemon.

## Where things are today (checked in the code)

- **Electron main owns the tabs.** `apps/desktop/src/main/browser.ts` (about 2,000 lines) keeps,
  per browser profile, the tab list and the selected tab in `browser-tabs-v1.json`, one
  `WebContentsView` per tab, and its own mutation receipts (`BrowserReceipt`: intent recorded
  before the effect, reconciled after a crash in `browser-reconcile.ts`). A child-process lease
  (`acquireBrowserLease`) keeps one owner per browser profile.
- **The daemon forwards.** `browser.open`, `browser.navigate`, `browser.close`, `browser.list`,
  `browser.inspect` and `browser.operation` (contract `daemon.rs`), plus automation, capture,
  diagnostics, recording and import (contract `browser.rs`), are relayed to the owner that
  registered with `browser.owner.register` (a private Unix socket, `browser-owner.ts`). The daemon
  also keeps receipts for `browser.open` and settles held ones against the owner
  (`browser_reconcile.rs`). With no desktop running, no tab can be listed or opened.
- **Tabs belong to a browser profile, not a workspace.** `BrowserTabRecord` has `profile_id` and
  an optional `partition_id`; nothing ties a tab to a workspace, a window or a pane.
- **The new desktop draws no browser.** "Open browser" opens a tab with no content; the renderer
  never calls `window.adeHost.browser`. The bridge (`shared/bridge/browser.ts`: `open`, `select`,
  `navigate`, `history`, `close`, `bounds`, `hide`) serves the old prototype's flow.
- **Cookies and site storage are Chromium's.** Each profile and partition has an Electron session
  on disk; `captureProfile` and `restoreProfile` move them in backups. That data cannot live in the
  daemon.

## Target

The daemon owns browser tab **records**; Electron owns only **pages**: the Chromium session, the
`WebContentsView` that renders a record, and the automation, capture, diagnostics and recording
that need a live page.

| Record | Owner | Fields | Links |
|---|---|---|---|
| Browser tab | Workspace | `id`, `workspace_id`, `partition_id` (null for default), `requested_url`, `observed_url`, `title`, `state` (`not_loaded`, `loading`, `loaded`, `failed` with `error`), `can_go_back`, `can_go_forward`, `updated_at` | Shown by layouts through `TabTarget.browser` |

- **One owner:** a tab belongs to the workspace it was opened for, so removing a workspace closes
  its tabs and a navigator can list them. Sessions stay per profile and partition, as today.
- **Without a desktop:** the CLI can list, open, navigate and close tabs. A record opened with no
  owner attached is `not_loaded` and loads when an owner attaches. Operations that need a live page
  (automation, capture, diagnostics, recording, screenshot) keep refusing with the existing
  owner-unavailable error.
- **Selection is layout:** Electron's per-profile `selectedId` goes; which browser tab a pane shows
  is the layout's active tab (lane A).

## Operations

| Operation | Tier | Change |
|---|---|---|
| `browser.open` | Effect | Daemon admits it, writes the record in its transaction (with `workspace_id`, optional `place: {window_id, pane_id?}` like `terminal.create`), then tells the owner to load it. Receipt is the daemon's envelope |
| `browser.navigate`, `browser.history` | Effect | Record `requested_url` (or the direction) first, then relay; the owner reports the result |
| `browser.close` | Effect | Remove the record and its tabs from every layout (`layouts::remove_target`) in one transaction, then tell the owner to destroy the view |
| `browser.list`, `browser.inspect` | Query | Served from daemon records; live fields come from the owner's last report |
| `browser.owner.report` | Idempotent (owner only) | The owner reports observed URL, title, state, history flags and load errors for a tab, with a per-tab sequence so a late report never overwrites a newer one |
| `browser.owner.adopt` | Idempotent (owner only), one-time | Migration: the owner uploads the tabs from `browser-tabs-v1.json` it still holds; the daemon creates records for any it does not know, in the profile's default workspace unless a layout already points at them |
| Automation, capture, diagnostics, recording, import, screenshot | Unchanged | Still relayed to the owner, now naming daemon tab IDs |

Browser tab changes reach the feed (`browser_tab_changed`, `browser_tab_removed`), debounced for
title and loading churn the way lane C debounced terminal titles (at most one title-only change a
second).

## Owner protocol (Electron main)

1. On registration the owner subscribes to browser tab records for its profile and creates a
   `WebContentsView` per record in state `not_loaded` or `loading`, navigating to
   `requested_url`. Views load lazily: only tabs shown in a pane, or asked for by an operation that
   needs a live page, are created.
2. Relayed `open`, `navigate`, `history` and `close` act on views only; the daemon has already
   changed the record.
3. The owner reports page events with `browser.owner.report`.
4. Remove from `browser.ts`: the tab list and its file, `selectedId`, the owner's own mutation
   receipts and `browser-reconcile.ts` (the daemon's envelope and reconciliation cover them). Keep:
   the lease, sessions and partitions, the backup capture and restore of session storage, page
   hosting, and the automation, capture, diagnostics and recording cores.
5. Migration: before deleting its receipts, the owner settles any pending one against its tabs
   (existing logic), then calls `browser.owner.adopt` once and renames `browser-tabs-v1.json` to
   `.adopted`.

## Desktop (renderer)

A browser tab's content is a stock-kit address bar (back, forward, reload, URL field, provisional
under `renderer/src/provisional/` until a Pen design exists) over a placeholder whose bounds are
sent to main (`bounds`/`hide` as today), so main attaches the tab's `WebContentsView` there. Only
the shown browser tab of each pane has a view attached; hidden tabs detach, like terminals.
"Open browser" calls `browser.open` with `place`.

## Tests

- Protocol E2E in `e2e/protocol/browser-records/`: open, navigate and close with no owner (records
  only); an owner attaching loads `not_loaded` tabs; a crash between the record and the relay
  settles; workspace removal closes its tabs and their layout tabs; `adopt` is idempotent; a late
  owner report never overwrites a newer one; the existing browser automation, capture, diagnostics
  and recording specs pass with daemon tab IDs.
- Desktop Vitest: a browser tab reports its bounds, hides when not shown, and the address bar
  drives `navigate` and `history`.

## Lanes

| Lane | Work | Files |
|---|---|---|
| 09a Daemon | Records, migration, operations, feed, owner report and adopt, E2E | `crates/`, `contract/daemon.rs` or a new `contract/browser_tabs.rs`, `e2e/protocol/browser-records/` |
| 09b Owner | Electron main as a page host of daemon records; removal of its tab store and receipts; adopt on upgrade | `apps/desktop/src/main/browser*.ts` |
| 09c Surface | Browser tab content and address bar in panes | `apps/desktop/src/renderer` |

09b and 09c start once 09a's contract is fixed (one coordinator step, as ticket 01 fixed
`TabTarget`), and run in parallel with the rest of 09a.

## Decisions for the user before it starts

1. ~~Tabs owned by a workspace or by the profile.~~ **Decided by the user 2026-09-29: a browser tab
   is owned by a workspace**; removing the workspace closes its tabs.
2. **Opening with no desktop** creates a `not_loaded` record (recommended) or is refused.

## Comments
