import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('a window restores separate conversation drafts and clears only after submission', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-drafts-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    const prompt = conversation.getByRole('textbox', { name: 'Prompt' })
    await expect(prompt).toBeEnabled()
    await prompt.fill('Unsent draft for the first conversation')
    await expect(prompt).toHaveValue('Unsent draft for the first conversation')
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(prompt).toHaveValue('Unsent draft for the first conversation')

    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect(prompt).toBeEnabled()
    await expect(prompt).toHaveValue('')
    await prompt.fill('typed-tool')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect(conversation.locator('.message-assistant')).toContainText('Hello world')
    await expect(prompt).toHaveValue('')
    await window.reload()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(prompt).toHaveValue('')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)

    await window.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: 'New Conversation' }).first().click()
    await expect(prompt).toHaveValue('Unsent draft for the first conversation')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
