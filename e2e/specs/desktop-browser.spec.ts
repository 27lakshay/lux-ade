import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string
const execFileAsync = promisify(execFile)

async function fixture(): Promise<{ server: Server; url: string; reports: Array<{ page: string; bridge: string; cookie: string }> }> {
  const reports: Array<{ page: string; bridge: string; cookie: string }> = []
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://localhost')
    if (address.pathname === '/report') {
      reports.push({ page: address.searchParams.get('page') ?? '', bridge: address.searchParams.get('bridge') ?? '',
        cookie: request.headers.cookie ?? '' })
      response.writeHead(204).end()
      return
    }
    if (address.pathname === '/redirect') { response.writeHead(302, { Location: '/landing' }).end(); return }
    if (address.pathname === '/blocked-redirect') { response.writeHead(302, { Location: 'file:///tmp/ade-browser-blocked' }).end(); return }
    if (address.pathname === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="blocked.txt"' })
      response.end('download should stay blocked')
      return
    }
    if (address.pathname === '/set') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `profile=${address.searchParams.get('value')}; Path=/; Max-Age=3600` })
    } else response.writeHead(200, { 'Content-Type': 'text/html' })
    if (address.pathname === '/permissions') {
      response.end(`<script>navigator.permissions.query({name:'geolocation'}).then((value) =>
        fetch('/report?page=permission&bridge=' + value.state))</script>`)
      return
    }
    const page = address.pathname.slice(1) || 'start'
    const frame = page === 'landing' ? '<iframe src="/frame"></iframe>' : ''
    const popup = page === 'landing' ? '<script>window.open("/popup")</script>' : ''
    response.end(`<html><head><title>${page}</title></head><body>${page}${frame}<script>
      fetch('/report?page=${page}&bridge=' + typeof window.adeHost).catch(() => {})
      </script>${popup}</body></html>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture has no port')
  return { server, url: `http://127.0.0.1:${address.port}`, reports }
}

async function stopOwned(socket: string, bootId: unknown): Promise<void> {
  const hello = await rpc(socket, { op: 'hello' }).catch(() => null)
  if (!hello || hello.boot_id !== bootId) return
  await rpc(socket, { op: 'runtime.prepare_restart', boot_id: bootId })
  if (typeof hello.runtime_socket !== 'string') return
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance, stop_active: true })
      return
    } catch (error) {
      if (attempt === 49) throw error
      await new Promise((done) => setTimeout(done, 50))
    }
  }
}

async function quitNormally(application: Awaited<ReturnType<typeof electron.launch>>): Promise<void> {
  const process = application.process()
  await application.evaluate(({ app }) => app.quit()).catch(() => undefined)
  if (process.exitCode === null) await new Promise<void>((done) => process.once('exit', () => done()))
}

