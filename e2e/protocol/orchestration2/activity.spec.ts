// F117, F114 (backend) and 10-S03: activity cursors stay valid across daemon
// restarts and crashes, a client that missed frames catches up from its
// cursor exactly once, child activity names its origin and resolves to the
// child and its parent, notification preferences and snoozes suppress
// delivery, and one activity has one delivery record however many clients
// race for it.
import {
  cancelActiveSubmission,
  expect,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  type ScratchProfile,
} from '../fixtures'
import { defineFailingAgent } from '../fixtures/failing-agent'
import { subscribeFeed } from '../fixtures/feed'
import { delegate, parentIn, waitForChild } from './steps'

type Activity = {
  id: string
  sequence: number
  kind: string
  state: string
  title: string
  target: { conversation_id: string; workspace_id: string; request_id: string | null; turn_id: string | null }
}

async function activities(profile: ScratchProfile, request: Record<string, unknown> = {}): Promise<Activity[]> {
  return (await profile.call('activity.list', { limit: 200, include_dismissed: true, ...request })).activities
}

async function completedTurns(profile: ScratchProfile, conversationId: string, count: number): Promise<void> {
  const before = (await activities(profile)).filter((item) => item.target.conversation_id === conversationId).length
  for (let turn = 1; turn <= count; turn++) {
    await send(profile, conversationId, prompts.turn)
    await expect
      .poll(
        async () => (await activities(profile)).filter((item) => item.target.conversation_id === conversationId).length,
      )
      .toBe(before + turn)
    await waitForIdle(profile, conversationId)
  }
}

function claim(profile: ScratchProfile, activity: string, client: string) {
  return profile.call('notification.delivery.claim', { activity_id: activity, channel: 'desktop', client_id: client })
}

test('activity cursors stay valid across a restart and a crash: catch-up returns only newer activity, in order (10-S03)', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 2)
  const first = await profile.call('activity.list', {})
  const cursor = first.latest_sequence
  expect(first.activities).toHaveLength(2)

  for (const mode of ['kill', 'graceful'] as const) {
    await profile.restartDaemon(mode)
    // Nothing new was recorded, so the cursor is still the newest position.
    const unchanged = await profile.call('activity.list', { after: cursor })
    expect(unchanged).toMatchObject({ activities: [], next_cursor: null, latest_sequence: cursor })
    expect((await profile.call('activity.list', { before: cursor + 1 })).activities.map((item) => item.id)).toEqual(
      first.activities.map((item) => item.id),
    )
  }

  await completedTurns(profile, conversationId, 2)
  const caughtUp = await profile.call('activity.list', { after: cursor, limit: 1 })
  expect(caughtUp.activities).toHaveLength(1)
  expect(caughtUp.activities[0].sequence).toBeGreaterThan(cursor)
  const rest = await profile.call('activity.list', { after: caughtUp.next_cursor ?? 0 })
  expect(rest.activities).toHaveLength(1)
  expect(rest.next_cursor).toBeNull()
  const newer = [...caughtUp.activities, ...rest.activities]
  expect(newer.map((item) => item.sequence)).toEqual(newer.map((item) => item.sequence).sort((a, b) => a - b))
  expect(new Set([...first.activities, ...newer].map((item) => item.id)).size).toBe(4)

  // A crash after that keeps every sequence and the newest position.
  await profile.restartDaemon('kill')
  const after = await profile.call('activity.list', { after: cursor })
  expect(after.activities.map((item) => item.id)).toEqual(newer.map((item) => item.id))
  expect(after.latest_sequence).toBe(newer[1].sequence)
})

test('a client that was away while activity was recorded catches up from its cursor once, then follows the feed', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 1)
  const seen = (await profile.call('activity.list', {})).latest_sequence

  // The client is gone while the daemon crashes and new activity is recorded.
  await profile.restartDaemon('kill')
  await completedTurns(profile, conversationId, 2)
  const feed = await subscribeFeed(profile)
  try {
    await feed.connected()
    const missed = await profile.call('activity.list', { after: seen })
    expect(missed.activities).toHaveLength(2)
    // The feed does not replay what the client must catch up on through the cursor.
    await completedTurns(profile, conversationId, 1)
    const fresh = (await profile.call('activity.list', { after: missed.latest_sequence })).activities
    expect(fresh).toHaveLength(1)
    await feed.waitFor((frame) => frame.type === 'activity_changed' && (frame.activity as Activity).id === fresh[0].id)
    const announced = feed.frames
      .filter((frame) => frame.type === 'activity_changed')
      .map((frame) => (frame.activity as Activity).id)
    for (const old of missed.activities) expect(announced).not.toContain(old.id)
    expect(announced.filter((id) => id === fresh[0].id)).toHaveLength(1)
  } finally {
    feed.stop()
  }
})

