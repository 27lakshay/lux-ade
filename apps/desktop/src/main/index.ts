import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AdeClient, DaemonRequestError, openTerminalConnection, requestDaemon, type TerminalConnection } from '@ade/client'
import { closeBrowserWindow, flushBrowserSessions, registerBrowserIpc, setBrowserProfile } from './browser'

type Profile = { id: string; name: string; selected: boolean; home: string }
type ProfileState = { managed: boolean; profiles: Profile[]; selectedId: string | null; activeId: string | null; error: string }
const fixedSocket = process.env.ADE_SOCKET
const managedProfiles = !fixedSocket
let socket = fixedSocket
let client = new AdeClient(socket)
let clientGeneration = 0
let unsubscribeClient: (() => void) | null = null
let unsubscribeFeed: (() => void) | null = null
let switching = false
let profileState: ProfileState = { managed: managedProfiles, profiles: [], selectedId: null, activeId: null, error: '' }
const execFileAsync = promisify(execFile)
const terminals = new Map<string, TerminalConnection>()
type Draft = { text: string; revision: number; attachments: unknown[] }
type SendIntent = { requestId: string; draftText: string; revision: number; text: string; attachments: unknown[];
  state: 'pending' | 'rejected'; preparing: boolean; inFlight: Promise<Record<string, unknown>> | null;
  reviewSelection?: { senderId: number; workspaceId: string; conversationId: string; epoch: number } }
type DraftEntry = { senderId: number; endpoint: string; conversationId: string; windowId: string; draft: Draft; timer: ReturnType<typeof setTimeout> | null; pending: Promise<void>; savedRevision: number; error: string; unclearedText: string; send: SendIntent | null }
const windowIds = new Map<number, string>()
const selectedWorkspaces = new Map<number, { workspaceId: string; conversationId: string | null; generation: number; epoch: number }>()
const selectionRequests = new Map<number, number>()
let singleWindowId = ''
const drafts = new Map<string, DraftEntry>()
const draftKey = (senderId: number, endpoint: string, conversationId: string): string => `${senderId}:${endpoint}:${conversationId}`
const terminalKey = (senderId: number, connectionId: string): string => `${senderId}:${connectionId}`
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
type ReviewFile = { path: string; staged: boolean; unstaged: boolean }
type ReviewStatus = { revision: string; files: ReviewFile[] }
type ReviewDiff = { token: string; hunks: string[] }
type ReviewAnchor = { workspace_id: string; path: string; staged: boolean; revision: string;
  token: string; hunk: string; line: number; text: string }

function reviewPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.includes('\0') && !value.startsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

type ReviewContext = { endpoint: string; generation: number; senderId: number; epoch: number }

function activeReviewContext(senderId: number, workspaceId: unknown): ReviewContext {
  const endpoint = socket
  const state = client.getState()
  if (!endpoint || state.status !== 'connected') throw new Error('Profile daemon is unavailable')
  if (!validId(workspaceId) || !state.catalog?.workspaces.some((item) => item.id === workspaceId)) {
    throw new Error('Workspace is unavailable in this profile')
  }
  const selection = selectedWorkspaces.get(senderId)
  if (!selection || selection.workspaceId !== workspaceId || selection.generation !== clientGeneration) {
    throw new Error('Selected workspace changed; return to Changes and try again')
  }
  return { endpoint, generation: clientGeneration, senderId, epoch: selection.epoch }
}

function assertReviewContext(context: ReviewContext, workspaceId: string, conversationId?: string): void {
  const selection = selectedWorkspaces.get(context.senderId)
  if (socket !== context.endpoint || clientGeneration !== context.generation ||
    !client.getState().catalog?.workspaces.some((item) => item.id === workspaceId) ||
    selection?.workspaceId !== workspaceId || selection.generation !== context.generation ||
    selection.epoch !== context.epoch || (conversationId !== undefined && selection.conversationId !== conversationId)) {
    throw new Error('Profile, workspace, or conversation changed while review loaded; refresh Changes')
  }
}

async function reviewStatus(context: ReviewContext, workspaceId: string): Promise<ReviewStatus> {
  const response = await requestDaemon(context.endpoint, 'review.status', { workspace_id: workspaceId, force: true })
  assertReviewContext(context, workspaceId)
  if (typeof response.revision !== 'string' || !Array.isArray(response.files)) throw new Error('Invalid review status')
  return response as unknown as ReviewStatus
}

