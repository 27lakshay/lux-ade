// F039 conversation rewind, and F043's removal of rewound records from work
// search. Claude's adapter rewinds only through what the Agent SDK documents:
// forkSession() copies the transcript up to the entry before the rewound turn
// into a new session with new message UUIDs, and `resume` continues the fork.
// The earlier session stays unchanged on disk. Dropping only the last turn
// first asks the CLI to check the range (resumeDropsTurn on a forking resume).
// ADE then removes its own messages from that turn on, moves the Conversation
// to the fork and its history epoch in one transaction, and the search index
// drops the removed text. The provider mock (providers/claude/fake-sdk.mjs)
// never truncates a transcript on its own, so nothing here relies on
// undocumented SDK behaviour. Codex conversation rewind is unavailable
// (context/rewind.spec.ts); file rewind goes through ADE checkpoints.
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { mockDirectory } from '../fixtures/providers'

type Message = { id: string; role: string; text: string; turn_id: string | null; sequence: number }

async function messages(profile: ScratchProfile, conversationId: string): Promise<Message[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId, limit: 200 })).messages
}

async function texts(profile: ScratchProfile, conversationId: string): Promise<string[]> {
  return (await messages(profile, conversationId)).map((message) => message.text)
}

async function thread(profile: ScratchProfile, conversationId: string): Promise<string | null> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.provider_thread_id
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

async function hits(profile: ScratchProfile, query: string): Promise<number> {
  return ((await profile.call('history.search' as never, { query } as never)) as { results: unknown[] }).results.length
}

async function forks(profile: ScratchProfile) {
  return (await profile.mockCalls('claude')).filter((entry) => entry.method === 'forkSession')
}

/** The forking resumes that only check a single-turn range. */
async function checks(profile: ScratchProfile) {
  return (await profile.mockCalls('claude')).filter((entry) => entry.method === 'query' && entry.resumeSessionAt)
}

/** The prompts a native Claude session file holds, as the mock stored it. */
async function nativePrompts(profile: ScratchProfile, session: string): Promise<string[]> {
  const lines = (await readFile(join(mockDirectory(profile.root, 'claude'), `${session}.jsonl`), 'utf8')).split('\n')
  const entries = lines
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; message?: { content?: unknown } })
  return entries
    .filter((entry) => entry.type === 'user' && typeof entry.message?.content === 'string')
    .map((entry) => entry.message!.content as string)
}

/** A Claude Conversation whose turns' prompts carry unique words. */
async function turns(profile: ScratchProfile, prompts: string[]) {
  const { conversationId } = await startConversation(profile, 'claude')
  for (const prompt of prompts) await turn(profile, conversationId, prompt)
  const all = await messages(profile, conversationId)
  expect(all.map((message) => message.text)).toEqual(prompts.flatMap((prompt) => [prompt, 'Hello Claude']))
  return { conversationId, all }
}

async function preview(profile: ScratchProfile, conversationId: string, before: Message) {
  return profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: before.id,
  })
}

