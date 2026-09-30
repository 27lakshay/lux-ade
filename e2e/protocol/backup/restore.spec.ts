// F050, R014, F059 and D15: a live profile is backed up while it keeps
// working, the bundle is inspected, and a restore into a fresh profile is
// read back through the public protocol.
import { access, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, turnReply } from '../fixtures'
import { control, spawnControl } from '../fixtures/control'
import {
  copyBundle,
  createBackup,
  pixel,
  pluginId,
  readManifest,
  restoreIntoNewProfile,
  rewriteDatabase,
  seed,
  skillName,
  stages,
} from './helpers'

test('backs up a live profile during writes and restores conversations, attachments, plugins, skills and accounts', async ({
  ade,
  profile,
}) => {
  test.setTimeout(120_000)
  const seeded = await seed(ade, profile)

  // Hold the online copy of sessions.sqlite part-way and keep writing to the
  // profile meanwhile. The daemon must keep serving, and the bundle must be
  // one consistent snapshot.
  const signal = join(ade.root, 'backup-active')
  const release = join(ade.root, 'backup-release')
  const bundle = join(ade.root, 'bundle')
  const running = await spawnControl(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle], {
    env: {
      ADE_E2E_BACKUP_PAUSE_ENABLED: '1',
      ADE_E2E_BACKUP_PAUSE_SIGNAL: signal,
      ADE_E2E_BACKUP_PAUSE_RELEASE: release,
    },
  })
  await expect
    .poll(() =>
      access(signal).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true)
  const during = await profile.call('attachment.put', {
    conversation_id: seeded.conversationId,
    request_id: 'during-backup',
    name: 'during.png',
    data: pixel,
  })
  await profile.call('draft.save', {
    conversation_id: seeded.conversationId,
    window_id: 'backup-window',
    revision: 2,
    text: 'draft saved while the backup ran',
    attachments: [during.attachment],
  })
  await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'during',
    value: { text: 'written while the backup ran' },
    expected_revision: 0,
  })
  expect(await readdir(ade.root)).not.toContain('bundle')
  await writeFile(release, '')
  const created = await running.done
  expect(created.code, created.stderr).toBe(0)

  // Inspect verifies the bundle and discloses what it leaves out.
  const inspected = await control(ade, ['backup', 'inspect', '--backup', bundle])
  expect(inspected.code, inspected.stderr).toBe(0)
  const manifest = inspected.json!.manifest as Awaited<ReturnType<typeof readManifest>>
  expect(manifest.format_version).toBe(7)
  expect(manifest.entries.map((entry) => entry.path)).toEqual(
    expect.arrayContaining(['sessions.sqlite', 'sessions.plugins.sqlite3', 'sessions.plugins/artifacts']),
  )
  expect(manifest.excluded.join('\n')).toMatch(/provider-native homes and credentials/)
  expect(manifest.excluded.join('\n')).toMatch(/plugin-private files/)
  expect(manifest.coverage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ store: 'sessions.sqlite#history_index', disposition: 'rebuilt' }),
      expect.objectContaining({ store: 'sessions.plugins.sqlite3', disposition: 'backed_up' }),
      expect.objectContaining({ store: 'sessions.plugins/artifacts', disposition: 'backed_up' }),
    ]),
  )
  const artifacts = manifest.entries.find((entry) => entry.path === 'sessions.plugins/artifacts')!
  // One hash per artifact file; the helper script keeps its executable bit.
  expect(artifacts.files!.map((file) => file.path.split('/').slice(2).join('/')).sort()).toEqual([
    'ade-plugin.json',
    'dist/tool.sh',
    'dist/ui.js',
  ])
  expect(artifacts.files!.find((file) => file.path.endsWith('dist/tool.sh'))).toMatchObject({ executable: true })
  expect(await readdir(bundle)).not.toContain('provider-accounts')
  expect(await stages(ade.root)).toEqual([])

  const restored = await restoreIntoNewProfile(ade, bundle)
  expect(restored.hello.runtime_instance).not.toBe(profile.hello.runtime_instance)

  // Conversation, message and draft attachments.
  const snapshot = await restored.call('conversation.get', { conversation_id: seeded.conversationId })
  expect(snapshot.messages.map((message) => JSON.stringify(message)).join('\n')).toContain(turnReply.codex)
  const attachment = await restored.call('attachment.inspect', {
    conversation_id: seeded.conversationId,
    attachment_id: seeded.attachmentId,
  })
  expect(attachment.sha256).toBe(seeded.attachmentSha)
  const draft = await restored.call('draft.get', { conversation_id: seeded.conversationId, window_id: 'backup-window' })
  // The draft is the one revision or the other, never a mix: its attachment always resolves.
  expect([1, 2]).toContain(draft.draft?.revision)
  for (const item of draft.draft?.attachments ?? []) {
    const copy = await restored.call('attachment.inspect', {
      conversation_id: seeded.conversationId,
      attachment_id: item.id,
    })
    expect(copy.attachment.size).toBe(item.size)
  }
  if (draft.draft?.revision === 2) {
    expect((draft.draft.attachments ?? []).map((item) => item.id)).toEqual([during.attachment.id])
  }

  // The plugin comes back enabled and active, from the restored profile's own artifact.
  const plugin = (await restored.call('plugin.inspect', { plugin_id: pluginId })).plugin
  expect(plugin).toMatchObject({ status: 'enabled', artifact_digest: seeded.pluginDigest })
  expect(await realpath(plugin.artifact_path)).toContain(await realpath(restored.dataDirectory))
  await expect
    .poll(async () => (await restored.call('plugin.inspect', { plugin_id: pluginId })).plugin.activation)
    .not.toBeNull()
  expect(
    (await restored.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'first' })).record,
  ).toMatchObject({ value: { text: 'kept by backup' } })
  const settings = await restored.call('plugin.setting.list', { plugin_id: pluginId })
  expect(settings.settings).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'wrap', value: true })]))

  // The skill bundle and its blobs.
  const skills = await restored.call('skill.list', {})
  expect(skills.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: skillName, content_hash: seeded.skillHash })]),
  )
  expect((await restored.call('skill.inspect', { name: skillName })).skill.file_count).toBe(2)

  // Accounts come back unverified, pointing at the restored profile, without the credential file.
  const accounts = await restored.call('account.list', {})
  const account = accounts.accounts.find((candidate) => candidate.id === seeded.accountId)
  expect(account).toMatchObject({ state: 'unverified' })
  expect(await realpath(account!.native_home)).toContain(await realpath(restored.dataDirectory))
  expect(await readdir(account!.native_home)).not.toContain('auth.json')

  // The source kept working throughout and is still its own profile.
  const source = await profile.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'during' })
  expect(source.record).toMatchObject({ value: { text: 'written while the backup ran' } })
})

