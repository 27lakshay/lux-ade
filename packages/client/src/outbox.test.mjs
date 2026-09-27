// Pure-core tests for the client outbox and its recovery deciders (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/outbox.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Outbox,
  OutboxPersistenceUncertain,
  decideGitAdmission,
  decideSendRecovery,
  findPendingSend,
  gitAdmitted,
  pendingGitOperation,
} from '../dist/outbox.js'

const codec = {
  version: 3,
  name: 'Test outbox',
  maxRecords: 2,
  key: (record) => record.owner,
  decode(value) {
    if (!value || value.version !== 3 || !Array.isArray(value.records)) throw new Error('invalid')
    return value.records
  },
}

function storage(initial) {
  const state = { value: initial, saves: 0, fail: null }
  return {
    state,
    load: async () => structuredClone(state.value),
    save: async (value) => {
      if (state.fail) throw state.fail
      state.saves++
      state.value = structuredClone(value)
    },
  }
}

const same = (previous, next) => previous.id === next.id && previous.body === next.body

test('an outbox persists each change before it is visible and skips unchanged saves', async () => {
  const store = storage(undefined)
  const outbox = await Outbox.open(store, codec)
  await outbox.put({ owner: 'a', id: '1', body: 'x' }, same)
  assert.deepEqual(store.state.value, { version: 3, records: [{ owner: 'a', id: '1', body: 'x' }] })
  await outbox.put({ owner: 'a', id: '1', body: 'x' }, same)
  assert.equal(store.state.saves, 1)
  assert.deepEqual(await outbox.get('a'), { owner: 'a', id: '1', body: 'x' })
  const reopened = await Outbox.open(store, codec)
  assert.deepEqual(await reopened.list(), [{ owner: 'a', id: '1', body: 'x' }])
})

test('a second operation for the same owner is refused and changes nothing', async () => {
  const store = storage(undefined)
  const outbox = await Outbox.open(store, codec)
  await outbox.put({ owner: 'a', id: '1', body: 'x' }, same)
  await assert.rejects(outbox.put({ owner: 'a', id: '2', body: 'x' }, same, 'Owned elsewhere'), /Owned elsewhere/)
  await assert.rejects(outbox.put({ owner: 'a', id: '1', body: 'changed' }, same), /Another operation owns/)
  assert.deepEqual(await outbox.list(), [{ owner: 'a', id: '1', body: 'x' }])
})

test('remove drops only the matching request', async () => {
  const outbox = await Outbox.open(storage(undefined), codec)
  await outbox.put({ owner: 'a', id: '1', body: 'x' }, same)
  assert.equal(await outbox.remove('a', (record) => record.id === '2'), false)
  assert.equal(await outbox.remove('missing', () => true), false)
  assert.equal(await outbox.remove('a', (record) => record.id === '1'), true)
  assert.deepEqual(await outbox.list(), [])
})

test('a failed save keeps memory unchanged, and an uncertain save refuses all later use', async () => {
  const store = storage(undefined)
  const outbox = await Outbox.open(store, codec)
  store.state.fail = new Error('disk full')
  await assert.rejects(outbox.put({ owner: 'a', id: '1', body: 'x' }, same), /disk full/)
  assert.deepEqual(await outbox.list(), [])
  store.state.fail = new OutboxPersistenceUncertain('rename done, sync failed')
  await assert.rejects(outbox.put({ owner: 'a', id: '1', body: 'x' }, same), /sync failed/)
  store.state.fail = null
  await assert.rejects(outbox.list(), /persistence is uncertain/)
  await assert.rejects(outbox.put({ owner: 'b', id: '2', body: 'y' }, same), /persistence is uncertain/)
})

test('open refuses duplicate owners, overflow and invalid files', async () => {
  const record = { owner: 'a', id: '1', body: 'x' }
  await assert.rejects(Outbox.open(storage({ version: 3, records: [record, record] }), codec), /duplicate owners/)
  await assert.rejects(
    Outbox.open(
      storage({ version: 3, records: [record, { ...record, owner: 'b' }, { ...record, owner: 'c' }] }),
      codec,
    ),
    /full/,
  )
  await assert.rejects(Outbox.open(storage({ version: 1, records: [] }), codec), /invalid/)
  const outbox = await Outbox.open(storage(undefined), codec)
  await outbox.put(record, same)
  await outbox.put({ ...record, owner: 'b' }, same)
  await assert.rejects(outbox.put({ ...record, owner: 'c' }, same), /full/)
})

const send = (overrides) => ({ requestId: 'r1', admitted: false, local: null, daemon: null, ...overrides })
const local = (overrides) => ({ requestId: 'r1', restoreHold: false, admitted: false, ...overrides })
const listed = (outcome, overrides) => ({ requestId: 'r1', outcome, matches: true, ...overrides })

