// HostResources across profiles (architecture section 5; 05-S11, 05-S12,
// R007). Two or three scratch profiles share one host registry the way
// managed profiles do, and compete for the same physical checkout through
// the SDK, the CLI and the raw protocol.
import { readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test } from '../fixtures'
import { startHostProfiles } from '../fixtures/host-profiles'
import { rawReply } from '../fixtures/raw-reply'
import {
  adopt,
  claimsOn,
  exists,
  externalTree,
  gitListsTree,
  launchShell,
  profileId,
  removeTree,
  settledOperation,
  startShell,
} from './steps'

test('a profile cannot remove a checkout another profile works in, by its path or an alias', async ({ ade, repo }) => {
  const {
    profiles: [worker, remover],
  } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'shared')
  const projectId = await adopt(remover, repo.path, tree)

  const launch = await launchShell(worker, tree)
  expect(launch.launched).toBe(true)
  const workerId = await profileId(worker)

  const seen = await claimsOn(remover, tree)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    owner_profile: workerId,
    mine: false,
    mode: 'shared',
    purpose: 'use',
    state: 'active',
    owner_live: true,
    path: tree,
  })

  // A symbolic link to the checkout is the same physical resource.
  const alias = join(ade.root, 'alias-to-shared')
  await symlink(tree, alias)
  expect((await claimsOn(remover, alias)).map((claim) => claim.id)).toEqual([seen[0].id])

  const refused = await removeTree(remover, projectId, 'remove-shared', tree)
  expect(refused).toMatchObject({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources' })
  expect(refused.message).toContain(seen[0].id)
  expect(await exists(tree)).toBe(true)
  expect(await gitListsTree(repo, tree)).toBe(true)
  expect(await isRunning(launch.shellPid!)).toBe(true)

  // The CLI reports the same refusal and exits non-zero.
  const cli = await remover.cli(
    'request',
    'worktree.remove',
    JSON.stringify({ project_id: projectId, operation_id: 'remove-shared-cli', path: tree, confirm_path: tree }),
  )
  expect(cli.code).not.toBe(0)
  expect(String(cli.json?.message)).toContain('conflicts with the active shared use claim')

  // Once the worker stops its shell, its claim goes and the removal is admitted
  // under the same operation ID: a refusal left no receipt behind.
  await worker.call('terminal.stop', { workspace_id: launch.workspace.id, terminal_id: launch.shellId })
  await expect.poll(async () => (await claimsOn(remover, tree)).length).toBe(0)
  const admitted = await removeTree(remover, projectId, 'remove-shared', tree)
  expect(admitted.type).toBe('worktree_state')
  expect((await settledOperation(remover, projectId, 'remove-shared')).status).toBe('succeeded')
  expect(await exists(tree)).toBe(false)
})

test('a launch racing a removal in another profile leaves one winner and never deletes an active checkout', async ({
  ade,
  repo,
}) => {
  // A fresh worker per round: a workspace whose folder another profile removed
  // leaves its profile waiting for a rebind.
  const {
    profiles: [remover, ...workers],
  } = await startHostProfiles(ade, 4)
  for (const [index, worker] of workers.entries()) {
    const round = index + 1
    const tree = await externalTree(ade, repo, `race-${round}`)
    const projectId = await adopt(remover, repo.path, tree)
    const { workspace } = await worker.call('workspace.open', { path: tree })

    const [launch, removal] = await Promise.all([
      startShell(worker, workspace),
      removeTree(remover, projectId, `race-remove-${round}`, tree).then(async (reply) =>
        reply.type === 'error'
          ? reply
          : { type: 'settled', operation: await settledOperation(remover, projectId, `race-remove-${round}`) },
      ),
    ])
    const removed = removal.type === 'settled' && (removal.operation as { status: string }).status === 'succeeded'
    // Never both: a running shell's checkout is never deleted.
    expect(launch.launched && removed, JSON.stringify({ launch, removal })).toBe(false)
    // At least one side wins.
    expect(launch.launched || removed, JSON.stringify({ launch, removal })).toBe(true)
    if (launch.launched) {
      expect(await exists(tree)).toBe(true)
      expect(await gitListsTree(repo, tree)).toBe(true)
      if (removal.type === 'error') expect(removal.code).toBe('host_resource_conflict')
      else expect(removal.operation).toMatchObject({ status: 'failed', code: 'host_resource_conflict' })
    } else {
      expect(await exists(tree)).toBe(false)
      expect(JSON.stringify(launch.error)).toContain('conflicts with the active exclusive remove claim')
    }
  }
})

