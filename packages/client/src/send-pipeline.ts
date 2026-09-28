// The send pipeline: one window's drafts and prompts, delivered through the send
// journal. The journal holds a prompt only until the daemon admits it. `admitted`
// records that this client saw the daemon hold the intent (from
// `draft.send.prepare`, `draft.send.get` or `draft.send.list`); from then on the
// daemon's intent is the recovery record and the journal entry is dropped.
//
// Framework-neutral: a client supplies its journal and hooks. Electron main keeps
// one entry per window and Conversation; the CLI uses `sendJournaled` below.
import { decodeResponse, type Operation, type Request, type Response } from '@ade/contracts'
import { decideSendRecovery, findPendingSend } from './outbox.js'
import { DaemonRequestError, isDaemonRefusal, requestDaemon, type RequestOptions } from './request.js'
import { sameReviewAnchor, sameReviewFeedback, type ReviewAnchor, type ReviewFeedback } from './review.js'
import type { SendJournal, SendJournalIdentity, SendJournalRecord } from './send-journal.js'

type Fields<O extends Operation> = Omit<Request<O>, 'op'>
type Attachments = Fields<'draft.save'>['attachments']

/** One daemon request whose reply is checked against the operation's contract. */
async function daemon<O extends Operation>(
  endpoint: string,
  op: O,
  fields: Fields<O>,
  options?: RequestOptions,
): Promise<Response<O>> {
  return decodeResponse(op, await requestDaemon(endpoint, op, fields as Record<string, unknown>, options))
}

/** A draft as a client holds it. Attachments pass through unchecked. */
export type SendDraft = { text: string; revision: number; attachments: unknown[] }

/** A prompt being delivered. It keeps its request ID until the daemon settles it. */
export type SendIntent = {
  requestId: string
  draftText: string
  revision: number
  text: string
  attachments: unknown[]
  state: 'pending' | 'rejected'
  preparing: boolean
  admitted: boolean
  inFlight: Promise<SendResult> | null
  reviewAnchor?: ReviewAnchor
  reviewFeedback?: ReviewFeedback
}

/** Who owns a draft: the daemon's draft owner is a window of one profile. */
export type SendOwner = { endpoint: string; profileId: string; windowId: string; conversationId: string }

/** One window's draft for one Conversation, and the prompt it is delivering. */
export type SendEntry = SendOwner & {
  draft: SendDraft
  timer: ReturnType<typeof setTimeout> | null
  pending: Promise<void>
  savedRevision: number
  error: string
  unclearedText: string
  send: SendIntent | null
}

/** A prompt whose delivery is unconfirmed; retrying reuses its request ID. */
export type SendPending = { type: 'send_pending'; request_id: string; text: string; message?: string }
/** A prompt the daemon had already accepted, found and acknowledged by reconciliation. */
export type SendReconciled = { type: 'ack'; request_id: string; reconciled: true }
/** How a send ends. */
export type SendResult = Response<'agent.send'> | SendPending | SendReconciled

export type SendPipelineHooks<E extends SendEntry> = {
  /**
   * Called when a dispatch starts. The returned check says whether the dispatch
   * may still talk to the entry's daemon; when it turns false the send stops and
   * is reported pending. The default never stops.
   */
  session?(entry: E, intent: SendIntent): () => boolean
  /** A draft save failed (`message`) or recovered (`''`). */
  draftError?(entry: E, message: string): void
  /** Runs after the journal holds a new prompt and before its draft is saved. */
  journaled?(entry: E, intent: SendIntent): Promise<void>
}

function journalIdentity(entry: SendOwner, intent: SendIntent): SendJournalIdentity {
  return {
    profileId: entry.profileId,
    windowId: entry.windowId,
    conversationId: entry.conversationId,
    requestId: intent.requestId,
  }
}

