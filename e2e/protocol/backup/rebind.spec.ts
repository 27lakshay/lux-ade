// R014 restore rebind: a restored profile's workspaces, repositories and Git
// lifecycle repositories are rebound one by one to folders the user names,
// never to the saved source folders or an unrelated checkout, and a rebind
// interrupted by a daemon exit recovers. Ported from the legacy
// e2e/specs/restored-workspace-rebind spec; the backup runs through ade-control.
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, test, type AdeHarness, type ScratchProfile } from '../fixtures'
import { scratchEnvironment } from '../fixtures/environment'
import { rawReply } from '../fixtures/raw-reply'
import { backupAndRestore } from './helpers'

const run = promisify(execFile)

async function git(ade: AdeHarness, ...args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: ade.root,
    env: scratchEnvironment(join(ade.root, 'git-home')),
  })
}

/** `git init` with no commit at each path. */
async function emptyRepositories(ade: AdeHarness, ...paths: string[]): Promise<void> {
  for (const path of paths) await git(ade, 'init', '-q', '-b', 'main', path)
}

let terminals = 0

/** A raw terminal.create, so a refusal's code is visible. */
function createTerminal(profile: ScratchProfile, workspace_id: string) {
  return rawReply(profile, { op: 'terminal.create', operation_id: `rebind-terminal-${++terminals}`, workspace_id })
}

const fenced = { type: 'error', code: 'needs_rebind' }

function refused(message: string) {
  return { type: 'error', message: expect.stringContaining(message) }
}

/** The source profile's own private workspace. */
async function privateWorkspace(profile: ScratchProfile) {
  const root = await realpath(profile.defaultWorkspaceRoot)
  const found = (await profile.call('catalog.get', {})).catalog.workspaces.find((workspace) => workspace.root === root)
  expect(found).toBeDefined()
  return found!
}

/** Restore `source` into a profile that keeps the source's private workspace path. */
function restoreSharingRoot(
  ade: AdeHarness,
  source: ScratchProfile,
  before?: (dataDirectory: string) => Promise<void>,
) {
  return backupAndRestore(ade, source, { env: { ADE_ROOT: source.defaultWorkspaceRoot }, before })
}

