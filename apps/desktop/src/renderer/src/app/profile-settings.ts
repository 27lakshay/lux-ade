import type { ProfileSettings } from '@ade/contracts'
import type { AdeHost } from '../../../shared/bridge'
import type { DaemonStore } from '../state/daemon-store'
import type { Keybindings } from '../../../shared/app-commands'
import { applyKeybindings } from './keybindings'
import { applyMotionPreference } from './motion-preference'
import { applyResolvedTheme, applyThemePreference } from './theme'
import { queryClient } from './query-client'
import { applyAccessibilityPreferences, type AccessibilitySignals } from './accessibility-preference'

// Keeps the window showing the profile's settings: read from the daemon each time it connects, and
// changed with every `settings_changed` frame, whoever made the change (this window, another one,
// or `ade settings set`).

const appearanceKeys = [
  'appearance',
  'app_light_theme',
  'app_dark_theme',
  'terminal_binding',
  'syntax_binding',
  'terminal_color_overrides',
  'terminal_minimum_contrast',
  'terminal_bold_color',
] as const

function sameAppearance(left: ProfileSettings | null, right: ProfileSettings): boolean {
  return (
    left !== null &&
    appearanceKeys.every((key) => left[key] === right[key] || JSON.stringify(left[key]) === JSON.stringify(right[key]))
  )
}

function applyProfileTypography(settings: ProfileSettings): void {
  const root = document.documentElement
  root.style.setProperty('--ade-ui-font-family', JSON.stringify(settings.ui_font_family as string))
  root.style.setProperty('--ade-code-font-family', JSON.stringify(settings.code_font_family as string))
  root.style.setProperty('--ade-ui-font-scale', String((settings.ui_font_size as number) / 13))
  root.style.setProperty('--ade-code-font-size', String(settings.code_font_size as number) + 'px')
  root.dataset.density = settings.density as string
}

function show(settings: ProfileSettings, signals: AccessibilitySignals): void {
  queryClient.setQueryData(['profile-settings'], settings)
  applyProfileTypography(settings)
  applyAccessibilityPreferences(settings, signals)
  applyThemePreference(settings.appearance)
  applyMotionPreference(settings.reduced_motion)
  applyKeybindings(settings.keybindings as Keybindings)
}

/** Follows the daemon's settings; returns the unsubscribe function. */
export function startProfileSettings(
  host: Pick<AdeHost, 'settings' | 'conversations' | 'nativeAccessibility'>,
  store: DaemonStore,
): () => void {
  let connected = false
  let bootId: string | null = null
  let generation = 0
  let latestRevision = -1
  let settingsEventVersion = 0
  let latestSettings: ProfileSettings | null = null
  let disposed = false
  let accessibilitySignals: AccessibilitySignals = {
    highContrast: null,
    reducedTransparency: null,
    differentiateWithoutColor: null,
  }
  let nativeSignalVersion = 0
  const stopNativeAccessibility = host.nativeAccessibility.onUpdate((signals) => {
    nativeSignalVersion++
    accessibilitySignals = signals
    if (latestSettings) applyAccessibilityPreferences(latestSettings, accessibilitySignals)
  })
  const snapshotVersion = nativeSignalVersion
  void host.nativeAccessibility.getSnapshot().then(
    (signals) => {
      if (disposed || nativeSignalVersion !== snapshotVersion) return
      accessibilitySignals = signals
      if (latestSettings) applyAccessibilityPreferences(latestSettings, accessibilitySignals)
    },
    () => {},
  )
  const accept = (settings: ProfileSettings): void => {
    if (disposed || settings.appearance_revision < latestRevision) return
    const appearanceUnchanged =
      latestSettings !== null &&
      settings.appearance_revision === latestSettings.appearance_revision &&
      sameAppearance(latestSettings, settings)
    latestRevision = settings.appearance_revision
    latestSettings = settings
    show(settings, accessibilitySignals)
    if (appearanceUnchanged) return
    const requestGeneration = generation
    void host.settings.appearance().then(
      (appearance) => {
        if (disposed || requestGeneration !== generation || appearance.revision < latestRevision) return
        latestRevision = appearance.revision
        applyResolvedTheme(appearance)
      },
      () => {},
    )
  }
  const onState = (): void => {
    const state = store.getState()
    const now = state.status === 'connected'
    const identityChanged = state.bootId !== bootId
    if (now !== connected || identityChanged) generation++
    if (now && (!connected || identityChanged)) {
      latestRevision = -1
      latestSettings = null
      const requestGeneration = generation
      const requestEventVersion = settingsEventVersion
      void host.settings.get().then(
        (settings) => {
          if (requestGeneration === generation && requestEventVersion === settingsEventVersion) accept(settings)
        },
        () => {},
      )
    }
    connected = now
    bootId = state.bootId
  }
  onState()
  const stopStore = store.subscribe(onState)
  const stopFeed = host.conversations.onFeedFrame((frame) => {
    if (connected && frame.type === 'settings_changed' && frame.boot_id === bootId) {
      settingsEventVersion++
      accept(frame.settings)
    }
  })
  return () => {
    disposed = true
    stopStore()
    stopFeed()
    stopNativeAccessibility()
  }
}
