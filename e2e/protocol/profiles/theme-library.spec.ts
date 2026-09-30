import type { ThemeLibrary } from '../../../packages/contracts/dist/index.js'
import { DatabaseSync } from 'node:sqlite'
import { subscribeFeed } from '../fixtures/feed'
import { rawReply } from '../fixtures/raw-reply'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'

function source(id = 'user:sample', name = 'Sample') {
  return JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id,
    name,
    mode: 'dark',
    provenance: {
      kind: 'imported',
      source: 'fixture.jsonc',
      source_digest: 'sha256:fixture',
      author: 'Fixture author',
      license: 'MIT',
    },
    app: { defaults: 'ade:graphite', tokens: { primary: '#AbC' } },
  })
}

test('accepted definitions install without selecting, survive source removal and restart, and preserve provenance', async ({
  profile,
}) => {
  const before = await profile.call('settings.appearance', {})
  const text = source()
  const file = join(profile.root, 'source.jsonc')
  await writeFile(file, text)
  const installed = await profile.call('themes.install', { items: [{ source: text, expected_revision: 0 }] })
  expect(installed).toMatchObject({ type: 'theme_installation', committed: true, changed: true, revision: 1 })
  await rm(file)
  const listed = await profile.call('themes.list', {})
  expect(listed).toMatchObject({ type: 'theme_library', revision: 1 })
  expect(listed.themes).toContainEqual(
    expect.objectContaining({ id: 'user:sample', name: 'Sample', revision: 1, bundled: false }),
  )
  const inspected = await profile.call('themes.inspect', { id: 'user:sample' })
  expect(inspected).toMatchObject({
    type: 'theme_record',
    theme: {
      source: text,
      revision: 1,
      definition: {
        id: 'user:sample',
        app: { tokens: { primary: '#aabbcc' } },
        provenance: {
          source: 'fixture.jsonc',
          source_digest: 'sha256:fixture',
          author: 'Fixture author',
          license: 'MIT',
        },
      },
    },
  })
  expect(await profile.call('settings.appearance', {})).toEqual(before)
  await profile.restartDaemon('kill')
  expect(await profile.call('themes.inspect', { id: 'user:sample' })).toEqual(inspected)
  expect(await profile.call('settings.appearance', {})).toEqual(before)
})

test('accepted batches are atomic, replacements check stable ID revisions and replay changes nothing', async ({
  profile,
}) => {
  const one = source('user:one', 'Same name')
  const two = source('user:two', 'Same name')
  const file = join(profile.root, 'one.jsonc')
  const second = join(profile.root, 'two.jsonc')
  await writeFile(file, one)
  await writeFile(second, two)
  const invalid = await profile.cli('themes', 'install', file, '0', second, '1')
  expect(invalid.code).not.toBe(0)
  expect(invalid.json).toMatchObject({ type: 'error', code: 'theme_conflict', id: 'user:two', expected: 1, current: 0 })
  expect((await profile.call('themes.list', {})).revision).toBe(0)
  const accepted = await profile.cli('themes', 'install', file, '0', second, '0')
  expect(accepted.code, accepted.stderr).toBe(0)
  expect(accepted.json).toMatchObject({ committed: true, changed: true, revision: 1 })
  const replay = await profile.call('themes.install', {
    items: [
      { source: one, expected_revision: 0 },
      { source: two, expected_revision: 0 },
    ],
  })
  expect(replay).toMatchObject({ committed: true, changed: false, revision: 1 })
  const renamed = await profile.cli('themes', 'rename', 'user:one', 'Renamed', '1')
  expect(renamed.code, renamed.stderr).toBe(0)
  expect(renamed.json).toMatchObject({ committed: true, changed: true, revision: 2 })
  const inspected = await profile.call('themes.inspect', { id: 'user:one' })
  expect(inspected.theme.definition).toMatchObject({ id: 'user:one', name: 'Renamed' })
  const stale = await profile.cli('themes', 'install', file, '1')
  expect(stale.code).not.toBe(0)
  expect(stale.json).toMatchObject({ code: 'theme_conflict', id: 'user:one', expected: 1, current: 2 })
  const validation = await profile.call('themes.validate', { source: one })
  expect(validation.target).toMatchObject({ id: 'user:one', name: 'Renamed', revision: 2 })
  await writeFile(second, '{')
  const malformed = await profile.cli('themes', 'install', file, '2', second, '1')
  expect(malformed.code).toBe(2)
  expect(malformed.json).toMatchObject({
    committed: false,
    changed: false,
    revision: 2,
    items: [expect.objectContaining({ index: 0, valid: true }), expect.objectContaining({ index: 1, valid: false })],
  })
  expect(await profile.call('themes.inspect', { id: 'user:one' })).toEqual(inspected)
})