test('restored repository and shared workspaces rebind explicitly without source authority', async ({
  ade,
  profile: source,
}) => {
  test.setTimeout(120_000)
  const outside = join(ade.root, 'outside')
  const sourceCheckout = join(outside, 'source')
  const sourceSecond = join(outside, 'source-second')
  const targetCheckout = join(outside, 'target')
  const targetSecond = join(outside, 'target-second')
  const otherCheckout = join(outside, 'other')
  const privateTarget = join(outside, 'private-target')
  await mkdir(privateTarget, { recursive: true })
  await git(ade, 'init', '-q', '-b', 'main', sourceCheckout)
  await writeFile(join(sourceCheckout, 'marker.txt'), 'source only\n')
  await git(ade, '-C', sourceCheckout, 'add', 'marker.txt')
  await git(ade, '-C', sourceCheckout, 'commit', '-q', '-m', 'source')
  await git(ade, '-C', sourceCheckout, 'worktree', 'add', '-q', '-b', 'source-second', sourceSecond)
  await git(ade, 'clone', '-q', sourceCheckout, targetCheckout)
  await git(ade, '-C', targetCheckout, 'worktree', 'add', '-q', '-b', 'target-second', targetSecond)
  await git(ade, 'clone', '-q', sourceCheckout, otherCheckout)
  await writeFile(
    join(targetCheckout, 'package.json'),
    JSON.stringify({
      name: 'rebind-fixture',
      scripts: { verify: "node -e \"require('fs').writeFileSync('ran-here.txt',process.cwd())\"" },
    }),
  )

  const first = (await source.call('workspace.open', { path: sourceCheckout })).workspace
  const second = (await source.call('workspace.open', { path: sourceSecond })).workspace
  expect(second.project_id).toBe(first.project_id)
  const projectId = first.project_id
  const conversation = (
    await source.call('conversation.create', { workspace_id: first.id, provider: 'codex', title: 'Preserved history' })
  ).conversation
  await source.call('draft.save', {
    conversation_id: conversation.id,
    window_id: 'original',
    revision: 1,
    text: 'preserved draft',
  })
  const lifecycle = (await source.call('worktree.repository', { path: sourceCheckout })).repository
  const privateSource = await privateWorkspace(source)
  await source.call('service.configure', {
    workspace_id: first.id,
    name: 'rebound-service',
    revision: 0,
    config: { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: '.', env: {}, ports: [] },
  })

  const restored = await restoreSharingRoot(ade, source)
  expect((await restored.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
    id: conversation.id,
    workspace_id: first.id,
  })
  expect(
    (await restored.call('draft.get', { conversation_id: conversation.id, window_id: 'original' })).draft,
  ).toMatchObject({ text: 'preserved draft' })
  expect(await createTerminal(restored, first.id)).toMatchObject(fenced)
  expect((await restored.call('rebind.list', {})).lifecycle).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: lifecycle.id, needs_rebind: true, rebindable: true })]),
  )
  // The CLI reads the same one list.
  expect((await restored.cli('rebind', 'list')).json).toMatchObject({
    type: 'rebind_catalog',
    lifecycle: expect.arrayContaining([expect.objectContaining({ id: lifecycle.id, needs_rebind: true })]),
  })
  expect(await restored.call('rebind.list', {})).toMatchObject({
    type: 'rebind_catalog',
    repositories: expect.arrayContaining([
      expect.objectContaining({
        id: projectId,
        root: await realpath(join(sourceCheckout, '.git')),
        needs_rebind: true,
        rebindable: true,
      }),
    ]),
  })
  // The saved source checkout and a missing folder are refused; a clone is accepted.
  for (const path of [sourceCheckout, join(outside, 'missing')]) {
    expect(await rawReply(restored, { op: 'worktree.rebind', project_id: lifecycle.id, path })).toMatchObject({
      type: 'error',
    })
  }
  expect(
    (await restored.call('worktree.rebind', { project_id: lifecycle.id, path: targetCheckout })).repository,
  ).toMatchObject({ id: lifecycle.id, needs_rebind: false, root: await realpath(targetCheckout) })

  // A process restart between the two SQLite bindings must preserve the
  // unbound core catalogue and reject execution.
  await restored.stop()
  await restored.restartDaemon()
  expect(await createTerminal(restored, first.id)).toMatchObject(fenced)
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: privateSource.id, path: sourceCheckout }),
  ).toMatchObject(refused('ordinary workspace'))
  expect(await createTerminal(restored, privateSource.id)).toMatchObject(fenced)
  expect(
    await rawReply(restored, { op: 'repository.rebind', project_id: projectId, path: otherCheckout }),
  ).toMatchObject(refused('lifecycle binding'))
  expect(
    (await restored.call('repository.rebind', { project_id: projectId, path: targetCheckout })).repository,
  ).toMatchObject({ id: projectId, root: await realpath(join(targetCheckout, '.git')), needs_rebind: false })
  expect((await restored.call('rebind.list', {})).repositories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: projectId,
        root: await realpath(join(targetCheckout, '.git')),
        needs_rebind: false,
      }),
    ]),
  )
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: first.id, path: sourceCheckout }),
  ).toMatchObject({ type: 'error' })
  expect(
    (await restored.call('workspace.rebind', { workspace_id: first.id, path: targetCheckout })).workspace,
  ).toMatchObject({ id: first.id, root: await realpath(targetCheckout), needs_rebind: false })
  expect(await createTerminal(restored, second.id)).toMatchObject(fenced)
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: second.id, path: targetCheckout }),
  ).toMatchObject(refused('another identity'))
  // Two concurrent rebinds of one workspace: only the valid target wins.
  const [valid, competing] = await Promise.all([
    rawReply(restored, { op: 'workspace.rebind', workspace_id: second.id, path: targetSecond }),
    rawReply(restored, { op: 'workspace.rebind', workspace_id: second.id, path: sourceSecond }),
  ])
  expect(valid).toMatchObject({
    type: 'ack',
    workspace: { id: second.id, root: await realpath(targetSecond), needs_rebind: false },
  })
  expect(competing).toMatchObject({ type: 'error' })
  await restored.call('workspace.rebind', { workspace_id: privateSource.id, path: privateTarget })
  const { catalog } = await restored.call('catalog.get', {})
  expect(catalog.workspaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.id, root: await realpath(targetCheckout), needs_rebind: false }),
      expect.objectContaining({ id: second.id, root: await realpath(targetSecond), needs_rebind: false }),
    ]),
  )
  expect(catalog.workspaces.filter((workspace) => workspace.needs_rebind)).toEqual([])
  expect((await restored.call('worktree.get', { project_id: lifecycle.id })).repository).toMatchObject({
    id: lifecycle.id,
    needs_rebind: false,
  })

  // Execution now runs in the rebound checkout.
  expect((await restored.call('terminal.create', { workspace_id: first.id })).terminal_id).toEqual(expect.any(String))
  expect((await restored.call('review.status', { workspace_id: first.id })).type).toEqual(expect.any(String))
  const script = await restored.call('script.start', { workspace_id: first.id, name: 'verify' })
  await expect
    .poll(async () => (await restored.call('script.inspect', { workspace_id: first.id, run_id: script.run_id })).state)
    .toBe('exited')
  expect(await readFile(join(targetCheckout, 'ran-here.txt'), 'utf8')).toBe(await realpath(targetCheckout))
  await restored.call('service.start', { workspace_id: first.id, name: 'rebound-service' })
  await restored.call('service.stop', { workspace_id: first.id, name: 'rebound-service' })

  // A replaced target folder fences the workspace and its lifecycle repository again.
  await rename(targetCheckout, join(outside, 'target-moved'))
  await mkdir(targetCheckout)
  expect(await createTerminal(restored, first.id)).toMatchObject(fenced)
  expect(await rawReply(restored, { op: 'worktree.get', project_id: lifecycle.id })).toMatchObject(fenced)
  expect((await restored.call('workspace.open', { path: targetCheckout })).workspace).toMatchObject({
    id: first.id,
    needs_rebind: true,
  })
  expect(await readFile(join(sourceCheckout, 'marker.txt'), 'utf8')).toBe('source only\n')
  expect((await source.call('catalog.get', {})).catalog.workspaces).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: first.id, root: first.root })]),
  )
})

