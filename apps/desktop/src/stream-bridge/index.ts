// The stream bridge: an Electron utilityProcess that carries the daemon's high-volume streams (the
// conversation feed and terminal output) straight to each window over a MessagePort, so a burst of
// agent output never queues behind window work on the main process. Main starts it
// (src/main/stream-bridge.ts), tells it the active profile's socket, and hands it one port per
// window. Requests and commands stay in main.
import { AdeClient, openTerminalConnection, type FeedFrame, type TerminalConnection } from '@ade/client'
import type { MessagePortMain } from 'electron'
import type { BridgeControl, WindowToBridge } from '../shared/stream-bridge'
import { validId } from '../shared/valid-id'

// Frames are sent in batches at most once per animation frame (about 60 per second).
const FLUSH_MS = 16
const MAX_INPUT_BYTES = 64 * 1024

type TerminalFrame = Parameters<Parameters<typeof openTerminalConnection>[3]>[0]

interface WindowLink {
  port: MessagePortMain
  terminals: Map<string, TerminalConnection>
  feed: FeedFrame[]
  terminalFrames: Map<string, TerminalFrame[]>
  timer: NodeJS.Timeout | null
}

let socket: string | null = null
let client: AdeClient | null = null
let stopFeed: (() => void) | null = null
const windows = new Map<number, WindowLink>()

function flush(link: WindowLink): void {
  link.timer = null
  if (link.feed.length) link.port.postMessage({ type: 'feed', frames: link.feed })
  link.feed = []
  for (const [connectionId, frames] of link.terminalFrames) {
    link.port.postMessage({ type: 'terminal-frames', connectionId, frames })
  }
  link.terminalFrames.clear()
}

function schedule(link: WindowLink): void {
  link.timer ??= setTimeout(() => flush(link), FLUSH_MS)
}

function closeTerminals(link: WindowLink, reason: string): void {
  flush(link)
  for (const [connectionId, terminal] of link.terminals) {
    terminal.dispose()
    link.port.postMessage({ type: 'terminal-close', connectionId, reason })
  }
  link.terminals.clear()
}

function attachTerminal(link: WindowLink, message: Extract<WindowToBridge, { type: 'terminal-attach' }>): void {
  const reply = (error: string | null): void =>
    link.port.postMessage({ type: 'terminal-attached', requestId: message.requestId, error })
  const { connectionId, workspaceId, terminalId } = message
  if (!validId(connectionId) || !validId(workspaceId) || !validId(terminalId)) {
    reply('Invalid terminal identity')
    return
  }
  const state = client?.getState()
  const record = state?.catalog?.terminals?.find((item) => item.id === terminalId)
  if (!socket || state?.status !== 'connected' || record?.workspace_id !== workspaceId) {
    reply('The selected terminal is unavailable in this profile')
    return
  }
  link.terminals.get(connectionId)?.dispose()
  // Frames reach the renderer unchanged and in order, including a mid-stream `resync: true`
  // snapshot, which the renderer's TerminalFeed restores in place of the screen. Snapshots are the
  // runtime's Ghostty state, which the renderer's Ghostty decodes exactly. The SDK closes the
  // attachment on an output gap, so the renderer never receives non-contiguous output.
  const terminal = openTerminalConnection(
    socket,
    workspaceId,
    terminalId,
    (frame) => {
      const frames = link.terminalFrames.get(connectionId) ?? []
      frames.push(frame)
      link.terminalFrames.set(connectionId, frames)
      schedule(link)
    },
    (reason) => {
      link.terminals.delete(connectionId)
      flush(link)
      link.port.postMessage({ type: 'terminal-close', connectionId, reason })
    },
    { snapshotFormat: 'ghostty' },
  )
  link.terminals.set(connectionId, terminal)
  reply(null)
}

function onWindowMessage(link: WindowLink, message: WindowToBridge): void {
  if (message.type === 'terminal-attach') {
    attachTerminal(link, message)
    return
  }
  const terminal = validId(message.connectionId) ? link.terminals.get(message.connectionId) : undefined
  if (!terminal) return
  if (message.type === 'terminal-input') {
    if (typeof message.data === 'string' && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES)
      terminal.input(message.data)
  } else if (message.type === 'terminal-binary') {
    const { bytes } = message
    if (
      Array.isArray(bytes) &&
      bytes.length <= MAX_INPUT_BYTES &&
      bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      terminal.binary(bytes)
    }
  } else if (message.type === 'terminal-resize') {
    const { cols, rows, widthPx, heightPx } = message
    if (
      [cols, rows, widthPx, heightPx].every(Number.isInteger) &&
      cols >= 2 &&
      cols <= 1000 &&
      rows >= 2 &&
      rows <= 1000 &&
      widthPx >= 0 &&
      widthPx <= 65535 &&
      heightPx >= 0 &&
      heightPx <= 65535
    ) {
      terminal.resize(cols, rows, widthPx, heightPx)
    }
  } else if (message.type === 'terminal-detach') {
    terminal.detach()
    link.terminals.delete(message.connectionId)
  }
}

function useProfile(next: string | null): void {
  if (next === socket && client) return
  for (const link of windows.values()) closeTerminals(link, 'The profile changed')
  stopFeed?.()
  client?.stop()
  socket = next
  client = next ? new AdeClient(next) : null
  stopFeed =
    client?.subscribeFeed((frame) => {
      for (const link of windows.values()) {
        link.feed.push(frame)
        schedule(link)
      }
    }) ?? null
  client?.start()
}

function addWindow(windowId: number, port: MessagePortMain): void {
  removeWindow(windowId)
  const link: WindowLink = { port, terminals: new Map(), feed: [], terminalFrames: new Map(), timer: null }
  port.on('message', (event) => onWindowMessage(link, event.data as WindowToBridge))
  port.on('close', () => removeWindow(windowId))
  port.start()
  windows.set(windowId, link)
}

function removeWindow(windowId: number): void {
  const link = windows.get(windowId)
  if (!link) return
  windows.delete(windowId)
  if (link.timer) clearTimeout(link.timer)
  for (const terminal of link.terminals.values()) terminal.dispose()
  link.terminals.clear()
  link.port.close()
}

process.parentPort.on('message', (event) => {
  const message = event.data as BridgeControl
  if (message.type === 'profile') useProfile(message.socket)
  else if (message.type === 'window' && event.ports[0]) addWindow(message.windowId, event.ports[0])
  else if (message.type === 'window-closed') removeWindow(message.windowId)
})
