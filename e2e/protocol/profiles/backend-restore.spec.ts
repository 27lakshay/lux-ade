// F050 and R014 for registered profiles: `ade-control profiles backup-backend`
// captures a live profile's backend with its source identity, and
// `restore-backend` publishes a new profile in the registry last, remaps its
// private workspace, fences everything else, and leaves an interrupted
// restore unpublished until an explicit resume. Ported from the legacy
// e2e/specs/profile-backend-restore, native-control (restore case) and
// local-profiles (backup case) specs, which drove scripts/profiles.py.
import { cp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ManagedProfile, type ProfileHost } from '../fixtures/managed-profiles'
import { spawn } from 'node:child_process'
import { controlBinary } from '../fixtures/control'

type Json = Record<string, unknown>

/** `ade-control profiles ...` on the host; a failure returns its error message. */
async function profiles(host: ProfileHost, ...args: string[]): Promise<Json> {
  const result = await host.control(['profiles', ...args])
  expect(result.code, result.stderr).toBe(0)
  return result.json!
}

async function refused(host: ProfileHost, ...args: string[]): Promise<string> {
  const result = await host.control(['profiles', ...args])
  expect(result.code, result.stdout).not.toBe(0)
  return String(result.json?.message ?? result.stderr)
}

async function started(profile: ManagedProfile): Promise<void> {
  const status = await profile.cli('status')
  expect(status.code, status.stderr).toBe(0)
}

function registry(host: ProfileHost): Promise<string> {
  return readFile(join(host.home, 'registry.json'), 'utf8')
}

function privateWorkspace(host: ProfileHost, id: string): Promise<string> {
  return realpath(join(host.home, 'profiles', id, 'workspace'))
}

test('registered backend restore publishes a new profile last and remaps its private workspace', async ({
  ade,
  host,
}) => {
  const bundle = join(ade.root, 'bundle')
  const sourceExternal = join(ade.root, 'source-external')
  const reboundExternal = join(ade.root, 'rebound-external')
  await mkdir(sourceExternal)
  await mkdir(reboundExternal)
  const source = await host.create('Source')
  await started(source)
  const workspace = (await source.call('catalog.get', {})).catalog.workspaces[0]!
  const conversation = (
    await source.call('conversation.create', {
      workspace_id: workspace.id,
      provider: 'codex',
      title: 'Retained history',
    })
  ).conversation
  const externalId = (await source.call('workspace.open', { path: sourceExternal })).workspace.id
  await profiles(host, 'backup-backend', '--out', bundle, source.id)

  // A changed backend manifest and a redirected bundle are refused, and the registry is untouched.
  const corrupt = join(ade.root, 'corrupt')
  await cp(bundle, corrupt, { recursive: true })
  await writeFile(join(corrupt, 'backend', 'manifest.json'), '{}')
  const before = await registry(host)
  expect(await refused(host, 'restore-backend', '--backup', corrupt, '--name', 'Corrupt')).toMatch(
    /Registered backend manifest changed/,
  )
  const redirected = join(ade.root, 'redirected')
  await symlink(bundle, redirected)
  expect(await refused(host, 'restore-backend', '--backup', redirected, '--name', 'Redirected')).toMatch(
    /Directory is redirected/,
  )
  expect(await registry(host)).toBe(before)

  const result = await profiles(host, 'restore-backend', '--backup', bundle, '--name', 'Recovered')
  expect(result).toMatchObject({
    type: 'profile_backend_restored',
    scope: 'profile-backend-only',
    source_profile_id: source.id,
  })
  const record = result.profile as { id: string; name: string; home: string }
  expect(record.id).not.toBe(source.id)
  // The restore does not change which profile is selected.
  expect((await profiles(host, 'current')).profile).toMatchObject({ id: source.id })

  const target = await host.register(record)
  await started(target)
  expect(
    (await target.call('catalog.get', {})).catalog.workspaces.find((item) => item.id === workspace.id),
  ).toMatchObject({ id: workspace.id, root: await privateWorkspace(host, target.id), needs_rebind: false })
  expect((await target.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Retained history',
  })
  expect((await target.call('catalog.get', {})).catalog.workspaces).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: externalId, needs_rebind: true })]),
  )
  const rebound = await target.cli('workspace', 'rebind', externalId, reboundExternal)
  expect(rebound.json).toMatchObject({
    type: 'ack',
    workspace: { id: externalId, root: await realpath(reboundExternal), needs_rebind: false },
  })

  // The source profile is unchanged.
  const sourceAfter = (await source.call('catalog.get', {})).catalog
  expect(sourceAfter.workspaces[0]).toMatchObject({ id: workspace.id, root: workspace.root })
  expect((await source.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Retained history',
  })
  expect(sourceAfter.workspaces).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: externalId, root: await realpath(sourceExternal) })]),
  )
})