test('profile browser tabs isolate cookies, restore identity, and reject closed IDs', async () => {
  const signedApp = process.env.ADE_E2E_BROWSER_APP
  if (signedApp) test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-browser-e2e-'))
  const profilesHome = join(directory, 'profiles')
  const web = await fixture()
  const { ADE_SOCKET: _fixedSocket, ADE_DAEMON_BIN: _parentDaemon, ...environment } = process.env
  const env = { ...environment, ADE_PROFILES_HOME: profilesHome, ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
    ...(signedApp ? {} : { ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }) }
  const owned: Array<{ socket: string; bootId: unknown }> = []
  const launch = () => electron.launch({ executablePath: signedApp ? join(signedApp, 'Contents/MacOS/Lux ADE') : electronExecutable,
    args: signedApp ? [] : [desktopDirectory], env })
  let application = await launch()
  try {
    let window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const first = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Personal')!
    const firstSocket = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', first.home])).stdout) as { socket: string }
    owned.push({ socket: firstSocket.socket, bootId: (await rpc(firstSocket.socket, { op: 'hello' })).boot_id })
    await window.getByRole('button', { name: 'Show preview' }).click()
    await window.getByRole('textbox', { name: 'Address' }).fill(`${web.url}/set?value=personal`)
    await window.getByRole('button', { name: 'Open tab' }).click()
    const personal = await window.evaluate(() => window.adeHost.browser.list())
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl)
      .toContain('/set?value=personal')
    expect(personal.tabs).toHaveLength(1)
    const personalId = personal.tabs[0].id
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: personalId, url: web.url })
    await expect.poll(() => web.reports.findLast((item) => item.page === 'probe')?.cookie).toContain('profile=personal')

    await window.getByRole('textbox', { name: 'New profile' }).fill('Work')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const second = (await window.evaluate(() => window.adeHost.getProfileState())).profiles.find((item) => item.name === 'Work')!
    const secondSocket = JSON.parse((await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', second.home])).stdout) as { socket: string }
    owned.push({ socket: secondSocket.socket, bootId: (await rpc(secondSocket.socket, { op: 'hello' })).boot_id })
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs).toHaveLength(0)
    await window.getByRole('button', { name: 'Show preview' }).click()
    await window.getByRole('textbox', { name: 'Address' }).fill(`${web.url}/set?value=work`)
    await window.getByRole('button', { name: 'Open tab' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl)
      .toContain('/set?value=work')
    const workId = (await window.evaluate(() => window.adeHost.browser.list())).tabs[0].id
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: workId, url: web.url })
    await expect.poll(() => web.reports.filter((item) => item.page === 'probe').at(-1)?.cookie).toContain('profile=work')
    await window.getByRole('combobox', { name: 'Profile' }).selectOption(first.id)
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([personalId])
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: personalId, url: web.url })
    await expect.poll(() => web.reports.filter((item) => item.page === 'probe').at(-1)?.cookie).toContain('profile=personal')
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl)
      .toContain('/probe')
    const conflictingSource = join(second.home, 'browser-session')
    await mkdir(conflictingSource)
    await writeFile(join(conflictingSource, 'original.txt'), 'keep the legacy source')
    await expect(window.evaluate((id) => window.adeHost.selectProfile(id), second.id))
      .rejects.toThrow(/migration review/)
    const afterRefusal = await window.evaluate(() => window.adeHost.getProfileState())
    expect(afterRefusal.activeId).toBe(first.id)
    expect(afterRefusal.selectedId).toBe(first.id)
    expect((await window.evaluate(() => window.adeHost.getClientState())).status).toBe('connected')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([personalId])
    expect(await readFile(join(conflictingSource, 'original.txt'), 'utf8')).toBe('keep the legacy source')
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: personalId, url: web.url })
    await expect.poll(() => web.reports.filter((item) => item.page === 'probe').at(-1)?.cookie).toContain('profile=personal')
    await rm(conflictingSource, { recursive: true })
    await quitNormally(application)
    const personalStorageKey = createHash('sha256').update(first.id).digest('hex')
    await rename(join(env.ADE_E2E_USER_DATA_DIR, 'browser-sessions', personalStorageKey), join(first.home, 'browser-session'))
    application = await launch()
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([personalId])
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: personalId, url: web.url })
    await expect.poll(() => web.reports.filter((item) => item.page === 'probe').at(-1)?.cookie).toContain('profile=personal')
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl).toContain('/probe')
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/redirect`), { id: personalId, url: web.url })
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.observedUrl)
      .toContain('/landing')
    await expect.poll(() => web.reports.some((item) => item.page === 'frame')).toBe(true)
    for (const page of ['set', 'probe', 'landing', 'frame']) expect(web.reports.some((item) => item.page === page)).toBe(true)
    expect(web.reports.filter((item) => ['set', 'probe', 'landing', 'frame'].includes(item.page)).every((item) => item.bridge === 'undefined')).toBe(true)
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.error)
      .toContain('Popup blocked')
    await expect(window.evaluate((url) => window.adeHost.browser.open(url), 'file:///tmp/ade-browser-blocked'))
      .rejects.toThrow(/Only HTTP\(S\) URLs/)
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/blocked-redirect`),
      { id: personalId, url: web.url })
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.error)
      .toMatch(/Blocked navigation|ERR_UNSAFE_REDIRECT/)
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/permissions`),
      { id: personalId, url: web.url })
    await expect.poll(() => web.reports.find((item) => item.page === 'permission')?.bridge).toBe('denied')
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/download`),
      { id: personalId, url: web.url })
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs[0]?.error)
      .toContain('Download blocked')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs[0].id).toBe(personalId)
    await window.getByRole('button', { name: 'New tab' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).selectedId).toBeNull()
    await expect(window.getByRole('button', { name: 'Open tab' })).toBeVisible()
    await window.getByRole('textbox', { name: 'Address' }).fill(`${web.url}/other`)
    await window.getByRole('button', { name: 'Open tab' }).click()
    await expect.poll(async () => (await window.evaluate(() => window.adeHost.browser.list())).tabs.length).toBe(2)
    const otherId = (await window.evaluate(() => window.adeHost.browser.list())).selectedId
    expect(otherId).not.toBe(personalId)
    await window.evaluate((id) => window.adeHost.browser.close(id), personalId)
    await expect(window.evaluate((id) => window.adeHost.browser.select(id), personalId)).rejects.toThrow(/unavailable/)
    expect((await window.evaluate(() => window.adeHost.browser.list())).selectedId).toBe(otherId)
    await window.getByRole('combobox', { name: 'Profile' }).selectOption(second.id)
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([workId])
    await expect(window.evaluate((id) => window.adeHost.browser.select(id), personalId)).rejects.toThrow(/unavailable/)
    expect((await window.evaluate(() => window.adeHost.browser.list())).selectedId).toBe(workId)
    await window.evaluate(({ id, url }) => window.adeHost.browser.navigate(id, `${url}/probe`), { id: workId, url: web.url })
    await expect.poll(() => web.reports.filter((item) => item.page === 'probe').at(-1)?.cookie)
      .toContain('profile=work')
  } finally {
    await application.close().catch(() => undefined)
    for (const item of owned) await stopOwned(item.socket, item.bootId).catch(() => undefined)
    await new Promise<void>((done) => web.server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('fixed daemon sockets with one Electron data directory do not share browser tabs', async () => {
  const first = await startDaemon()
  const second = await startDaemon()
  const directory = await mkdtemp(join(tmpdir(), 'ade-fixed-browser-e2e-'))
  const web = await fixture()
  const launch = (socket: string) => electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: socket, ADE_E2E_USER_DATA_DIR: directory } })
  let application = await launch(first.socket)
  try {
    let window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const original = await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/start`)
    expect(original.tabs).toHaveLength(1)
    await application.close()
    application = await launch(second.socket)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs).toHaveLength(0)
    await window.evaluate((url) => window.adeHost.browser.open(url), `${web.url}/other`)
    await application.close()
    const identity = createHash('sha256').update(resolve(first.socket)).digest('hex').slice(0, 32)
    const metadata = join(directory, 'browser-fixed', identity, 'browser-tabs-v1.json')
    const saved = JSON.parse(await readFile(metadata, 'utf8')) as { tabs: unknown[] }
    saved.tabs.unshift(null)
    await writeFile(metadata, JSON.stringify(saved))
    application = await launch(first.socket)
    window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    expect((await window.evaluate(() => window.adeHost.browser.list())).tabs.map((tab) => tab.id)).toEqual([original.tabs[0].id])
  } finally {
    await application.close().catch(() => undefined)
    await first.stop()
    await second.stop()
    await new Promise<void>((done) => web.server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
})
