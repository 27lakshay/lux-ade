import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
// Profile settings live in the profile daemon, so every client applies the same durable preferences.
// A change reaches the feed; an unknown key is refused.
import { expect, test } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { rawReply } from '../fixtures/raw-reply'
import { defaultKeybindings as keybindings } from './keybindings'

test('settings default, change through the CLI, reach the feed and survive a restart', async ({ profile }) => {
  expect(await profile.call('settings.get', {})).toEqual({
    type: 'settings',
    settings: {
      appearance_revision: 0,
      app_light_theme: 'ade:chalk',
      app_dark_theme: 'ade:graphite',
      terminal_binding: { kind: 'follow_app' },
      syntax_binding: { kind: 'follow_app' },
      terminal_color_overrides: {},
      terminal_minimum_contrast: 1,
      terminal_bold_color: 'inherit',
      appearance: 'system',
      reduced_motion: 'system',
      high_contrast: 'system',
      reduced_transparency: 'system',
      differentiate_without_color: 'system',
      ui_font_family: 'Inter Variable',
      ui_font_size: 13,
      code_font_family: 'JetBrains Mono Variable',
      code_font_size: 12,
      terminal_font_family: 'JetBrains Mono Variable',
      terminal_font_size: 12,
      density: 'default',
      terminal_line_height: 1.35,
      terminal_font_kerning: 'auto',
      terminal_cursor_shape: 'block',
      terminal_cursor_blink: true,
      keybindings,
    },
  })
  const feed = await subscribeFeed(profile)
  await feed.connected()

  const set = await profile.cli('settings', 'set', 'appearance', 'dark', 'reduced_motion', 'on')
  expect(set.code, set.stderr).toBe(0)
  expect(set.json).toEqual({
    type: 'settings',
    settings: {
      appearance_revision: 1,
      app_light_theme: 'ade:chalk',
      app_dark_theme: 'ade:graphite',
      terminal_binding: { kind: 'follow_app' },
      syntax_binding: { kind: 'follow_app' },
      terminal_color_overrides: {},
      terminal_minimum_contrast: 1,
      terminal_bold_color: 'inherit',
      appearance: 'dark',
      reduced_motion: 'on',
      high_contrast: 'system',
      reduced_transparency: 'system',
      differentiate_without_color: 'system',
      ui_font_family: 'Inter Variable',
      ui_font_size: 13,
      code_font_family: 'JetBrains Mono Variable',
      code_font_size: 12,
      terminal_font_family: 'JetBrains Mono Variable',
      terminal_font_size: 12,
      density: 'default',
      terminal_line_height: 1.35,
      terminal_font_kerning: 'auto',
      terminal_cursor_shape: 'block',
      terminal_cursor_blink: true,
      keybindings,
    },
  })
  await feed.waitFor(
    (frame) =>
      frame.type === 'settings_changed' &&
      frame.settings.appearance === 'dark' &&
      frame.settings.reduced_motion === 'on',
  )
  feed.stop()

  // One key changes alone; the other keeps its value.
  expect((await profile.call('settings.set', { appearance: 'light' })).settings).toEqual({
    appearance_revision: 2,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
    appearance: 'light',
    reduced_motion: 'on',
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
    ui_font_family: 'Inter Variable',
    ui_font_size: 13,
    code_font_family: 'JetBrains Mono Variable',
    code_font_size: 12,
    terminal_font_family: 'JetBrains Mono Variable',
    terminal_font_size: 12,
    density: 'default',
    terminal_line_height: 1.35,
    terminal_font_kerning: 'auto',
    terminal_cursor_shape: 'block',
    terminal_cursor_blink: true,
    keybindings,
  })
  await profile.restartDaemon('kill')
  const got = await profile.cli('settings', 'get')
  expect(got.json).toEqual({
    type: 'settings',
    settings: {
      appearance_revision: 2,
      app_light_theme: 'ade:chalk',
      app_dark_theme: 'ade:graphite',
      terminal_binding: { kind: 'follow_app' },
      syntax_binding: { kind: 'follow_app' },
      terminal_color_overrides: {},
      terminal_minimum_contrast: 1,
      terminal_bold_color: 'inherit',
      appearance: 'light',
      reduced_motion: 'on',
      high_contrast: 'system',
      reduced_transparency: 'system',
      differentiate_without_color: 'system',
      ui_font_family: 'Inter Variable',
      ui_font_size: 13,
      code_font_family: 'JetBrains Mono Variable',
      code_font_size: 12,
      terminal_font_family: 'JetBrains Mono Variable',
      terminal_font_size: 12,
      density: 'default',
      terminal_line_height: 1.35,
      terminal_font_kerning: 'auto',
      terminal_cursor_shape: 'block',
      terminal_cursor_blink: true,
      keybindings,
    },
  })
})

