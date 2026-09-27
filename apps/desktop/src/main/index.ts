import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { browserQuitGuard, closeBrowserWindow, registerBrowserIpc, setBrowserProfile } from './browser'
import { BrowserOwner } from './browser-owner'
import { registerConversationIpc } from './conversations/ipc'
import { draftQuitGuard, warnPendingSends } from './conversations/quit-guard'
import { drafts, flushDraft, persistentWindowId, reconcileAcceptedSend, setSendJournal, unsafePending,
  windowIds } from './conversations/send-pipeline'
import { registerFileIpc } from './files'
import { watchActivity } from './notifications'
import { GitJournal } from './git-journal'
import { broadcast, fixedSocket, getBrowserOwner, getClient, managedProfiles, publishProfile, refreshProfiles,
  setBrowserOwner, setStartupProfileSelection, setUnsubscribeClient, setUnsubscribeFeed,
  stopClient } from './profile-connection'
import { registerProfileIpc, selectProfile } from './profiles'
import { holdQuit, registerQuitGuard } from './quit-guards'
import { registerReviewIpc, setGitJournal } from './review'
import { SendJournal } from './send-journal'
import { registerServiceIpc } from './services'
import { closeAll as closeAllTerminals, closeSenderTerminals, registerTerminalIpc } from './terminals'
import { registerWorkspaceIpc, selectedWorkspaces, selectionRequests } from './workspaces'

let singleWindowId = ''
if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}
registerBrowserIpc(selectProfile)

ipcMain.handle('ade:app-version', () => app.getVersion())
registerProfileIpc()
registerConversationIpc()
registerWorkspaceIpc()
registerServiceIpc()
registerReviewIpc()
registerFileIpc()
registerTerminalIpc()

// Order matters: drafts are saved before browser sessions are flushed.
registerQuitGuard(draftQuitGuard)
registerQuitGuard(browserQuitGuard)

function openMainWindow(): void {
  const window = new BrowserWindow({
    show: process.env.ADE_E2E_HIDE_WINDOW !== '1',
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'ADE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  windowIds.set(window.webContents.id, singleWindowId)
  let readyForClose = false
  let closeFlushInProgress = false
  window.on('close', (event) => {
    // E2E teardown must not surface a native modal over the user's active Space.
    // The test process owns this isolated profile and may deliberately leave an
    // uncertain send to verify recovery after process exit.
    if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.env.ADE_E2E_TEST_CLOSE_GUARD !== '1') return
    if (readyForClose) return
    if (closeFlushInProgress) { event.preventDefault(); return }
    const owned = [...drafts.entries()].filter(([key]) => key.startsWith(`${window.webContents.id}:`)).map(([, entry]) => entry)
    if (!owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) return
    event.preventDefault()
    closeFlushInProgress = true
    void (async () => {
      await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
        return
      }
      const pending = owned.filter((entry) => !entry.send && (entry.timer || entry.savedRevision < entry.draft.revision))
      const results = await Promise.allSettled(pending.map(flushDraft))
      if (results.some((result) => result.status === 'rejected')) {
        if (process.env.ADE_E2E_USER_DATA_DIR) console.error('Draft was not saved during window close')
        else await dialog.showMessageBox(window, { type: 'error', title: 'Draft was not saved',
          message: 'This window is staying open because a draft could not be saved.',
          detail: 'Restore the profile daemon and try closing the window again.' })
        return
      }
      if (await unsafePending(owned)) {
        await warnPendingSends(window)
        return
      }
      readyForClose = true
      if (!window.isDestroyed()) window.close()
    })().finally(() => { closeFlushInProgress = false })
  })
  window.webContents.on('did-start-navigation', () => closeSenderTerminals(window.webContents.id))
  window.webContents.on('destroyed', () => {
    closeBrowserWindow(window)
    closeSenderTerminals(window.webContents.id)
    selectedWorkspaces.delete(window.webContents.id)
    selectionRequests.delete(window.webContents.id)
    for (const [key, entry] of drafts) {
      if (!key.startsWith(`${window.webContents.id}:`)) continue
      void flushDraft(entry).then(() => drafts.delete(key)).catch(() => undefined)
    }
    windowIds.delete(window.webContents.id)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
  singleWindowId = await persistentWindowId()
  setSendJournal(await SendJournal.open(join(app.getPath('userData'), 'pending-sends-v1.json')))
  setGitJournal(await GitJournal.open(join(app.getPath('userData'), 'git-intents-v1.json')))
  if (!managedProfiles && fixedSocket) {
    const fixedIdentity = createHash('sha256').update(resolve(fixedSocket)).digest('hex').slice(0, 32)
    const home = join(app.getPath('userData'), 'browser-fixed', fixedIdentity)
    await setBrowserProfile('fixed', home)
    setBrowserOwner(await BrowserOwner.open(`fixed-${fixedIdentity}`, 'fixed'))
  }
  setUnsubscribeClient(getClient().subscribe((state) => {
    broadcast('ade:client-state-changed', state)
    if (state.status === 'connected' && fixedSocket) {
      void getBrowserOwner()?.register(fixedSocket, state.bootId).catch((error) =>
        console.error('Browser owner registration failed', error))
    }
  }))
  const stopFeed = getClient().subscribeFeed((frame) => broadcast('ade:feed-frame', frame))
  const stopActivity = watchActivity(getClient())
  setUnsubscribeFeed(() => { stopFeed(); stopActivity() })
  getClient().start()
  openMainWindow()
  if (managedProfiles) {
    setStartupProfileSelection(refreshProfiles().then(async (state) => {
      if (state.selectedId) await selectProfile(state.selectedId, false)
    }).catch((error) => { publishProfile({ error: String(error) }) }).finally(() => { setStartupProfileSelection(null) }))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
}).catch((error: unknown) => {
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
  if (holdQuit(event)) return
  closeAllTerminals()
  stopClient()
})

app.on('window-all-closed', () => {
  if (quitRequested || process.platform !== 'darwin') app.quit()
})
