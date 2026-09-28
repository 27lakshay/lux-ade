// R001 through the CLI: `ade conversation send` holds a prompt in the SDK's send
// journal (the profile's client directory) before its first attempt. A prompt the
// daemon never answered, because it was stopped, is delivered once the daemon is
// back, under its original request ID, and never twice.
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

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
}

test('R001: a prompt the CLI sends while the daemon is stopped is delivered exactly once after it restarts', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const requestId = 'cli-held-while-stopped'
  await profile.killDaemon()

  // The daemon is down: the CLI keeps the prompt and says so.
  const held = await profile.cli('conversation', 'send', conversationId, prompts.turn, '--request-id', requestId)
  expect(held.code, held.stderr).toBe(3)
  expect(held.json).toMatchObject({ type: 'error', code: 'unavailable', message: expect.stringContaining(requestId) })
  expect((await profile.cli('conversation', 'pending')).json).toEqual({
    type: 'held_sends',
    sends: [{ request_id: requestId, conversation_id: conversationId, text: prompts.turn }],
  })
  // A different prompt for the same Conversation waits for the held one.
  const other = await profile.cli('conversation', 'send', conversationId, 'another prompt', '--request-id', 'cli-other')
  expect(other.code).toBe(8)
  expect(other.json).toMatchObject({ code: 'conflict', message: expect.stringContaining(requestId) })

  await profile.restartDaemon()
  const delivered = await profile.cli('conversation', 'deliver')
  expect(delivered.code, delivered.stderr).toBe(0)
  expect(delivered.json).toMatchObject({
    type: 'held_sends_delivered',
    results: [{ request_id: requestId, conversation_id: conversationId, outcome: 'delivered' }],
  })
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)

  // Nothing is left to deliver, and repeating the send converges on the same turn.
  expect((await profile.cli('conversation', 'pending')).json).toEqual({ type: 'held_sends', sends: [] })
  expect((await profile.cli('conversation', 'deliver')).json).toEqual({ type: 'held_sends_delivered', results: [] })
  const repeated = await profile.cli('conversation', 'send', conversationId, prompts.turn, '--request-id', requestId)
  expect(repeated.code, repeated.stderr).toBe(0)
  expect(repeated.json).toMatchObject({ request_id: requestId })

  expect(await turnStarts(profile)).toEqual([requestId])
  const users = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.filter(
    (message) => message.role === 'user',
  )
  expect(users.map((message) => message.id)).toEqual([requestId])
})

test('a prompt the daemon refuses leaves the CLI journal at once', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await profile.cli('conversation', 'send', conversationId, prompts.turn, '--request-id', 'cli-first')
  await waitForIdle(profile, conversationId)
  // The same ID with another prompt is refused by the daemon, not held.
  const refused = await profile.cli('conversation', 'send', conversationId, 'changed', '--request-id', 'cli-first')
  expect(refused.code).not.toBe(0)
  expect(JSON.stringify(refused.json)).toContain('different prompt')
  expect((await profile.cli('conversation', 'pending')).json).toEqual({ type: 'held_sends', sends: [] })
  expect(await turnStarts(profile)).toEqual(['cli-first'])
})
