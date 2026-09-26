import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc as fixtureRpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)

async function rpc(socket: string, request: Record<string, unknown>) {
  try { return await fixtureRpc(socket, request) }
  catch (error) { throw new Error(`${request.op}: ${String(error)}`) }
}

async function reply(socket: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
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

test('restored repository and shared workspaces rebind explicitly without source authority', async () => {
  test.setTimeout(120_000)
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-e2e-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceCheckout = join(outside, 'source')
    const sourceSecond = join(outside, 'source-second')
    const targetCheckout = join(outside, 'target')
    const targetSecond = join(outside, 'target-second')
    const otherCheckout = join(outside, 'other')
    const privateTarget = join(outside, 'private-target')
    await mkdir(privateTarget)
    await execFileAsync('git', ['init', '-b', 'main', sourceCheckout])
    await writeFile(join(sourceCheckout, 'marker.txt'), 'source only\n')
    await execFileAsync('git', ['add', 'marker.txt'], { cwd: sourceCheckout })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c',
      'user.email=fixture@example.invalid', 'commit', '-m', 'source'], { cwd: sourceCheckout })
    await execFileAsync('git', ['worktree', 'add', '-b', 'source-second', sourceSecond], { cwd: sourceCheckout })
    await execFileAsync('git', ['clone', '-q', sourceCheckout, targetCheckout])
    await execFileAsync('git', ['worktree', 'add', '-b', 'target-second', targetSecond], { cwd: targetCheckout })
    await execFileAsync('git', ['clone', '-q', sourceCheckout, otherCheckout])
    await writeFile(join(targetCheckout, 'package.json'), JSON.stringify({ name: 'rebind-fixture',
      scripts: { verify: 'node -e "require(\'fs\').writeFileSync(\'ran-here.txt\',process.cwd())"' } }))

    const first = (await rpc(source.socket, { op: 'workspace.open', path: sourceCheckout }))
      .workspace as { id: string; repository_id: string; root: string }
    const second = (await rpc(source.socket, { op: 'workspace.open', path: sourceSecond }))
      .workspace as { id: string; repository_id: string; root: string }
    expect(second.repository_id).toBe(first.repository_id)
    const conversation = (await rpc(source.socket, { op: 'conversation.create',
      workspace_id: first.id, provider: 'codex', title: 'Preserved history' }))
      .conversation as { id: string }
    await rpc(source.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'original', revision: 1, text: 'preserved draft' })
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: sourceCheckout }))
      .repository as { id: string }
    const sourcePrivateRoot = await realpath(source.rootDirectory)
    const privateWorkspace = ((await rpc(source.socket, { op: 'catalog.get' })).catalog as {
      workspaces: Array<{ id: string; root: string }>
    }).workspaces.find((workspace) => workspace.root === sourcePrivateRoot)
    expect(privateWorkspace).toBeDefined()
    await rpc(source.socket, { op: 'service.configure', workspace_id: first.id,
      name: 'rebound-service', revision: 0,
      config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: '.', env: {}, ports: [] } })

    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    expect((await rpc(socket, { op: 'conversation.get', conversation_id: conversation.id }))
      .conversation).toMatchObject({ id: conversation.id, workspace_id: first.id })
    expect((await rpc(socket, { op: 'draft.get', conversation_id: conversation.id,
      window_id: 'original' })).draft).toMatchObject({ text: 'preserved draft' })
    expect(await reply(socket, { op: 'terminal.create', workspace_id: first.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect((await rpc(socket, { op: 'worktree.rebind.list' })).repositories)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: lifecycle.id,
        needs_rebind: true, rebindable: true })]))
    expect(await rpc(socket, { op: 'repository.rebind.list' }))
      .toMatchObject({ type: 'repository_rebind_catalog', repositories: expect.arrayContaining([
        expect.objectContaining({ id: first.repository_id,
          root: await realpath(join(sourceCheckout, '.git')), needs_rebind: true,
          rebindable: true }),
      ]) })
    expect(await reply(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: sourceCheckout })).toMatchObject({ type: 'error' })
    expect(await reply(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: join(outside, 'missing') })).toMatchObject({ type: 'error' })
    expect((await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: targetCheckout })).repository).toMatchObject({ id: lifecycle.id, needs_rebind: false,
        root: await realpath(targetCheckout) })

    // A process restart between the two SQLite bindings must preserve the
    // unbound core catalogue and reject execution.
    await restored.stop()
    restored = null
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const restarted = restored.socket
    expect(await reply(restarted, { op: 'terminal.create', workspace_id: first.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect(await reply(restarted, { op: 'workspace.rebind', workspace_id: privateWorkspace!.id,
      path: sourceCheckout })).toMatchObject({ type: 'error', message:
      expect.stringContaining('ordinary workspace') })
    expect(await reply(restarted, { op: 'terminal.create', workspace_id: privateWorkspace!.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect(await reply(restarted, { op: 'repository.rebind', repository_id: first.repository_id,
      path: otherCheckout })).toMatchObject({ type: 'error', message:
      expect.stringContaining('Worktrunk binding') })
    expect((await rpc(restarted, { op: 'repository.rebind', repository_id: first.repository_id,
      path: targetCheckout })).repository).toMatchObject({ id: first.repository_id,
        root: await realpath(join(targetCheckout, '.git')), needs_rebind: false })
    expect((await rpc(restarted, { op: 'repository.rebind.list' })).repositories)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: first.repository_id,
        root: await realpath(join(targetCheckout, '.git')), needs_rebind: false })]))
    expect(await reply(restarted, { op: 'workspace.rebind', workspace_id: first.id,
      path: sourceCheckout })).toMatchObject({ type: 'error' })
    expect((await rpc(restarted, { op: 'workspace.rebind', workspace_id: first.id,
      path: targetCheckout })).workspace).toMatchObject({ id: first.id,
        root: await realpath(targetCheckout), needs_rebind: false })
    expect(await reply(restarted, { op: 'terminal.create', workspace_id: second.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect(await reply(restarted, { op: 'workspace.rebind', workspace_id: second.id,
      path: targetCheckout })).toMatchObject({ type: 'error', message:
      expect.stringContaining('another identity') })
    const [valid, competing] = await Promise.all([
      reply(restarted, { op: 'workspace.rebind', workspace_id: second.id, path: targetSecond }),
      reply(restarted, { op: 'workspace.rebind', workspace_id: second.id, path: sourceSecond }),
    ])
    expect(valid).toMatchObject({ type: 'ack', workspace: { id: second.id,
      root: await realpath(targetSecond), needs_rebind: false } })
    expect(competing).toMatchObject({ type: 'error' })
    await rpc(restarted, { op: 'workspace.rebind', workspace_id: privateWorkspace!.id,
      path: privateTarget })
    const catalog = (await rpc(restarted, { op: 'catalog.get' })).catalog as {
      workspaces: Array<{ id: string; root: string; needs_rebind: boolean }>
    }
    expect(catalog.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, root: await realpath(targetCheckout), needs_rebind: false }),
      expect.objectContaining({ id: second.id, root: await realpath(targetSecond), needs_rebind: false }),
    ]))
    expect(catalog.workspaces.filter((workspace) => workspace.needs_rebind)).toEqual([])
    expect((await rpc(restarted, { op: 'worktree.get', repository_id: lifecycle.id }))
      .repository).toMatchObject({ id: lifecycle.id, needs_rebind: false })
    expect((await rpc(restarted, { op: 'terminal.create', workspace_id: first.id })).terminal_id)
      .toEqual(expect.any(String))
    expect((await rpc(restarted, { op: 'review.status', workspace_id: first.id })).type)
      .toEqual(expect.any(String))
    const run = await rpc(restarted, { op: 'script.start', workspace_id: first.id, name: 'verify' })
    await expect.poll(async () => (await rpc(restarted, { op: 'script.inspect',
      workspace_id: first.id, run_id: run.run_id })).state).toBe('exited')
    expect(await readFile(join(targetCheckout, 'ran-here.txt'), 'utf8'))
      .toBe(await realpath(targetCheckout))
    await rpc(restarted, { op: 'service.start', workspace_id: first.id, name: 'rebound-service' })
    await rpc(restarted, { op: 'service.stop', workspace_id: first.id, name: 'rebound-service' })
    await rename(targetCheckout, join(outside, 'target-moved'))
    await mkdir(targetCheckout)
    expect(await reply(restarted, { op: 'terminal.create', workspace_id: first.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect(await reply(restarted, { op: 'worktree.get', repository_id: lifecycle.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect((await rpc(restarted, { op: 'workspace.open', path: targetCheckout })).workspace)
      .toMatchObject({ id: first.id, needs_rebind: true })
    expect(await readFile(join(sourceCheckout, 'marker.txt'), 'utf8')).toBe('source only\n')
    expect((await rpc(source.socket, { op: 'catalog.get' })).catalog).toEqual(expect.objectContaining({
      workspaces: expect.arrayContaining([expect.objectContaining({ id: first.id, root: first.root })]),
    }))
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('renamed source directories retain their saved physical identity and cannot be rebound', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-source-identity-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const plain = join(outside, 'plain-source')
    const missingIdentity = join(outside, 'missing-identity-source')
    const missingIdentityTarget = join(outside, 'missing-identity-target')
    const gitSource = join(outside, 'git-source')
    const gitTarget = join(outside, 'git-target')
    const lifecycleSource = join(outside, 'lifecycle-source')
    const lifecycleTarget = join(outside, 'lifecycle-target')
    await mkdir(plain)
    await mkdir(missingIdentity)
    await mkdir(missingIdentityTarget)
    await execFileAsync('git', ['init', '-q', '-b', 'main', gitSource])
    await execFileAsync('git', ['init', '-q', '-b', 'main', gitTarget])
    await execFileAsync('git', ['init', '-q', '-b', 'main', lifecycleSource])
    await execFileAsync('git', ['init', '-q', '-b', 'main', lifecycleTarget])
    const ordinary = (await rpc(source.socket, { op: 'workspace.open', path: plain }))
      .workspace as { id: string }
    const missing = (await rpc(source.socket, { op: 'workspace.open', path: missingIdentity }))
      .workspace as { id: string }
    const repositoryWorkspace = (await rpc(source.socket, { op: 'workspace.open', path: gitSource }))
      .workspace as { id: string; repository_id: string }
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: lifecycleSource }))
      .repository as { id: string }
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    await execFileAsync('python3', ['-c',
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"DELETE FROM path_bindings WHERE kind='workspace' AND id=?\",(sys.argv[2],)); c.commit()",
      join(data, 'sessions.sqlite'), missing.id])
    await rename(plain, join(outside, 'plain-renamed'))
    await rename(gitSource, join(outside, 'git-renamed'))
    await rename(lifecycleSource, join(outside, 'lifecycle-renamed'))
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    expect(await reply(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: join(outside, 'lifecycle-renamed') })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical repository') })
    expect((await rpc(socket, { op: 'worktree.rebind.list' })).repositories)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: lifecycle.id,
        needs_rebind: true })]))
    await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: lifecycleTarget })
    expect(await reply(socket, { op: 'repository.rebind',
      repository_id: repositoryWorkspace.repository_id,
      path: join(outside, 'git-renamed') })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical repository') })
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: ordinary.id,
      path: join(outside, 'plain-renamed') })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical directory') })
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: missing.id,
      path: missingIdentityTarget })).toMatchObject({ type: 'error', message:
      expect.stringContaining('physical identity is unavailable') })
    await rpc(socket, { op: 'repository.rebind', repository_id: repositoryWorkspace.repository_id,
      path: gitTarget })
    await rename(join(gitTarget, '.git'), join(gitTarget, '.git-saved'))
    await execFileAsync('git', ['init', '-q', gitTarget])
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: repositoryWorkspace.id,
      path: gitTarget })).toMatchObject({ type: 'error', message:
      expect.stringContaining('Rebind the repository first') })
    expect(await reply(socket, { op: 'terminal.create', workspace_id: ordinary.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('second rebind and another workspace cannot recover authority over saved source directories', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-second-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceGit = join(outside, 'source-git')
    const targetGit = join(outside, 'target-git')
    const sourceLife = join(outside, 'source-life')
    const targetLife = join(outside, 'target-life')
    const sourcePlain = join(outside, 'source-plain')
    const targetPlain = join(outside, 'target-plain')
    await execFileAsync('git', ['init', '-q', '-b', 'main', sourceGit])
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetGit])
    await execFileAsync('git', ['init', '-q', '-b', 'main', sourceLife])
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetLife])
    await mkdir(sourcePlain)
    await mkdir(targetPlain)
    const gitWorkspace = (await rpc(source.socket, { op: 'workspace.open', path: sourceGit }))
      .workspace as { id: string; repository_id: string }
    const plainWorkspace = (await rpc(source.socket, { op: 'workspace.open', path: sourcePlain }))
      .workspace as { id: string }
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: sourceLife }))
      .repository as { id: string }
    const privateRoot = await realpath(source.rootDirectory)
    const privateWorkspace = ((await rpc(source.socket, { op: 'catalog.get' })).catalog as {
      workspaces: Array<{ id: string; root: string }>
    }).workspaces.find((workspace) => workspace.root === privateRoot)!
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id, path: targetLife })
    await rpc(socket, { op: 'repository.rebind', repository_id: gitWorkspace.repository_id,
      path: targetGit })
    await rpc(socket, { op: 'workspace.rebind', workspace_id: gitWorkspace.id, path: targetGit })
    await rpc(socket, { op: 'workspace.rebind', workspace_id: plainWorkspace.id, path: targetPlain })
    await rename(targetGit, join(outside, 'target-git-moved'))
    await rename(targetPlain, join(outside, 'target-plain-moved'))
    await rename(sourcePlain, join(outside, 'source-plain-renamed'))
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetGit])
    await mkdir(targetPlain)
    expect(await reply(socket, { op: 'repository.rebind', repository_id: gitWorkspace.repository_id,
      path: sourceGit })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical repository') })
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: gitWorkspace.id,
      path: sourceGit })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical directory') })
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: plainWorkspace.id,
      path: join(outside, 'source-plain-renamed') })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical directory') })
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: privateWorkspace.id,
      path: join(outside, 'source-plain-renamed') })).toMatchObject({ type: 'error', message:
      expect.stringContaining('saved source workspace') })
    await rename(targetLife, join(outside, 'target-life-moved'))
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetLife])
    expect(await reply(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: sourceLife })).toMatchObject({ type: 'error', message:
      expect.stringContaining('different physical repository') })
    expect(await reply(socket, { op: 'terminal.create', workspace_id: gitWorkspace.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect(await reply(socket, { op: 'terminal.create', workspace_id: plainWorkspace.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('core rebind follows the same lifecycle repository after a second lifecycle rebind', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-lineage-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceGit = join(outside, 'source')
    const cloneA = join(outside, 'clone-a')
    const cloneB = join(outside, 'clone-b')
    const cloneC = join(outside, 'clone-c')
    for (const folder of [sourceGit, cloneA, cloneB, cloneC])
      await execFileAsync('git', ['init', '-q', '-b', 'main', folder])
    const workspace = (await rpc(source.socket, { op: 'workspace.open', path: sourceGit }))
      .workspace as { repository_id: string }
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: sourceGit }))
      .repository as { id: string }
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id, path: cloneA })
    await rpc(socket, { op: 'repository.rebind', repository_id: workspace.repository_id,
      path: cloneA })
    await rename(cloneA, join(outside, 'clone-a-moved'))
    await execFileAsync('git', ['init', '-q', '-b', 'main', cloneA])
    await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id, path: cloneB })
    expect(await reply(socket, { op: 'repository.rebind', repository_id: workspace.repository_id,
      path: cloneC })).toMatchObject({ type: 'error', message:
      expect.stringContaining('differs from the Worktrunk binding') })
    expect((await rpc(socket, { op: 'repository.rebind',
      repository_id: workspace.repository_id, path: cloneB })).repository)
      .toMatchObject({ id: workspace.repository_id, root: await realpath(join(cloneB, '.git')) })
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('core and lifecycle rebinds reject each other’s unrelated source checkout', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-cross-store-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceCore = join(outside, 'source-core')
    const sourceLife = join(outside, 'source-life')
    const targetCore = join(outside, 'target-core')
    const targetLife = join(outside, 'target-life')
    for (const folder of [sourceCore, sourceLife, targetCore, targetLife])
      await execFileAsync('git', ['init', '-q', '-b', 'main', folder])
    const workspace = (await rpc(source.socket, { op: 'workspace.open', path: sourceCore }))
      .workspace as { repository_id: string }
    const lifecycle = (await rpc(source.socket, { op: 'worktree.repository', path: sourceLife }))
      .repository as { id: string }
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    await rpc(socket, { op: 'worktree.rebind', repository_id: lifecycle.id, path: targetLife })
    expect(await reply(socket, { op: 'repository.rebind', repository_id: workspace.repository_id,
      path: sourceLife })).toMatchObject({ type: 'error', message:
      expect.stringContaining('saved source Worktrunk repository') })
    await rpc(socket, { op: 'repository.rebind', repository_id: workspace.repository_id,
      path: targetCore })
    await rename(targetLife, join(outside, 'target-life-moved'))
    await execFileAsync('git', ['init', '-q', '-b', 'main', targetLife])
    expect(await reply(socket, { op: 'worktree.rebind', repository_id: lifecycle.id,
      path: sourceCore })).toMatchObject({ type: 'error', message:
      expect.stringContaining('saved source workspace or repository') })
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('schema-12 restore cannot rebind without a saved source physical identity', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-schema12-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceFolder = join(outside, 'source-folder')
    const targetFolder = join(outside, 'target-folder')
    await mkdir(sourceFolder)
    await mkdir(targetFolder)
    const workspace = (await rpc(source.socket, { op: 'workspace.open', path: sourceFolder }))
      .workspace as { id: string }
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DROP TABLE path_bindings"); c.execute("DELETE FROM schema_migrations WHERE version=13"); c.execute("PRAGMA user_version=12"); c.commit()',
      join(backup, 'sessions.sqlite')])
    const bytes = await readFile(join(backup, 'sessions.sqlite'))
    const manifestFile = join(backup, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      entries: Array<{ path: string; schema?: number; sha256: string; size: number }>
    }
    const core = manifest.entries.find((entry) => entry.path === 'sessions.sqlite')!
    core.schema = 12
    core.sha256 = createHash('sha256').update(bytes).digest('hex')
    core.size = bytes.length
    await writeFile(manifestFile, JSON.stringify(manifest))
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    expect((await rpc(socket, { op: 'catalog.get' })).catalog)
      .toEqual(expect.objectContaining({ workspaces: expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, needs_rebind: true }),
      ]) }))
    expect(await reply(socket, { op: 'workspace.rebind', workspace_id: workspace.id,
      path: targetFolder })).toMatchObject({ type: 'error', message:
      expect.stringContaining('physical identity is unavailable') })
    expect((await rpc(socket, { op: 'workspace.rebind.list' })).workspaces)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id,
        needs_rebind: true, rebindable: false })]))
    expect(await reply(socket, { op: 'terminal.create', workspace_id: workspace.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

for (const failpoint of ['before_workspace_commit', 'after_workspace_commit'] as const) {
  test(`restore rebind recovers after daemon exits ${failpoint}`, async () => {
    test.setTimeout(120_000)
    const source = await startDaemon()
    const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-crash-'))
    let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
    try {
      const oldExternal = join(outside, 'old-external')
      const newExternal = join(outside, 'new-external')
      const privateTarget = join(outside, 'new-private')
      const unknown = join(outside, 'unknown')
      await Promise.all([mkdir(oldExternal), mkdir(newExternal), mkdir(privateTarget), mkdir(unknown)])
      const external = (await rpc(source.socket, { op: 'workspace.open', path: oldExternal }))
        .workspace as { id: string }
      const sourcePrivate = await realpath(source.rootDirectory)
      const privateWorkspace = ((await rpc(source.socket, { op: 'catalog.get' })).catalog as {
        workspaces: Array<{ id: string; root: string }>
      }).workspaces.find((workspace) => workspace.root === sourcePrivate)
      expect(privateWorkspace).toBeDefined()
      const backup = join(outside, 'backup')
      const data = join(outside, 'restored')
      await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
        '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
      await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
        '--backup', backup, '--data-dir', data], { timeout: 30_000 })
      restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
      const fenced = await reply(restored.socket, { op: 'workspace.open', path: unknown })
      expect(fenced).toMatchObject({ type: 'error', code: 'needs_rebind' })
      const unknownRoot = await realpath(unknown)
      expect(await rpc(restored.socket, { op: 'workspace.rebind.list' }))
        .toMatchObject({ type: 'workspace_rebind_catalog', workspaces: expect.arrayContaining([
          expect.objectContaining({ id: external.id, root: await realpath(oldExternal),
            name: 'old-external', needs_rebind: true }),
          expect.objectContaining({ id: privateWorkspace!.id, needs_rebind: true }),
        ]) })
      expect(((await rpc(restored.socket, { op: 'catalog.get' })).catalog as {
        workspaces: Array<{ root: string }>
      }).workspaces.some((workspace) => workspace.root === unknownRoot)).toBe(false)
      await rpc(restored.socket, { op: 'workspace.rebind', workspace_id: external.id,
        path: newExternal })
      await restored.stop()
      restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory,
        ADE_E2E_REBIND_FAILPOINT: failpoint })
      await expect(rpc(restored.socket, { op: 'workspace.rebind',
        workspace_id: privateWorkspace!.id, path: privateTarget })).rejects.toThrow()
      await restored.stop()
      restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
      const catalogue = (await rpc(restored.socket, { op: 'catalog.get' })).catalog as {
        workspaces: Array<{ id: string; root: string; needs_rebind: boolean }>
      }
      const rebound = catalogue.workspaces.find((workspace) => workspace.id === privateWorkspace!.id)
      expect(rebound).toMatchObject({ id: privateWorkspace!.id,
        root: failpoint === 'before_workspace_commit' ? await realpath(source.rootDirectory)
          : await realpath(privateTarget),
        needs_rebind: failpoint === 'before_workspace_commit' })
      if (failpoint === 'before_workspace_commit') {
        expect(await reply(restored.socket, { op: 'workspace.open', path: unknown }))
          .toMatchObject({ type: 'error', code: 'needs_rebind' })
        expect(await reply(restored.socket, { op: 'terminal.create',
          workspace_id: privateWorkspace!.id })).toMatchObject({ type: 'error', code: 'needs_rebind' })
        await rpc(restored.socket, { op: 'workspace.rebind', workspace_id: privateWorkspace!.id,
          path: privateTarget })
      }
      const opened = (await rpc(restored.socket, { op: 'workspace.open', path: unknown }))
        .workspace as { id: string; root: string; needs_rebind: boolean }
      expect(opened).toMatchObject({ root: await realpath(unknown), needs_rebind: false })
      expect((await rpc(restored.socket, { op: 'workspace.rebind.list' })).workspaces)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.id,
          root: unknownRoot, needs_rebind: false })]))
      await rename(unknown, join(outside, 'unknown-moved'))
      await mkdir(unknown)
      expect((await rpc(restored.socket, { op: 'workspace.rebind.list' })).workspaces)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.id,
          root: unknownRoot, needs_rebind: true })]))
      expect((await rpc(restored.socket, { op: 'terminal.create',
        workspace_id: external.id })).terminal_id).toEqual(expect.any(String))
    } finally {
      const results = await Promise.allSettled([restored?.stop(), source.stop()])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
        (failure) => String(failure.reason)).join('; ')}`)
      await rm(outside, { recursive: true, force: true })
    }
  })
}

test('a linked workspace is fenced when its Git common directory diverges from the rebound repository', async () => {
  const source = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-git-divergence-'))
  let restored: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    const sourceCheckout = join(outside, 'source')
    const targetA = join(outside, 'target-a')
    const targetB = join(outside, 'target-b')
    const unrelated = join(outside, 'unrelated')
    await execFileAsync('git', ['init', '-q', '-b', 'main', sourceCheckout])
    await writeFile(join(sourceCheckout, 'tracked.txt'), 'original\n')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: sourceCheckout })
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c',
      'user.email=fixture@example.invalid', 'commit', '-qm', 'original'], { cwd: sourceCheckout })
    for (const target of [targetA, targetB, unrelated]) {
      await execFileAsync('git', ['clone', '-q', sourceCheckout, target])
    }
    const workspace = (await rpc(source.socket, { op: 'workspace.open', path: sourceCheckout }))
      .workspace as { id: string; repository_id: string }
    const backup = join(outside, 'backup')
    const data = join(outside, 'restored')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', source.dataDirectory, '--out', backup], { timeout: 30_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', data], { timeout: 30_000 })
    restored = await startDaemon({ ADE_DATA_DIR: data, ADE_ROOT: source.rootDirectory })
    const socket = restored.socket
    await rpc(socket, { op: 'repository.rebind', repository_id: workspace.repository_id, path: targetA })
    await rpc(socket, { op: 'workspace.rebind', workspace_id: workspace.id, path: targetA })
    expect((await rpc(socket, { op: 'terminal.create', workspace_id: workspace.id })).terminal_id)
      .toEqual(expect.any(String))

    // Keep the checkout directory inode, but make Git resolve through a
    // different common directory before rebinding the core repository.
    await rename(join(targetA, '.git'), join(targetA, '.git-saved'))
    await symlink(join(unrelated, '.git'), join(targetA, '.git'))
    await rpc(socket, { op: 'repository.rebind', repository_id: workspace.repository_id, path: targetB })
    expect(await reply(socket, { op: 'terminal.create', workspace_id: workspace.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
    expect((await rpc(socket, { op: 'workspace.rebind.list' })).workspaces)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id,
        root: await realpath(targetA), needs_rebind: true })]))
    expect((await rpc(socket, { op: 'workspace.rebind', workspace_id: workspace.id,
      path: targetB })).workspace).toMatchObject({ id: workspace.id,
        root: await realpath(targetB), needs_rebind: false })
    expect((await rpc(socket, { op: 'terminal.create', workspace_id: workspace.id })).terminal_id)
      .toEqual(expect.any(String))
  } finally {
    const results = await Promise.allSettled([restored?.stop(), source.stop()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new Error(`ADE cleanup is unconfirmed; retain ${outside}: ${failures.map(
      (failure) => String(failure.reason)).join('; ')}`)
    await rm(outside, { recursive: true, force: true })
  }
})

test('a nonregular Git common-directory marker fails closed without blocking daemon requests', async () => {
  const daemon = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-rebind-git-fifo-'))
  try {
    const checkout = join(outside, 'checkout')
    await execFileAsync('git', ['init', '-q', checkout])
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout }))
      .workspace as { id: string }
    await execFileAsync('mkfifo', [join(checkout, '.git', 'commondir')])
    expect((await fixtureRpc(daemon.socket, { op: 'workspace.rebind.list' }, 2_000)).workspaces)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id,
        needs_rebind: true })]))
    expect(await reply(daemon.socket, { op: 'terminal.create', workspace_id: workspace.id }))
      .toMatchObject({ type: 'error', code: 'needs_rebind' })
  } finally {
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})