test('registered restore starts with a fenced Git lifecycle repository and no default terminal launch', async ({
  ade,
  host,
  repo,
}) => {
  const bundle = join(ade.root, 'bundle')
  const source = await host.create('Source')
  await started(source)
  const workspace = (await source.call('workspace.open', { path: repo.path })).workspace
  const lifecycle = (await source.call('worktree.repository', { path: repo.path })).repository
  await profiles(host, 'backup-backend', '--out', bundle, source.id)
  const record = (await profiles(host, 'restore-backend', '--backup', bundle, '--name', 'Recovered')).profile as {
    id: string
    name: string
    home: string
  }
  const target = await host.register(record)
  await started(target)
  expect((await target.call('worktree.rebind.list', {})).repositories).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: lifecycle.id, needs_rebind: true })]),
  )
  expect((await target.call('workspace.rebind.list', {})).workspaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: workspace.id, root: await realpath(repo.path), needs_rebind: true }),
    ]),
  )
  expect((await target.call('catalog.get', {})).catalog).toMatchObject({
    workspaces: expect.arrayContaining([
      expect.objectContaining({ root: await privateWorkspace(host, target.id), needs_rebind: false }),
    ]),
  })
})

test('an interrupted registry-last restore remains unpublished until explicit resume', async ({ ade, host }) => {
  const bundle = join(ade.root, 'bundle')
  const source = await host.create('Source')
  await started(source)
  const workspace = (await source.call('catalog.get', {})).catalog.workspaces[0]!
  const conversation = (
    await source.call('conversation.create', {
      workspace_id: workspace.id,
      provider: 'codex',
      title: 'Before interrupted restore',
    })
  ).conversation
  await profiles(host, 'backup-backend', '--out', bundle, source.id)
  const signal = join(ade.root, 'published')
  const release = join(ade.root, 'release')
  const registryBefore = await registry(host)

  // The restore pauses once its files are in place, before it writes the registry, and is killed there.
  const child = spawn(controlBinary, ['profiles', 'restore-backend', '--backup', bundle, '--name', 'Interrupted'], {
    cwd: host.cwd,
    env: { ...host.env, ADE_E2E_RESTORE_PUBLISHED_SIGNAL: signal, ADE_E2E_RESTORE_PUBLISHED_RELEASE: release },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await ade.ledger.own(child.pid!, 'interrupted restore')
  let targetId: string
  try {
    await expect.poll(() => readFile(signal, 'utf8').catch(() => ''), { timeout: 10_000 }).not.toBe('')
    targetId = await readFile(signal, 'utf8')
    expect(await registry(host)).toBe(registryBefore)
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
    child.kill('SIGKILL')
    await exited
  } finally {
    await writeFile(release, '')
  }
  expect((await profiles(host, 'pending-restores')).profiles).toEqual([
    expect.objectContaining({ id: targetId, name: 'Interrupted', source_profile_id: source.id }),
  ])

  // A redirected runtime directory and a corrupt review store stop the resume; the registry is untouched.
  const targetDirectory = join(host.home, 'profiles', targetId)
  const runtimeDirectory = join(targetDirectory, 'runtime')
  const heldRuntime = join(targetDirectory, 'runtime-held')
  await rename(runtimeDirectory, heldRuntime)
  await symlink(heldRuntime, runtimeDirectory)
  expect(await refused(host, 'resume-restore', targetId)).toMatch(/Directory is redirected/)
  expect(await registry(host)).toBe(registryBefore)
  await rm(runtimeDirectory)
  await rename(heldRuntime, runtimeDirectory)
  const review = join(runtimeDirectory, 'data', 'sessions.review.sqlite3')
  const reviewBytes = await readFile(review)
  await writeFile(review, 'corrupt SQLite review store')
  expect(await refused(host, 'resume-restore', targetId)).toMatch(/file is not a database/)
  expect(await registry(host)).toBe(registryBefore)
  await writeFile(review, reviewBytes)

  const resumed = await profiles(host, 'resume-restore', targetId)
  expect(resumed).toMatchObject({ type: 'profile_backend_restored', profile: { id: targetId } })
  expect((await profiles(host, 'list')).profiles).toHaveLength(2)
  expect((await profiles(host, 'pending-restores')).profiles).toEqual([])
  const target = await host.register(resumed.profile as { id: string; name: string; home: string })
  await started(target)
  expect((await target.call('catalog.get', {})).catalog.workspaces[0]).toMatchObject({
    id: workspace.id,
    root: await realpath(join(targetDirectory, 'workspace')),
    needs_rebind: false,
  })
  expect((await target.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Before interrupted restore',
  })
  expect((await source.call('catalog.get', {})).catalog).toMatchObject({
    workspaces: [expect.objectContaining({ id: workspace.id, root: workspace.root })],
  })
})

test('a registered profile captures its live backend with source identity and explicit exclusions', async ({
  ade,
  host,
}) => {
  const bundle = join(ade.root, 'backend-bundle')
  const source = await host.create('Source')
  const other = await host.create('Other')
  // A profile that never started has no backend to capture. ade-control reports the missing
  // runtime directory's launch lock rather than naming the missing runtime binding.
  expect(await refused(host, 'backup-backend', '--out', bundle, other.id)).toMatch(
    /runtime\/launch\.lock: No such file/,
  )
  await expect(readFile(join(bundle, 'manifest.json'))).rejects.toThrow()
  await started(source)
  const workspace = (await source.call('catalog.get', {})).catalog.workspaces[0]!
  const conversation = (
    await source.call('conversation.create', {
      workspace_id: workspace.id,
      provider: 'codex',
      title: 'Backed up while live',
    })
  ).conversation
  // The bundle may not live inside the profile it captures.
  const nestedBundle = join(host.home, 'profiles', source.id, 'nested-bundle')
  expect(await refused(host, 'backup-backend', '--out', nestedBundle, source.id)).toMatch(
    /must be outside the profile it copies/,
  )
  await expect(readFile(join(nestedBundle, 'manifest.json'))).rejects.toThrow()

  const captured = await profiles(host, 'backup-backend', '--out', bundle, source.id)
  expect(captured).toMatchObject({
    type: 'profile_backend_backup',
    path: bundle,
    manifest: {
      format_version: 2,
      scope: 'profile-backend-only',
      source_profile_id: source.id,
      source_profile_name: 'Source',
    },
  })
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as {
    source_private_workspace: string
  }
  expect(manifest.source_private_workspace).toContain(source.id)
  // The backend bundle inside discloses what it leaves out.
  const inspected = await host.control(['backup', 'inspect', '--backup', join(bundle, 'backend')])
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(inspected.json).toMatchObject({ type: 'backup', manifest: { scope: 'backend-snapshot-only' } })
  const excluded = ((inspected.json!.manifest as { excluded: string[] }).excluded ?? []).join(' ')
  expect(excluded).toMatch(/pending send/)
  expect(excluded).toMatch(/browser session/)
  expect(await refused(host, 'backup-backend', '--out', bundle, source.id)).toMatch(/already exists/)
  expect((await profiles(host, 'list')).profiles).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: source.id }), expect.objectContaining({ id: other.id })]),
  )
  expect((await source.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Backed up while live',
  })
})
