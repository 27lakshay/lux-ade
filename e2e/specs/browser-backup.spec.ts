import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const execFileAsync = promisify(execFile)

test('active browser backup restores a tab and persistent cookie into an independent profile', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-backup-'))
  const bundle = join(directory, 'browser.json')
  const pauseSignal = join(directory, 'browser-open-paused')
  const pauseRelease = join(directory, 'browser-open-release')
  const reports: Array<{ page: string; cookie: string }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/report') {
      reports.push({ page: url.searchParams.get('page') ?? '', cookie: request.headers.cookie ?? '' })
      response.writeHead(204).end()
      return
    }
    if (url.pathname === '/set') response.setHeader('Set-Cookie', [
      'persistent=kept; Path=/; Max-Age=3600', 'temporary=omitted; Path=/',
    ])
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><title>${url.pathname}</title><script>fetch('/report?page=${url.pathname.slice(1)}').catch(()=>{})</script></html>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no port')
  const base = `http://127.0.0.1:${address.port}`
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const userData = join(directory, 'electron')
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'), ADE_E2E_USER_DATA_DIR: userData,
      ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'), ADE_E2E_HIDE_WINDOW: '1',
      ADE_E2E_BROWSER_PAUSE: 'open-before-mutation', ADE_E2E_BROWSER_PAUSE_URL: `${base}/slow-open`,
      ADE_E2E_BROWSER_PAUSE_SIGNAL: pauseSignal, ADE_E2E_BROWSER_PAUSE_RELEASE: pauseRelease } })
  const owned: Array<{ socket: string; bootId: unknown }> = []
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Source')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const source = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Source')!
    const located = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', source.home])).stdout) as { socket: string }
    owned.push({ socket: located.socket, bootId: (await rpc(located.socket, { op: 'hello' })).boot_id })

    const initial = await window.evaluate((url) => window.adeHost.browser.open(url), `${base}/set`)
    const sourceTabId = initial.tabs[0].id
    await expect.poll(() => reports.findLast((item) => item.page === 'set')?.cookie).toContain('persistent=kept')
    const pendingOpen = window.evaluate((url) => window.adeHost.browser.open(url), `${base}/slow-open`)
    await expect.poll(() => stat(pauseSignal).then(() => true, () => false)).toBe(true)
    const pendingCapture = window.evaluate(({ id, file }) => window.adeHost.captureBrowserProfile(id, file),
      { id: source.id, file: bundle })
    await expect.poll(() => window.evaluate(() => window.adeHost.browser.list()).then(() => false,
      (error: unknown) => String(error).includes('Browser capture is in progress'))).toBe(true)
    await expect(stat(bundle)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(pauseRelease, 'release')
    await pendingOpen
    const captured = await pendingCapture
    expect(captured).toMatchObject({ type: 'browser_profile_captured', format: 'ade-browser-bundle-v1',
      source_profile_id: source.id, scope: 'tabs-and-persistent-cookies', tab_count: 2, cookie_count: 1 })
    expect(JSON.stringify(captured)).not.toContain('kept')
    const artifact = JSON.parse(await readFile(bundle, 'utf8')) as {
      excluded: string[]; tabs: { value: { tabs: Array<{ id: string }> } }; cookies: { value: Array<{ name: string }> }
    }
    expect(artifact.excluded).toEqual(expect.arrayContaining(['localStorage', 'IndexedDB', 'session cookies']))
    expect(artifact.tabs.value.tabs.map((tab) => tab.id)).toContain(sourceTabId)
    expect(artifact.tabs.value.tabs).toHaveLength(2)
    expect(artifact.cookies.value.map((cookie) => cookie.name)).toContain('persistent')
    expect(artifact.cookies.value.map((cookie) => cookie.name)).not.toContain('temporary')
    expect((await stat(bundle)).mode & 0o777).toBe(0o600)
    await expect(window.evaluate(({ id, file }) => window.adeHost.captureBrowserProfile(id, file),
      { id: source.id, file: bundle })).rejects.toThrow()
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, url),
      { id: sourceTabId, url: `${base}/source-probe` })
    await expect.poll(() => reports.findLast((item) => item.page === 'source-probe')?.cookie)
      .toContain('persistent=kept')

    const target = (await window.evaluate(() => window.adeHost.createProfile('Restored')))
      .profiles.find((item) => item.name === 'Restored')!
    expect(target.id).not.toBe(source.id)
    const corrupted = join(directory, 'corrupted-browser.json')
    const altered = structuredClone(artifact) as typeof artifact & { format: string }
    altered.tabs.value.tabs[0].id = 'tampered-tab'
    await writeFile(corrupted, JSON.stringify(altered))
    await expect(window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
      { file: corrupted, id: target.id })).rejects.toThrow(/failed verification/)
    const future = join(directory, 'future-browser.json')
    await writeFile(future, JSON.stringify({ ...artifact, format: 'ade-browser-bundle-v2' }))
    await expect(window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
      { file: future, id: target.id })).rejects.toThrow(/Unsupported browser backup format/)
    await expect(stat(join(userData, 'browser-sessions', createHash('sha256').update(target.id).digest('hex'))))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const restored = await window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
      { file: bundle, id: target.id })
    expect(restored).toMatchObject({ type: 'browser_profile_restored', source_profile_id: source.id,
      profile_id: target.id, tab_count: 2, cookie_count: 1 })
    await window.evaluate((id) => window.adeHost.selectProfile(id), target.id)
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const restoredTabs = await window.evaluate(() => window.adeHost.browser.list())
    expect(restoredTabs.profileId).toBe(target.id)
    expect(restoredTabs.tabs).toHaveLength(2)
    expect(restoredTabs.tabs[0].id).not.toBe(sourceTabId)
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, url),
      { id: restoredTabs.tabs[0].id, url: `${base}/probe` })
    await expect.poll(() => reports.findLast((item) => item.page === 'probe')?.cookie).toContain('persistent=kept')
    expect(reports.findLast((item) => item.page === 'probe')?.cookie).not.toContain('temporary=omitted')
    const restoredStorage = join(userData, 'browser-sessions', createHash('sha256').update(target.id).digest('hex'))
    expect(JSON.parse(await readFile(join(restoredStorage, '.ade-owner-v1.json'), 'utf8')))
      .toMatchObject({ profileId: target.id })
    await expect(window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
      { file: bundle, id: target.id })).rejects.toThrow()
  } finally {
    await application.close().catch(() => undefined)
    for (const item of owned) {
      const hello = await rpc(item.socket, { op: 'hello' }).catch(() => null)
      if (!hello || hello.boot_id !== item.bootId) continue
      await rpc(item.socket, { op: 'runtime.prepare_restart', boot_id: item.bootId }).catch(() => undefined)
      if (typeof hello.runtime_socket === 'string') await rpc(hello.runtime_socket,
        { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true }).catch(() => undefined)
    }
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
})

