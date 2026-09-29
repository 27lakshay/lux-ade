// Git lifecycle work stays pinned to the checkout it admitted: a checkout, a
// Git common directory or a removal target replaced while the worker is
// paused is refused with needs_rebind and nothing is created or removed. The
// daemon pauses through its debug pause directories (ADE_E2E_WORKTREE_*_DIR,
// ADE_E2E_WORKER_PAUSE_DIR). Ported from the legacy e2e/specs/worktree-cwd-pin spec.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, ScratchRepo, test, type AdeHarness, type ScratchProfile } from '../fixtures'
import { scratchEnvironment } from '../fixtures/environment'
import { register, settled } from './lifecycle'

async function pausedProfile(ade: AdeHarness, variable: string): Promise<{ profile: ScratchProfile; pause: string }> {
  const pause = join(ade.root, 'pause')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', [variable]: pause } })
  return { profile, pause }
}

/** A repository with one commit of `identity.txt` at exactly `path`. */
function checkoutAt(ade: AdeHarness, path: string, marker: string): Promise<ScratchRepo> {
  return ScratchRepo.create(path, scratchEnvironment(join(ade.root, 'git-home')), {
    initialFiles: { 'identity.txt': marker },
  })
}

async function paused(pause: string): Promise<void> {
  await expect.poll(async () => readFile(join(pause, 'signal'), 'utf8').catch(() => null)).toBe('ready')
}

async function release(pause: string): Promise<void> {
  await rm(join(pause, 'armed'))
  await writeFile(join(pause, 'release'), '')
}

async function refused(profile: ScratchProfile, projectId: string, operationId: string): Promise<void> {
  expect(await settled(profile, projectId, operationId)).toMatchObject({ status: 'failed', code: 'needs_rebind' })
}

test('a Git lifecycle operation refuses a replacement checkout installed before worker spawn', async ({ ade }) => {
  const { profile, pause } = await pausedProfile(ade, 'ADE_E2E_WORKTREE_SPAWN_PAUSE_DIR')
  const repo = await ade.repo({ name: 'source', initialFiles: { 'identity.txt': 'original physical checkout\n' } })
  const moved = join(dirname(repo.path), 'moved-source')
  const projectId = await register(profile, repo)
  await writeFile(join(pause, 'armed'), '')
  const operationId = 'reject-replaced-checkout'
  await profile.call('worktree.switch', {
    project_id: projectId,
    operation_id: operationId,
    target: 'must-not-be-created',
    base: 'main',
    create: true,
  })
  await paused(pause)

  // The daemon admitted the original checkout. Its first Git command is
  // paused before spawning, so the worker would inherit a different directory.
  await rename(repo.path, moved)
  const replacement = await checkoutAt(ade, repo.path, 'replacement physical checkout\n')
  await release(pause)

  await refused(profile, projectId, operationId)
  expect(await replacement.git('branch', '--list', 'must-not-be-created')).toBe('')
  expect(await replacement.read('identity.txt')).toBe('replacement physical checkout\n')
  expect(await readFile(join(moved, 'identity.txt'), 'utf8')).toBe('original physical checkout\n')
})

test('a Git lifecycle worker refuses an in-place replacement Git common directory', async ({ ade }) => {
  const { profile, pause } = await pausedProfile(ade, 'ADE_E2E_WORKER_PAUSE_DIR')
  const repo = await ade.repo({ name: 'source', initialFiles: { 'identity.txt': 'original Git common directory\n' } })
  const projectId = await register(profile, repo)
  await writeFile(join(pause, 'armed'), '')
  const operationId = 'reject-replaced-git-common'
  await profile.call('worktree.switch', {
    project_id: projectId,
    operation_id: operationId,
    target: 'must-not-be-created',
    base: 'main',
    create: true,
  })
  await paused(pause)

  await rename(join(repo.path, '.git'), join(dirname(repo.path), 'original-git-dir'))
  await repo.git('init', '-q', '-b', 'main')
  await release(pause)

  await refused(profile, projectId, operationId)
  expect(await repo.git('branch', '--list', 'must-not-be-created')).toBe('')
  expect(await repo.read('identity.txt')).toBe('original Git common directory\n')
})

test('Git lifecycle removal refuses a replacement target installed after ownership validation', async ({ ade }) => {
  const { profile, pause } = await pausedProfile(ade, 'ADE_E2E_WORKTREE_REMOVE_PAUSE_DIR')
  const repo = await ade.repo({ name: 'source', initialFiles: { 'identity.txt': 'source checkout\n' } })
  const projectId = await register(profile, repo)
  await profile.call('worktree.switch', {
    project_id: projectId,
    operation_id: 'create-owned-for-remove-pin',
    target: 'owned-for-remove-pin',
    base: 'main',
    create: true,
  })
  expect(await settled(profile, projectId, 'create-owned-for-remove-pin')).toMatchObject({ status: 'succeeded' })
  const { worktrees } = await profile.call('worktree.get', { project_id: projectId })
  const owned = worktrees.find((item) => item.branch === 'owned-for-remove-pin')
  expect(owned).toMatchObject({ ade_owned: true, path: expect.any(String) })
  const target = String(owned?.path)
  const moved = join(ade.root, 'moved-owned-checkout')

  await writeFile(join(pause, 'armed'), '')
  await profile.call('worktree.remove', {
    project_id: projectId,
    operation_id: 'remove-replaced-target',
    path: target,
    delete_branch: 'keep',
  })
  await paused(pause)
  await rename(target, moved)
  await checkoutAt(ade, target, 'unrelated replacement checkout\n')
  await release(pause)

  await refused(profile, projectId, 'remove-replaced-target')
  expect(await readFile(join(target, 'identity.txt'), 'utf8')).toBe('unrelated replacement checkout\n')
  expect(await readFile(join(moved, 'identity.txt'), 'utf8')).toBe('source checkout\n')
})
