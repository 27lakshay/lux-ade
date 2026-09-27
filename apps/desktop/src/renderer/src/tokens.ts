// Colour tokens: the one source for the running app (applyTokens) and the contrast check
// (scripts/check-contrast.ts). Three tiers:
//   surfaces  the only tier that changes with glass: a solid colour, and a glass tint whose opacity
//             is clamped at a contrast floor
//   fills     hover, selected, chips, borders: the text colour at low opacity, so they sit on any
//             surface, solid or glass, without a variant
//   text      opaque, the same in both modes
// Solid values come from the Pen baseline frames (~/Documents/ade.pen).

export type Theme = 'dark' | 'light'
export type RGB = readonly [number, number, number]
type Surface = 'backdrop' | 'side' | 'app' | 'raised' | 'status'
type Text = 'fg' | 'fgMuted' | 'inverse' | 'attention' | 'success' | 'running' | 'destructive'
type Fill = 'panel' | 'muted' | 'selected' | 'border' | 'attentionMuted'

interface ThemeTokens {
  solid: Record<Surface, RGB>
  // Glass tints are chosen, not the solid colour made translucent: they sit slightly lighter (dark)
  // or whiter (light) so the cards separate from the macOS material.
  glass: Record<Exclude<Surface, 'backdrop'>, RGB>
  text: Record<Text, RGB>
  fills: Record<Fill, readonly [RGB, number]>
  shadow: { solid: string; glass: string }
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const TOKENS: Record<Theme, ThemeTokens> = {
  dark: {
    solid: {
      backdrop: hex('#0c0c0b'),
      side: hex('#1a1a18'),
      app: hex('#141413'),
      raised: hex('#262523'),
      status: hex('#1a1a18'),
    },
    glass: { side: hex('#1e1d1b'), app: hex('#161615'), raised: hex('#282725'), status: hex('#1a1a18') },
    text: {
      fg: hex('#fafafa'),
      fgMuted: hex('#a8a29e'),
      inverse: hex('#0c0a09'),
      attention: hex('#f5a524'),
      success: hex('#4ade80'),
      running: hex('#60a5fa'),
      destructive: hex('#ff6669'),
    },
    // Opacities reproduce the baseline's solid fills over the surfaces they mostly sit on.
    fills: {
      panel: [hex('#fafaf9'), 0.04],
      muted: [hex('#fafaf9'), 0.09],
      selected: [hex('#fafaf9'), 0.055],
      border: [hex('#ffffff'), 0.1],
      attentionMuted: [hex('#f5a524'), 0.1],
    },
    shadow: { solid: '0 10px 30px #00000066', glass: '0 10px 30px #00000040' },
  },
  light: {
    solid: {
      backdrop: hex('#e9e9eb'),
      side: hex('#f7f7f8'),
      app: hex('#ffffff'),
      raised: hex('#ffffff'),
      status: hex('#f7f7f8'),
    },
    glass: { side: hex('#fafafb'), app: hex('#ffffff'), raised: hex('#ffffff'), status: hex('#f7f7f8') },
    text: {
      fg: hex('#0a0a0a'),
      fgMuted: hex('#737373'),
      inverse: hex('#fafafa'),
      attention: hex('#c2410c'),
      success: hex('#16a34a'),
      running: hex('#2563eb'),
      destructive: hex('#e7000b'),
    },
    fills: {
      panel: [hex('#0a0a0a'), 0.06],
      muted: [hex('#0a0a0a'), 0.04],
      selected: [hex('#0a0a0a'), 0.07],
      border: [hex('#0a0a0a'), 0.1],
      attentionMuted: [hex('#c2410c'), 0.1],
    },
    shadow: { solid: '0 4px 16px #0000000f', glass: '0 4px 16px #0000000a' },
  },
}

// The macOS vibrancy material ('under-window', active) measured over a black and a white window
// behind it, via the main process's MATERIAL_OUT mode on macOS 26, 2026-09-26. Anything behind a
// glass surface lands between these two.
export const MATERIAL: Record<Theme, { darkest: RGB; lightest: RGB }> = {
  dark: { darkest: [37, 38, 41], lightest: [81, 82, 85] },
  light: { darkest: [199, 200, 203], lightest: [224, 225, 227] },
}

// What is drawn on each glass surface, optionally over a fill, and the contrast it needs:
// 4.5:1 for text, 3:1 for icons.
type Check = { text: Text; on?: Fill; min: number }
const TEXT = 4.5
const ICON = 3
const USAGE: Record<Exclude<Surface, 'backdrop'>, Check[]> = {
  side: [
    { text: 'fg', min: TEXT },
    { text: 'fgMuted', min: TEXT },
    { text: 'fgMuted', on: 'selected', min: TEXT },
    { text: 'attention', on: 'selected', min: TEXT },
    { text: 'success', min: TEXT },
    { text: 'destructive', min: TEXT },
    { text: 'running', min: ICON },
  ],
  app: [
    { text: 'fg', min: TEXT },
    { text: 'fgMuted', min: TEXT },
    { text: 'fg', on: 'muted', min: TEXT },
    { text: 'success', on: 'panel', min: TEXT },
    { text: 'destructive', on: 'panel', min: TEXT },
  ],
  raised: [
    { text: 'fg', min: TEXT },
    { text: 'fgMuted', min: TEXT },
    { text: 'attention', min: TEXT },
  ],
  status: [
    { text: 'fgMuted', min: TEXT },
    { text: 'success', min: ICON },
  ],
}

// --- contrast maths (WCAG 2.x) ---

const over = (top: RGB, alpha: number, under: RGB): RGB =>
  [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)) as unknown as RGB
