// `workspace.create_worktree` and `workspace.delete_worktree` (daemon authority
// ticket 03): one daemon operation each for what a client used to chain
// itself. Creation makes the tree through the lifecycle and opens it as a
// named, ADE-owned workspace; deletion checks every blocker first, removes the
// workspace from ADE, then the tree, and recovers a crash between the two.
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { operationId } from '../worktrees/lifecycle'

async function catalog(profile: ScratchProfile) {
  return (await profile.call('catalog.get', {})).catalog
}

/** Sends the operation again under its ID until it leaves `running`, and returns its state. */
async function finished<T extends { status: string }>(send: () => Promise<T>): Promise<T> {
  let state: T | undefined
  await expect.poll(async () => (state = await send()).status, { timeout: 60_000 }).not.toBe('running')
  return state!
}

/** The error a rejected SDK call raised, with its daemon code and frame details. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; details: Record<string, unknown> },
  )
}

async function worktreeOf(profile: ScratchProfile, projectId: string, name: string) {
  const id = operationId('create')
  const state = await finished(() =>
    profile.call('workspace.create_worktree', { operation_id: id, project_id: projectId, name }),
  )
  expect(state, JSON.stringify(state)).toMatchObject({ status: 'succeeded' })
  return { id, workspaceId: state.workspace_id!, path: state.worktree_path! }
}

test('create_worktree makes the tree, opens it as a named ADE-owned workspace and replays', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const id = operationId('create')
  const created = await profile.cli(
    '--operation-id',
    id,
    'workspace',
    'create-worktree',
    main.project_id,
    'Payments API',
    '--wait',
  )
  expect(created.code, created.stderr).toBe(0)
  expect(created.json).toMatchObject({
    type: 'workspace_worktree_operation',
    operation_id: id,
    kind: 'create_worktree',
    status: 'succeeded',
    project_id: main.project_id,
    error: null,
  })
  const reply = created.json as { workspace_id: string; worktree_path: string }
  expect(existsSync(reply.worktree_path)).toBe(true)

  // The workspace is in the catalog under the name as typed, in the project.
  const listed = (await catalog(profile)).workspaces.find((workspace) => workspace.id === reply.workspace_id)
  const listing = await profile.call('worktree.get', { project_id: main.project_id })
  const tree = listing.worktrees.find((item) => item.path === reply.worktree_path)
  expect(tree?.ade_owned).toBe(true)
  expect(listed).toMatchObject({
    name: 'Payments API',
    root: reply.worktree_path,
    project_id: main.project_id,
    kind: 'linked_worktree',
    ade_owned: true,
    branch: tree?.branch,
  })

  // The lifecycle step is readable under the project ID and this operation ID.
  const lifecycle = await profile.call('worktree.operation', { project_id: main.project_id, operation_id: id })
  expect(lifecycle.operation).toMatchObject({ status: 'succeeded', worktree_path: reply.worktree_path })

  // A retry replays the state; the same ID for another request conflicts.
  const replay = await profile.call('workspace.create_worktree', {
    operation_id: id,
    project_id: main.project_id,
    name: 'Payments API',
  })
  expect(replay).toEqual(created.json)
  const conflict = await refusal(
    profile.call('workspace.create_worktree', { operation_id: id, project_id: main.project_id, name: 'Other' }),
  )
  expect(conflict.code).toBe('conflict')
  expect(listing.worktrees).toHaveLength(2)
})

test('create_worktree refuses a folder project, an unknown project and an invalid name', async ({ ade, profile }) => {
  const folder = join(profile.root, 'folders', 'notes')
  await mkdir(folder, { recursive: true })
  const notes = (await profile.call('workspace.open', { path: await realpath(folder) })).workspace
  const plain = await refusal(profile.call('workspace.create_worktree', { project_id: notes.project_id, name: 'x' }))
  expect(plain.code).toBe('project_not_repository')
  const missing = await refusal(profile.call('workspace.create_worktree', { project_id: 'repo_missing', name: 'x' }))
  expect(missing.code).toBe('project_not_found')
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const invalid = await refusal(profile.call('workspace.create_worktree', { project_id: main.project_id, name: ' ' }))
  expect(invalid.code).toBe('invalid_workspace_name')
  const cli = await profile.cli('workspace', 'create-worktree', notes.project_id, 'x')
  expect(cli.code).toBe(25)
  // Nothing was created.
  expect((await repo.git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
})

test('delete_worktree refuses a dirty tree, the main checkout and a folder before changing anything', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { workspaceId, path } = await worktreeOf(profile, main.project_id, 'Dirty')
  await writeFile(join(path, 'scratch.txt'), 'uncommitted\n')

  const dirty = await refusal(profile.call('workspace.delete_worktree', { workspace_id: workspaceId }))
  expect(dirty.code).toBe('worktree_delete_blocked')
  expect(dirty.details.blockers).toContainEqual(expect.objectContaining({ kind: 'dirty', id: path }))
  // Nothing changed: the workspace is listed and the tree is there.
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).toContain(workspaceId)
  expect(existsSync(join(path, 'scratch.txt'))).toBe(true)
  const cli = await profile.cli('workspace', 'delete-worktree', workspaceId)
  expect(cli.code).toBe(24)
  expect(cli.json).toMatchObject({
    code: 'worktree_delete_blocked',
    blockers: [expect.objectContaining({ kind: 'dirty' })],
  })

  const primary = await refusal(profile.call('workspace.delete_worktree', { workspace_id: main.id }))
  expect(primary.details.blockers).toEqual([expect.objectContaining({ kind: 'primary_checkout' })])
  const folderPath = join(profile.root, 'folders', 'plain')
  await mkdir(folderPath, { recursive: true })
  const plain = (await profile.call('workspace.open', { path: await realpath(folderPath) })).workspace
  const folder = await refusal(profile.call('workspace.delete_worktree', { workspace_id: plain.id }))
  expect(folder.details.blockers).toEqual([expect.objectContaining({ kind: 'not_a_worktree', id: plain.id })])
  const missing = await refusal(profile.call('workspace.delete_worktree', { workspace_id: 'workspace_missing' }))
  expect(missing.code).toBe('workspace_not_found')

  // Once clean, it is deleted: workspace and tree both go, and a retry replays.
  await rm(join(path, 'scratch.txt'))
  const id = operationId('delete')
  const deleted = await profile.cli('--operation-id', id, 'workspace', 'delete-worktree', workspaceId, '--wait')
  expect(deleted.code, deleted.stderr).toBe(0)
  expect(deleted.json).toMatchObject({ kind: 'delete_worktree', status: 'succeeded', workspace_id: workspaceId })
  expect(existsSync(path)).toBe(false)
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
  const replay = await profile.call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId })
  expect(replay).toEqual(deleted.json)
})

test('a daemon crash between removing the workspace and removing the tree recovers @fault', async ({ ade }) => {
  const pause = join(ade.root, 'pause-delete')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_RECEIPT_PAUSE_DIR: pause } })
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { workspaceId, path } = await worktreeOf(profile, main.project_id, 'Crash')

  const armed = join(pause, 'workspace.delete_worktree.armed')
  await writeFile(armed, '')
  const id = operationId('delete')
  const pending = profile
    .call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId })
    .catch((error: unknown) => error)
  await expect.poll(() => existsSync(join(pause, 'workspace.delete_worktree.paused')), { timeout: 30_000 }).toBe(true)
  // Paused between the steps: the workspace is removed, the tree is not.
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
  expect(existsSync(path)).toBe(true)

  await rm(armed)
  await profile.restartDaemon('kill')
  await pending
  // The new daemon takes the next step itself; a retry reads the outcome.
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(false)
  const state = await finished(() =>
    profile.call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId }),
  )
  expect(state).toMatchObject({ status: 'succeeded', workspace_id: workspaceId, worktree_path: path })
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
})

test('create_worktree with show_in shows the new workspace in that window once it is ready', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  await profile.call('window.create', { window_id: 'asking', workspace_id: main.id })
  const id = operationId('create')
  const state = await finished(() =>
    profile.call('workspace.create_worktree', {
      operation_id: id,
      project_id: main.project_id,
      name: 'Shown',
      show_in: 'asking',
    }),
  )
  expect(state).toMatchObject({ status: 'succeeded' })
  const window = (await catalog(profile)).windows.find((item) => item.id === 'asking')!
  expect(window.workspace_id).toBe(state.workspace_id)
  expect(window.view.recent_workspaces).toEqual([state.workspace_id, main.id])

  // A window that is gone by then leaves the creation successful.
  const unshown = operationId('create')
  const gone = await finished(() =>
    profile.call('workspace.create_worktree', {
      operation_id: unshown,
      project_id: main.project_id,
      name: 'Unshown',
      show_in: 'window-missing',
    }),
  )
  expect(gone).toMatchObject({ status: 'succeeded' })
})
