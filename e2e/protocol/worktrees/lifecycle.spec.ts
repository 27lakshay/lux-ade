// F063, F066, F067, F069: creating trees from naming defaults, setup and
// teardown hooks, and archive and cleanup, through the SDK against a real
// lifecycle daemon and real Git.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test } from '../fixtures'
import { create, createReady, item, operation, operationId, register, settled } from './lifecycle'


/** A hook that runs a shell script; hooks are argument vectors, never shell lines. */
const sh = (name: string, script: string, timeout_seconds?: number) =>
  ({ name, command: ['/bin/sh', '-c', script], ...(timeout_seconds ? { timeout_seconds } : {}) })

test('create applies the branch prefix and default base, generates free names, refuses collisions and records the resolved names', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const release = await repo.head()
  await repo.git('branch', 'release')
  await repo.commit('Main moves on', { 'main.txt': 'main only\n' })
  const repositoryId = await register(profile, repo)
  const parent = dirname(repo.path)
  const repoName = basename(repo.path)

  await profile.call('worktree.configure', { repository_id: repositoryId,
    config: { branch_prefix: 'ade/', default_base: 'release' } })

  // A name becomes the prefix plus its slug; the tree starts at the default base.
  const named = await create(profile, repositoryId, { name: 'Login Page' })
  expect(named, JSON.stringify(named)).toMatchObject({ status: 'succeeded',
    worktree_path: join(parent, `${repoName}-ade-Login-Page`),
    result: { resolved: { branch: 'ade/Login-Page', base: 'release', path: join(parent, `${repoName}-ade-Login-Page`) } } })
  const namedPath = named.worktree_path!
  expect(await repo.git('-C', namedPath, 'rev-parse', 'HEAD')).toBe(release)
  expect(await repo.git('-C', namedPath, 'branch', '--show-current')).toBe('ade/Login-Page')
  expect(await item(profile, repositoryId, namedPath)).toMatchObject({ branch: 'ade/Login-Page', ade_owned: true,
    setup_state: 'ready', phase: 'ready' })

  // No name: the first free generated names, in order.
  const first = await create(profile, repositoryId)
  const second = await create(profile, repositoryId)
  expect(first.result!.resolved.branch).toBe('ade/wt-1')
  expect(second.result!.resolved.branch).toBe('ade/wt-2')
  expect(second.worktree_path).toBe(join(parent, `${repoName}-ade-wt-2`))

  // An explicit base overrides the default.
  const based = await create(profile, repositoryId, { name: 'from-main', base: 'main' })
  expect(await repo.git('-C', based.worktree_path!, 'rev-parse', 'HEAD')).toBe(await repo.head())

  // An explicit branch and an explicit path directly inside the parent directory.
  const customPath = join(parent, 'custom-tree')
  const explicit = await create(profile, repositoryId, { branch: 'feature/exact', path: customPath })
  expect(explicit).toMatchObject({ status: 'succeeded', worktree_path: customPath,
    result: { resolved: { branch: 'feature/exact' } } })

  const branchesBefore = await repo.git('branch', '--list', '--format=%(refname:short)')
  // A collision on an explicit name, even in another case, is refused, never renumbered.
  for (const request of [{ name: 'login page' }, { branch: 'main' }, { branch: 'feature/exact' }]) {
    const refused = await create(profile, repositoryId, request)
    expect(refused, JSON.stringify(request)).toMatchObject({ status: 'failed' })
    expect(refused.error).toMatch(/already exists/)
  }
  // A path outside the configured directory, or one that exists, is refused.
  const outside = await create(profile, repositoryId, { branch: 'outside', path: join(parent, 'nested', 'tree') })
  expect(outside).toMatchObject({ status: 'failed' })
  expect(outside.error).toMatch(/directly inside/)
  const occupied = join(parent, 'occupied')
  await writeFile(occupied, 'not a tree\n')
  const taken = await create(profile, repositoryId, { branch: 'occupied', path: occupied })
  expect(taken).toMatchObject({ status: 'failed' })
  expect(await readFile(occupied, 'utf8')).toBe('not a tree\n')
  // No refused request created a branch.
  expect(await repo.git('branch', '--list', '--format=%(refname:short)')).toBe(branchesBefore)

  // A duplicate request replays; the same ID with other parameters conflicts.
  const id = operationId('create-dup')
  await profile.call('worktree.create', { repository_id: repositoryId, operation_id: id, name: 'dup' })
  const done = await settled(profile, repositoryId, id)
  await profile.call('worktree.create', { repository_id: repositoryId, operation_id: id, name: 'dup' })
  expect(await operation(profile, repositoryId, id)).toMatchObject({ status: 'succeeded', finished_at: (done as any).finished_at })
  expect((await profile.call('worktree.get', { repository_id: repositoryId })).worktrees
    .filter((tree) => tree.branch === 'ade/dup')).toHaveLength(1)
  await expect(profile.call('worktree.create', { repository_id: repositoryId, operation_id: id, name: 'other' }))
    .rejects.toThrow(/already used for different parameters/)
})

