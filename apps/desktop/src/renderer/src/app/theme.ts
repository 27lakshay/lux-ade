import type { ThemePreference } from '../../../shared/window-chrome'

// Light, dark, or follow the system. The profile's setting lives in the daemon (`appearance`;
// profile-settings.ts keeps the window in step with it). Main applies each change to macOS and keeps
// the one startup copy (src/main/appearance.ts): the page's prefers-color-scheme follows it, which
// is how the boot script (public/theme-boot.js) paints the right theme before the daemon answers.

const systemDark = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/** The preference shown now; `system` until the daemon's setting arrives. */
let current: ThemePreference = 'system'

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
