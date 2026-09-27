// Steps the reliability-c specs share. Every wait polls a query or the file
// system; none sleeps.
import { access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type AdeHarness, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

let refreshes = 0

export async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** A linked tree made with plain Git, outside ADE, on a new branch. Returns its canonical path. */
export async function externalTree(ade: AdeHarness, repo: ScratchRepo, branch: string): Promise<string> {
  const path = join(ade.root, 'repos', `${branch}-tree`)
  await repo.git('worktree', 'add', '--quiet', '-b', branch, path)
  return realpath(path)
}

/** Wait for a worktree lifecycle operation to leave `running` and return it. */
export async function settledOperation(profile: ScratchProfile, repositoryId: string, operationId: string) {
  let status = 'running'
  await expect.poll(async () => {
    status = (await profile.call('worktree.operation', { repository_id: repositoryId, operation_id: operationId }))
      .operation.status
    return status
  }, { timeout: 30_000 }).not.toBe('running')
  return status
}

/** Refresh the repository listing and wait for it. */
export async function refresh(profile: ScratchProfile, repositoryId: string): Promise<void> {
  const operationId = `refresh-${process.pid}-${++refreshes}`
  await profile.call('worktree.refresh', { repository_id: repositoryId, operation_id: operationId })
  expect(await settledOperation(profile, repositoryId, operationId)).toBe('succeeded')
}

/** Register the repository in `profile` and adopt `tree` there, giving that profile removal authority. */
export async function adopt(profile: ScratchProfile, repoPath: string, tree: string): Promise<string> {
  const repositoryId = (await profile.call('worktree.repository', { path: repoPath })).repository.id
  await profile.call('worktree.adopt', { repository_id: repositoryId, path: tree, confirm_path: tree })
  await refresh(profile, repositoryId)
  const state = await profile.call('worktree.get', { repository_id: repositoryId })
  expect(state.worktrees.find((item) => item.path === tree)?.ade_owned).toBe(true)
  return repositoryId
}

/** Open `tree` as a workspace and start its terminal shell through the CLI. Returns the shell's PID. */
export async function launchShell(profile: ScratchProfile, tree: string) {
  const { workspace } = await profile.call('workspace.open', { path: tree })
  const inspected = await profile.cli('terminal', 'inspect', workspace.id, workspace.terminal_id)
  expect(inspected.code, inspected.stderr).toBe(0)
  const metrics = (inspected.json as { metrics: { shell_pid: number; shell_running: boolean } }).metrics
  expect(metrics.shell_running).toBe(true)
  return { workspace, shellPid: metrics.shell_pid }
}

/** `worktree.remove` over the raw protocol, so the typed error code is visible. */
export function removeTree(profile: ScratchProfile, repositoryId: string, operationId: string, tree: string) {
  return rawReply(profile, { op: 'worktree.remove', repository_id: repositoryId, operation_id: operationId,
    path: tree, confirm_path: tree })
}

/** Checkout claims on, inside or around `path`, as `profile` sees them. */
export async function claimsOn(profile: ScratchProfile, path: string) {
  return (await profile.call('resources.inspect', { path, resource: 'checkout' })).claims
}

/** Nearest-rank percentile of `values` (0 < p <= 100). */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}
