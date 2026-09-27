import { expect, test } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const launcher = resolve('scripts/profiles.py')
const daemonBinary = resolve('target/debug/ade-daemon')
type Profile = { id: string; name: string; home: string }
type Launch = { profile: Profile; socket: string }

async function command(home: string, ...args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync('python3', [launcher, '--home', home, '--daemon', daemonBinary, ...args], {
    timeout: 30_000,
  })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

test('registered backend restore publishes a new profile last and remaps its private workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-registered-restore-e2e-'))
  const home = join(directory, 'profiles')
  const bundle = join(directory, 'bundle')
  const sourceExternal = join(directory, 'source-external')
  const reboundExternal = join(directory, 'rebound-external')
  const owned: ManagedProfileOwner[] = []
  try {
    await mkdir(sourceExternal)
    await mkdir(reboundExternal)
    const source = (await command(home, 'create', 'Source')).profile as Profile
    const sourceLaunch = (await command(home, 'start', source.id)) as Launch
    owned.push(await managedProfileOwner(sourceLaunch.socket))
    const original = await rpc(sourceLaunch.socket, { op: 'catalog.get' })
    const workspace = (original.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces[0]
    const created = await rpc(sourceLaunch.socket, {
      op: 'conversation.create',
      workspace_id: workspace.id,
      provider: 'codex',
      title: 'Retained history',
    })
    const conversationId = (created.conversation as { id: string }).id
    const opened = await rpc(sourceLaunch.socket, { op: 'workspace.open', path: sourceExternal })
    const externalId = (opened.workspace as { id: string }).id
    await command(home, 'backup-backend', '--out', bundle, source.id)

    const corrupt = join(directory, 'corrupt')
    await cp(bundle, corrupt, { recursive: true })
    await writeFile(join(corrupt, 'backend', 'manifest.json'), '{}')
    const before = await readFile(join(home, 'registry.json'), 'utf8')
    await expect(command(home, 'restore-backend', '--backup', corrupt, '--name', 'Corrupt')).rejects.toThrow(
      /Registered backend manifest changed/,
    )
    const redirected = join(directory, 'redirected')
    await symlink(bundle, redirected)
    await expect(command(home, 'restore-backend', '--backup', redirected, '--name', 'Redirected')).rejects.toThrow(
      /redirected or invalid/,
    )
    expect(await readFile(join(home, 'registry.json'), 'utf8')).toBe(before)

    const result = await command(home, 'restore-backend', '--backup', bundle, '--name', 'Recovered')
    expect(result).toMatchObject({
      type: 'profile_backend_restored',
      scope: 'profile-backend-only',
      source_profile_id: source.id,
    })
    const target = result.profile as Profile
    expect(target.id).not.toBe(source.id)
    expect((await command(home, 'current')).profile).toMatchObject({ id: source.id })
    const targetLaunch = (await command(home, 'start', target.id)) as Launch
    owned.push(await managedProfileOwner(targetLaunch.socket))
    const restored = await rpc(targetLaunch.socket, { op: 'catalog.get' })
    const targetWorkspace = (
      restored.catalog as { workspaces: Array<{ id: string; root: string; needs_rebind: boolean }> }
    ).workspaces.find((item) => item.id === workspace.id)
    expect(targetWorkspace).toMatchObject({
      id: workspace.id,
      root: await realpath(join(home, 'profiles', target.id, 'workspace')),
      needs_rebind: false,
    })
    expect(
      (await rpc(targetLaunch.socket, { op: 'conversation.get', conversation_id: conversationId })).conversation,
    ).toMatchObject({ id: conversationId, title: 'Retained history' })
    const fenced = await rpc(targetLaunch.socket, { op: 'catalog.get' })
    expect((fenced.catalog as { workspaces: Array<{ id: string; needs_rebind: boolean }> }).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: externalId, needs_rebind: true })]),
    )
    const cli = resolve('apps/cli/dist/index.js')
    const rebound = await execFileAsync(
      process.execPath,
      [cli, '--socket', targetLaunch.socket, 'workspace', 'rebind', externalId, reboundExternal],
      { timeout: 12_000 },
    )
    expect(JSON.parse(rebound.stdout)).toMatchObject({
      type: 'ack',
      workspace: { id: externalId, root: await realpath(reboundExternal), needs_rebind: false },
    })
    const sourceAfter = await rpc(sourceLaunch.socket, { op: 'catalog.get' })
    expect((sourceAfter.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces[0]).toMatchObject({
      id: workspace.id,
      root: workspace.root,
    })
    expect(
      (await rpc(sourceLaunch.socket, { op: 'conversation.get', conversation_id: conversationId })).conversation,
    ).toMatchObject({ id: conversationId, title: 'Retained history' })
    expect((sourceAfter.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: externalId, root: await realpath(sourceExternal) })]),
    )
  } finally {
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('registered restore starts with a fenced Git lifecycle repository and no default terminal launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-registered-lifecycle-restore-e2e-'))
  const home = join(directory, 'profiles')
  const checkout = join(directory, 'source-checkout')
  const bundle = join(directory, 'bundle')
  const owned: ManagedProfileOwner[] = []
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', checkout])
    const source = (await command(home, 'create', 'Source')).profile as Profile
    const sourceLaunch = (await command(home, 'start', source.id)) as Launch
    owned.push(await managedProfileOwner(sourceLaunch.socket))
    const workspace = (await rpc(sourceLaunch.socket, { op: 'workspace.open', path: checkout })).workspace as {
      id: string
    }
    const lifecycle = (await rpc(sourceLaunch.socket, { op: 'worktree.repository', path: checkout })).repository as {
      id: string
    }
    await command(home, 'backup-backend', '--out', bundle, source.id)
    const target = (await command(home, 'restore-backend', '--backup', bundle, '--name', 'Recovered'))
      .profile as Profile
    const targetLaunch = (await command(home, 'start', target.id)) as Launch
    owned.push(await managedProfileOwner(targetLaunch.socket))
    expect((await rpc(targetLaunch.socket, { op: 'worktree.rebind.list' })).repositories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: lifecycle.id, needs_rebind: true })]),
    )
    expect((await rpc(targetLaunch.socket, { op: 'workspace.rebind.list' })).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, root: await realpath(checkout), needs_rebind: true }),
      ]),
    )
    expect((await rpc(targetLaunch.socket, { op: 'catalog.get' })).catalog).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          root: await realpath(join(home, 'profiles', target.id, 'workspace')),
          needs_rebind: false,
        }),
      ]),
    })
  } finally {
    await stopManagedProfiles(owned)
    await rm(directory, { recursive: true, force: true })
  }
})

