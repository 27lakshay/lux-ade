// F036, R001 and R002: after a lost reply or a crash, a window finds its
// unresolved sends with draft.send.list and settles each one with
// draft.send.acknowledge. Acknowledgement never dispatches a prompt; it only
// settles what the daemon can prove.
import { expect, prompts, startConversation, test, turnReply, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
}

async function prepare(profile: ScratchProfile, conversationId: string, windowId: string, requestId: string, text: string) {
  await profile.call('draft.save', { conversation_id: conversationId, window_id: windowId, text, revision: 1 })
  return profile.call('draft.send.prepare', { conversation_id: conversationId, window_id: windowId, request_id: requestId,
    draft_text: text, text, revision: 1, attachments: [] })
}

test('R001: a send accepted with its reply lost is listed as accepted and acknowledged once, across a crash', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-lost-reply'
  await prepare(profile, conversationId, window, 'lost-reply-send', prompts.turn)
  await sendAndLoseReply(profile, { op: 'agent.send', conversation_id: conversationId, request_id: 'lost-reply-send', text: prompts.turn })
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  // The window crashed with the reply; the daemon crashes too.
  await profile.restartDaemon('kill')

  const listed = await profile.call('draft.send.list', { window_id: window })
  expect(listed.sends).toEqual([expect.objectContaining({ outcome: 'accepted',
    intent: expect.objectContaining({ request_id: 'lost-reply-send', conversation_id: conversationId }) })])
  const acknowledge = { conversation_id: conversationId, window_id: window, request_id: 'lost-reply-send' }
  const settled = await profile.call('draft.send.acknowledge', acknowledge)
  expect(settled).toMatchObject({ resolution: 'completed', draft: { text: '', revision: 2 } })
  // A repeat after another lost reply returns the same settlement and writes nothing new.
  await profile.call('draft.save', { conversation_id: conversationId, window_id: window, text: 'next idea', revision: 3 })
  expect(await profile.call('draft.send.acknowledge', acknowledge))
    .toMatchObject({ resolution: 'completed', draft: { text: 'next idea', revision: 3 } })
  expect((await profile.call('draft.send.list', { window_id: window })).sends).toEqual([])
  expect(await turnStarts(profile)).toEqual(['lost-reply-send'])
})

test('R001: a prepared send that never reached the daemon is listed as prepared and cannot be acknowledged away', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-prepared'
  await prepare(profile, conversationId, window, 'prepared-send', prompts.turn)
  await profile.restartDaemon('kill')
  expect((await profile.call('draft.send.list', { window_id: window })).sends)
    .toEqual([expect.objectContaining({ outcome: 'prepared', intent: expect.objectContaining({ request_id: 'prepared-send' }) })])
  const acknowledge = { conversation_id: conversationId, window_id: window, request_id: 'prepared-send' }
  await expect(profile.call('draft.send.acknowledge', acknowledge)).rejects.toThrow(/retry delivery with the same request ID/)
  expect(await turnStarts(profile)).toEqual([])
  // Delivery with the same ID dispatches it once; then acknowledgement completes it.
  await profile.call('agent.send', { conversation_id: conversationId, request_id: 'prepared-send', text: prompts.turn })
  await waitForIdle(profile, conversationId)
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({ resolution: 'completed' })
  expect(await turnStarts(profile)).toEqual(['prepared-send'])
})

test('R001: a send the daemon rejected is listed as rejected and acknowledgement keeps the draft', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const busyWindow = 'window-busy'
  // Hold a turn so the next send is refused before admission.
  await profile.call('agent.send', { conversation_id: conversationId, request_id: 'holding', text: prompts.hold })
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  await prepare(profile, conversationId, busyWindow, 'refused-send', 'keep this text')
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-send', text: 'keep this text' }))
    .rejects.toThrow(/active turn/)
  expect((await profile.call('draft.send.list', { window_id: busyWindow })).sends)
    .toEqual([expect.objectContaining({ outcome: 'rejected' })])
  await profile.restartDaemon()
  const acknowledge = { conversation_id: conversationId, window_id: busyWindow, request_id: 'refused-send' }
  expect(await profile.call('draft.send.acknowledge', acknowledge))
    .toMatchObject({ resolution: 'aborted', draft: { text: 'keep this text' } })
  expect(await profile.call('draft.send.acknowledge', acknowledge)).toMatchObject({ resolution: 'aborted' })
  // An aborted ID can never be delivered later.
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: 'refused-send', text: 'keep this text' }))
    .rejects.toThrow(/aborted/)
  expect(await turnStarts(profile)).toEqual(['holding'])
})

test('R002: send intents refuse a different payload or owner under the same request ID', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = 'window-dup'
  const prepared = await prepare(profile, conversationId, window, 'dup-intent', prompts.turn)
  // The same preparation converges.
  expect(await profile.call('draft.send.prepare', { conversation_id: conversationId, window_id: window, request_id: 'dup-intent',
    draft_text: prompts.turn, text: prompts.turn, revision: 1, attachments: [] })).toEqual(prepared)
  await expect(profile.call('draft.send.prepare', { conversation_id: conversationId, window_id: window, request_id: 'dup-intent',
    draft_text: prompts.turn, text: 'different', revision: 1, attachments: [] })).rejects.toThrow(/different prompt/)
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: 'dup-intent', text: 'different' }))
    .rejects.toThrow(/different prompt/)
  await expect(profile.call('draft.send.acknowledge', { conversation_id: conversationId, window_id: 'another-window',
    request_id: 'dup-intent' })).rejects.toThrow(/another owner/)
  // Paging across Conversations: one entry per Conversation, ordered, with a cursor.
  const second = await startConversation(profile, 'codex')
  await prepare(profile, second.conversationId, window, 'dup-intent-2', prompts.turn)
  const first = await profile.call('draft.send.list', { window_id: window, limit: 1 })
  expect(first.sends).toHaveLength(1)
  expect(first.next_cursor).not.toBeNull()
  const rest = await profile.call('draft.send.list', { window_id: window, after: first.next_cursor!, limit: 1 })
  expect(rest.sends).toHaveLength(1)
  expect(rest.next_cursor).toBeNull()
  expect([...first.sends, ...rest.sends].map((send) => send.intent.request_id).sort()).toEqual(['dup-intent', 'dup-intent-2'])
  expect(await turnStarts(profile)).toEqual([])
})
