// F036 with R001 and R002: drafts belong to a Conversation and a window and
// survive a crashed window and a crashed daemon. Recall and stash write only
// over the revision the caller saw; a newer draft is never overwritten.
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function draft(profile: ScratchProfile, conversationId: string, windowId: string) {
  return (await profile.call('draft.get', { conversation_id: conversationId, window_id: windowId })).draft
}

test('F036: a draft survives a crashed window and a crashed daemon, and an older write never overwrites it', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const owner = { conversation_id: conversationId, window_id: 'window-crashed' }
  await profile.call('draft.save', { ...owner, text: 'first thought', revision: 1 })
  await profile.call('draft.save', { ...owner, text: 'first thought, refined', revision: 2 })
  // A late write from before the crash carries an older revision and changes nothing.
  expect((await profile.call('draft.save', { ...owner, text: 'stale', revision: 1 })).draft).toMatchObject({
    text: 'first thought, refined',
    revision: 2,
  })
  // The window never closed cleanly; the daemon crashes as well.
  await profile.restartDaemon('kill')
  expect(await draft(profile, conversationId, 'window-crashed')).toMatchObject({
    text: 'first thought, refined',
    revision: 2,
  })
  // Another window of the same Conversation has its own draft.
  expect(await draft(profile, conversationId, 'window-other')).toMatchObject({ text: '', revision: 0 })
  // An explicit conflict resolution applies only over the revision it reviewed.
  expect(
    (await profile.call('draft.save', { ...owner, text: 'resolved', revision: 3, expected_revision: 1 })).draft,
  ).toMatchObject({ text: 'first thought, refined', revision: 2 })
  expect(
    (await profile.call('draft.save', { ...owner, text: 'resolved', revision: 3, expected_revision: 2 })).draft,
  ).toMatchObject({ text: 'resolved', revision: 3 })
})

test('F036: sent and discarded drafts can be recalled only over the revision the caller saw', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const owner = { conversation_id: conversationId, window_id: 'window-recall' }
  // Send one draft through the send intent.
  await profile.call('draft.save', { ...owner, text: prompts.turn, revision: 1 })
  await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'recall-send',
    draft_text: prompts.turn,
    text: prompts.turn,
    revision: 1,
    attachments: [],
  })
  await send(profile, conversationId, prompts.turn, 'recall-send')
  expect((await profile.call('draft.send.complete', { ...owner, request_id: 'recall-send' })).draft).toMatchObject({
    text: '',
    revision: 2,
  })
  await waitForIdle(profile, conversationId)
  // Type, then clear: the cleared text is kept as discarded.
  await profile.call('draft.save', { ...owner, text: 'an idea I deleted', revision: 3 })
  await profile.call('draft.save', { ...owner, text: '', revision: 4 })
  await profile.restartDaemon()

  const history = await profile.call('draft.history.list', { conversation_id: conversationId })
  expect(history.entries.map((entry) => [entry.kind, entry.text])).toEqual([
    ['discarded', 'an idea I deleted'],
    ['sent', prompts.turn],
  ])
  const cli = await profile.cli('draft', 'history', conversationId, '--window', 'window-recall')
  expect(cli.code).toBe(0)
  expect(JSON.stringify(cli.json)).toContain('an idea I deleted')

  const discarded = history.entries[0]
  const recall = { ...owner, entry_id: discarded.id, expected_revision: 4, revision: 5 }
  // Another write lands first: the recall writes nothing and returns the newer draft.
  await profile.call('draft.save', { ...owner, text: 'typed meanwhile', revision: 5 })
  expect(await profile.call('draft.history.restore', recall)).toMatchObject({
    outcome: 'conflict',
    draft: { text: 'typed meanwhile', revision: 5 },
  })
  expect(await draft(profile, conversationId, 'window-recall')).toMatchObject({ text: 'typed meanwhile', revision: 5 })
  const cliConflict = await profile.cli(
    'draft',
    'recall',
    conversationId,
    String(discarded.id),
    '--window',
    'window-recall',
    '--expected-revision',
    '4',
    '--revision',
    '5',
  )
  expect(cliConflict.code).not.toBe(0)

  // Against the revision it saw, the recall lands and keeps the displaced draft in history.
  const restored = await profile.call('draft.history.restore', { ...recall, expected_revision: 5, revision: 6 })
  expect(restored).toMatchObject({ outcome: 'restored', draft: { text: 'an idea I deleted', revision: 6 } })
  expect(restored.displaced_entry_id).not.toBeNull()
  // A retry after a lost reply converges.
  expect(await profile.call('draft.history.restore', { ...recall, expected_revision: 5, revision: 6 })).toMatchObject({
    outcome: 'already_restored',
    draft: { text: 'an idea I deleted', revision: 6 },
  })
  const after = await profile.call('draft.history.list', {
    conversation_id: conversationId,
    window_id: 'window-recall',
  })
  expect(after.entries.map((entry) => entry.text)).toContain('typed meanwhile')
})

