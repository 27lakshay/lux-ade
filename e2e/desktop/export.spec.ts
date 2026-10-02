// Ticket 28: the window exports a conversation's retained history to a new file through the same
// SDK writer as the CLI, with the provider-continuity disclosure and attachment availability.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prompts, send, waitForIdle } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('the window exports the readable history with its continuity disclosure', async ({ profile, desktop }) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Export',
  })
  await send(profile, conversation.id, prompts.turn)
  await waitForIdle(profile, conversation.id)
  const file = join(profile.root, 'exported.json')
  const running = await desktop.launch(profile)
  await running.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
  }, file)
  const page = running.window
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Export' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  await view.getByRole('button', { name: 'Export conversation' }).click()
  await expect(view.getByRole('status').filter({ hasText: 'Exported' })).toHaveText(`Exported 2 messages to ${file}.`)
  const exported = JSON.parse(await readFile(file, 'utf8'))
  expect(exported).toMatchObject({
    format: 'ade-conversation-export-v1',
    message_order: 'oldest_first',
    continuity: { provider_available: true, native_resume_possible: true },
  })
  expect(exported.messages.map((entry: { message: { role: string } }) => entry.message.role)).toEqual([
    'user',
    'assistant',
  ])
  // A second export to the same file is refused and nothing is overwritten.
  await view.getByRole('button', { name: 'Export conversation' }).click()
  await expect(view.getByRole('status').filter({ hasText: 'export' })).toContainText('already exists')
})
