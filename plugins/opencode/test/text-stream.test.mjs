import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TextStream } from '../src/native/text-stream.mjs'
import { projectMessage } from '../src/native/transcript.mjs'

let sequence = 0
const event = (type, data = {}) => ({
  id: `evt_${sequence++}`,
  type: `session.text.${type}`,
  data: { sessionID: 'ses_one', assistantMessageID: 'msg_assistant', ordinal: 2, ...data },
})

test('live deltas and full completion use the same history identity', () => {
  const stream = new TextStream('ses_one')
  assert.equal(stream.consume(event('started'), 'msg_user')[0].item.id, 'msg_assistant:2')
  assert.equal(stream.consume(event('delta', { delta: 'Hello ' }), 'msg_user')[0].text, 'Hello ')
  assert.equal(stream.consume(event('delta', { delta: 'world' }), 'msg_user')[0].text, 'world')
  const end = stream.consume(event('ended', { text: 'Hello world' }), 'msg_user')
  assert.equal(end[0].item.text, 'Hello world')
  assert.equal(end[0].item.status, 'completed')
  assert.equal(stream.parts.size, 0)
})

test('reconnect gap never appends a suffix to an uncertain prefix', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_user')
  stream.consume(event('delta', { delta: 'before ' }), 'msg_user')
  stream.disconnected()
  assert.deepEqual(stream.consume(event('delta', { delta: 'after' }), 'msg_user'), [])
  const restored = stream.consume(event('ended', { text: 'before missing after' }), 'msg_user')
  assert.equal(restored[0].type, 'item')
  assert.equal(restored[0].item.text, 'before missing after')
})

test('replayed events and repeated starts do not duplicate or erase text', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_user')
  const delta = event('delta', { delta: 'once' })
  stream.consume(delta, 'msg_user')
  assert.deepEqual(stream.consume(delta, 'msg_user'), [])
  assert.deepEqual(stream.consume(event('started'), 'msg_user'), [])
  assert.equal(stream.previous.get('msg_assistant:2').text, 'once')
})

test('durable placeholders do not erase live text; canonical completed values replace it', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_user')
  stream.consume(event('delta', { delta: 'live' }), 'msg_user')
  const entry = stream.previous.get('msg_assistant:2')
  assert.deepEqual(stream.reconcile([{ ...entry, text: '' }]), [])
  assert.equal(stream.reconcile([{ ...entry, text: 'complete', status: 'completed' }])[0].item.text, 'complete')
  assert.deepEqual(stream.consume(event('delta', { delta: 'late' }), 'msg_user'), [])
})

test('other sessions and unobserved starts cannot create partial text', () => {
  const stream = new TextStream('ses_one')
  assert.deepEqual(stream.consume(event('started', { sessionID: 'ses_other' }), 'msg_user'), [])
  assert.deepEqual(stream.consume(event('delta', { delta: 'orphan' }), 'msg_user'), [])
  assert.throws(() => stream.consume(event('started', { ordinal: -1 }), 'msg_user'), /identity/)
})

test('the delta path publishes only the suffix and bounds accumulated bytes', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_user')
  for (let i = 0; i < 1000; i++) {
    const emitted = stream.consume(event('delta', { delta: 'x'.repeat(100) }), 'msg_user')
    assert.equal(emitted[0].text.length, 100)
    assert.equal(emitted[0].type, 'delta')
  }
  assert.equal(stream.bytes, 100_000)
  assert.equal(stream.previous.get('msg_assistant:2').text.length, 100_000)
  assert.throws(() => stream.consume(event('delta', { delta: 'x'.repeat(1024 * 1024) }), 'msg_user'), /content limit/)
})

test('a late fragment cannot be reassigned to the next turn', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_first')
  stream.consume(event('delta', { delta: 'first' }), 'msg_first')
  assert.deepEqual(stream.consume(event('ended', { text: 'late first' }), 'msg_second'), [])
  assert.equal(stream.previous.get('msg_assistant:2').turn, 'msg_first')
})

test('a durable full text value ends its live fragment even before the assistant finishes', () => {
  const stream = new TextStream('ses_one')
  stream.consume(event('started'), 'msg_user')
  stream.consume(event('delta', { delta: 'prefix' }), 'msg_user')
  const entry = stream.previous.get('msg_assistant:2')
  stream.reconcile([{ ...entry, text: 'full stored value' }])
  assert.deepEqual(stream.consume(event('delta', { delta: 'stale' }), 'msg_user'), [])
  assert.equal(stream.previous.get('msg_assistant:2').text, 'full stored value')
})

test('a streamed text fragment and its stored message share one item when reasoning precedes the text', () => {
  // OpenCode 2.0.22 live: content [reasoning, text]; the text events carry text ordinal 0.
  const stream = new TextStream('ses_one')
  const data = { sessionID: 'ses_one', assistantMessageID: 'msg_live', ordinal: 0 }
  stream.consume({ id: 'evt_1', type: 'session.text.started', data }, 'msg_user')
  stream.consume({ id: 'evt_2', type: 'session.text.ended', data: { ...data, text: 'ok' } }, 'msg_user')
  const stored = projectMessage(
    {
      id: 'msg_live',
      type: 'assistant',
      time: { completed: 1 },
      content: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'ok' },
      ],
    },
    'msg_user',
  )
  assert.deepEqual(
    stored.map((entry) => entry.id),
    ['msg_live:0'],
  )
  assert.deepEqual(stream.reconcile(stored), [])
  assert.deepEqual([...stream.previous.keys()], ['msg_live:0'])
})
