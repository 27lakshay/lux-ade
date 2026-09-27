// Pure-core tests for the feed catch-up reducer and projection (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/sync.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONVERSATION_WINDOW, reduceFrame, startConversationProjection } from '../dist/sync.js'

const conversation = { id: 'c1', title: 'One' }
const snapshot = (revision, messages = [], boot = 'b1') =>
  ({ conversation, messages, requests: [], revision, boot_id: boot })
const message = (id, sequence, text = id) => ({ id, sequence, text })
const changed = (revision, messages, requests = [], boot = 'b1') =>
  ({ type: 'conversation_changed', boot_id: boot, revision, conversation, messages, requests })

test('applies a contiguous conversation_changed by merging, sorting and replacing requests', () => {
  const base = snapshot(4, [message('a', 1), message('b', 2)])
  const outcome = reduceFrame(base, changed(5, [message('c', 3), message('a', 1, 'edited')], [{ id: 'r' }]), 'c1')
  assert.equal(outcome.kind, 'changed')
  assert.equal(outcome.snapshot.revision, 5)
  assert.deepEqual(outcome.snapshot.messages.map((item) => [item.id, item.text]), [['a', 'edited'], ['b', 'b'], ['c', 'c']])
  assert.deepEqual(outcome.snapshot.requests, [{ id: 'r' }])
})

test('keeps only the newest window of messages', () => {
  const many = Array.from({ length: CONVERSATION_WINDOW + 5 }, (_, index) => message(`m${index}`, index))
  const outcome = reduceFrame(snapshot(0), changed(1, many), 'c1')
  assert.equal(outcome.snapshot.messages.length, CONVERSATION_WINDOW)
  assert.equal(outcome.snapshot.messages[0].id, 'm5')
})

test('advances the global revision for other frames and other conversations', () => {
  assert.deepEqual(reduceFrame(snapshot(1), { type: 'catalog', boot_id: 'b1', revision: 2 }, 'c1'),
    { kind: 'advance', snapshot: snapshot(2) })
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
  assert.deepEqual(reduceFrame(snapshot(5), { type: 'conversation_reload', boot_id: 'b1', revision: 6, conversation }, 'c1'),
    { kind: 'resnapshot', reason: 'reload' })
  assert.equal(reduceFrame(snapshot(5),
    { type: 'conversation_reload', boot_id: 'b1', revision: 6, conversation: { id: 'c2' } }, 'c1').kind, 'advance')
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(snapshots) {
  const fetches = []
  const states = []
  let listener = () => {}
  const stop = startConversationProjection({
    conversationId: 'c1',
    fetchSnapshot: async (id, limit) => { fetches.push(limit); return snapshots.shift() },
    subscribe: (next) => { listener = next; return () => {} },
    onState: (state, cause) => states.push({ ...state, cause }),
  })
  return { fetches, states, send: (frame) => listener(frame), stop }
}

test('buffers frames until the snapshot loads, then replays those after its revision', async () => {
  const h = harness([snapshot(2, [message('a', 1)])])
  h.send(changed(2, [message('dup', 9)]))
  h.send(changed(3, [message('b', 2)]))
  await settle()
  assert.deepEqual(h.fetches, [CONVERSATION_WINDOW])
  const last = h.states.at(-1)
  assert.equal(last.cause, 'loaded')
  assert.equal(last.status, 'current')
  assert.deepEqual(last.snapshot.messages.map((item) => item.id), ['a', 'b'])
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

test('reports a failed load and stays loading', async () => {
  const states = []
  startConversationProjection({ conversationId: 'c1', fetchSnapshot: async () => { throw new Error('down') },
    subscribe: () => () => {}, onState: (state, cause) => states.push({ ...state, cause }) })
  await settle()
  assert.deepEqual(states, [{ status: 'loading', snapshot: null, error: 'Error: down', cause: 'failed' }])
})
