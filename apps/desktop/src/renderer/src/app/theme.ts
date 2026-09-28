import { isThemePreference, type ThemePreference } from '../../../shared/window-chrome'

// Light, dark, or follow the system. The preference lives in localStorage, where the boot script
// (public/theme-boot.js) reads it before the first paint; main gets each change so the native
// window matches and remembers it (src/main/appearance.ts).

export const THEME_KEY = 'ade.theme'

const systemDark = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export function themePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return isThemePreference(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

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

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, preference)
  } catch {
    // Storage unavailable: the theme still applies until the window reloads.
  }
  paint(preference)
  window.adeHost?.setTheme(preference)
}

/** Applies the saved preference and follows system changes. */
export function startTheme(): void {
  const preference = themePreference()
  paint(preference)
  window.adeHost?.setTheme(preference)
  // Also fires when main changes the native appearance, which lags a preference change slightly.
  systemDark().addEventListener('change', () => paint(themePreference()))
}
