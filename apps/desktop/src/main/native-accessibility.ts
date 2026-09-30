import { nativeTheme } from 'electron'
import type { NativeAccessibilitySnapshot } from '../shared/bridge/native-accessibility'
import { broadcast, handle } from './ipc'

export function nativeAccessibilitySnapshot(): NativeAccessibilitySnapshot {
  return {
    highContrast:
      process.platform === 'darwin' || process.platform === 'win32' ? nativeTheme.shouldUseHighContrastColors : null,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    differentiateWithoutColor: process.platform === 'darwin' ? nativeTheme.shouldDifferentiateWithoutColor : null,
  }
}

export function registerNativeAccessibility(): () => void {
  const onUpdated = (): void => broadcast('ade:native-accessibility-updated', nativeAccessibilitySnapshot())
  handle('ade:native-accessibility-snapshot', () => nativeAccessibilitySnapshot())
  nativeTheme.on('updated', onUpdated)
  return () => nativeTheme.removeListener('updated', onUpdated)
}
