// F031: provider output larger than one message may hold. An agent message
// or a tool output past 1 MiB is stored cut on a character boundary and
// ends with an explicit truncation marker. It never fails the Conversation,
// the marker survives a daemon restart, and the next turn runs normally.
import { expect, prompts, send, startConversation, test, turnReply, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { conversationFaults } from '../fixtures/conversation-faults'

const LIMIT = 1024 * 1024
const MARKER = '[ADE truncated this message at 1 MiB. The rest of the provider\'s output was not stored.]'

async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

function large(messages: Awaited<ReturnType<typeof snapshot>>['messages']) {
  const answer = messages.find((message) => message.provider_item_id?.startsWith('large-answer-'))
  const tool = messages.find((message) => message.provider_item_id?.startsWith('large-command-'))
  return { answer, tool }
}

test('F031: a message and a tool output past 1 MiB are kept truncated with a marker and the turn completes', async ({ ade }) => {
  test.setTimeout(90_000)
  const profile = await ade.profile({ env: conversationFaults.env })
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, conversationFaults.largePrompt, 'large-turn')
  await waitForIdle(profile, conversationId, 60_000)

  const state = await snapshot(profile, conversationId)
  expect(state.conversation.error ?? null).toBeNull()
  const { answer, tool } = large(state.messages)
  expect(answer).toMatchObject({ role: 'assistant', status: 'completed' })
  expect(Buffer.byteLength(answer!.text)).toBeLessThanOrEqual(LIMIT)
  expect(answer!.text.endsWith(MARKER)).toBe(true)
  // Everything before the marker is the provider's own text, never altered.
  expect(answer!.text.slice(0, -MARKER.length).trimEnd()).toMatch(/^a+$/)
  expect(answer!.text.length).toBeGreaterThan(LIMIT - 1024)

  expect(tool).toMatchObject({ role: 'tool', kind: 'commandExecution', status: 'completed' })
  expect(Buffer.byteLength(tool!.text)).toBeLessThanOrEqual(LIMIT)
  expect(tool!.text.endsWith(MARKER)).toBe(true)
  const output = (tool!.content as { type: string; output?: string } | undefined)?.output ?? ''
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(LIMIT)
  expect(output.endsWith(MARKER)).toBe(true)

  // The stored text survives a daemon crash unchanged, and the Conversation continues.
  await profile.restartDaemon('kill')
  const after = large((await snapshot(profile, conversationId)).messages)
  expect(after.answer?.text).toBe(answer!.text)
  expect(after.tool?.text).toBe(tool!.text)
  await send(profile, conversationId, prompts.turn, 'after-large')
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  const users = (await snapshot(profile, conversationId)).messages.filter((message) => message.role === 'user')
  expect(users.map((message) => message.id)).toEqual(['large-turn', 'after-large'])
})

test('F031: a prompt past 1 MiB is still refused before dispatch', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: 'huge-prompt',
    text: 'x'.repeat(LIMIT + 1) })).rejects.toThrow()
  const state = await snapshot(profile, conversationId)
  expect(state.messages).toEqual([])
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toEqual([])
})
