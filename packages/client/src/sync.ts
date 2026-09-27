// Feed catch-up for one conversation: the SDK's single implementation of
// snapshot-plus-delta synchronization. This module is transport-free and imports
// nothing from Node, so the Electron renderer can use it through `@ade/client/sync`.
// The caller injects how a snapshot is fetched and where frames come from.

/**
 * The one message window shared by snapshots and merged deltas. The snapshot asks
 * `conversation.get` for this many messages, and applied deltas keep the newest
 * this many, so a projection never holds more or fewer than a fresh snapshot would.
 * The daemon also caps a `conversation.get` page at 200.
 */
export const CONVERSATION_WINDOW = 200

/** A feed frame as the daemon stamps it: every frame carries the boot and global revision. */
export type SyncFrame = { [key: string]: unknown; type: string; boot_id: string; revision: number }

export type SyncMessage = { id: string; sequence: number }

export type ConversationSnapshot<C extends { id: string } = { id: string }, M extends SyncMessage = SyncMessage,
  R = unknown> = { conversation: C; messages: M[]; requests: R[]; revision: number; boot_id: string }

/** What one frame does to a projection that already holds a snapshot. */
export type FrameOutcome<S> =
  | { kind: 'duplicate' }
  | { kind: 'resnapshot'; reason: 'gap' | 'boot' | 'reload' }
  | { kind: 'advance'; snapshot: S }
  | { kind: 'changed'; snapshot: S }
  | { kind: 'deleted' }

/** The daemon's error code for a Conversation that has a deletion tombstone. */
export const CONVERSATION_DELETED = 'conversation_deleted'

/**
 * The pure reducer. Frames at or below the snapshot's revision on the same boot are
 * duplicates. A `conversation_deleted` for this conversation ends the projection,
 * whatever gap or boot change came before it. A different boot, a revision gap, or a
 * `conversation_reload` for this conversation needs a new snapshot. The revision is
 * global, so every other frame advances it; a `conversation_changed` for this
 * conversation also merges messages by ID, sorts them by sequence, keeps the newest
 * window and replaces the requests.
 */
export function reduceFrame<C extends { id: string }, M extends SyncMessage, R>(
  snapshot: ConversationSnapshot<C, M, R>, frame: SyncFrame, conversationId: string,
): FrameOutcome<ConversationSnapshot<C, M, R>> {
  if (frame.boot_id === snapshot.boot_id && frame.revision <= snapshot.revision) return { kind: 'duplicate' }
  if (frame.type === CONVERSATION_DELETED && frame.conversation_id === conversationId) return { kind: 'deleted' }
  if (frame.boot_id !== snapshot.boot_id) return { kind: 'resnapshot', reason: 'boot' }
  if (frame.revision !== snapshot.revision + 1) return { kind: 'resnapshot', reason: 'gap' }
  if (frame.type === 'conversation_reload' && conversationIdOf(frame) === conversationId) {
    return { kind: 'resnapshot', reason: 'reload' }
  }
  const advance = { kind: 'advance' as const, snapshot: { ...snapshot, revision: frame.revision } }
  if (frame.type !== 'conversation_changed') return advance
  const changed = frame.conversation as C | undefined
  if (!changed || changed.id !== conversationId || !Array.isArray(frame.messages) || !Array.isArray(frame.requests)) {
    return advance
  }
  const messages = new Map(snapshot.messages.map((message) => [message.id, message]))
  for (const item of frame.messages as M[]) {
    if (item && typeof item.id === 'string') messages.set(item.id, item)
  }
  return { kind: 'changed', snapshot: { ...snapshot, conversation: changed,
    messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence).slice(-CONVERSATION_WINDOW),
    requests: frame.requests as R[], revision: frame.revision } }
}

function conversationIdOf(frame: SyncFrame): string | undefined {
  const conversation = frame.conversation
  return conversation !== null && typeof conversation === 'object' && 'id' in conversation
    ? (conversation).id as string | undefined
    : undefined
}

/**
 * `loading`: no snapshot has been applied yet. `current`: a snapshot is applied and
 * the buffered frames are drained. `stale`: a snapshot was shown, but a gap, boot
 * change or reload is being repaired; `snapshot` is the last projection until then.
 * `deleted`: the Conversation was deleted. The projection holds no snapshot, ignores
 * every later frame and snapshot reply, and never loads again.
 */
export type ProjectionStatus = 'loading' | 'current' | 'stale' | 'deleted'

