import type { ThemeDefinition } from '@ade/contracts'
import type { ContrastReportRow } from './themeContrastInspector'
import { row, sourceTokens, type Color, type PaletteSection } from './themeContrastRows'

export const TEXT_THRESHOLD = 4.5
export const NON_TEXT_THRESHOLD = 3

export type ContrastRowAdder = (
  id: string,
  surface: string,
  state: string,
  section: PaletteSection,
  role: string,
  foreground: Color,
  background: Color,
  threshold: number,
  alphaState?: string,
  roleColor?: Color,
) => void

export function createContrastRowAdder(rows: ContrastReportRow[], definition: ThemeDefinition): ContrastRowAdder {
  return (
    id,
    surface,
    state,
    section,
    role,
    foreground,
    background,
    threshold,
    alphaState = 'opaque',
    roleColor = foreground,
  ) => {
    rows.push(
      row({
        id,
        surface,
        state,
        role,
        section,
        sourceValue: sourceTokens(section, definition)[role],
        resolvedValue: roleColor,
        foreground,
        background,
        threshold,
        alphaState,
      }),
    )
  }
}
