import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AdeClient, openTerminalConnection, requestDaemon, type TerminalConnection } from '@ade/client'

type Profile = { id: string; name: string; selected: boolean; home: string }
type ProfileState = { managed: boolean; profiles: Profile[]; selectedId: string | null; activeId: string | null; error: string }
const fixedSocket = process.env.ADE_SOCKET
const managedProfiles = !fixedSocket
let socket = fixedSocket
let client = new AdeClient(socket)
let clientGeneration = 0
let unsubscribeClient: (() => void) | null = null
let switching = false
let profileState: ProfileState = { managed: managedProfiles, profiles: [], selectedId: null, activeId: null, error: '' }
const execFileAsync = promisify(execFile)
const terminals = new Map<string, TerminalConnection>()
type Draft = { text: string; revision: number; attachments: unknown[] }
type SendIntent = { requestId: string; text: string; preparing: boolean; inFlight: Promise<Record<string, unknown>> | null }
type DraftEntry = { senderId: number; endpoint: string; conversationId: string; windowId: string; draft: Draft; timer: ReturnType<typeof setTimeout> | null; pending: Promise<void>; savedRevision: number; error: string; unclearedText: string; send: SendIntent | null }
const windowIds = new Map<number, string>()
const drafts = new Map<string, DraftEntry>()
const draftKey = (senderId: number, endpoint: string, conversationId: string): string => `${senderId}:${endpoint}:${conversationId}`
const terminalKey = (senderId: number, connectionId: string): string => `${senderId}:${connectionId}`
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function closeSenderTerminals(senderId: number): void {
  for (const [key, terminal] of terminals) {
    if (!key.startsWith(`${senderId}:`)) continue
    terminal.dispose()
    terminals.delete(key)
  }
}

function publishDraftError(entry: DraftEntry, message: string): void {
  const window = BrowserWindow.getAllWindows().find((item) => item.webContents.id === entry.senderId)
  if (window && !window.isDestroyed()) window.webContents.send('ade:draft-error', { conversationId: entry.conversationId, message })
}

function flushDraft(entry: DraftEntry): Promise<void> {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  if (entry.savedRevision >= entry.draft.revision) return entry.pending
  const draft = { ...entry.draft }
  entry.pending = entry.pending.catch(() => undefined).then(async () => {
    if (entry.savedRevision >= draft.revision) return
    const response = await requestDaemon(entry.endpoint, 'draft.save', {
      conversation_id: entry.conversationId, window_id: entry.windowId,
      text: draft.text, revision: draft.revision, attachments: draft.attachments,
    })
    const saved = response.draft as Draft
    if (!saved || saved.revision < draft.revision) throw new Error('Draft was not saved')
    entry.savedRevision = saved.revision
    entry.error = ''
    publishDraftError(entry, '')
  }).catch((error: unknown) => {
    entry.error = `Draft could not be saved: ${String(error)}`
    publishDraftError(entry, entry.error)
    throw error
  })
  return entry.pending
}

function scheduleDraft(entry: DraftEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => { void flushDraft(entry).catch(() => undefined) }, 250)
}

async function loadDraft(senderId: number, endpoint: string, conversationId: string): Promise<DraftEntry> {
  const key = draftKey(senderId, endpoint, conversationId)
  const cached = drafts.get(key)
  if (cached) return cached
  const windowId = windowIds.get(senderId)
  if (!windowId) throw new Error('Window is unavailable')
  const response = await requestDaemon(endpoint, 'draft.get', { conversation_id: conversationId, window_id: windowId })
  const value = response.draft as Draft
  if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision)) throw new Error('Invalid draft response')
  const entry: DraftEntry = { senderId, endpoint, conversationId, windowId, draft: value, timer: null,
    pending: Promise.resolve(), savedRevision: value.revision, error: '', unclearedText: '', send: null }
  const concurrent = drafts.get(key)
  if (concurrent) return concurrent
  drafts.set(key, entry)
  return entry
}

function pendingSend(entry: DraftEntry): Record<string, unknown> | null {
  return entry.send ? { request_id: entry.send.requestId, text: entry.send.text } : null
}

async function acceptedSend(entry: DraftEntry, intent: SendIntent, response: Record<string, unknown>): Promise<Record<string, unknown>> {
  entry.draft = { text: '', revision: entry.draft.revision + 1, attachments: [] }
  try { await flushDraft(entry) }
  catch {
    entry.unclearedText = intent.text
    entry.error = 'Prompt was sent, but its draft could not be cleared. Retry clearing before sending again.'
    publishDraftError(entry, entry.error)
    entry.send = null
    return { ...response, draft_error: entry.error }
  }
  entry.send = null
  return response
}

