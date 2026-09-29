// Steps the resources specs share: worktree lifecycle and terminal launches
// through the SDK and CLI, and HostResources inspection. Every wait polls a
// query or the file system; none sleeps.
import { access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { type AdeHarness, expect, primaryShell, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

type Profile = ScratchProfile

let refreshes = 0

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Wait for a worktree lifecycle operation to leave `running` and return it. */
export async function settledOperation(profile: Profile, repositoryId: string, operationId: string, timeout = 30_000) {
  let operation: Awaited<ReturnType<typeof readOperation>> | undefined
  await expect
    .poll(
      async () => {
        operation = await readOperation(profile, repositoryId, operationId)
        return operation.status
      },
      { timeout },
    )
    .not.toBe('running')
  return operation!
}

async function readOperation(profile: Profile, repositoryId: string, operationId: string) {
  return (await profile.call('worktree.operation', { project_id: repositoryId, operation_id: operationId })).operation
}

/** A linked tree made with plain Git, outside ADE, on a new branch. Returns its canonical path. */
export async function externalTree(ade: AdeHarness, repo: ScratchRepo, branch: string): Promise<string> {
  const path = join(ade.root, 'repos', `${branch}-tree`)
  await repo.git('worktree', 'add', '--quiet', '-b', branch, path)
  return realpath(path)
}

/** Register the repository in `profile` and adopt `tree` there, giving that profile removal authority. */
export async function adopt(profile: Profile, repoPath: string, tree: string): Promise<string> {
  const repositoryId = (await profile.call('worktree.repository', { path: repoPath })).repository.id
  await profile.call('worktree.adopt', { project_id: repositoryId, path: tree, confirm_path: tree })
  // The adopt reply carries the cached listing; refresh it to read the authority back.
  const refresh = `refresh-${++refreshes}`
  await profile.call('worktree.refresh', { project_id: repositoryId, operation_id: refresh })
  expect((await settledOperation(profile, repositoryId, refresh)).status).toBe('succeeded')
  const state = await profile.call('worktree.get', { project_id: repositoryId })
  expect(state.worktrees.find((item) => item.path === tree)?.ade_owned).toBe(true)
  return repositoryId
}

/**
 * Open `tree` as a workspace and start its terminal shell through the CLI,
 * which is how work launches in a checkout. Returns the shell's PID.
 */
export async function launchShell(profile: Profile, tree: string) {
  const { workspace } = await profile.call('workspace.open', { path: tree })
  return startShell(profile, workspace)
}

/**
 * Start an opened workspace's primary shell through the CLI. A refusal is
 * returned, not thrown.
 */
export async function startShell(profile: Profile, workspace: { id: string }) {
  const shellId = await primaryShell(profile, workspace.id)
  const inspected = await profile.cli('terminal', 'inspect', workspace.id, shellId)
  if (inspected.code !== 0)
    return { workspace, shellId, launched: false as const, error: inspected.json ?? inspected.stderr }
  const metrics = (inspected.json as { metrics: { shell_pid: number; shell_running: boolean } }).metrics
  expect(metrics.shell_running).toBe(true)
  return { workspace, shellId, launched: true as const, shellPid: metrics.shell_pid }
}

/** `worktree.remove` over the raw protocol, so the typed error code is visible. */
export function removeTree(profile: Profile, repositoryId: string, operationId: string, tree: string) {
  return rawReply(profile, {
    op: 'worktree.remove',
    project_id: repositoryId,
    operation_id: operationId,
    path: tree,
    confirm_path: tree,
  })
}

/** Checkout claims on, inside or around `path`, as `profile` sees them. */
export async function claimsOn(profile: Profile, path: string) {
  return (await profile.call('resources.inspect', { path, resource: 'checkout' })).claims
}

/** The profile ID a daemon claims for. */
export async function profileId(profile: Profile): Promise<string> {
  return (await profile.call('resources.inspect', {})).profile
}

/** Whether `tree` is still a linked tree in Git's own listing. */
export async function gitListsTree(repo: ScratchRepo, tree: string): Promise<boolean> {
  const listing = await repo.git('worktree', 'list', '--porcelain')
  return listing.split('\n').some((line) => line === `worktree ${tree}`)
}