test('renamed source directories retain their saved physical identity and cannot be rebound', async ({
  ade,
  profile: source,
}) => {
  const outside = join(ade.root, 'outside')
  const plain = join(outside, 'plain-source')
  const missingIdentity = join(outside, 'missing-identity-source')
  const missingIdentityTarget = join(outside, 'missing-identity-target')
  const gitSource = join(outside, 'git-source')
  const gitTarget = join(outside, 'git-target')
  const lifecycleSource = join(outside, 'lifecycle-source')
  const lifecycleTarget = join(outside, 'lifecycle-target')
  for (const folder of [plain, missingIdentity, missingIdentityTarget]) await mkdir(folder, { recursive: true })
  await emptyRepositories(ade, gitSource, gitTarget, lifecycleSource, lifecycleTarget)
  const ordinary = (await source.call('workspace.open', { path: plain })).workspace
  const missing = (await source.call('workspace.open', { path: missingIdentity })).workspace
  const repositoryWorkspace = (await source.call('workspace.open', { path: gitSource })).workspace
  const lifecycle = (await source.call('worktree.repository', { path: lifecycleSource })).repository

  const restored = await restoreSharingRoot(ade, source, async (data) => {
    // One workspace lost its saved physical identity.
    const db = new DatabaseSync(join(data, 'sessions.sqlite'))
    db.prepare("DELETE FROM path_bindings WHERE kind='workspace' AND id=?").run(missing.id)
    db.close()
    await rename(plain, join(outside, 'plain-renamed'))
    await rename(gitSource, join(outside, 'git-renamed'))
    await rename(lifecycleSource, join(outside, 'lifecycle-renamed'))
  })
  // A lifecycle-only repository has no catalog binding, so the lifecycle's own identity check refuses.
  expect(
    await rawReply(restored, {
      op: 'worktree.rebind',
      project_id: lifecycle.id,
      path: join(outside, 'lifecycle-renamed'),
    }),
  ).toMatchObject(refused('different physical repository from the saved checkout'))
  expect((await restored.call('rebind.list', {})).lifecycle).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: lifecycle.id, needs_rebind: true })]),
  )
  await restored.call('worktree.rebind', { project_id: lifecycle.id, path: lifecycleTarget })
  expect(
    await rawReply(restored, {
      op: 'repository.rebind',
      project_id: repositoryWorkspace.project_id,
      path: join(outside, 'git-renamed'),
    }),
  ).toMatchObject(refused('different physical repository'))
  expect(
    await rawReply(restored, {
      op: 'workspace.rebind',
      workspace_id: ordinary.id,
      path: join(outside, 'plain-renamed'),
    }),
  ).toMatchObject(refused('different physical directory'))
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: missing.id, path: missingIdentityTarget }),
  ).toMatchObject(refused('physical identity is unavailable'))
  await restored.call('repository.rebind', { project_id: repositoryWorkspace.project_id, path: gitTarget })
  // The rebound repository's Git directory is replaced before its workspace is rebound.
  await rename(join(gitTarget, '.git'), join(gitTarget, '.git-saved'))
  await git(ade, 'init', '-q', gitTarget)
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: repositoryWorkspace.id, path: gitTarget }),
  ).toMatchObject(refused('Rebind the repository first'))
  expect(await createTerminal(restored, ordinary.id)).toMatchObject(fenced)
})