test('F039, F043: a Claude rewind forks the session before the turn, removes later turns from ADE, refuses older pages and drops search hits', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, ['first zebracorn', 'second quokkaflux', 'third lemurmint'])
  const second = all[2]
  const original = (await thread(profile, conversationId))!
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)
  await expect.poll(() => hits(profile, 'lemurmint')).toBe(1)

  // A reader holds the newest page and pages back from it.
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 2 })
  expect(page.history_epoch).toBe(0)
  const cursor = {
    conversation_id: conversationId,
    before: (page.messages[0] as Message).sequence,
    limit: 2,
    history_epoch: page.history_epoch,
  }
  expect((await profile.call('conversation.get', cursor)).messages).toHaveLength(2)

  // The preview names what goes: the second and third turns, four messages.
  const controls = (await profile.call('conversation.controls', { conversation_id: conversationId })).controls
  expect(controls.find((entry) => entry.control === 'rewind_conversation')).toMatchObject({
    available: true,
    mechanism: 'claude.fork_session',
    reason: null,
  })
  const shown = await preview(profile, conversationId, second)
  expect(shown.history).toMatchObject({
    before_message_id: second.id,
    turn_id: second.turn_id,
    removed_messages: 4,
    removed_turns: 2,
    kept_messages: 2,
    history_epoch: 0,
  })
  expect(shown.history!.native_session).toBeUndefined()

  // A wrong state token is refused before anything reaches Claude, and leaves no receipt.
  const rewind = {
    operation_id: 'rewind-history',
    conversation_id: conversationId,
    scope: 'conversation' as const,
    before_message_id: second.id,
    expected_state: shown.history!.state_token,
  }
  await expect(profile.call('conversation.rewind', { ...rewind, expected_state: 'stale' })).rejects.toThrow(
    /changed since the preview/,
  )
  expect(await forks(profile)).toEqual([])

  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({
    outcome: 'acknowledged',
    control: 'rewind_conversation',
    reason: null,
    history: {
      removed_messages: 4,
      removed_turns: 2,
      kept_messages: 2,
      history_epoch: 1,
      previous_native_session: original,
    },
  })
  const forked = reply.history!.native_session!
  expect(forked).toBeTruthy()
  expect(forked).not.toBe(original)
  // Claude forked at the first turn's last entry. Two turns went, so no single-turn check ran.
  const [fork] = await forks(profile)
  expect(fork).toMatchObject({ session: original, forked })
  expect(fork.upToMessageId).not.toBe(second.turn_id)
  expect(await checks(profile)).toEqual([])
  // The Conversation continues in the fork; the earlier native session is unchanged.
  expect(await thread(profile, conversationId)).toBe(forked)
  expect(await nativePrompts(profile, original)).toEqual(['first zebracorn', 'second quokkaflux', 'third lemurmint'])
  expect(await nativePrompts(profile, forked)).toEqual(['first zebracorn'])
  expect(await texts(profile, conversationId)).toEqual(['first zebracorn', 'Hello Claude'])

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
  await expect(profile.call('conversation.rewind', { ...rewind, before_message_id: all[0].id })).rejects.toThrow(
    /already used for a different request/,
  )
  expect(await forks(profile)).toHaveLength(1)

  // The Conversation continues from the rewound point in the fork, and a
  // resume reads the fork back: the kept prompt keeps its ADE identity even
  // though the fork gave it a new UUID, so nothing is duplicated.
  await turn(profile, conversationId, 'fourth ocelotwave')
  expect(await nativePrompts(profile, forked)).toEqual(['first zebracorn', 'fourth ocelotwave'])
  const continued = await messages(profile, conversationId)
  expect(continued.map((message) => message.text)).toEqual([
    'first zebracorn',
    'Hello Claude',
    'fourth ocelotwave',
    'Hello Claude',
  ])
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect(await thread(profile, conversationId)).toBe(forked)
  expect((await messages(profile, conversationId)).map((message) => [message.id, message.text])).toEqual(
    continued.map((message) => [message.id, message.text]),
  )
  await expect.poll(() => hits(profile, 'ocelotwave')).toBe(1)
  expect(await hits(profile, 'quokkaflux')).toBe(0)
})

test('F039: a fork is rewound again at a prompt it copied, by the ID ADE stored, across an Agent resume', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, [
    'one alpacarun',
    'two bisonleap',
    'three civetdash',
    'four dingosky',
  ])
  const original = (await thread(profile, conversationId))!
  const third = all[4]
  const first = await profile.call('conversation.rewind', {
    operation_id: 'rewind-one',
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: third.id,
    expected_state: (await preview(profile, conversationId, third)).history!.state_token,
  })
  const fork = first.history!.native_session!
  await turn(profile, conversationId, 'five egretfall')
  // The Agent restarts, so the bridge reads the fork's UUID record from ADE's data, not from memory.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)

  // `two` was copied into the fork under a new UUID; ADE still names it by the first one.
  const two = (await messages(profile, conversationId))[2]
  expect(two).toMatchObject({ id: all[2].id, text: 'two bisonleap' })
  const again = await profile.call('conversation.rewind', {
    operation_id: 'rewind-two',
    conversation_id: conversationId,
    scope: 'conversation',
    before_message_id: two.id,
    expected_state: (await preview(profile, conversationId, two)).history!.state_token,
  })
  expect(again).toMatchObject({
    outcome: 'acknowledged',
    history: { removed_messages: 4, removed_turns: 2, history_epoch: 2, previous_native_session: fork },
  })
  const second = again.history!.native_session!
  expect([original, fork]).not.toContain(second)
  expect((await forks(profile)).map((entry) => entry.session)).toEqual([original, fork])
  expect(await nativePrompts(profile, second)).toEqual(['one alpacarun'])
  expect(await nativePrompts(profile, fork)).toEqual(['one alpacarun', 'two bisonleap', 'five egretfall'])
  expect(await texts(profile, conversationId)).toEqual(['one alpacarun', 'Hello Claude'])
  await turn(profile, conversationId, 'six ferretgo')
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect((await messages(profile, conversationId)).map((message) => [message.id, message.text])).toEqual([
    [all[0].id, 'one alpacarun'],
    [expect.any(String), 'Hello Claude'],
    [expect.any(String), 'six ferretgo'],
    [expect.any(String), 'Hello Claude'],
  ])
  expect(await messages(profile, conversationId)).toHaveLength(4)
})

