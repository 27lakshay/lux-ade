// F039: conversation and file rewind. Codex's adapter does not rewind its
// history, so conversation rewind is reported as unavailable, with the reason,
// and records nothing; Claude's conversation rewind is proved in
// e2e/protocol/accounts-rewind/rewind.spec.ts. File rewind restores an ADE
// checkpoint for any provider: it is previewed first, refuses a stale preview
// and unconfirmed overwrites, and reads a lost outcome back after a crash.
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { snapshot } from './helpers'

async function checkpointed(profile: ScratchProfile, repo: ScratchRepo, provider: 'codex' | 'claude') {
  await repo.commit('Add source', { 'src/app.ts': 'export const answer = 42\n' })
  const { workspaceId, conversationId } = await startConversation(profile, provider, repo.path)
  const { checkpoint } = await profile.call('checkpoint.create', { operation_id: `cp-${provider}`, workspace_id: workspaceId,
    label: 'before the agent' })
  // The agent's work: an edit and a new file.
  await repo.dirty('src/app.ts', 'export const answer = 41\n')
  await repo.write('src/extra.ts', 'export {}\n')
  return { workspaceId, conversationId, checkpointId: checkpoint.checkpoint_id }
}

async function control(profile: ScratchProfile, conversationId: string, name: string) {
  return (await profile.call('conversation.controls', { conversation_id: conversationId })).controls
    .find((entry) => entry.control === name)
}

for (const provider of ['codex', 'claude'] as const) {
  test(`F039: ${provider} rewinds files through a checkpoint after a preview${provider === 'codex' ? ', and conversation rewind is unavailable' : ''}`, async ({ profile, repo }) => {
    const { conversationId, checkpointId } = await checkpointed(profile, repo, provider)
    expect(await control(profile, conversationId, 'rewind_files'))
      .toMatchObject({ available: true, mechanism: 'ade.checkpoints', reason: null })
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
    const before = (await snapshot(profile, conversationId)).messages

    if (provider === 'codex') {
      expect(await control(profile, conversationId, 'rewind_conversation'))
        .toMatchObject({ available: false, mechanism: null, reason: expect.stringContaining('adapter') })
      // Conversation rewind: reported, not emulated, and no receipt, so the operation ID stays unused.
      const conversationPreview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId,
        scope: 'conversation' })
      expect(conversationPreview).toMatchObject({ scope: 'conversation', files: null, availability: { available: false } })
      const refused = await profile.call('conversation.rewind', { operation_id: 'rewind-op', conversation_id: conversationId,
        scope: 'conversation' })
      expect(refused).toMatchObject({ outcome: 'unavailable', control: 'rewind_conversation',
        reason: conversationPreview.availability.reason })
      expect((await snapshot(profile, conversationId)).messages).toEqual(before)
    }

    // File rewind: the preview lists what changes and asks for confirmation over uncommitted work.
    const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
      checkpoint_id: checkpointId })
    expect(preview.availability).toMatchObject({ available: true, mechanism: 'ade.checkpoints' })
    expect(preview.files).toMatchObject({ verdict: 'needs_confirmation',
      uncommitted_overwritten: expect.arrayContaining(['src/app.ts']) })
    expect(preview.files!.changes.map((change) => change.path).sort()).toEqual(['src/app.ts', 'src/extra.ts'])
    const rewind = { operation_id: 'rewind-op', conversation_id: conversationId, scope: 'files' as const,
      checkpoint_id: checkpointId, expected_state: preview.files!.state_token, confirm_overwrite: true }
    const reply = await profile.call('conversation.rewind', rewind)
    expect(reply).toMatchObject({ outcome: 'restored', control: 'rewind_files', reason: null,
      files: { outcome: 'restored', verified: true, problems: [] } })
    expect(reply.files!.safety_checkpoint).not.toBeNull()
    expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
    await expect(repo.read('src/extra.ts')).rejects.toThrow()
    // The conversation history is not touched by a file rewind.
    expect((await snapshot(profile, conversationId)).messages).toEqual(before)

    // R002: the same operation replays its outcome, also after a daemon crash; a different payload conflicts.
    expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
    await profile.restartDaemon('kill')
    expect(await profile.call('conversation.rewind', rewind)).toEqual(reply)
    await expect(profile.call('conversation.rewind', { ...rewind, confirm_overwrite: false }))
      .rejects.toThrow('already used for a different request')
    // Rewinding again to where the files already are changes nothing.
    const again = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
      checkpoint_id: checkpointId })
    expect(again.files).toMatchObject({ verdict: 'unchanged', changes: [] })
  })
}

