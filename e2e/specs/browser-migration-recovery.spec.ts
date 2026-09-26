import { expect, test, _electron as electron } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, stopManagedProfile, stopManagedProfiles, type ManagedProfileOwner, rpc } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const execFileAsync = promisify(execFile)

type Application = Awaited<ReturnType<typeof electron.launch>>
type OwnedRuntime = ManagedProfileOwner

async function fixture(): Promise<{ server: Server; url: string; reports: Array<{ page: string; cookie: string }> }> {
  const reports: Array<{ page: string; cookie: string }> = []
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://localhost')
    if (address.pathname === '/report') {
      reports.push({ page: address.searchParams.get('page') ?? '', cookie: request.headers.cookie ?? '' })
      response.writeHead(204).end()
      return
    }
    if (address.pathname === '/set') response.setHeader('Set-Cookie', 'profile=migrated; Path=/; Max-Age=3600')
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><body><script>fetch('/report?page=${address.pathname.slice(1)}').catch(() => {})</script></body></html>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture has no port')
  return { server, url: `http://127.0.0.1:${address.port}`, reports }
}



async function locateOwned(home: string): Promise<OwnedRuntime> {
  const located = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', home])).stdout) as { socket: string }
  return managedProfileOwner(located.socket)
}

async function quitNormally(application: Application): Promise<void> {
  const process = application.process()
  await application.evaluate(({ app }) => app.quit()).catch(() => undefined)
  if (process.exitCode === null) await new Promise<void>((done) => process.once('exit', () => done()))
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => child.once('exit', () => done()))
}

async function migrationStages(parent: string, storageKey: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(`${storageKey}.migrating-`))
}

async function creationStages(parent: string, storageKey: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(`${storageKey}.creating-`))
}

