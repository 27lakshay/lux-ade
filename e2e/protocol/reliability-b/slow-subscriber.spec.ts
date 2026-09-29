// R009 and R008 (the feed and terminal lanes): one consumer that stops reading
// never slows the others. A raw protocol client subscribes and stops draining
// its socket while a provider floods about 40 MiB of output, a second provider
// takes turns and a fast SDK client follows the feed. The daemon evicts the
// stuck client from its bounded queue; the fast client sees every revision in
// order, and control requests keep answering. The evicted client is told by a
// close, never by a silent gap, and a new subscription starts from a fresh
// catalog. A terminal viewer that stops reading is handled the same way.
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import {
  expect,
  primaryShell,
  prompts,
  type ScratchProfile,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
} from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { mockDirectory } from '../fixtures/providers'
import { RawFeed } from '../fixtures/raw-feed'
import { recoveryFixtures } from '../fixtures/recovery'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'

async function counter(profile: ScratchProfile, name: string): Promise<number> {
  return (await profile.call('diagnostics.status', {})).counters.find((item) => item.name === name)?.value ?? -1
}

async function queueDepth(profile: ScratchProfile, name: string): Promise<number> {
  return (await profile.call('diagnostics.status', {})).queues.find((item) => item.name === name)?.depth ?? -1
}

/** How long one call takes, in milliseconds. */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await work()
  return performance.now() - started
}

/** Each revision is exactly one more than the one before. */
function expectContiguous(revisions: number[]): void {
  for (let index = 1; index < revisions.length; index++) {
    expect(revisions[index], `revision after ${revisions[index - 1]}`).toBe(revisions[index - 1] + 1)
  }
}

test('a feed client that stops reading is evicted while a flood, another provider and a fast client continue', async ({
  ade,
}) => {
  test.setTimeout(180_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.floodCodex } })
  const mocks = mockDirectory(profile.root, 'codex')
  const fast = await subscribeFeed(profile)
  await fast.connected()
  const stuck = await RawFeed.open(profile.socket)
  stuck.pause()
  await expect.poll(() => queueDepth(profile, 'feed.subscribers')).toBe(2)
  expect(await counter(profile, 'feed.subscribers_evicted')).toBe(0)

  const flood = await startConversation(profile, 'codex')
  const other = await startConversation(profile, 'claude')
  await send(profile, flood.conversationId, 'flood')
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: flood.conversationId })).conversation.status,
    )
    .toBe('running')
  await profile.releaseMock('codex', 'flood-release')

  // While the flood streams, control requests and another provider stay responsive.
  const latencies: number[] = []
  const floodDone = () =>
    access(join(mocks, 'flood-done')).then(
      () => true,
      () => false,
    )
  let turns = 0
  while (!(await floodDone()) || turns === 0) {
    latencies.push(await timed(() => profile.rpc({ op: 'hello' })))
    latencies.push(await timed(() => profile.call('catalog.get', {})))
    latencies.push(await timed(() => profile.call('diagnostics.status', {})))
    if (turns < 3) {
      turns += 1
      await send(profile, other.conversationId, prompts.turn)
      await waitForIdle(profile, other.conversationId, 30_000)
    }
  }
  // The slowest control reply stays below the daemon's 2 s write timeout, which a
  // publisher blocked on the stuck client would have to wait out.
  expect(Math.max(...latencies), JSON.stringify(latencies.map(Math.round))).toBeLessThan(2_000)
  await waitForMessage(profile, other.conversationId, turnReply.claude)

  // The stuck client was evicted and counted; the fast client is the only subscriber left.
  await expect.poll(() => counter(profile, 'feed.subscribers_evicted'), { timeout: 30_000 }).toBe(1)
  await expect.poll(() => queueDepth(profile, 'feed.subscribers')).toBe(1)

  // The fast client saw the whole flood in order on one connection, without reconnecting.
  const last = await fast.waitFor(
    (frame) =>
      frame.type === 'conversation_changed' &&
      JSON.stringify(frame.messages ?? []).includes('flood-') &&
      (frame.messages as Array<{ provider_item_id?: string }>).some((message) =>
        (message.provider_item_id ?? '').endsWith('-639'),
      ),
    60_000,
  )
  expect(last.boot_id).toBe(profile.hello.boot_id)
  expect(fast.states.filter((state) => state.status === 'reconnecting' || state.status === 'unavailable')).toEqual([])
  expectContiguous(fast.frames.map((frame) => frame.revision))
  const floodItems = new Set<string>()
  for (const frame of fast.frames) {
    if (frame.type !== 'conversation_changed') continue
    for (const message of (frame.messages ?? []) as Array<{ provider_item_id?: string }>) {
      if (message.provider_item_id?.startsWith('flood-')) floodItems.add(message.provider_item_id)
    }
  }
  expect(floodItems.size).toBe(640)

  // The stuck client reads what its socket kept: an unbroken run of revisions, then a close.
  stuck.resume()
  await stuck.waitForClose()
  const kept = stuck.revisions()
  expectContiguous(kept)
  expect(stuck.frames.filter((frame) => frame.type === 'invalid')).toEqual([])
  expect(kept.at(-1)!).toBeLessThan(fast.frames.at(-1)!.revision)

  // A new subscription starts from a fresh catalog at the current revision.
  const again = await RawFeed.open(profile.socket)
  expect(again.frames[0]).toMatchObject({ type: 'catalog', boot_id: profile.hello.boot_id })
  expect(again.frames[0].revision!).toBeGreaterThanOrEqual(fast.client.getState().revision!)
  expect(JSON.stringify(again.frames[0].catalog)).toContain(flood.conversationId)
  again.close()
  fast.stop()
  // With the daemon attached, the burst was held back at the provider, not
  // dropped: the run is still going and reports no output failure.
  expect(
    (await profile.call('conversation.get', { conversation_id: flood.conversationId })).conversation,
  ).toMatchObject({ status: 'running', error: null })
  await profile.call('agent.cancel', { conversation_id: flood.conversationId })
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: flood.conversationId })).conversation.status,
    )
    .toMatch(/^(idle|ready|interrupted)$/)
})

