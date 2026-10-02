// Tickets 24–26: plugin UI contributions in the built app. A plugin's timeline renderer shows its
// custom view and falls back to the canonical text when the plugin is disabled or the renderer
// throws; a composer transform prepares the prompt the provider receives, exactly as previewed; a
// plugin node in a draft stays readable and sends its plain text when the plugin is disabled or
// upgraded; and a plugin that hangs the renderer is recovered by Electron main into safe mode with
// the draft, the pending request and Stop intact.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { installAndEnable, stagePlugin } from '../protocol/fixtures/plugins'
import {
  expect,
  prompts,
  send,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  waitForPendingRequest,
  type DesktopLauncher,
  type ScratchProfile,
} from './fixtures'

const CARD_TEXT = 'Check summary: 3 checks passed.'

async function createConversation(profile: ScratchProfile, provider: string, title: string): Promise<string> {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider,
    title,
  })
  return conversation.id
}

async function openConversation(page: Page, title: string, conversationId: string) {
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: title }).click()
  const view = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view).toBeVisible()
  return view
}

/** The text the Codex mock received for each turn, in order. */
async function deliveredPrompts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) =>
      ((call.params as { input: Array<{ type: string; text?: string }> }).input ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    )
}

/** Saves a draft with context nodes while no app window holds it, as another client would. */
async function seedDraft(
  profile: ScratchProfile,
  desktop: DesktopLauncher,
  title: string,
  conversationId: string,
  text: string,
  nodes: Array<{ id: string; kind: string; data: Record<string, unknown> }>,
): Promise<void> {
  const first = await desktop.launch(profile)
  await openConversation(first.window, title, conversationId)
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  await desktop.kill(first)
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: ownerId,
    expected_revision: 0,
    revision: 1,
    text,
    attachments: [],
    context_nodes: nodes,
  })
}