test('F039: removing only the last turn asks Claude to check it drops exactly that turn; the CLI drives it', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, ['first zebracorn', 'second quokkaflux', 'third lemurmint'])
  const original = (await thread(profile, conversationId))!
  const third = all[4]
  const shown = await profile.cli('conversation', 'rewind-preview', conversationId, 'conversation', third.id)
  expect(shown.code, shown.stderr).toBe(0)
  const token = (shown.json as { history: { state_token: string; removed_messages: number } }).history
  expect(token.removed_messages).toBe(2)
  const done = await profile.cli(
    'conversation',
    'rewind',
    conversationId,
    'conversation',
    third.id,
    token.state_token,
    '--operation-id',
    'rewind-last',
  )
  expect(done.code, done.stderr).toBe(0)
  expect(done.json).toMatchObject({
    outcome: 'acknowledged',
    history: { removed_messages: 2, history_epoch: 1, previous_native_session: original },
  })
  // The check is a forking resume, so it leaves the session as it was; the fork follows it.
  const [check] = await checks(profile)
  expect(check).toMatchObject({ resume: original, forkSession: true, resumeDropsTurn: third.turn_id, rejected: false })
  const [fork] = await forks(profile)
  expect(fork).toMatchObject({ session: original, upToMessageId: check.resumeSessionAt })
  expect(await thread(profile, conversationId)).toBe(fork.forked)
  expect(await texts(profile, conversationId)).toEqual([
    'first zebracorn',
    'Hello Claude',
    'second quokkaflux',
    'Hello Claude',
  ])
})

test('F039: a rewind is refused while a turn runs, without the Agent, before the first turn, or not at a prompt', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, ['first zebracorn', 'second quokkaflux', 'third lemurmint'])
  const original = await thread(profile, conversationId)
  const base = { conversation_id: conversationId, scope: 'conversation' as const }

  // Not a turn's prompt.
  await expect(profile.call('conversation.rewind.preview', { ...base, before_message_id: all[1].id })).rejects.toThrow(
    /user message that started a turn/,
  )
  await expect(
    profile.call('conversation.rewind.preview', { ...base, before_message_id: 'message_missing' }),
  ).rejects.toThrow(/not in this Conversation/)

  // Claude cannot fork before its first entry: the adapter refuses and nothing is removed.
  const first = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[0].id })
  const refused = await profile.call('conversation.rewind', {
    ...base,
    operation_id: 'rewind-first',
    before_message_id: all[0].id,
    expected_state: first.history!.state_token,
  })
  expect(refused).toMatchObject({ outcome: 'refused' })
  expect(refused.history).toBeUndefined()
  // Provider messages reach clients only as safe categories.
  expect(refused.reason).toMatch(/Provider rejected the operation/)
  expect(await messages(profile, conversationId)).toEqual(all)
  expect(await thread(profile, conversationId)).toBe(original)
  // A settled refusal replays; a new request needs a new operation ID.
  expect(
    await profile.call('conversation.rewind', {
      ...base,
      operation_id: 'rewind-first',
      before_message_id: all[0].id,
      expected_state: first.history!.state_token,
    }),
  ).toEqual(refused)

  // While a turn runs, nothing is rewound and no receipt is kept.
  await send(profile, conversationId, 'hold')
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  const busy = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[2].id })
  expect(busy.history).toBeUndefined()
  expect(busy).toMatchObject({
    availability: { available: false, reason: 'A turn is running; stop it before rewinding the conversation' },
  })
  expect(
    await profile.call('conversation.rewind', {
      ...base,
      operation_id: 'rewind-busy',
      before_message_id: all[2].id,
      expected_state: 'unused',
    }),
  ).toMatchObject({ outcome: 'unavailable' })
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('interrupted')

  // Without a connected Agent, a rewind cannot reach Claude.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  const disconnected = await profile.call('conversation.rewind.preview', { ...base, before_message_id: all[2].id })
  expect(disconnected.availability).toMatchObject({
    available: false,
    reason: expect.stringContaining('not connected'),
  })
  expect(await forks(profile)).toEqual([])
  expect(await checks(profile)).toEqual([])
})

