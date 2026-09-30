import { expect, test } from '../fixtures'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawReply } from '../fixtures/raw-reply'

test('Ghostty readability proposals require a separate revision-checked settings action', async ({ profile }) => {
  const before = await profile.call('settings.get', {})
  const report = await profile.call('themes.ghostty.validate', {
    id: 'user:ghostty-policies',
    name: 'Policy proposals',
    mode: 'dark',
    source: 'foreground = #123456\nminimum-contrast = 4.5\nbold-color = bright\ncursor-opacity = 0.5\n',
  })
  expect(report.policies).toEqual({ minimum_contrast: 4.5, bold_color: 'bright' })
  expect(report.preview).toMatchObject({ minimum_contrast: 1, bold_color: 'inherit' })
  expect(report.validation.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'optional_policy', line: 2 }),
      expect.objectContaining({ code: 'optional_policy', line: 3 }),
      expect.objectContaining({ code: 'unsupported_policy', line: 4 }),
    ]),
  )
  await profile.call('themes.install', { items: [{ source: report.source!, expected_revision: 0 }] })
  expect(await profile.call('settings.get', {})).toEqual(before)
  const saved = await profile.call('settings.set', {
    expected_appearance_revision: before.settings.appearance_revision,
    terminal_minimum_contrast: report.policies.minimum_contrast!,
  })
  expect(saved.settings).toMatchObject({ terminal_minimum_contrast: 4.5, terminal_bold_color: 'inherit' })
  expect(
    await rawReply(profile, {
      op: 'settings.set',
      expected_appearance_revision: before.settings.appearance_revision,
      terminal_bold_color: report.policies.bold_color!,
    }),
  ).toMatchObject({ type: 'error', code: 'appearance_conflict' })
  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings).toEqual(saved.settings)
})

test('Ghostty policy proposals preserve resets, clamping and invalid-setting diagnostics across CLI and SDK', async ({
  profile,
}) => {
  const request = { id: 'user:policy-grammar', name: 'Policy grammar', mode: 'dark' as const, source_name: null }
  const before = await profile.call('settings.get', {})
  const cases = [
    {
      source: 'minimum-contrast = 4.5\nbold-color = "ForestGreen"\nminimum-contrast = NaN\nbold-color = invalid\n',
      policies: { minimum_contrast: 4.5, bold_color: { r: 34, g: 139, b: 34 } },
      unsupported: 2,
    },
    {
      source: 'minimum-contrast = 4.5\nminimum-contrast =\nbold-color = bright\nbold-color =\n',
      policies: { minimum_contrast: 1, bold_color: 'inherit' },
      unsupported: 0,
    },
    {
      source: 'minimum-contrast = 22\nbold-color = #123456\ncursor-opacity = 0.25\nbold-is-bright = true\n',
      policies: { minimum_contrast: 21, bold_color: { r: 18, g: 52, b: 86 } },
      unsupported: 2,
    },
    {
      source: 'minimum-contrast = -2\nbold-color\nfont-family = NeverLoad\n',
      policies: { minimum_contrast: 1, bold_color: null },
      unsupported: 2,
    },
    {
      source: 'minimum-contrast = 4.5e0\nbold-color = bright\n',
      policies: { minimum_contrast: 4.5, bold_color: 'bright' },
      unsupported: 0,
    },
  ]
  const file = join(profile.root, 'policy.ghostty')
  for (const fixture of cases) {
    const source = `foreground = #000000\n${fixture.source}`
    await writeFile(file, source)
    const report = await profile.call('themes.ghostty.validate', { ...request, source, source_name: file })
    expect(report.validation.valid).toBe(true)
    expect(report.policies).toEqual(fixture.policies)
    expect(report.preview).toMatchObject({
      foreground: { r: 0, g: 0, b: 0 },
      minimum_contrast: 1,
      bold_color: 'inherit',
    })
    expect(report.validation.diagnostics.filter((diagnostic) => diagnostic.code === 'unsupported_policy')).toHaveLength(
      fixture.unsupported,
    )
    if (fixture.source.includes('minimum-contrast = 22') || fixture.source.includes('minimum-contrast = -2'))
      expect(report.validation.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'policy_clamped', line: 2 })]),
      )
    const cli = await profile.cli('themes', 'ghostty-validate', file, request.id, request.name, request.mode)
    expect(cli.code, cli.stderr).toBe(0)
    expect(cli.json).toEqual(report)
  }
  expect(await profile.call('settings.get', {})).toEqual(before)
})

