import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function command(socket: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args])
  return JSON.parse(result.stdout) as Record<string, unknown>
}

async function rejected(socket: string, args: string[]): Promise<Record<string, unknown>> {
  try { await command(socket, args) }
  catch (error) {
    const failure = error as Error & { stderr?: string }
    if (failure.stderr) return JSON.parse(failure.stderr) as Record<string, unknown>
    throw error
  }
  throw new Error('CLI unexpectedly accepted the command')
}

async function settled(socket: string, repositoryId: string, requestId: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => {
    const response = await command(socket, ['worktree', 'operation', repositoryId, requestId])
    return (response.operation as { status: string }).status
  }, { timeout: 20_000 }).toBe('succeeded')
  const response = await command(socket, ['worktree', 'operation', repositoryId, requestId])
  return response.operation as Record<string, unknown>
}

test('CLI worktree lifecycle uses caller-owned IDs for receipt lookup and safe retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-cli-worktree-retry-'))
  const source = join(directory, 'source')
  const created = join(directory, 'source-feature')
  const daemon = await startDaemon()
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', source])
    await writeFile(join(source, 'README'), 'retain project files\n')
    await execFileAsync('git', ['add', 'README'], { cwd: source })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-q', '-m', 'first'], { cwd: source })
    const registered = await command(daemon.socket, ['worktree', 'register', source])
    const repositoryId = (registered.repository as { id: string }).id
    const createArgs = ['worktree', 'create', repositoryId, 'feature', 'main',
      '--request-id', 'cli-create-one']
    expect(await command(daemon.socket, createArgs)).toMatchObject({ request_id: 'cli-create-one' })
    expect(await settled(daemon.socket, repositoryId, 'cli-create-one'))
      .toMatchObject({ status: 'succeeded' })
    expect(await readFile(join(created, 'README'), 'utf8')).toBe('retain project files\n')
    expect(await command(daemon.socket, createArgs)).toMatchObject({ request_id: 'cli-create-one' })
    expect(await rejected(daemon.socket, ['worktree', 'create', repositoryId, 'other', 'main',
      '--request-id', 'cli-create-one'])).toMatchObject({ type: 'error', code: 'daemon' })
    expect(await rejected(daemon.socket, ['worktree', 'create', repositoryId, 'other', 'main']))
      .toMatchObject({ type: 'error', code: 'usage' })

    const removeArgs = ['worktree', 'remove', repositoryId, created, '--request-id', 'cli-remove-one']
    expect(await command(daemon.socket, removeArgs)).toMatchObject({ request_id: 'cli-remove-one' })
    expect(await settled(daemon.socket, repositoryId, 'cli-remove-one'))
      .toMatchObject({ status: 'succeeded' })
    expect(await command(daemon.socket, removeArgs)).toMatchObject({ request_id: 'cli-remove-one' })
    expect(await rejected(daemon.socket, ['worktree', 'remove', repositoryId, source,
      '--request-id', 'cli-remove-one'])).toMatchObject({ type: 'error', code: 'daemon' })
    expect(await readFile(join(source, 'README'), 'utf8')).toBe('retain project files\n')
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
