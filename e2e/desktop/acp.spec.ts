// Ticket 20: a generic ACP conversation runs through the bundled ACP provider worker in the
// production conversation view. The agent is the deterministic ACP fixture
// (e2e/protocol/fixtures/adapters/acp_agent.mjs); this is fixture evidence, not installed or live.
import { expect, test } from './fixtures'
import { acpCalls, defineAcpAdapter, stageAdapterAgents } from '../protocol/fixtures/adapters'

test('an ACP turn streams a tool, its permission is answered in the window with the agent option, and Stop settles natively', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const agents = await stageAdapterAgents(ade.root)
  const provider = await defineAcpAdapter(profile, agents)
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider,
    title: 'Generic ACP',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Generic ACP' }).click()
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

  await type('permission please')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  const form = view.getByRole('form', { name: 'Answer agent request' })
  await expect(form).toBeVisible()
  // Each choice is the agent's own option, with its once-only or persistent meaning.
  for (const label of ['Allow once', 'Always allow', 'Reject'])
    await expect(form.getByRole('radio', { name: label, exact: true })).toBeVisible()
  await expect(form.getByText('Persistent', { exact: true })).toBeVisible()
  await expect(view.getByText('Write notes.txt').first()).toBeVisible()
  await testInfo.attach('acp-permission.png', { body: await page.screenshot(), contentType: 'image/png' })

  await form.getByRole('radio', { name: 'Always allow', exact: true }).click()
  await form.getByRole('button', { name: 'Send response' }).click()
  await expect(view).toContainText('Permission allow-always')
  await expect.poll(status).toMatch(/^(idle|ready)$/)
  await expect(form).toBeHidden()
  // The agent received exactly its own option ID, once.
  const replies = (await acpCalls(agents)).filter((call) => call.method === undefined)
  expect(replies.map((call) => call.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-always' } }])
  await expect(view.getByText('Accepted by native agent')).toBeVisible()

  // Stop sends session/cancel; only the prompt's own `cancelled` reply settles it.
  await type('hold please')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect.poll(status).toBe('running')
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stop = view.getByRole('status', { name: 'Stop status' })
  await expect(stop).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect(stop).toContainText('interrupted')
  expect((await acpCalls(agents)).filter((call) => call.method === 'session/cancel')).toHaveLength(1)
  await testInfo.attach('acp-stopped.png', { body: await page.screenshot(), contentType: 'image/png' })
})
