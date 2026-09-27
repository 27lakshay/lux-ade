// F031, F034, R001 and R002 through the SDK, the CLI and the raw protocol:
// sends stream into a structured transcript, a request ID admits one turn,
// and the prompt queue survives a daemon restart without duplicate dispatch.
import { codexPrompts, conversationStatus, expect, prompts, send, startConversation, test, turnReply,
  waitForIdle, waitForMessage, waitForPendingRequest, type MockProvider, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
}

for (const provider of ['codex', 'claude'] as MockProvider[]) {
  test(`F031: a ${provider} reply streams before it completes and the transcript keeps its order`, async ({ profile }) => {
    const { conversationId } = await startConversation(profile, provider)
    await send(profile, conversationId, prompts.hold, 'held-turn')
    // The held turn has streamed its text but not completed it.
    await expect.poll(async () => (await snapshot(profile, conversationId)).messages
      .filter((message) => message.role === 'assistant').map((message) => [message.text, message.status]))
      .toEqual([[turnReply[provider], 'streaming']])
    expect(await conversationStatus(profile, conversationId)).toBe('running')
    await profile.call('agent.cancel', { conversation_id: conversationId })
    // A cancelled turn settles as interrupted, and cancelling pauses the queue.
    await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
    expect((await snapshot(profile, conversationId)).conversation.queue_paused).toBe(true)
    await profile.call('queue.pause', { conversation_id: conversationId, paused: false })

    await send(profile, conversationId, prompts.turn, 'second-turn')
    await waitForMessage(profile, conversationId, turnReply[provider])
    await waitForIdle(profile, conversationId)
    const settled = await snapshot(profile, conversationId)
    const users = settled.messages.filter((message) => message.role === 'user').map((message) => message.id)
    expect(users).toEqual(['held-turn', 'second-turn'])
    const sequences = settled.messages.map((message) => message.sequence)
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
  })
}

test('F031: tool events and an unknown item keep their order and readable fallback across a daemon restart', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'typed-unknown', 'typed-unknown-turn')
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  const before = await snapshot(profile, conversationId)
  const view = (messages: typeof before.messages) => messages.map((message) =>
    ({ id: message.id, role: message.role, kind: message.kind, status: message.status, text: message.text }))

  const tool = before.messages.find((message) => message.kind === 'commandExecution')
  expect(tool).toMatchObject({ role: 'tool', status: 'failed' })
  expect(tool?.text).toContain('fixture failure')
  const unknown = before.messages.find((message) => message.kind === 'futurePreview')
  expect(unknown?.text).toContain('Unrecognized Codex item (futurePreview)')
  // Private reasoning and the unknown item's native payload never enter the shared history.
  const everything = JSON.stringify(before.messages)
  expect(everything).not.toContain('PRIVATE_REASONING')
  expect(everything).not.toContain('PRIVATE_NATIVE_PAYLOAD')
  const order = before.messages.map((message) => message.id)
  expect(order.indexOf('typed-unknown-turn')).toBeLessThan(order.indexOf(tool!.id))
  expect(order.indexOf(tool!.id)).toBeLessThan(order.indexOf(unknown!.id))

  await profile.restartDaemon()
  const after = await snapshot(profile, conversationId)
  expect(view(after.messages)).toEqual(view(before.messages))
})

test('R002: agent.send with the same request ID admits one turn; a different payload conflicts', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const requestId = await send(profile, conversationId, prompts.turn, 'duplicate-send')
  await waitForIdle(profile, conversationId)
  // The same ID and payload converges on the accepted turn, even after reconnecting.
  await send(profile, conversationId, prompts.turn, requestId)
  await profile.restartDaemon()
  await send(profile, conversationId, prompts.turn, requestId)
  const cli = await profile.cli('conversation', 'send', conversationId, prompts.turn, '--request-id', requestId)
  expect(cli.code).toBe(0)
  // A different payload under the same ID is refused and admits nothing.
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: requestId, text: 'another prompt' }))
    .rejects.toThrow(/already used for a different prompt/)
  const conflict = await profile.cli('conversation', 'send', conversationId, 'another prompt', '--request-id', requestId)
  expect(conflict.code).not.toBe(0)
  expect(JSON.stringify(conflict.json)).toContain('different prompt')
  // Another Conversation cannot reuse the ID either.
  const other = await startConversation(profile, 'codex')
  await expect(profile.call('agent.send', { conversation_id: other.conversationId, request_id: requestId, text: prompts.turn }))
    .rejects.toThrow(/already used for a different prompt or conversation/)

  expect(await turnStarts(profile)).toEqual([requestId])
  const users = (await snapshot(profile, conversationId)).messages.filter((message) => message.role === 'user')
  expect(users.map((message) => message.id)).toEqual([requestId])
})

test('R001: a send whose reply was lost is accepted once and a retry after a daemon crash does not dispatch again', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await sendAndLoseReply(profile, { op: 'agent.send', conversation_id: conversationId, request_id: 'lost-send', text: prompts.turn })
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  await profile.restartDaemon('kill')
  await send(profile, conversationId, prompts.turn, 'lost-send')
  expect(await turnStarts(profile)).toEqual(['lost-send'])
  // The Conversation still takes new work after the crash.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, prompts.turn, 'after-crash')
  await waitForIdle(profile, conversationId)
  expect(await turnStarts(profile)).toEqual(['lost-send', 'after-crash'])
})

