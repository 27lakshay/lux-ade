// R001: a turn lost to a runtime crash has an unknown outcome. Whichever
// process notices first, the daemon that outlived its runtime or the next
// daemon start, the Conversation records exactly one operation_unknown
// activity for that turn, never turn_interrupted or turn_failed, and the
// prompt is never replayed.
import { expect, isRunning, prompts, send, startConversation, test, turnReply, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { waitForAttemptRecord } from '../fixtures/recovery'

async function turnActivity(profile: ScratchProfile, conversationId: string) {
  const { activities } = await profile.call('activity.list', { limit: 200, include_dismissed: true })
  return activities.filter((activity) => activity.target.conversation_id === conversationId
    && ['turn_completed', 'turn_failed', 'turn_interrupted', 'operation_unknown'].includes(activity.kind))
}

for (const ordering of ['daemon-survives', 'daemon-first'] as const) {
  test(`R001: a turn lost to a runtime crash (${ordering}) is recorded once as operation_unknown`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, 'codex')
    await send(profile, conversationId, prompts.hold, 'lost-turn')
    let turn: string | null = null
    await expect.poll(async () => {
      const current = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
      turn = current.status === 'running' ? current.active_turn_id ?? null : null
      return turn
    }).not.toBeNull()
    // Wait for the process record so both orderings reach the same evidence.
    const record = await waitForAttemptRecord(profile, `agent:${conversationId}`)

    if (ordering === 'daemon-first') await profile.killDaemon()
    await profile.killRuntime()
    await expect.poll(() => isRunning(record.pid)).toBe(false)
    if (ordering === 'daemon-survives') {
      await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId }))
        .conversation.status, { timeout: 20_000 }).toBe('interrupted')
      // The surviving daemon already records the unknown outcome.
      await expect.poll(async () => (await turnActivity(profile, conversationId)).map((activity) => activity.kind))
        .toEqual(['operation_unknown'])
    }
    await profile.restartDaemon()

    const recorded = await turnActivity(profile, conversationId)
    expect(recorded.map((activity) => [activity.kind, activity.target.turn_id])).toEqual([['operation_unknown', turn]])
    const recovery = await profile.call('runtime.recovery', {})
    const attempt = recovery.reports.flatMap((report) => report.attempts)
      .find((candidate) => candidate.key === `agent:${conversationId}`)
    expect(attempt).toMatchObject({ classification: 'settled', outcome_unknown: true })

    // Continuing records the next turn normally and never replays the lost prompt.
    await profile.call('agent.resume', { conversation_id: conversationId })
    await waitForIdle(profile, conversationId)
    await send(profile, conversationId, prompts.turn, 'after-lost-turn')
    await waitForMessage(profile, conversationId, turnReply.codex)
    await waitForIdle(profile, conversationId)
    const kinds = (await turnActivity(profile, conversationId)).map((activity) => activity.kind).sort()
    expect(kinds).toEqual(['operation_unknown', 'turn_completed'])
    const starts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
      .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
    expect(starts).toEqual(['lost-turn', 'after-lost-turn'])
  })
}

test('R001: a turn the user cancels is still recorded as interrupted, not unknown', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold, 'cancelled-turn')
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId }))
    .conversation.status).toBe('running')
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId }))
    .conversation.status).toBe('interrupted')
  // A cancelled turn does not notify (activity rule): no unknown outcome either.
  expect((await turnActivity(profile, conversationId)).map((activity) => activity.kind)).toEqual([])
})