test('F036: a stash keeps text and context, transfers a draft between windows, and refuses stale revisions', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const context = [{ id: 'node-1', kind: 'terminal_selection', data: { text: 'npm test failed', terminal: 'term-1' } }]
  const stash = {
    conversation_id: conversationId,
    window_id: 'window-a',
    name: 'review notes',
    text: 'check the failing test',
    attachments: [],
    context_nodes: context,
  }
  const created = await profile.call('draft.stash.save', stash)
  expect(created).toMatchObject({
    outcome: 'created',
    stash: { revision: 1, text: stash.text, context_nodes: context },
  })
  // The same content converges; a replacement needs the revision it replaces.
  expect(await profile.call('draft.stash.save', stash)).toMatchObject({ outcome: 'unchanged', stash: { revision: 1 } })
  await expect(profile.call('draft.stash.save', { ...stash, text: 'other text' })).rejects.toThrow(
    /changed since it was listed/,
  )
  const replaced = await profile.call('draft.stash.save', {
    ...stash,
    text: 'check the failing test twice',
    expected_revision: 1,
  })
  expect(replaced).toMatchObject({ outcome: 'replaced', stash: { revision: 2 } })
  await expect(
    profile.call('draft.stash.save', { ...stash, text: 'a third text', expected_revision: 1 }),
  ).rejects.toThrow(/changed since it was listed/)

  await profile.restartDaemon('kill')
  const listed = await profile.call('draft.stash.list', { conversation_id: conversationId })
  expect(listed.stashes).toEqual([
    expect.objectContaining({ name: 'review notes', revision: 2, context_nodes: context }),
  ])

  // Transfer explicitly into window B. Its own draft moved on, so the first try writes nothing.
  const windowB = { conversation_id: conversationId, window_id: 'window-b' }
  await profile.call('draft.save', { ...windowB, text: 'window B draft', revision: 1 })
  const restore = { ...windowB, name: 'review notes', stash_revision: 2, expected_revision: 0, revision: 2 }
  expect(await profile.call('draft.stash.restore', restore)).toMatchObject({
    outcome: 'conflict',
    draft: { text: 'window B draft', revision: 1 },
  })
  await expect(
    profile.call('draft.stash.restore', { ...restore, stash_revision: 1, expected_revision: 1 }),
  ).rejects.toThrow(/changed since it was listed/)
  const moved = await profile.call('draft.stash.restore', { ...restore, expected_revision: 1 })
  expect(moved).toMatchObject({
    outcome: 'restored',
    draft: { text: 'check the failing test twice', revision: 2 },
    context_nodes: context,
  })
  expect(moved.displaced_entry_id).not.toBeNull()
  expect(await profile.call('draft.stash.restore', { ...restore, expected_revision: 1 })).toMatchObject({
    outcome: 'already_restored',
  })
  // Window A keeps its own draft; the transfer did not touch it.
  expect(await draft(profile, conversationId, 'window-a')).toMatchObject({ text: '', revision: 0 })

  // Drop: a stale revision is refused, the listed one drops, and a repeat converges.
  await expect(
    profile.call('draft.stash.drop', { conversation_id: conversationId, name: 'review notes', stash_revision: 1 }),
  ).rejects.toThrow(/changed since it was listed/)
  const drop = { conversation_id: conversationId, name: 'review notes', stash_revision: 2 }
  expect(await profile.call('draft.stash.drop', drop)).toMatchObject({ dropped: true })
  expect(await profile.call('draft.stash.drop', drop)).toMatchObject({ dropped: false })
  expect((await profile.call('draft.stash.list', { conversation_id: conversationId })).stashes).toEqual([])
})