test('F034: queued prompts can be inspected, removed and paused, survive a restart and dispatch once each', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval, 'approval-turn')
  const approval = await waitForPendingRequest(profile, conversationId)

  // Queue three follow-ups through the SDK and the CLI while the turn waits.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-1', text: prompts.turn })
  const added = await profile.cli('queue', 'add', conversationId, prompts.turn, '--request-id', 'queued-2')
  expect(added.code).toBe(0)
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-3', text: prompts.turn })
  // A duplicate with the same payload converges; another payload under the ID conflicts.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-1', text: prompts.turn })
  await expect(profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-1', text: 'other' }))
    .rejects.toThrow(/belongs to another prompt/)
  // A direct send cannot jump the queue while the turn is active.
  await expect(profile.call('agent.send', { conversation_id: conversationId, request_id: 'jump', text: prompts.turn }))
    .rejects.toThrow(/active turn/)
  expect((await snapshot(profile, conversationId)).queued.map((entry) => entry.id))
    .toEqual(['queued-1', 'queued-2', 'queued-3'])

  // Remove one entry, then pause before the active turn ends.
  await profile.call('queue.cancel', { conversation_id: conversationId, request_id: 'queued-2' })
  const paused = await profile.cli('queue', 'pause', conversationId)
  expect(paused.code).toBe(0)
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'decline' })
  await waitForIdle(profile, conversationId)
  let state = await snapshot(profile, conversationId)
  expect(state.conversation.queue_paused).toBe(true)
  expect(state.queued.map((entry) => entry.id)).toEqual(['queued-1', 'queued-3'])
  expect(await turnStarts(profile)).toEqual(['approval-turn'])

  // The queue and its pause survive a daemon crash.
  await profile.restartDaemon('kill')
  state = await snapshot(profile, conversationId)
  expect(state.conversation.queue_paused).toBe(true)
  expect(state.queued.map((entry) => entry.id)).toEqual(['queued-1', 'queued-3'])
  // A cancelled entry cannot be revived by a retry under its ID.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-2', text: prompts.turn })
  expect((await snapshot(profile, conversationId)).queued.map((entry) => entry.id)).toEqual(['queued-1', 'queued-3'])

  // Resume: every accepted entry dispatches once, in order.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  const resumed = await profile.cli('queue', 'resume', conversationId)
  expect(resumed.code).toBe(0)
  await expect.poll(async () => (await snapshot(profile, conversationId)).queued.length, { timeout: 20_000 }).toBe(0)
  await waitForIdle(profile, conversationId)
  // Retrying a delivered entry reports it without queueing it again.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-1', text: prompts.turn })
  await profile.restartDaemon()
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
  expect(await turnStarts(profile)).toEqual(['approval-turn', 'queued-1', 'queued-3'])
  const users = (await snapshot(profile, conversationId)).messages.filter((message) => message.role === 'user')
  expect(users.map((message) => message.id)).toEqual(['approval-turn', 'queued-1', 'queued-3'])
  // The removed entry cannot be cancelled after submission of others, and a submitted one refuses cancel.
  await expect(profile.call('queue.cancel', { conversation_id: conversationId, request_id: 'queued-1' }))
    .rejects.toThrow(/already been submitted/)
})

test('F034: a prompt queued behind a running turn dispatches automatically when the turn ends', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, codexPrompts.approval, 'first')
  const approval = await waitForPendingRequest(profile, conversationId)
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'follow-up', text: prompts.turn })
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'accept' })
  await expect.poll(async () => (await snapshot(profile, conversationId)).messages
    .filter((message) => message.role === 'user').map((message) => message.id), { timeout: 20_000 })
    .toEqual(['first', 'follow-up'])
  await waitForIdle(profile, conversationId)
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
  expect(await turnStarts(profile)).toEqual(['first', 'follow-up'])
})

test('R001: a runtime crash during a turn keeps the accepted prompt, reports the interruption and never replays it', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold, 'runtime-crash-turn')
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'after-runtime-crash', text: prompts.turn })
  await profile.killRuntime()
  // The turn's outcome is unknown: it must not be reported as a completed or running turn.
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .toMatch(/^(interrupted|error|disconnected)$/)
  const failed = await snapshot(profile, conversationId)
  expect(failed.messages.filter((message) => message.role === 'user').map((message) => message.id)).toEqual(['runtime-crash-turn'])
  // The queued prompt is kept and does not run on its own after a failure.
  expect(failed.queued.map((entry) => entry.id)).toEqual(['after-runtime-crash'])

  await profile.restartDaemon()
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await expect.poll(async () => (await snapshot(profile, conversationId)).messages
    .filter((message) => message.role === 'user').map((message) => message.id), { timeout: 20_000 })
    .toEqual(['runtime-crash-turn', 'after-runtime-crash'])
  await waitForIdle(profile, conversationId)
  expect(await turnStarts(profile)).toEqual(['runtime-crash-turn', 'after-runtime-crash'])
})

test('F034 and R001: a queued prompt in dispatch when the daemon crashes is delivered once after restart', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.approval, 'crash-first')
  const approval = await waitForPendingRequest(profile, conversationId)
  // The mock holds this turn's admission until release-admission exists.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'crash-queued', text: 'queue-admission' })
  await profile.call('agent.answer', { conversation_id: conversationId, request_id: approval.id, decision: 'decline' })
  await expect.poll(() => turnStarts(profile), { timeout: 20_000 }).toEqual(['crash-first', 'crash-queued'])
  await profile.restartDaemon('kill')
  await profile.releaseMock('codex', 'release-admission')
  await expect.poll(async () => (await snapshot(profile, conversationId)).messages
    .filter((message) => message.role === 'user').map((message) => message.id)).toEqual(['crash-first', 'crash-queued'])
  await waitForMessage(profile, conversationId, turnReply.codex)
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 }).toMatch(/^(idle|ready)$/)
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
  // Recovery never replays the queued prompt: a retry under its ID reports it delivered.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'crash-queued', text: 'queue-admission' })
  await profile.restartDaemon()
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
  expect(await turnStarts(profile)).toEqual(['crash-first', 'crash-queued'])
})
