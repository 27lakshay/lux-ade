// Worktree lifecycle steps over the SDK. Lifecycle effect commands reply with
// the repository state at admission and run on a worker; every wait here polls
// `worktree.operation` until the ledger row leaves `running`. Nothing sleeps.
import { expect, type ScratchProfile, type ScratchRepo } from '../fixtures'

export type Operation = {
  id: string
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted'
  worktree_path?: string | null
  result: Record<string, any> | null
  error: string | null
  code?: string
  recovery?: string
}

let operationNumber = 0

/** A fresh operation ID, unique across workers. */
export function operationId(label: string): string {
  return `e2e-${label}-${process.pid}-${++operationNumber}`
}

/** Register the repository at `repo.path` with the lifecycle and return its ID. */
export async function register(profile: ScratchProfile, repo: ScratchRepo): Promise<string> {
  const state = await profile.call('worktree.repository', { path: repo.path })
  return state.repository.id
}

export async function operation(profile: ScratchProfile, repositoryId: string, id: string): Promise<Operation> {
  const reply = await profile.call('worktree.operation', { repository_id: repositoryId, operation_id: id })
  return reply.operation as unknown as Operation
}

/** Wait until the operation has settled and return its full ledger row. */
export async function settled(
  profile: ScratchProfile,
  repositoryId: string,
  id: string,
  timeout = 30_000,
): Promise<Operation> {
  let row: Operation | undefined
  await expect
    .poll(
      async () => {
        row = await operation(profile, repositoryId, id)
        return row.status
      },
      { timeout },
    )
    .not.toBe('running')
  return row!
}

/** Create a tree with `worktree.create`, wait for it, and return the settled operation. */
export async function create(
  profile: ScratchProfile,
  repositoryId: string,
  request: {
    name?: string
    branch?: string
    base?: string
    path?: string
    fetch?: { remote: string; ref: string }
  } = {},
  id = operationId('create'),
): Promise<Operation> {
  await profile.call('worktree.create', { repository_id: repositoryId, operation_id: id, ...request })
  return settled(profile, repositoryId, id)
}

/** Create a tree that must succeed, and return its path. */
export async function createReady(
  profile: ScratchProfile,
  repositoryId: string,
  request: Parameters<typeof create>[2] = {},
): Promise<string> {
  const row = await create(profile, repositoryId, request)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded' })
  expect(row.worktree_path).toBeTruthy()
  return row.worktree_path!
}

/** The listed tree at `path`, or undefined. */
export async function item(profile: ScratchProfile, repositoryId: string, path: string) {
  const state = await profile.call('worktree.get', { repository_id: repositoryId })
  return state.worktrees.find((tree) => tree.path === path)
}