test('bundled definitions export complete equivalent colors and require a distinct custom copy', async ({
  profile,
}) => {
  const bundled = await profile.call('themes.inspect', { id: 'ade:graphite' })
  expect(bundled.theme).toMatchObject({
    revision: 0,
    definition: {
      provenance: { kind: 'bundled' },
      app: { tokens: { base: '#101113' } },
      terminal: { tokens: { 'terminal-ansi-0': '#a9b0bc', 'terminal-ansi-255': '#eeeeee' } },
    },
  })
  const exported = await profile.cli('themes', 'export', 'ade:graphite', '0')
  expect(exported.code, exported.stderr).toBe(0)
  const normalized = await profile.call('themes.validate', { source: String(exported.json!.source) })
  expect(normalized.definition).toEqual(bundled.theme.definition)
  const prohibited = await rawReply(profile, {
    op: 'themes.install',
    items: [{ source: exported.json!.source, expected_revision: 0 }],
  })
  expect(prohibited).toMatchObject({ type: 'error', code: 'theme_protected', id: 'ade:graphite' })
  const copy = {
    ...normalized.definition!,
    id: 'user:graphite-copy',
    provenance: { ...normalized.definition!.provenance, kind: 'user' },
  }
  const installed = await profile.call('themes.install', {
    items: [{ source: JSON.stringify(copy), expected_revision: 0 }],
  })
  expect(installed).toMatchObject({ committed: true, revision: 1 })
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(bundled)
  const roundTrip = await profile.call('themes.export', { id: copy.id, expected_revision: 1 })
  expect((await profile.call('themes.validate', { source: roundTrip.source })).definition).toEqual(copy)
})

test('persistence failure rolls back a whole batch and retry publishes one durable library revision', async ({
  profile,
}) => {
  const before = await profile.call('themes.list', {})
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  const items = [
    { source: source('user:first'), expected_revision: 0 },
    { source: source('user:second'), expected_revision: 0 },
  ]
  try {
    database.exec(
      "CREATE TRIGGER fail_theme_save BEFORE INSERT ON theme_definitions WHEN NEW.id='user:second' BEGIN SELECT RAISE(ABORT, 'theme persistence failure'); END",
    )
    const failed = await rawReply(profile, { op: 'themes.install', items })
    expect(failed.type).toBe('error')
    expect(failed.message).toContain('theme persistence failure')
    expect(await profile.call('themes.list', {})).toEqual(before)
    database.exec('DROP TRIGGER fail_theme_save')
    expect(await profile.call('themes.install', { items })).toMatchObject({
      committed: true,
      changed: true,
      revision: 1,
    })
    await feed.waitFor((frame) => frame.type === 'theme_library_changed' && frame.library_revision === 1)
    expect(feed.frames.filter((frame) => frame.type === 'theme_library_changed')).toHaveLength(1)
    expect(await profile.call('themes.install', { items })).toMatchObject({ changed: false, revision: 1 })
  } finally {
    database.close()
    feed.stop()
  }
})

test('library pagination lists duplicate names by stable ID without losing entries', async ({ profile }) => {
  const items = Array.from({ length: 16 }, (_, index) => ({
    source: source(`user:item-${String(index).padStart(2, '0')}`, 'Same name'),
    expected_revision: 0,
  }))
  await profile.call('themes.install', { items })
  const ids: string[] = []
  let afterId: string | null = null
  do {
    const page: ThemeLibrary = await profile.call('themes.list', { after_id: afterId })
    expect(page.themes.length).toBeLessThanOrEqual(16)
    ids.push(...page.themes.map((theme) => theme.id))
    afterId = page.next_id ?? null
  } while (afterId)
  expect(ids).toHaveLength(28)
  expect(new Set(ids).size).toBe(28)
  expect(ids.filter((id) => id.startsWith('user:'))).toEqual(items.map((item) => JSON.parse(item.source).id))
})

