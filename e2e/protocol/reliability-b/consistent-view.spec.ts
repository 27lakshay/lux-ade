// R010: a consistent application view after reconnect. The view is the SDK
// client feed plus the `@ade/client/sync` conversation projection, the pair
// the renderer uses. It loses its connection while turns run, sees the daemon
// killed and restarted mid-turn, and receives a snapshot reply late, after
// newer frames. Each time it must end equal to a fresh snapshot, with every
// repair visible as a stale state first. Cursors: an activity cursor is kept
// across a restart and catches up exactly; a history search cursor from an
// earlier index epoch is refused as expired, not answered from the new index.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { codexPrompts, expect, prompts, send, startConversation, test, turnReply, waitForIdle, waitForMessage,
  type ScratchProfile } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { openConversationView, viewDigest, type ConversationView } from '../fixtures/sync-view'

async function fresh(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId, limit: 200 })
}

/** Wait until the view is current, idle and equal to a fresh snapshot. */
async function converged(view: ConversationView, profile: ScratchProfile, conversationId: string) {
  let expected: Awaited<ReturnType<typeof fresh>> | null = null
  await expect.poll(async () => {
    expected = await fresh(profile, conversationId)
    const state = view.latest()
    if (state?.status !== 'current' || !state.snapshot) return 'not current'
    return JSON.stringify(viewDigest(state.snapshot)) === JSON.stringify(viewDigest(expected)) ? 'equal' : 'different'
  }, { timeout: 30_000, message: 'the view to equal a fresh snapshot' }).toBe('equal')
  return expected!
}

function toolPid(profile: ScratchProfile) {
  return expect.poll(async () => Number((await profile.mockCalls('codex'))
    .find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0)).toBeGreaterThan(0)
}

test('the view repairs itself after a lost connection, a daemon kill and a graceful restart during turns', async ({ profile }) => {
  test.setTimeout(150_000)
  const { conversationId } = await startConversation(profile, 'codex')
  const view = await openConversationView(profile, conversationId)
  try {
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
    await converged(view, profile, conversationId)
    const firstFetches = view.fetches()

    // The connection drops while another turn runs to completion.
    view.detach()
    const stale = view.states.length
    await send(profile, conversationId, codexPrompts.typedPlan)
    await waitForIdle(profile, conversationId)
    await view.attach(profile)
    // Same boot, later revision: a gap. The view goes stale, fetches a snapshot, and converges.
    await converged(view, profile, conversationId)
    const repair = view.states.slice(stale).map((entry) => entry.cause)
    expect(repair[0]).toBe('stale')
    expect(repair).toContain('loaded')
    expect(view.fetches()).toBeGreaterThan(firstFetches)

    for (const mode of ['kill', 'graceful'] as const) {
      // A turn blocked in a tool while the daemon goes away.
      const before = view.states.length
      await send(profile, conversationId, codexPrompts.heldTool)
      await toolPid(profile)
      await view.settle((snapshot) => snapshot.conversation.status === 'running')
      const previous = profile.hello.boot_id
      await profile.restartDaemon(mode)
      // The client reconnects on its own and the new boot forces a new snapshot.
      await expect.poll(() => view.client()?.getState().bootId, { timeout: 20_000 }).toBe(profile.hello.boot_id)
      await view.settle((snapshot) => snapshot.boot_id === profile.hello.boot_id && snapshot.conversation.status === 'running')
      expect(view.states.slice(before).some((entry) => entry.cause === 'stale' && entry.state.snapshot?.boot_id === previous)).toBe(true)
      await profile.releaseMock('codex', 'release-tool')
      await waitForIdle(profile, conversationId)
      const settled = await converged(view, profile, conversationId)
      expect(settled.conversation.status).toMatch(/^(idle|ready)$/)
      // The finished tool appears once: nothing was replayed or duplicated into the view.
      const messages = view.latest()!.snapshot!.messages
      expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length)
      await expect.poll(async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'fixture/tool').length)
        .toBe(mode === 'kill' ? 1 : 2)
      // The next held tool waits for its own release.
      await rm(join(mockDirectory(profile.root, 'codex'), 'release-tool'), { force: true })
    }
    // Every frame the view applied after a snapshot was on that snapshot's boot, in order.
    const revisions = view.forwarded.filter((frame) => frame.boot_id === profile.hello.boot_id).map((frame) => frame.revision)
    for (let index = 1; index < revisions.length; index++) expect(revisions[index]).toBe(revisions[index - 1] + 1)
  } finally {
    view.dispose()
  }
})

