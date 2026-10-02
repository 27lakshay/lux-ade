import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_NATIVE_HISTORY_PAGE_BYTES,
  MAX_NATIVE_HISTORY_PAGE_ITEMS,
  MAX_NATIVE_HISTORY_RETAINED_BYTES,
  MAX_NATIVE_HISTORY_DECODED_BYTES,
  startNativeHistoryProjection,
} from '../dist/history.js'

const snapshot = (overrides = {}) => ({
  provider: 'codex',
  execution_id: 'execution-1',
  generation: 'generation-1',
  session: 'session-1',
  source: 'thread-history',
  consistency: 'best_effort',
  invalidation_epoch: 3,
  size_bytes: null,
  account_id: null,
  lineage: null,
  modified_at_ms: null,
  ...overrides,
})
const message = (id, sequence, text = id) => ({
  id,
  sequence,
  text,
  conversation_id: 'c1',
  kind: 'message',
  provider_item_id: null,
  role: 'assistant',
  status: 'complete',
  turn_id: null,
})
const response = (overrides = {}) => ({
  type: 'conversation_history',
  complete: true,
  conversation_id: 'c1',
  error: null,
  history_epoch: 4,
  messages: [],
  next_native_cursor: null,
  retained_bytes: 0,
  snapshot: snapshot(),
  stale: false,
  ...overrides,
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function projection(fetchPage, options = {}) {
  const states = []
  const controller = startNativeHistoryProjection({
    conversationId: 'c1',
    historyEpoch: 4,
    provider: 'codex',
    isContextCurrent: () => true,
    fetchPage,
    onState: (state) => states.push(state),
    ...options,
  })
  return { controller, states }
}

test('preserves native page and item order even when ADE sequence values disagree', async () => {
  const requests = []
  const { controller, states } = projection(async (request) => {
    requests.push(request)
    return requests.length === 1
      ? response({
          messages: [message('b', 2), message('a', 1)],
          next_native_cursor: 'native:opaque:1',
          retained_bytes: 90,
        })
      : response({ messages: [message('older', 0)], retained_bytes: 40 })
  })
  await controller.loadMore()
  await controller.loadMore()
  assert.deepEqual(
    requests.map(({ conversation_id, history_epoch, native_cursor, snapshot, max_items, max_bytes }) => ({
      conversation_id,
      history_epoch,
      native_cursor,
      snapshot,
      max_items,
      max_bytes,
    })),
    [
      {
        conversation_id: 'c1',
        history_epoch: 4,
        native_cursor: null,
        snapshot: null,
        max_items: MAX_NATIVE_HISTORY_PAGE_ITEMS,
        max_bytes: MAX_NATIVE_HISTORY_PAGE_BYTES,
      },
      {
        conversation_id: 'c1',
        history_epoch: 4,
        native_cursor: 'native:opaque:1',
        snapshot: snapshot(),
        max_items: MAX_NATIVE_HISTORY_PAGE_ITEMS,
        max_bytes: MAX_NATIVE_HISTORY_PAGE_BYTES,
      },
    ],
  )
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['b', 'a', 'older'],
  )
  assert.equal(states.at(-1).finished, true)
})

test('rejects a changed nullable source size instead of mixing native pages', async () => {
  let page = 0
  const { controller, states } = projection(async () => {
    page++
    return response({
      messages: page === 1 ? [message('newest', 2)] : [message('older', 1)],
      next_native_cursor: page === 1 ? 'cursor-1' : null,
      snapshot: page === 1 ? snapshot() : snapshot({ size_bytes: 0 }),
      retained_bytes: 32,
    })
  })
  await controller.loadMore()
  await controller.loadMore()
  assert.equal(states.at(-1).restartRequired, true)
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['newest'],
  )
})

