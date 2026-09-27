// F064: carry uncommitted changes from one tree into a clean ADE-owned tree.
// Every Git step (temporary-index snapshot, commit-tree, update-ref,
// merge-tree, read-tree, source cleanup) runs for real here.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '../fixtures'
import { createReady, operation, operationId, register, settled } from './lifecycle'

const files = { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n', 'keep.txt': 'keep\n' }

test('an exact carry moves only the selected changes, saves them under a ref and cleans the source after verification', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const target = await createReady(profile, repositoryId, { name: 'exact' })
  const base = await repo.head()

  await repo.write('a.txt', 'alpha carried\n')
  await repo.git('rm', '--quiet', 'b.txt')
  await repo.write('new/c.txt', 'charlie\n')
  await repo.write('keep.txt', 'keep, not selected\n')

  const preview = await profile.call('worktree.carry.preview', {
    repository_id: repositoryId,
    source: repo.path,
    paths: ['a.txt', 'b.txt', 'new'],
  })
  expect(preview).toMatchObject({ head: base, carriable: true, blockers: [] })
  const byPath = Object.fromEntries(preview.entries.map((entry) => [entry.path, entry]))
  expect(byPath['a.txt']).toMatchObject({ change: 'modified', selected: true, staged: false, unstaged: true })
  expect(byPath['b.txt']).toMatchObject({ change: 'deleted', selected: true, staged: true })
  expect(byPath['new/c.txt']).toMatchObject({ change: 'untracked', selected: true })
  expect(byPath['keep.txt']).toMatchObject({ change: 'modified', selected: false })
  // The preview changed nothing.
  expect((await repo.status()).sort()).toEqual([' M a.txt', ' M keep.txt', 'D  b.txt', '?? new/c.txt'].sort())

  const id = operationId('carry-exact')
  const request = {
    repository_id: repositoryId,
    operation_id: id,
    source: repo.path,
    target,
    paths: ['a.txt', 'b.txt', 'new'],
    expect_head: base,
    clean_source: true,
  }
  await profile.call('worktree.carry', request)
  const row = await settled(profile, repositoryId, id)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded', worktree_path: target })
  const carry = row.result!.carry
  expect(carry).toMatchObject({
    source: repo.path,
    target,
    base,
    applied: 'exact',
    verified: true,
    source_outcome: 'cleaned',
    target_head: base,
  })
  expect([...carry.paths].sort()).toEqual(['a.txt', 'b.txt', 'new/c.txt'])

  // The snapshot commit is kept under its ref, with the source HEAD as parent.
  expect(carry.ref_name).toMatch(/^refs\/ade\/carry\/[0-9a-f]{24}$/)
  expect(await repo.git('rev-parse', carry.ref_name)).toBe(carry.commit)
  expect(await repo.git('rev-parse', `${carry.commit}^`)).toBe(base)

  // The target holds the carried changes, staged; the unselected change stayed behind.
  const inTarget = (...args: string[]) => repo.git('-C', target, ...args)
  expect((await inTarget('status', '--porcelain=v1', '--untracked-files=all')).split('\n').sort()).toEqual([
    'A  new/c.txt',
    'D  b.txt',
    'M  a.txt',
  ])
  expect(await inTarget('show', ':a.txt')).toBe('alpha carried')
  expect(existsSync(join(target, 'b.txt'))).toBe(false)
  expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  expect(await inTarget('show', ':keep.txt')).toBe('keep')

  // The source lost exactly the carried changes and kept the unselected one.
  expect(await repo.status()).toEqual([' M keep.txt'])
  expect(await repo.read('a.txt')).toBe('alpha\n')
  expect(await repo.read('b.txt')).toBe('bravo\n')
  expect(existsSync(join(repo.path, 'new/c.txt'))).toBe(false)
  expect(await repo.read('keep.txt')).toBe('keep, not selected\n')

  // A duplicate request replays the receipt: nothing runs twice.
  await profile.call('worktree.carry', request)
  expect(await operation(profile, repositoryId, id)).toMatchObject({ status: 'succeeded', result: { carry } })
  expect(await repo.status()).toEqual([' M keep.txt'])
  // The same operation ID with different parameters is a conflict.
  await expect(profile.call('worktree.carry', { ...request, clean_source: false })).rejects.toThrow(
    /already used for different parameters/,
  )

  // Both claims were released: the target is an ordinary dirty tree again.
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((tree) => tree.path === target)?.blockers).toEqual(['dirty'])
})

