// Ticket 10: while a turn runs, the window offers Queue and Steer as separate actions. Queue adds
// to ADE's durable queue and never reaches the provider until the turn ends; Steer reaches the
// running native turn; Enter never chooses either.
import type { Page } from '@playwright/test'
import { expect, prompts, test, type ScratchProfile } from './fixtures'

async function startConversation(profile: ScratchProfile, title: string) {
  const { catalog } = await profile.call('catalog.get', {})
  const workspace = catalog.workspaces[0]!
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: 'codex',
    title,
  })
  return conversation.id
}

async function typePrompt(page: Page, conversationId: string, text: string) {
  const prompt = page.locator(`[data-conversation-id="${conversationId}"]`).getByRole('textbox', { name: 'Prompt' })
  await prompt.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

async function nativeCalls(profile: ScratchProfile, method: string) {
  return (await profile.mockCalls('codex')).filter((call) => call.method === method)
}

test('Queue and Steer stay separate from Send while a turn runs', async ({ profile, desktop }, testInfo) => {
  const conversationId = await startConversation(profile, 'Follow-up input')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Follow-up input' }).click()
  const view = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view).toBeVisible()

  await typePrompt(page, conversationId, prompts.hold)
  await view.getByRole('button', { name: 'Send prompt' }).click()
  await expect.poll(async () => (await nativeCalls(profile, 'turn/start')).length).toBe(1)
  await expect(view.getByRole('button', { name: 'Queue prompt' })).toBeVisible()
  await expect(view.getByRole('button', { name: 'Steer turn' })).toBeVisible()
  await expect(view.getByRole('button', { name: 'Send prompt' })).toHaveCount(0)

  // Enter only sends, so while the turn runs it neither queues nor steers.
  await typePrompt(page, conversationId, 'Enter must not choose')
  await page.keyboard.press('Enter')
  await expect(view).toContainText('Choose Queue prompt or Steer turn.')
  expect(await nativeCalls(profile, 'turn/steer')).toHaveLength(0)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).queued).toEqual([])

  // Queue: held by ADE, not sent to the provider.
  await typePrompt(page, conversationId, 'Then write the summary')
  await view.getByRole('button', { name: 'Queue prompt' }).click()
  const queue = view.getByRole('region', { name: 'Queued prompts' })
  await expect(queue).toContainText("Waiting in ADE's queue · not sent to the provider")
  await expect(queue).toContainText('Then write the summary')
  expect(await nativeCalls(profile, 'turn/start')).toHaveLength(1)
  await testInfo.attach('queued-prompt.png', { body: await page.screenshot(), contentType: 'image/png' })

  // Steer: reaches the running native turn by its ID.
  await typePrompt(page, conversationId, 'Also cover the edge cases')
  await expect(view.getByRole('button', { name: 'Steer turn' })).toBeEnabled()
  await view.getByRole('button', { name: 'Steer turn' }).click()
  await expect.poll(async () => (await nativeCalls(profile, 'turn/steer')).length).toBe(1)
  const steer = (await nativeCalls(profile, 'turn/steer'))[0]!.params as { expectedTurnId: string }
  const live = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  expect(steer.expectedTurnId).toBe(live.active_turn_id)
  expect(await nativeCalls(profile, 'turn/start')).toHaveLength(1)

  // Removing the queued prompt only drops ADE's entry.
  await view.getByRole('button', { name: "Remove queued prompt 1 from ADE's queue" }).click()
  await expect(queue).toHaveCount(0)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).queued).toEqual([])
  expect(await nativeCalls(profile, 'turn/start')).toHaveLength(1)
})
