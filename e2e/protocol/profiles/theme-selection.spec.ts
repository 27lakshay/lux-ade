import { expect, test } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'
import { subscribeFeed } from '../fixtures/feed'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

function definition(id: string, sections: string[], mode = 'dark', color = '#123456') {
  return JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id,
    name: id,
    mode,
    provenance: { kind: 'user' },
    ...Object.fromEntries(
      sections.map((section) => [
        section,
        {
          defaults: mode === 'dark' ? 'ade:graphite' : 'ade:chalk',
          tokens:
            section === 'terminal'
              ? {
                  'terminal-foreground': color,
                  'terminal-ansi-255': '#abcdef',
                  'terminal-cursor-text': 'cell-background',
                  'terminal-selection': '#11223380',
                }
              : section === 'syntax'
                ? { 'syntax-keyword': color }
                : { primary: color },
        },
      ]),
    ),
  })
}

test('installed sections select independently, preserve complete terminal values and survive restart', async ({
  profile,
}) => {
  await profile.call('themes.install', {
    items: [
      { source: definition('user:app', ['app']), expected_revision: 0 },
      { source: definition('user:terminal', ['terminal']), expected_revision: 0 },
      { source: definition('user:syntax', ['syntax']), expected_revision: 0 },
    ],
  })
  const selected = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'dark',
    app_dark_theme: 'user:app',
    terminal_binding: { kind: 'fixed', theme_id: 'user:terminal' },
    syntax_binding: { kind: 'fixed', theme_id: 'user:syntax' },
  })
  expect(selected.type).toBe('settings')
  const appearance = await profile.call('settings.appearance', {})
  expect(appearance).toMatchObject({
    theme_id: 'user:app',
    tokens: { primary: '#123456' },
    syntax: { palette: { id: 'user:syntax', tokens: { 'syntax-keyword': '#123456' } }, diagnostics: [] },
    terminal: {
      foreground: { r: 18, g: 52, b: 86 },
      cursor_text: 'cell-background',
      selection_background: { r: 17, g: 34, b: 51, a: 128 },
      dark: true,
    },
    propagation: { state: 'applied' },
  })
  expect(appearance.terminal.palette).toHaveLength(256)
  expect(appearance.terminal.palette[255]).toEqual({ r: 171, g: 205, b: 239 })
  expect(Object.keys(appearance.tokens)).toHaveLength(73)
  for (const changes of [
    { app_dark_theme: 'user:terminal' },
    { terminal_binding: { kind: 'fixed', theme_id: 'user:syntax' } },
    { syntax_binding: { kind: 'fixed', theme_id: 'user:app' } },
    { app_light_theme: 'user:app' },
  ]) {
    expect((await rawReply(profile, { op: 'settings.set', ...changes })).type).toBe('error')
    expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  }
  await profile.restartDaemon('kill')
  expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  await profile.call('settings.set', {
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
  })
  const following = await profile.call('settings.appearance', {})
  expect(following.tokens.primary).toBe('#123456')
  expect(following.syntax).toMatchObject({
    selected_id: 'user:app',
    palette: { id: 'ade:graphite' },
    diagnostics: [expect.objectContaining({ code: 'missing_section', selected_id: 'user:app' })],
  })
  expect(following.terminal_diagnostics).toEqual([
    expect.objectContaining({ code: 'missing_section', selected_id: 'user:app' }),
  ])
})

