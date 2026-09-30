import type { ThemeBinding, TerminalColorOverrides, BoldColor } from '@ade/contracts'
import { dailyUseCommand, DaemonRequestError } from '@ade/client'
import { handleResult as handle } from './ipc'
import { refreshAppearance, appearanceStartupStatus, acknowledgeStartupWarning } from './appearance'
import { getClient, getSocket } from './profile-connection'

// The profile's settings, forwarded to the daemon, which checks every key and value.

function endpoint(): string {
  const socket = getSocket()
  if (!socket || getClient().getState().status !== 'connected')
    throw new DaemonRequestError('unavailable', 'Profile daemon is unavailable')
  return socket
}

export function registerSettingsIpc(): void {
  handle('ade:settings-startup-status', async () => appearanceStartupStatus())
  handle('ade:settings-reset-appearance', async (_event, expectedRevision) => {
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new DaemonRequestError('invalid_request', 'Invalid appearance revision')
    }
    const socket = endpoint()
    const saved = await dailyUseCommand(socket, {
      op: 'settings.appearance.reset',
      expected_appearance_revision: expectedRevision,
    })
    await refreshAppearance(socket)
    if (socket === getSocket()) acknowledgeStartupWarning()
    return saved.settings
  })
  handle('ade:settings-palettes', async () => dailyUseCommand(endpoint(), { op: 'settings.palettes' }))
  handle('ade:settings-appearance', async () => refreshAppearance(endpoint()))
  handle('ade:settings-get', async () => (await dailyUseCommand(endpoint(), { op: 'settings.get' })).settings)
  handle('ade:settings-set', async (_event, changes: unknown) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes))
      throw new DaemonRequestError('invalid_request', 'Invalid settings')
    const {
      appearance,
      app_light_theme,
      app_dark_theme,
      terminal_binding,
      syntax_binding,
      terminal_color_overrides,
      terminal_minimum_contrast,
      terminal_bold_color,
      reduced_motion,
      high_contrast,
      reduced_transparency,
      differentiate_without_color,
      ui_font_family,
      ui_font_size,
      code_font_family,
      code_font_size,
      terminal_font_family,
      terminal_font_size,
      density,
      terminal_line_height,
      terminal_font_kerning,
      terminal_cursor_shape,
      terminal_cursor_blink,
      expected_appearance_revision,
      expected_theme_revisions,
    } = changes as Record<string, unknown>
    const request = {
      op: 'settings.set' as const,
      ...(app_light_theme === undefined ? {} : { app_light_theme: app_light_theme as string }),
      ...(app_dark_theme === undefined ? {} : { app_dark_theme: app_dark_theme as string }),
      ...(syntax_binding === undefined ? {} : { syntax_binding: syntax_binding as ThemeBinding }),
      ...(terminal_binding === undefined ? {} : { terminal_binding: terminal_binding as ThemeBinding }),
      ...(terminal_bold_color === undefined ? {} : { terminal_bold_color: terminal_bold_color as BoldColor }),
      ...(terminal_minimum_contrast === undefined
        ? {}
        : { terminal_minimum_contrast: terminal_minimum_contrast as number }),
      ...(terminal_color_overrides === undefined
        ? {}
        : { terminal_color_overrides: terminal_color_overrides as TerminalColorOverrides }),
      ...(expected_appearance_revision === undefined
        ? {}
        : { expected_appearance_revision: expected_appearance_revision as number }),
      ...(expected_theme_revisions === undefined
        ? {}
        : { expected_theme_revisions: expected_theme_revisions as Record<string, number> }),
      ...(appearance === undefined ? {} : { appearance: appearance as 'light' | 'dark' | 'system' }),
      ...(reduced_motion === undefined ? {} : { reduced_motion: reduced_motion as 'system' | 'on' | 'off' }),
      ...(ui_font_family === undefined ? {} : { ui_font_family: ui_font_family as string }),
      ...(high_contrast === undefined ? {} : { high_contrast: high_contrast as 'system' | 'on' | 'off' }),
      ...(reduced_transparency === undefined
        ? {}
        : { reduced_transparency: reduced_transparency as 'system' | 'on' | 'off' }),
      ...(differentiate_without_color === undefined
        ? {}
        : { differentiate_without_color: differentiate_without_color as 'system' | 'on' | 'off' }),
      ...(ui_font_size === undefined ? {} : { ui_font_size: ui_font_size as number }),
      ...(code_font_family === undefined ? {} : { code_font_family: code_font_family as string }),
      ...(code_font_size === undefined ? {} : { code_font_size: code_font_size as number }),
      ...(terminal_font_family === undefined ? {} : { terminal_font_family: terminal_font_family as string }),
      ...(terminal_font_size === undefined ? {} : { terminal_font_size: terminal_font_size as number }),
      ...(density === undefined ? {} : { density: density as 'default' | 'compact' }),
      ...(terminal_line_height === undefined ? {} : { terminal_line_height: terminal_line_height as number }),
      ...(terminal_font_kerning === undefined
        ? {}
        : { terminal_font_kerning: terminal_font_kerning as 'auto' | 'normal' | 'none' }),
      ...(terminal_cursor_shape === undefined
        ? {}
        : { terminal_cursor_shape: terminal_cursor_shape as 'block' | 'bar' | 'underline' }),
      ...(terminal_cursor_blink === undefined ? {} : { terminal_cursor_blink: terminal_cursor_blink as boolean }),
    }
    const socket = endpoint()
    const saved = await dailyUseCommand(socket, request)
    if (
      appearance !== undefined ||
      app_light_theme !== undefined ||
      app_dark_theme !== undefined ||
      terminal_binding !== undefined ||
      syntax_binding !== undefined ||
      terminal_color_overrides !== undefined ||
      terminal_minimum_contrast !== undefined ||
      terminal_bold_color !== undefined
    )
      await refreshAppearance(socket)
    return saved.settings
  })
}
