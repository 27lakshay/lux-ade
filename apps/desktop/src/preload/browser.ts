import { ipcRenderer } from 'electron'
import type { BrowserBridge } from '../renderer/src/host/browser'
import { subscribe } from './subscribe'

export const browser: BrowserBridge = {
  list: () => ipcRenderer.invoke('ade:browser-list'),
  open: (url) => ipcRenderer.invoke('ade:browser-open', url),
  select: (id) => ipcRenderer.invoke('ade:browser-select', id),
  newTab: () => ipcRenderer.invoke('ade:browser-new'),
  navigate: (id, url) => ipcRenderer.invoke('ade:browser-navigate', id, url),
  history: (id, direction) => ipcRenderer.invoke('ade:browser-history', id, direction),
  close: (id) => ipcRenderer.invoke('ade:browser-close', id),
  bounds: (id, rect) => ipcRenderer.invoke('ade:browser-bounds', id, rect),
  hide: () => ipcRenderer.invoke('ade:browser-hide'),
  onState: (listener) => subscribe('ade:browser-state', listener),
  onLeaseLost: (listener) => subscribe('ade:browser-lease-lost', listener),
  adoptSession: (profileId) => ipcRenderer.invoke('ade:browser-adopt', profileId),
  captureProfile: (profileId, destination) => ipcRenderer.invoke('ade:browser-backup-capture', profileId, destination),
  restoreProfile: (bundle, profileId) => ipcRenderer.invoke('ade:browser-backup-restore', bundle, profileId),
}