test('a late snapshot never hides newer frames, even across a daemon restart', async ({ profile }) => {
  test.setTimeout(120_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const view = await openConversationView(profile, conversationId)
  try {
    await converged(view, profile, conversationId)

    // Lose the connection, then hold the repair snapshot back while more turns commit.
    view.detach()
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
    const held = view.holdNextSnapshot()
    await view.attach(profile)
    const late = await held.read
    await send(profile, conversationId, codexPrompts.typedPlan)
    await waitForIdle(profile, conversationId)
    const newer = await fresh(profile, conversationId)
    expect(newer.revision).toBeGreaterThan(late.revision)
    // The frames that arrived meanwhile are applied over the late snapshot.
    held.release()
    await converged(view, profile, conversationId)

    // A snapshot read from the old daemon arrives after the new daemon's first frame.
    view.detach()
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
    const beforeRestart = view.holdNextSnapshot()
    await view.attach(profile)
    const old = await beforeRestart.read
    const previous = profile.hello.boot_id
    await profile.restartDaemon('kill')
    await expect.poll(() => view.client()?.getState().bootId, { timeout: 20_000 }).toBe(profile.hello.boot_id)
    const fetches = view.fetches()
    beforeRestart.release()
    expect(old.boot_id).toBe(previous)
    // The old boot's snapshot is not the answer: the view fetches again from the new daemon.
    const current = await converged(view, profile, conversationId)
    expect(view.latest()!.snapshot!.boot_id).toBe(profile.hello.boot_id)
    expect(current.boot_id).toBe(profile.hello.boot_id)
    expect(view.fetches()).toBeGreaterThan(fetches)
  } finally {
    view.dispose()
  }
})

test('a kept activity cursor catches up exactly after a restart, and a search cursor from an old index epoch expires', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  for (let turn = 0; turn < 3; turn++) {
    await send(profile, conversationId, `capybara ${turn} ${prompts.turn}`)
    await waitForIdle(profile, conversationId)
  }
  await waitForMessage(profile, conversationId, turnReply.codex)
  const seen = await profile.call('activity.list', { limit: 200 })
  const cursor = Math.max(...seen.activities.map((activity) => activity.sequence))
  await expect.poll(async () => (await profile.call('history.search', { query: 'capybara', limit: 1 })).results.length)
    .toBe(1)
  const page = await profile.call('history.search', { query: 'capybara', limit: 1 })
  expect(page.next_cursor).toBeTruthy()

  await profile.restartDaemon('kill')
  // The activity cursor is still valid on the new daemon and returns only what came after it.
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const caughtUp = await profile.call('activity.list', { after: cursor })
  expect(caughtUp.activities.length).toBeGreaterThan(0)
  expect(caughtUp.activities.every((activity) => activity.sequence > cursor)).toBe(true)
  const all = await profile.call('activity.list', { limit: 200 })
  expect(caughtUp.activities.map((activity) => activity.id).sort())
    .toEqual(all.activities.filter((activity) => activity.sequence > cursor).map((activity) => activity.id).sort())

  // The search cursor still pages on the same epoch after the restart ...
  const second = await profile.call('history.search', { query: 'capybara', limit: 1, cursor: page.next_cursor! })
  expect(second.index.epoch).toBe(page.index.epoch)
  // ... and a rebuild moves the epoch, so the old cursor is refused rather than mixed with the new index.
  await profile.call('history.index.rebuild', { expected_epoch: page.index.epoch })
  await expect(profile.call('history.search', { query: 'capybara', limit: 1, cursor: page.next_cursor! }))
    .rejects.toThrow(/expired/)
  await expect.poll(async () => (await profile.call('history.search', { query: 'capybara', limit: 50 })).results.length)
    .toBe(3)
})
