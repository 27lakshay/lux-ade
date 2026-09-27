// R014 and F050: a restored profile is a new identity. It must not send what
// the source profile may still send, and it must not treat the source
// profile's runtime as its own.
import { expect, isRunning, prompts, send, startConversation, test, turnReply, waitForMessage } from '../fixtures'
import { codexTurns, createBackup, restoreIntoNewProfile } from './helpers'

test('a restored profile holds queued prompts and pending sends, and starts without the source runtime incarnation', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  // Conversation A: a turn in flight with a prompt queued behind it.
  const busy = await startConversation(profile, 'codex')
  await send(profile, busy.conversationId, prompts.hold)
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: busy.conversationId })).conversation.active_turn_id,
    )
    .not.toBeNull()
  await profile.call('queue.enqueue', {
    conversation_id: busy.conversationId,
    request_id: 'queued-at-backup',
    text: 'queued at backup',
  })
  await expect
    .poll(async () =>
      (await profile.call('conversation.get', { conversation_id: busy.conversationId })).queued.map(
        (item) => item.status,
      ),
    )
    .toEqual(['queued'])

  // Conversation B: a send the client prepared but had not dispatched.
  const pending = await profile.call('conversation.create', { workspace_id: busy.workspaceId, provider: 'codex' })
  const owner = { conversation_id: pending.conversation.id, window_id: 'restore-owner' }
  await profile.call('draft.save', { ...owner, revision: 1, text: 'send once' })
  await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'restored-send-1',
    revision: 1,
    draft_text: 'send once',
    text: 'send once',
  })

  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  // The source sends its prepared prompt after the backup.
  await send(profile, pending.conversation.id, 'send once', 'restored-send-1')
  await expect.poll(() => codexTurns(profile)).toContain('send once')

  const restored = await restoreIntoNewProfile(ade, bundle)
  const source = profile.hello

  // A fresh runtime, and no restart reconciliation against the source runtime.
  expect(restored.hello.runtime_instance).not.toBe(source.runtime_instance)
  const recovery = await restored.call('runtime.recovery', {})
  expect(recovery.current_instance).toBe(restored.hello.runtime_instance)
  expect(recovery.reports).toEqual([])
  expect(await isRunning(source.runtime_pid)).toBe(true)

  // A: the in-flight turn is not resumed, and the queue is paused with its prompt kept.
  const a = await restored.call('conversation.get', { conversation_id: busy.conversationId })
  expect(a.conversation.queue_paused).toBe(true)
  expect(a.conversation.active_turn_id).toBeNull()
  // The interrupted turn explains itself; the conversation is not left busy.
  expect(a.conversation.error).toEqual(expect.any(String))
  expect(a.queued).toEqual([expect.objectContaining({ text: 'queued at backup', status: 'queued' })])

  // Execution stays fenced until the user rebinds the workspace. Rebinding
  // releases neither the paused queue nor the held send.
  expect(await restored.call('draft.send.get', owner)).toMatchObject({
    restored_from_backup: true,
    intent: { request_id: 'restored-send-1', state: 'pending' },
  })
  await expect(
    restored.call('agent.send', {
      conversation_id: pending.conversation.id,
      request_id: 'restored-send-1',
      text: 'send once',
    }),
  ).rejects.toThrow('needs_rebind')
  const [fenced] = (await restored.call('workspace.rebind.list', {})).workspaces
  await restored.call('workspace.rebind', { workspace_id: fenced.id, path: restored.defaultWorkspaceRoot })

  // B: the prepared send is held; neither a retry nor completing the draft releases it.
  await expect(
    restored.call('agent.send', {
      conversation_id: pending.conversation.id,
      request_id: 'restored-send-1',
      text: 'send once',
    }),
  ).rejects.toThrow('Restored prompt is held')
  await expect(restored.call('draft.send.complete', { ...owner, request_id: 'restored-send-1' })).rejects.toThrow(
    'Restored prompt is held',
  )

  // A crash and a restart of the restored daemon do not release either hold.
  await restored.restartDaemon('kill')
  await restored.restartDaemon('graceful')
  const afterRestart = await restored.call('conversation.get', { conversation_id: busy.conversationId })
  expect(afterRestart.conversation.queue_paused).toBe(true)
  expect(afterRestart.queued.map((item) => item.status)).toEqual(['queued'])
  await expect(
    restored.call('agent.send', {
      conversation_id: pending.conversation.id,
      request_id: 'restored-send-1',
      text: 'send once',
    }),
  ).rejects.toThrow('Restored prompt is held')

  // Barrier: a new turn in the restored profile completes. Up to then its
  // provider received nothing inherited from the source.
  const fresh = await restored.call('conversation.create', { workspace_id: fenced.id, provider: 'codex' })
  await send(restored, fresh.conversation.id, prompts.turn)
  await waitForMessage(restored, fresh.conversation.id, turnReply.codex)
  expect(await codexTurns(restored)).toEqual([prompts.turn])

  // The source profile kept its own turn and queue throughout.
  // The source's held turn was still live in its own runtime; the source still owns its queue.
  await profile.call('agent.cancel', { conversation_id: busy.conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: busy.conversationId })).conversation.active_turn_id,
    )
    .toBeNull()
  expect((await profile.call('conversation.get', { conversation_id: busy.conversationId })).queued).toEqual([
    expect.objectContaining({ id: 'queued-at-backup', status: 'queued' }),
  ])
  expect(await codexTurns(restored)).toEqual([prompts.turn])
})