test('child activity names the child and its workspace, and resolves to the child and its parent (F117, F114 navigation)', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'child-origin' })
  const { parent, workspace } = await parentIn(profile, repo.path)
  const child = await delegate(profile, parent, prompts.turn)
  await waitForChild(profile, child.child_conversation_id, 'settled', { outcome: 'completed' })
  await expect
    .poll(
      async () =>
        (await activities(profile)).filter((item) => item.target.conversation_id === child.child_conversation_id)
          .length,
    )
    .toBe(1)
  const [entry] = (await activities(profile)).filter(
    (item) => item.target.conversation_id === child.child_conversation_id,
  )
  expect(entry).toMatchObject({
    kind: 'turn_completed',
    state: 'unread',
    target: { workspace_id: workspace.id, conversation_id: child.child_conversation_id },
  })
  // Navigation resolves the target's stable identity: the child, its parent link and its workspace.
  const target = await profile.call('conversation.get', { conversation_id: entry.target.conversation_id })
  expect(target.conversation).toMatchObject({ id: child.child_conversation_id, workspace_id: workspace.id })
  expect(
    (await profile.call('orchestration.child.get', { child_conversation_id: entry.target.conversation_id })).child,
  ).toMatchObject({ parent_conversation_id: parent })
  // The parent's own inbox has nothing from the child's work.
  expect((await activities(profile)).filter((item) => item.target.conversation_id === parent)).toEqual([])
})

test('activity from an adapter agent stays readable after the adapter is removed and the daemon restarts (F117)', async ({
  ade,
  profile,
}) => {
  const agent = await defineFailingAgent(profile, ade.root)
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const child = await delegate(profile, parent, 'please fail', { provider: agent.provider, account: 'ambient' })
  await waitForChild(profile, child.child_conversation_id, 'settled', { outcome: 'failed' })
  const entry = async () =>
    (await activities(profile)).find((item) => item.target.conversation_id === child.child_conversation_id)
  await expect.poll(async () => (await entry())?.kind).toBe('turn_failed')
  const recorded = (await entry())!
  expect(recorded).toMatchObject({ title: 'please fail', detail: expect.stringContaining('status 3') })

  // The adapter refuses removal while its agent runs; stop the child's Agent first.
  await profile.call('agent.disconnect', { conversation_id: child.child_conversation_id })
  const removed = await profile.call('adapter.remove', { id: 'e2e-failing' })
  expect(JSON.stringify(removed)).not.toContain('"error"')
  expect((await profile.call('adapter.list', {})).adapters.map((item) => item.provider_id)).not.toContain(
    agent.provider,
  )
  for (const mode of ['graceful', 'kill'] as const) {
    await profile.restartDaemon(mode)
    // The entry keeps its origin, status text and target; the child link still resolves.
    expect(await entry()).toEqual(recorded)
    expect(
      (await profile.call('orchestration.child.get', { child_conversation_id: child.child_conversation_id })).child,
    ).toMatchObject({ parent_conversation_id: parent, provider: agent.provider })
  }
  expect((await profile.call('activity.mark', { activity_ids: [recorded.id], mark: 'read' })).activities[0].state).toBe(
    'read',
  )
  expect(await claim(profile, recorded.id, 'desktop-a')).toMatchObject({ granted: true })
})

