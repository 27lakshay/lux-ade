// Pure-core tests for settleWorktreeOperation (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/worktree-operation.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleWorktreeOperation } from '../dist/index.js'

const state = (status, id = 'op_1') => ({
  type: 'workspace_worktree_operation',
  operation_id: id,
  kind: 'create_worktree',
  status,
  project_id: 'repo_1',
  workspace_id: status === 'succeeded' ? 'workspace_2' : null,
  worktree_path: null,
  error: null,
  code: null,
})

/** A client's state and feed that a test drives. */
function fakeFeed() {
  const states = new Set()
  const frames = new Set()
  let current = { status: 'connected' }
  return {
    subscribe(listener) {
      states.add(listener)
      listener(current)
      return () => states.delete(listener)
    },
    subscribeFeed(listener) {
      frames.add(listener)
      return () => frames.delete(listener)
    },
    status(status) {
      current = { status }
      for (const listener of states) listener(current)
    },
    frame(operation) {
      for (const listener of frames) listener({ type: 'workspace_worktree_operation_changed', operation })
    },
    listeners: () => states.size + frames.size,
  }
}

test('a reply that is already settled resolves at once', async () => {
  const feed = fakeFeed()
  assert.equal((await settleWorktreeOperation(feed, 'op_1', async () => state('succeeded'))).status, 'succeeded')
  assert.equal(feed.listeners(), 0)
})

test('a running operation settles from its own frame, not another operation', async () => {
  const feed = fakeFeed()
  let sends = 0
  const settled = settleWorktreeOperation(feed, 'op_1', async () => {
    sends++
    return state('running')
  })
  await new Promise((done) => setImmediate(done))
  feed.frame(state('failed', 'op_2'))
  feed.frame(state('running'))
  feed.frame(state('succeeded'))
  assert.equal((await settled).workspace_id, 'workspace_2')
  assert.equal(sends, 1)
  assert.equal(feed.listeners(), 0)
})

test('after a reconnect the command is sent again, and its reply settles it', async () => {
  const feed = fakeFeed()
  const replies = [state('running'), state('failed')]
  const settled = settleWorktreeOperation(feed, 'op_1', async () => replies.shift())
  await new Promise((done) => setImmediate(done))
  feed.status('disconnected')
  feed.status('connected')
  assert.equal((await settled).status, 'failed')
  assert.deepEqual(replies, [])
})

test('a send that throws ends the wait with its error', async () => {
  const feed = fakeFeed()
  await assert.rejects(
    settleWorktreeOperation(feed, 'op_1', async () => {
      throw new Error('Profile changed')
    }),
    /Profile changed/,
  )
  assert.equal(feed.listeners(), 0)
})

test('recheckMs asks again at its interval, one request at a time', async () => {
  const feed = fakeFeed()
  let sends = 0
  let inFlight = 0
  const settled = settleWorktreeOperation(
    feed,
    'op_1',
    async () => {
      sends++
      inFlight++
      assert.equal(inFlight, 1)
      await new Promise((done) => setTimeout(done, 5))
      inFlight--
      if (sends < 3) return state('running')
      throw new Error('Profile changed')
    },
    { recheckMs: 1 },
  )
  await assert.rejects(settled, /Profile changed/)
  assert.equal(sends, 3)
  assert.equal(feed.listeners(), 0)
})
