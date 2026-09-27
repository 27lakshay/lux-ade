import { emit, handle, listen } from './ipc'
import { openTerminalConnection, type TerminalConnection } from '@ade/client'
import { getClient, getSocket } from './profile-connection'
import { validId } from './validation'

const terminals = new Map<string, TerminalConnection>()
const terminalKey = (senderId: number, connectionId: string): string => `${senderId}:${connectionId}`
export function closeSenderTerminals(senderId: number): void {
  for (const [key, terminal] of terminals) {
    if (!key.startsWith(`${senderId}:`)) continue
    terminal.dispose()
    terminals.delete(key)
  }
}
export function closeAll(): void {
  for (const terminal of terminals.values()) terminal.dispose()
  terminals.clear()
}
export function registerTerminalIpc(): void {
  handle('ade:terminal-attach', (event, connectionId: unknown, workspaceId: unknown, terminalId: unknown) => {
    if (!validId(connectionId) || !validId(workspaceId) || !validId(terminalId))
      throw new Error('Invalid terminal identity')
    const socket = getSocket()
    const workspace = getClient()
      .getState()
      .catalog?.workspaces.find((item) => item.id === workspaceId)
    if (
      getClient().getState().status !== 'connected' ||
      !workspace ||
      workspace.terminal_id !== terminalId ||
      !socket
    ) {
      throw new Error('The selected terminal is unavailable in this profile')
    }
    const key = terminalKey(event.sender.id, connectionId)
    terminals.get(key)?.dispose()
    // Frames go to the renderer unchanged and in order, including a
    // mid-stream `resync: true` snapshot, which the renderer's TerminalFeed
    // applies as a reset and replay. The SDK closes the attachment on an
    // output gap, so the renderer never receives non-contiguous output.
    const terminal = openTerminalConnection(
      socket,
      workspaceId,
      terminalId,
      (frame) => {
        emit(event.sender, 'ade:terminal-frame', connectionId, frame)
      },
      (reason) => {
        terminals.delete(key)
        emit(event.sender, 'ade:terminal-close', connectionId, reason)
      },
    )
    terminals.set(key, terminal)
    return true
  })
  listen('ade:terminal-input', (event, connectionId: unknown, data: unknown) => {
    if (validId(connectionId) && typeof data === 'string' && Buffer.byteLength(data) <= 64 * 1024) {
      terminals.get(terminalKey(event.sender.id, connectionId))?.input(data)
    }
  })
  listen('ade:terminal-binary', (event, connectionId: unknown, bytes: unknown) => {
    if (
      validId(connectionId) &&
      Array.isArray(bytes) &&
      bytes.length <= 64 * 1024 &&
      bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      terminals.get(terminalKey(event.sender.id, connectionId))?.binary(bytes)
    }
  })
  listen(
    'ade:terminal-resize',
    (event, connectionId: unknown, cols: unknown, rows: unknown, widthPx: unknown, heightPx: unknown) => {
      if (validId(connectionId) && [cols, rows, widthPx, heightPx].every((value) => Number.isInteger(value))) {
        const [c, r, w, h] = [cols, rows, widthPx, heightPx] as number[]
        if (c >= 2 && c <= 1000 && r >= 2 && r <= 1000 && w >= 0 && w <= 65535 && h >= 0 && h <= 65535) {
          terminals.get(terminalKey(event.sender.id, connectionId))?.resize(c, r, w, h)
        }
      }
    },
  )
  listen('ade:terminal-detach', (event, connectionId: unknown) => {
    if (!validId(connectionId)) return
    const key = terminalKey(event.sender.id, connectionId)
    terminals.get(key)?.detach()
    terminals.delete(key)
  })
}