test('F039: file rewind refuses a stale preview, unconfirmed overwrites and a running turn, and keeps the files', async ({ profile, repo }) => {
  const { workspaceId, conversationId, checkpointId } = await checkpointed(profile, repo, 'codex')
  const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
    checkpoint_id: checkpointId })
  const base = { conversation_id: conversationId, scope: 'files' as const, checkpoint_id: checkpointId,
    expected_state: preview.files!.state_token }
  await expect(profile.call('conversation.rewind', { ...base, operation_id: 'rewind-unconfirmed' }))
    .rejects.toThrow(/confirm/i)
  // The files moved after the preview: its state token no longer matches.
  await repo.dirty('src/app.ts', 'export const answer = 40\n')
  await expect(profile.call('conversation.rewind', { ...base, operation_id: 'rewind-stale', confirm_overwrite: true }))
    .rejects.toThrow(/changed|preview/i)
  expect(await repo.read('src/app.ts')).toBe('export const answer = 40\n')

  // While a turn runs, file rewind is unavailable and records nothing.
  await send(profile, conversationId, prompts.hold)
  await expect.poll(async () => (await snapshot(profile, conversationId)).conversation.status).toBe('running')
  const fresh = await profile.call('checkpoint.restore.preview', { workspace_id: workspaceId, checkpoint_id: checkpointId })
  const running = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
    checkpoint_id: checkpointId })
  expect(running).toMatchObject({ files: null, availability: { available: false,
    reason: 'A turn is running; stop it before rewinding files' } })
  const busy = { ...base, operation_id: 'rewind-busy', expected_state: fresh.state_token, confirm_overwrite: true }
  expect(await profile.call('conversation.rewind', busy)).toMatchObject({ outcome: 'unavailable',
    reason: 'A turn is running; stop it before rewinding files', files: null })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 40\n')
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(async () => (await snapshot(profile, conversationId)).conversation.status).toBe('interrupted')
  // No receipt was kept: the same operation ID runs once the turn has stopped.
  expect(await profile.call('conversation.rewind', busy)).toMatchObject({ outcome: 'restored' })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 42\n')
})

test('R001: a file rewind whose reply was lost is read back after a daemon crash and restores once', async ({ profile, repo }) => {
  const { workspaceId, conversationId, checkpointId } = await checkpointed(profile, repo, 'codex')
  const preview = await profile.call('conversation.rewind.preview', { conversation_id: conversationId, scope: 'files',
    checkpoint_id: checkpointId })
  const rewind = { operation_id: 'rewind-lost', conversation_id: conversationId, scope: 'files' as const,
    checkpoint_id: checkpointId, expected_state: preview.files!.state_token, confirm_overwrite: true }
  await sendAndLoseReply(profile, { op: 'conversation.rewind', ...rewind })
  await expect.poll(() => repo.read('src/app.ts')).toBe('export const answer = 42\n')
  await profile.restartDaemon('kill')
  // The user edits again; the retry reports the earlier restore and does not write over the new edit.
  await repo.dirty('src/app.ts', 'export const answer = 43\n')
  const retried = await profile.call('conversation.rewind', rewind)
  expect(retried).toMatchObject({ outcome: 'restored', files: { outcome: 'restored' } })
  expect(await repo.read('src/app.ts')).toBe('export const answer = 43\n')
  const safety = (await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints
    .filter((entry) => entry.checkpoint_id !== checkpointId)
  expect(safety).toHaveLength(1)
})

// Gap: Codex 0.157.0 thread/revert rewrites only paginated threads, and ADE's
// Codex adapter starts legacy threads (thread/rollback was removed), so Codex
// conversation rewind is honestly unavailable (proved above). Codex documents
// thread/fork with lastTurnId, which could fork before a turn as Claude's
// adapter does; it stays unwired until the pinned schema is checked. ADE's side of a
// rewind (dropping messages, invalidating history pages) is built and proved
// for Claude in e2e/protocol/accounts-rewind/rewind.spec.ts.
test.fixme('F039: a Codex conversation rewind drops later messages and invalidates stale history pages', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  await send(profile, conversationId, 'second prompt')
  await waitForIdle(profile, conversationId)
  const firstTurn = (await snapshot(profile, conversationId)).messages[0].turn_id
  expect(await profile.call('conversation.rewind', { operation_id: 'rewind-history', conversation_id: conversationId,
    scope: 'conversation' })).toMatchObject({ outcome: 'acknowledged' })
  expect((await snapshot(profile, conversationId)).messages.every((message) => message.turn_id === firstTurn)).toBe(true)
})