test('Ghostty file validation uses pinned color parsing and defaults without changing appearance', async ({
  profile,
}) => {
  const before = await profile.call('settings.appearance', {})
  const source =
    '# Theme fixture\nforeground = "ForestGreen"\nbackground = #abc\npalette = 0x10=rgb:12/34/56\npalette = 255=#123456\ncursor-color = cell-background\ncursor-text = cell-foreground\nselection-foreground = cell-foreground\nselection-background = #654321\n'
  const report = await rawReply(profile, {
    op: 'themes.ghostty.validate',
    source,
    id: 'user:ghostty',
    name: 'Ghostty fixture',
    mode: 'dark',
    source_name: 'fixture.theme',
  })
  expect(report).toMatchObject({
    type: 'ghostty_theme_validation',
    preview: { foreground: { r: 34, g: 139, b: 34 }, background: { r: 170, g: 187, b: 204 }, minimum_contrast: 1 },
    validation: {
      valid: true,
      target: null,
      definition: {
        id: 'user:ghostty',
        provenance: { kind: 'imported', source: 'fixture.theme' },
        terminal: {
          tokens: {
            terminal: '#aabbcc',
            'terminal-foreground': '#228b22',
            'terminal-cursor': 'cell-background',
            'terminal-cursor-text': 'cell-foreground',
            'terminal-selection-foreground': 'cell-foreground',
            'terminal-selection': '#654321',
            'terminal-ansi-16': '#123456',
            'terminal-ansi-255': '#123456',
            'terminal-ansi-17': '#00005f',
            'terminal-ansi-232': '#080808',
          },
        },
      },
    },
  })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('Ghostty candidates install through the common library and retain source after restart', async ({ profile }) => {
  const request = {
    source:
      'foreground = #123456\npalette = 255=#abcdef\ncursor-color = cell-foreground\ncursor-text = cell-background\n',
    id: 'user:imported',
    name: 'Imported',
    mode: 'dark' as const,
    source_name: 'Local theme',
  }
  const report = await profile.call('themes.ghostty.validate', request)
  expect(report.validation.valid).toBe(true)
  expect(report.source).not.toBeNull()
  await profile.call('themes.install', { items: [{ source: report.source!, expected_revision: 0 }] })
  const retained = await profile.call('themes.inspect', { id: request.id })
  expect(retained.theme.definition.provenance).toMatchObject({
    source: 'Local theme',
    source_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    source_version: '9c96f7ddb3be2cc575a159d4d1f1d49fb10d7006',
  })
  expect(retained.theme.definition['x-ghostty']).toEqual({ source: request.source })
  expect(retained.theme.definition.terminal?.tokens['terminal-cursor']).toBe('cell-foreground')
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: request.id } })
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject({
    foreground: { r: 18, g: 52, b: 86 },
    background: { r: 40, g: 44, b: 52 },
    cursor_text: 'cell-background',
    selection_foreground: { r: 40, g: 44, b: 52 },
    selection_background: { r: 18, g: 52, b: 86 },
  })
  await profile.restartDaemon('kill')
  expect(await profile.call('themes.inspect', { id: request.id })).toEqual(retained)
  expect((await profile.call('themes.ghostty.validate', request)).validation.target?.revision).toBe(1)
})

