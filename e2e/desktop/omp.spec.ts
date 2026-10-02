// Ticket 07: an Oh My Pi conversation runs through its public provider worker in the shared
// conversation view. The native OMP process is the deterministic RPC CLI fixture
// (providers/omp/mock-cli.mjs); this is not installed or live evidence.
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { repositoryRoot } from '../protocol/fixtures/environment'

test('an Oh My Pi turn and its Stop run through the shared conversation view', async ({ ade, desktop }, testInfo) => {
  const profile = await ade.profile({ env: { ADE_OMP_BIN: join(repositoryRoot, 'providers/omp/mock-cli.mjs') } })
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'omp',
    title: 'Oh My Pi worker',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Oh My Pi worker' }).click()
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

  // A native turn's reply renders, and the prompt is attributed only once OMP echoes it.
  await type('hello')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect(view).toContainText('Hello Oh My Pi')
  await expect(view.getByText('Accepted by native agent')).toBeVisible()
  await expect.poll(status).toMatch(/^(idle|ready)$/)
  expect(
    (await profile.call('conversation.get', { conversation_id: conversation.id })).messages.filter(
      (message) => message.role === 'user',
    ),
  ).toHaveLength(1)

  // Stop: OMP's own interrupted run settles the Stop; the request reply alone never does.
  await type('hold')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect.poll(status).toBe('running')
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stop = view.getByRole('status', { name: 'Stop status' })
  await expect(stop).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect(stop).toContainText('interrupted')
  await testInfo.attach('omp-stopped.png', { body: await page.screenshot(), contentType: 'image/png' })
})
