# Desktop app

The Electron desktop presents daemon state through native windows and a React renderer. The
[current architecture](../../docs/architecture.md) identifies the owner of each operation.
Paths below are relative to `apps/desktop`.

## Read for the task

- **Workspace shell, pane, tab or drag behavior:** read [LAYOUT.md](LAYOUT.md) and the owning
  component or layout core.
- **Visual design, typography, motion or shared components:** read [DESIGN.md](DESIGN.md), the
  approved Pen screen when one exists, and [UI copy](../../docs/agents/ui-copy.md).
- **Terminal view or stream:** read [terminal notes](../../docs/agents/terminal.md).
- **Electron API or browser page:** read [Electron notes](../../docs/agents/electron.md); for
  browser tab records, read the [open browser ticket](../../.scratch/daemon-authority/issues/09-browser-tab-records.md).
- **Inspecting a UI change:** use the `drive-ade-app` skill and
  [desktop debugging](../../docs/agents/desktop-debugging.md). Check the drawn state and real
  pointer or keyboard interaction before claiming it works.

## Process boundaries

- `src/main` owns native windows, menus, browser pages and quit guards. It forwards daemon
  requests and keeps only the SDK's client journals on disk; durable application rules belong to
  the daemon. Browser tab records remain an explicit exception until ticket 09 is built.
- `src/preload` exposes typed functions as `window.adeHost`. The renderer imports neither
  `electron` nor `node:*` and does not receive `ipcRenderer`.
- Declare every request channel in `src/shared/ipc.ts` and its type in `src/shared/bridge`.
  Use the handlers in `src/main/ipc.ts` and `src/preload/ipc.ts`. Main validates input and accepts
  requests only from an app window's main frame.
- The `src/stream-bridge` utility process carries the daemon feed and terminal frames to each
  window over a MessagePort. Add high-volume streams there, not as ordinary IPC events.
- Browser pages and previews have no app preload or application bridge.

## Renderer

- The daemon owns windows and revisioned layouts. The renderer stores the latest records,
  previews a gesture locally and sends one command when it ends. Keep durable layout rules in
  the daemon's layout core.
- State from the daemon lives in `src/renderer/src/state`; read it with a selector. Query data
  uses the shared TanStack Query client. Transient pointer, focus, scrolling and mounting state
  stays in the renderer.
- Full-screen views use the router (`/`, `/onboarding`, `/settings`). Pane tabs are layout state,
  not routes. Native-menu shortcuts go through `src/main/app-menu.ts`; other shortcuts use the
  renderer command service with a `when` clause.
- Terminal output stays outside React state. Terminal pane content renders with Ghostty
  WebAssembly. Production conversation panes render retained history and execution context;
  the mounted composer saves revisioned per-view drafts, exposes stash recovery, and sends
  through the main-process pipeline with daemon admission and reconciliation. Browser, file and
  diff pane content
  is still unbuilt; `?bench` supplies synthetic conversation content for development measurements.
- `?safeMode=1` means main reloaded after a hang or crash. Keep core recovery visible and avoid
  loading plugins in safe mode.

## Verification

For renderer behavior, Electron boundaries or accessibility changes, follow the
[test-layer selection](../../docs/testing.md#workflow-for-a-change). Use the
[desktop E2E guide](../../e2e/desktop/README.md) for scratch profiles, provider mocks,
keyboard and axe checks, and Electron failure traces. Verify changed UI in the running app,
including hover, focus, pointer release and selected text width. Report automated checks
and observed interactions separately.
