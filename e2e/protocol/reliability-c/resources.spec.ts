// R007: physical resources are coordinated across profiles. Two or three
// scratch profiles share one HostResources registry the way managed profiles
// do. These specs cover what the resources area left open (architecture
// section 12, fault scenario 1): a checkout path that is replaced, and a
// registry that is corrupted or migrated while another profile's daemon is
// live and holds a claim in it. New work must fail closed, and ownership must
// never be forgotten.
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, isRunning, test } from '../fixtures'
import { startHostProfiles } from '../fixtures/host-profiles'
import { rawReply } from '../fixtures/raw-reply'
import { adopt, claimsOn, exists, externalTree, launchShell, removeTree, settledOperation } from './steps'

test('a checkout moved away keeps its claim, and a new checkout at the old path does not inherit it', async ({ ade, repo }) => {
  const { profiles: [holder, remover] } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'moved')
  const launch = await launchShell(holder, tree)
  const [claim] = await claimsOn(remover, tree)
  expect(claim).toMatchObject({ mode: 'shared', purpose: 'use', state: 'active', owner_live: true, mine: false })

  // Git moves the checkout while the holder's shell works in it, and a new
  // checkout is created at the old path.
  await repo.git('worktree', 'move', tree, join(ade.root, 'repos', 'moved-elsewhere'))
  const moved = await realpath(join(ade.root, 'repos', 'moved-elsewhere'))
  await repo.git('worktree', 'add', '--quiet', '-b', 'replacement', tree)

  // The claim follows the physical checkout, not the path.
  expect((await claimsOn(remover, moved)).map((entry) => entry.id)).toEqual([claim.id])
  expect(await claimsOn(remover, tree)).toEqual([])

  // The remover takes removal authority over both checkouts. Removing the
  // moved one is refused while the holder works in it.
  const repositoryId = await adopt(remover, repo.path, moved)
  await adopt(remover, repo.path, tree)
  const refused = await removeTree(remover, repositoryId, 'remove-moved', moved)
  expect(refused).toMatchObject({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources' })
  expect(refused.message).toContain(claim.id)
  expect(await exists(moved)).toBe(true)
  expect(await isRunning(launch.shellPid)).toBe(true)

  // The replacement at the old path is another resource: nobody holds it, so it can be removed.
  expect((await removeTree(remover, repositoryId, 'remove-replacement', tree)).type).toBe('worktree_state')
  expect(await settledOperation(remover, repositoryId, 'remove-replacement')).toBe('succeeded')
  expect(await exists(tree)).toBe(false)
  // The holder's checkout and shell are untouched.
  expect(await exists(moved)).toBe(true)
  expect(await isRunning(launch.shellPid)).toBe(true)
  expect((await claimsOn(remover, moved)).map((entry) => entry.id)).toEqual([claim.id])
  expect(await removeTree(remover, repositoryId, 'remove-moved', moved))
    .toMatchObject({ type: 'error', code: 'host_resource_conflict' })
})

test('a registry corrupted under a live owner blocks new lifecycle work and cannot be replaced until that owner stops', async ({ ade, repo }) => {
  const { profilesHome, profiles: [holder, remover] } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'corrupt')
  const repositoryId = await adopt(remover, repo.path, tree)
  const launch = await launchShell(holder, tree)
  const registry = join(profilesHome, 'host-resources.sqlite3')
  expect(await claimsOn(remover, tree)).toHaveLength(1)

  // The file is overwritten with garbage while the holder's daemon keeps it
  // open. The write-ahead log is overwritten too, so none of its frames can
  // make the damaged file look valid again.
  const garbage = Buffer.alloc(16_384, 'not a registry ')
  await writeFile(registry, garbage)
  if (await exists(`${registry}-wal`)) await writeFile(`${registry}-wal`, garbage)

  await remover.restartDaemon()
  const blocked = await remover.call('resources.inspect', {})
  expect(blocked.registry).toMatchObject({ state: 'blocked', path: registry })
  expect(blocked.registry.reason).toMatch(/unreadable/)

  // New lifecycle work fails closed with a typed refusal and a recovery hint.
  const refused = await removeTree(remover, repositoryId, 'remove-corrupt', tree)
  expect(refused).toMatchObject({ type: 'error', code: 'host_resources_unavailable', recovery: 'recover_host_resources' })
  expect(await exists(tree)).toBe(true)
  expect(await isRunning(launch.shellPid)).toBe(true)

  // Accepting a new, empty registry now would forget the live holder's claim,
  // so it is refused. The damaged file is left exactly as it was.
  const early = await rawReply(remover, { op: 'resources.registry.accept', operation_id: 'accept-early',
    confirm_registry: registry })
  expect(early).toMatchObject({ type: 'error', code: 'host_resources_unavailable' })
  expect(early.message).toMatch(/live/)
  expect(await readFile(registry)).toEqual(garbage)
  expect((await readdir(profilesHome)).some((name) => name.includes('.unreadable-'))).toBe(false)
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('blocked')
  expect(await removeTree(remover, repositoryId, 'remove-corrupt', tree))
    .toMatchObject({ type: 'error', code: 'host_resources_unavailable' })
  expect(await exists(tree)).toBe(true)

  // Once the holder has stopped, nothing live depends on the old file: the
  // same explicit recovery moves it aside and starts a new registry.
  await holder.stop()
  const accepted = await remover.cli('resources', 'accept', registry, '--request-id', 'accept-after-stop')
  expect(accepted.code, accepted.stderr).toBe(0)
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('ready')
  expect((await readdir(profilesHome)).some((name) => name.startsWith('host-resources.sqlite3.unreadable-'))).toBe(true)
  // The refusals left no receipt, so the same operation ID is admitted now.
  expect((await removeTree(remover, repositoryId, 'remove-corrupt', tree)).type).toBe('worktree_state')
  expect(await settledOperation(remover, repositoryId, 'remove-corrupt')).toBe('succeeded')
})

