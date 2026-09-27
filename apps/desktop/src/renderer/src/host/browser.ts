import type { ProfileState } from '../types'

export type BrowserTab = { id: string; profileId: string; requestedUrl: string; observedUrl: string; title: string; loading: boolean; error: string }
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
  captureProfile(profileId: string, destination: string): Promise<Record<string, unknown>>
  restoreProfile(bundle: string, profileId: string): Promise<Record<string, unknown>>
}
