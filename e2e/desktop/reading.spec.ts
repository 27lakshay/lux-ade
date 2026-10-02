// Ticket 29: a reader keeps their place while a conversation streams. A selection in an earlier
// message survives streaming and copies exactly, the scroll position does not jump to the end,
// typing focus stays in the composer, and the populated view passes an axe scan.
import AxeBuilder from '@axe-core/playwright'
import { prompts, send, waitForIdle, waitForMessage } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('selection, scroll position and composer focus hold while another reply streams', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Reading',
  })
  for (let index = 0; index < 6; index++) {
    await send(profile, conversation.id, prompts.turn)
    await waitForIdle(profile, conversation.id)
  }
  const running = await desktop.launch(profile)
  const page = running.window
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Reading' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  // The scroll viewport that holds the current messages.
  const viewport = view
    .locator('[data-slot="scroll-area-viewport"]')
    .filter({ has: page.locator('article[data-role="assistant"]') })
    .first()
  await expect(view.locator('article[data-role="assistant"]').first()).toBeVisible()

  // The reader scrolls to the top and selects the first reply.
  await viewport.evaluate((element) => {
    element.scrollTop = 0
  })
  const select = () =>
    view
      .locator('article[data-role="assistant"]')
      .first()
      .evaluate((article) => {
        const paragraph = article.querySelector('p')!
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return selection.toString()
      })
  expect(await select()).toBe('Hello world')
  const before = await viewport.evaluate((element) => element.scrollTop)

  // A reply streams for about four seconds.
  await send(profile, conversation.id, 'slow-stream')
  await waitForMessage(profile, conversation.id, 'Streaming line 5')
  const during = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(during).toBe('Hello world')
  expect(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - before)).toBeLessThanOrEqual(1)
  await page.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Hello world')
  await waitForIdle(profile, conversation.id)
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Hello world')
  expect(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - before)).toBeLessThanOrEqual(1)

  // Typing focus stays in the composer while another reply streams.
  const prompt = view.getByRole('form', { name: 'Prompt composer' }).getByRole('textbox', { name: 'Prompt' })
  await prompt.click()
  await send(profile, conversation.id, 'slow-stream')
  await waitForMessage(profile, conversation.id, 'Streaming line 3')
  await page.keyboard.type('still typing here')
  await waitForIdle(profile, conversation.id)
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveText('still typing here')

  // The populated view, with its provisional panels open, has no axe violations.
  await view.getByRole('button', { name: 'Usage and limits' }).click()
  await view.getByRole('button', { name: 'Commands and skills' }).click()
  expect(page.frames()).toHaveLength(1)
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze()
  await testInfo.attach('axe-conversation', {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json',
  })
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([])

  // Delete on a focused tab closes it; the close mark is pointer-only.
  const tab = page.locator(`[role="tab"][data-tab-id]`).first()
  await tab.focus()
  await page.keyboard.press('Delete')
  await expect(page.locator(`[data-conversation-id="${conversation.id}"]`)).toHaveCount(0)
})

test('expanding a large tool output on demand keeps the reading position and keyboard focus', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Tool output',
  })
  await send(profile, conversation.id, 'typed-summary-large-tool')
  await waitForIdle(profile, conversation.id)
  for (let index = 0; index < 4; index++) {
    await send(profile, conversation.id, prompts.turn)
    await waitForIdle(profile, conversation.id)
  }
  const running = await desktop.launch(profile)
  const page = running.window
  // A window tall enough that the timeline shows the control with room around it.
  await running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 1000))
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Tool output' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const summary = view.locator('[data-kind="tool-summary"]')
  const viewport = view
    .locator('[data-slot="scroll-area-viewport"]')
    .filter({ has: page.locator('article[data-role="assistant"]') })
    .first()
  await expect(summary).toContainText('excerpt (bounded; full output not shown)')
  await expect(summary).not.toContainText('TOOL_OUTPUT_TAIL_SENTINEL')

  // The reader scrolls the control into the middle of the view and opens it from the keyboard.
  const control = summary.getByRole('button', { name: 'Show full output' })
  await expect.poll(() => viewport.evaluate((element) => element.clientHeight)).toBeGreaterThan(250)
  await viewport.evaluate((element, target) => {
    const bounds = element.getBoundingClientRect()
    const button = element.querySelector(target)!.getBoundingClientRect()
    element.scrollTop += button.top - bounds.top - element.clientHeight / 3
  }, '[data-kind="tool-summary"] button[aria-expanded]')
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const bounds = element.closest('[data-slot="scroll-area-viewport"]')!.getBoundingClientRect()
        const rect = element.getBoundingClientRect()
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom
      }),
    )
    .toBe(true)
  const top = () => control.evaluate((element) => element.getBoundingClientRect().top)
  const scrollTop = () => viewport.evaluate((element) => element.scrollTop)
  const before = { top: await top(), scroll: await scrollTop() }
  await control.focus()
  await page.keyboard.press('Enter')

  const expanded = summary.getByRole('button', { name: 'Show excerpt' })
  await expect(expanded).toHaveAttribute('aria-expanded', 'true')
  await expect(expanded).toBeFocused()
  const full = summary.getByRole('region', { name: 'Full failure output' })
  await expect(full).toContainText('TOOL_OUTPUT_TAIL_SENTINEL')
  // Let the timeline measure the taller row before reading positions.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  expect(
    Math.abs((await expanded.evaluate((element) => element.getBoundingClientRect().top)) - before.top),
  ).toBeLessThanOrEqual(1)
  expect(Math.abs((await scrollTop()) - before.scroll)).toBeLessThanOrEqual(1)
  await testInfo.attach('tool-output-expanded.png', { body: await page.screenshot(), contentType: 'image/png' })

  // Collapsing returns the excerpt in place.
  await page.keyboard.press('Enter')
  await expect(summary.getByRole('button', { name: 'Show full output' })).toBeFocused()
  await expect(summary).not.toContainText('TOOL_OUTPUT_TAIL_SENTINEL')
  expect(Math.abs((await top()) - before.top)).toBeLessThanOrEqual(1)
})
