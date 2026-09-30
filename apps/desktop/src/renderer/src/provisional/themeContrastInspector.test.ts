import { expect, test } from 'vitest'
import type { ThemeDraftPreview } from '@ade/contracts'
import { findDraftContrastRepair, inspectThemeContrast } from './themeContrastInspector'

const preview = (overrides: Record<string, unknown> = {}) =>
  ({
    type: 'theme_draft_preview',
    valid: true,
    definition: {
      id: 'ade:fixture',
      name: 'Fixture',
      mode: 'light',
      provenance: { kind: 'bundled' },
      app: {
        tokens: {
          'primary-foreground': '#ffffff',
          primary: '#000000',
          'secondary-foreground': '#ffffff',
          secondary: '#000000',
          'accent-foreground': '#ffffff',
          accent: '#000000',
          background: '#ffffff',
          foreground: '#000000',
          muted: '#f0f0f0',
          card: '#ffffff',
          ring: '#000000',
          destructive: '#000000',
          'destructive-foreground': '#ffffff',
          'destructive-muted': '#f3ebec',
        },
      },
      syntax: { tokens: {} },
      terminal: { tokens: { 'terminal-selection': '#00000080', 'terminal-selection-foreground': '#ffffff' } },
    },
    app: {
      id: 'ade:fixture',
      name: 'Fixture',
      mode: 'light',
      tokens: {
        'primary-foreground': '#ffffff',
        primary: '#000000',
        'secondary-foreground': '#ffffff',
        secondary: '#000000',
        'accent-foreground': '#ffffff',
        accent: '#000000',
        background: '#ffffff',
        foreground: '#000000',
        muted: '#f0f0f0',
        card: '#ffffff',
        ring: '#000000',
        destructive: '#000000',
        'destructive-foreground': '#ffffff',
        'destructive-muted': '#f3ebec',
      },
    },
    syntax: {
      id: 'ade:fixture',
      name: 'Fixture',
      mode: 'light',
      tokens: {
        base: '#ffffff',
        accent: '#000000',
        'accent-foreground': '#ffffff',
        'diff-add': '#008000',
        'diff-remove': '#800000',
        'diff-add-muted': '#ccffcc',
        'diff-remove-muted': '#ffcccc',
        'muted-foreground': '#333333',
        panel: '#eeeeee',
        'syntax-default': '#000000',
        'syntax-keyword': '#000000',
        'syntax-string': '#000000',
        'syntax-number': '#000000',
        'syntax-comment': '#000000',
        'syntax-added': '#000000',
        'syntax-removed': '#000000',
      },
    },
    terminal: {
      foreground: { r: 0, g: 0, b: 0 },
      background: { r: 255, g: 255, b: 255 },
      cursor: { r: 0, g: 0, b: 0 },
      cursor_text: { r: 255, g: 255, b: 255 },
      dark: false,
      minimum_contrast: 1,
      palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
      revision: 1,
      selection_background: { r: 0, g: 0, b: 0, a: 128 },
      selection_foreground: { r: 255, g: 255, b: 255 },
    },
    ...overrides,
  }) as unknown as ThemeDraftPreview

test('reports actual ratios and keeps distinct roles with matching colors', () => {
  const report = inspectThemeContrast(preview())
  const primary = report.rows.find((item) => item.id === 'app-primary-default')!
  expect(primary.ratio).toBe(21)
  expect(primary.threshold).toBe(4.5)
  expect(report.rows.find((item) => item.id === 'app-secondary-default')?.ratio).toBe(21)
  expect(primary.role).not.toBe(report.rows.find((item) => item.id === 'app-secondary-default')?.role)
  expect(report.rows.some((item) => item.id === 'syntax-syntax-keyword' && item.supported)).toBe(true)
  expect(
    report.rows.filter((item) => item.section === 'diff').every((item) => !item.supported && item.ratio === null),
  ).toBe(true)
  expect(report.diagnosticsOnly).toBe(true)
})