test('a registry migrated to a newer format under a live owner blocks new work and keeps every claim', async ({ ade, repo }) => {
  const { profilesHome, profiles: [holder, remover] } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'migrated')
  const repositoryId = await adopt(remover, repo.path, tree)
  const launch = await launchShell(holder, tree)
  const registry = join(profilesHome, 'host-resources.sqlite3')
  const [claim] = await claimsOn(remover, tree)

  // A newer ADE migrates the registry while the holder's daemon is live.
  const setFormat = (format: string) => {
    const db = new DatabaseSync(registry)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.prepare("UPDATE registry SET value=? WHERE key='format'").run(format)
    } finally { db.close() }
  }
  const claimIds = () => {
    const db = new DatabaseSync(registry, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      return (db.prepare('SELECT id FROM claims').all() as Array<{ id: string }>).map((row) => row.id)
    } finally { db.close() }
  }
  setFormat('2')

  await remover.restartDaemon()
  const blocked = await remover.call('resources.inspect', {})
  expect(blocked.registry).toMatchObject({ state: 'blocked', path: registry })
  expect(blocked.registry.reason).toMatch(/format 2.*update ADE/)
  expect(await removeTree(remover, repositoryId, 'remove-migrated', tree))
    .toMatchObject({ type: 'error', code: 'host_resources_unavailable', recovery: 'recover_host_resources' })

  // An explicit accept cannot replace a newer registry: the file is left alone.
  const accept = await rawReply(remover, { op: 'resources.registry.accept', operation_id: 'accept-newer',
    confirm_registry: registry })
  expect(accept).toMatchObject({ type: 'error', code: 'host_resources_unavailable' })
  expect(accept.message).toMatch(/format 2/)
  expect(claimIds()).toContain(claim.id)
  expect((await readdir(profilesHome)).some((name) => name.includes('.unreadable-'))).toBe(false)
  expect(await exists(tree)).toBe(true)
  expect(await isRunning(launch.shellPid)).toBe(true)

  // When the registry is back at a supported format, the holder's claim is
  // still there and still refuses the removal: nothing was forgotten.
  setFormat('1')
  await remover.restartDaemon()
  expect((await remover.call('resources.inspect', {})).registry.state).toBe('ready')
  expect(await claimsOn(remover, tree)).toEqual([expect.objectContaining({ id: claim.id, state: 'active', owner_live: true })])
  expect(await removeTree(remover, repositoryId, 'remove-migrated', tree))
    .toMatchObject({ type: 'error', code: 'host_resource_conflict' })
  expect(await exists(tree)).toBe(true)
  expect(await isRunning(launch.shellPid)).toBe(true)
})
