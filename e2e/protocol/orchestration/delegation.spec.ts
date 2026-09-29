// F104, F106, F107 and 09-S08: delegation to a child Conversation with a
// durable parent link, messages to the child, non-blocking waits, questions
// answered once, and effect-command deduplication, over real daemon and
// runtime processes with the provider mocks.
import { expect, fixtureAnswers, prompts, test, turnReply, waitForMessage } from '../fixtures'
import { createWorktree } from '../fixtures/worktrees'
import { opId, parentIn, waitForChild, waitOnce } from './steps'

test('delegates a child with a durable parent link, reports admission before completion, and settles on evidence', async ({
  profile,
  repo,
}) => {
  const { workspace, parent } = await parentIn(profile, repo.path)
  const operation = opId('delegate')

  const { child } = await profile.call('orchestration.delegate', {
    operation_id: operation,
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: 'codex',
    account: { mode: 'inherit' },
    workspace: { mode: 'same' },
    task: prompts.turn,
    title: 'Child task',
  })
  expect(child).toMatchObject({
    parent_conversation_id: parent,
    operation_id: operation,
    attribution: 'user',
    depth: 1,
    provider: 'codex',
    workspace_id: workspace.id,
    workspace_mode: 'same',
    worktree_operation_id: null,
  })
  // Admission is not completion: the reply names the queued task, not an outcome.
  expect(child.task_message_id).toMatch(/\S/)

  const settled = await waitForChild(profile, child.child_conversation_id, 'settled', { outcome: 'completed' })
  expect(settled).toMatchObject({ message_id: child.task_message_id, done: true })
  await waitForMessage(profile, child.child_conversation_id, turnReply.codex)

  const { children } = await profile.call('orchestration.children', { parent_conversation_id: parent })
  expect(children.map((item) => item.child_conversation_id)).toEqual([child.child_conversation_id])
  const read = await profile.call('orchestration.child.get', { child_conversation_id: child.child_conversation_id })
  expect(read.child).toMatchObject({ parent_conversation_id: parent, task_message_id: child.task_message_id })
  expect(read.child.status).toMatch(/^(idle|ready)$/)

  // The child is an ordinary Conversation in the catalog, bound to the stated workspace.
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.conversations.find((item) => item.id === child.child_conversation_id)).toMatchObject({
    workspace_id: workspace.id,
    provider: 'codex',
    title: 'Child task',
  })
})

test('messages a child, attributes the parent Agent, and waits on each message without blocking', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'agent', conversation_id: parent },
    provider: 'codex',
    account: { mode: 'inherit' },
    workspace: { mode: 'same' },
    task: prompts.turn,
  })
  expect(child.attribution).toBe(`agent:${parent}`)
  const childId = child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })

  // A held turn: the wait answers at once even with a long timeout, and says it is still pending.
  const held = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'agent', conversation_id: parent },
    text: prompts.hold,
  })
  expect(held).toMatchObject({ child_conversation_id: childId, attribution: `agent:${parent}` })
  await expect
    .poll(async () => (await waitOnce(profile, childId, { messageId: held.message_id, timeoutMs: 0 })).phase)
    .toBe('running')
  const started = Date.now()
  const pending = await waitOnce(profile, childId, { messageId: held.message_id, timeoutMs: 60_000 })
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(pending).toMatchObject({ state: 'pending', phase: 'running', done: false })
  expect(pending.deadline_ms).toBeGreaterThan(Date.now() + 50_000)
  // A repeat carries the first deadline; a deadline already passed reports timed_out, not an outcome.
  const again = await waitOnce(profile, childId, { messageId: held.message_id, deadlineMs: pending.deadline_ms })
  expect(again).toMatchObject({ state: 'pending', deadline_ms: pending.deadline_ms })
  const timedOut = await waitOnce(profile, childId, { messageId: held.message_id, timeoutMs: 0 })
  expect(timedOut).toMatchObject({ state: 'timed_out', phase: 'running', done: true })

  // A message sent behind the held turn waits in the child's durable queue.
  const queued = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' },
    text: prompts.turn,
  })
  expect(queued.attribution).toBe('user')
  expect(await waitOnce(profile, childId, { messageId: queued.message_id, timeoutMs: 60_000 })).toMatchObject({
    state: 'pending',
    phase: 'queued',
    done: false,
  })

  // Cancelling the held turn settles it as interrupted and pauses the child's queue. The queued
  // message is reported blocked, not pending, until the queue is resumed. The child's Agent
  // is still connected, so resuming the queue dispatches it, as for an idle child.
  await profile.call('agent.cancel', { conversation_id: childId })
  const interrupted = await waitForChild(profile, childId, 'settled', {
    messageId: held.message_id,
    outcome: 'interrupted',
  })
  expect(interrupted.done).toBe(true)
  expect(await waitForChild(profile, childId, 'blocked', { messageId: queued.message_id })).toMatchObject({
    done: true,
  })
  await profile.call('queue.pause', { conversation_id: childId, paused: false })
  await waitForChild(profile, childId, 'settled', { messageId: queued.message_id, outcome: 'completed' })
  // The newest message is the default target of a wait.
  expect((await waitOnce(profile, childId)).message_id).toBe(queued.message_id)
})

