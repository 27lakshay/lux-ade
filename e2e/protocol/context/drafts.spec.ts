// F036 with context: a live window draft keeps the context nodes captured into
// it through a crashed window and a crashed daemon; recall and stash carry the
// context back; an explicit transfer moves it between windows without
// overwriting a newer draft there.
import { expect, startConversation, test, waitForIdle, type ScratchProfile, type ScratchRepo } from '../fixtures'

async function captured(profile: ScratchProfile, repo: ScratchRepo) {
  await repo.commit('Add source', { 'src/app.ts': 'const a = 1\nconst b = 2\nconst c = 3\n' })
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  const reply = await profile.call('context.capture', {
    conversation_id: conversationId,
    request_id: 'ctx-draft',
    source: { kind: 'file_range', workspace_id: workspaceId, path: 'src/app.ts', start_line: 2, end_line: 3 },
  })
  // The window keeps the node as a context reference and its attachment beside the text.
  const node = { id: reply.node.id, kind: reply.node.kind, data: { provenance: reply.node.provenance } }
  return { conversationId, node, attachments: reply.node.attachments }
}

async function draft(profile: ScratchProfile, conversationId: string, windowId: string) {
  return (await profile.call('draft.get', { conversation_id: conversationId, window_id: windowId })).draft
}

test('F036: a live draft restores its captured context after a window crash and a daemon crash', async ({
  profile,
  repo,
}) => {
  const { conversationId, node, attachments } = await captured(profile, repo)
  const owner = { conversation_id: conversationId, window_id: 'window-crashed' }
  const saved = await profile.call('draft.save', {
    ...owner,
    text: 'explain these lines',
    revision: 1,
    attachments,
    context_nodes: [node],
  })
  expect(saved.draft).toEqual({ text: 'explain these lines', revision: 1, attachments, context_nodes: [node] })
  // A late write from before the crash carries an older revision; it changes neither text nor context.
  await profile.call('draft.save', { ...owner, text: 'stale', revision: 1 })
  await profile.restartDaemon('kill')
  expect(await draft(profile, conversationId, 'window-crashed')).toEqual({
    text: 'explain these lines',
    revision: 1,
    attachments,
    context_nodes: [node],
  })
  // The context node protects nothing by itself, but the draft's attachment reference does.
  const { preview } = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: attachments[0].id,
  })
  expect(preview.protected_by).toContain('draft')

  // A newer save without context drops it; an explicit conflict resolution applies only over the revision it saw.
  await profile.call('draft.save', { ...owner, text: 'explain', revision: 2, attachments })
  expect((await draft(profile, conversationId, 'window-crashed')).context_nodes).toBeUndefined()
  expect(
    (
      await profile.call('draft.save', {
        ...owner,
        text: 'x',
        revision: 3,
        expected_revision: 1,
        context_nodes: [node],
      })
    ).draft,
  ).toMatchObject({ text: 'explain', revision: 2 })
  expect(
    (
      await profile.call('draft.save', {
        ...owner,
        text: 'x',
        revision: 3,
        expected_revision: 2,
        context_nodes: [node],
      })
    ).draft,
  ).toEqual({ text: 'x', revision: 3, context_nodes: [node] })
})

