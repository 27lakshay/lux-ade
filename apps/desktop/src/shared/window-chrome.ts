// The window's title-bar geometry and background, shared by main (which places the native traffic
// lights and paints the window before the page loads) and the renderer (which lays out the title
// row and sets the page background). Change them here, never in one place alone.

/** Height of the title-bar row every screen reserves at the top of the window. */
export const TITLEBAR_HEIGHT = 40

/** Native macOS traffic lights (14pt buttons), centred vertically in the title-bar row. */
export const TRAFFIC_LIGHTS = { x: 16, y: TITLEBAR_HEIGHT / 2 - 7 }

/**
 * The window's background before the page paints, per appearance. They equal the shadcn theme's
 * `--background` (src/renderer/src/shadcn.css; a renderer test keeps them in step), so the window
 * never flashes another colour while loading.
 */
export const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#0c0a09' } as const

export type ThemePreference = 'light' | 'dark' | 'system'

export const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system'
