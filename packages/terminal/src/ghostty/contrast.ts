import { interpolate, wcagContrast, type Rgb } from 'culori'
import type { GhosttyColor } from './core'

export const contrastRgb = (color: GhosttyColor): Rgb => ({
  mode: 'rgb',
  r: color.r / 255,
  g: color.g / 255,
  b: color.b / 255,
})

/** One paint's cache; never changes the stored palette or Ghostty cells. */
export function contrastCorrection(minimum: number) {
  const cache = new Map<string, GhosttyColor>()
  return (foreground: GhosttyColor, background: GhosttyColor): GhosttyColor => {
    if (minimum <= 1) return foreground
    const key = `${foreground.r},${foreground.g},${foreground.b}/${background.r},${background.g},${background.b}`
    const cached = cache.get(key)
    if (cached) return cached
    const fg = contrastRgb(foreground)
    const bg = contrastRgb(background)
    if (wcagContrast(fg, bg) >= minimum) {
      cache.set(key, foreground)
      return foreground
    }
    const black: Rgb = { mode: 'rgb', r: 0, g: 0, b: 0 }
    const white: Rgb = { mode: 'rgb', r: 1, g: 1, b: 1 }
    const endpoint = wcagContrast(black, bg) >= wcagContrast(white, bg) ? black : white
    const mix = interpolate([fg, endpoint], 'rgb')
    let low = 0
    let high = 1
    let result = { r: endpoint.r * 255, g: endpoint.g * 255, b: endpoint.b * 255 }
    // Some backgrounds cannot reach a requested ratio with foreground alone.
    // In that case return the strongest available black/white endpoint.
    for (let step = 0; step < 16; step++) {
      const amount = (low + high) / 2
      const color = mix(amount)
      const candidate = { r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255) }
      if (wcagContrast(contrastRgb(candidate), bg) >= minimum) {
        result = candidate
        high = amount
      } else low = amount
    }
    cache.set(key, result)
    return result
  }
}