async function reviewDiff(context: ReviewContext, workspaceId: string,
  path: string, staged: boolean): Promise<ReviewDiff> {
  const response = await requestDaemon(context.endpoint, 'review.diff', { workspace_id: workspaceId, path, staged })
  assertReviewContext(context, workspaceId)
  if (typeof response.token !== 'string' || !Array.isArray(response.hunks)) throw new Error('Invalid review diff')
  return response as unknown as ReviewDiff
}

function lineInHunk(hunk: string, lineNumber: number, text: string): boolean {
  const lines = hunk.split('\n')
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '')
  if (!match) return false
  let next = Number(match[1])
  for (const line of lines.slice(1)) {
    if (line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++'))) {
      if (next === lineNumber && line === text) return true
      next += 1
    }
  }
  return false
}

async function reviewPrompt(context: ReviewContext, conversationId: string,
  value: unknown, note: unknown): Promise<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review anchor')
  const anchor = value as ReviewAnchor
  assertReviewContext(context, anchor.workspace_id, conversationId)
  const conversation = client.getState().catalog?.conversations.find((item) => item.id === conversationId)
  if (!conversation || conversation.workspace_id !== anchor.workspace_id) throw new Error('Review feedback must target a conversation in this workspace')
  if (!reviewPath(anchor.path) || typeof anchor.staged !== 'boolean' ||
    typeof anchor.revision !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.revision) ||
    typeof anchor.token !== 'string' || !/^[0-9a-f]{16}$/.test(anchor.token) ||
    typeof anchor.hunk !== 'string' || !anchor.hunk.startsWith('@@ ') || anchor.hunk.length > 512 ||
    !Number.isSafeInteger(anchor.line) || anchor.line < 1 ||
    typeof anchor.text !== 'string' || anchor.text.length > 8192 ||
    typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 64 * 1024) throw new Error('Invalid review feedback')
  const status = await reviewStatus(context, anchor.workspace_id)
  if (status.revision !== anchor.revision) throw new Error('Stale diff: workspace changes have moved; refresh Changes and select the line again')
  if (!status.files.some((file) => file.path === anchor.path && (anchor.staged ? file.staged : file.unstaged))) {
    throw new Error('Stale diff: file or side changed; refresh Changes and select the line again')
  }
  const diff = await reviewDiff(context, anchor.workspace_id, anchor.path, anchor.staged)
  if (diff.token !== anchor.token || !diff.hunks.some((hunk) => hunk.split('\n')[0] === anchor.hunk &&
    lineInHunk(hunk, anchor.line, anchor.text))) {
    throw new Error('Stale diff: selected line changed; refresh Changes and select the line again')
  }
  return `Review feedback for workspace ${anchor.workspace_id}\nFile: ${anchor.path}\nSide: ${anchor.staged ? 'staged' : 'unstaged'}\nDiff token: ${anchor.token}\nStatus revision: ${anchor.revision}\nHunk: ${anchor.hunk}\nLine: +${anchor.line}\nSelected text: ${anchor.text}\n\nFeedback:\n${note.trim()}`
}

