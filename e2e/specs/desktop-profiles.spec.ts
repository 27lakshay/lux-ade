import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, stopManagedProfiles, type ManagedProfileOwner, rpc } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string
const execFileAsync = promisify(execFile)

async function profileSocket(home: string): Promise<string> {
  const result = await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', home])
  return (JSON.parse(result.stdout) as { socket: string }).socket
}



test('Electron creates and switches independent profiles without stopping either daemon', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-desktop-profiles-e2e-'))
  const profilesHome = join(directory, 'profiles')
  const { ADE_SOCKET: _fixedSocket, ...environment } = process.env
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: {
      ...environment,
      ADE_PROFILES_HOME: profilesHome,
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
      ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'),
    },
  })
  const owned: ManagedProfileOwner[] = []
  try {
    const window = await application.firstWindow()
    const picker = window.getByRole('combobox', { name: 'Profile' })
    await expect(picker).toBeVisible()
    await expect(window.getByText('No active profile')).toBeVisible()

    await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const firstBoot = await window.locator('.connection-meta').textContent()
    const firstState = await window.evaluate(() => window.adeHost.getProfileState())
    const first = firstState.profiles.find((item) => item.name === 'Personal')!
    const firstSocket = await profileSocket(first.home)
    const firstHello = await rpc(firstSocket, { op: 'hello' })
    owned.push(await managedProfileOwner(firstSocket))
    expect(firstBoot).toContain(String(firstHello.boot_id))
    const firstCatalog = await rpc(firstSocket, { op: 'catalog.get' })
    const workspace = (firstCatalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const created = await rpc(firstSocket, {
      op: 'conversation.create', workspace_id: workspace.id, provider: 'codex', title: 'Personal only',
    })
    expect(created.type).toBe('ack')
    await expect(window.getByRole('button', { name: /Personal only/ })).toBeVisible()

    await expect(window.getByRole('textbox', { name: 'New profile' })).toHaveValue('')
    await window.getByRole('textbox', { name: 'New profile' }).fill('Work')
    await expect(window.getByRole('button', { name: 'Create' })).toBeEnabled()
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const secondState = await window.evaluate(() => window.adeHost.getProfileState())
    const second = secondState.profiles.find((item) => item.name === 'Work')!
    const secondSocket = await profileSocket(second.home)
    const secondHello = await rpc(secondSocket, { op: 'hello' })
    owned.push(await managedProfileOwner(secondSocket))
    expect(secondHello.boot_id).not.toBe(firstHello.boot_id)
    expect(await window.locator('.connection-meta').textContent()).toContain(String(secondHello.boot_id))
    await expect(window.getByRole('button', { name: /Personal only/ })).toHaveCount(0)
    const secondCatalog = await rpc(secondSocket, { op: 'catalog.get' })
    expect((secondCatalog.catalog as { conversations: Array<{ title: string }> }).conversations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Personal only' })]))
    expect((await rpc(firstSocket, { op: 'hello' })).boot_id).toBe(firstHello.boot_id)

    await picker.selectOption(first.id)
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await expect(window.locator('.connection-meta')).toContainText(String(firstHello.boot_id))
    await expect(window.getByRole('button', { name: /Personal only/ })).toBeVisible()
    expect((await rpc(secondSocket, { op: 'hello' })).boot_id).toBe(secondHello.boot_id)
  } finally {
    await application.close()
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
