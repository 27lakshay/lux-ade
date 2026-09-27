import { invoke, subscribe } from './ipc'
import type { ProfilesBridge } from '../shared/bridge/profiles'

export const profiles: ProfilesBridge = {
  getState: () => invoke('ade:profile-state'),
  list: () => invoke('ade:profile-list'),
  create: (name) => invoke('ade:profile-create', name),
  select: (id) => invoke('ade:profile-select', id),
  onState: (listener) => subscribe('ade:profile-state-changed', listener),
  getClientState: () => invoke('ade:client-state'),
  onClientState: (listener) => subscribe('ade:client-state-changed', listener),
}
