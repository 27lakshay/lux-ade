// Portions adapted from t3code apps/web/src/terminal/ghostty/renderer.ts (MIT).
import { blend, converter } from 'culori'
import { contrastCorrection, contrastRgb } from './contrast'
import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  ghosttyFaintColor,
  type GhosttyBoldColor,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttyColorPolicy,
  type GhosttySnapshot,
} from './core'

export interface GhosttyCellMetrics {
  readonly width: number
  readonly height: number
  readonly baseline: number
}

export interface GhosttyCellRange {
  readonly start: { readonly x: number; readonly y: number }
  readonly end: { readonly x: number; readonly y: number }
}

const DEFAULT_SELECTION_BACKGROUND = 'rgba(72, 122, 191, 0.35)'

function cssColor(color: GhosttyColor): string {
  return color.a === undefined
    ? `rgb(${color.r}, ${color.g}, ${color.b})`
    : `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`
}

function cellColor(policy: GhosttyColorPolicy, cell: GhosttyCell): GhosttyColor {
  if (policy === 'cell-foreground') return cell.foreground
  if (policy === 'cell-background') return cell.background
  return policy
}

function selectionColor(policy: string | GhosttyColor, cell: GhosttyCell): string {
  if (typeof policy === 'string' && policy !== 'cell-foreground' && policy !== 'cell-background') return policy
  return cssColor(cellColor(policy, cell))
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  // Shape across selection boundaries; recolor that same run through clips.
  // Splitting the run would change ligatures and glyph spacing.
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  )
}

export function ghosttyTextRunEnd(
  cells: readonly GhosttyCell[],
  start: number,
  sameStyle: (cell: GhosttyCell) => boolean,
): number {
  let end = start + 1
  while (end < cells.length) {
    const next = cells[end]
    if (!next) break
    if (next.wide === GHOSTTY_CELL_WIDE.spacerTail) {
      end += 1
      continue
    }
    if (next.text.length === 0 || !sameStyle(next)) break
    end += 1
  }
  return end
}

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const style = cell.italic ? 'italic' : 'normal'
  const weight = cell.bold ? '700' : '400'
  return `${style} ${weight} ${fontSize}px ${fontFamily}`
}

export function measureGhosttyCell(
  context: CanvasRenderingContext2D,
  fontSize: number,
  fontFamily: string,
  lineHeight = 1.35,
  kerning: 'auto' | 'normal' | 'none' = 'auto',
): GhosttyCellMetrics {
  context.fontKerning = kerning
  context.font = `normal 400 ${fontSize}px ${fontFamily}`
  const widthMeasurement = context.measureText('M')
  const verticalMeasurement = context.measureText('Mg')
  const ascent = verticalMeasurement.actualBoundingBoxAscent || fontSize
  const descent = verticalMeasurement.actualBoundingBoxDescent
  const glyphHeight = ascent + descent
  const height = Math.max(1, Math.round(fontSize * lineHeight), Math.ceil(glyphHeight))
  return {
    width: Math.max(1, widthMeasurement.width),
    height,
    baseline: Math.round((height - glyphHeight) / 2 + ascent),
  }
}

export function terminalGridSize(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((width - padding * 2) / metrics.width)),
    rows: Math.max(1, Math.floor((height - padding * 2) / metrics.height)),
  }
}

