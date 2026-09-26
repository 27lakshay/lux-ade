import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AdeClient, DaemonRequestError, openTerminalConnection, requestDaemon, type TerminalConnection } from '@ade/client'
import { adoptUnownedBrowserStorage, captureBrowserProfile, closeBrowserWindow, flushBrowserSessions,
  registerBrowserIpc, restoreBrowserProfile, setBrowserProfile } from './browser'
import { SendJournal, type SendJournalIdentity, type SendJournalRecord } from './send-journal'

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
let restoringBinding = false
let startupProfileSelection: Promise<void> | null = null
let profileState: ProfileState = { managed: managedProfiles, profiles: [], selectedId: null, activeId: null, error: '' }
const execFileAsync = promisify(execFile)
const terminals = new Map<string, TerminalConnection>()
type Draft = { text: string; revision: number; attachments: unknown[] }
type SendIntent = { requestId: string; draftText: string; revision: number; text: string; attachments: unknown[];
  state: 'pending' | 'rejected'; preparing: boolean; inFlight: Promise<Record<string, unknown>> | null;
  reviewSelection?: { senderId: number; workspaceId: string; conversationId: string; epoch: number } }
type DraftEntry = { senderId: number; endpoint: string; profileId: string; conversationId: string; windowId: string; draft: Draft; timer: ReturnType<typeof setTimeout> | null; pending: Promise<void>; savedRevision: number; error: string; unclearedText: string; send: SendIntent | null }
const windowIds = new Map<number, string>()
const selectedWorkspaces = new Map<number, { workspaceId: string; conversationId: string | null; generation: number; epoch: number }>()
const selectionRequests = new Map<number, number>()
let singleWindowId = ''
let sendJournal: SendJournal | null = null
function journal(): SendJournal {
  if (!sendJournal) throw new Error('Send recovery journal is unavailable')
  return sendJournal
}
const drafts = new Map<string, DraftEntry>()
const draftKey = (senderId: number, endpoint: string, conversationId: string): string => `${senderId}:${endpoint}:${conversationId}`
const terminalKey = (senderId: number, connectionId: string): string => `${senderId}:${connectionId}`
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function journalProfileId(endpoint: string): string {
  if (!managedProfiles) return `fixed-${createHash('sha256').update(resolve(endpoint)).digest('hex').slice(0, 32)}`
  if (socket !== endpoint || !profileState.activeId) throw new Error('Active profile changed before prompt recovery was recorded')
  return profileState.activeId
}

function journalIdentity(entry: DraftEntry, intent: SendIntent): SendJournalIdentity {
  return { profileId: entry.profileId, windowId: entry.windowId,
    conversationId: entry.conversationId, requestId: intent.requestId }
}

