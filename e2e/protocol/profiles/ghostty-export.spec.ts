import { expect, test } from '../fixtures'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { rawReply } from '../fixtures/raw-reply'

test('Ghostty export is deterministic, revision checked and round trips supported terminal colors', async ({
  profile,
}) => {
  const imported = await profile.call('themes.ghostty.validate', {
    source:
      'foreground = #abcdef\nbackground = #123456\npalette = 255=#654321\ncursor-color = cell-background\ncursor-text = cell-foreground\nselection-foreground = cell-foreground\n',
    id: 'user:ghostty-export',
    name: 'Ghostty export',
    mode: 'dark',
    source_name: 'round-trip fixture',
  })
  await profile.call('themes.install', { items: [{ source: imported.source!, expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const exported = await rawReply(profile, {
    op: 'themes.ghostty.export',
    id: 'user:ghostty-export',
    expected_revision: 1,
  })
  expect(exported).toMatchObject({
    type: 'ghostty_theme_export',
    theme: { revision: 1 },
    source: expect.stringContaining('palette = 255=#654321\n'),
  })
  expect(exported.source).toContain('cursor-color = cell-background\n')
  expect(
    await rawReply(profile, { op: 'themes.ghostty.export', id: 'user:ghostty-export', expected_revision: 1 }),
  ).toEqual(exported)
  const reimported = await profile.call('themes.ghostty.validate', {
    source: exported.source as string,
    id: 'user:reimported',
    name: 'Reimported',
    mode: 'dark',
    source_name: 'exported file',
  })
  expect(reimported.validation.valid).toBe(true)
  expect(reimported.validation.definition?.terminal?.tokens).toEqual(imported.validation.definition?.terminal?.tokens)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('Ghostty export discloses unrepresentable data and stale definitions never publish a file', async ({
  profile,
}) => {
  const id = 'user:alpha-export'
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id,
    name: 'Alpha export',
    mode: 'dark',
    provenance: { kind: 'user' },
    app: { defaults: 'ade:graphite', tokens: {} },
    syntax: { defaults: 'ade:graphite', tokens: {} },
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-selection': '#11223380' } },
    'x-inert': { command: 'never execute' },
  })
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const report = await profile.call('themes.ghostty.export', { id, expected_revision: 1 })
  expect(report.omissions.map((item) => item.path)).toEqual(
    expect.arrayContaining([
      '/terminal/tokens/terminal-selection',
      '/app',
      '/syntax',
      '/provenance',
      '/appearance',
      '/x-inert',
    ]),
  )
  expect(report.source).not.toContain('selection-background =')
  expect(report.source).not.toContain('never execute')
  const cli = await profile.cli('themes', 'ghostty-export', id, '1')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(report)
  const file = join(profile.root, 'alpha.ghostty')
  const written = await profile.cli('themes', 'ghostty-export', id, '1', '--output', file)
  expect(written.code, written.stderr).toBe(0)
  expect(written.json).toMatchObject({ type: 'ghostty_theme_file_export', revision: 1, omissions: report.omissions })
  expect(await readFile(file, 'utf8')).toBe(report.source)
  const conflict = await profile.cli('themes', 'ghostty-export', id, '1', '--output', file)
  expect(conflict.code).toBe(8)
  expect(conflict.json).toMatchObject({ code: 'conflict' })
  await profile.call('themes.rename', { id, name: 'New name', expected_revision: 1 })
  const stale = await profile.cli('themes', 'ghostty-export', id, '1', '--output', file, '--overwrite')
  expect(stale.code).toBe(7)
  expect(stale.json).toMatchObject({ code: 'theme_conflict', expected: 1, current: 2 })
  expect(await readFile(file, 'utf8')).toBe(report.source)
  expect((await readdir(profile.root)).some((name) => name.startsWith('.ade-theme-'))).toBe(false)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('opaque ADE selection alpha exports as equivalent Ghostty RGB without a color omission', async ({ profile }) => {
  const id = 'user:opaque-selection'
  await profile.call('themes.install', {
    items: [
      {
        expected_revision: 0,
        source: JSON.stringify({
          format: 'ade-theme',
          version: 1,
          id,
          name: 'Opaque selection',
          mode: 'dark',
          provenance: { kind: 'user' },
          terminal: { defaults: 'ade:graphite', tokens: { 'terminal-selection': '#112233ff' } },
        }),
      },
    ],
  })
  const report = await profile.call('themes.ghostty.export', { id, expected_revision: 1 })
  expect(report.source).toContain('selection-background = #112233\n')
  expect(report.omissions.some((item) => item.path === '/terminal/tokens/terminal-selection')).toBe(false)
})
