import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const backupScript = resolve('scripts/managed_backup.py')

async function backup(...args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync('python3', [backupScript, ...args], { timeout: 30_000 })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

async function backupError(...args: string[]): Promise<string> {
  try {
    await backup(...args)
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    return String((JSON.parse(failure.stderr ?? '{}') as { message?: string }).message)
  }
  throw new Error('Backup operation unexpectedly succeeded')
}

test('live backend snapshot restores public state and rejects corrupt or future versions before target mutation', async () => {
  test.setTimeout(120_000)
  const daemon = await startDaemon()
  const root = await mkdtemp(join(tmpdir(), 'ade-backup-e2e-'))
  const output = join(root, 'backup')
  const target = join(root, 'restored-data')
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      title: 'Backup fixture conversation', provider: 'codex' })).conversation as { id: string }
    const attachment = (await rpc(daemon.socket, { op: 'attachment.put', conversation_id: conversation.id,
      request_id: 'backup-image', name: 'image.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0wwAAAABJRU5ErkJggg==' }))
      .attachment as { id: string; size: number }
    expect(attachment.id).toBe('backup-image')
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'backup-window', revision: 1, text: 'draft one', attachments: [attachment] })
    const account = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Backup account' }))
      .account as { id: string; native_home: string }
    await writeFile(join(account.native_home, 'private-fixture.txt'), 'fixture credential must stay out of backup')
    await rpc(daemon.socket, { op: 'service.configure', workspace_id: workspace.id, name: 'backup-web', revision: 0,
      config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        env: {}, cwd: '.', ports: ['PORT'] } })
    const sourceRoute = await rpc(daemon.socket, { op: 'service.proxy.ensure', workspace_id: workspace.id,
      name: 'backup-web', port_variable: 'PORT' })
    expect(sourceRoute.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const repository = join(root, 'source-repository')
    await execFileAsync('git', ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'file.txt'), 'fixture repository\n')
    await execFileAsync('git', ['add', 'file.txt'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'fixture'], { cwd: repository })
    const sourceRepository = (await rpc(daemon.socket, { op: 'worktree.repository', path: repository }))
      .repository as { id: string }
    const worktreeRequest = { op: 'worktree.switch', repository_id: sourceRepository.id,
      request_id: 'backup-owned-worktree', target: 'backup-owned', base: 'main', create: true }
    await rpc(daemon.socket, worktreeRequest)
    await expect.poll(async () => {
      const response = await rpc(daemon.socket, { op: 'worktree.operation', repository_id: sourceRepository.id,
        request_id: worktreeRequest.request_id })
      const operation = response.operation as { status: string; error?: string }
      return operation.status === 'running' ? null : operation
    }, { timeout: 30_000 }).toMatchObject({ status: 'succeeded' })
    const sourceWorktrees = (await rpc(daemon.socket, { op: 'worktree.get', repository_id: sourceRepository.id }))
      .worktrees as Array<{ path: string; branch: string; ade_owned: boolean }>
    const owned = sourceWorktrees.find((item) => item.branch === 'backup-owned')
    expect(owned).toMatchObject({ ade_owned: true, path: expect.any(String) })
    const ownedPath = String(owned?.path)

    let writes = 0
    let writing = true
    const writer = (async () => {
      while (writing) {
        writes += 1
        await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
          window_id: 'backup-window', revision: writes + 1, text: `draft ${writes + 1}`, attachments: [attachment] })
        await delay(2)
      }
    })()
    try {
      const created = await backup('create', '--data-dir', daemon.dataDirectory, '--out', output)
      expect(created).toMatchObject({ type: 'managed_backup', operation: 'create',
        manifest: { format_version: 1, scope: 'backend-snapshot-only' } })
    } finally {
      writing = false
      await writer
    }
    expect(writes).toBeGreaterThan(0)
    const inspected = await backup('inspect', '--backup', output)
    expect(inspected).toMatchObject({ type: 'managed_backup', operation: 'inspect' })
    const occupied = join(root, 'occupied-backup')
    await mkdir(occupied)
    const occupiedInode = (await stat(occupied)).ino
    expect(await backupError('create', '--data-dir', daemon.dataDirectory, '--out', occupied))
      .toContain('already exists')
    expect((await stat(occupied)).ino).toBe(occupiedInode)
    const manifest = inspected.manifest as { entries: Array<{ path: string }>; excluded: string[] }
    expect(manifest.entries.map((entry) => entry.path)).toContain('sessions.sqlite')
    expect(manifest.excluded.join(' ')).toContain('credentials')
    expect(manifest.excluded.join(' ')).toContain('Stable service proxy routes')
    expect(await readdir(output)).not.toContain('provider-accounts')
    expect(await readdir(output)).not.toContain('service-proxies.json')

    await backup('restore', '--backup', output, '--data-dir', target)
    expect(await readdir(join(target, 'provider-accounts', account.id))).toEqual(['config.toml'])
    expect(await readFile(join(target, 'provider-accounts', account.id, 'config.toml'), 'utf8'))
      .toBe('cli_auth_credentials_store = "file"\n')
    const persisted = await execFileAsync('python3', ['-c',
      'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT data FROM accounts WHERE id=?", (sys.argv[2],)).fetchone()[0])',
      join(target, 'sessions.sqlite'), account.id])
    expect((JSON.parse(persisted.stdout) as { native_home: string }).native_home)
      .toBe(join(target, 'provider-accounts', account.id))
    restored = await startDaemon({ ADE_DATA_DIR: target })
    const catalog = await rpc(restored.socket, { op: 'catalog.get' })
    expect((await rpc(restored.socket, { op: 'draft.send.get', conversation_id: conversation.id,
      window_id: 'backup-window' })).restored_from_backup).toBe(true)
    expect((catalog.catalog as { conversations: Array<{ id: string }> }).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: conversation.id })]))
    expect((await rpc(restored.socket, { op: 'conversation.get', conversation_id: conversation.id })).conversation)
      .toMatchObject({ id: conversation.id, title: 'Backup fixture conversation' })
    const draft = (await rpc(restored.socket, { op: 'draft.get', conversation_id: conversation.id,
      window_id: 'backup-window' })).draft as { revision: number; text: string; attachments: Array<{ id: string }> }
    expect(draft.revision).toBeGreaterThanOrEqual(1)
    expect(draft.revision).toBeLessThanOrEqual(writes + 1)
    expect(draft.attachments).toEqual([expect.objectContaining({ id: attachment.id })])
    expect((await rpc(restored.socket, { op: 'account.list' })).accounts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id,
        state: 'unverified', native_home: join(await realpath(target), 'provider-accounts', account.id) })]))
    expect((await rpc(restored.socket, { op: 'service.proxy.recovery.inspect' })).routes).toEqual([])
    await expect(rpc(restored.socket, { op: 'service.proxy.inspect', workspace_id: workspace.id,
      name: 'backup-web', port_variable: 'PORT' })).rejects.toThrow('needs_rebind')
    await expect(rpc(restored.socket, { op: 'worktree.get', repository_id: sourceRepository.id }))
      .rejects.toThrow('needs_rebind')
    await expect(rpc(restored.socket, { op: 'worktree.remove', repository_id: sourceRepository.id,
      request_id: 'restored-must-not-remove-source', path: ownedPath })).rejects.toThrow('needs_rebind')
    expect((await stat(ownedPath)).isDirectory()).toBe(true)
    await restored.stop()
    restored = null
    await rpc(daemon.socket, { op: 'worktree.remove', repository_id: sourceRepository.id,
      request_id: 'source-removes-its-own-tree', path: ownedPath })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'worktree.operation',
      repository_id: sourceRepository.id, request_id: 'source-removes-its-own-tree' }))
      .operation).toMatchObject({ status: 'succeeded' })

    const corrupt = join(root, 'corrupt')
    await mkdir(corrupt)
    for (const entry of await readdir(output)) await cp(join(output, entry), join(corrupt, entry), { recursive: true })
    const marker = join(root, 'untouched')
    await mkdir(marker)
    await writeFile(join(marker, 'sentinel'), 'keep')
    await writeFile(join(corrupt, 'manifest.json'), '{"format_version":99}')
    expect(await backupError('restore', '--backup', corrupt, '--data-dir', marker)).toContain('Unsupported backup format')
    expect(await readFile(join(marker, 'sentinel'), 'utf8')).toBe('keep')

    const preFence = join(root, 'pre-fence')
    await mkdir(preFence)
    for (const entry of await readdir(output)) await cp(join(output, entry), join(preFence, entry), { recursive: true })
    await execFileAsync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=11"); c.close()',
      join(preFence, 'sessions.sqlite')])
    const preFenceDb = await readFile(join(preFence, 'sessions.sqlite'))
    const preFenceManifest = JSON.parse(await readFile(join(preFence, 'manifest.json'), 'utf8')) as {
      entries: Array<{ path: string; sha256: string; size: number; schema?: number }>
    }
    const preFenceEntry = preFenceManifest.entries.find((entry) => entry.path === 'sessions.sqlite')!
    preFenceEntry.sha256 = createHash('sha256').update(preFenceDb).digest('hex')
    preFenceEntry.size = preFenceDb.length
    preFenceEntry.schema = 11
    await writeFile(join(preFence, 'manifest.json'), JSON.stringify(preFenceManifest))
    const preFenceTarget = join(root, 'pre-fence-target')
    expect(await backupError('restore', '--backup', preFence, '--data-dir', preFenceTarget))
      .toContain('Restore requires a schema-12 backup')
    await expect(stat(preFenceTarget)).rejects.toThrow()

    const future = join(root, 'future')
    await mkdir(future)
    for (const entry of await readdir(output)) await cp(join(output, entry), join(future, entry), { recursive: true })
    await execFileAsync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=99"); c.close()',
      join(future, 'sessions.sqlite')])
    const futureDb = await readFile(join(future, 'sessions.sqlite'))
    const futureManifest = JSON.parse(await readFile(join(future, 'manifest.json'), 'utf8')) as {
      entries: Array<{ path: string; sha256: string; size: number; schema?: number }>
    }
    const dbEntry = futureManifest.entries.find((entry) => entry.path === 'sessions.sqlite')!
    dbEntry.sha256 = createHash('sha256').update(futureDb).digest('hex')
    dbEntry.size = futureDb.length
    dbEntry.schema = 99
    await writeFile(join(future, 'manifest.json'), JSON.stringify(futureManifest))
    const untouched = join(root, 'unsupported-target')
    expect(await backupError('restore', '--backup', future, '--data-dir', untouched))
      .toContain('Unsupported sessions.sqlite schema version 99')
    await expect(stat(untouched)).rejects.toThrow()
  } finally {
    const results = await Promise.allSettled([restored?.stop(), daemon.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`Backup E2E process cleanup is unconfirmed; retain ${root}: ${failures.map((failure) => String(failure.reason)).join('; ')}`)
    await rm(root, { recursive: true, force: true })
  }
})
