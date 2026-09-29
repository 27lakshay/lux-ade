// Plugin installation, lifecycle and namespaced state (F051, F059) against a
// real daemon, through the SDK and the CLI.
import { execFile } from 'node:child_process'
import { cp, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { fixturePluginIds, installAndEnable, stagePlugin } from '../fixtures/plugins'

const execFileAsync = promisify(execFile)
const backend = fixturePluginIds.backend

test('installs a local plugin, enables, disables and uninstalls it with visible status', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'backend')
  const request = { operation_id: 'install-local-1', source: { kind: 'local' as const, path: source } }
  const installed = await profile.call('plugin.install', request)
  expect(installed.plugin).toMatchObject({
    id: backend,
    version: '1.0.0',
    status: 'disabled',
    activation_generation: 0,
    activation: null,
  })
  expect(installed.plugin.source).toMatchObject({
    kind: 'local',
    locator: source,
    pin: installed.plugin.artifact_digest,
  })

  // The same operation ID replays the stored reply; a different payload under it is a conflict.
  expect((await profile.call('plugin.install', request)).plugin.artifact_digest).toBe(installed.plugin.artifact_digest)
  await expect(
    profile.call('plugin.install', {
      operation_id: 'install-local-1',
      source: { kind: 'local', path: join(source, 'missing') },
    }),
  ).rejects.toMatchObject({ code: 'conflict' })

  const enabled = await profile.call('plugin.enable', { plugin_id: backend })
  expect(enabled.plugin.status).toBe('enabled')
  expect(enabled.plugin.activation_generation).toBe(1)
  expect(enabled.plugin.activation?.registrations.map((registration) => registration.id).sort()).toEqual([
    'e2e.backend.crash',
    'e2e.backend.echo',
    'e2e.backend.fail',
    'e2e.backend.hold',
  ])
  // Enabling an enabled plugin changes nothing.
  expect((await profile.call('plugin.enable', { plugin_id: backend })).plugin.activation_generation).toBe(1)

  const listed = await profile.cli('plugin', 'list')
  expect(listed.code).toBe(0)
  expect(listed.json).toMatchObject({ plugins: [expect.objectContaining({ id: backend, status: 'enabled' })] })

  // An enabled plugin can be neither replaced nor removed.
  await expect(
    profile.call('plugin.install', { operation_id: 'install-local-2', source: { kind: 'local', path: source } }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    profile.call('plugin.uninstall', { operation_id: 'uninstall-1', plugin_id: backend }),
  ).rejects.toMatchObject({ code: 'conflict' })

  const disabled = await profile.call('plugin.disable', { plugin_id: backend })
  expect(disabled.plugin).toMatchObject({ status: 'disabled', activation: null })
  const cliInspect = await profile.cli('plugin', 'inspect', backend)
  expect(cliInspect.json).toMatchObject({ plugin: { status: 'disabled' } })

  const removed = await profile.cli('plugin', 'uninstall', backend, '--operation-id', 'uninstall-2')
  expect(removed.code).toBe(0)
  expect(removed.json).toMatchObject({ plugin_id: backend, data_purged: false })
  expect((await profile.call('plugin.list', {})).plugins).toEqual([])
  await expect(profile.call('plugin.inspect', { plugin_id: backend })).rejects.toThrow()
  expect(await readdir(join(profile.dataDirectory, 'sessions.plugins', 'artifacts')).catch(() => [])).not.toContain(
    backend,
  )
})

