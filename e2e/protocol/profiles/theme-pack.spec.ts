import { expect, test } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

test('pack export resolves independent members and checks every captured definition revision', async ({ profile }) => {
  const source = (id: string, mode: 'dark' | 'light') =>
    JSON.stringify({
      format: 'ade-theme',
      version: 1,
      id,
      name: 'Same display name',
      mode,
      provenance: { kind: 'user', author: 'Pack author', license: 'MIT' },
      terminal: {
        defaults: mode === 'light' ? 'ade:chalk' : 'ade:graphite',
        tokens: { 'terminal-ansi-255': '#abcdef' },
      },
    })
  await profile.call('themes.install', {
    items: [
      { source: source('user:pack-dark', 'dark'), expected_revision: 0 },
      { source: source('user:pack-light', 'light'), expected_revision: 0 },
    ],
  })
  const before = await profile.call('settings.appearance', {})
  const exported = await rawReply(profile, {
    op: 'themes.pack.export',
    id: 'user:coordinated',
    name: 'Coordinated fixture',
    items: [
      { id: 'user:pack-dark', expected_revision: 1 },
      { id: 'user:pack-light', expected_revision: 1 },
    ],
  })
  expect(exported.type).toBe('theme_pack_export')
  const request = {
    id: 'user:coordinated',
    name: 'Coordinated fixture',
    items: [
      { id: 'user:pack-dark', expected_revision: 1 },
      { id: 'user:pack-light', expected_revision: 1 },
    ],
  }
  expect(await profile.call('themes.pack.export', request)).toEqual(exported)
  const file = join(profile.root, 'pack-request.json')
  await writeFile(file, JSON.stringify(request))
  const cli = await profile.cli('themes', 'pack-export', file)
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(exported)
  const pack = JSON.parse(exported.source as string)
  expect(pack).toMatchObject({
    format: 'ade-theme-pack',
    version: 1,
    id: 'user:coordinated',
    name: 'Coordinated fixture',
  })
  expect(pack.themes).toHaveLength(2)
  for (const definition of pack.themes) {
    expect(definition.terminal.defaults).toBeNull()
    expect(definition.terminal.tokens['terminal-ansi-255']).toBe('#abcdef')
    expect(Object.keys(definition.terminal.tokens).filter((key) => key.startsWith('terminal-ansi-'))).toHaveLength(256)
    expect((await profile.call('themes.validate', { source: JSON.stringify(definition) })).valid).toBe(true)
  }
  await profile.call('themes.rename', { id: 'user:pack-light', name: 'Changed member', expected_revision: 1 })
  expect(
    await rawReply(profile, {
      op: 'themes.pack.export',
      id: 'user:coordinated',
      name: 'Coordinated fixture',
      items: [
        { id: 'user:pack-dark', expected_revision: 1 },
        { id: 'user:pack-light', expected_revision: 1 },
      ],
    }),
  ).toMatchObject({ code: 'theme_conflict', id: 'user:pack-light', expected: 1, current: 2 })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('pack export rejects ambiguous identities and missing members without mutating the library', async ({
  profile,
}) => {
  const before = await profile.call('themes.list', {})
  expect(await rawReply(profile, { op: 'themes.file.validate', source: 'x'.repeat(4 * 1024 * 1024) })).toMatchObject({
    code: 'invalid_request',
    message: expect.stringContaining('4 MiB'),
  })
  expect(await rawReply(profile, { op: 'themes.unknown', source: 'x'.repeat(256 * 1024) })).toMatchObject({
    code: 'invalid_request',
    message: expect.stringContaining('128 KiB'),
  })
  const request = {
    op: 'themes.pack.export',
    id: 'user:pair',
    name: 'Pair',
    items: [
      { id: 'ade:graphite', expected_revision: 0 },
      { id: 'ade:graphite', expected_revision: 0 },
    ],
  }
  expect(await rawReply(profile, request)).toMatchObject({ type: 'error', message: expect.stringContaining('repeats') })
  expect(await rawReply(profile, { ...request, id: 'unqualified', items: [request.items[0]] })).toMatchObject({
    type: 'error',
    message: expect.stringContaining('identity'),
  })
  expect(await rawReply(profile, { ...request, items: [] })).toMatchObject({
    type: 'error',
    message: expect.stringContaining('1 and 16'),
  })
  expect(await rawReply(profile, { ...request, items: [{ id: 'user:missing', expected_revision: 0 }] })).toMatchObject({
    code: 'theme_not_found',
    id: 'user:missing',
  })
  expect(await profile.call('themes.list', {})).toEqual(before)
})

test('pack validation locates bad member colors and explicit valid subsets install without changing selections', async ({
  profile,
}) => {
  const member = (id: string, color: string) => ({
    format: 'ade-theme',
    version: 1,
    id,
    name: id,
    mode: 'dark',
    provenance: { kind: 'user', author: 'Pack author', license: 'MIT' },
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-foreground': color } },
  })
  const source = `// coordinated source\n${JSON.stringify({ format: 'ade-theme-pack', version: 1, id: 'user:subset', name: 'Subset fixture', themes: [member('user:first', '#AbC'), member('user:invalid', 'invalid'), member('user:ignored', '#112233')] }, null, 2)}`
  const before = await profile.call('settings.appearance', {})
  const report = await rawReply(profile, { op: 'themes.file.validate', source })
  expect(report.type).toBe('theme_file_validation')
  expect(report).toMatchObject({ container_valid: true, pack: { id: 'user:subset', name: 'Subset fixture' } })
  const candidates = report.candidates as Array<{
    source: string
    validation: {
      valid: boolean
      definition: { id: string; pack: unknown }
      diagnostics: Array<{ code: string; offset: number; length: number; path: string }>
    }
  }>
  expect(await profile.call('themes.file.validate', { source })).toEqual(report)
  const file = join(profile.root, 'subset.jsonc')
  await writeFile(file, source)
  const cli = await profile.cli('themes', 'file-validate', file)
  expect(cli.code).toBe(2)
  expect(JSON.parse(cli.stderr)).toEqual(report)
  expect(candidates.map((candidate) => candidate.validation.valid)).toEqual([true, false, true])
  const problem = candidates[1]!.validation.diagnostics.find((diagnostic) => diagnostic.code === 'invalid_color')!
  expect(problem.path).toBe('/themes/1/terminal/tokens/terminal-foreground')
  expect(source.slice(problem.offset, problem.offset + problem.length)).toBe('"invalid"')
  expect(candidates[0]!.validation.definition.pack).toEqual({ id: 'user:subset', name: 'Subset fixture' })
  await profile.call('themes.install', { items: [{ source: candidates[0]!.source, expected_revision: 0 }] })
  expect(
    (await profile.call('themes.list', {})).themes.filter((theme) => !theme.bundled).map((theme) => theme.id),
  ).toEqual(['user:first'])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await profile.restartDaemon('kill')
  expect((await profile.call('themes.inspect', { id: 'user:first' })).theme.definition.pack).toEqual({
    id: 'user:subset',
    name: 'Subset fixture',
  })
})

test('pack headers reject ambiguity and unsupported versions before any member can be accepted', async ({
  profile,
}) => {
  const member = {
    format: 'ade-theme',
    version: 1,
    id: 'user:one',
    name: 'One',
    mode: 'dark',
    provenance: { kind: 'user' },
    terminal: { defaults: 'ade:graphite', tokens: {} },
  }
  const pack = { format: 'ade-theme-pack', version: 1, id: 'user:pair', name: 'Café', themes: [member] }
  const before = await profile.call('themes.list', {})
  for (const [source, code, path] of [
    [JSON.stringify({ ...pack, version: 2 }), 'unsupported_version', '/version'],
    [JSON.stringify({ ...pack, themes: [member, member] }), 'duplicate_theme_id', '/themes/1/id'],
    [JSON.stringify({ ...pack, themes: [] }), 'member_limit', '/themes'],
    [JSON.stringify({ ...pack, name: '' }), 'invalid_pack_identity', '/name'],
    [JSON.stringify({ ...pack, script: 'must never execute' }), 'unsupported_pack_field', '/script'],
    [JSON.stringify(pack).replace('"version":1', '"version":1,"version":2'), 'duplicate_key', '/version'],
    [' '.repeat(512 * 1024 + 1), 'size_limit', ''],
    ['['.repeat(65) + '0' + ']'.repeat(65), 'depth_limit', ''],
  ]) {
    const report = await profile.call('themes.file.validate', { source })
    expect(report, code).toMatchObject({ container_valid: false, candidates: [] })
    expect(report.diagnostics, code).toEqual(expect.arrayContaining([expect.objectContaining({ code, path })]))
  }
  const source = JSON.stringify(
    {
      ...pack,
      themes: [
        member,
        { ...member, id: 'user:two', terminal: { defaults: 'ade:graphite', tokens: { 'terminal-foreground': 'bad' } } },
      ],
    },
    null,
    2,
  )
  const report = await profile.call('themes.file.validate', { source })
  const problem = report.candidates[1]!.validation.diagnostics.find(
    (diagnostic) => diagnostic.code === 'invalid_color',
  )!
  expect(
    Buffer.from(source)
      .subarray(problem.offset, problem.offset + problem.length)
      .toString(),
  ).toBe('"bad"')
  expect(report.candidates[0]!.validation.valid).toBe(true)
  expect(await profile.call('themes.list', {})).toEqual(before)
})

test('pack normalization enforces the individual definition bound after adding retained identity', async ({
  profile,
}) => {
  const exported = await profile.call('themes.export', { id: 'ade:graphite', expected_revision: 0 })
  const definition = { ...JSON.parse(exported.source), inert_fixture: '' }
  definition.inert_fixture = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(definition)))
  const source = JSON.stringify(definition)
  expect(Buffer.byteLength(source)).toBe(256 * 1024)
  expect((await profile.call('themes.validate', { source })).valid).toBe(true)
  const report = await profile.call('themes.file.validate', {
    source: JSON.stringify({
      format: 'ade-theme-pack',
      version: 1,
      id: 'user:bounded',
      name: 'Bounded',
      themes: [definition],
    }),
  })
  expect(report.container_valid).toBe(true)
  expect(report.candidates[0]!.validation).toMatchObject({ valid: false, definition: null })
  expect(report.candidates[0]!.validation.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'normalized_size_limit', path: '/themes/0' })]),
  )
})