test('an interrupted registry-last restore remains unpublished until explicit resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-restore-resume-e2e-'))
  const home = join(directory, 'profiles')
  const bundle = join(directory, 'bundle')
  let sourceOwner: ManagedProfileOwner | null = null
  let targetOwner: ManagedProfileOwner | null = null
  try {
    const source = (await command(home, 'create', 'Source')).profile as Profile
    const launch = (await command(home, 'start', source.id)) as Launch
    sourceOwner = await managedProfileOwner(launch.socket)
    const sourceCatalog = await rpc(launch.socket, { op: 'catalog.get' })
    const workspace = (sourceCatalog.catalog as { workspaces: Array<{ id: string; root: string }> }).workspaces[0]
    const created = await rpc(launch.socket, {
      op: 'conversation.create',
      workspace_id: workspace.id,
      provider: 'codex',
      title: 'Before interrupted restore',
    })
    const conversationId = (created.conversation as { id: string }).id
    await command(home, 'backup-backend', '--out', bundle, source.id)
    const signal = join(directory, 'published')
    const release = join(directory, 'release')
    const registryBefore = await readFile(join(home, 'registry.json'), 'utf8')
    const child = spawn(
      'python3',
      [launcher, '--home', home, 'restore-backend', '--backup', bundle, '--name', 'Interrupted'],
      {
        env: { ...process.env, ADE_E2E_RESTORE_PUBLISHED_SIGNAL: signal, ADE_E2E_RESTORE_PUBLISHED_RELEASE: release },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    try {
      await expect
        .poll(
          () =>
            access(signal).then(
              () => true,
              () => false,
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
      const targetId = await readFile(signal, 'utf8')
      expect(await readFile(join(home, 'registry.json'), 'utf8')).toBe(registryBefore)
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
      child.kill('SIGKILL')
      await exited
      expect((await command(home, 'pending-restores')).profiles).toEqual([
        expect.objectContaining({ id: targetId, name: 'Interrupted', source_profile_id: source.id }),
      ])
      const targetDirectory = join(home, 'profiles', targetId)
      const runtimeDirectory = join(targetDirectory, 'runtime')
      const heldRuntime = join(targetDirectory, 'runtime-held')
      await rename(runtimeDirectory, heldRuntime)
      await symlink(heldRuntime, runtimeDirectory)
      await expect(command(home, 'resume-restore', targetId)).rejects.toThrow(/redirected or invalid/)
      expect(await readFile(join(home, 'registry.json'), 'utf8')).toBe(registryBefore)
      await rm(runtimeDirectory)
      await rename(heldRuntime, runtimeDirectory)
      const review = join(runtimeDirectory, 'data', 'sessions.review.sqlite3')
      const reviewBytes = await readFile(review)
      await writeFile(review, 'corrupt SQLite review store')
      await expect(command(home, 'resume-restore', targetId)).rejects.toThrow(/file is not a database/)
      expect(await readFile(join(home, 'registry.json'), 'utf8')).toBe(registryBefore)
      await writeFile(review, reviewBytes)
      const resumed = await command(home, 'resume-restore', targetId)
      expect(resumed).toMatchObject({ type: 'profile_backend_restored', profile: { id: targetId } })
      expect((await command(home, 'list')).profiles).toHaveLength(2)
      expect((await command(home, 'pending-restores')).profiles).toEqual([])
      const started = (await command(home, 'start', targetId)) as Launch
      targetOwner = await managedProfileOwner(started.socket)
      const targetCatalog = await rpc(started.socket, { op: 'catalog.get' })
      expect(
        (targetCatalog.catalog as { workspaces: Array<{ id: string; root: string; needs_rebind: boolean }> })
          .workspaces[0],
      ).toMatchObject({
        id: workspace.id,
        root: await realpath(join(targetDirectory, 'workspace')),
        needs_rebind: false,
      })
      expect(
        (await rpc(started.socket, { op: 'conversation.get', conversation_id: conversationId })).conversation,
      ).toMatchObject({ id: conversationId, title: 'Before interrupted restore' })
      expect((await rpc(launch.socket, { op: 'catalog.get' })).catalog).toMatchObject({
        workspaces: [expect.objectContaining({ id: workspace.id, root: workspace.root })],
      })
    } finally {
      await writeFile(release, '')
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  } finally {
    await stopManagedProfiles(
      [targetOwner, sourceOwner].filter((owner): owner is ManagedProfileOwner => owner !== null),
    )
    await rm(directory, { recursive: true, force: true })
  }
})
