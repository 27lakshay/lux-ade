import type { TerminalAppearance } from '@ade/contracts'
import type { GhosttyTheme } from '@ade/terminal'

/** The daemon resolves sections and preferences. This adapts only property names for the local view. */
export function previewTerminalTheme(appearance: TerminalAppearance): GhosttyTheme {
  return {
    foreground: appearance.foreground,
    background: appearance.background,
    cursor: appearance.cursor,
    palette: appearance.palette,
    cursorText: appearance.cursor_text,
    selectionForeground: appearance.selection_foreground,
    selectionBackground: appearance.selection_background,
    minimumContrast: appearance.minimum_contrast,
    boldColor: appearance.bold_color,
  }
}
