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

- The workspace shell (`features/workspace`) is built to the Pen screen "Workspace — graphite —
  dark": fixed chrome (`chrome/`: title bar, rail, bottom bar) around floating cards (`cards/`:
  the sidebars and the panes). The layout is data (`model/layout.ts`), changed only by the reducer
  (`model/layout.logic.ts`), stored per workspace (`model/layout-store.ts`). Sidebars only swap
  sides; panes split and move anywhere in the centre. Pane content is empty for now.
- Folders in `src/renderer/src`:
  - `bootstrap.ts`: the entry. It imports `app/start.tsx` dynamically and shows a plain error
    screen if that fails.
  - `app/`: startup, providers, the router, the theme, the query client and the window's command
    service. Nothing feature-specific.
  - `features/<name>/`: one folder per product area. Put pure logic for `X.tsx` in `X.logic.ts`
    and test it there.
  - `provisional/`: surfaces built from the stock kit until Pen designs them.
  - `icons/`: the icon table (`icons.ts`) and `<Icon>`.
  - `components/`: ADE's shared components built from the kit (`Typography`, `Row`,
    `IconButton`, `Status`, `Shortcut`, the `interactive` states).
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
- Surfaces separate by fill, never borders. Each layer steps up in tone (dark mode shown):

  | Class | For |
  |---|---|
  | `bg-sidebar` | Chrome: title bar, rail, bottom bar (darkest) |
  | `bg-base` | The gutters between floating cards |
  | `bg-panel` | The floating sidebars |
  | `bg-background` | Panes |
  | `bg-card` | Blocks inside a pane: code, tool calls, the composer |
  | `bg-popover` | Anything floating: menus, palettes, toasts, dialogs |
  | `bg-muted` | Chips, the active tab, user messages |
  | `bg-accent` | Hover and selected rows |

  Inside a pane the steps are larger than between frame layers, because no gutter draws the edge.
  `ade/surface-steps` refuses `border`, `divide` and fills off these steps (status colours
  excepted).
- Text: render it with the typography components in `components/Typography.tsx`, never with size
  or weight classes or raw `<p>`/`<h1>`–`<h6>`. Fonts are Inter and JetBrains Mono (bundled).

  | Component | Size | For |
  |---|---|---|
  | `<Heading level="display">` | 28 semibold | Onboarding |
  | `<Heading>` | 20 semibold | Full-screen view titles |
  | `<Title>` | 15 semibold | Dialog and pane titles |
  | `<Body>` | 14 | Messages, text people read or type |
  | `<Text>` | 13 | Rows, buttons, menus |
  | `<Caption>` | 12 | Tabs, section labels |
  | `<Meta>` | 11 muted | Status bar, times, counts |
  | `<Code>` | 12 mono | Code, paths, commands; `size="inline"` inside other text |

  Props: `tone` (`default`, `muted`, `inherit`), `weight`, `truncate`, `lines` (2–4), `numeric`
  (tabular figures), `selectable` (off for chrome text, on for `Body` and `Code`), `as`;
  `className` is for placement only. The theme moves the kit's `text-sm` to 13px, so kit menus and
  buttons match `<Text>`. Lint: `ade/type-scale` (no size, weight, line-height or `font-mono`
  classes) and `ade/text-elements` (no raw paragraphs or headings) outside that file. In Pen the
  same steps are the `type-*` variables and the "Type / …" text components. Agent markdown gets
  a `<Prose>` component built from these when the conversation is built.
- Sizes: 28px is the default control (`h-7`): buttons (`size="sm"`), icon buttons, rows, menu
  items. 24px (`h-6`) is compact, 32px (`h-8`) is the field size the kit uses for inputs, selects
  and tabs, 40px the title bar and tab strip, 28px the bottom bar. Every kit `Button` states its
  `size` (`ade/kit-button-size`); pixel heights are refused (`ade/fixed-heights`).
- Spacing is on the 4px grid: steps 0.5, 1, 1.5, 2, 3, 4, 6, 8 (2 to 32px), and 10, 12, 16 for
  page layout (`ade/spacing-grid`). Rows pad 8px; popovers inset 4px; panes inset 6px.
- Radius: `rounded-sm` 6 (rows, chips, tabs), `-md` 8 (blocks in a pane), `-lg` 10 (kit controls,
  rows in a popover), `-xl` 14 (panes, popovers, dialogs), `-full` (`ade/radius-steps`). Nested
  corners are concentric: inner radius = outer radius − the inset between them.
- States: ADE's own interactive surfaces use `interactive` (`components/interactive.ts`): hover
  lifts to `muted`, selected (`data-selected`) and pressed use `accent`, keyboard focus draws a
  full-strength ring inside the element, disabled fades to 50%. The kit keeps its stock states.
  `--ring` is set so focus reaches 3:1 on every fill, the kit's 50% ring included
  (`app/contrast.test.ts` checks every text, mark and ring against every fill, light and dark).
- Rows: `<Row>` for anything one line and clickable in a sidebar, tree, list or popover: 28px,
  `depth` indents 16px a level, `leading`/`trailing` slots, `radius="lg"` inside popovers.
- Icon buttons: `<IconButton icon label shortcut?>`, 28px or `size="xs"` 24px. The label is the
  accessible name and the tooltip; the shortcut shows from the keys actually bound. Tooltips open
  after 600ms, then switch instantly between controls.
- Motion (the `motion` package, [docs/agents](../../docs/agents/libraries.md)):

  | Kind | Tool |
  |---|---|
  | Hover, press, focus, colour | CSS transitions: `duration-100/200/300`, `ease-standard` |
  | Kit popups, dialogs, tooltips, toasts | The kit's own CSS animations, untouched |
  | ADE's structural motion: card swap, pane split and close, tab reorder, drop settle | `m` elements (`motion/react-m`) with `layout` |
  | Dragging cards, tabs, panes | Pragmatic drag and drop; Motion only animates the settle |
  | Loops: spinners, caret, shimmer | CSS keyframes |

  `app/MotionProvider.tsx` loads `domMax` once and sets the reduced-motion policy; timing comes
  from the presets in `app/motion.ts` (the same values as the CSS tokens, which a test checks).
  Rules, enforced by lint (`ade/motion-props`, `ade/motion-classes`, `no-restricted-imports`):
  animate only opacity and transforms; use a preset, never inline timing; give every `layout` a
  `layoutDependency` (the order or structure, never sizes, so resizing never triggers layout
  animations); import `m`, never the full `motion` component or `framer-motion`. Anything holding a
  terminal or canvas animates with `layout="position"`, never scaled. Reduce motion follows the
  system or the palette commands (`app/motion-preference.ts`); it turns off transforms and layout
  animations, keeps fades, and stops CSS transitions through `<html data-reduced-motion>`.
  Collapsing a sidebar expands the centre frame: its content takes the final size at once, and
  only the card's plain background and the content's position animate.
- Scrolling: everything that scrolls sits in the kit's `<ScrollArea>` (`ade/scroll-area` refuses
  `overflow-auto`/`scroll`).
- Cursors: the arrow on controls and in-app links, as native Mac apps do.
- Loading, empty and failed: a `Skeleton` for a list that is loading; a spinner only for an
  action that takes over 300ms; the kit's `Empty` when there is nothing to show; an inline banner
  or `ErrorReport` when something failed, saying what to do next.
- Copy: [docs/agents/ui-copy.md](../../docs/agents/ui-copy.md). `ade/button-copy` refuses
  title-case and vague button labels.
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
