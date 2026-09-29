import { afterEach, expect, test } from 'vitest'
import { WINDOW_BACKGROUND } from '../../../shared/window-chrome'
import bootScript from '../../public/theme-boot.js?raw'
import './app.css'
import { applyThemePreference, resolveTheme, setThemePreference, themePreference } from './theme'

afterEach(() => {
  applyThemePreference('system')
  document.documentElement.classList.remove('dark')
})

// The colour a CSS colour value paints, as #rrggbb.
function painted(color: string): string {
  const context = document.createElement('canvas').getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, '0')).join('')}`
}

test("the window's background matches the theme's in light and dark", () => {
  // Main paints the window before the page loads; a mismatch shows as a flash of another colour.
  const background = (): string => painted(getComputedStyle(document.body).getPropertyValue('--background'))
  expect(background()).toBe(WINDOW_BACKGROUND.light)
  document.documentElement.classList.add('dark')
  expect(background()).toBe(WINDOW_BACKGROUND.dark)
})

test('the boot script paints what the system appearance says, which main set from the saved setting', () => {
  // Main applies the saved appearance to macOS before the window opens; the page's
  // prefers-color-scheme follows it, so the boot script keeps no copy of its own.
  expect(bootScript).toContain('prefers-color-scheme: dark')
  expect(bootScript).not.toContain('localStorage')
})

test('a preference is applied and kept in memory, not in storage', () => {
  expect(themePreference()).toBe('system')
  setThemePreference('dark')
  expect(themePreference()).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  setThemePreference('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(localStorage.getItem('ade.theme')).toBeNull()
})

test('the system preference follows the system', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('light', true)).toBe('light')
})
