import { formatHex, interpolate, wcagContrast, type Rgb } from 'culori'
import type { ThemeDefinition, ThemeDraftPreview } from '@ade/contracts'
import { color, composite, row, sourceTokens, unsupported, type PaletteSection } from './themeContrastRows'
import { appendAppContrastRows } from './themeContrastAppRows'
import { appendCodeContrastRows } from './themeContrastCodeRows'
import { createContrastRowAdder, TEXT_THRESHOLD, NON_TEXT_THRESHOLD } from './themeContrastRowAdder'

export type ContrastReportRow = {
  id: string
  surface: string
  state: string
  role: string
  section: PaletteSection | 'diff'
  sourceValue: string | null
  resolvedValue: string | null
  foreground: string | null
  background: string | null
  /** Exact consumer background, before the diagnostic hex display rounds its channels. */
  backgroundRgb: Rgb | null
  alphaState: string
  threshold: number | null
  ratio: number | null
  supported: boolean
  reason?: string
}
export type ThemeContrastReport = {
  diagnosticsOnly: true
  diagnostics: ThemeDraftPreview['diagnostics']
  rows: ContrastReportRow[]
}

/** Measured pairs from shipped consumers only; a diagnostic report, never a certification. */
export function inspectThemeContrast(
  preview: ThemeDraftPreview,
  definition: ThemeDefinition = preview.definition,
): ThemeContrastReport {
  const rows: ContrastReportRow[] = []
  const add = createContrastRowAdder(rows, definition)
  appendAppContrastRows(preview, add)

  const terminal = preview.terminal
  if (terminal) {
    const source = sourceTokens('terminal', definition)
    add(
      'terminal-default',
      'Terminal text',
      'default',
      'terminal',
      'terminal-foreground',
      terminal.foreground,
      terminal.background,
      TEXT_THRESHOLD,
    )
    const selectionBg = color(terminal.selection_background)
    const selectionResolvedBg =
      selectionBg && color(terminal.background) ? composite(selectionBg, color(terminal.background)!) : null
    const selectionForeground = terminal.selection_foreground
    const selected = row({
      id: 'terminal-selected',
      surface: 'Terminal text',
      state: 'selected',
      role: 'terminal-selection-foreground',
      section: 'terminal',
      sourceValue: source['terminal-selection-foreground'],
      resolvedValue: selectionForeground,
      foreground: selectionForeground,
      background: selectionResolvedBg,
      threshold: TEXT_THRESHOLD,
      alphaState: 'selection background composited over terminal background',
    })
    if (
      source['terminal-selection']?.startsWith('cell-') ||
      (typeof terminal.selection_background === 'string' && terminal.selection_background.startsWith('cell-')) ||
      (typeof selectionForeground === 'string' && selectionForeground.startsWith('cell-'))
    ) {
      selected.supported = false
      selected.ratio = null
      selected.reason = 'Selection colors follow each terminal cell; a single contrast ratio is unavailable.'
    }
    rows.push(selected)
    rows.push(
      row({
        id: 'terminal-cursor',
        surface: 'Terminal cursor',
        state: 'cursor',
        role: 'terminal-cursor',
        section: 'terminal',
        sourceValue: source['terminal-cursor'],
        resolvedValue: terminal.cursor,
        foreground: terminal.cursor,
        background: terminal.background,
        threshold: NON_TEXT_THRESHOLD,
        alphaState: 'cursor over terminal background',
      }),
    )
  }

  appendCodeContrastRows(preview, add)
  rows.push(
    unsupported(
      'diff-lines',
      'Production diff surface',
      'production diff foreground and addition/deletion states',
      'Production file and diff consumers are not built in this workbench. The measured Pierre preview does not certify a production consumer.',
    ),
    unsupported(
      'diff-selection',
      'Diff selection and keyboard focus',
      'diff selected/focus roles',
      'The Pierre preview does not enable line selection or a keyboard focus treatment. Browser-native text selection has no ADE role mapping; production diff state consumers remain unavailable.',
    ),
  )
  const measured = new Set(rows.map((item) => item.section + '/' + item.role))
  for (const section of ['app', 'syntax', 'terminal'] as const) {
    for (const [role, sourceValue] of Object.entries(sourceTokens(section, definition))) {
      if (measured.has(section + '/' + role)) continue
      const extension = preview.diagnostics?.find(
        (diagnostic) =>
          diagnostic.code === 'unsupported_extension' &&
          diagnostic.path === '/' + section + '/tokens/' + role.replaceAll('~', '~0').replaceAll('/', '~1'),
      )
      rows.push(
        row({
          id: 'unmeasured-' + section + '-' + role,
          surface: 'Declared role without a direct contrast measurement',
          state: 'unmeasured',
          section,
          role,
          sourceValue,
          resolvedValue: extension ? null : preview.definition[section]?.tokens[role],
          foreground: null,
          background: null,
          threshold: null,
          alphaState: 'unmeasured',
          reason:
            extension?.message ??
            'No direct contrast measurement for this declared role. Background or decoration roles may contribute to the pairs above; no standalone ratio is inferred.',
        }),
      )
    }
  }
  return { diagnosticsOnly: true, diagnostics: preview.diagnostics ?? [], rows }
}

/** A local draft suggestion only; all measured states of this editable role must pass. */
export function findDraftContrastRepair(
  preview: ThemeDraftPreview,
  item: ContrastReportRow,
  report: ThemeContrastReport = inspectThemeContrast(preview),
  definition: ThemeDefinition = preview.definition,
): string | null {
  if (
    !preview.valid ||
    !item.supported ||
    item.section === 'diff' ||
    item.ratio === null ||
    item.threshold === null ||
    item.ratio >= item.threshold
  )
    return null
  const tokens = definition[item.section]?.tokens
  if (!item.sourceValue || !tokens || !Object.hasOwn(tokens, item.role)) return null
  const original = color(item.resolvedValue)
  if (!original || (color(tokens[item.role])?.alpha ?? 1) !== 1) return null
  const peers = report.rows.filter((peer) => peer.section === item.section && peer.role === item.role && peer.supported)
  if (!peers.length || peers.some((peer) => !peer.backgroundRgb || peer.threshold === null)) return null
  if (item.section === 'app' && item.role === 'destructive') return null
  const passes = (candidate: Rgb) =>
    peers.every((peer) => {
      const background = peer.backgroundRgb!
      const foreground =
        peer.section === 'app' && peer.role === 'ring' ? composite({ ...candidate, alpha: 0.5 }, background) : candidate
      return wcagContrast(foreground, background) >= peer.threshold!
    })
  let nearest: { value: string; amount: number } | null = null
  for (const endpoint of [0, 255]) {
    const mix = interpolate([original, endpoint === 0 ? '#000000' : '#ffffff'], 'rgb')
    const boundaries = new Set<number>([0, 1])
    // Hex values change at channel rounding boundaries. Check each distinct candidate in
    // order: peer constraints can admit an intermediate color even if the endpoint fails.
    for (const channel of [original.r, original.g, original.b]) {
      const distance = Math.abs(endpoint - Math.round(channel * 255))
      for (let step = 0; step < distance; step++) boundaries.add((step + 0.5) / distance)
    }
    const ordered = [...boundaries].sort((left, right) => left - right)
    for (let index = 0; index < ordered.length; index++) {
      const amount = ordered[index]!
      if (nearest && amount >= nearest.amount) break
      const value = formatHex(mix((amount + (ordered[index + 1] ?? amount)) / 2))!
      const candidate = color(value)!
      if (passes(candidate)) {
        nearest = { value, amount }
        break
      }
    }
  }
  return nearest?.value ?? null
}