test('notification preferences and a snooze suppress delivery, the record is final, and it survives restarts (F114)', async ({
  profile,
}) => {
  expect(await profile.call('notification.preferences.get', {})).toMatchObject({
    type: 'notification_preferences',
    desktop: true,
    muted_kinds: [],
    updated_at: null,
  })
  const muted = await profile.call('notification.preferences.set', {
    desktop: true,
    muted_kinds: ['turn_completed', 'turn_completed'],
  })
  expect(muted).toMatchObject({ desktop: true, muted_kinds: ['turn_completed'] })
  expect(muted.updated_at).not.toBeNull()
  // Setting the same preferences again converges on the stored record.
  expect(
    await profile.call('notification.preferences.set', { desktop: true, muted_kinds: ['turn_completed'] }),
  ).toEqual(muted)

  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 1)
  const [completed] = await activities(profile)
  expect(await claim(profile, completed.id, 'desktop-a')).toMatchObject({
    granted: false,
    delivery: { status: 'suppressed', reason: 'kind_muted', client_id: 'desktop-a' },
  })

  // A question still notifies.
  await send(profile, conversationId, prompts.questions)
  await expect
    .poll(async () => (await activities(profile)).some((item) => item.kind === 'question_requested'))
    .toBe(true)
  const question = (await activities(profile)).find((item) => item.kind === 'question_requested')!
  expect(await claim(profile, question.id, 'desktop-a')).toMatchObject({
    granted: true,
    delivery: { status: 'claimed' },
  })
  await profile.call('notification.delivery.report', {
    activity_id: question.id,
    channel: 'desktop',
    client_id: 'desktop-a',
    outcome: 'shown',
  })
  await cancelActiveSubmission(profile, conversationId)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('interrupted')
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })

  // A snoozed Conversation does not notify; turning the desktop off wins over everything.
  await profile.call('notification.preferences.set', { desktop: true, muted_kinds: [] })
  await profile.call('conversation.snooze', { conversation_id: conversationId, until: Date.now() + 3_600_000 })
  await completedTurns(profile, conversationId, 1)
  const snoozed = (await activities(profile)).find(
    (item) => item.kind === 'turn_completed' && item.id !== completed.id,
  )!
  expect(await claim(profile, snoozed.id, 'desktop-b')).toMatchObject({
    granted: false,
    delivery: { status: 'suppressed', reason: 'conversation_snoozed' },
  })
  await profile.call('conversation.unsnooze', { conversation_id: conversationId })
  const cli = await profile.cli('notification', 'preferences', '--desktop', 'off', '--muted', 'none')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'notification_preferences', desktop: false, muted_kinds: [] })
  await completedTurns(profile, conversationId, 1)
  const off = (await activities(profile))[0]
  expect(await claim(profile, off.id, 'desktop-a')).toMatchObject({
    granted: false,
    delivery: { status: 'suppressed', reason: 'desktop_disabled' },
  })

  // Preferences persist, and a suppressed delivery stays final after they change back and the daemon restarts.
  for (const mode of ['kill', 'graceful'] as const) {
    await profile.restartDaemon(mode)
    expect(await profile.call('notification.preferences.get', {})).toMatchObject({ desktop: false, muted_kinds: [] })
  }
  await profile.call('notification.preferences.set', { desktop: true, muted_kinds: [] })
  for (const [activity, reason] of [
    [completed.id, 'kind_muted'],
    [snoozed.id, 'conversation_snoozed'],
    [off.id, 'desktop_disabled'],
  ] as const) {
    expect(await claim(profile, activity, 'desktop-c')).toMatchObject({
      granted: false,
      delivery: { status: 'suppressed', reason },
    })
  }
  expect(await claim(profile, question.id, 'desktop-c')).toMatchObject({
    granted: false,
    delivery: { status: 'shown' },
  })
  // New activity notifies again once the preferences allow it.
  await completedTurns(profile, conversationId, 1)
  expect(await claim(profile, (await activities(profile))[0].id, 'desktop-c')).toMatchObject({ granted: true })

  const suppressed = await profile.cli('notification', 'deliveries', '--status', 'suppressed')
  expect(
    (suppressed.json as { deliveries: Array<{ activity_id: string }> }).deliveries
      .map((item) => item.activity_id)
      .sort(),
  ).toEqual([completed.id, snoozed.id, off.id].sort())
  const read = await profile.cli('notification', 'preferences')
  expect(read.json).toMatchObject({ desktop: true, muted_kinds: [] })
  const usage = await profile.cli('notification', 'preferences', '--desktop', 'on', '--muted', 'nonsense')
  expect(usage.code).not.toBe(0)
})

test('clients racing to claim one activity produce one delivery record, and an unreported claim is never re-delivered (F114, 10-S03)', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 2)
  const [raced, abandoned] = await activities(profile)

  const clients = ['desktop-a', 'desktop-b', 'desktop-c', 'desktop-d', 'desktop-e']
  const results = await Promise.all([...clients, ...clients].map((client) => claim(profile, raced.id, client)))
  const holders = new Set(results.filter((result) => result.granted).map((result) => result.delivery.client_id))
  expect(holders.size).toBe(1)
  const [holder] = holders
  for (const result of results) expect(result.delivery).toMatchObject({ client_id: holder, status: 'claimed' })

  // A client claims and dies before reporting: the outcome is unknown, so nobody delivers it again.
  expect(await claim(profile, abandoned.id, 'desktop-dead')).toMatchObject({ granted: true })
  await profile.call('notification.delivery.report', {
    activity_id: raced.id,
    channel: 'desktop',
    client_id: holder,
    outcome: 'shown',
  })
  for (const mode of ['kill', 'graceful'] as const) {
    await profile.restartDaemon(mode)
    const again = await Promise.all(clients.map((client) => claim(profile, raced.id, client)))
    expect(again.every((result) => !result.granted && result.delivery.status === 'shown')).toBe(true)
    expect(await claim(profile, abandoned.id, 'desktop-a')).toMatchObject({
      granted: false,
      delivery: { status: 'claimed', client_id: 'desktop-dead' },
    })
  }
  const { deliveries } = await profile.call('notification.delivery.list', {})
  expect(deliveries.map((item) => item.activity_id).sort()).toEqual([raced.id, abandoned.id].sort())
})
