// Prompts sent straight to `agent.send` by a client with no draft of its own, such
// as the CLI. The send journal holds each prompt from before its first attempt
// until the daemon answers: a prompt whose daemon was unreachable, or whose reply
// was lost, stays held and is delivered later under the same request ID, which
// the daemon deduplicates. A daemon answer, acceptance or refusal, ends the record.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DaemonRequestError, requestDaemon, type DaemonResponse } from './request.js'
import type { SendJournal, SendJournalIdentity, SendJournalRecord } from './send-journal.js'

/** The draft owner a draftless client's records name. It never reaches the daemon. */
const directSendWindow = 'cli'

/**
 * The journal's profile ID for a daemon reached by socket path alone, with no
 * managed profile to name it. Electron main names a fixed socket the same way.
 */
export function socketProfileId(endpoint: string): string {
  return `fixed-${createHash('sha256').update(resolve(endpoint)).digest('hex').slice(0, 32)}`
}

/** A prompt the daemon did not answer. The journal still holds it under `requestId`. */
export class SendHeld extends Error {
  /** The failure's own code, such as `unavailable` or `timeout`. */
  readonly code: string
  constructor(
    readonly requestId: string,
    readonly failure: unknown,
  ) {
    super(
      `Prompt delivery is unconfirmed (${failure instanceof Error ? failure.message : String(failure)}). ` +
        `It is held as request ${requestId} and will be delivered once, with that ID, by the next delivery.`,
    )
    this.name = 'SendHeld'
    this.code = failure instanceof DaemonRequestError ? failure.code : 'outcome_unknown'
  }
}

/** One held prompt's delivery attempt. */
export type DirectDelivery =
  | { request_id: string; conversation_id: string; outcome: 'delivered'; response: DaemonResponse }
  | { request_id: string; conversation_id: string; outcome: 'refused' | 'held'; code: string; message: string }

/** Whether the daemon answered, or the request can never be sent: either way nothing is left to retry. */
function settledFailure(error: unknown): boolean {
  return (
    error instanceof DaemonRequestError &&
    (error.replied || (error.code === 'invalid_request' && error.delivery === 'not_sent'))
  )
}

function identity(record: SendJournalRecord): SendJournalIdentity {
  return {
    profileId: record.profileId,
    windowId: record.windowId,
    conversationId: record.conversationId,
    requestId: record.requestId,
  }
}

async function attempt(journal: SendJournal, endpoint: string, record: SendJournalRecord): Promise<DaemonResponse> {
  let response: DaemonResponse
  try {
    response = await requestDaemon(endpoint, 'agent.send', {
      conversation_id: record.conversationId,
      request_id: record.requestId,
      text: record.text,
    })
  } catch (error) {
    if (!settledFailure(error)) throw new SendHeld(record.requestId, error)
    await journal.remove(identity(record))
    throw error
  }
  await journal.remove(identity(record))
  return response
}

/**
 * Sends one prompt, journaled first. One prompt per profile and Conversation may
 * be held at a time; a different one is refused until the held one is delivered.
 * Throws `SendHeld` when the daemon did not answer.
 */
export async function sendJournaled(
  journal: SendJournal,
  owner: { endpoint: string; profileId: string; conversationId: string },
  prompt: { requestId: string; text: string },
): Promise<DaemonResponse> {
  const held = (await journal.list()).find(
    (record) =>
      record.profileId === owner.profileId &&
      record.windowId === directSendWindow &&
      record.conversationId === owner.conversationId,
  )
  if (held && held.requestId !== prompt.requestId) {
    throw new Error(
      `Prompt ${held.requestId} for this conversation is still awaiting delivery; deliver it before sending another`,
    )
  }
  if (held?.restoreHold) throw new Error('Restored prompt is held until its source outcome is reconciled')
  const record: SendJournalRecord = {
    profileId: owner.profileId,
    windowId: directSendWindow,
    conversationId: owner.conversationId,
    requestId: prompt.requestId,
    endpoint: owner.endpoint,
    text: prompt.text,
    draftText: '',
    draftRevision: 0,
    attachments: [],
    contextNodes: [],
    dispatchStarted: false,
  }
  await journal.upsert(record)
  return attempt(journal, owner.endpoint, record)
}

/** The prompts this profile's draftless client still holds. */
export async function heldDirectSends(journal: SendJournal, profileId: string): Promise<SendJournalRecord[]> {
  return (await journal.list()).filter(
    (record) => record.profileId === profileId && record.windowId === directSendWindow,
  )
}

/**
 * Delivers every held prompt of the profile once, each under its original request
 * ID. A restored prompt stays held for reconciliation.
 */
export async function deliverHeldSends(
  journal: SendJournal,
  endpoint: string,
  profileId: string,
): Promise<DirectDelivery[]> {
  const results: DirectDelivery[] = []
  for (const record of await heldDirectSends(journal, profileId)) {
    const base = { request_id: record.requestId, conversation_id: record.conversationId }
    if (record.restoreHold) {
      results.push({ ...base, outcome: 'held', code: 'restored_send_held', message: 'Restored prompt is held' })
      continue
    }
    try {
      results.push({ ...base, outcome: 'delivered', response: await attempt(journal, endpoint, record) })
    } catch (error) {
      const failure = error instanceof SendHeld ? error.failure : error
      results.push({
        ...base,
        outcome: error instanceof SendHeld ? 'held' : 'refused',
        code: failure instanceof DaemonRequestError ? failure.code : 'protocol',
        message: failure instanceof Error ? failure.message : String(failure),
      })
    }
  }
  return results
}
