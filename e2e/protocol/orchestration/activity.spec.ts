// F117, F114 (backend) and 10-S03: durable activity recorded with the event
// it describes, cursor paging, read and dismissed state, the activity feed,
// and notification delivery claims that a reconnect or restart cannot repeat.
import { expect, prompts, send, startConversation, test, waitForIdle, waitForPendingRequest, type ScratchProfile } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'

type Activity = { id: string; sequence: number; kind: string; state: string; created_at: number; read_at: number | null;
  dismissed_at: number | null; target: { conversation_id: string; workspace_id: string; request_id: string | null; turn_id: string | null } }

async function activities(profile: ScratchProfile, request: Record<string, unknown> = {}): Promise<Activity[]> {
  return (await profile.call('activity.list', { limit: 200, include_dismissed: true, ...request })).activities as Activity[]
}

async function completedTurns(profile: ScratchProfile, conversationId: string, count: number): Promise<void> {
  for (let turn = 0; turn < count; turn++) {
    await send(profile, conversationId, prompts.turn)
    await expect.poll(async () => (await activities(profile)).filter((item) =>
      item.target.conversation_id === conversationId && item.kind === 'turn_completed').length).toBe(turn + 1)
    await waitForIdle(profile, conversationId)
  }
}

test('a finished turn and a pending request each record one activity, committed with the change the feed announces', async ({ profile }) => {
  const feed = await subscribeFeed(profile)
  try {
    await feed.connected()
    const { conversationId, workspaceId } = await startConversation(profile, 'codex')
    await send(profile, conversationId, prompts.turn)

    // The moment the feed announces the finished turn, its activity is already committed.
    await feed.waitFor((frame) => frame.type === 'conversation_changed' &&
      (frame.conversation as { id: string; status: string }).id === conversationId &&
      (frame.conversation as { status: string }).status === 'ready')
    const completed = (await activities(profile)).filter((item) => item.target.conversation_id === conversationId)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ kind: 'turn_completed', state: 'unread',
      target: { workspace_id: workspaceId, conversation_id: conversationId } })
    expect(completed[0].target.turn_id).toMatch(/\S/)
    const announced = await feed.waitFor((frame) => frame.type === 'activity_changed' &&
      (frame.activity as Activity).id === completed[0].id)
    expect(announced.activity).toMatchObject({ kind: 'turn_completed', sequence: completed[0].sequence })

    await send(profile, conversationId, prompts.approval)
    const request = await waitForPendingRequest(profile, conversationId)
    const approval = (await activities(profile)).find((item) => item.kind === 'approval_requested')
    expect(approval).toMatchObject({ target: { conversation_id: conversationId, request_id: request.id } })
    await profile.call('agent.answer', { conversation_id: conversationId, request_id: request.id, decision: 'decline' })
    await waitForIdle(profile, conversationId)

    await send(profile, conversationId, prompts.questions)
    const questions = await waitForPendingRequest(profile, conversationId)
    expect((await activities(profile)).find((item) => item.kind === 'question_requested'))
      .toMatchObject({ target: { request_id: questions.id } })
    // Activity records are unique per event: the list holds no repeated identity.
    const all = await activities(profile)
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length)
    expect(all.filter((item) => item.kind === 'turn_completed')).toHaveLength(2)
  } finally {
    feed.stop()
  }
})

