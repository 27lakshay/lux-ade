import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

type Tab = { id: string; profileId: string; requestedUrl: string; observedUrl: string; title: string; loading: boolean; error: string }
type Saved = { version: 1; selectedId: string | null; tabs: Array<Pick<Tab, 'id' | 'profileId' | 'requestedUrl' | 'observedUrl' | 'title'>> }
type ProfileTabs = { selectedId: string | null; tabs: Map<string, Tab>; views: Map<string, WebContentsView>; writes: Promise<void> }
type WindowTab = { profileId: string; tabId: string; bounds: Electron.Rectangle } | null
const profiles = new Map<string, ProfileTabs>()
const profilePaths = new Map<string, string>()
const loadingProfiles = new Map<string, Promise<ProfileTabs>>()
const guardedSessions = new Set<string>()
const windows = new Map<number, WindowTab>()
let activeProfile: string | null = null
type BrowserLease = { id: string; process: ChildProcessWithoutNullStreams; released: boolean }
let browserLease: BrowserLease | null = null

const allowedUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length > 8192) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
const abortedLoad = (error: unknown): boolean => /ERR_ABORTED|\(-3\)/.test(String(error))
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const profilePath = (id: string): string => {
  const directory = profilePaths.get(id)
  if (!directory) throw new Error('Browser profile storage is unavailable')
  return directory
}
const target = (id: string): string => join(profilePath(id), 'browser-tabs-v1.json')
const ownerName = '.ade-owner-v1.json'
const stageName = '.ade-stage-owner-v1.json'
const storageKey = (id: string): string => createHash('sha256').update(id).digest('hex')
const browserStoragePath = (id: string): string => {
  if (id === 'fixed') return join(profilePath(id), 'browser-session')
  return join(app.getPath('userData'), 'browser-sessions', storageKey(id))
}
async function acquireBrowserLease(id: string, directory: string): Promise<BrowserLease> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const script = app.isPackaged ? join(process.resourcesPath, 'browser_lease.py')
    : join(app.getAppPath(), '../../scripts/browser_lease.py')
  const child = spawn(app.isPackaged ? '/usr/bin/python3' : 'python3',
    [script, join(directory, '.ade-browser-session.lock')], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => undefined)
  const lease: BrowserLease = { id, process: child, released: false }
  try {
    const status = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Browser session lease timed out')), 10_000)
      const finish = (error?: Error, value?: string): void => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
        if (error) reject(error)
        else resolve(value ?? '')
      }
      const onError = (error: Error): void => finish(error)
      const onExit = (): void => finish(new Error('Browser session lease helper stopped before admission'))
      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8')
        if (output.length > 32) return finish(new Error('Browser session lease returned an invalid response'))
        const newline = output.indexOf('\n')
        if (newline >= 0) finish(undefined, output.slice(0, newline))
      }
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
    if (status !== 'ready') throw new Error(status === 'busy'
      ? `Another ADE process owns browser data for profile ${id}; close its browser before switching here`
      : 'Browser session lease returned an invalid response')
    child.on('exit', () => {
      if (lease.released || browserLease !== lease) return
      browserLease = null
      activeProfile = null
      for (const window of BrowserWindow.getAllWindows()) detach(window)
      for (const state of profiles.values()) {
        for (const view of state.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
        state.views.clear()
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('ade:browser-lease-lost', id)
      }
    })
    return lease
  } catch (error) {
    child.stdin.end()
    if (child.exitCode === null) child.kill()
    throw error
  }
}
async function releaseBrowserLease(lease: BrowserLease): Promise<void> {
  lease.released = true
  if (lease.process.exitCode !== null || lease.process.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { lease.process.kill(); resolve() }, 5_000)
    lease.process.once('exit', () => { clearTimeout(timer); resolve() })
    lease.process.stdin.end()
  })
}
async function directoryExists(directory: string): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Browser storage is not a directory; preserve it for review')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function writeOwner(directory: string, id: string): Promise<void> {
  const handle = await open(join(directory, ownerName), 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ version: 1, profileId: id, storageKey: storageKey(id) }))
    await handle.sync()
  } finally { await handle.close() }
  await syncDirectory(directory)
}
async function readSmallJson(file: string, limit = 4096): Promise<unknown | null> {
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.size > limit) throw new Error('Browser storage record is unsafe; preserve it for review')
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null) throw new Error('null record')
    return parsed
  }
  catch { throw new Error('Browser storage record is invalid; preserve it for review') }
}
async function checkOwner(directory: string, id: string): Promise<boolean> {
  const value = await readSmallJson(join(directory, ownerName))
  if (value === null) return false
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).profileId !== id ||
    (value as Record<string, unknown>).storageKey !== storageKey(id)) {
    throw new Error('Browser session belongs to another profile or has an invalid owner; preserve it for review')
  }
  return true
}
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) await syncTree(child)
    else if (entry.isFile()) {
      const handle = await open(child, 'r')
      try { await handle.sync() } finally { await handle.close() }
    } else throw new Error('Browser migration source has unsupported files; preserve it for review')
  }
  await syncDirectory(directory)
}
async function migrationPause(point: 'fresh-stage' | 'fresh-owner' | 'stage' | 'copy' | 'marker' | 'rename'): Promise<void> {
  if (process.env.ADE_E2E_HIDE_WINDOW !== '1' || process.env.ADE_E2E_BROWSER_MIGRATION_PAUSE !== point) return
  const signal = process.env.ADE_E2E_BROWSER_MIGRATION_SIGNAL
  if (!signal || !isAbsolute(signal)) throw new Error('Browser migration test signal must be absolute')
  await writeFile(signal, point, { flag: 'wx' })
  await new Promise<void>(() => undefined)
}
async function migrateBrowserStorage(id: string): Promise<void> {
  const source = join(profilePath(id), 'browser-session')
  const destination = browserStoragePath(id)
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const creatingPrefix = `${basename(destination)}.creating-`
  for (const name of await readdir(parent)) {
    if (!name.startsWith(creatingPrefix)) continue
    const stage = join(parent, name)
    if (!(await directoryExists(stage))) throw new Error('Interrupted browser creation needs review')
    const children = await readdir(stage)
    const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name.slice(creatingPrefix.length))
    if (!match || children.some((child) => child !== ownerName)) {
      throw new Error('Interrupted browser creation contains session data; preserve it for review')
    }
    let claim: unknown = null
    try { claim = await readSmallJson(join(stage, ownerName)) }
    catch { /* A partial owner record is safe to retire before any session starts. */ }
    if (claim && typeof claim === 'object' && !Array.isArray(claim) &&
      (claim as Record<string, unknown>).profileId !== undefined &&
      (claim as Record<string, unknown>).profileId !== id) {
      throw new Error('Interrupted browser creation belongs to another profile')
    }
    try { process.kill(Number(match[1]), 0); throw new Error('Another ADE process owns browser creation') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await rm(stage, { recursive: true })
  }
  if (source !== destination) {
    const prefix = `${storageKey(id)}.migrating-`
    for (const name of await readdir(parent)) {
      if (!name.startsWith(prefix)) continue
      const stage = join(parent, name)
      if (!(await directoryExists(stage))) throw new Error('Interrupted browser migration needs review; preserve its temporary copy')
      let claim: unknown | null = null
      try { claim = await readSmallJson(join(stage, stageName)) }
      catch { /* A partial claim is recoverable only before any session data was copied. */ }
      const candidate = claim && typeof claim === 'object' && !Array.isArray(claim) ? claim as Record<string, unknown> : null
      if (candidate?.profileId !== undefined && candidate.profileId !== id) {
        throw new Error('Interrupted browser migration has a different owner; preserve its temporary copy')
      }
      if (!candidate || candidate.version !== 1 || candidate.profileId !== id || candidate.storageKey !== storageKey(id)) {
        const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name.slice(prefix.length))
        const children = await readdir(stage)
        if (!match || children.some((child) => child !== stageName)) {
          throw new Error('Interrupted browser migration needs review; preserve its temporary copy')
        }
        try { process.kill(Number(match[1]), 0); throw new Error('Another ADE process owns the browser migration') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        await rm(stage, { recursive: true })
        continue
      }
      const pid = candidate.pid
      const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name.slice(prefix.length))
      if (!match || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid !== Number(match[1])) {
        throw new Error('Interrupted browser migration has an invalid process owner; preserve its temporary copy')
      }
      try { process.kill(pid, 0); throw new Error('Another ADE process owns the browser migration') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      await rm(stage, { recursive: true })
    }
  }
  if (await directoryExists(destination)) {
    const owned = await checkOwner(destination, id)
    if (source === destination) { if (!owned) await writeOwner(destination, id); return }
    const legacy = await readSmallJson(join(destination, '.ade-migration-v1.json')) as { profileId?: string } | null
    if (legacy?.profileId === id) { if (!owned) await writeOwner(destination, id); return }
    if (!(await directoryExists(source))) {
      if (owned) return
      throw new Error(`Browser session ownership is unverified for profile ${id}; review the saved session before adopting it`)
    }
    throw new Error('Existing browser session needs migration review; original profile data remains intact')
  }
  if (source === destination || !(await directoryExists(source))) {
    const stage = `${destination}.creating-${process.pid}-${randomUUID()}`
    await mkdir(stage, { mode: 0o700 })
    try {
      await migrationPause('fresh-stage')
      await writeOwner(stage, id)
      await migrationPause('fresh-owner')
      await rename(stage, destination)
      await syncDirectory(parent)
    } finally { await rm(stage, { recursive: true, force: true }) }
    return
  }
  const stage = `${destination}.migrating-${process.pid}-${randomUUID()}`
  await mkdir(stage, { mode: 0o700 })
  try {
    await migrationPause('stage')
    const claim = await open(join(stage, stageName), 'wx', 0o600)
    try { await claim.writeFile(JSON.stringify({ version: 1, profileId: id, storageKey: storageKey(id), source, pid: process.pid })); await claim.sync() }
    finally { await claim.close() }
    await syncDirectory(stage)
    await cp(source, join(stage, 'data'), { recursive: true, force: false, errorOnExist: true })
    await migrationPause('copy')
    if (!(await checkOwner(join(stage, 'data'), id))) await writeOwner(join(stage, 'data'), id)
    const marker = join(stage, 'data', '.ade-migration-v1.json')
    const existingMarker = await readSmallJson(marker) as { profileId?: string } | null
    if (existingMarker && existingMarker.profileId !== id) throw new Error('Browser migration source has a different owner')
    if (!existingMarker) {
      const handle = await open(marker, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ profileId: id, source })); await handle.sync() }
      finally { await handle.close() }
    }
    await syncTree(join(stage, 'data'))
    await migrationPause('marker')
    await rename(join(stage, 'data'), destination)
    await migrationPause('rename')
    await syncDirectory(parent)
  } finally { await rm(stage, { recursive: true, force: true }) }
}
export async function adoptUnownedBrowserStorage(id: string, directory: string): Promise<void> {
  if (!validId(id) || id === 'fixed' || !isAbsolute(directory)) throw new Error('Invalid browser profile for adoption')
  const lease = await acquireBrowserLease(id, directory)
  try {
    const destination = join(app.getPath('userData'), 'browser-sessions', storageKey(id))
    const source = join(directory, 'browser-session')
    if (!(await directoryExists(destination)) || await directoryExists(source)) {
      throw new Error('Browser session adoption requires one existing destination and no legacy source')
    }
    if (await checkOwner(destination, id)) throw new Error('Browser session already has a verified owner')
    const marker = await readSmallJson(join(destination, '.ade-migration-v1.json')) as { profileId?: string } | null
    if (marker) throw new Error('Browser migration marker requires separate review before adoption')
    const entries = await readdir(dirname(destination))
    if (entries.some((name) => name.startsWith(`${storageKey(id)}.migrating-`) ||
      name.startsWith(`${storageKey(id)}.creating-`))) {
      throw new Error('Interrupted browser storage work must be resolved before adoption')
    }
    await writeOwner(destination, id)
  } finally { await releaseBrowserLease(lease) }
}
const snapshot = (id: string): { profileId: string; selectedId: string | null; tabs: Tab[] } => {
  const state = profiles.get(id)
  return { profileId: id, selectedId: state?.selectedId ?? null, tabs: [...(state?.tabs.values() ?? [])].map((tab) => ({ ...tab })) }
}
const publish = (id: string): void => {
  const value = snapshot(id)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ade:browser-state', value)
  }
}
async function stateFor(id: string): Promise<ProfileTabs> {
  const existing = profiles.get(id)
  if (existing) return existing
  const inFlight = loadingProfiles.get(id)
  if (inFlight) return inFlight
  const work = (async (): Promise<ProfileTabs> => {
    let saved: Saved | null = null
    try {
      const parsed: unknown = JSON.parse(await readFile(target(id), 'utf8'))
      if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1 &&
        'tabs' in parsed && Array.isArray(parsed.tabs)) saved = parsed as Saved
    } catch (error) {
      if (error instanceof SyntaxError) await rename(target(id), `${target(id)}.corrupt-${randomUUID()}`)
      else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const tabs = new Map<string, Tab>()
    for (const item of saved?.tabs ?? []) {
      if (!item || typeof item !== 'object' || !validId(item.id) || item.profileId !== id || !allowedUrl(item.requestedUrl) ||
        typeof item.observedUrl !== 'string' || typeof item.title !== 'string') continue
      tabs.set(item.id, { ...item, loading: false, error: '' })
    }
    const state: ProfileTabs = { tabs, selectedId: validId(saved?.selectedId) && tabs.has(saved.selectedId) ? saved.selectedId : null,
      views: new Map(), writes: Promise.resolve() }
    profiles.set(id, state)
    return state
  })()
  loadingProfiles.set(id, work)
  try { return await work } finally { loadingProfiles.delete(id) }
}
async function save(id: string): Promise<void> {
  const state = await stateFor(id)
  const payload: Saved = { version: 1, selectedId: state.selectedId, tabs: [...state.tabs.values()].map((tab) => ({
    id: tab.id, profileId: id, requestedUrl: tab.requestedUrl, observedUrl: tab.observedUrl, title: tab.title,
  })) }
  state.writes = state.writes.catch(() => undefined).then(async () => {
    const file = target(id)
    await mkdir(profilePath(id), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  })
  await state.writes
}
function owner(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) throw new Error('Browser is unavailable')
  return window
}
function current(event: Electron.IpcMainInvokeEvent): { id: string; window: BrowserWindow } {
  const window = owner(event)
  if (!activeProfile) throw new Error('Profile is unavailable')
  return { id: activeProfile, window }
}
function exact(state: ProfileTabs, profileId: string, tabId: unknown): Tab {
  const tab = validId(tabId) ? state.tabs.get(tabId) : undefined
  if (!tab || tab.profileId !== profileId) throw new Error('unavailable: browser tab does not exist in this profile')
  return tab
}
function detach(window: BrowserWindow): void {
  const selection = windows.get(window.webContents.id)
  if (!selection) return
  const view = profiles.get(selection.profileId)?.views.get(selection.tabId)
  windows.set(window.webContents.id, null)
  if (view && !view.webContents.isDestroyed() && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.contentView.removeChildView(view)
  }
}
function attach(window: BrowserWindow, profileId: string, tabId: string, bounds: Electron.Rectangle): void {
  detach(window)
  const view = profiles.get(profileId)?.views.get(tabId)
  if (!view || view.webContents.isDestroyed()) return
  view.setBounds(bounds)
  window.contentView.addChildView(view)
  windows.set(window.webContents.id, { profileId, tabId, bounds })
}
function viewFor(id: string, state: ProfileTabs, tab: Tab, initialUrl = tab.observedUrl || tab.requestedUrl): WebContentsView {
  const existing = state.views.get(tab.id)
  if (existing && !existing.webContents.isDestroyed()) return existing
  const storage = browserStoragePath(id)
  const pageSession = session.fromPath(storage)
  if (!guardedSessions.has(storage)) {
    pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    pageSession.setPermissionCheckHandler(() => false)
    pageSession.setDevicePermissionHandler(() => false)
    pageSession.on('will-download', (event, _item, contents) => {
      event.preventDefault()
      for (const [tabId, candidate] of state.views) {
        if (candidate.webContents !== contents) continue
        const affected = state.tabs.get(tabId)
        if (affected) { affected.loading = false; affected.error = 'Download blocked in browser preview'; publish(id) }
        break
      }
    })
    guardedSessions.add(storage)
  }
  const view = new WebContentsView({ webPreferences: {
    session: pageSession, contextIsolation: true, nodeIntegration: false,
    sandbox: true, webSecurity: true, webviewTag: false,
  } })
  const wc = view.webContents
  const update = (): void => { publish(id); void save(id).catch(() => undefined) }
  const block = (url: string, main: boolean): boolean => {
    if (allowedUrl(url)) return false
    if (!main && (url === 'about:blank' || url === 'about:srcdoc' || /^(blob|data):/.test(url))) return false
    if (main) tab.error = `Blocked navigation: ${url.slice(0, 256)}`
    else tab.error = `Blocked frame navigation: ${url.slice(0, 256)}`
    if (main) tab.loading = false
    update()
    return true
  }
  wc.on('will-frame-navigate', (event) => { if (block(event.url, event.isMainFrame)) event.preventDefault() })
  wc.on('will-redirect', (event) => { if (block(event.url, event.isMainFrame)) event.preventDefault() })
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler(({ url }) => { tab.error = `Popup blocked: ${url.slice(0, 256)}`; update(); return { action: 'deny' } })
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = ''; publish(id) })
  wc.on('did-stop-loading', () => { tab.loading = false; publish(id) })
  wc.on('did-navigate', (_event, url) => {
    if (allowedUrl(url)) { tab.observedUrl = url; tab.requestedUrl = url; tab.error = ''; update() }
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && allowedUrl(url)) { tab.observedUrl = url; tab.requestedUrl = url; update() }
  })
  wc.on('page-title-updated', (_event, title) => { tab.title = title.slice(0, 512); update() })
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      tab.loading = false
      if (!tab.error) tab.error = `Load failed: ${description} (${code})`
      update()
    }
  })
  wc.on('render-process-gone', (_event, details) => { tab.loading = false; tab.error = `Page process stopped: ${details.reason}`; update() })
  state.views.set(tab.id, view)
  tab.loading = true
  void wc.loadURL(initialUrl).catch((error) => {
    if (wc.isDestroyed()) return
    tab.loading = wc.isLoading()
    if (!abortedLoad(error) && !tab.error) tab.error = `Load failed: ${String(error)}`
    else if (!tab.loading && !tab.error) tab.error = 'Navigation canceled'
    update()
  })
  return view
}

