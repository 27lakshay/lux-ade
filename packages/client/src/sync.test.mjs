// Pure-core tests for the feed catch-up reducer and projection (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/sync.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONVERSATION_WINDOW,
  MAX_BUFFERED_FRAME_BYTES,
  MAX_BUFFERED_FRAME_COUNT,
  MAX_PROJECTION_DECODED_BYTES,
  MAX_PROJECTION_ITEMS,
  reduceFrame,
  startConversationProjection,
} from '../dist/sync.js'

const conversation = { id: 'c1', title: 'One' }
const snapshot = (revision, messages = [], boot = 'b1') => ({
  conversation,
  messages,
  requests: [],
  revision,
  boot_id: boot,
})
const message = (id, sequence, text = id) => ({ id, sequence, text })
const changed = (revision, messages, requests = [], boot = 'b1') => ({
  type: 'conversation_changed',
  boot_id: boot,
  revision,
  conversation,
  messages,
  requests,
})

test('applies a contiguous conversation_changed by merging, sorting and replacing requests', () => {
  const base = snapshot(4, [message('a', 1), message('b', 2)])
  const outcome = reduceFrame(base, changed(5, [message('c', 3), message('a', 1, 'edited')], [{ id: 'r' }]), 'c1')
  assert.equal(outcome.kind, 'changed')
  assert.equal(outcome.snapshot.revision, 5)
  assert.deepEqual(
    outcome.snapshot.messages.map((item) => [item.id, item.text]),
    [
      ['a', 'edited'],
      ['b', 'b'],
      ['c', 'c'],
    ],
  )
  assert.deepEqual(outcome.snapshot.requests, [{ id: 'r' }])
})

test('keeps only the newest window of messages', () => {
  const many = Array.from({ length: CONVERSATION_WINDOW + 5 }, (_, index) => message(`m${index}`, index))
  const outcome = reduceFrame(snapshot(0), changed(1, many), 'c1')
  assert.equal(outcome.snapshot.messages.length, CONVERSATION_WINDOW)
  assert.equal(outcome.snapshot.messages.length, 32)
  assert.equal(outcome.snapshot.messages[0].id, 'm5')
})

test('rejects a single oversized live message instead of admitting it as the newest item', () => {
  const oversized = { ...message('huge', 2), native_content: 'x'.repeat(8 * 1024 * 1024) }
  const outcome = reduceFrame(snapshot(0, [message('retained', 1)]), changed(1, [oversized]), 'c1')
  assert.deepEqual(outcome, { kind: 'degraded', reason: 'resource-limit' })
})

test('rejects retained snapshots and incoming deltas that exceed the aggregate item ceiling', () => {
  const requests = Array.from({ length: MAX_PROJECTION_ITEMS + 1 }, (_, index) => ({ id: 'request-' + index }))
  assert.deepEqual(reduceFrame(snapshot(0), changed(1, [], requests), 'c1'), {
    kind: 'degraded',
    reason: 'resource-limit',
  })
  assert.deepEqual(reduceFrame({ ...snapshot(0), requests }, changed(1, []), 'c1'), {
    kind: 'degraded',
    reason: 'resource-limit',
  })
})

test('advances the global revision for other frames and other conversations', () => {
  assert.deepEqual(reduceFrame(snapshot(1), { type: 'catalog', boot_id: 'b1', revision: 2 }, 'c1'), {
    kind: 'advance',
    snapshot: snapshot(2),
  })
  const other = { ...changed(2, [message('x', 1)]), conversation: { id: 'c2' } }
  assert.equal(reduceFrame(snapshot(1), other, 'c1').kind, 'advance')
})

test('drops a duplicate at or below the snapshot revision', () => {
  assert.deepEqual(reduceFrame(snapshot(5), changed(5, [message('a', 1)]), 'c1'), { kind: 'duplicate' })
  assert.deepEqual(reduceFrame(snapshot(5), changed(3, []), 'c1'), { kind: 'duplicate' })
})

test('asks for a new snapshot on a gap, a boot change or a reload of this conversation', () => {
  assert.deepEqual(reduceFrame(snapshot(5), changed(7, []), 'c1'), { kind: 'resnapshot', reason: 'gap' })
  assert.deepEqual(reduceFrame(snapshot(5), changed(1, [], [], 'b2'), 'c1'), { kind: 'resnapshot', reason: 'boot' })
  assert.deepEqual(
    reduceFrame(snapshot(5), { type: 'conversation_reload', boot_id: 'b1', revision: 6, conversation }, 'c1'),
    { kind: 'resnapshot', reason: 'reload' },
  )
  assert.equal(
    reduceFrame(
      snapshot(5),
      { type: 'conversation_reload', boot_id: 'b1', revision: 6, conversation: { id: 'c2' } },
      'c1',
    ).kind,
    'advance',
  )
})