test('R001: a rewind whose reply was lost is read back after a daemon crash and reaches Claude once', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, ['first zebracorn', 'second quokkaflux', 'third lemurmint'])
  const second = all[2]
  const rewind = {
    operation_id: 'rewind-lost',
    conversation_id: conversationId,
    scope: 'conversation' as const,
    before_message_id: second.id,
    expected_state: (await preview(profile, conversationId, second)).history!.state_token,
  }
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect.poll(async () => (await forks(profile)).length).toBe(1)
  await profile.restartDaemon('kill')
  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({ outcome: 'acknowledged', history: { removed_messages: 4, history_epoch: 1 } })
  expect(await forks(profile)).toHaveLength(1)
  expect(await thread(profile, conversationId)).toBe(reply.history!.native_session)
  expect(await texts(profile, conversationId)).toEqual(['first zebracorn', 'Hello Claude'])
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
})

test('R001: a daemon crash while Claude forks leaves the Agent on the earlier session until the retry settles the move', async ({
  profile,
}) => {
  const { conversationId, all } = await turns(profile, ['hold-fork', 'second quokkaflux', 'third lemurmint'])
  const original = (await thread(profile, conversationId))!
  const second = all[2]
  const rewind = {
    operation_id: 'rewind-crash',
    conversation_id: conversationId,
    scope: 'conversation' as const,
    before_message_id: second.id,
    expected_state: (await preview(profile, conversationId, second)).history!.state_token,
  }
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect
    .poll(async () => (await profile.mockCalls('claude')).some((entry) => entry.method === 'forkSession.held'))
    .toBe(true)
  // The daemon dies while the runtime's Agent is still forking; the fork then completes.
  await profile.restartDaemon('kill')
  await profile.releaseMock('claude', 'release-fork')
  await expect.poll(async () => (await forks(profile)).length).toBe(1)
  // Another crash: this daemon reattaches to a runtime whose Agent now reports
  // the fork, and the session the fork left, which the Conversation still holds.
  await profile.restartDaemon('kill')

  // The new daemon reattached the Agent without taking the fork as its session.
  expect(await thread(profile, conversationId)).toBe(original)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.error).toBeNull()
  expect(await messages(profile, conversationId)).toEqual(all)
  // The retry asks the same run, which answers from its receipt, and the move commits once.
  const reply = await profile.call('conversation.rewind', rewind)
  const [fork] = await forks(profile)
  expect(reply).toMatchObject({
    outcome: 'acknowledged',
    history: { removed_messages: 4, history_epoch: 1, native_session: fork.forked, previous_native_session: original },
  })
  expect(await thread(profile, conversationId)).toBe(fork.forked)
  expect(await texts(profile, conversationId)).toEqual(['hold-fork', 'Hello Claude'])
  await turn(profile, conversationId, 'fourth ocelotwave')
  expect(await nativePrompts(profile, fork.forked as string)).toEqual(['hold-fork', 'fourth ocelotwave'])
  expect(await forks(profile)).toHaveLength(1)
})

