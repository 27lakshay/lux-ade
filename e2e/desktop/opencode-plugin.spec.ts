// Ticket 21: a conversation on the independently installed OpenCode plugin provider runs in
// the production conversation view. The plugin is installed through the ordinary
// plugin.install; its native OpenCode server is the deterministic fixture
// (plugins/opencode/test/fixtures/mock-opencode.mjs), so this is not installed or live evidence.
import { expect, test } from './fixtures'
import { openCodeFixtureEnvironment, openCodePluginArtifact } from '../protocol/fixtures/plugins'

test('an OpenCode plugin turn, its tool and its Stop run through the shared conversation view', async ({
  ade,
  desktop,
}, testInfo) => {
  const profile = await ade.profile({ env: openCodeFixtureEnvironment(ade.root) })
  const installed = await profile.call('plugin.install', {
    operation_id: 'install-opencode',
    source: { kind: 'local', path: await openCodePluginArtifact(ade.root) },
  })
  await profile.call('plugin.enable', { plugin_id: installed.plugin.id })
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: `plugin:${installed.plugin.id}`,
    title: 'OpenCode plugin',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'OpenCode plugin' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  const type = async (text: string) => {
    await expect(prompt).toBeEditable()
    await prompt.click()
    await page.keyboard.type(text)
  }
  const status = async () =>
    (await profile.call('conversation.get', { conversation_id: conversation.id })).conversation.status

  // A native turn with a tool call renders its reply, and the prompt appears once.
  await type('tool')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect(view).toContainText('Hello OpenCode')
  await expect(view).toContainText('echo fixture')
  await expect(view.getByText('Accepted by native agent')).toBeVisible()
  await expect.poll(status).toMatch(/^(idle|ready)$/)
  expect(
    (await profile.call('conversation.get', { conversation_id: conversation.id })).messages.filter(
      (message) => message.role === 'user',
    ),
  ).toHaveLength(1)
  await testInfo.attach('opencode-turn.png', { body: await page.screenshot(), contentType: 'image/png' })

  // Stop: OpenCode's own interrupted record confirms it.
  await type('hold')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect.poll(status).toBe('running')
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stop = view.getByRole('status', { name: 'Stop status' })
  await expect(stop).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect.poll(status).toBe('interrupted')
  await testInfo.attach('opencode-stopped.png', { body: await page.screenshot(), contentType: 'image/png' })
})
