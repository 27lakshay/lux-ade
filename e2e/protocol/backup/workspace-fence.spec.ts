// R014 restore fence: a restored profile keeps the source's history readable
// but runs nothing in the source's checkouts until they are rebound, and a
// lifecycle-only repository stays fenced even when the core catalogue is
// cleared. Ported from the legacy e2e/specs/restored-workspace-fence spec; the
// backup runs through ade-control.
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, test, type AdeHarness } from '../fixtures'
import { scratchEnvironment } from '../fixtures/environment'
import { rawReply } from '../fixtures/raw-reply'
import { backupAndRestore } from './helpers'

const run = promisify(execFile)

async function git(ade: AdeHarness, ...args: string[]): Promise<void> {
  await run('git', args, { cwd: ade.root, env: scratchEnvironment(join(ade.root, 'git-home')) })
}

test('restored external workspace keeps history readable but fences source checkout execution', async ({
  ade,
  profile: source,
}) => {
  const checkout = join(ade.root, 'external', 'checkout')
  const child = join(checkout, 'plain-child')
  const unknown = join(ade.root, 'external', 'new-folder')
  await mkdir(child, { recursive: true })
  await mkdir(unknown, { recursive: true })
  await git(ade, '-C', checkout, 'init', '-q')
  await writeFile(join(checkout, 'source-marker.txt'), 'source checkout must stay untouched\n')
  const workspace = (await source.call('workspace.open', { path: checkout })).workspace
  const conversation = (
    await source.call('conversation.create', { workspace_id: workspace.id, provider: 'codex', title: 'Source history' })
  ).conversation
  await source.call('draft.save', {
    conversation_id: conversation.id,
    window_id: 'source-draft',
    revision: 1,
    text: 'Source draft',
  })
  await source.call('queue.pause', { conversation_id: conversation.id, paused: true })
  await source.call('queue.enqueue', {
    conversation_id: conversation.id,
    request_id: 'source-queued',
    text: 'Do not run from restore',
  })
  await source.call('service.configure', {
    workspace_id: workspace.id,
    name: 'source-service',
    revision: 0,
    config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: '.', env: {}, ports: ['PORT'] },
  })

  const clone = await backupAndRestore(ade, source)
  const { catalog } = await clone.call('catalog.get', {})
  expect(catalog.workspaces).toContainEqual(
    expect.objectContaining({ id: workspace.id, root: workspace.root, needs_rebind: true }),
  )
  expect(catalog.conversations).toContainEqual(
    expect.objectContaining({ id: conversation.id, workspace_id: workspace.id }),
  )
  expect((await clone.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Source history',
  })
  expect(
    (await clone.call('draft.get', { conversation_id: conversation.id, window_id: 'source-draft' })).draft,
  ).toMatchObject({ text: 'Source draft' })
  expect((await clone.call('workspace.open', { path: checkout })).workspace).toMatchObject({
    id: workspace.id,
    needs_rebind: true,
  })
  // Neither a folder inside the fenced checkout nor an unknown folder becomes a new workspace.
  for (const path of [child, unknown]) {
    expect(await rawReply(clone, { op: 'workspace.open', path })).toMatchObject({
      type: 'error',
      code: 'needs_rebind',
    })
  }
  const afterRejected = (await clone.call('catalog.get', {})).catalog.workspaces.map((item) => item.root)
  expect(afterRejected).not.toContain(await realpath(child))
  expect(afterRejected).not.toContain(await realpath(unknown))

  // Nothing executes in the source checkout, and each refusal says to rebind.
  for (const request of [
    { op: 'agent.send', conversation_id: conversation.id, request_id: 'blocked-send', text: 'run' },
    { op: 'agent.resume', operation_id: 'blocked-resume', conversation_id: conversation.id },
    { op: 'queue.pause', operation_id: 'blocked-unpause', conversation_id: conversation.id, paused: false },
    { op: 'terminal.create', operation_id: 'blocked-terminal', workspace_id: workspace.id },
    { op: 'terminal.restart', operation_id: 'blocked-restart', workspace_id: workspace.id },
    { workspace_id: workspace.id },
    { op: 'service.start', operation_id: 'blocked-service', workspace_id: workspace.id, name: 'source-service' },
    { op: 'service.health.sample', workspace_id: workspace.id, name: 'source-service' },
    { op: 'script.start', operation_id: 'blocked-script', workspace_id: workspace.id, name: 'source-script' },
    { op: 'review.snapshot', workspace_id: workspace.id },
    { op: 'worktree.repository', path: checkout },
  ]) {
    expect(await rawReply(clone, request), JSON.stringify(request)).toMatchObject({
      type: 'error',
      code: 'needs_rebind',
      recovery: 'rebind_workspace',
    })
  }
  expect((await clone.call('conversation.get', { conversation_id: conversation.id })).queued).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'source-queued', status: 'queued' })]),
  )
  const runtime = await clone.call('runtime.status', {})
  expect(runtime.terminals).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ workspace: { id: workspace.id } })]),
  )
  expect(await readFile(join(checkout, 'source-marker.txt'), 'utf8')).toBe('source checkout must stay untouched\n')
  expect((await source.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    title: 'Source history',
  })
})

test('restored lifecycle-only repository stays fenced after private workspace rebind', async ({
  ade,
  profile: source,
}) => {
  const repo = await ade.repo({ name: 'checkout', initialFiles: { 'source-marker.txt': 'lifecycle source\n' } })
  // This lifecycle repository has no matching core workspace or repository.
  const lifecycle = (await source.call('worktree.repository', { path: repo.path })).repository
  const fenced = await backupAndRestore(ade, source)
  expect(await rawReply(fenced, { op: 'workspace.open', path: repo.path })).toMatchObject({
    type: 'error',
    code: 'needs_rebind',
  })

  // Model a future private-workspace rebind: it must not grant inherited
  // lifecycle records removal or execution authority. Clearing the core
  // marker here isolates the lifecycle database's independent fence.
  await fenced.stop()
  const db = new DatabaseSync(join(fenced.dataDirectory, 'sessions.sqlite'))
  db.exec('UPDATE restore_fence SET worktree_lifecycle_needs_rebind=0 WHERE id=1')
  for (const table of ['workspaces', 'repositories']) {
    const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>
    for (const row of rows) {
      const record = JSON.parse(row.data) as Record<string, unknown>
      record.needs_rebind = false
      record.worktree_lifecycle_needs_rebind = false
      db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record), row.id)
    }
  }
  db.close()
  await fenced.restartDaemon()
  for (const request of [
    { op: 'worktree.repository', path: repo.path },
    { op: 'worktree.get', project_id: lifecycle.id },
    { op: 'worktree.refresh', project_id: lifecycle.id, operation_id: 'must-not-refresh' },
    {
      op: 'worktree.switch',
      project_id: lifecycle.id,
      operation_id: 'must-not-switch',
      target: 'new-branch',
      base: 'main',
      create: true,
    },
  ]) {
    expect(await rawReply(fenced, request), JSON.stringify(request)).toMatchObject({
      type: 'error',
      code: 'needs_rebind',
    })
  }
  expect(await repo.read('source-marker.txt')).toBe('lifecycle source\n')
})
