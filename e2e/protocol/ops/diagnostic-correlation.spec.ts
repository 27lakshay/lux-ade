// Migrates the maintained assertions from scripts/test_diagnostic_correlation.py.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, startConversation, test, waitForIdle } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'

test('successful requests correlate to the provider process and survive viewer disconnect without exposing prompt or path', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const diagnosticId = `diag_${randomUUID()}`
  const prompt = `diagnostic-private-prompt-${randomUUID()}`
  await test.step('Send the diagnostic request and wait for completion', async () => {
    await profile.rpc({
      op: 'agent.send',
      diagnostic_id: diagnosticId,
      conversation_id: conversationId,
      request_id: randomUUID(),
      text: prompt,
    })
    await waitForIdle(profile, conversationId)
  })
  let bundle = await profile.call('diagnostics.export', { max_events: 1000 })
  let runId: string | undefined
  let providerPid: number | undefined
  await expect
    .poll(async () => {
      bundle = await profile.call('diagnostics.export', { max_events: 1000 })
      const events = bundle.events as Array<Record<string, unknown>>
      const correlated = events.find((event) => event.event === 'rpc_run' && event.diagnostic_id === diagnosticId)
      runId = typeof correlated?.run_id === 'string' ? correlated.run_id : undefined
      const started = events.find((event) => event.event === 'agent_run_started' && event.run_id === runId)
      providerPid = typeof started?.pid === 'number' ? started.pid : undefined
      return Boolean(
        runId && providerPid && events.some((event) => event.event === 'provider_started' && event.pid === providerPid),
      )
    })
    .toBe(true)
  expect(runId).toMatch(/^run_/)
  expect(providerPid).toBeGreaterThan(0)
  const events = bundle.events as Array<Record<string, unknown>>
  for (const event of ['rpc_started', 'rpc_succeeded']) {
    expect(events.some((record) => record.event === event && record.diagnostic_id === diagnosticId)).toBe(true)
  }

  await test.step('Disconnect the viewer and verify the provider survives', async () => {
    const viewer = await subscribeFeed(profile)
    try {
      await viewer.connected()
    } finally {
      viewer.stop()
    }
    await expect
      .poll(
        async () =>
          (await profile.call('diagnostics.status', {})).queues.find((queue) => queue.name === 'feed.subscribers')
            ?.depth,
      )
      .toBe(0)
    const after = await profile.call('diagnostics.status', {})
    expect(after.live.runs).toContainEqual(
      expect.objectContaining({ conversation_id: conversationId, run_id: runId, pid: providerPid }),
    )
    expect(await isRunning(providerPid!)).toBe(true)
  })
  await test.step('Export correlation IDs without private prompt or path', async () => {
    const output = join(profile.root, 'diagnostic-correlation.json')
    const exportedReply = await profile.cli('diagnostics', 'export', '--output', output, '--events', '1000')
    expect(exportedReply.code).toBe(0)
    const exported = await readFile(output, 'utf8')
    expect(exported).toContain(diagnosticId)
    expect(exported).toContain(runId!)
    expect(exported).not.toContain(prompt)
    expect(exported).not.toContain(profile.root)
  })
})
