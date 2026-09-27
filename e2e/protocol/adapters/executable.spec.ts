// F024: a declared custom executable protocol (text in, text out) runs
// Conversations through a generic adapter. The fixture is
// e2e/protocol/fixtures/adapters/exec_agent.sh. Everything it cannot do is
// refused with its capability limitation.
import {
  conversationStatus,
  expect,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { defineExecAdapter, execPrompts, releaseExec, stageAdapterAgents } from '../fixtures/adapters'

/** Cancel the running turn: it settles as interrupted and pauses the queue, which is resumed for the next send. */
async function cancelTurn(profile: ScratchProfile, conversationId: string) {
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
}

async function turnRunning(profile: ScratchProfile, conversationId: string) {
  await expect
    .poll(async () => {
      const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
      return conversation.status === 'running' && conversation.active_turn_id !== null
    })
    .toBe(true)
}

test('F024: a custom executable runs turns, cancel stops a running one, and unsupported operations are refused', async ({
  ade,
  profile,
}) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineExecAdapter(profile, agents)
  expect(
    (await profile.call('catalog.get', {})).providers.find((descriptor) => descriptor.id === provider),
  ).toMatchObject({ capabilities: ['streaming', 'cancel'], permission_modes: ['default'] })

  const { conversationId } = await startConversation(profile, provider as never)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Echo: hello')
  await waitForIdle(profile, conversationId)

  // Cancel stops the running process; the turn is not sent again.
  await send(profile, conversationId, 'hold please')
  await turnRunning(profile, conversationId)
  await expect.poll(() => execPrompts(agents)).toEqual(['hello', 'hold please'])
  const { conversation } = await profile.call('conversation.get', { conversation_id: conversationId })
  const steer = await profile.call('conversation.steer', {
    operation_id: 'exec-steer',
    conversation_id: conversationId,
    turn_id: conversation.active_turn_id ?? '',
    text: 'more',
  })
  expect(steer).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no native steer path') })
  await cancelTurn(profile, conversationId)
  await releaseExec(agents)
  expect(await execPrompts(agents)).toEqual(['hello', 'hold please'])
  const texts = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.map(
    (m) => m.text,
  )
  expect(texts.join('\n')).not.toContain('Echo: hold please')

  // An executable cannot resume a native session: after its runtime dies, the
  // Conversation reports that limitation instead of starting a different session.
  await profile.killRuntime()
  await profile.restartDaemon()
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error ?? '',
      { timeout: 20_000 },
    )
    .toContain('cannot resume sessions')
  expect(await execPrompts(agents)).toEqual(['hello', 'hold please'])
})
