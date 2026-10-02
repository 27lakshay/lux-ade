import { app, BrowserWindow, dialog, screen, session } from 'electron'
import type { Window } from '@ade/client'
import { broadcast, handle, listen, registerAppWindow } from './ipc'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { browserQuitGuard, closeBrowserWindow, registerBrowserIpc, setBrowserProfile } from './browser'
import { BrowserOwner } from './browser-owner'
import { registerConversationIpc } from './conversations/ipc'
import { draftQuitGuard, warnPendingSends } from './conversations/quit-guard'
import {
  drafts,
  flushDraft,
  reconcileAcceptedSend,
  setSendJournal,
  unsafePending,
  windowIds,
} from './conversations/send-pipeline'
import { registerFileIpc } from './files'
import { watchActivity } from './notifications'
import { openDesktopJournals } from './outbox-file'
import {
  fixedSocket,
  getBrowserOwner,
  getClient,
  getSocket,
  managedProfiles,
  publishProfile,
  refreshProfiles,
  setBrowserOwner,
  setStartupProfileSelection,
  setUnsubscribeClient,
  setUnsubscribeFeed,
  stopClient,
} from './profile-connection'
import { registerProfileIpc, selectProfile } from './profiles'
import { finishQuit, holdQuit, registerQuitGuard, registerQuitTeardown } from './quit-guards'
import { registerReviewIpc, setGitJournal } from './review'
import { registerServiceIpc } from './services'
import { disconnectWindow, setStreamProfile, startStreamBridge, stopStreamBridge } from './stream-bridge'
import { registerSettingsIpc } from './settings'
import { registerThemesIpc } from './themes'
import { registerTerminalIpc } from './terminals'
import { registerWorkspaceActionIpc } from './workspace-actions'
import { registerWorkspaceIpc } from './workspaces'
import { registerLayoutIpc } from './layouts'
import { markQuitting, onClientState, quitCancelled, reopenWindow, startWindows, trackWindow } from './windows'
import { installAppMenu, setMenuKeybindings } from './app-menu'
import { registerAppScheme, serveAppScheme, windowUrl } from './app-protocol'
import { lockDownAppSession, lockDownAppWindow, refuseWebviews } from './app-security'
import { enableRemoteDebugging, startDevStateServer } from './dev'
import { initializeLogging, logWindowConsole } from './logging'
import { startCrashReporter } from './diagnostics'
import { recoverRendererFailures } from './renderer-recovery'
import { registerPluginUiIpc, servePluginScheme } from './plugin-ui'
import { loadAppearance, setAppearance, watchAppearance, windowBackground } from './appearance'
import { isThemePreference, TRAFFIC_LIGHTS } from '../shared/window-chrome'
import { registerNativeAccessibility } from './native-accessibility'
let singleWindowId = ''
enableRemoteDebugging()
registerAppScheme()
refuseWebviews()
if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}
initializeLogging()
startCrashReporter()
startDevStateServer()
registerBrowserIpc(selectProfile)
const stopNativeAccessibility = registerNativeAccessibility()

handle('ade:app-version', () => app.getVersion())
// The renderer follows the profile's appearance setting and sends each change; main applies it to
// macOS and keeps the startup copy (appearance.ts).
listen('ade:keybindings', (_event, keybindings: unknown) => setMenuKeybindings(keybindings))
listen('ade:theme', (_event, theme: unknown) => {
  if (isThemePreference(theme)) setAppearance(theme)
})
// The renderer knows what its pane layout needs; the window may not shrink below it. A window
// already smaller grows to fit, within its screen.
listen('ade:window-minimum-size', (event, width: unknown, height: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || typeof width !== 'number' || typeof height !== 'number') return
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  const area = screen.getDisplayMatching(window.getBounds()).workAreaSize
  const minimum = {
    width: Math.round(Math.min(area.width, Math.max(WINDOW_MINIMUM.width, width))),
    height: Math.round(Math.min(area.height, Math.max(WINDOW_MINIMUM.height, height))),
  }
  window.setMinimumSize(minimum.width, minimum.height)
  const [current, currentHeight] = window.getSize() as [number, number]
  if (current < minimum.width || currentHeight < minimum.height)
    window.setSize(Math.max(current, minimum.width), Math.max(currentHeight, minimum.height))
})
registerProfileIpc()
registerConversationIpc()
registerPluginUiIpc()
registerWorkspaceIpc()
registerLayoutIpc()
registerWorkspaceActionIpc()
registerTerminalIpc()
registerSettingsIpc()
registerThemesIpc()
registerServiceIpc()
registerReviewIpc()
registerFileIpc()

// Order matters: drafts are saved before browser sessions are flushed.
registerQuitGuard(draftQuitGuard)
registerQuitGuard(browserQuitGuard)
// Teardown waits for will-quit: a window's close handler can still cancel the quit.
registerQuitTeardown(async () => {
  const owner = getBrowserOwner()
  setBrowserOwner(null)
  await owner?.close()
})
registerQuitTeardown(stopNativeAccessibility)
registerQuitTeardown(() => {
  stopStreamBridge()
  stopClient()
})
// localStorage (per-viewer conveniences only) is written lazily; flush it so nothing written just
// before quitting is lost.
registerQuitTeardown(() => session.defaultSession.flushStorageData())

/** Main's own floor for any window, whatever its layout asks for. */
const WINDOW_MINIMUM = { width: 720, height: 480 } as const

/**
 * Opens a native window for a daemon window record, at its bounds; or, with no daemon yet, a window
 * that gets its record once the daemon connects (windows.ts).
 */