// The live draft keeps its context nodes beside the text, at the revision that
// saved them (e2e/protocol/context/drafts.spec.ts covers recall and transfer).
test('F036: a live draft restores its context nodes after a window crash', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const context = [{ id: 'node-1', kind: 'diff_selection', data: { path: 'README.md' } }]
  await profile.rpc({
    op: 'draft.save',
    conversation_id: conversationId,
    window_id: 'window-context',
    text: 'with context',
    revision: 1,
    context_nodes: context,
  })
  await profile.restartDaemon('kill')
  const reply = await profile.rpc({ op: 'draft.get', conversation_id: conversationId, window_id: 'window-context' })
  expect(reply).toMatchObject({ draft: { text: 'with context', context_nodes: context } })
})

test('F036: a draft with a pending send cannot be edited or replaced until the send resolves', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const owner = { conversation_id: conversationId, window_id: 'window-pending' }
  await profile.call('draft.save', { ...owner, text: prompts.turn, revision: 1 })
  await profile.call('draft.stash.save', {
    ...owner,
    name: 'saved',
    text: 'saved text',
    attachments: [],
    context_nodes: [],
  })
  await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'pending-send',
    draft_text: prompts.turn,
    text: prompts.turn,
    revision: 1,
    attachments: [],
  })
  await expect(profile.call('draft.save', { ...owner, text: 'edit', revision: 2 })).rejects.toThrow(/pending send/)
  await expect(
    profile.call('draft.stash.restore', {
      ...owner,
      name: 'saved',
      stash_revision: 1,
      expected_revision: 1,
      revision: 2,
    }),
  ).rejects.toThrow(/pending send/)
  await sendAndLoseReply(profile, {
    op: 'agent.send',
    conversation_id: conversationId,
    request_id: 'pending-send',
    text: prompts.turn,
  })
  await waitForIdle(profile, conversationId)
  await expect
    .poll(async () =>
      (await profile.call('conversation.get', { conversation_id: conversationId })).messages.some(
        (message) => message.id === 'pending-send',
      ),
    )
    .toBe(true)
  await profile.call('draft.send.complete', { ...owner, request_id: 'pending-send' })
  expect(
    await profile.call('draft.stash.restore', {
      ...owner,
      name: 'saved',
      stash_revision: 1,
      expected_revision: 2,
      revision: 3,
    }),
  ).toMatchObject({ outcome: 'restored', draft: { text: 'saved text', revision: 3 } })
})

test('F036: the CLI reads and saves a window draft, and an older revision changes nothing', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const window = ['--window', 'cli-window']
  const saved = await profile.cli(
    'draft',
    'save',
    conversationId,
    ...window,
    '--text',
    'from the CLI',
    '--revision',
    '2',
  )
  expect(saved.code, saved.stderr).toBe(0)
  expect(saved.json).toMatchObject({ type: 'draft', draft: { text: 'from the CLI', revision: 2 } })
  const stale = await profile.cli('draft', 'save', conversationId, ...window, '--text', 'stale', '--revision', '1')
  expect(stale.json).toMatchObject({ draft: { text: 'from the CLI', revision: 2 } })
  expect((await profile.cli('draft', 'get', conversationId, ...window)).json).toMatchObject({
    draft: { text: 'from the CLI', revision: 2 },
  })
  expect(await draft(profile, conversationId, 'cli-window')).toMatchObject({ text: 'from the CLI', revision: 2 })
  expect((await profile.cli('draft', 'get', conversationId)).code).toBe(2)
})
