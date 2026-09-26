import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('a changed diff after local send journaling cannot admit stale review feedback', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-admit-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const signal = join(userData, 'send-paused')
  const release = join(userData, 'send-release')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'first\nsecond\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test',
    'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'first\nselected line\n')
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1', ADE_E2E_SEND_JOURNAL_PAUSE: '1',
      ADE_E2E_SEND_JOURNAL_SIGNAL: signal, ADE_E2E_SEND_JOURNAL_RELEASE: release } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 2' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('This must remain local')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect.poll(async () => readFile(signal, 'utf8').catch(() => '')).toBe('paused')
    await writeFile(join(folder, 'sample.txt'), 'first\nnew line after check\n')
    await writeFile(release, 'release')
    await expect(changes.getByRole('alert')).toContainText('Stale diff')
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('This must remain local')
    const calls = await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => '')
    expect(calls).not.toContain('"method": "turn/start"')
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-user')).toHaveCount(0)
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('Electron sends feedback from a later page of a large diff', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-large-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'before\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test',
    'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), `before\n${'large change\n'.repeat(400_000)}`)
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await expect(changes.getByRole('button', { name: 'Next diff page' })).toBeVisible()
    await changes.getByRole('button', { name: 'Next diff page' }).click()
    await changes.getByRole('button', { name: 'Select line 1002' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Review this later-page line')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-user'))
      .toContainText('Review this later-page line')
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-user'))
      .toContainText('Line: +1002')
    await expect.poll(async () => (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n').filter((line) => line.includes('"method": "turn/start"')).length).toBe(1)
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('a crashed Electron process restores the anchored note and original send ID', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'ade-review-crash-e2e-'))
  const mockDirectory = join(userData, 'codex')
  const signal = join(userData, 'send-paused')
  const release = join(userData, 'send-release')
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory })
  const folder = join(daemon.rootDirectory, 'project')
  await mkdir(folder)
  await execFileAsync('git', ['init', '-q', folder])
  await writeFile(join(folder, 'sample.txt'), 'before\n')
  await execFileAsync('git', ['-C', folder, 'add', 'sample.txt'])
  await execFileAsync('git', ['-C', folder, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test',
    'commit', '-qm', 'initial'])
  await writeFile(join(folder, 'sample.txt'), 'after\n')
  const launch = (pause: boolean) => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1', ...(pause ? { ADE_E2E_SEND_JOURNAL_PAUSE: '1',
        ADE_E2E_SEND_JOURNAL_SIGNAL: signal, ADE_E2E_SEND_JOURNAL_RELEASE: release } : {}) } })
  let application = await launch(true)
  try {
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    let changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByText('sample.txt', { exact: true })).toBeVisible()
    await changes.getByRole('button', { name: 'Unstaged diff' }).click()
    await changes.getByRole('button', { name: 'Select line 1' }).click()
    await changes.getByRole('textbox', { name: 'Feedback note' }).fill('Keep this after a crash')
    await changes.getByRole('button', { name: 'Send feedback' }).click()
    await expect.poll(async () => readFile(signal, 'utf8').catch(() => '')).toBe('paused')
    const initial = JSON.parse(await readFile(join(userData, 'pending-sends-v1.json'), 'utf8')) as {
      records: Array<{ requestId: string }> }
    const requestId = initial.records[0].requestId
    const process = application.process()
    process.kill('SIGKILL')
    await expect.poll(() => process.signalCode).toBe('SIGKILL')
    application = await launch(false)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await window.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: 'project' })
    const originalConversation = window.getByRole('navigation', { name: 'Conversations' })
      .getByRole('button', { name: /New Conversation/ })
    await expect(originalConversation).toBeVisible()
    await originalConversation.click()
    changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.getByRole('textbox', { name: 'Feedback note' })).toHaveValue('Keep this after a crash')
    await changes.getByRole('button', { name: 'Retry feedback delivery' }).click()
    await expect(window.getByRole('region', { name: 'Conversation' }).locator('.message-user'))
      .toContainText('Keep this after a crash')
    const calls = (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const turns = calls.map((line) => JSON.parse(line) as { method: string; params?: { clientUserMessageId?: string } })
      .filter((call) => call.method === 'turn/start')
    expect(turns).toHaveLength(1)
    expect(turns[0].params?.clientUserMessageId).toBe(requestId)
  } finally {
    await application.close().catch(() => undefined)
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