test('accessibility preferences are typed, durable and independent of appearance revision', async ({
  profile,
  ade,
}) => {
  const initial = (await profile.call('settings.get', {})).settings
  expect(initial).toMatchObject({
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
    appearance_revision: 0,
  })

  const set = await profile.cli(
    'settings',
    'set',
    'high_contrast',
    'on',
    'reduced_transparency',
    'off',
    'differentiate_without_color',
    'on',
  )
  expect(set.code, set.stderr).toBe(0)
  const updated = (set.json as { settings: Record<string, unknown> }).settings
  expect(updated).toMatchObject({
    high_contrast: 'on',
    reduced_transparency: 'off',
    differentiate_without_color: 'on',
    appearance_revision: 0,
  })

  const invalid = await rawReply(profile, { op: 'settings.set', high_contrast: 'sometimes' })
  expect(invalid.type).toBe('error')
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    high_contrast: 'on',
    reduced_transparency: 'off',
    differentiate_without_color: 'on',
    appearance_revision: 0,
  })

  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    high_contrast: 'on',
    reduced_transparency: 'off',
    differentiate_without_color: 'on',
    appearance_revision: 0,
  })
  const other = await ade.profile()
  expect((await other.call('settings.get', {})).settings).toMatchObject({
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
    appearance_revision: 0,
  })
})

test('typography preferences are independent, validated and durable', async ({ profile }) => {
  const initial = (await profile.call('settings.get', {})).settings
  const feed = await subscribeFeed(profile)
  await feed.connected()

  const set = await profile.cli(
    'settings',
    'set',
    'ui_font_family',
    'Atkinson Hyperlegible',
    'ui_font_size',
    '14',
    'code_font_family',
    'Iosevka',
    'code_font_size',
    '15',
    'terminal_font_family',
    'SF Mono',
    'terminal_font_size',
    '13',
    'density',
    'compact',
    'terminal_line_height',
    '1.5',
    'terminal_font_kerning',
    'none',
    'terminal_cursor_shape',
    'underline',
    'terminal_cursor_blink',
    'false',
  )
  expect(set.code, set.stderr).toBe(0)
  expect(set.json).toMatchObject({
    settings: {
      ...initial,
      ui_font_family: 'Atkinson Hyperlegible',
      ui_font_size: 14,
      code_font_family: 'Iosevka',
      code_font_size: 15,
      terminal_font_family: 'SF Mono',
      terminal_font_size: 13,
      density: 'compact',
      terminal_line_height: 1.5,
      terminal_font_kerning: 'none',
      terminal_cursor_shape: 'underline',
      terminal_cursor_blink: false,
      appearance_revision: initial.appearance_revision,
    },
  })
  await feed.waitFor((frame) => frame.type === 'settings_changed' && frame.settings.ui_font_size === 14)
  feed.stop()

  const partial = (await profile.call('settings.set', { code_font_size: 16 })).settings
  expect(partial).toMatchObject({
    ui_font_family: 'Atkinson Hyperlegible',
    ui_font_size: 14,
    code_font_family: 'Iosevka',
    code_font_size: 16,
    terminal_font_family: 'SF Mono',
    terminal_font_size: 13,
    density: 'compact',
    terminal_cursor_blink: false,
    appearance_revision: initial.appearance_revision,
  })

  for (const [key, value] of [
    ['ui_font_family', 'Iosevka, monospace'],
    ['ui_font_size', '25'],
  ] as const) {
    const rejected = await profile.cli('settings', 'set', key, value)
    expect(rejected.code).not.toBe(0)
  }
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    ui_font_family: 'Atkinson Hyperlegible',
    ui_font_size: 14,
    code_font_size: 16,
    terminal_font_size: 13,
    appearance_revision: initial.appearance_revision,
  })

  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    ui_font_family: 'Atkinson Hyperlegible',
    ui_font_size: 14,
    code_font_family: 'Iosevka',
    code_font_size: 16,
    terminal_font_family: 'SF Mono',
    terminal_font_size: 13,
    density: 'compact',
    terminal_line_height: 1.5,
    terminal_font_kerning: 'none',
    terminal_cursor_shape: 'underline',
    terminal_cursor_blink: false,
    appearance_revision: initial.appearance_revision,
  })
})

