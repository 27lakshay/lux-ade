// Shared steps for the files and Git specs: open a workspace, read review
// status, run a Git effect command and wait for its receipt to settle.
import { randomUUID } from 'node:crypto'
import { expect, type ScratchProfile } from '../fixtures'

export type GitOperation = {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  op: string
  started_at: number
  finished_at?: number
  result?: Record<string, unknown>
  error?: string
  backup_path?: string
}

export const operationId = (label: string) => `${label}-${randomUUID()}`

export async function openWorkspace(profile: ScratchProfile, path: string): Promise<string> {
  return (await profile.call('workspace.open', { path })).workspace.id
}

export async function status(profile: ScratchProfile, workspace_id: string) {
  return profile.call('review.status', { workspace_id, force: true })
}

/** Poll `review.operation` until the receipt leaves `running`. */
export async function settled(profile: ScratchProfile, workspace_id: string, operation_id: string): Promise<GitOperation> {
  let last: GitOperation | undefined
  await expect.poll(async () => {
    last = (await profile.call('review.operation', { workspace_id, operation_id })).operation as GitOperation
    return last.status
  }, { timeout: 30_000, message: `Git operation ${operation_id} to settle` }).not.toBe('running')
  return last!
}

type Mutation = 'review.stage' | 'review.unstage' | 'review.discard' | 'review.commit' | 'review.hunk'
  | 'review.branch' | 'review.stash' | 'review.merge' | 'review.fetch' | 'review.pull' | 'review.push'

/** Admit one Git effect command over the SDK and wait for its settled receipt. */
export async function git<O extends Mutation>(profile: ScratchProfile, op: O,
  request: Record<string, unknown> & { workspace_id: string; operation_id?: string }): Promise<GitOperation> {
  const operation_id = request.operation_id ?? operationId(op.slice('review.'.length))
  const admitted = await profile.call(op, { ...request, operation_id } as never)
  const operation = (admitted as unknown as { operation: GitOperation }).operation
  expect(operation.id).toBe(operation_id)
  return operation.status === 'running' ? settled(profile, request.workspace_id, operation_id) : operation
}