test('pages activity with a cursor and moves read and dismissed state only forward', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 4)

  const everything = await profile.call('activity.list', {})
  expect(everything.activities).toHaveLength(4)
  expect(everything.next_cursor).toBeNull()
  const newestFirst = (everything.activities as Activity[]).map((item) => item.sequence)
  expect(newestFirst).toEqual([...newestFirst].sort((a, b) => b - a))
  expect(everything.latest_sequence).toBe(newestFirst[0])

  // Newest first, one page at a time, with `before`.
  const paged: number[] = []
  let cursor: number | undefined
  for (;;) {
    const page = await profile.call('activity.list', { limit: 1, ...(cursor === undefined ? {} : { before: cursor }) })
    paged.push(...(page.activities as Activity[]).map((item) => item.sequence))
    if (page.next_cursor === null || page.next_cursor === undefined) break
    cursor = page.next_cursor
  }
  expect(paged).toEqual(newestFirst)
  // Catch-up with `after` reads oldest first.
  const oldest = await profile.call('activity.list', { after: 0, limit: 2 })
  expect((oldest.activities as Activity[]).map((item) => item.sequence)).toEqual([...newestFirst].reverse().slice(0, 2))
  expect(oldest.next_cursor).toBe(oldest.activities[1].sequence)
  await expect(profile.call('activity.list', { after: 1, before: 9 })).rejects.toThrow(/not both/)

  const [first, second, third] = everything.activities as Activity[]
  const read = await profile.call('activity.mark', { activity_ids: [first.id], mark: 'read' })
  expect(read.activities[0]).toMatchObject({ id: first.id, state: 'read' })
  const readAt = (read.activities[0] as Activity).read_at
  expect(readAt).not.toBeNull()
  // Marking again converges on the same state and keeps the first read time.
  expect((await profile.call('activity.mark', { activity_ids: [first.id], mark: 'read' })).activities[0])
    .toMatchObject({ state: 'read', read_at: readAt })
  await profile.call('activity.mark', { activity_ids: [second.id], mark: 'dismissed' })
  // Read never undoes a dismissal.
  expect((await profile.call('activity.mark', { activity_ids: [second.id], mark: 'read' })).activities[0])
    .toMatchObject({ state: 'dismissed' })

  const unread = await profile.call('activity.list', { unread_only: true })
  expect((unread.activities as Activity[]).map((item) => item.id)).not.toContain(first.id)
  expect((unread.activities as Activity[]).map((item) => item.id)).toContain(third.id)
  expect((await activities(profile, { include_dismissed: false })).map((item) => item.id)).not.toContain(second.id)
  expect((await activities(profile)).map((item) => item.id)).toContain(second.id)

  // A batch naming an unknown activity fails as a whole and marks nothing.
  await expect(profile.call('activity.mark', { activity_ids: [third.id, 'activity_missing'], mark: 'read' }))
    .rejects.toThrow(/Unknown activity/)
  expect((await activities(profile)).find((item) => item.id === third.id)?.state).toBe('unread')

  // The CLI reads the same inbox and marks through the same rules.
  const cliPage = await profile.cli('activity', 'list', '--limit', '1', '--before', String(first.sequence))
  expect(cliPage.code).toBe(0)
  expect((cliPage.json as { activities: Activity[] }).activities.map((item) => item.id)).toEqual([third.id])
  const cliMark = await profile.cli('activity', 'mark', 'read', third.id)
  expect(cliMark.json).toMatchObject({ type: 'activity_marked', activities: [{ id: third.id, state: 'read' }] })
  const cliUnknown = await profile.cli('activity', 'mark', 'read', 'activity_missing')
  expect(cliUnknown.code).not.toBe(0)
  expect(cliUnknown.json).toMatchObject({ type: 'error' })
})

test('activity survives daemon restarts and crashes without duplicates, and a lost turn is recorded once (10-S03)', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 2)
  const before = await activities(profile)
  expect(before).toHaveLength(2)

  await profile.restartDaemon('graceful')
  expect(await activities(profile)).toEqual(before)
  await profile.restartDaemon('kill')
  expect(await activities(profile)).toEqual(before)

  // A turn lost with its runtime is recorded once, however often the daemon restarts after.
  // Its kind depends on which process noticed the loss first: the running daemon records the
  // turn interrupted, and a restarted daemon records its outcome unknown. Never both.
  await send(profile, conversationId, prompts.hold)
  await expect.poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  await profile.killRuntime()
  await profile.restartDaemon()
  const lost = async () => (await activities(profile)).filter((item) => item.kind !== 'turn_completed')
  await expect.poll(async () => (await lost()).length).toBe(1)
  const [loss] = await lost()
  expect(['operation_unknown', 'turn_interrupted']).toContain(loss.kind)
  expect(loss.target).toMatchObject({ conversation_id: conversationId, turn_id: expect.stringMatching(/\S/) })
  const afterLoss = await activities(profile)
  await profile.restartDaemon('kill')
  await profile.restartDaemon('graceful')
  expect(await activities(profile)).toEqual(afterLoss)
  // A reconnecting client catches up from its cursor and sees only what it has not seen.
  const caughtUp = await profile.call('activity.list', { after: before[0].sequence })
  expect((caughtUp.activities as Activity[]).map((item) => item.id)).toEqual([loss.id])
})

