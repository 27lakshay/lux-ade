// R011: no stale results after a context change. A view switches profile
// while its snapshot reply is still on the way, switches between
// conversations in different workspaces while the old one keeps producing,
// and reads older pages after newer messages arrived. Late replies and frames
// from the old context never reach the new one, and cursors from one context
// never return another context's data.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  codexPrompts,
  expect,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { openConversationView, sdkModules, viewDigest } from '../fixtures/sync-view'

async function fresh(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId, limit: 32 })
}

test('a profile switch drops the old profile late snapshot and frames', async ({ ade }) => {
  test.setTimeout(120_000)
  const first = await ade.profile()
  const second = await ade.profile()
  const a = await startConversation(first, 'codex')
  const b = await startConversation(second, 'claude')
  await send(first, a.conversationId, 'alpha-only marker')
  await waitForIdle(first, a.conversationId)
  await send(second, b.conversationId, prompts.turn)
  await waitForIdle(second, b.conversationId)

  // The first profile's view is waiting for a snapshot when the user switches away.
  const oldView = await openConversationView(first, a.conversationId)
  await oldView.settle(() => true)
  oldView.detach()
  await send(first, a.conversationId, prompts.turn)
  await waitForIdle(first, a.conversationId)
  const held = oldView.holdNextSnapshot()
  await oldView.attach(first)
  const late = await held.read
  oldView.dispose()
  const heardBeforeSwitch = oldView.states.length

  const newView = await openConversationView(second, b.conversationId)
  try {
    await newView.settle((snapshot) => snapshot.conversation.id === b.conversationId)
    // The late reply arrives after the switch, and the old profile keeps producing.
    held.release()
    expect(late.conversation.id).toBe(a.conversationId)
    await send(first, a.conversationId, codexPrompts.typedPlan)
    await waitForIdle(first, a.conversationId)
    await send(second, b.conversationId, prompts.turn)
    await waitForIdle(second, b.conversationId)
    await expect
      .poll(
        async () =>
          JSON.stringify(viewDigest(newView.latest()!.snapshot!)) ===
          JSON.stringify(viewDigest(await fresh(second, b.conversationId))),
      )
      .toBe(true)

    // Nothing from the first profile reached the old view after it closed, or the new view at all.
    expect(oldView.states).toHaveLength(heardBeforeSwitch)
    const shown = newView.latest()!.snapshot!
    expect(shown.boot_id).toBe(second.hello.boot_id)
    expect(JSON.stringify(shown)).not.toContain(a.conversationId)
    expect(JSON.stringify(shown)).not.toContain('alpha-only')
    expect(newView.forwarded.every((frame) => frame.boot_id === second.hello.boot_id)).toBe(true)
    expect(JSON.stringify(newView.client()!.getState().catalog)).not.toContain(a.conversationId)
    // The other profile's conversation does not exist here, rather than resolving to something else.
    await expect(second.call('conversation.get', { conversation_id: a.conversationId })).rejects.toThrow()
  } finally {
    newView.dispose()
  }
})

test('a stopped client hears nothing more from its daemon', async ({ profile }) => {
  const { client } = await sdkModules()
  const old = new client.AdeClient(profile.socket)
  const heard: string[] = []
  old.subscribeFeed((frame) => {
    heard.push(`${frame.type}:${frame.revision}`)
  })
  old.start()
  await expect.poll(() => old.getState().status).toBe('connected')
  const { conversationId } = await startConversation(profile, 'codex')
  await expect.poll(() => heard.length).toBeGreaterThan(1)
  old.stop()
  const atStop = heard.length
  const stateAtStop = old.getState()
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  // A newer client sees the turn, so frames were published after the stop.
  const probe = new client.AdeClient(profile.socket)
  probe.start()
  try {
    await expect.poll(() => probe.getState().revision ?? 0).toBeGreaterThan(stateAtStop.revision ?? 0)
  } finally {
    probe.stop()
  }
  expect(heard).toHaveLength(atStop)
  expect(old.getState().revision).toBe(stateAtStop.revision)
})