test('composites hover and alpha selection colors over their real opaque surface', () => {
  const report = inspectThemeContrast(preview())
  const hover = report.rows.find((item) => item.id === 'app-primary-hover')!
  const selection = report.rows.find((item) => item.id === 'terminal-selected')!
  expect(hover.alphaState).toBe('Button default variant: hover:bg-primary/80 over card surface')
  expect(hover.background).toBe('#333333')
  expect(selection.background).toBe('#7f7f7f')
  const ring = report.rows.find((item) => item.id === 'app-primary-focus')!
  expect(ring.resolvedValue).toBe('#000000')
  expect(ring.foreground).not.toBe(ring.resolvedValue)
  expect(selection.ratio).toBeGreaterThan(1)
  expect(selection.alphaState).toBe('selection background composited over terminal background')
})

test('identifies cell-relative selection as unavailable rather than measuring a guess', () => {
  const value = preview()
  value.definition.terminal!.tokens['terminal-selection'] = 'cell-background'
  value.terminal!.selection_background = 'cell-background'
  const selection = inspectThemeContrast(value).rows.find((item) => item.id === 'terminal-selected')!
  expect(selection.supported).toBe(false)
  expect(selection.ratio).toBeNull()
  expect(selection.reason).toContain('each terminal cell')
})

test('finds the nearest draft color that meets both primary text thresholds without mutating the preview', () => {
  const value = preview()
  value.definition.app!.tokens.primary = '#808080'
  value.definition.app!.tokens['primary-foreground'] = '#808080'
  value.app!.tokens.primary = '#808080'
  value.app!.tokens['primary-foreground'] = '#808080'
  const before = structuredClone(value)
  const report = inspectThemeContrast(value)
  const primary = report.rows.find((item) => item.id === 'app-primary-default')!
  expect(primary.ratio).toBe(1)
  const replacement = findDraftContrastRepair(value, primary, report)
  expect(replacement).toBe('#171717')
  expect(value).toEqual(before)
  value.definition.app!.tokens['primary-foreground'] = replacement!
  value.app!.tokens['primary-foreground'] = replacement!
  for (const item of inspectThemeContrast(value).rows.filter(
    (item) => item.section === 'app' && item.role === 'primary-foreground',
  )) {
    expect(item.ratio).toBeGreaterThanOrEqual(4.5)
  }
  value.app!.tokens['primary-foreground'] = '#181818'
  expect(inspectThemeContrast(value).rows.find((item) => item.id === 'app-primary-default')!.ratio).toBeLessThan(4.5)
})

test('repairs ring contrast as a 50% composite over card rather than an opaque foreground', () => {
  const value = preview()
  value.definition.app!.tokens.ring = '#808080'
  value.app!.tokens.ring = '#808080'
  const report = inspectThemeContrast(value)
  const ring = report.rows.find((item) => item.id === 'app-primary-focus')!
  expect(ring.ratio).toBeLessThan(3)
  const replacement = findDraftContrastRepair(value, ring, report)
  expect(replacement).toBe('#2a2a2a')
  value.app!.tokens.ring = replacement!
  expect(
    inspectThemeContrast(value).rows.find((item) => item.id === 'app-primary-focus')!.ratio,
  ).toBeGreaterThanOrEqual(3)
  value.app!.tokens.ring = '#2b2b2b'
  expect(inspectThemeContrast(value).rows.find((item) => item.id === 'app-primary-focus')!.ratio).toBeLessThan(3)
})

test('does not suggest a one-token repair for the destructive text and its self-tinted backgrounds', () => {
  const value = preview()
  value.definition.app!.tokens.destructive = '#ff0000'
  value.app!.tokens.destructive = '#ff0000'
  const report = inspectThemeContrast(value)
  const destructive = report.rows.find((item) => item.id === 'app-destructive-default')!
  expect(destructive.ratio).toBeLessThan(4.5)
  expect(findDraftContrastRepair(value, destructive, report)).toBeNull()
})

