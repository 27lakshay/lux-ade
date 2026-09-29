import type { ProfileSettings } from '@ade/contracts'
import type { AdeHost } from '../../../shared/bridge'
import type { DaemonStore } from '../state/daemon-store'
import { applyMotionPreference } from './motion-preference'
import { applyThemePreference } from './theme'

// Keeps the window showing the profile's settings: read from the daemon each time it connects, and
// changed with every `settings_changed` frame, whoever made the change (this window, another one,
// or `ade settings set`).

function show(settings: ProfileSettings): void {
  applyThemePreference(settings.appearance)
  applyMotionPreference(settings.reduced_motion)
}

/** Follows the daemon's settings; returns the unsubscribe function. */
export function startProfileSettings(
  host: Pick<AdeHost, 'settings' | 'conversations'>,
  store: DaemonStore,
): () => void {
  let connected = false
  const onState = (): void => {
    const now = store.getState().status === 'connected'
    if (now && !connected) void host.settings.get().then(show, () => {})
    connected = now
  }
  onState()
  const stopStore = store.subscribe(onState)
  const stopFeed = host.conversations.onFeedFrame((frame) => {
    if (frame.type === 'settings_changed') show(frame.settings)
  })
  return () => {
    stopStore()
    stopFeed()
  }
}