async function flushProfileSession(id: string): Promise<void> {
  const storage = browserStoragePath(id)
  if (!guardedSessions.has(storage)) return
  const pageSession = session.fromPath(storage)
  pageSession.flushStorageData()
  await pageSession.cookies.flushStore()
}
export async function setBrowserProfile(id: string | null, directory?: string): Promise<void> {
  if (id && (!directory || !isAbsolute(directory))) throw new Error('Browser profile needs an absolute storage path')
  // Migration can refuse an ambiguous destination. Validate it before detaching
  // the previous profile's views or changing the active browser identity.
  let acquired: BrowserLease | null = null
  if (id) {
    const originalPath = profilePaths.get(id)
    if (originalPath && originalPath !== directory) {
      throw new Error('Browser profile home changed while active; restart ADE to rebind this profile')
    }
    acquired = browserLease?.id === id ? null : await acquireBrowserLease(id, directory as string)
    profilePaths.set(id, directory as string)
    try {
      await migrateBrowserStorage(id)
      if (acquired && (acquired.process.exitCode !== null || acquired.process.signalCode !== null)) {
        throw new Error('Browser session lease ended during profile selection')
      }
    } catch (error) {
      if (acquired) await releaseBrowserLease(acquired)
      if (originalPath === undefined) profilePaths.delete(id)
      else profilePaths.set(id, originalPath)
      throw error
    }
  }
  const previous = activeProfile
  activeProfile = null
  for (const window of BrowserWindow.getAllWindows()) detach(window)
  try {
    if (previous && previous !== id) {
      const prior = profiles.get(previous)
      await flushProfileSession(previous)
      for (const view of prior?.views.values() ?? []) if (!view.webContents.isDestroyed()) view.webContents.close()
      prior?.views.clear()
    }
    if (acquired && (acquired.process.exitCode !== null || acquired.process.signalCode !== null)) {
      throw new Error('Browser session lease ended during profile selection')
    }
    if ((acquired || !id) && browserLease) {
      const previousLease = browserLease
      browserLease = acquired
      await releaseBrowserLease(previousLease)
    } else if (acquired) {
      browserLease = acquired
    }
    activeProfile = id
  } catch (error) {
    if (acquired && browserLease !== acquired) await releaseBrowserLease(acquired)
    activeProfile = previous
    throw error
  }
  if (id) void stateFor(id).then(() => publish(id)).catch(() => undefined)
}
export function closeBrowserWindow(window: BrowserWindow): void {
  detach(window)
  windows.delete(window.webContents.id)
  for (const state of profiles.values()) {
    for (const view of state.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
    state.views.clear()
  }
}
export async function flushBrowserSessions(): Promise<void> {
  await Promise.all([...profiles.values()].map((state) => state.writes))
  await Promise.all([...profilePaths.keys()].map(flushProfileSession))
}
export function registerBrowserIpc(): void {
  ipcMain.handle('ade:browser-list', async (event) => {
    const { id } = current(event)
    await stateFor(id)
    if (activeProfile !== id) throw new Error('Profile changed')
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-open', async (event, url: unknown) => {
    const { id } = current(event)
    if (!allowedUrl(url)) throw new Error('Only HTTP(S) URLs are supported')
    const state = await stateFor(id)
    if (activeProfile !== id) throw new Error('Profile changed')
    const address = url as string
    const tab: Tab = { id: randomUUID(), profileId: id, requestedUrl: address, observedUrl: '', title: address, loading: false, error: '' }
    state.tabs.set(tab.id, tab)
    state.selectedId = tab.id
    viewFor(id, state, tab)
    await save(id)
    publish(id)
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-select', async (event, tabId: unknown) => {
    const { id } = current(event)
    const state = await stateFor(id)
    const tab = exact(state, id, tabId)
    if (activeProfile !== id) throw new Error('Profile changed')
    state.selectedId = tab.id
    viewFor(id, state, tab)
    await save(id)
    publish(id)
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-new', async (event) => {
    const { id, window } = current(event)
    const state = await stateFor(id)
    if (activeProfile !== id) throw new Error('Profile changed')
    state.selectedId = null
    detach(window)
    await save(id)
    publish(id)
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-navigate', async (event, tabId: unknown, url: unknown) => {
    const { id } = current(event)
    const state = await stateFor(id)
    const tab = exact(state, id, tabId)
    if (!allowedUrl(url)) throw new Error('Only HTTP(S) URLs are supported')
    if (activeProfile !== id) throw new Error('Profile changed')
    tab.requestedUrl = url as string
    tab.error = ''
    await save(id)
    const existing = state.views.get(tab.id)
    const view = viewFor(id, state, tab, url as string)
    tab.loading = true
    publish(id)
    if (existing && !existing.webContents.isDestroyed()) void view.webContents.loadURL(url as string).catch((error) => {
      if (view.webContents.isDestroyed()) return
      tab.loading = view.webContents.isLoading()
      if (!abortedLoad(error) && !tab.error) tab.error = `Load failed: ${String(error)}`
      else if (!tab.loading && !tab.error) tab.error = 'Navigation canceled'
      publish(id)
    })
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-history', async (event, tabId: unknown, direction: unknown) => {
    const { id } = current(event)
    const state = await stateFor(id)
    const tab = exact(state, id, tabId)
    if (activeProfile !== id) throw new Error('Profile changed')
    const view = state.views.get(tab.id)
    if (!view || view.webContents.isDestroyed()) throw new Error('History is unavailable')
    if (direction === 'back' && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
    else if (direction === 'forward' && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward()
    else throw new Error('History is unavailable')
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-close', async (event, tabId: unknown) => {
    const { id } = current(event)
    const state = await stateFor(id)
    const tab = exact(state, id, tabId)
    if (activeProfile !== id) throw new Error('Profile changed')
    for (const window of BrowserWindow.getAllWindows()) {
      const selected = windows.get(window.webContents.id)
      if (selected?.profileId === id && selected.tabId === tab.id) detach(window)
    }
    const view = state.views.get(tab.id)
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
    state.views.delete(tab.id)
    state.tabs.delete(tab.id)
    if (state.selectedId === tab.id) state.selectedId = state.tabs.keys().next().value ?? null
    await save(id)
    publish(id)
    return snapshot(id)
  })
  ipcMain.handle('ade:browser-bounds', async (event, tabId: unknown, rect: unknown) => {
    const { id, window } = current(event)
    const state = await stateFor(id)
    const tab = exact(state, id, tabId)
    if (state.selectedId !== tab.id) throw new Error('Tab is not selected')
    if (!rect || typeof rect !== 'object') throw new Error('Invalid browser bounds')
    const candidate = rect as Electron.Rectangle
    const values = [candidate.x, candidate.y, candidate.width, candidate.height]
    if (values.some((value) => !Number.isFinite(value)) || candidate.width < 0 || candidate.height < 0) throw new Error('Invalid browser bounds')
    if (activeProfile !== id) throw new Error('Profile changed')
    const bounds = { x: Math.round(candidate.x), y: Math.round(candidate.y),
      width: Math.round(candidate.width), height: Math.round(candidate.height) }
    if (bounds.width === 0 || bounds.height === 0) { detach(window); return }
    viewFor(id, state, tab)
    attach(window, id, tab.id, bounds)
  })
  ipcMain.handle('ade:browser-hide', (event) => { detach(owner(event)) })
}