async function findAcceptedSend(entry: DraftEntry, intent: SendIntent): Promise<boolean> {
  const response = await requestDaemon(entry.endpoint, 'conversation.get', { conversation_id: entry.conversationId, limit: 200 })
  if (!Array.isArray(response.messages)) throw new Error('Conversation snapshot did not include messages')
  return response.messages.some((item: unknown) => item && typeof item === 'object'
    && 'id' in item && item.id === intent.requestId && 'role' in item && item.role === 'user'
    && 'text' in item && item.text === intent.text)
}

function dispatchSend(entry: DraftEntry, intent: SendIntent, retry: boolean): Promise<Record<string, unknown>> {
  if (intent.inFlight) return intent.inFlight
  const generation = clientGeneration
  const activeProfile = (): boolean => socket === entry.endpoint && clientGeneration === generation
  const uncertain = (): Record<string, unknown> => ({ type: 'send_pending', request_id: intent.requestId, text: intent.text,
    message: 'Prompt delivery is unconfirmed. Retry will use the same request ID.' })
  const work = (async (): Promise<Record<string, unknown>> => {
    if (!activeProfile()) return uncertain()
    try {
      if (retry && await findAcceptedSend(entry, intent)) {
        if (!activeProfile()) return uncertain()
        return acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true })
      }
    } catch { /* The original request ID is safe to retry when a snapshot cannot be read. */ }
    if (!activeProfile()) return uncertain()
    try {
      const response = await requestDaemon(entry.endpoint, 'agent.send', {
        conversation_id: entry.conversationId, request_id: intent.requestId, text: intent.text,
      })
      if (!activeProfile()) return uncertain()
      return acceptedSend(entry, intent, response)
    } catch {
      if (!activeProfile()) return uncertain()
      try {
        if (await findAcceptedSend(entry, intent)) {
          if (!activeProfile()) return uncertain()
          return acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true })
        }
      } catch { /* Admission remains uncertain until a later retry with the same ID. */ }
      return uncertain()
    }
  })()
  intent.inFlight = work
  void work.finally(() => { intent.inFlight = null }).catch(() => undefined)
  return work
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
}

function publishProfile(update: Partial<ProfileState>): ProfileState {
  profileState = { ...profileState, ...update }
  broadcast('ade:profile-state-changed', profileState)
  return profileState
}

async function launcher(action: string, ...args: string[]): Promise<Record<string, unknown>> {
  const script = resolve(app.getAppPath(), '../../scripts/profiles.py')
  const binary = process.env.ADE_DAEMON_BIN ?? resolve(app.getAppPath(), '../../target/debug/ade-daemon')
  const result = await execFileAsync('python3', [script, '--daemon', binary, action, ...args], {
    timeout: 35_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  })
  const value: unknown = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile launcher returned an invalid response')
  return value as Record<string, unknown>
}

async function refreshProfiles(): Promise<ProfileState> {
  if (!managedProfiles) return profileState
  const response = await launcher('list')
  if (response.type !== 'profiles' || !Array.isArray(response.profiles)) throw new Error('Invalid profile list')
  return publishProfile({ profiles: response.profiles as Profile[], selectedId: response.selected_id as string | null, error: '' })
}

function attachClient(endpoint: string, profileId: string): void {
  const previous = client
  const previousSubscription = unsubscribeClient
  const next = new AdeClient(endpoint)
  const generation = ++clientGeneration
  client = next
  socket = endpoint
  publishProfile({ activeId: profileId, error: '' })
  for (const window of BrowserWindow.getAllWindows()) closeSenderTerminals(window.webContents.id)
  previousSubscription?.()
  previous.stop()
  unsubscribeClient = next.subscribe((state) => {
    if (generation === clientGeneration) broadcast('ade:client-state-changed', state)
  })
  next.start()
}

async function selectProfile(id: string, updateDefault: boolean): Promise<ProfileState> {
  if (!managedProfiles) throw new Error('The socket is fixed by ADE_SOCKET')
  if (switching) throw new Error('A profile switch is already in progress')
  if (!profileState.profiles.some((item) => item.id === id)) throw new Error('Unknown profile')
  switching = true
  try {
    const result = await launcher('start', id)
    if (result.type !== 'profile_started' || typeof result.socket !== 'string' || !result.socket) {
      throw new Error('Profile launcher did not return a daemon socket')
    }
    if (updateDefault) await launcher('select', id)
    attachClient(result.socket, id)
    return await refreshProfiles()
  } finally { switching = false }
}

if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}

