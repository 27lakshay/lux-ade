import { app, BrowserWindow, nativeTheme } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { isThemePreference, WINDOW_BACKGROUND, type ThemePreference } from '../shared/window-chrome'

// The appearance preference (light, dark or system). The renderer owns it and sends each change;
// main applies it to macOS (`nativeTheme`, which also drives the page's prefers-color-scheme) and
// keeps a copy, so the next launch creates its window in the right colour before the page loads.

const file = (): string => join(app.getPath('userData'), 'appearance.json')

/** Applies the saved preference. Call once, before the first window opens. */
export function loadAppearance(): void {
  try {
    const saved: unknown = (JSON.parse(readFileSync(file(), 'utf8')) as { theme?: unknown }).theme
    if (isThemePreference(saved)) nativeTheme.themeSource = saved
  } catch {
    // No saved preference yet: follow the system.
  }
  // Windows keep the background of the resolved appearance, including when the system changes.
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground())
  })
}

export function setAppearance(theme: ThemePreference): void {
  if (nativeTheme.themeSource === theme) return
  nativeTheme.themeSource = theme
  try {
    writeFileSync(file(), JSON.stringify({ theme }))
  } catch (error) {
    log.warn('Could not save the appearance preference', error)
  }
}

/** The window background for the appearance in effect now. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}
