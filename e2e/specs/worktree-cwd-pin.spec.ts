import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)

async function commitFixture(path: string, marker: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', '-b', 'main', path])
  await writeFile(join(path, 'identity.txt'), marker)
  await execFileAsync('git', ['add', 'identity.txt'], { cwd: path })
  await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', 'fixture'], { cwd: path })
}

async function waitForOperation(socket: string, repositoryId: string, requestId: string,
  expected: string): Promise<void> {
  await expect.poll(async () => {
    const state = await rpc(socket, { op: 'worktree.operation', repository_id: repositoryId,
      request_id: requestId })
    return (state.operation as { status: string }).status
  }, { timeout: 15_000 }).toBe(expected)
  if (expected === 'failed') {
    const operation = await rpc(socket, { op: 'worktree.operation', repository_id: repositoryId,
      request_id: requestId })
    expect(operation.operation).toMatchObject({ status: 'failed', code: 'needs_rebind' })
  }
}

test('a Git lifecycle operation refuses a replacement checkout installed before worker spawn', async () => {
  test.setTimeout(45_000)
  const outside = await mkdtemp(join(tmpdir(), 'ade-worktree-cwd-pin-'))
  const pause = join(outside, 'pause')
  const repository = join(outside, 'source')
  const moved = join(outside, 'moved-source')
  await mkdir(pause)
  await commitFixture(repository, 'original physical checkout\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_WORKTREE_SPAWN_PAUSE_DIR: pause })
  try {
    const lifecycle = (await rpc(daemon.socket, { op: 'worktree.repository', path: repository }))
      .repository as { id: string }
    await writeFile(join(pause, 'armed'), '')
    const requestId = 'reject-replaced-checkout'
    await rpc(daemon.socket, { op: 'worktree.switch', repository_id: lifecycle.id,
      request_id: requestId, target: 'must-not-be-created', base: 'main', create: true })
    await expect.poll(async () => readFile(join(pause, 'signal'), 'utf8').catch(() => null),
      { timeout: 5_000 }).toBe('ready')

    // The daemon admitted the original checkout. Its first Git command is
    // paused before spawning, so the worker will inherit a different directory.
    await rename(repository, moved)
    await commitFixture(repository, 'replacement physical checkout\n')
    await rm(join(pause, 'armed'))
    await writeFile(join(pause, 'release'), '')

    await waitForOperation(daemon.socket, lifecycle.id, requestId, 'failed')
    const branch = await execFileAsync('git', ['branch', '--list', 'must-not-be-created'],
      { cwd: repository })
    expect(branch.stdout.trim()).toBe('')
    expect(await readFile(join(repository, 'identity.txt'), 'utf8'))
      .toBe('replacement physical checkout\n')
    expect(await readFile(join(moved, 'identity.txt'), 'utf8'))
      .toBe('original physical checkout\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})

test('a Git lifecycle worker refuses an in-place replacement Git common directory', async () => {
  test.setTimeout(45_000)
  const outside = await mkdtemp(join(tmpdir(), 'ade-worktree-common-pin-'))
  const pause = join(outside, 'pause')
  const repository = join(outside, 'source')
  await mkdir(pause)
  await commitFixture(repository, 'original Git common directory\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_WORKER_PAUSE_DIR: pause })
  try {
    const lifecycle = (await rpc(daemon.socket, { op: 'worktree.repository', path: repository }))
      .repository as { id: string }
    await writeFile(join(pause, 'armed'), '')
    const requestId = 'reject-replaced-git-common'
    await rpc(daemon.socket, { op: 'worktree.switch', repository_id: lifecycle.id,
      request_id: requestId, target: 'must-not-be-created', base: 'main', create: true })
    await expect.poll(async () => readFile(join(pause, 'signal'), 'utf8').catch(() => null),
      { timeout: 5_000 }).toBe('ready')

    await rename(join(repository, '.git'), join(outside, 'original-git-dir'))
    await execFileAsync('git', ['init', '-q', '-b', 'main', repository])
    await rm(join(pause, 'armed'))
    await writeFile(join(pause, 'release'), '')

    await waitForOperation(daemon.socket, lifecycle.id, requestId, 'failed')
    const branch = await execFileAsync('git', ['branch', '--list', 'must-not-be-created'],
      { cwd: repository })
    expect(branch.stdout.trim()).toBe('')
    expect(await readFile(join(repository, 'identity.txt'), 'utf8'))
      .toBe('original Git common directory\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})

test('Git lifecycle removal refuses a replacement target installed after ownership validation', async () => {
  test.setTimeout(60_000)
  const outside = await mkdtemp(join(tmpdir(), 'ade-worktree-remove-pin-'))
  const pause = join(outside, 'pause')
  const repository = join(outside, 'source')
  await mkdir(pause)
  await commitFixture(repository, 'source checkout\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_WORKTREE_REMOVE_PAUSE_DIR: pause })
  try {
    const lifecycle = (await rpc(daemon.socket, { op: 'worktree.repository', path: repository }))
      .repository as { id: string }
    await rpc(daemon.socket, { op: 'worktree.switch', repository_id: lifecycle.id,
      request_id: 'create-owned-for-remove-pin', target: 'owned-for-remove-pin',
      base: 'main', create: true })
    await waitForOperation(daemon.socket, lifecycle.id, 'create-owned-for-remove-pin', 'succeeded')
    const worktrees = (await rpc(daemon.socket, { op: 'worktree.get', repository_id: lifecycle.id }))
      .worktrees as Array<{ branch: string; path: string; ade_owned: boolean }>
    const owned = worktrees.find((item) => item.branch === 'owned-for-remove-pin')
    expect(owned).toMatchObject({ ade_owned: true, path: expect.any(String) })
    const target = String(owned?.path)
    const moved = join(outside, 'moved-owned-checkout')

    await writeFile(join(pause, 'armed'), '')
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: lifecycle.id,
      request_id: 'remove-replaced-target', path: target, delete_branch: 'keep' })
    await expect.poll(async () => readFile(join(pause, 'signal'), 'utf8').catch(() => null),
      { timeout: 5_000 }).toBe('ready')

    await rename(target, moved)
    await commitFixture(target, 'unrelated replacement checkout\n')
    await rm(join(pause, 'armed'))
    await writeFile(join(pause, 'release'), '')

    await waitForOperation(daemon.socket, lifecycle.id, 'remove-replaced-target', 'failed')
    expect(await readFile(join(target, 'identity.txt'), 'utf8'))
      .toBe('unrelated replacement checkout\n')
    expect(await readFile(join(moved, 'identity.txt'), 'utf8')).toBe('source checkout\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})