test('setup hooks run in the tree with its context; a failed setup keeps the tree visibly failed until worktree.setup recovers it', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const logs = join(ade.root, 'hook-logs')
  const marker = join(ade.root, 'setup-allowed')
  await mkdir(logs, { recursive: true })
  await profile.call('worktree.configure', { repository_id: repositoryId, config: { setup: [
    sh('context', `printf '%s\\n' "$ADE_HOOK_PHASE" "$ADE_WORKTREE_PATH" "$ADE_WORKTREE_BRANCH" "$ADE_REPOSITORY_ROOT" "$ADE_OPERATION_ID" "$(pwd -P)" > '${logs}/setup-'"$ADE_OPERATION_ID"`),
    sh('gate', `test -f '${marker}' || { echo 'setup needs the marker' >&2; exit 3; }`),
  ] } })

  const id = operationId('create-failing-setup')
  const failed = await create(profile, repositoryId, { name: 'hooked' }, id)
  expect(failed, JSON.stringify(failed)).toMatchObject({ status: 'failed', code: 'setup_hook_failed' })
  const tree = failed.worktree_path!
  // The tree is kept, owned and visibly failed; no Agent may use it.
  expect(existsSync(tree)).toBe(true)
  expect(await item(profile, repositoryId, tree)).toMatchObject({ ade_owned: true, phase: 'setup_failed', setup_state: 'failed' })
  const hooks = failed.result!.hooks as Array<Record<string, unknown>>
  expect(hooks.map((hook) => [hook.name, hook.verdict, hook.exit_code])).toEqual([['context', 'succeeded', 0], ['gate', 'failed', 3]])
  expect(hooks[1].output).toContain('setup needs the marker')
  // The error names the hook, never its output.
  expect(failed.error).not.toContain('setup needs the marker')

  // The hook saw the resolved names before it ran, in the tree itself.
  const context = (await readFile(join(logs, `setup-${id}`), 'utf8')).split('\n')
  expect(context.slice(0, 6)).toEqual(['setup', tree, 'hooked', repo.path, id, tree])

  // Cleanup refuses a tree whose setup did not finish.
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers).toContain('setup_incomplete')

  // Recovery: fix the cause and rerun setup; only full success makes it ready.
  await writeFile(marker, '')
  const retry = operationId('setup-retry')
  await profile.call('worktree.setup', { repository_id: repositoryId, operation_id: retry, path: tree })
  expect(await settled(profile, repositoryId, retry)).toMatchObject({ status: 'succeeded' })
  expect(await item(profile, repositoryId, tree)).toMatchObject({ phase: 'ready', setup_state: 'ready' })
  // A ready tree does not rerun setup.
  const again = operationId('setup-again')
  await expect(profile.call('worktree.setup', { repository_id: repositoryId, operation_id: again, path: tree }))
    .rejects.toThrow()
})