const channel = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (c: RGB) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export interface Floor {
  surface: Exclude<Surface, 'backdrop'>
  floor: number // lowest glass opacity at which every check on this surface passes
  binding: string // the check that sets the floor
  baseline: { check: string; ratio: number }[] // checks the solid baseline itself fails
}

// A check's target is its WCAG minimum, or the solid baseline's own ratio when the baseline falls
// short: glass must never read worse than solid, and must meet WCAG wherever solid does.
export function floors(theme: Theme): Floor[] {
  const t = TOKENS[theme]
  const backdrops = [MATERIAL[theme].darkest, MATERIAL[theme].lightest]
  const surfaceColour = (bg: RGB, c: Check) => (c.on ? over(t.fills[c.on][0], t.fills[c.on][1], bg) : bg)
  const label = (c: Check) => `${c.text}${c.on ? ` on ${c.on}` : ''}`
  return (Object.keys(USAGE) as Floor['surface'][]).map((surface) => {
    const checks = USAGE[surface]
    const baseline = checks
      .map((c) => ({
        check: label(c),
        ratio: contrast(t.text[c.text], surfaceColour(t.solid[surface], c)),
        min: c.min,
      }))
      .filter((r) => r.ratio < r.min)
    const target = (c: Check) => Math.min(c.min, contrast(t.text[c.text], surfaceColour(t.solid[surface], c)))
    const failing = (alpha: number) =>
      checks.find((c) =>
        backdrops.some(
          (m) => contrast(t.text[c.text], surfaceColour(over(t.glass[surface], alpha, m), c)) < target(c) - 1e-9,
        ),
      )
    // Walk down from opaque while every check still passes.
    let floor = 1
    let binding = 'none'
    for (let a = 100; a >= 0; a--) {
      const f = failing(a / 100)
      if (f) {
        binding = label(f)
        break
      }
      floor = a / 100
    }
    return { surface, floor, binding, baseline: baseline.map(({ check, ratio }) => ({ check, ratio })) }
  })
}

// --- applying to the page ---

const css = (c: RGB, a = 1) => `rgb(${c.map((v) => Math.round(v)).join(' ')} / ${Number(a.toFixed(3))})`

// Floating layers (popovers, menus, the dev panel) sit over app content, not over the macOS
// material, so the floors above do not cover them. They take the raised tint at this fixed opacity
// (or the raised floor, if higher), never follow the transparency slider, and must pair
// bg-overlay with a CSS backdrop blur so the content under them turns to an even wash.
const OVERLAY_ALPHA = 0.88

// macOS "Reduce transparency" (System Settings → Accessibility → Display). When on, glass starts off.
export const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'
export const DEFAULT_GLASS = { transparency: 0.8, background: 0 }
export const DEFAULT_THEME: Theme = 'dark'

export interface GlassSettings {
  on: boolean
  // 0 = panes opaque, 1 = panes at their contrast floors. Never goes past the floors.
  transparency: number
  // Opacity of the window background in the gutters, 0..1. No text sits there, so no floor.
  background: number
}

export function applyTokens(theme: Theme, glass: GlassSettings, root: HTMLElement = document.documentElement) {
  const t = TOKENS[theme]
  const set = (name: string, value: string) => root.style.setProperty(name, value)
  const vars: Record<Surface, string> = {
    backdrop: '--backdrop',
    side: '--side-bg',
    app: '--app-bg',
    raised: '--raised-bg',
    status: '--status-bg',
  }

  if (glass.on) {
    set(vars.backdrop, css(t.solid.backdrop, glass.background))
    const all = floors(theme)
    for (const f of all) set(vars[f.surface], css(t.glass[f.surface], 1 - glass.transparency * (1 - f.floor)))
    const raisedFloor = all.find((f) => f.surface === 'raised')!.floor
    set('--overlay-bg', css(t.glass.raised, Math.max(OVERLAY_ALPHA, raisedFloor)))
  } else {
    for (const s of Object.keys(vars) as Surface[]) set(vars[s], css(t.solid[s]))
    set('--overlay-bg', css(t.solid.raised))
  }
  set('--shadow', glass.on ? t.shadow.glass : t.shadow.solid)
  // Always opaque, even with glass on: for a sidebar peeking over live pane content, where a
  // translucent surface would let the text underneath read through.
  set('--side-solid', css(t.solid.side))

  set('--fg', css(t.text.fg))
  set('--fg-muted', css(t.text.fgMuted))
  set('--inverse', css(t.text.inverse))
  set('--attention', css(t.text.attention))
  set('--success', css(t.text.success))
  set('--running', css(t.text.running))
  set('--destructive', css(t.text.destructive))

  set('--panel-bg', css(...t.fills.panel))
  set('--muted', css(...t.fills.muted))
  set('--selected-bg', css(...t.fills.selected))
  set('--border', css(...t.fills.border))
  set('--attention-muted', css(...t.fills.attentionMuted))
}