test('two profiles reserving the same unborn path: one creates it and the other gets an explicit conflict', async ({
  ade,
  repo,
}) => {
  const {
    profiles: [first, second],
  } = await startHostProfiles(ade, 2)
  // Hold the first creation inside Git, after its claim is dispatched, until
  // released: a smudge filter runs while `git worktree add` checks files out.
  // (ADE runs Git with hooks disabled, so a hook cannot hold it.)
  const started = join(ade.root, 'creation-started')
  const release = join(ade.root, 'creation-release')
  await repo.commit('Add a filtered file', { '.gitattributes': 'held.txt filter=hold\n', 'held.txt': 'held\n' })
  await repo.git(
    'config',
    'filter.hold.smudge',
    `sh -c ': > ${started}; while [ ! -f ${release} ]; do sleep 0.05; done; cat'`,
  )

  const firstRepository = (await first.call('worktree.repository', { path: repo.path })).repository.id
  const secondRepository = (await second.call('worktree.repository', { path: repo.path })).repository.id
  const target = join(ade.root, 'repos', 'contested')
  await first.call('worktree.switch', {
    project_id: firstRepository,
    operation_id: 'create-first',
    target: 'first',
    create: true,
    path: target,
  })
  try {
    await expect.poll(() => exists(started)).toBe(true)

    const reserved = (await second.call('resources.inspect', { resource: 'checkout' })).claims.filter(
      (claim) => claim.purpose === 'create',
    )
    expect(reserved).toHaveLength(1)
    expect(reserved[0]).toMatchObject({ mode: 'exclusive', phase: 'dispatched', owner_profile: await profileId(first) })

    await second.call('worktree.switch', {
      project_id: secondRepository,
      operation_id: 'create-second',
      target: 'second',
      create: true,
      path: target,
    })
    const lost = await settledOperation(second, secondRepository, 'create-second')
    expect(lost, JSON.stringify(lost)).toMatchObject({
      status: 'failed',
      code: 'host_resource_conflict',
      recovery: 'inspect_host_resources',
    })
  } finally {
    await writeFile(release, '')
  }
  expect((await settledOperation(first, firstRepository, 'create-first')).status).toBe('succeeded')
  expect(await repo.git('-C', target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('first')
  expect(await repo.git('branch', '--list', 'second')).toBe('')
  expect(
    (await second.call('resources.inspect', { resource: 'checkout' })).claims.filter(
      (claim) => claim.purpose === 'create',
    ),
  ).toEqual([])
})

test('an escaped descendant keeps the checkout quarantined after its profile dies, until explicit resolution', async ({
  ade,
  repo,
}) => {
  const {
    profiles: [lost, remover],
  } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'escaped')
  const projectId = await adopt(remover, repo.path, tree)
  const launch = await launchShell(lost, tree)
  expect(launch.launched).toBe(true)

  // The shell starts a descendant that ignores hangup and outlives the terminal.
  const pidFile = join(ade.root, 'descendant.pid')
  const release = join(ade.root, 'descendant.release')
  const sent = await lost.cli(
    'terminal',
    'send',
    launch.workspace.id,
    launch.shellId,
    `nohup sh -c 'echo $$ > ${pidFile}; while [ ! -f ${release} ]; do sleep 0.1; done' >/dev/null 2>&1 &`,
  )
  expect(sent.code, sent.stderr).toBe(0)
  await expect.poll(async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim()).toMatch(/^\d+$/)
  const descendant = Number((await readFile(pidFile, 'utf8')).trim())
  await ade.ledger.own(descendant, 'escaped descendant')
  const claimId = (await claimsOn(remover, tree))[0].id

  await lost.killRuntime()
  await lost.killDaemon()
  expect(await isRunning(descendant)).toBe(true)

  // Losing the owner's lock does not clear the claim: it is quarantined and still conflicts.
  const quarantined = await claimsOn(remover, tree)
  expect(quarantined).toHaveLength(1)
  expect(quarantined[0]).toMatchObject({
    id: claimId,
    state: 'quarantined',
    reason: 'owner_lost_during_use',
    owner_live: false,
    mine: false,
  })
  const refused = await removeTree(remover, projectId, 'remove-escaped', tree)
  expect(refused).toMatchObject({ type: 'error', code: 'host_resource_conflict' })
  expect(await exists(tree)).toBe(true)

  // The user reconciles the resource outside ADE, then resolves the claim explicitly.
  await writeFile(release, '')
  await expect.poll(() => isRunning(descendant)).toBe(false)

  const wrongPath = await rawReply(remover, {
    op: 'resources.claim.resolve',
    operation_id: 'resolve-wrong',
    claim_id: claimId,
    confirm_path: join(ade.root, 'elsewhere'),
  })
  expect(wrongPath.type).toBe('error')
  expect(await claimsOn(remover, tree)).toHaveLength(1)

  const resolved = await remover.cli('resources', 'resolve', claimId, tree, '--operation-id', 'resolve-escaped')
  expect(resolved.code, resolved.stderr).toBe(0)
  expect(await claimsOn(remover, tree)).toEqual([])
  // A duplicate request replays; the same ID with other parameters conflicts.
  const replay = await remover.call('resources.claim.resolve', {
    operation_id: 'resolve-escaped',
    claim_id: claimId,
    confirm_path: tree,
  })
  expect(replay.claims.filter((claim) => claim.id === claimId)).toEqual([])
  const reused = await rawReply(remover, {
    op: 'resources.claim.resolve',
    operation_id: 'resolve-escaped',
    claim_id: 'claim_other',
    confirm_path: tree,
  })
  expect(reused).toMatchObject({ type: 'error' })
  expect(reused.message).toContain('different parameters')

  expect((await removeTree(remover, projectId, 'remove-escaped', tree)).type).toBe('worktree_state')
  expect((await settledOperation(remover, projectId, 'remove-escaped')).status).toBe('succeeded')
  expect(await exists(tree)).toBe(false)
})

test('a daemon crash quarantines a live checkout claim, and the restarted daemon takes it back', async ({
  ade,
  repo,
}) => {
  const {
    profiles: [owner, remover],
  } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'restarted')
  const projectId = await adopt(remover, repo.path, tree)
  const launch = await launchShell(owner, tree)
  expect(launch.launched).toBe(true)
  const before = (await claimsOn(owner, tree))[0]

  await owner.killDaemon()
  expect(await isRunning(launch.shellPid!)).toBe(true)
  expect((await claimsOn(remover, tree))[0]).toMatchObject({ id: before.id, state: 'quarantined', owner_live: false })
  expect(await removeTree(remover, projectId, 'remove-restarted', tree)).toMatchObject({
    type: 'error',
    code: 'host_resource_conflict',
  })

  // The restarted daemon adopts the runtime, finds the shell still running and
  // leases the same checkout again, which supersedes its own quarantined claim.
  await owner.restartDaemon()
  const after = await claimsOn(owner, tree)
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ state: 'active', mine: true, owner_live: true, owner_profile: before.owner_profile })
  expect(after[0].id).not.toBe(before.id)
  expect(after[0].owner_incarnation).not.toBe(before.owner_incarnation)
  expect(await removeTree(remover, projectId, 'remove-restarted', tree)).toMatchObject({
    type: 'error',
    code: 'host_resource_conflict',
  })
  expect(await exists(tree)).toBe(true)
  expect(await isRunning(launch.shellPid!)).toBe(true)
})

