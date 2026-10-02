// Electron main's wiring for the SDK's send pipeline (@ade/client/journals): one in-memory
// draft entry per renderer view and Conversation, and the hooks that tie a send to the
// window's profile. The journal, the durable draft owner ID (ClientJournals.ownerId)
// and every delivery rule live in the SDK.
import { BrowserWindow } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  decodeDailyUseResponse,
  requestDaemon,
  type DailyUseOperation,
  type DailyUseRequest,
  type DailyUseResponse,
  type RequestOptions,
} from '@ade/client'
import { SendPipeline, type SendEntry, type SendJournal } from '@ade/client/journals'
import { emit } from '../ipc'
import { getClientGeneration, getSocket, journalProfileId } from '../profile-connection'
import type { PendingSendState } from '../../shared/bridge/conversations'

type Fields<O extends DailyUseOperation> = Omit<DailyUseRequest<O>, 'op'>

/** One daemon request whose reply is checked against the operation's contract. */
export async function daemon<O extends DailyUseOperation>(
  endpoint: string,
  op: O,
  fields: Fields<O>,
  options?: RequestOptions,
): Promise<DailyUseResponse<O>> {
  return decodeDailyUseResponse(op, await requestDaemon(endpoint, op, fields as Record<string, unknown>, options))
}

/** A renderer view's local draft cache entry; senderId only routes main-process errors. */
export type DraftEntry = SendEntry & { senderId: number; viewId: string }

export const windowIds = new Map<number, string>()
export const drafts = new Map<string, DraftEntry>()
export const draftKey = (senderId: number, endpoint: string, conversationId: string, viewId: string): string =>
  senderId + ':' + viewId + ':' + endpoint + ':' + conversationId

function publishDraftError(entry: DraftEntry, message: string): void {
  const window = BrowserWindow.getAllWindows().find((item) => item.webContents.id === entry.senderId)
  if (window && !window.isDestroyed())
    emit(window.webContents, 'ade:draft-error', { conversationId: entry.conversationId, viewId: entry.viewId, message })
}

async function e2ePauseAfterSendJournal(): Promise<void> {
  if (process.env.ADE_E2E_HIDE_WINDOW !== '1' || process.env.ADE_E2E_SEND_JOURNAL_PAUSE !== '1') return
  const signal = process.env.ADE_E2E_SEND_JOURNAL_SIGNAL
  const release = process.env.ADE_E2E_SEND_JOURNAL_RELEASE
  if (!signal || !release || !isAbsolute(signal) || !isAbsolute(release))
    throw new Error('Invalid send journal E2E pause paths')
  await writeFile(signal, 'paused', { flag: 'wx' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (
      await stat(release).then(
        () => true,
        () => false,
      )
    )
      return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Send journal E2E pause timed out')
}

/** A send may use its daemon while the window's profile connection is the one it started on. */
function session(entry: DraftEntry): () => boolean {
  const generation = getClientGeneration()
  return () => getSocket() === entry.endpoint && getClientGeneration() === generation
}

let sendPipeline: SendPipeline<DraftEntry> | null = null
export const setSendJournal = (journal: SendJournal): void => {
  sendPipeline = new SendPipeline<DraftEntry>(journal, {
    session,
    draftError: publishDraftError,
    journaled: e2ePauseAfterSendJournal,
  })
}
export function pipeline(): SendPipeline<DraftEntry> {
  if (!sendPipeline) throw new Error('Send recovery journal is unavailable')
  return sendPipeline
}

export const flushDraft = (entry: DraftEntry): Promise<void> => pipeline().flush(entry)
export const reconcileAcceptedSend = (entry: DraftEntry): Promise<void> => pipeline().reconcileAccepted(entry)
export const unsafePending = (entries: DraftEntry[]): Promise<boolean> => pipeline().unsafePending(entries)

/** The view's entry for a Conversation, loaded once from the daemon and the journal. */
export async function loadDraft(
  senderId: number,
  endpoint: string,
  conversationId: string,
  viewId: string,
): Promise<DraftEntry> {
  const key = draftKey(senderId, endpoint, conversationId, viewId)
  const cached = drafts.get(key)
  if (cached) return cached
  const windowId = windowIds.get(senderId)
  if (!windowId) throw new Error('Window is unavailable')
  const entry = await pipeline().open(
    { endpoint, profileId: journalProfileId(endpoint), windowId, conversationId },
    { senderId, viewId },
  )
  const concurrent = drafts.get(key)
  if (concurrent) return concurrent
  drafts.set(key, entry)
  return entry
}

export function pendingSend(entry: DraftEntry): PendingSendState | null {
  if (!entry.send) return null
  return { request_id: entry.send.requestId, text: entry.send.text, state: entry.send.state }
}
