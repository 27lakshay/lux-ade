import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
type Review = { revision: string; index_token: string; files: Array<{ path: string; staged: boolean; unstaged: boolean }> }

test('Git stage, unstage and commit preserve revision checks and request identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-mutations-'))
  const checkout = join(directory, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await run('git', ['-C', checkout, 'config', 'user.name', 'ADE Fixture'])
  await run('git', ['-C', checkout, 'config', 'user.email', 'ade@example.invalid'])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', ['-C', checkout, 'commit', '-qm', 'baseline'])
  await writeFile(join(checkout, 'tracked.txt'), 'updated\n')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const status = async (): Promise<Review> => await rpc(daemon.socket, { op: 'review.status',
      workspace_id: workspace.id, force: true }) as unknown as Review
    const settle = async (requestId: string): Promise<{ status: string; error?: string; result?: { head?: string } }> => {
      let operation: { status: string; error?: string; result?: { head?: string } } | null = null
      await expect.poll(async () => {
        const reply = await rpc(daemon.socket, { op: 'review.operation', workspace_id: workspace.id,
          request_id: requestId })
        operation = reply.operation as typeof operation
        return operation?.status
      }).toMatch(/^(succeeded|failed|interrupted)$/)
      return operation!
    }
    const initial = await status()
    const stage = { op: 'review.stage', workspace_id: workspace.id, request_id: 'stage-first',
      path: 'tracked.txt', revision: initial.revision }
    await rpc(daemon.socket, stage)
    expect((await settle('stage-first')).status).toBe('succeeded')
    expect((await run('git', ['-C', checkout, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('tracked.txt')
    expect((await rpc(daemon.socket, stage)).operation).toMatchObject({ status: 'succeeded' })
    await expect(rpc(daemon.socket, { ...stage, path: 'other.txt' })).rejects.toThrow(/different parameters/i)

    const staged = await status()
    await rpc(daemon.socket, { op: 'review.unstage', workspace_id: workspace.id,
      request_id: 'unstage-first', path: 'tracked.txt', revision: staged.revision })
    expect((await settle('unstage-first')).status).toBe('succeeded')
    expect((await run('git', ['-C', checkout, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('')

    const beforeExternalChange = await status()
    await writeFile(join(checkout, 'tracked.txt'), 'changed after review\n')
    await rpc(daemon.socket, { op: 'review.stage', workspace_id: workspace.id,
      request_id: 'stale-stage', path: 'tracked.txt', revision: beforeExternalChange.revision })
    expect((await settle('stale-stage')).status).toBe('failed')
    expect((await run('git', ['-C', checkout, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('')

    const fresh = await status()
    await rpc(daemon.socket, { op: 'review.stage', workspace_id: workspace.id,
      request_id: 'stage-fresh', path: 'tracked.txt', revision: fresh.revision })
    expect((await settle('stage-fresh')).status).toBe('succeeded')
    await rpc(daemon.socket, { op: 'review.commit', workspace_id: workspace.id,
      request_id: 'stale-commit', index_token: initial.index_token, message: 'should fail' })
    expect((await settle('stale-commit')).status).toBe('failed')

    const headBefore = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()
    const hook = join(checkout, '.git', 'hooks', 'pre-commit')
    await mkdir(join(checkout, '.git', 'hooks'), { recursive: true })
    await writeFile(hook, '#!/bin/sh\nexit 7\n')
    await chmod(hook, 0o755)
    const ready = await status()
    await rpc(daemon.socket, { op: 'review.commit', workspace_id: workspace.id,
      request_id: 'hook-failed', index_token: ready.index_token, message: 'blocked by hook' })
    expect((await settle('hook-failed')).status).toBe('failed')
    expect((await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore)
    await unlink(hook)

    const commit = { op: 'review.commit', workspace_id: workspace.id,
      request_id: 'commit-once', index_token: (await status()).index_token, message: 'ADE commit' }
    await rpc(daemon.socket, commit)
    const completed = await settle('commit-once')
    expect(completed.status).toBe('succeeded')
    const headAfter = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(headAfter).not.toBe(headBefore)
    expect(completed.result?.head).toBe(headAfter)
    expect((await rpc(daemon.socket, commit)).operation).toMatchObject({ status: 'succeeded' })
    await expect(rpc(daemon.socket, { ...commit, message: 'different work' })).rejects.toThrow(/different parameters/i)
    expect((await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(headAfter)
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
