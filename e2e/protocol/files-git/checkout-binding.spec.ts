// Review Git stays bound to the checkout a workspace was opened on: a checkout
// moved and replaced, or a Git directory swapped, while a mutation waits is
// refused with needs_rebind, and nothing is staged anywhere. The daemon's review
// worker pauses through ADE_E2E_REVIEW_PAUSE_DIR and writes the settled receipt
// to `done`. Ported from the legacy e2e/specs/review-cwd-binding spec.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type AdeHarness, type ScratchProfile } from '../fixtures'
import { scratchEnvironment } from '../fixtures/environment'
import { openWorkspace } from './steps'

const run = promisify(execFile)

async function pausedProfile(ade: AdeHarness): Promise<{ profile: ScratchProfile; pause: string }> {
  const pause = join(ade.root, 'pause')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_REVIEW_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' } })
  return { profile, pause }
}

/** Admit a stage that pauses before its Git step, change the checkout, release it and return the settled receipt. */
async function stageAcross(
  profile: ScratchProfile,
  pause: string,
  workspace_id: string,
  operation_id: string,
  change: () => Promise<void>,
): Promise<{ status: string; code?: string }> {
  const { revision } = await profile.call('review.status', { workspace_id })
  await writeFile(join(pause, 'armed'), '')
  const started = await profile.call('review.stage', { workspace_id, operation_id, revision, path: 'tracked.txt' })
  expect(started.operation).toMatchObject({ id: operation_id, status: 'running' })
  await expect.poll(() => existsSync(join(pause, 'signal')), { timeout: 15_000 }).toBe(true)
  await change()
  await writeFile(join(pause, 'release'), '')
  await expect.poll(() => existsSync(join(pause, 'done')), { timeout: 15_000 }).toBe(true)
  return JSON.parse(await readFile(join(pause, 'done'), 'utf8')) as { status: string; code?: string }
}

test('review Git never stages a replacement checkout after its saved path moves', async ({ ade }) => {
  const { profile, pause } = await pausedProfile(ade)
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'committed\n' } })
  await repo.write('tracked.txt', 'original change\n')
  const moved = join(dirname(repo.path), 'moved')
  const workspace_id = await openWorkspace(profile, repo.path)
  const result = await stageAcross(profile, pause, workspace_id, 'review-cwd-replacement', async () => {
    await rename(repo.path, moved)
    // The saved path no longer exists, so Git runs from the harness root.
    await run('git', ['clone', '-q', moved, repo.path], {
      cwd: ade.root,
      env: scratchEnvironment(join(ade.root, 'git-home')),
    })
    await repo.write('tracked.txt', 'replacement change\n')
  })
  expect(result).toMatchObject({ status: 'failed', code: 'needs_rebind' })
  expect(await repo.git('diff', '--cached', '--name-only')).toBe('')
  expect(await repo.git('diff', '--name-only')).toBe('tracked.txt')
  expect(await repo.git('-C', moved, 'diff', '--cached', '--name-only')).toBe('')
  await expect(profile.call('review.status', { workspace_id })).rejects.toThrow(/needs_rebind/)
})

test('review from a nested workspace keeps the repository root bound', async ({ ade, profile }) => {
  const repo = await ade.repo()
  await mkdir(join(repo.path, 'nested'))
  await repo.write('tracked.txt', 'change\n')
  const workspace_id = await openWorkspace(profile, join(repo.path, 'nested'))
  expect(await profile.call('review.status', { workspace_id })).toMatchObject({
    type: 'review_status',
    root: await realpath(repo.path),
    files: expect.arrayContaining([expect.objectContaining({ path: 'tracked.txt' })]),
  })
})

test('review Git refuses a changed common directory within the same checkout', async ({ ade }) => {
  const { profile, pause } = await pausedProfile(ade)
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'committed\n' } })
  const unrelated = await ade.repo({ name: 'unrelated', initialFiles: { 'tracked.txt': 'committed\n' } })
  await repo.write('tracked.txt', 'checkout change\n')
  await unrelated.write('tracked.txt', 'unrelated change\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const result = await stageAcross(profile, pause, workspace_id, 'review-common-replacement', async () => {
    await rename(join(repo.path, '.git'), join(repo.path, '.git-saved'))
    await symlink(join(unrelated.path, '.git'), join(repo.path, '.git'))
  })
  expect(result).toMatchObject({ status: 'failed', code: 'needs_rebind' })
  expect(await unrelated.git('diff', '--cached', '--name-only')).toBe('')
  await expect(profile.call('review.status', { workspace_id })).rejects.toThrow(/needs_rebind/)
})
