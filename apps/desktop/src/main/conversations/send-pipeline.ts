import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DaemonRequestError, decodeDailyUseResponse, requestDaemon, type DailyUseOperation, type DailyUseRequest,
  type DailyUseResponse, type RequestOptions, type ReviewAnchor, type ReviewFeedback } from '@ade/client'
import { decideSendRecovery, findPendingSend } from '@ade/client/outbox'
import { getClientGeneration, getSocket, journalProfileId } from '../profile-connection'
import { reviewNote, sameReviewAnchor, sameReviewFeedback } from '../review'
import type { SendJournal, SendJournalIdentity, SendJournalRecord } from '../send-journal'
import { validId } from '../validation'
import { selectedWorkspaces } from '../workspaces'

type Draft = { text: string; revision: number; attachments: unknown[] }
type Fields<O extends DailyUseOperation> = Omit<DailyUseRequest<O>, 'op'>
type Attachments = Fields<'draft.save'>['attachments']

/** One daemon request whose reply is checked against the operation's contract. */
export async function daemon<O extends DailyUseOperation>(endpoint: string, op: O, fields: Fields<O>,
  options?: RequestOptions): Promise<DailyUseResponse<O>> {
  return decodeDailyUseResponse(op, await requestDaemon(endpoint, op, fields as Record<string, unknown>, options))
}
// The send journal holds a prompt only until the daemon admits it. `admitted`
// records that this process saw the daemon hold the intent (from
// `draft.send.prepare`, `draft.send.get` or `draft.send.list`); from then on the
// daemon's intent is the recovery record and the journal entry is dropped.
export type SendIntent = { requestId: string; draftText: string; revision: number; text: string; attachments: unknown[];
  state: 'pending' | 'rejected'; preparing: boolean; admitted: boolean; inFlight: Promise<Record<string, unknown>> | null;
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

/** A pending send is safe to leave once the daemon holds its intent or the journal holds its exact record. */
export async function unsafePending(entries: DraftEntry[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.send && !entry.send.admitted && !(await journaled(entry).catch(() => false))) return true
  }
  return false
}

function localRecord(entry: DraftEntry, records: SendJournalRecord[]): SendJournalRecord | null {
  return records.find((item) => item.profileId === entry.profileId &&
    item.windowId === entry.windowId && item.conversationId === entry.conversationId) ?? null
}

type DaemonSendIntent = DailyUseResponse<'draft.send.list'>['sends'][number]['intent']
type PendingDaemonSend = DailyUseResponse<'draft.send.list'>['sends'][number]

function sameDaemonIntent(saved: DaemonSendIntent, intent: SendIntent): boolean {
  return saved.request_id === intent.requestId && saved.text === intent.text &&
    saved.draft_text === intent.draftText && saved.draft_revision === intent.revision &&
    JSON.stringify(saved.attachments) === JSON.stringify(intent.attachments) &&
    sameReviewAnchor(saved.review_anchor, intent.reviewAnchor) &&
    sameReviewFeedback(saved.review_feedback, intent.reviewFeedback)
}

/** What `draft.send.list` reports for this window and Conversation. */
function daemonSend(entry: DraftEntry, options?: RequestOptions): Promise<PendingDaemonSend | null> {
  return findPendingSend(entry.conversationId, (after) => daemon(entry.endpoint, 'draft.send.list', {
    window_id: entry.windowId, limit: 200, ...(after === undefined ? {} : { after }),
  }, options))
}

/** Every unresolved send the daemon holds for one window, across Conversations. */
export async function listWindowSends(endpoint: string, windowId: string): Promise<PendingDaemonSend[]> {
  const sends: PendingDaemonSend[] = []
  let after: string | undefined
  for (let page = 0; page < 16; page++) {
    const reply = await daemon(endpoint, 'draft.send.list', { window_id: windowId, limit: 200,
      ...(after === undefined ? {} : { after }) })
    sends.push(...reply.sends)
    if (!reply.next_cursor) return sends
    if (after !== undefined && reply.next_cursor <= after) throw new Error('Pending send list did not advance')
    after = reply.next_cursor
  }
  throw new Error('Pending send list is too long to read')
}

/**
 * Settles an admitted send through `draft.send.acknowledge`. The daemon completes an
 * accepted prompt and releases a rejected one; it refuses anything it cannot prove
 * and never dispatches. Either settlement ends this send, and the daemon's draft
 * becomes the window's draft.
 */