test('a child question is reported as needs_input and is answered once; a late answer is refused', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: 'codex',
    account: { mode: 'inherit' },
    workspace: { mode: 'same' },
    task: prompts.questions,
  })
  const childId = child.child_conversation_id
  const asked = await waitForChild(profile, childId, 'needs_input')
  expect(asked.done).toBe(true)
  expect(asked.request_ids).toHaveLength(1)
  const requestId = asked.request_ids![0]

  const snapshot = await profile.call('conversation.get', { conversation_id: childId })
  const request = snapshot.requests.find((item) => (item as { id: string }).id === requestId) as {
    id: string
    method: string
    params: Record<string, unknown>
  }
  await profile.call('agent.answer', {
    conversation_id: childId,
    request_id: requestId,
    decision: 'answer',
    answers: fixtureAnswers(request),
  })
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })

  await expect(
    profile.call('agent.answer', {
      conversation_id: childId,
      request_id: requestId,
      decision: 'answer',
      answers: fixtureAnswers(request, 'late answer'),
    }),
  ).rejects.toThrow()
  const answered = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(answered).toHaveLength(1)
})

test('a repeated operation ID returns the same child or message, and a changed payload conflicts (09-S08)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const operation = opId('delegate')
  const request = {
    operation_id: operation,
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    provider: 'codex',
    account: { mode: 'inherit' as const },
    workspace: { mode: 'same' as const },
    task: prompts.hold,
  }
  const first = await profile.call('orchestration.delegate', request)
  const replay = await profile.call('orchestration.delegate', request)
  expect(replay.child.child_conversation_id).toBe(first.child.child_conversation_id)
  expect(replay.child.task_message_id).toBe(first.child.task_message_id)
  await expect(profile.call('orchestration.delegate', { ...request, task: 'a different task' })).rejects.toThrow(
    /already used for a different delegation/,
  )
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toHaveLength(1)

  const childId = first.child.child_conversation_id
  const send = {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' as const },
    text: 'follow up',
  }
  const sent = await profile.call('orchestration.child.send', send)
  expect((await profile.call('orchestration.child.send', send)).message_id).toBe(sent.message_id)
  await expect(profile.call('orchestration.child.send', { ...send, text: 'another follow up' })).rejects.toThrow(
    /already used for a different child message/,
  )
  const snapshot = await profile.call('conversation.get', { conversation_id: childId })
  expect(JSON.stringify(snapshot)).not.toContain('another follow up')
})

