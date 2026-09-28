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

- The UI is being rebuilt from scratch (2026-09-28; the design prototype was removed). The
  workspace (`features/workspace/Workspace.tsx`) renders only "Hello world" so far.
- Folders in `src/renderer/src`:
  - `bootstrap.ts`: the entry. It imports `app/start.tsx` dynamically and shows a plain error
    screen if that fails.
  - `app/`: startup, providers, the router, the theme, the query client and the window's command
    service. Nothing feature-specific.
  - `features/<name>/`: one folder per product area. Put pure logic for `X.tsx` in `X.logic.ts`
    and test it there.
  - `provisional/`: surfaces built from the stock kit until Pen designs them.
  - `components/ui/` (the kit), `commands/`, `state/`, `lib/`, `hooks/`.
  - Lint keeps files short: 300 lines for `.ts`, 400 for `.tsx` and 800 for tests.
- Startup (`app/start.tsx`): theme, commands, `router.load()`, then one render. The providers are
  an error boundary, then TanStack Query, then Tooltip, then the toast manager. The command palette
  (`provisional/CommandPalette.tsx`) and the `confirm()` dialog (`provisional/ConfirmDialog.tsx`)
  are mounted once at the root. Show a toast with `toast.add()` from `components/ui/toast`.
- Server state fetched with TanStack Query uses `queryClient` (`app/query-client.ts`), which is
  cleared when another profile is selected.
- Theme: light, dark or system (`app/theme.ts`), saved in localStorage. `public/theme-boot.js`
  applies it before the first paint. Main mirrors it to the native window and paints the window
  `WINDOW_BACKGROUND` (`src/shared/window-chrome.ts`, kept equal to the theme's `--background` by
  a test). There is no vibrancy.
- Window chrome: title-bar height and traffic-light position live in `src/shared/window-chrome.ts`
  (CSS: `var(--titlebar-height)`). A `drag` region exempts its interactive children and the kit's
  popups.
- Styles: `app/app.css` imports the kit's theme (`shadcn.css`) and adds only what every window
  needs. Use the kit's tokens (`bg-background`, `text-muted-foreground`, …); there are no ADE
  colour tokens in code. Lint (`@shadcn/lint`) refuses restyled kit components and raw colours,
  and `ade/no-native-title` refuses the `title` attribute: use the kit's Tooltip.
- `src/renderer/src/components/ui` is the stock shadcn/ui kit on Base UI (Nova preset, all
  components), with `hooks/use-mobile.ts`, `lib/utils.ts` and its theme in `shadcn.css`. Keep the
  kit files unmodified so `shadcn add` can update them; build product components from them
  elsewhere. The kit keeps its stock theme (decided 2026-09-28): ADE's tokens are not mapped onto
  it. Surfaces with no Pen design are built from the stock kit under
  `src/renderer/src/provisional/` (root `AGENTS.md`, Design workflow).
  Use the `shadcn` skill and the `shadcn` MCP server (`.mcp.json`); config is `components.json`.
- Terminal output stays outside React state. Terminals render with Ghostty compiled to
  WebAssembly (`packages/terminal`), built from the daemon's own Ghostty so its snapshots restore
  exactly; see [docs/agents/terminal.md](../../docs/agents/terminal.md).
- `?safeMode=1` in the window URL means main reloaded the window after a hang or crash
  (`src/main/renderer-recovery.ts`). Load no plugins in safe mode, and keep pending approvals and
  core recovery visible.
- Full-screen views are routes (`src/renderer/src/app/router.tsx`, TanStack Router, hash history):
  `/` the workspace, `/onboarding`, `/settings`. The workspace stays mounted, hidden, under the
  others. Panes, tabs and open conversations are layout state, never routes. The root route shows
  `provisional/ErrorReport.tsx` when a screen throws and `provisional/NotFound.tsx` for an unknown
  route.
- Global shortcuts belong to the native menu (`src/main/app-menu.ts`), which sends commands listed
  in `src/shared/app-commands.ts`. Do not bind the same keys in the renderer.
- Other shortcuts go through the command service (`src/renderer/src/commands`): register a command
  on the window's `commandService` (`app/commands.ts`), then a keybinding with a `when` clause.
  Never add a raw `keydown` listener for a shortcut.
- State from the daemon lives in the stores in `src/renderer/src/state`; read them with a selector
  (`useDaemon`, or zustand's `useStore(store, selector)`). Test against `state/fake-host.ts`.