test('F039: a file rewind that stops part way is reported as partial, with what failed and the safety checkpoint', async ({
  profile,
  repo,
}) => {
  await repo.commit('Add two files', { 'a/first.txt': 'one\n', 'b/second.txt': 'one\n' })
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  const { checkpoint } = await profile.call('checkpoint.create', {
    operation_id: 'cp-partial',
    workspace_id: workspaceId,
    label: 'before the agent',
  })
  await repo.write('a/first.txt', 'two\n')
  await repo.write('b/second.txt', 'two\n')
  const shown = await profile.call('conversation.rewind.preview', {
    conversation_id: conversationId,
    scope: 'files',
    checkpoint_id: checkpoint.checkpoint_id,
  })
  // Git restores a/ first, then cannot replace the file in the read-only b/.
  const locked = join(repo.path, 'b')
  await chmod(locked, 0o555)
  try {
    const rewind = {
      operation_id: 'rewind-partial',
      conversation_id: conversationId,
      scope: 'files' as const,
      checkpoint_id: checkpoint.checkpoint_id,
      expected_state: shown.files!.state_token,
      confirm_overwrite: true,
    }
    const reply = await profile.call('conversation.rewind', rewind)
    expect(reply).toMatchObject({
      outcome: 'partial',
      control: 'rewind_files',
      files: { outcome: 'partial', verified: false, safety_checkpoint: { kind: 'safety' } },
    })
    expect(reply.files!.problems.join('\n')).toMatch(/failed part way/)
    expect(reply.reason).toBe(reply.files!.problems.join('; '))
    expect(await repo.read('a/first.txt')).toBe('one\n')
    expect(await repo.read('b/second.txt')).toBe('two\n')
    // The partial outcome is the recorded one: a replay returns it and writes nothing more.
    expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
    // The safety checkpoint holds the state before the restore.
    const safetyId = reply.files!.safety_checkpoint!.checkpoint_id
    expect(
      (await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints.map(
        (entry) => entry.checkpoint_id,
      ),
    ).toContain(safetyId)
  } finally {
    await chmod(locked, 0o755)
  }
})

test('F039: a rewind Claude refuses at its fork-time check keeps the session and history, and the Conversation continues', async ({
  profile,
}) => {
  // The third turn absorbs a task notification after its answer, so the
  // discarded range is not all from that turn and the CLI refuses the check.
  const { conversationId, all } = await turns(profile, [
    'first zebracorn',
    'second quokkaflux',
    'absorbed-notification',
  ])
  const original = await thread(profile, conversationId)
  const third = all[4]
  const rewind = {
    operation_id: 'rewind-refused',
    conversation_id: conversationId,
    scope: 'conversation' as const,
    before_message_id: third.id,
    expected_state: (await preview(profile, conversationId, third)).history!.state_token,
  }
  const refused = await profile.call('conversation.rewind', rewind)
  expect(refused).toMatchObject({ outcome: 'refused', control: 'rewind_conversation' })
  expect(refused.reason).toMatch(/Provider rejected the operation/)
  expect(refused.history).toBeUndefined()
  const [check] = await checks(profile)
  expect(check).toMatchObject({ forkSession: true, resumeDropsTurn: third.turn_id, rejected: true })
  expect(await forks(profile)).toEqual([])

  // ADE removed nothing, stayed on its session and did not move the epoch; the refusal replays.
  expect(await messages(profile, conversationId)).toEqual(all)
  expect(await thread(profile, conversationId)).toBe(original)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).history_epoch).toBe(0)
  expect(await profile.call('conversation.rewind', rewind)).toEqual(refused)
  expect(await checks(profile)).toHaveLength(1)
  // The history indexer runs on its own schedule, so wait for it to catch up.
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)

  // The live query was never replaced: the next turn runs, and a resume reads Claude's kept history back.
  await turn(profile, conversationId, 'fourth ocelotwave')
  const kept = [
    'first zebracorn',
    'Hello Claude',
    'second quokkaflux',
    'Hello Claude',
    'absorbed-notification',
    'Hello Claude',
    'fourth ocelotwave',
    'Hello Claude',
  ]
  expect(await texts(profile, conversationId)).toEqual(kept)
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect(await texts(profile, conversationId)).toEqual(kept)
})