export function renderGhosttySnapshot(options: {
  readonly context: CanvasRenderingContext2D
  readonly snapshot: GhosttySnapshot
  readonly metrics: GhosttyCellMetrics
  readonly fontSize: number
  readonly fontFamily: string
  readonly padding: number
  readonly forceFull: boolean
  readonly cursorOn: boolean
  readonly previousCursorY?: number | null
  readonly focused?: boolean
  readonly selectionBackground?: string | GhosttyColor
  readonly selectionForeground?: GhosttyColorPolicy
  readonly cursorText?: GhosttyColorPolicy
  readonly cursorColor?: GhosttyColorPolicy
  readonly minimumContrast?: number
  readonly boldColor?: GhosttyBoldColor
  readonly hoveredLinkRange?: GhosttyCellRange | null
  readonly kerning?: 'auto' | 'normal' | 'none'
  /** Vertical origin of row 0; defaults to the horizontal padding. */
  readonly originY?: number
}): void {
  const { context, snapshot, metrics, fontSize, fontFamily, padding, forceFull, cursorOn, previousCursorY } = options
  context.fontKerning = options.kerning ?? 'auto'
  const boldColor = options.boldColor ?? 'inherit'
  const rowData =
    boldColor === 'inherit'
      ? snapshot.rowData
      : snapshot.rowData.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => {
            if (!cell.bold) return cell
            const source = cell.boldColor
            const chosen = boldColor === 'bright' ? source?.brightForeground : boldColor
            if (!chosen) return cell
            let foreground = chosen
            let background = source?.background ?? cell.background
            if (source?.inverse) [foreground, background] = [background, foreground]
            if (source?.faint) foreground = ghosttyFaintColor(foreground, background)
            return { ...cell, foreground, background }
          }),
        }))
  const focused = options.focused ?? true
  const correctContrast = contrastCorrection(options.minimumContrast ?? 1)
  const rgb = converter('rgb')
  const paintedBackground = (cell: GhosttyCell): GhosttyColor => {
    if (!cell.selected || (options.minimumContrast ?? 1) <= 1) return cell.background
    const overlay = rgb(selectionColor(selectionBackground, cell))
    if (!overlay) return cell.background
    const composed = rgb(blend([contrastRgb(cell.background), overlay]))!
    return { r: Math.round(composed.r * 255), g: Math.round(composed.g * 255), b: Math.round(composed.b * 255) }
  }
  const paintedForeground = (cell: GhosttyCell): GhosttyColor =>
    correctContrast(
      cell.selected && options.selectionForeground !== undefined
        ? cellColor(options.selectionForeground, cell)
        : cell.foreground,
      paintedBackground(cell),
    )
  const selectionBackground = options.selectionBackground ?? DEFAULT_SELECTION_BACKGROUND
  const hoveredLinkRange = options.hoveredLinkRange ?? null
  const originY = options.originY ?? padding
  const rowsToDraw = forceFull ? Array.from({ length: snapshot.rows }, (_, index) => index) : [...snapshot.dirtyRows]
  if (
    previousCursorY !== null &&
    previousCursorY !== undefined &&
    previousCursorY >= 0 &&
    !rowsToDraw.includes(previousCursorY)
  ) {
    rowsToDraw.push(previousCursorY)
  }
  if (snapshot.cursorVisible && snapshot.cursorY >= 0 && !rowsToDraw.includes(snapshot.cursorY)) {
    rowsToDraw.push(snapshot.cursorY)
  }

  if (forceFull) {
    context.save()
    context.resetTransform()
    context.fillStyle = cssColor(snapshot.background)
    context.fillRect(0, 0, context.canvas.width, context.canvas.height)
    context.restore()
  }

  context.textBaseline = 'alphabetic'
  for (const rowIndex of rowsToDraw) {
    const row = rowData[rowIndex]
    if (!row) continue
    const top = originY + rowIndex * metrics.height

    context.fillStyle = cssColor(snapshot.background)
    context.fillRect(padding, top, snapshot.cols * metrics.width, metrics.height)

    let backgroundStart = 0
    while (backgroundStart < row.cells.length) {
      const first = row.cells[backgroundStart]
      if (!first) break
      let backgroundEnd = backgroundStart + 1
      while (backgroundEnd < row.cells.length) {
        const next = row.cells[backgroundEnd]
        if (
          !next ||
          next.selected !== first.selected ||
          !ghosttyColorsEqual(next.background, first.background) ||
          (first.selected && selectionColor(selectionBackground, next) !== selectionColor(selectionBackground, first))
        ) {
          break
        }
        backgroundEnd += 1
      }
      if (first.selected || !ghosttyColorsEqual(first.background, snapshot.background)) {
        const left = padding + backgroundStart * metrics.width
        const width = (backgroundEnd - backgroundStart) * metrics.width
        if (!ghosttyColorsEqual(first.background, snapshot.background)) {
          context.fillStyle = cssColor(first.background)
          context.fillRect(left, top, width, metrics.height)
        }
        if (first.selected) {
          context.fillStyle = selectionColor(selectionBackground, first)
          context.fillRect(left, top, width, metrics.height)
        }
      }
      backgroundStart = backgroundEnd
    }

    let runStart = 0
    while (runStart < row.cells.length) {
      const first = row.cells[runStart]
      if (!first) break
      if (first.text.length === 0) {
        runStart += 1
        continue
      }
      const runEnd = ghosttyTextRunEnd(row.cells, runStart, (cell) => sameTextStyle(cell, first))
      const text = row.cells
        .slice(runStart, runEnd)
        .map((cell) => cell.text)
        .join('')
      if (!first.invisible && text.trim().length > 0) {
        let colorStart = runStart
        while (colorStart < runEnd) {
          const current = row.cells[colorStart]!
          const foreground = paintedForeground
          const color = foreground(current)
          let colorEnd = colorStart + 1
          while (colorEnd < runEnd && ghosttyColorsEqual(foreground(row.cells[colorEnd]!), color)) colorEnd++
          context.save()
          context.beginPath()
          context.rect(
            padding + colorStart * metrics.width,
            top,
            (colorEnd - colorStart) * metrics.width,
            metrics.height,
          )
          context.clip()
          context.font = fontForCell(first, fontSize, fontFamily)
          context.fillStyle = cssColor(color)
          context.fillText(
            text,
            padding + runStart * metrics.width,
            top + metrics.baseline,
            (runEnd - runStart) * metrics.width,
          )
          context.restore()
          colorStart = colorEnd
        }
      }
      runStart = runEnd
    }

    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column]
      const hoveredLink =
        hoveredLinkRange !== null &&
        rowIndex >= hoveredLinkRange.start.y &&
        rowIndex <= hoveredLinkRange.end.y &&
        (rowIndex > hoveredLinkRange.start.y || column >= hoveredLinkRange.start.x) &&
        (rowIndex < hoveredLinkRange.end.y || column <= hoveredLinkRange.end.x)
      if (!cell || (!cell.underline && !cell.strikethrough && !cell.overline && !hoveredLink)) {
        continue
      }
      context.fillStyle = cssColor(paintedForeground(cell))
      const left = padding + column * metrics.width
      if (cell.underline || hoveredLink) {
        context.fillRect(left, top + metrics.height - 2, metrics.width, 1)
      }
      if (cell.strikethrough) {
        context.fillRect(left, top + Math.floor(metrics.height * 0.55), metrics.width, 1)
      }
      if (cell.overline) context.fillRect(left, top + 1, metrics.width, 1)
    }
  }

  if (cursorOn && snapshot.cursorVisible && snapshot.cursorX >= 0 && snapshot.cursorY >= 0) {
    const cells = rowData[snapshot.cursorY]?.cells ?? []
    const cursorColumn =
      cells[snapshot.cursorX]?.wide === GHOSTTY_CELL_WIDE.spacerTail
        ? Math.max(0, snapshot.cursorX - 1)
        : snapshot.cursorX
    const cursorCell = cells[cursorColumn]
    const cursorWidth =
      Math.min(cursorCell?.wide === GHOSTTY_CELL_WIDE.wide ? 2 : 1, snapshot.cols - cursorColumn) * metrics.width
    const left = padding + cursorColumn * metrics.width
    const top = originY + snapshot.cursorY * metrics.height
    const cursorFill =
      snapshot.cursorOverride ??
      (options.cursorColor !== undefined && cursorCell ? cellColor(options.cursorColor, cursorCell) : snapshot.cursor)
    context.fillStyle = cssColor(cursorFill)
    if (!focused) {
      // An unfocused terminal draws a hollow cursor so the active pane is obvious.
      context.strokeStyle = cssColor(cursorFill)
      context.strokeRect(left + 0.5, top + 0.5, cursorWidth - 1, metrics.height - 1)
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, 2, metrics.height)
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + metrics.height - 2, cursorWidth, 2)
    } else if (snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(cursorFill)
      context.strokeRect(left + 0.5, top + 0.5, cursorWidth - 1, metrics.height - 1)
    } else {
      context.fillRect(left, top, cursorWidth, metrics.height)
      // Repaint the original run under a clip. Shaping an isolated cursor
      // character changes ligatures, spacing and wide/combining glyph geometry.
      let start = 0
      while (start < cells.length) {
        const first = cells[start]
        if (!first) break
        if (first.text.length === 0) {
          start += 1
          continue
        }
        const end = ghosttyTextRunEnd(cells, start, (cell) => sameTextStyle(cell, first))
        if (cursorColumn >= start && cursorColumn < end) {
          if (!first.invisible) {
            context.save()
            context.beginPath()
            context.rect(left, top, cursorWidth, metrics.height)
            context.clip()
            context.font = fontForCell(first, fontSize, fontFamily)
            context.fillStyle = cssColor(
              correctContrast(
                options.cursorText !== undefined && cursorCell
                  ? cellColor(options.cursorText, cursorCell)
                  : snapshot.background,
                cursorFill,
              ),
            )
            context.fillText(
              cells
                .slice(start, end)
                .map((cell) => cell.text)
                .join(''),
              padding + start * metrics.width,
              top + metrics.baseline,
              (end - start) * metrics.width,
            )
            context.restore()
          }
          break
        }
        start = end
      }
    }
  }
}
