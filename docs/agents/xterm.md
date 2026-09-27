# xterm.js notes for agents

xterm.js publishes no agent docs. ADE uses `@xterm/xterm` 6 through `packages/terminal`. Checked
2026-09-28 against [the releases](https://github.com/xtermjs/xterm.js/releases) and
[the API docs](https://xtermjs.org/docs/).

- **Packages are scoped:** `@xterm/xterm` and `@xterm/addon-*`. The old unscoped `xterm` and
  `xterm-addon-*` packages are dead.
- **Version 6 removed the canvas renderer.** Use `@xterm/addon-webgl`, falling back to the default
  DOM renderer when WebGL fails (`onContextLoss`).
- **WebGL contexts are limited** (Chromium allows about 16 per process). Dispose the WebGL addon of a
  hidden terminal and recreate it when shown; the buffer survives.
- **Addons ADE uses or plans:** fit (size to container), unicode11 (emoji widths; set
  `terminal.unicode.activeVersion = '11'`), search, serialize, web-links.
- **Keep output outside React.** Write bytes with `terminal.write(Uint8Array)`; never store terminal
  output in React state or re-render on data.
- **Resize:** call the fit addon after layout changes, then send the new cols and rows to the PTY
  owner (the daemon).
