// Ticket 06: a Claude conversation runs through the public provider SDK worker in the same
// production conversation view as Codex. The worker's official SDK import is replaced only by the
// deterministic SDK double named by ADE_E2E_CLAUDE_SDK; this is not installed or live evidence.
import { expect, test, type ScratchProfile } from './fixtures'

async function startClaude(profile: ScratchProfile, title: string) {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'claude',
    title,
  })
  return conversation.id
}

test('a Claude turn, its native approval and its Stop run through the shared conversation view', async ({
  profile,
  desktop,
}, testInfo) => {
  const conversationId = await startClaude(profile, 'Claude worker')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Claude worker' }).click()
  const view = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view).toContainText('claude')
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  const type = async (text: string) => {
    await expect(prompt).toBeEditable()
    await prompt.click()
    await page.keyboard.type(text)
  }

  // A plain native turn renders the streamed reply.
  await type('hello')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect(view).toContainText('Hello Claude')
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toMatch(/^(idle|ready)$/)

  // A native permission request is answered once from the window with a native choice.
  await type('approval')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  const form = view.getByRole('form', { name: 'Answer agent request' })
  await expect(form).toBeVisible()
  await testInfo.attach('claude-approval.png', { body: await page.screenshot(), contentType: 'image/png' })
  const requests = async () => (await profile.call('conversation.get', { conversation_id: conversationId })).requests
  const pending = (await requests())[0]!
  expect(pending.metadata.schema.kind).toBe('choices')
  // The native choices, with their native labels and scope, are what the window offers.
  await form.getByRole('radio', { name: 'Allow once' }).check()
  await form.getByRole('button', { name: 'Send response' }).click()
  await expect
    .poll(async () => (await profile.mockCalls('claude')).filter((call) => call.method === 'answer').length)
    .toBe(1)

  // Stop: the stop record comes from native evidence, not the request reply.
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toMatch(/^(idle|ready)$/)
  await type('hold')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stop = view.getByRole('status', { name: 'Stop status' })
  await expect(stop).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect(stop).toContainText('cancelled')
  await testInfo.attach('claude-stopped.png', { body: await page.screenshot(), contentType: 'image/png' })
})
