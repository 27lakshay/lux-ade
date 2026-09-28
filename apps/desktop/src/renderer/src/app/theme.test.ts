import { afterEach, expect, test } from 'vitest'
import { WINDOW_BACKGROUND } from '../../../shared/window-chrome'
import bootScript from '../../public/theme-boot.js?raw'
import './app.css'
import { resolveTheme, setThemePreference, THEME_KEY, themePreference } from './theme'

afterEach(() => {
  localStorage.removeItem(THEME_KEY)
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

test('the boot script reads the same saved preference as the app', () => {
  expect(bootScript).toContain(`'${THEME_KEY}'`)
})

test('a preference is saved and applied', () => {
  expect(themePreference()).toBe('system')
  setThemePreference('dark')
  expect(themePreference()).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  setThemePreference('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('the system preference follows the system', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('light', true)).toBe('light')
})
