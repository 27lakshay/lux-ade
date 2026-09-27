// R005, R008: while the daemon is away the runtime journals provider output
// for replay within a bounded spool. Output past that bound is an output
// failure the new daemon reports; it is never presented as a process exit,
// and the output before the overflow is kept.
import { join } from 'node:path'
import { expect, isRunning, send, startConversation, test } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { recoveryFixtures, waitForPidFile } from '../fixtures/recovery'

test('replay overflow while the daemon is away is reported as degraded output, not as an exit', async ({ ade }) => {
  test.setTimeout(120_000)
  const profile = await ade.profile({ env: { ADE_CODEX_BIN: recoveryFixtures.floodCodex } })
  const mocks = mockDirectory(profile.root, 'codex')
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'flood')
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')
  // The turn's opening output reached the daemon before it went away.
  await expect
    .poll(async () =>
      JSON.stringify((await profile.call('conversation.get', { conversation_id: conversationId })).messages),
    )
    .toContain('Hello world')
  const proxyPid = await waitForPidFile(join(mocks, 'flood-proxy.pid'))
  const first = profile.hello

  await profile.killDaemon()
  await profile.releaseMock('codex', 'flood-release')
  // The runtime stops a run whose output it can no longer replay, and only
  // that confirmed stop lets it journal an exit.
  await expect.poll(() => isRunning(proxyPid), { timeout: 60_000 }).toBe(false)

  const after = await profile.restartDaemon()
  expect(after.runtime_instance).toBe(first.runtime_instance)
  let snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  await expect
    .poll(
      async () => {
        snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
        return snapshot.conversation.error ?? ''
      },
      { timeout: 20_000 },
    )
    .toMatch(/exceeded the replay buffer/)
  expect(snapshot.conversation.status).not.toMatch(/^(running|starting|waiting)$/)
  expect(snapshot.conversation.error).not.toMatch(/Runtime supervisor exited|process exited/i)
  // Output journaled before the overflow is replayed; output after it is not.
  const flooded = snapshot.messages
    .map((message) => (message as { provider_item_id?: string }).provider_item_id ?? '')
    .filter((id) => id.startsWith('flood-'))
    .map((id) => Number(id.slice(id.lastIndexOf('-') + 1)))
  expect(flooded.length).toBeGreaterThan(0)
  expect(Math.max(...flooded)).toBeLessThan(639)
  // Nothing was replayed.
  const starts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(starts).toHaveLength(1)
})
