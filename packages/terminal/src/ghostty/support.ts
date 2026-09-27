// Portions adapted from t3code (MIT): apps/web/src/lib/utils.ts, apps/web/src/lib/selectionActions.ts,
// apps/web/src/appearanceFonts.ts and packages/client-runtime/src/markdownLinks.ts.
//
// The small helpers the terminal surface and its link detection need from outside the terminal.

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** Clicks closer together than this count as a double or triple click. */
export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500

export interface FilePathPosition {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/
const POSITION_HASH_PATTERN = /^#L(\d+)(?:C(\d+))?$/i

export function splitFilePathPosition(path: string, hash = ''): FilePathPosition {
  const suffixMatch = path.match(POSITION_SUFFIX_CAPTURE_PATTERN)
  const match = suffixMatch ?? hash.match(POSITION_HASH_PATTERN)
  if (!match?.[1]) return { path }
  const line = Number.parseInt(match[1], 10)
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10)
  return {
    path: suffixMatch ? path.slice(0, -suffixMatch[0].length) : path,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  }
}

export function formatFilePathPosition(position: FilePathPosition): string {
  if (!position.line) return position.path
  return `${position.path}:${position.line}${position.column ? `:${position.column}` : ''}`
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim()
  if (bare.length === 0) return ''
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare
  return `"${bare.replaceAll('"', '')}"`
}

/** A safe CSS font-family list from a name or comma-separated list, or null when empty. */
function cssFontFamilies(input: string): string | null {
  const families = input
    .split(',')
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0)
  return families.length > 0 ? families.join(', ') : null
}

let fontProbeContext: CanvasRenderingContext2D | null | undefined
const MONOSPACE_PROBE_VARIANTS = ['normal 400', 'normal 700', 'italic 400', 'italic 700'] as const
const MONOSPACE_PROBE_GLYPHS = ['i', 'M', 'W', '0', '@', '#', '.', ' '] as const
const MONOSPACE_ADVANCE_TOLERANCE = 0.01

function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0]
  if (
    reference === undefined ||
    !Number.isFinite(reference) ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE)
}

/**
 * Whether a family renders every character on the same advance, as a cell-grid terminal needs.
 * Unmeasurable environments answer true, so a missing canvas never blocks a legitimate font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family)
  if (families === null) return true
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement('canvas').getContext('2d')
    }
    if (fontProbeContext === null) return true
    const context = fontProbeContext
    // Fall back to a generic mono so an absent face measures as monospace and is left for the
    // normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width)
      if (!areFontAdvancesMonospace(advances)) return false
    }
    return true
  } catch {
    return true
  }
}
