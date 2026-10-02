// Ticket 30: conversation responsiveness budgets on the reference machine recorded in
// performance.json (platform, CPUs, memory, binaries' SHA-256, revision). Real daemon and
// runtime with the Codex mock behind the flood proxy; no model latency, no Electron rendering.
// Each budget is checked against the 95th percentile of its raw samples, which are all kept.
import { recoveryFixtures } from '../fixtures/recovery'
import { mockDirectory } from '../fixtures/providers'
import { subscribeFeed } from '../fixtures/feed'
import { cancelActiveSubmission, prompts, send, startConversation, waitForIdle } from '../fixtures'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/performance'

/**
 * Budgets in milliseconds (memory in bytes): about five to ten times the 95th percentiles of the
 * reference runs recorded on ticket 30, so noise does not fail them and a regression does.
 */
const BUDGETS = {
  openMs: 100,
  firstOutputMs: 500,
  stopUnderFloodMs: 500,
  prependMs: 150,
  catchUpMs: 3_000,
  feedChurnGrowthBytes: 32 * 1024 * 1024,
}

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!

test('conversation: open, first output, Stop under a flood, prepend, catch-up and feed churn stay within budget @load', async ({
  ade,
  measurements,
}) => {
  test.setTimeout(300_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.floodCodex } })
  measurements.details.budgets = BUDGETS
  measurements.details.workload = {
    history: '20 turns (40 messages) in the measured conversation',
    flood: 'another conversation streams 640 messages of 64 KiB while Stop is measured',
    samples: { open: 10, firstOutput: 10, stop: 5, prepend: 10, catchUp: 3, feedChurn: 20 },
  }
  const { conversationId } = await startConversation(profile, 'codex')
  for (let turn = 0; turn < 20; turn++) {
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
  }

  const timed = async (name: string, action: () => Promise<unknown>) => {
    const started = performance.now()
    await measurements.measure(name, action)
    return performance.now() - started
  }

  // Opening: the bounded first page a view loads.
  const open: number[] = []
  for (let sample = 0; sample < 10; sample++)
    open.push(
      await timed(`open.${sample}`, () => profile.call('conversation.get', { conversation_id: conversationId })),
    )

  // First output: from send to the reply's first feed frame.
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const first: number[] = []
  for (let sample = 0; sample < 10; sample++) {
    first.push(
      await timed(`first-output.${sample}`, async () => {
        const seen = feed.waitFor(
          (frame) =>
            frame.type === 'conversation_changed' &&
            frame.conversation.id === conversationId &&
            frame.messages.some(
              (message) =>
                message.role === 'assistant' && message.text.length > 0 && message.sequence > 40 + sample * 2,
            ),
        )
        await send(profile, conversationId, prompts.turn)
        await seen
      }),
    )
    await waitForIdle(profile, conversationId)
  }

  // Stop while another conversation floods the feed.
  const flood = (await startConversation(profile, 'codex')).conversationId
  await send(profile, flood, 'flood')
  await profile.releaseMock('codex', 'flood-release')
  const stop: number[] = []
  for (let sample = 0; sample < 5; sample++) {
    const { conversationId: held } = await startConversation(profile, 'codex')
    await send(profile, held, prompts.hold)
    await expect
      .poll(
        async () => (await profile.call('conversation.get', { conversation_id: held, limit: 1 })).conversation.status,
      )
      .toBe('running')
    stop.push(await timed(`stop-under-flood.${sample}`, () => cancelActiveSubmission(profile, held)))
  }
  await expect
    .poll(
      () =>
        access(join(mockDirectory(profile.root, 'codex'), 'flood-done')).then(
          () => true,
          () => false,
        ),
      {
        timeout: 120_000,
      },
    )
    .toBe(true)

  // History prepend: the page before the newest window.
  const newest = await profile.call('conversation.get', { conversation_id: conversationId })
  const prepend: number[] = []
  for (let sample = 0; sample < 10; sample++)
    prepend.push(
      await timed(`prepend.${sample}`, () =>
        profile.call('conversation.get', {
          conversation_id: conversationId,
          before: newest.messages[0]!.sequence,
          history_epoch: newest.history_epoch,
        }),
      ),
    )
  feed.stop()

  // Catch-up: a killed daemon restarts and a view reads its conversation again.
  const catchUp: number[] = []
  for (let sample = 0; sample < 3; sample++)
    catchUp.push(
      await timed(`catch-up.${sample}`, async () => {
        await profile.restartDaemon('kill')
        await profile.call('conversation.get', { conversation_id: conversationId })
      }),
    )

  // Feed churn: views opened and closed twenty times return their resources.
  const footprint = async () => (await profile.call('diagnostics.status', {})).resources.total_footprint_bytes ?? 0
  const before = await footprint()
  for (let sample = 0; sample < 20; sample++) {
    const view = await subscribeFeed(profile)
    await view.connected()
    view.stop()
  }
  const growth = (await footprint()) - before
  measurements.details.feedChurnGrowthBytes = growth

  const observed = {
    openMs: p95(open),
    firstOutputMs: p95(first),
    stopUnderFloodMs: p95(stop),
    prependMs: p95(prepend),
    catchUpMs: p95(catchUp),
    feedChurnGrowthBytes: growth,
  }
  measurements.details.observed = observed
  for (const [name, value] of Object.entries(observed))
    expect(value, `${name} p95 ${value} exceeds its budget`).toBeLessThanOrEqual(BUDGETS[name as keyof typeof BUDGETS])
})
