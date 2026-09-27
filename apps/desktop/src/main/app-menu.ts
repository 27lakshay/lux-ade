import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { emit } from './ipc'
import type { AppCommand } from '../shared/app-commands'
import { exportDiagnostics } from './diagnostics'

// The native application menu. Global shortcuts live here as accelerators so they fire wherever
// focus is, including terminals and browser tabs; each sends its command to the focused window.
// ⌘W closes a tab, not the window.

const send = (command: AppCommand) => () => {
  const window = BrowserWindow.getFocusedWindow()
  if (window && !window.isDestroyed()) emit(window.webContents, 'ade:command', command)
}

const item = (label: string, accelerator: string, command: AppCommand): MenuItemConstructorOptions => ({
  label,
  accelerator,
  click: send(command),
})

export function installAppMenu(): void {
  const development = !app.isPackaged
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'CmdOrCtrl+,', 'open-settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Conversation', 'CmdOrCtrl+N', 'new-conversation'),
        item('New Tab', 'CmdOrCtrl+T', 'new-tab'),
        { type: 'separator' },
        item('Close Tab', 'CmdOrCtrl+W', 'close-tab'),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ],
    },
    // The edit roles make copy, paste, undo and select-all work in every text field on macOS.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Command Palette…', 'CmdOrCtrl+Shift+P', 'command-palette'),
        { type: 'separator' },
        item('Toggle Left Sidebar', 'CmdOrCtrl+B', 'toggle-left-sidebar'),
        item('Toggle Right Sidebar', 'CmdOrCtrl+Alt+B', 'toggle-right-sidebar'),
        item('Split Right', 'CmdOrCtrl+\\', 'split-right'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(development
          ? ([
              { type: 'separator' },
              item('Toggle Dev Panel', 'CmdOrCtrl+.', 'toggle-dev-panel'),
              { label: 'Show Onboarding', click: send('open-onboarding') },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Export Diagnostics…',
          click: () =>
            void exportDiagnostics(BrowserWindow.getFocusedWindow()).catch((error: unknown) => {
              void dialog.showMessageBox({ type: 'error', message: 'Diagnostics export failed', detail: String(error) })
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
