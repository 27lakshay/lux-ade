import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const execFileAsync = promisify(execFile)

test('a delayed browser open cannot create a tab after profile selection changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-switch-race-'))
  const pauseSignal = join(directory, 'paused')
  const pauseRelease = join(directory, 'release')
  const delayedUrl = 'http://127.0.0.1:65534/delayed'
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'), ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'),
      ADE_E2E_HIDE_WINDOW: '1', ADE_E2E_BROWSER_PAUSE: 'open-before-mutation',
      ADE_E2E_BROWSER_PAUSE_URL: delayedUrl, ADE_E2E_BROWSER_PAUSE_SIGNAL: pauseSignal,
      ADE_E2E_BROWSER_PAUSE_RELEASE: pauseRelease } })
  const owned: ManagedProfileOwner[] = []
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('First')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const first = (await window.evaluate(() => window.adeHost.getProfileState()))
      .profiles.find((item) => item.name === 'First')!
    await window.getByRole('textbox', { name: 'New profile' }).fill('Second')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Second')).toBeVisible()
    const second = (await window.evaluate(() => window.adeHost.getProfileState()))
      .profiles.find((item) => item.name === 'Second')!
    for (const profile of [first, second]) {
      const located = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'),
        'locate', '--home', profile.home])).stdout) as { socket: string }
      owned.push(await managedProfileOwner(located.socket))
    }
    await window.evaluate((id) => window.adeHost.selectProfile(id), first.id)
    expect((await window.evaluate(() => window.adeHost.browser.list())).profileId).toBe(first.id)
    const delayed = window.evaluate((url) => window.adeHost.browser.open(url), delayedUrl)
      .then(() => 'accepted', (error: unknown) => String(error))
    await expect.poll(() => stat(pauseSignal).then(() => true, () => false)).toBe(true)
    await window.evaluate((id) => window.adeHost.selectProfile(id), second.id)
    const secondTab = await window.evaluate(() => window.adeHost.browser.open('http://127.0.0.1:65534/second'))
    const secondId = secondTab.tabs[0].id
    await window.evaluate((id) => window.adeHost.selectProfile(id), first.id)
    await writeFile(pauseRelease, 'release')
    expect(await delayed).toContain('Browser owner changed before opening the tab')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs).toEqual([])
    await window.evaluate((id) => window.adeHost.selectProfile(id), second.id)
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([secondId])
  } finally {
    await writeFile(pauseRelease, 'release').catch(() => undefined)
    await application.close().catch(() => undefined)
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
