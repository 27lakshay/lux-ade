import '@fontsource-variable/jetbrains-mono'
import { expect, it } from 'vitest'
import { GhosttyTerminalCore, type GhosttySnapshot } from './core'
import { contrastCorrection } from './contrast'
import { measureGhosttyCell, renderGhosttySnapshot } from './renderer'
const theme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
}

it('composites imported eight-bit selection alpha over the actual cell background', async () => {
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, theme)
  try {
    core.write('  ')
    core.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 })
    const options = await drawing(core.snapshot())
    renderGhosttySnapshot({ ...options, selectionBackground: { r: 17, g: 34, b: 51, a: 128 } })
    const pixel = options.context.getImageData(1, 1, 1, 1).data
    for (const [index, expected] of [9, 17, 26].entries())
      expect(Math.abs(pixel[index]! - expected)).toBeLessThanOrEqual(1)
    expect(pixel[3]).toBe(255)
  } finally {
    core.dispose()
  }
})

async function drawing(snapshot: GhosttySnapshot) {
  const fontFamily = '"JetBrains Mono Variable"'
  expect((await document.fonts.load(`20px ${fontFamily}`, '!=')).length).toBeGreaterThan(0)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const metrics = measureGhosttyCell(context, 20, fontFamily)
  canvas.width = Math.ceil(snapshot.cols * metrics.width)
  canvas.height = metrics.height
  return { context, snapshot, metrics, fontFamily, fontSize: 20, padding: 0, forceFull: true, cursorOn: false }
}

it.each(['selection', 'cursor'] as const)(
  'preserves an actual shipped-font ligature under %s recoloring',
  async (target) => {
    const core = await GhosttyTerminalCore.create(3, 1, 12, 27, theme)
    try {
      core.write('!=!\x1b[2G\x1b[2 q')
      if (target === 'selection') core.setSelection({ x: 1, y: 0 }, { x: 1, y: 0 })
      const snapshot = core.snapshot()
      const options = await drawing(snapshot)
      const { context, metrics } = options
      // Prove this is a shaped font run: independently painted characters differ.
      context.font = `normal 400 20px ${options.fontFamily}`
      context.fillStyle = '#ffffff'
      context.fillText('!=!', 0, metrics.baseline, metrics.width * 3)
      const shaped = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      context.clearRect(0, 0, context.canvas.width, context.canvas.height)
      for (const [index, character] of [...'!=!'].entries())
        context.fillText(character, index * metrics.width, metrics.baseline, metrics.width)
      const separate = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      expect(Array.from(shaped)).not.toEqual(Array.from(separate))
      const red = { r: 255, g: 0, b: 0 }
      renderGhosttySnapshot({
        ...options,
        cursorOn: target === 'cursor',
        selectionBackground: '#ffffff',
        selectionForeground: red,
        cursorText: red,
      })
      const actual = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      renderGhosttySnapshot({
        ...options,
        snapshot: {
          ...snapshot,
          background: theme.foreground,
          rowData: [
            {
              ...snapshot.rowData[0]!,
              cells: snapshot.rowData[0]!.cells.map((cell) => ({
                ...cell,
                selected: false,
                foreground: red,
                background: theme.foreground,
              })),
            },
          ],
        },
      })
      const expected = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      let glyphPixels = 0
      for (let y = 0; y < context.canvas.height; y++)
        for (let x = Math.ceil(metrics.width); x < Math.floor(2 * metrics.width); x++) {
          const offset = (y * context.canvas.width + x) * 4
          if (expected[offset + 1]! < 255) glyphPixels++
          expect(Array.from(actual.slice(offset, offset + 4))).toEqual(Array.from(expected.slice(offset, offset + 4)))
        }
      expect(glyphPixels).toBeGreaterThan(0)
    } finally {
      core.dispose()
    }
  },
)

