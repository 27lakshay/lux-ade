import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

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
const browserStoragePath = (id: string): string => {
  if (id === 'fixed') return join(profilePath(id), 'browser-session')
  const key = createHash('sha256').update(id).digest('hex')
  return join(app.getPath('userData'), 'browser-sessions', key)
}
async function migrateBrowserStorage(id: string): Promise<void> {
  const source = join(profilePath(id), 'browser-session')
  const destination = browserStoragePath(id)
  if (source === destination) return
  const marker = join(destination, '.ade-migration-v1.json')
  if (await stat(destination).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })) {
    const completed = await readFile(marker, 'utf8').then((data) => JSON.parse(data) as { profileId?: string; source?: string }).catch(() => null)
    if (completed?.profileId === id && completed.source === source) return
    if (await stat(source).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })) throw new Error('Existing browser session needs migration review; original profile data remains intact')
    return
  }
  if (!(await stat(source).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  }))) return
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.migrating-${randomUUID()}`
  try {
    await cp(source, temporary, { recursive: true, force: false, errorOnExist: true })
    await writeFile(join(temporary, '.ade-migration-v1.json'), JSON.stringify({ profileId: id, source }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
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
  if (id) {
    const originalPath = profilePaths.get(id)
    if (originalPath && originalPath !== directory) {
      throw new Error('Browser profile home changed while active; restart ADE to rebind this profile')
    }
    profilePaths.set(id, directory as string)
    try { await migrateBrowserStorage(id) } catch (error) {
      if (originalPath === undefined) profilePaths.delete(id)
      else profilePaths.set(id, originalPath)
      throw error
    }
  }
  const previous = activeProfile
  activeProfile = null
  for (const window of BrowserWindow.getAllWindows()) detach(window)
  if (previous && previous !== id) {
    const prior = profiles.get(previous)
    await flushProfileSession(previous)
    for (const view of prior?.views.values() ?? []) if (!view.webContents.isDestroyed()) view.webContents.close()
    prior?.views.clear()
  }
  activeProfile = id
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