function journalRecord(entry: SendOwner, intent: SendIntent, dispatchStarted: boolean): SendJournalRecord {
  return {
    ...journalIdentity(entry, intent),
    endpoint: entry.endpoint,
    text: intent.text,
    draftText: intent.draftText,
    draftRevision: intent.revision,
    attachments: intent.attachments,
    dispatchStarted,
    ...(intent.reviewAnchor ? { reviewAnchor: intent.reviewAnchor } : {}),
    ...(intent.reviewFeedback ? { reviewFeedback: intent.reviewFeedback } : {}),
  }
}

function localRecord(entry: SendOwner, records: SendJournalRecord[]): SendJournalRecord | null {
  return (
    records.find(
      (item) =>
        item.profileId === entry.profileId &&
        item.windowId === entry.windowId &&
        item.conversationId === entry.conversationId,
    ) ?? null
  )
}

type DaemonSendIntent = Response<'draft.send.list'>['sends'][number]['intent']
type PendingDaemonSend = Response<'draft.send.list'>['sends'][number]

function sameDaemonIntent(saved: DaemonSendIntent, intent: SendIntent): boolean {
  return (
    saved.request_id === intent.requestId &&
    saved.text === intent.text &&
    saved.draft_text === intent.draftText &&
    saved.draft_revision === intent.revision &&
    JSON.stringify(saved.attachments) === JSON.stringify(intent.attachments) &&
    sameReviewAnchor(saved.review_anchor, intent.reviewAnchor) &&
    sameReviewFeedback(saved.review_feedback, intent.reviewFeedback)
  )
}

