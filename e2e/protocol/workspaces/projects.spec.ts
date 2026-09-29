// One project identity (daemon authority ticket 03): every workspace names its
// project, plain folders included; each workspace reports its kind, the branch
// its HEAD names and whether it is the daemon's own; and the worktree
// lifecycle uses the catalog's project IDs, with lifecycle IDs recorded before
// the two shared one still resolving.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ScratchProfile } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { createReady, register, settled } from '../worktrees/lifecycle'

const execFileAsync = promisify(execFile)

async function folder(profile: ScratchProfile, name: string): Promise<string> {
  const path = join(profile.root, 'folders', name)
  await mkdir(path, { recursive: true })
  return realpath(path)
}

async function catalog(profile: ScratchProfile) {
  return (await profile.call('catalog.get', {})).catalog
}

async function listed(profile: ScratchProfile, id: string) {
  return (await catalog(profile)).workspaces.find((workspace) => workspace.id === id)
}

test('a main checkout, a linked worktree and a folder each name their project, kind and branch', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const linkedPath = join(dirname(repo.path), 'shop-feature')
  await repo.git('worktree', 'add', '--quiet', '-b', 'feature', linkedPath)
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const linked = (await profile.call('workspace.open', { path: linkedPath })).workspace
  const notesPath = await folder(profile, 'notes')
  const notes = (await profile.call('workspace.open', { path: notesPath })).workspace

  // The reply already carries the facts.
  expect(main).toMatchObject({ kind: 'primary_checkout', branch: 'main', default: false, ade_owned: false })
  expect(linked).toMatchObject({ kind: 'linked_worktree', branch: 'feature', ade_owned: false })
  expect(notes).toMatchObject({ kind: 'folder', branch: null, repository_id: null })

  // One project for the repository, one for the folder; the deprecated
  // repository_id stays equal to the repository project's ID.
  expect(main.project_id).toBe(main.repository_id)
  expect(linked.project_id).toBe(main.project_id)
  expect(notes.project_id).not.toBe(notes.id)
  const projects = (await catalog(profile)).projects
  expect(projects).toContainEqual({
    id: main.project_id,
    kind: 'repository',
    name: 'shop',
    root: join(repo.path, '.git'),
  })
  expect(projects).toContainEqual({ id: notes.project_id, kind: 'folder', name: 'notes', root: notesPath })
  expect(projects.filter((project) => project.id === main.project_id)).toHaveLength(1)

  // The lifecycle registers the repository under the same project ID.
  expect(await register(profile, repo)).toBe(main.project_id)

  // The daemon's own workspace is marked default, in replies and the catalog.
  const own = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  expect(own.default).toBe(true)
  expect((await listed(profile, own.id))?.default).toBe(true)
  expect((await listed(profile, main.id))?.default).toBe(false)

  // The SDK's catalog parser keeps projects and the workspace facts.
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const state = feed.client.getState().catalog!
  expect(state.projects).toEqual((await catalog(profile)).projects)
  expect(state.workspaces.find((workspace) => workspace.id === linked.id)).toMatchObject({
    project_id: main.project_id,
    kind: 'linked_worktree',
    branch: 'feature',
  })
  feed.stop()
})

test('branch follows a git switch made outside ADE, and a detached HEAD names none', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  expect(workspace.branch).toBe('main')
  const feed = await subscribeFeed(profile)
  await feed.connected()

  await repo.git('switch', '--quiet', '-c', 'topic')
  await feed.waitFor(
    (frame) =>
      frame.type === 'catalog' &&
      frame.catalog.workspaces.some((item) => item.id === workspace.id && item.branch === 'topic'),
  )
  feed.stop()

  await repo.git('switch', '--quiet', '--detach')
  await expect.poll(async () => (await listed(profile, workspace.id))?.branch).toBeNull()
  await repo.git('switch', '--quiet', 'main')
  await expect.poll(async () => (await listed(profile, workspace.id))?.branch).toBe('main')

  // The recorded branch survives a restart and is looked at again.
  await repo.git('switch', '--quiet', 'topic')
  await profile.restartDaemon('kill')
  await expect.poll(async () => (await listed(profile, workspace.id))?.branch).toBe('topic')
})

/** The receipt fingerprint the daemon computes: SHA-256 of the canonical payload without its operation ID. */
function fingerprint(payload: Record<string, unknown>): string {
  const canonical = (value: unknown): string =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(',')}}`
      : JSON.stringify(value)
  const { operation_id: _ignored, ...rest } = payload
  return createHash('sha256').update(canonical(rest)).digest('hex')
}

async function sqlite(database: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', [database, sql])
  return stdout.trim()
}

test('lifecycle IDs from before projects move onto the project ID and still resolve after a restart', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const projectId = main.project_id
  expect(await register(profile, repo)).toBe(projectId)
  const tree = await createReady(profile, projectId, { name: 'legacy' })
  const created = (await profile.call('worktree.get', { repository_id: projectId })).operations[0]!
  expect(created.worktree_path).toBe(tree)

  // Rewrite the lifecycle store as a build before projects left it: the
  // repository, its trees, ownership and ledger under a repository_… ID, and
  // the receipt fingerprinted with that ID.
  await profile.killDaemon()
  const legacy = 'repository_legacy_e2e'
  const database = join(profile.dataDirectory, 'sessions.worktrees', 'lifecycle.sqlite3')
  const moved = (table: string) =>
    `UPDATE ${table} SET data=json_set(data,'$.repository_id','${legacy}') WHERE json_extract(data,'$.repository_id')='${projectId}';`
  await sqlite(
    database,
    [
      `UPDATE repositories SET id='${legacy}', data=json_set(data,'$.id','${legacy}') WHERE id='${projectId}';`,
      moved('trees'),
      moved('owned'),
      moved('jobs'),
      `UPDATE operations SET fingerprint='${fingerprint({ repository_id: legacy, name: 'legacy' })}' WHERE id='${created.id}';`,
    ].join(''),
  )
  expect(await sqlite(database, `SELECT count(*) FROM repositories WHERE id='${legacy}'`)).toBe('1')
  await profile.restartDaemon()

  // The new daemon moved it back onto the project ID, keeping the alias.
  expect(await sqlite(database, `SELECT id FROM repository_aliases WHERE alias='${legacy}'`)).toBe(projectId)
  const state = await profile.call('worktree.get', { repository_id: legacy })
  expect(state.repository.id).toBe(projectId)
  expect(state.worktrees.find((item) => item.path === tree)?.ade_owned).toBe(true)
  const recorded = await profile.call('worktree.operation', { repository_id: legacy, operation_id: created.id })
  expect(recorded.operation).toMatchObject({ repository_id: projectId, status: 'succeeded', worktree_path: tree })
  // A retry of the recorded command under the old ID replays it: no second tree.
  await profile.call('worktree.create', { repository_id: legacy, operation_id: created.id, name: 'legacy' })
  expect((await settled(profile, legacy, created.id)).status).toBe('succeeded')
  const trees = (await profile.call('worktree.get', { repository_id: projectId })).worktrees
  expect(trees).toHaveLength(2)
  // Registering again finds the project ID.
  expect(await register(profile, repo)).toBe(projectId)
})

test('registering a repository with the lifecycle adds nothing to the catalog, and its first workspace takes that ID', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const lifecycleId = await register(profile, repo)
  expect((await catalog(profile)).projects.map((project) => project.id)).not.toContain(lifecycleId)
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  expect(workspace.project_id).toBe(lifecycleId)
  expect(await register(profile, repo)).toBe(lifecycleId)
})