async function persistentWindowId(): Promise<string> {
  const directory = app.getPath('userData')
  const target = join(directory, 'window-owner-v1.json')
  await mkdir(directory, { recursive: true })
  let saved: string | undefined
  try { saved = await readFile(target, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (saved !== undefined) {
    const value: unknown = JSON.parse(saved)
    if (!value || typeof value !== 'object' || !('id' in value) || !validId(value.id)) {
      throw new Error('Window owner record is invalid; preserve it for draft recovery')
    }
    return value.id
  }
  const id = randomUUID()
  const temporary = `${target}.${id}.tmp`
  await writeFile(temporary, JSON.stringify({ id }), { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
  return id
}

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
  const fields = { conversation_id: conversationId, window_id: windowId }
  const [response, pending] = await Promise.all([
    requestDaemon(endpoint, 'draft.get', fields),
    requestDaemon(endpoint, 'draft.send.get', fields),
  ])
  const value = response.draft as Draft
  if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision)) throw new Error('Invalid draft response')
  const recovered = pending.intent as { request_id?: unknown; draft_text?: unknown; draft_revision?: unknown;
    text?: unknown; attachments?: unknown; state?: unknown } | null
  if (recovered && (!validId(recovered.request_id) || typeof recovered.text !== 'string'
    || typeof recovered.draft_text !== 'string' || !Number.isSafeInteger(recovered.draft_revision)
    || !Array.isArray(recovered.attachments)
    || !['pending', 'rejected'].includes(String(recovered.state)))) throw new Error('Invalid send intent response')
  const entry: DraftEntry = { senderId, endpoint, conversationId, windowId, draft: value, timer: null,
    pending: Promise.resolve(), savedRevision: value.revision, error: '', unclearedText: '',
    send: recovered ? { requestId: recovered.request_id as string, text: recovered.text as string,
      draftText: recovered.draft_text as string, revision: recovered.draft_revision as number,
      attachments: recovered.attachments as unknown[],
      state: recovered.state as 'pending' | 'rejected', preparing: false, inFlight: null } : null }
  const concurrent = drafts.get(key)
  if (concurrent) return concurrent
  drafts.set(key, entry)
  return entry
}

function pendingSend(entry: DraftEntry): Record<string, unknown> | null {
  return entry.send ? { request_id: entry.send.requestId, text: entry.send.text, state: entry.send.state } : null
}

async function acceptedSend(entry: DraftEntry, intent: SendIntent, response: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const result = await requestDaemon(entry.endpoint, 'draft.send.complete', {
    conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId,
  }, { timeoutMs })
  const cleared = result.draft as Draft
  if (!cleared || cleared.text !== '' || !Number.isSafeInteger(cleared.revision)) throw new Error('Invalid completed draft')
  entry.draft = cleared
  entry.savedRevision = cleared.revision
  entry.unclearedText = ''
  entry.error = ''
  publishDraftError(entry, '')
  entry.send = null
  return response
}

// Closing a view must not turn an uncertain prompt into a new provider request.
// The owning daemon can only complete this intent after it has recorded the exact
// accepted user message, and an already completed intent returns the same draft.
async function reconcileAcceptedSend(entry: DraftEntry): Promise<void> {
  const intent = entry.send
  if (!intent || intent.preparing) return
  if (intent.inFlight) await intent.inFlight.catch(() => undefined)
  if (entry.send !== intent) return
  try {
    await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true }, 3_000)
  } catch { /* Keep the original request ID and ask the user to retry after recovery. */ }
}

