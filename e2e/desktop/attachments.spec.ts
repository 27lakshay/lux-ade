// Ticket 16: the composer shows what the provider will receive for each attachment before
// sending, refuses an unsupported file at import, and a prompt the provider would refuse is
// refused before dispatch with its draft and attachments kept. Uses the Claude SDK double.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type RunningDesktop } from './fixtures'
import { claudeContents, pngOfSize } from '../protocol/context/helpers'

/** Answers the next native file dialog with `paths`. */
async function choose(running: RunningDesktop, paths: string[]) {
  await running.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: chosen })) as typeof dialog.showOpenDialog
  }, paths)
}

test('attachments are previewed per provider, refused before dispatch, and sent once admissible', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'claude',
    title: 'Attachments',
  })
  const notes = join(profile.root, 'notes.txt')
  const large = join(profile.root, 'large.png')
  const pdf = join(profile.root, 'spec.pdf')
  await writeFile(notes, 'build fails on line 3\n')
  await writeFile(large, pngOfSize(7_600_000))
  await writeFile(pdf, '%PDF-1.7\n\u0000binary')

  const running = await desktop.launch(profile)
  const page = running.window
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Attachments' }).click()
  const composer = page
    .locator(`[data-conversation-id="${conversation.id}"]`)
    .getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  await expect(prompt).toBeEditable()
  await prompt.click()
  await page.keyboard.type('Why does it fail?')

  // An unsupported file is refused at import, and the draft is unchanged.
  await choose(running, [pdf])
  await composer.getByRole('button', { name: 'Attach files' }).click()
  await expect(composer.getByRole('alert')).toContainText(
    /Couldn't attach. The draft is unchanged. .*PNG, JPEG, GIF, WebP/,
  )
  await expect(composer.getByRole('list', { name: 'Attachments' })).toHaveCount(0)

  // Each attachment shows the form the provider receives, or why it would be refused.
  await choose(running, [notes, large])
  await composer.getByRole('button', { name: 'Attach files' }).click()
  const items = composer.getByRole('list', { name: 'Attachments' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText('notes.txt · 22 bytes · sent as a text block')
  await expect(items.nth(1)).toContainText('Will be refused: ')
  await expect(items.nth(1)).toContainText('claude accepts images up to 7500000 bytes')
  await testInfo.attach('attachment-preview.png', { body: await page.screenshot(), contentType: 'image/png' })

  // Sending anyway is refused before dispatch; the text and both attachments stay.
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect(composer.getByRole('alert')).toContainText(
    /This prompt was not sent. .*Attachment refused before sending/,
  )
  expect(await claudeContents(profile)).toEqual([])
  await expect(items).toHaveCount(2)
  await expect(prompt).toHaveText('Why does it fail?')

  // Removing the refused image makes the prompt admissible; it is sent once with the text file.
  await composer.getByRole('button', { name: 'Edit or retry prompt' }).click()
  await composer.getByRole('button', { name: /^Remove .*large\.png$/ }).click()
  await expect(items).toHaveCount(1)
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await expect.poll(() => claudeContents(profile)).toHaveLength(1)
  const [sent] = (await claudeContents(profile)) as Array<Array<{ type: string; text?: string }>>
  expect(sent.map((part) => part.type)).toEqual(['text', 'text'])
  expect(sent[1]!.text).toContain('build fails on line 3')
  await expect(composer.getByRole('list', { name: 'Attachments' })).toHaveCount(0)
})
