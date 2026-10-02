// F107: bounded waits. A wait times out without touching the child, a
// cancellation settles a wait already in progress, a cancelled queued message
// is reported blocked, a deadline survives a daemon restart, and out-of-range
// waits are refused. The CLI wait is a loop of non-blocking daemon queries.
import { cancelActiveSubmission, expect, prompts, test } from '../fixtures'
import { delegate, opId, parentIn, waitForChild, waitOnce } from './steps'

test('a wait times out at its deadline and leaves the child running (F107 timeout)', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.hold)).child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, child, { timeoutMs: 0 })).phase).toBe('running')

  const first = await waitOnce(profile, child, { timeoutMs: 400 })
  expect(first).toMatchObject({ state: 'pending', done: false, phase: 'running' })
  // Repeating with the returned deadline ends as timed_out once it passes, never as an outcome.
  let last = first
  await expect
    .poll(async () => {
      last = await waitOnce(profile, child, { deadlineMs: first.deadline_ms })
      return last.state
    })
    .toBe('timed_out')
  expect(last).toMatchObject({ done: true, phase: 'running', deadline_ms: first.deadline_ms })
  expect(Date.now()).toBeGreaterThanOrEqual(first.deadline_ms)

  // Timing out changed nothing: the child still runs and its provider saw no interrupt.
  expect((await waitOnce(profile, child, { timeoutMs: 0 })).state).toBe('timed_out')
  expect((await profile.call('conversation.get', { conversation_id: child })).conversation.status).toBe('running')
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/interrupt')).toEqual([])
})

test('cancelling the child ends a CLI wait already in progress with an interrupted outcome (F107 cancellation)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.hold)).child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, child, { timeoutMs: 0 })).phase).toBe('running')

  const started = Date.now()
  const waiting = profile.cli('child', 'wait', child, '--timeout-ms', '120000')
  // The CLI is polling; its wait is pending until the cancellation lands.
  expect((await waitOnce(profile, child, { timeoutMs: 0 })).phase).toBe('running')
  await cancelActiveSubmission(profile, child)
  const result = await waiting
  expect(result.code).toBe(0)
  expect(result.json).toMatchObject({ type: 'child_wait', state: 'settled', outcome: 'interrupted', done: true })
  expect(Date.now() - started).toBeLessThan(60_000)
})

test('a queued message cancelled before submission is reported blocked, and the child is not affected', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.hold)).child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, child, { timeoutMs: 0 })).phase).toBe('running')
  const queued = await profile.call('orchestration.child.send', {
    operation_id: opId('queued'),
    child_conversation_id: child,
    caller: { kind: 'user' },
    text: prompts.turn,
  })
  expect(await waitOnce(profile, child, { messageId: queued.message_id, timeoutMs: 60_000 })).toMatchObject({
    state: 'pending',
    phase: 'queued',
  })

  await profile.call('queue.cancel', { conversation_id: child, request_id: queued.message_id })
  expect(await waitOnce(profile, child, { messageId: queued.message_id, timeoutMs: 60_000 })).toMatchObject({
    state: 'blocked',
    done: true,
    reason: expect.stringContaining('cancelled'),
  })
  const listed = (await profile.call('orchestration.child.messages', { child_conversation_id: child })).messages
  expect(listed.find((item) => item.message_id === queued.message_id)?.delivery).toBe('cancelled')
  // The running task is untouched by the queued message's cancellation.
  expect(
    (
      await waitOnce(profile, child, {
        timeoutMs: 0,
        messageId: (await profile.call('orchestration.child.get', { child_conversation_id: child })).child
          .task_message_id,
      })
    ).phase,
  ).toBe('running')
})

test('a wait deadline carries across a daemon restart, and the settled outcome after it is the same (F107, F106)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent, prompts.hold)).child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, child, { timeoutMs: 0 })).phase).toBe('running')
  const first = await waitOnce(profile, child, { timeoutMs: 600_000 })
  expect(first).toMatchObject({ state: 'pending', done: false })

  await profile.restartDaemon('graceful')
  const after = await waitOnce(profile, child, { deadlineMs: first.deadline_ms })
  expect(after).toMatchObject({
    state: 'pending',
    phase: 'running',
    deadline_ms: first.deadline_ms,
    message_id: first.message_id,
  })
  await cancelActiveSubmission(profile, child)
  const settled = await waitForChild(profile, child, 'settled', { outcome: 'interrupted' })
  await profile.restartDaemon('kill')
  expect(await waitOnce(profile, child, { deadlineMs: first.deadline_ms })).toMatchObject({
    state: 'settled',
    outcome: settled.outcome,
    message_id: first.message_id,
  })
})

test('out-of-range waits and a message of another child are refused', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent)).child_conversation_id
  const other = await delegate(profile, parent)
  await expect(waitOnce(profile, child, { timeoutMs: 86_400_001 })).rejects.toThrow(/exceeds/)
  await expect(waitOnce(profile, child, { deadlineMs: Date.now() + 2 * 86_400_000 })).rejects.toThrow(
    /more than one day/,
  )
  await expect(waitOnce(profile, child, { messageId: other.task_message_id })).rejects.toThrow(
    /not a task or message sent to this child/,
  )
  const usage = await profile.cli('child', 'wait', child, '--timeout-ms', '86400001')
  expect(usage.code).not.toBe(0)
})
