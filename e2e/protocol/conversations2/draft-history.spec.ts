// F036 with R001 and R002 for draft.history.*: history entries are recorded
// once however often the write that records them is retried, and a recall is
// keyed by the revisions the caller saw. The same recall converges after a
// lost reply, a reconnect and a daemon crash; an altered recall under the
// same revisions writes nothing.
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'

async function draft(profile: ScratchProfile, conversationId: string, windowId: string) {
  return (await profile.call('draft.get', { conversation_id: conversationId, window_id: windowId })).draft
}

async function history(profile: ScratchProfile, conversationId: string, windowId?: string) {
  return (await profile.call('draft.history.list', { conversation_id: conversationId,
    ...(windowId ? { window_id: windowId } : {}) })).entries
}

test('R001: a discard and a send are recorded in history once, whatever is retried around a daemon crash', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const owner = { conversation_id: conversationId, window_id: 'window-once' }
  await profile.call('draft.save', { ...owner, text: 'a thought to discard', revision: 1 })
  // Clearing the draft records it as discarded; the reply is lost and the daemon crashes.
  await sendAndLoseReply(profile, { op: 'draft.save', ...owner, text: '', revision: 2 })
  await expect.poll(async () => (await draft(profile, conversationId, 'window-once')).revision).toBe(2)
  await profile.restartDaemon('kill')
  // The retry converges and records nothing more.
  expect((await profile.call('draft.save', { ...owner, text: '', revision: 2 })).draft).toMatchObject({ text: '', revision: 2 })
  expect((await history(profile, conversationId)).map((entry) => [entry.kind, entry.text]))
    .toEqual([['discarded', 'a thought to discard']])

  // A sent draft: the completion reply is lost and the daemon crashes before the retry.
  await profile.call('draft.save', { ...owner, text: prompts.turn, revision: 3 })
  await profile.call('draft.send.prepare', { ...owner, request_id: 'history-send', draft_text: prompts.turn,
    text: prompts.turn, revision: 3, attachments: [] })
  await send(profile, conversationId, prompts.turn, 'history-send')
  await sendAndLoseReply(profile, { op: 'draft.send.complete', ...owner, request_id: 'history-send' })
  await expect.poll(async () => (await draft(profile, conversationId, 'window-once')).text).toBe('')
  await profile.restartDaemon('kill')
  await profile.call('draft.send.complete', { ...owner, request_id: 'history-send' })
  await waitForIdle(profile, conversationId)
  expect((await history(profile, conversationId)).map((entry) => [entry.kind, entry.text]))
    .toEqual([['sent', prompts.turn], ['discarded', 'a thought to discard']])

  // Paging reads the same entries after the crash, one per page.
  const first = await profile.call('draft.history.list', { conversation_id: conversationId, limit: 1 })
  expect(first.entries.map((entry) => entry.text)).toEqual([prompts.turn])
  expect(first.next_before).not.toBeNull()
  const second = await profile.call('draft.history.list', { conversation_id: conversationId, limit: 1,
    before: first.next_before! })
  expect(second.entries.map((entry) => entry.text)).toEqual(['a thought to discard'])
  expect(second.next_before).toBeNull()
})

test('R001 and R002: a recall converges after a lost reply and a crash; an altered recall under the same revisions writes nothing', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const owner = { conversation_id: conversationId, window_id: 'window-recall' }
  await profile.call('draft.save', { ...owner, text: 'first idea', revision: 1 })
  await profile.call('draft.save', { ...owner, text: '', revision: 2 })
  await profile.call('draft.save', { ...owner, text: 'second idea', revision: 3 })
  await profile.call('draft.save', { ...owner, text: '', revision: 4 })
  await profile.call('draft.save', { ...owner, text: 'typing now', revision: 5 })
  const entries = await history(profile, conversationId, 'window-recall')
  expect(entries.map((entry) => entry.text)).toEqual(['second idea', 'first idea'])
  const [second, first] = entries

  // Recall "first idea" over revision 5; the reply is lost and the daemon crashes.
  const recall = { ...owner, entry_id: first.id, expected_revision: 5, revision: 6 }
  await sendAndLoseReply(profile, { op: 'draft.history.restore', ...recall })
  await expect.poll(async () => (await draft(profile, conversationId, 'window-recall')).revision).toBe(6)
  await profile.restartDaemon('kill')
  const retried = await profile.call('draft.history.restore', recall)
  expect(retried).toMatchObject({ outcome: 'already_restored', draft: { text: 'first idea', revision: 6 },
    displaced_entry_id: null })
  const cli = await profile.cli('draft', 'recall', conversationId, String(first.id), '--window', 'window-recall',
    '--expected-revision', '5', '--revision', '6')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ outcome: 'already_restored' })
  // The displaced draft was kept exactly once.
  const afterRecall = await history(profile, conversationId, 'window-recall')
  expect(afterRecall.map((entry) => entry.text)).toEqual(['typing now', 'second idea', 'first idea'])

  // The same revisions with another entry is a different request: it writes nothing.
  const altered = await profile.call('draft.history.restore', { ...recall, entry_id: second.id })
  expect(altered).toMatchObject({ outcome: 'conflict', draft: { text: 'first idea', revision: 6 }, displaced_entry_id: null })
  const alteredCli = await profile.cli('draft', 'recall', conversationId, String(second.id), '--window', 'window-recall',
    '--expected-revision', '5', '--revision', '6')
  expect(alteredCli.code).not.toBe(0)
  expect(await draft(profile, conversationId, 'window-recall')).toMatchObject({ text: 'first idea', revision: 6 })
  expect(await history(profile, conversationId, 'window-recall')).toEqual(afterRecall)

  // An entry of another Conversation cannot be recalled here.
  const other = await startConversation(profile, 'codex')
  await expect(profile.call('draft.history.restore', { conversation_id: other.conversationId, window_id: 'window-recall',
    entry_id: first.id, expected_revision: 0, revision: 1 })).rejects.toThrow(/unavailable/)
  expect(await draft(profile, other.conversationId, 'window-recall')).toMatchObject({ text: '', revision: 0 })
})