it('resolves cell-relative selection and cursor colors after real Ghostty reverse video', async () => {
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, theme)
  try {
    core.write('\x1b[38;2;12;34;56;48;2;78;90;123;7mMM\x1b[1G\x1b[2 q')
    core.setSelection({ x: 1, y: 0 }, { x: 1, y: 0 })
    const snapshot = core.snapshot()
    expect(snapshot.rowData[0]!.cells[0]).toMatchObject({
      foreground: { r: 78, g: 90, b: 123 },
      background: { r: 12, g: 34, b: 56 },
    })
    const options = await drawing(snapshot)
    renderGhosttySnapshot({
      ...options,
      cursorOn: true,
      cursorText: 'cell-background',
      selectionForeground: 'cell-background',
      selectionBackground: 'cell-foreground',
    })
    const { context, metrics } = options
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
    for (const column of [0, 1]) {
      let glyphPixels = 0
      for (let y = 0; y < context.canvas.height; y++)
        for (let x = Math.ceil(column * metrics.width); x < Math.floor((column + 1) * metrics.width); x++) {
          const offset = (y * context.canvas.width + x) * 4
          if (pixels[offset] === 12 && pixels[offset + 1] === 34 && pixels[offset + 2] === 56) glyphPixels++
        }
      expect(glyphPixels).toBeGreaterThan(0)
    }
    const selectedBackground = context.getImageData(Math.ceil(metrics.width), 0, 1, 1).data
    expect(Array.from(selectedBackground)).toEqual([78, 90, 123, 255])
  } finally {
    core.dispose()
  }
})
it.each([
  ['cell-foreground', [78, 90, 123]],
  ['cell-background', [12, 34, 56]],
  [{ r: 201, g: 45, b: 67 }, [201, 45, 67]],
] as const)('fills a reverse-video cursor from %s', async (cursor, expected) => {
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, { ...theme, cursor })
  try {
    core.write('\x1b[38;2;12;34;56;48;2;78;90;123;7m界\x1b[1G\x1b[2 q')
    const snapshot = core.snapshot()
    expect(snapshot.rowData[0]!.cells[0]).toMatchObject({
      foreground: { r: 78, g: 90, b: 123 },
      background: { r: 12, g: 34, b: 56 },
    })
    const options = await drawing(snapshot)
    renderGhosttySnapshot({ ...options, cursorOn: true, cursorColor: cursor })
    const pixels = options.context.getImageData(0, 0, options.context.canvas.width, options.context.canvas.height).data
    for (const x of [1, Math.ceil(options.metrics.width) + 1]) {
      const offset = (options.context.canvas.width + x) * 4
      expect(Array.from(pixels.slice(offset, offset + 3))).toEqual(expected)
    }
  } finally {
    core.dispose()
  }
})

it('lets OSC 12 override a symbolic cursor fill and OSC 112 restore it', async () => {
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, { ...theme, cursor: 'cell-background' })
  try {
    core.write('\x1b[38;2;12;34;56;48;2;78;90;123mX\x1b[1G\x1b[2 q\x1b]12;#c92d43\x07')
    const overridden = core.snapshot()
    expect(overridden.cursorOverride).toEqual({ r: 201, g: 45, b: 67 })
    let options = await drawing(overridden)
    renderGhosttySnapshot({ ...options, cursorOn: true, cursorColor: 'cell-background' })
    let pixel = options.context.getImageData(1, 1, 1, 1).data
    expect(Array.from(pixel.slice(0, 3))).toEqual([201, 45, 67])

    core.write('\x1b]112\x07')
    const reset = core.snapshot()
    expect(reset.cursorOverride).toBeNull()
    options = await drawing(reset)
    renderGhosttySnapshot({ ...options, cursorOn: true, cursorColor: 'cell-background' })
    pixel = options.context.getImageData(1, 1, 1, 1).data
    expect(Array.from(pixel.slice(0, 3))).toEqual([78, 90, 123])
  } finally {
    core.dispose()
  }
})

it.each([0, 1, 2, 3] as const)('paints cursor style %i across its wide-cell geometry', async (style) => {
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, { ...theme, cursor: { r: 201, g: 45, b: 67 } })
  try {
    core.write('界\x1b[1G\x1b[' + style + ' q')
    const snapshot = { ...core.snapshot(), cursorStyle: style }
    const options = await drawing(snapshot)
    renderGhosttySnapshot({ ...options, cursorOn: true, cursorColor: { r: 201, g: 45, b: 67 } })
    const { context, metrics } = options
    const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3))
    if (style === 0) {
      expect(pixel(1, 1)).toEqual([201, 45, 67])
      expect(pixel(Math.ceil(metrics.width) + 1, 1)).not.toEqual([201, 45, 67])
    } else if (style === 1) {
      expect(pixel(1, 1)).toEqual([201, 45, 67])
      expect(pixel(Math.ceil(metrics.width) + 1, 1)).toEqual([201, 45, 67])
    } else if (style === 2) {
      expect(pixel(Math.ceil(metrics.width) + 1, metrics.height - 1)).toEqual([201, 45, 67])
    } else {
      expect(pixel(Math.ceil(metrics.width) + 1, 0)).toEqual([201, 45, 67])
    }
  } finally {
    core.dispose()
  }
})
it('contrasts cursor text against the resolved cursor fill', async () => {
  const core = await GhosttyTerminalCore.create(1, 1, 12, 27, { ...theme, cursor: 'cell-background' })
  try {
    core.write('M\x1b[1G\x1b[2 q')
    const options = await drawing(core.snapshot())
    const cursorText = { r: 120, g: 120, b: 120 }
    const expected = contrastCorrection(4.5)(cursorText, { r: 0, g: 0, b: 0 })
    renderGhosttySnapshot({
      ...options,
      cursorOn: true,
      cursorColor: 'cell-background',
      cursorText,
      minimumContrast: 4.5,
    })
    const pixels = options.context.getImageData(0, 0, options.context.canvas.width, options.context.canvas.height).data
    let matchingPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] === expected.r && pixels[index + 1] === expected.g && pixels[index + 2] === expected.b) {
        matchingPixels++
      }
    }
    expect(matchingPixels).toBeGreaterThan(0)
  } finally {
    core.dispose()
  }
})

