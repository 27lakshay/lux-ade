# Desktop app

Electron app: `src/main` (Node, owns windows, menus and the daemon connection), `src/preload` (the
only bridge into a window) and `src/renderer` (React UI). Built with electron-vite; `pnpm dev` at
the repo root builds the backend and starts the app with hot reload.

## Process boundaries

- The renderer never imports `electron` or `node:*`. It reaches the backend only through
  `window.adeHost`, which the preload exposes and `src/renderer/src/host.d.ts` types.
- The preload exposes typed functions, never `ipcRenderer` itself.
- Main-process IPC handlers validate their input; the renderer is not trusted with paths or IDs.
- Web content shown in the app (browser tabs, previews) gets no preload and no application bridge.

## Renderer

- The workspace shell in `src/renderer/src` (`App.tsx`, `panes/`, `parts/`, `tokens.ts`,
  `motion.ts`, `layout.ts`) came from the design prototype and runs on sample data. Its design is
  not settled: change it only against an approved Pen design.
- Colours come from `tokens.ts` (`applyTokens`); `styles.css` only maps them into Tailwind.
  `pnpm --dir apps/desktop check:contrast` reports the glass contrast floors.
- `src/renderer/src/components/ui` is the stock shadcn/ui kit on Base UI, unmodified. Build product
  components from it; do not edit the kit files.
- Terminal output stays outside React state (xterm.js).
