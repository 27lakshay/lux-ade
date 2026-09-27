// R004: stopping existing execution keeps working when the application is
// overloaded. Storage, provider output and ordinary commands are saturated in
// turn; new unsafe work is refused while cancellation still reaches the
// provider (architecture section 4: "Reserve capacity for cancellation ... If
// storage cannot acknowledge durable writes, reject new work. An
// authenticated emergency runtime control path can still attempt to stop
// existing execution and reconcile later"). Saturated command receipts are
// covered by recovery/receipt-saturation.spec.ts.
import { join } from 'node:path'
import { expect, isRunning, prompts, send, startConversation, turnReply, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { recoveryFixtures, waitForPidFile } from '../fixtures/recovery'
import { volumeTest as test } from '../fixtures/scratch-volume'

const STORAGE_FULL = /database or disk is full/

async function conversation(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
}

async function runningTurn(profile: ScratchProfile, conversationId: string, text: string = prompts.hold): Promise<string> {
  await send(profile, conversationId, text)
  let turn: string | null = null
  await expect.poll(async () => {
    const current = await conversation(profile, conversationId)
    turn = current.status === 'running' ? current.active_turn_id ?? null : null
    return turn
  }, { timeout: 20_000 }).not.toBeNull()
  return turn!
}

async function interrupts(profile: ScratchProfile): Promise<Array<string | undefined>> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/interrupt')
    .map((call) => (call.params as { turnId?: string }).turnId)
}

async function refusal(action: Promise<unknown>): Promise<string> {
  return action.then((reply) => `accepted: ${JSON.stringify(reply)}`, (error: unknown) => String(error))
}

test('with the data volume full, new work is refused and a running turn is still stopped', async ({ ade, volume }) => {
  test.setTimeout(120_000)
  // The first profile's data directory is `p1/data` under the test root; the volume is mounted there first.
  const disk = await volume(join(ade.root, 'p1', 'data'), 48)
  const profile = await ade.profile()
  disk.use(profile)
  const running = await startConversation(profile, 'codex')
  const idle = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, running.conversationId)

  // Fill the volume, then use up the database's preallocated space with
  // ordinary writes until storage refuses even the smallest ones.
  await disk.fill()
  let full = ''
  let refusedInARow = 0
  for (let attempt = 0; attempt < 5_000 && refusedInARow < 5; attempt++) {
    const outcome = await refusal(profile.call('conversation.create', { workspace_id: idle.workspaceId, provider: 'codex',
      title: full ? 'f' : `filler ${attempt} ${'x'.repeat(180)}` }))
    if (outcome.startsWith('accepted')) refusedInARow = 0
    else { full ||= outcome; refusedInARow++ }
  }
  expect(full).toMatch(STORAGE_FULL)
  expect(refusedInARow).toBe(5)

  // New unsafe admission is refused, through the SDK and the CLI, and nothing reaches the provider.
  const starts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
  expect(await refusal(send(profile, idle.conversationId, prompts.turn, 'refused-while-full'))).toMatch(STORAGE_FULL)
  const cli = await profile.cli('conversation', 'send', idle.conversationId, prompts.turn, '--request-id', 'refused-cli')
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toMatch(STORAGE_FULL)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(starts)

  // Cancellation still stops the running turn and reports that it could not be recorded.
  const cancelled = await refusal(profile.call('agent.cancel', { conversation_id: running.conversationId, turn_id: turn }))
  expect(cancelled).toMatch(/asked the provider to stop this turn but could not record the cancellation/)
  expect(cancelled).toMatch(STORAGE_FULL)
  await expect.poll(() => interrupts(profile)).toEqual([turn])
  expect(await isRunning(profile.hello.pid)).toBe(true)

  // Once storage accepts writes again, the stopped turn is reconciled and new work is admitted.
  await disk.free()
  await expect.poll(async () => (await conversation(profile, running.conversationId)).status, { timeout: 30_000 })
    .toBe('interrupted')
  await send(profile, idle.conversationId, prompts.turn, 'accepted-after-free')
  await waitForMessage(profile, idle.conversationId, turnReply.codex)
  await waitForIdle(profile, idle.conversationId)
  expect(await interrupts(profile)).toEqual([turn])
})

/** Send `agent.cancel`, retrying only while the connection is refused before the request was sent. */
async function cancelWhenConnected(profile: ScratchProfile, request: { conversation_id: string; turn_id: string }) {
  for (;;) {
    try {
      return await profile.call('agent.cancel', request)
    } catch (error) {
      const { delivery, code } = error as { delivery?: string; code?: string }
      if (code !== 'unavailable' || delivery !== 'not_sent') throw error
    }
  }
}

/** A burst of ordinary commands: reads, and steers refused because they name another turn. */
function burst(profile: ScratchProfile, conversationId: string, size: number): Promise<string[]> {
  return Promise.all(Array.from({ length: size }, (_, index) => (index % 2
    ? profile.call('conversation.get', { conversation_id: conversationId })
    : profile.call('conversation.steer', { operation_id: `burst-${index}`, conversation_id: conversationId,
      turn_id: 'not-this-turn', text: 'x' })).then(() => 'ok', (error: unknown) => String(error))))
}

test('an output flood and a burst of ordinary commands do not keep cancellation from stopping the turn', async ({ ade }) => {
  test.setTimeout(120_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.floodCodex } })
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, conversationId, 'flood')
  await waitForPidFile(join(mockDirectory(profile.root, 'codex'), 'flood-proxy.pid'))
  await profile.releaseMock('codex', 'flood-release')
  // About 40 MiB of provider output streams while 400 ordinary commands arrive.
  const answered = burst(profile, conversationId, 400)
  await cancelWhenConnected(profile, { conversation_id: conversationId, turn_id: turn })
  await expect.poll(() => interrupts(profile), { timeout: 30_000 }).toEqual([turn])
  await expect.poll(async () => (await conversation(profile, conversationId)).status, { timeout: 60_000 })
    .toBe('interrupted')
  // Every ordinary command was answered, refused for its own reason, or
  // refused at the socket before it was sent; none was lost after sending.
  expect((await answered).filter((reply) => reply !== 'ok'
    && !/no longer the running turn|send a message instead|not running|unavailable at the selected socket/.test(reply)))
    .toEqual([])
})

// Gap: cancellation shares the profile socket and its listen backlog (128 on
// macOS) with every ordinary command. A burst of connections past the backlog
// is refused with ECONNREFUSED, and a cancel sent during it can be refused the
// same way. It was never sent, so a retry is safe, but no control lane is
// reserved for it (architecture section 4: "Reserve capacity for cancellation").
test.fixme('a cancel sent during a connection flood past the socket backlog is admitted on its first attempt', async ({ ade }) => {
  const profile = await ade.profile()
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, conversationId)
  const answered = burst(profile, conversationId, 2_000)
  await profile.call('agent.cancel', { conversation_id: conversationId, turn_id: turn })
  await expect.poll(() => interrupts(profile)).toEqual([turn])
  await answered
})
