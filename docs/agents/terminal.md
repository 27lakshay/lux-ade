# Terminal notes for agents

The window draws terminals with Ghostty's libghostty-vt compiled to WebAssembly
(`packages/terminal`). The daemon runs the same Ghostty natively. Both are built from the herdr
commit that `native/dependencies.json` pins, so a daemon snapshot restores exactly in the window.
The TypeScript around it is adapted from t3code (`THIRD-PARTY-NOTICES.md`).

## Layers

| File | What it does |
|---|---|
| `src/ghostty/runtime.ts` | Loads the module once per window. Reads struct layouts from the module (`ghostty_type_json`). |
| `src/ghostty/core.ts` | One Ghostty terminal: write bytes, restore a snapshot, read cells, selection, key and mouse encoding. No DOM. |
| `src/ghostty/renderer.ts`, `surface.ts` | Canvas 2D drawing, input, selection, links, scrollbar. |
| `src/feed.ts` | Applies an attachment's frames to a core or surface: snapshot first, then live output by offset. No DOM. |
| `src/index.ts` | `mountTerminal`: a surface plus a feed plus a bridge attachment. |

## Rules

- **Never answer a terminal query in the window.** The daemon's Ghostty already answered it; a
  second answer reaches the program twice (decision D06). The window installs no write-PTY
  callback.
- **Keep output outside React.** Bytes go from the stream bridge to the feed to Ghostty.
- **The view owns its grid.** The surface fits to its container and reports the size
  (`onResize`); a restored snapshot is refit to the container.
- **Frames are typed by the terminal stream contract** (`stream_frames` in
  `crates/ade-core/src/contract/terminals.rs`, generated as `TerminalStreamFrame`). The SDK checks
  every frame against it as it arrives, so code past `openTerminalConnection` can trust the types.
  A new frame kind starts there, then `pnpm contract:generate`.
- **Snapshots come as `ghostty-snapshot-v1-herdr-<pin>`.** The SDK asks for them with
  `openTerminalConnection(…, { snapshotFormat: 'ghostty' })`. The live offset after a snapshot is
  `metrics.terminal_bytes`. The CLI still uses `xterm-replay-v1`.
- **The WebAssembly needs `'wasm-unsafe-eval'`** in the window's `script-src`
  (`apps/desktop/src/shared/content-security-policy.ts`).

## Changing the Ghostty pin

1. Change the pin in `native/dependencies.json` (the daemon and the window move together).
2. Run `python3 scripts/bootstrap.py --sources-only`, then `node scripts/build-ghostty-wasm.mjs`.
   The script fetches the pinned Zig if needed, and writes `src/ghostty/vendor/ghostty-vt.wasm` and
   `vendor/VERSION`.
3. Update `GHOSTTY_SNAPSHOT_FORMAT` in `src/feed.ts`; `feed.test.ts` checks it against `VERSION`.
4. Run the terminal tests (`pnpm --filter @ade/desktop test`, which includes `packages/terminal`).
   `runtimeAbi.test.ts` fails first if an option number, struct size or field offset moved.

## Tests

- `packages/terminal/src/**/*.test.ts` run in headless Chromium through the desktop Vitest config.
- `e2e/protocol/terminals2` drives the same core and feed in Node against a real daemon
  (`viewer.ts`; `viewer-worker.mjs` for a slow viewer on a worker thread).

## Not built yet

- A shared WebGL2 renderer for many terminals: planned. Canvas 2D is used meanwhile.
- Find in terminal (Ghostty's `search.h` is in the build), a screen-reader mirror.