/** What `draft.send.list` reports for this window and Conversation. */
function daemonSend(entry: SendOwner, options?: RequestOptions): Promise<PendingDaemonSend | null> {
  return findPendingSend(entry.conversationId, (after) =>
    daemon(
      entry.endpoint,
      'draft.send.list',
      { window_id: entry.windowId, limit: 200, ...(after === undefined ? {} : { after }) },
      options,
    ),
  )
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

export class SendPipeline<E extends SendEntry = SendEntry> {
  constructor(
    readonly journal: SendJournal,
    private readonly hooks: SendPipelineHooks<E> = {},
  ) {}

  /** Every unresolved send the daemon holds for one window, across Conversations. */
  // Electron main calls this and the other suppressed members through its pipeline()
  // accessor (apps/desktop/src/main/conversations), which fallow cannot follow.
  // fallow-ignore-next-line unused-class-member
  async listWindowSends(endpoint: string, windowId: string): Promise<PendingDaemonSend[]> {
    const sends: PendingDaemonSend[] = []
    let after: string | undefined
    for (let page = 0; page < 16; page++) {
      const reply = await daemon(endpoint, 'draft.send.list', {
        window_id: windowId,
        limit: 200,
        ...(after === undefined ? {} : { after }),
      })
      sends.push(...reply.sends)
      if (!reply.next_cursor) return sends
      if (after !== undefined && reply.next_cursor <= after) throw new Error('Pending send list did not advance')
      after = reply.next_cursor
    }
    throw new Error('Pending send list is too long to read')
  }

  private async journaled(entry: E): Promise<boolean> {
    const intent = entry.send
    if (!intent) return true
    const identity = journalIdentity(entry, intent)
    return (await this.journal.list()).some(
      (record) =>
        record.profileId === identity.profileId &&
        record.windowId === identity.windowId &&
        record.conversationId === identity.conversationId &&
        record.requestId === identity.requestId &&
        record.text === intent.text &&
        record.draftText === intent.draftText &&
        record.draftRevision === intent.revision &&
        JSON.stringify(record.attachments) === JSON.stringify(intent.attachments) &&
        sameReviewAnchor(record.reviewAnchor, intent.reviewAnchor) &&
        sameReviewFeedback(record.reviewFeedback, intent.reviewFeedback),
    )
  }

  /** A pending send is safe to leave once the daemon holds its intent or the journal holds its exact record. */
  // fallow-ignore-next-line unused-class-member
  async unsafePending(entries: E[]): Promise<boolean> {
    for (const entry of entries) {
      if (entry.send && !entry.send.admitted && !(await this.journaled(entry).catch(() => false))) return true
    }
    return false
  }

  private draftError(entry: E, message: string): void {
    this.hooks.draftError?.(entry, message)
  }

  /**
   * Settles an admitted send through `draft.send.acknowledge`. The daemon completes an
   * accepted prompt and releases a rejected one; it refuses anything it cannot prove
   * and never dispatches. Either settlement ends this send, and the daemon's draft
   * becomes the window's draft.
   */
  private async acknowledgeSend(entry: E, intent: SendIntent, timeoutMs?: number): Promise<'completed' | 'aborted'> {
    if (localRecord(entry, await this.journal.list())?.restoreHold) {
      throw new Error('Restored prompt is held until its source outcome is reconciled')
    }
    const result = await daemon(
      entry.endpoint,
      'draft.send.acknowledge',
      { conversation_id: entry.conversationId, window_id: entry.windowId, request_id: intent.requestId },
      { timeoutMs },
    )
    const draft = result.draft as SendDraft
    if (
      result.request_id !== intent.requestId ||
      result.conversation_id !== entry.conversationId ||
      !draft ||
      typeof draft.text !== 'string' ||
      !Number.isSafeInteger(draft.revision) ||
      (result.resolution === 'completed' && draft.text !== '')
    )
      throw new Error('Invalid send acknowledgement')
    draft.attachments ??= []
    if (entry.send !== intent) throw new Error('Prompt changed during acknowledgement')
    await this.journal.remove(journalIdentity(entry, intent))
    entry.draft = draft
    entry.savedRevision = draft.revision
    entry.unclearedText = ''
    entry.error = ''
    this.draftError(entry, '')
    entry.send = null
    return result.resolution
  }

  /** Marks the intent as held by the daemon and drops its pre-admission journal record. */
  private async admit(entry: E, intent: SendIntent): Promise<void> {
    intent.admitted = true
    // A restore-held record stays for the transfer bundle. Any other record left
    // behind matches the daemon intent, and the next load reconciles it.
    try {
      if (localRecord(entry, await this.journal.list())?.restoreHold) return
      await this.journal.remove(journalIdentity(entry, intent))
    } catch {
      /* Kept records are reconciled against the daemon on the next load. */
    }
  }

  /** Saves the entry's draft to the daemon, after any save already under way. */
  flush(entry: E): Promise<void> {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.savedRevision >= entry.draft.revision) return entry.pending
    const draft = { ...entry.draft }
    entry.pending = entry.pending
      .catch(() => undefined)
      .then(async () => {
        if (entry.savedRevision >= draft.revision) return
        const response = await daemon(entry.endpoint, 'draft.save', {
          conversation_id: entry.conversationId,
          window_id: entry.windowId,
          text: draft.text,
          revision: draft.revision,
          attachments: draft.attachments as Attachments,
        })
        const saved = response.draft as SendDraft
        if (!saved || saved.revision < draft.revision) throw new Error('Draft was not saved')
        entry.savedRevision = saved.revision
        entry.error = ''
        this.draftError(entry, '')
      })
      .catch((error: unknown) => {
        entry.error = `Draft could not be saved: ${String(error)}`
        this.draftError(entry, entry.error)
        throw error
      })
    return entry.pending
  }

  /** Saves the entry's draft after a short pause in typing. */
  // fallow-ignore-next-line unused-class-member
  schedule(entry: E): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void this.flush(entry).catch(() => undefined)
    }, 250)
  }

  /**
   * Loads a window's draft and any prompt it was delivering, from the daemon and the
   * journal. They must agree; a conflict is refused so both records survive for review.
   * `extra` is merged into the entry, for the client's own fields.
   */
  // fallow-ignore-next-line unused-class-member
  async open(owner: SendOwner, extra: Omit<E, keyof SendEntry>): Promise<E> {
    const { endpoint, profileId, windowId, conversationId } = owner
    const fields = { conversation_id: conversationId, window_id: windowId }
    const [response, pending, journalRecords] = await Promise.all([
      daemon(endpoint, 'draft.get', fields),
      daemon(endpoint, 'draft.send.get', fields),
      this.journal.list(),
    ])
    const value = response.draft as SendDraft
    if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision))
      throw new Error('Invalid draft response')
    value.attachments ??= []
    if (pending.restored_from_backup !== undefined && typeof pending.restored_from_backup !== 'boolean') {
      throw new Error('Invalid restored-profile provenance; prompt recovery is unavailable')
    }
    const restoredFromBackup = pending.restored_from_backup === true
    const recovered = pending.intent as {
      request_id?: unknown
      draft_text?: unknown
      draft_revision?: unknown
      text?: unknown
      attachments?: unknown
      state?: unknown
      review_anchor?: unknown
      review_feedback?: unknown
    } | null
    if (
      recovered &&
      (!validId(recovered.request_id) ||
        typeof recovered.text !== 'string' ||
        typeof recovered.draft_text !== 'string' ||
        !Number.isSafeInteger(recovered.draft_revision) ||
        !Array.isArray(recovered.attachments) ||
        !['pending', 'rejected'].includes(String(recovered.state)))
    )
      throw new Error('Invalid send intent response')
    let recorded = localRecord(owner, journalRecords) ?? undefined
    if (
      recorded &&
      recovered &&
      (recorded.requestId !== recovered.request_id ||
        recorded.text !== recovered.text ||
        recorded.draftText !== recovered.draft_text ||
        recorded.draftRevision !== recovered.draft_revision ||
        JSON.stringify(recorded.attachments) !== JSON.stringify(recovered.attachments) ||
        !sameReviewAnchor(recorded.reviewAnchor, recovered.review_anchor) ||
        !sameReviewFeedback(recorded.reviewFeedback, recovered.review_feedback))
    ) {
      throw new Error('Local prompt recovery conflicts with the profile daemon; preserve both records for review')
    }
    // The daemon's intent is the recovery record once it exists. Only a restored
    // profile's intent is copied into the journal, as a held record, because the
    // pending-send transfer bundle reconciles against held records.
    if (!recorded && recovered && restoredFromBackup) {
      await this.journal.upsert({
        profileId,
        windowId,
        conversationId,
        requestId: recovered.request_id as string,
        endpoint,
        text: recovered.text as string,
        draftText: recovered.draft_text as string,
        draftRevision: recovered.draft_revision as number,
        attachments: recovered.attachments as unknown[],
        ...(recovered.review_anchor ? { reviewAnchor: recovered.review_anchor as ReviewAnchor } : {}),
        ...(recovered.review_feedback ? { reviewFeedback: recovered.review_feedback as ReviewFeedback } : {}),
        dispatchStarted: true,
        restoreHold: true,
      })
    } else if (recorded && restoredFromBackup && !recorded.restoreHold) {
      recorded = { ...recorded, restoreHold: true }
      await this.journal.upsert(recorded)
    } else if (recorded && recovered && !recorded.restoreHold) {
      // Admitted before the record could be dropped, or written by an older build.
      await this.journal
        .remove({ profileId, windowId, conversationId, requestId: recorded.requestId })
        .catch(() => false)
    }
    const restored =
      recorded ??
      (recovered
        ? {
            requestId: recovered.request_id as string,
            text: recovered.text as string,
            draftText: recovered.draft_text as string,
            draftRevision: recovered.draft_revision as number,
            attachments: recovered.attachments as unknown[],
            ...(recovered.review_anchor ? { reviewAnchor: recovered.review_anchor as ReviewAnchor } : {}),
            ...(recovered.review_feedback ? { reviewFeedback: recovered.review_feedback as ReviewFeedback } : {}),
          }
        : null)
    const visibleDraft = recorded
      ? { text: recorded.draftText, revision: recorded.draftRevision, attachments: recorded.attachments }
      : value
    const entry: SendEntry = {
      endpoint,
      profileId,
      conversationId,
      windowId,
      draft: visibleDraft,
      timer: null,
      pending: Promise.resolve(),
      savedRevision: value.revision,
      error: '',
      unclearedText: '',
      send: restored
        ? {
            requestId: restored.requestId,
            text: restored.text,
            draftText: restored.draftText,
            revision: restored.draftRevision,
            attachments: restored.attachments,
            reviewAnchor: restored.reviewAnchor,
            reviewFeedback: restored.reviewFeedback,
            state: (recovered?.state as 'pending' | 'rejected') || 'pending',
            preparing: false,
            admitted: recovered !== null,
            inFlight: null,
          }
        : null,
    }
    return Object.assign(entry, extra) as E
  }

  /** The live path: `agent.send` just accepted the prompt, so complete its intent. */
  private async acceptedSend(
    entry: E,
    intent: SendIntent,
    response: Response<'agent.send' | 'agent.send_review'>,
  ): Promise<Response<'agent.send' | 'agent.send_review'>> {
    if (localRecord(entry, await this.journal.list())?.restoreHold) {
      throw new Error('Restored prompt is held until its source outcome is reconciled')
    }
    const result = await daemon(entry.endpoint, 'draft.send.complete', {
      conversation_id: entry.conversationId,
      window_id: entry.windowId,
      request_id: intent.requestId,
    })
    const cleared = result.draft as SendDraft
    if (!cleared || cleared.text !== '' || !Number.isSafeInteger(cleared.revision))
      throw new Error('Invalid completed draft')
    cleared.attachments ??= []
    await this.journal.remove(journalIdentity(entry, intent))
    entry.draft = cleared
    entry.savedRevision = cleared.revision
    entry.unclearedText = ''
    entry.error = ''
    this.draftError(entry, '')
    entry.send = null
    return response
  }

  /**
   * Closing a view must not turn an uncertain prompt into a new provider request.
   * Only a prompt the daemon lists as accepted, or one it already settled, is
   * acknowledged here; everything else keeps its request ID for a later retry.
   */
  // fallow-ignore-next-line unused-class-member
  async reconcileAccepted(entry: E): Promise<void> {
    const intent = entry.send
    if (!intent || intent.preparing) return
    if (intent.inFlight)
      await new Promise<void>((resolveWait) => {
        const timeout = setTimeout(resolveWait, 1_500)
        void intent.inFlight?.then(
          () => {
            clearTimeout(timeout)
            resolveWait()
          },
          () => {
            clearTimeout(timeout)
            resolveWait()
          },
        )
      })
    if (entry.send !== intent) return
    try {
      const listed = await daemonSend(entry, { timeoutMs: 3_000 })
      if (entry.send !== intent) return
      const accepted = listed !== null && listed.outcome === 'accepted' && sameDaemonIntent(listed.intent, intent)
      if (accepted || (listed === null && intent.admitted)) await this.acknowledgeSend(entry, intent, 3_000)
    } catch {
      /* Keep the original request ID and ask the user to retry after recovery. */
    }
  }

  /**
   * Starts a new prompt: the journal holds it before anything reaches the daemon,
   * then the draft is saved and the prompt dispatched. A draft that cannot be
   * saved drops the prompt again, so nothing was sent.
   */
  // fallow-ignore-next-line unused-class-member
  async begin(entry: E, intent: SendIntent): Promise<SendResult> {
    await this.journal.upsert(journalRecord(entry, intent, false))
    entry.send = intent
    await this.hooks.journaled?.(entry, intent)
    try {
      await this.flush(entry)
    } catch {
      try {
        await this.journal.remove(journalIdentity(entry, intent))
        entry.send = null
      } catch {
        throw new Error('Draft save and recovery cleanup failed; preserve the pending prompt')
      }
      throw new Error('Draft could not be saved; prompt was not sent')
    }
    intent.draftText = entry.draft.text
    intent.revision = entry.draft.revision
    intent.attachments = entry.draft.attachments
    intent.preparing = false
    return this.dispatch(entry, intent)
  }

  /**
   * Drives one send to a result the daemon can prove. The next step comes from
   * `decideSendRecovery`: replay the pre-admission steps, deliver with the original
   * ID, acknowledge, release, or keep the ID and report the send as pending.
   */
  dispatch(entry: E, intent: SendIntent): Promise<SendResult> {
    if (intent.inFlight) return intent.inFlight
    const activeProfile = this.hooks.session?.(entry, intent) ?? (() => true)
    const journal = this.journal
    const uncertain = (): SendPending => ({
      type: 'send_pending',
      request_id: intent.requestId,
      text: intent.text,
      message: 'Prompt delivery is unconfirmed. Retry will use the same request ID.',
    })
    const reconciled: SendReconciled = { type: 'ack', request_id: intent.requestId, reconciled: true }
    const rejected = new Error('The profile daemon rejected this prompt before admission. The draft keeps its text.')

    // Settles an admitted send. A released (rejected) send throws `rejection`.
    const settle = async (rejection: unknown): Promise<SendResult> => {
      if (!activeProfile()) return uncertain()
      try {
        if ((await this.acknowledgeSend(entry, intent)) === 'completed') return reconciled
      } catch {
        return uncertain()
      }
      throw rejection
    }

    const deliver = async (): Promise<SendResult> => {
      if (!activeProfile()) return uncertain()
      try {
        const op = intent.reviewAnchor || intent.reviewFeedback ? 'agent.send_review' : 'agent.send'
        const raw = await requestDaemon(entry.endpoint, op, {
          conversation_id: entry.conversationId,
          request_id: intent.requestId,
          text: intent.text,
          attachments: intent.attachments,
          ...(intent.reviewAnchor ? { review_anchor: intent.reviewAnchor } : {}),
          ...(intent.reviewFeedback ? { review_feedback: intent.reviewFeedback } : {}),
        })
        // A reply that fails its contract is handled as a lost reply: the daemon is asked below.
        const response = decodeResponse(op, raw)
        if (!activeProfile()) return uncertain()
        try {
          return await this.acceptedSend(entry, intent, response)
        } catch {
          return uncertain()
        }
      } catch (error) {
        if (!activeProfile()) return uncertain()
        let after: PendingDaemonSend | null
        try {
          after = await daemonSend(entry)
        } catch {
          return uncertain()
        }
        if (after === null) return settle(error)
        if (!sameDaemonIntent(after.intent, intent)) return uncertain()
        if (after.outcome === 'accepted') return settle(error)
        if (after.outcome === 'rejected') return settle(error)
        return uncertain()
      }
    }

    // Pre-admission: the daemon holds no intent, so nothing was dispatched. Make the
    // daemon draft match the journaled one, then prepare with the original ID.
    const prepare = async (): Promise<SendResult> => {
      try {
        const response = await daemon(entry.endpoint, 'draft.get', {
          conversation_id: entry.conversationId,
          window_id: entry.windowId,
        })
        let saved = response.draft as SendDraft
        if (
          !saved ||
          !Number.isSafeInteger(saved.revision) ||
          (saved.attachments !== undefined && !Array.isArray(saved.attachments))
        )
          return uncertain()
        saved.attachments ??= []
        if (saved.revision < intent.revision) {
          const result = await daemon(entry.endpoint, 'draft.save', {
            conversation_id: entry.conversationId,
            window_id: entry.windowId,
            revision: intent.revision,
            text: intent.draftText,
            attachments: intent.attachments as Attachments,
          })
          saved = result.draft as SendDraft
          if (saved) saved.attachments ??= []
        }
        if (
          saved.revision !== intent.revision ||
          saved.text !== intent.draftText ||
          JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments)
        )
          return uncertain()
      } catch {
        return uncertain()
      }
      if (!activeProfile()) return uncertain()
      try {
        const prepared = await daemon(entry.endpoint, 'draft.send.prepare', {
          conversation_id: entry.conversationId,
          window_id: entry.windowId,
          request_id: intent.requestId,
          draft_text: intent.draftText,
          text: intent.text,
          revision: intent.revision,
          attachments: intent.attachments as Attachments,
          ...(intent.reviewAnchor ? { review_anchor: intent.reviewAnchor } : {}),
          ...(intent.reviewFeedback ? { review_feedback: intent.reviewFeedback } : {}),
        })
        const persisted = prepared.intent as { request_id?: string; state?: string } | null
        if (
          persisted?.request_id !== intent.requestId ||
          !['pending', 'rejected', 'completed'].includes(String(persisted.state))
        ) {
          throw new Error('Send intent was not admitted')
        }
        await this.admit(entry, intent)
        if (persisted.state === 'completed') return settle(rejected)
        intent.state = persisted.state as 'pending' | 'rejected'
        return persisted.state === 'rejected' ? settle(rejected) : deliver()
      } catch (error) {
        if (!activeProfile()) return uncertain()
        // The reply may be lost while the intent was admitted; ask the daemon.
        let after: PendingDaemonSend | null
        try {
          after = await daemonSend(entry)
        } catch {
          return uncertain()
        }
        if (!activeProfile()) return uncertain()
        if (after !== null) {
          if (!sameDaemonIntent(after.intent, intent)) return uncertain()
          await this.admit(entry, intent)
          return resume()
        }
        // No unresolved intent. A settled one returns its settlement again.
        try {
          if ((await this.acknowledgeSend(entry, intent)) === 'completed') return reconciled
          throw rejected
        } catch (settleError) {
          if (entry.send === null) throw settleError
        }
        if (
          !intent.admitted &&
          error instanceof DaemonRequestError &&
          (isDaemonRefusal(error) || error.code === 'invalid_request')
        ) {
          await journal.remove(journalIdentity(entry, intent))
          entry.send = null
          throw error
        }
        return uncertain()
      }
    }

    const resume = async (): Promise<SendResult> => {
      if (!activeProfile()) return uncertain()
      let records: SendJournalRecord[]
      let listed: PendingDaemonSend | null
      try {
        ;[records, listed] = await Promise.all([journal.list(), daemonSend(entry)])
      } catch {
        return uncertain()
      }
      if (!activeProfile()) return uncertain()
      const local = localRecord(entry, records)
      if (local && local.requestId === intent.requestId && local.text !== intent.text) return uncertain()
      // Without a journal record, only the daemon can prove this prompt exists.
      if (!local && !intent.admitted && listed === null) return uncertain()
      if (listed !== null && sameDaemonIntent(listed.intent, intent)) intent.admitted = true
      const action = decideSendRecovery({
        requestId: intent.requestId,
        admitted: intent.admitted,
        local: local && {
          requestId: local.requestId,
          restoreHold: local.restoreHold === true,
          admitted: local.dispatchStarted,
        },
        daemon: listed && {
          requestId: listed.intent.request_id,
          outcome: listed.outcome,
          matches: sameDaemonIntent(listed.intent, intent),
        },
      })
      switch (action.kind) {
        case 'hold':
          return {
            ...uncertain(),
            message:
              'Restored prompt is held until the source outcome is reconciled. It will not be dispatched automatically.',
          }
        case 'conflict':
          return uncertain()
        case 'acknowledge':
          return settle(rejected)
        case 'release':
          intent.state = 'rejected'
          return settle(rejected)
        case 'deliver':
          await this.admit(entry, intent)
          return deliver()
        case 'prepare':
          return prepare()
      }
    }

    const work = resume()
    intent.inFlight = work
    void work
      .finally(() => {
        intent.inFlight = null
      })
      .catch(() => undefined)
    return work
  }
}
