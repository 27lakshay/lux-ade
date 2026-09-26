import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function command(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, any> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(result.stdout) }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) }
  }
}

test('CLI reads only the exact live profile browser owner and tab', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-owner-cli-'))
  const web = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>ADE fixture</title>'))
  await new Promise<void>((done) => web.listen(0, '127.0.0.1', done))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('Browser fixture has no port')
  const url = `http://127.0.0.1:${address.port}/preview`
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'), ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'),
      ADE_E2E_HIDE_WINDOW: '1' } })
  const owned: ManagedProfileOwner[] = []
  try {
    const window = await application.firstWindow()
    async function createProfile(name: string): Promise<{ id: string; socket: string }> {
      await window.getByRole('textbox', { name: 'New profile' }).fill(name)
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.getByText(`Active profile: ${name}`)).toBeVisible()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === name)!
      const located = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'),
        'locate', '--home', profile.home])).stdout) as { socket: string }
      owned.push(await managedProfileOwner(located.socket))
      return { id: profile.id, socket: located.socket }
    }
    const first = await createProfile('First')
    const opened = await window.evaluate((address) => window.adeHost.browser.open(address), url)
    const tabId = opened.tabs[0].id
    await expect.poll(async () => (await command(first.socket, 'request', 'browser.owner.get',
      JSON.stringify({ profile_id: first.id }))).output.owner_id).toBeTruthy()
    await expect.poll(async () => (await command(first.socket, 'browser', 'owner')).output.owner_id).toBeTruthy()
    const owner = (await command(first.socket, 'browser', 'owner')).output.owner_id as string
    expect((await command(first.socket, 'browser', 'list', owner)).output)
      .toMatchObject({ profile_id: first.id, owner_id: owner, tabs: [expect.objectContaining({ id: tabId })] })
    expect((await command(first.socket, 'browser', 'inspect', owner, tabId)).output)
      .toMatchObject({ profile_id: first.id, owner_id: owner, tab: { id: tabId, profileId: first.id } })

    const second = await createProfile('Second')
    expect((await command(first.socket, 'browser', 'list', owner)).code).not.toBe(0)
    expect((await command(second.socket, 'browser', 'owner')).output.profile_id).toBe(second.id)
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs).toEqual([])
    await window.evaluate((id) => window.adeHost.selectProfile(id), first.id)
    await expect.poll(async () => (await command(first.socket, 'browser', 'owner')).output.owner_id).toBeTruthy()
    const renewed = (await command(first.socket, 'browser', 'owner')).output.owner_id as string
    expect(renewed).not.toBe(owner)
    expect((await command(first.socket, 'browser', 'list', owner)).code).not.toBe(0)
    expect((await command(first.socket, 'browser', 'inspect', renewed, tabId)).output.tab.id).toBe(tabId)
    await window.evaluate((id) => window.adeHost.browser.close(id), tabId)
    expect((await command(first.socket, 'browser', 'inspect', renewed, tabId)).code).not.toBe(0)

    await application.close()
    expect((await command(first.socket, 'browser', 'owner')).code).not.toBe(0)
  } finally {
    await application.close().catch(() => undefined)
    await new Promise<void>((done) => web.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
