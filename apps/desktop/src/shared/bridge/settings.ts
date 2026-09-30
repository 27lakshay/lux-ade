import type { PaletteCatalog, ProfileSettings, ResolvedAppearance } from '@ade/contracts'

/** `window.adeHost.settings`: the profile's settings, which the daemon keeps. */
export interface SettingsBridge {
  get(): Promise<ProfileSettings>
  appearance(): Promise<ResolvedAppearance>
  palettes(): Promise<PaletteCatalog>
  startupStatus(): Promise<{ warnings: string[] }>
  resetAppearance(expectedRevision: number): Promise<ProfileSettings>
  /** Changes the given settings and returns them all. */
  set(
    changes: Partial<
      Pick<
        ProfileSettings,
        | 'appearance'
        | 'app_light_theme'
        | 'app_dark_theme'
        | 'terminal_binding'
        | 'syntax_binding'
        | 'terminal_color_overrides'
        | 'terminal_minimum_contrast'
        | 'terminal_bold_color'
        | 'reduced_motion'
        | 'high_contrast'
        | 'reduced_transparency'
        | 'differentiate_without_color'
        | 'ui_font_family'
        | 'ui_font_size'
        | 'code_font_family'
        | 'code_font_size'
        | 'terminal_font_family'
        | 'terminal_font_size'
        | 'density'
        | 'terminal_line_height'
        | 'terminal_font_kerning'
        | 'terminal_cursor_shape'
        | 'terminal_cursor_blink'
      >
    > & {
      expected_appearance_revision?: number
      expected_theme_revisions?: Record<string, number>
    },
  ): Promise<ProfileSettings>
}
