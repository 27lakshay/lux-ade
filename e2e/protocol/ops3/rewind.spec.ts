// F039 conversation rewind, and F043's removal of deleted records from work
// search. Claude's adapter rewinds natively: the bridge restarts the Agent
// SDK query with `resumeSessionAt` at the last chain entry before the turn
// being removed. ADE then removes its own messages from that turn on, moves
// the Conversation's history epoch so older pages are refused, and the search
// index drops the removed text. The preview says exactly what goes.
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

type Message = { id: string; role: string; text: string; turn_id: string | null; sequence: number }

async function messages(profile: ScratchProfile, conversationId: string): Promise<Message[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId, limit: 200 })).messages as Message[]
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

async function hits(profile: ScratchProfile, query: string): Promise<number> {
  return ((await profile.call('history.search' as never, { query } as never)) as { results: unknown[] }).results.length
}

async function rewindQueries(profile: ScratchProfile) {
  return (await profile.mockCalls('claude')).filter((entry) => entry.method === 'query' && entry.resumeSessionAt)
}

/** A Claude Conversation with three turns whose prompts carry unique words. */
async function threeTurns(profile: ScratchProfile) {
  const { conversationId } = await startConversation(profile, 'claude')
  await turn(profile, conversationId, 'first zebracorn')
  await turn(profile, conversationId, 'second quokkaflux')
  await turn(profile, conversationId, 'third lemurmint')
  const all = await messages(profile, conversationId)
  expect(all.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  return { conversationId, all }
}

test('F039, F043: a Claude rewind removes later turns natively and from ADE, refuses older pages and drops search hits', async ({ profile }) => {
  const { conversationId, all } = await threeTurns(profile)
  const second = all[2]!
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)
  await expect.poll(() => hits(profile, 'lemurmint')).toBe(1)

  // A reader holds the newest page and pages back from it.
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 2 })
  expect(page.history_epoch).toBe(0)
  const cursor = { conversation_id: conversationId, before: (page.messages[0] as Message).sequence, limit: 2,
    history_epoch: page.history_epoch }
  expect((await profile.call('conversation.get', cursor)).messages).toHaveLength(2)

  // The preview names what goes: the second and third turns, four messages.
  const controls = (await profile.call('conversation.controls', { conversation_id: conversationId })).controls
  expect(controls.find((entry) => entry.control === 'rewind_conversation'))
    .toMatchObject({ available: true, mechanism: 'claude.resume_session_at', reason: null })
  const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId,
    scope: 'conversation', before_message_id: second.id })
  expect(preview.history).toMatchObject({ before_message_id: second.id, turn_id: second.turn_id, removed_messages: 4,
    removed_turns: 2, kept_messages: 2, history_epoch: 0 })

  // A wrong state token is refused before anything reaches Claude, and leaves no receipt.
  const rewind = { operation_id: 'rewind-history', conversation_id: conversationId, scope: 'conversation' as const,
    before_message_id: second.id, expected_state: preview.history!.state_token }
  await expect(profile.call('conversation.rewind', { ...rewind, expected_state: 'stale' }))
    .rejects.toThrow(/changed since the preview/)
  expect(await rewindQueries(profile)).toEqual([])

  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({ outcome: 'acknowledged', control: 'rewind_conversation', reason: null,
    history: { removed_messages: 4, removed_turns: 2, kept_messages: 2, history_epoch: 1 } })
  // Claude resumed at the first turn's last entry; two turns went, so no single-turn check applies.
  const [native] = await rewindQueries(profile)
  expect(native).toMatchObject({ resume: expect.any(String), resumeDropsTurn: null, rejected: false })
  expect(native!.resumeSessionAt).not.toBe(second.turn_id)
  expect((await messages(profile, conversationId)).map((message) => message.text))
    .toEqual(['first zebracorn', 'Hello Claude'])

  // The page cursor the reader held belongs to the replaced history.
  await expect(profile.call('conversation.get', cursor)).rejects.toThrow(/History changed since that page was read/)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).history_epoch).toBe(1)

  // F043: removed text leaves search; kept text stays.
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(0)
  await expect.poll(() => hits(profile, 'lemurmint')).toBe(0)
  expect(await hits(profile, 'zebracorn')).toBe(1)

  // R002: the same operation replays, also after a daemon crash; another payload conflicts.
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
  await expect(profile.call('conversation.rewind', { ...rewind, before_message_id: all[0]!.id }))
    .rejects.toThrow(/already used for a different request/)
  expect(await rewindQueries(profile)).toHaveLength(1)

  // The Conversation continues from the rewound point, and a resume reads the
  // provider's truncated history back without the removed turns.
  await turn(profile, conversationId, 'fourth ocelotwave')
  expect((await messages(profile, conversationId)).map((message) => message.text))
    .toEqual(['first zebracorn', 'Hello Claude', 'fourth ocelotwave', 'Hello Claude'])
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect((await messages(profile, conversationId)).map((message) => message.text))
    .toEqual(['first zebracorn', 'Hello Claude', 'fourth ocelotwave', 'Hello Claude'])
  await expect.poll(() => hits(profile, 'ocelotwave')).toBe(1)
  expect(await hits(profile, 'quokkaflux')).toBe(0)
})

