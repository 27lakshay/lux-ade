import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { clientSdk } from '../fixtures/terminals'

test('theme file export requires explicit overwrite and round-trips the inspected definition', async ({ profile }) => {
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:file',
    name: 'Export fixture',
    mode: 'dark',
    provenance: { kind: 'user', author: 'Fixture author', license: 'MIT' },
    terminal: {
      defaults: 'ade:graphite',
      tokens: { 'terminal-ansi-255': '#abcdef', 'terminal-selection': '#12345680' },
    },
  })
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  const before = await profile.call('settings.appearance', {})
  const folder = join(profile.root, 'exports')
  await mkdir(folder)
  const file = join(folder, 'theme.json')
  const result = await profile.cli('themes', 'export', 'user:file', '1', '--output', file)
  expect(result.code, result.stderr).toBe(0)
  expect(result.json).toMatchObject({ type: 'theme_file_export', path: file, theme_id: 'user:file', revision: 1 })
  const exported = await readFile(file, 'utf8')
  expect((await profile.call('themes.validate', { source: exported })).definition).toEqual(
    (await profile.call('themes.inspect', { id: 'user:file' })).theme.definition,
  )
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  await writeFile(file, 'existing content')
  const refused = await profile.cli('themes', 'export', 'user:file', '1', '--output', file)
  expect(refused.code).not.toBe(0)
  expect(refused.stderr).toContain('already exists')
  expect(JSON.parse(refused.stderr).code).toBe('conflict')
  expect(await readFile(file, 'utf8')).toBe('existing content')
  const replaced = await profile.cli('themes', 'export', 'user:file', '1', '--output', file, '--overwrite')
  expect(replaced.code, replaced.stderr).toBe(0)
  expect(await readFile(file, 'utf8')).toBe(exported)
  await profile.call('themes.rename', { id: 'user:file', name: 'New name', expected_revision: 1 })
  const stale = await profile.cli('themes', 'export', 'user:file', '1', '--output', file, '--overwrite')
  expect(stale.code).not.toBe(0)
  expect(stale.stderr).toContain('revision')
  expect(await readFile(file, 'utf8')).toBe(exported)
  expect(await readdir(folder)).toEqual(['theme.json'])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('SDK file publication is exclusive under concurrent exports and matches CLI bytes', async ({ profile }) => {
  const { ThemeFileExportError, writeThemeExport } = await clientSdk()
  const dark = await profile.call('themes.export', { id: 'ade:graphite', expected_revision: 0 })
  const light = await profile.call('themes.export', { id: 'ade:chalk', expected_revision: 0 })
  const file = join(profile.root, 'contended.json')
  const results = await Promise.allSettled([writeThemeExport(file, dark), writeThemeExport(file, light)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  const refused = results.find((result) => result.status === 'rejected')!
  if (refused.status !== 'rejected') throw new Error('No refused publication')
  expect(refused.reason).toBeInstanceOf(ThemeFileExportError)
  expect(refused.reason.code).toBe('conflict')
  const winner = results.find((result) => result.status === 'fulfilled')!
  if (winner.status !== 'fulfilled') throw new Error('No successful publication')
  expect(JSON.parse(await readFile(file, 'utf8')).id).toBe(winner.value.theme_id)
  const cliFile = join(profile.root, 'cli.json')
  const cli = await profile.cli('themes', 'export', winner.value.theme_id, '0', '--output', cliFile)
  expect(cli.code, cli.stderr).toBe(0)
  expect(await readFile(cliFile, 'utf8')).toBe(await readFile(file, 'utf8'))
  let publishing = true
  let reads = 0
  await Promise.all([
    (async () => {
      while (publishing) {
        expect([dark.source, light.source]).toContain(await readFile(file, 'utf8'))
        reads++
      }
    })(),
    (async () => {
      try {
        for (let index = 0; index < 20; index++) await writeThemeExport(file, index % 2 ? dark : light, true)
      } finally {
        publishing = false
      }
    })(),
  ])
  expect(reads).toBeGreaterThan(0)
  expect((await readdir(profile.root)).filter((name) => name.startsWith('.ade-theme-'))).toEqual([])
})

test('failed file publication preserves the target and symlink replacement never writes through it', async ({
  profile,
}) => {
  const folder = join(profile.root, 'exports')
  await mkdir(folder)
  const directory = join(folder, 'target.json')
  await mkdir(directory)
  const failed = await profile.cli('themes', 'export', 'ade:graphite', '0', '--output', directory, '--overwrite')
  expect(failed.code).not.toBe(0)
  expect(JSON.parse(failed.stderr).code).toBe('unavailable')
  expect((await stat(directory)).isDirectory()).toBe(true)
  expect(await readdir(folder)).toEqual(['target.json'])
  const original = join(folder, 'original.json')
  const link = join(folder, 'link.json')
  await writeFile(original, 'original content')
  await symlink(original, link)
  const blocked = await profile.cli('themes', 'export', 'ade:graphite', '0', '--output', link)
  expect(blocked.code).not.toBe(0)
  const replaced = await profile.cli('themes', 'export', 'ade:graphite', '0', '--output', link, '--overwrite')
  expect(replaced.code, replaced.stderr).toBe(0)
  expect(await readFile(original, 'utf8')).toBe('original content')
  expect(JSON.parse(await readFile(link, 'utf8')).id).toBe('ade:graphite')
  expect((await readdir(folder)).sort()).toEqual(['link.json', 'original.json', 'target.json'])
})

test('a maximum-size canonical definition remains importable after writing the exported file', async ({ profile }) => {
  const exported = await profile.call('themes.export', { id: 'ade:graphite', expected_revision: 0 })
  const definition = { ...JSON.parse(exported.source), id: 'user:boundary', inert_fixture: '' }
  definition.provenance.kind = 'user'
  definition.inert_fixture = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(definition)))
  const source = JSON.stringify(definition)
  expect((await profile.call('themes.validate', { source })).valid).toBe(true)
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  const file = join(profile.root, 'boundary.json')
  const result = await profile.cli('themes', 'export', 'user:boundary', '1', '--output', file)
  expect(result.code, result.stderr).toBe(0)
  const written = await readFile(file, 'utf8')
  expect(Buffer.byteLength(written)).toBe(256 * 1024)
  expect((await profile.call('themes.file.validate', { source: written })).candidates[0]!.validation.valid).toBe(true)
})
