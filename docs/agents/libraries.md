# Libraries: check here before writing it yourself

Before writing a utility, a hook, a parser or a UI mechanism, find the task below and use the
package it names. These are installed in `apps/desktop` unless a row says otherwise (dev
dependencies marked *dev*). Write your own only when no row fits, and explain why in the change.

When you first import a package listed here, remove it from `ignoreDependencies` in
`.fallowrc.json`. It sits there only until something uses it.

## General code

| Task | Use | Not |
|---|---|---|
| groupBy, chunk, debounce, throttle, isEqual, pick, omit, uniqBy, sortBy, … | `es-toolkit` | lodash, hand-written helpers |
| Branching on a union (frame types, statuses, events) with exhaustiveness | `ts-pattern` | long `if`/`switch` chains without a `never` check |
| Updating nested state in a Zustand store | `immer` (zustand's `immer` middleware) | manual spread chains |
| Async work with a concurrency limit, or in order | `p-queue` | hand-rolled queues |
| Retrying async work with backoff | `p-retry` | retry loops |
| A short random ID (panes, tabs, drafts) | `nanoid` | `Math.random` strings; use `crypto.randomUUID` only when a UUID is required |
| Validating data at a boundary | `zod` | hand-written type guards for objects |
| Dates: format, compare, relative time | `date-fns` | manual date maths |
| File sizes and durations for display | `pretty-bytes`, `pretty-ms` | hand-written units |
| Version ranges and comparison | `semver` | string splitting |

## React and the window

| Task | Use | Not |
|---|---|---|
| UI primitives (button, dialog, menu, popover, tooltip, …) | the shadcn kit in `src/renderer/src/components/ui` (Base UI) | new primitives |
| Class name merging and variants | `cn` (`lib/utils.ts`), `class-variance-authority` | string concatenation |
| Icons | `lucide-react`, through `<Icon>` (`apps/desktop/src/renderer/src/icons`) | inline SVGs; never imported directly outside the kit |
| Animation, layout and gesture motion | `motion`: `m` from `motion/react-m`, presets from `app/motion.ts` (see the `motion` skill and apps/desktop/AGENTS.md) | hand-written animation loops, `framer-motion`, the full `motion` component |
| Stopping one pane's crash from taking down the window | `react-error-boundary` | class component boundaries |
| Media queries, resize observers, event listeners, debounced values, local storage | Consider `usehooks-ts` and add it as a dependency when needed; it was removed 2026-09-29 when its last use moved to the daemon | new `useEffect` hooks for these |
| State from the daemon | the Zustand stores in `src/renderer/src/state` | component state or new stores for the same data |
| Request-and-answer data (files, review, services) | `@tanstack/react-query` | fetch-in-effect with manual caching |
| Full-screen views | `@tanstack/react-router` (`router.tsx`) | conditional rendering of screens |
| Commands and shortcuts | the command service (`src/renderer/src/commands`); `@tanstack/react-hotkeys` for keybinding settings | raw `keydown` listeners |
| Command palette | `cmdk` | a custom list with key handling |
| Toasts | `sonner` | custom notification stacks |
| Long lists and logs | `@tanstack/react-virtual` | rendering every row |
| Tables (sessions, services, usage, worktrees) | `@tanstack/react-table` | hand-written sorting and column state |
| Forms | the kit's form fields with `zod` | ad hoc input state |
| Resizable splits | `react-resizable-panels` | pointer-drag math |
| Drag and drop (tabs, panes, files) | `@atlaskit/pragmatic-drag-and-drop` (+ `-hitbox`, `-auto-scroll`, `-live-region` for screen-reader announcements) | HTML5 drag events by hand |
| Charts | `recharts` | SVG by hand |
| Colour maths (OKLCH, contrast, mixing) | `culori` | hand-written conversions |

## Text, content and files

| Task | Use | Not |
|---|---|---|
| Markdown in chat, including streamed output | `streamdown` | another Markdown renderer |
| Code highlighting | `shiki` | regex highlighting |
| Diffs and review views | `@pierre/diffs` | hand-built diff views |
| File trees | `@pierre/trees` | a recursive list component |
| Code editing | CodeMirror 6 (`codemirror`, `@codemirror/state`, `@codemirror/view`), languages from `@codemirror/language-data` | `contenteditable`, Monaco |
| Rich text in the composer, mentions, suggestions | TipTap (`@tiptap/*`) | `contenteditable` by hand |
| Fuzzy matching (quick open, palette ranking) | `fuzzysort` | substring scoring |
| Full-text search held in the window | `minisearch` | linear scans |
| `.gitignore` rules | `ignore` | glob approximations |
| Glob patterns | `picomatch` | regex conversion by hand |
| Paths in the renderer (join, relative, extension) | `pathe` | string slicing; the renderer has no `node:path` |
| Finding links in plain text | `linkify-it` | URL regexes |
| ANSI colour in chat or tool output (not a terminal) | `anser`; `strip-ansi` to remove it | escape-code regexes |
| HTML to Markdown | `turndown` | hand conversion |
| JSON with comments (settings, `tsconfig`) | `jsonc-parser` | stripping comments by regex |
| YAML | `yaml` | — |
| TOML (`Cargo.toml`, `pyproject.toml`, Codex config) | `smol-toml` | — |
| Zip archives | `jszip` | — |
| PDF preview | `pdfjs-dist` | an `<iframe>` or `<embed>` |
| CSV preview | `papaparse` | splitting on commas |

## Terminal and Electron

| Task | Use | Not |
|---|---|---|
| A terminal view | `mountTerminal` from `@ade/terminal` ([terminal.md](terminal.md)) | another terminal emulator |
| Native context menus in main | `electron-context-menu` | building `Menu` templates for standard text menus |
| Main-process logging | `electron-log` (`src/main/logging.ts`) | `console.log` in main |

## Tests

| Task | Use |
|---|---|
| Renderer and component tests | Vitest browser mode (`vitest-browser-react`) |
| Property tests for reducers, codecs and fingerprints | `fast-check` *dev* |
| Realistic sample data in fixtures | `@faker-js/faker` *dev* |
| Backend behaviour | `e2e/protocol` on its shared fixtures |

## Decided against

Do not add these; each was ruled out on purpose.

- dockview: panes use the in-house split tree (D07).
- Monaco: CodeMirror 6 and Pierre Diffs cover editing and review.
- xterm.js: terminals use Ghostty (D06).
- TanStack DB and Markdown, dnd-kit, lodash.
