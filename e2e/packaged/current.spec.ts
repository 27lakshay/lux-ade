// The currently built workspace shell and Electron bridge, using the same release
// artifact as package-protocol. Legacy composer/profile UI remains in macos.spec.ts.
import { DesktopLauncher, windowRecordOf } from '../desktop/fixtures'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { bundle, expect, test as packaged } from '../protocol/fixtures/packaged'
import type { ManagedProfile } from '../protocol/fixtures/managed-profiles'
import { waitForMessage, turnReply } from '../protocol/fixtures'

const test = packaged.extend<{ candidateDesktop: DesktopLauncher; candidateProfile: ManagedProfile }>({
  candidateProfile: async ({ host }, use) => {
    const profile = await host.create('Candidate desktop')
    const started = await profile.cli('workspace', 'list')
    expect(started.code, started.stderr).toBe(0)
    const directory = join(profile.root, 'desktop-workspace')
    await mkdir(directory, { recursive: true })
    await profile.call('workspace.open', { path: directory })
    await use(profile)
  },
  candidateDesktop: async ({ ade }, use, testInfo) => {
    const launcher = new DesktopLauncher(ade, testInfo, { executablePath: bundle.electron, args: [] })
    try {
      await use(launcher)
    } finally {
      await launcher.closeAll()
    }
  },
})

test('candidate workspace shell selects daemon records and retains its window after relaunch', async ({
  ade,
  candidateProfile: profile,
  candidateDesktop: desktop,
}) => {
  const repo = await ade.repo({ name: 'candidate-project' })
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const launch = await desktop.launch(profile.asScratch())
  expect(await launch.app.evaluate(() => process.execPath)).toBe(bundle.electron)
  const row = launch.window
    .getByRole('list', { name: 'Projects' })
    .getByRole('button', { name: 'candidate-project', exact: true })
    .last()
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'true')
  const id = windowRecordOf(launch.window)!
  expect(id).toBeTruthy()
  await expect
    .poll(async () => (await profile.call('window.list', {})).windows.find((item) => item.id === id)?.workspace_id)
    .toBe(workspace.id)
  await launch.window.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(launch.window.getByRole('dialog')).toBeVisible()
  await launch.window.keyboard.press('Escape')
  await expect(launch.window.getByRole('dialog')).toBeHidden()
  await desktop.quit(launch)
  const relaunched = await desktop.launch(profile.asScratch())
  expect(windowRecordOf(relaunched.window)).toBe(id)
  await expect(
    relaunched.window
      .getByRole('list', { name: 'Projects' })
      .getByRole('button', { name: 'candidate-project', exact: true })
      .last(),
  ).toHaveAttribute('aria-current', 'true')
})

test('candidate Electron bridge sends through the bundled provider and replays once', async ({
  candidateProfile: profile,
  candidateDesktop: desktop,
}) => {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title: 'Candidate bridge',
  })
  const { window: page } = await desktop.launch(profile.asScratch())
  expect(
    await page.evaluate(
      ({ conversationId }) =>
        window.adeHost.conversations.request('draft.save', {
          conversation_id: conversationId,
          text: 'hello',
        }),
      { conversationId: conversation.id },
    ),
  ).toMatchObject({ type: 'draft', draft: { text: 'hello' } })
  const request = () =>
    page.evaluate(
      ({ conversationId }) =>
        window.adeHost.conversations.request('agent.send', {
          conversation_id: conversationId,
          request_id: 'candidate-send',
          text: 'hello',
        }),
      { conversationId: conversation.id },
    )
  expect(await request()).toMatchObject({ type: 'ack' })
  await waitForMessage(profile.asScratch(), conversation.id, turnReply.codex)
  expect(await request()).toMatchObject({ type: 'ack', reconciled: true })
  const { messages } = await profile.call('conversation.get', { conversation_id: conversation.id })
  expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(profile.env.HOME).not.toBe(process.env.HOME)
})
