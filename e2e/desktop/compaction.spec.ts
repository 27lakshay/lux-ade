// Ticket 18: the window offers native compaction only when the provider supports it now, says the
// reply only means the provider started, shows the provider's compaction record in the history,
// and does not move the earlier prompt's own outcome. An unsupported provider says why.
import { prompts, send, waitForIdle, waitForMessage } from '../protocol/fixtures'
import { expect, test } from './fixtures'

const compactionText = 'Codex compacted the conversation context.'

async function open(profile: Parameters<Parameters<typeof test>[2]>[0]['profile'], provider: string, title: string) {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider,
    title,
  })
  await send(profile, conversation.id, provider === 'codex' ? prompts.turn : 'hello')
  await waitForIdle(profile, conversation.id)
  return conversation.id
}

test('a Codex compaction is requested from the window and its native record is shown', async ({
  profile,
  desktop,
}, testInfo) => {
  const id = await open(profile, 'codex', 'Compaction')
  const before = (await profile.call('conversation.get', { conversation_id: id })).messages[0]!.delivery
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Compaction' }).click()
  const view = page.locator(`[data-conversation-id="${id}"]`)
  const control = view.getByLabel('Compaction')
  await control.getByRole('button', { name: 'Compact context' }).click()
  await expect(control.getByRole('status')).toHaveText(
    'The provider started compacting. Its result appears in the conversation when it reports it.',
  )
  await waitForMessage(profile, id, compactionText)
  await expect(view.getByText(compactionText)).toBeVisible()
  const after = (await profile.call('conversation.get', { conversation_id: id })).messages[0]!.delivery
  expect(after).toEqual(before)
  await testInfo.attach('compaction.png', { body: await page.screenshot(), contentType: 'image/png' })
})

test('a provider without native compaction shows the reason and offers no request', async ({ profile, desktop }) => {
  const id = await open(profile, 'claude', 'No compaction')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'No compaction' }).click()
  const control = page.locator(`[data-conversation-id="${id}"]`).getByLabel('Compaction')
  await expect(control.getByRole('button', { name: 'Compact context' })).toBeDisabled()
  await expect(control).toContainText('Compaction is unavailable:')
})
