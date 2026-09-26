import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfile, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const desktop = resolve('apps/desktop')
const executable = createRequire(join(desktop, 'package.json'))('electron') as string
const exec = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function command(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, any> }> {
  try {
    const { stdout } = await exec(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(stdout) }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) }
  }
}

test('CLI browser mutations keep the exact owner, tab and request receipt', async () => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-cli-mutation-'))
  const web = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'text/html' })
    .end(`<title>${request.url}</title>`))
  await new Promise<void>((done) => web.listen(0, '127.0.0.1', done))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('Browser fixture has no port')
  const firstUrl = `http://127.0.0.1:${address.port}/first`
  const secondUrl = `http://127.0.0.1:${address.port}/second`
  const { ADE_SOCKET: _fixed, ADE_DAEMON_BIN: _daemon, ...parent } = process.env
  const environment = { ...parent, ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_E2E_USER_DATA_DIR: join(directory, 'electron'), ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'),
    ADE_E2E_HIDE_WINDOW: '1' }
  let application = await electron.launch({ executablePath: executable, args: [desktop], env: environment })
  const owned: ManagedProfileOwner[] = []
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Browser CLI')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Browser CLI')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((item) => item.name === 'Browser CLI')!
    const { stdout } = await exec('python3', [resolve('scripts/runtime.py'), 'locate', '--home', profile.home])
    let socket = (JSON.parse(stdout) as { socket: string }).socket
    owned.push(await managedProfileOwner(socket))
    await expect.poll(async () => (await command(socket, 'browser', 'owner')).output.owner_id).toBeTruthy()
    const owner = (await command(socket, 'browser', 'owner')).output.owner_id as string

    const opened = await command(socket, 'browser', 'open', owner, firstUrl, '--request-id', 'open-one')
    expect(opened).toMatchObject({ code: 0, output: { type: 'browser_mutation', profile_id: profile.id,
      owner_id: owner, request_id: 'open-one' } })
    const tabId = opened.output.tab_id as string
    expect((await command(socket, 'browser', 'open', owner, firstUrl, '--request-id', 'open-one')).output.tab_id)
      .toBe(tabId)
    expect((await command(socket, 'browser', 'operation', 'open-one')).output)
      .toMatchObject({ state: 'completed', result: { tab_id: tabId } })
    expect((await command(socket, 'browser', 'open', owner, secondUrl, '--request-id', 'open-one')).code).not.toBe(0)
    expect((await command(socket, 'browser', 'list', owner)).output.tabs.map((tab: { id: string }) => tab.id))
      .toEqual([tabId])

    expect((await command(socket, 'browser', 'navigate', owner, tabId, secondUrl,
      '--request-id', 'navigate-one')).output.tab_id).toBe(tabId)
    expect((await command(socket, 'browser', 'navigate', owner, tabId, secondUrl,
      '--request-id', 'navigate-one')).output.tab_id).toBe(tabId)
    expect((await command(socket, 'browser', 'inspect', owner, tabId)).output.tab.requestedUrl).toBe(secondUrl)
    for (let index = 0; index < 513; index++) {
      const result = await rpc(socket, { op: 'browser.navigate', profile_id: profile.id, owner_id: owner,
        request_id: `many-navigations-${index}`, tab_id: tabId, url: secondUrl })
      expect(result.tab_id).toBe(tabId)
    }
    expect((await command(socket, 'browser', 'operation', 'many-navigations-512')).output.state)
      .toBe('completed')
    await application.close()
    expect((await command(socket, 'browser', 'owner')).code).not.toBe(0)
    await stopManagedProfile(owned[0])
    owned.length = 0
    application = await electron.launch({ executablePath: executable, args: [desktop], env: environment })
    const reopened = await application.firstWindow()
    await expect(reopened.locator('header').getByRole('status')).toHaveText('connected')
    const locatedAgain = await exec('python3', [resolve('scripts/runtime.py'), 'locate', '--home', profile.home])
    socket = (JSON.parse(locatedAgain.stdout) as { socket: string }).socket
    owned.push(await managedProfileOwner(socket))
    await expect.poll(async () => (await command(socket, 'browser', 'owner')).output.owner_id).toBeTruthy()
    const renewedOwner = (await command(socket, 'browser', 'owner')).output.owner_id as string
    expect(renewedOwner).not.toBe(owner)
    expect((await command(socket, 'browser', 'operation', 'open-one')).output)
      .toMatchObject({ state: 'completed', result: { owner_id: owner, tab_id: tabId } })
    expect((await command(socket, 'browser', 'open', renewedOwner, firstUrl, '--request-id', 'open-one')).code)
      .not.toBe(0)
    expect((await command(socket, 'browser', 'list', renewedOwner)).output.tabs.map((tab: { id: string }) => tab.id))
      .toEqual([tabId])
    expect((await command(socket, 'browser', 'close', renewedOwner, tabId, '--request-id', 'close-one')).output.tab_id)
      .toBe(tabId)
    expect((await command(socket, 'browser', 'close', renewedOwner, tabId, '--request-id', 'close-one')).output.tab_id)
      .toBe(tabId)
    expect((await command(socket, 'browser', 'inspect', renewedOwner, tabId)).code).not.toBe(0)
    expect((await reopened.evaluate(() => window.adeHost.browser.list())).tabs).toEqual([])
  } finally {
    await application.close().catch(() => undefined)
    await new Promise<void>((done) => web.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