function journalRecord(entry: DraftEntry, intent: SendIntent, dispatchStarted: boolean): SendJournalRecord {
  return { ...journalIdentity(entry, intent), endpoint: entry.endpoint, text: intent.text,
    draftText: intent.draftText, draftRevision: intent.revision, attachments: intent.attachments,
    dispatchStarted }
}
async function e2ePauseAfterSendJournal(): Promise<void> {
  if (process.env.ADE_E2E_HIDE_WINDOW !== '1' || process.env.ADE_E2E_SEND_JOURNAL_PAUSE !== '1') return
  const signal = process.env.ADE_E2E_SEND_JOURNAL_SIGNAL
  const release = process.env.ADE_E2E_SEND_JOURNAL_RELEASE
  if (!signal || !release || !isAbsolute(signal) || !isAbsolute(release)) throw new Error('Invalid send journal E2E pause paths')
  await writeFile(signal, 'paused', { flag: 'wx' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await stat(release).then(() => true, () => false)) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Send journal E2E pause timed out')
}

async function journaled(entry: DraftEntry): Promise<boolean> {
  const intent = entry.send
  if (!intent) return true
  const identity = journalIdentity(entry, intent)
  return (await journal().list()).some((record) =>
    record.profileId === identity.profileId && record.windowId === identity.windowId &&
    record.conversationId === identity.conversationId && record.requestId === identity.requestId &&
    record.text === intent.text && record.draftText === intent.draftText &&
    record.draftRevision === intent.revision &&
    JSON.stringify(record.attachments) === JSON.stringify(intent.attachments))
}

async function unsafePending(entries: DraftEntry[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.send && !(await journaled(entry).catch(() => false))) return true
  }
  return false
}
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
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ id })); await handle.sync() }
  finally { await handle.close() }
  await rename(temporary, target)
  const directoryHandle = await open(directory, 'r')
  try { await directoryHandle.sync() }
  finally { await directoryHandle.close() }
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
  const profileId = journalProfileId(endpoint)
  const fields = { conversation_id: conversationId, window_id: windowId }
  const [response, pending, journalRecords] = await Promise.all([
    requestDaemon(endpoint, 'draft.get', fields),
    requestDaemon(endpoint, 'draft.send.get', fields),
    journal().list(),
  ])
  const value = response.draft as Draft
  if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision)) throw new Error('Invalid draft response')
  value.attachments ??= []
  if (pending.restored_from_backup !== undefined && typeof pending.restored_from_backup !== 'boolean') {
    throw new Error('Invalid restored-profile provenance; prompt recovery is unavailable')
  }
  const restoredFromBackup = pending.restored_from_backup === true
  const recovered = pending.intent as { request_id?: unknown; draft_text?: unknown; draft_revision?: unknown;
    text?: unknown; attachments?: unknown; state?: unknown } | null
  if (recovered && (!validId(recovered.request_id) || typeof recovered.text !== 'string'
    || typeof recovered.draft_text !== 'string' || !Number.isSafeInteger(recovered.draft_revision)
    || !Array.isArray(recovered.attachments)
    || !['pending', 'rejected'].includes(String(recovered.state)))) throw new Error('Invalid send intent response')
  let recorded = journalRecords.find((item) => item.profileId === profileId && item.windowId === windowId &&
    item.conversationId === conversationId)
  if (recorded && recovered && (recorded.requestId !== recovered.request_id || recorded.text !== recovered.text ||
    recorded.draftText !== recovered.draft_text || recorded.draftRevision !== recovered.draft_revision ||
    JSON.stringify(recorded.attachments) !== JSON.stringify(recovered.attachments))) {
    throw new Error('Local prompt recovery conflicts with the profile daemon; preserve both records for review')
  }
  if (!recorded && recovered) {
    await journal().upsert({ profileId, windowId, conversationId, requestId: recovered.request_id as string,
      endpoint, text: recovered.text as string, draftText: recovered.draft_text as string,
      draftRevision: recovered.draft_revision as number, attachments: recovered.attachments as unknown[],
      dispatchStarted: true, ...(restoredFromBackup ? { restoreHold: true } : {}) })
  } else if (recorded && restoredFromBackup && !recorded.restoreHold) {
    recorded = { ...recorded, restoreHold: true }
    await journal().upsert(recorded)
  }
  const restored = recorded ?? (recovered ? { requestId: recovered.request_id as string,
    text: recovered.text as string, draftText: recovered.draft_text as string,
    draftRevision: recovered.draft_revision as number, attachments: recovered.attachments as unknown[] } : null)
  const visibleDraft = recorded ? { text: recorded.draftText, revision: recorded.draftRevision,
    attachments: recorded.attachments } : value
  const entry: DraftEntry = { senderId, endpoint, profileId, conversationId, windowId, draft: visibleDraft, timer: null,
    pending: Promise.resolve(), savedRevision: value.revision, error: '', unclearedText: '',
    send: restored ? { requestId: restored.requestId, text: restored.text,
      draftText: restored.draftText, revision: restored.draftRevision,
      attachments: restored.attachments,
      state: recovered?.state as 'pending' | 'rejected' || 'pending', preparing: false, inFlight: null } : null }
  const concurrent = drafts.get(key)
  if (concurrent) return concurrent
  drafts.set(key, entry)
  return entry
}

function pendingSend(entry: DraftEntry): Record<string, unknown> | null {
  return entry.send ? { request_id: entry.send.requestId, text: entry.send.text, state: entry.send.state } : null
}

