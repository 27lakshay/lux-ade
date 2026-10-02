// Ticket 08 / PC32: the window shows the provider settings ADE requested beside what the provider
// reported in effect, offers the models and levels the provider listed (Codex `model/list` on the
// deterministic fixture), and a change at the current revision relaunches the idle agent under it.
import { expect, prompts, test, turnReply, waitForIdle, waitForMessage } from './fixtures'
import { send } from '../protocol/fixtures'

test('the window shows requested and reported settings and applies a change through the daemon', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Provider settings',
  })
  await send(profile, conversation.id, prompts.turn)
  await waitForMessage(profile, conversation.id, turnReply.codex)
  await waitForIdle(profile, conversation.id)

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Provider settings' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  await view.getByRole('button', { name: 'Provider settings' }).click()
  const effective = view.getByRole('definition').first()
  await expect(effective).toHaveText('fixture-default-model (reported by the provider)')

  // The model list and each model's levels come from the provider's report.
  const model = view.getByLabel('Model', { exact: true })
  const reasoning = view.getByLabel('Reasoning')
  await expect(model.locator('option')).toHaveText([
    'Provider default',
    'Fixture Default Model',
    'Fixture Model B',
    'Fixture Model Small',
  ])
  await expect(view.getByText('Listed by the provider (model/list)')).toBeVisible()
  await expect(reasoning.locator('option')).toHaveText(['Provider default', 'minimal', 'low', 'medium', 'high'])
  // Choosing another model shows that model's levels before anything is saved.
  await model.selectOption('fixture-model-small')
  await expect(reasoning.locator('option')).toHaveText(['Provider default', 'low', 'medium'])
  await expect(view.getByText('Listed by the provider for this model')).toBeVisible()
  await expect(view.getByText("ADE's list; the provider lists none for this model")).toBeVisible()
  await testInfo.attach('provider-settings-choices.png', { body: await page.screenshot(), contentType: 'image/png' })

  await model.selectOption('fixture-model-b')
  await reasoning.selectOption('high')
  await view.getByRole('button', { name: 'Save settings' }).click()
  await expect(view.getByText(/Settings saved/)).toBeVisible()
  await expect(effective).toHaveText('fixture-model-b (reported by the provider)')
  await testInfo.attach('provider-settings.png', { body: await page.screenshot(), contentType: 'image/png' })

  // The SDK reads the same authoritative values.
  expect(await profile.call('conversation.settings', { conversation_id: conversation.id })).toMatchObject({
    revision: 1,
    model: { requested: 'fixture-model-b', effective: 'fixture-model-b', source: 'native_reported' },
    reasoning_effort: { requested: 'high' },
  })
})
