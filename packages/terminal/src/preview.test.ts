import { expect, it } from 'vitest'
import { createTerminalPreview } from './preview'

it('recolors an isolated Ghostty sample while preserving its canvas and truecolor swatch', async () => {
  const theme = {
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    cursor: 'cell-background' as const,
    palette: Array.from({ length: 256 }, () => ({ r: 100, g: 0, b: 0 })),
  }
  const preview = await createTerminalPreview(theme)
  try {
    const canvas = preview.canvas
    const pixel = (x: number, y: number) => Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data)
    expect(pixel(1, 1)).toEqual([100, 0, 0, 255])
    const cellWidth = canvas.width / 32
    const cellHeight = canvas.height / 6
    expect(pixel(Math.floor(cellWidth * 7) + 1, Math.floor(cellHeight * 4) + 1)).toEqual([0, 0, 0, 255])
    const truecolor = pixel(1, Math.floor((canvas.height / 6) * 2) + 1)
    expect(truecolor).toEqual([12, 90, 160, 255])
    preview.setTheme({ ...theme, palette: theme.palette.map(() => ({ r: 0, g: 100, b: 0 })) })
    expect(preview.canvas).toBe(canvas)
    expect(pixel(1, 1)).toEqual([0, 100, 0, 255])
    expect(pixel(1, Math.floor((canvas.height / 6) * 2) + 1)).toEqual(truecolor)
  } finally {
    preview.dispose()
  }
})