test('an unknown key or value is refused and changes nothing', async ({ profile }) => {
  const unknown = await rawReply(profile, { op: 'settings.set', appearance: 'dark', colour: 'red' })
  expect(unknown).toMatchObject({ type: 'error', code: 'unknown_setting' })
  expect(String(unknown.message)).toContain('colour')
  const invalid = await rawReply(profile, { op: 'settings.set', appearance: 'sepia' })
  expect(invalid.type).toBe('error')
  // The SDK and the CLI refuse an unknown key before sending it.
  const cli = await profile.cli('settings', 'set', 'colour', 'red')
  expect(cli.code).not.toBe(0)
  expect((await profile.call('settings.get', {})).settings).toEqual({
    appearance_revision: 0,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
    appearance: 'system',
    reduced_motion: 'system',
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
    ui_font_family: 'Inter Variable',
    ui_font_size: 13,
    code_font_family: 'JetBrains Mono Variable',
    code_font_size: 12,
    terminal_font_family: 'JetBrains Mono Variable',
    terminal_font_size: 12,
    density: 'default',
    terminal_line_height: 1.35,
    terminal_font_kerning: 'auto',
    terminal_cursor_shape: 'block',
    terminal_cursor_blink: true,
    keybindings,
  })
})

test('appearance revisions reject stale edits atomically and survive restart', async ({ profile }) => {
  const initial = await rawReply(profile, { op: 'settings.get' })
  expect(initial.settings).toMatchObject({
    appearance_revision: 0,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
  })
  const changed = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'dark',
    expected_appearance_revision: 0,
  })
  expect(changed.settings).toMatchObject({
    appearance: 'dark',
    appearance_revision: 1,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
  })
  const stale = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'light',
    reduced_motion: 'on',
    expected_appearance_revision: 0,
  })
  expect(stale).toMatchObject({ type: 'error', code: 'appearance_conflict', expected: 0, current: 1 })
  const unchanged = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'dark',
    expected_appearance_revision: 1,
  })
  expect(unchanged.settings).toMatchObject({
    appearance: 'dark',
    appearance_revision: 1,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
    reduced_motion: 'system',
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
  })
  const cliRetry = await profile.cli('settings', 'set', 'appearance', 'dark', 'expected_appearance_revision', '1')
  expect(cliRetry.code, cliRetry.stderr).toBe(0)
  expect(cliRetry.json).toMatchObject({ settings: unchanged.settings })
  const cliStale = await profile.cli('settings', 'set', 'appearance', 'light', 'expected_appearance_revision', '0')
  expect(cliStale.code).not.toBe(0)
  await profile.restartDaemon('kill')
  expect((await rawReply(profile, { op: 'settings.get' })).settings).toEqual(unchanged.settings)
})

test('resolved appearance exposes theme identity and runtime convergence', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light' })
  const resolved = await rawReply(profile, { op: 'settings.appearance' })
  expect(resolved).toMatchObject({
    type: 'appearance',
    theme_id: 'ade:chalk',
    revision: 1,
    tokens: { background: '#FAFBFC' },
    propagation: { state: 'applied', revision: 1 },
    terminal: { revision: 1, dark: false, foreground: { r: 32, g: 36, b: 43 } },
  })
  expect(Object.keys(resolved.tokens as Record<string, string>)).toHaveLength(73)
  await profile.restartDaemon('kill')
  expect(await rawReply(profile, { op: 'settings.appearance' })).toEqual(resolved)
  const cli = await profile.cli('settings', 'appearance')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(resolved)
})

test('a dead runtime is reported without losing the committed appearance', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light' })
  await profile.killRuntime()
  expect(await rawReply(profile, { op: 'settings.appearance' })).toMatchObject({
    theme_id: 'ade:chalk',
    propagation: { state: 'unavailable', desired_revision: 1 },
  })
  const failed = await rawReply(profile, { op: 'settings.set', appearance: 'dark', expected_appearance_revision: 1 })
  expect(failed.type).toBe('error')
  expect(failed.message).toContain('Appearance saved')
  expect(await rawReply(profile, { op: 'settings.appearance' })).toMatchObject({
    theme_id: 'ade:graphite',
    revision: 2,
    propagation: { state: 'unavailable', desired_revision: 2 },
  })
  await profile.restartDaemon('kill')
  expect(await rawReply(profile, { op: 'settings.appearance' })).toMatchObject({
    theme_id: 'ade:graphite',
    revision: 2,
    propagation: { state: 'applied', revision: 2 },
  })
})

