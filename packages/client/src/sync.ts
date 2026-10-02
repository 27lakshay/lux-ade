// Feed catch-up for one conversation: the SDK's single implementation of
// snapshot-plus-delta synchronization. This module is transport-free and imports
// nothing from Node, so the Electron renderer can use it through `@ade/client/sync`.
// The caller injects how a snapshot is fetched and where frames come from.
import { decodedSizeWithin } from './size-bounds.js'

/**
 * The shared ADE message window. Snapshot reads request 32 messages, and merged deltas
 * retain the newest 32; older native history is loaded separately through conversation.history.
 */
export const CONVERSATION_WINDOW = 32

/** Retained-data bounds; decoded bytes estimate UTF-16 storage and metadata, not measured heap use. */
export const MAX_PROJECTION_ITEMS = 512
export const MAX_PROJECTION_DECODED_BYTES = 8 * 1024 * 1024
export const MAX_BUFFERED_FRAME_COUNT = 128
export const MAX_BUFFERED_FRAME_BYTES = 4 * 1024 * 1024

const RESOURCE_LIMIT_ERROR = 'Conversation history exceeded client resource limits; the projection may be incomplete.'

function boundedCollections(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const messages = record.messages
  const requests = record.requests
  const queued = record.queued
  if (!Array.isArray(messages) || !Array.isArray(requests) || (queued !== undefined && !Array.isArray(queued)))
    return false
  if (messages.length > CONVERSATION_WINDOW) return false
  const queuedCount = Array.isArray(queued) ? queued.length : 0
  return messages.length + requests.length + queuedCount <= MAX_PROJECTION_ITEMS
}

function snapshotWithinBounds(snapshot: unknown): boolean {
  return boundedCollections(snapshot) && decodedSizeWithin([snapshot], MAX_PROJECTION_DECODED_BYTES) !== null
}

function frameWithinBounds(frame: SyncFrame): boolean {
  if (!Array.isArray(frame.messages) || !Array.isArray(frame.requests)) return false
  const queued = frame.queued
  if (queued !== undefined && !Array.isArray(queued)) return false
  if (frame.messages.length > MAX_PROJECTION_ITEMS) return false
  const queuedCount = Array.isArray(queued) ? queued.length : 0
  return (
    frame.messages.length + frame.requests.length + queuedCount <= MAX_PROJECTION_ITEMS &&
    decodedSizeWithin([frame], MAX_PROJECTION_DECODED_BYTES) !== null
  )
}
/** A feed frame as the daemon stamps it: every frame carries the boot and global revision. */
export type SyncFrame = { [key: string]: unknown; type: string; boot_id: string; revision: number }

export type SyncMessage = { id: string; sequence: number }

export type ConversationSnapshot<
  C extends { id: string } = { id: string },
  M extends SyncMessage = SyncMessage,
  R = unknown,
> = { conversation: C; messages: M[]; requests: R[]; revision: number; boot_id: string; history_epoch?: number }

/** What one frame does to a projection that already holds a snapshot. */
export type FrameOutcome<S> =
  | { kind: 'duplicate' }
  | { kind: 'resnapshot'; reason: 'gap' | 'boot' | 'reload' }
  | { kind: 'advance'; snapshot: S }
  | { kind: 'changed'; snapshot: S }
  | { kind: 'degraded'; reason: 'resource-limit' }
  | { kind: 'deleted' }

/** The daemon's error code for a Conversation that has a deletion tombstone. */
export const CONVERSATION_DELETED = 'conversation_deleted'

/**
 * The pure reducer. Frames at or below the snapshot's revision on the same boot are
 * duplicates. A deletion for this conversation ends the projection. A different boot,
 * a revision gap or a reload needs a new snapshot. Relevant snapshots, frames and merged
 * projections must stay within the same bounded retention policy.
 */
export function reduceFrame<C extends { id: string }, M extends SyncMessage, R>(
  snapshot: ConversationSnapshot<C, M, R>,
  frame: SyncFrame,
  conversationId: string,
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
  if (!changed || changed.id !== conversationId) return advance
  if (
    !Array.isArray(frame.messages) ||
    !Array.isArray(frame.requests) ||
    !snapshotWithinBounds(snapshot) ||
    !frameWithinBounds(frame)
  )
    return { kind: 'degraded', reason: 'resource-limit' }
  const messages = new Map(snapshot.messages.map((message) => [message.id, message]))
  for (const item of frame.messages as M[]) {
    if (item && typeof item.id === 'string') messages.set(item.id, item)
  }
  const projected = {
    ...snapshot,
    conversation: changed,
    messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence).slice(-CONVERSATION_WINDOW),
    requests: frame.requests as R[],
    revision: frame.revision,
  }
  if (!snapshotWithinBounds(projected)) return { kind: 'degraded', reason: 'resource-limit' }
  return { kind: 'changed', snapshot: projected }
}

function conversationIdOf(frame: SyncFrame): string | undefined {
  const conversation = frame.conversation
  return conversation !== null && typeof conversation === 'object' && 'id' in conversation
    ? (conversation.id as string | undefined)
    : undefined
}

/**
 * A degraded projection retains the last admitted snapshot but has refused incoming
 * resource-over-budget data; error explains why it cannot claim to be complete.
 */
export type ProjectionStatus = 'loading' | 'current' | 'stale' | 'degraded' | 'deleted'