test('rejects incompatible manifests before anything is installed or activated', async ({ ade, profile }) => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ api_version: 99 }, /api_version 99 is not supported/],
    [{ manifest_version: 2 }, /manifest_version 2 is not supported/],
    [{ id: 'NotAnId' }, /id must be publisher\.name/],
    [{ entry_points: { backend: 'missing.mjs' } }, /entry_points\.backend missing\.mjs is not in the artifact/],
  ]
  for (const [index, [patch, message]] of cases.entries()) {
    const source = await stagePlugin(ade.root, 'backend', patch)
    const error = await profile
      .call('plugin.install', { operation_id: `bad-${index}`, source: { kind: 'local', path: source } })
      .then(
        () => null,
        (failure: unknown) => failure as { code?: string; message?: string },
      )
    expect(error?.code).toBe('invalid_request')
    expect(error?.message).toMatch(message)
  }
  // A pinned version that does not match is refused as well.
  const source = await stagePlugin(ade.root, 'backend')
  await expect(
    profile.call('plugin.install', {
      operation_id: 'bad-version',
      source: { kind: 'local', path: source },
      expected_version: '9.9.9',
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect((await profile.call('plugin.list', {})).plugins).toEqual([])
})

test('installs the same artifact pinned from a package archive and a Git commit', async ({ ade, profile }) => {
  const source = await stagePlugin(ade.root, 'backend')
  const local = await profile.call('plugin.install', {
    operation_id: 'from-local',
    source: { kind: 'local', path: source },
  })

  // A package archive as `pnpm pack` writes it: everything under package/.
  const archive = join(ade.root, 'e2e-backend-1.0.0.tgz')
  await cp(source, join(ade.root, 'pack', 'package'), { recursive: true })
  await execFileAsync('tar', ['-czf', archive, '-C', join(ade.root, 'pack'), 'package'])
  const { stdout } = await execFileAsync('shasum', ['-a', '256', archive])
  const sha256 = stdout.split(' ')[0]
  await expect(
    profile.call('plugin.install', {
      operation_id: 'from-package-bad',
      source: { kind: 'package', path: archive, sha256: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'not_applied' })
  const packaged = await profile.call('plugin.install', {
    operation_id: 'from-package',
    source: { kind: 'package', path: archive, sha256 },
    expected_version: '1.0.0',
  })
  expect(packaged.plugin.source).toMatchObject({ kind: 'package', pin: `sha256:${sha256}` })
  expect(packaged.plugin.artifact_digest).toBe(local.plugin.artifact_digest)

  const files: Record<string, string> = {}
  for (const name of await readdir(source)) files[name] = await readFile(join(source, name), 'utf8')
  const repo = await ade.repo({ name: 'plugin-repo', initialFiles: files })
  const commit = await repo.head()
  await expect(
    profile.call('plugin.install', {
      operation_id: 'from-git-bad',
      source: { kind: 'git', url: repo.path, ref: 'main', commit: 'f'.repeat(40) },
    }),
  ).rejects.toMatchObject({ code: 'not_applied' })
  const cloned = await profile.call('plugin.install', {
    operation_id: 'from-git',
    source: { kind: 'git', url: repo.path, commit },
  })
  expect(cloned.plugin.source).toMatchObject({ kind: 'git', pin: commit })
  expect(cloned.plugin.artifact_digest).toBe(local.plugin.artifact_digest)

  const enabled = await profile.call('plugin.enable', { plugin_id: backend })
  expect(enabled.plugin).toMatchObject({ status: 'enabled', source: { kind: 'git', pin: commit } })
})

test('keeps namespaced records and settings apart, across a restart and an uninstall without purge', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const other = await installAndEnable(
    profile,
    await stagePlugin(ade.root, 'backend', {
      id: 'e2e.other',
      contributes: { settings: [{ key: 'out_dir', title: 'Output', kind: 'string', default: '' }] },
    }),
  )

  const first = await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'a',
    value: { n: 1 },
  })
  expect(first.record).toMatchObject({ revision: 1, value: { n: 1 }, data_schema: 1 })
  await profile.call('plugin.record.put', {
    plugin_id: other.pluginId,
    namespace: 'notes',
    key: 'a',
    value: { n: 'other' },
  })
  // Compare-and-set refuses a stale revision.
  await expect(
    profile.call('plugin.record.put', {
      plugin_id: pluginId,
      namespace: 'notes',
      key: 'a',
      value: { n: 2 },
      expected_revision: 0,
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  const second = await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'a',
    value: { n: 2 },
    expected_revision: 1,
  })
  expect(second.record?.revision).toBe(2)
  // Two plugins with the same namespace and key never see each other's record.
  expect(
    (await profile.call('plugin.record.get', { plugin_id: other.pluginId, namespace: 'notes', key: 'a' })).record
      ?.value,
  ).toEqual({ n: 'other' })

  // Only declared settings of the declared kind are accepted.
  await expect(
    profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'out_dir', value: 5 }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(
    profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'undeclared', value: 'x' }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  // A credential setting holds a typed reference, never a default or a non-reference value.
  const tokenReference = { keychain: { service: 'e2e', account: 'token' } }
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: tokenReference })
  for (const value of ['', 42, 'keychain:e2e/token']) {
    await expect(
      profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  }
  await expect(
    profile.call('plugin.install', {
      operation_id: 'credential-default',
      source: {
        kind: 'local',
        path: await stagePlugin(ade.root, 'backend', {
          id: 'e2e.defaulted',
          entry_points: { backend: 'backend.mjs' },
          contributes: { settings: [{ key: 'token', title: 'Token', kind: 'credential_ref', default: 'keychain:x' }] },
        }),
      },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/cannot have a default/) })

  const before = await profile.call('plugin.inspect', { plugin_id: pluginId })
  await profile.restartDaemon('kill')
  const restored = await profile.call('plugin.inspect', { plugin_id: pluginId })
  expect(restored.plugin.status).toBe('enabled')
  expect(restored.plugin.activation_generation).toBeGreaterThan(before.plugin.activation_generation)
  expect((await profile.call('plugin.record.list', { plugin_id: pluginId, namespace: 'notes' })).records).toEqual([
    expect.objectContaining({ key: 'a', value: { n: 2 }, revision: 2 }),
  ])
  expect((await profile.call('plugin.setting.list', { plugin_id: pluginId })).settings).toEqual([
    expect.objectContaining({ key: 'out_dir', value: outDir, is_default: false }),
    expect.objectContaining({ key: 'token', kind: 'credential_ref', value: tokenReference, is_default: false }),
  ])

  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.uninstall', { operation_id: 'keep-data', plugin_id: pluginId })
  await profile.call('plugin.install', {
    operation_id: 'reinstall',
    source: { kind: 'local', path: await stagePlugin(ade.root, 'backend') },
  })
  expect(
    (await profile.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'a' })).record?.value,
  ).toEqual({ n: 2 })

  // A data schema lower than the stored one is refused: rolling back code does not roll back data.
  await profile.call('plugin.record.put', { plugin_id: pluginId, namespace: 'notes', key: 'b', value: 1 })
  await profile.call('plugin.uninstall', { operation_id: 'keep-data-2', plugin_id: pluginId })
  await profile.call('plugin.install', {
    operation_id: 'schema-2',
    source: { kind: 'local', path: await stagePlugin(ade.root, 'backend', { version: '2.0.0', data_schema: 2 }) },
  })
  await profile.call('plugin.uninstall', { operation_id: 'keep-data-3', plugin_id: pluginId })
  await expect(
    profile.call('plugin.install', {
      operation_id: 'schema-1',
      source: { kind: 'local', path: await stagePlugin(ade.root, 'backend') },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })

  // Purging is the way back.
  await profile.call('plugin.uninstall', { operation_id: 'purge', plugin_id: pluginId, purge_data: true })
  await profile.call('plugin.install', {
    operation_id: 'schema-1-again',
    source: { kind: 'local', path: await stagePlugin(ade.root, 'backend') },
  })
  expect((await profile.call('plugin.record.list', { plugin_id: pluginId, namespace: 'notes' })).records).toEqual([])
  expect(
    (await profile.call('plugin.record.get', { plugin_id: other.pluginId, namespace: 'notes', key: 'a' })).record
      ?.value,
  ).toEqual({ n: 'other' })
})
