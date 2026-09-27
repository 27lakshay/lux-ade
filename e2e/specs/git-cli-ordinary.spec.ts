import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd: directory })).stdout.trim()
}

async function ade(socket: string, ...args: string[]): Promise<{ code: number; body: Record<string, unknown> }> {
  try {
    const output = await run(process.execPath, [cli, '--socket', socket, ...args], { timeout: 15_000 })
    return { code: 0, body: JSON.parse(output.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, body: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

async function receipt(socket: string, workspaceId: string, requestId: string): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => {
      const result = await ade(socket, 'git', 'operation', workspaceId, requestId)
      expect(result.code).toBe(0)
      return (result.body.operation as { status: string }).status
    })
    .not.toBe('running')
  return (await ade(socket, 'git', 'operation', workspaceId, requestId)).body.operation as Record<string, unknown>
}

test('named CLI Git commands use reviewed revisions, preserve receipts and expose hook failures', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-cli-e2e-'))
  const checkout = join(directory, 'checkout')
  await mkdir(checkout)
  await git(checkout, 'init', '-q', '-b', 'main')
  await git(checkout, 'config', 'user.name', 'ADE E2E')
  await git(checkout, 'config', 'user.email', 'ade@example.invalid')
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(checkout, 'commit', '-qm', 'baseline')
  await writeFile(join(checkout, 'tracked.txt'), 'first change\n')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const status = await ade(daemon.socket, 'git', 'status', workspace.id)
    expect(status).toMatchObject({
      code: 0,
      body: { type: 'review_status', files: [expect.objectContaining({ path: 'tracked.txt', unstaged: true })] },
    })
    const oldRevision = status.body.revision as string
    expect((await ade(daemon.socket, 'git', 'stage', workspace.id, 'tracked.txt', oldRevision)).body).toMatchObject({
      code: 'usage',
    })
    await writeFile(join(checkout, 'tracked.txt'), 'newer change\n')
    const staleId = 'git-cli-stale-stage'
    const stale = await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'tracked.txt',
      oldRevision,
      '--request-id',
      staleId,
    )
    expect(stale).toMatchObject({ code: 0, body: { request_id: staleId, workspace_id: workspace.id } })
    expect(await receipt(daemon.socket, workspace.id, staleId)).toMatchObject({ status: 'failed' })
    expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('')

    const fresh = await ade(daemon.socket, 'git', 'status', workspace.id)
    expect(fresh.body.revision).not.toBe(oldRevision)
    const stageId = 'git-cli-stage'
    const staged = await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'tracked.txt',
      fresh.body.revision as string,
      '--request-id',
      stageId,
    )
    expect(staged.body).toMatchObject({ request_id: stageId, workspace_id: workspace.id })
    expect(await receipt(daemon.socket, workspace.id, stageId)).toMatchObject({ status: 'succeeded' })
    const repeated = await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'tracked.txt',
      fresh.body.revision as string,
      '--request-id',
      stageId,
    )
    expect(repeated.body.operation).toMatchObject({ id: stageId, status: 'succeeded' })
    const changed = await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'another.txt',
      fresh.body.revision as string,
      '--request-id',
      stageId,
    )
    expect(changed).toMatchObject({ code: 7, body: { code: 'daemon' } })
    expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('tracked.txt')

    const stagedStatus = await ade(daemon.socket, 'git', 'status', workspace.id)
    const unstageId = 'git-cli-unstage'
    await ade(
      daemon.socket,
      'git',
      'unstage',
      workspace.id,
      'tracked.txt',
      stagedStatus.body.revision as string,
      '--request-id',
      unstageId,
    )
    expect(await receipt(daemon.socket, workspace.id, unstageId)).toMatchObject({ status: 'succeeded' })
    expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('')
    const unstagedStatus = await ade(daemon.socket, 'git', 'status', workspace.id)
    await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'tracked.txt',
      unstagedStatus.body.revision as string,
      '--request-id',
      'git-cli-restage',
    )
    expect(await receipt(daemon.socket, workspace.id, 'git-cli-restage')).toMatchObject({ status: 'succeeded' })
    const beforeCommit = await ade(daemon.socket, 'git', 'status', workspace.id)
    const oldHead = await git(checkout, 'rev-parse', 'HEAD')
    await writeFile(join(checkout, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n', {
      mode: 0o700,
    })
    const hookId = 'git-cli-hook-failure'
    await ade(
      daemon.socket,
      'git',
      'commit',
      workspace.id,
      'change',
      beforeCommit.body.index_token as string,
      '--request-id',
      hookId,
    )
    expect(await receipt(daemon.socket, workspace.id, hookId)).toMatchObject({ status: 'failed' })
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(oldHead)
    await rm(join(checkout, '.git', 'hooks', 'pre-commit'))
    const afterHook = await ade(daemon.socket, 'git', 'status', workspace.id)
    await writeFile(join(checkout, 'external.txt'), 'external change\n')
    await git(checkout, 'add', '--', 'external.txt')
    await ade(
      daemon.socket,
      'git',
      'commit',
      workspace.id,
      'change',
      afterHook.body.index_token as string,
      '--request-id',
      'git-cli-stale-index',
    )
    expect(await receipt(daemon.socket, workspace.id, 'git-cli-stale-index')).toMatchObject({ status: 'failed' })
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(oldHead)
    expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('external.txt\ntracked.txt')
    await git(checkout, 'reset', '-q', 'HEAD', '--', 'external.txt')
    const current = await ade(daemon.socket, 'git', 'status', workspace.id)
    const commitId = 'git-cli-commit'
    await ade(
      daemon.socket,
      'git',
      'commit',
      workspace.id,
      'change',
      current.body.index_token as string,
      '--request-id',
      commitId,
    )
    const committed = await receipt(daemon.socket, workspace.id, commitId)
    expect(committed).toMatchObject({ status: 'succeeded', result: { head: expect.any(String) } })
    const newHead = await git(checkout, 'rev-parse', 'HEAD')
    expect(newHead).not.toBe(oldHead)
    expect((committed.result as { head: string }).head).toBe(newHead)
    const retry = await ade(
      daemon.socket,
      'git',
      'commit',
      workspace.id,
      'change',
      current.body.index_token as string,
      '--request-id',
      commitId,
    )
    expect(retry.body.operation).toEqual(committed)
    expect(await git(checkout, 'rev-list', '--count', 'HEAD')).toBe('2')
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI reconciles a Git mutation when its admission reply is lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-cli-lost-reply-'))
  const checkout = join(directory, 'checkout')
  await mkdir(checkout)
  await git(checkout, 'init', '-q', '-b', 'main')
  await writeFile(join(checkout, 'new.txt'), 'one\n')
  const daemon = await startDaemon()
  const proxyPath = join(directory, 'drop.sock')
  const proxy = createServer((client) => {
    const upstream = createConnection(daemon.socket)
    let replies = 0
    let frame = ''
    client.on('data', (bytes) => upstream.write(bytes))
    upstream.on('data', (bytes) => {
      frame += bytes.toString('utf8')
      for (;;) {
        const end = frame.indexOf('\n')
        if (end < 0) break
        const line = frame.slice(0, end + 1)
        frame = frame.slice(end + 1)
        replies++
        if (replies === 2) {
          client.destroy()
          upstream.destroy()
          break
        }
        client.write(line)
      }
    })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const status = await ade(daemon.socket, 'git', 'status', workspace.id)
    await new Promise<void>((resolveListen, rejectListen) => {
      proxy.once('error', rejectListen)
      proxy.listen(proxyPath, resolveListen)
    })
    const requestId = 'git-cli-lost-admission'
    const lost = await ade(
      proxyPath,
      'git',
      'stage',
      workspace.id,
      'new.txt',
      status.body.revision as string,
      '--request-id',
      requestId,
    )
    expect(lost.code).not.toBe(0)
    const result = await receipt(daemon.socket, workspace.id, requestId)
    expect(result).toMatchObject({ id: requestId, status: 'succeeded' })
    const same = await ade(
      daemon.socket,
      'git',
      'stage',
      workspace.id,
      'new.txt',
      status.body.revision as string,
      '--request-id',
      requestId,
    )
    expect(same.body.operation).toEqual(result)
    expect(await git(checkout, 'diff', '--cached', '--name-only')).toBe('new.txt')
  } finally {
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
