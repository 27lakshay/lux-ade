// Ticket 19: the window previews a conversation rewind from a prompt, names how the provider
// performs it and that files are not restored, and reports the new native session lineage the
// daemon recorded. Uses the Claude SDK double named by ADE_E2E_CLAUDE_SDK.
import { prompts, send, waitForIdle } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('a Claude rewind is previewed, confirmed and reported with its native lineage', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'claude',
    title: 'Rewind',
  })
  for (const prompt of ['one alpacarun', 'two bisonleap']) {
    await send(profile, conversation.id, prompt)
    await waitForIdle(profile, conversation.id)
  }
  const original = (await profile.call('conversation.get', { conversation_id: conversation.id })).conversation
    .provider_thread_id!

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Rewind' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const second = view.locator('article[data-role="user"]', { hasText: 'two bisonleap' })
  await second.getByRole('button', { name: 'Rewind to before this prompt' }).click()

  const panel = view.getByRole('region', { name: 'Rewind conversation' })
  await expect(panel).toContainText('Removes 2 messages from 1 turns and keeps 2.')
  await expect(panel).toContainText('worker.rewind')
  await expect(panel).toContainText('Files are not restored')
  await testInfo.attach('rewind-preview.png', { body: await page.screenshot(), contentType: 'image/png' })

  await panel.getByRole('button', { name: 'Rewind', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText(
    `Rewound: removed 2 messages from 1 turns. The conversation continues in native session`,
  )
  await expect(panel.getByRole('status')).toContainText(`session ${original} is kept unchanged`)
  await expect(view.getByText('two bisonleap')).toHaveCount(0)
  await expect(view.getByText('one alpacarun')).toBeVisible()

  // The CLI reads the same lineage the window reported.
  const inspected = await profile.cli('conversation', 'inspect', conversation.id)
  const forked = (inspected.json as { conversation: { provider_thread_id: string } }).conversation.provider_thread_id
  expect(forked).not.toBe(original)
  await expect(panel.getByRole('status')).toContainText(`native session ${forked};`)
  await testInfo.attach('rewind-done.png', { body: await page.screenshot(), contentType: 'image/png' })
})

test('a rewind is unavailable while a turn runs, with the reason, and nothing changes', async ({
  profile,
  desktop,
}) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Busy rewind',
  })
  await send(profile, conversation.id, prompts.hold)
  await expect
    .poll(
      async () => (await profile.call('conversation.get', { conversation_id: conversation.id })).conversation.status,
    )
    .toBe('running')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Busy rewind' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  await view
    .locator('article[data-role="user"]')
    .first()
    .getByRole('button', { name: 'Rewind to before this prompt' })
    .click()
  const panel = view.getByRole('region', { name: 'Rewind conversation' })
  await expect(panel).toContainText('Rewind is unavailable:')
  await expect(panel.getByRole('button', { name: 'Rewind', exact: true })).toHaveCount(0)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'thread/fork')).toEqual([])
})