function dispatchSend(entry: DraftEntry, intent: SendIntent): Promise<Record<string, unknown>> {
  if (intent.inFlight) return intent.inFlight
  const generation = clientGeneration
  const activeProfile = (): boolean => {
    if (socket !== entry.endpoint || clientGeneration !== generation) return false
    if (!intent.reviewSelection) return true
    const selection = selectedWorkspaces.get(intent.reviewSelection.senderId)
    return selection?.workspaceId === intent.reviewSelection.workspaceId &&
      selection.conversationId === intent.reviewSelection.conversationId &&
      selection.generation === generation && selection.epoch === intent.reviewSelection.epoch
  }
  const uncertain = (): Record<string, unknown> => ({ type: 'send_pending', request_id: intent.requestId, text: intent.text,
    message: 'Prompt delivery is unconfirmed. Retry will use the same request ID.' })
  const work = (async (): Promise<Record<string, unknown>> => {
    if (!activeProfile()) return uncertain()
    try {
      const prepared = await requestDaemon(entry.endpoint, 'draft.send.prepare', {
        conversation_id: entry.conversationId, window_id: entry.windowId,
        request_id: intent.requestId, draft_text: intent.draftText, text: intent.text,
        revision: intent.revision, attachments: intent.attachments,
      })
      const persisted = prepared.intent as { request_id?: string; state?: string } | null
      if (persisted?.request_id === intent.requestId && persisted.state === 'completed') {
        if (!activeProfile()) return uncertain()
        try { return await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true }) }
        catch { return uncertain() }
      }
      if (persisted?.request_id !== intent.requestId || !['pending', 'rejected'].includes(String(persisted.state))) {
        throw new Error('Send intent was not admitted')
      }
      intent.state = persisted.state as 'pending' | 'rejected'
    } catch (error) {
      if (!activeProfile()) return uncertain()
      try {
        const state = await requestDaemon(entry.endpoint, 'draft.send.get', {
          conversation_id: entry.conversationId, window_id: entry.windowId,
        })
        const persisted = state.intent as { request_id?: string; state?: string } | null
        if (persisted?.request_id === intent.requestId && ['pending', 'rejected'].includes(String(persisted.state))) {
          intent.state = persisted.state as 'pending' | 'rejected'
        } else if (persisted) {
          entry.send = null
          throw new Error('A different prompt is awaiting reconciliation for this draft')
        } else {
          try {
            if (!activeProfile()) return uncertain()
            return await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true })
          } catch { /* No completed intent was found. */ }
          if (error instanceof DaemonRequestError && (error.code === 'daemon' || error.code === 'invalid_request')) {
            entry.send = null
            throw error
          }
          return uncertain()
        }
      } catch (recoveryError) {
        if (entry.send === null) throw recoveryError
        return uncertain()
      }
    }
    if (!activeProfile()) return uncertain()
    try {
      const response = await requestDaemon(entry.endpoint, 'agent.send', {
        conversation_id: entry.conversationId, request_id: intent.requestId, text: intent.text,
        attachments: intent.attachments,
      })
      if (!activeProfile()) return uncertain()
      try { return await acceptedSend(entry, intent, response) }
      catch { return uncertain() }
    } catch (error) {
      if (!activeProfile()) return uncertain()
      try {
        return await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true })
      } catch { /* No matching durable user message is visible yet. */ }
      try {
        const state = await requestDaemon(entry.endpoint, 'draft.send.get', {
          conversation_id: entry.conversationId, window_id: entry.windowId,
        })
        const persisted = state.intent as { request_id?: string; state?: string } | null
        if (persisted?.request_id === intent.requestId && persisted.state === 'rejected') {
          await requestDaemon(entry.endpoint, 'draft.send.abort', {
            conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId,
          })
          if (!activeProfile()) return uncertain()
          intent.state = 'rejected'
          entry.send = null
          throw error
        }
      } catch (recoveryError) {
        if (recoveryError === error) throw error
      }
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
  const script = app.isPackaged ? join(process.resourcesPath, 'profiles.py') : resolve(app.getAppPath(), '../../scripts/profiles.py')
  const binary = process.env.ADE_DAEMON_BIN ?? (app.isPackaged
    ? resolve(process.resourcesPath, '../MacOS/ade-daemon')
    : resolve(app.getAppPath(), '../../target/debug/ade-daemon'))
  const environment = app.isPackaged ? {
    ...process.env,
    ADE_NODE_BIN: process.execPath,
    ADE_BUN_BIN: join(process.resourcesPath, 'bin/bun'),
    ELECTRON_RUN_AS_NODE: '1',
  } : process.env
  const python = app.isPackaged ? '/usr/bin/python3' : 'python3'
  const result = await execFileAsync(python, [script, '--daemon', binary, action, ...args], {
    timeout: 35_000,
    maxBuffer: 1024 * 1024,
    env: environment,
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

async function attachClient(endpoint: string, profileId: string): Promise<void> {
  await setBrowserProfile(profileId, profileState.profiles.find((item) => item.id === profileId)?.home)
  const previous = client
  const previousSubscription = unsubscribeClient
  const previousFeed = unsubscribeFeed
  const next = new AdeClient(endpoint)
  const generation = ++clientGeneration
  selectedWorkspaces.clear()
  selectionRequests.clear()
  client = next
  socket = endpoint
  publishProfile({ activeId: profileId, error: '' })
  for (const window of BrowserWindow.getAllWindows()) closeSenderTerminals(window.webContents.id)
  previousSubscription?.()
  previousFeed?.()
  previous.stop()
  unsubscribeClient = next.subscribe((state) => {
    if (generation === clientGeneration) broadcast('ade:client-state-changed', state)
  })
  unsubscribeFeed = next.subscribeFeed((frame) => {
    if (generation === clientGeneration) broadcast('ade:feed-frame', frame)
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
    await attachClient(result.socket, id)
    return await refreshProfiles()
  } finally { switching = false }
}

if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}
registerBrowserIpc()

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
ipcMain.handle('ade:workspace-select', async (event, workspaceId: unknown, conversationId: unknown) => {
  if (!validId(workspaceId) || (conversationId !== null && !validId(conversationId))) {
    throw new Error('Invalid selected workspace or conversation')
  }
  const endpoint = socket
  const generation = clientGeneration
  const request = (selectionRequests.get(event.sender.id) ?? 0) + 1
  selectionRequests.set(event.sender.id, request)
  let available = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (socket !== endpoint || clientGeneration !== generation) throw new Error('Profile changed while selecting a workspace')
    if (selectionRequests.get(event.sender.id) !== request) throw new Error('Workspace selection was superseded')
    const state = client.getState()
    available = state.status === 'connected' && Boolean(state.catalog?.workspaces.some((item) => item.id === workspaceId)) &&
      (conversationId === null || Boolean(state.catalog?.conversations.some((item) => item.id === conversationId && item.workspace_id === workspaceId)))
    if (available) break
    await new Promise<void>((done) => setTimeout(done, 25))
  }
  if (!available) throw new Error('Selected workspace or conversation is unavailable in this profile')
  if (selectionRequests.get(event.sender.id) !== request) throw new Error('Workspace selection was superseded')
  const prior = selectedWorkspaces.get(event.sender.id)
  if (prior?.workspaceId === workspaceId && prior.conversationId === conversationId && prior.generation === clientGeneration) return true
  selectedWorkspaces.set(event.sender.id, { workspaceId, conversationId: conversationId as string | null,
    generation: clientGeneration, epoch: (prior?.epoch ?? 0) + 1 })
  return true
})
const serviceOps = new Set(['service.list', 'service.inspect', 'service.configure', 'service.start', 'service.stop', 'service.remove', 'listener.list'])
ipcMain.handle('ade:service-request', async (_event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !serviceOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid service request')
  }
  const args = fields as Record<string, unknown>
  const endpoint = socket
  const generation = clientGeneration
  const state = client.getState()
  if (state.status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
  if (op === 'listener.list') {
    if (Object.keys(args).length) throw new Error('Listener inventory does not accept fields')
    const result = await requestDaemon(endpoint, op, {})
    if (generation !== clientGeneration || socket !== endpoint) throw new Error('Profile changed while observing listeners')
    return result
  }
  if (!validId(args.workspace_id) || !state.catalog?.workspaces.some((item) => item.id === args.workspace_id)) {
    throw new Error('Workspace is unavailable in this profile')
  }
  const request: Record<string, unknown> = { workspace_id: args.workspace_id }
  if (op !== 'service.list') {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) throw new Error('Invalid service name')
    request.name = args.name
  }
  if (op === 'service.configure' || op === 'service.remove') {
    if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 0) throw new Error('Invalid service revision')
    request.revision = args.revision
  }
  if (op === 'service.configure') {
    if (!args.config || typeof args.config !== 'object' || Array.isArray(args.config)) throw new Error('Invalid service configuration')
    request.config = args.config
  }
  if (op === 'service.inspect') {
    if (!Number.isSafeInteger(args.tail_bytes) || (args.tail_bytes as number) < 1 || (args.tail_bytes as number) > 32768) {
      throw new Error('Invalid service output limit')
    }
    request.tail_bytes = args.tail_bytes
  }
  const result = await requestDaemon(endpoint, op, request)
  if (generation !== clientGeneration || socket !== endpoint) {
    throw new Error('Profile changed while the service request completed; inspect the original profile before retrying')
  }
  return result
})
ipcMain.handle('ade:review-request', async (event, op: unknown, fields: unknown) => {
  if ((op !== 'review.status' && op !== 'review.diff') || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid review request')
  }
  const args = fields as Record<string, unknown>
  const context = activeReviewContext(event.sender.id, args.workspace_id)
  const workspaceId = args.workspace_id as string
  const status = await reviewStatus(context, workspaceId)
  if (op === 'review.status') return status
  if (!reviewPath(args.path) || typeof args.staged !== 'boolean' ||
    !status.files.some((file) => file.path === args.path && (args.staged ? file.staged : file.unstaged))) {
    throw new Error('File or side is unavailable in this workspace; refresh Changes')
  }
  return reviewDiff(context, workspaceId, args.path, args.staged)
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
    try {
    const reviewContext = args.review_anchor === undefined ? null : activeReviewContext(event.sender.id,
      (args.review_anchor as Record<string, unknown> | null)?.workspace_id)
    let text = args.text
    if (op === 'agent.send' && reviewContext) {
      text = await reviewPrompt(reviewContext, args.conversation_id, args.review_anchor, args.note)
      assertReviewContext(reviewContext, (args.review_anchor as ReviewAnchor).workspace_id, args.conversation_id)
    }
    const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
    if (op === 'agent.retry_send') {
      if (!entry.send) throw new Error('No prompt is awaiting confirmation')
      if (args.request_id !== undefined && args.request_id !== entry.send.requestId) {
        throw new Error('A different prompt is awaiting confirmation')
      }
      if (entry.send.reviewSelection) {
        const selection = selectedWorkspaces.get(event.sender.id)
        if (!selection || selection.workspaceId !== entry.send.reviewSelection.workspaceId ||
          selection.conversationId !== entry.send.reviewSelection.conversationId ||
          selection.generation !== clientGeneration) throw new Error('Return to the feedback workspace before retrying')
        entry.send.reviewSelection.epoch = selection.epoch
      }
      if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
      return await dispatchSend(entry, entry.send)
    }
    if (!validId(args.request_id) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 120 * 1024) {
      throw new Error('Invalid prompt')
    }
    if (reviewContext && (entry.draft.text.length || (Array.isArray(entry.draft.attachments) && entry.draft.attachments.length))) {
      throw new Error('Send or clear the ordinary conversation draft before sending review feedback')
    }
    if (entry.send) {
      if (entry.send.requestId !== args.request_id || entry.send.text !== text) {
        throw new Error('Resolve the previous prompt before starting another')
      }
      if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
      return await dispatchSend(entry, entry.send)
    }
    if (entry.unclearedText) throw new Error('Finish clearing the previous sent draft before sending again')
    if (reviewContext && entry.draft.revision === 0) {
      entry.draft = { text: '', revision: 1, attachments: [] }
    }
    if (reviewContext) assertReviewContext(reviewContext, (args.review_anchor as ReviewAnchor).workspace_id, args.conversation_id)
    const intent: SendIntent = { requestId: args.request_id, text, draftText: entry.draft.text,
      revision: entry.draft.revision, attachments: entry.draft.attachments,
      state: 'pending', preparing: true, inFlight: null,
      reviewSelection: reviewContext ? { senderId: event.sender.id,
        workspaceId: (args.review_anchor as ReviewAnchor).workspace_id,
        conversationId: args.conversation_id, epoch: reviewContext.epoch } : undefined }
    entry.send = intent
    try { await flushDraft(entry) }
    catch { entry.send = null; throw new Error('Draft could not be saved; prompt was not sent') }
    intent.draftText = entry.draft.text
    intent.revision = entry.draft.revision
    intent.attachments = entry.draft.attachments
    intent.preparing = false
    return await dispatchSend(entry, intent)
    } catch (error) {
      if (op !== 'agent.send' || args.review_anchor === undefined) throw error
      const entry = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
      if (entry && entry.send?.requestId === args.request_id) {
        return { type: 'send_pending', ...pendingSend(entry) }
      }
      return { type: 'review_rejected', message: String(error) }
    }
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
    show: process.env.ADE_E2E_HIDE_WINDOW !== '1',
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
  windowIds.set(window.webContents.id, singleWindowId)
  let readyForClose = false
  let closeFlushInProgress = false
  window.on('close', (event) => {
    // E2E teardown must not surface a native modal over the user's active Space.
    // The test process owns this isolated profile and may deliberately leave an
    // uncertain send to verify recovery after process exit.
    if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.env.ADE_E2E_TEST_CLOSE_GUARD !== '1') return
    if (readyForClose) return
    if (closeFlushInProgress) { event.preventDefault(); return }
    const owned = [...drafts.entries()].filter(([key]) => key.startsWith(`${window.webContents.id}:`)).map(([, entry]) => entry)
    const hasWindowSend = (): boolean => [...drafts.entries()].some(([key, entry]) =>
      key.startsWith(`${window.webContents.id}:`) && Boolean(entry.send))
    if (!owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) return
    event.preventDefault()
    closeFlushInProgress = true
    void (async () => {
      await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
      if (hasWindowSend()) {
        await dialog.showMessageBox(window, { type: 'warning', title: 'Prompt delivery is unconfirmed',
          message: 'This window is staying open until the prompt is reconciled.',
          detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
        return
      }
      const pending = owned.filter((entry) => entry.timer || entry.savedRevision < entry.draft.revision)
      const results = await Promise.allSettled(pending.map(flushDraft))
      if (results.some((result) => result.status === 'rejected')) {
        await dialog.showMessageBox(window, { type: 'error', title: 'Draft was not saved',
          message: 'This window is staying open because a draft could not be saved.',
          detail: 'Restore the profile daemon and try closing the window again.' })
        return
      }
      if (hasWindowSend()) {
        await dialog.showMessageBox(window, { type: 'warning', title: 'Prompt delivery is unconfirmed',
          message: 'This window is staying open until the prompt is reconciled.',
          detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
        return
      }
      readyForClose = true
      if (!window.isDestroyed()) window.close()
    })().finally(() => { closeFlushInProgress = false })
  })
  window.webContents.on('did-start-navigation', () => closeSenderTerminals(window.webContents.id))
  window.webContents.on('destroyed', () => {
    closeBrowserWindow(window)
    closeSenderTerminals(window.webContents.id)
    selectedWorkspaces.delete(window.webContents.id)
    selectionRequests.delete(window.webContents.id)
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

app.whenReady().then(async () => {
  if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
  singleWindowId = await persistentWindowId()
  if (!managedProfiles && fixedSocket) {
    const fixedIdentity = createHash('sha256').update(resolve(fixedSocket)).digest('hex').slice(0, 32)
    await setBrowserProfile('fixed', join(app.getPath('userData'), 'browser-fixed', fixedIdentity))
  }
  unsubscribeClient = client.subscribe((state) => broadcast('ade:client-state-changed', state))
  unsubscribeFeed = client.subscribeFeed((frame) => broadcast('ade:feed-frame', frame))
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
}).catch((error: unknown) => {
  dialog.showErrorBox('ADE could not open its window', String(error))
  app.quit()
})

let readyToQuit = false
let quitFlushInProgress = false
let browserReadyToQuit = false
let browserFlushInProgress = false
app.on('before-quit', (event) => {
  if (!readyToQuit && (process.env.ADE_E2E_HIDE_WINDOW !== '1' || process.env.ADE_E2E_TEST_CLOSE_GUARD === '1')) {
    const owned = [...drafts.values()]
    if (owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) {
      event.preventDefault()
      if (quitFlushInProgress) return
      quitFlushInProgress = true
      void (async () => {
        await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
        if ([...drafts.values()].some((entry) => entry.send)) {
          await dialog.showMessageBox({ type: 'warning', title: 'Prompt delivery is unconfirmed',
            message: 'ADE is staying open until the prompt is reconciled.',
            detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
          return
        }
        const pending = owned.filter((entry) => entry.timer || entry.savedRevision < entry.draft.revision)
        const results = await Promise.allSettled(pending.map(flushDraft))
        if (results.some((result) => result.status === 'rejected')) {
          await dialog.showMessageBox({ type: 'error', title: 'Draft was not saved',
            message: 'ADE is staying open because a draft could not be saved.',
            detail: 'Restore the profile daemon and try closing ADE again.' })
          return
        }
        if ([...drafts.values()].some((entry) => entry.send)) {
          await dialog.showMessageBox({ type: 'warning', title: 'Prompt delivery is unconfirmed',
            message: 'ADE is staying open until the prompt is reconciled.',
            detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' })
          return
        }
        readyToQuit = true
        app.quit()
      })().finally(() => { quitFlushInProgress = false })
      return
    }
  }
  if (!browserReadyToQuit) {
    event.preventDefault()
    if (!browserFlushInProgress) {
      browserFlushInProgress = true
      void flushBrowserSessions().then(() => {
        browserReadyToQuit = true
        app.quit()
      }).catch((error) => {
        browserFlushInProgress = false
        if (process.env.ADE_E2E_HIDE_WINDOW === '1') {
          console.error('Browser state could not be saved', error)
          browserReadyToQuit = true
          app.quit()
        } else void dialog.showMessageBox({ type: 'error', title: 'Browser state was not saved',
          message: 'ADE is staying open because browser state could not be saved.', detail: String(error) })
      })
    }
    return
  }
  for (const terminal of terminals.values()) terminal.dispose()
  terminals.clear()
  unsubscribeClient?.()
  unsubscribeFeed?.()
  client.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
