import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '../shared/app-commands'

// The native application menu. Global shortcuts live here as accelerators so they fire wherever
// focus is, including terminals and browser tabs; each sends its command to the focused window.
// ⌘W closes a tab, not the window.

const send = (command: AppCommand) => () => {
  const window = BrowserWindow.getFocusedWindow()
  if (window && !window.isDestroyed()) window.webContents.send('ade:command', command)
}

const item = (label: string, accelerator: string, command: AppCommand): MenuItemConstructorOptions => ({
  label,
  accelerator,
  click: send(command),
})

export function installAppMenu(): void {
  const development = !app.isPackaged
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
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
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
