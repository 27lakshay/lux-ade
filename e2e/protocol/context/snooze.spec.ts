// F046: snoozing. A snooze defers attention to a Conversation until a chosen
// time. It is durable: a wake that falls due while ADE is down is recorded on
// the next start, once, as a `snooze_ended` activity. A snooze never stops,
// starts or queues agent work.
import { conversationStatus, expect, prompts, send, startConversation, test, type ScratchProfile } from '../fixtures'
import { snapshot } from './helpers'

async function wakes(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('activity.list', { limit: 200 })).activities
    .filter((activity) => activity.kind === 'snooze_ended' && activity.target.conversation_id === conversationId)
}

async function activeSnooze(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.controls', { conversation_id: conversationId })).snooze
}

test('F046: a snooze that falls due while ADE is down wakes once on restart, and the running turn keeps running', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  const callsBefore = (await profile.mockCalls('codex')).length

  const until = Date.now() + 1_500
  const snoozed = await profile.call('conversation.snooze', { conversation_id: conversationId, until })
  expect(snoozed.snooze).toMatchObject({ conversation_id: conversationId, until })
  // The same wake time converges on the stored snooze.
  expect((await profile.call('conversation.snooze', { conversation_id: conversationId, until })).snooze).toEqual(snoozed.snooze)
  expect(await activeSnooze(profile, conversationId)).toEqual(snoozed.snooze)
  expect((await profile.call('conversation.snooze.list', {})).snoozes).toEqual([snoozed.snooze])

  // ADE goes down before the wake time and comes back after it.
  await profile.killDaemon()
  await expect.poll(() => Date.now(), { timeout: 5_000 }).toBeGreaterThan(until)
  await profile.restartDaemon('kill')
  await expect.poll(async () => (await wakes(profile, conversationId)).length).toBe(1)
  const [wake] = await wakes(profile, conversationId)
  expect(wake).toMatchObject({ state: 'unread', target: { conversation_id: conversationId } })
  expect(await activeSnooze(profile, conversationId)).toBeNull()
  expect((await profile.call('conversation.snooze.list', {})).snoozes).toEqual([])

  // Attention came back; the work was never touched: the turn still runs, nothing was queued or sent.
  const state = await snapshot(profile, conversationId)
  expect(state.conversation.status).toBe('running')
  expect(state.queued).toEqual([])
  expect((await profile.mockCalls('codex')).length).toBe(callsBefore)
  // Another restart records no second wake.
  await profile.restartDaemon()
  expect(await wakes(profile, conversationId)).toHaveLength(1)
})

test('F046: a snooze wakes while ADE runs, a new time replaces it, and unsnooze records no wake', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const other = (await startConversation(profile, 'claude')).conversationId

  // Replaced before it fell due: only the replacement wakes.
  const far = Date.now() + 3_600_000
  const first = await profile.call('conversation.snooze', { conversation_id: conversationId, until: far })
  const soon = Date.now() + 1_000
  const replaced = await profile.call('conversation.snooze', { conversation_id: conversationId, until: soon })
  expect(replaced.snooze).toMatchObject({ until: soon })
  expect(replaced.snooze!.snoozed_at).toBeGreaterThanOrEqual(first.snooze!.snoozed_at)
  // The CLI snoozes the other Conversation; unsnooze ends it without a wake.
  const cli = await profile.cli('conversation', 'snooze', other, '+2h')
  expect(cli.code, cli.stderr).toBe(0)
  const listed = (await profile.call('conversation.snooze.list', {})).snoozes
  expect(listed.map((snooze) => snooze.conversation_id)).toEqual([conversationId, other])
  expect((await profile.call('conversation.unsnooze', { conversation_id: other })).snooze).toBeNull()
  expect((await profile.call('conversation.unsnooze', { conversation_id: other })).snooze).toBeNull()

  await expect.poll(async () => (await wakes(profile, conversationId)).length, { timeout: 10_000 }).toBe(1)
  expect(await wakes(profile, other)).toEqual([])
  expect((await profile.call('conversation.snooze.list', {})).snoozes).toEqual([])
  // The Conversations stayed idle: a snooze schedules no agent work.
  for (const conversation of [conversationId, other]) {
    const state = await snapshot(profile, conversation)
    expect(state.messages).toEqual([])
    expect(state.queued).toEqual([])
  }
  expect(await profile.mockCalls('codex')).toEqual(expect.not.arrayContaining([
    expect.objectContaining({ method: 'turn/start' })]))
})

test('F046: a wake time in the past or more than 366 days ahead is refused', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await expect(profile.call('conversation.snooze', { conversation_id: conversationId, until: Date.now() - 1_000 }))
    .rejects.toThrow('Snooze time must be in the future')
  await expect(profile.call('conversation.snooze', { conversation_id: conversationId,
    until: Date.now() + 367 * 24 * 60 * 60 * 1000 })).rejects.toThrow('at most 366 days ahead')
  await expect(profile.call('conversation.snooze', { conversation_id: 'conversation_missing', until: Date.now() + 60_000 }))
    .rejects.toThrow()
  const cli = await profile.cli('conversation', 'snooze', conversationId, 'tomorrow')
  expect(cli.code).not.toBe(0)
  expect(await activeSnooze(profile, conversationId)).toBeNull()
})
