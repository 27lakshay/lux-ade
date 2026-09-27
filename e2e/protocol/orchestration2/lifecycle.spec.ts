// F104 and F106: a child's lifecycle from admission to settlement as the
// parent sees it, a failed child and an unavailable child Agent, each across
// daemon restarts and crashes, and parent and child lifetimes that do not
// depend on each other. Real daemon and runtime processes with the Codex mock
// and a custom executable agent that fails on request.
import { expect, isRunning, prompts, test, turnReply, waitForMessage } from '../fixtures'
import { defineFailingAgent, failingAgentPrompts } from '../fixtures/failing-agent'
import { childView, delegate, opId, parentIn, waitForChild, waitForStatus, waitOnce } from './steps'

test('a child is admitted, runs and settles, and the parent sees each step without assuming completion (F104)', async ({
  profile,
}) => {
  const { parent, workspace } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent, prompts.hold)
  const childId = child.child_conversation_id
  // Admission: the reply names the queued task and binds provider, account and workspace explicitly.
  expect(child).toMatchObject({
    provider: 'codex',
    account_id: null,
    workspace_id: workspace.id,
    workspace_mode: 'same',
    pending_requests: [],
  })
  expect(child.status).not.toBe('ready')
  const admitted = await waitOnce(profile, childId, { timeoutMs: 0 })
  expect(admitted.message_id).toBe(child.task_message_id)
  expect(admitted.state === 'settled').toBe(false)

  // Running: the parent's view and the wait agree, and nothing claims an outcome.
  await expect.poll(async () => (await waitOnce(profile, childId, { timeoutMs: 0 })).phase).toBe('running')
  expect((await childView(profile, parent, childId)).status).toBe('running')

  // Cancelled: settles as interrupted, never completed.
  await profile.call('agent.cancel', { conversation_id: childId })
  expect(await waitForChild(profile, childId, 'settled', { outcome: 'interrupted' })).toMatchObject({ done: true })
  expect((await childView(profile, parent, childId)).status).toBe('interrupted')

  // Resumed with a new message: runs to a completed settlement on evidence from the transcript.
  await profile.call('queue.pause', { conversation_id: childId, paused: false })
  const next = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' },
    text: prompts.turn,
  })
  await waitForChild(profile, childId, 'settled', { messageId: next.message_id, outcome: 'completed' })
  await waitForMessage(profile, childId, turnReply.codex)
  expect((await childView(profile, parent, childId)).status).toBe('ready')
  // The earlier task keeps its own outcome; a later turn does not rewrite it as completed.
  expect((await waitOnce(profile, childId, { messageId: child.task_message_id })).outcome).not.toBe('completed')
})

test('a failed child reports failed with its error, keeps that across a restart and a crash, and records one activity (F106)', async ({
  ade,
  profile,
}) => {
  const agent = await defineFailingAgent(profile, ade.root)
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent, 'please fail', { provider: agent.provider, account: 'ambient' })
  const childId = child.child_conversation_id
  expect(child).toMatchObject({ provider: agent.provider, account_id: null })

  const failed = await waitForChild(profile, childId, 'settled', { outcome: 'failed' })
  expect(failed.error).toContain('status 3')
  expect(await childView(profile, parent, childId)).toMatchObject({
    status: 'error',
    error: expect.stringContaining('status 3'),
  })
  expect(await failingAgentPrompts(agent)).toEqual(['please fail'])
  const failures = async () =>
    (await profile.call('activity.list', { limit: 200 })).activities.filter(
      (item) => item.kind === 'turn_failed' && item.target.conversation_id === childId,
    )
  await expect.poll(async () => (await failures()).length).toBe(1)

  for (const mode of ['graceful', 'kill'] as const) {
    await profile.restartDaemon(mode)
    expect(await waitOnce(profile, childId, { messageId: child.task_message_id })).toMatchObject({
      state: 'settled',
      outcome: 'failed',
      done: true,
    })
    expect(await childView(profile, parent, childId)).toMatchObject({ status: 'error', parent_conversation_id: parent })
    expect(await failures()).toHaveLength(1)
  }
  // The failed turn was never replayed by a restart.
  expect(await failingAgentPrompts(agent)).toEqual(['please fail'])

  // A new message to the failed child waits for an explicit resume, and then runs.
  const retry = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' },
    text: 'hello again',
  })
  const held = await waitOnce(profile, childId, { messageId: retry.message_id, timeoutMs: 60_000 })
  expect(held).toMatchObject({ state: 'blocked', done: true, reason: expect.stringMatching(/paused/) })
  expect(await failingAgentPrompts(agent)).toEqual(['please fail'])
  await profile.call('queue.pause', { conversation_id: childId, paused: false })
  await waitForChild(profile, childId, 'settled', { messageId: retry.message_id, outcome: 'completed' })
  await waitForMessage(profile, childId, 'Echo: hello again')
  expect(await failingAgentPrompts(agent)).toEqual(['please fail', 'hello again'])
  // Once a later turn replaces it, the failed task is never reported as completed.
  expect((await waitOnce(profile, childId, { messageId: child.task_message_id })).outcome).not.toBe('completed')
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toHaveLength(1)
})

