import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)

async function rawReply(socket: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolveReply, rejectReply) => {
    const peer = createConnection(socket)
    let frame = ''
    const timer = setTimeout(() => peer.destroy(new Error('Daemon request timed out')), 5_000)
    peer.setEncoding('utf8')
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: string) => {
      frame += chunk
      const end = frame.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      peer.destroy()
      resolveReply(JSON.parse(frame.slice(0, end)) as Record<string, unknown>)
    })
    peer.once('error', (error) => { clearTimeout(timer); rejectReply(error) })
  })
}

test('restored external workspace keeps history readable but fences source checkout execution', async () => {
  const source = await startDaemon()
  const external = await mkdtemp(join(tmpdir(), 'ade-restore-external-'))
  try {
    const checkout = join(external, 'checkout')
    await mkdir(checkout)
    const child = join(checkout, 'plain-child')
    await mkdir(child)
    const unknown = join(external, 'new-folder')
    await mkdir(unknown)
    await execFileAsync('git', ['-C', checkout, 'init', '-q'])
    await writeFile(join(checkout, 'source-marker.txt'), 'source checkout must stay untouched\n')
    const workspace = (await rpc(source.socket, { op: 'workspace.open', path: checkout }))
      .workspace as { id: string; root: string; repository_id: string }
    const conversation = (await rpc(source.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex', title: 'Source history' }))
      .conversation as { id: string }
    await rpc(source.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'source-draft', revision: 1, text: 'Source draft' })
    await rpc(source.socket, { op: 'queue.pause', conversation_id: conversation.id, paused: true })
    await rpc(source.socket, { op: 'queue.enqueue', conversation_id: conversation.id,
      request_id: 'source-queued', text: 'Do not run from restore' })
    await rpc(source.socket, { op: 'service.configure', workspace_id: workspace.id,
      name: 'source-service', revision: 0,
      config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: '.', env: {}, ports: ['PORT'] } })

    const backup = join(source.rootDirectory, 'external-backup')
    const restored = join(source.rootDirectory, 'restored-data')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 20_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', restored], { timeout: 20_000 })
    const clone = await startDaemon({ ADE_DATA_DIR: restored })
    try {
      const catalogue = (await rpc(clone.socket, { op: 'catalog.get' })).catalog as {
        workspaces: Array<{ id: string; root: string; needs_rebind: boolean }>
        conversations: Array<{ id: string; workspace_id: string }>
      }
      expect(catalogue.workspaces).toContainEqual(expect.objectContaining({ id: workspace.id,
        root: workspace.root, needs_rebind: true }))
      expect(catalogue.conversations).toContainEqual(expect.objectContaining({ id: conversation.id,
        workspace_id: workspace.id }))
      expect((await rpc(clone.socket, { op: 'conversation.get', conversation_id: conversation.id }))
        .conversation).toMatchObject({ id: conversation.id, title: 'Source history' })
      expect((await rpc(clone.socket, { op: 'draft.get', conversation_id: conversation.id,
        window_id: 'source-draft' })).draft).toMatchObject({ text: 'Source draft' })
      expect((await rpc(clone.socket, { op: 'workspace.open', path: checkout })).workspace)
        .toMatchObject({ id: workspace.id, needs_rebind: true })
      expect(await rawReply(clone.socket, { op: 'workspace.open', path: child }))
        .toMatchObject({ type: 'error', code: 'needs_rebind' })
      expect(await rawReply(clone.socket, { op: 'workspace.open', path: unknown }))
        .toMatchObject({ type: 'error', code: 'needs_rebind' })
      const afterRejected = (await rpc(clone.socket, { op: 'catalog.get' })).catalog as {
        workspaces: Array<{ root: string }>
      }
      expect(afterRejected.workspaces.map((item) => item.root)).not.toContain(await realpath(child))
      expect(afterRejected.workspaces.map((item) => item.root)).not.toContain(await realpath(unknown))

      for (const request of [
        { op: 'agent.send', conversation_id: conversation.id, request_id: 'blocked-send', text: 'run' },
        { op: 'agent.resume', conversation_id: conversation.id },
        { op: 'queue.pause', conversation_id: conversation.id, paused: false },
        { op: 'terminal.create', workspace_id: workspace.id },
        { op: 'terminal.restart', workspace_id: workspace.id },
        { workspace_id: workspace.id },
        { op: 'service.start', workspace_id: workspace.id, name: 'source-service' },
        { op: 'service.health.sample', workspace_id: workspace.id, name: 'source-service' },
        { op: 'script.start', workspace_id: workspace.id, name: 'source-script' },
        { op: 'review.snapshot', workspace_id: workspace.id },
        { op: 'worktree.repository', path: checkout },
      ]) {
        expect(await rawReply(clone.socket, request)).toMatchObject({ type: 'error',
          code: 'needs_rebind', recovery: 'rebind_workspace' })
      }
      expect((await rpc(clone.socket, { op: 'conversation.get', conversation_id: conversation.id }))
        .queued).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'source-queued', status: 'queued' })]))
      const runtime = await rpc(clone.socket, { op: 'runtime.status' })
      expect((runtime.terminals as Array<{ workspace: { id: string } }>))
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ workspace: { id: workspace.id } })]))
      expect(await readFile(join(checkout, 'source-marker.txt'), 'utf8'))
        .toBe('source checkout must stay untouched\n')
      expect((await rpc(source.socket, { op: 'conversation.get', conversation_id: conversation.id }))
        .conversation).toMatchObject({ id: conversation.id, title: 'Source history' })
    } finally {
      await clone.stop()
    }
  } finally {
    await source.stop()
    await rm(external, { recursive: true, force: true })
  }
})

