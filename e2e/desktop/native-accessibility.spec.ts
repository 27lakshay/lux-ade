import { expect, test } from './fixtures'
import type { AdeHost } from '../../apps/desktop/src/shared/bridge'
import type { NativeAccessibilitySnapshot } from '../../apps/desktop/src/shared/bridge/native-accessibility'

declare global {
  interface Window {
    adeHost: AdeHost
    __nativeAccessibilityUpdate(snapshot: NativeAccessibilitySnapshot): void
  }
}
test('native accessibility bridge reports Electron signals and forwards updates', async ({ desktop, profile }) => {
  const { app, window } = await desktop.launch(profile)
  const snapshot = await window.evaluate(() => self.adeHost.nativeAccessibility.getSnapshot())
  const native = await app.evaluate(({ nativeTheme }) => ({
    highContrast: nativeTheme.shouldUseHighContrastColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    differentiateWithoutColor: nativeTheme.shouldDifferentiateWithoutColor,
  }))
  expect(snapshot).toEqual({
    highContrast: process.platform === 'darwin' || process.platform === 'win32' ? native.highContrast : null,
    reducedTransparency: native.reducedTransparency,
    differentiateWithoutColor: process.platform === 'darwin' ? native.differentiateWithoutColor : null,
  })

  let update: NativeAccessibilitySnapshot | undefined
  await window.exposeFunction('__nativeAccessibilityUpdate', (value: NativeAccessibilitySnapshot) => {
    update = value
  })
  await window.evaluate(() => {
    const host = self.adeHost
    let unsubscribe = (): void => {}
    unsubscribe = host.nativeAccessibility.onUpdate((value) => {
      unsubscribe()
      self.__nativeAccessibilityUpdate(value)
    })
  })
  await app.evaluate(({ nativeTheme }) => nativeTheme.emit('updated'))
  await expect.poll(() => update).toEqual(snapshot)
})