function openAppWindow(record: Window | null): BrowserWindow {
  const bounds = record?.bounds
  const window = new BrowserWindow({
    // Shown once the first frame is painted (ready-to-show below), so it never opens blank.
    show: false,
    width: bounds ? Math.round(bounds.width) : 1440,
    height: bounds ? Math.round(bounds.height) : 900,
    ...(bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : {}),
    minWidth: WINDOW_MINIMUM.width,
    minHeight: WINDOW_MINIMUM.height,
    title: 'ADE',
    // The daemon keeps the window's position and size; Electron keeps its fullscreen or maximized
    // state by name, the record's ID (experimental in Electron 44).
    ...(record ? { name: record.id, windowStatePersistence: true } : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHTS,
    // The page's own background, so resizing or loading never shows another colour.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.env.ADE_E2E_HIDE_WINDOW !== '1') window.once('ready-to-show', () => window.show())
  windowIds.set(window.webContents.id, singleWindowId)
  registerAppWindow(window.webContents)
  trackWindow(window, record?.id ?? null)
  logWindowConsole(window.webContents, 'window')
  recoverRendererFailures(window)
  let readyForClose = false
  let closeFlushInProgress = false
  window.on('close', (event) => {
    // E2E teardown must not surface a native modal over the user's active Space.
    // The test process owns this isolated profile and may deliberately leave an
    // uncertain send to verify recovery after process exit.
    if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.env.ADE_E2E_TEST_CLOSE_GUARD !== '1') return
    if (readyForClose) return
    if (closeFlushInProgress) {
      event.preventDefault()
      return
    }
    const owned = [...drafts.entries()]
      .filter(([key]) => key.startsWith(`${window.webContents.id}:`))
      .map(([, entry]) => entry)
    if (!owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) return
    event.preventDefault()
    closeFlushInProgress = true
    void (async () => {
      await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
        quitCancelled()
        return
      }
      const pending = owned.filter(
        (entry) => !entry.send && (entry.timer || entry.savedRevision < entry.draft.revision),
      )
      const results = await Promise.allSettled(pending.map(flushDraft))
      if (results.some((result) => result.status === 'rejected')) {
        if (process.env.ADE_E2E_USER_DATA_DIR) console.error('Draft was not saved during window close')
        else
          await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Draft was not saved',
            message: 'This window is staying open because a draft could not be saved.',
            detail: 'Restore the profile daemon and try closing the window again.',
          })
        quitCancelled()
        return
      }
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
        quitCancelled()
        return
      }
      readyForClose = true
      if (!window.isDestroyed()) window.close()
    })().finally(() => {
      closeFlushInProgress = false
    })
  })
  window.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) disconnectWindow(window.webContents.id)
  })
  window.webContents.on('destroyed', () => {
    closeBrowserWindow(window)
    disconnectWindow(window.webContents.id)
    for (const [key, entry] of drafts) {
      if (!key.startsWith(`${window.webContents.id}:`)) continue
      void flushDraft(entry)
        .then(() => drafts.delete(key))
        .catch(() => undefined)
    }
    windowIds.delete(window.webContents.id)
  })

  lockDownAppWindow(window.webContents)
  void window.loadURL(windowUrl(record?.id ?? null))
  return window
}

app
  .whenReady()
  .then(async () => {
    installAppMenu()
    serveAppScheme(session.defaultSession)
    servePluginScheme(session.defaultSession)
    lockDownAppSession(session.defaultSession)
    if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.platform === 'darwin') {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    }
    loadAppearance()
    const journals = await openDesktopJournals()
    singleWindowId = journals.ownerId
    setSendJournal(journals.send)
    setGitJournal(journals.git)
    if (!managedProfiles && fixedSocket) {
      const fixedIdentity = createHash('sha256').update(resolve(fixedSocket)).digest('hex').slice(0, 32)
      const home = join(app.getPath('userData'), 'browser-fixed', fixedIdentity)
      await setBrowserProfile('fixed', home)
      setBrowserOwner(await BrowserOwner.open(`fixed-${fixedIdentity}`, 'fixed'))
    }
    setUnsubscribeClient(
      getClient().subscribe((state) => {
        broadcast('ade:client-state-changed', state)
        onClientState(state)
        if (state.status === 'connected' && fixedSocket) {
          void getBrowserOwner()
            ?.register(fixedSocket, state.bootId)
            .catch((error) => console.error('Browser owner registration failed', error))
        }
      }),
    )
    // The feed reaches windows through the stream bridge; main watches it only for notifications.
    const stopActivity = watchActivity(getClient())
    const stopAppearance = fixedSocket ? watchAppearance(getClient(), fixedSocket) : () => {}
    setUnsubscribeFeed(() => {
      stopActivity()
      stopAppearance()
    })
    getClient().start()
    startStreamBridge()
    setStreamProfile(getSocket() ?? null)
    if (managedProfiles) {
      setStartupProfileSelection(
        refreshProfiles()
          .then(async (state) => {
            if (state.selectedId) await selectProfile(state.selectedId, false)
          })
          .catch((error) => {
            publishProfile({ error: String(error) })
          })
          .finally(() => {
            setStartupProfileSelection(null)
          }),
      )
    }
    // One native window per open daemon window record, once the daemon answers.
    await startWindows(openAppWindow)
    app.on('activate', reopenWindow)
  })
  .catch((error: unknown) => {
    if (process.env.ADE_E2E_USER_DATA_DIR) {
      console.error('ADE could not open its window:', error)
    } else {
      dialog.showErrorBox('ADE could not open its window', String(error))
    }
    app.quit()
  })

let quitRequested = false
app.on('before-quit', (event) => {
  quitRequested = true
  // Windows closing from here on keep their records, unless a guard holds the quit.
  if (!holdQuit(event)) markQuitting()
})
app.on('will-quit', finishQuit)

app.on('window-all-closed', () => {
  if (quitRequested || process.platform !== 'darwin') app.quit()
})
