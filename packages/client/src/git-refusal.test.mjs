// In-process tests for the pure Git refusal decider (AGENTS.md test policy).
// Run after `pnpm build:sdk`: node --test packages/client/src/git-refusal.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideRefusedGitRecord, definiteRefusal } from '../dist/git-refusal.js'

const id = '11111111-2222-3333-4444-555555555555'
const failure = (code, message, delivery = 'unknown') => ({ code, message, delivery })
const busy = failure('daemon', 'Repository is busy; retry after the current operation')
const unknown = failure('daemon', 'Unknown review operation')

test('a discard refused because review.status holds the repository lock releases its record', () => {
  assert.equal(decideRefusedGitRecord(id, busy, unknown, []), 'release')
})

test('other pre-admission refusals release once the daemon denies knowing the ID', () => {
  for (const send of [
    failure('daemon', 'Too many Git operations'),
    failure('daemon', 'Workspace needs rebind'),
    failure('invalid_request', 'The review.discard request failed its contract', 'not_sent'),
    failure('conflict', 'Refused', 'rejected'),
  ]) {
    assert.equal(decideRefusedGitRecord(id, send, unknown, []), 'release')
  }
})

test('a specific daemon refusal code releases like a code-less refusal', () => {
  const rebind = { ...failure('needs_rebind', 'Workspace needs_rebind'), refusal: true }
  assert.equal(decideRefusedGitRecord(id, rebind, unknown, []), 'release')
  assert.equal(definiteRefusal(failure('needs_rebind', 'Raised locally, not answered')), false)
})

test('a lost, timed-out or unreadable reply keeps the record for a retry', () => {
  for (const send of [
    failure('timeout', 'The profile daemon did not respond before the deadline.'),
    failure('unavailable', 'Profile daemon closed the connection before replying.'),
    failure('protocol', 'Daemon review.discard reply failed its contract'),
    failure('outcome_unknown', 'Outcome unknown'),
    failure('in_progress', 'In progress'),
  ]) {
    assert.equal(definiteRefusal(send), false)
    assert.equal(decideRefusedGitRecord(id, send, unknown, []), 'keep')
  }
})

test('a refusal keeps the record while the daemon knows the ID or cannot be asked', () => {
  assert.equal(decideRefusedGitRecord(id, busy, null, []), 'keep')
  assert.equal(decideRefusedGitRecord(id, busy, failure('timeout', 'deadline'), []), 'keep')
  assert.equal(decideRefusedGitRecord(id, busy, failure('daemon', 'Repository is busy'), []), 'keep')
  assert.equal(decideRefusedGitRecord(id, busy, unknown, null), 'keep')
  assert.equal(decideRefusedGitRecord(id, busy, unknown, [id]), 'keep')
})

test('a refused retry of an ID whose receipt is final releases its record', () => {
  // The CLI reused a finished request ID for another payload; the daemon refuses it.
  const reused = failure('daemon', 'Git operation ID belongs to another request')
  assert.equal(decideRefusedGitRecord(id, reused, null, null, true), 'release')
  // A running or interrupted receipt is not final and keeps the record.
  assert.equal(decideRefusedGitRecord(id, reused, null, [id], false), 'keep')
  // A lost reply keeps the record whatever the receipt says.
  assert.equal(decideRefusedGitRecord(id, failure('timeout', 'deadline'), null, [], true), 'keep')
})

test('no failure details keeps the record', () => {
  assert.equal(decideRefusedGitRecord(id, null, unknown, []), 'keep')
})