test('a lost or unreadable registry blocks lifecycle commands until the profile accepts it explicitly', async ({
  ade,
  repo,
}) => {
  const {
    profilesHome,
    profiles: [holder, remover],
  } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'registry')
  const projectId = await adopt(remover, repo.path, tree)
  expect((await launchShell(holder, tree)).launched).toBe(true)
  const registry = join(profilesHome, 'host-resources.sqlite3')
  expect((await remover.call('resources.inspect', {})).registry.path).toBe(registry)

  // The registry goes missing while another profile still holds a claim in it.
  // A profile bound to it never creates an empty replacement that forgets that owner.
  await rename(registry, `${registry}.lost`)
  await remover.restartDaemon()
  const missing = await remover.call('resources.inspect', {})
  expect(missing.registry).toMatchObject({ state: 'blocked', path: registry })
  expect(await exists(registry)).toBe(false)
  expect(await removeTree(remover, projectId, 'remove-registry', tree)).toMatchObject({
    type: 'error',
    code: 'host_resources_unavailable',
    recovery: 'recover_host_resources',
  })
  expect(await exists(tree)).toBe(true)

  // Once the other profile has stopped, the file on disk is unreadable garbage.
  await holder.stop()
  await rm(`${registry}-wal`, { force: true })
  await rm(`${registry}-shm`, { force: true })
  await writeFile(registry, Buffer.alloc(8192, 'not a registry '))
  await remover.restartDaemon()
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('blocked')

  const wrong = await rawReply(remover, {
    op: 'resources.registry.accept',
    operation_id: 'accept-wrong',
    confirm_registry: `${registry}.other`,
  })
  expect(wrong.type).toBe('error')
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('blocked')

  const accepted = await remover.cli('resources', 'accept', registry, '--operation-id', 'accept-registry')
  expect(accepted.code, accepted.stderr).toBe(0)
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('ready')
  // The unreadable file was moved aside, never deleted.
  const names = await readdir(profilesHome)
  expect(
    names.some((name) => name.startsWith('host-resources.sqlite3.unreadable-')),
    names.join(', '),
  ).toBe(true)

  expect((await removeTree(remover, projectId, 'remove-registry', tree)).type).toBe('worktree_state')
  expect((await settledOperation(remover, projectId, 'remove-registry')).status).toBe('succeeded')
})
