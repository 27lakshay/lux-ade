import type { GhosttyColor, GhosttyTheme } from './ghostty/core'

// A terminal takes its colours from the page, so it follows the app theme without a palette of
// its own: the text colour from CSS `color`, the background from the nearest opaque ancestor.

let probe: CanvasRenderingContext2D | null = null

/** Any CSS colour (named, hex, rgb, oklch, …) as the sRGB bytes the browser paints. */
function resolveColor(css: string): GhosttyColor & { a: number } {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return { r: 0, g: 0, b: 0, a: 0 }
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data
  return { r, g, b, a }
}

function backgroundOf(element: HTMLElement): GhosttyColor {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = resolveColor(getComputedStyle(node).backgroundColor)
    if (color.a === 255) return { r: color.r, g: color.g, b: color.b }
  }
  return { r: 0, g: 0, b: 0 }
}

export function terminalThemeFrom(element: HTMLElement): GhosttyTheme {
  const { r, g, b } = resolveColor(getComputedStyle(element).color)
  const foreground = { r, g, b }
  return {
    foreground,
    background: backgroundOf(element),
    cursor: foreground,
    selectionBackground: `rgb(${r} ${g} ${b} / 25%)`,
  }
}
