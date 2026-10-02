// PC24: text typed into a draft reaches main with the edit, so a renderer crash straight after
// typing loses none of it; main saves it to the daemon while the window recovers.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('text typed just before a renderer crash is saved', async ({ profile, desktop }, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Crash draft',
  })
  const running = await desktop.launch(profile)
  const page = running.window
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Crash draft' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const prompt = view.getByRole('form', { name: 'Prompt composer' }).getByRole('textbox', { name: 'Prompt' })
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  const saved = async () =>
    (await profile.call('draft.get', { conversation_id: conversation.id, window_id: ownerId })).draft.text

  await prompt.click()
  await page.keyboard.type('Keep the first part')
  await expect.poll(saved).toBe('Keep the first part')

  // The renderer locks up in the task straight after the edit and is then crashed, so a save still
  // waiting on a timer (the composer used to wait 250 ms) never runs: only text sent with the edit
  // itself survives.
  await page.evaluate(() =>
    document.addEventListener(
      'input',
      () =>
        setTimeout(() => {
          const end = Date.now() + 60_000
          while (Date.now() < end);
        }, 0),
      { once: true, capture: true },
    ),
  )
  await page.keyboard.insertText(' and the words typed right before the crash')
  await running.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
  )

  await expect.poll(saved).toBe('Keep the first part and the words typed right before the crash')
  await expect
    .poll(() => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL()), {
      timeout: 30_000,
    })
    .toContain('safeMode=1')
  const png = await running.app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'),
  )
  await testInfo.attach('after-crash.png', { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
})
