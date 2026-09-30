// Portions adapted from t3code apps/web/src/terminal/ghostty/renderer.test.ts (MIT).
import { describe, expect, it } from 'vitest'

import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from './core'
import { ghosttyTextRunEnd, measureGhosttyCell, renderGhosttySnapshot, terminalGridSize } from './renderer'

const cell = (text: string, wide = 0): GhosttyCell => ({
  text,
  wide,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
})

describe('terminalGridSize', () => {
  it("matches the mobile renderer's cell-and-padding sizing model", () => {
    expect(terminalGridSize(808, 408, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 80,
      rows: 20,
    })
  })

  it('never sends an invalid zero-sized terminal to libghostty', () => {
    expect(terminalGridSize(0, 0, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 1,
      rows: 1,
    })
  })
})

describe('measureGhosttyCell', () => {
  it('uses descender-aware metrics and the mobile terminal line-height', () => {
    const measureText = (text: string) =>
      text === 'M'
        ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
        : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 }
    const context = {
      font: '',
      measureText,
    } as unknown as CanvasRenderingContext2D

    expect(measureGhosttyCell(context, 12, 'monospace')).toEqual({
      width: 7.2,
      height: 16,
      baseline: 11,
    })
  })

  it('measures requested line height and kerning', () => {
    const context = {
      font: '',
      fontKerning: 'auto',
      measureText: (text: string) =>
        text === 'M'
          ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
          : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 },
    } as unknown as CanvasRenderingContext2D
    expect(measureGhosttyCell(context, 12, 'monospace', 2, 'none')).toEqual({
      width: 7.2,
      height: 24,
      baseline: 15,
    })
    expect(context.fontKerning).toBe('none')
  })
})

describe('ghosttyTextRunEnd', () => {
  it('includes wide spacer tails in the visual clip without rendering spaces', () => {
    const cells = [
      cell('界', GHOSTTY_CELL_WIDE.wide),
      cell('', GHOSTTY_CELL_WIDE.spacerTail),
      cell('🙂', GHOSTTY_CELL_WIDE.wide),
      cell('', GHOSTTY_CELL_WIDE.spacerTail),
      cell(''),
    ]
    expect(ghosttyTextRunEnd(cells, 0, () => true)).toBe(4)
  })
})

describe('renderGhosttySnapshot', () => {
  it('underlines every cell in a hovered wrapped link', () => {
    const fillRectCalls: number[][] = []
    const context = {
      canvas: { width: 200, height: 80 },
      fontKerning: 'auto',
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRectCalls.push(args),
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const snapshot: GhosttySnapshot = {
      cols: 4,
      rows: 2,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0, 1]),
      rowData: [0, 1].map(() => ({
        cells: [cell('a'), cell('b'), cell('c'), cell('d')],
        text: 'abcd',
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    }

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 10, height: 20, baseline: 15 },
      fontSize: 12,
      fontFamily: 'monospace',
      padding: 4,
      forceFull: false,
      cursorOn: false,
      hoveredLinkRange: { start: { x: 2, y: 0 }, end: { x: 1, y: 1 } },
      kerning: 'none',
    })

    expect(fillRectCalls.filter(([, , , height]) => height === 1)).toEqual([
      [24, 22, 10, 1],
      [34, 22, 10, 1],
      [4, 42, 10, 1],
      [14, 42, 10, 1],
    ])
    expect(context.fontKerning).toBe('none')
  })

  it('repaints the original shaped run under a clipped block cursor', () => {
    const fillTextCalls: unknown[][] = []
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const cells = [cell('a'), cell('b'), cell('x')]
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: 'abx', isWrapContinuation: false, wrapsToNext: false }],
    }

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: 'monospace',
      padding: 4,
      forceFull: false,
      cursorOn: true,
    })

    expect(fillTextCalls).toEqual([
      ['abx', 4, 15, 21.6],
      ['abx', 4, 15, 21.6],
    ])
  })

  it('repaints the cell without an overlay during the blink off phase', () => {
    const fillTextCalls: unknown[][] = []
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: true,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [
        {
          cells: [cell('a'), cell('b'), cell('x')],
          text: 'abx',
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    }

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: 'monospace',
      padding: 4,
      forceFull: false,
      cursorOn: false,
    })

    // The cursor row still repaints so the block disappears, but the inverted
    // glyph the on phase draws over the cell is gone.
    expect(fillTextCalls).toEqual([['abx', 4, 15, 21.6]])
  })

  it('repaints the previous cursor row after the cursor moves', () => {
    const clearedRows: number[] = []
    const context = {
      canvas: { width: 200, height: 80 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (_left: number, top: number, _width: number, height: number) => {
        if (height === 16) clearedRows.push(top)
      },
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const snapshot: GhosttySnapshot = {
      cols: 1,
      rows: 3,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 0,
      cursorY: 2,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [cell('')],
        text: '',
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    }

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: 'monospace',
      padding: 4,
      forceFull: false,
      cursorOn: true,
      previousCursorY: 0,
    })

    expect(clearedRows).toEqual([4, 36, 36])
  })
})