test('treats absent and null native size as unknown during source identity comparison', async () => {
  let page = 0
  const { controller, states } = projection(async () => {
    page++
    const identity = snapshot()
    if (page === 2) delete identity.size_bytes
    return response({
      messages: [message(page === 1 ? 'newer' : 'older', page)],
      next_native_cursor: page === 1 ? 'cursor-1' : null,
      snapshot: identity,
      retained_bytes: 20,
    })
  })
  await controller.loadMore()
  await controller.loadMore()
  assert.equal(states.at(-1).restartRequired, false)
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['newer', 'older'],
  )
})
test('accepts a valid partial page and continues with its native cursor', async () => {
  let call = 0
  const requests = []
  const { controller, states } = projection(async (request) => {
    requests.push(request)
    call++
    return call === 1
      ? response({
          complete: false,
          messages: [message('partial', 1)],
          next_native_cursor: 'next-native-cursor',
          retained_bytes: 34,
        })
      : response({ messages: [message('oldest', 0)], retained_bytes: 33 })
  })
  await controller.loadMore()
  assert.equal(states.at(-1).finished, false)
  assert.equal(states.at(-1).nativeCursor, 'next-native-cursor')
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['partial'],
  )
  await controller.loadMore()
  assert.equal(requests[1].native_cursor, 'next-native-cursor')
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['partial', 'oldest'],
  )
  assert.equal(states.at(-1).finished, true)
})

test('keeps safely identified stale content and replaces it after bounded manual retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let call = 0
  const requests = []
  const { controller, states } = projection(async (request) => {
    requests.push(request)
    call++
    if (call === 1)
      return response({ messages: [message('latest', 9)], next_native_cursor: 'cursor-1', retained_bytes: 25 })
    if (call === 2)
      return response({
        complete: false,
        error: { code: 'timeout', message: 'Using cached history.' },
        messages: [message('cached-older', 8)],
        next_native_cursor: 'must-not-be-used',
        retained_bytes: 30,
        stale: true,
      })
    return response({ messages: [message('older', 8)], retained_bytes: 28 })
  })
  await controller.loadMore()
  await controller.loadMore()
  assert.equal(states.at(-1).status, 'stale')
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['latest', 'cached-older'],
  )
  assert.deepEqual(states.at(-1).failure, { code: 'timeout', message: 'Using cached history.' })
  assert.equal(states.at(-1).nativeCursor, 'cursor-1')
  const retry = controller.loadMore()
  const matchingRetry = controller.loadMore()
  assert.strictEqual(matchingRetry, retry)
  await Promise.resolve()
  t.mock.timers.tick(249)
  assert.equal(requests.length, 2)
  t.mock.timers.tick(1)
  await retry
  assert.equal(requests[1].native_cursor, 'cursor-1')
  assert.deepEqual(requests[1].snapshot, snapshot())
  assert.equal(requests[2].native_cursor, 'cursor-1')
  assert.deepEqual(
    states.at(-1).messages.map(({ id }) => id),
    ['latest', 'older'],
  )
})

test('discards a late native page after the conversation context is invalidated', async () => {
  const pending = deferred()
  let current = true
  const { controller, states } = projection(() => pending.promise, {
    isContextCurrent: () => current,
  })
  const loading = controller.loadMore()
  await Promise.resolve()
  current = false
  pending.resolve(response({ messages: [message('late', 1)] }))
  await loading
  assert.equal(states.at(-1).status, 'loading')
  assert.equal(states.at(-1).messages.length, 0)
  controller.stop()
})

test('coalesces matching page requests until the accepted or refused read settles', async () => {
  const reads = [deferred(), deferred()]
  let fetches = 0
  const { controller, states } = projection(() => reads[fetches++].promise)
  const accepted = controller.loadMore()
  const sameAccepted = controller.loadMore()
  assert.strictEqual(sameAccepted, accepted)
  let acceptedSettled = false
  void accepted.then(() => {
    acceptedSettled = true
  })
  await Promise.resolve()
  assert.equal(fetches, 1)
  assert.equal(acceptedSettled, false)
  reads[0].resolve(response({ complete: false, next_native_cursor: 'cursor-1', messages: [message('newer', 2)] }))
  await Promise.all([accepted, sameAccepted])
  assert.equal(acceptedSettled, true)

  const refused = controller.loadMore()
  const sameRefused = controller.loadMore()
  assert.strictEqual(sameRefused, refused)
  let refusedSettled = false
  void refused.then(() => {
    refusedSettled = true
  })
  await Promise.resolve()
  assert.equal(fetches, 2)
  assert.equal(refusedSettled, false)
  reads[1].resolve(response({ complete: false, error: { code: 'unsupported', message: 'Refused.' } }))
  await Promise.all([refused, sameRefused])
  assert.equal(refusedSettled, true)
  assert.deepEqual(states.at(-1).failure, { code: 'unsupported', message: 'Refused.' })
})