test('a child whose Agent is disconnected is reported blocked, not pending, until it is resumed (F107 unavailable peer)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent)
  const childId = child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })

  await profile.call('agent.disconnect', { conversation_id: childId })
  expect((await childView(profile, parent, childId)).status).toBe('disconnected')
  // A message is still accepted durably, and the wait says why it cannot move.
  const sent = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'agent', conversation_id: parent },
    text: prompts.turn,
  })
  const blocked = await waitOnce(profile, childId, { messageId: sent.message_id, timeoutMs: 60_000 })
  expect(blocked).toMatchObject({ state: 'blocked', done: true, reason: expect.stringContaining('disconnected') })
  // A daemon crash does not turn the unavailable peer into a pending one.
  await profile.restartDaemon('kill')
  expect(await waitOnce(profile, childId, { messageId: sent.message_id, timeoutMs: 60_000 })).toMatchObject({
    state: 'blocked',
    done: true,
  })

  await profile.call('agent.resume', { conversation_id: childId })
  await waitForChild(profile, childId, 'settled', { messageId: sent.message_id, outcome: 'completed' })
})

test('a child turn lost with its runtime settles as not completed while the daemon keeps running (F106 unknown)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent, prompts.hold)
  const childId = child.child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, childId, { timeoutMs: 0 })).phase).toBe('running')
  const daemon = profile.hello.pid

  await profile.killRuntime()
  const settled = await waitForChild(profile, childId, 'settled')
  expect(['interrupted', 'unknown']).toContain(settled.outcome)
  expect(profile.daemonRunning).toBe(true)
  expect(await isRunning(daemon)).toBe(true)
  const view = await childView(profile, parent, childId)
  expect(view.status).not.toMatch(/^(running|ready|unavailable)$/)
})

test('parent and child run independently: the parent ending or disconnecting does not stop the child (F106)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  await profile.call('agent.send', { conversation_id: parent, request_id: opId('parent-hold'), text: prompts.hold })
  await waitForStatus(profile, parent, 'running')
  const child = await delegate(profile, parent, prompts.hold)
  const childId = child.child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, childId, { timeoutMs: 0 })).phase).toBe('running')

  // The parent's turn ends and its Agent disconnects; the child keeps running.
  await profile.call('agent.cancel', { conversation_id: parent })
  await waitForStatus(profile, parent, 'interrupted')
  await profile.call('agent.disconnect', { conversation_id: parent })
  await waitForStatus(profile, parent, 'disconnected')
  expect((await waitOnce(profile, childId, { timeoutMs: 0 })).phase).toBe('running')
  expect((await childView(profile, parent, childId)).status).toBe('running')

  // The child ending leaves the disconnected parent as it was.
  await profile.call('agent.cancel', { conversation_id: childId })
  await waitForChild(profile, childId, 'settled', { outcome: 'interrupted' })
  expect((await profile.call('conversation.get', { conversation_id: parent })).conversation.status).toBe('disconnected')
  // The link outlives both Agents.
  expect((await profile.call('orchestration.child.get', { child_conversation_id: childId })).child).toMatchObject({
    parent_conversation_id: parent,
  })
})
