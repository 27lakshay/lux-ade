import { invoke, subscribe } from './ipc'
import type { BrowserBridge } from '../shared/bridge/browser'

export const browser: BrowserBridge = {
  list: () => invoke('ade:browser-list'),
  open: (url) => invoke('ade:browser-open', url),
  select: (id) => invoke('ade:browser-select', id),
  newTab: () => invoke('ade:browser-new'),
  navigate: (id, url) => invoke('ade:browser-navigate', id, url),
  history: (id, direction) => invoke('ade:browser-history', id, direction),
  close: (id) => invoke('ade:browser-close', id),
  bounds: (id, rect) => invoke('ade:browser-bounds', id, rect),
  hide: () => invoke('ade:browser-hide'),
  onState: (listener) => subscribe('ade:browser-state', listener),
  onLeaseLost: (listener) => subscribe('ade:browser-lease-lost', listener),
  adoptSession: (profileId) => invoke('ade:browser-adopt', profileId),
  captureProfile: (profileId, destination) => invoke('ade:browser-backup-capture', profileId, destination),
  restoreProfile: (bundle, profileId) => invoke('ade:browser-backup-restore', bundle, profileId),
}
