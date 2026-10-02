// F036, R001 and R002: after a lost reply or a crash, a window finds its
// unresolved sends with draft.send.list and settles each one with
// draft.send.acknowledge. Acknowledgement never dispatches a prompt; it only
// settles what the daemon can prove.
import {
  expect,
  prompts,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
}

async function prepare(
  profile: ScratchProfile,
  conversationId: string,
  windowId: string,
  requestId: string,
  text: string,
  contextNodes?: { id: string; kind: string; data: unknown }[],
) {
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: windowId,
    text,
    revision: 1,
    context_nodes: contextNodes,
  })
  return profile.call('draft.send.prepare', {
    conversation_id: conversationId,
    window_id: windowId,
    request_id: requestId,
    draft_text: text,
    text,
    revision: 1,
    attachments: [],
    context_nodes: contextNodes,
  })
}

test('R001: a send accepted with its reply lost is listed as accepted and acknowledged once, across a crash', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-lost-reply'
  await prepare(profile, conversationId, window, 'lost-reply-send', prompts.turn)
  await sendAndLoseReply(profile, {
    op: 'agent.send',
    conversation_id: conversationId,
    request_id: 'lost-reply-send',
    text: prompts.turn,
  })
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  // The window crashed with the reply; the daemon crashes too.
  await profile.restartDaemon('kill')

  const listed = await profile.call('draft.send.list', { window_id: window })
  expect(listed.sends).toEqual([
    expect.objectContaining({
      outcome: 'accepted',
      intent: expect.objectContaining({ request_id: 'lost-reply-send', conversation_id: conversationId }),
    }),
  ])
  const acknowledge = { conversation_id: conversationId, window_id: window, request_id: 'lost-reply-send' }
  const settled = await profile.call('draft.send.acknowledge', acknowledge)
  expect(settled).toMatchObject({ resolution: 'completed', draft: { text: '', revision: 2 } })
  // A repeat after another lost reply returns the same settlement and writes nothing new.
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: window,
    text: 'next idea',
    revision: 3,
  })
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({
    resolution: 'completed',
    draft: { text: 'next idea', revision: 3 },
  })
  expect((await profile.call('draft.send.list', { window_id: window })).sends).toEqual([])
  expect(await turnStarts(profile)).toEqual(['lost-reply-send'])
})

test('R001: a prepared send with context survives daemon restart and dispatches once', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-prepared'
  const context = [
    { id: 'context-restart', kind: 'terminal_selection', data: { text: 'retained context', terminal: 'term-1' } },
  ]
  const prepared = await prepare(profile, conversationId, window, 'prepared-send', prompts.turn, context)
  expect(prepared.intent.context_nodes).toEqual(context)
  await profile.restartDaemon('kill')

  const listed = await profile.call('draft.send.list', { window_id: window })
  expect(listed.sends).toEqual([
    expect.objectContaining({
      outcome: 'prepared',
      intent: expect.objectContaining({ request_id: 'prepared-send', context_nodes: context }),
    }),
  ])
  expect((await profile.call('draft.send.get', { conversation_id: conversationId, window_id: window })).intent).toEqual(
    prepared.intent,
  )
  expect((await profile.call('draft.get', { conversation_id: conversationId, window_id: window })).draft).toMatchObject(
    {
      text: prompts.turn,
      context_nodes: context,
    },
  )
  const acknowledge = { conversation_id: conversationId, window_id: window, request_id: 'prepared-send' }
  await expect(profile.call('draft.send.acknowledge', acknowledge)).rejects.toThrow(
    /retry delivery with the same request ID/,
  )
  expect(await turnStarts(profile)).toEqual([])

  await profile.call('agent.send', { conversation_id: conversationId, request_id: 'prepared-send', text: prompts.turn })
  await waitForIdle(profile, conversationId)
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({
    resolution: 'completed',
    draft: { text: '', revision: 2 },
  })
  expect(
    (await profile.call('draft.history.list', { conversation_id: conversationId, window_id: window })).entries,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'sent', text: prompts.turn, context_nodes: context })]),
  )
  expect(await turnStarts(profile)).toEqual(['prepared-send'])
})