test('a terminal viewer that stops reading is cut off with its output intact while another viewer keeps up', async ({
  profile,
}) => {
  test.setTimeout(120_000)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const target = [workspace.id, shellId] as const
  const live = TerminalStream.open(profile, ...target)
  const runId = (await live.snapshot()).run_id as string
  const stuck = await RawFeed.openTerminal(profile.socket, ...target)
  stuck.pause()
  const pid = (await terminalMetrics(profile, ...target))!.shell_pid

  // About 1.6 MiB of paced output: a viewer that reads keeps up, but it is far
  // more than the stuck viewer's socket buffers hold.
  live.send({
    op: 'input',
    run_id: runId,
    data:
      "for i in $(seq 1 400); do head -c 4096 /dev/zero | tr '\\0' y; " +
      'echo " line-$i"; sleep 0.01; done; echo "flo""od-done"\n',
  })
  await live.waitForText(/flood-done/, 90_000)
  expect(live.text()).toMatch(/ line-400\r?\n/)
  // Input still echoes promptly for the viewer that keeps reading.
  const started = performance.now()
  live.send({ op: 'input', data: 'echo "ec""ho-after"\n', run_id: runId })
  await live.waitForText(/echo-after/)
  expect(performance.now() - started).toBeLessThan(2_000)
  const offsets = live.frames
    .filter((frame) => frame.type === 'terminal')
    .map((frame) => ({ offset: frame.offset as number, length: (frame.bytes as number[]).length }))
  for (let index = 1; index < offsets.length; index++) {
    expect(offsets[index].offset).toBe(offsets[index - 1].offset + offsets[index - 1].length)
  }
  expect(live.closed).toBe(false)

  // The stuck viewer gets an unbroken prefix of the output and then a close, never a skipped range.
  stuck.resume()
  await stuck.waitForClose(60_000)
  const chunks = stuck.frames
    .filter((frame) => frame.type === 'terminal')
    .map((frame) => ({ offset: frame.offset as number, length: (frame.bytes as number[]).length }))
  for (let index = 1; index < chunks.length; index++) {
    expect(chunks[index].offset).toBe(chunks[index - 1].offset + chunks[index - 1].length)
  }
  const reached = chunks.length ? chunks.at(-1)!.offset + chunks.at(-1)!.length : 0
  const total = (await terminalMetrics(profile, ...target))!.terminal_bytes as number
  expect(reached).toBeLessThan(total)
  // The shell never noticed.
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    shell_pid: pid,
    shell_running: true,
    run_id: runId,
  })
  // Reattaching starts again from a snapshot that replays everything the stuck viewer missed.
  const again = TerminalStream.open(profile, ...target)
  const snapshot = await again.snapshot()
  expect(snapshot.run_id).toBe(runId)
  expect(snapshot.terminal_recovery).toMatchObject({ complete: true, through_offset: total })
  expect(again.text()).toMatch(/ line-400\r?\n/)
  again.close()
  live.close()
})
