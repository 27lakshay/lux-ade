# 09 — Browser tab records in the daemon

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [08](08-integration-audit.md)

Electron main owns the browser tab list, its receipts and leases today
(`apps/desktop/src/main/browser.ts`, `browser-tabs-v1.json`). Pages must render in Electron, but
which tabs exist, their URLs and their workspaces are records a CLI should read and open.

## Direction (to be planned in detail when it starts)

- The daemon owns browser tab records (`id`, `workspace_id`, `url`, `title`, partition) and the
  `browser.tab.*` operations, with `TabTarget.browser` pointing at them.
- Electron main stays the registered browser owner: it renders pages and runs automation,
  capture, diagnostics and recording against the daemon's records, under the existing owner
  lease.
- Receipts move to the daemon's envelope; main keeps only the page hosting.

## Comments
