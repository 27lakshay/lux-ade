// F041 and F043: combined history and work search over the daemon's
// asynchronous full-text index, which states its lag and catches up after a
// daemon crash from its durable journal.
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

/** An index status is never reported caught up while work is outstanding. */
function expectHonestStatus(index: any): void {
  if (index.caught_up) expect(index).toMatchObject({ pending_changes: 0, rebuilding: false })
}

async function searchUntil(profile: ScratchProfile, request: Record<string, unknown>, count: number): Promise<any> {
  let reply: any
  await expect.poll(async () => {
    reply = await call(profile, 'history.search', request)
    expectHonestStatus(reply.index)
    return reply.results.length
  }).toBe(count)
  return reply
}

test('searches Codex and Claude history together and each hit opens the message it names', async ({ profile }) => {
  const codex = await startConversation(profile, 'codex')
  const claude = await startConversation(profile, 'claude')
  await turn(profile, codex.conversationId, 'investigate the marmoset scheduler')
  await turn(profile, claude.conversationId, 'document the marmoset scheduler')

  const both = await searchUntil(profile, { query: 'marmoset scheduler' }, 2)
  expect(both.results.map((hit: any) => hit.provenance.provider).sort()).toEqual(['claude', 'codex'])
  for (const hit of both.results) {
    expect(hit).toMatchObject({ role: 'user', kind: expect.any(String), has_review_feedback: false })
    expect(hit.excerpt).toMatch(/marmoset/)
    // The hit names a conversation and message that open to the same text.
    const snapshot = await profile.call('conversation.get', { conversation_id: hit.provenance.conversation_id })
    const message = snapshot.messages.find((entry) => (entry as { id?: string }).id === hit.message_id) as { text?: string } | undefined
    expect(message?.text).toContain('marmoset')
    expect(hit.provenance.workspace_id).toBe(snapshot.conversation.workspace_id)
    expect(hit.provenance.import).toBeUndefined()
  }
  // Each provider keeps its own native session reference; nothing implies one continues the other.
  const natives = both.results.map((hit: any) => hit.provenance.native_session_id)
  expect(natives.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(natives).size).toBe(2)

  const onlyClaude = await call(profile, 'history.search', { query: 'marmoset', provider: 'claude' })
  expect(onlyClaude.results.map((hit: any) => hit.provenance.conversation_id)).toEqual([claude.conversationId])
  const inConversation = await call(profile, 'history.search', { query: 'marmoset', conversation_id: codex.conversationId })
  expect(inConversation.results).toHaveLength(1)
  // Assistant replies are indexed too, by their final text.
  await searchUntil(profile, { query: 'hello world', provider: 'codex' }, 1)
  // A prefix term matches; operators are literal, so this finds nothing rather than failing.
  await searchUntil(profile, { query: 'marmo*' }, 2)
  expect((await call(profile, 'history.search', { query: 'marmoset OR NEAR(' })).results).toEqual([])

  const listed = await call(profile, 'history.list', {})
  const ids = listed.conversations.map((entry: any) => entry.provenance.conversation_id)
  expect(ids).toEqual(expect.arrayContaining([codex.conversationId, claude.conversationId]))
  for (const entry of listed.conversations) expect(entry.message_count).toBeGreaterThanOrEqual(2)

  await expect(call(profile, 'history.search', { query: 'marmoset', workspace_id: 'workspace_missing' })).rejects.toThrow()
  const cli = await profile.cli('history', 'search', 'marmoset')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'history_search' })
})

test('pages results with a cursor that a rebuild expires', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  for (let index = 0; index < 3; index++) await turn(profile, conversationId, `capybara note ${index}`)
  await searchUntil(profile, { query: 'capybara' }, 3)

  const page = await call(profile, 'history.search', { query: 'capybara', limit: 2 })
  expect(page.results).toHaveLength(2)
  expect(page.next_cursor).toBeTruthy()
  const rest = await call(profile, 'history.search', { query: 'capybara', limit: 2, cursor: page.next_cursor })
  expect(rest.results).toHaveLength(1)
  const seen = [...page.results, ...rest.results].map((hit: any) => hit.message_id)
  expect(new Set(seen).size).toBe(3)

  const epoch = page.index.epoch
  const rebuilt = await call(profile, 'history.index.rebuild', { expected_epoch: epoch })
  expect(rebuilt.index.epoch).toBe(epoch + 1)
  // A repeated rebuild request for the old epoch converges instead of starting again.
  const repeated = await call(profile, 'history.index.rebuild', { expected_epoch: epoch })
  expect(repeated.index.epoch).toBe(epoch + 1)
  await expect(call(profile, 'history.search', { query: 'capybara', limit: 2, cursor: page.next_cursor }))
    .rejects.toThrow(/expired/)
  await searchUntil(profile, { query: 'capybara' }, 3)
  await expect.poll(async () => (await call(profile, 'history.index.status', {})).index)
    .toMatchObject({ epoch: epoch + 1, rebuilding: false, pending_changes: 0, caught_up: true })
})

test('catches up after a daemon kill without losing or duplicating indexed messages', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await turn(profile, conversationId, 'okapi before the crash')
  await searchUntil(profile, { query: 'okapi' }, 1)

  // Messages committed just before the kill may not have reached the index yet.
  for (let index = 0; index < 4; index++) await turn(profile, conversationId, `okapi burst ${index}`)
  await profile.restartDaemon('kill')

  const after = await searchUntil(profile, { query: 'okapi' }, 5)
  expect(new Set(after.results.map((hit: any) => hit.message_id)).size).toBe(5)
  await expect.poll(async () => (await call(profile, 'history.index.status', {})).index)
    .toMatchObject({ rebuilding: false, pending_changes: 0, caught_up: true, last_error: null })

  // A turn sent right before a kill is indexed once the new daemon has it.
  await send(profile, conversationId, 'okapi in flight')
  await profile.restartDaemon('kill')
  await waitForIdle(profile, conversationId)
  const final = await searchUntil(profile, { query: 'okapi' }, 6)
  expect(new Set(final.results.map((hit: any) => hit.message_id)).size).toBe(6)
  await searchUntil(profile, { query: 'hello world', conversation_id: conversationId }, 6)
})

// F043 asks that deleted records leave the results. Search joins live
// messages, but no operation deletes a message or a conversation yet (rewind
// removes none in this build), so a deletion cannot be driven end to end.
test.fixme('a deleted conversation disappears from search results', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await turn(profile, conversationId, 'pangolin notes')
  await searchUntil(profile, { query: 'pangolin' }, 1)
  await profile.rpc({ op: 'conversation.delete', conversation_id: conversationId })
  await searchUntil(profile, { query: 'pangolin' }, 0)
})
