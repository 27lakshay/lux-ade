// R001 and R002 for the remaining Conversation effect commands.
// conversation.rewind (files) restores a checkpoint under its operation ID:
// a retry reads the recorded outcome and never restores twice, also after a
// lost reply and a daemon crash; a different payload conflicts. A
// Conversation rewind has no handler, so it records no receipt at all.
// conversation.create is declared an effect command but takes no operation
// ID, so a retry cannot be recognised (gap, fixme below).
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile,
  type ScratchRepo } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function checkpointed(profile: ScratchProfile, repo: ScratchRepo) {
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  await repo.dirty('README.md', '# Scratch repository\n\nAt the checkpoint.\n')
  const { checkpoint } = await profile.call('checkpoint.create', { operation_id: `cp-${conversationId}`,
    workspace_id: workspaceId })
  await repo.dirty('README.md', '# Scratch repository\n\nAfter the checkpoint.\n')
  const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
    checkpoint_id: checkpoint.checkpoint_id })
  expect(preview.availability).toMatchObject({ available: true })
  return { workspaceId, conversationId, checkpoint, state: preview.files!.state_token }
}

async function safetyCheckpoints(profile: ScratchProfile, workspaceId: string): Promise<number> {
  return (await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints
    .filter((entry) => entry.kind === 'safety').length
}

test('R001 and R002: a file rewind whose reply was lost restores once and a retry after a crash reads its outcome', async ({ profile, repo }) => {
  const { workspaceId, conversationId, checkpoint, state } = await checkpointed(profile, repo)
  const rewind = { operation_id: 'rewind-files', conversation_id: conversationId, scope: 'files' as const,
    checkpoint_id: checkpoint.checkpoint_id, expected_state: state, confirm_overwrite: true }
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect.poll(() => repo.read('README.md')).toContain('At the checkpoint')
  await expect.poll(() => safetyCheckpoints(profile, workspaceId)).toBe(1)
  await profile.restartDaemon('kill')

  // New work after the rewind: a retry must not restore over it.
  await repo.dirty('README.md', '# Scratch repository\n\nEdited after the rewind.\n')
  const reply = await profile.call('conversation.rewind', rewind)
  expect(reply).toMatchObject({ outcome: 'restored', control: 'rewind_files', operation_id: 'rewind-files' })
  expect(reply.files?.checkpoint_id).toBe(checkpoint.checkpoint_id)
  expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
  const cli = await profile.cli('conversation', 'rewind', conversationId, 'files', checkpoint.checkpoint_id, state,
    '--request-id', 'rewind-files', '--confirm-overwrite')
  expect(cli.code, cli.stderr).toBe(0)
  expect(await repo.read('README.md')).toContain('Edited after the rewind')
  expect(await safetyCheckpoints(profile, workspaceId)).toBe(1)

  // The same operation ID with another payload conflicts and writes nothing.
  await expect(profile.call('conversation.rewind', { ...rewind, confirm_overwrite: false }))
    .rejects.toThrow(/already used for a different request/)
  const other = await startConversation(profile, 'codex', repo.path)
  await expect(profile.call('conversation.rewind', { ...rewind, conversation_id: other.conversationId }))
    .rejects.toThrow(/already used for a different request/)
  expect(await repo.read('README.md')).toContain('Edited after the rewind')
  expect(await safetyCheckpoints(profile, workspaceId)).toBe(1)
})

test('R002: a Conversation rewind reports its limitation and records no receipt', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const rewind = { operation_id: 'rewind-conversation', conversation_id: conversationId, scope: 'conversation' as const,
    confirm_overwrite: false }
  expect(await profile.call('conversation.rewind', rewind)).toMatchObject({ outcome: 'unavailable',
    reason: expect.stringContaining('thread/revert') })
  expect(await profile.call('conversation.rewind', rewind)).toMatchObject({ outcome: 'unavailable' })
  // Nothing was recorded under the ID, so it stays free for a real operation.
  expect(await profile.call('conversation.compact', { operation_id: 'rewind-conversation', conversation_id: conversationId }))
    .toMatchObject({ outcome: 'acknowledged' })
})

// Gap: conversation.create is declared an effect command, but its request has
// no operation ID. A create whose reply is lost cannot be retried safely: the
// retry makes a second Conversation. Closing it needs an operation_id field
// on ConversationCreateRequest and a receipt in the daemon.
test.fixme('R002: a conversation.create retried under the same operation ID makes one Conversation', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const request = { op: 'conversation.create', operation_id: 'create-once', workspace_id: workspace.id, provider: 'codex' }
  await sendAndLoseReply(profile, request)
  await profile.restartDaemon('kill')
  const first = await profile.rpc(request) as { conversation: { id: string } }
  const second = await profile.rpc(request) as { conversation: { id: string } }
  expect(second.conversation.id).toBe(first.conversation.id)
  await expect(profile.rpc({ ...request, provider: 'claude' })).rejects.toThrow(/different request/)
})