ipcMain.handle('ade:app-version', () => app.getVersion())
ipcMain.handle('ade:client-state', () => client.getState())
ipcMain.handle('ade:profile-state', () => profileState)
ipcMain.handle('ade:profile-list', () => refreshProfiles())
ipcMain.handle('ade:profile-create', async (_event, name: unknown) => {
  if (!managedProfiles) throw new Error('The socket is fixed by ADE_SOCKET')
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Profile name must contain 1 to 80 characters')
  await launcher('create', name.trim())
  return refreshProfiles()
})
ipcMain.handle('ade:profile-select', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid profile ID')
  return selectProfile(id, true)
})
async function openWorkspace(folder: unknown): Promise<Record<string, unknown>> {
  if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096) throw new Error('Choose an absolute folder path')
  if (!(await stat(folder)).isDirectory()) throw new Error('The selected path is not a folder')
  const endpoint = socket
  if (client.getState().status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
  return requestDaemon(endpoint, 'workspace.open', { path: folder })
}
ipcMain.handle('ade:workspace-open', (_event, folder: unknown) => openWorkspace(folder))
ipcMain.handle('ade:workspace-choose', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Open workspace', properties: ['openDirectory'], buttonLabel: 'Open workspace',
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled || !result.filePaths[0]) return null
  return openWorkspace(result.filePaths[0])
})
const conversationOps = new Set(['provider.list', 'conversation.create', 'conversation.get', 'agent.send', 'agent.retry_send', 'agent.answer', 'draft.get', 'draft.save', 'draft.flush'])
ipcMain.handle('ade:conversation-request', async (event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !conversationOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid conversation request')
  }
  const endpoint = socket
  const args = fields as Record<string, unknown>
  if (op === 'draft.get' && endpoint && validId(args.conversation_id)) {
    const cached = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
    if (cached) return { type: 'draft', draft: cached.draft, error: cached.error, sent_text: cached.unclearedText,
      send_pending: pendingSend(cached) }
  }
  if (client.getState().status !== 'connected' || !endpoint) {
    throw new Error('Profile daemon is unavailable')
  }
  const catalog = client.getState().catalog
  if (op === 'provider.list') return requestDaemon(endpoint, op)
  if (op === 'conversation.create') {
    const providers = await requestDaemon(endpoint, 'provider.list')
    const available = Array.isArray(providers.providers) ? providers.providers : []
    if (!validId(args.workspace_id) || !catalog?.workspaces.some((item) => item.id === args.workspace_id)
      || !available.some((item) => item && typeof item === 'object' && 'id' in item && item.id === args.provider)
      || typeof args.title !== 'string' || args.title.length > 256) throw new Error('Invalid conversation creation')
    return requestDaemon(endpoint, op, { workspace_id: args.workspace_id, provider: args.provider, title: args.title })
  }
  if (!validId(args.conversation_id) || !catalog?.conversations.some((item) => item.id === args.conversation_id)) {
    throw new Error('Conversation is unavailable in this profile')
  }
  if (op === 'draft.get' || op === 'draft.save' || op === 'draft.flush') {
    const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
    if (op === 'draft.save') {
      if (entry.unclearedText || entry.send) throw new Error('Resolve the previous prompt before editing this draft')
      if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 120 * 1024) throw new Error('Invalid draft')
      entry.draft = { text: args.text, revision: entry.draft.revision + 1, attachments: [] }
      scheduleDraft(entry)
    }
    if (op === 'draft.flush') {
      await flushDraft(entry)
      entry.unclearedText = ''
    }
    return { type: 'draft', draft: entry.draft, error: entry.error, sent_text: entry.unclearedText,
      send_pending: pendingSend(entry) }
  }
  if (op === 'conversation.get') return requestDaemon(endpoint, op, { conversation_id: args.conversation_id, limit: 200 })
  if (op === 'agent.send' || op === 'agent.retry_send') {
    const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
    if (op === 'agent.retry_send') {
      if (!entry.send) throw new Error('No prompt is awaiting confirmation')
      if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
      return dispatchSend(entry, entry.send, true)
    }
    if (!validId(args.request_id) || typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 120 * 1024) {
      throw new Error('Invalid prompt')
    }
    if (entry.send) {
      if (entry.send.requestId !== args.request_id || entry.send.text !== args.text) {
        throw new Error('Resolve the previous prompt before starting another')
      }
      if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
      return dispatchSend(entry, entry.send, true)
    }
    if (entry.unclearedText) throw new Error('Finish clearing the previous sent draft before sending again')
    const intent: SendIntent = { requestId: args.request_id, text: args.text, preparing: true, inFlight: null }
    entry.send = intent
    try { await flushDraft(entry) }
    catch { entry.send = null; throw new Error('Draft could not be saved; prompt was not sent') }
    intent.preparing = false
    return dispatchSend(entry, intent, false)
  }
  if (!validId(args.request_id) || !['accept', 'decline', 'answer'].includes(String(args.decision))) throw new Error('Invalid answer')
  if (args.decision === 'answer') {
    if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)
      || Buffer.byteLength(JSON.stringify(args.answers)) > 64 * 1024) throw new Error('Invalid question answers')
  }
  return requestDaemon(endpoint, op, {
    conversation_id: args.conversation_id, request_id: args.request_id,
    decision: args.decision, ...(args.decision === 'answer' ? { answers: args.answers } : {}),
  })
})
ipcMain.handle('ade:terminal-attach', (event, connectionId: unknown, workspaceId: unknown, terminalId: unknown) => {
  if (!validId(connectionId) || !validId(workspaceId) || !validId(terminalId)) throw new Error('Invalid terminal identity')
  const workspace = client.getState().catalog?.workspaces.find((item) => item.id === workspaceId)
  if (client.getState().status !== 'connected' || !workspace || workspace.terminal_id !== terminalId || !socket) {
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
  windowIds.set(window.webContents.id, randomUUID())
  let readyForClose = false
  let closeFlushInProgress = false
  window.on('close', (event) => {
    if (readyForClose) return
    if (closeFlushInProgress) { event.preventDefault(); return }
    if ([...drafts.entries()].some(([key, entry]) => key.startsWith(`${window.webContents.id}:`) && entry.send)) {
      event.preventDefault()
      void dialog.showMessageBox(window, { type: 'warning', title: 'Prompt delivery is unconfirmed',
        message: 'This window is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
      return
    }
    const pending = [...drafts.entries()].filter(([key, entry]) =>
      key.startsWith(`${window.webContents.id}:`) && (entry.timer || entry.savedRevision < entry.draft.revision))
      .map(([, entry]) => entry)
    if (!pending.length) return
    event.preventDefault()
    closeFlushInProgress = true
    void Promise.allSettled(pending.map(flushDraft)).then((results) => {
      closeFlushInProgress = false
      if (results.some((result) => result.status === 'rejected')) {
        void dialog.showMessageBox(window, { type: 'error', title: 'Draft was not saved',
          message: 'This window is staying open because a draft could not be saved.',
          detail: 'Restore the profile daemon and try closing the window again.' })
        return
      }
      if ([...drafts.entries()].some(([key, entry]) => key.startsWith(`${window.webContents.id}:`) && entry.send)) {
        void dialog.showMessageBox(window, { type: 'warning', title: 'Prompt delivery is unconfirmed',
          message: 'This window is staying open until the prompt is reconciled.',
          detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
        return
      }
      readyForClose = true
      window.close()
    })
  })
  window.webContents.on('did-start-navigation', () => closeSenderTerminals(window.webContents.id))
  window.webContents.on('destroyed', () => {
    closeSenderTerminals(window.webContents.id)
    for (const [key, entry] of drafts) {
      if (!key.startsWith(`${window.webContents.id}:`)) continue
      void flushDraft(entry).then(() => drafts.delete(key)).catch(() => undefined)
    }
    windowIds.delete(window.webContents.id)
  })

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
  unsubscribeClient = client.subscribe((state) => broadcast('ade:client-state-changed', state))
  client.start()
  openMainWindow()
  if (managedProfiles) {
    void refreshProfiles().then(async (state) => {
      if (state.selectedId) await selectProfile(state.selectedId, false)
    }).catch((error) => publishProfile({ error: String(error) }))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

let readyToQuit = false
app.on('before-quit', (event) => {
  if (!readyToQuit) {
    if ([...drafts.values()].some((entry) => entry.send)) {
      event.preventDefault()
      void dialog.showMessageBox({ type: 'warning', title: 'Prompt delivery is unconfirmed',
        message: 'ADE is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
      return
    }
    const pending = [...drafts.values()].filter((entry) => entry.timer || entry.savedRevision < entry.draft.revision)
    if (pending.length) {
      event.preventDefault()
      void Promise.allSettled(pending.map(flushDraft)).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          void dialog.showMessageBox({ type: 'error', title: 'Draft was not saved',
            message: 'ADE is staying open because a draft could not be saved.',
            detail: 'Restore the profile daemon and try closing ADE again.' })
          return
        }
        if ([...drafts.values()].some((entry) => entry.send)) {
          void dialog.showMessageBox({ type: 'warning', title: 'Prompt delivery is unconfirmed',
            message: 'ADE is staying open until the prompt is reconciled.',
            detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
          return
        }
        readyToQuit = true
        app.quit()
      })
      return
    }
  }
  for (const terminal of terminals.values()) terminal.dispose()
  terminals.clear()
  unsubscribeClient?.()
  client.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
