// F034 with R001 and R002 for queue.enqueue and queue.pause. Resuming the
// queue of an interrupted Conversation dispatches its head, as it does for an
// idle one; each queued prompt reaches the provider once, whatever crashes
// or retries happen around the dispatch.
import { conversationStatus, expect, prompts, send, startConversation, test, turnReply, waitForIdle,
  type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

async function turnStarts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId)
}

async function userMessages(profile: ScratchProfile, conversationId: string): Promise<string[]> {
  return (await snapshot(profile, conversationId)).messages.filter((message) => message.role === 'user')
    .map((message) => message.id)
}

/** Start a held turn, cancel it, and return once the Conversation is interrupted with its queue paused. */
async function interrupted(profile: ScratchProfile, conversationId: string, requestId: string): Promise<void> {
  await send(profile, conversationId, prompts.hold, requestId)
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  expect((await snapshot(profile, conversationId)).conversation.queue_paused).toBe(true)
}

test('F034: resuming the queue of an interrupted Conversation dispatches its head, through the SDK and the CLI', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await interrupted(profile, conversationId, 'cancelled-turn')
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'after-cancel', text: prompts.turn })
  // Paused: nothing dispatches while the Conversation stays interrupted.
  expect((await snapshot(profile, conversationId)).queued.map((entry) => entry.id)).toEqual(['after-cancel'])

  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await expect.poll(() => userMessages(profile, conversationId), { timeout: 20_000 })
    .toEqual(['cancelled-turn', 'after-cancel'])
  await waitForIdle(profile, conversationId)
  expect((await snapshot(profile, conversationId)).queued).toEqual([])

  // The same through the CLI, after a second interruption.
  await interrupted(profile, conversationId, 'cancelled-again')
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'after-cli-resume', text: prompts.turn })
  const resumed = await profile.cli('queue', 'resume', conversationId)
  expect(resumed.code, resumed.stderr).toBe(0)
  await expect.poll(() => userMessages(profile, conversationId), { timeout: 20_000 })
    .toEqual(['cancelled-turn', 'after-cancel', 'cancelled-again', 'after-cli-resume'])
  await waitForIdle(profile, conversationId)
  expect(await turnStarts(profile)).toEqual(['cancelled-turn', 'after-cancel', 'cancelled-again', 'after-cli-resume'])
})

test('F034 and R001: after a runtime crash, the queue waits for an explicit resume, then dispatches once and never replays the lost prompt', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold, 'lost-with-runtime')
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'queued-past-crash', text: prompts.turn })
  await profile.killRuntime()
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 }).toBe('interrupted')
  await profile.restartDaemon()
  const state = await snapshot(profile, conversationId)
  expect(state.conversation).toMatchObject({ status: 'interrupted', queue_paused: true })
  expect(state.queued.map((entry) => entry.id)).toEqual(['queued-past-crash'])

  // The lost run needs an explicit agent.resume. Resuming only the queue keeps
  // the prompt queued, unpaused, until the Agent is resumed.
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  // An unrelated turn elsewhere proves the queue had a dispatch pass meanwhile.
  const other = await startConversation(profile, 'codex')
  await send(profile, other.conversationId, prompts.turn, 'other-turn')
  await waitForIdle(profile, other.conversationId)
  const waiting = await snapshot(profile, conversationId)
  expect(waiting.conversation).toMatchObject({ status: 'interrupted', queue_paused: false })
  expect(waiting.queued.map((entry) => entry.id)).toEqual(['queued-past-crash'])
  expect(await turnStarts(profile)).toEqual(['lost-with-runtime', 'other-turn'])

  // Resuming the Agent dispatches the waiting prompt on its own.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect.poll(() => userMessages(profile, conversationId), { timeout: 20_000 })
    .toEqual(['lost-with-runtime', 'queued-past-crash'])
  await waitForIdle(profile, conversationId)
  expect(await turnStarts(profile)).toEqual(['lost-with-runtime', 'other-turn', 'queued-past-crash'])
})

test('R002: repeating queue.pause converges and never dispatches a prompt twice, also after a daemon crash', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await interrupted(profile, conversationId, 'pause-held')
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'pause-q1', text: prompts.turn })
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'pause-q2', text: prompts.turn })
  // Pausing twice converges on paused.
  await profile.call('queue.pause', { conversation_id: conversationId, paused: true })
  await profile.call('queue.pause', { conversation_id: conversationId, paused: true })
  expect((await snapshot(profile, conversationId)).conversation.queue_paused).toBe(true)

  // An unpause whose reply was lost, a daemon crash, then the same unpause again.
  await sendAndLoseReply(profile, { op: 'queue.pause', conversation_id: conversationId, paused: false })
  await expect.poll(async () => (await snapshot(profile, conversationId)).conversation.queue_paused).toBe(false)
  await profile.restartDaemon('kill')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await expect.poll(async () => (await snapshot(profile, conversationId)).queued.length, { timeout: 30_000 }).toBe(0)
  await waitForIdle(profile, conversationId)
  expect(await userMessages(profile, conversationId)).toEqual(['pause-held', 'pause-q1', 'pause-q2'])
  expect(await turnStarts(profile)).toEqual(['pause-held', 'pause-q1', 'pause-q2'])
})

test('R001 and R002: an enqueue whose reply was lost is kept once; its ID cannot be reused for another prompt or Conversation', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold, 'enqueue-held')
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  await sendAndLoseReply(profile, { op: 'queue.enqueue', conversation_id: conversationId, request_id: 'lost-enqueue',
    text: prompts.turn })
  await expect.poll(async () => (await snapshot(profile, conversationId)).queued.map((entry) => entry.id))
    .toEqual(['lost-enqueue'])
  await profile.restartDaemon('kill')
  // The retry converges on the kept entry.
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'lost-enqueue', text: prompts.turn })
  const cli = await profile.cli('queue', 'add', conversationId, prompts.turn, '--request-id', 'lost-enqueue')
  expect(cli.code, cli.stderr).toBe(0)
  expect((await snapshot(profile, conversationId)).queued.map((entry) => entry.id)).toEqual(['lost-enqueue'])
  // Another prompt, another Conversation or a direct send under the same ID conflicts and admits nothing.
  await expect(profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'lost-enqueue', text: 'other' }))
    .rejects.toThrow(/belongs to another prompt/)
  const other = await startConversation(profile, 'codex')
  await expect(profile.call('queue.enqueue', { conversation_id: other.conversationId, request_id: 'lost-enqueue',
    text: prompts.turn })).rejects.toThrow(/belongs to another prompt/)
  expect((await snapshot(profile, other.conversationId)).queued).toEqual([])
  await expect(profile.call('agent.send', { conversation_id: other.conversationId, request_id: 'lost-enqueue',
    text: prompts.turn })).rejects.toThrow()

  // The held turn survived the daemon crash. Cancelling it pauses the queue;
  // resuming the queue delivers the kept entry once.
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('running')
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationStatus(profile, conversationId)).toBe('interrupted')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  await expect.poll(() => userMessages(profile, conversationId), { timeout: 20_000 })
    .toEqual(['enqueue-held', 'lost-enqueue'])
  await waitForIdle(profile, conversationId)
  await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'lost-enqueue', text: prompts.turn })
  expect((await snapshot(profile, conversationId)).queued).toEqual([])
  expect((await turnStarts(profile)).filter((key) => key === 'lost-enqueue')).toHaveLength(1)
  expect(JSON.stringify((await snapshot(profile, conversationId)).messages)).toContain(turnReply.codex)
})