test('refuses a forged Agent caller, an inherited account across providers and an unverified worktree, leaving no child', async ({
  profile,
  repo,
}) => {
  const { parent } = await parentIn(profile, repo.path)
  const other = (await parentIn(profile, profile.defaultWorkspaceRoot)).parent
  const base = {
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    provider: 'codex',
    account: { mode: 'inherit' as const },
    workspace: { mode: 'same' as const },
    task: prompts.turn,
  }

  await expect(
    profile.call('orchestration.delegate', {
      ...base,
      operation_id: opId('forged'),
      caller: { kind: 'agent', conversation_id: other },
    }),
  ).rejects.toThrow(/only from its own Conversation/)
  await expect(
    profile.call('orchestration.delegate', { ...base, operation_id: opId('cross'), provider: 'claude' }),
  ).rejects.toThrow(/needs the parent's provider/)
  // A workspace that no succeeded worktree.switch created is not a new worktree.
  const unrelated = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(
    profile.call('orchestration.delegate', {
      ...base,
      operation_id: opId('fake-tree'),
      workspace: {
        mode: 'new_worktree',
        workspace_id: unrelated.workspace.id,
        project_id: 'repository_missing',
        worktree_operation_id: 'missing',
      },
    }),
  ).rejects.toThrow()
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toEqual([])

  // Only the parent Agent or the user may message a child.
  const { child } = await profile.call('orchestration.delegate', { ...base, operation_id: opId('ok') })
  await expect(
    profile.call('orchestration.child.send', {
      operation_id: opId('send'),
      child_conversation_id: child.child_conversation_id,
      caller: { kind: 'agent', conversation_id: other },
      text: 'not yours',
    }),
  ).rejects.toThrow(/Only the parent Conversation/)
  // A Conversation that is not a delegated child cannot be waited on as one.
  await expect(waitOnce(profile, other)).rejects.toThrow(/not a delegated child/)
})

test('delegates into a new worktree the lifecycle ledger created, with an explicit managed account', async ({
  profile,
  repo,
}) => {
  const { parent, workspace } = await parentIn(profile, repo.path)
  const tree = await createWorktree(profile, repo.path, 'child-tree')
  const { account } = await profile.call('account.create', { provider: 'codex', name: 'Child account' })

  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('tree'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: 'codex',
    account: { mode: 'managed', account_id: account.id },
    workspace: {
      mode: 'new_worktree',
      workspace_id: tree.workspaceId,
      project_id: tree.projectId,
      worktree_operation_id: tree.operationId,
    },
    task: prompts.hold,
  })
  expect(child).toMatchObject({
    workspace_id: tree.workspaceId,
    workspace_mode: 'new_worktree',
    worktree_operation_id: tree.operationId,
    account_id: account.id,
  })
  expect(child.workspace_id).not.toBe(workspace.id)
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.conversations.find((item) => item.id === child.child_conversation_id)).toMatchObject({
    workspace_id: tree.workspaceId,
    account_id: account.id,
  })
  // The parent's own workspace is not a new worktree.
  await expect(
    profile.call('orchestration.delegate', {
      operation_id: opId('tree-parent'),
      parent_conversation_id: parent,
      caller: { kind: 'user' },
      provider: 'codex',
      account: { mode: 'ambient' },
      workspace: {
        mode: 'new_worktree',
        workspace_id: workspace.id,
        project_id: tree.projectId,
        worktree_operation_id: tree.operationId,
      },
      task: prompts.turn,
    }),
  ).rejects.toThrow(/different workspace/)
})

test('links, messages and replays survive a daemon restart and a daemon crash (F106)', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const delegate = {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    provider: 'codex',
    account: { mode: 'inherit' as const },
    workspace: { mode: 'same' as const },
    task: prompts.turn,
  }
  const { child } = await profile.call('orchestration.delegate', delegate)
  const childId = child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })
  const send = {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' as const },
    text: prompts.turn,
  }
  const sent = await profile.call('orchestration.child.send', send)
  await waitForChild(profile, childId, 'settled', { messageId: sent.message_id, outcome: 'completed' })

  for (const mode of ['graceful', 'kill'] as const) {
    const before = profile.hello
    const after = await profile.restartDaemon(mode)
    expect(after.boot_id).not.toBe(before.boot_id)
    const { children } = await profile.call('orchestration.children', { parent_conversation_id: parent })
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      child_conversation_id: childId,
      parent_conversation_id: parent,
      operation_id: delegate.operation_id,
      task_message_id: child.task_message_id,
    })
    // The same operation IDs replay their first results instead of creating work again.
    expect((await profile.call('orchestration.delegate', delegate)).child.child_conversation_id).toBe(childId)
    expect((await profile.call('orchestration.child.send', send)).message_id).toBe(sent.message_id)
    expect(await waitOnce(profile, childId, { messageId: child.task_message_id })).toMatchObject({
      state: 'settled',
      outcome: expect.stringMatching(/^(completed|unknown)$/),
    })
    expect(await waitOnce(profile, childId, { messageId: sent.message_id })).toMatchObject({
      state: 'settled',
      outcome: 'completed',
    })
  }
})