test('second rebind and another workspace cannot recover authority over saved source directories', async ({
  ade,
  profile: source,
}) => {
  const outside = join(ade.root, 'outside')
  const sourceGit = join(outside, 'source-git')
  const targetGit = join(outside, 'target-git')
  const sourceLife = join(outside, 'source-life')
  const targetLife = join(outside, 'target-life')
  const sourcePlain = join(outside, 'source-plain')
  const targetPlain = join(outside, 'target-plain')
  await emptyRepositories(ade, sourceGit, targetGit, sourceLife, targetLife)
  await mkdir(sourcePlain)
  await mkdir(targetPlain)
  const gitWorkspace = (await source.call('workspace.open', { path: sourceGit })).workspace
  const plainWorkspace = (await source.call('workspace.open', { path: sourcePlain })).workspace
  const lifecycle = (await source.call('worktree.repository', { path: sourceLife })).repository
  const privateSource = await privateWorkspace(source)

  const restored = await restoreSharingRoot(ade, source)
  await restored.call('worktree.rebind', { project_id: lifecycle.id, path: targetLife })
  await restored.call('repository.rebind', { project_id: gitWorkspace.project_id, path: targetGit })
  await restored.call('workspace.rebind', { workspace_id: gitWorkspace.id, path: targetGit })
  await restored.call('workspace.rebind', { workspace_id: plainWorkspace.id, path: targetPlain })
  // The rebound targets are replaced, and a source folder is renamed.
  await rename(targetGit, join(outside, 'target-git-moved'))
  await rename(targetPlain, join(outside, 'target-plain-moved'))
  await rename(sourcePlain, join(outside, 'source-plain-renamed'))
  await git(ade, 'init', '-q', '-b', 'main', targetGit)
  await mkdir(targetPlain)
  expect(
    await rawReply(restored, {
      op: 'repository.rebind',
      project_id: gitWorkspace.project_id,
      path: sourceGit,
    }),
  ).toMatchObject(refused('different physical repository'))
  expect(
    await rawReply(restored, { op: 'workspace.rebind', workspace_id: gitWorkspace.id, path: sourceGit }),
  ).toMatchObject(refused('different physical directory'))
  expect(
    await rawReply(restored, {
      op: 'workspace.rebind',
      workspace_id: plainWorkspace.id,
      path: join(outside, 'source-plain-renamed'),
    }),
  ).toMatchObject(refused('different physical directory'))
  expect(
    await rawReply(restored, {
      op: 'workspace.rebind',
      workspace_id: privateSource.id,
      path: join(outside, 'source-plain-renamed'),
    }),
  ).toMatchObject(refused('saved source workspace'))
  await rename(targetLife, join(outside, 'target-life-moved'))
  await git(ade, 'init', '-q', '-b', 'main', targetLife)
  expect(await rawReply(restored, { op: 'worktree.rebind', project_id: lifecycle.id, path: sourceLife })).toMatchObject(
    refused('different physical repository from the saved checkout'),
  )
  expect(await createTerminal(restored, gitWorkspace.id)).toMatchObject(fenced)
  expect(await createTerminal(restored, plainWorkspace.id)).toMatchObject(fenced)
})

