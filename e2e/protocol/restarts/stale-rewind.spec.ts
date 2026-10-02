// R011: late results cannot resurrect or cross-associate data after a rewind.
// A snapshot, a search reply, an older page and a search cursor are each read
// before a Claude conversation rewind and used after it. A rewind deletes the
// later messages, and the next turn reuses their sequence numbers, so a late
// result that is trusted by position would show another message. The same
// late results are also used after a conversation delete. The profile switch
// half of R011 is in `reliability-b/stale-results.spec.ts`.
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { openConversationView } from '../fixtures/sync-view'

type Message = { id: string; role: string; text: string; sequence: number; turn_id: string | null }
const removedWords = ['quokkaflux', 'lemurmint']

async function messages(profile: ScratchProfile, conversationId: string): Promise<Message[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId, limit: 32 })).messages
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

async function hits(profile: ScratchProfile, query: string): Promise<number> {
  return (await profile.call('history.search', { query, limit: 50 })).results.length
}

/** A Claude conversation with three turns, rewound to before the second one. */
async function threeTurns(profile: ScratchProfile) {
  const { conversationId } = await startConversation(profile, 'claude')
  await turn(profile, conversationId, 'first zebracorn')
  await turn(profile, conversationId, 'second quokkaflux')
  await turn(profile, conversationId, 'third lemurmint')
  const all = await messages(profile, conversationId)
  expect(all.map((message) => message.text)).toEqual([
    'first zebracorn',
    'Hello Claude',
    'second quokkaflux',
    'Hello Claude',
    'third lemurmint',
    'Hello Claude',
  ])
  const rewind = async (operationId: string) => {
    const second = all[2]
    const preview = await profile.call('conversation.rewind.preview', {
      conversation_id: conversationId,
      scope: 'conversation',
      before_message_id: second.id,
    })
    const reply = await profile.call('conversation.rewind', {
      operation_id: operationId,
      conversation_id: conversationId,
      scope: 'conversation',
      before_message_id: second.id,
      expected_state: preview.history!.state_token,
    })
    expect(reply).toMatchObject({ outcome: 'acknowledged', history: { removed_messages: 4, history_epoch: 1 } })
  }
  return { conversationId, all, rewind }
}

test('R011: a snapshot delayed across a rewind never shows the removed turns as current', async ({ profile }) => {
  test.setTimeout(90_000)
  const { conversationId, all, rewind } = await threeTurns(profile)
  const view = await openConversationView(profile, conversationId)
  try {
    await view.settle((snapshot) => snapshot.messages.length === 6)
    // The connection drops and the frames move on, so the reconnected view needs a new snapshot.
    view.detach()
    await startConversation(profile, 'codex')
    const held = view.holdNextSnapshot()
    await view.attach(profile)
    const late = await held.read
    expect(late.messages.map((message) => message.id)).toEqual(all.map((message) => message.id))

    // The rewind lands while that snapshot reply is still on its way.
    await rewind('rewind-late-snapshot')
    await expect
      .poll(() =>
        view.forwarded.some(
          (frame) =>
            frame.type === 'conversation_reload' && (frame.conversation as { id: string }).id === conversationId,
        ),
      )
      .toBe(true)
    const beforeRelease = view.states.length
    held.release()

    const shown = await view.settle((snapshot) => snapshot.messages.length === 2)
    expect(shown.messages.map((message) => message.text)).toEqual(['first zebracorn', 'Hello Claude'])
    expect((shown as unknown as { history_epoch: number }).history_epoch).toBe(1)
    // The late snapshot was only ever shown as stale, never as the current view.
    const after = view.states.slice(beforeRelease)
    for (const { state } of after) {
      if (state.status === 'current') {
        expect(JSON.stringify(state.snapshot!.messages)).not.toMatch(new RegExp(removedWords.join('|')))
      }
    }

    // The next turn reuses the removed sequence numbers; the view holds the new messages, not the old ones.
    await turn(profile, conversationId, 'fourth ocelotwave')
    const settled = await view.settle((snapshot) => snapshot.messages.length === 4)
    expect(settled.messages.map((message) => message.text)).toEqual([
      'first zebracorn',
      'Hello Claude',
      'fourth ocelotwave',
      'Hello Claude',
    ])
    expect(settled.messages.map((message) => message.id)).toEqual(
      (await messages(profile, conversationId)).map((message) => message.id),
    )
  } finally {
    view.dispose()
  }
})