test('CLI pack installation accepts only named valid members and stale replacement rolls back the whole set', async ({
  profile,
}) => {
  const member = (id: string, color: string) => ({
    format: 'ade-theme',
    version: 1,
    id,
    name: id,
    mode: 'dark',
    provenance: { kind: 'user' },
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-foreground': color } },
  })
  const file = join(profile.root, 'cli-pack.jsonc')
  await writeFile(
    file,
    `// pack input\n${JSON.stringify({ format: 'ade-theme-pack', version: 1, id: 'user:cli-pack', name: 'CLI pack', themes: [member('user:chosen', '#abcdef'), member('user:ignored', '#123456'), member('user:invalid', 'bad')] })}`,
  )
  const before = await profile.call('settings.appearance', {})
  const installed = await profile.cli('themes', 'pack-install', file, 'user:chosen', '0')
  expect(installed.code, installed.stderr).toBe(0)
  expect((await profile.call('themes.inspect', { id: 'user:chosen' })).theme.definition.pack).toEqual({
    id: 'user:cli-pack',
    name: 'CLI pack',
  })
  await profile.call('themes.rename', { id: 'user:chosen', name: 'External revision', expected_revision: 1 })
  const library = await profile.call('themes.list', {})
  for (const words of [
    ['user:invalid', '0'],
    ['user:missing', '0'],
    ['user:chosen', '1', 'user:chosen', '1'],
    ['user:chosen', '0', 'user:ignored', '0'],
  ]) {
    const refused = await profile.cli('themes', 'pack-install', file, ...words)
    expect(refused.code, JSON.stringify(words)).not.toBe(0)
    expect(JSON.parse(refused.stderr).code).toBeTruthy()
    expect(await profile.call('themes.list', {})).toEqual(library)
  }
  const replaced = await profile.cli('themes', 'pack-install', file, 'user:chosen', '2', 'user:ignored', '0')
  expect(replaced.code, replaced.stderr).toBe(0)
  expect((await profile.call('themes.inspect', { id: 'user:chosen' })).theme.revision).toBe(3)
  expect((await profile.call('themes.inspect', { id: 'user:ignored' })).theme.revision).toBe(3)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('CLI and SDK pack files preserve resolved values and require explicit overwrite before publication', async ({
  profile,
}) => {
  const { readFile, readdir, stat } = await import('node:fs/promises')
  const { clientSdk } = await import('../fixtures/terminals')
  const request = {
    id: 'user:exported',
    name: 'Exported pair',
    items: [
      { id: 'ade:graphite', expected_revision: 0 },
      { id: 'ade:chalk', expected_revision: 0 },
    ],
  }
  const input = join(profile.root, 'request.json')
  const output = join(profile.root, 'pack.json')
  await writeFile(input, JSON.stringify(request))
  const before = await profile.call('settings.appearance', {})
  const exported = await profile.call('themes.pack.export', request)
  const result = await profile.cli('themes', 'pack-export', input, '--output', output)
  expect(result.code, result.stderr).toBe(0)
  expect(result.json).toMatchObject({
    type: 'theme_pack_file_export',
    path: output,
    pack_id: 'user:exported',
    revisions: { 'ade:graphite': 0, 'ade:chalk': 0 },
  })
  expect(await readFile(output, 'utf8')).toBe(exported.source)
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  const report = await profile.call('themes.file.validate', { source: await readFile(output, 'utf8') })
  expect(report.container_valid).toBe(true)
  expect(report.candidates.map((candidate) => candidate.validation.valid)).toEqual([true, true])
  expect(report.candidates.map((candidate) => candidate.validation.definition)).toEqual(
    JSON.parse(exported.source).themes,
  )
  await writeFile(output, 'existing content')
  const refused = await profile.cli('themes', 'pack-export', input, '--output', output)
  expect(JSON.parse(refused.stderr).code).toBe('conflict')
  expect(await readFile(output, 'utf8')).toBe('existing content')
  const replaced = await profile.cli('themes', 'pack-export', input, '--output', output, '--overwrite')
  expect(replaced.code, replaced.stderr).toBe(0)
  const { writeThemePackExport } = await clientSdk()
  const sdkOutput = join(profile.root, 'sdk-pack.json')
  const receipt = await writeThemePackExport(sdkOutput, exported)
  expect(receipt.sha256).toBe(result.json!.sha256)
  expect(await readFile(sdkOutput, 'utf8')).toBe(await readFile(output, 'utf8'))
  await writeFile(input, JSON.stringify({ ...request, items: [{ id: 'ade:graphite', expected_revision: 1 }] }))
  const stale = await profile.cli('themes', 'pack-export', input, '--output', output, '--overwrite')
  expect(JSON.parse(stale.stderr).code).toBe('theme_conflict')
  expect(await readFile(output, 'utf8')).toBe(exported.source)
  expect((await readdir(profile.root)).filter((name) => name.startsWith('.ade-theme-'))).toEqual([])
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})
