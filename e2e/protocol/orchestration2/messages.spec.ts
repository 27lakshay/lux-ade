// F107 and 09-S08: identified messages in both directions between a parent
// and its delegated child. Each message is durably queued once for its
// receiver, attributed to its sender, listed with its delivery state, and
// deduplicated by its operation ID across a daemon crash.
import { expect, prompts, test, turnReply, waitForMessage, type ScratchProfile } from '../fixtures'
import { delegate, opId, parentIn, waitForChild, waitForStatus } from './steps'

type Listed = {
  message_id: string
  direction: string
  receiver_conversation_id: string
  attribution: string
  operation_id: string
  delivery: string
}

async function messages(profile: ScratchProfile, child: string): Promise<Listed[]> {
  return (await profile.call('orchestration.child.messages', { child_conversation_id: child })).messages
}

async function userTexts(profile: ScratchProfile, conversation: string): Promise<string[]> {
  return (await profile.call('conversation.get', { conversation_id: conversation })).messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
}

test('a parent and its child exchange identified messages both ways, each delivered once to its receiver', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent)
  const childId = child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })

  // Parent to child, as the parent Agent.
  const down = await profile.call('orchestration.child.send', {
    operation_id: opId('down'),
    child_conversation_id: childId,
    caller: { kind: 'agent', conversation_id: parent },
    text: prompts.turn,
  })
  await waitForChild(profile, childId, 'settled', { messageId: down.message_id, outcome: 'completed' })

  // Child to parent, as the child's own Agent. The parent receives it as a prompt naming the child.
  const reply = {
    operation_id: opId('up'),
    child_conversation_id: childId,
    caller: { kind: 'agent' as const, conversation_id: childId },
    text: 'Child finished: 2 files changed',
  }
  const up = await profile.call('orchestration.parent.send', reply)
  expect(up).toMatchObject({
    parent_conversation_id: parent,
    child_conversation_id: childId,
    attribution: `agent:${childId}`,
  })
  await expect
    .poll(() => userTexts(profile, parent))
    .toEqual([`Message from delegated child ${childId}:\n\nChild finished: 2 files changed`])
  await waitForMessage(profile, parent, turnReply.codex)
  await waitForStatus(profile, parent, 'ready')

  // Both directions are listed oldest first with sender, receiver and delivery.
  expect(await messages(profile, childId)).toEqual([
    expect.objectContaining({
      message_id: child.task_message_id,
      direction: 'to_child',
      receiver_conversation_id: childId,
      attribution: 'user',
      delivery: 'submitted',
    }),
    expect.objectContaining({
      message_id: down.message_id,
      direction: 'to_child',
      receiver_conversation_id: childId,
      attribution: `agent:${parent}`,
      delivery: 'submitted',
    }),
    expect.objectContaining({
      message_id: up.message_id,
      direction: 'to_parent',
      receiver_conversation_id: parent,
      attribution: `agent:${childId}`,
      operation_id: reply.operation_id,
      delivery: 'submitted',
    }),
  ])

  // A retry of the same operation returns the same message and delivers nothing new; a changed payload conflicts.
  expect((await profile.call('orchestration.parent.send', reply)).message_id).toBe(up.message_id)
  await expect(profile.call('orchestration.parent.send', { ...reply, text: 'something else' })).rejects.toThrow(
    /already used for a different parent message/,
  )
  // After a daemon crash the same holds, and the parent still received the message once.
  await profile.restartDaemon('kill')
  expect((await profile.call('orchestration.parent.send', reply)).message_id).toBe(up.message_id)
  expect((await messages(profile, childId)).map((item) => item.message_id)).toEqual([
    child.task_message_id,
    down.message_id,
    up.message_id,
  ])
  expect(await userTexts(profile, parent)).toHaveLength(1)
  expect(JSON.stringify(await profile.call('conversation.get', { conversation_id: parent }))).not.toContain(
    'something else',
  )
})