test('R011: a search reply, an older page and a search cursor read before a rewind cannot resurrect or cross-associate', async ({
  profile,
}) => {
  test.setTimeout(90_000)
  const { conversationId, all, rewind } = await threeTurns(profile)
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)
  await expect.poll(() => hits(profile, 'Claude')).toBe(3)

  // Replies the caller holds while the rewind runs.
  const lateSearch = await profile.call('history.search', { query: 'quokkaflux', limit: 50 })
  const [lateMatch] = lateSearch.results
  expect(lateMatch).toMatchObject({
    message_id: all[2].id,
    sequence: all[2].sequence,
    history_epoch: 0,
    provenance: { conversation_id: conversationId },
  })
  const newestReply = await profile.call('history.search', { query: 'Claude', limit: 1 })
  expect(newestReply.results[0].message_id).toBe(all[5].id)
  expect(newestReply.next_cursor).toBeTruthy()
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 2 })
  const olderPage = {
    conversation_id: conversationId,
    before: page.messages[0].sequence,
    limit: 32,
    history_epoch: page.history_epoch,
  }

  await rewind('rewind-late-search')
  // The next turn takes the removed prompt's sequence number, with another message.
  await turn(profile, conversationId, 'fourth ocelotwave')
  const now = await messages(profile, conversationId)
  const reused = now.find((message) => message.sequence === lateMatch.sequence)!
  expect(reused.text).toBe('fourth ocelotwave')
  expect(reused.id).not.toBe(lateMatch.message_id)

  // Opening the late match at its position is refused rather than landing on the new message.
  await expect(
    profile.call('conversation.get', {
      conversation_id: conversationId,
      before: lateMatch.sequence + 1,
      limit: 1,
      history_epoch: lateMatch.history_epoch,
    }),
  ).rejects.toThrow(/History changed since that page was read/)
  // Its message is gone by ID too, so nothing resurrects it.
  expect(now.map((message) => message.id)).not.toContain(lateMatch.message_id)
  // A fresh match for the new text carries the new epoch and opens on the new message.
  await expect.poll(() => hits(profile, 'ocelotwave')).toBe(1)
  const fresh = (await profile.call('history.search', { query: 'ocelotwave', limit: 50 })).results[0]
  expect(fresh).toMatchObject({ message_id: reused.id, sequence: reused.sequence, history_epoch: 1 })
  const opened = await profile.call('conversation.get', {
    conversation_id: conversationId,
    before: fresh.sequence + 1,
    limit: 1,
    history_epoch: fresh.history_epoch,
  })
  expect(opened.messages.map((message) => message.id)).toEqual([reused.id])

  // An older page read before the rewind is refused.
  await expect(profile.call('conversation.get', olderPage)).rejects.toThrow(/History changed since that page was read/)

  // The search cursor from before the rewind pages only messages that still exist.
  const rest = await profile.call('history.search', { query: 'Claude', limit: 50, cursor: newestReply.next_cursor! })
  expect(rest.results.map((match) => match.message_id)).toEqual([all[1].id])
  expect(rest.results.every((match) => match.history_epoch === 1)).toBe(true)
  for (const word of removedWords) expect(await hits(profile, word)).toBe(0)
})

