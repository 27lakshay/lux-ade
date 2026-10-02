import type {
  ConversationHistory,
  ConversationHistoryRequest,
  Message,
  ProviderHistorySnapshot,
  ProviderWorkerFailure,
} from '@ade/contracts'
import { decodedSizeWithin } from './size-bounds.js'
import { MAX_PROJECTION_DECODED_BYTES, MAX_PROJECTION_ITEMS } from './sync.js'

export const MAX_NATIVE_HISTORY_PAGE_ITEMS = 32
export const MAX_NATIVE_HISTORY_PAGE_BYTES = 512 * 1024
export const MAX_NATIVE_HISTORY_PAGES = MAX_PROJECTION_ITEMS
export const MAX_NATIVE_HISTORY_DECODED_BYTES = MAX_PROJECTION_DECODED_BYTES
export const MAX_NATIVE_HISTORY_RETAINED_BYTES = 8 * 1024 * 1024
const RETRY_BASE_DELAY_MS = 250
const RETRY_MAX_DELAY_MS = 2_000
const RETRYABLE_QUERY_FAILURES = new Set<ProviderWorkerFailure['code']>([
  'rate_limited',
  'provider_failure',
  'transport_failure',
  'timeout',
  'shutdown',
  'internal',
])
const MAX_ERROR_LENGTH = 2_000
const NODE_METADATA_BYTES = 64

export type ConversationHistoryQuery = Omit<ConversationHistoryRequest, 'op'>
export type NativeHistoryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error' | 'degraded'

export type NativeHistoryState = {
  status: NativeHistoryStatus
  historyEpoch: number
  snapshot: ProviderHistorySnapshot | null
  nativeCursor: string | null
  messages: Message[]
  loaded: boolean
  finished: boolean
  stale: boolean
  limitReached: boolean
  restartRequired: boolean
  retainedBytes: number
  failure: ProviderWorkerFailure | null
  error: string | null
}

export type NativeHistoryProjectionOptions = {
  conversationId: string
  historyEpoch: number
  provider: string
  isContextCurrent: () => boolean
  fetchPage: (request: ConversationHistoryQuery) => Promise<ConversationHistory>
  onState: (state: NativeHistoryState) => void
}

function sameOptional<T extends string | number>(left: T | null | undefined, right: T | null | undefined): boolean {
  return (left ?? null) === (right ?? null)
}

function sameSnapshot(left: ProviderHistorySnapshot, right: ProviderHistorySnapshot): boolean {
  return (
    left.provider === right.provider &&
    left.execution_id === right.execution_id &&
    left.generation === right.generation &&
    left.session === right.session &&
    left.source === right.source &&
    left.consistency === right.consistency &&
    left.invalidation_epoch === right.invalidation_epoch &&
    sameOptional(left.size_bytes, right.size_bytes) &&
    sameOptional(left.account_id, right.account_id) &&
    sameOptional(left.lineage, right.lineage) &&
    sameOptional(left.modified_at_ms, right.modified_at_ms)
  )
}

function snapshotMetadataBytes(snapshot: ProviderHistorySnapshot, cursor: string | null): number {
  let bytes = NODE_METADATA_BYTES + 11 * 16 + 24
  const addString = (value: string | null | undefined): void => {
    if (value !== null && value !== undefined) bytes += value.length * 2 + 16
  }
  addString(snapshot.provider)
  addString(snapshot.execution_id)
  addString(snapshot.generation)
  addString(snapshot.session)
  addString(snapshot.source)
  addString(snapshot.consistency)
  addString(snapshot.account_id)
  addString(snapshot.lineage)
  if (cursor !== null) bytes += cursor.length * 2 + 16
  return bytes
}

function failureMessage(result: ConversationHistory): string {
  const message = result.error?.message || 'The native history page was incomplete.'
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message
}

function isRetryableQueryFailure(failure: ProviderWorkerFailure | null): boolean {
  return failure !== null && RETRYABLE_QUERY_FAILURES.has(failure.code)
}

function queryRetryDelayMs(failures: number): number {
  return failures === 0 ? 0 : Math.min(RETRY_BASE_DELAY_MS * 2 ** (failures - 1), RETRY_MAX_DELAY_MS)
}

/**
 * Transport-free native-history paging. Cursors stay opaque; each accepted continuation must
 * match the identified native source and durable history epoch, even when consistency is best-effort.
 */