test('backs off only on manual query retry and caps its cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let fetches = 0
  const { controller } = projection(async () => {
    fetches++
    return response({ complete: false, error: { code: 'timeout', message: 'Temporary refusal.' } })
  })
  await controller.loadMore()
  assert.equal(fetches, 1)
  t.mock.timers.tick(10_000)
  assert.equal(fetches, 1)
  const delays = [250, 500, 1_000, 2_000, 2_000]
  for (let index = 0; index < delays.length; index++) {
    const retry = controller.loadMore()
    await Promise.resolve()
    t.mock.timers.tick(delays[index] - 1)
    assert.equal(fetches, 1 + index)
    t.mock.timers.tick(1)
    await retry
  }
  assert.equal(fetches, 6)
})

test('prevents a delayed manual query after stop or context switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const invalidate of ['stop', 'context']) {
    let current = true
    let fetches = 0
    const { controller } = projection(
      async () => {
        fetches++
        return response({ complete: false, error: { code: 'timeout', message: 'Temporary refusal.' } })
      },
      { isContextCurrent: () => current },
    )
    await controller.loadMore()
    const retry = controller.loadMore()
    await Promise.resolve()
    assert.equal(fetches, 1)
    if (invalidate === 'stop') controller.stop()
    else current = false
    t.mock.timers.tick(2_500)
    await retry
    assert.equal(fetches, 1)
    controller.stop()
  }
})

test('does not merge incomplete non-stale pages', async () => {
  const { controller, states } = projection(async () =>
    response({
      complete: false,
      error: { code: 'oversized_item', message: 'The oldest message exceeds the limit.' },
      messages: [message('partial', 1)],
      retained_bytes: 32,
    }),
  )
  await controller.loadMore()
  assert.equal(states.at(-1).status, 'error')
  assert.deepEqual(states.at(-1).messages, [])
  assert.match(states.at(-1).error, /oldest message exceeds the limit/)
})

test('caps aggregate native JSON bytes without treating source size as retained bytes', async () => {
  let page = 0
  const text = '漢'.repeat(160_000)
  const sourceSize = 16_777_216
  const nativePageBytes = []
  const { controller, states } = projection(async () => {
    page++
    const messages = [message('m' + page, page, text)]
    const retainedBytes = Buffer.byteLength(JSON.stringify(messages))
    nativePageBytes.push(retainedBytes)
    return response({
      complete: false,
      messages,
      next_native_cursor: 'cursor-' + page,
      retained_bytes: retainedBytes,
      snapshot: snapshot({ size_bytes: sourceSize }),
    })
  })

  for (let call = 0; call < 17; call++) await controller.loadMore()

  const lastSafe = states.at(-1)
  assert.equal(MAX_NATIVE_HISTORY_RETAINED_BYTES, 8_388_608)
  assert.equal(page, 17)
  assert.equal(lastSafe.status, 'ready')
  assert.equal(lastSafe.limitReached, false)
  assert.equal(lastSafe.messages.length, 17)
  assert.equal(lastSafe.messages[0].id, 'm1')
  assert.equal(lastSafe.messages.at(-1).id, 'm17')
  assert.equal(lastSafe.nativeCursor, 'cursor-17')
  assert.equal(lastSafe.snapshot.size_bytes, sourceSize)
  assert.notEqual(lastSafe.retainedBytes, sourceSize)
  assert.ok(lastSafe.retainedBytes < sourceSize)
  assert.ok(lastSafe.retainedBytes <= 8_388_608)
  assert.ok(nativePageBytes.slice(0, 17).reduce((total, bytes) => total + bytes, 0) < 8_388_608)

  await controller.loadMore()

  const rejected = states.at(-1)
  assert.equal(page, 18)
  assert.equal(rejected.status, 'degraded')
  assert.equal(rejected.limitReached, true)
  assert.equal(rejected.failure, null)
  assert.equal(
    rejected.messages.some(({ id }) => id === 'm18'),
    false,
  )
  assert.deepEqual(rejected.messages, lastSafe.messages)
  assert.equal(rejected.nativeCursor, 'cursor-17')
  assert.deepEqual(rejected.snapshot, lastSafe.snapshot)
  assert.equal(rejected.retainedBytes, lastSafe.retainedBytes)
  assert.ok(nativePageBytes.reduce((total, bytes) => total + bytes, 0) > 8_388_608)
  controller.stop()
})