// The delete half of R011: a snapshot, a search reply, an older page and a
// search cursor read before `conversation.delete` and used after it. The
// deletion leaves a tombstone, so a late result is refused or empty, never a
// view of the deleted Conversation.
test('R011: a result delayed across a conversation delete cannot resurrect it', async ({ profile }) => {
  test.setTimeout(90_000)
  const { conversationId, all } = await threeTurns(profile)
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)
  await expect.poll(() => hits(profile, 'Claude')).toBe(3)

  // Replies the caller holds while the deletion runs.
  const [lateMatch] = (await profile.call('history.search', { query: 'quokkaflux', limit: 50 })).results
  expect(lateMatch).toMatchObject({ message_id: all[2].id, provenance: { conversation_id: conversationId } })
  const newestReply = await profile.call('history.search', { query: 'Claude', limit: 1 })
  expect(newestReply.next_cursor).toBeTruthy()
  const page = await profile.call('conversation.get', { conversation_id: conversationId, limit: 2 })
  const olderPage = {
    conversation_id: conversationId,
    before: page.messages[0].sequence,
    limit: 32,
    history_epoch: page.history_epoch,
  }

  const view = await openConversationView(profile, conversationId)
  try {
    await view.settle((snapshot) => snapshot.messages.length === 6)
    // The connection drops and the frames move on, so the reconnected view needs a new snapshot.
    view.detach()
    await startConversation(profile, 'codex')
    const held = view.holdNextSnapshot()
    await view.attach(profile)
    const late = await held.read
    expect(late.messages.map((message) => message.id)).toEqual(all.map((message) => message.id))

    // The deletion lands while that snapshot reply is still on its way.
    await profile.call('conversation.delete', { operation_id: 'delete-late-results', conversation_id: conversationId })
    await expect
      .poll(() =>
        view.forwarded.some(
          (frame) => frame.type === 'conversation_deleted' && frame.conversation_id === conversationId,
        ),
      )
      .toBe(true)
    const beforeRelease = view.states.length
    held.release()
    await expect.poll(() => view.latest()?.status).toBe('deleted')
    expect(view.latest()).toEqual({
      status: 'deleted',
      snapshot: null,
      error: `Conversation ${conversationId} was deleted`,
    })
    // The late snapshot was never shown as the current view, and nothing loads again.
    expect(view.states.slice(beforeRelease).some(({ state }) => state.status === 'current')).toBe(false)
    const fetches = view.fetches()
    await turn(profile, (await startConversation(profile, 'claude')).conversationId, 'unrelated turn')
    expect(view.fetches()).toBe(fetches)
    expect(view.latest()?.status).toBe('deleted')
  } finally {
    view.dispose()
  }

  // Opening the late match, or the older page, is refused as deleted.
  const deleted = new RegExp(`Conversation ${conversationId} was deleted`)
  await expect(
    profile.call('conversation.get', {
      conversation_id: conversationId,
      before: lateMatch.sequence + 1,
      limit: 1,
      history_epoch: lateMatch.history_epoch,
    }),
  ).rejects.toThrow(deleted)
  await expect(profile.call('conversation.get', olderPage)).rejects.toThrow(deleted)
  // The search cursor from before the deletion pages nothing of it, and no word of it is found.
  const rest = await profile.call('history.search', { query: 'Claude', limit: 50, cursor: newestReply.next_cursor! })
  expect(rest.results.filter((match) => match.provenance.conversation_id === conversationId)).toEqual([])
  for (const word of ['zebracorn', ...removedWords]) expect(await hits(profile, word)).toBe(0)

  // A new Conversation with the same words is found under its own identity only.
  const again = (await startConversation(profile, 'claude')).conversationId
  await turn(profile, again, 'second quokkaflux')
  await expect.poll(() => hits(profile, 'quokkaflux')).toBe(1)
  const fresh = (await profile.call('history.search', { query: 'quokkaflux', limit: 50 })).results[0]
  expect(fresh.provenance.conversation_id).toBe(again)
  expect(fresh.message_id).not.toBe(lateMatch.message_id)
})
