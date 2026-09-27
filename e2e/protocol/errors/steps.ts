// Steps the error-propagation specs share. Each sets up a real daemon refusal
// or reads one back through the SDK and the CLI. Every wait polls; none sleeps.
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DaemonRequestError } from '../../../packages/client/dist/index.js'
import { expect, type AdeHarness, type CliResult, type ScratchProfile, type ScratchRepo } from '../fixtures'

/** The rejection of `attempt`, which must be the SDK's `DaemonRequestError`. */
export async function sdkError(attempt: Promise<unknown>): Promise<DaemonRequestError> {
  const error = await attempt.then(
    (reply) => { throw new Error(`Expected a refusal, got ${JSON.stringify(reply)}`) },
    (failure: unknown) => failure)
  expect(error).toMatchObject({ name: 'DaemonRequestError' })
  return error as DaemonRequestError
}

/** A CLI run that must fail with an error body on stderr. */
export function cliError(result: CliResult): Record<string, unknown> {
  expect(result.code, result.stderr).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.json, result.stderr).toMatchObject({ type: 'error' })
  return result.json!
}

/** A linked tree made with plain Git, outside ADE, on a new branch. Returns its canonical path. */
export async function externalTree(ade: AdeHarness, repo: ScratchRepo, branch: string): Promise<string> {
  const path = join(ade.root, 'trees', branch)
  await repo.git('worktree', 'add', '--quiet', '-b', branch, path)
  return realpath(path)
}

/** Register `repoPath` in `profile` and adopt `tree` there, so that profile may remove it. */
export async function adopt(profile: ScratchProfile, repoPath: string, tree: string): Promise<string> {
  const repositoryId = (await profile.call('worktree.repository', { path: repoPath })).repository.id
  await profile.call('worktree.adopt', { repository_id: repositoryId, path: tree, confirm_path: tree })
  return repositoryId
}

/** Open `tree` as a workspace in `profile` and start its shell, which claims the checkout for use. */
export async function occupy(profile: ScratchProfile, tree: string) {
  const { workspace } = await profile.call('workspace.open', { path: tree })
  const inspected = await profile.cli('terminal', 'inspect', workspace.id, workspace.terminal_id)
  expect(inspected.code, inspected.stderr).toBe(0)
  const metrics = (inspected.json as { metrics: { shell_pid: number; shell_running: boolean } }).metrics
  expect(metrics.shell_running).toBe(true)
  return { workspace, shellPid: metrics.shell_pid }
}

/** Wait until `profile` sees a use claim on `tree`. */
export async function waitForClaim(profile: ScratchProfile, tree: string): Promise<void> {
  await expect.poll(async () => (await profile.call('resources.inspect', { path: tree, resource: 'checkout' }))
    .claims.length).toBeGreaterThan(0)
}