test('core rebind follows the same lifecycle repository after a second lifecycle rebind', async ({
  ade,
  profile: source,
}) => {
  const outside = join(ade.root, 'outside')
  const [sourceGit, cloneA, cloneB, cloneC] = ['source', 'clone-a', 'clone-b', 'clone-c'].map((name) =>
    join(outside, name),
  )
  await emptyRepositories(ade, sourceGit, cloneA, cloneB, cloneC)
  const workspace = (await source.call('workspace.open', { path: sourceGit })).workspace
  const lifecycle = (await source.call('worktree.repository', { path: sourceGit })).repository
  const restored = await restoreSharingRoot(ade, source)
  await restored.call('worktree.rebind', { project_id: lifecycle.id, path: cloneA })
  await restored.call('repository.rebind', { project_id: workspace.project_id, path: cloneA })
  await rename(cloneA, join(outside, 'clone-a-moved'))
  await git(ade, 'init', '-q', '-b', 'main', cloneA)
  await restored.call('worktree.rebind', { project_id: lifecycle.id, path: cloneB })
  expect(
    await rawReply(restored, { op: 'repository.rebind', project_id: workspace.project_id, path: cloneC }),
  ).toMatchObject(refused('differs from the lifecycle binding'))
  expect(
    (await restored.call('repository.rebind', { project_id: workspace.project_id, path: cloneB })).repository,
  ).toMatchObject({ id: workspace.project_id, root: await realpath(join(cloneB, '.git')) })
})

test('core and lifecycle rebinds reject each other’s unrelated source checkout', async ({ ade, profile: source }) => {
  const outside = join(ade.root, 'outside')
  const [sourceCore, sourceLife, targetCore, targetLife] = [
    'source-core',
    'source-life',
    'target-core',
    'target-life',
  ].map((name) => join(outside, name))
  await emptyRepositories(ade, sourceCore, sourceLife, targetCore, targetLife)
  const workspace = (await source.call('workspace.open', { path: sourceCore })).workspace
  const lifecycle = (await source.call('worktree.repository', { path: sourceLife })).repository
  const restored = await restoreSharingRoot(ade, source)
  await restored.call('worktree.rebind', { project_id: lifecycle.id, path: targetLife })
  expect(
    await rawReply(restored, { op: 'repository.rebind', project_id: workspace.project_id, path: sourceLife }),
  ).toMatchObject(refused('saved source Git lifecycle repository'))
  await restored.call('repository.rebind', { project_id: workspace.project_id, path: targetCore })
  await rename(targetLife, join(outside, 'target-life-moved'))
  await git(ade, 'init', '-q', '-b', 'main', targetLife)
  expect(await rawReply(restored, { op: 'worktree.rebind', project_id: lifecycle.id, path: sourceCore })).toMatchObject(
    refused('saved source workspace or repository'),
  )
})

for (const failpoint of ['before_workspace_commit', 'after_workspace_commit'] as const) {
  test(`restore rebind recovers after daemon exits ${failpoint}`, async ({ ade, profile: source }) => {
    test.setTimeout(120_000)
    const outside = join(ade.root, 'outside')
    const [oldExternal, newExternal, privateTarget, unknown] = [
      'old-external',
      'new-external',
      'new-private',
      'unknown',
    ].map((name) => join(outside, name))
    for (const folder of [oldExternal, newExternal, privateTarget, unknown]) await mkdir(folder, { recursive: true })
    const external = (await source.call('workspace.open', { path: oldExternal })).workspace
    const privateSource = await privateWorkspace(source)
    const restored = await restoreSharingRoot(ade, source)
    expect(await rawReply(restored, { op: 'workspace.open', path: unknown })).toMatchObject(fenced)
    const unknownRoot = await realpath(unknown)
    expect(await restored.call('rebind.list', {})).toMatchObject({
      type: 'rebind_catalog',
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          id: external.id,
          root: await realpath(oldExternal),
          name: 'old-external',
          needs_rebind: true,
        }),
        expect.objectContaining({ id: privateSource.id, needs_rebind: true }),
      ]),
    })
    expect(
      (await restored.call('catalog.get', {})).catalog.workspaces.some((workspace) => workspace.root === unknownRoot),
    ).toBe(false)
    await restored.call('workspace.rebind', { workspace_id: external.id, path: newExternal })

    // The daemon exits at the failpoint while rebinding the private workspace.
    await restored.stop()
    restored.env.ADE_E2E_REBIND_FAILPOINT = failpoint
    await restored.restartDaemon()
    await expect(
      restored.call('workspace.rebind', { workspace_id: privateSource.id, path: privateTarget }),
    ).rejects.toThrow()
    await restored.stop()
    delete restored.env.ADE_E2E_REBIND_FAILPOINT
    await restored.restartDaemon()

    const rebound = (await restored.call('catalog.get', {})).catalog.workspaces.find(
      (workspace) => workspace.id === privateSource.id,
    )
    expect(rebound).toMatchObject({
      id: privateSource.id,
      root:
        failpoint === 'before_workspace_commit'
          ? await realpath(source.defaultWorkspaceRoot)
          : await realpath(privateTarget),
      needs_rebind: failpoint === 'before_workspace_commit',
    })
    if (failpoint === 'before_workspace_commit') {
      expect(await rawReply(restored, { op: 'workspace.open', path: unknown })).toMatchObject(fenced)
      expect(await createTerminal(restored, privateSource.id)).toMatchObject(fenced)
      await restored.call('workspace.rebind', { workspace_id: privateSource.id, path: privateTarget })
    }
    // Once every workspace is rebound, new folders open as ordinary workspaces.
    const opened = (await restored.call('workspace.open', { path: unknown })).workspace
    expect(opened).toMatchObject({ root: unknownRoot, needs_rebind: false })
    expect((await restored.call('rebind.list', {})).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: opened.id, root: unknownRoot, needs_rebind: false })]),
    )
    await rename(unknown, join(outside, 'unknown-moved'))
    await mkdir(unknown)
    expect((await restored.call('rebind.list', {})).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: opened.id, root: unknownRoot, needs_rebind: true })]),
    )
    expect((await restored.call('terminal.create', { workspace_id: external.id })).terminal_id).toEqual(
      expect.any(String),
    )
  })
}

