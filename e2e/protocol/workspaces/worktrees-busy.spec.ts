// Workspace worktree operations when the repository is busy or a step fails
// (review of daemon authority ticket 03). A repository another operation
// holds makes a step wait, never fail; the deletion checks its tree again
// before removing anything; a failing step fails its own operation, gives the
// workspace back where it can, and never stalls the others.
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { operationId, register } from '../worktrees/lifecycle'

const hold = (started: string, release: string) => ({
  name: 'wait',
  command: ['/bin/sh', '-c', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
  timeout_seconds: 60,
})

type State = {
  status: string
  workspace_id: string | null
  worktree_path: string | null
  error: string | null
  code: string | null
}

async function finished(send: () => Promise<State>): Promise<State> {
  let state: State | undefined
  await expect.poll(async () => (state = await send()).status, { timeout: 60_000 }).not.toBe('running')
  return state!
}

function createOf(profile: ScratchProfile, projectId: string, name: string, id = operationId('create')) {
  return () =>
    profile.call('workspace.create_worktree', { operation_id: id, project_id: projectId, name }) as Promise<State>
}

function deleteOf(profile: ScratchProfile, workspaceId: string, id = operationId('delete')) {
  return () =>
    profile.call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId }) as Promise<State>
}

async function listed(profile: ScratchProfile, id: string): Promise<boolean> {
  return (await profile.call('catalog.get', {})).catalog.workspaces.some((workspace) => workspace.id === id)
}

test('two deletes sent back to back in one repository both succeed', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  const first = await finished(createOf(profile, projectId, 'First'))
  const second = await finished(createOf(profile, projectId, 'Second'))
  const deleteFirst = deleteOf(profile, first.workspace_id!)
  const deleteSecond = deleteOf(profile, second.workspace_id!)
  await Promise.all([deleteFirst(), deleteSecond()])
  const [one, two] = await Promise.all([finished(deleteFirst), finished(deleteSecond)])
  expect(one, JSON.stringify(one)).toMatchObject({ status: 'succeeded' })
  expect(two, JSON.stringify(two)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(first.worktree_path!)).toBe(false)
  expect(existsSync(second.worktree_path!)).toBe(false)
})

test('while another worktree sets up, a creation and deletions wait; a tree dirtied meanwhile is refused untouched', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  const clean = await finished(createOf(profile, projectId, 'Clean'))
  const dirty = await finished(createOf(profile, projectId, 'Dirty'))

  const started = join(ade.root, 'setup-started')
  const release = join(ade.root, 'setup-release')
  await profile.call('worktree.configure', { repository_id: projectId, config: { setup: [hold(started, release)] } })
  const held = createOf(profile, projectId, 'Held')
  await held()
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)

  // The repository is busy: everything waits, and nothing is removed yet.
  const waiting = createOf(profile, projectId, 'Waiting')
  const deleteClean = deleteOf(profile, clean.workspace_id!)
  const deleteDirty = deleteOf(profile, dirty.workspace_id!)
  expect((await waiting()).status).toBe('running')
  expect((await deleteClean()).status).toBe('running')
  expect((await deleteDirty()).status).toBe('running')
  expect(await listed(profile, clean.workspace_id!)).toBe(true)
  expect(await listed(profile, dirty.workspace_id!)).toBe(true)

  await writeFile(join(dirty.worktree_path!, 'scratch.txt'), 'uncommitted\n')
  await writeFile(release, '')

  expect((await finished(held)).status).toBe('succeeded')
  const cleaned = await finished(deleteClean)
  expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(clean.worktree_path!)).toBe(false)
  const refused = await finished(deleteDirty)
  expect(refused, JSON.stringify(refused)).toMatchObject({ status: 'failed', code: 'worktree_delete_blocked' })
  // Refused before anything changed: the workspace is listed, its file kept.
  expect(await listed(profile, dirty.workspace_id!)).toBe(true)
  expect(existsSync(join(dirty.worktree_path!, 'scratch.txt'))).toBe(true)
  expect((await finished(waiting)).status).toBe('succeeded')
})

test('an operation ID the lifecycle already used for its own command is refused at admission', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  expect(await register(profile, repo)).toBe(projectId)
  const id = operationId('shared')
  await profile.call('worktree.refresh', { repository_id: projectId, operation_id: id })
  await expect(
    profile.call('workspace.create_worktree', { operation_id: id, project_id: projectId, name: 'Shared' }),
  ).rejects.toMatchObject({ code: 'conflict' })
})

test('a failed rename fails the creation instead of retrying it forever @fault', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_WORKTREE_FAILPOINT: 'rename' } })
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  const failed = await finished(createOf(profile, projectId, 'Renamed Later'))
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('failpoint rename')
  // The tree and its workspace exist, only unnamed; the next operation, which
  // renames nothing, is not held up by the failed one.
  expect(failed.workspace_id).toBeTruthy()
  const next = await finished(deleteOf(profile, failed.workspace_id!))
  expect(next, JSON.stringify(next)).toMatchObject({ status: 'succeeded' })
})

test('a tree that cannot be removed gives the workspace back, and says so @fault', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_WORKTREE_FAILPOINT: 'remove_tree' } })
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  const tree = await finished(createOf(profile, projectId, 'Kept'))
  const failed = await finished(deleteOf(profile, tree.workspace_id!))
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('without its previous layouts and terminals')
  expect(await listed(profile, tree.workspace_id!)).toBe(true)
  expect(existsSync(tree.worktree_path!)).toBe(true)
})

test('when the workspace cannot be restored either, the failure says how to bring it back @fault', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_WORKTREE_FAILPOINT: 'remove_tree,restore' } })
  const repo = await ade.repo()
  const { project_id: projectId } = (await profile.call('workspace.open', { path: repo.path })).workspace
  const tree = await finished(createOf(profile, projectId, 'Lost'))
  const failed = await finished(deleteOf(profile, tree.workspace_id!))
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('could not be restored')
  expect(await listed(profile, tree.workspace_id!)).toBe(false)
  // Opening its folder brings it back under the same ID.
  expect((await profile.call('workspace.open', { path: tree.worktree_path! })).workspace.id).toBe(tree.workspace_id)
})