for (const phase of ['cookies', 'tabs', 'owner'] as const) {
  test(`browser restore resumes safely after a failure following ${phase}`, async () => {
    test.setTimeout(90_000)
    const directory = await mkdtemp(join(tmpdir(), `ade-browser-restore-${phase}-`))
    const bundle = join(directory, 'browser.json')
    const failOnce = join(directory, 'restore-failed-once')
    const server = createServer((_request, response) => {
      response.setHeader('Set-Cookie', 'persistent=restored; Path=/; Max-Age=3600')
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>Restore</title></html>')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port')
    const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
    const userData = join(directory, 'electron')
    const launchOptions = { executablePath: electronExecutable, args: [desktopDirectory],
      env: { ...environment, ADE_PROFILES_HOME: join(directory, 'profiles'), ADE_E2E_USER_DATA_DIR: userData,
        ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'), ADE_E2E_HIDE_WINDOW: '1',
        ADE_E2E_BROWSER_RESTORE_FAIL: phase, ADE_E2E_BROWSER_RESTORE_FAIL_ONCE: failOnce } }
    let application = await electron.launch(launchOptions)
    const owned: Array<{ socket: string; bootId: unknown }> = []
    try {
      let window = await application.firstWindow()
      await window.getByRole('textbox', { name: 'New profile' }).fill('Source')
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const source = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Source')!
      const sourceLocation = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', source.home])).stdout) as { socket: string }
      owned.push({ socket: sourceLocation.socket, bootId: (await rpc(sourceLocation.socket, { op: 'hello' })).boot_id })
      await window.evaluate((url) => window.adeHost.browser.open(url), `http://127.0.0.1:${address.port}/`)
      await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.title)
        .toBe('Restore')
      const target = (await window.evaluate((name) => window.adeHost.createProfile(name), `Restored ${phase}`))
        .profiles.find((item) => item.name === `Restored ${phase}`)!
      await window.evaluate(({ id, file }) => window.adeHost.captureBrowserProfile(id, file),
        { id: source.id, file: bundle })
      await expect(window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
        { file: bundle, id: target.id })).rejects.toThrow(`Injected browser restore failure after ${phase}`)
      await expect(stat(failOnce)).resolves.toBeDefined()
      await expect(stat(join(target.home, '.ade-browser-restore-v1.json'))).resolves.toBeDefined()
      await application.close()
      application = await electron.launch(launchOptions)
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect(window.evaluate((id) => window.adeHost.selectProfile(id), target.id))
        .rejects.toThrow(/Browser restore is incomplete/)
      const resumed = await window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
        { file: bundle, id: target.id })
      expect(resumed).toMatchObject({ type: 'browser_profile_restored', profile_id: target.id, tab_count: 1,
        cookie_count: 1 })
      await expect(stat(join(target.home, '.ade-browser-restore-v1.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      const repeated = await window.evaluate(({ file, id }) => window.adeHost.restoreBrowserProfile(file, id),
        { file: bundle, id: target.id })
      expect(repeated).toMatchObject({ already_complete: true, profile_id: target.id })
      const targetStorage = join(userData, 'browser-sessions', createHash('sha256').update(target.id).digest('hex'))
      expect(JSON.parse(await readFile(join(targetStorage, '.ade-owner-v1.json'), 'utf8')))
        .toMatchObject({ profileId: target.id })
      await window.evaluate((id) => window.adeHost.selectProfile(id), target.id)
      const restored = await window.evaluate(() => window.adeHost.browser.list())
      expect(restored.tabs).toHaveLength(1)
      expect(restored.profileId).toBe(target.id)
    } finally {
      await application.close().catch(() => undefined)
      for (const item of owned) {
        const hello = await rpc(item.socket, { op: 'hello' }).catch(() => null)
        if (!hello || hello.boot_id !== item.bootId) continue
        await rpc(item.socket, { op: 'runtime.prepare_restart', boot_id: item.bootId }).catch(() => undefined)
        if (typeof hello.runtime_socket === 'string') await rpc(hello.runtime_socket,
          { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true }).catch(() => undefined)
      }
      await new Promise<void>((done) => server.close(() => done()))
      await rm(directory, { recursive: true, force: true })
    }
  })
}
