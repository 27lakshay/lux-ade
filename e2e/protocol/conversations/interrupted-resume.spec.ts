// Ticket 14: a prompt whose native acceptance is unknown after its provider died stays unknown,
// is never resent, and a resume that may continue it in the native session must be explicitly
// requested; the CLI and SDK refuse and accept on the same terms.
import { expect, prompts, startConversation, test, waitForIdle } from '../fixtures'

test('an unknown delivery blocks an implicit resume, and an explicit one never resends the prompt', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await profile.releaseMock('codex', 'hang-turn-reply')
  void profile
    .call('agent.send', { conversation_id: conversationId, request_id: 'unknown-prompt', text: prompts.turn })
    .catch(() => undefined)
  let pid = 0
  await expect
    .poll(async () => {
      const call = (await profile.mockCalls('codex')).find((entry) => entry.method === 'turn/start')
      pid = Number(call?.pid ?? 0)
      return pid
    })
    .toBeGreaterThan(0)
  process.kill(pid, 'SIGKILL')

  const read = async () => profile.call('conversation.get', { conversation_id: conversationId })
  await expect
    .poll(
      async () =>
        (await read()).messages.find((m) => m.delivery?.request_id === 'unknown-prompt')?.delivery?.native_outcome,
    )
    .toBe('unknown')

  // The SDK and the CLI refuse an implicit resume and name the prompt.
  await expect(profile.call('agent.resume', { conversation_id: conversationId })).rejects.toThrow(
    /outcome of prompt unknown-prompt is unknown.*continue_interrupted/,
  )
  const refused = await profile.cli('conversation', 'resume', conversationId)
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toMatch(/outcome of prompt unknown-prompt is unknown/)

  // An explicit resume reopens the session and the prompt is not sent again.
  const accepted = await profile.cli('conversation', 'resume', conversationId, '--continue-interrupted')
  expect(accepted.code, accepted.stderr).toBe(0)
  await waitForIdle(profile, conversationId)
  const starts = (await profile.mockCalls('codex')).filter((entry) => entry.method === 'turn/start')
  expect(starts).toHaveLength(1)
})
