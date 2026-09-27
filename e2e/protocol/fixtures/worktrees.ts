// Linked worktrees made through the daemon's lifecycle ledger, the way a
// client creates one: register the repository, run `worktree.switch` with
// `create`, poll its receipt, then open the new tree as a workspace. Polls;
// never sleeps for a fixed time.
import { expect } from '@playwright/test'
import type { ScratchProfile } from './profile'

export type LinkedWorktree = {
  repositoryId: string
  /** The `worktree.switch` operation that created the tree. */
  operationId: string
  path: string
  workspaceId: string
}

/** The lifecycle repository ID of the Git repository at `path`. */
export async function repositoryId(profile: ScratchProfile, path: string): Promise<string> {
  return (await profile.call('worktree.repository', { path })).repository.id
}

/** Create `branch` in a new linked worktree of the repository at `repoPath`, and open it as a workspace. */
export async function createWorktree(profile: ScratchProfile, repoPath: string, branch: string,
  operationId = `e2e-worktree-${branch.replace(/[^A-Za-z0-9]/g, '-')}`): Promise<LinkedWorktree> {
  const repository = await repositoryId(profile, repoPath)
  await profile.call('worktree.switch', { repository_id: repository, operation_id: operationId, target: branch, create: true })
  let path = ''
  await expect.poll(async () => {
    const { operation } = await profile.call('worktree.operation', { repository_id: repository, operation_id: operationId })
    if (operation.status === 'succeeded' && operation.worktree_path) path = operation.worktree_path
    return operation.status
  }, { timeout: 30_000 }).toBe('succeeded')
  const { workspace } = await profile.call('workspace.open', { path })
  return { repositoryId: repository, operationId, path: workspace.root, workspaceId: workspace.id }
}
