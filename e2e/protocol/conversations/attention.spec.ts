// Conversation attention and unread state (daemon authority ticket 03): the
// daemon reports whether a Conversation needs the person, and whether it
// changed since the profile last marked it seen, in the catalog, the feed and
// every reply; `conversation.mark_seen` clears unread. Orchestration children
// carry their parent and group links on the catalog record.
import {
  answerFor,
  answerIntent,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  waitForPendingRequest,
  type ScratchProfile,
} from '../fixtures'
import { cancelActiveSubmission } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { opId, parentIn, waitForChild } from '../orchestration/steps'

async function listed(profile: ScratchProfile, id: string) {
  const { catalog } = await profile.call('catalog.get', {})
  return catalog.conversations.find((conversation) => conversation.id === id)
}

async function attention(profile: ScratchProfile, id: string) {
  return (await profile.call('conversation.get', { conversation_id: id })).conversation.attention
}

test('attention and unread follow a real turn, an open approval and mark_seen', async ({ profile, repo }) => {
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  // A new Conversation is idle and read.
  expect(await listed(profile, conversationId)).toMatchObject({ attention: 'idle', unread: false })
  const feed = await subscribeFeed(profile)
  await feed.connected()

  // An open approval needs the person; answering it lets the turn finish.
  await send(profile, conversationId, prompts.approval)
  const approval = await waitForPendingRequest(profile, conversationId)
  expect(await attention(profile, conversationId)).toBe('needs_you')
  expect((await listed(profile, conversationId))?.attention).toBe('needs_you')
  await profile.call('agent.answer', answerIntent(approval, answerFor(approval, 'decline')))
  await waitForIdle(profile, conversationId)
  expect(await attention(profile, conversationId)).toBe('idle')

  // The turn changed it after it was seen; marking it seen clears that.
  expect((await listed(profile, conversationId))?.unread).toBe(true)
  const seen = await profile.cli('conversation', 'mark-seen', conversationId)
  expect(seen.code, seen.stderr).toBe(0)
  expect(seen.json).toMatchObject({ type: 'ack' })
  await feed.waitFor(
    (frame) =>
      frame.type === 'conversation_changed' &&
      frame.conversation.id === conversationId &&
      frame.conversation.unread === false,
  )
  expect((await listed(profile, conversationId))?.unread).toBe(false)
  // The SDK's catalog keeps both fields from the feed.
  expect(feed.client.getState().catalog!.conversations.find((item) => item.id === conversationId)).toMatchObject({
    attention: 'idle',
    unread: false,
  })

  // Marking seen is idempotent and survives a restart; an old time never wins.
  await profile.call('conversation.mark_seen', { conversation_id: conversationId })
  await profile.call('conversation.mark_seen', { conversation_id: conversationId, through: 0 })
  feed.stop()
  await profile.restartDaemon('graceful')
  expect((await listed(profile, conversationId))?.unread).toBe(false)

  // A running turn is running, in replies and the feed.
  const again = await subscribeFeed(profile)
  await again.connected()
  await send(profile, conversationId, prompts.hold)
  await expect.poll(() => attention(profile, conversationId)).toBe('running')
  await again.waitFor(
    (frame) =>
      frame.type === 'conversation_changed' &&
      frame.conversation.id === conversationId &&
      frame.conversation.attention === 'running',
  )
  again.stop()
  await cancelActiveSubmission(profile, conversationId)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .not.toMatch(/^(starting|running|waiting|cancelling)$/)

  // A disconnected Agent is an error to look at.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await expect.poll(() => attention(profile, conversationId)).toBe('error')
})

test('a delegated child lists its parent, and a group run its group', async ({ profile, repo }) => {
  const { parent } = await parentIn(profile, repo.path)
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: 'codex',
    account: { mode: 'inherit' },
    workspace: { mode: 'same' },
    task: prompts.turn,
    title: 'Child task',
  })
  expect(await listed(profile, child.child_conversation_id)).toMatchObject({
    parent_conversation_id: parent,
    group_id: null,
  })
  expect(await listed(profile, parent)).toMatchObject({ parent_conversation_id: null, group_id: null })
  // The child's work is news to the person until it is seen.
  await waitForChild(profile, child.child_conversation_id, 'settled', { outcome: 'completed' })
  expect((await listed(profile, child.child_conversation_id))?.unread).toBe(true)

  const { group } = await profile.call('orchestration.group.start', {
    operation_id: opId('group'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    task: prompts.turn,
    runs: [
      { provider: 'codex', account: { mode: 'inherit' }, workspace: { mode: 'same' } },
      { provider: 'claude', account: { mode: 'ambient' }, workspace: { mode: 'same' } },
    ],
  })
  const { catalog } = await profile.call('catalog.get', {})
  const runs = catalog.conversations.filter((conversation) => conversation.group_id === group.group_id)
  expect(runs).toHaveLength(2)
  for (const run of runs) expect(run.parent_conversation_id).toBe(parent)
})
