// R014: faults around backup and restore. A killed backup publishes nothing
// and a retry succeeds; a duplicate request never replaces a published bundle
// or a restored profile; a crashed daemon's data directory still backs up.
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, startConversation, test } from '../fixtures'
import { control, spawnControl } from '../fixtures/control'
import { createBackup, restoreIntoNewProfile, stages } from './helpers'

test('a backup killed part-way publishes nothing, its stage is not restorable, and a retry succeeds', async ({
  ade,
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'w',
    revision: 1,
    text: 'before the crash',
  })
  const parent = join(ade.root, 'backups')
  await mkdir(parent)
  const bundle = join(parent, 'bundle')
  const signal = join(ade.root, 'backup-active')
  const running = await spawnControl(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle], {
    env: {
      ADE_E2E_BACKUP_PAUSE_ENABLED: '1',
      ADE_E2E_BACKUP_PAUSE_SIGNAL: signal,
      ADE_E2E_BACKUP_PAUSE_RELEASE: join(ade.root, 'never-released'),
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
  running.child.kill('SIGKILL')
  expect((await running.done).code).not.toBe(0)

  expect(await readdir(parent)).not.toContain('bundle')
  const [stage] = await stages(parent)
  expect(stage).toBeDefined()
  const fromStage = await control(ade, [
    'backup',
    'restore',
    '--backup',
    join(parent, stage),
    '--data-dir',
    join(ade.root, 'from-stage'),
  ])
  expect(fromStage.code).not.toBe(0)
  await expect(access(join(ade.root, 'from-stage'))).rejects.toThrow()

  // The profile kept working, and a retry to the same destination publishes a complete bundle.
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'w',
    revision: 2,
    text: 'after the crash',
  })
  const retried = await control(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle])
  expect(retried.code, retried.stderr).toBe(0)
  const restored = await restoreIntoNewProfile(ade, bundle)
  expect((await restored.call('draft.get', { conversation_id: conversationId, window_id: 'w' })).draft).toMatchObject({
    revision: 2,
    text: 'after the crash',
  })
})

test('duplicate and misplaced requests never replace a published bundle or a restored profile', async ({
  ade,
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await profile.call('draft.save', { conversation_id: conversationId, window_id: 'w', revision: 1, text: 'first' })
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  const published = await stat(join(bundle, 'manifest.json'))

  // A second create to the same destination is refused and leaves the first bundle as it was.
  await profile.call('draft.save', { conversation_id: conversationId, window_id: 'w', revision: 2, text: 'second' })
  const again = await control(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle])
  expect(again.code).not.toBe(0)
  expect(String(again.json?.message)).toContain('Backup destination already exists')
  const unchanged = await stat(join(bundle, 'manifest.json'))
  expect([unchanged.ino, unchanged.mtimeMs]).toEqual([published.ino, published.mtimeMs])

  // A destination inside the profile it copies is refused.
  const nested = await control(ade, [
    'backup',
    'create',
    '--data-dir',
    profile.dataDirectory,
    '--out',
    join(profile.dataDirectory, 'nested-backup'),
  ])
  expect(nested.code).not.toBe(0)
  expect(String(nested.json?.message)).toContain('Backup destination must be outside the profile it copies')
  expect(await readdir(profile.dataDirectory)).not.toContain('nested-backup')
  expect(await stages(profile.dataDirectory)).toEqual([])

  // Restoring the same bundle twice into the same place is refused; the first restore keeps serving.
  const restored = await restoreIntoNewProfile(ade, bundle)
  const repeat = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', restored.dataDirectory])
  expect(repeat.code).not.toBe(0)
  expect(String(repeat.json?.message)).toContain('Restore target already exists')
  expect((await restored.call('draft.get', { conversation_id: conversationId, window_id: 'w' })).draft).toMatchObject({
    revision: 1,
    text: 'first',
  })

  // Restoring it again elsewhere gives a second, independent profile.
  const second = await restoreIntoNewProfile(ade, bundle)
  expect(second.hello.runtime_instance).not.toBe(restored.hello.runtime_instance)
  const [fenced] = (await second.call('workspace.rebind.list', {})).workspaces
  await second.call('workspace.rebind', { workspace_id: fenced.id, path: second.defaultWorkspaceRoot })
  await second.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'w',
    revision: 2,
    text: 'only in second',
  })
  expect((await restored.call('draft.get', { conversation_id: conversationId, window_id: 'w' })).draft).toMatchObject({
    revision: 1,
    text: 'first',
  })
})

test('the data directory of a crashed daemon backs up with every committed write', async ({ ade, profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  for (let revision = 1; revision <= 20; revision++) {
    await profile.call('draft.save', {
      conversation_id: conversationId,
      window_id: 'w',
      revision,
      text: `revision ${revision}`,
    })
  }
  await profile.killDaemon()
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)

  const restored = await restoreIntoNewProfile(ade, bundle)
  expect((await restored.call('draft.get', { conversation_id: conversationId, window_id: 'w' })).draft).toMatchObject({
    revision: 20,
    text: 'revision 20',
  })

  // The crashed source recovers on its own data, untouched by the backup.
  await profile.restartDaemon()
  expect((await profile.call('draft.get', { conversation_id: conversationId, window_id: 'w' })).draft).toMatchObject({
    revision: 20,
  })
})
