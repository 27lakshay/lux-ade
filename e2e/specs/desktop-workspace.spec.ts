import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

test('Electron opens a folder as a stable workspace in the selected profile', async () => {
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-workspace-e2e-'))
  const folder = join(daemon.rootDirectory, 'project-folder')
  await mkdir(folder)
  const canonicalFolder = await realpath(folder)
  const application = await electron.launch({
    executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const input = window.getByRole('textbox', { name: 'Open folder' })
    const workspaceNavigation = window.getByRole('complementary', { name: 'Workspace navigation' })
    await input.fill(join(daemon.rootDirectory, 'missing'))
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(workspaceNavigation.getByRole('alert')).toContainText('ENOENT')
    await input.fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(workspaceNavigation.getByRole('alert')).toHaveCount(0)
    await expect(window.getByRole('combobox', { name: 'Workspace' })).toHaveValue(/workspace_/)
    await expect(window.getByText(canonicalFolder, { exact: true })).toBeVisible()
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const opened = (catalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces.find((item) => item.root === canonicalFolder)
    expect(opened).toBeDefined()
    await expect(window.getByRole('combobox', { name: 'Workspace' })).toHaveValue(opened!.id)
    await window.reload()
    await expect(window.getByRole('combobox', { name: 'Workspace' })).toHaveValue(opened!.id)
    await expect(window.locator('.terminal-surface .xterm-rows')).toBeVisible()
    await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(window.getByRole('textbox', { name: 'Open folder' })).toHaveValue('')
    const repeated = await rpc(daemon.socket, { op: 'catalog.get' })
    expect((repeated.catalog as { workspaces: Array<{ root: string }> }).workspaces.filter((item) => item.root === canonicalFolder)).toHaveLength(1)
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})