test('a failed teardown keeps the tree; a timed-out teardown quarantines its claim; a fixed teardown removes it', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const logs = join(ade.root, 'teardown.log')
  const configure = (teardown: Array<ReturnType<typeof sh>>) => profile.call('worktree.configure',
    { repository_id: repositoryId, config: { teardown } })

  const tree = await createReady(profile, repositoryId, { name: 'teardown' })
  await configure([sh('refuse', 'echo teardown refused >&2; exit 4')])
  const id = operationId('remove-failing')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: id, path: tree })
  const failed = await settled(profile, repositoryId, id)
  expect(failed, JSON.stringify(failed)).toMatchObject({ status: 'failed', code: 'teardown_hook_failed' })
  expect(existsSync(tree)).toBe(true)
  expect(await item(profile, repositoryId, tree)).toMatchObject({ phase: 'teardown_failed' })
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers).toContain('teardown_incomplete')

  // A teardown that fixes itself: explicit removal is the recovery path.
  await configure([sh('record', `printf '%s %s\\n' "$ADE_HOOK_PHASE" "$ADE_WORKTREE_PATH" >> '${logs}'`)])
  const retry = operationId('remove-retry')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: retry, path: tree })
  expect(await settled(profile, repositoryId, retry)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(tree)).toBe(false)
  expect(await readFile(logs, 'utf8')).toBe(`teardown ${tree}\n`)
  // The branch is kept by default and the archive records the removal.
  expect(await repo.git('branch', '--list', 'teardown')).toContain('teardown')
  const archive = await profile.call('worktree.archived', { repository_id: repositoryId })
  expect(archive.entries[0]).toMatchObject({ path: tree, branch: 'teardown', branch_deleted: false, operation_id: retry })

  // A hook killed at its time limit leaves execution ownership uncertain.
  const slow = await createReady(profile, repositoryId, { name: 'slow-teardown' })
  await configure([sh('hang', `exec sleep 60`, 1)])
  const timed = operationId('remove-timeout')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: timed, path: slow })
  const timedOut = await settled(profile, repositoryId, timed)
  expect(timedOut, JSON.stringify(timedOut)).toMatchObject({ status: 'failed' })
  expect(timedOut.result!.hooks[0]).toMatchObject({ name: 'hang', verdict: 'timed_out' })
  expect(existsSync(slow)).toBe(true)
  const quarantined = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(quarantined.trees.find((candidate) => candidate.path === slow)?.blockers)
    .toEqual(expect.arrayContaining(['claim_uncertain', 'teardown_incomplete']))
})

test.fixme('setup hooks stream their status while they run', async () => {
  // Gap (F067): hooks report only on completion. The spec asks for streamed
  // status; no frame or query exposes a running hook's progress yet.
})