test('Ghostty diagnostics locate invalid data, preserve hashes and never resolve includes or execute options', async ({
  profile,
}) => {
  const request = { source: '', id: 'user:grammar', name: 'Grammar', mode: 'dark' as const, source_name: null }
  const before = await profile.call('themes.list', {})
  const source =
    '# é comment\r\nforeground = #AbC\r\nforeground = \r\npalette = 255=#112233\npalette =\npalette = 0b1=#abc\npalette = 0x1=#fed\ncursor-text = cell-foreground\nselection-background = cell-background\ncommand = touch never-execute\nconfig-file = /never-read\n'
  const valid = await profile.call('themes.ghostty.validate', { ...request, source })
  expect(valid.validation.valid).toBe(true)
  expect(valid.validation.definition?.terminal?.tokens).toMatchObject({
    'terminal-foreground': '#ffffff',
    'terminal-ansi-1': '#ffeedd',
    'terminal-ansi-255': '#eeeeee',
    'terminal-cursor-text': 'cell-foreground',
    'terminal-selection': 'cell-background',
  })
  expect(valid.validation.diagnostics.filter((item) => item.code === 'duplicate_assignment')).toHaveLength(2)
  expect(valid.validation.diagnostics.filter((item) => item.code === 'ignored_option')).toHaveLength(2)
  expect(
    (await profile.call('themes.ghostty.validate', { ...request, source: 'foreground = fOrEsTgReEn' })).validation
      .definition?.terminal?.tokens['terminal-foreground'],
  ).toBe('#228b22')
  const bad = '# é\nforeground = #abcdef # inline comment\n'
  const invalid = await profile.call('themes.ghostty.validate', { ...request, source: bad })
  expect(invalid.source).toBeNull()
  expect(invalid.preview).toBeNull()
  expect(invalid.validation).toMatchObject({ valid: false, definition: null })
  const diagnostic = invalid.validation.diagnostics.find((item) => item.code === 'invalid_color')!
  expect(
    Buffer.from(bad)
      .subarray(diagnostic.offset, diagnostic.offset + diagnostic.length)
      .toString(),
  ).toBe('#abcdef # inline comment')
  expect(diagnostic).toMatchObject({ line: 2, column: 14 })
  for (const text of [
    'foreground',
    'foreground = #fff\npalette = 256=#fff',
    'foreground = #fff\npalette-generate = true',
    'foreground = #fff\ncursor-color = cell-neither',
    '# no colors',
    'foreground = #fff\n' + '#'.repeat(4095),
    'x'.repeat(256 * 1024 + 1),
  ]) {
    expect(
      (await profile.call('themes.ghostty.validate', { ...request, source: text })).validation.valid,
      text.slice(0, 60),
    ).toBe(false)
  }
  expect(await profile.call('themes.list', {})).toEqual(before)
})

test('CLI and SDK expose the same color-only import report and invalid-data exit status', async ({ profile }) => {
  const file = join(profile.root, 'ghostty.theme')
  const request = {
    source: 'foreground = #abc\npalette = 255=#123456\n',
    id: 'user:cli-ghostty',
    name: 'CLI Ghostty',
    mode: 'light' as const,
    source_name: file,
  }
  await writeFile(file, request.source)
  const sdk = await profile.call('themes.ghostty.validate', request)
  const cli = await profile.cli('themes', 'ghostty-validate', file, request.id, request.name, request.mode)
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(sdk)
  await writeFile(file, 'foreground = invalid')
  const invalid = await profile.cli('themes', 'ghostty-validate', file, request.id, request.name, request.mode)
  expect(invalid.code).toBe(2)
  expect(invalid.json).toEqual(
    await profile.call('themes.ghostty.validate', { ...request, source: 'foreground = invalid' }),
  )
})

