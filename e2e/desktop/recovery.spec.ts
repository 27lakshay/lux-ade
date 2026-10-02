// Ticket 14: after a provider dies before accepting a prompt, the window shows the same refusal the
// SDK and CLI give for an implicit resume, resumes only on an explicit choice, and never resends.
import { expect, prompts, test } from './fixtures'
import { waitForIdle } from '../protocol/fixtures'

test('an unknown delivery is resumed only on an explicit choice, and the prompt is not resent', async ({
  profile,
  desktop,
}, testInfo) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Unknown delivery',
  })
  await profile.releaseMock('codex', 'hang-turn-reply')
  void profile
    .call('agent.send', { conversation_id: conversation.id, request_id: 'unknown-prompt', text: prompts.turn })
    .catch(() => undefined)
  let pid = 0
  await expect
    .poll(async () => {
      pid = Number((await profile.mockCalls('codex')).find((entry) => entry.method === 'turn/start')?.pid ?? 0)
      return pid
    })
    .toBeGreaterThan(0)
  process.kill(pid, 'SIGKILL')
  await expect
    .poll(
      async () =>
        (await profile.call('conversation.get', { conversation_id: conversation.id })).messages.find(
          (message) => message.delivery?.request_id === 'unknown-prompt',
        )?.delivery?.native_outcome,
    )
    .toBe('unknown')

  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Unknown delivery' }).click()
  const recovery = page.locator(`[data-conversation-id="${conversation.id}"]`).getByRole('region', {
    name: 'Conversation recovery',
  })
  await recovery.getByRole('button', { name: 'Resume agent' }).click()
  await expect(recovery.getByRole('alert')).toContainText('The outcome of prompt unknown-prompt is unknown')
  await testInfo.attach('recovery-refused.png', { body: await page.screenshot(), contentType: 'image/png' })
  await recovery.getByRole('button', { name: 'Resume and let the session continue that work' }).click()
  await expect(recovery.getByRole('status')).toHaveText('Resumed. No prompt was sent again.')
  await waitForIdle(profile, conversation.id)
  expect((await profile.mockCalls('codex')).filter((entry) => entry.method === 'turn/start')).toHaveLength(1)
})
