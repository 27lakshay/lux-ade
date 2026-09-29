import { invoke } from './ipc'
import type { SettingsBridge } from '../shared/bridge/settings'

export const settings: SettingsBridge = {
  get: () => invoke('ade:settings-get'),
  set: (changes) => invoke('ade:settings-set', changes),
}
