import { ipcRenderer } from 'electron'
import type { ProfilesBridge } from '../renderer/src/host/profiles'
import { subscribe } from './subscribe'

export const profiles: ProfilesBridge = {
  getState: () => ipcRenderer.invoke('ade:profile-state'),
  list: () => ipcRenderer.invoke('ade:profile-list'),
  create: (name) => ipcRenderer.invoke('ade:profile-create', name),
  select: (id) => ipcRenderer.invoke('ade:profile-select', id),
  onState: (listener) => subscribe('ade:profile-state-changed', listener),
  getClientState: () => ipcRenderer.invoke('ade:client-state'),
  onClientState: (listener) => subscribe('ade:client-state-changed', listener),
}