it.each(['cursor', 'selection'] as const)(
  'paints a real wide Ghostty glyph across both %s cells without squeezing it',
  async (target) => {
    const core = await GhosttyTerminalCore.create(3, 1, 12, 27, theme)
    try {
      core.write('界é\x1b[1G\x1b[2 q')
      if (target === 'selection') core.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 })
      const snapshot = core.snapshot()
      const options = await drawing(snapshot)
      const { context, metrics } = options
      renderGhosttySnapshot({
        ...options,
        cursorOn: target === 'cursor',
        selectionForeground: theme.background,
        selectionBackground: theme.foreground,
      })
      const actual = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      renderGhosttySnapshot({
        ...options,
        snapshot: {
          ...snapshot,
          background: theme.foreground,
          rowData: [
            {
              ...snapshot.rowData[0]!,
              cells: snapshot.rowData[0]!.cells.map((cell) => ({
                ...cell,
                selected: false,
                foreground: theme.background,
                background: theme.foreground,
              })),
            },
          ],
        },
      })
      const expected = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      let glyphPixels = 0
      for (let y = 0; y < context.canvas.height; y++)
        for (let x = 0; x < Math.floor(2 * metrics.width); x++) {
          const offset = (y * context.canvas.width + x) * 4
          if (expected[offset]! < 255) glyphPixels++
          expect(Array.from(actual.slice(offset, offset + 4))).toEqual(Array.from(expected.slice(offset, offset + 4)))
        }
      expect(glyphPixels).toBeGreaterThan(0)
    } finally {
      core.dispose()
    }
  },
)

it.each([
  [0, 0, 21, 255],
  [20, 0, 4.5, 117],
  [250, 255, 4.5, 118],
])(
  'contrast correction changes %i on %i at ratio %f to %i without changing source cells',
  async (foreground, background, minimum, expected) => {
    const core = await GhosttyTerminalCore.create(2, 1, 12, 27, theme)
    try {
      core.write(
        `\x1b[38;2;${foreground};${foreground};${foreground};48;2;${background};${background};${background}mMM`,
      )
      const snapshot = core.snapshot()
      const source = structuredClone(snapshot.rowData)
      const options = await drawing(snapshot)
      const correctedPixels = () => {
        const { context } = options
        const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
        let count = 0
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] === expected && pixels[i + 1] === expected && pixels[i + 2] === expected) count++
        return count
      }
      renderGhosttySnapshot(options)
      expect(correctedPixels()).toBe(0)
      renderGhosttySnapshot({ ...options, minimumContrast: minimum })
      expect(correctedPixels()).toBeGreaterThan(0)
      expect(snapshot.rowData).toEqual(source)
      expect(core.snapshot().rowData).toEqual(source)
      renderGhosttySnapshot({ ...options, minimumContrast: 1 })
      expect(correctedPixels()).toBe(0)
    } finally {
      core.dispose()
    }
  },
)