async function acceptedSend(entry: DraftEntry, intent: SendIntent, response: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const recorded = (await journal().list()).find((item) => item.profileId === entry.profileId &&
    item.windowId === entry.windowId && item.conversationId === entry.conversationId)
  if (recorded?.restoreHold) {
    throw new Error('Restored prompt is held until its source outcome is reconciled')
  }
  const result = await requestDaemon(entry.endpoint, 'draft.send.complete', {
    conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId,
  }, { timeoutMs })
  const cleared = result.draft as Draft
  if (!cleared || cleared.text !== '' || !Number.isSafeInteger(cleared.revision)) throw new Error('Invalid completed draft')
  cleared.attachments ??= []
  await journal().remove(journalIdentity(entry, intent))
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
  if (intent.inFlight) await new Promise<void>((resolveWait) => {
    const timeout = setTimeout(resolveWait, 1_500)
    void intent.inFlight?.then(() => { clearTimeout(timeout); resolveWait() },
      () => { clearTimeout(timeout); resolveWait() })
  })
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
    const recorded = (await journal().list()).find((item) => item.profileId === entry.profileId &&
      item.windowId === entry.windowId && item.conversationId === entry.conversationId)
    if (!recorded || recorded.requestId !== intent.requestId || recorded.text !== intent.text) return uncertain()
    if (recorded.restoreHold) return { ...uncertain(),
      message: 'Restored prompt is held until the source outcome is reconciled. It will not be dispatched automatically.' }
    if (recorded.dispatchStarted) {
      try { return await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true }) }
      catch { /* The original provider turn may still be running or its outcome may be unavailable. */ }
      try {
        const previous = await requestDaemon(entry.endpoint, 'draft.send.get', {
          conversation_id: entry.conversationId, window_id: entry.windowId,
        })
        const saved = previous.intent as { request_id?: string; text?: string; draft_text?: string;
          draft_revision?: number; attachments?: unknown[]; state?: string } | null
        if (!saved || saved.request_id !== intent.requestId || saved.text !== intent.text ||
          saved.draft_text !== intent.draftText || saved.draft_revision !== intent.revision ||
          JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments) ||
          !['pending', 'rejected'].includes(String(saved.state))) return uncertain()
      } catch { return uncertain() }
    } else {
      try {
        const response = await requestDaemon(entry.endpoint, 'draft.get', {
          conversation_id: entry.conversationId, window_id: entry.windowId,
        })
        let saved = response.draft as Draft
        if (!saved || !Number.isSafeInteger(saved.revision) ||
          (saved.attachments !== undefined && !Array.isArray(saved.attachments))) return uncertain()
        saved.attachments ??= []
        if (saved.revision < intent.revision) {
          const result = await requestDaemon(entry.endpoint, 'draft.save', {
            conversation_id: entry.conversationId, window_id: entry.windowId,
            revision: intent.revision, text: intent.draftText, attachments: intent.attachments,
          })
          saved = result.draft as Draft
          if (saved) saved.attachments ??= []
        }
        if (saved.revision !== intent.revision || saved.text !== intent.draftText ||
          JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments)) return uncertain()
      } catch { return uncertain() }
    }
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
          throw new Error('A different prompt is awaiting reconciliation for this draft')
        } else {
          try {
            if (!activeProfile()) return uncertain()
            return await acceptedSend(entry, intent, { type: 'ack', request_id: intent.requestId, reconciled: true })
          } catch { /* No completed intent was found. */ }
          if (!recorded.dispatchStarted && error instanceof DaemonRequestError &&
            (error.code === 'daemon' || error.code === 'invalid_request')) {
            await journal().remove(journalIdentity(entry, intent))
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
      await journal().markDispatched(journalIdentity(entry, intent))
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
          await journal().remove(journalIdentity(entry, intent))
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
    ADE_PNPM_BIN: join(process.resourcesPath, 'bin/pnpm'),
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
  if (restoringBinding) throw new Error('Wait for workspace recovery to finish before switching profiles')
  if (!profileState.profiles.some((item) => item.id === id)) throw new Error('Unknown profile')
  switching = true
  try {
    const previousId = profileState.activeId
    const previousEndpoint = socket
    const result = await launcher('start', id)
    if (result.type !== 'profile_started' || typeof result.socket !== 'string' || !result.socket) {
      throw new Error('Profile launcher did not return a daemon socket')
    }
    await attachClient(result.socket, id)
    // Let packaged E2E select another profile while startup selection remains open.
    const release = process.env.ADE_E2E_STARTUP_PROFILE_RELEASE_FILE
    if (!updateDefault && process.env.ADE_E2E_HIDE_WINDOW === '1' && release && isAbsolute(release)) {
      const deadline = Date.now() + 10_000
      while (true) {
        try { await stat(release); break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (Date.now() >= deadline) throw new Error('E2E startup profile release timed out')
        await new Promise<void>((done) => setTimeout(done, 25))
      }
    }
    if (updateDefault) {
      try { await launcher('select', id) } catch (error) {
        if (previousId && previousEndpoint) {
          try { await attachClient(previousEndpoint, previousId) } catch (rollbackError) {
            throw new Error(`Could not save the selected profile, and returning to the previous profile failed: ${String(rollbackError)}`, { cause: error })
          }
        }
        throw error
      }
    }
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
  if (switching) throw new Error('A profile operation is already in progress')
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Profile name must contain 1 to 80 characters')
  await launcher('create', name.trim())
  return refreshProfiles()
})
ipcMain.handle('ade:profile-select', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid profile ID')
  if (startupProfileSelection) await startupProfileSelection
  return selectProfile(id, true)
})
ipcMain.handle('ade:browser-adopt', async (event, id: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) throw new Error('Browser adoption is unavailable')
  if (!managedProfiles || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || switching) {
    throw new Error('Invalid browser adoption request')
  }
  if (startupProfileSelection) await startupProfileSelection
  const profile = profileState.profiles.find((item) => item.id === id)
  if (!profile) throw new Error('Unknown profile')
  await adoptUnownedBrowserStorage(id, profile.home)
  return selectProfile(id, true)
})
function browserBackupRequest(event: Electron.IpcMainInvokeEvent, id: unknown, location: unknown,
  active: boolean): { profile: Profile; location: string } {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame ||
    !managedProfiles || switching || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
    typeof location !== 'string' || !isAbsolute(location) || location.includes('\0') || location.length > 4096) {
    throw new Error('Invalid browser backup request')
  }
  const profile = profileState.profiles.find((item) => item.id === id)
  if (!profile || (active ? profileState.activeId !== id : profileState.activeId === id)) {
    throw new Error('Browser backup target does not match the requested profile')
  }
  return { profile, location }
}
ipcMain.handle('ade:browser-backup-capture', async (event, id: unknown, destination: unknown) => {
  if (startupProfileSelection) await startupProfileSelection
  const request = browserBackupRequest(event, id, destination, true)
  switching = true
  try { return await captureBrowserProfile(request.profile.id, request.location) }
  finally { switching = false }
})
ipcMain.handle('ade:browser-backup-restore', async (event, bundle: unknown, id: unknown) => {
  if (startupProfileSelection) await startupProfileSelection
  const request = browserBackupRequest(event, id, bundle, false)
  switching = true
  try { return await restoreBrowserProfile(request.location, request.profile.id, request.profile.home) }
  finally { switching = false }
})
function sendTransferRequest(event: Electron.IpcMainInvokeEvent, id: unknown, location: unknown,
  active: boolean): { profile: Profile; location: string } {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame ||
    !managedProfiles || switching || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
    typeof location !== 'string' || !isAbsolute(location) || location.includes('\0') || location.length > 4096) {
    throw new Error('Invalid pending-send transfer request')
  }
  const profile = profileState.profiles.find((item) => item.id === id)
  if (!profile || (active ? profileState.activeId !== id : profileState.activeId === id)) {
    throw new Error('Pending-send profile does not match the transfer request')
  }
  return { profile, location }
}
ipcMain.handle('ade:send-journal-export', async (event, id: unknown, destination: unknown) => {
  if (startupProfileSelection) await startupProfileSelection
  const request = sendTransferRequest(event, id, destination, true)
  switching = true
  try { return await journal().exportProfile(request.profile.id, request.location) }
  finally { switching = false }
})
ipcMain.handle('ade:send-journal-import', async (event, bundle: unknown, sourceId: unknown, targetId: unknown) => {
  if (startupProfileSelection) await startupProfileSelection
  const request = sendTransferRequest(event, targetId, bundle, false)
  if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/.test(sourceId)) {
    throw new Error('Invalid pending-send source identity')
  }
  switching = true
  try {
    await SendJournal.inspectTransfer(request.location, sourceId)
    const started = await launcher('start', request.profile.id)
    if (started.type !== 'profile_started' || typeof started.socket !== 'string' ||
      !isAbsolute(started.socket)) throw new Error('Restored profile daemon is unavailable')
    return await journal().importProfile(request.location, sourceId, request.profile.id, started.socket,
      (record) => requestDaemon(started.socket as string, 'draft.send.get', {
        conversation_id: record.conversationId, window_id: record.windowId }))
  } finally { switching = false }
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
ipcMain.handle('ade:restore-bindings', async () => {
  if (startupProfileSelection) await startupProfileSelection
  const endpoint = socket
  const generation = clientGeneration
  if (!endpoint || switching || client.getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
  const [lifecycle, repositories, workspaces] = await Promise.all([
    requestDaemon(endpoint, 'worktree.rebind.list'),
    requestDaemon(endpoint, 'repository.rebind.list'),
    requestDaemon(endpoint, 'workspace.rebind.list'),
  ])
  if (socket !== endpoint || clientGeneration !== generation || switching) throw new Error('Profile changed while loading recovery state')
  if (!Array.isArray(lifecycle.repositories) || !Array.isArray(repositories.repositories) ||
    !Array.isArray(workspaces.workspaces)) {
    throw new Error('Profile daemon returned an invalid recovery catalog')
  }
  return { lifecycle: lifecycle.repositories, repositories: repositories.repositories,
    workspaces: workspaces.workspaces }
})
ipcMain.handle('ade:restore-binding', async (_event, expectedProfile: unknown, kind: unknown, id: unknown, folder: unknown) => {
  if (startupProfileSelection) await startupProfileSelection
  if (kind !== 'worktree' && kind !== 'repository' && kind !== 'workspace') throw new Error('Invalid recovery kind')
  if (!validId(id)) throw new Error('Invalid recovery identity')
  const endpoint = socket
  const generation = clientGeneration
  const activeProfile = managedProfiles ? profileState.activeId : 'fixed'
  if (expectedProfile !== activeProfile) throw new Error('Profile changed while preparing workspace recovery')
  if (!endpoint || switching || restoringBinding || client.getState().status !== 'connected') {
    throw new Error('Profile recovery is unavailable or already in progress')
  }
  restoringBinding = true
  try {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096 || !(await stat(folder)).isDirectory()) {
      throw new Error('Choose an absolute folder path')
    }
    if (socket !== endpoint || clientGeneration !== generation || profileState.activeId !== (managedProfiles ? activeProfile : null)) {
      throw new Error('Profile changed while checking the replacement folder')
    }
    const op = kind === 'worktree' ? 'worktree.rebind' : kind === 'repository' ? 'repository.rebind' : 'workspace.rebind'
    const field = kind === 'workspace' ? 'workspace_id' : 'repository_id'
    const result = await requestDaemon(endpoint, op, { [field]: id, path: folder })
    if (socket !== endpoint || clientGeneration !== generation) throw new Error('Profile changed during workspace recovery')
    return result
  } finally { restoringBinding = false }
})
ipcMain.handle('ade:restore-choose-folder', async (event) => {
  if (startupProfileSelection) await startupProfileSelection
  const endpoint = socket
  const generation = clientGeneration
  if (!endpoint || switching || client.getState().status !== 'connected') throw new Error('Profile daemon is unavailable')
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Choose replacement folder', properties: ['openDirectory'], buttonLabel: 'Use this folder',
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (socket !== endpoint || clientGeneration !== generation || switching) throw new Error('Profile changed while choosing a replacement folder')
  return result.canceled ? null : result.filePaths[0] ?? null
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
const serviceOps = new Set(['service.list', 'service.inspect', 'service.configure', 'service.start', 'service.stop', 'service.remove', 'service.proxy.ensure', 'service.proxy.inspect', 'service.proxy.remap', 'service.proxy.retire', 'service.proxy.recovery.inspect', 'service.proxy.recovery.retry', 'service.proxy.recovery.reset', 'listener.list'])
const scriptOps = new Set(['script.list', 'script.runs', 'script.start', 'script.inspect', 'script.stop', 'script.retire'])
ipcMain.handle('ade:script-request', async (_event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !scriptOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid script request')
  }
  const args = fields as Record<string, unknown>
  if (switching && (op === 'script.start' || op === 'script.stop' || op === 'script.retire')) {
    throw new Error('Profile switch is in progress; retry the script action in the selected profile')
  }
  const endpoint = socket
  const generation = clientGeneration
  const state = client.getState()
  if (state.status !== 'connected' || !endpoint) throw new Error('Profile daemon is unavailable')
  if (!validId(args.workspace_id) || !state.catalog?.workspaces.some((item) => item.id === args.workspace_id)) {
    throw new Error('Workspace is unavailable in this profile')
  }
  const request: Record<string, unknown> = { workspace_id: args.workspace_id }
  const keys = new Set(['workspace_id'])
  if (op === 'script.start') {
    if (typeof args.name !== 'string' || !/^[a-zA-Z0-9_:-][a-zA-Z0-9_.:-]{0,63}$/.test(args.name)) {
      throw new Error('Invalid script name')
    }
    request.name = args.name
    keys.add('name')
  }
  if (op === 'script.inspect' || op === 'script.stop' || op === 'script.retire') {
    if (typeof args.run_id !== 'string' || !/^script_[a-zA-Z0-9_.:-]+_[a-fA-F0-9-]{36}$/.test(args.run_id)) {
      throw new Error('Invalid script run ID')
    }
    request.run_id = args.run_id
    keys.add('run_id')
  }
  if (op === 'script.inspect') {
    if (!Number.isSafeInteger(args.tail_bytes) || (args.tail_bytes as number) < 1 || (args.tail_bytes as number) > 32768) {
      throw new Error('Invalid script output limit')
    }
    request.tail_bytes = args.tail_bytes
    keys.add('tail_bytes')
  }
  if (Object.keys(args).some((key) => !keys.has(key))) throw new Error('Unknown script request field')
  const result = await requestDaemon(endpoint, op, request)
  if (generation !== clientGeneration || socket !== endpoint) {
    throw new Error('Profile changed while the script request completed; inspect the original profile before retrying')
  }
  return result
})
ipcMain.handle('ade:service-request', async (_event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !serviceOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid service request')
  }
  const args = fields as Record<string, unknown>
  if (switching && !['service.list', 'service.inspect', 'service.proxy.inspect', 'service.proxy.recovery.inspect', 'listener.list'].includes(op)) {
    throw new Error('Profile switch is in progress; retry the service action in the selected profile')
  }
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
  if (op === 'service.proxy.recovery.inspect' || op === 'service.proxy.recovery.reset') {
    const request: Record<string, unknown> = {}
    if (op === 'service.proxy.recovery.inspect' && Object.keys(args).length) {
      throw new Error('URL recovery inspection does not accept fields')
    }
    if (op === 'service.proxy.recovery.reset') {
      if (Object.keys(args).sort().join(',') !== 'confirm_reset,expected_registry_sha256' ||
        args.confirm_reset !== true || typeof args.expected_registry_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(args.expected_registry_sha256)) {
        throw new Error('Reset requires confirmation and the inspected registry SHA-256')
      }
      request.expected_registry_sha256 = args.expected_registry_sha256
    }
    const result = await requestDaemon(endpoint, op, request)
    if (generation !== clientGeneration || socket !== endpoint) {
      throw new Error('Profile changed while URL recovery completed; inspect the original profile before retrying')
    }
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
  if (op === 'service.proxy.ensure' || op === 'service.proxy.inspect' || op === 'service.proxy.remap' || op === 'service.proxy.retire' || op === 'service.proxy.recovery.retry') {
    if (typeof args.port_variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(args.port_variable)) {
      throw new Error('Invalid service port variable')
    }
    request.port_variable = args.port_variable
  }
  if (op === 'service.proxy.remap' || op === 'service.proxy.retire' || op === 'service.proxy.recovery.retry') {
    if (typeof args.expected_service_identity !== 'string' || !validId(args.expected_service_identity) ||
      !Number.isSafeInteger(args.expected_target_port) || (args.expected_target_port as number) < 1 || (args.expected_target_port as number) > 65535 ||
      (op === 'service.proxy.remap' && (typeof args.expected_route_identity !== 'string' || !validId(args.expected_route_identity) ||
        !Number.isSafeInteger(args.expected_route_port) || (args.expected_route_port as number) < 1 || (args.expected_route_port as number) > 65535)) ||
      (op !== 'service.proxy.remap' && (typeof args.expected_route_id !== 'string' || !validId(args.expected_route_id) ||
        !Number.isSafeInteger(args.expected_proxy_port) || (args.expected_proxy_port as number) < 1 || (args.expected_proxy_port as number) > 65535))) {
      throw new Error('Invalid expected service targets')
    }
    request.expected_service_identity = args.expected_service_identity
    request.expected_target_port = args.expected_target_port
    if (op === 'service.proxy.remap') {
      request.expected_route_identity = args.expected_route_identity
      request.expected_route_port = args.expected_route_port
    } else {
      request.expected_route_id = args.expected_route_id
      request.expected_proxy_port = args.expected_proxy_port
    }
  }
  if (op === 'service.inspect') {
    if (!Number.isSafeInteger(args.tail_bytes) || (args.tail_bytes as number) < 1 || (args.tail_bytes as number) > 32768) {
      throw new Error('Invalid service output limit')
    }
    request.tail_bytes = args.tail_bytes
    if (args.health_check !== undefined) {
      const check = args.health_check
      if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error('Invalid HTTP health check')
      const fields = check as Record<string, unknown>
      if (typeof fields.port_variable !== 'string' || typeof fields.path !== 'string' ||
        !Number.isSafeInteger(fields.timeout_ms)) throw new Error('Invalid HTTP health check')
      request.health_check = { port_variable: fields.port_variable, path: fields.path, timeout_ms: fields.timeout_ms }
    }
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
const fileOps = new Set(['file.list', 'file.search', 'file.preview'])
ipcMain.handle('ade:file-request', async (event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !fileOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid file request')
  }
  const args = fields as Record<string, unknown>
  const context = activeReviewContext(event.sender.id, args.workspace_id)
  const workspaceId = args.workspace_id as string
  const request: Record<string, unknown> = { workspace_id: workspaceId }
  if (op === 'file.list' || op === 'file.preview') {
    if (op === 'file.list' && (args.path === undefined || args.path === '')) request.path = ''
    else if (!reviewPath(args.path)) throw new Error('Invalid relative file path')
    else request.path = args.path
  }
  if (op === 'file.search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256 || args.query.includes('\0')) {
      throw new Error('Invalid file search')
    }
    request.query = args.query.trim()
  }
  if (op !== 'file.preview') {
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || args.cursor.length > 16_384) throw new Error('Invalid file cursor')
      request.cursor = args.cursor
    }
    if (args.limit !== undefined) {
      if (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 100) throw new Error('Invalid file limit')
      request.limit = args.limit
    } else request.limit = 100
  }
  const response = await requestDaemon(context.endpoint, op, request)
  assertReviewContext(context, workspaceId)
  if (JSON.stringify(response).length > 1_000_000) throw new Error('File result exceeds the display limit')
  const expectedType = op.replace('.', '_')
  if (response.type !== expectedType) throw new Error('Invalid file response')
  return response
})
const conversationOps = new Set(['provider.list', 'account.list', 'account.create', 'account.inspect', 'account.verify', 'account.disable', 'conversation.create', 'conversation.get', 'agent.send', 'agent.retry_send', 'agent.answer', 'draft.get', 'draft.save', 'draft.flush'])
ipcMain.handle('ade:pending-sends', async () => (await journal().list()).map((record) => ({
  profileId: record.profileId, conversationId: record.conversationId,
  requestId: record.requestId, text: record.text,
})))
ipcMain.handle('ade:conversation-request', async (event, op: unknown, fields: unknown) => {
  if (typeof op !== 'string' || !conversationOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid conversation request')
  }
  const endpoint = socket
  const generation = clientGeneration
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
  if (op === 'account.list' || op === 'account.create' || op === 'account.inspect' || op === 'account.verify' || op === 'account.disable') {
    let request: Record<string, unknown> = {}
    if (op === 'account.create') {
      if (typeof args.provider !== 'string' || !['claude', 'codex', 'omp'].includes(args.provider) || typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) {
        throw new Error('Invalid managed account')
      }
      request = { provider: args.provider, name: args.name.trim() }
    } else if (op !== 'account.list') {
      if (!validId(args.account_id)) throw new Error('Invalid account')
      request = { account_id: args.account_id }
      if (op === 'account.verify') {
        if (!Number.isSafeInteger(args.expected_generation) || (args.expected_generation as number) < 0) {
          throw new Error('Invalid account generation')
        }
        const identity = args.expected_identity
        const expected = identity as Record<string, unknown> | null
        const claudeIdentity = expected && Object.keys(expected).sort().join(',') === 'api_provider,auth_method,email,org_id' &&
          expected.auth_method === 'claude.ai' && expected.api_provider === 'firstParty' &&
          typeof expected.email === 'string' && expected.email.length > 0 && expected.email.length <= 320 &&
          typeof expected.org_id === 'string' && expected.org_id.length > 0 && expected.org_id.length <= 256
        const codexIdentity = expected && Object.keys(expected).sort().join(',') === 'chatgpt_account_id,email' &&
          typeof expected.email === 'string' && expected.email.length > 0 && expected.email.length <= 320 &&
          typeof expected.chatgpt_account_id === 'string' && expected.chatgpt_account_id.length > 0 &&
          expected.chatgpt_account_id.length <= 256
        const ompIdentity = expected && Object.keys(expected).sort().join(',') ===
          'account_id,credential_id,credential_type,email,identity_key,org_id,provider' &&
          typeof expected.provider === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(expected.provider) &&
          Number.isSafeInteger(expected.credential_id) && (expected.credential_id as number) > 0 &&
          expected.credential_type === 'oauth' && typeof expected.identity_key === 'string' &&
          expected.identity_key.length > 0 && expected.identity_key.length <= 512 &&
          (expected.email === null || (typeof expected.email === 'string' && expected.email.length <= 320)) &&
          (expected.account_id === null || (typeof expected.account_id === 'string' && expected.account_id.length <= 320)) &&
          (expected.org_id === null || (typeof expected.org_id === 'string' && expected.org_id.length <= 320)) &&
          (Boolean(expected.email) || Boolean(expected.account_id))
        if (!identity || typeof identity !== 'object' || Array.isArray(identity) || (!claudeIdentity && !codexIdentity && !ompIdentity)) {
          throw new Error('Invalid inspected account identity')
        }
        request.expected_generation = args.expected_generation
        request.expected_identity = identity
      }
    }
    const result = await requestDaemon(endpoint, op, request)
    if (clientGeneration !== generation || socket !== endpoint) {
      throw new Error('Profile changed during account request; inspect the original profile before retrying')
    }
    return result
  }
  if (op === 'conversation.create') {
    const providers = await requestDaemon(endpoint, 'provider.list')
    const available = Array.isArray(providers.providers) ? providers.providers : []
    if (!validId(args.workspace_id) || !catalog?.workspaces.some((item) => item.id === args.workspace_id)
      || !available.some((item) => item && typeof item === 'object' && 'id' in item && item.id === args.provider)
      || typeof args.title !== 'string' || args.title.length > 256
      || (args.account_id !== undefined && !validId(args.account_id))) throw new Error('Invalid conversation creation')
    const result = await requestDaemon(endpoint, op, { workspace_id: args.workspace_id, provider: args.provider,
      title: args.title, ...(args.account_id === undefined ? {} : { account_id: args.account_id }) })
    if (clientGeneration !== generation || socket !== endpoint) throw new Error('Profile changed during conversation creation')
    return result
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
    await journal().upsert(journalRecord(entry, intent, false))
    entry.send = intent
    await e2ePauseAfterSendJournal()
    try { await flushDraft(entry) }
    catch {
      try { await journal().remove(journalIdentity(entry, intent)); entry.send = null }
      catch { throw new Error('Draft save and recovery cleanup failed; preserve the pending prompt') }
      throw new Error('Draft could not be saved; prompt was not sent')
    }
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

let warnedPendingSends: string | null = null
async function warnPendingSends(window?: BrowserWindow): Promise<void> {
  const pending = [...drafts.entries()]
    .filter(([key, entry]) => entry.send && (!window || key.startsWith(`${window.webContents.id}:`)))
    .map(([key, entry]) => `${key}:${entry.send?.requestId}`)
    .sort()
    .join('\n')
  if (!pending || pending === warnedPendingSends) return
  warnedPendingSends = pending
  if (process.env.ADE_E2E_USER_DATA_DIR) {
    console.error('Prompt delivery is unconfirmed; pending request IDs:', pending)
    return
  }
  const options = window
    ? { type: 'warning' as const, title: 'Prompt delivery is unconfirmed',
        message: 'This window is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' }
    : { type: 'warning' as const, title: 'Prompt delivery is unconfirmed',
        message: 'ADE is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' }
  if (window) await dialog.showMessageBox(window, options)
  else await dialog.showMessageBox(options)
}

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
    if (!owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) return
    event.preventDefault()
    closeFlushInProgress = true
    void (async () => {
      await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
        return
      }
      const pending = owned.filter((entry) => !entry.send && (entry.timer || entry.savedRevision < entry.draft.revision))
      const results = await Promise.allSettled(pending.map(flushDraft))
      if (results.some((result) => result.status === 'rejected')) {
        if (process.env.ADE_E2E_USER_DATA_DIR) console.error('Draft was not saved during window close')
        else await dialog.showMessageBox(window, { type: 'error', title: 'Draft was not saved',
          message: 'This window is staying open because a draft could not be saved.',
          detail: 'Restore the profile daemon and try closing the window again.' })
        return
      }
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
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
  sendJournal = await SendJournal.open(join(app.getPath('userData'), 'pending-sends-v1.json'))
  if (!managedProfiles && fixedSocket) {
    const fixedIdentity = createHash('sha256').update(resolve(fixedSocket)).digest('hex').slice(0, 32)
    await setBrowserProfile('fixed', join(app.getPath('userData'), 'browser-fixed', fixedIdentity))
  }
  unsubscribeClient = client.subscribe((state) => broadcast('ade:client-state-changed', state))
  unsubscribeFeed = client.subscribeFeed((frame) => broadcast('ade:feed-frame', frame))
  client.start()
  openMainWindow()
  if (managedProfiles) {
    startupProfileSelection = refreshProfiles().then(async (state) => {
      if (state.selectedId) await selectProfile(state.selectedId, false)
    }).catch((error) => { publishProfile({ error: String(error) }) }).finally(() => { startupProfileSelection = null })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
}).catch((error: unknown) => {
  if (process.env.ADE_E2E_USER_DATA_DIR) {
    console.error('ADE could not open its window:', error)
  } else {
    dialog.showErrorBox('ADE could not open its window', String(error))
  }
  app.quit()
})

let readyToQuit = false
let quitFlushInProgress = false
let browserReadyToQuit = false
let browserFlushInProgress = false
let quitRequested = false
app.on('before-quit', (event) => {
  quitRequested = true
  if (!readyToQuit && (process.env.ADE_E2E_HIDE_WINDOW !== '1' || process.env.ADE_E2E_TEST_CLOSE_GUARD === '1')) {
    const owned = [...drafts.values()]
    if (owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) {
      event.preventDefault()
      if (quitFlushInProgress) return
      quitFlushInProgress = true
      void (async () => {
        await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
        if (await unsafePending(owned)) {
          await warnPendingSends()
          return
        }
        const pending = owned.filter((entry) => !entry.send && (entry.timer || entry.savedRevision < entry.draft.revision))
        const results = await Promise.allSettled(pending.map(flushDraft))
        if (results.some((result) => result.status === 'rejected')) {
          if (process.env.ADE_E2E_USER_DATA_DIR) console.error('Draft was not saved during app quit')
          else await dialog.showMessageBox({ type: 'error', title: 'Draft was not saved',
            message: 'ADE is staying open because a draft could not be saved.',
            detail: 'Restore the profile daemon and try closing ADE again.' })
          return
        }
        if (await unsafePending(owned)) {
          await warnPendingSends()
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
        if (process.env.ADE_E2E_USER_DATA_DIR || process.env.ADE_E2E_HIDE_WINDOW === '1') {
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
  if (quitRequested || process.platform !== 'darwin') app.quit()
})
