// PC27 and story 56, measured in the built Electron app: opening a conversation view repeatedly
// stays fast and returns its memory and DOM when the view closes, and typing stays responsive
// while other conversations stream. Each measurement is attached to the test as evidence; the
// budgets hold on a loaded development machine with a debug backend.
import type { Page } from '@playwright/test'
import { prompts, send, waitForIdle, waitForMessage } from '../protocol/fixtures'
import { expect, test } from './fixtures'

const MOUNT_CYCLES = 20
const MOUNT_MEDIAN_MS = 400
const MOUNT_WORST_MS = 1_500
const HEAP_GROWTH_BYTES = 16 * 1024 * 1024
const DOM_GROWTH_NODES = 500
const LONGEST_TASK_MS = 250

async function heapAfterCollection(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.collectGarbage')
  const { usedSize } = (await session.send('Runtime.getHeapUsage')) as { usedSize: number }
  await session.detach()
  return usedSize
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

test('opening a conversation view repeatedly stays fast and returns its memory and DOM', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Mounting',
  })
  for (let index = 0; index < 12; index++) {
    await send(profile, conversation.id, prompts.turn)
    await waitForIdle(profile, conversation.id)
  }
  const { window: page } = await desktop.launch(profile)
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Mounting' })
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const tab = page.getByRole('tab', { name: 'Mounting' })
  const cycle = async (): Promise<number> => {
    const started = Date.now()
    await row.click()
    await expect(view.locator('article[data-role="assistant"]').first()).toBeVisible()
    const elapsed = Date.now() - started
    await tab.focus()
    await page.keyboard.press('Delete')
    await expect(view).toHaveCount(0)
    return elapsed
  }
  // One warm-up opens the view's code paths before measuring.
  await cycle()
  const nodes = () => page.evaluate(() => document.getElementsByTagName('*').length)
  const baseline = { heap: await heapAfterCollection(page), nodes: await nodes() }
  const mounts: number[] = []
  for (let index = 0; index < MOUNT_CYCLES; index++) mounts.push(await cycle())
  const after = { heap: await heapAfterCollection(page), nodes: await nodes() }
  const measured = {
    cycles: MOUNT_CYCLES,
    mount_median_ms: median(mounts),
    mount_worst_ms: Math.max(...mounts),
    heap_growth_bytes: after.heap - baseline.heap,
    dom_growth_nodes: after.nodes - baseline.nodes,
    mounts_ms: mounts,
  }
  await testInfo.attach('view-mounting.json', {
    body: JSON.stringify(measured, null, 2),
    contentType: 'application/json',
  })
  expect(measured.mount_median_ms).toBeLessThanOrEqual(MOUNT_MEDIAN_MS)
  expect(measured.mount_worst_ms).toBeLessThanOrEqual(MOUNT_WORST_MS)
  expect(measured.heap_growth_bytes).toBeLessThanOrEqual(HEAP_GROWTH_BYTES)
  expect(measured.dom_growth_nodes).toBeLessThanOrEqual(DOM_GROWTH_NODES)
})

test('typing stays responsive while two other conversations stream', async ({ profile, desktop }, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const create = async (title: string) =>
    (
      await profile.call('conversation.create', {
        workspace_id: catalog.workspaces[0]!.id,
        provider: 'codex',
        title,
      })
    ).conversation.id
  const [first, second, typing] = [await create('Stream one'), await create('Stream two'), await create('Typing')]
  const { window: page } = await desktop.launch(profile)
  for (const title of ['Stream one', 'Stream two', 'Typing'])
    await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: title }).click()
  const view = page.locator(`[data-conversation-id="${typing}"]`)
  const prompt = view.getByRole('form', { name: 'Prompt composer' }).getByRole('textbox', { name: 'Prompt' })
  await expect(prompt).toBeEditable()

  await page.evaluate(() => {
    const tasks: number[] = []
    ;(window as unknown as { longTasks: number[] }).longTasks = tasks
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration)
    }).observe({ type: 'longtask' })
  })
  await send(profile, first, 'slow-stream')
  await send(profile, second, 'slow-stream')
  await waitForMessage(profile, first, 'Streaming line 3')
  await waitForMessage(profile, second, 'Streaming line 3')

  // Each keystroke is timed from the key to the frame that shows it.
  await prompt.click()
  const text = 'responsive while others stream'
  const keys: number[] = []
  for (const key of text) {
    const started = Date.now()
    await page.keyboard.type(key)
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))))
    keys.push(Date.now() - started)
  }
  await expect(prompt).toHaveText(text)
  await waitForIdle(profile, first)
  await waitForIdle(profile, second)
  const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)
  const measured = {
    keystroke_median_ms: median(keys),
    keystroke_worst_ms: Math.max(...keys),
    long_tasks: longTasks.length,
    longest_task_ms: Math.max(0, ...longTasks),
  }
  await testInfo.attach('typing-under-streams.json', {
    body: JSON.stringify(measured, null, 2),
    contentType: 'application/json',
  })
  expect(measured.keystroke_median_ms).toBeLessThanOrEqual(50)
  expect(measured.longest_task_ms).toBeLessThanOrEqual(LONGEST_TASK_MS)
})