test('a second Electron process cannot write one profile browser while its owner is alive', async () => {
  test.setTimeout(70_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-lease-'))
  const web = await fixture()
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const common = { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'),
    ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'), ADE_E2E_HIDE_WINDOW: '1' }
  const launch = (name: string) => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...common, ADE_E2E_USER_DATA_DIR: join(directory, name) } })
  const owned: OwnedRuntime[] = []
  let first: Application | null = null
  let second: Application | null = null
  try {
    first = await launch('first')
    const firstWindow = await first.firstWindow()
    await firstWindow.getByRole('textbox', { name: 'New profile' }).fill('Shared')
    await firstWindow.getByRole('button', { name: 'Create' }).click()
    await expect(firstWindow.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await firstWindow.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((item) => item.name === 'Shared')!
    owned.push(await locateOwned(profile.home))
    await firstWindow.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
    await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')

    second = await launch('second')
    const secondWindow = await second.firstWindow()
    await secondWindow.getByRole('textbox', { name: 'New profile' }).waitFor()
    await expect.poll(async () => (await secondWindow.evaluate(() => window.adeHost.getProfileState())).error)
      .toContain('Another ADE process owns browser data')
    await expect(secondWindow.evaluate((id) => window.adeHost.selectProfile(id), profile.id))
      .rejects.toThrow(/Another ADE process owns browser data/)
    expect((await firstWindow.evaluate(() => window.adeHost.browser.list())).tabs).toHaveLength(1)

    const owner = first.process()
    owner.kill('SIGKILL')
    await waitForExit(owner)
    first = null
    await expect.poll(async () => secondWindow.evaluate((id) => window.adeHost.selectProfile(id)
      .then(() => true, () => false), profile.id), { timeout: 15_000 }).toBe(true)
    await expect(secondWindow.locator('header').getByRole('status')).toHaveText('connected')
    expect((await secondWindow.evaluate(() => window.adeHost.browser.list())).tabs).toHaveLength(1)
  } finally {
    await first?.close().catch(() => undefined)
    await second?.close().catch(() => undefined)
    await new Promise<void>((done) => web.server.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

for (const pause of ['fresh-stage', 'fresh-owner'] as const) {
  test(`a ${pause} crash creates a usable owned browser session on relaunch`, async () => {
    test.setTimeout(60_000)
    const directory = await mkdtemp(join(tmpdir(), `ade-browser-${pause}-`))
    const userData = join(directory, 'electron')
    const signal = join(directory, 'fresh-session-paused')
    const web = await fixture()
    const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
    const env = { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'), ADE_E2E_USER_DATA_DIR: userData,
      ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
    const launch = (paused: boolean) => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
      env: paused ? { ...env, ADE_E2E_BROWSER_MIGRATION_PAUSE: pause, ADE_E2E_BROWSER_MIGRATION_SIGNAL: signal } : env })
    const owned: OwnedRuntime[] = []
    let application: Application | null = null
    try {
      application = await launch(true)
      let window = await application.firstWindow()
      await window.getByRole('textbox', { name: 'New profile' }).waitFor()
      const created = await window.evaluate(() => window.adeHost.createProfile('Fresh'))
      const profile = created.profiles.find((item) => item.name === 'Fresh')!
      await window.evaluate((id) => { void window.adeHost.selectProfile(id).catch(() => undefined) }, profile.id)
      await expect.poll(async () => access(signal).then(() => true, () => false), { timeout: 15_000 }).toBe(true)
      owned.push(await locateOwned(profile.home))
      const storageKey = createHash('sha256').update(profile.id).digest('hex')
      const storageParent = join(userData, 'browser-sessions')
      const destination = join(storageParent, storageKey)
      const stages = await creationStages(storageParent, storageKey)
      expect(stages).toHaveLength(1)
      const stagedFiles = await readdir(join(storageParent, stages[0]))
      if (pause === 'fresh-stage') expect(stagedFiles).toHaveLength(0)
      else expect(stagedFiles).toContain('.ade-owner-v1.json')
      await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      const pausedProcess = application.process()
      pausedProcess.kill('SIGKILL')
      await waitForExit(pausedProcess)
      application = null

      application = await launch(false)
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      expect(await creationStages(storageParent, storageKey)).toHaveLength(0)
      expect(JSON.parse(await readFile(join(destination, '.ade-owner-v1.json'), 'utf8')))
        .toMatchObject({ version: 1, profileId: profile.id, storageKey })
      const opened = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
      const tabId = opened.tabs[0].id
      await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')
      await quitNormally(application)
      application = null

      application = await launch(false)
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id))
        .toEqual([tabId])
      await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
      await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
      expect(await creationStages(storageParent, storageKey)).toHaveLength(0)
    } finally {
      await application?.close().catch(() => undefined)
      await new Promise<void>((done) => web.server.close(() => done()))
      await stopManagedProfiles(owned)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const pause of ['stage', 'copy', 'marker', 'rename'] as const) {
  test(`a ${pause} boundary crash recovers the original browser tab and cookie`, async () => {
    test.setTimeout(90_000)
    const directory = await mkdtemp(join(tmpdir(), `ade-browser-${pause}-`))
    const profilesHome = join(directory, 'profiles')
    const userData = join(directory, 'electron')
    const signal = join(directory, 'migration-paused')
    const web = await fixture()
    const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
    const env = { ...environment, ADE_PROFILES_HOME: profilesHome, ADE_E2E_USER_DATA_DIR: userData,
      ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
    const launch = () => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory], env })
    const owned: OwnedRuntime[] = []
    let application: Application | null = null
    let paused: ChildProcess | null = null
    try {
      application = await launch()
      let window = await application.firstWindow()
      await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Personal')!
      owned.push(await locateOwned(profile.home))
      const original = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
      const tabId = original.tabs[0].id
      await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')
      await quitNormally(application)
      application = null

      const storageKey = createHash('sha256').update(profile.id).digest('hex')
      const storageParent = join(userData, 'browser-sessions')
      const destination = join(storageParent, storageKey)
      const source = join(profile.home, 'browser-session')
      await rename(destination, source)
      const sentinel = join(source, 'legacy-source-sentinel.txt')
      await writeFile(sentinel, `preserve source through ${pause}`)
      const sourceFiles = await readdir(source)
      const sourceOwner = await readFile(join(source, '.ade-owner-v1.json'), 'utf8').catch(() => '')
      paused = spawn(electronExecutable, [desktopDirectory], { env: { ...env,
        ADE_E2E_BROWSER_MIGRATION_PAUSE: pause, ADE_E2E_BROWSER_MIGRATION_SIGNAL: signal }, stdio: 'ignore' })
      await expect.poll(async () => {
        if (paused?.exitCode !== null || paused?.signalCode !== null) throw new Error(`Electron exited before ${pause} pause`)
        return access(signal).then(() => true, () => false)
      }, { timeout: 15_000 }).toBe(true)
      expect(await migrationStages(storageParent, storageKey)).toHaveLength(1)
      if (pause === 'stage') expect(await readdir(join(storageParent, (await migrationStages(storageParent, storageKey))[0]))).toHaveLength(0)
      if (pause === 'rename') expect(await readdir(destination)).toContain('.ade-owner-v1.json')
      paused.kill('SIGKILL')
      await waitForExit(paused)
      paused = null

      application = await launch()
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id))
        .toEqual([tabId])
      await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
      await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
      expect(await migrationStages(storageParent, storageKey)).toHaveLength(0)
      expect(await readdir(source)).toEqual(expect.arrayContaining(sourceFiles))
      expect(await readFile(sentinel, 'utf8')).toBe(`preserve source through ${pause}`)
      if (sourceOwner) expect(await readFile(join(source, '.ade-owner-v1.json'), 'utf8')).toBe(sourceOwner)
      expect(JSON.parse(await readFile(join(destination, '.ade-owner-v1.json'), 'utf8'))).toMatchObject({
        version: 1, profileId: profile.id, storageKey,
      })
    } finally {
      if (paused) { paused.kill('SIGKILL'); await waitForExit(paused).catch(() => undefined) }
      await application?.close().catch(() => undefined)
      await new Promise<void>((done) => web.server.close(() => done()))
      await stopManagedProfiles(owned)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('a mismatched owner refuses adoption and an ownerless switch targets the requested profile', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-owner-'))
  const userData = join(directory, 'electron')
  const web = await fixture()
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const env = { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'), ADE_E2E_USER_DATA_DIR: userData,
    ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
  const owned: OwnedRuntime[] = []
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory], env })
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Work')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const work = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Work')!
    owned.push(await locateOwned(work.home))
    // Connection can publish before createProfile finishes clearing its form.
    await expect(window.getByRole('textbox', { name: 'New profile' })).toHaveValue('')
    await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const personal = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Personal')!
    owned.push(await locateOwned(personal.home))
    const original = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
    const tabId = original.tabs[0].id
    await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')

    const storageKey = createHash('sha256').update(work.id).digest('hex')
    const destination = join(userData, 'browser-sessions', storageKey)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, '.ade-owner-v1.json'), JSON.stringify({ version: 1,
      profileId: personal.id, storageKey: createHash('sha256').update(personal.id).digest('hex') }))
    await expect(window.evaluate((id) => window.adeHost.selectProfile(id), work.id)).rejects.toThrow(/owner|migration review/i)
    await expect(window.evaluate((id) => window.adeHost.adoptBrowserSession(id), work.id)).rejects.toThrow(/owner/i)
    await expect(window.getByRole('button', { name: 'Adopt unverified browser session' })).toHaveCount(0)
    const state = await window.evaluate(() => window.adeHost.getProfileState())
    expect(state.activeId).toBe(personal.id)
    expect(state.selectedId).toBe(personal.id)
    expect((await window.evaluate(() => window.adeHost.getClientState())).status).toBe('connected')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([tabId])
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
    await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
    expect(JSON.parse(await readFile(join(destination, '.ade-owner-v1.json'), 'utf8'))).toMatchObject({ profileId: personal.id })
    await writeFile(join(destination, 'foreign-session-sentinel.txt'), 'another profile owns these browser bytes')
    await rm(join(destination, '.ade-owner-v1.json'))
    await expect(window.evaluate((id) => window.adeHost.selectProfile(id), work.id)).rejects.toThrow(/owner|migration review/i)
    const afterOwnerlessRefusal = await window.evaluate(() => window.adeHost.getProfileState())
    expect(afterOwnerlessRefusal.activeId).toBe(personal.id)
    expect(afterOwnerlessRefusal.selectedId).toBe(personal.id)
    expect(await readFile(join(destination, 'foreign-session-sentinel.txt'), 'utf8'))
      .toBe('another profile owns these browser bytes')
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
    await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
    await window.getByRole('combobox', { name: 'Profile' }).selectOption(work.id)
    const adopt = window.getByRole('button', { name: 'Adopt unverified browser session' })
    await expect(adopt).toBeVisible()
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    const dialogPromise = window.waitForEvent('dialog')
    const click = adopt.click()
    const dialog = await dialogPromise
    expect(dialog.message()).toContain(work.name)
    expect(dialog.message()).toContain(work.id)
    expect(dialog.message()).not.toContain(personal.id)
    await dialog.accept()
    await click
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    expect(JSON.parse(await readFile(join(destination, '.ade-owner-v1.json'), 'utf8')))
      .toMatchObject({ version: 1, profileId: work.id, storageKey })
    expect(await readFile(join(destination, 'foreign-session-sentinel.txt'), 'utf8'))
      .toBe('another profile owns these browser bytes')
    await window.getByRole('combobox', { name: 'Profile' }).selectOption(personal.id)
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
    await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
  } finally {
    await application.close().catch(() => undefined)
    await new Promise<void>((done) => web.server.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('moving a profile home refuses a stale runtime binding before browser writes', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-home-move-'))
  const originalHome = join(directory, 'profiles-original')
  const movedHome = join(directory, 'profiles-moved')
  const userData = join(directory, 'electron')
  const web = await fixture()
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const common = { ...environment, ADE_E2E_USER_DATA_DIR: userData,
    ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
  const launch = (profilesHome: string) => electron.launch({ executablePath: electronExecutable,
    args: [desktopDirectory], env: { ...common, ADE_PROFILES_HOME: profilesHome } })
  const owned: OwnedRuntime[] = []
  let application: Application | null = null
  try {
    application = await launch(originalHome)
    let window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Moved')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Moved')!
    const originalId = profile.id
    const originalStorageKey = createHash('sha256').update(originalId).digest('hex')
    owned.push(await locateOwned(profile.home))
    const original = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
    const tabId = original.tabs[0].id
    await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')
    await quitNormally(application)
    application = null
    const originalTabs = await readFile(join(profile.home, 'browser-tabs-v1.json'))
    const ownerFile = join(userData, 'browser-sessions', originalStorageKey, '.ade-owner-v1.json')
    const originalOwner = await readFile(ownerFile)
    const originalSessionFiles = await readdir(join(userData, 'browser-sessions', originalStorageKey))
    await stopManagedProfile(owned.at(-1)!)
    owned.pop()
    await rename(originalHome, movedHome)

    application = await launch(movedHome)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('unconfigured')
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.getProfileState())).error).not.toBe('')
    const state = await window.evaluate(() => window.adeHost.getProfileState())
    expect(state.error).toContain(originalHome)
    expect(state.activeId).toBeNull()
    expect(state.selectedId).toBe(originalId)
    const moved = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Moved')!
    expect(moved.id).toBe(originalId)
    expect(moved.home).not.toBe(profile.home)
    expect(JSON.parse(await readFile(ownerFile, 'utf8')))
      .toMatchObject({ version: 1, profileId: originalId, storageKey: originalStorageKey })
    expect(await readFile(ownerFile)).toEqual(originalOwner)
    expect(await readFile(join(moved.home, 'browser-tabs-v1.json'))).toEqual(originalTabs)
    expect(await readdir(join(userData, 'browser-sessions', originalStorageKey))).toEqual(originalSessionFiles)
    expect(await migrationStages(join(userData, 'browser-sessions'), originalStorageKey)).toHaveLength(0)
    expect(tabId).toBe(JSON.parse(originalTabs.toString())?.tabs?.[0]?.id)
  } finally {
    await application?.close().catch(() => undefined)
    await new Promise<void>((done) => web.server.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a pre-manifest browser session requires explicit adoption before its tab and cookie return', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-owner-upgrade-'))
  const userData = join(directory, 'electron')
  const web = await fixture()
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const env = { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'), ADE_E2E_USER_DATA_DIR: userData,
    ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
  const launch = () => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory], env })
  const owned: OwnedRuntime[] = []
  let application: Application | null = null
  try {
    application = await launch()
    let window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Existing')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const profile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Existing')!
    owned.push(await locateOwned(profile.home))
    const original = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/set`)
    const tabId = original.tabs[0].id
    await expect.poll(() => web.reports.findLast((item) => item.page === 'set')?.cookie).toContain('profile=migrated')
    await quitNormally(application)
    application = null
    const storageKey = createHash('sha256').update(profile.id).digest('hex')
    const destination = join(userData, 'browser-sessions', storageKey)
    const originalTabs = await readFile(join(profile.home, 'browser-tabs-v1.json'))
    const sentinel = join(destination, 'ownerless-session-sentinel.txt')
    await writeFile(sentinel, 'preserve the existing session')
    await rm(join(destination, '.ade-owner-v1.json'))
    const originalSessionFiles = await readdir(destination)

    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('unconfigured')
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.getProfileState())).error).not.toBe('')
    const state = await window.evaluate(() => window.adeHost.getProfileState())
    expect(state.error).toContain('Browser session ownership is unverified')
    expect(state.activeId).toBeNull()
    expect(state.selectedId).toBe(profile.id)
    expect(await readFile(join(profile.home, 'browser-tabs-v1.json'))).toEqual(originalTabs)
    expect(await readdir(destination)).toEqual(originalSessionFiles)
    expect(await readFile(sentinel, 'utf8')).toBe('preserve the existing session')
    expect(tabId).toBe(JSON.parse(originalTabs.toString())?.tabs?.[0]?.id)
    const adopt = window.getByRole('button', { name: 'Adopt unverified browser session' })
    await expect(adopt).toBeVisible()
    const cancelDialogPromise = window.waitForEvent('dialog')
    const cancelClick = adopt.click()
    const cancelDialog = await cancelDialogPromise
    expect(cancelDialog.message()).toContain(profile.name)
    expect(cancelDialog.message()).toContain(profile.id)
    expect(cancelDialog.message()).toMatch(/another profile.s cookies/i)
    await cancelDialog.dismiss()
    await cancelClick
    expect(await readdir(destination)).toEqual(originalSessionFiles)
    await expect(window.locator('header').getByRole('status')).toHaveText('unconfigured')

    const acceptDialogPromise = window.waitForEvent('dialog')
    const acceptClick = adopt.click()
    const acceptDialog = await acceptDialogPromise
    await acceptDialog.accept()
    await acceptClick
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    expect((await window.evaluate(() => window.adeHost.getProfileState())).activeId).toBe(profile.id)
    expect(JSON.parse(await readFile(join(destination, '.ade-owner-v1.json'), 'utf8')))
      .toMatchObject({ version: 1, profileId: profile.id, storageKey })
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id))
      .toEqual([tabId])
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: tabId, url: web.url })
    await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=migrated')
    expect(await readFile(sentinel, 'utf8')).toBe('preserve the existing session')
  } finally {
    await application?.close().catch(() => undefined)
    await new Promise<void>((done) => web.server.close(() => done()))
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})
