// Ticket 23: Settings lists each plugin's activation generations with the artifact version and
// digest and the provider sessions that lease each, and discloses what disabling does before it
// happens. The leased session keeps its retained history; nothing is disabled without confirming.
import { installAndEnable, stagePlugin } from '../protocol/fixtures/plugins'
import { send, waitForIdle, waitForMessage } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('disabling a provider plugin discloses its leased session first, and history stays readable', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: `plugin:${pluginId}`,
    title: 'Leased plugin session',
  })
  await send(profile, conversation.id, 'hello')
  await waitForMessage(profile, conversation.id, 'Hello plugin')
  await waitForIdle(profile, conversation.id)
  const [current] = (await profile.call('plugin.generation.list', { plugin_id: pluginId })).generations

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Plugins' }) })
  const generations = section.getByRole('list', { name: /^Generations of / })
  await expect(generations).toContainText(
    `Generation ${current!.generation}: version ${current!.version} (${current!.artifact_digest.slice(0, 12)})`,
  )
  await expect(generations).toContainText('1 provider session leases it')

  await section.getByRole('button', { name: 'Disable…' }).click()
  const confirm = section.getByRole('alertdialog')
  await expect(confirm).toContainText('1 provider session keeps running on the version it started on until it ends')
  await expect(confirm).toContainText('Retained conversation history stays readable.')
  await testInfo.attach('plugin-disable.png', { body: await page.screenshot(), contentType: 'image/png' })
  // Keeping it enabled changes nothing.
  await confirm.getByRole('button', { name: 'Keep enabled' }).click()
  expect((await profile.call('plugin.list', {})).plugins[0]!.status).toBe('enabled')

  await section.getByRole('button', { name: 'Disable…' }).click()
  await section
    .getByRole('alertdialog')
    .getByRole('button', { name: /^Disable / })
    .click()
  await expect(section.getByRole('button', { name: /^Enable / })).toBeVisible()
  expect((await profile.call('plugin.list', {})).plugins[0]!.status).toBe('disabled')
  const kept = await profile.call('conversation.get', { conversation_id: conversation.id })
  expect(kept.messages.map((message) => message.text)).toEqual(['hello', 'Hello plugin'])
})
