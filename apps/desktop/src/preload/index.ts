import { contextBridge } from 'electron'
import { browser } from './browser'
import { conversations } from './conversations'
import { files } from './files'
import { layouts } from './layouts'
import { profiles } from './profiles'
import { review } from './review'
import { services } from './services'
import { settings } from './settings'
import { themes } from './themes'
import { terminal } from './stream'
import { terminals } from './terminals'
import { workspaces } from './workspaces'
import { invoke, send, subscribe } from './ipc'
import { nativeAccessibility } from './native-accessibility'
import { isAppCommand } from '../shared/app-commands'
import type { AdeHost } from '../shared/bridge'

// Flat names the existing E2E specs still call through `window.evaluate`. The
// renderer and its `Window.adeHost` type use only the domain namespaces. Remove
// an alias once no spec under e2e/ calls it.
/* oxlint-disable typescript/unbound-method -- the preload domain modules never use `this` */
const e2eAliases = {
  getClientState: profiles.getClientState,
  getProfileState: profiles.getState,
  createProfile: profiles.create,
  selectProfile: profiles.select,
  adoptBrowserSession: browser.adoptSession,
  captureBrowserProfile: browser.captureProfile,
  restoreBrowserProfile: browser.restoreProfile,
  exportSendJournalProfile: conversations.exportSendJournal,
  importSendJournalProfile: conversations.importSendJournal,
  requestConversation: conversations.request,
  rebindRestored: workspaces.rebindRestored,
}
/* oxlint-enable typescript/unbound-method */

const adeHost: AdeHost = {
  getAppVersion: () => invoke('ade:app-version'),
  // The window's vibrancy material follows the native appearance, so the renderer's theme has to
  // reach the main process.
  setTheme: (theme) => send('ade:theme', theme),
  setKeybindings: (keybindings) => send('ade:keybindings', keybindings),
  setWindowMinimumSize: (width, height) => send('ade:window-minimum-size', width, height),
  // Commands from the native menu (src/shared/app-commands.ts).
  onCommand: (listener) =>
    subscribe('ade:command', (command) => {
      if (isAppCommand(command)) listener(command)
    }),
  profiles,
  conversations,
  workspaces,
  layouts,
  services,
  review,
  files,
  browser,
  terminal,
  terminals,
  themes,
  settings,
  nativeAccessibility,
}

contextBridge.exposeInMainWorld('adeHost', { ...adeHost, ...e2eAliases })
