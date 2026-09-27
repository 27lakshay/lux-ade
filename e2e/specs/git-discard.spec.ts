import { expect, test } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { managedProfileOwner, rpc, startDaemon, stopManagedProfile, stopOrphanRuntime } from '../fixtures/daemon'

const run = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function git(checkout: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', checkout, ...args])).stdout.trim()
}

async function reviewedFile(
  socket: string,
  workspaceId: string,
  path: string,
): Promise<{ revision: string; diffToken: string }> {
  const status = await rpc(socket, { op: 'review.status', workspace_id: workspaceId, force: true })
  const diff = await rpc(socket, { op: 'review.diff', workspace_id: workspaceId, path, staged: false })
  return { revision: status.revision as string, diffToken: diff.token as string }
}

async function operation(socket: string, workspaceId: string, requestId: string): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> | undefined
  await expect
    .poll(async () => {
      result = (await rpc(socket, { op: 'review.operation', workspace_id: workspaceId, request_id: requestId }))
        .operation as Record<string, unknown>
      return result.status
    })
    .toMatch(/^(succeeded|failed|interrupted)$/)
  return result!
}

test('discard restores only reviewed tracked worktree bytes and refuses changed or unsafe state', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-'))
  const checkout = join(directory, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await git(checkout, 'config', 'user.name', 'ADE Fixture')
  await git(checkout, 'config', 'user.email', 'ade@example.invalid')
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  const binaryBaseline = Buffer.from([0, 1, 2, 3, 4])
  await writeFile(join(checkout, 'binary.dat'), binaryBaseline)
  await git(checkout, 'add', '--', 'tracked.txt', 'binary.dat')
  await git(checkout, 'commit', '-qm', 'baseline')
  const daemon = await startDaemon()
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id

    // A reviewed file may have both staged and unstaged changes. Discard must
    // restore the worktree from the index without replacing the staged bytes.
    await writeFile(join(checkout, 'tracked.txt'), 'staged\n')
    await git(checkout, 'add', '--', 'tracked.txt')
    await writeFile(join(checkout, 'tracked.txt'), 'unstaged\n')
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    const indexBefore = await git(checkout, 'rev-parse', ':tracked.txt')
    const discard = {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-reviewed',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    }
    await rpc(daemon.socket, discard)
    const firstReceipt = await operation(daemon.socket, workspaceId, 'discard-reviewed')
    expect(firstReceipt.status).toBe('succeeded')
    expect(await readFile(firstReceipt.backup_path as string, 'utf8')).toBe('unstaged\n')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('staged\n')
    expect(await git(checkout, 'rev-parse', ':tracked.txt')).toBe(indexBefore)

    await writeFile(join(checkout, 'binary.dat'), Buffer.from([0, 5, 6, 7, 8]))
    const binaryPreview = await reviewedFile(daemon.socket, workspaceId, 'binary.dat')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-binary',
      path: 'binary.dat',
      revision: binaryPreview.revision,
      diff_token: binaryPreview.diffToken,
    })
    expect((await operation(daemon.socket, workspaceId, 'discard-binary')).status).toBe('succeeded')
    expect(await readFile(join(checkout, 'binary.dat'))).toEqual(binaryBaseline)
    await rm(join(checkout, 'binary.dat'))
    const deletedPreview = await reviewedFile(daemon.socket, workspaceId, 'binary.dat')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-deleted',
      path: 'binary.dat',
      revision: deletedPreview.revision,
      diff_token: deletedPreview.diffToken,
    })
    const restored = await operation(daemon.socket, workspaceId, 'discard-deleted')
    expect(restored.status).toBe('succeeded')
    expect(restored.backup_path).toBeUndefined()
    expect(await readFile(join(checkout, 'binary.dat'))).toEqual(binaryBaseline)
    expect((await rpc(daemon.socket, discard)).operation).toMatchObject({ status: 'succeeded' })
    await expect(rpc(daemon.socket, { ...discard, path: 'other.txt' })).rejects.toThrow(/different parameters/i)

    await writeFile(join(checkout, 'tracked.txt'), 'CLI draft\n')
    const cliStatus = JSON.parse(
      (await run(process.execPath, [cli, '--socket', daemon.socket, 'git', 'status', workspaceId])).stdout,
    ) as { revision: string }
    const cliDiff = JSON.parse(
      (await run(process.execPath, [cli, '--socket', daemon.socket, 'git', 'diff', workspaceId, 'tracked.txt'])).stdout,
    ) as { token: string }
    const cliResult = await run(process.execPath, [
      cli,
      '--socket',
      daemon.socket,
      'git',
      'discard',
      workspaceId,
      'tracked.txt',
      cliStatus.revision,
      cliDiff.token,
      '--request-id',
      'discard-cli',
    ])
    expect(JSON.parse(cliResult.stdout)).toMatchObject({ request_id: 'discard-cli', workspace_id: workspaceId })
    expect((await operation(daemon.socket, workspaceId, 'discard-cli')).status).toBe('succeeded')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('staged\n')
    expect(await git(checkout, 'rev-parse', ':tracked.txt')).toBe(indexBefore)

    await writeFile(join(checkout, 'tracked.txt'), 'first draft\n')
    const stale = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await writeFile(join(checkout, 'tracked.txt'), 'newer draft\n')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-stale',
      path: 'tracked.txt',
      revision: stale.revision,
      diff_token: stale.diffToken,
    })
    expect((await operation(daemon.socket, workspaceId, 'discard-stale')).status).toBe('failed')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('newer draft\n')
    expect(await git(checkout, 'rev-parse', ':tracked.txt')).toBe(indexBefore)

    await writeFile(join(checkout, 'new.txt'), 'do not delete\n')
    const untracked = await reviewedFile(daemon.socket, workspaceId, 'new.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-untracked',
      path: 'new.txt',
      revision: untracked.revision,
      diff_token: untracked.diffToken,
    })
    expect((await operation(daemon.socket, workspaceId, 'discard-untracked')).status).toBe('failed')
    expect(await readFile(join(checkout, 'new.txt'), 'utf8')).toBe('do not delete\n')

    // A dirty submodule is tracked, but its nested repository is not an
    // ordinary file that ADE may restore on the user's behalf.
    const subsource = join(directory, 'subsource')
    await mkdir(subsource)
    await run('git', ['init', '-q', '-b', 'main', subsource])
    await git(subsource, 'config', 'user.name', 'ADE Fixture')
    await git(subsource, 'config', 'user.email', 'ade@example.invalid')
    await writeFile(join(subsource, 'nested.txt'), 'nested baseline\n')
    await git(subsource, 'add', '--', 'nested.txt')
    await git(subsource, 'commit', '-qm', 'nested baseline')
    await git(checkout, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsource, 'vendor')
    await git(checkout, 'commit', '-qm', 'add submodule')
    await writeFile(join(checkout, 'vendor', 'nested.txt'), 'nested draft\n')
    const submodule = await reviewedFile(daemon.socket, workspaceId, 'vendor')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-submodule',
      path: 'vendor',
      revision: submodule.revision,
      diff_token: submodule.diffToken,
    })
    expect((await operation(daemon.socket, workspaceId, 'discard-submodule')).status).toBe('failed')
    expect(await readFile(join(checkout, 'vendor', 'nested.txt'), 'utf8')).toBe('nested draft\n')

    // Traversal is invalid even if a caller supplies otherwise valid review tokens.
    const traversal = {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-traversal',
      path: '../outside.txt',
      revision: stale.revision,
      diff_token: stale.diffToken,
    }
    try {
      await rpc(daemon.socket, traversal)
      expect((await operation(daemon.socket, workspaceId, 'discard-traversal')).status).toBe('failed')
    } catch (error) {
      expect(String(error)).toMatch(/path|repository|invalid/i)
    }
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('newer draft\n')

    // A conflicted path has no unambiguous index version to restore.
    await git(checkout, 'submodule', 'deinit', '-f', '-q', '--', 'vendor')
    await rm(join(checkout, 'new.txt'))
    await git(checkout, 'restore', '--', 'tracked.txt')
    await git(checkout, 'branch', 'side')
    await writeFile(join(checkout, 'tracked.txt'), 'main change\n')
    await git(checkout, 'commit', '-qam', 'main change')
    await git(checkout, 'switch', '-q', 'side')
    await writeFile(join(checkout, 'tracked.txt'), 'side change\n')
    await git(checkout, 'commit', '-qam', 'side change')
    await run('git', ['-C', checkout, 'merge', 'main']).catch(() => undefined)
    const conflicted = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-conflict',
      path: 'tracked.txt',
      revision: conflicted.revision,
      diff_token: conflicted.diffToken,
    })
    expect((await operation(daemon.socket, workspaceId, 'discard-conflict')).status).toBe('failed')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toContain('<<<<<<<')
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a discarded file is reconcilable by request ID after losing the admission reply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-reply-'))
  const checkout = join(directory, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await git(checkout, 'config', 'user.name', 'ADE Fixture')
  await git(checkout, 'config', 'user.email', 'ade@example.invalid')
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(checkout, 'commit', '-qm', 'baseline')
  await writeFile(join(checkout, 'tracked.txt'), 'draft\n')
  const daemon = await startDaemon()
  const proxyPath = join(directory, 'drop.sock')
  const proxy = createServer((client) => {
    const upstream = createConnection(daemon.socket)
    client.on('data', (bytes) => upstream.write(bytes))
    upstream.on('data', () => {
      client.destroy()
      upstream.destroy()
    })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await new Promise<void>((resolveListen, rejectListen) => {
      proxy.once('error', rejectListen)
      proxy.listen(proxyPath, resolveListen)
    })
    const discard = {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-lost-reply',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    }
    await expect(rpc(proxyPath, discard)).rejects.toThrow(/closed|reset/i)
    const settled = await operation(daemon.socket, workspaceId, 'discard-lost-reply')
    expect(settled.status).toBe('succeeded')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect((await rpc(daemon.socket, discard)).operation).toEqual(settled)
  } finally {
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an edit after the final discard precondition is not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-race-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(checkout, 'tracked.txt'), 'reviewed draft\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_DISCARD_BEFORE_APPLY_DIR: pause })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-final-race',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await writeFile(join(checkout, 'tracked.txt'), 'newer edit\n')
    await writeFile(join(pause, 'release'), '')
    expect((await operation(daemon.socket, workspaceId, 'discard-final-race')).status).toBe('failed')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('newer edit\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a concurrent edit at a different offset remains intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-offset-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  const baseline = Array.from({ length: 105 }, (_, index) => (index === 52 ? 'ORIGINAL' : `line-${index}`))
  const draft = baseline.map((line, index) => (index === 52 ? 'DRAFT' : line))
  await writeFile(join(checkout, 'tracked.txt'), `${baseline.join('\n')}\n`)
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(checkout, 'tracked.txt'), `${draft.join('\n')}\n`)
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_DISCARD_AFTER_CHECK_DIR: pause })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-offset',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const newer = [...draft]
    newer[52] = 'NEWER'
    newer.push(...draft.slice(49, 56))
    const newerBytes = `${newer.join('\n')}\n`
    await writeFile(join(checkout, 'tracked.txt'), newerBytes)
    await writeFile(join(pause, 'release'), '')
    expect((await operation(daemon.socket, workspaceId, 'discard-offset')).status).toBe('failed')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe(newerBytes)
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an edit to the displaced file during exchange is restored without losing either version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-swap-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(checkout, 'tracked.txt'), 'reviewed draft\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_DISCARD_AFTER_SWAP_DIR: pause })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-swap-race',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')
    await writeFile(displacedPath, 'newer edit\n')
    await writeFile(join(pause, 'release'), '')
    const receipt = await operation(daemon.socket, workspaceId, 'discard-swap-race')
    expect(receipt.status).toBe('failed')
    expect(receipt.backup_path).toBe(displacedPath)
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('newer edit\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('baseline\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a crash after exchange exposes the retained file and never replays discard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-crash-'))
  const checkout = join(directory, 'checkout')
  const dataDirectory = join(directory, 'data')
  const socket = join(directory, 'daemon.sock')
  const pause = join(directory, 'pause')
  await mkdir(dataDirectory)
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(checkout, 'tracked.txt'), 'reviewed draft\n')
  const env = {
    ...process.env,
    ADE_DATA_DIR: dataDirectory,
    ADE_SOCKET: socket,
    ADE_RUNTIME_SOCKET: join(directory, 'runtime.sock'),
    ADE_ROOT: directory,
    SHELL: '/bin/sh',
    ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_DISCARD_AFTER_SWAP_DIR: pause,
  }
  let child: ChildProcess | null = null
  let stopped = false
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null) throw new Error(`Daemon exited during startup: ${child?.exitCode}`)
          return rpc(socket, { op: 'hello' }, 500).then(
            (reply) => reply.type,
            () => '',
          )
        },
        { timeout: 10_000 },
      )
      .toBe('hello')
  }
  try {
    await launch()
    const workspaceId = ((await rpc(socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }).id
    const preview = await reviewedFile(socket, workspaceId, 'tracked.txt')
    const discard = {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-crash-after-swap',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    }
    await rpc(socket, discard)
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')
    const first = child!
    first.kill('SIGKILL')
    await new Promise<void>((resolveExit) => first.once('exit', () => resolveExit()))
    await launch()
    const receipt = (
      await rpc(socket, { op: 'review.operation', workspace_id: workspaceId, request_id: discard.request_id })
    ).operation as Record<string, unknown>
    expect(receipt).toMatchObject({ status: 'interrupted', backup_path: displacedPath })
    expect((await rpc(socket, discard)).operation).toEqual(receipt)
    await delay(100)
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')
    await stopManagedProfile(await managedProfileOwner(socket))
    stopped = true
  } finally {
    if (!stopped && child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (!stopped) await stopOrphanRuntime(dataDirectory)
    if (stopped) await rm(directory, { recursive: true, force: true })
  }
})

test('a replaced ancestor cannot redirect discard outside the workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-ancestor-'))
  const checkout = join(directory, 'checkout')
  const nested = join(checkout, 'nested')
  const outside = join(directory, 'outside')
  const pause = join(directory, 'pause')
  await mkdir(checkout)
  await mkdir(nested)
  await mkdir(outside)
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(nested, 'tracked.txt'), 'baseline\n')
  await writeFile(join(outside, 'tracked.txt'), 'outside untouched\n')
  await git(checkout, 'add', '--', 'nested/tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(nested, 'tracked.txt'), 'reviewed draft\n')
  const daemon = await startDaemon({ ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_DISCARD_BEFORE_SWAP_DIR: pause })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'nested/tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-replaced-ancestor',
      path: 'nested/tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await rename(nested, join(checkout, 'moved'))
    await symlink(outside, nested)
    await writeFile(join(pause, 'release'), '')
    expect((await operation(daemon.socket, workspaceId, 'discard-replaced-ancestor')).status).toBe('failed')
    expect(await readFile(join(outside, 'tracked.txt'), 'utf8')).toBe('outside untouched\n')
    expect(await readFile(join(checkout, 'moved', 'tracked.txt'), 'utf8')).toBe('reviewed draft\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a writer holding the old inode can recover its later bytes from the reported backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-open-fd-'))
  const checkout = join(directory, 'checkout')
  const pause = join(directory, 'pause')
  await mkdir(pause)
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await git(checkout, 'add', '--', 'tracked.txt')
  await git(
    checkout,
    '-c',
    'user.name=ADE Fixture',
    '-c',
    'user.email=ade@example.invalid',
    'commit',
    '-qm',
    'baseline',
  )
  await writeFile(join(checkout, 'tracked.txt'), 'reviewed draft\n')
  const writer = await open(join(checkout, 'tracked.txt'), 'r+')
  const daemon = await startDaemon({
    ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_DISCARD_AFTER_DISPLACED_CHECK_DIR: pause,
  })
  try {
    const workspaceId = (
      (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    ).id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-open-fd',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    await expect
      .poll(() =>
        stat(join(pause, 'signal')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
    await writer.truncate(0)
    await writer.writeFile('later writer bytes\n')
    await writer.sync()
    await writeFile(join(pause, 'release'), '')
    const receipt = await operation(daemon.socket, workspaceId, 'discard-open-fd')
    expect(receipt).toMatchObject({ status: 'succeeded', backup_path: displacedPath })
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('later writer bytes\n')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await writer.close()
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('discard restores the index of a linked worktree without changing its primary checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-discard-linked-'))
  const primary = join(directory, 'primary')
  const linked = join(directory, 'linked')
  await run('git', ['init', '-q', '-b', 'main', primary])
  await writeFile(join(primary, 'tracked.txt'), 'primary baseline\n')
  await git(primary, 'add', '--', 'tracked.txt')
  await git(primary, '-c', 'user.name=ADE Fixture', '-c', 'user.email=ade@example.invalid', 'commit', '-qm', 'baseline')
  await git(primary, 'worktree', 'add', '-q', '-b', 'linked', linked)
  await writeFile(join(linked, 'tracked.txt'), 'linked staged\n')
  await git(linked, 'add', '--', 'tracked.txt')
  await writeFile(join(linked, 'tracked.txt'), 'linked draft\n')
  const daemon = await startDaemon()
  try {
    const workspaceId = ((await rpc(daemon.socket, { op: 'workspace.open', path: linked })).workspace as { id: string })
      .id
    const preview = await reviewedFile(daemon.socket, workspaceId, 'tracked.txt')
    await rpc(daemon.socket, {
      op: 'review.discard',
      workspace_id: workspaceId,
      request_id: 'discard-linked-index',
      path: 'tracked.txt',
      revision: preview.revision,
      diff_token: preview.diffToken,
    })
    const receipt = await operation(daemon.socket, workspaceId, 'discard-linked-index')
    expect(receipt.status).toBe('succeeded')
    expect(await readFile(join(linked, 'tracked.txt'), 'utf8')).toBe('linked staged\n')
    expect(await git(linked, 'show', ':tracked.txt')).toBe('linked staged')
    expect(await readFile(join(primary, 'tracked.txt'), 'utf8')).toBe('primary baseline\n')
    expect(await readFile(receipt.backup_path as string, 'utf8')).toBe('linked draft\n')
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