test('a timeline renderer shows its custom view, and the canonical text returns when the plugin is disabled', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  // Headless installation declares the contributions; the daemon never loads the UI entry.
  const { plugin } = await profile.call('plugin.inspect', { plugin_id: pluginId })
  expect(plugin.manifest.contributes.timeline).toEqual([
    {
      id: 'e2e.ui.card',
      version: 1,
      item_kind: 'e2e.ui.card',
      title: 'Check card',
      required_fields: ['title', 'passed'],
      actions: [{ title: 'Recheck', command: 'e2e.ui.recheck' }],
    },
  ])
  expect(plugin.activation?.registrations).toEqual(
    expect.arrayContaining([
      { kind: 'timeline', id: 'e2e.ui.card' },
      { kind: 'composer', id: 'e2e.ui.snippet' },
    ]),
  )
  const title = 'Custom timeline'
  const conversationId = await createConversation(profile, `plugin:${pluginId}`, title)
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, CARD_TEXT)
  await waitForIdle(profile, conversationId)
  const stored = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.at(-1)!
  expect(stored).toMatchObject({
    kind: 'e2e.ui.card',
    text: CARD_TEXT,
    content: { type: 'extension', data: { title: 'Checks', passed: 3, fail: false } },
  })

  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const card = view.locator(`[data-message-id="${stored.id}"]`)
  await expect(card.getByRole('group', { name: 'Check card' })).toHaveText('Checks: 3 passed')
  await expect(card.locator('[data-plugin-view="custom"]')).toHaveAttribute('data-plugin-contribution', 'e2e.ui.card')
  await expect(card).not.toContainText(CARD_TEXT)
  await testInfo.attach('plugin-timeline-custom.png', { body: await page.screenshot(), contentType: 'image/png' })

  // A declared action runs the plugin's command through the daemon with this message's identity.
  const actions = card.getByRole('group', { name: 'Plugin actions' })
  await actions.getByRole('button', { name: 'Recheck' }).click()
  await expect(actions.getByRole('status')).toHaveText('Recheck: completed')

  // A payload without a declared field is not handed to the renderer; the canonical text shows.
  await send(profile, conversationId, 'partial')
  await waitForIdle(profile, conversationId)
  const partial = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.at(-1)!
  const partialCard = view.locator(`[data-message-id="${partial.id}"]`)
  await expect(partialCard.locator('[data-plugin-view="fallback"]')).toContainText(CARD_TEXT)
  await expect(partialCard).toContainText('Custom view unavailable: the payload lacks passed')
  await expect(partialCard.getByRole('group', { name: 'Plugin actions' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Plugins' }) })
  await section.getByRole('button', { name: 'Disable…' }).click()
  await section
    .getByRole('alertdialog')
    .getByRole('button', { name: /^Disable / })
    .click()
  await expect(section.getByRole('button', { name: /^Enable / })).toBeVisible()
  await page.getByRole('link', { name: 'Back to workspace' }).click()

  await expect(card.getByRole('group', { name: 'Check card' })).toHaveCount(0)
  await expect(card.locator('[data-plugin-view="fallback"]')).toContainText(CARD_TEXT)
  await expect(card).toContainText('Custom view unavailable: no enabled plugin provides e2e.ui.card')
  await testInfo.attach('plugin-timeline-disabled.png', { body: await page.screenshot(), contentType: 'image/png' })
})

test('a renderer that throws falls back to the canonical text, and Stop and the composer keep working', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const title = 'Throwing renderer'
  const conversationId = await createConversation(profile, `plugin:${pluginId}`, title)
  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  await prompt.click()
  await page.keyboard.type('fail and hold')
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversationId, CARD_TEXT)

  const fallback = view.locator('[data-plugin-view="fallback"]')
  await expect(fallback).toContainText(CARD_TEXT)
  await expect(fallback).toContainText('Custom view unavailable: Check card failed (fixture renderer failure)')
  await expect(view.getByRole('group', { name: 'Check card' })).toHaveCount(0)
  await testInfo.attach('plugin-timeline-thrown.png', { body: await page.screenshot(), contentType: 'image/png' })

  // The composer still takes input while the turn runs.
  await prompt.click()
  await page.keyboard.type('next idea')
  await expect(prompt).toHaveText('next idea')

  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stop = view.getByRole('status', { name: 'Stop status' })
  await expect(stop).toHaveAttribute('data-stop-outcome', 'confirmed')
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).conversation.stop).toMatchObject(
    {
      outcome: 'confirmed',
      confirmation: 'native_terminal',
    },
  )
})

test('a composer transform prepares the prompt, and the provider receives exactly the previewed text', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const title = 'Prepared prompt'
  const conversationId = await createConversation(profile, 'codex', title)
  const snippet = { id: 'snippet-1', kind: 'e2e.ui.snippet', data: { label: 'Notes', text: 'Ship the checklist.' } }
  await seedDraft(profile, desktop, title, conversationId, 'Plan for :today:', [snippet])

  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toHaveText('Plan for :today:')
  await expect(composer.getByRole('list', { name: 'Draft context' })).toHaveText('e2e.ui.snippet: Notes')
  const prepared = composer.getByRole('region', { name: 'Prepared prompt' })
  const expected = 'Plan for 2026-10-02\n\n[snippet Notes]\nShip the checklist.'
  await expect(prepared.getByRole('note', { name: 'Prepared prompt text' })).toHaveText(expected)
  await testInfo.attach('composer-prepared.png', { body: await page.screenshot(), contentType: 'image/png' })

  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  expect(await deliveredPrompts(profile)).toEqual([expected])
  const user = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.role === 'user',
  )!
  expect(user.text).toBe(expected)
  // The draft that was sent is recalled as written, with its reference.
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  const sent = await profile.call('draft.history.list', { conversation_id: conversationId, window_id: ownerId })
  expect(sent.entries[0]).toMatchObject({ kind: 'sent', text: 'Plan for :today:', context_nodes: [snippet] })
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toHaveText('')
  await expect(prepared).toHaveCount(0)
})

