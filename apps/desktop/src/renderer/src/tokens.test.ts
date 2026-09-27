import { describe, expect, test } from 'vitest'
import { applyTokens, DEFAULT_GLASS, floors } from './tokens'

const alphaOf = (value: string) => Number(/\/ ([\d.]+)\)$/.exec(value)?.[1])

describe('applyTokens', () => {
  test('solid surfaces are opaque', () => {
    const root = document.createElement('div')
    applyTokens('dark', { ...DEFAULT_GLASS, on: false }, root)
    expect(alphaOf(root.style.getPropertyValue('--app-bg'))).toBe(1)
    expect(alphaOf(root.style.getPropertyValue('--side-bg'))).toBe(1)
  })

  test('glass never goes below a surface contrast floor, even at full transparency', () => {
    for (const theme of ['dark', 'light'] as const) {
      const root = document.createElement('div')
      applyTokens(theme, { on: true, transparency: 1, background: 0 }, root)
      const variable = { side: '--side-bg', app: '--app-bg', raised: '--raised-bg', status: '--status-bg' }
      for (const floor of floors(theme)) {
        expect(alphaOf(root.style.getPropertyValue(variable[floor.surface]))).toBeGreaterThanOrEqual(floor.floor)
      }
    }
  })
})