test('send recovery replays only records the daemon never admitted', () => {
  assert.deepEqual(decideSendRecovery(send({ local: local() })), { kind: 'prepare' })
  // A record the daemon once held, or a legacy dispatched record, is never re-prepared.
  assert.deepEqual(decideSendRecovery(send({ local: local(), admitted: true })), { kind: 'acknowledge' })
  assert.deepEqual(decideSendRecovery(send({ local: local({ admitted: true }) })), { kind: 'acknowledge' })
  assert.deepEqual(decideSendRecovery(send({ admitted: true })), { kind: 'acknowledge' })
})

test('send recovery follows the daemon outcome once it lists the intent', () => {
  assert.deepEqual(decideSendRecovery(send({ daemon: listed('prepared') })), { kind: 'deliver' })
  assert.deepEqual(decideSendRecovery(send({ local: local(), daemon: listed('prepared') })), { kind: 'deliver' })
  assert.deepEqual(decideSendRecovery(send({ daemon: listed('accepted') })), { kind: 'acknowledge' })
  assert.deepEqual(decideSendRecovery(send({ daemon: listed('rejected') })), { kind: 'release' })
  assert.deepEqual(decideSendRecovery(send({ daemon: listed('held') })), { kind: 'hold' })
  assert.equal(decideSendRecovery(send({ daemon: listed('conflict') })).kind, 'conflict')
})

test('send recovery holds restored records and refuses mismatches', () => {
  assert.deepEqual(decideSendRecovery(send({ local: local({ restoreHold: true }), daemon: listed('prepared') })), {
    kind: 'hold',
  })
  assert.equal(decideSendRecovery(send({ local: local({ requestId: 'other' }) })).kind, 'conflict')
  assert.equal(decideSendRecovery(send({ daemon: listed('accepted', { requestId: 'other' }) })).kind, 'conflict')
  assert.equal(decideSendRecovery(send({ daemon: listed('accepted', { matches: false }) })).kind, 'conflict')
})

const pending = (conversation, request = `r-${conversation}`) => ({
  intent: { conversation_id: conversation, request_id: request },
  outcome: 'prepared',
})

test('findPendingSend pages by Conversation ID and stops once past it', async () => {
  const pages = {
    '': { sends: [pending('a'), pending('b')], next_cursor: 'b' },
    b: { sends: [pending('c'), pending('e')], next_cursor: 'e' },
    e: { sends: [pending('f')], next_cursor: null },
  }
  const seen = []
  const page = async (after) => {
    seen.push(after ?? '')
    return pages[after ?? '']
  }
  assert.equal((await findPendingSend('c', page)).intent.request_id, 'r-c')
  assert.deepEqual(seen, ['', 'b'])
  seen.length = 0
  assert.equal(await findPendingSend('d', page), null)
  assert.deepEqual(seen, ['', 'b'])
  assert.equal(await findPendingSend('z', page), null)
})

test('findPendingSend refuses a list that does not advance or never ends', async () => {
  await assert.rejects(
    findPendingSend('z', async (after) => ({ sends: [pending('a')], next_cursor: after ?? 'a' })),
    /did not advance/,
  )
  let count = 0
  await assert.rejects(
    findPendingSend('zz', async () => ({ sends: [pending('a')], next_cursor: `a${++count}` }), 3),
    /too long/,
  )
})

const entry = (id, status, acknowledged_at = null) => ({
  operation: { id, status, op: 'review.stage', started_at: 1 },
  acknowledged_at,
})

test('a workspace admits one Git operation that needs the person at a time', () => {
  assert.deepEqual(decideGitAdmission('n', false, null, []), { kind: 'admit' })
  assert.deepEqual(decideGitAdmission('n', false, { request_id: 'l' }, []).blocking, 'l')
  assert.equal(decideGitAdmission('n', false, { request_id: 'n' }, []).kind, 'refuse')
  assert.deepEqual(decideGitAdmission('n', true, { request_id: 'n' }, []), { kind: 'admit' })
  assert.equal(decideGitAdmission('n', false, null, [entry('o', 'running')]).blocking, 'o')
  assert.equal(decideGitAdmission('n', false, null, [entry('o', 'interrupted')]).blocking, 'o')
  // An acknowledged interrupted operation no longer blocks, and a retry of the listed one passes.
  assert.deepEqual(decideGitAdmission('n', false, null, [entry('o', 'interrupted', 5)]), { kind: 'admit' })
  assert.deepEqual(decideGitAdmission('n', true, { request_id: 'n' }, [entry('n', 'running')]), { kind: 'admit' })
})

test('the pending Git operation prefers the local record, then the newest daemon one', () => {
  const record = { request_id: 'l', op: 'review.commit' }
  assert.deepEqual(pendingGitOperation(record, [entry('o', 'running')]), { source: 'local', record })
  assert.equal(
    pendingGitOperation(null, [entry('a', 'interrupted', 3), entry('b', 'interrupted')]).entry.operation.id,
    'b',
  )
  assert.equal(pendingGitOperation(null, [entry('a', 'interrupted', 3)]), null)
  assert.equal(gitAdmitted('b', [entry('b', 'running')]), true)
  assert.equal(gitAdmitted('c', [entry('b', 'running')]), false)
})