test('a deletion of this conversation ends it, even across a gap; another conversation only advances', () => {
  const deleted = (revision, id = 'c1', boot = 'b1') => ({
    type: 'conversation_deleted',
    boot_id: boot,
    revision,
    conversation_id: id,
  })
  assert.deepEqual(reduceFrame(snapshot(5), deleted(6), 'c1'), { kind: 'deleted' })
  assert.deepEqual(reduceFrame(snapshot(5), deleted(9), 'c1'), { kind: 'deleted' })
  assert.deepEqual(reduceFrame(snapshot(5), deleted(1, 'c1', 'b2'), 'c1'), { kind: 'deleted' })
  assert.deepEqual(reduceFrame(snapshot(5), deleted(5), 'c1'), { kind: 'duplicate' })
  assert.equal(reduceFrame(snapshot(5), deleted(6, 'c2'), 'c1').kind, 'advance')
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function heldRead() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('a snapshot delivered after the deletion frame is dropped, and nothing loads again', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches += 1
      await gate
      return snapshot(3, [message('a', 1)])
    },
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  listener({ type: 'conversation_deleted', boot_id: 'b1', revision: 4, conversation_id: 'c1' })
  release()
  await settle()
  listener(changed(5, [message('b', 2)]))
  await settle()
  assert.equal(fetches, 1)
  assert.deepEqual(
    states.map((state) => [state.status, state.cause, state.snapshot]),
    [['deleted', 'deleted', null]],
  )
})

test('a snapshot fetch refused as conversation_deleted ends the projection', async () => {
  const states = []
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      throw Object.assign(new Error('Conversation c1 was deleted'), { code: 'conversation_deleted' })
    },
    subscribe: () => () => {},
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  assert.deepEqual(
    states.map((state) => [state.status, state.cause]),
    [['deleted', 'deleted']],
  )
})

function harness(snapshots) {
  const fetches = []
  const states = []
  let listener = () => {}
  const stop = startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async (id, limit) => {
      fetches.push(limit)
      return snapshots.shift()
    },
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  return { fetches, states, send: (frame) => listener(frame), stop }
}

test('buffers frames until the snapshot loads, then replays those after its revision', async () => {
  const h = harness([snapshot(2, [message('a', 1)])])
  h.send(changed(2, [message('dup', 9)]))
  h.send(changed(3, [message('b', 2)]))
  await settle()
  assert.deepEqual(h.fetches, [32])
  const last = h.states.at(-1)
  assert.equal(last.cause, 'loaded')
  assert.equal(last.status, 'current')
  assert.deepEqual(
    last.snapshot.messages.map((item) => item.id),
    ['a', 'b'],
  )
})

test('marks the projection stale during a gap repair and current after it', async () => {
  const h = harness([snapshot(1), snapshot(9, [message('z', 1)])])
  await settle()
  h.send(changed(4, []))
  assert.equal(h.states.at(-1).status, 'stale')
  assert.equal(h.states.at(-1).snapshot.revision, 1)
  await settle()
  assert.equal(h.fetches.length, 2)
  assert.equal(h.states.at(-1).status, 'current')
  assert.equal(h.states.at(-1).snapshot.revision, 9)
})

test('ignores a queued feed callback after disposal and unsubscribes only once', async () => {
  const states = []
  let listener = () => {}
  let fetches = 0
  let unsubscribes = 0
  const stop = startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches += 1
      return snapshot(1, [message('a', 1)])
    },
    subscribe: (next) => {
      listener = next
      return () => {
        unsubscribes += 1
      }
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  stop()
  stop()
  // A callback already queued by the source may still arrive after unsubscribe.
  listener(changed(2, [message('b', 2)]))
  await settle()
  assert.equal(fetches, 1)
  assert.equal(unsubscribes, 1)
  assert.deepEqual(
    states.map((state) => state.cause),
    ['loaded'],
  )
})

test('drops a delayed initial snapshot after idempotent disposal', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const states = []
  let fetches = 0
  let unsubscribes = 0
  const stop = startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches += 1
      markStarted()
      await gate
      return snapshot(1, [message('late', 1)])
    },
    subscribe: () => () => {
      unsubscribes += 1
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await started
  stop()
  stop()
  release()
  await settle()
  assert.equal(fetches, 1)
  assert.equal(unsubscribes, 1)
  assert.deepEqual(states, [])
})

