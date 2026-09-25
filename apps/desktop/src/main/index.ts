import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { AdeClient } from '@ade/client'

const client = new AdeClient(process.env.ADE_SOCKET)

if (process.env.ADE_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ADE_E2E_USER_DATA_DIR)
}

ipcMain.handle('ade:app-version', () => app.getVersion())
ipcMain.handle('ade:client-state', () => client.getState())

function openMainWindow(): void {
  const window = new BrowserWindow({
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

app.whenReady().then(() => {
  client.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('ade:client-state-changed', state)
    }
  })
  client.start()
  openMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', () => client.stop())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