function appDraft(tokens: Record<string, string>) {
  const value = preview()
  Object.assign(value.definition.app!.tokens, tokens)
  Object.assign(value.app!.tokens, tokens)
  return value
}

test('chooses the smaller black interpolation when both directions have passing colors', () => {
  const value = appDraft({ primary: '#767676', 'primary-foreground': '#767676', card: '#767676' })
  const report = inspectThemeContrast(value)
  expect(
    findDraftContrastRepair(
      value,
      report.rows.find((item) => item.id === 'app-primary-default')!,
      report,
    ),
  ).toBe('#040404')
})

test('uses unrounded hover backgrounds and the stricter peer rather than the selected default row alone', () => {
  const value = appDraft({ primary: '#525252', 'primary-foreground': '#525252' })
  const report = inspectThemeContrast(value)
  expect(
    findDraftContrastRepair(
      value,
      report.rows.find((item) => item.id === 'app-primary-default')!,
      report,
    ),
  ).toBe('#fcfcfc')
  value.app!.tokens['primary-foreground'] = '#fcfcfc'
  const repaired = inspectThemeContrast(value)
  expect(repaired.rows.find((item) => item.id === 'app-primary-hover')!.ratio).toBeCloseTo(4.516770602, 8)
  value.app!.tokens['primary-foreground'] = '#fbfbfb'
  expect(inspectThemeContrast(value).rows.find((item) => item.id === 'app-primary-hover')!.ratio).toBeLessThan(4.5)
})

test('keeps a feasible intermediate peer-row interval even when neither endpoint satisfies all peers', () => {
  const value = appDraft({ primary: '#ffffff', 'primary-foreground': '#ffffff' })
  const report = inspectThemeContrast(value)
  const primary = report.rows.find((item) => item.id === 'app-primary-default')!
  const peer = report.rows.find((item) => item.id === 'app-primary-hover')!
  peer.background = '#000000'
  peer.backgroundRgb = { mode: 'rgb', r: 0, g: 0, b: 0 }
  peer.ratio = 21
  expect(findDraftContrastRepair(value, primary, report)).toBe('#767676')
})

test('honors a higher peer threshold when deriving the same role replacement', () => {
  const value = appDraft({ primary: '#000000', 'primary-foreground': '#000000' })
  const report = inspectThemeContrast(value)
  report.rows.find((item) => item.id === 'app-primary-hover')!.threshold = 7
  const replacement = findDraftContrastRepair(
    value,
    report.rows.find((item) => item.id === 'app-primary-default')!,
    report,
  )
  value.app!.tokens['primary-foreground'] = replacement!
  expect(
    inspectThemeContrast(value).rows.find((item) => item.id === 'app-primary-hover')!.ratio,
  ).toBeGreaterThanOrEqual(7)
})

test('declines a repair when primary peer rows cannot share any passing replacement', () => {
  const value = appDraft({ primary: '#777777', 'primary-foreground': '#777777', card: '#000000' })
  const report = inspectThemeContrast(value)
  expect(
    findDraftContrastRepair(
      value,
      report.rows.find((item) => item.id === 'app-primary-default')!,
      report,
    ),
  ).toBeNull()
})

test('declines a ring repair when its required half-opacity cannot reach the threshold', () => {
  const value = appDraft({ ring: '#808080', card: '#808080' })
  const report = inspectThemeContrast(value)
  expect(
    findDraftContrastRepair(
      value,
      report.rows.find((item) => item.id === 'app-primary-focus')!,
      report,
    ),
  ).toBeNull()
})

