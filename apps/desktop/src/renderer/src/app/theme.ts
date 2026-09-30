import { applyCodeTheme } from '../features/code/code-theme'
import type { ResolvedAppearance } from '@ade/contracts'
import { isThemePreference, type ThemePreference } from '../../../shared/window-chrome'

// The daemon owns committed appearance. Main supplies a per-profile startup snapshot;
// profile-settings.ts applies live resolved tokens after connection.

const systemDark = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/** The preference shown now; `system` until the daemon's setting arrives. */
const bootPreference = document.documentElement.dataset.appearancePreference
let current: ThemePreference = isThemePreference(bootPreference) ? bootPreference : 'system'

export const themePreference = (): ThemePreference => current

export const resolveTheme = (preference: ThemePreference, systemIsDark: boolean): 'light' | 'dark' =>
  preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference

function paint(preference: ThemePreference): void {
  const root = document.documentElement
  const dark = resolveTheme(preference, systemDark().matches) === 'dark'
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (root.classList.contains('dark') === dark) return
  // Every colour flips at once, rather than each element animating through its own transition.
  root.classList.add('theme-switching')
  root.classList.toggle('dark', dark)
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
}

/** Shows a preference: the page, the native window and the boot copy. */
export function applyThemePreference(preference: ThemePreference): void {
  current = preference
  paint(preference)
  window.adeHost?.setTheme(preference)
}

/** Changes the profile's appearance setting, showing it at once. */
export function setThemePreference(preference: ThemePreference): void {
  applyThemePreference(preference)
  void window.adeHost?.settings.set({ appearance: preference }).catch(() => {})
}

/** Applies the saved preference and follows system changes. */
export function startTheme(): void {
  const preference = themePreference()
  paint(preference)
  window.adeHost?.setTheme(preference)
  // Also fires when main changes the native appearance, which lags a preference change slightly.
  systemDark().addEventListener('change', () => paint(themePreference()))
}

/** Paints the daemon's complete committed app palette, including same-mode changes. */
export function applyResolvedTheme(appearance: ResolvedAppearance): void {
  const root = document.documentElement
  root.classList.add('theme-switching')
  for (const [role, value] of Object.entries(appearance.tokens)) root.style.setProperty(`--${role}`, value)
  applyCodeTheme(root, appearance.syntax.palette.tokens)
  root.style.colorScheme = appearance.mode
  root.classList.toggle('dark', appearance.mode === 'dark')
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
}
