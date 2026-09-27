// F040: context compaction. ADE asks Codex to compact natively and records the
// provider's own compaction item with its provenance. The history before it is
// retained and the session continues. A lost reply is read back after a crash
// without a second native call. ADE never claims a context state the provider
// did not report.
import {
  conversationStatus,
  expect,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { snapshot } from './helpers'

async function nativeCompactions(profile: ScratchProfile) {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'thread/compact/start')
}

const compactionText = 'Codex compacted the conversation context.'

test('F040: a Codex compaction keeps its native provenance and the earlier history, and the session continues', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const before = await snapshot(profile, conversationId)
  expect(
    (await profile.call('conversation.controls', { conversation_id: conversationId })).controls.find(
      (entry) => entry.control === 'compact',
    ),
  ).toMatchObject({ available: true, mechanism: 'thread/compact/start' })

  const reply = await profile.call('conversation.compact', {
    operation_id: 'compact-keep',
    conversation_id: conversationId,
  })
  // Acknowledged means the provider started; ADE claims nothing more until the provider reports it.
  expect(reply).toMatchObject({ outcome: 'acknowledged', control: 'compact', reason: null, turn_id: null, files: null })
  await waitForMessage(profile, conversationId, compactionText)
  const [call] = await nativeCompactions(profile)
  expect(call.params).toEqual({ threadId: before.conversation.provider_thread_id })

  const after = await snapshot(profile, conversationId)
  const record = after.messages.find((message) => message.kind === 'contextCompaction')!
  expect(record).toMatchObject({
    role: 'tool',
    status: 'completed',
    text: compactionText,
    provider_item_id: expect.stringMatching(/^compaction-/),
    turn_id: expect.stringMatching(/^compact-turn-/),
  })
  // The earlier history is retained in order, before the compaction record.
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
  expect(record.sequence).toBeGreaterThan(before.messages.at(-1)!.sequence)
  expect(after.conversation.provider_thread_id).toBe(before.conversation.provider_thread_id)

  // The record and its provenance survive a daemon crash, and the same thread takes the next turn.
  await profile.restartDaemon('kill')
  expect((await snapshot(profile, conversationId)).messages).toEqual(after.messages)
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const resumed = await snapshot(profile, conversationId)
  expect(resumed.messages.filter((message) => message.text === turnReply.codex)).toHaveLength(2)
  expect(resumed.conversation.provider_thread_id).toBe(before.conversation.provider_thread_id)

  // Through the CLI, compaction is the same effect command.
  const cli = await profile.cli('conversation', 'compact', conversationId, '--request-id', 'compact-cli')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ outcome: 'acknowledged' })
  await expect
    .poll(
      async () =>
        (await snapshot(profile, conversationId)).messages.filter((message) => message.kind === 'contextCompaction')
          .length,
    )
    .toBe(2)
})

test('R001: a compaction whose reply was lost is read back after a daemon crash without a second native call', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const compact = { operation_id: 'compact-lost', conversation_id: conversationId }
  await sendAndLoseReply(profile, { op: 'conversation.compact', ...compact })
  await expect.poll(async () => (await nativeCompactions(profile)).length).toBe(1)
  await waitForMessage(profile, conversationId, compactionText)
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.compact', compact)).toMatchObject({ outcome: 'acknowledged' })
  await expect(
    profile.call('conversation.compact', { ...compact, conversation_id: 'conversation_other' }),
  ).rejects.toThrow()
  expect(await nativeCompactions(profile)).toHaveLength(1)
  expect(
    (await snapshot(profile, conversationId)).messages.filter((message) => message.kind === 'contextCompaction'),
  ).toHaveLength(1)
})

test('F040: an unsupported provider or a busy Conversation reports why and records no compaction', async ({
  profile,
}) => {
  const claude = (await startConversation(profile, 'claude')).conversationId
  await send(profile, claude, prompts.turn)
  await waitForIdle(profile, claude)
  const unsupported = await profile.call('conversation.compact', {
    operation_id: 'compact-claude',
    conversation_id: claude,
  })
  expect(unsupported).toMatchObject({
    outcome: 'unavailable',
    reason: "ADE's Claude adapter does not issue Claude Code's compaction command yet",
  })
  const cli = await profile.cli('conversation', 'compact', claude, '--request-id', 'compact-claude-cli')
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toContain('compaction command')

  const codex = (await startConversation(profile, 'codex')).conversationId
  await send(profile, codex, prompts.hold)
  await expect.poll(() => conversationStatus(profile, codex)).toBe('running')
  expect(
    await profile.call('conversation.compact', { operation_id: 'compact-busy', conversation_id: codex }),
  ).toMatchObject({ outcome: 'unavailable', reason: 'A turn is running; compact when it finishes' })
  for (const conversation of [claude, codex]) {
    expect(
      (await snapshot(profile, conversation)).messages.some((message) => message.kind === 'contextCompaction'),
    ).toBe(false)
  }
  expect(await nativeCompactions(profile)).toEqual([])
})
