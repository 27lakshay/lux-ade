// Ticket 27: the window shows each turn's usage with its native source and observation time, says
// when a figure was not reported instead of showing zero, shows rate limits as of their report,
// and opens a child agent's own transcript from the parent message. Uses the Claude SDK double.
import { send, waitForIdle } from '../protocol/fixtures'
import { expect, test } from './fixtures'

test('usage, limits and a child transcript read the same native evidence as the SDK', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'claude',
    title: 'Usage and children',
  })
  for (const prompt of ['usage', 'hello', 'typed-subagents']) {
    await send(profile, conversation.id, prompt)
    await waitForIdle(profile, conversation.id)
  }
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Usage and children' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)

  await view.getByRole('button', { name: 'Usage and limits' }).click()
  const turns = view.getByRole('list', { name: 'Turn usage' }).getByRole('listitem')
  await expect(turns).toHaveCount(3)
  // Newest first: the subagent and plain turns reported nothing; the usage turn reported figures.
  await expect(turns.nth(1)).toHaveText('The provider reported no usage for this turn')
  await expect(turns.nth(2)).toContainText("input 130, 100 cached · output 5 tokens · $0.5000 (the agent's estimate)")
  await expect(turns.nth(2)).toContainText('from result · observed ')
  const limits = view.getByRole('list', { name: 'Usage limits' }).getByRole('listitem')
  await expect(limits.first()).toContainText('five_hour: 25% used')
  await expect(limits.first()).toContainText('from rate_limit_event, as of ')
  const sdk = await profile.call('usage.turns', { conversation_id: conversation.id })
  expect(sdk.turns.map((turn) => turn.reported)).toEqual([false, false, true])

  // The parent message names its child; its own transcript loads from the provider.
  const children = view.getByRole('list', { name: 'Child agents' })
  // The timeline renders only rows near its viewport; scroll to the newest.
  const viewport = view.locator('[aria-label="Conversation history"] [data-slot="scroll-area-viewport"]').last()
  await expect
    .poll(async () => {
      await viewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      return children.count()
    })
    .toBe(1)
  await children.getByRole('button', { name: 'Show transcript' }).click()
  await expect(children.getByRole('list', { name: /^Transcript of / })).toContainText('Private child transcript')
  await expect(children).toContainText(/End of transcript|Load more of the transcript/)
  await testInfo.attach('usage-children.png', { body: await page.screenshot(), contentType: 'image/png' })
})
