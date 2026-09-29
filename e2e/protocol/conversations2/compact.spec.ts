// F040 with R001 and R002 for conversation.compact, an effect command keyed
// by operation ID. A retry reads the recorded outcome, including after a
// daemon crash between dispatch and the provider's acknowledgement; a crash
// that loses the run leaves the outcome explicitly unknown; the provider is
// never asked to compact twice for one operation.
import {
  conversationStatus,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { conversationFaults, waitForHeldCompaction } from '../fixtures/conversation-faults'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function compactions(profile: ScratchProfile): Promise<number> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'thread/compact/start').length
}

async function compactionRecords(profile: ScratchProfile, conversationId: string): Promise<number> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages.filter(
    (message) => message.kind === 'contextCompaction' && message.status === 'completed',
  ).length
}

async function readyConversation(profile: ScratchProfile): Promise<string> {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  return conversationId
}

test('R002: the same compaction converges on its reply after reconnects and a crash; another payload conflicts', async ({
  profile,
}) => {
  const conversationId = await readyConversation(profile)
  const compact = { operation_id: 'compact-r002', conversation_id: conversationId }
  const reply = await profile.call('conversation.compact', compact)
  expect(reply).toMatchObject({ outcome: 'acknowledged', control: 'compact', operation_id: 'compact-r002' })
  await waitForMessage(profile, conversationId, 'Codex compacted the conversation context.')
  await waitForIdle(profile, conversationId)

  expect(await profile.call('conversation.compact', compact)).toEqual(reply)
  const cli = await profile.cli('conversation', 'compact', conversationId, '--operation-id', 'compact-r002')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ outcome: 'acknowledged', operation_id: 'compact-r002' })
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.compact', compact)).toEqual(reply)

  // The operation ID on another Conversation is a different payload.
  const other = await readyConversation(profile)
  await expect(
    profile.call('conversation.compact', { operation_id: 'compact-r002', conversation_id: other }),
  ).rejects.toThrow(/already used for a different request/)
  const conflict = await profile.cli('conversation', 'compact', other, '--operation-id', 'compact-r002')
  expect(conflict.code).not.toBe(0)
  expect(await compactions(profile)).toBe(1)
  expect(await compactionRecords(profile, conversationId)).toBe(1)
  expect(await compactionRecords(profile, other)).toBe(0)
})

test('R001: a compaction whose reply was lost is read back after a daemon crash without a second native call', async ({
  profile,
}) => {
  const conversationId = await readyConversation(profile)
  const compact = { operation_id: 'compact-lost', conversation_id: conversationId }
  await sendAndLoseReply(profile, { op: 'conversation.compact', ...compact })
  await expect.poll(() => compactions(profile)).toBe(1)
  await waitForMessage(profile, conversationId, 'Codex compacted the conversation context.')
  await profile.restartDaemon('kill')
  expect(await profile.call('conversation.compact', compact)).toMatchObject({ outcome: 'acknowledged' })
  expect(await compactions(profile)).toBe(1)
  expect(await compactionRecords(profile, conversationId)).toBe(1)
})

test('R001: a daemon crash between dispatch and the provider acknowledgement is reconciled from the same run', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: conversationFaults.env })
  const conversationId = await readyConversation(profile)
  await profile.releaseMock('codex', conversationFaults.holdCompact)
  const compact = { operation_id: 'compact-in-flight', conversation_id: conversationId }
  await sendAndLoseReply(profile, { op: 'conversation.compact', ...compact })
  // The call left the daemon and waits in front of the provider.
  await waitForHeldCompaction(profile)
  expect(await compactions(profile)).toBe(0)
  await profile.restartDaemon('kill')

  // The provider acknowledges while no daemon holds the reply.
  await profile.releaseMock('codex', conversationFaults.releaseCompact)
  await expect.poll(() => compactions(profile)).toBe(1)
  await waitForMessage(profile, conversationId, 'Codex compacted the conversation context.')
  const reply = await profile.call('conversation.compact', compact)
  expect(reply).toMatchObject({ outcome: 'acknowledged', operation_id: 'compact-in-flight' })
  expect(await profile.call('conversation.compact', compact)).toEqual(reply)
  expect(await compactions(profile)).toBe(1)
  await waitForIdle(profile, conversationId)
  expect(await compactionRecords(profile, conversationId)).toBe(1)
})

test('R001: a compaction whose run was lost with the runtime is reported unknown and never sent again', async ({
  ade,
}) => {
  const profile = await ade.profile({ env: conversationFaults.env })
  const conversationId = await readyConversation(profile)
  await profile.releaseMock('codex', conversationFaults.holdCompact)
  const compact = { operation_id: 'compact-unknown', conversation_id: conversationId }
  await sendAndLoseReply(profile, { op: 'conversation.compact', ...compact })
  await waitForHeldCompaction(profile)
  // The runtime and the provider it ran are lost before any acknowledgement.
  await profile.killRuntime()
  await expect.poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 }).toBe('interrupted')
  await profile.restartDaemon()
  await profile.releaseMock('codex', conversationFaults.releaseCompact)

  const unknown = await profile.call('conversation.compact', compact)
  expect(unknown).toMatchObject({ outcome: 'unknown', reason: expect.stringContaining('will not run it again') })
  const cli = await profile.cli('conversation', 'compact', conversationId, '--operation-id', 'compact-unknown')
  expect(cli.code).not.toBe(0)
  expect(JSON.stringify(cli.json)).toContain('outcome_unknown')
  // The unknown outcome is stable once the Conversation runs again.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  expect(await profile.call('conversation.compact', compact)).toEqual(unknown)
  expect(await compactions(profile)).toBe(0)

  // A new operation compacts on the new run.
  const fresh = await profile.call('conversation.compact', {
    operation_id: 'compact-after-loss',
    conversation_id: conversationId,
  })
  expect(fresh).toMatchObject({ outcome: 'acknowledged' })
  expect(await compactions(profile)).toBe(1)
})
