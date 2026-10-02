// PC33: a burst of streamed text with no pause, then a native request, more text, a failed tool's
// terminal state, an error and the turn's end, through real daemon, runtime and provider processes.
// The burst fills the provider worker's bounded event queue many times over; backpressure must hold
// the rest of the native output rather than fail the session, and every transition is kept in order.
import { answerFor, answerIntent, expect, send, startConversation, test, waitForPendingRequest } from '../fixtures'

test('a burst of text then a request, a terminal tool state and an error are all retained in order', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'burst-ordering')
  const request = await waitForPendingRequest(profile, conversationId)

  // When the request is offered, all the text the provider sent before it is already retained.
  const before = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(before.conversation.error).toBeNull()
  const streamed = before.messages.find((message) => message.role === 'assistant')!
  expect(streamed.text).toContain('Burst line 399\n')
  expect(streamed.text.match(/Burst line \d+\n/g)).toHaveLength(400)

  await profile.call('agent.answer', answerIntent(request, answerFor(request, 'accept')))
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('error')
  const after = await profile.call('conversation.get', { conversation_id: conversationId })
  // ADE reports the native error by its kind; the provider's own text is not shown.
  expect(after.conversation.error).toContain('Provider rejected the operation')
  const assistant = after.messages.find((message) => message.role === 'assistant')!
  expect(assistant.text.match(/After approval line \d+\n/g)).toHaveLength(200)
  expect(assistant.text.indexOf('Burst line 399')).toBeLessThan(assistant.text.indexOf('After approval line 0'))
  const tool = after.messages.find((message) => message.role === 'tool')!
  expect(tool).toMatchObject({ status: 'failed' })
  expect(JSON.stringify(tool)).toContain('BURST_TOOL_OUTPUT')
})
