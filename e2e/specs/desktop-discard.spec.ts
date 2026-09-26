import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string

test('Electron previews a discard, refuses a newer edit, then preserves the staged index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-discard-'))
  const checkout = join(directory, 'checkout')
  const userData = join(directory, 'electron')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', ['-C', checkout, '-c', 'user.name=ADE Fixture', '-c', 'user.email=ade@example.invalid',
    'commit', '-qm', 'baseline'])
  await writeFile(join(checkout, 'tracked.txt'), 'staged\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await writeFile(join(checkout, 'tracked.txt'), 'draft\n')
  const daemon = await startDaemon()
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    await rpc(daemon.socket, { op: 'workspace.open', path: checkout })
    application = await electron.launch({ executablePath: executable, args: [desktop],
      env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
        ADE_E2E_HIDE_WINDOW: '1' } })
    const window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'checkout' })
    const changes = window.getByRole('region', { name: 'Changes' })
    const preview = changes.getByRole('button', { name: 'Preview discard tracked.txt' })
    await expect(preview).toBeVisible()
    await preview.click()
    await expect(changes.getByRole('group', { name: 'Discard tracked.txt' })).toContainText('Staged changes stay staged')
    await expect(changes.getByRole('region', { name: 'Diff for tracked.txt' })).toContainText('draft')

    await writeFile(join(checkout, 'tracked.txt'), 'newer edit\n')
    await changes.getByRole('group', { name: 'Discard tracked.txt' }).getByRole('button', { name: 'Confirm discard' }).click()
    await expect(changes.getByRole('status')).toContainText('discard failed')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('newer edit\n')

    await expect(preview).toBeVisible()
    await preview.click()
    await expect(changes.getByRole('region', { name: 'Diff for tracked.txt' })).toContainText('newer edit')
    await changes.getByRole('group', { name: 'Discard tracked.txt' }).getByRole('button', { name: 'Confirm discard' }).click()
    await expect(changes.getByRole('button', { name: 'Unstage tracked.txt' })).toBeVisible()
    await expect(changes.getByRole('status')).toContainText('Recovery file:')
    await expect(preview).toHaveCount(0)
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('staged\n')
    expect((await run('git', ['-C', checkout, 'show', ':tracked.txt'])).stdout).toBe('staged\n')
  } finally {
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Electron retains the discard preview intent after a process crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-discard-crash-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  const userData = join(directory, 'electron')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', ['-C', checkout, '-c', 'user.name=ADE Fixture', '-c', 'user.email=ade@example.invalid',
    'commit', '-qm', 'baseline'])
  await writeFile(join(checkout, 'tracked.txt'), 'draft\n')
  const daemon = await startDaemon({ ADE_E2E_REVIEW_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' })
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const env = { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData,
      ADE_E2E_HIDE_WINDOW: '1' }
    application = await electron.launch({ executablePath: executable, args: [desktop], env })
    let window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'checkout' })
    let changes = window.getByRole('region', { name: 'Changes' })
    await changes.getByRole('button', { name: 'Preview discard tracked.txt' }).click()
    await expect(changes.getByRole('group', { name: 'Discard tracked.txt' })).toBeVisible()
    await writeFile(join(pause, 'armed'), '')
    await changes.getByRole('button', { name: 'Confirm discard' }).click()
    await expect.poll(() => stat(join(pause, 'signal')).then(() => true, () => false)).toBe(true)
    const text = await changes.locator('.review-operation').textContent()
    const id = text?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
    expect(id).toEqual(expect.any(String))
    application.process().kill('SIGKILL')
    await application.close().catch(() => undefined)
    application = await electron.launch({ executablePath: executable, args: [desktop], env })
    window = await application.firstWindow()
    await window.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'checkout' })
    changes = window.getByRole('region', { name: 'Changes' })
    await expect(changes.locator('.review-operation')).toContainText(id!)
    await writeFile(join(pause, 'release'), '')
    await expect(changes.getByText('No changed files in this workspace.')).toBeVisible()
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect((await rpc(daemon.socket, { op: 'review.operation', workspace_id: workspace.id,
      request_id: id })).operation).toMatchObject({ id, status: 'succeeded' })
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await application?.close().catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
