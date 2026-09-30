import { call } from '@ade/client'
import { CliError, type CommandResult } from '../shared.js'

export const settingsUsage = `  settings palettes                     List built-in palette variants and their tokens
  settings appearance                   Read resolved colors and runtime propagation
  settings get                          Read the profile's settings
  settings set KEY VALUE [KEY VALUE ...]
                                        Change settings: appearance light|dark|system,
                                        app_light_theme ID, app_dark_theme ID,
                                        syntax_binding JSON (follow_app, paired or fixed),
                                        terminal_binding JSON (follow_app, paired or fixed),
                                        terminal_color_overrides JSON (cursor_text, selection_foreground/background),
                                        terminal_minimum_contrast NUMBER (1–21; 1 is fidelity),
                                        terminal_bold_color inherit|bright|RGB_JSON, reduced_motion system|on|off,
                                        high_contrast system|on|off, reduced_transparency system|on|off,
                                        differentiate_without_color system|on|off,
                                        ui_font_family NAME, ui_font_size INTEGER (12–24),
                                        code_font_family NAME, code_font_size INTEGER (10–32),
                                        terminal_font_family NAME, terminal_font_size INTEGER (6–32),
                                        density default|compact, terminal_line_height NUMBER (1–2),
                                        terminal_font_kerning auto|normal|none,
                                        terminal_cursor_shape block|bar|underline,
                                        terminal_cursor_blink true|false,
                                        expected_appearance_revision NUMBER,
                                        expected_theme_revisions JSON (theme ID to captured revision),
                                        keybindings.COMMAND ACCELERATOR|none
  settings reset-appearance REVISION      Restore appearance defaults at this revision
  settings reset-keybindings [COMMAND ...]
                                        Return the named commands, or every command,
                                        to their default keys
`

const KEYBINDING = 'keybindings.'

export async function runSettingsCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'settings') return undefined
  if (action === 'reset-appearance') {
    if (rest.length !== 1)
      throw new CliError('usage', 'settings reset-appearance requires the current appearance revision.')
    const revision = Number(rest[0])
    if (!/^\d+$/.test(rest[0]!) || !Number.isSafeInteger(revision)) {
      throw new CliError('usage', 'Appearance revision must be a non-negative safe integer.')
    }
    return call(socketPath, 'settings.appearance.reset', { expected_appearance_revision: revision })
  }
  if (action === 'palettes') {
    if (rest.length) throw new CliError('usage', 'settings palettes does not accept arguments.')
    return call(socketPath, 'settings.palettes', {})
  }
  if (action === 'appearance') {
    if (rest.length) throw new CliError('usage', 'settings appearance does not accept arguments.')
    return call(socketPath, 'settings.appearance', {})
  }
  if (action === 'get') {
    if (rest.length) throw new CliError('usage', 'settings get does not accept arguments.')
    return call(socketPath, 'settings.get', {})
  }
  if (action === 'set') {
    if (!rest.length || rest.length % 2) throw new CliError('usage', 'settings set requires KEY VALUE pairs.')
    const change: Record<string, unknown> = {}
    const keybindings: Record<string, string | null> = {}
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!
      const value = rest[index + 1]!
      // `none` unbinds the command; it is not an accelerator.
      if (key.startsWith(KEYBINDING)) keybindings[key.slice(KEYBINDING.length)] = value === 'none' ? null : value
      else if (key === 'terminal_minimum_contrast') change[key] = Number(value)
      else if (key === 'ui_font_size' || key === 'code_font_size' || key === 'terminal_font_size') {
        const size = Number(value)
        if (!Number.isSafeInteger(size) || String(size) !== value)
          throw new CliError('usage', key + ' must be an integer.')
        change[key] = size
      } else if (key === 'terminal_line_height') {
        const lineHeight = Number(value)
        if (!Number.isFinite(lineHeight)) throw new CliError('usage', 'terminal_line_height must be a number.')
        change[key] = lineHeight
      } else if (key === 'terminal_cursor_blink') {
        if (value !== 'true' && value !== 'false') {
          throw new CliError('usage', 'terminal_cursor_blink must be true or false.')
        }
        change[key] = value === 'true'
      } else if (
        key === 'terminal_binding' ||
        key === 'syntax_binding' ||
        key === 'expected_theme_revisions' ||
        key === 'terminal_color_overrides' ||
        (key === 'terminal_bold_color' && value !== 'inherit' && value !== 'bright')
      ) {
        try {
          change[key] = JSON.parse(value)
        } catch {
          throw new CliError('usage', key + ' requires a JSON object.')
        }
      } else if (key === 'expected_appearance_revision') {
        const revision = Number(value)
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
          throw new CliError('usage', 'Appearance revision must be a non-negative safe integer.')
        }
        change[key] = revision
      } else change[key] = value
    }
    if (Object.keys(keybindings).length) change.keybindings = keybindings
    return call(socketPath, 'settings.set', change as never)
  }
  if (action === 'reset-keybindings') {
    return call(socketPath, 'settings.set', { reset_keybindings: rest.length ? rest : 'all' } as never)
  }
  return undefined
}
