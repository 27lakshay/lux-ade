import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
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
/** The open records the last match saw, so a window opened or closed elsewhere is followed. */
let seenOpen = ''
let inflight: Promise<void> | null = null
/**
 * A quit is under way: windows closing now keep their records, so they come back next launch.
 * Records of windows that close during a quit that is then cancelled are closed after all.
 */
let quitting = false
const closedDuringQuit = new Set<string>()

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

/** The quit is going ahead: every guard let it through. */
export function markQuitting(): void {
  quitting = true
}

/** The quit was cancelled (a guard or a window kept it): close the records of windows already gone. */
export function quitCancelled(): void {
  if (!quitting) return
  quitting = false
  for (const record of closedDuringQuit)
    void daemonCall('window.close', { window_id: record }).catch((error: unknown) =>
      console.warn('Could not close the window record', error),
    )
  closedDuringQuit.clear()
}

const openRecords = (state: ClientState): string =>
  (state.catalog?.windows ?? [])
    .filter((window) => window.state === 'open')
    .map((window) => window.id)
    .sort()
    .join(',')

/**
 * Follows each client state: counts workspace switches, and matches windows to records once
 * connected, after a profile switch, and whenever a window is opened or closed elsewhere (the CLI).
 */
export function onClientState(state: ClientState): void {
  for (const window of state.catalog?.windows ?? []) {
    const seen = epochs.get(window.id)
    if (seen?.workspaceId !== window.workspace_id)
      epochs.set(window.id, { workspaceId: window.workspace_id, epoch: (seen?.epoch ?? 0) + 1 })
  }
  // Not before startup has chosen the profile: records must land in the profile the app shows.
  if (!open || !connected(state) || isSwitching() || getStartupProfileSelection()) return
  if (reconciled !== getClientGeneration() || openRecords(state) !== seenOpen) void reconcile()
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
    if (current && quitting) closedDuringQuit.add(current)
    else if (current && connected())
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
 * A record for a window that has none (`window.claim`): an open one no other native window shows,
 * else a closed one reopened, else a new one on the daemon's first workspace.
 */
async function claimRecord(claimed: Set<string>): Promise<Window> {
  return (await daemonCall('window.claim', { window_id: `window-${randomUUID()}`, claimed: [...claimed] })).window
}

/** One match of native windows and records; see `reconcile`. */
async function reconcileOnce(): Promise<void> {
  if (!open) return
  const generation = getClientGeneration()
  const { windows } = await daemonCall('window.list', {})
  if (generation !== getClientGeneration()) return
  const claimed = new Set<string>()
  const unbound: BrowserWindow[] = []
  for (const window of appWindows()) {
    const record = records.get(window.webContents.id)
    const listed = windows.find((item) => item.id === record)
    // Closed elsewhere (the CLI): the native window goes too, and its record stays closed.
    if (listed?.state === 'closed') {
      records.set(window.webContents.id, null)
      window.close()
    } else if (listed && !claimed.has(listed.id)) claimed.add(listed.id)
    else unbound.push(window)
  }
  for (const window of unbound) {
    const record = await claimRecord(claimed)
    claimed.add(record.id)
    setRecord(window, record.id)
  }
  for (const record of windows) if (record.state === 'open' && !claimed.has(record.id)) open(record)
  reconciled = generation
  seenOpen = openRecords(getClient().getState())
}

/**
 * Gives every native window an open record, opens a native window for every other open record, and
 * closes the native window of a record closed elsewhere. Callers share one run in flight; it runs
 * again while a window still has no record (one opened meanwhile), at most three times.
 */
function reconcile(): Promise<void> {
  inflight ??= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await reconcileOnce()
        const unbound = appWindows().some((window) => !records.get(window.webContents.id))
        if (!unbound || !connected()) break
      }
    } catch (error) {
      console.error('Could not open the daemon windows', error)
    } finally {
      inflight = null
    }
  })()
  return inflight
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
  if (connected() && !isSwitching() && !getStartupProfileSelection()) {
    await reconcile()
    if (appWindows().length === 0) opener(await claimRecord(new Set()))
  }
  if (appWindows().length === 0) opener(null)
}

/** The Dock icon was clicked with no window open: bring one back, reopening its record. */
export function reopenWindow(): void {
  if (!open || appWindows().length > 0) return
  if (!connected()) {
    open(null)
    return
  }
  void (async () => {
    await reconcile()
    if (appWindows().length > 0 || !open) return
    try {
      open(await claimRecord(new Set()))
    } catch {
      open(null)
    }
  })()
}
