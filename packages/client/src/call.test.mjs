// Pure-core tests for the generic call codec (AGENTS.md test policy): request
// validation before sending and reply validation after. Run after `pnpm build:sdk`:
// node --test packages/client/src/call.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operations } from '@ade/contracts'
import { call, decodeCallReply, encodeCall } from '../dist/call.js'

function rejects(fn, code, delivery) {
  assert.throws(fn, (error) => error.name === 'DaemonRequestError' && error.code === code && error.delivery === delivery)
}

test('a valid request becomes wire fields without its op', () => {
  assert.deepEqual(encodeCall('queue.pause', { conversation_id: 'c1', paused: true }),
    { op: 'queue.pause', fields: { conversation_id: 'c1', paused: true } })
  assert.deepEqual(encodeCall('hello', {}), { op: 'hello', fields: {} })
})

test('undefined fields are dropped as JSON would drop them', () => {
  assert.deepEqual(encodeCall('file.list', { workspace_id: 'w', path: undefined }).fields, { workspace_id: 'w' })
})

test('unknown operations, non-object bodies, op fields and contract failures are never sent', () => {
  rejects(() => encodeCall('no.such_op', {}), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('__proto__', {}), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('hello', null), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('hello', []), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('hello', { op: 'hello' }), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('queue.pause', { conversation_id: 'c1' }), 'invalid_request', 'not_sent')
  rejects(() => encodeCall('queue.pause', { conversation_id: 'c1', paused: 'yes' }), 'invalid_request', 'not_sent')
})

test('call rejects an invalid request before it connects', async () => {
  // The socket does not exist: a request that reached it would fail as unavailable.
  await assert.rejects(call('/nonexistent/ade.sock', 'queue.pause', { conversation_id: 'c1' }),
    (error) => error.code === 'invalid_request' && error.delivery === 'not_sent')
})

test('a reply that fails its contract leaves the outcome unknown', () => {
  rejects(() => decodeCallReply('queue.pause', { type: 'something_else' }), 'protocol', 'unknown')
  rejects(() => decodeCallReply('hello', null), 'protocol', 'unknown')
})

test('every operation has a request and a reply validator', () => {
  for (const op of Object.keys(operations)) {
    rejects(() => decodeCallReply(op, { type: '\u0000not-a-reply' }), 'protocol', 'unknown')
    rejects(() => encodeCall(op, { '\u0000unexpected': 1 }), 'invalid_request', 'not_sent')
  }
})