test('a carry into a tree at another commit merges with merge-tree and keeps the source', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const target = await createReady(profile, repositoryId, { name: 'merged' })
  const inTarget = (...args: string[]) => repo.git('-C', target, ...args)
  await writeFile(join(target, 'b.txt'), 'bravo in target\n')
  await inTarget('commit', '--quiet', '-am', 'Target moves on')
  const targetHead = await inTarget('rev-parse', 'HEAD')
  const base = await repo.head()
  expect(targetHead).not.toBe(base)

  await repo.write('a.txt', 'alpha merged\n')
  const id = operationId('carry-merge')
  await profile.call('worktree.carry', {
    repository_id: repositoryId,
    operation_id: id,
    source: repo.path,
    target,
    expect_head: base,
    clean_source: true,
  })
  const row = await settled(profile, repositoryId, id)
  // The carry reached the target, but a merged result cannot prove the
  // source's content arrived intact, so the requested cleanup is refused.
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'partial', code: 'carry_source_kept' })
  expect(row.result!.carry).toMatchObject({
    applied: 'merged',
    verified: true,
    target_head: targetHead,
    source_outcome: 'kept',
    source_reason: 'base_differs',
  })

  expect(await inTarget('rev-parse', 'HEAD')).toBe(targetHead)
  expect(await inTarget('status', '--porcelain=v1')).toBe('M  a.txt')
  expect(await inTarget('show', ':a.txt')).toBe('alpha merged')
  expect(await inTarget('show', ':b.txt')).toBe('bravo in target')
  expect(await repo.status()).toEqual([' M a.txt'])
  expect(await repo.read('a.txt')).toBe('alpha merged\n')
})

test('a conflicting carry applies nothing, keeps both trees and still saves the changes', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const target = await createReady(profile, repositoryId, { name: 'conflict' })
  const inTarget = (...args: string[]) => repo.git('-C', target, ...args)
  await writeFile(join(target, 'a.txt'), 'alpha from target\n')
  await inTarget('commit', '--quiet', '-am', 'Target edits a.txt')
  const targetHead = await inTarget('rev-parse', 'HEAD')

  await repo.write('a.txt', 'alpha from source\n')
  await repo.write('untracked.txt', 'stays\n')
  const id = operationId('carry-conflict')
  await profile.call('worktree.carry', {
    repository_id: repositoryId,
    operation_id: id,
    source: repo.path,
    target,
    clean_source: true,
  })
  const row = await settled(profile, repositoryId, id)
  expect(row, JSON.stringify(row)).toMatchObject({
    status: 'failed',
    code: 'carry_conflict',
    recovery: 'resolve_from_carry_ref',
  })
  const carry = row.result!.carry
  expect(carry).toMatchObject({ applied: 'conflicted', verified: false, source_outcome: 'kept' })
  expect(carry.conflicts).toEqual(['a.txt'])
  expect(row.error).toContain(carry.ref_name)

  // Nothing reached the target and nothing left the source.
  expect(await inTarget('rev-parse', 'HEAD')).toBe(targetHead)
  expect(await inTarget('status', '--porcelain=v1', '--untracked-files=all')).toBe('')
  expect((await repo.status()).sort()).toEqual([' M a.txt', '?? untracked.txt'])
  expect(await repo.read('a.txt')).toBe('alpha from source\n')
  // The saved commit still holds the source's version.
  expect(await repo.git('show', `${carry.ref_name}:a.txt`)).toBe('alpha from source')

  // The target's claim was released, not quarantined: it is eligible for cleanup.
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((tree) => tree.path === target)).toMatchObject({ eligible: true, blockers: [] })
})

test('a path with staged and unstaged changes is carried but the source keeps both versions', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const mixed = await repo.stagedAndUnstaged('mixed.txt')
  const target = await createReady(profile, repositoryId, { name: 'mixed' })

  const preview = await profile.call('worktree.carry.preview', { repository_id: repositoryId, source: repo.path })
  expect(preview.entries).toEqual([
    expect.objectContaining({ path: 'mixed.txt', staged: true, unstaged: true, selected: true }),
  ])

  const id = operationId('carry-mixed')
  await profile.call('worktree.carry', {
    repository_id: repositoryId,
    operation_id: id,
    source: repo.path,
    target,
    clean_source: true,
  })
  const row = await settled(profile, repositoryId, id)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'partial', code: 'carry_source_kept' })
  expect(row.result!.carry).toMatchObject({
    applied: 'exact',
    verified: true,
    source_outcome: 'kept',
    source_reason: 'staged_and_unstaged',
  })

  // The target receives the working-tree version.
  expect(await repo.git('-C', target, 'show', ':mixed.txt')).toBe(mixed.unstaged.trimEnd())
  // The source keeps its staged version in the index and its unstaged version on disk.
  expect(await repo.status()).toEqual(['MM mixed.txt'])
  expect(await repo.git('show', ':mixed.txt')).toBe(mixed.staged.trimEnd())
  expect(await repo.read('mixed.txt')).toBe(mixed.unstaged)
})

