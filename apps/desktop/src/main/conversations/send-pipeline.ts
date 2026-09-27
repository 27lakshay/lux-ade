import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DaemonRequestError, requestDaemon, type ReviewAnchor, type ReviewFeedback } from '@ade/client'
import { getClientGeneration, getSocket, journalProfileId } from '../profile-connection'
import { reviewNote, sameReviewAnchor, sameReviewFeedback } from '../review'
import type { SendJournal, SendJournalIdentity, SendJournalRecord } from '../send-journal'
import { validId } from '../validation'
import { selectedWorkspaces } from '../workspaces'

type Draft = { text: string; revision: number; attachments: unknown[] }
export type SendIntent = { requestId: string; draftText: string; revision: number; text: string; attachments: unknown[];
  state: 'pending' | 'rejected'; preparing: boolean; inFlight: Promise<Record<string, unknown>> | null;
  reviewSelection?: { senderId: number; workspaceId: string; conversationId: string; epoch: number };
  reviewAnchor?: ReviewAnchor; reviewFeedback?: ReviewFeedback }
type DraftEntry = { senderId: number; endpoint: string; profileId: string; conversationId: string; windowId: string; draft: Draft; timer: ReturnType<typeof setTimeout> | null; pending: Promise<void>; savedRevision: number; error: string; unclearedText: string; send: SendIntent | null }
export const windowIds = new Map<number, string>()
let sendJournal: SendJournal | null = null
export const setSendJournal = (value: SendJournal): void => { sendJournal = value }
export function journal(): SendJournal {
  if (!sendJournal) throw new Error('Send recovery journal is unavailable')
  return sendJournal
}
export const drafts = new Map<string, DraftEntry>()
export const draftKey = (senderId: number, endpoint: string, conversationId: string): string => `${senderId}:${endpoint}:${conversationId}`
export function journalIdentity(entry: DraftEntry, intent: SendIntent): SendJournalIdentity {
  return { profileId: entry.profileId, windowId: entry.windowId,
    conversationId: entry.conversationId, requestId: intent.requestId }
}

export function journalRecord(entry: DraftEntry, intent: SendIntent, dispatchStarted: boolean): SendJournalRecord {
  return { ...journalIdentity(entry, intent), endpoint: entry.endpoint, text: intent.text,
    draftText: intent.draftText, draftRevision: intent.revision, attachments: intent.attachments,
    dispatchStarted, ...(intent.reviewAnchor ? { reviewAnchor: intent.reviewAnchor } : {}),
    ...(intent.reviewFeedback ? { reviewFeedback: intent.reviewFeedback } : {}) }
}
export async function e2ePauseAfterSendJournal(): Promise<void> {
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
    JSON.stringify(record.attachments) === JSON.stringify(intent.attachments) &&
    sameReviewAnchor(record.reviewAnchor, intent.reviewAnchor) &&
    sameReviewFeedback(record.reviewFeedback, intent.reviewFeedback))
}

