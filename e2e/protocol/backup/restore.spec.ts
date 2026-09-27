// F050, R014, F059 and D15: a live profile is backed up while it keeps
// working, the bundle is inspected, and a restore into a fresh profile is
// read back through the public protocol.
import { access, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, startConversation, test, turnReply, waitForMessage } from '../fixtures'
import { control, spawnControl } from '../fixtures/control'
import { copyBundle, createBackup, pixel, pluginId, readManifest, restoreIntoNewProfile, rewriteDatabase, seed, skillName,
  stages, type Manifest } from './helpers'

test('backs up a live profile during writes and restores conversations, attachments, plugins, skills and accounts', async ({ ade, profile }) => {
  test.setTimeout(120_000)
  const seeded = await seed(ade, profile)

  // Hold the online copy of sessions.sqlite part-way and keep writing to the
  // profile meanwhile. The daemon must keep serving, and the bundle must be
  // one consistent snapshot.
  const signal = join(ade.root, 'backup-active')
  const release = join(ade.root, 'backup-release')
  const bundle = join(ade.root, 'bundle')
  const running = await spawnControl(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle], {
    env: { ADE_E2E_BACKUP_PAUSE_ENABLED: '1', ADE_E2E_BACKUP_PAUSE_SIGNAL: signal, ADE_E2E_BACKUP_PAUSE_RELEASE: release } })
  await expect.poll(() => access(signal).then(() => true, () => false)).toBe(true)
  const during = await profile.call('attachment.put', { conversation_id: seeded.conversationId,
    request_id: 'during-backup', name: 'during.png', data: pixel })
  await profile.call('draft.save', { conversation_id: seeded.conversationId, window_id: 'backup-window', revision: 2,
    text: 'draft saved while the backup ran', attachments: [during.attachment] })
  await profile.call('plugin.record.put', { plugin_id: pluginId, namespace: 'notes', key: 'during',
    value: { text: 'written while the backup ran' }, expected_revision: 0 })
  expect(await readdir(ade.root)).not.toContain('bundle')
  await writeFile(release, '')
  const created = await running.done
  expect(created.code, created.stderr).toBe(0)

  // Inspect verifies the bundle and discloses what it leaves out.
  const inspected = await control(ade, ['backup', 'inspect', '--backup', bundle])
  expect(inspected.code, inspected.stderr).toBe(0)
  const manifest = inspected.json!.manifest as Awaited<ReturnType<typeof readManifest>>
  expect(manifest.format_version).toBe(7)
  expect(manifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
    'sessions.sqlite', 'sessions.plugins.sqlite3', 'sessions.plugins/artifacts']))
  expect(manifest.excluded.join('\n')).toMatch(/provider-native homes and credentials/)
  expect(manifest.excluded.join('\n')).toMatch(/plugin-private files/)
  expect(manifest.coverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ store: 'sessions.sqlite#history_index', disposition: 'rebuilt' }),
    expect.objectContaining({ store: 'sessions.plugins.sqlite3', disposition: 'backed_up' }),
    expect.objectContaining({ store: 'sessions.plugins/artifacts', disposition: 'backed_up' }),
  ]))
  const artifacts = manifest.entries.find((entry) => entry.path === 'sessions.plugins/artifacts')!
  // One hash per artifact file; the helper script keeps its executable bit.
  expect(artifacts.files!.map((file) => file.path.split('/').slice(2).join('/')).sort())
    .toEqual(['ade-plugin.json', 'dist/tool.sh', 'dist/ui.js'])
  expect(artifacts.files!.find((file) => file.path.endsWith('dist/tool.sh'))).toMatchObject({ executable: true })
  expect(await readdir(bundle)).not.toContain('provider-accounts')
  expect(await stages(ade.root)).toEqual([])

  const restored = await restoreIntoNewProfile(ade, bundle)
  expect(restored.hello.runtime_instance).not.toBe(profile.hello.runtime_instance)

  // Conversation, message and draft attachments.
  const snapshot = await restored.call('conversation.get', { conversation_id: seeded.conversationId })
  expect(snapshot.messages.map((message) => JSON.stringify(message)).join('\n')).toContain(turnReply.codex)
  const attachment = await restored.call('attachment.inspect', { conversation_id: seeded.conversationId,
    attachment_id: seeded.attachmentId })
  expect(attachment.sha256).toBe(seeded.attachmentSha)
  const draft = await restored.call('draft.get', { conversation_id: seeded.conversationId, window_id: 'backup-window' })
  // The draft is the one revision or the other, never a mix: its attachment always resolves.
  expect([1, 2]).toContain(draft.draft?.revision)
  for (const item of draft.draft?.attachments ?? []) {
    const copy = await restored.call('attachment.inspect', { conversation_id: seeded.conversationId, attachment_id: item.id })
    expect(copy.attachment.size).toBe(item.size)
  }
  if (draft.draft?.revision === 2) {
    expect((draft.draft.attachments ?? []).map((item) => item.id)).toEqual([during.attachment.id])
  }

  // The plugin comes back enabled and active, from the restored profile's own artifact.
  const plugin = (await restored.call('plugin.inspect', { plugin_id: pluginId })).plugin
  expect(plugin).toMatchObject({ status: 'enabled', artifact_digest: seeded.pluginDigest })
  expect(await realpath(plugin.artifact_path)).toContain(await realpath(restored.dataDirectory))
  await expect.poll(async () => (await restored.call('plugin.inspect', { plugin_id: pluginId })).plugin.activation)
    .not.toBeNull()
  expect((await restored.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'first' })).record)
    .toMatchObject({ value: { text: 'kept by backup' } })
  const settings = await restored.call('plugin.setting.list', { plugin_id: pluginId })
  expect(settings.settings).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'wrap', value: true })]))

  // The skill bundle and its blobs.
  const skills = await restored.call('skill.list', {})
  expect(skills.skills).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: skillName, content_hash: seeded.skillHash })]))
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

