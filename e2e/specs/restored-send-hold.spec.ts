import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)

test('a restored daemon holds an inherited prompt after workspace paths are rebound', async () => {
  test.setTimeout(60_000)
  const mocks = await mkdtemp(join(tmpdir(), 'ade-restored-send-mocks-'))
  const sourceMock = join(mocks, 'source')
  const targetMock = join(mocks, 'target')
  const provider = resolve('scripts/fixtures/codex_mock.py')
  const source = await startDaemon({ ADE_CODEX_BIN: provider, ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: sourceMock })
  let target: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const catalog = (await rpc(source.socket, { op: 'catalog.get' })).catalog as {
      workspaces: Array<{ id: string }>
    }
    const conversation = (await rpc(source.socket, { op: 'conversation.create',
      workspace_id: catalog.workspaces[0].id, provider: 'codex' })).conversation as { id: string }
    const owner = { conversation_id: conversation.id, window_id: 'restore-owner' }
    await rpc(source.socket, { op: 'draft.save', ...owner, revision: 1, text: 'send once' })
    await rpc(source.socket, { op: 'draft.send.prepare', ...owner, request_id: 'restored-send-1',
      revision: 1, draft_text: 'send once', text: 'send once' })

    const backup = join(source.rootDirectory, 'backup')
    const restored = join(source.rootDirectory, 'restored')
    await run('python3', [resolve('scripts/managed_backup.py'), 'create',
      '--data-dir', source.dataDirectory, '--out', backup])
    await rpc(source.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'restored-send-1', text: 'send once' })
    await expect.poll(async () => {
      const calls = await readFile(join(sourceMock, 'calls.jsonl'), 'utf8').catch(() => '')
      return calls.split('\n').filter(Boolean).filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    await run('python3', [resolve('scripts/managed_backup.py'), 'restore',
      '--backup', backup, '--data-dir', restored])

    // Stand in for the future explicit physical-path rebind. Retain backup
    // provenance and the inherited intent hold while clearing only path fences.
    await run('python3', ['-c', `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
for table in ('workspaces','repositories'):
 for id,encoded in db.execute('SELECT id,data FROM '+table).fetchall():
  row=json.loads(encoded);row['needs_rebind']=False;row['worktree_lifecycle_needs_rebind']=False
  db.execute('UPDATE '+table+' SET data=? WHERE id=?',(json.dumps(row),id))
db.execute('UPDATE restore_fence SET worktree_lifecycle_needs_rebind=0 WHERE id=1')
db.commit()
`, join(restored, 'sessions.sqlite')])
    target = await startDaemon({ ADE_DATA_DIR: restored, ADE_CODEX_BIN: provider,
      ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: targetMock })
    expect(await rpc(target.socket, { op: 'draft.send.get', ...owner })).toMatchObject({
      restored_from_backup: true, intent: { request_id: 'restored-send-1', state: 'pending' },
    })
    await expect(rpc(target.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'restored-send-1', text: 'send once' })).rejects.toThrow('Restored prompt is held')
    await expect(rpc(target.socket, { op: 'draft.send.complete', ...owner,
      request_id: 'restored-send-1' })).rejects.toThrow('Restored prompt is held')
    await expect(rpc(target.socket, { op: 'draft.send.abort', ...owner,
      request_id: 'restored-send-1' })).rejects.toThrow('Restored prompt is held')
    const targetCalls = await readFile(join(targetMock, 'calls.jsonl'), 'utf8').catch(() => '')
    expect(targetCalls.split('\n').filter(Boolean).filter((line) => JSON.parse(line).method === 'turn/start'))
      .toHaveLength(0)
    expect((await rpc(source.socket, { op: 'conversation.get', conversation_id: conversation.id })).messages)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'restored-send-1' })]))
  } finally {
    if (target) await target.stop()
    await source.stop()
    await rm(mocks, { recursive: true, force: true })
  }
})