test('only the child itself or the user may message the parent, and a non-child cannot', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent)).child_conversation_id
  const sibling = (await delegate(profile, parent)).child_conversation_id
  const base = { child_conversation_id: child, text: 'status' }

  await expect(
    profile.call('orchestration.parent.send', {
      ...base,
      operation_id: opId('forged'),
      caller: { kind: 'agent', conversation_id: sibling },
    }),
  ).rejects.toThrow(/Only the child Conversation/)
  await expect(
    profile.call('orchestration.parent.send', {
      ...base,
      operation_id: opId('parent-as-child'),
      caller: { kind: 'agent', conversation_id: parent },
    }),
  ).rejects.toThrow(/Only the child Conversation/)
  await expect(
    profile.call('orchestration.parent.send', {
      operation_id: opId('not-child'),
      child_conversation_id: parent,
      caller: { kind: 'agent', conversation_id: parent },
      text: 'status',
    }),
  ).rejects.toThrow(/not a delegated child/)
  await expect(
    profile.call('orchestration.parent.send', {
      ...base,
      operation_id: opId('empty'),
      caller: { kind: 'user' },
      text: '  ',
    }),
  ).rejects.toThrow(/empty/)
  expect((await messages(profile, child)).filter((item) => item.direction === 'to_parent')).toEqual([])

  const byUser = await profile.call('orchestration.parent.send', {
    ...base,
    operation_id: opId('user'),
    caller: { kind: 'user' },
  })
  expect(byUser.attribution).toBe('user')
})

test('a message for a busy parent waits in its queue and is delivered once the parent is free', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent)).child_conversation_id
  await waitForChild(profile, child, 'settled', { outcome: 'completed' })
  await profile.call('agent.send', { conversation_id: parent, request_id: opId('parent-hold'), text: prompts.hold })
  await waitForStatus(profile, parent, 'running')

  const up = await profile.call('orchestration.parent.send', {
    operation_id: opId('up'),
    child_conversation_id: child,
    caller: { kind: 'agent', conversation_id: child },
    text: 'ready for review',
  })
  const delivery = async () =>
    (await messages(profile, child)).find((item) => item.message_id === up.message_id)?.delivery
  expect(await delivery()).toBe('queued')
  const { queued } = await profile.call('conversation.get', { conversation_id: parent })
  expect(queued.map((prompt) => prompt.id)).toContain(up.message_id)

  // Cancelling the parent's turn pauses its queue; the message stays queued, not lost.
  await profile.call('agent.cancel', { conversation_id: parent })
  await waitForStatus(profile, parent, 'interrupted')
  expect(await delivery()).toBe('queued')
  await profile.restartDaemon('graceful')
  expect(await delivery()).toBe('queued')
  await profile.call('queue.pause', { conversation_id: parent, paused: false })
  await expect.poll(delivery).toBe('submitted')
  await waitForStatus(profile, parent, 'ready')
  expect((await userTexts(profile, parent)).filter((text) => text.includes('ready for review'))).toHaveLength(1)
})

test('the CLI sends a child message to its parent and lists both directions', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = (await delegate(profile, parent)).child_conversation_id
  await waitForChild(profile, child, 'settled', { outcome: 'completed' })

  const operation = opId('cli-up')
  const sent = await profile.cli(
    'child',
    'reply',
    child,
    'done from the CLI',
    '--as-agent',
    child,
    '--operation-id',
    operation,
  )
  expect(sent.code).toBe(0)
  expect(sent.json).toMatchObject({
    type: 'parent_message_queued',
    parent_conversation_id: parent,
    attribution: `agent:${child}`,
  })
  const again = await profile.cli(
    'child',
    'reply',
    child,
    'done from the CLI',
    '--as-agent',
    child,
    '--operation-id',
    operation,
  )
  expect((again.json as { message_id: string }).message_id).toBe((sent.json as { message_id: string }).message_id)
  const conflict = await profile.cli(
    'child',
    'reply',
    child,
    'changed',
    '--as-agent',
    child,
    '--operation-id',
    operation,
  )
  expect(conflict.code).not.toBe(0)
  expect(conflict.json).toMatchObject({ type: 'error' })
  const forged = await profile.cli('child', 'reply', child, 'not yours', '--as-agent', parent)
  expect(forged.code).not.toBe(0)

  const listed = await profile.cli('child', 'messages', child)
  expect(listed.code).toBe(0)
  expect(listed.json).toMatchObject({
    type: 'child_messages',
    child_conversation_id: child,
    parent_conversation_id: parent,
  })
  expect((listed.json as { messages: Listed[] }).messages.map((item) => item.direction)).toEqual([
    'to_child',
    'to_parent',
  ])
})