test('a feed consumer reconnects after a daemon restart and receives new activity without replaying old frames', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 1)
  const [old] = await activities(profile)
  const feed = await subscribeFeed(profile)
  try {
    await feed.connected()
    const firstBoot = feed.client.getState().bootId
    await profile.restartDaemon('kill')
    await expect.poll(() => feed.client.getState().bootId, { timeout: 20_000 }).not.toBe(firstBoot)
    await feed.connected()
    await completedTurns(profile, conversationId, 1)
    const fresh = (await activities(profile)).find((item) => item.id !== old.id)!
    await feed.waitFor((frame) => frame.type === 'activity_changed' && (frame.activity as Activity).id === fresh.id)
    const announced = feed.frames.filter((frame) => frame.type === 'activity_changed').map((frame) => (frame.activity as Activity).id)
    expect(announced).not.toContain(old.id)
    expect(announced.filter((id) => id === fresh.id)).toHaveLength(1)
  } finally {
    feed.stop()
  }
})

test('one client claims a notification delivery, reports it once, and nobody delivers it again after a restart (F114, 10-S03)', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await completedTurns(profile, conversationId, 2)
  const [shownActivity, failedActivity] = await activities(profile)
  const claim = (activity: string, client: string) =>
    profile.call('notification.delivery.claim', { activity_id: activity, channel: 'desktop', client_id: client })
  const report = (activity: string, client: string, outcome: 'shown' | 'failed' | 'suppressed', reason?: string) =>
    profile.call('notification.delivery.report', { activity_id: activity, channel: 'desktop', client_id: client, outcome,
      ...(reason ? { reason } : {}) })

  const granted = await claim(shownActivity.id, 'desktop-a')
  expect(granted).toMatchObject({ granted: true, delivery: { status: 'claimed', client_id: 'desktop-a' } })
  // A second client is refused and told who holds it; the holder's retry converges.
  expect(await claim(shownActivity.id, 'desktop-b')).toMatchObject({ granted: false, delivery: { client_id: 'desktop-a' } })
  expect(await claim(shownActivity.id, 'desktop-a')).toMatchObject({ granted: true,
    delivery: { claimed_at: granted.delivery.claimed_at } })
  await expect(report(shownActivity.id, 'desktop-b', 'shown')).rejects.toThrow(/Another client/)
  expect((await report(shownActivity.id, 'desktop-a', 'shown')).delivery.status).toBe('shown')
  expect((await report(shownActivity.id, 'desktop-a', 'shown')).delivery.status).toBe('shown')
  await expect(report(shownActivity.id, 'desktop-a', 'failed', 'late')).rejects.toThrow(/already recorded/)

  // An OS failure is recorded with its reason and stays visible.
  await claim(failedActivity.id, 'desktop-a')
  await expect(report(failedActivity.id, 'desktop-a', 'failed')).rejects.toThrow(/needs a reason/)
  await report(failedActivity.id, 'desktop-a', 'failed', 'permission_denied')
  await expect(claim('activity_missing', 'desktop-a')).rejects.toThrow(/Unknown activity/)

  for (const mode of ['kill', 'graceful'] as const) {
    await profile.restartDaemon(mode)
    // After a reconnect the same client, or another, is not granted a delivery that was already handled.
    expect(await claim(shownActivity.id, 'desktop-a')).toMatchObject({ granted: false, delivery: { status: 'shown' } })
    expect(await claim(failedActivity.id, 'desktop-c')).toMatchObject({ granted: false, delivery: { status: 'failed' } })
  }
  const failed = await profile.cli('notification', 'deliveries', '--status', 'failed')
  expect(failed.code).toBe(0)
  expect(failed.json).toMatchObject({ type: 'notification_deliveries',
    deliveries: [{ activity_id: failedActivity.id, status: 'failed', reason: 'permission_denied' }] })
})

// F114 needs notification preferences and snoozed attention to decide which
// activity notifies. The daemon has no preference model yet, and a snooze does
// not change delivery (evidence phase2-activity-feed.md, Open).
test.fixme('notification preferences and a snoozed conversation suppress delivery of its activity (F114)', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await profile.call('conversation.snooze', { conversation_id: conversationId, until: Date.now() + 3_600_000 })
  await completedTurns(profile, conversationId, 1)
  const [activity] = await activities(profile)
  expect(await profile.call('notification.delivery.claim', { activity_id: activity.id, channel: 'desktop', client_id: 'desktop-a' }))
    .toMatchObject({ granted: false })
})
