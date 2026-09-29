import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import type { ClientState, Window } from '@ade/client'
import { emit } from './ipc'
import {
  getClient,
  getClientGeneration,
  getSocket,
  getStartupProfileSelection,
  isSwitching,
} from './profile-connection'
import { daemonCall } from './daemon-call'

// Native windows for the daemon's window records (daemon authority ticket 07). On start, main opens
// one native window per open record, or reopens or creates one when there is none; a native window
// the person closes closes its record, and its bounds are reported when a move or resize ends. Each
// window's renderer knows its record by the ID in its URL (`?window=`), and main answers its layout
// requests for that record only. Which workspace a window shows is its record's `workspace_id`.

/** Each app window's record ID, by web contents ID; null until the daemon gives it one. */
const records = new Map<number, string | null>()
/** How often each window's shown workspace changed, so a review started on one notices a switch. */
const epochs = new Map<string, { workspaceId: string; epoch: number }>()
let open: ((record: Window | null) => BrowserWindow) | null = null
let reconciled = -1
let reconciling = false
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/** How long startup waits for the daemon before it opens a window without a record. */
const STARTUP_WAIT_MS = 4_000
const BOUNDS_DELAY_MS = 400

const connected = (state: ClientState = getClient().getState()): boolean =>
  state.status === 'connected' && Boolean(state.catalog) && Boolean(getSocket())

/** The record a window's requests act on. */
export function recordOf(contentsId: number): string {
  const record = records.get(contentsId)
  if (!record) throw new Error('This window has no daemon record yet')
  return record
}

const catalogWindow = (id: string | null | undefined): Window | undefined =>
  id
    ? getClient()
        .getState()
        .catalog?.windows?.find((window) => window.id === id)
    : undefined

/**
 * The workspace a window shows, for requests fenced to it (review, feedback). `epoch` grows each
 * time the window switches, so a request that began on another selection notices.
 */
export function selectedWorkspace(
  contentsId: number,
): { workspaceId: string; conversationId: null; generation: number; epoch: number } | undefined {
  const window = catalogWindow(records.get(contentsId))
  if (!window) return undefined
  return {
    workspaceId: window.workspace_id,
    conversationId: null,
    generation: getClientGeneration(),
    epoch: epochs.get(window.id)?.epoch ?? 0,
  }
}

/** Follows each client state: counts workspace switches, and binds windows once connected. */
export function onClientState(state: ClientState): void {
  for (const window of state.catalog?.windows ?? []) {
    const seen = epochs.get(window.id)
    if (seen?.workspaceId !== window.workspace_id)
      epochs.set(window.id, { workspaceId: window.workspace_id, epoch: (seen?.epoch ?? 0) + 1 })
  }
  if (connected(state) && reconciled !== getClientGeneration() && open) void reconcile()
}

/** Tracks a native window: its record, bounds reports and closing. */
export function trackWindow(window: BrowserWindow, record: string | null): void {
  const id = window.webContents.id
  records.set(id, record)
  let timer: NodeJS.Timeout | undefined
  const report = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const current = records.get(id)
      if (window.isDestroyed() || !current || !connected() || window.isFullScreen()) return
      const { x, y, width, height } = window.getNormalBounds()
      void daemonCall('window.set_bounds', { window_id: current, bounds: { x, y, width, height } }).catch(
        (error: unknown) => console.warn('Could not save the window bounds', error),
      )
    }, BOUNDS_DELAY_MS)
  }
  window.on('moved', report)
  window.on('resized', report)
  window.on('closed', () => {
    clearTimeout(timer)
    const current = records.get(id)
    records.delete(id)
    // Quitting keeps every window open for the next launch; closing one by hand closes its record.
    if (current && !quitting && connected())
      void daemonCall('window.close', { window_id: current }).catch((error: unknown) =>
        console.warn('Could not close the window record', error),
      )
  })
}

function setRecord(window: BrowserWindow, record: string): void {
  records.set(window.webContents.id, record)
  emit(window.webContents, 'ade:window-id-changed', record)
}

const appWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter((window) => records.has(window.webContents.id))

/**
 * A record for a window that has none: a closed one reopened (the last listed whose workspace is
 * still there), or a new one on the daemon's first workspace.
 */
async function freeRecord(claimed: Set<string>, windows: Window[]): Promise<Window> {
  const workspaces = getClient().getState().catalog?.workspaces ?? []
  const live = new Set(workspaces.map((workspace) => workspace.id))
  const closed = windows.filter((window) => window.state === 'closed' && !claimed.has(window.id))
  const reopen = closed.reverse().find((window) => live.has(window.workspace_id))
  if (reopen) return (await daemonCall('window.reopen', { window_id: reopen.id })).window
  const first = workspaces[0]
  if (!first) throw new Error('The daemon lists no workspace to show')
  return (await daemonCall('window.create', { window_id: `window-${randomUUID()}`, workspace_id: first.id })).window
}

/** Gives every native window an open record and opens a native window for every other open record. */
async function reconcile(): Promise<void> {
  if (reconciling || !open) return
  reconciling = true
  const generation = getClientGeneration()
  try {
    const { windows } = await daemonCall('window.list', {})
    if (generation !== getClientGeneration()) return
    const claimed = new Set<string>()
    const unbound: BrowserWindow[] = []
    for (const window of appWindows()) {
      const record = records.get(window.webContents.id)
      const listed = windows.find((item) => item.id === record && item.state === 'open')
      if (listed && !claimed.has(listed.id)) claimed.add(listed.id)
      else unbound.push(window)
    }
    const waiting = windows.filter((window) => window.state === 'open' && !claimed.has(window.id))
    for (const window of unbound) {
      const record = waiting.shift() ?? (await freeRecord(claimed, windows))
      claimed.add(record.id)
      setRecord(window, record.id)
    }
    for (const record of waiting) open(record)
    if (appWindows().length === 0) open(await freeRecord(claimed, windows))
    reconciled = generation
  } catch (error) {
    console.error('Could not open the daemon windows', error)
  } finally {
    reconciling = false
  }
}

/**
 * Opens the windows at startup: once the daemon answers, one per open record; if it does not
 * answer soon, one window without a record, which gets one when the daemon connects.
 */
export async function startWindows(opener: (record: Window | null) => BrowserWindow): Promise<void> {
  open = opener
  const deadline = Date.now() + STARTUP_WAIT_MS
  while (Date.now() < deadline && (!connected() || isSwitching() || getStartupProfileSelection()))
    await new Promise((done) => setTimeout(done, 25))
  if (connected()) await reconcile()
  if (appWindows().length === 0) opener(null)
}

/** The Dock icon was clicked with no window open: bring one back. */
export function reopenWindow(): void {
  if (!open || appWindows().length > 0) return
  if (connected()) void reconcile().then(() => appWindows().length === 0 && open?.(null))
  else open(null)
}

/** Forces a fresh match of windows and records, as after a profile switch. */
export function rebindWindows(): void {
  reconciled = -1
  if (connected()) void reconcile()
}