test('switching conversations across workspaces keeps the other conversation out of the view', async ({ profile }) => {
  const otherRoot = join(profile.root, 'other-workspace')
  await mkdir(otherRoot, { recursive: true })
  const x = await startConversation(profile, 'codex')
  const y = await startConversation(profile, 'claude', otherRoot)
  expect(y.workspaceId).not.toBe(x.workspaceId)
  await send(profile, y.conversationId, prompts.turn)
  await waitForIdle(profile, y.conversationId)

  const xView = await openConversationView(profile, x.conversationId)
  await xView.settle(() => true)
  // Switch while X has a turn in flight; X keeps producing after the switch.
  await send(profile, x.conversationId, codexPrompts.heldTool)
  xView.dispose()
  const yView = await openConversationView(profile, y.conversationId)
  try {
    await yView.settle((snapshot) => snapshot.conversation.id === y.conversationId)
    await profile.releaseMock('codex', 'release-tool')
    await waitForMessage(profile, x.conversationId, 'tool completed once')
    await waitForIdle(profile, x.conversationId)
    // Y's view saw every frame X produced, and took none of X's content.
    await expect.poll(() => yView.forwarded.at(-1)?.revision).toBe(yView.client()!.getState().revision)
    expect(
      yView.forwarded.some(
        (frame) =>
          frame.type === 'conversation_changed' && (frame.conversation as { id: string }).id === x.conversationId,
      ),
    ).toBe(true)
    expect(
      yView.states.every(
        (entry) => entry.state.snapshot === null || entry.state.snapshot.conversation.id === y.conversationId,
      ),
    ).toBe(true)
    const shown = yView.latest()!.snapshot!
    expect(shown.conversation.id).toBe(y.conversationId)
    expect(
      shown.messages.every(
        (message) => message.id.startsWith(y.conversationId) || !JSON.stringify(message).includes(x.conversationId),
      ),
    ).toBe(true)
    expect(JSON.stringify(shown.messages)).not.toContain('tool completed once')
    expect(viewDigest(shown)).toEqual(viewDigest(await fresh(profile, y.conversationId)))
    // Search scoped to Y's workspace never returns X's messages.
    await expect
      .poll(async () => (await profile.call('history.search', { query: 'tool completed', limit: 50 })).results.length)
      .toBeGreaterThan(0)
    const scoped = await profile.call('history.search', {
      query: 'tool completed',
      workspace_id: y.workspaceId,
      limit: 50,
    })
    expect(scoped.results).toEqual([])
  } finally {
    yView.dispose()
  }
})

test('late pages and cursors from another context never return that context', async ({ ade }) => {
  test.setTimeout(90_000)
  const first = await ade.profile()
  const second = await ade.profile()
  const a = await startConversation(first, 'codex')
  const b = await startConversation(second, 'codex')
  for (let turn = 0; turn < 4; turn++) {
    await send(first, a.conversationId, `wombat first ${turn}`)
    await waitForIdle(first, a.conversationId)
    await send(second, b.conversationId, `wombat second ${turn}`)
    await waitForIdle(second, b.conversationId)
  }

  // An older page read after newer messages arrived holds only older messages.
  const top = await first.call('conversation.get', { conversation_id: a.conversationId, limit: 3 })
  const oldest = Math.min(...top.messages.map((message) => message.sequence))
  await send(first, a.conversationId, 'wombat first late')
  await waitForIdle(first, a.conversationId)
  const older = await first.call('conversation.get', { conversation_id: a.conversationId, before: oldest, limit: 32 })
  expect(older.messages.every((message) => message.sequence < oldest)).toBe(true)
  expect(JSON.stringify(older.messages)).not.toContain('wombat first late')
  const all = await fresh(first, a.conversationId)
  const merged = [...older.messages, ...top.messages].map((message) => message.id)
  expect(new Set(merged).size).toBe(merged.length)
  expect(all.messages.map((message) => message.id).slice(0, merged.length)).toEqual(merged)

  // A search cursor issued by one profile, replayed on another, only ever pages that other profile.
  await expect
    .poll(async () => (await first.call('history.search', { query: 'wombat', limit: 50 })).results.length)
    .toBe(5)
  await expect
    .poll(async () => (await second.call('history.search', { query: 'wombat', limit: 50 })).results.length)
    .toBe(4)
  const page = await first.call('history.search', { query: 'wombat', limit: 1 })
  expect(page.next_cursor).toBeTruthy()
  const crossed = await second.call('history.search', { query: 'wombat', limit: 50, cursor: page.next_cursor! }).then(
    (reply) => reply.results,
    (error: Error) => error.message,
  )
  if (Array.isArray(crossed)) {
    expect(crossed.every((result) => result.provenance.conversation_id === b.conversationId)).toBe(true)
  } else {
    expect(crossed).toMatch(/cursor/i)
  }
})
