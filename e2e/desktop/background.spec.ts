// Ticket 11: after a prompt yields, the window shows the background work the provider still
// reports, keeps the conversation marked running, and shows when the session spoke without a
// prompt. Uses the deterministic Claude SDK double named by ADE_E2E_CLAUDE_SDK.
import { expect, test } from './fixtures'
import { send, waitForIdle } from '../protocol/fixtures'

test('the window shows background work after the prompt yields, and its end', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'claude',
    title: 'Background build',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Background build' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)

  await send(profile, conversation.id, 'background-task')
  await waitForIdle(profile, conversation.id)
  const activity = view.getByLabel('Session activity')
  await expect(activity).toHaveText('1 background task running')
  await expect(activity).toHaveAttribute('data-background', 'true')
  await testInfo.attach('background-running.png', { body: await page.screenshot(), contentType: 'image/png' })

  await profile.releaseMock('claude', 'release-background')
  await expect(activity).toHaveText(/^No background work running · Session output without a prompt at /)
  await expect(view).toContainText('The build finished')
  await testInfo.attach('background-settled.png', { body: await page.screenshot(), contentType: 'image/png' })
})