test('F039: removing only the last turn asks Claude to check it drops exactly that turn; the CLI drives it', async ({ profile }) => {
  const { conversationId, all } = await threeTurns(profile)
  const third = all[4]!
  const preview = await profile.cli('conversation', 'rewind-preview', conversationId, 'conversation', third.id)
  expect(preview.code, preview.stderr).toBe(0)
  const token = (preview.json as { history: { state_token: string; removed_messages: number } }).history
  expect(token.removed_messages).toBe(2)
  const done = await profile.cli('conversation', 'rewind', conversationId, 'conversation', third.id, token.state_token,
    '--request-id', 'rewind-last')
  expect(done.code, done.stderr).toBe(0)
  expect(done.json).toMatchObject({ outcome: 'acknowledged', history: { removed_messages: 2, history_epoch: 1 } })
  const [native] = await rewindQueries(profile)
  expect(native).toMatchObject({ resumeDropsTurn: third.turn_id, rejected: false })
  expect((await messages(profile, conversationId)).map((message) => message.text))
    .toEqual(['first zebracorn', 'Hello Claude', 'second quokkaflux', 'Hello Claude'])
})

test('F039: a rewind is refused while a turn runs, without the Agent, before the first turn, or not at a prompt', async ({ profile }) => {
  const { conversationId, all } = await threeTurns(profile)
  const base = { conversation_id: conversationId, scope: 'conversation' as const }

  // Not a turn's prompt.
  await expect(profile.call('conversation.rewind.preview', { ...base, before_message_id: all[1]!.id }))
    .rejects.toThrow(/user message that started a turn/)
  await expect(profile.call('conversation.rewind.preview', { ...base, before_message_id: 'message_missing' }))
    .rejects.toThrow(/not in this Conversation/)

  // Claude cannot resume before its first entry: the provider refuses and nothing is removed.
  const first = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[0]!.id })
  const refused = await profile.call('conversation.rewind', { ...base, operation_id: 'rewind-first',
    before_message_id: all[0]!.id, expected_state: first.history!.state_token })
  expect(refused).toMatchObject({ outcome: 'refused' })
  expect(refused.history).toBeUndefined()
  expect(refused.reason).toBeTruthy()
  expect(await messages(profile, conversationId)).toEqual(all)
  // A settled refusal replays; a new request needs a new operation ID.
  expect(await profile.call('conversation.rewind', { ...base, operation_id: 'rewind-first',
    before_message_id: all[0]!.id, expected_state: first.history!.state_token })).toEqual(refused)

  // While a turn runs, nothing is rewound and no receipt is kept.
  await send(profile, conversationId, 'hold')
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId }))
    .conversation.status).toBe('running')
  const busy = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[2]!.id })
  expect(busy.history).toBeUndefined()
  expect(busy).toMatchObject({ availability: { available: false,
    reason: 'A turn is running; stop it before rewinding the conversation' } })
  expect(await profile.call('conversation.rewind', { ...base, operation_id: 'rewind-busy', before_message_id: all[2]!.id,
    expected_state: 'unused' })).toMatchObject({ outcome: 'unavailable' })
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId }))
    .conversation.status).toBe('interrupted')

  // Without a connected Agent, a rewind cannot reach Claude.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  const disconnected = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[2]!.id })
  expect(disconnected.availability).toMatchObject({ available: false, reason: expect.stringContaining('not connected') })
  expect(await rewindQueries(profile)).toEqual([])
})

test('R001: a rewind whose reply was lost is read back after a daemon crash and reaches Claude once', async ({ profile }) => {
  const { conversationId, all } = await threeTurns(profile)
  const second = all[2]!
  const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId,
    scope: 'conversation', before_message_id: second.id })
  const rewind = { operation_id: 'rewind-lost', conversation_id: conversationId, scope: 'conversation' as const,
    before_message_id: second.id, expected_state: preview.history!.state_token }
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect.poll(async () => (await rewindQueries(profile)).length).toBe(1)
  await profile.restartDaemon('kill')
  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({ outcome: 'acknowledged', history: { removed_messages: 4, history_epoch: 1 } })
  expect(await rewindQueries(profile)).toHaveLength(1)
  expect((await messages(profile, conversationId)).map((message) => message.text))
    .toEqual(['first zebracorn', 'Hello Claude'])
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
})
