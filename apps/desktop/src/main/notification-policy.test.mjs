// In-process tests for the pure notification decider (AGENTS.md test policy).
// Run: node --test apps/desktop/src/main/notification-policy.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideNotification, NOTIFY_MAX_AGE_MS, rememberHandled } from './notification-policy.ts'

const now = 1_000_000_000
const activity = (fields = {}) => ({
  id: 'activity_1',
  kind: 'turn_completed',
  state: 'unread',
  title: 'Fix build',
  detail: null,
  created_at: now - 1000,
  ...fields,
})
const context = (fields = {}) => ({ focused: false, now, handled: new Set(), ...fields })

test('new unread activity is presented while the window is not focused', () => {
  assert.deepEqual(decideNotification(activity(), context()), {
    action: 'present',
    title: 'Fix build',
    body: 'Turn completed',
  })
})

test('a focused window suppresses with a recorded reason', () => {
  assert.deepEqual(decideNotification(activity(), context({ focused: true })), {
    action: 'suppress',
    reason: 'window_focused',
  })
})

test('handled, read, dismissed, stale and unknown kinds are skipped', () => {
  assert.equal(decideNotification(activity(), context({ handled: new Set(['activity_1']) })).action, 'skip')
  assert.equal(decideNotification(activity({ state: 'read' }), context()).action, 'skip')
  assert.equal(decideNotification(activity({ state: 'dismissed' }), context()).action, 'skip')
  assert.equal(decideNotification(activity({ created_at: now - NOTIFY_MAX_AGE_MS - 1 }), context()).action, 'skip')
  assert.equal(decideNotification(activity({ kind: 'plugin_event' }), context()).action, 'skip')
})

test('failures carry their bounded detail; other kinds do not', () => {
  const failed = decideNotification(activity({ kind: 'turn_failed', detail: 'x'.repeat(400) }), context())
  assert.equal(failed.action, 'present')
  assert.equal(failed.body, `Turn failed: ${'x'.repeat(200)}`)
  const approval = decideNotification(
    activity({ kind: 'approval_requested', detail: 'item/x/requestApproval' }),
    context(),
  )
  assert.equal(approval.body, 'Approval needed')
  assert.equal(decideNotification(activity({ kind: 'snooze_ended' }), context()).body, 'Snooze ended')
  assert.equal(decideNotification(activity({ title: '  ' }), context()).title, 'ADE')
})

test('the handled set keeps the most recent IDs within its limit', () => {
  const handled = new Set()
  for (const id of ['a', 'b', 'c']) rememberHandled(handled, id, 2)
  assert.deepEqual([...handled], ['b', 'c'])
  rememberHandled(handled, 'b', 2)
  rememberHandled(handled, 'd', 2)
  assert.deepEqual([...handled], ['b', 'd'])
})
