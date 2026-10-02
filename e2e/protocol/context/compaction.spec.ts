// F040: context compaction. ADE asks Codex to compact natively and records the
// provider's own compaction item with its provenance. The history before it is
// retained and the session continues. A lost reply is read back after a crash
// without a second native call. ADE never claims a context state the provider
// did not report.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { repositoryRoot } from '../fixtures/environment'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { mockDirectory } from '../fixtures/providers'
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
  ).toMatchObject({ available: true, mechanism: 'worker.compact' })

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
  const cli = await profile.cli('conversation', 'compact', conversationId, '--operation-id', 'compact-cli')
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
    reason: "ADE's Claude worker does not issue Claude Code's /compact command",
  })
  const cli = await profile.cli('conversation', 'compact', claude, '--operation-id', 'compact-claude-cli')
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toContain('/compact command')

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

test('PC35: tool material a provider repeats while compacting is not a second execution and joins no other tool', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'typed-tool')
  await waitForIdle(profile, conversationId)
  const before = await snapshot(profile, conversationId)
  const tools = (messages: typeof before.messages) => messages.filter((message) => message.kind === 'commandExecution')
  const [original] = tools(before.messages)
  expect(original).toBeDefined()

  await writeFile(join(mockDirectory(profile.root, 'codex'), 'compact-replay-tools'), '')
  await profile.call('conversation.compact', { operation_id: 'compact-replay', conversation_id: conversationId })
  await waitForMessage(profile, conversationId, compactionText)
  await waitForIdle(profile, conversationId)

  // The repeated item is the same execution: one record, with its own turn and output unchanged.
  const after = await snapshot(profile, conversationId)
  expect(tools(after.messages)).toEqual([original])
  expect(after.messages.filter((message) => message.kind === 'contextCompaction')).toHaveLength(1)

  // A later tool gets only its own output, never the repeated material.
  await send(profile, conversationId, 'typed-tool')
  await waitForIdle(profile, conversationId)
  const later = tools((await snapshot(profile, conversationId)).messages)
  expect(later).toHaveLength(2)
  expect(later[0]).toEqual(original)
  expect(later[1]!.provider_item_id).not.toBe(original!.provider_item_id)
  expect(later[1]!.text).toBe(original!.text)
})

test("PC02: Oh My Pi compaction is offered from its worker's declaration and performed through the native RPC compact", async ({
  ade,
}) => {
  // The Oh My Pi CLI is the recording fixture `providers/omp/mock-cli.mjs`.
  const calls = join(ade.root, 'omp-mock')
  await mkdir(calls, { recursive: true })
  const profile = await ade.profile({
    env: { ADE_OMP_BIN: join(repositoryRoot, 'providers/omp/mock-cli.mjs'), ADE_MOCK_OMP_DIR: calls },
  })
  const { conversationId } = await startConversation(profile, 'omp')
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, 'Hello Oh My Pi')
  await waitForIdle(profile, conversationId)
  const controls = (await profile.call('conversation.controls', { conversation_id: conversationId })).controls
  expect(controls.find((entry) => entry.control === 'compact')).toMatchObject({
    available: true,
    mechanism: 'worker.compact',
  })
  // What the worker declares unsupported reports the worker's own reason.
  expect(controls.find((entry) => entry.control === 'rewind_conversation')?.reason).toContain('Oh My Pi RPC has branch')
  const compacts = async () =>
    (await readFile(join(calls, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line.includes('"method":"compact"')).length
  expect(
    await profile.call('conversation.compact', { operation_id: 'compact-omp', conversation_id: conversationId }),
  ).toMatchObject({ outcome: 'acknowledged', control: 'compact' })
  expect(await compacts()).toBe(1)
  // A retry under the same operation ID replays the receipt without a second native compaction.
  expect(
    await profile.call('conversation.compact', { operation_id: 'compact-omp', conversation_id: conversationId }),
  ).toMatchObject({ outcome: 'acknowledged', control: 'compact' })
  expect(await compacts()).toBe(1)
  await send(profile, conversationId, 'after compaction')
  await expect
    .poll(async () => (await snapshot(profile, conversationId)).messages.map((m) => m.text))
    .toContain('after compaction')
  await waitForIdle(profile, conversationId)
})
