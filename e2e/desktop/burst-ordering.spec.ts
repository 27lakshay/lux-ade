// PC33: a burst of streamed text followed by an approval request, more text, a failed tool's terminal
// state and the turn's failed end (after a native error) appears in that order in the built window:
// the request is never shown ahead of the text before it, and nothing overtakes the text it follows.
import { expect, test } from './fixtures'

test('a burst of text then a request, a terminal tool state and a failed turn end appear in order', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Burst ordering',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Burst ordering' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toBeEditable()

  // Record, in the page, the order in which each transition first becomes visible. Marks seen in
  // the same DOM mutation batch were drawn together.
  await page.evaluate((id) => {
    const marks: Array<[string, (root: Element) => boolean]> = [
      ['burst text', (root) => (root.textContent ?? '').includes('Burst line 399')],
      ['request', (root) => root.querySelector('form[aria-label="Answer agent request"]') !== null],
      ['text after the request', (root) => (root.textContent ?? '').includes('After approval line 199')],
      ['failed tool', (root) => (root.textContent ?? '').includes('BURST_TOOL_OUTPUT')],
      ['failed turn', (root) => (root.textContent ?? '').includes('Terminal failure: rejected')],
    ]
    const seen: Array<{ mark: string; batch: number }> = []
    ;(window as unknown as { visibleOrder: typeof seen }).visibleOrder = seen
    let batch = 0
    new MutationObserver(() => {
      batch++
      const root = document.querySelector(`[data-conversation-id="${id}"]`)
      if (!root) return
      for (const [mark, visible] of marks)
        if (!seen.some((entry) => entry.mark === mark) && visible(root)) seen.push({ mark, batch })
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  }, conversation.id)

  await composer.getByRole('textbox', { name: 'Prompt' }).click()
  await page.keyboard.type('burst-ordering')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  const form = view.getByRole('form', { name: 'Answer agent request' })
  await expect(form).toBeVisible()
  await testInfo.attach('burst-request.png', { body: await page.screenshot(), contentType: 'image/png' })
  await form.getByRole('radio', { name: 'Allow once' }).check()
  await form.getByRole('button', { name: 'Send response' }).click()
  await expect(view).toContainText('Terminal failure: rejected')
  await expect(view).toContainText('BURST_TOOL_OUTPUT')
  await testInfo.attach('burst-done.png', { body: await page.screenshot(), contentType: 'image/png' })

  const order = await page.evaluate(
    () => (window as unknown as { visibleOrder: Array<{ mark: string; batch: number }> }).visibleOrder,
  )
  await testInfo.attach('visible-order.json', { body: JSON.stringify(order, null, 2), contentType: 'application/json' })
  expect(order.map((entry) => entry.mark)).toEqual([
    'burst text',
    'request',
    'text after the request',
    'failed tool',
    'failed turn',
  ])
  const batchOf = (mark: string) => order.find((entry) => entry.mark === mark)!.batch
  // Text is never drawn after what followed it; the request may arrive in the same frame as its text.
  expect(batchOf('burst text')).toBeLessThanOrEqual(batchOf('request'))
  expect(batchOf('text after the request')).toBeLessThanOrEqual(batchOf('failed tool'))
  expect(batchOf('failed tool')).toBeLessThanOrEqual(batchOf('failed turn'))
})