it('bright bold colors distinguish indexed text from identical truecolor and honor live OSC overrides', async () => {
  const palette = Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 }))
  palette[1] = { r: 100, g: 0, b: 0 }
  palette[9] = { r: 0, g: 200, b: 0 }
  const core = await GhosttyTerminalCore.create(2, 1, 12, 27, { ...theme, palette })
  try {
    core.write('\x1b[1;31mM\x1b[38;2;100;0;0mM')
    const options = await drawing(core.snapshot())
    const count = (column: number, color: number[]) => {
      const { context, metrics } = options
      const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      let found = 0
      for (let y = 0; y < context.canvas.height; y++)
        for (let x = Math.ceil(column * metrics.width); x < Math.floor((column + 1) * metrics.width); x++) {
          const i = (y * context.canvas.width + x) * 4
          if (pixels[i] === color[0] && pixels[i + 1] === color[1] && pixels[i + 2] === color[2]) found++
        }
      return found
    }
    renderGhosttySnapshot({ ...options, boldColor: 'bright' })
    expect(count(0, [0, 200, 0])).toBeGreaterThan(0)
    expect(count(1, [100, 0, 0])).toBeGreaterThan(0)
    expect(core.snapshot().rowData[0]!.cells[0]!.foreground).toEqual({ r: 100, g: 0, b: 0 })
    core.write('\x1b]4;9;#123456\x07')
    renderGhosttySnapshot({ ...options, snapshot: core.snapshot(), boldColor: 'bright' })
    expect(count(0, [18, 52, 86])).toBeGreaterThan(0)
    renderGhosttySnapshot({ ...options, boldColor: { r: 77, g: 88, b: 99 } })
    expect(count(0, [77, 88, 99])).toBeGreaterThan(0)
    expect(count(1, [77, 88, 99])).toBeGreaterThan(0)
  } finally {
    core.dispose()
  }
})

it('applies bold color before inverse and faint, then applies selection colors', async () => {
  const core = await GhosttyTerminalCore.create(1, 1, 12, 27, theme)
  try {
    core.write('\x1b[1;2;7;38;2;100;0;0mM')
    const options = await drawing(core.snapshot())
    const count = (color: number[]) => {
      const { context } = options
      const bytes = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
      let found = 0
      for (let i = 0; i < bytes.length; i += 4)
        if (bytes[i] === color[0] && bytes[i + 1] === color[1] && bytes[i + 2] === color[2]) found++
      return found
    }
    const boldColor = { r: 0, g: 0, b: 200 }
    renderGhosttySnapshot({ ...options, boldColor })
    expect(count([0, 0, 200])).toBeGreaterThan(0)
    expect(count([0, 0, 78])).toBeGreaterThan(0)
    core.setSelection({ x: 0, y: 0 }, { x: 0, y: 0 })
    renderGhosttySnapshot({
      ...options,
      snapshot: core.snapshot(),
      boldColor,
      selectionForeground: { r: 255, g: 255, b: 0 },
      selectionBackground: { r: 0, g: 17, b: 0 },
    })
    expect(count([255, 255, 0])).toBeGreaterThan(0)
    expect(count([0, 17, 0])).toBeGreaterThan(0)
    expect(core.snapshot().rowData[0]!.cells[0]).toMatchObject({
      background: { r: 100, g: 0, b: 0 },
      foreground: { r: 39, g: 0, b: 0 },
    })
  } finally {
    core.dispose()
  }
})

it.each(['selection', 'cursor'] as const)(
  'corrects %s text against its painted background and preserves fidelity',
  async (target) => {
    const core = await GhosttyTerminalCore.create(2, 1, 12, 27, theme)
    try {
      core.write('\x1b[38;2;128;128;128mMM\x1b[1G\x1b[2 q')
      if (target === 'selection') core.setSelection({ x: 0, y: 0 }, { x: 1, y: 0 })
      const snapshot = core.snapshot()
      const source = structuredClone(snapshot.rowData)
      const options = {
        ...(await drawing(snapshot)),
        cursorOn: target === 'cursor',
        cursorText: { r: 255, g: 255, b: 255 },
        selectionForeground: { r: 128, g: 128, b: 128 },
        selectionBackground: 'rgba(255, 255, 255, 0.5)',
      }
      const image = () =>
        options.context.getImageData(0, 0, options.context.canvas.width, options.context.canvas.height).data
      renderGhosttySnapshot(options)
      const fidelity = Array.from(image())
      renderGhosttySnapshot({ ...options, minimumContrast: target === 'cursor' ? 21 : 4.5 })
      const corrected = image()
      // 50% white over black paints 128 gray. At 4.5:1 the rounded foreground
      // must reach 23 gray. White cursor fill at 21:1 requires black text.
      const expected = target === 'cursor' ? 0 : 23
      let changedGlyphPixels = 0
      for (let i = 0; i < corrected.length; i += 4)
        if (
          corrected[i] === expected &&
          corrected[i + 1] === expected &&
          corrected[i + 2] === expected &&
          fidelity[i] !== expected
        )
          changedGlyphPixels++
      expect(changedGlyphPixels).toBeGreaterThan(0)
      expect(snapshot.rowData).toEqual(source)
      expect(core.snapshot().rowData).toEqual(source)
      renderGhosttySnapshot({ ...options, minimumContrast: 1 })
      expect(Array.from(image())).toEqual(fidelity)
    } finally {
      core.dispose()
    }
  },
)
