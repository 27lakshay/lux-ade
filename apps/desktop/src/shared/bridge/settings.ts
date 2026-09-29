import type { ProfileSettings } from '@ade/contracts'

/** `window.adeHost.settings`: the profile's settings, which the daemon keeps. */
export interface SettingsBridge {
  get(): Promise<ProfileSettings>
  /** Changes the given settings and returns them all. */
  set(changes: Partial<Pick<ProfileSettings, 'appearance' | 'reduced_motion'>>): Promise<ProfileSettings>
}