export function startNativeHistoryProjection(options: NativeHistoryProjectionOptions): {
  loadMore: () => Promise<void>
  stop: () => void
} {
  const { conversationId, historyEpoch } = options
  let disposed = false
  let pendingLoad: { cursor: string | null; snapshot: ProviderHistorySnapshot | null; promise: Promise<void> } | null =
    null
  let retryableFailures = 0
  let cancelRetryDelay: (() => void) | null = null
  let requestId = 0
  let sourceSnapshot: ProviderHistorySnapshot | null = null
  let pageBytes = new Map<string | null, number>()
  let pageDecodedBytes = new Map<string | null, number>()
  let pageMessages = new Map<string | null, Message[]>()
  let state: NativeHistoryState = {
    status: 'idle',
    historyEpoch,
    snapshot: null,
    nativeCursor: null,
    messages: [],
    loaded: false,
    finished: false,
    stale: false,
    limitReached: false,
    restartRequired: false,
    retainedBytes: 0,
    failure: null,
    error: null,
  }
  const emit = (): void => options.onState(state)
  const fail = (message: string, restartRequired = false, failure: ProviderWorkerFailure | null = null): void => {
    state = { ...state, status: 'error', error: message, failure, restartRequired }
    emit()
  }
  const waitForRetryDelay = (delayMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false
      const finish = (canContinue: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (cancelRetryDelay === cancel) cancelRetryDelay = null
        resolve(canContinue)
      }
      const timer = setTimeout(() => finish(true), delayMs)
      const cancel = (): void => finish(false)
      cancelRetryDelay = cancel
    })

  const executeLoadOlder = async (
    requestedCursor: string | null,
    requestedSnapshot: ProviderHistorySnapshot | null,
  ): Promise<void> => {
    if (disposed || state.finished || state.limitReached || state.restartRequired || !options.isContextCurrent()) return
    const currentRequestId = ++requestId
    state = { ...state, status: 'loading', error: null, failure: null }
    emit()
    const delayMs = queryRetryDelayMs(retryableFailures)
    if (delayMs > 0) {
      const canContinue = await waitForRetryDelay(delayMs)
      if (!canContinue || disposed || currentRequestId !== requestId || !options.isContextCurrent()) return
    }
    try {
      const result = await options.fetchPage({
        conversation_id: conversationId,
        history_epoch: historyEpoch,
        native_cursor: requestedCursor,
        snapshot: requestedSnapshot,
        max_items: MAX_NATIVE_HISTORY_PAGE_ITEMS,
        max_bytes: MAX_NATIVE_HISTORY_PAGE_BYTES,
      })
      if (disposed || currentRequestId !== requestId || !options.isContextCurrent()) return
      if (result.conversation_id !== conversationId || result.history_epoch !== historyEpoch) {
        fail('Conversation history changed while this page was loading. Reload the conversation to continue.', true)
        return
      }
      if (result.snapshot === null) {
        if (sourceSnapshot !== null || result.complete || result.stale) {
          fail(
            'The native history source changed while this page was loading. Reload the conversation to continue.',
            true,
          )
          return
        }
        retryableFailures = isRetryableQueryFailure(result.error) ? Math.min(retryableFailures + 1, 4) : 0
        fail(failureMessage(result), false, result.error)
        return
      }
      if (result.snapshot.provider !== options.provider) {
        fail(
          'The native history provider no longer matches this conversation. Reload the conversation to continue.',
          true,
        )
        return
      }
      if (sourceSnapshot !== null && !sameSnapshot(sourceSnapshot, result.snapshot)) {
        fail(
          'The native history source changed while this page was loading. Reload the conversation to continue.',
          true,
        )
        return
      }
      if (!Number.isSafeInteger(result.retained_bytes) || result.retained_bytes < 0) {
        fail('The native history page reported an invalid retained size.', true)
        return
      }
      if (result.stale && (result.complete || result.error === null)) {
        fail('The native history source returned an invalid stale page.', true)
        return
      }
      if (result.error !== null && !result.stale) {
        retryableFailures = isRetryableQueryFailure(result.error) ? Math.min(retryableFailures + 1, 4) : 0
        sourceSnapshot ??= result.snapshot
        state = {
          ...state,
          snapshot: sourceSnapshot,
          status: 'error',
          error: failureMessage(result),
          failure: result.error,
        }
        emit()
        return
      }
      if (
        result.messages.length > MAX_NATIVE_HISTORY_PAGE_ITEMS ||
        result.retained_bytes > MAX_NATIVE_HISTORY_PAGE_BYTES
      ) {
        state = {
          ...state,
          snapshot: sourceSnapshot ?? result.snapshot,
          status: 'degraded',
          limitReached: true,
          error: 'The native history page exceeded the client retention limit.',
        }
        emit()
        return
      }
      const decodedBytes = decodedSizeWithin(result.messages, MAX_NATIVE_HISTORY_DECODED_BYTES)
      if (decodedBytes === null) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history page exceeded the decoded-data limit.',
        }
        emit()
        return
      }
      if (
        !result.stale &&
        ((result.next_native_cursor === requestedCursor && !(result.complete && requestedCursor === null)) ||
          (!result.complete && result.next_native_cursor === null))
      ) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history cursor did not advance.',
        }
        emit()
        return
      }
      if (
        !result.stale &&
        result.next_native_cursor !== null &&
        result.next_native_cursor !== requestedCursor &&
        pageBytes.has(result.next_native_cursor)
      ) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history cursor repeated an earlier page.',
        }
        emit()
        return
      }

      const replacingPage = pageBytes.has(requestedCursor)
      const nextPageCount = pageBytes.size + (replacingPage ? 0 : 1)
      if (nextPageCount > MAX_NATIVE_HISTORY_PAGES) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history page retention limit was reached.',
        }
        emit()
        return
      }
      let pageMessageBytes = result.retained_bytes
      let aggregateDecodedBytes = decodedBytes
      let pageItemCount = result.messages.length
      let cursorMetadataBytes = requestedCursor === null ? 0 : requestedCursor.length * 2 + 16
      for (const [cursor, bytes] of pageBytes) {
        if (cursor === requestedCursor) continue
        pageMessageBytes += bytes
        aggregateDecodedBytes += pageDecodedBytes.get(cursor) ?? 0
        pageItemCount += pageMessages.get(cursor)?.length ?? 0
        if (cursor !== null) cursorMetadataBytes += cursor.length * 2 + 16
      }
      const nextCursor = result.stale ? requestedCursor : result.next_native_cursor
      const metadataBytes =
        snapshotMetadataBytes(result.snapshot, nextCursor) +
        nextPageCount * (NODE_METADATA_BYTES + 16) +
        pageItemCount * (NODE_METADATA_BYTES + 16) +
        cursorMetadataBytes
      const retainedBytes = pageMessageBytes + metadataBytes
      aggregateDecodedBytes += metadataBytes
      if (aggregateDecodedBytes > MAX_NATIVE_HISTORY_DECODED_BYTES) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history decoded-data retention limit was reached.',
        }
        emit()
        return
      }
      if (pageItemCount > MAX_PROJECTION_ITEMS || retainedBytes > MAX_NATIVE_HISTORY_RETAINED_BYTES) {
        state = {
          ...state,
          status: 'degraded',
          limitReached: true,
          error: 'The native history retention limit was reached.',
        }
        emit()
        return
      }
      const nextPageBytes = new Map(pageBytes)
      nextPageBytes.set(requestedCursor, result.retained_bytes)
      const nextPageDecodedBytes = new Map(pageDecodedBytes)
      nextPageDecodedBytes.set(requestedCursor, decodedBytes)
      const nextPageMessages = new Map(pageMessages)
      nextPageMessages.set(requestedCursor, result.messages)
      const merged = new Map<string, Message>()
      for (const pageMessages of nextPageMessages.values()) {
        for (const message of pageMessages) if (!merged.has(message.id)) merged.set(message.id, message)
      }
      retryableFailures = result.stale && isRetryableQueryFailure(result.error) ? Math.min(retryableFailures + 1, 4) : 0
      // Native page and item order is the provider's chronology. ADE sequence may be unknown (0).
      const messages = [...merged.values()]
      sourceSnapshot = result.snapshot
      pageBytes = nextPageBytes
      pageDecodedBytes = nextPageDecodedBytes
      pageMessages = nextPageMessages
      const acceptedPage = !result.stale
      state = {
        ...state,
        status: result.stale ? 'stale' : 'ready',
        snapshot: sourceSnapshot,
        nativeCursor: acceptedPage ? result.next_native_cursor : requestedCursor,
        messages,
        loaded: true,
        finished: acceptedPage && result.complete && result.next_native_cursor === null,
        stale: result.stale,
        retainedBytes,
        error: result.stale ? failureMessage(result) : null,
        failure: result.stale ? result.error : null,
      }
      emit()
    } catch (reason) {
      if (!disposed && currentRequestId === requestId && options.isContextCurrent()) {
        state = { ...state, status: 'error', error: String(reason).slice(0, MAX_ERROR_LENGTH), failure: null }
        emit()
      }
    }
  }

  const loadMore = (): Promise<void> => {
    if (pendingLoad !== null) {
      const sameSource =
        pendingLoad.snapshot === sourceSnapshot ||
        (pendingLoad.snapshot !== null && sourceSnapshot !== null && sameSnapshot(pendingLoad.snapshot, sourceSnapshot))
      return pendingLoad.cursor === state.nativeCursor && sameSource
        ? pendingLoad.promise
        : pendingLoad.promise.then(loadMore)
    }
    if (disposed || state.finished || state.limitReached || state.restartRequired || !options.isContextCurrent()) {
      return Promise.resolve()
    }
    const cursor = state.nativeCursor
    const snapshot = sourceSnapshot
    const promise = Promise.resolve().then(() => executeLoadOlder(cursor, snapshot))
    pendingLoad = { cursor, snapshot, promise }
    const clearPending = (): void => {
      if (pendingLoad?.promise === promise) pendingLoad = null
    }
    void promise.then(clearPending, clearPending)
    return promise
  }

  return {
    loadMore: loadMore,
    stop: () => {
      if (disposed) return
      disposed = true
      requestId++
      cancelRetryDelay?.()
      cancelRetryDelay = null
      pageBytes.clear()
      pageDecodedBytes.clear()
      pageMessages.clear()
    },
  }
}