test('marks an oversized snapshot degraded and limits automatic recovery to one retry', async () => {
  const oversized = snapshot(0, [{ ...message('huge', 1), native_content: 'x'.repeat(8 * 1024 * 1024) }])
  const states = []
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches++
      return oversized
    },
    subscribe: () => () => {},
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'degraded')
  assert.equal(states.at(-1).cause, 'degraded')
  assert.match(states.at(-1).error, /resource limits/)
  assert.equal(states.at(-1).snapshot, null)
})

test('bounds pre-snapshot frame entries and recovers once without publishing the incomplete buffer', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches++
      if (fetches === 1) return gate
      return snapshot(1)
    },
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  for (let revision = 1; revision <= MAX_BUFFERED_FRAME_COUNT + 1; revision++) listener(changed(revision, []))
  assert.equal(states.at(-1).status, 'degraded')
  assert.match(states.at(-1).error, /resource limits/)
  release(snapshot(0))
  await settle()
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'current')
  assert.deepEqual(states.at(-1).snapshot.messages, [])
})

test('bounds pre-snapshot decoded bytes even when the frame buffer has room', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => {
      fetches++
      if (fetches === 1) return gate
      return snapshot(1)
    },
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  listener({ ...changed(1, []), native_content: 'x'.repeat(MAX_BUFFERED_FRAME_BYTES + 1) })
  assert.equal(states.at(-1).status, 'degraded')
  assert.match(states.at(-1).error, /resource limits/)
  release(snapshot(0))
  await settle()
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'current')
  assert.deepEqual(states.at(-1).snapshot.messages, [])
})

test('rejects an ASCII native field that fits the UTF-8 cap but exceeds the retained UTF-16 budget', () => {
  const nativeContent = 'x'.repeat(MAX_PROJECTION_DECODED_BYTES / 2 + 1)
  assert.ok(nativeContent.length < MAX_PROJECTION_DECODED_BYTES)
  const frame = changed(1, [{ ...message('large', 1), native_content: nativeContent }])
  assert.deepEqual(reduceFrame(snapshot(0), frame, 'c1'), { kind: 'degraded', reason: 'resource-limit' })
})

test('replays frames received during recovery before claiming the recovered snapshot current', async () => {
  const first = heldRead()
  const second = heldRead()
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => (++fetches === 1 ? first.promise : second.promise),
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  for (let revision = 1; revision <= MAX_BUFFERED_FRAME_COUNT + 1; revision++) listener(changed(revision, []))
  first.resolve(snapshot(0))
  await settle()
  assert.equal(fetches, 2)

  listener(changed(1, [message('newer', 1)]))
  second.resolve(snapshot(0))
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'current')
  assert.equal(states.at(-1).snapshot.revision, 1)
  assert.deepEqual(
    states.at(-1).snapshot.messages.map((item) => item.id),
    ['newer'],
  )
})

test('keeps recovery degraded and finite when the recovery read overflows again', async () => {
  const first = heldRead()
  const second = heldRead()
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => (++fetches === 1 ? first.promise : second.promise),
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  for (let revision = 1; revision <= MAX_BUFFERED_FRAME_COUNT + 1; revision++) listener(changed(revision, []))
  first.resolve(snapshot(0))
  await settle()
  assert.equal(fetches, 2)

  listener({ ...changed(1, []), native_content: 'x'.repeat(MAX_BUFFERED_FRAME_BYTES / 2 + 1) })
  second.resolve(snapshot(0))
  await settle()
  listener(changed(1, [message('ignored', 1)]))
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'degraded')
  assert.match(states.at(-1).error, /resource limits/)
})

test('does not restart snapshots on later frames after the bounded recovery read fails', async () => {
  const first = heldRead()
  const second = heldRead()
  const states = []
  let listener = () => {}
  let fetches = 0
  startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async () => (++fetches === 1 ? first.promise : second.promise),
    subscribe: (next) => {
      listener = next
      return () => {}
    },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  await settle()
  for (let revision = 1; revision <= MAX_BUFFERED_FRAME_COUNT + 1; revision++) listener(changed(revision, []))
  first.resolve(snapshot(0))
  await settle()
  assert.equal(fetches, 2)

  second.reject(new Error('recovery unavailable'))
  await settle()
  for (let revision = 1; revision <= MAX_BUFFERED_FRAME_COUNT; revision++) listener(changed(revision, []))
  await settle()
  assert.equal(fetches, 2)
  assert.equal(states.at(-1).status, 'degraded')
  assert.match(states.at(-1).error, /Resnapshot failed/)
})