test('a child turn lost with its runtime is reported as not completed, and the parent link survives (F106)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: 'codex',
    account: { mode: 'inherit' },
    workspace: { mode: 'same' },
    task: prompts.hold,
  })
  const childId = child.child_conversation_id
  await expect.poll(async () => (await waitOnce(profile, childId, { timeoutMs: 0 })).phase).toBe('running')

  await profile.killRuntime()
  await profile.restartDaemon()
  const settled = await waitForChild(profile, childId, 'settled')
  expect(settled.outcome).not.toBe('completed')
  expect(['interrupted', 'unknown', 'failed']).toContain(settled.outcome)
  const { children } = await profile.call('orchestration.children', { parent_conversation_id: parent })
  expect(children.map((item) => item.child_conversation_id)).toEqual([childId])
  expect(children[0].status).not.toBe('unavailable')

  // The child keeps its own lifetime. Runtime loss pauses its queue, so a new message is
  // blocked until the queue and the child are resumed explicitly, and then it completes.
  const next = await profile.call('orchestration.child.send', {
    operation_id: opId('send'),
    child_conversation_id: childId,
    caller: { kind: 'user' },
    text: prompts.turn,
  })
  await waitForChild(profile, childId, 'blocked', { messageId: next.message_id })
  await profile.call('queue.pause', { conversation_id: childId, paused: false })
  await profile.call('agent.resume', { conversation_id: childId })
  await waitForChild(profile, childId, 'settled', { messageId: next.message_id, outcome: 'completed' })
})

test('the CLI delegates, lists, reads, messages and waits on a child with structured output', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const operation = opId('cli-delegate')
  const delegated = await profile.cli(
    'child',
    'delegate',
    parent,
    'codex',
    prompts.turn,
    '--workspace',
    'same',
    '--account',
    'inherit',
    '--operation-id',
    operation,
  )
  expect(delegated.code).toBe(0)
  const child = (delegated.json as { child: { child_conversation_id: string } }).child
  const childId = child.child_conversation_id

  const waited = await profile.cli('child', 'wait', childId, '--timeout-ms', '20000')
  expect(waited.code).toBe(0)
  expect(waited.json).toMatchObject({ type: 'child_wait', state: 'settled', outcome: 'completed', done: true })

  const replay = await profile.cli(
    'child',
    'delegate',
    parent,
    'codex',
    prompts.turn,
    '--workspace',
    'same',
    '--account',
    'inherit',
    '--operation-id',
    operation,
  )
  expect((replay.json as { child: { child_conversation_id: string } }).child.child_conversation_id).toBe(childId)
  const conflict = await profile.cli(
    'child',
    'delegate',
    parent,
    'codex',
    'changed',
    '--workspace',
    'same',
    '--account',
    'inherit',
    '--operation-id',
    operation,
  )
  expect(conflict.code).not.toBe(0)
  expect(conflict.json).toMatchObject({ type: 'error' })

  const listed = await profile.cli('child', 'list', parent)
  expect(listed.json).toMatchObject({ type: 'child_list', parent_conversation_id: parent })
  expect((listed.json as { children: unknown[] }).children).toHaveLength(1)
  expect((await profile.cli('child', 'get', childId)).json).toMatchObject({
    type: 'child',
    child: { child_conversation_id: childId },
  })

  const sent = await profile.cli('child', 'send', childId, prompts.hold, '--as-agent', parent)
  expect(sent.json).toMatchObject({ type: 'child_message_queued', attribution: `agent:${parent}` })
  // A bounded CLI wait on a held turn ends as timed_out, not as an outcome.
  const timedOut = await profile.cli('child', 'wait', childId, '--timeout-ms', '300')
  expect(timedOut.code).toBe(0)
  expect(timedOut.json).toMatchObject({ state: 'timed_out', done: true })

  const usage = await profile.cli('child', 'wait', childId, '--timeout-ms', 'soon')
  expect(usage.code).not.toBe(0)
  await profile.call('agent.cancel', { conversation_id: childId })
  const cancelled = await profile.cli('child', 'wait', childId, '--timeout-ms', '20000')
  expect(cancelled.json).toMatchObject({ state: 'settled', outcome: 'interrupted' })
})