test('a damaged installed definition falls back visibly and a valid replacement restores its retained selections', async ({
  profile,
}) => {
  const original = definition('user:damaged', ['app', 'terminal', 'syntax'])
  await profile.call('themes.install', { items: [{ source: original, expected_revision: 0 }] })
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: 'user:damaged' })
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    database
      .prepare(
        "UPDATE theme_definitions SET data=json_set(data,'$.definition.terminal.tokens.terminal-foreground','javascript:invalid') WHERE id=?",
      )
      .run('user:damaged')
  } finally {
    database.close()
  }
  await profile.restartDaemon('kill')
  const fallback = await profile.call('settings.appearance', {})
  expect(fallback).toMatchObject({
    theme_id: 'ade:graphite',
    diagnostics: [expect.objectContaining({ code: 'invalid_definition', selected_id: 'user:damaged' })],
    terminal_diagnostics: [expect.objectContaining({ code: 'invalid_definition', selected_id: 'user:damaged' })],
  })
  expect((await profile.call('settings.get', {})).settings.app_dark_theme).toBe('user:damaged')
  expect(await profile.call('themes.install', { items: [{ source: original, expected_revision: 1 }] })).toMatchObject({
    committed: true,
    changed: true,
  })
  expect(await profile.call('settings.appearance', {})).toMatchObject({
    theme_id: 'user:damaged',
    tokens: { primary: '#123456' },
    diagnostics: [],
    terminal_diagnostics: [],
  })
})

test('replacing a selected definition advances appearance atomically, publishes once and fences stale previews', async ({
  profile,
}) => {
  const original = definition('user:selected', ['app', 'terminal', 'syntax'])
  await profile.call('themes.install', { items: [{ source: original, expected_revision: 0 }] })
  expect(
    (await rawReply(profile, { op: 'settings.set', appearance: 'dark', app_dark_theme: 'user:selected' })).type,
  ).toBe('settings')
  const before = await profile.call('settings.appearance', {})
  const feed = await subscribeFeed(profile)
  await feed.connected()
  try {
    const edited = definition('user:selected', ['app', 'terminal', 'syntax'], 'dark', '#654321')
    await profile.call('themes.install', { items: [{ source: edited, expected_revision: 1 }] })
    const after = await profile.call('settings.appearance', {})
    expect(after.revision).toBe(before.revision + 1)
    expect(after.tokens.primary).toBe('#654321')
    expect(after.syntax.palette.tokens['syntax-keyword']).toBe('#654321')
    expect(after.terminal.foreground).toEqual({ r: 101, g: 67, b: 33 })
    expect(after.propagation).toMatchObject({ state: 'applied', revision: after.revision })
    await feed.waitFor(
      (frame) => frame.type === 'settings_changed' && frame.settings.appearance_revision === after.revision,
    )
    const stale = await rawReply(profile, {
      op: 'settings.set',
      app_dark_theme: 'ade:carbon',
      expected_appearance_revision: before.revision,
    })
    expect(stale).toMatchObject({ code: 'appearance_conflict' })
    expect(await profile.call('themes.install', { items: [{ source: edited, expected_revision: 1 }] })).toMatchObject({
      changed: false,
    })
    expect((await profile.call('settings.appearance', {})).revision).toBe(after.revision)
    expect(feed.frames.filter((frame) => frame.type === 'settings_changed')).toHaveLength(1)
    await profile.restartDaemon('kill')
    expect(await profile.call('settings.appearance', {})).toEqual(after)
  } finally {
    feed.stop()
  }
})

