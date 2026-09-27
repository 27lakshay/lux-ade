# Desktop app

Electron app, in four parts:

- `src/main`: Node; owns windows, menus, requests to the daemon, the send journal and quit guards.
- `src/stream-bridge`: a utility process that carries the daemon's conversation feed and terminal
  streams straight to each window over a MessagePort, batched once per frame. Main starts and
  restarts it (`src/main/stream-bridge.ts`); the preload holds the port (`src/preload/stream.ts`).
- `src/preload`: the only bridge into a window.
- `src/renderer`: the React UI.
- `src/shared`: types and pure code all of them use: the IPC contract, bridge types, commands.

Built with electron-vite; `pnpm dev` at the repo root builds the backend and starts the app with
hot reload.

## Seeing the running app

Use the `drive-ade-app` skill. In development the app opens a DevTools Protocol port (9333) and a
state endpoint (`curl http://127.0.0.1:9334/state`), and logs to `.dev/logs/main.log`. Details:
[docs/agents/desktop-debugging.md](../../docs/agents/desktop-debugging.md). Look at the app before
claiming a UI change works.

## Process boundaries

- The renderer never imports `electron` or `node:*`. It reaches the backend only through
  `window.adeHost`, which the preload exposes and `src/renderer/src/host.d.ts` types.
- The preload exposes typed functions, never `ipcRenderer` itself.
- Every IPC channel is declared in `src/shared/ipc.ts`, typed from the bridge interfaces in
  `src/shared/bridge`. Use the helpers in `src/main/ipc.ts` and `src/preload/ipc.ts`; lint bans
  `ipcMain` and `ipcRenderer` elsewhere. Main accepts requests only from an app window's main frame.
- Main-process IPC handlers validate their input; the renderer is not trusted with paths or IDs.
- High-volume streams go through the stream bridge, not IPC. Add a stream there
  (`src/shared/stream-bridge.ts`), not as an IPC event.
- Web content shown in the app (browser tabs, previews) gets no preload and no application bridge.

## Renderer

- The workspace shell in `src/renderer/src` (`App.tsx`, `panes/`, `parts/`, `tokens.ts`,
  `motion.ts`, `layout.ts`) came from the design prototype and runs on sample data. Its design is
  not settled: change it only against an approved Pen design.
- Colours come from `tokens.ts` (`applyTokens`); `styles.css` only maps them into Tailwind.
  `pnpm --dir apps/desktop check:contrast` reports the glass contrast floors.
- `src/renderer/src/components/ui` is the stock shadcn/ui kit on Base UI (Nova preset, all
  components), with `hooks/use-mobile.ts`, `lib/utils.ts` and its theme in `shadcn.css`. Keep the
  kit files unmodified so `shadcn add` can update them; build product components from them
  elsewhere. `shadcn.css` is not imported by the prototype shell yet: its variable names overlap the
  prototype's tokens, and ADE's tokens get mapped onto it once the design system is settled in Pen.
  Use the `shadcn` skill and the `shadcn` MCP server (`.mcp.json`); config is `components.json`.
- Terminal output stays outside React state (xterm.js).
- `?safeMode=1` in the window URL means main reloaded the window after a hang or crash
  (`src/main/renderer-recovery.ts`). Load no plugins in safe mode, and keep pending approvals and
  core recovery visible.
- Global shortcuts belong to the native menu (`src/main/app-menu.ts`), which sends commands listed
  in `src/shared/app-commands.ts`. Do not bind the same keys in the renderer.
