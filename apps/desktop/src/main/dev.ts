import { app, BrowserWindow, webContents } from 'electron'
import { createServer } from 'node:http'
import { logFile } from './logging'
import { getClient, getProfileState, getSocket } from './profile-connection'

// Development-only hooks that let people and agents inspect the running app. Nothing here runs in a
// packaged build. See docs/agents/desktop-debugging.md.

/** The Chrome DevTools Protocol port an unpackaged app listens on. `ADE_DEBUG_PORT=0` turns it off. */
export const DEFAULT_DEBUG_PORT = 9333
/** The state endpoint's port. `ADE_DEV_STATE_PORT=0` turns it off. */
export const DEFAULT_STATE_PORT = 9334

/**
 * Opens the remote debugging port (localhost only) so agent-browser, chrome-devtools-mcp or
 * chrome://inspect can attach. Must run before the app is ready. A packaged app never opens it: the
 * port gives full control of every window.
 */
export function enableRemoteDebugging(): void {
  if (app.isPackaged) return
  const port = process.env.ADE_DEBUG_PORT ?? String(DEFAULT_DEBUG_PORT)
  if (port === '0') return
  app.commandLine.appendSwitch('remote-debugging-port', port)
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

/** A snapshot of what the app is showing and what it is connected to. */
export function devState(): Record<string, unknown> {
  const client = getClient().getState()
  return {
    app: { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged },
    logFile: logFile(),
    daemon: {
      socket: getSocket() ?? null,
      status: client.status,
      detail: client.detail,
      bootId: client.bootId,
      revision: client.revision,
      workspaces: client.catalog?.workspaces.length ?? null,
      conversations: client.catalog?.conversations.length ?? null,
    },
    profiles: getProfileState(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      title: window.getTitle(),
      url: window.webContents.getURL(),
      bounds: window.getBounds(),
      focused: window.isFocused(),
      visible: window.isVisible(),
    })),
    webContents: webContents.getAllWebContents().map((contents) => ({
      id: contents.id,
      type: contents.getType(),
      url: contents.getURL(),
      title: contents.getTitle(),
    })),
  }
}

/** Serves `GET /state` on localhost with devState() as JSON, for `curl` and agents. */
export function startDevStateServer(): void {
  if (app.isPackaged) return
  const port = Number(process.env.ADE_DEV_STATE_PORT ?? DEFAULT_STATE_PORT)
  if (!port) return
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/state') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(devState(), null, 2))
  })
  server.on('error', (error) => console.warn('Development state endpoint is off:', error.message))
  server.listen(port, '127.0.0.1')
  app.on('will-quit', () => server.close())
}