test('cleanup archives only eligible trees, skips dirty, locked, active and external ones, and reports branch deletion separately', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const parent = dirname(repo.path)
  const clean = await createReady(profile, repositoryId, { name: 'clean' })
  const unmerged = await createReady(profile, repositoryId, { name: 'unmerged' })
  const dirty = await createReady(profile, repositoryId, { name: 'dirty' })
  const locked = await createReady(profile, repositoryId, { name: 'locked' })
  const active = await createReady(profile, repositoryId, { name: 'active' })
  const external = join(parent, 'external-tree')
  await repo.git('worktree', 'add', '--quiet', '-b', 'external', external)

  await repo.git('-C', unmerged, 'commit', '--quiet', '--allow-empty', '-m', 'Unmerged work')
  const unmergedHead = await repo.git('-C', unmerged, 'rev-parse', 'HEAD')
  await writeFile(join(dirty, 'README.md'), 'uncommitted\n')
  await repo.git('worktree', 'lock', '--reason', 'e2e', locked)
  const { workspace } = await profile.call('workspace.open', { path: active })
  await profile.call('terminal.restart', { workspace_id: workspace.id })

  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  const blockers = Object.fromEntries(plan.trees.map((tree) => [tree.path, tree.blockers]))
  expect(blockers[clean]).toEqual([])
  expect(blockers[unmerged]).toEqual([])
  expect(blockers[dirty]).toEqual(['dirty'])
  expect(blockers[locked]).toEqual(['locked'])
  // This profile's own lease also holds a host claim on the tree.
  expect(blockers[active]).toContain('active_work')
  expect(blockers[external]).toEqual(['external'])
  expect(plan.trees.map((tree) => tree.path)).not.toContain(repo.path)

  const id = operationId('cleanup')
  const paths = [clean, unmerged, dirty, locked, active, external]
  await profile.call('worktree.cleanup', { repository_id: repositoryId, operation_id: id, paths, delete_branch: 'merged' })
  const row = await settled(profile, repositoryId, id)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'partial' })
  const outcomes = Object.fromEntries((row.result!.trees as Array<{ path: string }>).map((tree) => [tree.path, tree]))
  expect(outcomes[clean]).toMatchObject({ outcome: 'archived', branch_deleted: true })
  expect(outcomes[unmerged]).toMatchObject({ outcome: 'archived', branch_deleted: false })
  for (const path of [dirty, locked, active, external]) {
    expect(outcomes[path], path).toMatchObject({ outcome: 'skipped', blockers: blockers[path] })
    expect(existsSync(path), path).toBe(true)
  }
  expect(existsSync(clean)).toBe(false)
  expect(existsSync(unmerged)).toBe(false)
  expect(await readFile(join(dirty, 'README.md'), 'utf8')).toBe('uncommitted\n')

  // Branch deletion is its own outcome: the merged branch is gone, the unmerged one kept.
  expect(await repo.git('branch', '--list', 'clean')).toBe('')
  expect(await repo.git('rev-parse', 'refs/heads/unmerged')).toBe(unmergedHead)
  const archive = await profile.call('worktree.archived', { repository_id: repositoryId })
  expect(archive.entries.filter((entry) => entry.operation_id === id).map((entry) => [entry.path, entry.branch_deleted]).sort())
    .toEqual([[clean, true], [unmerged, false]].sort())
  expect(archive.entries.find((entry) => entry.path === unmerged)).toMatchObject({ branch: 'unmerged', head: unmergedHead })

  // Direct removal refuses the same trees, and never forces.
  for (const path of [external, active]) {
    await expect(profile.call('worktree.remove', { repository_id: repositoryId, operation_id: operationId('remove'), path }),
      path).rejects.toThrow()
    expect(existsSync(path)).toBe(true)
  }
  await expect(profile.call('worktree.remove', { repository_id: repositoryId, operation_id: operationId('force'),
    path: dirty, force: true })).rejects.toThrow(/Forced worktree removal is unavailable/)
  const dirtyRemoval = operationId('remove-dirty')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: dirtyRemoval, path: dirty })
  expect(await settled(profile, repositoryId, dirtyRemoval)).toMatchObject({ status: 'failed' })
  expect(await readFile(join(dirty, 'README.md'), 'utf8')).toBe('uncommitted\n')
})

