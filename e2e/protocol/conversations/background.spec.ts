// Ticket 11: a prompt that yields while the provider still runs background work keeps the
// conversation running, with the provider's evidence; output no submission owns is recorded as
// the session's own, never as a prompt; and the record settles from native evidence only.
import { expect, send, startConversation, test, waitForIdle, waitForMessage } from '../fixtures'

test('background work outlives the yielded prompt, and its settlement comes from the provider', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  const read = async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  await send(profile, conversationId, 'background-task')
  await waitForMessage(profile, conversationId, 'Started the build in the background')
  await waitForIdle(profile, conversationId)

  // The prompt yielded, but the native task still runs.
  const yielded = await read()
  expect(yielded.background).toMatchObject({ active: true, running: 1, source: 'task_lifecycle' })
  expect(yielded.attention).toBe('running')
  expect(yielded.autonomous_output_at_ms).toBeNull()
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.conversations.find((item) => item.id === conversationId)?.attention).toBe('running')

  // The session reports output and then the task ends; no prompt owns the output.
  await profile.releaseMock('claude', 'release-background')
  await expect.poll(async () => (await read()).background?.active).toBe(false)
  const settled = await read()
  expect(settled.status).toMatch(/^(idle|ready)$/)
  expect(settled).toMatchObject({ attention: 'idle', background: { running: 0 } })
  expect(settled.autonomous_output_at_ms).toEqual(expect.any(Number))
  const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
  const autonomous = messages.find((message) => message.text === 'The build finished')
  expect(autonomous).toMatchObject({ role: 'assistant' })
  expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)

  // The CLI reads the same record.
  const cli = await profile.cli('conversation', 'inspect', conversationId)
  expect(cli.json!.conversation).toMatchObject({ background: settled.background })
})

test('a provider that exits leaves its background work unknown, never settled', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await send(profile, conversationId, 'background-task')
  await waitForIdle(profile, conversationId)
  const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
  await profile.call('agent.terminate', {
    operation_id: 'background-terminate',
    conversation_id: conversationId,
    source_attempt_id: conversation.runtime_run!,
  })
  await expect
    .poll(
      async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.background,
    )
    .toMatchObject({ active: null, running: 1, source: 'provider_exited' })
})
