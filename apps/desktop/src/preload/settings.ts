import { invokeResult as invoke } from './ipc'
import type { SettingsBridge } from '../shared/bridge/settings'

export const settings: SettingsBridge = {
  startupStatus: () => invoke('ade:settings-startup-status'),
  palettes: () => invoke('ade:settings-palettes'),
  resetAppearance: (revision) => invoke('ade:settings-reset-appearance', revision),
  appearance: () => invoke('ade:settings-appearance'),
  get: () => invoke('ade:settings-get'),
  set: (changes) => invoke('ade:settings-set', changes),
}
