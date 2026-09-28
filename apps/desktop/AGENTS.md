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
  - `icons/`: the icon table (`icons.ts`) and `<Icon>`.
  - `components/`: ADE's shared components built from the kit (`Status`, `Shortcut`).
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
- Icons: `<Icon name="terminal" size="sm" />` (`icons/Icon.tsx`). `name` is what the icon means,
  from the table in `icons/icons.ts`; add an icon there before using it. Sizes are `xs` 12, `sm`
  14, `md` 16 and `lg` 18px, the same scale as the Pen components. Leave `size` unset inside kit
  components, which size their own icons. Colour follows the text; `tone` sets emphasis only, and
  status colours belong to the Status component. `IconProvider` fixes the stroke at 1.25 screen
  pixels for every icon, the kit's included. Lint refuses `lucide-react` outside `icons/` and the
  kit, size classes on `<Icon>`, and icon-only buttons without `aria-label`.
- Theme: `shadcn.css` holds everything visual: the kit's colours (Graphite), ADE's status and
  diff colours, and the type scale. `app/app.css` imports it and adds only what every window needs.
  Lint (`@shadcn/lint`) refuses restyled kit components and raw colours, and
  `ade/no-native-title` refuses the `title` attribute: use the kit's Tooltip.
- Surfaces separate by fill, never borders. The steps, darkest to lightest:

  | Class | For |
  |---|---|
  | `bg-sidebar` | Window chrome: title bar, rail, sidebars, bottom bar |
  | `bg-background` | Panes |
  | `bg-card` | Blocks inside a pane: code, tool calls, the composer |
  | `bg-popover` | Anything floating: menus, palettes, toasts, dialogs |
  | `bg-muted` | Chips, the active tab, user messages |
  | `bg-accent` | Hover and selected rows |

  `ade/surface-steps` refuses `border`, `divide` and fills off these steps (status colours
  excepted).
- Type: five sizes, the Pen components' scale. `text-meta` 11px (status bar, times, counts),
  `text-label` 12 (tabs, section labels, code), `text-ui` 13 (rows, buttons, menus), `text-body` 14
  (messages and text people read or type), `text-title` 15 (dialog and pane titles).
  `ade/type-scale` refuses Tailwind's sizes and arbitrary ones. shadcn's "typography" entries are
  prose examples, not components; long-form markdown gets its own styles when it is built.
- Status: `<Status state="needsYou" />` (`idle`, `running`, `needsYou`, `error`, `done`) is the only
  status mark. Amber means "needs you" and nothing else.
- Shortcuts: `<Shortcut appCommand="command-palette" />` for native-menu commands (keys from
  `APP_COMMAND_KEYS` in `src/shared/app-commands.ts`, which the menu also binds), or
  `<Shortcut keys={service.keybindingFor(id)} />` for command-service bindings. Never type a
  shortcut label by hand.
- `src/renderer/src/components/ui` is the stock shadcn/ui kit on Base UI (Nova preset, all
  components), with `hooks/use-mobile.ts`, `lib/utils.ts` and its theme in `shadcn.css`. Keep the
  kit files unmodified so `shadcn add` can update them; build product components from them
  elsewhere. Surfaces with no Pen design are built from the stock kit under
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