test('restores a bundle one schema behind, migrates it, and refuses two behind without creating the target', async ({ ade, profile }) => {
  test.setTimeout(90_000)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, turnReply.codex)
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  const current = (await readManifest(bundle)).entries.find((entry) => entry.path === 'sessions.sqlite')!.schema!

  // Schema 17 added only the receipts table; take it back out, as a schema-16 build wrote it.
  const behind = await copyBundle(bundle, join(ade.root, 'behind'))
  await rewriteDatabase(behind, (db) => db.exec(`DROP TABLE operations; DELETE FROM schema_migrations WHERE version=${current};
    PRAGMA user_version=${current - 1};`))
  const inspected = await control(ade, ['backup', 'inspect', '--backup', behind])
  expect(inspected.code, inspected.stderr).toBe(0)
  expect((inspected.json!.manifest as Manifest).entries.find((entry) => entry.path === 'sessions.sqlite'))
    .toMatchObject({ schema: current - 1 })

  // Two behind is outside the D15 range; restore refuses before it creates anything.
  const older = await copyBundle(behind, join(ade.root, 'older'))
  await rewriteDatabase(older, (db) => db.exec(`DROP TABLE terminal_creations;
    DELETE FROM schema_migrations WHERE version=${current - 1}; PRAGMA user_version=${current - 2};`))
  const refusedTarget = join(ade.root, 'older-target')
  const refused = await control(ade, ['backup', 'restore', '--backup', older, '--data-dir', refusedTarget])
  expect(refused.code).not.toBe(0)
  expect(String(refused.json?.message)).toContain(`Unsupported sessions.sqlite schema version ${current - 2}`)
  await expect(access(refusedTarget)).rejects.toThrow()
  expect(await stages(ade.root)).toEqual([])

  const restored = await restoreIntoNewProfile(ade, behind)
  const snapshot = await restored.call('conversation.get', { conversation_id: conversationId })
  expect(JSON.stringify(snapshot.messages)).toContain(turnReply.codex)
  // An effect command needs the receipts table schema 17 adds, so it proves the daemon migrated.
  // A restored workspace is fenced until it is rebound to a folder of the new profile.
  const [fenced] = (await restored.call('workspace.rebind.list', {})).workspaces
  expect(fenced).toMatchObject({ needs_rebind: true })
  const { workspace } = await restored.call('workspace.rebind', { workspace_id: fenced.id,
    path: restored.defaultWorkspaceRoot })
  expect(workspace.needs_rebind).toBe(false)
  const created = await restored.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })
  expect(created.conversation.id).toMatch(/^conversation_/)
  const again = await createBackup(ade, restored, 'migrated')
  expect(again.result.code, again.result.stderr).toBe(0)
  expect((await readManifest(again.path)).entries.find((entry) => entry.path === 'sessions.sqlite'))
    .toMatchObject({ schema: current })
})

test('restores a format-2 bundle and rebuilds the history index it still carries', async ({ ade, profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, turnReply.codex)
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)

  // Format 2 held only the core, review and lifecycle stores, and no coverage list.
  const legacy = await copyBundle(bundle, join(ade.root, 'format-2'))
  const manifest = await readManifest(legacy)
  const kept = new Set(['sessions.sqlite', 'sessions.review.sqlite3', 'sessions.worktrees/lifecycle.sqlite3',
    'sessions.worktrees/empty.toml'])
  for (const entry of manifest.entries.filter((candidate) => !kept.has(candidate.path))) {
    await rm(join(legacy, entry.path), { recursive: true, force: true })
  }
  await rm(join(legacy, 'sessions.plugins'), { recursive: true, force: true })
  await writeFile(join(legacy, 'manifest.json'), JSON.stringify({ format_version: 2, scope: manifest.scope,
    entries: manifest.entries.filter((entry) => kept.has(entry.path)),
    excluded: [
      'browser sessions, tabs, cookies and pending sends',
      'provider-native homes and credentials',
      'external projects, repositories and worktrees',
      'service routes, logs, owner locks, sockets and processes',
    ] }))
  const inspected = await control(ade, ['backup', 'inspect', '--backup', legacy])
  expect(inspected.code, inspected.stderr).toBe(0)

  const restored = await restoreIntoNewProfile(ade, legacy)
  await expect.poll(async () => (await restored.call('history.index.status', {})).index)
    .toMatchObject({ caught_up: true, rebuilding: false })
  const found = await restored.call('history.search', { query: 'Hello' })
  expect(found.results.map((match) => match.provenance.conversation_id)).toContain(conversationId)
})
