// F035 and F040 with R002: steering and compaction are effect commands keyed
// by operation ID. Codex's mock performs both natively; Claude's adapter has
// neither and must say so without queueing a message or recording a receipt.
import { conversationStatus, expect, prompts, send, startConversation, test, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

async function nativeCalls(profile: ScratchProfile, method: string) {
  return (await profile.mockCalls('codex')).filter((call) => call.method === method)
}

async function heldTurn(profile: ScratchProfile, conversationId: string): Promise<string> {
  await send(profile, conversationId, prompts.hold)
  let turn: string | null = null
  await expect.poll(async () => {
    const current = (await snapshot(profile, conversationId)).conversation
    turn = current.status === 'running' ? current.active_turn_id ?? null : null
    return turn
  }).not.toBeNull()
  return turn!
}

test('F035: steering a running Codex turn is acknowledged natively and a retry reads the stored reply', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const controls = await profile.call('conversation.controls', { conversation_id: conversationId })
  expect(controls.controls.find((control) => control.control === 'steer'))
    .toMatchObject({ available: false, mechanism: 'turn/steer', reason: expect.stringContaining('No turn is running') })

  const turn = await heldTurn(profile, conversationId)
  expect((await profile.call('conversation.controls', { conversation_id: conversationId })).controls
    .find((control) => control.control === 'steer')).toMatchObject({ available: true })
  const steer = { operation_id: 'steer-1', conversation_id: conversationId, turn_id: turn, text: 'also check the tests' }
  const reply = await profile.call('conversation.steer', steer)
  expect(reply).toMatchObject({ outcome: 'acknowledged', turn_id: turn, control: 'steer' })
  // The steered input reaches the transcript under the operation ID, and nothing was queued.
  await waitForMessage(profile, conversationId, 'also check the tests')
  const state = await snapshot(profile, conversationId)
  expect(state.queued).toEqual([])
  expect(state.messages.find((message) => message.text === 'also check the tests')).toMatchObject({ role: 'user' })

  // R002: the same operation converges on the stored reply without a second native call, even after a restart.
  expect(await profile.call('conversation.steer', steer)).toEqual(reply)
  await profile.restartDaemon()
  expect(await profile.call('conversation.steer', steer)).toEqual(reply)
  await expect(profile.call('conversation.steer', { ...steer, text: 'something else' }))
    .rejects.toThrow('already used for a different request')
  expect(await nativeCalls(profile, 'turn/steer')).toHaveLength(1)
})

test('F035: steering an idle Codex turn or a stale turn is refused without a receipt or a queued message', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const idle = { operation_id: 'steer-idle', conversation_id: conversationId, turn_id: 'turn-none', text: 'redirect' }
  const refused = await profile.call('conversation.steer', idle)
  expect(refused).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('send a message instead') })
  expect((await snapshot(profile, conversationId)).queued).toEqual([])

  const turn = await heldTurn(profile, conversationId)
  await expect(profile.call('conversation.steer', { ...idle, operation_id: 'steer-stale', turn_id: 'turn-stale' }))
    .rejects.toThrow('is no longer the running turn')
  // Neither refusal kept a receipt: the same operation IDs run once the turn is live.
  expect(await profile.call('conversation.steer', { ...idle, turn_id: turn })).toMatchObject({ outcome: 'acknowledged' })
  expect(await profile.call('conversation.steer', { ...idle, operation_id: 'steer-stale', turn_id: turn }))
    .toMatchObject({ outcome: 'acknowledged' })
  expect(await nativeCalls(profile, 'turn/steer')).toHaveLength(2)
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
})

