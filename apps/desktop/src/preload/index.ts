import { contextBridge, ipcRenderer } from 'electron'
import { browser } from './browser'
import { conversations } from './conversations'
import { files } from './files'
import { profiles } from './profiles'
import { review } from './review'
import { services } from './services'
import { terminal } from './terminal'
import { workspaces } from './workspaces'

// Flat names the existing E2E specs still call through `window.evaluate`. The
// renderer and its `Window.adeHost` type use only the domain namespaces. Remove
// an alias once no spec under e2e/ calls it.
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

contextBridge.exposeInMainWorld('adeHost', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('ade:app-version'),
  // The window's vibrancy material follows the native appearance, so the renderer's theme has to
  // reach the main process.
  setTheme: (theme: 'dark' | 'light'): void => ipcRenderer.send('ade:theme', theme),
  profiles,
  conversations,
  workspaces,
  services,
  review,
  files,
  browser,
  terminal,
  ...e2eAliases,
})