test('Queue delivers the same prepared prompt as Send while a turn runs', async ({ ade, profile, desktop }) => {
  await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const title = 'Prepared queue'
  const conversationId = await createConversation(profile, 'codex', title)
  const snippet = { id: 'snippet-q', kind: 'e2e.ui.snippet', data: { label: 'Notes', text: 'Ship the checklist.' } }
  await seedDraft(profile, desktop, title, conversationId, 'Plan for :today:', [snippet])
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')

  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const expected = 'Plan for 2026-10-02\n\n[snippet Notes]\nShip the checklist.'
  await expect(
    composer.getByRole('region', { name: 'Prepared prompt' }).getByRole('note', { name: 'Prepared prompt text' }),
  ).toHaveText(expected)
  await composer.getByRole('button', { name: 'Queue prompt' }).click()
  await expect
    .poll(async () =>
      (await profile.call('conversation.get', { conversation_id: conversationId })).queued.map((entry) => entry.text),
    )
    .toEqual([expected])
})

test('a disabled plugin node stays readable and sends its plain text, as the preview says', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const title = 'Disabled node'
  const conversationId = await createConversation(profile, 'codex', title)
  const snippet = { id: 'snippet-2', kind: 'e2e.ui.snippet', data: { label: 'Notes', text: 'Ship the checklist.' } }
  await seedDraft(profile, desktop, title, conversationId, 'Plan for :today:', [snippet])
  await profile.call('plugin.disable', { plugin_id: pluginId })

  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('list', { name: 'Draft context' })).toHaveText('e2e.ui.snippet: Notes')
  const prepared = composer.getByRole('region', { name: 'Prepared prompt' })
  const expected = 'Plan for :today:\n\nShip the checklist.'
  await expect(prepared.getByRole('note', { name: 'Prepared prompt text' })).toHaveText(expected)
  await expect(prepared).toContainText(
    'e2e.ui.snippet: no enabled plugin provides e2e.ui.snippet; its plain text is included in the prompt.',
  )
  await testInfo.attach('composer-disabled-node.png', { body: await page.screenshot(), contentType: 'image/png' })

  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  expect(await deliveredPrompts(profile)).toEqual([expected])
})

test('a draft with a plugin node keeps its text and reference across a plugin upgrade', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'ui'))
  const title = 'Upgraded node'
  const conversationId = await createConversation(profile, 'codex', title)
  const snippet = { id: 'snippet-3', kind: 'e2e.ui.snippet', data: { label: 'Notes', text: 'Ship the checklist.' } }
  await seedDraft(profile, desktop, title, conversationId, 'Plan for :today:', [snippet])

  const { window: page } = await desktop.launch(profile)
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const prepared = composer.getByRole('region', { name: 'Prepared prompt' })
  const expected = 'Plan for 2026-10-02\n\n[snippet Notes]\nShip the checklist.'
  await expect(prepared.getByRole('note', { name: 'Prepared prompt text' })).toHaveText(expected)

  // An upgrade disables the plugin, replaces its artifact with a newer version and enables it again.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await expect(composer.getByRole('list', { name: 'Draft context' })).toHaveText('e2e.ui.snippet: Notes')
  await profile.call('plugin.install', {
    operation_id: 'ui-upgrade',
    source: { kind: 'local', path: await stagePlugin(ade.root, 'ui', { version: '1.1.0' }) },
  })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  const upgraded = (await profile.call('plugin.list', {})).plugins.find((plugin) => plugin.id === pluginId)
  expect(upgraded?.version).toBe('1.1.0')

  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toHaveText('Plan for :today:')
  await expect(composer.getByRole('list', { name: 'Draft context' })).toHaveText('e2e.ui.snippet: Notes')
  await expect(prepared.getByRole('note', { name: 'Prepared prompt text' })).toHaveText(expected)
  await testInfo.attach('composer-after-upgrade.png', { body: await page.screenshot(), contentType: 'image/png' })

  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  expect(await deliveredPrompts(profile)).toEqual([expected])
})

