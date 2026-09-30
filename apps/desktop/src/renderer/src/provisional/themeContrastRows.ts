import { converter, parse, wcagContrast, type Rgb } from 'culori'
import type { ThemeDefinition } from '@ade/contracts'
import type { ContrastReportRow } from './themeContrastInspector'

const rgb = converter('rgb')

export type PaletteSection = 'app' | 'terminal' | 'syntax'
export type Color = string | Rgb | { r: number; g: number; b: number; a?: number; mode?: undefined } | null | undefined

export function color(value: Color): Rgb | null {
  if (!value) return null
  const parsed =
    typeof value === 'string'
      ? parse(value)
      : value.mode === 'rgb'
        ? value
        : {
            mode: 'rgb' as const,
            r: value.r / 255,
            g: value.g / 255,
            b: value.b / 255,
            alpha: value.a === undefined ? 1 : value.a / 255,
          }
  if (!parsed) return null
  const converted = rgb(parsed)
  return converted && Number.isFinite(converted.r) && Number.isFinite(converted.g) && Number.isFinite(converted.b)
    ? converted
    : null
}
export function composite(top: Rgb, bottom: Rgb): Rgb {
  const alpha = top.alpha ?? 1
  const baseAlpha = bottom.alpha ?? 1
  const outAlpha = alpha + baseAlpha * (1 - alpha)
  const channel = (front: number, back: number) => (front * alpha + back * baseAlpha * (1 - alpha)) / outAlpha
  return { mode: 'rgb', r: channel(top.r, bottom.r), g: channel(top.g, bottom.g), b: channel(top.b, bottom.b) }
}
function colorText(value: Rgb | null, preserveAlpha = false): string | null {
  if (!value) return null
  const channel = (component: number) =>
    Math.round(component * 255 + Number.EPSILON * 255)
      .toString(16)
      .padStart(2, '0')
  return (
    '#' +
    channel(value.r) +
    channel(value.g) +
    channel(value.b) +
    (preserveAlpha && value.alpha !== undefined && value.alpha < 1 ? channel(value.alpha) : '')
  )
}
export function row(input: {
  id: string
  surface: string
  state: string
  role: string
  section: PaletteSection
  sourceValue: Color
  resolvedValue: Color
  foreground: Color
  background: Color
  threshold: number | null
  alphaState?: string
  reason?: string
}): ContrastReportRow {
  const fg = color(input.foreground)
  const bg = color(input.background)
  return {
    id: input.id,
    surface: input.surface,
    state: input.state,
    role: input.role,
    section: input.section,
    sourceValue: typeof input.sourceValue === 'string' ? input.sourceValue : colorText(color(input.sourceValue)),
    resolvedValue: colorText(color(input.resolvedValue), true),
    foreground: colorText(fg),
    background: colorText(bg),
    backgroundRgb: bg,
    alphaState: input.alphaState ?? 'opaque',
    threshold: input.threshold,
    ratio: fg && bg && input.threshold !== null ? wcagContrast(fg, bg) : null,
    supported: Boolean(fg && bg && input.threshold !== null),
    ...(input.reason || !fg || !bg
      ? { reason: input.reason ?? 'A consumer color is unavailable, cell-relative, or invalid.' }
      : {}),
  }
}
export function sourceTokens(section: PaletteSection, definition: ThemeDefinition): Record<string, string> {
  return definition[section]?.tokens ?? {}
}
export function unsupported(id: string, surface: string, role: string, reason: string): ContrastReportRow {
  return {
    id,
    surface,
    state: 'unavailable',
    role,
    section: 'diff',
    sourceValue: null,
    resolvedValue: null,
    foreground: null,
    background: null,
    backgroundRgb: null,
    alphaState: 'unavailable',
    threshold: null,
    ratio: null,
    supported: false,
    reason,
  }
}