test('an interrupted setup survives a daemon crash as setup_interrupted and stays blocked until recovered', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const started = join(ade.root, 'setup-started')
  const release = join(ade.root, 'setup-release')
  await profile.call('worktree.configure', { repository_id: repositoryId, config: { setup: [
    sh('wait', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, 60),
  ] } })

  const id = operationId('create-interrupted')
  await profile.call('worktree.create', { repository_id: repositoryId, operation_id: id, name: 'interrupted' })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  const running = await operation(profile, repositoryId, id)
  const tree = running.worktree_path!
  try {
    expect(running.status).toBe('running')
    await profile.killDaemon()
  } finally {
    // The hook runs under the supervisor, which outlives the daemon; let it finish.
    await writeFile(release, '')
  }
  await profile.restartDaemon()
  const after = await settled(profile, repositoryId, id)
  expect(after, JSON.stringify(after)).toMatchObject({ status: 'interrupted' })
  expect(existsSync(tree)).toBe(true)
  // The phase is durable across the crash: the tree reads as interrupted and cleanup refuses it.
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((candidate) => candidate.path === tree))
    .toMatchObject({ phase: 'setup_interrupted', eligible: false, blockers: expect.arrayContaining(['setup_incomplete']) })
  const refreshed = operationId('refresh')
  await profile.call('worktree.refresh', { repository_id: repositoryId, operation_id: refreshed })
  await settled(profile, repositoryId, refreshed)
  expect(await item(profile, repositoryId, tree)).toMatchObject({ phase: 'setup_interrupted', setup_state: 'interrupted' })

  // The lost owner's create claim is quarantined: nothing reruns in the tree
  // until someone reconciles it explicitly.
  const refused = operationId('setup-refused')
  await expect(profile.call('worktree.setup', { repository_id: repositoryId, operation_id: refused, path: tree }))
    .rejects.toThrow(/quarantined exclusive create claim/)
  const inspection = await profile.call('resources.inspect', { path: tree })
  const quarantined = inspection.claims.filter((claim) => claim.path === tree && claim.state === 'quarantined')
  expect(quarantined).toHaveLength(1)
  await profile.call('resources.claim.resolve', { operation_id: operationId('resolve'),
    claim_id: quarantined[0].id, confirm_path: tree })

  // Recovery reruns setup explicitly; the release file now lets the hook finish.
  const recover = operationId('setup-recover')
  await profile.call('worktree.setup', { repository_id: repositoryId, operation_id: recover, path: tree })
  expect(await settled(profile, repositoryId, recover)).toMatchObject({ status: 'succeeded' })
  expect(await item(profile, repositoryId, tree)).toMatchObject({ phase: 'ready', setup_state: 'ready' })
})

test('a tree being created is reserved host-wide until its setup finishes', async ({ ade }) => {
  const shared = { ADE_HOST_RESOURCES_HOME: join(ade.root, 'host-resources') }
  const creator = await ade.profile({ env: shared })
  const other = await ade.profile({ env: shared })
  const repo = await ade.repo()
  const creatorRepository = await register(creator, repo)
  const otherRepository = await register(other, repo)
  const started = join(ade.root, 'setup-started')
  const release = join(ade.root, 'setup-release')
  await creator.call('worktree.configure', { repository_id: creatorRepository, config: { setup: [
    sh('wait', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, 60),
  ] } })

  const id = operationId('create-reserved')
  await creator.call('worktree.create', { repository_id: creatorRepository, operation_id: id, name: 'reserved' })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  const tree = (await operation(creator, creatorRepository, id)).worktree_path!
  try {
    // Another profile can neither adopt nor clean up the tree while it is set up.
    const refused = await other.call('worktree.adopt', { repository_id: otherRepository, path: tree, confirm_path: tree })
      .then(() => null, (error: unknown) => String(error))
    expect(refused).toMatch(/conflicts with the active exclusive create claim/)
    const plan = await other.call('worktree.cleanup.plan', { repository_id: otherRepository })
    expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers)
      .toEqual(expect.arrayContaining(['external', 'claim_held']))
  } finally {
    await writeFile(release, '')
  }
  expect(await settled(creator, creatorRepository, id)).toMatchObject({ status: 'succeeded' })
  // Once ready, the claim is gone: only the ownership difference remains.
  const after = await other.call('worktree.cleanup.plan', { repository_id: otherRepository })
  expect(after.trees.find((candidate) => candidate.path === tree)?.blockers).toEqual(['external'])
})