test('a plugin that hangs the renderer is recovered into safe mode with the draft, pending request and Stop intact', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  test.setTimeout(180_000)
  const source = await stagePlugin(ade.root, 'ui', { entry_points: { provider: 'worker.mjs', ui: 'ui-freeze.mjs' } })
  await installAndEnable(profile, source)
  const title = 'Frozen plugin'
  const conversationId = await createConversation(profile, 'codex', title)
  const running = await desktop.launch(profile)
  const page = running.window
  const view = await openConversation(page, title, conversationId)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  await prompt.click()
  await page.keyboard.type(prompts.approval)
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  const pending = await waitForPendingRequest(profile, conversationId)
  await expect(view.getByRole('button', { name: 'Stop current turn' })).toBeVisible()
  const before = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation

  // A draft the plugin's transform never returns from, entered as one edit: each edit is saved
  // as it is made, so the transform hangs the renderer as soon as the word appears.
  await prompt.click()
  await page.keyboard.insertText('please freeze now')
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  await expect
    .poll(async () => (await profile.call('draft.get', { conversation_id: conversationId, window_id: ownerId })).draft)
    .toMatchObject({ text: 'please freeze now' })
  // Main sees the renderer hung: a script it runs there never completes.
  const responds = () =>
    running.app.evaluate(({ BrowserWindow }) =>
      Promise.race([
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('true'),
        new Promise((settle) => setTimeout(() => settle(false), 1_000)),
      ]),
    )
  await expect.poll(responds, { timeout: 10_000 }).toBe(false)
  // Chromium never reports a hang while a debugger is attached, and Playwright attaches one, so the
  // test raises the `unresponsive` event Electron raises for a person's window. Main's existing
  // recovery (main/renderer-recovery.ts) then ends the hung renderer and reloads it in safe mode.
  await running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('unresponsive'))
  // Playwright keeps its page for the ended renderer marked crashed, so the recovered renderer is
  // read and driven through main, which owns the window.
  const inWindow = <T>(script: string): Promise<T> =>
    running.app.evaluate(
      ({ BrowserWindow }, source) =>
        Promise.race([
          BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(source),
          new Promise((_, refuse) => setTimeout(() => refuse(new Error('The window did not answer')), 2_000)),
        ]),
      script,
    ) as Promise<T>
  const capture = async (name: string): Promise<void> => {
    const png = await running.app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'),
    )
    await testInfo.attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
  }
  const button = (name: string, scope = 'document') =>
    `[...${scope}.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === ${JSON.stringify(name)})`
  await expect
    .poll(() => running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL()), {
      timeout: 60_000,
      intervals: [1_000],
    })
    .toContain('safeMode=1')
  await expect
    .poll(() => inWindow<string>(`document.querySelector('[aria-label="Plugin UI not loaded"]')?.textContent ?? ''`))
    .toContain('E2E UI 1.0.0 (generation 1): Check card, Snippets')
  expect(await inWindow<boolean>(`document.querySelector('main[aria-label="Safe mode recovery"]') !== null`)).toBe(true)
  await capture('safe-mode-recovery.png')
  await inWindow(`${button('Continue in safe mode')}.click()`)

  const scope = `document.querySelector('[data-conversation-id="${conversationId}"]')`
  await expect
    .poll(() =>
      inWindow<string>(
        `${scope}?.querySelector('form[aria-label="Prompt composer"] [contenteditable]')?.textContent ?? ''`,
      ),
    )
    .toBe('please freeze now')
  expect(
    await inWindow<number>(`${scope}.querySelectorAll('section[aria-label="Agent requests"] article').length`),
  ).toBe(1)
  expect(await inWindow<boolean>(`!(${button('Stop current turn', scope)}?.disabled ?? true)`)).toBe(true)
  await capture('safe-mode-conversation.png')
  // Recovery neither answered the request nor resent the prompt, and the turn kept running.
  const after = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(after.requests).toEqual([expect.objectContaining({ id: pending.id, resolution: 'outstanding' })])
  expect(after.conversation.runtime_run).toBe(before.runtime_run)
  expect(after.conversation.status).toBe(before.status)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(0)
  expect(await deliveredPrompts(profile)).toEqual([prompts.approval])

  await inWindow(`${button('Stop current turn', scope)}.click()`)
  await expect
    .poll(() =>
      inWindow<string | null>(
        `${scope}.querySelector('[aria-label="Stop status"]')?.getAttribute('data-stop-outcome') ?? null`,
      ),
    )
    .toBe('confirmed')
})