test('does not repair passing, undeclared, invalid, diff or cell-relative report roles', () => {
  const passing = preview()
  const passingReport = inspectThemeContrast(passing)
  expect(
    findDraftContrastRepair(
      passing,
      passingReport.rows.find((item) => item.id === 'app-primary-default')!,
      passingReport,
    ),
  ).toBeNull()
  expect(
    findDraftContrastRepair(
      passing,
      passingReport.rows.find((item) => item.id === 'diff-lines')!,
      passingReport,
    ),
  ).toBeNull()
  const inherited = appDraft({ primary: '#ffffff' })
  delete inherited.definition.app!.tokens['primary-foreground']
  const inheritedReport = inspectThemeContrast(inherited)
  expect(
    findDraftContrastRepair(
      inherited,
      inheritedReport.rows.find((item) => item.id === 'app-primary-default')!,
      inheritedReport,
    ),
  ).toBeNull()
  const invalid = appDraft({ primary: '#ffffff' })
  invalid.valid = false
  const invalidReport = inspectThemeContrast(invalid)
  expect(
    findDraftContrastRepair(
      invalid,
      invalidReport.rows.find((item) => item.id === 'app-primary-default')!,
      invalidReport,
    ),
  ).toBeNull()
  const cells = preview()
  cells.definition.terminal!.tokens['terminal-selection'] = 'cell-background'
  cells.terminal!.selection_background = 'cell-background'
  const cellReport = inspectThemeContrast(cells)
  expect(
    findDraftContrastRepair(
      cells,
      cellReport.rows.find((item) => item.id === 'terminal-selected')!,
      cellReport,
    ),
  ).toBeNull()
})

test('crosswalks visible app states to their distinct semantic roles and leaves absent consumers unmapped', () => {
  const report = inspectThemeContrast(preview())
  const byId = (id: string) => report.rows.find((item) => item.id === id)!
  expect([byId('app-outline-hover').role, byId('app-outline-open').role]).toEqual(['foreground', 'foreground'])
  expect(byId('app-outline-hover').ratio).toBeGreaterThan(4.5)
  expect([byId('app-toggle-hover').role, byId('app-toggle-pressed').role]).toEqual(['foreground', 'foreground'])
  expect([byId('app-menu-hover').role, byId('app-menu-focus').role]).toEqual(['accent-foreground', 'accent-foreground'])
  expect(byId('app-menu-focus').background).toBe('#000000')
  expect(byId('app-secondary-default').state).toBe('default')
  expect(byId('app-secondary-hover').role).toBe('secondary-foreground')
  expect(byId('app-destructive-default').role).toBe('destructive')
  expect(byId('app-destructive-default').background).toBe('#e6e6e6')
  expect(byId('app-destructive-focus').threshold).toBe(3)
  expect(byId('code-selection').role).toBe('accent-foreground')
  expect(byId('code-selection').section).toBe('syntax')
  expect(byId('syntax-syntax-comment').surface).toBe('Shiki code preview')
  expect(report.rows.some((item) => item.id === 'syntax-syntax-added')).toBe(false)
  expect(byId('app-primary-default').role).toBe('primary-foreground')
  expect(byId('diff-lines').supported).toBe(false)
  expect(byId('diff-selection').supported).toBe(false)
  expect(byId('terminal-selected').role).toBe('terminal-selection-foreground')
  expect(byId('terminal-cursor').role).toBe('terminal-cursor')
})

test('measures Shiki selection from syntax declarations even without an app projection', () => {
  const value = preview()
  value.app = null
  value.definition.app = null
  value.syntax!.tokens.accent = '#ffffff'
  value.syntax!.tokens['accent-foreground'] = '#000000'
  value.definition.syntax!.tokens['accent-foreground'] = '#000000'
  const selection = inspectThemeContrast(value).rows.find((item) => item.id === 'code-selection')!
  expect(selection.section).toBe('syntax')
  expect(selection.role).toBe('accent-foreground')
  expect(selection.sourceValue).toBe('#000000')
  expect(selection.foreground).toBe('#000000')
  expect(selection.background).toBe('#ffffff')
  expect(selection.ratio).toBe(21)
})

