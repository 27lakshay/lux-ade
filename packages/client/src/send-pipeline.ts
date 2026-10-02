// The send pipeline keeps each view's draft separate and shares owner-scoped prompt
// intents through the send journal. The journal holds a prompt only until daemon admission.
// The admitted flag records that this client saw the daemon hold the intent (from
// draft.send.prepare, draft.send.get or draft.send.list); after admission, the daemon's
// intent is the recovery record and the journal entry is dropped.
//
// Framework-neutral: Electron main keeps one entry per renderer view and Conversation,
// while the owner-scoped send state is shared; the CLI uses sendJournaled below.
import { randomUUID } from 'node:crypto'
import { decodeResponse, type Operation, type Request, type Response } from '@ade/contracts'
import { decideSendRecovery, findPendingSend } from './outbox.js'
import { DaemonRequestError, isDaemonRefusal, requestDaemon, type RequestOptions } from './request.js'
import type { SendJournal, SendJournalIdentity, SendJournalRecord } from './send-journal.js'

type Fields<O extends Operation> = Omit<Request<O>, 'op'>
type ContextNodes = NonNullable<Fields<'draft.save'>['context_nodes']>
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

/** A per-view draft snapshot; its attachments and context nodes follow the revision. */
export type SendDraft = { text: string; revision: number; attachments: unknown[]; context_nodes: unknown[] }

/** A prompt being delivered. It keeps its request ID until the daemon settles it. */
export type SendIntent = {
  requestId: string
  draftText: string
  revision: number
  text: string
  attachments: unknown[]
  contextNodes: unknown[]
  state: 'pending' | 'rejected'
  preparing: boolean
  admitted: boolean
  inFlight: Promise<SendResult> | null
}

/** Stable client owner identity scoped by profile, not an Electron BrowserWindow ID. */
export type SendOwner = { endpoint: string; profileId: string; windowId: string; conversationId: string }

/** A view's mutable draft and revision plus its reference to the owner's shared send intent. */
export type SendEntry = SendOwner & {
  draft: SendDraft
  timer: ReturnType<typeof setTimeout> | null
  pending: Promise<void>
  stashedRevision?: number
  recoveryPending?: boolean
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

type DraftSaveResult = { draft: SendDraft } | { conflictStashed: true }

function sameDraftContent(
  left: Pick<SendDraft, 'text' | 'attachments' | 'context_nodes'>,
  right: Pick<SendDraft, 'text' | 'attachments' | 'context_nodes'>,
): boolean {
  return (
    left.text === right.text &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.context_nodes) === JSON.stringify(right.context_nodes)
  )
}