test('a carry is refused for a dirty target, a stale head, an unowned tree, the primary checkout and nothing to carry', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const target = await createReady(profile, repositoryId, { name: 'refusals' })
  const base = await repo.head()
  const carry = (extra: Record<string, unknown>) => ({
    repository_id: repositoryId,
    source: repo.path,
    target,
    ...extra,
  })

  // Nothing to carry.
  const empty = await profile.call('worktree.carry.preview', { repository_id: repositoryId, source: repo.path })
  expect(empty).toMatchObject({ carriable: false, blockers: ['no_changes'] })
  let id = operationId('carry-empty')
  await profile.call('worktree.carry', { ...carry({}), operation_id: id })
  expect(await settled(profile, repositoryId, id)).toMatchObject({ status: 'failed', code: 'carry_blocked' })

  await repo.write('a.txt', 'alpha dirty\n')
  // A requested path with no change is a blocker, never dropped silently.
  const unchanged = await profile.call('worktree.carry.preview', {
    repository_id: repositoryId,
    source: repo.path,
    paths: ['a.txt', 'b.txt'],
  })
  expect(unchanged).toMatchObject({ carriable: false, blockers: ['not_changed'] })

  // A HEAD that moved since the preview refuses.
  id = operationId('carry-stale')
  await profile.call('worktree.carry', { ...carry({ expect_head: '0'.repeat(40) }), operation_id: id })
  const stale = await settled(profile, repositoryId, id)
  expect(stale).toMatchObject({ status: 'failed', code: 'carry_blocked' })
  expect(stale.result!.blockers).toEqual(['head_changed'])

  // A dirty target refuses and keeps its own change.
  await writeFile(join(target, 'b.txt'), 'target dirt\n')
  id = operationId('carry-dirty-target')
  await profile.call('worktree.carry', { ...carry({ expect_head: base }), operation_id: id })
  expect(await settled(profile, repositoryId, id)).toMatchObject({ status: 'failed', code: 'carry_target_dirty' })
  expect(await repo.git('-C', target, 'status', '--porcelain=v1')).toBe(' M b.txt')
  await repo.git('-C', target, 'checkout', '--quiet', '--', 'b.txt')

  // The primary checkout never receives a carry.
  await expect(
    profile.call('worktree.carry', {
      repository_id: repositoryId,
      operation_id: operationId('carry-primary'),
      source: target,
      target: repo.path,
    }),
  ).rejects.toThrow(/primary checkout cannot receive/)

  // A tree ADE neither created nor adopted is never written.
  const external = join(repo.path, '..', 'external-tree')
  await repo.git('worktree', 'add', '--quiet', '-b', 'external', external)
  await expect(
    profile.call('worktree.carry', { ...carry({}), target: external, operation_id: operationId('carry-external') }),
  ).rejects.toThrow(/created or adopted/)
  expect(await repo.git('-C', external, 'status', '--porcelain=v1')).toBe('')

  // Every refusal left the source as it was.
  expect(await repo.status()).toEqual([' M a.txt'])
})

test('a settled carry survives a daemon crash: its receipt replays and its ref and result are kept', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: files })
  const repositoryId = await register(profile, repo)
  const target = await createReady(profile, repositoryId, { name: 'restart' })
  await repo.write('a.txt', 'alpha across a restart\n')

  const id = operationId('carry-restart')
  const request = { repository_id: repositoryId, operation_id: id, source: repo.path, target, clean_source: true }
  await profile.call('worktree.carry', request)
  const before = await settled(profile, repositoryId, id)
  expect(before).toMatchObject({ status: 'succeeded' })

  await profile.restartDaemon('kill')
  const after = await operation(profile, repositoryId, id)
  expect(after).toMatchObject({ status: 'succeeded', result: { carry: before.result!.carry } })
  // The replay after the restart does not carry again.
  await profile.call('worktree.carry', request)
  expect(await operation(profile, repositoryId, id)).toMatchObject({
    status: 'succeeded',
    finished_at: (before as any).finished_at,
  })
  expect(await repo.git('-C', target, 'status', '--porcelain=v1')).toBe('M  a.txt')
  expect(await repo.status()).toEqual([])
  expect(await repo.git('rev-parse', before.result!.carry.ref_name)).toBe(before.result!.carry.commit)
})