test('R001: rejected empty and non-empty contexts survive daemon restart and abort restoration', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const busyWindow = 'window-busy'
  const emptyWindow = 'window-busy-empty-context'
  const context = [
    { id: 'context-aborted', kind: 'terminal_selection', data: { text: 'keep attached context', terminal: 'term-2' } },
  ]
  const emptyText = 'keep this text without context'
  // Hold a turn so both following sends are refused before admission.
  await profile.call('agent.send', { conversation_id: conversationId, request_id: 'holding', text: prompts.hold })
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')

  await prepare(profile, conversationId, busyWindow, 'refused-send', 'keep this text', context)
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-send', text: 'keep this text' }),
  ).rejects.toThrow(/active turn/)
  await prepare(profile, conversationId, emptyWindow, 'refused-empty-send', emptyText, [])
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-empty-send', text: emptyText }),
  ).rejects.toThrow(/active turn/)

  expect((await profile.call('draft.send.list', { window_id: busyWindow })).sends).toEqual([
    expect.objectContaining({ outcome: 'rejected', intent: expect.objectContaining({ context_nodes: context }) }),
  ])
  expect((await profile.call('draft.send.list', { window_id: emptyWindow })).sends).toEqual([
    expect.objectContaining({ outcome: 'rejected', intent: expect.objectContaining({ context_nodes: [] }) }),
  ])
  await profile.restartDaemon()

  for (const [window_id, request_id, context_nodes] of [
    [busyWindow, 'refused-send', context],
    [emptyWindow, 'refused-empty-send', []],
  ] as const) {
    expect(await profile.call('draft.send.get', { conversation_id: conversationId, window_id })).toMatchObject({
      intent: { request_id, context_nodes },
    })
    expect((await profile.call('draft.send.list', { window_id })).sends).toEqual([
      expect.objectContaining({ outcome: 'rejected', intent: expect.objectContaining({ request_id, context_nodes }) }),
    ])
  }

  const restored = await profile.call('draft.send.abort', {
    conversation_id: conversationId,
    window_id: emptyWindow,
    request_id: 'refused-empty-send',
  })
  expect(restored.draft).toMatchObject({ text: emptyText, revision: 1 })
  expect((await profile.call('draft.send.list', { window_id: emptyWindow })).sends).toEqual([])

  const acknowledge = { conversation_id: conversationId, window_id: busyWindow, request_id: 'refused-send' }
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({
    resolution: 'aborted',
    draft: { text: 'keep this text', context_nodes: context },
  })
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({ resolution: 'aborted' })
  expect((await profile.call('draft.send.list', { window_id: busyWindow })).sends).toEqual([])
  // An aborted ID can never be delivered later.
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-send', text: 'keep this text' }),
  ).rejects.toThrow(/aborted/)
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-empty-send', text: emptyText }),
  ).rejects.toThrow(/aborted/)
  expect(await turnStarts(profile)).toEqual(['holding'])
})

test('R002: send intents refuse a different payload or owner under the same request ID', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-dup'
  const prepared = await prepare(profile, conversationId, window, 'dup-intent', prompts.turn)
  // The same preparation converges.
  expect(
    await profile.call('draft.send.prepare', {
      conversation_id: conversationId,
      window_id: window,
      request_id: 'dup-intent',
      draft_text: prompts.turn,
      text: prompts.turn,
      revision: 1,
      attachments: [],
    }),
  ).toEqual(prepared)
  await expect(
    profile.call('draft.send.prepare', {
      conversation_id: conversationId,
      window_id: window,
      request_id: 'dup-intent',
      draft_text: prompts.turn,
      text: 'different',
      revision: 1,
      attachments: [],
    }),
  ).rejects.toThrow(/different prompt/)
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: 'dup-intent', text: 'different' }),
  ).rejects.toThrow(/different prompt/)
  await expect(
    profile.call('draft.send.acknowledge', {
      conversation_id: conversationId,
      window_id: 'another-window',
      request_id: 'dup-intent',
    }),
  ).rejects.toThrow(/another owner/)
  // Paging across Conversations: one entry per Conversation, ordered, with a cursor.
  const second = await startConversation(profile, 'codex')
  await prepare(profile, second.conversationId, window, 'dup-intent-2', prompts.turn)
  const first = await profile.call('draft.send.list', { window_id: window, limit: 1 })
  expect(first.sends).toHaveLength(1)
  expect(first.next_cursor).not.toBeNull()
  const rest = await profile.call('draft.send.list', { window_id: window, after: first.next_cursor!, limit: 1 })
  expect(rest.sends).toHaveLength(1)
  expect(rest.next_cursor).toBeNull()
  expect([...first.sends, ...rest.sends].map((send) => send.intent.request_id).sort()).toEqual([
    'dup-intent',
    'dup-intent-2',
  ])
  expect(await turnStarts(profile)).toEqual([])
})