test('restored lifecycle-only repository stays fenced after private workspace rebind', async () => {
  const source = await startDaemon()
  const external = await mkdtemp(join(tmpdir(), 'ade-restore-lifecycle-only-'))
  try {
    const checkout = join(external, 'checkout')
    await execFileAsync('git', ['init', '-b', 'main', checkout])
    await writeFile(join(checkout, 'source-marker.txt'), 'lifecycle source\n')
    await execFileAsync('git', ['add', 'source-marker.txt'], { cwd: checkout })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c',
      'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: checkout })
    // This lifecycle repository has no matching core workspace or repository.
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: checkout }))
      .repository as { id: string }
    const backup = join(source.rootDirectory, 'lifecycle-backup')
    const restored = join(source.rootDirectory, 'lifecycle-restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 20_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', restored], { timeout: 20_000 })
    const fenced = await startDaemon({ ADE_DATA_DIR: restored })
    try {
      expect(await rawReply(fenced.socket, { op: 'workspace.open', path: checkout }))
        .toMatchObject({ type: 'error', code: 'needs_rebind' })
    } finally {
      await fenced.stop()
    }
    // Model a future private-workspace rebind: it must not grant inherited
    // lifecycle records removal or execution authority. Clearing the core
    // marker here isolates the lifecycle database's independent fence.
    await execFileAsync('python3', ['-c', `import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('UPDATE restore_fence SET worktree_lifecycle_needs_rebind=0 WHERE id=1')
 for table in ('workspaces','repositories'):
  for record_id,encoded in db.execute(f'SELECT id,data FROM {table}').fetchall():
   record=json.loads(encoded)
   record['needs_rebind']=False
   record['worktree_lifecycle_needs_rebind']=False
   db.execute(f'UPDATE {table} SET data=? WHERE id=?',(json.dumps(record),record_id))`,
    join(restored, 'sessions.sqlite')])
    const clone = await startDaemon({ ADE_DATA_DIR: restored })
    try {
      for (const request of [
        { op: 'worktree.repository', path: checkout },
        { op: 'worktree.get', repository_id: lifecycle.id },
        { op: 'worktree.refresh', repository_id: lifecycle.id, request_id: 'must-not-refresh' },
        { op: 'worktree.switch', repository_id: lifecycle.id, request_id: 'must-not-switch',
          target: 'new-branch', base: 'main', create: true },
      ]) {
        expect(await rawReply(clone.socket, request)).toMatchObject({ type: 'error',
          code: 'needs_rebind' })
      }
      expect(await readFile(join(checkout, 'source-marker.txt'), 'utf8')).toBe('lifecycle source\n')
    } finally {
      await clone.stop()
    }
  } finally {
    await source.stop()
    await rm(external, { recursive: true, force: true })
  }
})
