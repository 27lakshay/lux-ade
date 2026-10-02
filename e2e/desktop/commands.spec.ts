// Ticket 17: the window lists the provider's commands and skills with where each came from, and
// Run hands one to the provider in its native form as a tracked queue entry; it is not sent as
// typed text and runs once. Uses the Claude SDK double.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { waitForIdle } from '../protocol/fixtures'
import { claudeContents } from '../protocol/context/helpers'

test('a project command is listed with provenance and run once in its native form', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const workspace = catalog.workspaces[0]!
  await mkdir(join(workspace.root, '.claude/commands'), { recursive: true })
  await writeFile(
    join(workspace.root, '.claude/commands/review.md'),
    '---\ndescription: Review a file for bugs\nargument-hint: <file>\n---\nReview $ARGUMENTS carefully.\n',
  )
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: 'claude',
    title: 'Commands',
    provider_config: { setting_sources: ['project'] },
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Commands' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  await view.getByRole('button', { name: 'Commands and skills' }).click()
  const panel = view.getByLabel('Commands and skills')
  const review = panel.getByRole('listitem').filter({ hasText: '/review' })
  await expect(review).toContainText('Command /review — Review a file for bugs · from provider file')
  await expect(review).toContainText('.claude/commands/review.md')
  await review.getByLabel('Arguments for review').fill('src/app.ts')
  await review.getByRole('button', { name: 'Run review' }).click()
  await expect(panel.getByRole('status')).toContainText(
    "/review src/app.ts is in this conversation's queue for the provider to run as its own command",
  )
  await expect.poll(() => claudeContents(profile)).toEqual(['/review src/app.ts'])
  await waitForIdle(profile, conversation.id)
  expect(await claudeContents(profile)).toHaveLength(1)
  await testInfo.attach('commands.png', { body: await page.screenshot(), contentType: 'image/png' })
})
