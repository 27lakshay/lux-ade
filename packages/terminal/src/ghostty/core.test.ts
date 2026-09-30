// Portions adapted from t3code apps/web/src/terminal/ghostty/core.test.ts (MIT).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GHOSTTY_CELL_WIDE, GhosttyTerminalCore, ghosttyCellText } from './core'
import { loadGhosttyRuntime } from './runtime'
import { encodeSnapshot } from './testing'

const theme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
}

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4))
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true))
  return view
}

const rowText = (core: GhosttyTerminalCore, row: number): string =>
  core
    .snapshot()
    .rowData[row]!.cells.map((cell) => cell.text || ' ')
    .join('')
    .trimEnd()

describe('ghosttyCellText', () => {
  it('converts oversized grapheme clusters without hitting engine spread limits', () => {
    // A program printing one base character followed by a huge run of combining marks packs the
    // whole cluster into one cell; spreading that many arguments into String.fromCodePoint once
    // overflows the call stack.
    const graphemeLength = 130_000
    const view = new DataView(new ArrayBuffer(graphemeLength * 4))
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(index * 4, index === 0 ? 'a'.codePointAt(0)! : 0x301, true)
    }
    const text = ghosttyCellText(view, graphemeLength)
    expect(text.length).toBe(graphemeLength)
    expect(text.codePointAt(0)).toBe('a'.codePointAt(0))
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x301)
  })

  it('converts small clusters including astral codepoints', () => {
    const text = ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2)
    expect([...text]).toEqual(['\u{1F642}', '\u{20E3}'])
  })

  it('returns an empty string for empty cells', () => {
    expect(ghosttyCellText(codepointView([]), 0)).toBe('')
  })
})

describe('GhosttyTerminalCore', () => {
  const cores = new Set<GhosttyTerminalCore>()

  async function createCore(cols = 12, rows = 3) {
    const core = await GhosttyTerminalCore.create(cols, rows, 8, 16, theme)
    cores.add(core)
    return core
  }

  afterEach(() => {
    for (const core of cores) core.dispose()
    cores.clear()
    vi.restoreAllMocks()
  })

  it('preserves styles, wide cells, and selection after shared memory grows', async () => {
    const core = await createCore()
    const runtime = await loadGhosttyRuntime()
    const grapheme = `e${'́'.repeat(64)}`
    core.write(`\x1b[1;3;4;8;9;53;38;2;123;45;67;48;2;9;8;7m${grapheme}\x1b[0m界🙂`)
    const cells = core.snapshot().rowData[0]!.cells
    expect(cells[0]).toEqual({
      text: grapheme,
      wide: 0,
      foreground: { r: 123, g: 45, b: 67 },
      background: { r: 9, g: 8, b: 7 },
      bold: true,
      boldColor: {
        foreground: { r: 123, g: 45, b: 67 },
        background: { r: 9, g: 8, b: 7 },
        brightForeground: null,
        inverse: false,
        faint: false,
      },
      italic: true,
      invisible: true,
      strikethrough: true,
      overline: true,
      underline: true,
      selected: false,
    })
    expect(cells.slice(1, 5).map(({ text, wide }) => ({ text, wide }))).toEqual([
      { text: '界', wide: GHOSTTY_CELL_WIDE.wide },
      { text: '', wide: GHOSTTY_CELL_WIDE.spacerTail },
      { text: '🙂', wide: GHOSTTY_CELL_WIDE.wide },
      { text: '', wide: GHOSTTY_CELL_WIDE.spacerTail },
    ])

    runtime.memory.grow(1)
    core.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 })
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual({ ...cells[0], selected: true })
    core.clearSelection()
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual(cells[0])
  })

  it('retains bold color provenance and active bright palette overrides', async () => {
    const core = await createCore()
    const palette = Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 }))
    palette[1] = { r: 100, g: 0, b: 0 }
    palette[9] = { r: 0, g: 200, b: 0 }
    core.setTheme({ ...theme, palette })
    core.write('\x1b[1;31mA\x1b[38;2;100;0;0mB\x1b[31;7;2mC')
    const cells = core.snapshot().rowData[0]!.cells
    expect(cells[0]).toMatchObject({
      foreground: { r: 100, g: 0, b: 0 },
      boldColor: { brightForeground: { r: 0, g: 200, b: 0 }, inverse: false, faint: false },
    })
    expect(cells[1]).toMatchObject({ foreground: { r: 100, g: 0, b: 0 }, boldColor: { brightForeground: null } })
    expect(cells[2]).toMatchObject({ boldColor: { inverse: true, faint: true } })
    core.write('\x1b]4;9;#123456\x07')
    expect(core.snapshot().rowData[0]!.cells[0]).toMatchObject({
      boldColor: { brightForeground: { r: 18, g: 52, b: 86 } },
    })
  })

  it('writes bytes as well as strings', async () => {
    const core = await createCore()
    core.write(new TextEncoder().encode('bytes ok'))
    expect(rowText(core, 0)).toBe('bytes ok')
  })

  it('restores a Ghostty snapshot exactly, then continues with live output', async () => {
    const source = await createCore(20, 4)
    source.write('\x1b[1;32mgreen\x1b[0m\r\nsecond line\r\n\x1b[?2004h')
    const bytes = await encodeSnapshot(source)
    expect(bytes.length).toBeGreaterThan(0)

    const viewer = await createCore(20, 4)
    viewer.write('stale content')
    expect(viewer.restoreSnapshot(bytes)).toBe(true)
    expect(rowText(viewer, 0)).toBe('green')
    expect(rowText(viewer, 1)).toBe('second line')
    expect(viewer.snapshot().rowData[0]!.cells[0]).toMatchObject({ bold: true })
    // Terminal modes come across too: bracketed paste was on in the source.
    expect(viewer.encodePaste('x')).toContain('\x1b[200~')

    viewer.write('live')
    expect(rowText(viewer, 2)).toBe('live')
  })

  it('rejects a corrupt snapshot and keeps the screen', async () => {
    const viewer = await createCore()
    viewer.write('kept')
    expect(viewer.restoreSnapshot(new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(rowText(viewer, 0)).toBe('kept')
  })

  it('reports terminal modes', async () => {
    const core = await createCore()
    expect(core.isApplicationCursorKeys()).toBe(false)
    core.write('\x1b[?1h')
    expect(core.isApplicationCursorKeys()).toBe(true)
    expect(core.isMouseAnyEventTracking()).toBe(false)
    core.write('\x1b[?1003h')
    expect(core.isMouseAnyEventTracking()).toBe(true)
    expect(core.isAlternateScreen()).toBe(false)
    core.write('\x1b[?1049h')
    expect(core.isAlternateScreen()).toBe(true)
  })
})
