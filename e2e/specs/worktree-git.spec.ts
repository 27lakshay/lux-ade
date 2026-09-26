import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)

async function operation(socket: string, repositoryId: string, requestId: string) {
  await expect.poll(async () => (await rpc(socket, { op: 'worktree.operation',
    repository_id: repositoryId, request_id: requestId })).operation as { status: string },
  { timeout: 20_000 }).toMatchObject({ status: expect.stringMatching(/succeeded|failed|partial/) })
  return (await rpc(socket, { op: 'worktree.operation', repository_id: repositoryId,
    request_id: requestId })).operation as { status: string; error?: string; result: Record<string, unknown> }
}

test('Git lifecycle works without wt and requires explicit external adoption for removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-git-lifecycle-'))
  const source = join(directory, 'source')
  const external = join(directory, 'external')
  const created = join(directory, 'source-feature-one')
  const daemon = await startDaemon({ ADE_WT_BIN: '/does/not/exist', WORKTRUNK_CONFIG_PATH: '/does/not/exist' })
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', source])
    await writeFile(join(source, 'README'), 'preserve project work\n')
    await execFileAsync('git', ['add', 'README'], { cwd: source })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-q', '-m', 'first'], { cwd: source })
    const repository = (await rpc(daemon.socket, { op: 'worktree.repository', path: source }))
      .repository as { id: string }
    const createdId = 'git-create-one'
    await rpc(daemon.socket, { op: 'worktree.switch', repository_id: repository.id,
      request_id: createdId, target: 'feature/one', base: 'main', create: true })
    expect(await operation(daemon.socket, repository.id, createdId)).toMatchObject({ status: 'succeeded' })
    expect(await readFile(join(created, 'README'), 'utf8')).toBe('preserve project work\n')
    await writeFile(join(created, 'scratch'), 'dirty')
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: repository.id,
      request_id: 'dirty-remove', path: created })
    expect(await operation(daemon.socket, repository.id, 'dirty-remove'))
      .toMatchObject({ status: 'failed', error: expect.stringMatching(/uncommitted|untracked/) })
    await rm(join(created, 'scratch'))
    await execFileAsync('git', ['worktree', 'lock', created, '--reason', 'fixture'], { cwd: source })
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: repository.id,
      request_id: 'locked-remove', path: created })
    expect(await operation(daemon.socket, repository.id, 'locked-remove')).toMatchObject({ status: 'failed' })
    await execFileAsync('git', ['worktree', 'unlock', created], { cwd: source })
    await execFileAsync('git', ['branch', 'external'], { cwd: source })
    await execFileAsync('git', ['worktree', 'add', external, 'external'], { cwd: source })
    await expect(rpc(daemon.socket, { op: 'worktree.remove', repository_id: repository.id,
      request_id: 'external-remove', path: external })).rejects.toThrow(/no ADE removal authority/)
    await expect(rpc(daemon.socket, { op: 'worktree.adopt', repository_id: repository.id,
      path: external, confirm_path: created })).rejects.toThrow(/confirm_path/)
    await rpc(daemon.socket, { op: 'worktree.adopt', repository_id: repository.id,
      path: external, confirm_path: await realpath(external) })
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: repository.id,
      request_id: 'adopted-remove', path: external, delete_branch: 'keep' })
    expect(await operation(daemon.socket, repository.id, 'adopted-remove')).toMatchObject({ status: 'succeeded' })
    await writeFile(join(created, 'feature'), 'unmerged commit\n')
    await execFileAsync('git', ['add', 'feature'], { cwd: created })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-q', '-m', 'feature'], { cwd: created })
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: repository.id,
      request_id: 'created-remove', path: created, delete_branch: 'merged' })
    expect(await operation(daemon.socket, repository.id, 'created-remove'))
      .toMatchObject({ status: 'partial', error: expect.stringContaining('branch feature/one was retained') })
    expect((await execFileAsync('git', ['branch', '--list', 'feature/one'], { cwd: source })).stdout)
      .toContain('feature/one')
    expect(await readFile(join(source, 'README'), 'utf8')).toBe('preserve project work\n')
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