test('caps aggregate UTF-16 decoded content when UTF-8 page bytes still fit', async () => {
  let page = 0
  const text = 'x'.repeat(400_000)
  const sourceSize = 16_777_216
  const nativePageBytes = []
  const { controller, states } = projection(async () => {
    page++
    const messages = [message('ascii-' + page, page, text)]
    const retainedBytes = Buffer.byteLength(JSON.stringify(messages))
    nativePageBytes.push(retainedBytes)
    return response({
      complete: false,
      messages,
      next_native_cursor: 'ascii-cursor-' + page,
      retained_bytes: retainedBytes,
      snapshot: snapshot({ size_bytes: sourceSize }),
    })
  })

  for (let call = 0; call < 10; call++) await controller.loadMore()

  const lastSafe = states.at(-1)
  assert.equal(MAX_NATIVE_HISTORY_DECODED_BYTES, 8_388_608)
  assert.equal(page, 10)
  assert.equal(lastSafe.status, 'ready')
  assert.equal(lastSafe.limitReached, false)
  assert.equal(lastSafe.messages.length, 10)
  assert.equal(lastSafe.messages[0].id, 'ascii-1')
  assert.equal(lastSafe.messages.at(-1).id, 'ascii-10')
  assert.equal(lastSafe.nativeCursor, 'ascii-cursor-10')
  assert.equal(lastSafe.snapshot.size_bytes, sourceSize)
  assert.notEqual(lastSafe.retainedBytes, sourceSize)
  assert.ok(lastSafe.retainedBytes < 8_388_608)
  assert.ok(nativePageBytes.reduce((total, bytes) => total + bytes, 0) < 8_388_608)

  await controller.loadMore()

  const rejected = states.at(-1)
  assert.equal(page, 11)
  assert.equal(rejected.status, 'degraded')
  assert.equal(rejected.limitReached, true)
  assert.equal(rejected.failure, null)
  assert.equal(rejected.messages.length, 10)
  assert.equal(
    rejected.messages.some(({ id }) => id === 'ascii-11'),
    false,
  )
  assert.deepEqual(rejected.messages, lastSafe.messages)
  assert.equal(rejected.nativeCursor, 'ascii-cursor-10')
  assert.deepEqual(rejected.snapshot, lastSafe.snapshot)
  assert.equal(rejected.retainedBytes, lastSafe.retainedBytes)
  assert.ok(nativePageBytes.reduce((total, bytes) => total + bytes, 0) < 8_388_608)
  controller.stop()
})

test('includes opaque cursor and source bookkeeping in the decoded admission budget before retaining maps', async () => {
  const { controller, states } = projection(async () =>
    response({
      complete: false,
      messages: [],
      next_native_cursor: 'c'.repeat(MAX_NATIVE_HISTORY_DECODED_BYTES / 2 + 1),
      retained_bytes: 0,
    }),
  )
  await controller.loadMore()
  assert.equal(states.at(-1).status, 'degraded')
  assert.match(states.at(-1).error, /decoded-data retention limit/)
  assert.deepEqual(states.at(-1).messages, [])
})