test('separates dark outline input alpha from opaque toggle muted and light outline muted', () => {
  const value = appDraft({ input: '#000000', muted: '#888888', card: '#ffffff', foreground: '#ffffff' })
  value.definition.mode = 'dark'
  value.app!.mode = 'dark'
  const dark = inspectThemeContrast(value)
  const outline = dark.rows.find((item) => item.id === 'app-outline-hover')!
  const toggle = dark.rows.find((item) => item.id === 'app-toggle-hover')!
  expect(outline.backgroundRgb!.r).toBe(0.5)
  expect(outline.ratio).toBeCloseTo(3.9766530249, 8)
  expect(toggle.background).toBe('#888888')
  expect(toggle.ratio).toBeCloseTo(3.5448862153, 8)
  value.app!.mode = 'light'
  value.definition.mode = 'light'
  expect(inspectThemeContrast(value).rows.find((item) => item.id === 'app-outline-hover')!.background).toBe('#888888')
})

test('keeps raw sparse declarations distinct from expanded defaults in the resolved preview', () => {
  const value = appDraft({ primary: '#234567' })
  const raw = structuredClone(value.definition)
  raw.app = { defaults: 'ade:chalk', tokens: { primary: '#234567' } }
  const before = structuredClone(raw)
  const primary = inspectThemeContrast(value, raw).rows.find((item) => item.id === 'app-primary-default')!
  expect(primary.sourceValue).toBeNull()
  expect(primary.resolvedValue).toBe('#ffffff')
  expect(primary.ratio).toBeGreaterThan(4.5)
  expect(raw).toEqual(before)
  expect(findDraftContrastRepair(value, primary, inspectThemeContrast(value, raw), raw)).toBeNull()
})

test('keeps the secondary OKLCH background unrounded when choosing a passing repair', () => {
  const value = appDraft({ secondary: '#030303', foreground: '#ffffff', 'secondary-foreground': '#787878' })
  const report = inspectThemeContrast(value)
  const hover = report.rows.find((item) => item.id === 'app-secondary-hover')!
  expect(hover.background).toBe('#090909')
  expect(hover.backgroundRgb!.r).toBeCloseTo(0.037055878226046966, 14)
  expect(hover.ratio).toBeCloseTo(4.498379233781973, 10)
  const replacement = findDraftContrastRepair(value, hover, report)
  expect(replacement).toBe('#797979')
  value.app!.tokens['secondary-foreground'] = replacement!
  expect(
    inspectThemeContrast(value).rows.find((item) => item.id === 'app-secondary-hover')!.ratio,
  ).toBeGreaterThanOrEqual(4.5)
})

test('keeps valid-preview warnings and declared unmeasured roles explicit without ratios or repairs', () => {
  const value = preview()
  value.definition.app!.tokens['extension/role'] = '#ff0000'
  value.definition.syntax!.tokens['syntax-added'] = '#000000'
  value.diagnostics = [
    {
      severity: 'warning',
      code: 'unsupported_extension',
      path: '/app/tokens/extension~1role',
      message: 'Unsupported token is retained without applying it.',
      line: 1,
      column: 1,
      offset: 0,
      length: 0,
    },
  ]
  const report = inspectThemeContrast(value)
  expect(report.diagnostics).toEqual(value.diagnostics)
  const extension = report.rows.find((item) => item.id === 'unmeasured-app-extension/role')!
  expect(extension.sourceValue).toBe('#ff0000')
  expect(extension.resolvedValue).toBeNull()
  expect(extension.ratio).toBeNull()
  expect(extension.threshold).toBeNull()
  expect(extension.supported).toBe(false)
  expect(findDraftContrastRepair(value, extension, report)).toBeNull()
  const unusedSyntax = report.rows.find((item) => item.id === 'unmeasured-syntax-syntax-added')!
  expect(unusedSyntax.ratio).toBeNull()
  expect(unusedSyntax.supported).toBe(false)
})

