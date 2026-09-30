import { converter, parse, wcagContrast, type Rgb } from 'culori'
import { afterEach, describe, expect, test } from 'vitest'
import './app.css'

// These checks cover selected semantic-role pairs and focus styles; they do not certify WCAG
// conformance or the complete rendered palette/component matrix.

const rgb = converter('rgb')
const FILLS = ['sidebar', 'base', 'panel', 'background', 'card', 'popover', 'muted', 'accent'] as const

function token(name: string): Rgb {
  const probe = document.createElement('span')
  probe.style.color = `var(--${name})`
  document.body.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return rgb(parse(value)!)
}

// A colour with alpha, as it looks over a fill.
function over(top: Rgb, fill: Rgb, alpha = top.alpha ?? 1): Rgb {
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha)
  return { mode: 'rgb', r: mix(top.r, fill.r), g: mix(top.g, fill.g), b: mix(top.b, fill.b) }
}

afterEach(() => document.documentElement.classList.remove('dark'))

describe.each(['light', 'dark'])('%s', (mode) => {
  const setMode = () => document.documentElement.classList.toggle('dark', mode === 'dark')

  test.each(FILLS)('text is readable on %s', (fill) => {
    setMode()
    for (const text of ['foreground', 'muted-foreground']) {
      expect(wcagContrast(token(text), token(fill)), `${text} on ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test.each(FILLS)('status marks and diff text stand out on %s', (fill) => {
    setMode()
    for (const mark of ['attention', 'running', 'success', 'destructive']) {
      expect(wcagContrast(token(mark), token(fill)), `${mark} on ${fill}`).toBeGreaterThanOrEqual(3)
    }
    for (const text of ['diff-add', 'diff-remove']) {
      expect(wcagContrast(token(text), token(fill)), `${text} on ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test.each(FILLS)('focus rings are visible on %s', (fill) => {
    setMode()
    const ring = token('ring')
    // ADE's ring is drawn at full strength; the kit draws it at 50%.
    expect(wcagContrast(ring, token(fill)), `ring on ${fill}`).toBeGreaterThanOrEqual(3)
    expect(wcagContrast(over(ring, token(fill), 0.5), token(fill)), `kit ring on ${fill}`).toBeGreaterThanOrEqual(3)
  })

  test("destructive text is readable on its own tint (the kit's destructive button)", () => {
    setMode()
    // The kit draws destructive buttons as bg-destructive/10 (light) or /20 (dark) with red text.
    const red = token('destructive')
    for (const fill of ['popover', 'background', 'card'] as const) {
      const tint = over(red, token(fill), mode === 'dark' ? 0.2 : 0.1)
      expect(wcagContrast(red, tint), `destructive on its tint over ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('buttons are readable', () => {
    setMode()
    expect(wcagContrast(token('primary-foreground'), token('primary'))).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrast(token('secondary-foreground'), token('secondary'))).toBeGreaterThanOrEqual(4.5)
  })
})