test('unsaved theme draft preview resolves supported sections without changing committed state', async ({
  profile,
}) => {
  const beforeLibrary = await profile.call('themes.list', {})
  const beforeSettings = await profile.call('settings.appearance', {})
  const draft = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:draft-preview',
    name: 'Draft preview',
    mode: 'dark',
    provenance: { kind: 'user', source: null, source_version: null, source_digest: null, author: null, license: null },
    app: { defaults: 'ade:graphite', tokens: { primary: '#123456' } },
    terminal: { defaults: 'ade:graphite', tokens: { 'terminal-ansi-2': '#234567' } },
    syntax: { defaults: 'ade:graphite', tokens: { 'syntax-keyword': '#345678' } },
  })
  const preview = await profile.call('themes.draft.preview', { source: draft })
  expect(preview).toMatchObject({
    type: 'theme_draft_preview',
    definition: { id: 'user:draft-preview', mode: 'dark' },
    app: { tokens: { primary: '#123456' } },
    terminal: { palette: expect.arrayContaining([expect.objectContaining({ r: 35, g: 69, b: 103 })]) },
    syntax: { tokens: { 'syntax-keyword': '#345678' } },
    light: { app: { id: 'ade:chalk' }, syntax: { id: 'ade:chalk' } },
    dark: { app: { id: 'user:draft-preview', tokens: { primary: '#123456' } }, syntax: { id: 'user:draft-preview' } },
    valid: true,
  })
  const invalid = draft.replace('#123456', 'url(javascript:alert(1))')
  const invalidPreview = await profile.call('themes.draft.preview', { source: invalid })
  expect(invalidPreview).toMatchObject({
    valid: false,
    app: null,
    light: { app: { id: 'ade:chalk' } },
    dark: { app: { id: 'ade:graphite' } },
    diagnostics: [expect.objectContaining({ severity: 'error', code: 'invalid_color' })],
  })
  expect((await profile.call('themes.list', {})).revision).toBe(beforeLibrary.revision)
  expect(await profile.call('themes.inspect', { id: 'user:draft-preview' }).catch(() => null)).toBeNull()
  expect(await profile.call('settings.appearance', {})).toEqual(beforeSettings)
})

test('competing replacements accept one current revision and keep another profile isolated', async ({
  ade,
  profile,
}) => {
  const other = await ade.profile()
  const otherBefore = await other.call('themes.list', {})
  await profile.call('themes.install', { items: [{ source: source(), expected_revision: 0 }] })
  const replies = await Promise.all([
    rawReply(profile, {
      op: 'themes.install',
      items: [{ source: source('user:sample', 'First choice'), expected_revision: 1 }],
    }),
    rawReply(profile, {
      op: 'themes.install',
      items: [{ source: source('user:sample', 'Second choice'), expected_revision: 1 }],
    }),
  ])
  expect(replies.filter((reply) => reply.type === 'theme_installation')).toHaveLength(1)
  expect(replies.find((reply) => reply.type === 'error')).toMatchObject({
    code: 'theme_conflict',
    id: 'user:sample',
    expected: 1,
    current: 2,
  })
  const inspected = await profile.call('themes.inspect', { id: 'user:sample' })
  expect(inspected.theme.revision).toBe(2)
  expect(['First choice', 'Second choice']).toContain(inspected.theme.definition.name)
  expect(await other.call('themes.list', {})).toEqual(otherBefore)
})

test('compact canonical export round trips accepted definitions whose pretty representation exceeds the source limit', async ({
  profile,
}) => {
  const data = JSON.parse(source('user:large-extension'))
  data.extension = Array.from({ length: 45000 }, () => 0)
  const text = JSON.stringify(data)
  expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
  expect(Buffer.byteLength(JSON.stringify(data, null, 2))).toBeGreaterThan(256 * 1024)
  expect(await profile.call('themes.install', { items: [{ source: text, expected_revision: 0 }] })).toMatchObject({
    committed: true,
  })
  const exported = await profile.call('themes.export', { id: data.id, expected_revision: 1 })
  expect(Buffer.byteLength(exported.source)).toBeLessThan(256 * 1024)
  const imported = await profile.call('themes.validate', { source: exported.source })
  expect(imported.valid).toBe(true)
  const original = await profile.call('themes.inspect', { id: data.id })
  expect(imported.definition).toEqual(original.theme.definition)
  expect(
    await profile.call('themes.rename', { id: data.id, name: 'Renamed large definition', expected_revision: 1 }),
  ).toMatchObject({ committed: true, revision: 2 })
})