test('restores custom appearance definitions and supported preferences into an isolated profile', async ({
  ade,
  profile,
}) => {
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:backup-appearance',
    name: 'Backup appearance',
    mode: 'dark',
    provenance: { kind: 'user', author: 'Local theme author', license: 'MIT' },
    app: { defaults: 'ade:graphite', tokens: { primary: '#123456' } },
    terminal: {
      defaults: 'ade:graphite',
      tokens: { 'terminal-foreground': '#654321', 'terminal-ansi-255': '#abcdef' },
    },
    syntax: { defaults: 'ade:graphite', tokens: { 'syntax-keyword': '#345678' } },
  })
  const sourceFile = join(profile.root, 'backup-appearance.json')
  await writeFile(sourceFile, source)
  const installed = await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  expect(installed).toMatchObject({ committed: true, changed: true })
  await profile.call('settings.set', {
    appearance: 'dark',
    app_dark_theme: 'user:backup-appearance',
    terminal_binding: { kind: 'fixed', theme_id: 'user:backup-appearance' },
    syntax_binding: { kind: 'fixed', theme_id: 'user:backup-appearance' },
    terminal_color_overrides: {
      cursor_text: { r: 18, g: 52, b: 86 },
      selection_foreground: { r: 101, g: 67, b: 33 },
      selection_background: { r: 171, g: 205, b: 239 },
    },
    terminal_minimum_contrast: 4.5,
    terminal_bold_color: { r: 52, g: 86, b: 120 },
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
    high_contrast: 'on',
    reduced_transparency: 'off',
    differentiate_without_color: 'on',
    reduced_motion: 'on',
  })
  const expectedSettings = await profile.call('settings.get', {})
  const expectedAppearance = await profile.call('settings.appearance', {})
  const expectedDefinition = await profile.call('themes.inspect', { id: 'user:backup-appearance' })
  expect(expectedDefinition.theme.definition.provenance).toMatchObject({
    kind: 'user',
    author: 'Local theme author',
    license: 'MIT',
  })
  await rm(sourceFile)

  const { path: bundle, result } = await createBackup(ade, profile, 'appearance')
  expect(result.code, result.stderr).toBe(0)
  const isolated = await ade.profile()
  const isolatedSettings = await isolated.call('settings.get', {})
  const isolatedAppearance = await isolated.call('settings.appearance', {})
  expect(isolatedSettings.settings.app_dark_theme).not.toBe('user:backup-appearance')
  expect(isolatedSettings.settings.terminal_binding).toEqual({ kind: 'follow_app' })
  expect(isolatedSettings.settings.high_contrast).not.toBe('on')

  const restored = await restoreIntoNewProfile(ade, bundle)
  const actualSettings = await restored.call('settings.get', {})
  expect(actualSettings.settings).toEqual(expectedSettings.settings)
  expect(await restored.call('themes.inspect', { id: 'user:backup-appearance' })).toEqual(expectedDefinition)
  const actualAppearance = await restored.call('settings.appearance', {})
  expect(actualAppearance.theme_id).toBe('user:backup-appearance')
  expect(actualAppearance.tokens.primary).toBe('#123456')
  expect(actualAppearance.syntax.palette).toMatchObject({
    id: 'user:backup-appearance',
    tokens: { 'syntax-keyword': '#345678' },
  })
  expect(actualAppearance.terminal.palette[255]).toEqual({ r: 171, g: 205, b: 239 })
  expect(actualAppearance.terminal).toMatchObject({
    foreground: { r: 101, g: 67, b: 33 },
    cursor_text: { r: 18, g: 52, b: 86 },
    selection_foreground: { r: 101, g: 67, b: 33 },
    selection_background: { r: 171, g: 205, b: 239 },
    minimum_contrast: 4.5,
    bold_color: { r: 52, g: 86, b: 120 },
  })

  await restored.restartDaemon('kill')
  expect(await restored.call('settings.get', {})).toEqual(actualSettings)
  expect(await restored.call('themes.inspect', { id: 'user:backup-appearance' })).toEqual(expectedDefinition)
  expect(await restored.call('settings.appearance', {})).toEqual(actualAppearance)
  expect(await profile.call('settings.get', {})).toEqual(expectedSettings)
  expect(await profile.call('settings.appearance', {})).toEqual(expectedAppearance)
  expect((await isolated.call('settings.get', {})).settings).toEqual(isolatedSettings.settings)
  expect(await isolated.call('settings.appearance', {})).toEqual(isolatedAppearance)
})
test('refuses a bundle of an older schema or format without creating the target', async ({ ade, profile }) => {
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  const manifest = await readManifest(bundle)
  const current = manifest.entries.find((entry) => entry.path === 'sessions.sqlite')!.schema!

  // Nothing restores an older bundle before launch (D19).
  const behind = await copyBundle(bundle, join(ade.root, 'behind'))
  await rewriteDatabase(behind, (db) => db.exec(`PRAGMA user_version=${current - 1};`))
  const format = await copyBundle(bundle, join(ade.root, 'format'))
  await writeFile(
    join(format, 'manifest.json'),
    JSON.stringify({ ...manifest, format_version: manifest.format_version - 1 }),
  )
  const cases: Array<[string, string]> = [
    [behind, `Unsupported sessions.sqlite schema version ${current - 1}; this build restores only schema ${current}`],
    [format, `this build restores only format ${manifest.format_version} bundles`],
  ]
  for (const [copy, message] of cases) {
    const target = `${copy}-target`
    const refused = await control(ade, ['backup', 'restore', '--backup', copy, '--data-dir', target])
    expect(refused.code).not.toBe(0)
    expect(String(refused.json?.message)).toContain(message)
    await expect(access(target)).rejects.toThrow()
  }
  expect(await stages(ade.root)).toEqual([])
})
