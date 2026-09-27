# Electron notes for agents

Electron publishes no `llms.txt`. These notes cover the APIs ADE uses, for Electron 44 (Chromium
152, Node 24). Checked 2026-09-28 against the official docs and release posts linked below. When a
note disagrees with the installed `electron.d.ts`, the types win; fix the note.

## Processes

- **Main** is the app's UI thread. Blocking it freezes every window. Keep heavy work out of it.
- **Preload** runs in each window before the page, isolated from it. It exposes a small typed API
  with `contextBridge.exposeInMainWorld`. Never expose `ipcRenderer` itself.
- **Renderer** is the page. It is sandboxed: no Node, no `require`, no sockets.
- **utilityProcess** is a Node child process for background work. It can receive a `MessagePort`
  so a window and the process talk directly, without passing through main.
  ([utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process),
  [MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports))

## IPC

- Use `ipcRenderer.invoke` with `ipcMain.handle` for requests. Never use `sendSync`.
- Every message is copied with the structured clone algorithm. Batch small updates (about once per
  animation frame); do not send one message per token.
- Binary data: send `Uint8Array`. Over a `MessagePort`, pass the buffer in the transfer list to
  avoid a copy.
- Check `event.senderFrame` in handlers: only the app's own frames may call them.
  ([security checklist, item 17](https://www.electronjs.org/docs/latest/tutorial/security))

## Security defaults to keep

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every `BrowserWindow`
  and `WebContentsView`. Never disable `webSecurity`.
- Handle `will-navigate` and `setWindowOpenHandler` on every web contents; deny by default.
- `session.setPermissionRequestHandler` and `setPermissionCheckHandler`: deny by default.
- Serve the app from a custom scheme with `protocol.handle`, not `file://`.
- Web content (browser tabs, previews) runs in a `WebContentsView` with no preload, `sandbox: true`
  and its own `partition`.
  ([security](https://www.electronjs.org/docs/latest/tutorial/security),
  [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses))

## Changed in Electron 38–44

- `BrowserView` is replaced by `BaseWindow` plus `WebContentsView`. Do not use `BrowserView` or
  `<webview>`.
- A `WebContentsView` is composited above the page's DOM. HTML popovers cannot draw over it: hide
  the view (or show a `capturePage()` image) while an overlay is open.
- 42: the Electron binary is no longer downloaded on `postinstall` of the `electron` package;
  `apps/desktop` runs `install-electron` in its own `postinstall`. Notifications use
  `UNNotification` and need a signed app.
- 43: the main process boots from a Node startup snapshot with bytecode caching.
- 44: `clipboard` is async and gone from renderers (use `navigator.clipboard` or preload);
  `windowStatePersistence` saves window bounds (the window needs a `name`); macOS 12 is dropped.
  ([Electron 42](https://www.electronjs.org/blog/electron-42-0),
  [43](https://www.electronjs.org/blog/electron-43-0),
  [44](https://www.electronjs.org/blog/electron-44-0),
  [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes))

## Debugging

- Renderer: DevTools (`webContents.openDevTools()`), or attach over the development-only remote
  debugging port.
- Main: `--inspect`, then `chrome://inspect`.
- Cross-process traces: `contentTracing.startRecording`, opened in Perfetto.
