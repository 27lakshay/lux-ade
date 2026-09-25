import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { AdeClient, openTerminalConnection, requestDaemon, type TerminalConnection } from '@ade/client'

const client = new AdeClient(process.env.ADE_SOCKET)
const terminals = new Map<string, TerminalConnection>()
const terminalKey = (senderId: number, connectionId: string): string => `${senderId}:${connectionId}`
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function closeSenderTerminals(senderId: number): void {
  for (const [key, terminal] of terminals) {
    if (!key.startsWith(`${senderId}:`)) continue
    terminal.dispose()
    terminals.delete(key)
  }
}

if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}

ipcMain.handle('ade:app-version', () => app.getVersion())
ipcMain.handle('ade:client-state', () => client.getState())
const conversationOps = new Set(['provider.list', 'conversation.create', 'conversation.get', 'agent.send', 'agent.answer'])
ipcMain.handle('ade:conversation-request', async (_event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !conversationOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid conversation request')
  }
  if (client.getState().status !== 'connected' || !process.env.ADE_SOCKET) {
    throw new Error('Profile daemon is unavailable')
  }
  const args = fields as Record<string, unknown>
  const catalog = client.getState().catalog
  if (op === 'provider.list') return requestDaemon(process.env.ADE_SOCKET, op)
  if (op === 'conversation.create') {
    const providers = await requestDaemon(process.env.ADE_SOCKET, 'provider.list')
    const available = Array.isArray(providers.providers) ? providers.providers : []
    if (!validId(args.workspace_id) || !catalog?.workspaces.some((item) => item.id === args.workspace_id)
      || !available.some((item) => item && typeof item === 'object' && 'id' in item && item.id === args.provider)
      || typeof args.title !== 'string' || args.title.length > 256) throw new Error('Invalid conversation creation')
    return requestDaemon(process.env.ADE_SOCKET, op, { workspace_id: args.workspace_id, provider: args.provider, title: args.title })
  }
  if (!validId(args.conversation_id) || !catalog?.conversations.some((item) => item.id === args.conversation_id)) {
    throw new Error('Conversation is unavailable in this profile')
  }
  if (op === 'conversation.get') return requestDaemon(process.env.ADE_SOCKET, op, { conversation_id: args.conversation_id, limit: 200 })
  if (op === 'agent.send') {
    if (!validId(args.request_id) || typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 120 * 1024) {
      throw new Error('Invalid prompt')
    }
    return requestDaemon(process.env.ADE_SOCKET, op, { conversation_id: args.conversation_id, request_id: args.request_id, text: args.text })
  }
  if (!validId(args.request_id) || !['accept', 'decline', 'answer'].includes(String(args.decision))) throw new Error('Invalid answer')
  if (args.decision === 'answer') {
    if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)
      || Buffer.byteLength(JSON.stringify(args.answers)) > 64 * 1024) throw new Error('Invalid question answers')
  }
  return requestDaemon(process.env.ADE_SOCKET, op, {
    conversation_id: args.conversation_id, request_id: args.request_id,
    decision: args.decision, ...(args.decision === 'answer' ? { answers: args.answers } : {}),
  })
})
ipcMain.handle('ade:terminal-attach', (event, connectionId: unknown, workspaceId: unknown, terminalId: unknown) => {
  if (!validId(connectionId) || !validId(workspaceId) || !validId(terminalId)) throw new Error('Invalid terminal identity')
  const workspace = client.getState().catalog?.workspaces.find((item) => item.id === workspaceId)
  if (client.getState().status !== 'connected' || !workspace || workspace.terminal_id !== terminalId || !process.env.ADE_SOCKET) {
    throw new Error('The selected terminal is unavailable in this profile')
  }
  const key = terminalKey(event.sender.id, connectionId)
  terminals.get(key)?.dispose()
  const terminal = openTerminalConnection(process.env.ADE_SOCKET, workspaceId, terminalId,
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

function openMainWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'ADE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.on('did-start-navigation', () => closeSenderTerminals(window.webContents.id))
  window.webContents.on('destroyed', () => closeSenderTerminals(window.webContents.id))

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  client.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('ade:client-state-changed', state)
    }
  })
  client.start()
  openMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', () => {
  for (const terminal of terminals.values()) terminal.dispose()
  terminals.clear()
  client.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