/** Why the listener was called: load/change/repair/deletion, or a resource-limit refusal. */
export type ProjectionCause = 'loaded' | 'failed' | 'changed' | 'stale' | 'degraded' | 'deleted'

export type ProjectionState<S> = { status: ProjectionStatus; snapshot: S | null; error: string | null }

export type ConversationProjectionOptions<S> = {
  conversationId: string
  /** Fetches a snapshot; it should request CONVERSATION_WINDOW messages. */
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
  let bufferedBytes = 0
  let bufferingDisabled = false
  let draining = false
  let degradedDuringDrain = false
  let resourceVersion = 0
  let resourceRecoveryUsed = false
  let load!: () => Promise<void>
  const emit = (cause: ProjectionCause): void => options.onState({ status, snapshot: shown, error }, cause)
  const clearBuffer = (): void => {
    buffered = []
    bufferedBytes = 0
  }
  const requestLoad = (): void => {
    reloadRequested = true
    if (!loading && !disposed && !deleted) {
      reloadRequested = false
      void load()
    }
  }
  const markResourceLimit = (): void => {
    if (disposed || deleted) return
    resourceVersion++
    current = null
    clearBuffer()
    bufferingDisabled = true
    status = 'degraded'
    error = RESOURCE_LIMIT_ERROR
    if (draining) degradedDuringDrain = true
    if (!draining) emit('degraded')
    if (!resourceRecoveryUsed) {
      resourceRecoveryUsed = true
      requestLoad()
    }
  }
  const markDeleted = (): void => {
    if (deleted) return
    deleted = true
    current = null
    shown = null
    clearBuffer()
    bufferingDisabled = true
    reloadRequested = false
    status = 'deleted'
    error = 'Conversation ' + conversationId + ' was deleted'
    emit('deleted')
  }
  const resnapshot = (): void => {
    current = null
    if (shown && status !== 'stale') {
      status = 'stale'
      if (!draining) emit('stale')
    }
    requestLoad()
  }
  const apply = (frame: SyncFrame): void => {
    if (disposed || deleted) return
    if (!current) {
      if (frame.type === CONVERSATION_DELETED && frame.conversation_id === conversationId) {
        markDeleted()
        return
      }
      if (bufferingDisabled) return
      if (buffered.length >= MAX_BUFFERED_FRAME_COUNT) {
        markResourceLimit()
        return
      }
      const frameBytes = decodedSizeWithin([frame], MAX_BUFFERED_FRAME_BYTES)
      if (frameBytes === null || bufferedBytes + frameBytes > MAX_BUFFERED_FRAME_BYTES) {
        markResourceLimit()
        return
      }
      buffered.push(frame)
      bufferedBytes += frameBytes
      if (!loading) void load()
      return
    }
    const outcome = reduceFrame(current, frame, conversationId)
    if (outcome.kind === 'duplicate') return
    if (outcome.kind === 'deleted') {
      markDeleted()
      return
    }
    if (outcome.kind === 'resnapshot') {
      if (outcome.reason !== 'reload') clearBuffer()
      resnapshot()
      return
    }
    if (outcome.kind === 'degraded') {
      markResourceLimit()
      return
    }
    current = outcome.snapshot
    if (outcome.kind === 'changed') {
      shown = current
      if (!draining) emit('changed')
    }
  }
  load = async (): Promise<void> => {
    if (loading || disposed || deleted) return
    if (status === 'degraded') {
      clearBuffer()
      bufferingDisabled = false
    }
    loading = true
    const resourceVersionAtStart = resourceVersion
    try {
      const value = await options.fetchSnapshot(conversationId, CONVERSATION_WINDOW)
      if (!disposed && !deleted) {
        if (!snapshotWithinBounds(value)) {
          markResourceLimit()
          return
        }
        if (resourceVersion !== resourceVersionAtStart) {
          status = 'degraded'
          error = RESOURCE_LIMIT_ERROR
          if (!draining) emit('degraded')
          return
        }
        current = value
        shown = value
        status = 'current'
        error = null
        bufferingDisabled = false
        const pending = buffered
        clearBuffer()
        degradedDuringDrain = false
        draining = true
        for (const frame of pending) {
          if (frame.boot_id === value.boot_id && frame.revision <= (current?.revision ?? -1)) continue
          apply(frame)
          if (!current) break
        }
        draining = false
        if (!deleted) {
          if (!degradedDuringDrain) status = current ? 'current' : 'stale'
          if (!degradedDuringDrain && status === 'current' && !reloadRequested) resourceRecoveryUsed = false
          emit(degradedDuringDrain ? 'degraded' : 'loaded')
        }
      }
    } catch (reason) {
      if (!disposed && !deleted) {
        if (isDeletedError(reason)) markDeleted()
        else if (status === 'degraded') {
          clearBuffer()
          bufferingDisabled = true
          error = RESOURCE_LIMIT_ERROR + ' Resnapshot failed: ' + String(reason)
          emit('degraded')
        } else {
          error = String(reason)
          emit('failed')
        }
      }
    } finally {
      draining = false
      loading = false
      if (!disposed && !deleted && reloadRequested) {
        reloadRequested = false
        void load()
      }
    }
  }
  const unsubscribe = options.subscribe(apply)
  void load()
  return () => {
    if (disposed) return
    disposed = true
    current = null
    shown = null
    clearBuffer()
    reloadRequested = false
    draining = false
    loading = false
    unsubscribe()
  }
}