test('measures Pierre preview tokens against changed-line, gutter, marker and word-emphasis consumers', () => {
  const report = inspectThemeContrast(preview())
  const addition = report.rows.find((item) => item.id === 'diff-addition-syntax-default')!
  const deletionNumber = report.rows.find((item) => item.id === 'diff-deletion-syntax-number')!
  const emphasis = report.rows.find((item) => item.id === 'diff-addition-word')!
  expect(addition.section).toBe('syntax')
  expect(addition.role).toBe('syntax-default')
  expect(addition.background).toBe('#ccffcc')
  expect(addition.ratio).toBeGreaterThan(4.5)
  expect(deletionNumber.background).toBe('#ffcccc')
  expect(emphasis.role).toBe('syntax-number')
  expect(emphasis.background).toBe('#bfdfbf')
  expect(emphasis.backgroundRgb!.g).toBeCloseTo(0.8754901960784314, 14)
  expect(report.rows.find((item) => item.id === 'diff-addition-gutter')!.role).toBe('muted-foreground')
  expect(report.rows.find((item) => item.id === 'diff-deletion-marker')!.role).toBe('diff-remove')
  expect(report.rows.find((item) => item.id === 'diff-addition-hover')!.background).toBe('#ccffcc')
  expect(report.rows.find((item) => item.id === 'diff-lines')!.ratio).toBeNull()
  expect(report.rows.find((item) => item.id === 'diff-selection')!.supported).toBe(false)
})

test('rounds a Pierre 25 percent sRGB emphasis surface at the CSS channel boundary', () => {
  const value = preview()
  value.syntax!.tokens.base = '#101113'
  value.syntax!.tokens['diff-add'] = '#80d6a5'
  const emphasis = inspectThemeContrast(value).rows.find((item) => item.id === 'diff-addition-word')!
  expect(emphasis.background).toBe('#2c4238')
  expect(emphasis.backgroundRgb!.b * 255).toBeCloseTo(55.5, 10)
})
test('maps saturated secondary OKLCH hover into the rendered sRGB gamut before contrast and repair', () => {
  const value = appDraft({ secondary: '#ffff00', foreground: '#00ffff', 'secondary-foreground': '#717171' })
  const report = inspectThemeContrast(value)
  const hover = report.rows.find((item) => item.id === 'app-secondary-hover')!
  expect(hover.background).toBe('#f3ff2d')
  expect(hover.backgroundRgb!.r).toBeCloseTo(0.9520561114372627, 14)
  expect(hover.backgroundRgb!.g).toBe(1)
  expect(hover.backgroundRgb!.b).toBeCloseTo(0.17672727575259722, 14)
  expect(hover.ratio).toBeCloseTo(4.4495674565, 8)
  expect(hover.ratio).toBeLessThan(4.5)
  const replacement = findDraftContrastRepair(value, hover, report)
  expect(replacement).not.toBeNull()
  value.app!.tokens['secondary-foreground'] = replacement!
  const repaired = inspectThemeContrast(value).rows.find((item) => item.id === 'app-secondary-hover')!
  expect(repaired.ratio).toBeGreaterThanOrEqual(4.5)
})

test('preserves resolved declaration alpha while keeping composite pair colors opaque', () => {
  const report = inspectThemeContrast(preview())
  const declaration = report.rows.find((item) => item.id === 'unmeasured-terminal-terminal-selection')!
  const selected = report.rows.find((item) => item.id === 'terminal-selected')!
  expect(declaration.sourceValue).toBe('#00000080')
  expect(declaration.resolvedValue).toBe('#00000080')
  expect(selected.foreground).toBe('#ffffff')
  expect(selected.background).toBe('#7f7f7f')
  expect(selected.foreground).toMatch(/^#[0-9a-f]{6}$/i)
  expect(selected.background).toMatch(/^#[0-9a-f]{6}$/i)
})
