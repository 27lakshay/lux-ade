// R003 stream fencing: a cancelled turn's late provider stream never reaches
// the turn admitted after it. The Codex mock sits behind a proxy
// (codex_stale_stream.py) that, once the successor turn has started, sends
// what a slow provider could still send for the cancelled one: text, an
// error, a question and a failed completion, all naming the old turn.
//
// The successor is admitted three ways: a new send, a new send after a daemon
// crash between the cancel and the admission, and a queued prompt that wakes
// when the queue resumes while the cancelled turn is still being cleaned up.
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, prompts, send, startConversation, test, type ScratchProfile } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'

async function conversation(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId, limit: 200 })
}

async function runningTurn(profile: ScratchProfile, conversationId: string, sent = true): Promise<string> {
  if (sent) await send(profile, conversationId, prompts.hold)
  let turn = ''
  await expect.poll(async () => {
    const current = (await conversation(profile, conversationId)).conversation
    turn = current.status === 'running' ? current.active_turn_id ?? '' : ''
    return turn
  }, { timeout: 20_000 }).not.toBe('')
  return turn
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

for (const successor of ['a new send', 'a new send after a daemon crash', 'a queued wake'] as const) {
  test(`R003: a cancelled turn's late stream never reaches its successor, admitted by ${successor}`, async ({ ade }) => {
    const profile = await ade.profile({ env: { ADE_CODEX_BIN: join(__dirname, 'codex_stale_stream.py') } })
    const directory = mockDirectory(profile.root, 'codex')
    const { conversationId } = await startConversation(profile, 'codex')
    const first = await runningTurn(profile, conversationId)
    const woken = successor === 'a queued wake'
    if (woken) {
      await profile.call('queue.enqueue', { conversation_id: conversationId, request_id: 'core-wake', text: prompts.hold })
    }
    await profile.releaseMock('codex', 'stale-stream')
    await profile.call('agent.cancel', { conversation_id: conversationId, turn_id: first })
    // The wake is admitted as soon as the queue resumes, racing the cancelled turn's cleanup.
    if (woken) await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
    else {
      await expect.poll(async () => (await conversation(profile, conversationId)).conversation.status).toBe('interrupted')
      if (successor === 'a new send after a daemon crash') await profile.restartDaemon('kill')
      await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
    }

    const second = await runningTurn(profile, conversationId, !woken)
    expect(second).not.toBe(first)
    if (woken) {
      // The queued prompt ran once, as the successor.
      const snapshot = await conversation(profile, conversationId)
      expect(snapshot.queued).toEqual([])
      expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(2)
    }
    await expect.poll(() => exists(join(directory, 'stale-sent'))).toBe(true)
    expect(await readFile(join(directory, 'stale-sent'), 'utf8')).toBe(second)
    // The stale question is refused on the provider pipe rather than shown to the person.
    await expect.poll(() => exists(join(directory, 'stale-request-answered'))).toBe(true)
    expect(JSON.parse(await readFile(join(directory, 'stale-request-answered'), 'utf8'))).toHaveProperty('error')
    // The stale text is kept, but as the cancelled turn's message.
    await expect.poll(async () => (await conversation(profile, conversationId)).messages
      .find((message) => message.text.includes('Stale text'))?.turn_id ?? null).toBe(first)

    // The successor is untouched: still running under its own ID, with no error and nothing pending.
    const snapshot = await conversation(profile, conversationId)
    expect(snapshot.conversation).toMatchObject({ status: 'running', active_turn_id: second })
    expect(snapshot.conversation.error ?? null).toBeNull()
    expect(snapshot.requests).toEqual([])
    expect(snapshot.messages.filter((message) => message.turn_id === second)
      .some((message) => message.text.includes('Stale'))).toBe(false)
    // It still takes commands meant for it, and ends only by its own cancel.
    expect(await profile.call('conversation.steer', { operation_id: 'core-steer', conversation_id: conversationId,
      turn_id: second, text: 'still yours' })).toMatchObject({ outcome: 'acknowledged', turn_id: second })
    await profile.call('agent.cancel', { conversation_id: conversationId, turn_id: second })
    await expect.poll(async () => (await conversation(profile, conversationId)).conversation.status).toBe('interrupted')
    expect((await conversation(profile, conversationId)).conversation.error ?? null).toBeNull()
  })
}