async function stashDraft(endpoint: string, conversationId: string, windowId: string, draft: SendDraft): Promise<void> {
  const name = 'recovery-' + randomUUID()
  const recovery = await daemon(endpoint, 'draft.stash.save', {
    conversation_id: conversationId,
    window_id: windowId,
    name,
    text: draft.text,
    attachments: draft.attachments as Attachments,
    context_nodes: draft.context_nodes as ContextNodes,
  })
  if (
    !recovery.stash ||
    !['created', 'unchanged'].includes(recovery.outcome) ||
    recovery.stash.name !== name ||
    recovery.stash.conversation_id !== conversationId ||
    !sameDraftContent(recovery.stash, draft)
  ) {
    throw new Error('Draft changed elsewhere; its recovery copy could not be confirmed')
  }
}
async function saveDraftOrStash(
  endpoint: string,
  conversationId: string,
  windowId: string,
  draft: SendDraft,
  expectedRevision: number,
): Promise<DraftSaveResult> {
  try {
    const result = await daemon(endpoint, 'draft.save', {
      conversation_id: conversationId,
      window_id: windowId,
      expected_revision: expectedRevision,
      revision: draft.revision,
      text: draft.text,
      attachments: draft.attachments as Attachments,
      context_nodes: draft.context_nodes as ContextNodes,
    })
    const saved = result.draft as SendDraft
    if (!saved) throw new Error('Draft save returned no draft')
    saved.attachments ??= []
    saved.context_nodes ??= []
    if (saved.revision !== draft.revision || !sameDraftContent(saved, draft)) {
      await stashDraft(endpoint, conversationId, windowId, draft)
      return { conflictStashed: true }
    }
    return { draft: saved }
  } catch (error) {
    if (!(error instanceof DaemonRequestError) || error.code !== 'conflict') throw error
    await stashDraft(endpoint, conversationId, windowId, draft)
    return { conflictStashed: true }
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
    contextNodes: intent.contextNodes,
    dispatchStarted,
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
  if (!Array.isArray(saved.context_nodes)) throw new Error('Invalid send intent response')
  return (
    saved.request_id === intent.requestId &&
    saved.text === intent.text &&
    saved.draft_text === intent.draftText &&
    saved.draft_revision === intent.revision &&
    JSON.stringify(saved.attachments) === JSON.stringify(intent.attachments) &&
    JSON.stringify(saved.context_nodes) === JSON.stringify(intent.contextNodes)
  )
}
function sameSendIntent(left: SendIntent, right: SendIntent): boolean {
  if (
    left.requestId !== right.requestId ||
    left.text !== right.text ||
    left.draftText !== right.draftText ||
    left.revision !== right.revision
  )
    return false
  try {
    return (
      JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
      JSON.stringify(left.contextNodes) === JSON.stringify(right.contextNodes)
    )
  } catch {
    return false
  }
}

type SharedSendState = { intent: SendIntent | null }
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

/** A prompt still being prepared: its delivery is unconfirmed until the preparation settles. */
const pending = (intent: SendIntent): SendPending => ({
  type: 'send_pending',
  request_id: intent.requestId,
  text: intent.text,
})

export class SendPipeline<E extends SendEntry = SendEntry> {
  private readonly ownerSendStates = new Map<string, SharedSendState>()
  private readonly entrySendStates = new WeakMap<SendEntry, SharedSendState>()

  constructor(
    readonly journal: SendJournal,
    private readonly hooks: SendPipelineHooks<E> = {},
  ) {}

  private sharedState(owner: SendOwner): SharedSendState {
    const key = JSON.stringify([owner.endpoint, owner.profileId, owner.windowId, owner.conversationId])
    let state = this.ownerSendStates.get(key)
    if (!state) {
      state = { intent: null }
      this.ownerSendStates.set(key, state)
    }
    return state
  }

  private bindEntry(entry: E, state = this.sharedState(entry)): void {
    if (this.entrySendStates.has(entry)) return
    const initial = entry.send
    if (state.intent && initial && !sameSendIntent(state.intent, initial)) {
      throw new Error('Local prompt recovery conflicts with another view; preserve both records for review')
    }
    if (!state.intent && initial) state.intent = initial
    Object.defineProperty(entry, 'send', {
      configurable: true,
      enumerable: true,
      get: () => state.intent,
      set: (intent: SendIntent | null) => {
        state.intent = intent
      },
    })
    this.entrySendStates.set(entry, state)
  }

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
        JSON.stringify(record.contextNodes) === JSON.stringify(intent.contextNodes),
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
    draft.context_nodes ??= []
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
    if (entry.recoveryPending) return entry.pending
    if (entry.savedRevision >= entry.draft.revision || entry.stashedRevision === entry.draft.revision)
      return entry.pending
    const draft = { ...entry.draft }
    entry.pending = entry.pending
      .catch(() => undefined)
      .then(async () => {
        if (entry.savedRevision >= draft.revision || entry.stashedRevision === draft.revision) return
        const result = await saveDraftOrStash(
          entry.endpoint,
          entry.conversationId,
          entry.windowId,
          draft,
          entry.savedRevision,
        )
        if ('conflictStashed' in result) {
          entry.stashedRevision = draft.revision
          entry.error = 'Draft revision changed or could not be confirmed; its text and context are saved for recovery'
          this.draftError(entry, entry.error)
          return
        }
        entry.savedRevision = result.draft.revision
        entry.stashedRevision = undefined
        entry.error = ''
        this.draftError(entry, '')
      })
      .catch((error: unknown) => {
        entry.error = 'Draft could not be saved'
        this.draftError(entry, entry.error)
        throw error
      })
    return entry.pending
  }

  /** Saves the entry's draft after a short pause in typing. */
  // fallow-ignore-next-line unused-class-member
  schedule(entry: E): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.recoveryPending) return
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
    const sharedState = this.sharedState(owner)
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
    value.context_nodes ??= []
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
      context_nodes?: unknown
      state?: unknown
    } | null
    if (
      recovered &&
      (!validId(recovered.request_id) ||
        typeof recovered.text !== 'string' ||
        typeof recovered.draft_text !== 'string' ||
        !Number.isSafeInteger(recovered.draft_revision) ||
        !Array.isArray(recovered.attachments) ||
        !Array.isArray(recovered.context_nodes) ||
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
        JSON.stringify(recorded.contextNodes) !== JSON.stringify(recovered.context_nodes))
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
        contextNodes: recovered.context_nodes as unknown[],
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
            contextNodes: recovered.context_nodes as unknown[],
          }
        : null)
    const visibleDraft = recorded
      ? {
          text: recorded.draftText,
          revision: recorded.draftRevision,
          attachments: recorded.attachments,
          context_nodes: recorded.contextNodes,
        }
      : value
    const recoveredIntent: SendIntent | null = restored
      ? {
          requestId: restored.requestId,
          text: restored.text,
          draftText: restored.draftText,
          revision: restored.draftRevision,
          attachments: restored.attachments,
          contextNodes: restored.contextNodes,
          state: (recovered?.state as 'pending' | 'rejected') || 'pending',
          preparing: false,
          admitted: recovered !== null,
          inFlight: null,
        }
      : null
    if (sharedState.intent && recoveredIntent && !sameSendIntent(sharedState.intent, recoveredIntent)) {
      throw new Error('Local prompt recovery conflicts with the profile daemon; preserve both records for review')
    }
    if (!sharedState.intent) sharedState.intent = recoveredIntent
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
      send: sharedState.intent,
    }
    this.bindEntry(entry as E, sharedState)
    return Object.assign(entry, extra) as E
  }

  /**
   * Sends a prompt from the entry's draft under `requestId`. The same request and text again
   * continue the prompt the entry is delivering. Any other prompt is refused until that one
   * resolves, and until the last sent draft has cleared.
   */
  async listDraftStashes(entry: E): Promise<Response<'draft.stash.list'>['stashes']> {
    const response = await daemon(entry.endpoint, 'draft.stash.list', { conversation_id: entry.conversationId })
    return response.stashes
  }

  async restoreDraftStash(entry: E, name: string, stashRevision: number): Promise<Response<'draft.stash.restore'>> {
    this.bindEntry(entry)
    if (entry.send || entry.recoveryPending) throw new Error('Resolve the current prompt or recovery action first')
    if (
      !name ||
      name.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !Number.isSafeInteger(stashRevision) ||
      stashRevision < 1
    )
      throw new Error('Invalid draft recovery selection')
    entry.recoveryPending = true
    try {
      const localDraft = {
        ...entry.draft,
        attachments: structuredClone(entry.draft.attachments),
        context_nodes: structuredClone(entry.draft.context_nodes),
      }
      const [stashes, current] = await Promise.all([
        this.listDraftStashes(entry),
        daemon(entry.endpoint, 'draft.get', {
          conversation_id: entry.conversationId,
          window_id: entry.windowId,
        }),
      ])
      const selected = stashes.find(
        (stash) =>
          stash.name === name && stash.revision === stashRevision && stash.conversation_id === entry.conversationId,
      )
      if (!selected) throw new Error('Saved draft recovery changed; reload the recovery list')
      const latest = current.draft as SendDraft
      if (!latest || typeof latest.text !== 'string' || !Number.isSafeInteger(latest.revision))
        throw new Error('Invalid draft response while restoring recovery')
      latest.attachments ??= []
      latest.context_nodes ??= []
      if (!sameDraftContent(localDraft, selected) && entry.stashedRevision !== localDraft.revision) {
        await stashDraft(entry.endpoint, entry.conversationId, entry.windowId, localDraft)
      }
      if (!sameDraftContent(latest, selected) && !sameDraftContent(latest, localDraft)) {
        await stashDraft(entry.endpoint, entry.conversationId, entry.windowId, latest)
      }
      const revision = Math.max(latest.revision, localDraft.revision) + 1
      if (!Number.isSafeInteger(revision)) throw new Error('Draft revision is exhausted')
      const response = await daemon(entry.endpoint, 'draft.stash.restore', {
        conversation_id: entry.conversationId,
        window_id: entry.windowId,
        name,
        stash_revision: stashRevision,
        expected_revision: latest.revision,
        revision,
      })
      if (response.outcome === 'conflict') {
        entry.error = 'Draft changed before recovery could be restored; neither draft was overwritten'
        this.draftError(entry, entry.error)
        return response
      }
      entry.draft = {
        text: response.draft.text,
        revision: response.draft.revision,
        attachments: response.draft.attachments ?? [],
        context_nodes: response.context_nodes,
      }
      entry.savedRevision = response.draft.revision
      entry.stashedRevision = undefined
      entry.error = ''
      this.draftError(entry, '')
      return response
    } finally {
      entry.recoveryPending = false
    }
  }
  async send(entry: E, requestId: string, text: string): Promise<SendResult> {
    if (!validId(requestId) || typeof text !== 'string' || !text.trim()) throw new Error('Invalid prompt')
    this.bindEntry(entry)
    const current = entry.send
    if (current) {
      if (current.requestId !== requestId || current.text !== text)
        throw new Error('Resolve the previous prompt before starting another')
      return current.preparing ? pending(current) : this.dispatch(entry, current)
    }
    if (entry.unclearedText) throw new Error('Finish clearing the previous sent draft before sending again')
    return this.begin(entry, {
      requestId,
      text,
      draftText: entry.draft.text,
      revision: entry.draft.revision,
      attachments: entry.draft.attachments,
      contextNodes: structuredClone(entry.draft.context_nodes),
      state: 'pending',
      preparing: true,
      admitted: false,
      inFlight: null,
    })
  }

  /**
   * Delivers the prompt awaiting confirmation again, under its own request ID. `requestId`, when
   * given, must name that prompt.
   */
  async retry(entry: E, requestId?: string): Promise<SendResult> {
    this.bindEntry(entry)
    const current = entry.send
    if (!current) throw new Error('No prompt is awaiting confirmation')
    if (requestId !== undefined && requestId !== current.requestId)
      throw new Error('A different prompt is awaiting confirmation')
    return current.preparing ? pending(current) : this.dispatch(entry, current)
  }

  /** The live path: `agent.send` just accepted the prompt, so complete its intent. */
  private async acceptedSend(
    entry: E,
    intent: SendIntent,
    response: Response<'agent.send'>,
  ): Promise<Response<'agent.send'>> {
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
    cleared.context_nodes ??= []
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
    this.bindEntry(entry)
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
  async begin(entry: E, intent: SendIntent): Promise<SendResult> {
    this.bindEntry(entry)
    const current = entry.send
    if (current) {
      if (!sameSendIntent(current, intent)) throw new Error('Resolve the previous prompt before starting another')
      return current.preparing ? pending(current) : this.dispatch(entry, current)
    }
    entry.send = intent
    try {
      await this.journal.upsert(journalRecord(entry, intent, false))
    } catch (error) {
      if (entry.send === intent) entry.send = null
      throw error
    }
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
    this.bindEntry(entry)
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
        const raw = await requestDaemon(entry.endpoint, 'agent.send', {
          conversation_id: entry.conversationId,
          request_id: intent.requestId,
          text: intent.text,
          attachments: intent.attachments,
        })
        // A reply that fails its contract is handled as a lost reply: the daemon is asked below.
        const response = decodeResponse('agent.send', raw)
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
        saved.context_nodes ??= []
        if (saved.revision < intent.revision) {
          const result = await saveDraftOrStash(
            entry.endpoint,
            entry.conversationId,
            entry.windowId,
            {
              text: intent.draftText,
              revision: intent.revision,
              attachments: intent.attachments,
              context_nodes: intent.contextNodes,
            },
            saved.revision,
          )
          if ('conflictStashed' in result) return uncertain()
          saved = result.draft
        }
        if (
          saved.revision !== intent.revision ||
          saved.text !== intent.draftText ||
          JSON.stringify(saved.attachments) !== JSON.stringify(intent.attachments) ||
          JSON.stringify(saved.context_nodes ?? []) !== JSON.stringify(intent.contextNodes)
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
          context_nodes: intent.contextNodes as ContextNodes,
        })
        const persisted = prepared.intent as { request_id?: string; state?: string; context_nodes?: unknown } | null
        if (
          !persisted ||
          persisted.request_id !== intent.requestId ||
          !Array.isArray(persisted.context_nodes) ||
          JSON.stringify(persisted.context_nodes) !== JSON.stringify(intent.contextNodes) ||
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
