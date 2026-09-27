import { ipcMain } from 'electron'
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
  ipcMain.handle('ade:terminal-attach', (event, connectionId: unknown, workspaceId: unknown, terminalId: unknown) => {
    if (!validId(connectionId) || !validId(workspaceId) || !validId(terminalId)) throw new Error('Invalid terminal identity')
    const socket = getSocket()
    const workspace = getClient().getState().catalog?.workspaces.find((item) => item.id === workspaceId)
    if (getClient().getState().status !== 'connected' || !workspace || workspace.terminal_id !== terminalId || !socket) {
      throw new Error('The selected terminal is unavailable in this profile')
    }
    const key = terminalKey(event.sender.id, connectionId)
    terminals.get(key)?.dispose()
    const terminal = openTerminalConnection(socket, workspaceId, terminalId,
      (frame) => {
        if (!event.sender.isDestroyed()) event.sender.send('ade:terminal-frame', connectionId, frame)
      },
      (reason) => {
        terminals.delete(key)
        if (!event.sender.isDestroyed()) event.sender.send('ade:terminal-close', connectionId, reason)
      })
    terminals.set(key, terminal)
    return true
  })
  ipcMain.on('ade:terminal-input', (event, connectionId: unknown, data: unknown) => {
    if (validId(connectionId) && typeof data === 'string' && Buffer.byteLength(data) <= 64 * 1024) {
      terminals.get(terminalKey(event.sender.id, connectionId))?.input(data)
    }
  })
  ipcMain.on('ade:terminal-binary', (event, connectionId: unknown, bytes: unknown) => {
    if (validId(connectionId) && Array.isArray(bytes) && bytes.length <= 64 * 1024
      && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      terminals.get(terminalKey(event.sender.id, connectionId))?.binary(bytes)
    }
  })
  ipcMain.on('ade:terminal-resize', (event, connectionId: unknown, cols: unknown, rows: unknown, widthPx: unknown, heightPx: unknown) => {
    if (validId(connectionId) && [cols, rows, widthPx, heightPx].every((value) => Number.isInteger(value))) {
      const [c, r, w, h] = [cols, rows, widthPx, heightPx] as number[]
      if (c >= 2 && c <= 1000 && r >= 2 && r <= 1000 && w >= 0 && w <= 65535 && h >= 0 && h <= 65535) {
        terminals.get(terminalKey(event.sender.id, connectionId))?.resize(c, r, w, h)
      }
    }
  })
  ipcMain.on('ade:terminal-detach', (event, connectionId: unknown) => {
    if (!validId(connectionId)) return
    const key = terminalKey(event.sender.id, connectionId)
    terminals.get(key)?.dispose()
    terminals.delete(key)
  })
}