test('Warp YAML previews normalize into the shared library and invalid sources stay read-only', async ({ profile }) => {
  const before = await profile.call('themes.list', {})
  const appearance = await profile.call('settings.appearance', {})
  const file = join(profile.root, 'sample.yaml')
  const source =
    "name: Warp sample\ndetails: darker\nbackground: '#abc'\nforeground: '#123456'\ncursor: '#fed'\nterminal_colors:\n  normal:\n    red: '#ff0000'\n  bright:\n    white: '#ededed'\naccent: '#abcdef'\n"
  await writeFile(file, source)
  const report = await profile.call('themes.warp.validate', { source, id: 'user:warp-sample', source_name: file })
  expect(report.validation).toMatchObject({
    valid: true,
    definition: {
      id: 'user:warp-sample',
      name: 'Warp sample',
      mode: 'dark',
      provenance: { kind: 'imported', source: file },
      terminal: {
        tokens: {
          terminal: '#aabbcc',
          'terminal-foreground': '#123456',
          'terminal-cursor': '#ffeedd',
          'terminal-ansi-1': '#ff0000',
          'terminal-ansi-15': '#ededed',
        },
      },
    },
  })
  expect(report.validation.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'unsupported_key', path: '/accent', line: 11 })]),
  )
  expect(report.preview).toMatchObject({ background: { r: 170, g: 187, b: 204 }, foreground: { r: 18, g: 52, b: 86 } })
  const cli = await profile.cli('themes', 'warp-validate', file, 'user:warp-sample')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(report)
  expect(await profile.call('themes.list', {})).toEqual(before)
  expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  expect(await readFile(file, 'utf8')).toBe(source)

  const invalidFile = join(profile.root, 'invalid.yaml')
  await writeFile(invalidFile, 'name: [broken\n')
  const invalidCli = await profile.cli('themes', 'warp-validate', invalidFile, 'user:warp-invalid')
  expect(invalidCli.code).toBe(2)
  expect(JSON.parse(invalidCli.stderr)).toMatchObject({ type: 'warp_theme_validation', validation: { valid: false } })

  const oversizedFile = join(profile.root, 'oversized.yaml')
  await writeFile(oversizedFile, 'name: Warp large\n#' + 'x'.repeat(256 * 1024))
  const oversizedCli = await profile.cli('themes', 'warp-validate', oversizedFile, 'user:warp-large')
  expect(oversizedCli.code).toBe(2)
  expect(oversizedCli.json).toMatchObject({ type: 'error', code: 'invalid_request' })

  const duplicate = await profile.call('themes.warp.validate', {
    source: 'name: One\nname: Two\n',
    id: 'user:duplicate',
    source_name: null,
  })
  expect(duplicate.validation).toMatchObject({ valid: false, definition: null })
  expect(duplicate.validation.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'duplicate_key', line: 2 })]),
  )
  const oversizedForOrdinaryRequests = 'name: [broken\n#' + 'x'.repeat(130 * 1024)
  const malformed = await profile.call('themes.warp.validate', {
    source: oversizedForOrdinaryRequests,
    id: 'user:large-bad',
    source_name: null,
  })
  expect(malformed.validation).toMatchObject({ valid: false, definition: null })
  expect(malformed.validation.diagnostics[0]).toMatchObject({
    code: 'parse_error',
    line: 2,
    column: expect.any(Number),
  })
  expect(await profile.call('themes.list', {})).toEqual(before)
  expect(await profile.call('settings.appearance', {})).toEqual(appearance)
  const oversized = await profile.call('themes.warp.validate', {
    source: 'name: Large\n#' + 'x'.repeat(256 * 1024),
    id: 'user:large',
    source_name: null,
  })
  expect(oversized.validation).toMatchObject({ valid: false, definition: null })
  expect(oversized.validation.diagnostics[0]).toMatchObject({ code: 'source_limit' })
  expect(await profile.call('themes.list', {})).toEqual(before)

  await profile.call('themes.install', { items: [{ source: report.source!, expected_revision: 0 }] })
  const installed = await profile.call('themes.inspect', { id: 'user:warp-sample' })
  expect(installed.theme.definition.provenance.source_digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(installed.theme.definition['x-warp']).toEqual({ source })
})