describe('block cursor glyph geometry', () => {
  it.each([0, 1, 2, 3, 4])('preserves painted pixels with the cursor in column %i', (cursorX) => {
    const canvas = document.createElement('canvas')
    canvas.width = 50
    canvas.height = 24
    const context = canvas.getContext('2d')!
    const cells = [
      cell('f'),
      cell('i'),
      cell('界', GHOSTTY_CELL_WIDE.wide),
      cell('', GHOSTTY_CELL_WIDE.spacerTail),
      cell('e\u0301'),
    ]
    const snapshot: GhosttySnapshot = {
      cols: 5,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: 'fi界e\u0301', isWrapContinuation: false, wrapsToNext: false }],
    }
    const options = {
      context,
      snapshot,
      metrics: { width: 10, height: 24, baseline: 19 },
      fontSize: 18,
      fontFamily: 'monospace',
      padding: 0,
      forceFull: true,
    }
    renderGhosttySnapshot({ ...options, cursorOn: false })
    const reference = document.createElement('canvas')
    reference.width = 50
    reference.height = 24
    const referenceContext = reference.getContext('2d')!
    // Compare with the normal full-run paint in the same colors. Browser text
    // antialiasing depends on foreground/background, so RGB inversion is not a
    // valid reference for glyph coverage.
    renderGhosttySnapshot({
      ...options,
      context: referenceContext,
      cursorOn: false,
      snapshot: {
        ...snapshot,
        background: { r: 255, g: 255, b: 255 },
        rowData: [
          {
            ...snapshot.rowData[0]!,
            cells: cells.map((value) => ({
              ...value,
              foreground: { r: 0, g: 0, b: 0 },
              background: { r: 255, g: 255, b: 255 },
            })),
          },
        ],
      },
    })
    const expected = referenceContext.getImageData(0, 0, 50, 24).data
    const before = context.getImageData(0, 0, 50, 24).data
    renderGhosttySnapshot({ ...options, cursorOn: true })
    const after = context.getImageData(0, 0, 50, 24).data
    const left = cursorX === 3 ? 20 : cursorX * 10
    const width = cursorX === 2 || cursorX === 3 ? 20 : 10
    let glyphPixels = 0
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 50; x++) {
        const offset = (y * 50 + x) * 4
        if (x >= left && x < left + width) {
          if (before[offset]! > 0) glyphPixels++
          expect(after[offset]).toBe(expected[offset])
        } else expect(after[offset]).toBe(before[offset])
      }
    }
    expect(glyphPixels).toBeGreaterThan(0)
  })
})

describe('terminal foreground policies', () => {
  it.each(['selection', 'cursor'] as const)('paints literal %s text without changing glyph coverage', (target) => {
    const canvas = document.createElement('canvas')
    canvas.width = 40
    canvas.height = 24
    const context = canvas.getContext('2d')!
    const cells = [cell('f'), cell('i'), cell('e\u0301'), cell('!')]
    cells[1] = { ...cells[1]!, selected: target === 'selection' }
    const snapshot: GhosttySnapshot = {
      cols: 4,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: 1,
      cursorY: 0,
      cursorVisible: target === 'cursor',
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: 'fie\u0301!', isWrapContinuation: false, wrapsToNext: false }],
    }
    const options = {
      context,
      snapshot,
      metrics: { width: 10, height: 24, baseline: 19 },
      fontSize: 18,
      fontFamily: 'monospace',
      padding: 0,
      forceFull: true,
      cursorOn: true,
    }
    renderGhosttySnapshot({
      ...options,
      selectionBackground: '#000000',
      selectionForeground: { r: 255, g: 0, b: 0 },
      cursorText: { r: 255, g: 0, b: 0 },
    })
    const actual = context.getImageData(0, 0, 40, 24).data
    renderGhosttySnapshot({
      ...options,
      cursorOn: false,
      snapshot: {
        ...snapshot,
        rowData: [
          {
            ...snapshot.rowData[0]!,
            cells: cells.map((value) => ({ ...value, selected: false, foreground: { r: 255, g: 0, b: 0 } })),
          },
        ],
      },
    })
    const reference = context.getImageData(0, 0, 40, 24).data
    let painted = 0
    for (let y = 0; y < 24; y++)
      for (let x = 10; x < 20; x++) {
        const i = (y * 40 + x) * 4
        if (reference[i]! > 0) painted++
        expect(Array.from(actual.slice(i, i + 4))).toEqual(Array.from(reference.slice(i, i + 4)))
      }
    expect(painted).toBeGreaterThan(0)
  })
})

describe('cell-relative selection backgrounds', () => {
  it.each(['cell-foreground', 'cell-background'] as const)(
    'resolves %s separately for adjacent selected cells',
    (policy) => {
      const canvas = document.createElement('canvas')
      canvas.width = 20
      canvas.height = 10
      const context = canvas.getContext('2d')!
      const cells = [
        { ...cell(''), selected: true, foreground: { r: 12, g: 34, b: 56 }, background: { r: 7, g: 8, b: 9 } },
        { ...cell(''), selected: true, foreground: { r: 78, g: 90, b: 123 }, background: { r: 7, g: 8, b: 9 } },
      ]
      const snapshot: GhosttySnapshot = {
        cols: 2,
        rows: 1,
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
        cursorX: -1,
        cursorY: -1,
        cursorVisible: false,
        cursorBlinking: false,
        cursorStyle: 1,
        dirtyRows: new Set([0]),
        rowData: [{ cells, text: '', isWrapContinuation: false, wrapsToNext: false }],
      }
      renderGhosttySnapshot({
        context,
        snapshot,
        metrics: { width: 10, height: 10, baseline: 8 },
        fontSize: 8,
        fontFamily: 'monospace',
        padding: 0,
        forceFull: true,
        cursorOn: false,
        selectionBackground: policy,
      })
      expect(Array.from(context.getImageData(5, 5, 1, 1).data)).toEqual(
        policy === 'cell-foreground' ? [12, 34, 56, 255] : [7, 8, 9, 255],
      )
      expect(Array.from(context.getImageData(15, 5, 1, 1).data)).toEqual(
        policy === 'cell-foreground' ? [78, 90, 123, 255] : [7, 8, 9, 255],
      )
    },
  )
})