test('F036: a cleared or sent draft is recalled with its context, only over the revision the caller saw', async ({
  profile,
  repo,
}) => {
  const { conversationId, node, attachments } = await captured(profile, repo)
  const owner = { conversation_id: conversationId, window_id: 'window-recall' }
  await profile.call('draft.save', { ...owner, text: 'first idea', revision: 1, attachments, context_nodes: [node] })
  // Clearing the draft keeps it, context included, as discarded history.
  await profile.call('draft.save', { ...owner, text: '', revision: 2 })
  expect(await draft(profile, conversationId, 'window-recall')).toEqual({ text: '', revision: 2 })

  // Send a second draft with the same context through the send intent.
  await profile.call('draft.save', { ...owner, text: 'hello', revision: 3, attachments, context_nodes: [node] })
  const prepared = await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'send-with-context',
    draft_text: 'hello',
    text: 'hello',
    revision: 3,
    attachments,
    context_nodes: [node],
  })
  expect(prepared.intent.context_nodes).toEqual([node])
  expect((await profile.call('draft.send.get', owner)).intent).toMatchObject({
    request_id: 'send-with-context',
    context_nodes: [node],
  })
  expect((await profile.call('draft.send.list', { window_id: owner.window_id })).sends).toEqual([
    expect.objectContaining({
      intent: expect.objectContaining({ request_id: 'send-with-context', context_nodes: [node] }),
    }),
  ])
  await profile.call('agent.send', {
    conversation_id: conversationId,
    request_id: 'send-with-context',
    text: 'hello',
    attachments,
  })
  const cleared = await profile.call('draft.send.complete', { ...owner, request_id: 'send-with-context' })
  expect(cleared.draft).toEqual({ text: '', revision: 4 })
  await waitForIdle(profile, conversationId)
  await profile.restartDaemon('kill')
  // The send cleared the context with the text.
  expect(await draft(profile, conversationId, 'window-recall')).toEqual({ text: '', revision: 4 })

  const history = await profile.call('draft.history.list', {
    conversation_id: conversationId,
    window_id: 'window-recall',
  })
  expect(history.entries.map((entry) => [entry.kind, entry.text, entry.context_nodes])).toEqual([
    ['sent', 'hello', [node]],
    ['discarded', 'first idea', [node]],
  ])
  const discarded = history.entries[1]

  // Another write lands first: the recall writes nothing.
  await profile.call('draft.save', { ...owner, text: 'typed meanwhile', revision: 5 })
  expect(
    await profile.call('draft.history.restore', {
      ...owner,
      entry_id: discarded.id,
      expected_revision: 4,
      revision: 6,
    }),
  ).toMatchObject({ outcome: 'conflict', draft: { text: 'typed meanwhile', revision: 5 } })
  const restored = await profile.call('draft.history.restore', {
    ...owner,
    entry_id: discarded.id,
    expected_revision: 5,
    revision: 6,
  })
  expect(restored).toMatchObject({
    outcome: 'restored',
    context_nodes: [node],
    draft: { text: 'first idea', revision: 6, attachments, context_nodes: [node] },
  })
  // The recalled context is the live draft's context, and survives a crash.
  await profile.restartDaemon('kill')
  expect(await draft(profile, conversationId, 'window-recall')).toEqual({
    text: 'first idea',
    revision: 6,
    attachments,
    context_nodes: [node],
  })
})

test('F036: a stash moves a draft and its context to another window without overwriting a newer draft there', async ({
  profile,
  repo,
}) => {
  const { conversationId, node, attachments } = await captured(profile, repo)
  const windowA = { conversation_id: conversationId, window_id: 'window-a' }
  const windowB = { conversation_id: conversationId, window_id: 'window-b' }
  await profile.call('draft.save', { ...windowA, text: 'review this', revision: 1, attachments, context_nodes: [node] })
  const stashed = await profile.call('draft.stash.save', {
    ...windowA,
    name: 'review',
    text: 'review this',
    attachments,
    context_nodes: [node],
  })
  expect(stashed).toMatchObject({ outcome: 'created', stash: { revision: 1, context_nodes: [node], attachments } })
  // The stash keeps the attachment even once window A lets it go.
  await profile.call('draft.save', { ...windowA, text: '', revision: 2 })
  const { preview } = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: attachments[0].id,
  })
  expect(preview.protected_by).toContain('draft_stash')

  await profile.call('draft.save', { ...windowB, text: 'window B work', revision: 1 })
  const transfer = { ...windowB, name: 'review', stash_revision: 1, expected_revision: 0, revision: 2 }
  expect(await profile.call('draft.stash.restore', transfer)).toMatchObject({
    outcome: 'conflict',
    draft: { text: 'window B work', revision: 1 },
  })
  const moved = await profile.call('draft.stash.restore', { ...transfer, expected_revision: 1 })
  expect(moved).toMatchObject({
    outcome: 'restored',
    draft: { text: 'review this', revision: 2, context_nodes: [node] },
  })
  await profile.restartDaemon('kill')
  expect(await draft(profile, conversationId, 'window-b')).toEqual({
    text: 'review this',
    revision: 2,
    attachments,
    context_nodes: [node],
  })
  // Window B's displaced draft is recallable; window A was not touched by the transfer.
  const history = await profile.call('draft.history.list', { conversation_id: conversationId, window_id: 'window-b' })
  expect(history.entries.map((entry) => entry.text)).toEqual(['window B work'])
  expect(await draft(profile, conversationId, 'window-a')).toEqual({ text: '', revision: 2 })

  // Too much context is refused before anything is written.
  const many = Array.from({ length: 65 }, (_, index) => ({ id: `n-${index}`, kind: 'file_range', data: {} }))
  await expect(profile.call('draft.save', { ...windowB, text: 'x', revision: 3, context_nodes: many })).rejects.toThrow(
    'Limit of 64 context nodes per draft',
  )
  expect((await draft(profile, conversationId, 'window-b')).revision).toBe(2)
})
