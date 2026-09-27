# Seeing and driving the desktop app

How people and agents inspect the running Electron app in development. Everything here is off in a
packaged build.

## Start and restart

- `pnpm dev` at the repo root builds the backend, starts a development profile's daemon and opens the
  app. Renderer edits hot-reload. Main-process and preload edits need a restart: stop `pnpm dev` and
  start it again. (Watch mode is off on purpose: it starts the new app before the old one releases
  the debugging port.)
- `wt dev pnpm dev` runs it in a pane beside yours, or detached with a log when no pane can open.

## What is exposed

| What | Where | Turn off |
| --- | --- | --- |
| Chrome DevTools Protocol | `http://127.0.0.1:9333` (`/json/list` lists targets) | `ADE_DEBUG_PORT=0` |
| App state as JSON | `curl http://127.0.0.1:9334/state` | `ADE_DEV_STATE_PORT=0` |
| Log file | `.dev/logs/main.log`: main process plus the app window's console | — |

`/state` reports the app and Electron versions, the log file, the daemon connection (socket, status,
boot ID, revision, workspace and conversation counts), the profiles, every window with its bounds,
and every web contents with its type and URL.

## Driving the window

The app window is the CDP target whose URL is the dev server, `http://localhost:5173/`. Embedded
browser tabs are separate targets (`WebContentsView`s). Attach only to the app window: ADE's own
browser automation refuses a tab that a foreign debugger holds.

**agent-browser** (snapshot, click, type, screenshot). This machine's shell auto-connects
agent-browser to the user's own browser, so always turn that off and use a named session:

```sh
export AGENT_BROWSER_AUTO_CONNECT=0
agent-browser --session ade-app --cdp 9333 snapshot -i
agent-browser --session ade-app --cdp 9333 click @e14
agent-browser --session ade-app --cdp 9333 screenshot /tmp/ade.png
agent-browser --session ade-app --cdp 9333 errors
agent-browser --session ade-app --cdp 9333 console
```

Loop: snapshot, act on a ref, snapshot again. Refs change after the page changes.

**chrome-devtools-mcp** (`ade-app-devtools` in `.mcp.json`, version 1.10.1 checked against
Electron 44): performance traces with insights, accessibility snapshots, console and network. Pass
`pageId` from `list_pages`. Usage statistics and CrUX lookups are off.

## React helpers

Loaded ahead of React by the dev server (`electron.vite.config.ts`), never built into the app.

| Helper | Default | Use |
| --- | --- | --- |
| react-grab | on (`ADE_REACT_GRAB=0` turns it off) | Hover an element and press ⌘C: copies its component stack with file and line, to paste into an agent |
| React Scan | off (`ADE_REACT_SCAN=1`) | Outlines components as they re-render |
| React DevTools | off (`ADE_REACT_DEVTOOLS=1`) | Connects to the standalone app: `pnpm --dir apps/desktop exec react-devtools` |
