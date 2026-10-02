// Ticket 15: a draft's context references survive the window dying and stay readable in the
// composer, including a kind this build does not know; sending carries the draft and clears it.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, turnReply, waitForIdle, waitForMessage } from './fixtures'

test('a draft keeps its context references across an app restart and lists unknown kinds readably', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Draft context',
  })
  const first = await desktop.launch(profile)
  await first.window.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Draft context' }).click()
  await expect(first.window.locator(`[data-conversation-id="${conversation.id}"]`)).toBeVisible()
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  await desktop.kill(first)

  // A newer client saved text with a reference this build has no editor node for.
  const nodes = [
    { id: 'ctx-file', kind: 'file_range', data: { provenance: { path: 'src/app.ts' } } },
    { id: 'ctx-future', kind: 'future_widget', data: { label: 'Design board frame' } },
  ]
  await profile.call('draft.save', {
    conversation_id: conversation.id,
    window_id: ownerId,
    expected_revision: 0,
    revision: 1,
    text: 'Review this with its context',
    attachments: [],
    context_nodes: nodes,
  })

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Draft context' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toHaveText('Review this with its context')
  const context = composer.getByRole('list', { name: 'Draft context' })
  await expect(context.getByRole('listitem')).toHaveText([
    'file range: src/app.ts',
    'future widget: Design board frame',
  ])
  await testInfo.attach('draft-context.png', { body: await page.screenshot(), contentType: 'image/png' })

  // Typing keeps the references with the draft.
  await composer.getByRole('textbox', { name: 'Prompt' }).click()
  await page.keyboard.type(' now')
  await expect
    .poll(async () => (await profile.call('draft.get', { conversation_id: conversation.id, window_id: ownerId })).draft)
    .toMatchObject({ text: 'Review this with its context now', context_nodes: nodes })

  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversation.id, turnReply.codex)
  await waitForIdle(profile, conversation.id)
  await expect(context).toHaveCount(0)
  const sent = await profile.call('draft.history.list', { conversation_id: conversation.id, window_id: ownerId })
  expect(sent.entries[0]).toMatchObject({
    kind: 'sent',
    text: 'Review this with its context now',
    context_nodes: nodes,
  })
})

test('a captured file range previews its source identity and the exact text the provider then receives', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const workspace = catalog.workspaces[0]!
  await mkdir(join(workspace.root, 'src'), { recursive: true })
  await writeFile(
    join(workspace.root, 'src/app.ts'),
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n',
  )
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: 'codex',
    title: 'Captured context',
  })
  const captured = await profile.call('context.capture', {
    conversation_id: conversation.id,
    request_id: 'ctx-app',
    source: { kind: 'file_range', workspace_id: workspace.id, path: 'src/app.ts', start_line: 2, end_line: 4 },
  })
  const plan = await profile.call('context.plan', {
    conversation_id: conversation.id,
    attachments: captured.node.attachments,
  })
  const exact = `${plan.parts[0]!.text_prefix ?? ''}${captured.previews[0]!.text}`

  const first = await desktop.launch(profile)
  await first.window.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Captured context' }).click()
  await expect(first.window.locator(`[data-conversation-id="${conversation.id}"]`)).toBeVisible()
  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  await desktop.kill(first)
  await profile.call('draft.save', {
    conversation_id: conversation.id,
    window_id: ownerId,
    expected_revision: 0,
    revision: 1,
    text: 'Review these lines',
    attachments: captured.node.attachments,
    context_nodes: [
      { id: 'ref-app', kind: 'file_range', data: { node_id: captured.node.id, provenance: { path: 'src/app.ts' } } },
    ],
  })

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Captured context' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const composer = view.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('textbox', { name: 'Prompt' })).toHaveText('Review these lines')
  await composer.getByRole('button', { name: 'Preview what the provider receives' }).click()
  const preview = composer.getByRole('region', { name: 'Preview of file range: src/app.ts' })
  await expect(preview).toContainText(
    `src/app.ts · lines 2–4 of 10 · read by ADE · SHA-256 ${captured.node.sha256[0]!.slice(0, 12)}`,
  )
  const body = preview.locator(`[data-attachment-id="${captured.node.attachments[0]!.id}"]`)
  await expect.poll(() => body.evaluate((element) => element.textContent)).toBe(exact)
  await testInfo.attach('captured-context-preview.png', { body: await page.screenshot(), contentType: 'image/png' })

  // What the provider receives is exactly what the preview showed.
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  await waitForMessage(profile, conversation.id, turnReply.codex)
  await waitForIdle(profile, conversation.id)
  const starts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect((starts.at(-1)!.params as { input: unknown[] }).input).toEqual([
    { type: 'text', text: 'Review these lines' },
    { type: 'text', text: exact },
  ])
})