test('appearance reset is revision checked and preserves other preferences', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light', reduced_motion: 'on' })
  expect(await rawReply(profile, { op: 'settings.appearance.reset', expected_appearance_revision: 0 })).toMatchObject({
    type: 'error',
    code: 'appearance_conflict',
    current: 1,
  })
  const reset = await rawReply(profile, { op: 'settings.appearance.reset', expected_appearance_revision: 1 })
  expect(reset).toMatchObject({
    type: 'settings',
    settings: {
      appearance: 'system',
      appearance_revision: 2,
      app_light_theme: 'ade:chalk',
      app_dark_theme: 'ade:graphite',
      terminal_binding: { kind: 'follow_app' },
      syntax_binding: { kind: 'follow_app' },
      terminal_color_overrides: {},
      terminal_minimum_contrast: 1,
      terminal_bold_color: 'inherit',
      reduced_motion: 'on',
      high_contrast: 'system',
      reduced_transparency: 'system',
      differentiate_without_color: 'system',
      keybindings,
    },
  })
  const retry = await profile.cli('settings', 'reset-appearance', '2')
  expect(retry.code, retry.stderr).toBe(0)
  expect(retry.json).toEqual(reset)
  expect(await rawReply(profile, { op: 'settings.appearance' })).toMatchObject({
    theme_id: 'ade:graphite',
    propagation: { state: 'applied', revision: 2 },
  })
})

test('appearance selections and resets stay isolated between profiles', async ({ ade, profile }) => {
  const other = await ade.profile()
  await profile.call('settings.set', { appearance: 'light' })
  await other.call('settings.set', { appearance: 'dark' })
  const otherBefore = await other.call('settings.appearance', {})
  await profile.call('settings.appearance.reset', { expected_appearance_revision: 1 })
  expect(await other.call('settings.appearance', {})).toEqual(otherBefore)
  expect(otherBefore).toMatchObject({ theme_id: 'ade:graphite', revision: 1, propagation: { state: 'applied' } })
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    appearance: 'system',
    appearance_revision: 2,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
  })
})

test('a persistence failure rolls back appearance and revision before runtime propagation', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light' })
  const before = await profile.call('settings.appearance', {})
  // Inject a real SQLite write failure inside this scratch profile's transaction.
  // Assertions remain at public protocol boundaries; no production failure hook is added.
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    database.exec(`CREATE TRIGGER refuse_appearance_revision BEFORE INSERT ON profile_settings
      WHEN NEW.key = 'appearance_revision'
      BEGIN SELECT RAISE(ABORT, 'fixture appearance persistence failure'); END`)
    const failed = await rawReply(profile, {
      op: 'settings.set',
      appearance: 'dark',
      reduced_motion: 'on',
      expected_appearance_revision: 1,
    })
    expect(failed.type).toBe('error')
    expect(failed.message).toContain('fixture appearance persistence failure')
    expect(await profile.call('settings.appearance', {})).toEqual(before)
    expect((await profile.call('settings.get', {})).settings).toMatchObject({
      appearance: 'light',
      appearance_revision: 1,
      app_light_theme: 'ade:chalk',
      app_dark_theme: 'ade:graphite',
      terminal_binding: { kind: 'follow_app' },
      syntax_binding: { kind: 'follow_app' },
      terminal_color_overrides: {},
      terminal_minimum_contrast: 1,
      terminal_bold_color: 'inherit',
      reduced_motion: 'system',
      high_contrast: 'system',
      reduced_transparency: 'system',
      differentiate_without_color: 'system',
    })
  } finally {
    database.exec('DROP TRIGGER IF EXISTS refuse_appearance_revision')
    database.close()
  }
  const saved = await profile.call('settings.set', { appearance: 'dark', expected_appearance_revision: 1 })
  expect(saved.settings).toMatchObject({
    appearance: 'dark',
    appearance_revision: 2,
    app_light_theme: 'ade:chalk',
    app_dark_theme: 'ade:graphite',
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
  })
})
