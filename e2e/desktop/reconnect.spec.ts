// Ticket 13: a conversation view open across a daemon restart keeps running work, says while
// disconnected that what it shows may be old, reports connected, replayed and on-screen revision
// separately, and merges the tool's output once without the prompt being sent again.
import { codexPrompts, isRunning, send, waitForIdle, waitForMessage } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('the view stays truthful across a daemon kill mid-tool and merges the result once', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Reconnect',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Reconnect' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const sync = view.getByLabel('Sync status')

  await send(profile, conversation.id, codexPrompts.heldTool)
  let toolPid = 0
  await expect
    .poll(async () => {
      toolPid = Number((await profile.mockCalls('codex')).find((call) => call.method === 'fixture/tool')?.tool_pid ?? 0)
      return toolPid
    })
    .toBeGreaterThan(0)
  await expect(sync).toHaveAttribute('data-caught-up', 'true')

  // While the daemon is gone the view keeps what it showed and says it may be old.
  await profile.killDaemon()
  await expect(sync).toHaveAttribute('data-caught-up', 'false')
  await expect(sync).toContainText(/showing revision \d+, which may be out of date$/)
  expect(await isRunning(toolPid)).toBe(true)
  await testInfo.attach('reconnect-offline.png', { body: await page.screenshot(), contentType: 'image/png' })

  // The new daemon reattaches the running tool; the view replays and catches up.
  await profile.restartDaemon()
  await expect(sync).toHaveAttribute('data-caught-up', 'true')
  await expect(sync).toContainText(/^Connected · history replayed · showing revision \d+$/)
  expect((await profile.call('conversation.get', { conversation_id: conversation.id })).conversation.status).toBe(
    'running',
  )

  await profile.releaseMock('codex', 'release-tool')
  await waitForMessage(profile, conversation.id, 'tool completed once')
  await waitForIdle(profile, conversation.id)
  await expect(view.getByText('tool completed once')).toHaveCount(1)
  const turns = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(turns).toHaveLength(1)
  // The screen shows the last revision that changed this conversation; frames about other
  // things advance the client without re-rendering this view.
  await expect(sync).toHaveAttribute('data-caught-up', 'true')
  const client = await page.evaluate(() => window.adeHost.profiles.getClientState())
  expect(Number(await sync.getAttribute('data-display-revision'))).toBeLessThanOrEqual(client.revision!)
  await testInfo.attach('reconnect-caught-up.png', { body: await page.screenshot(), contentType: 'image/png' })
})