test('F035: a steer the provider refuses settles as refused and a retry reads the refusal', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await heldTurn(profile, conversationId)
  await profile.releaseMock('codex', 'refuse-steer')
  const steer = { operation_id: 'steer-refused', conversation_id: conversationId, turn_id: turn, text: 'redirect' }
  const reply = await profile.call('conversation.steer', steer)
  expect(reply).toMatchObject({ outcome: 'refused', reason: expect.any(String) })
  // The refusal does not end the running turn.
  expect(await conversationStatus(profile, conversationId)).toBe('running')
  expect(await profile.call('conversation.steer', steer)).toEqual(reply)
  expect(await nativeCalls(profile, 'turn/steer')).toHaveLength(1)
})

test('F040: Codex compaction is acknowledged and its native record appears in the transcript', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const turn = await heldTurn(profile, conversationId)
  expect(turn).toBeTruthy()
  const busy = await profile.call('conversation.compact', { operation_id: 'compact-busy', conversation_id: conversationId })
  expect(busy).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('A turn is running') })
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')

  const compact = { operation_id: 'compact-1', conversation_id: conversationId }
  const reply = await profile.call('conversation.compact', compact)
  expect(reply).toMatchObject({ outcome: 'acknowledged', control: 'compact' })
  await waitForMessage(profile, conversationId, 'Codex compacted the conversation context.')
  expect((await snapshot(profile, conversationId)).messages.find((message) => message.kind === 'contextCompaction'))
    .toMatchObject({ role: 'tool', status: 'completed' })
  expect(await profile.call('conversation.compact', compact)).toEqual(reply)
  expect(await nativeCalls(profile, 'thread/compact/start')).toHaveLength(1)
})

test('F040: a compaction the provider refuses reports the failure and claims no new context', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  await profile.releaseMock('codex', 'refuse-compact')
  const reply = await profile.call('conversation.compact', { operation_id: 'compact-refused', conversation_id: conversationId })
  expect(reply).toMatchObject({ outcome: 'refused', reason: expect.any(String) })
  const state = await snapshot(profile, conversationId)
  expect(state.messages.some((message) => message.kind === 'contextCompaction')).toBe(false)
  expect(state.conversation.status).toMatch(/^(idle|ready)$/)
})

test('F035 and F040: Claude reports steering and compaction as unavailable with its limitation', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await send(profile, conversationId, prompts.hold)
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  const controls = await profile.call('conversation.controls', { conversation_id: conversationId })
  expect(controls.provider).toBe('claude')
  for (const name of ['steer', 'compact'] as const) {
    expect(controls.controls.find((control) => control.control === name))
      .toMatchObject({ available: false, mechanism: null, reason: expect.stringContaining('Claude adapter') })
  }
  const turn = (await snapshot(profile, conversationId)).conversation.active_turn_id ?? 'unknown-turn'
  const steer = { operation_id: 'claude-steer', conversation_id: conversationId, turn_id: turn, text: 'redirect' }
  expect(await profile.call('conversation.steer', steer))
    .toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no native steer path') })
  // The steer text is not relabelled as a queued or sent message.
  const state = await snapshot(profile, conversationId)
  expect(state.queued).toEqual([])
  expect(state.messages.some((message) => message.text === 'redirect')).toBe(false)
  expect(await profile.call('conversation.compact', { operation_id: 'claude-compact', conversation_id: conversationId }))
    .toMatchObject({ outcome: 'unavailable' })
  const calls = await profile.mockCalls('claude')
  expect(calls.map((call) => call.text)).toEqual([prompts.hold])
})

test('R001: a steer whose reply was lost is read back after a daemon crash without a second native call', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await heldTurn(profile, conversationId)
  const steer = { operation_id: 'steer-lost', conversation_id: conversationId, turn_id: turn, text: 'lost reply steer' }
  await sendAndLoseReply(profile, { op: 'conversation.steer', ...steer })
  await expect.poll(async () => (await nativeCalls(profile, 'turn/steer')).length).toBe(1)
  await waitForMessage(profile, conversationId, 'lost reply steer')
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.steer', steer)).toMatchObject({ outcome: 'acknowledged', turn_id: turn })
  expect(await nativeCalls(profile, 'turn/steer')).toHaveLength(1)
})
