import { GhosttyTerminalCore, type GhosttyTheme } from './ghostty/core'
import { measureGhosttyCell, renderGhosttySnapshot } from './ghostty/renderer'

// Fixed local bytes. This module has no bridge, input handler or terminal attachment.
const sample =
  [
    Array.from({ length: 8 }, (_, i) => `\x1b[48;5;${i}m    `).join(''),
    Array.from({ length: 8 }, (_, i) => `\x1b[48;5;${i + 8}m    `).join(''),
    '\x1b[48;2;12;90;160m Truecolor stays fixed ',
    '\x1b[0m\x1b[1mBold\x1b[0m  \x1b[3mItalic\x1b[0m  \x1b[4mUnderline\x1b[0m',
    'Cursor',
    'Selection',
  ].join('\x1b[0m\r\n') + '\x1b[0m\x1b[5;8H\x1b[2 q'

/** An isolated sample using the production Ghostty parser and painter. */
export async function createTerminalPreview(theme: GhosttyTheme) {
  const canvas = document.createElement('canvas')
  canvas.className = 'max-w-full'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Terminal sample: ANSI colors, truecolor, styles, cursor and selection')
  const context = canvas.getContext('2d')!
  const fontFamily = 'monospace'
  const metrics = measureGhosttyCell(context, 12, fontFamily)
  canvas.width = Math.ceil(metrics.width * 32)
  canvas.height = metrics.height * 6
  const core = await GhosttyTerminalCore.create(32, 6, metrics.width, metrics.height, theme)
  let disposed = false
  const paint = (colors: GhosttyTheme) =>
    renderGhosttySnapshot({
      context,
      snapshot: core.snapshot(),
      metrics,
      fontSize: 12,
      fontFamily,
      padding: 0,
      forceFull: true,
      cursorOn: true,
      focused: true,
      selectionBackground: colors.selectionBackground,
      selectionForeground: colors.selectionForeground,
      cursorColor: colors.cursor,
      cursorText: colors.cursorText,
      minimumContrast: colors.minimumContrast,
      boldColor: colors.boldColor,
    })
  try {
    core.write(sample)
    core.setSelection({ x: 0, y: 5 }, { x: 8, y: 5 })
    paint(theme)
  } catch (error) {
    core.dispose()
    throw error
  }
  return {
    canvas,
    setTheme(colors: GhosttyTheme): void {
      if (!disposed) {
        core.setTheme(colors)
        paint(colors)
      }
    },
    dispose(): void {
      if (!disposed) {
        disposed = true
        core.dispose()
        canvas.remove()
      }
    },
  }
}
