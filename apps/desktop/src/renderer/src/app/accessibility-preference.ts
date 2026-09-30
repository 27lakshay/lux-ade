export type AccessibilityMode = 'system' | 'on' | 'off'

export interface AccessibilityPreferences {
  high_contrast: AccessibilityMode
  reduced_transparency: AccessibilityMode
  differentiate_without_color: AccessibilityMode
}

export interface AccessibilitySignals {
  highContrast: boolean | null
  reducedTransparency: boolean | null
  differentiateWithoutColor: boolean | null
}

export function resolveAccessibilityPreference(mode: AccessibilityMode, system: boolean | null): boolean {
  return mode === 'system' ? system === true : mode === 'on'
}

export function applyAccessibilityPreferences(
  preferences: AccessibilityPreferences,
  signals: AccessibilitySignals,
): void {
  const root = document.documentElement
  root.toggleAttribute(
    'data-high-contrast',
    resolveAccessibilityPreference(preferences.high_contrast, signals.highContrast),
  )
  root.toggleAttribute(
    'data-reduced-transparency',
    resolveAccessibilityPreference(preferences.reduced_transparency, signals.reducedTransparency),
  )
  root.toggleAttribute(
    'data-differentiate-without-color',
    resolveAccessibilityPreference(preferences.differentiate_without_color, signals.differentiateWithoutColor),
  )
}