test('a linked workspace is fenced when its Git common directory diverges from the rebound repository', async ({
  ade,
  profile: source,
}) => {
  const outside = join(ade.root, 'outside')
  const sourceCheckout = join(outside, 'source')
  const [targetA, targetB, unrelated] = ['target-a', 'target-b', 'unrelated'].map((name) => join(outside, name))
  await git(ade, 'init', '-q', '-b', 'main', sourceCheckout)
  await writeFile(join(sourceCheckout, 'tracked.txt'), 'original\n')
  await git(ade, '-C', sourceCheckout, 'add', 'tracked.txt')
  await git(ade, '-C', sourceCheckout, 'commit', '-qm', 'original')
  for (const target of [targetA, targetB, unrelated]) await git(ade, 'clone', '-q', sourceCheckout, target)
  const workspace = (await source.call('workspace.open', { path: sourceCheckout })).workspace
  const restored = await restoreSharingRoot(ade, source)
  await restored.call('repository.rebind', { project_id: workspace.project_id, path: targetA })
  await restored.call('workspace.rebind', { workspace_id: workspace.id, path: targetA })
  expect((await restored.call('terminal.create', { workspace_id: workspace.id })).terminal_id).toEqual(
    expect.any(String),
  )

  // Keep the checkout directory inode, but make Git resolve through a
  // different common directory before rebinding the core repository.
  await rename(join(targetA, '.git'), join(targetA, '.git-saved'))
  await symlink(join(unrelated, '.git'), join(targetA, '.git'))
  await restored.call('repository.rebind', { project_id: workspace.project_id, path: targetB })
  expect(await createTerminal(restored, workspace.id)).toMatchObject(fenced)
  expect((await restored.call('rebind.list', {})).workspaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: workspace.id, root: await realpath(targetA), needs_rebind: true }),
    ]),
  )
  expect(
    (await restored.call('workspace.rebind', { workspace_id: workspace.id, path: targetB })).workspace,
  ).toMatchObject({ id: workspace.id, root: await realpath(targetB), needs_rebind: false })
  expect((await restored.call('terminal.create', { workspace_id: workspace.id })).terminal_id).toEqual(
    expect.any(String),
  )
})

test('a nonregular Git common-directory marker fails closed without blocking daemon requests', async ({
  ade,
  profile,
}) => {
  const checkout = join(ade.root, 'checkout')
  await git(ade, 'init', '-q', checkout)
  const workspace = (await profile.call('workspace.open', { path: checkout })).workspace
  await run('mkfifo', [join(checkout, '.git', 'commondir')])
  expect((await profile.call('rebind.list', {}, { timeoutMs: 2_000 })).workspaces).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: workspace.id, needs_rebind: true })]),
  )
  expect(await createTerminal(profile, workspace.id)).toMatchObject(fenced)
})