test('preview captures inactive definition revisions and an appearance persistence failure rolls back the active replacement', async ({
  profile,
}) => {
  await profile.call('themes.install', {
    items: [
      { source: definition('user:inactive', ['app'], 'light'), expected_revision: 0 },
      { source: definition('user:active', ['app', 'terminal', 'syntax']), expected_revision: 0 },
    ],
  })
  await profile.call('settings.set', { appearance: 'dark', app_dark_theme: 'user:active' })
  const draft = {
    app_light_theme: 'user:inactive',
    app_dark_theme: 'user:active',
    terminal_binding: { kind: 'follow_app' as const },
    syntax_binding: { kind: 'follow_app' as const },
  }
  const before = await profile.call('settings.appearance', {})
  const preview = await profile.call('themes.preview', draft)
  expect(preview.expected_theme_revisions).toEqual({ 'user:inactive': 1, 'user:active': 1 })
  expect(preview.samples[0]!.app.tokens.primary).toBe('#123456')
  expect(preview.samples[1]!.terminal.palette[255]).toEqual({ r: 171, g: 205, b: 239 })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  const file = join(profile.root, 'preview.json')
  await writeFile(file, JSON.stringify(draft))
  const cli = await profile.cli('themes', 'preview', file)
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(preview)
  await profile.call('themes.install', {
    items: [{ source: definition('user:inactive', ['app'], 'light', '#654321'), expected_revision: 1 }],
  })
  expect((await profile.call('settings.appearance', {})).revision).toBe(before.revision)
  expect(
    await rawReply(profile, {
      op: 'settings.set',
      ...draft,
      expected_appearance_revision: before.revision,
      expected_theme_revisions: preview.expected_theme_revisions,
    }),
  ).toMatchObject({ code: 'theme_conflict', id: 'user:inactive', expected: 1, current: 2 })
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  const original = await profile.call('themes.inspect', { id: 'user:active' })
  const library = await profile.call('themes.list', {})
  try {
    database.exec(
      "CREATE TRIGGER fail_active_theme BEFORE UPDATE ON profile_settings WHEN NEW.key='appearance_revision' BEGIN SELECT RAISE(ABORT, 'appearance persistence failure'); END",
    )
    const failed = await rawReply(profile, {
      op: 'themes.install',
      items: [
        { source: definition('user:active', ['app', 'terminal', 'syntax'], 'dark', '#654321'), expected_revision: 1 },
      ],
    })
    expect(failed).toMatchObject({ type: 'error' })
    expect(failed.message).toContain('appearance persistence failure')
    expect(await profile.call('themes.inspect', { id: 'user:active' })).toEqual(original)
    expect(await profile.call('themes.list', {})).toEqual(library)
    expect(await profile.call('settings.appearance', {})).toEqual(before)
    database.exec('DROP TRIGGER fail_active_theme')
    await profile.call('themes.install', {
      items: [
        { source: definition('user:active', ['app', 'terminal', 'syntax'], 'dark', '#654321'), expected_revision: 1 },
      ],
    })
    expect((await profile.call('settings.appearance', {})).revision).toBe(before.revision + 1)
  } finally {
    database.close()
  }
})

test('CLI selection carries captured definition revisions and reset leaves custom definitions and other preferences intact', async ({
  profile,
}) => {
  await profile.call('themes.install', {
    items: [{ source: definition('user:cli-selection', ['app', 'terminal', 'syntax']), expected_revision: 0 }],
  })
  await profile.call('settings.set', { reduced_motion: 'on', terminal_minimum_contrast: 7 })
  const before = await profile.call('settings.appearance', {})
  const select = await profile.cli(
    'settings',
    'set',
    'appearance',
    'dark',
    'app_dark_theme',
    'user:cli-selection',
    'expected_appearance_revision',
    String(before.revision),
    'expected_theme_revisions',
    JSON.stringify({ 'user:cli-selection': 1 }),
  )
  expect(select.code, select.stderr).toBe(0)
  const captured = await profile.call('settings.appearance', {})
  expect(captured.theme_id).toBe('user:cli-selection')
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    reduced_motion: 'on',
    terminal_minimum_contrast: 7,
  })
  await profile.call('themes.rename', { id: 'user:cli-selection', name: 'New revision', expected_revision: 1 })
  const current = await profile.call('settings.appearance', {})
  const stale = await profile.cli(
    'settings',
    'set',
    'appearance',
    'dark',
    'app_dark_theme',
    'user:cli-selection',
    'expected_appearance_revision',
    String(current.revision),
    'expected_theme_revisions',
    JSON.stringify({ 'user:cli-selection': 1 }),
  )
  expect(stale.code).not.toBe(0)
  expect(JSON.parse(stale.stderr)).toMatchObject({
    code: 'theme_conflict',
    id: 'user:cli-selection',
    expected: 1,
    current: 2,
  })
  expect(await profile.call('settings.appearance', {})).toEqual(current)
  const reset = await profile.cli('settings', 'reset-appearance', String(current.revision))
  expect(reset.code, reset.stderr).toBe(0)
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    app_dark_theme: 'ade:graphite',
    reduced_motion: 'on',
    terminal_minimum_contrast: 1,
  })
  expect((await profile.call('themes.inspect', { id: 'user:cli-selection' })).theme.revision).toBe(2)
})