/**
 * Why the listener was called: a snapshot loaded and its buffer drained, a load
 * failed, a delta changed the projection, a repair began and the projection is stale,
 * or the Conversation was deleted.
 */
export type ProjectionCause = 'loaded' | 'failed' | 'changed' | 'stale' | 'deleted'

export type ProjectionState<S> = { status: ProjectionStatus; snapshot: S | null; error: string | null }

export type ConversationProjectionOptions<S> = {
  conversationId: string
  /** Fetches a snapshot; it should request `CONVERSATION_WINDOW` messages. */
  fetchSnapshot: (conversationId: string, limit: number) => Promise<S>
  /** Subscribes to feed frames and returns the unsubscribe function. */
  subscribe: (listener: (frame: SyncFrame) => void) => () => void
  onState: (state: ProjectionState<S>, cause: ProjectionCause) => void
}

/** Whether a failed snapshot fetch reports the Conversation deleted. */
function isDeletedError(reason: unknown): boolean {
  return reason !== null && typeof reason === 'object' && (reason as { code?: unknown }).code === CONVERSATION_DELETED
}

/**
 * Keeps one conversation's projection current from a snapshot and the feed. It
 * buffers frames until the first snapshot loads, drops duplicates, and takes a new
 * snapshot on a boot change, revision gap or reload, queuing one if a load is in flight.
 * A `conversation_deleted` frame, or a snapshot fetch refused as `conversation_deleted`,
 * ends it: a snapshot read before the deletion and delivered late is dropped.
 * It subscribes and loads at once; call the returned function to stop.
 */
export function startConversationProjection<C extends { id: string }, M extends SyncMessage, R>(
  options: ConversationProjectionOptions<ConversationSnapshot<C, M, R>>,
): () => void {
  type S = ConversationSnapshot<C, M, R>
  const { conversationId } = options
  let disposed = false
  let deleted = false
  let current: S | null = null
  let shown: S | null = null
  let status: ProjectionStatus = 'loading'
  let error: string | null = null
  let loading = false
  let reloadRequested = false
  let buffered: SyncFrame[] = []
  let draining = false
  const emit = (cause: ProjectionCause): void => options.onState({ status, snapshot: shown, error }, cause)
  const markDeleted = (): void => {
    if (deleted) return
    deleted = true
    current = null
    shown = null
    buffered = []
    reloadRequested = false
    status = 'deleted'
    error = `Conversation ${conversationId} was deleted`
    emit('deleted')
  }
  const resnapshot = (): void => {
    current = null
    if (shown && status !== 'stale') { status = 'stale'; if (!draining) emit('stale') }
    reloadRequested = true
    if (!loading) { reloadRequested = false; void load() }
  }
  const apply = (frame: SyncFrame): void => {
    if (deleted) return
    if (!current) {
      if (frame.type === CONVERSATION_DELETED && frame.conversation_id === conversationId) { markDeleted(); return }
      buffered.push(frame)
      if (!loading) void load()
      return
    }
    const outcome = reduceFrame(current, frame, conversationId)
    if (outcome.kind === 'duplicate') return
    if (outcome.kind === 'deleted') { markDeleted(); return }
    if (outcome.kind === 'resnapshot') {
      if (outcome.reason !== 'reload') buffered = []
      resnapshot()
      return
    }
    current = outcome.snapshot
    if (outcome.kind === 'changed') { shown = current; if (!draining) emit('changed') }
  }
  const load = async (): Promise<void> => {
    if (loading || disposed || deleted) return
    loading = true
    try {
      const value = await options.fetchSnapshot(conversationId, CONVERSATION_WINDOW)
      if (!disposed && !deleted) {
        current = value
        shown = value
        error = null
        const pending = buffered
        buffered = []
        draining = true
        for (const frame of pending) {
          if (frame.boot_id === value.boot_id && frame.revision <= (current?.revision ?? -1)) continue
          apply(frame)
          if (!current) break
        }
        draining = false
        if (!deleted) {
          status = current ? 'current' : 'stale'
          emit('loaded')
        }
      }
    } catch (reason) {
      if (!disposed && !deleted) {
        if (isDeletedError(reason)) markDeleted()
        else { error = String(reason); emit('failed') }
      }
    } finally {
      draining = false
      loading = false
      if (!disposed && !deleted && reloadRequested) { reloadRequested = false; void load() }
    }
  }
  const unsubscribe = options.subscribe(apply)
  void load()
  return () => { disposed = true; unsubscribe() }
}
