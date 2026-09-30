import { clampRgb, converter, formatHex, interpolate, parse, wcagContrast } from 'culori'
import type { PaletteMode, ThemeDefinition } from '@ade/contracts'
import type { APP_THEME_ROLES } from '../../../shared/app-theme-roles'

type AppRole = Exclude<(typeof APP_THEME_ROLES)[number], 'terminal' | `terminal-${string}` | `syntax-${string}`>
const toRgb = converter('rgb')
const statusColors = {
  light: { attention: '#855600', success: '#167044', destructive: '#b42318', info: '#2456a6' },
  dark: { attention: '#f0c36e', success: '#80d6a5', destructive: '#ff9a9a', info: '#9dbbff' },
} as const

function color(value: string, label: string): string {
  const parsed = parse(value.trim())
  if (!parsed || (parsed.alpha !== undefined && parsed.alpha !== 1)) {
    throw new Error(`${label} must be an opaque CSS color.`)
  }
  const rgb = toRgb(parsed)
  if (!rgb || ![rgb.r, rgb.g, rgb.b].every(Number.isFinite)) {
    throw new Error(`${label} must be a finite color.`)
  }
  const hex = formatHex(clampRgb(parsed))
  if (!hex) throw new Error(`${label} cannot be converted to sRGB.`)
  return hex
}

function mix(first: string, second: string, amount: number): string {
  return formatHex(clampRgb(interpolate([first, second], 'oklch')(amount)))
}

function foreground(background: string): string {
  return wcagContrast(background, '#17181b') >= wcagContrast(background, '#f4f5f7') ? '#17181b' : '#f4f5f7'
}

/**
 * Derives all app roles from opaque inputs, clipped to literal sRGB hex with Culori.
 * The returned custom draft has no declared defaults and reads no source definition or DOM colors.
 * Terminal ANSI and syntax palettes are intentionally untouched. This is not a contrast certification.
 */
export function deriveSimpleTheme(input: {
  id: string
  name: string
  mode: PaletteMode
  surface: string
  accent: string
}): ThemeDefinition {
  const surface = color(input.surface, 'Surface')
  const accent = color(input.accent, 'Accent')
  const text = foreground(surface)
  const accentText = foreground(accent)
  const sidebar = mix(surface, text, 0.16)
  const raised = mix(surface, text, 0.045)
  const secondary = mix(surface, text, 0.09)
  const accentFill = mix(surface, accent, 0.19)
  const border = mix(surface, text, 0.19)
  const status = statusColors[input.mode]
  const attentionMuted = mix(surface, status.attention, 0.11)
  const successMuted = mix(surface, status.success, 0.11)
  const destructiveMuted = mix(surface, status.destructive, 0.11)
  const tokens = {
    background: surface,
    foreground: text,
    card: raised,
    'card-foreground': text,
    popover: raised,
    'popover-foreground': text,
    primary: accent,
    'primary-foreground': accentText,
    secondary,
    'secondary-foreground': text,
    muted: secondary,
    'muted-foreground': text,
    accent: accentFill,
    'accent-foreground': text,
    destructive: status.destructive,
    'destructive-foreground': foreground(status.destructive),
    border,
    input: mix(surface, text, 0.3),
    ring: accent,
    sidebar,
    'sidebar-foreground': text,
    'sidebar-primary': accent,
    'sidebar-primary-foreground': accentText,
    'sidebar-accent': accentFill,
    'sidebar-accent-foreground': text,
    'sidebar-border': border,
    'sidebar-ring': accent,
    base: mix(surface, text, 0.24),
    panel: mix(surface, text, 0.12),
    attention: status.attention,
    'attention-muted': attentionMuted,
    running: status.info,
    success: status.success,
    'success-muted': successMuted,
    'destructive-muted': destructiveMuted,
    'diff-add': status.success,
    'diff-add-muted': successMuted,
    'diff-remove': status.destructive,
    'diff-remove-muted': destructiveMuted,
    info: status.info,
    'info-muted': mix(surface, status.info, 0.11),
    link: accent,
    'chart-1': accent,
    'chart-2': status.success,
    'chart-3': status.attention,
    'chart-4': status.destructive,
    'chart-5': status.info,
    'destructive-button-bg': mix(surface, status.destructive, 0.2),
  } satisfies Record<AppRole, string>
  return {
    format: 'ade-theme',
    version: 1,
    id: input.id,
    name: input.name,
    mode: input.mode,
    provenance: { kind: 'user', source: null, source_version: null, source_digest: null, author: null, license: null },
    app: { defaults: null, tokens },
    terminal: null,
    syntax: null,
  }
}
