// Ticket 09: the window shows what the open provider session was bound to, from the same
// daemon record the CLI and SDK read; an ambient session is labelled as the machine's own login.
import { expect, prompts, test, turnReply, waitForIdle, waitForMessage } from './fixtures'
import { send } from '../protocol/fixtures'

test('the window shows the session binding the SDK reads, and labels an ambient login', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Ambient binding',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Ambient binding' }).click()
  const view = page.locator(`[data-conversation-id="${conversation.id}"]`)
  const binding = view.getByText(/No provider session open|Session /)
  await expect(binding).toHaveText('No provider session open')

  await send(profile, conversation.id, prompts.turn)
  await waitForMessage(profile, conversation.id, turnReply.codex)
  await waitForIdle(profile, conversation.id)
  const recorded = (await profile.call('conversation.get', { conversation_id: conversation.id })).conversation.execution
  expect(recorded).toMatchObject({ account_context: 'ambient', account_id: null, account_generation: null })
  await expect(view.getByLabel('Session binding')).toHaveText(
    "Session uses this machine's own login, not isolated by ADE",
  )
  const cli = await profile.cli('conversation', 'inspect', conversation.id)
  expect(cli.json!.conversation).toMatchObject({ execution: recorded })
  await testInfo.attach('session-binding.png', { body: await page.screenshot(), contentType: 'image/png' })
})