async function acknowledgeSend(entry: DraftEntry, intent: SendIntent,
  timeoutMs?: number): Promise<'completed' | 'aborted'> {
  if (localRecord(entry, await journal().list())?.restoreHold) {
    throw new Error('Restored prompt is held until its source outcome is reconciled')
  }
  const result = await daemon(entry.endpoint, 'draft.send.acknowledge', {
    conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId,
  }, { timeoutMs })
  const draft = result.draft as Draft
  if (result.request_id !== intent.requestId || result.conversation_id !== entry.conversationId ||
    !draft || typeof draft.text !== 'string' || !Number.isSafeInteger(draft.revision) ||
    (result.resolution === 'completed' && draft.text !== '')) throw new Error('Invalid send acknowledgement')
  draft.attachments ??= []
  if (entry.send !== intent) throw new Error('Prompt changed during acknowledgement')
  await journal().remove(journalIdentity(entry, intent))
  entry.draft = draft
  entry.savedRevision = draft.revision
  entry.unclearedText = ''
  entry.error = ''
  publishDraftError(entry, '')
  entry.send = null
  return result.resolution
}

/** Marks the intent as held by the daemon and drops its pre-admission journal record. */
async function admit(entry: DraftEntry, intent: SendIntent): Promise<void> {
  intent.admitted = true
  // A restore-held record stays for the transfer bundle. Any other record left
  // behind matches the daemon intent, and the next load reconciles it.
  try {
    if (localRecord(entry, await journal().list())?.restoreHold) return
    await journal().remove(journalIdentity(entry, intent))
  } catch { /* Kept records are reconciled against the daemon on the next load. */ }
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
    const response = await daemon(entry.endpoint, 'draft.save', {
      conversation_id: entry.conversationId, window_id: entry.windowId,
      text: draft.text, revision: draft.revision, attachments: draft.attachments as Attachments,
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
    daemon(endpoint, 'draft.get', fields),
    daemon(endpoint, 'draft.send.get', fields),
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
  // The daemon's intent is the recovery record once it exists. Only a restored
  // profile's intent is copied into the journal, as a held record, because the
  // pending-send transfer bundle reconciles against held records.
  if (!recorded && recovered && restoredFromBackup) {
    await journal().upsert({ profileId, windowId, conversationId, requestId: recovered.request_id as string,
      endpoint, text: recovered.text as string, draftText: recovered.draft_text as string,
      draftRevision: recovered.draft_revision as number, attachments: recovered.attachments as unknown[],
      ...(recovered.review_anchor ? { reviewAnchor: recovered.review_anchor as ReviewAnchor } : {}),
      ...(recovered.review_feedback ? { reviewFeedback: recovered.review_feedback as ReviewFeedback } : {}),
      dispatchStarted: true, restoreHold: true })
  } else if (recorded && restoredFromBackup && !recorded.restoreHold) {
    recorded = { ...recorded, restoreHold: true }
    await journal().upsert(recorded)
  } else if (recorded && recovered && !recorded.restoreHold) {
    // Admitted before the record could be dropped, or written by an older build.
    await journal().remove({ profileId, windowId, conversationId, requestId: recorded.requestId }).catch(() => false)
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
      state: recovered?.state as 'pending' | 'rejected' || 'pending', preparing: false,
      admitted: recovered !== null, inFlight: null } : null }
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

/** The live path: `agent.send` just accepted the prompt, so complete its intent. */
async function acceptedSend(entry: DraftEntry, intent: SendIntent, response: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (localRecord(entry, await journal().list())?.restoreHold) {
    throw new Error('Restored prompt is held until its source outcome is reconciled')
  }
  const result = await daemon(entry.endpoint, 'draft.send.complete', {
    conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId,
  })
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
// Only a prompt the daemon lists as accepted, or one it already settled, is
// acknowledged here; everything else keeps its request ID for a later retry.
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
    const listed = await daemonSend(entry, { timeoutMs: 3_000 })
    if (entry.send !== intent) return
    const accepted = listed !== null && listed.outcome === 'accepted' && sameDaemonIntent(listed.intent, intent)
    if (accepted || (listed === null && intent.admitted)) await acknowledgeSend(entry, intent, 3_000)
  } catch { /* Keep the original request ID and ask the user to retry after recovery. */ }
}

/**
 * Drives one send to a result the daemon can prove. The next step comes from
 * `decideSendRecovery`: replay the pre-admission steps, deliver with the original
 * ID, acknowledge, release, or keep the ID and report the send as pending.
 */
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
  const reconciled = { type: 'ack', request_id: intent.requestId, reconciled: true }
  const rejected = new Error('The profile daemon rejected this prompt before admission. The draft keeps its text.')

  // Settles an admitted send. A released (rejected) send throws `rejection`.
  const settle = async (rejection: unknown): Promise<Record<string, unknown>> => {
    if (!activeProfile()) return uncertain()
    try {
      if (await acknowledgeSend(entry, intent) === 'completed') return reconciled
    } catch { return uncertain() }
    throw rejection
  }

  const deliver = async (): Promise<Record<string, unknown>> => {
    if (!activeProfile()) return uncertain()
    try {
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
      let after: PendingDaemonSend | null
      try { after = await daemonSend(entry) } catch { return uncertain() }
      if (after === null) return settle(error)
      if (!sameDaemonIntent(after.intent, intent)) return uncertain()
      if (after.outcome === 'accepted') return settle(error)
      if (after.outcome === 'rejected') return settle(error)
      return uncertain()
    }
  }

  // Pre-admission: the daemon holds no intent, so nothing was dispatched. Make the
  // daemon draft match the journaled one, then prepare with the original ID.
  const prepare = async (): Promise<Record<string, unknown>> => {
    try {
      const response = await daemon(entry.endpoint, 'draft.get', {
        conversation_id: entry.conversationId, window_id: entry.windowId,
      })
      let saved = response.draft as Draft
      if (!saved || !Number.isSafeInteger(saved.revision) ||
        (saved.attachments !== undefined && !Array.isArray(saved.attachments))) return uncertain()
      saved.attachments ??= []
      if (saved.revision < intent.revision) {
        const result = await daemon(entry.endpoint, 'draft.save', {
          conversation_id: entry.conversationId, window_id: entry.windowId,
          revision: intent.revision, text: intent.draftText, attachments: intent.attachments as Attachments,
        })
        saved = result.draft as Draft
        if (saved) saved.attachments ??= []
      }
      if (saved.revision !== intent.revision || saved.text !== intent.draftText ||
        JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments)) return uncertain()
    } catch { return uncertain() }
    if (!activeProfile()) return uncertain()
    try {
      const prepared = await daemon(entry.endpoint, 'draft.send.prepare', {
        conversation_id: entry.conversationId, window_id: entry.windowId,
        request_id: intent.requestId, draft_text: intent.draftText, text: intent.text,
        revision: intent.revision, attachments: intent.attachments as Attachments,
        ...(intent.reviewAnchor ? { review_anchor: intent.reviewAnchor } : {}),
        ...(intent.reviewFeedback ? { review_feedback: intent.reviewFeedback } : {}),
      })
      const persisted = prepared.intent as { request_id?: string; state?: string } | null
      if (persisted?.request_id !== intent.requestId ||
        !['pending', 'rejected', 'completed'].includes(String(persisted.state))) {
        throw new Error('Send intent was not admitted')
      }
      await admit(entry, intent)
      if (persisted.state === 'completed') return settle(rejected)
      intent.state = persisted.state as 'pending' | 'rejected'
      return persisted.state === 'rejected' ? settle(rejected) : deliver()
    } catch (error) {
      if (!activeProfile()) return uncertain()
      // The reply may be lost while the intent was admitted; ask the daemon.
      let after: PendingDaemonSend | null
      try { after = await daemonSend(entry) } catch { return uncertain() }
      if (!activeProfile()) return uncertain()
      if (after !== null) {
        if (!sameDaemonIntent(after.intent, intent)) return uncertain()
        await admit(entry, intent)
        return resume()
      }
      // No unresolved intent. A settled one returns its settlement again.
      try {
        if (await acknowledgeSend(entry, intent) === 'completed') return reconciled
        throw rejected
      } catch (settleError) {
        if (entry.send === null) throw settleError
      }
      if (!intent.admitted && error instanceof DaemonRequestError &&
        (error.code === 'daemon' || error.code === 'invalid_request')) {
        await journal().remove(journalIdentity(entry, intent))
        entry.send = null
        throw error
      }
      return uncertain()
    }
  }

  const resume = async (): Promise<Record<string, unknown>> => {
    if (!activeProfile()) return uncertain()
    let records: SendJournalRecord[]
    let listed: PendingDaemonSend | null
    try { [records, listed] = await Promise.all([journal().list(), daemonSend(entry)]) }
    catch { return uncertain() }
    if (!activeProfile()) return uncertain()
    const local = localRecord(entry, records)
    if (local && local.requestId === intent.requestId && local.text !== intent.text) return uncertain()
    // Without a journal record, only the daemon can prove this prompt exists.
    if (!local && !intent.admitted && listed === null) return uncertain()
    if (listed !== null && sameDaemonIntent(listed.intent, intent)) intent.admitted = true
    const action = decideSendRecovery({
      requestId: intent.requestId,
      admitted: intent.admitted,
      local: local && { requestId: local.requestId, restoreHold: local.restoreHold === true, admitted: local.dispatchStarted },
      daemon: listed && { requestId: listed.intent.request_id, outcome: listed.outcome, matches: sameDaemonIntent(listed.intent, intent) },
    })
    switch (action.kind) {
      case 'hold': return { ...uncertain(),
        message: 'Restored prompt is held until the source outcome is reconciled. It will not be dispatched automatically.' }
      case 'conflict': return uncertain()
      case 'acknowledge': return settle(rejected)
      case 'release': intent.state = 'rejected'; return settle(rejected)
      case 'deliver': await admit(entry, intent); return deliver()
      case 'prepare': return prepare()
    }
  }

  const work = resume()
  intent.inFlight = work
  void work.finally(() => { intent.inFlight = null }).catch(() => undefined)
  return work
}

