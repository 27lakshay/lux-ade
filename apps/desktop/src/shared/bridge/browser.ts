import type { ProfileState } from './types'

export type BrowserTab = {
  id: string
  profileId: string
  requestedUrl: string
  observedUrl: string
  title: string
  loading: boolean
  error: string
}
export type BrowserState = { profileId: string; selectedId: string | null; tabs: BrowserTab[] }

/** `window.adeHost.browser`: the main-process `browser` module. */
export interface BrowserBridge {
  list(): Promise<BrowserState>
  open(url: string): Promise<BrowserState>
  select(id: string): Promise<BrowserState>
  newTab(): Promise<BrowserState>
  navigate(id: string, url: string): Promise<BrowserState>
  history(id: string, direction: 'back' | 'forward'): Promise<BrowserState>
  close(id: string): Promise<BrowserState>
  bounds(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<void>
  hide(): Promise<void>
  onState(listener: (state: BrowserState) => void): () => void
  onLeaseLost(listener: (profileId: string) => void): () => void
  adoptSession(profileId: string): Promise<ProfileState>
  captureProfile(profileId: string, destination: string): Promise<BrowserProfileCaptured>
  restoreProfile(bundle: string, profileId: string): Promise<BrowserProfileRestored>
}

/** What a browser profile bundle carries, and what it leaves out. */
type BrowserBundleSummary = {
  scope: 'tabs-and-persistent-cookies'
  included: string[]
  excluded: string[]
  tab_count: number
  cookie_count: number
  source_profile_id: string
}

export type BrowserProfileCaptured = BrowserBundleSummary & {
  type: 'browser_profile_captured'
  format: 'ade-browser-bundle-v1'
  file: string
  /** Tabs in named partitions, which the bundle format does not carry. */
  excluded_partition_tabs: number
}

export type BrowserProfileRestored = BrowserBundleSummary & {
  type: 'browser_profile_restored'
  profile_id: string
  /** Set when an earlier attempt had already finished this restore. */
  already_complete?: true
}