export async function unsafePending(entries: DraftEntry[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.send && !(await journaled(entry).catch(() => false))) return true
  }
  return false
}
export async function persistentWindowId(): Promise<string> {
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
function publishDraftError(entry: DraftEntry, message: string): void {
  const window = BrowserWindow.getAllWindows().find((item) => item.webContents.id === entry.senderId)
  if (window && !window.isDestroyed()) window.webContents.send('ade:draft-error', { conversationId: entry.conversationId, message })
}

export function flushDraft(entry: DraftEntry): Promise<void> {
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

export function scheduleDraft(entry: DraftEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => { void flushDraft(entry).catch(() => undefined) }, 250)
}

export async function loadDraft(senderId: number, endpoint: string, conversationId: string): Promise<DraftEntry> {
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
    text?: unknown; attachments?: unknown; state?: unknown; review_anchor?: unknown; review_feedback?: unknown } | null
  if (recovered && (!validId(recovered.request_id) || typeof recovered.text !== 'string'
    || typeof recovered.draft_text !== 'string' || !Number.isSafeInteger(recovered.draft_revision)
    || !Array.isArray(recovered.attachments)
    || !['pending', 'rejected'].includes(String(recovered.state)))) throw new Error('Invalid send intent response')
  let recorded = journalRecords.find((item) => item.profileId === profileId && item.windowId === windowId &&
    item.conversationId === conversationId)
  if (recorded && recovered && (recorded.requestId !== recovered.request_id || recorded.text !== recovered.text ||
    recorded.draftText !== recovered.draft_text || recorded.draftRevision !== recovered.draft_revision ||
    JSON.stringify(recorded.attachments) !== JSON.stringify(recovered.attachments) ||
    !sameReviewAnchor(recorded.reviewAnchor, recovered.review_anchor) ||
    !sameReviewFeedback(recorded.reviewFeedback, recovered.review_feedback))) {
    throw new Error('Local prompt recovery conflicts with the profile daemon; preserve both records for review')
  }
  if (!recorded && recovered) {
    await journal().upsert({ profileId, windowId, conversationId, requestId: recovered.request_id as string,
      endpoint, text: recovered.text as string, draftText: recovered.draft_text as string,
      draftRevision: recovered.draft_revision as number, attachments: recovered.attachments as unknown[],
      ...(recovered.review_anchor ? { reviewAnchor: recovered.review_anchor as ReviewAnchor } : {}),
      ...(recovered.review_feedback ? { reviewFeedback: recovered.review_feedback as ReviewFeedback } : {}),
      dispatchStarted: true, ...(restoredFromBackup ? { restoreHold: true } : {}) })
  } else if (recorded && restoredFromBackup && !recorded.restoreHold) {
    recorded = { ...recorded, restoreHold: true }
    await journal().upsert(recorded)
  }
  const restored = recorded ?? (recovered ? { requestId: recovered.request_id as string,
    text: recovered.text as string, draftText: recovered.draft_text as string,
    draftRevision: recovered.draft_revision as number, attachments: recovered.attachments as unknown[],
    ...(recovered.review_anchor ? { reviewAnchor: recovered.review_anchor as ReviewAnchor } : {}),
    ...(recovered.review_feedback ? { reviewFeedback: recovered.review_feedback as ReviewFeedback } : {}) } : null)
  const visibleDraft = recorded ? { text: recorded.draftText, revision: recorded.draftRevision,
    attachments: recorded.attachments } : value
  const entry: DraftEntry = { senderId, endpoint, profileId, conversationId, windowId, draft: visibleDraft, timer: null,
    pending: Promise.resolve(), savedRevision: value.revision, error: '', unclearedText: '',
    send: restored ? { requestId: restored.requestId, text: restored.text,
      draftText: restored.draftText, revision: restored.draftRevision,
      attachments: restored.attachments,
      reviewAnchor: restored.reviewAnchor, reviewFeedback: restored.reviewFeedback,
      state: recovered?.state as 'pending' | 'rejected' || 'pending', preparing: false, inFlight: null } : null }
  const concurrent = drafts.get(key)
  if (concurrent) return concurrent
  drafts.set(key, entry)
  return entry
}

export function pendingSend(entry: DraftEntry): Record<string, unknown> | null {
  if (!entry.send) return null
  const anchor = entry.send.reviewAnchor
  return { request_id: entry.send.requestId, text: entry.send.text, state: entry.send.state,
    ...(anchor ? { review_anchor: anchor, review_note: reviewNote(entry.send.text, anchor) } : {}),
    ...(entry.send.reviewFeedback ? { review_feedback: entry.send.reviewFeedback } : {}) }
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
export async function reconcileAcceptedSend(entry: DraftEntry): Promise<void> {
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

export function dispatchSend(entry: DraftEntry, intent: SendIntent): Promise<Record<string, unknown>> {
  if (intent.inFlight) return intent.inFlight
  const generation = getClientGeneration()
  const activeProfile = (): boolean => {
    if (getSocket() !== entry.endpoint || getClientGeneration() !== generation) return false
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
          draft_revision?: number; attachments?: unknown[]; state?: string; review_anchor?: unknown; review_feedback?: unknown } | null
        if (!saved || saved.request_id !== intent.requestId || saved.text !== intent.text ||
          saved.draft_text !== intent.draftText || saved.draft_revision !== intent.revision ||
          JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments) ||
          !sameReviewAnchor(saved.review_anchor, intent.reviewAnchor) ||
          !sameReviewFeedback(saved.review_feedback, intent.reviewFeedback) ||
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
        ...(intent.reviewAnchor ? { review_anchor: intent.reviewAnchor } : {}),
        ...(intent.reviewFeedback ? { review_feedback: intent.reviewFeedback } : {}),
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
      const response = await requestDaemon(entry.endpoint, intent.reviewAnchor || intent.reviewFeedback ? 'agent.send_review' : 'agent.send', {
        conversation_id: entry.conversationId, request_id: intent.requestId, text: intent.text,
        attachments: intent.attachments,
        ...(intent.reviewAnchor ? { review_anchor: intent.reviewAnchor } : {}),
        ...(intent.reviewFeedback ? { review_feedback: intent.reviewFeedback } : {}),
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
