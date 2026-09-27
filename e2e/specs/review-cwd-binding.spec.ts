import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)

test('review Git never stages a replacement checkout after its saved path moves', async () => {
  test.setTimeout(45_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-cwd-'))
  const pause = join(directory, 'pause')
  const checkout = join(directory, 'checkout')
  const moved = join(directory, 'moved')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'committed\n')
  await run('git', ['add', 'tracked.txt'], { cwd: checkout })
  await run(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'],
    { cwd: checkout },
  )
  await writeFile(join(checkout, 'tracked.txt'), 'original change\n')
  const daemon = await startDaemon({ ADE_E2E_REVIEW_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const status = await rpc(daemon.socket, { op: 'review.status', workspace_id: workspace.id })
    expect(status.type).toBe('review_status')
    await writeFile(join(pause, 'armed'), '')
    const requestId = 'review-cwd-replacement'
    const started = await rpc(daemon.socket, {
      op: 'review.stage',
      workspace_id: workspace.id,
      request_id: requestId,
      revision: status.revision,
      path: 'tracked.txt',
    })
    expect(started.operation).toMatchObject({ id: requestId, status: 'running' })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await rename(checkout, moved)
    await run('git', ['clone', '-q', moved, checkout])
    await writeFile(join(checkout, 'tracked.txt'), 'replacement change\n')
    await writeFile(join(pause, 'release'), '')
    await expect
      .poll(() =>
        stat(join(pause, 'done')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const result = JSON.parse(await readFile(join(pause, 'done'), 'utf8')) as { status: string; code?: string }
    expect(result).toMatchObject({ status: 'failed', code: 'needs_rebind' })
    expect((await run('git', ['diff', '--cached', '--name-only'], { cwd: checkout })).stdout.trim()).toBe('')
    expect((await run('git', ['diff', '--name-only'], { cwd: checkout })).stdout.trim()).toBe('tracked.txt')
    expect((await run('git', ['diff', '--cached', '--name-only'], { cwd: moved })).stdout.trim()).toBe('')
    await expect(rpc(daemon.socket, { op: 'review.status', workspace_id: workspace.id })).rejects.toThrow(
      /needs_rebind/,
    )
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('review from a nested workspace keeps the repository root bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-nested-'))
  const checkout = join(directory, 'checkout')
  const nested = join(checkout, 'nested')
  await run('git', ['init', '-q', checkout])
  await mkdir(nested)
  await writeFile(join(checkout, 'tracked.txt'), 'change\n')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: nested })).workspace as { id: string }
    const status = await rpc(daemon.socket, { op: 'review.status', workspace_id: workspace.id })
    expect(status).toMatchObject({
      type: 'review_status',
      root: await realpath(checkout),
      files: expect.arrayContaining([expect.objectContaining({ path: 'tracked.txt' })]),
    })
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('review Git refuses a changed common directory within the same checkout', async () => {
  test.setTimeout(45_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-common-'))
  const checkout = join(directory, 'checkout')
  const unrelated = join(directory, 'unrelated')
  const pause = join(directory, 'pause')
  await mkdir(pause)
  for (const root of [checkout, unrelated]) {
    await run('git', ['init', '-q', '-b', 'main', root])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await run('git', ['add', 'tracked.txt'], { cwd: root })
    await run(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'],
      { cwd: root },
    )
    await writeFile(join(root, 'tracked.txt'), `${root} change\n`)
  }
  const daemon = await startDaemon({ ADE_E2E_REVIEW_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const status = await rpc(daemon.socket, { op: 'review.status', workspace_id: workspace.id })
    await writeFile(join(pause, 'armed'), '')
    const started = await rpc(daemon.socket, {
      op: 'review.stage',
      workspace_id: workspace.id,
      request_id: 'review-common-replacement',
      revision: status.revision,
      path: 'tracked.txt',
    })
    expect(started.operation).toMatchObject({ status: 'running' })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await rename(join(checkout, '.git'), join(checkout, '.git-saved'))
    await symlink(join(unrelated, '.git'), join(checkout, '.git'))
    await writeFile(join(pause, 'release'), '')
    await expect
      .poll(() =>
        stat(join(pause, 'done')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const result = JSON.parse(await readFile(join(pause, 'done'), 'utf8')) as { status: string; code?: string }
    expect(result).toMatchObject({ status: 'failed', code: 'needs_rebind' })
    expect((await run('git', ['diff', '--cached', '--name-only'], { cwd: unrelated })).stdout.trim()).toBe('')
    await expect(rpc(daemon.socket, { op: 'review.status', workspace_id: workspace.id })).rejects.toThrow(
      /needs_rebind/,
    )
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
